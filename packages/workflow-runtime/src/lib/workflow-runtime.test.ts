import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  lstat,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import {
  checkArtifact,
  checkPayload,
  packageRoot,
  packageRuntime,
  parseInventory,
  payloadRoot,
  readInventory,
  type Inventory,
  type RuntimeFile,
} from './workflow-runtime.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const file = (
  path: string,
  text: string,
  lane: 'portable' | 'archon' = 'portable',
): RuntimeFile => ({
  path,
  lane,
  sourceSha256: hash(text),
  artifactSha256: hash(text),
  executable: false,
  transformation: null,
});

async function scratch(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'temari-package-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function fixture(
  t: TestContext,
): Promise<{ root: string; source: string; inventory: Inventory }> {
  const root = await scratch(t);
  const source = join(root, 'assets/v4.1');
  const texts = new Map([
    ['LICENSE', 'license\n'],
    ['integrations/archon/runtime-files.txt', 'optional\n'],
  ]);
  const inventory: Inventory = {
    schema: 1,
    sourceRevision: 'a'.repeat(40),
    files: [...texts].map(([path, text]) =>
      file(
        path,
        text,
        path.startsWith('integrations/') ? 'archon' : 'portable',
      ),
    ),
  };
  for (const [path, text] of texts) {
    await mkdir(dirname(join(source, path)), { recursive: true });
    await writeFile(join(source, path), text);
    await chmod(join(source, path), 0o644);
  }
  await writeFile(join(root, 'provenance.json'), JSON.stringify(inventory));
  return { root, source, inventory };
}

test('inventory rejects traversal, absolute paths, private profiles, dependencies and evidence', () => {
  for (const path of [
    '../outside',
    '/absolute',
    'skills//file',
    'skills/./file',
    'skills\\escape',
    'C:/escape',
    'skills/OpConnect-profile.md',
    'skills/node_modules/a',
    '.git/config',
    'verification/evidence/secret',
  ]) {
    assert.throws(
      () =>
        parseInventory({
          schema: 1,
          sourceRevision: 'a'.repeat(40),
          files: [file(path, 'x')],
        }),
      /path/i,
      path,
    );
  }
});

test('inventory rejects case collisions and file-directory collisions', () => {
  for (const paths of [
    ['A', 'a'],
    ['a', 'a/b'],
  ]) {
    assert.throws(
      () =>
        parseInventory({
          schema: 1,
          sourceRevision: 'a'.repeat(40),
          files: paths.map((path) => file(path, 'x')),
        }),
      /collision/,
    );
  }
});

test('inventory rejects unknown fields, wrong lanes and unexplained transformations', () => {
  const base = {
    schema: 1,
    sourceRevision: 'a'.repeat(40),
    files: [file('a', 'x')],
  };
  assert.throws(() => parseInventory({ ...base, unknown: true }), /fields/);
  assert.throws(
    () =>
      parseInventory({
        ...base,
        files: [{ ...file('a', 'x'), lane: 'archon' }],
      }),
    /lane/,
  );
  assert.throws(
    () =>
      parseInventory({
        ...base,
        files: [{ ...file('a', 'x'), artifactSha256: hash('other') }],
      }),
    /Unexplained/,
  );
});

test('portable and Archon packages are separate, deterministic and repeatable', async (t) => {
  const { root, inventory } = await fixture(t);
  const outputs = await scratch(t);
  const portable = await packageRuntime(
    'portable',
    join(outputs, 'portable'),
    root,
  );
  const archon = await packageRuntime('archon', join(outputs, 'archon'), root);
  assert.equal(portable.files, 1);
  assert.equal(archon.files, 2);
  assert.notEqual(portable.digest, archon.digest);
  assert.deepEqual(await readdir(portable.root), [
    '.temari-distribution.json',
    'LICENSE',
  ]);
  assert.equal(
    await readFile(
      join(archon.root, 'integrations/archon/runtime-files.txt'),
      'utf8',
    ),
    'optional\n',
  );
  assert.deepEqual(
    await packageRuntime('portable', join(outputs, 'portable'), root),
    { ...portable, status: 'unchanged' },
  );
  await checkArtifact(portable.root, inventory, 'portable');
});

test('unknown source files fail before output publication', async (t) => {
  const { root, source } = await fixture(t);
  const output = join(await scratch(t), 'output');
  await writeFile(join(source, 'extra'), 'unreviewed');
  await assert.rejects(packageRuntime('portable', output, root), /unknown/);
  await assert.rejects(readFile(join(output, '.temari-distribution.json')), {
    code: 'ENOENT',
  });
});

test('missing source files and tampered bytes fail closed', async (t) => {
  const { root, source } = await fixture(t);
  const output = join(await scratch(t), 'output');
  await writeFile(join(source, 'LICENSE'), 'changed');
  await assert.rejects(
    packageRuntime('portable', output, root),
    /Hash mismatch/,
  );
  await rm(join(source, 'LICENSE'));
  await assert.rejects(packageRuntime('portable', output, root), /missing/);
});

test('source and inventory symlinks are rejected', async (t) => {
  const { root, source } = await fixture(t);
  const output = join(await scratch(t), 'output');
  await rm(join(source, 'LICENSE'));
  await symlink(join(root, 'provenance.json'), join(source, 'LICENSE'));
  await assert.rejects(packageRuntime('portable', output, root), /Symlink/);
  const second = await fixture(t);
  await rm(join(second.root, 'provenance.json'));
  await symlink(
    join(root, 'provenance.json'),
    join(second.root, 'provenance.json'),
  );
  await assert.rejects(readInventory(second.root), /regular file/);
});

test('a symlinked assets ancestor is rejected', async (t) => {
  const { root } = await fixture(t);
  const copy = await scratch(t);
  await cp(join(root, 'assets'), join(copy, 'payload'), { recursive: true });
  await rm(join(root, 'assets'), { recursive: true });
  await symlink(join(copy, 'payload'), join(root, 'assets'));
  await assert.rejects(
    packageRuntime('portable', join(copy, 'output'), root),
    /regular directory/,
  );
});

test('output through a symlink into payload rejects without creating nested directories', async (t) => {
  const { root, source, inventory } = await fixture(t);
  const outside = await scratch(t);
  await symlink(source, join(outside, 'alias'));
  const before = await readdir(source);
  await assert.rejects(
    packageRuntime('portable', join(outside, 'alias/new/nested/output'), root),
    /overlaps/,
  );
  assert.deepEqual(await readdir(source), before);
  await checkPayload(source, inventory.files);
  await assert.rejects(
    packageRuntime('portable', join(source, 'new/nested/output'), root),
    /overlaps/,
  );
  assert.deepEqual(await readdir(source), before);
});

test('root, relative and ancestor outputs cannot replace the source', async (t) => {
  const { root, source, inventory } = await fixture(t);
  for (const output of ['/', 'relative', source, root])
    await assert.rejects(
      packageRuntime('portable', output, root),
      /absolute|overlaps/,
    );
  await checkPayload(source, inventory.files);
});

test('pre-existing foreign or changed destinations are preserved', async (t) => {
  const { root } = await fixture(t);
  const output = await scratch(t);
  await writeFile(join(output, 'owner.txt'), 'foreign');
  await assert.rejects(packageRuntime('portable', output, root));
  assert.equal(await readFile(join(output, 'owner.txt'), 'utf8'), 'foreign');
  const result = await packageRuntime(
    'portable',
    join(output, 'artifact'),
    root,
  );
  await writeFile(join(result.root, 'LICENSE'), 'local edit');
  await assert.rejects(
    packageRuntime('portable', result.root, root),
    /Hash mismatch/,
  );
  assert.equal(
    await readFile(join(result.root, 'LICENSE'), 'utf8'),
    'local edit',
  );
});

test('artifact checks reject unknown files and symlinked roots', async (t) => {
  const { root, inventory } = await fixture(t);
  const output = await scratch(t);
  const result = await packageRuntime(
    'portable',
    join(output, 'artifact'),
    root,
  );
  await symlink(result.root, join(output, 'alias'));
  await assert.rejects(
    checkArtifact(join(output, 'alias'), inventory, 'portable'),
    /regular directory/,
  );
  await assert.rejects(
    packageRuntime('portable', join(output, 'alias'), root),
    /symlink/,
  );
  await writeFile(join(result.root, 'extra'), 'not inventoried');
  await assert.rejects(
    checkArtifact(result.root, inventory, 'portable'),
    /unknown/,
  );
});

test('inventory verifies executable mode', async (t) => {
  const { root, source } = await fixture(t);
  await chmod(join(source, 'LICENSE'), 0o755);
  await assert.rejects(
    packageRuntime('portable', join(await scratch(t), 'output'), root),
    /Executable mode/,
  );
});

test('vendored inventory has explicit provenance and no excluded private profile', async () => {
  const inventory = await readInventory();
  assert.deepEqual(
    (await readFile(join(packageRoot, 'import-paths.txt'), 'utf8'))
      .trim()
      .split('\n'),
    inventory.files.map((file) => file.path),
  );
  assert.ok(inventory.files.length > 200);
  await checkPayload(payloadRoot, inventory.files);
  assert.equal(
    inventory.files.some((file) =>
      /opconnect|node_modules|\/evidence\//i.test(file.path),
    ),
    false,
  );
  assert.ok(inventory.files.some((file) => file.path.endsWith('/bun.lock')));
  assert.ok(
    inventory.files.some(
      (file) =>
        file.path === 'integrations/archon/.archon/workflows/temari-pilot.yaml',
    ),
  );
  assert.equal(
    inventory.files
      .find((file) => file.path === 'skills/seq-log-review/SKILL.md')
      ?.transformation?.includes('needs-scope'),
    true,
  );
});

test('relocated portable artifact runs catalog, routing and playbook commands without Archon', async (t) => {
  const output = await scratch(t);
  const artifact = await packageRuntime('portable', join(output, 'artifact'));
  const control = join(
    artifact.root,
    'verification/verify-temari/scripts/control-temari',
  );
  const catalog = execFileSync('bash', [control, 'plugin-catalog'], {
    cwd: output,
    encoding: 'utf8',
  });
  assert.match(catalog, /name=temari/);
  assert.match(
    execFileSync('bash', [control, 'routing'], {
      cwd: output,
      encoding: 'utf8',
    }),
    /routing_ok=yes/,
  );
  assert.match(
    execFileSync('bash', [control, 'playbooks'], {
      cwd: output,
      encoding: 'utf8',
    }),
    /coverage=exact/,
  );
  await assert.rejects(
    readFile(join(artifact.root, 'integrations/archon/runtime-files.txt')),
    { code: 'ENOENT' },
  );
  const unavailable = spawnSync(
    'bash',
    [
      join(artifact.root, 'scripts/copy-archon-runtime.sh'),
      artifact.root,
      join(output, 'archon'),
    ],
    { cwd: output, encoding: 'utf8' },
  );
  assert.equal(unavailable.status, 2);
  assert.match(unavailable.stderr, /Archon unavailable/);
});

test('portable copy installs preserve routing, references and optional Archon absence', async (t) => {
  const output = await scratch(t);
  const artifact = await packageRuntime('portable', join(output, 'artifact'));
  for (const host of ['generic', 'codex', 'claude-code']) {
    const destination = join(output, host);
    assert.match(
      execFileSync(
        'bash',
        [
          join(artifact.root, 'scripts/install-host.sh'),
          `--host=${host}`,
          '--mode=copy',
          `--dest=${destination}`,
          '--include-verification',
        ],
        { cwd: output, encoding: 'utf8' },
      ),
      /archon=unavailable/,
    );
    assert.equal(
      (await readFile(join(destination, 'pstack-root'), 'utf8')).trim(),
      '.temari-package',
    );
    const control = join(
      artifact.root,
      'verification/verify-temari/scripts/control-temari',
    );
    assert.match(
      execFileSync('bash', [control, 'routing', '--dest', destination], {
        cwd: output,
        encoding: 'utf8',
      }),
      /install_drift=none/,
    );
    assert.match(
      execFileSync(
        'bash',
        [
          join(
            destination,
            '.temari-package/scripts/check-skill-references.sh',
          ),
        ],
        { cwd: output, encoding: 'utf8' },
      ),
      /PASSED/,
    );
  }
});

test('portable Codex plugin has entry skills and a complete relocated payload', async (t) => {
  const output = await scratch(t);
  const artifact = await packageRuntime('portable', join(output, 'artifact'));
  const plugin = join(output, 'temari');
  assert.match(
    execFileSync(
      'bash',
      [
        join(artifact.root, 'scripts/build-codex-plugin.sh'),
        `--output=${plugin}`,
      ],
      { cwd: output, encoding: 'utf8' },
    ),
    /archon=unavailable/,
  );
  assert.deepEqual(await readdir(join(plugin, 'skills')), [
    'closeout',
    'poteto-mode',
    'temari',
  ]);
  assert.equal(
    JSON.parse(
      await readFile(join(plugin, '.codex-plugin/plugin.json'), 'utf8'),
    ).name,
    'temari',
  );
  assert.match(
    execFileSync(
      'bash',
      [join(plugin, 'package/scripts/check-skill-references.sh')],
      { cwd: output, encoding: 'utf8' },
    ),
    /PASSED/,
  );
});

test('relocated generic public entries load their bundled mapping and upstream instructions', async (t) => {
  const output = await scratch(t);
  const artifact = await packageRuntime('portable', join(output, 'artifact'));
  const original = join(output, 'original-skills');
  execFileSync(
    'bash',
    [
      join(artifact.root, 'scripts/install-host.sh'),
      '--host=generic',
      '--mode=copy',
      `--dest=${original}`,
    ],
    { cwd: output },
  );
  const moved = join(output, 'moved-skills');
  await rename(original, moved);
  await rm(artifact.root, { recursive: true });
  const pointer = (await readFile(join(moved, 'pstack-root'), 'utf8')).trim();
  const root = resolve(moved, pointer);
  for (const [entry, heading] of [
    ['temari', '# Temari'],
    ['poteto-mode', '# Poteto mode'],
    ['closeout', '# Closeout'],
  ]) {
    const publicPath = join(moved, entry, 'SKILL.md');
    const instructions = await readFile(publicPath, 'utf8');
    const mappingStep =
      instructions.split('\n').find((line) => line.startsWith('2. Read ')) ??
      '';
    const linked = mappingStep.match(/\]\(([^)]+)\)/);
    const rooted = mappingStep.match(/Read `([^`]+)` from the package root/);
    assert.ok(
      linked || rooted,
      `Missing executable mapping instruction in ${publicPath}`,
    );
    const mappingPath = linked
      ? resolve(dirname(publicPath), linked[1])
      : resolve(root, rooted![1]);
    assert.match(
      await readFile(mappingPath, 'utf8'),
      /^# Generic host mapping/m,
    );
    assert.ok(
      (await realpath(mappingPath)).startsWith((await realpath(root)) + '/'),
    );
    const routed = instructions.match(/Read package-root `([^`]+)`/);
    assert.ok(routed, `Missing upstream instruction in ${publicPath}`);
    assert.match(
      await readFile(resolve(root, routed[1]), 'utf8'),
      new RegExp('^' + heading + '$', 'm'),
    );
  }
});

test('independent copied-install audit detects changed runtime directories and root files', async (t) => {
  const output = await scratch(t);
  const artifact = await packageRuntime('portable', join(output, 'reference'));
  const destination = join(output, 'skills');
  execFileSync(
    'bash',
    [
      join(artifact.root, 'scripts/install-host.sh'),
      '--host=generic',
      '--mode=copy',
      `--dest=${destination}`,
    ],
    { cwd: output },
  );
  const control = join(
    artifact.root,
    'verification/verify-temari/scripts/control-temari',
  );
  const audit = () =>
    spawnSync('bash', [control, 'routing', '--dest', destination], {
      cwd: output,
      encoding: 'utf8',
    });
  let result = audit();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^install_comparison=independent-reference$/m);
  assert.match(result.stdout, /^install_drift=none$/m);
  const paths = [
    'adapters/generic/HOST.md',
    'agents/poteto-agent.md',
    'scripts/install-host.sh',
    'docs/guide/01-setup.md',
    'LICENSE',
    'UPSTREAM.md',
    'verification/verify-temari/scripts/verification-maintenance.mjs',
    'verification/verify-temari/scripts/verification-maintenance-test.mjs',
    'verification/verify-temari/features/verification-maintenance.md',
  ];
  for (const path of paths) {
    const installed = join(destination, '.temari-package', path);
    const original = await readFile(installed);
    if (path === 'adapters/generic/HOST.md') await rm(installed);
    else
      await writeFile(
        installed,
        Buffer.concat([
          original,
          Buffer.from('\nchanged by drift regression\n'),
        ]),
      );
    result = audit();
    assert.equal(result.status, 1, `Audit missed ${path}: ${result.stdout}`);
    assert.match(result.stdout, /^install_comparison=independent-reference$/m);
    assert.match(result.stdout, /^install_drift=[1-9][0-9]* files$/m);
    assert.match(result.stdout, /^routing_ok=no$/m);
    await writeFile(installed, original);
    result = audit();
    assert.equal(result.status, 0, `Restored ${path}: ${result.stdout}`);
    assert.match(result.stdout, /^install_drift=none$/m);
  }
});

test('independent copied-install audit checks one coherent host and all public projections', async (t) => {
  const output = await scratch(t);
  const artifact = await packageRuntime('portable', join(output, 'reference'));
  const control = join(
    artifact.root,
    'verification/verify-temari/scripts/control-temari',
  );
  for (const host of ['generic', 'codex', 'claude-code']) {
    const destination = join(output, host);
    execFileSync(
      'bash',
      [
        join(artifact.root, 'scripts/install-host.sh'),
        `--host=${host}`,
        '--mode=copy',
        '--include-verification',
        `--dest=${destination}`,
      ],
      { cwd: output },
    );
    const audit = () =>
      spawnSync('bash', [control, 'routing', '--dest', destination], {
        cwd: output,
        encoding: 'utf8',
      });
    assert.equal(audit().status, 0);
    for (const path of [
      'pstack-HOST.md',
      'temari/SKILL.md',
      'poteto-mode/SKILL.md',
      'closeout/SKILL.md',
      'verify-temari/SKILL.md',
    ]) {
      const installed = join(destination, path);
      const original = await readFile(installed);
      await writeFile(
        installed,
        Buffer.concat([original, Buffer.from('\nchanged public projection\n')]),
      );
      const changed = audit();
      assert.equal(
        changed.status,
        1,
        `Audit missed ${host}/${path}: ${changed.stdout}`,
      );
      assert.match(changed.stdout, /^install_drift=[1-9][0-9]* files$/m);
      await writeFile(installed, original);
      const restored = audit();
      assert.equal(restored.status, 0, restored.stdout);
      assert.match(restored.stdout, /^install_drift=none$/m);
    }
    const otherHost = host === 'generic' ? 'codex' : 'generic';
    await writeFile(
      join(destination, 'temari/SKILL.md'),
      await readFile(
        join(artifact.root, `adapters/${otherHost}/skills/temari/SKILL.md`),
      ),
    );
    assert.equal(
      audit().status,
      1,
      'A valid entry from another host must not match',
    );
    await writeFile(
      join(destination, 'temari/SKILL.md'),
      await readFile(
        join(artifact.root, `adapters/${host}/skills/temari/SKILL.md`),
      ),
    );
    await writeFile(
      join(destination, 'temari/unexpected.md'),
      'unknown public file',
    );
    assert.equal(
      audit().status,
      1,
      'Unknown public projection files must not match',
    );
    await rm(join(destination, 'temari/unexpected.md'));
    await rm(join(destination, 'verify-temari'), { recursive: true });
    assert.equal(audit().status, 0, 'Verification projection is optional');
    await rm(join(destination, 'closeout/SKILL.md'));
    assert.equal(audit().status, 1, 'Closeout projection is required');
  }
});

test('copied-install audit retains verification-evidence exclusion but compares skill dependencies', async (t) => {
  const output = await scratch(t);
  const artifact = await packageRuntime('portable', join(output, 'reference'));
  const destination = join(output, 'skills');
  execFileSync(
    'bash',
    [
      join(artifact.root, 'scripts/install-host.sh'),
      '--host=generic',
      '--mode=copy',
      `--dest=${destination}`,
    ],
    { cwd: output },
  );
  const control = join(
    artifact.root,
    'verification/verify-temari/scripts/control-temari',
  );
  const audit = () =>
    spawnSync('bash', [control, 'routing', '--dest', destination], {
      cwd: output,
      encoding: 'utf8',
    });
  const retained = join(
    destination,
    '.temari-package/verification/verify-temari/evidence',
  );
  await mkdir(retained);
  await writeFile(join(retained, 'retained.txt'), 'retained evidence');
  assert.equal(audit().status, 0);
  const dependencies = join(
    destination,
    '.temari-package/skills/poteto-mode/scripts/node_modules',
  );
  await mkdir(dependencies);
  await writeFile(join(dependencies, 'fixture.txt'), 'provisioned dependency');
  const changed = audit();
  assert.equal(changed.status, 1, changed.stdout);
  assert.match(changed.stdout, /^install_drift=[1-9][0-9]* files$/m);
  await rm(dependencies, { recursive: true });
  assert.equal(audit().status, 0);
});

test('same-tree routing health does not claim independently verified equality', async (t) => {
  const output = await scratch(t);
  const artifact = await packageRuntime('portable', join(output, 'reference'));
  const destination = join(output, 'skills');
  execFileSync(
    'bash',
    [
      join(artifact.root, 'scripts/install-host.sh'),
      '--host=generic',
      '--mode=copy',
      `--dest=${destination}`,
    ],
    { cwd: output },
  );
  const control = join(
    destination,
    '.temari-package/verification/verify-temari/scripts/control-temari',
  );
  for (const changed of [false, true]) {
    if (changed)
      await rm(join(destination, '.temari-package/adapters/generic/HOST.md'));
    const result = spawnSync(
      'bash',
      [control, 'routing', '--dest', destination],
      { cwd: output, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /^install_comparison=not-performed \(same tree; no independent reference\)$/m,
    );
    assert.match(result.stdout, /^install_drift=unknown$/m);
    assert.match(result.stdout, /^routing_ok=yes$/m);
    assert.doesNotMatch(result.stdout, /install_drift=none/);
  }
});

test('CLI rejects unknown options and invalid lanes before writing', () => {
  const cli = join(packageRoot, 'src/cli.ts');
  for (const args of [
    ['package', '--lane', 'other'],
    ['package', '--oops', 'x'],
    ['check', '--output', '/tmp/not-written'],
  ]) {
    const result = spawnSync(
      process.execPath,
      ['--import', '@swc-node/register/esm-register', cli, ...args],
      { cwd: resolveWorkspace(), encoding: 'utf8' },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:|Lane must/);
  }
});

function resolveWorkspace(): string {
  return join(packageRoot, '../..');
}

const maintenanceDirectory = 'verification/verify-temari';
const maintenanceReceipt =
  '.temari/runs/verification-maintenance/last-success.json';
const distributionCases = [
  { lane: 'portable', host: 'generic' },
  { lane: 'portable', host: 'codex' },
  { lane: 'portable', host: 'claude-code' },
  { lane: 'portable', host: 'plugin' },
  { lane: 'archon', host: 'generic' },
  { lane: 'archon', host: 'codex' },
  { lane: 'archon', host: 'claude-code' },
  { lane: 'archon', host: 'plugin' },
] as const;

async function maintenanceScratch(t: TestContext): Promise<string> {
  const retained = process.env.TEMARI_RUNTIME_TEST_EVIDENCE;
  if (!retained) return scratch(t);
  await mkdir(retained, { recursive: true });
  const root = await mkdtemp(join(retained, 'copied-maintenance-'));
  t.diagnostic(
    `Synthetic storage and copied CLI evidence retained at ${root}; no maintenance skill execution claimed.`,
  );
  return root;
}

async function capturedCommand(
  root: string,
  label: string,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd = root,
  timeout = 15000,
) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    timeout,
    encoding: 'utf8',
  });
  await writeFile(
    join(root, `${label}.json`),
    JSON.stringify(
      {
        command,
        args,
        cwd,
        status: result.status,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
        error: result.error?.message,
      },
      null,
      2,
    ),
  );
  assert.equal(result.error, undefined, `${label}: ${result.error?.message}`);
  return result;
}

test('maintenance payload omissions, byte changes and lost executable modes reject artifacts', async (t) => {
  const output = await scratch(t);
  const inventory = await readInventory();
  const artifact = await packageRuntime('portable', join(output, 'artifact'));
  for (const path of [
    `${maintenanceDirectory}/scripts/verification-maintenance.mjs`,
    `${maintenanceDirectory}/scripts/verification-maintenance-test.mjs`,
    `${maintenanceDirectory}/features/verification-maintenance.md`,
  ]) {
    const target = join(artifact.root, path);
    const bytes = await readFile(target);
    const mode = (await lstat(target)).mode;
    await rm(target);
    await assert.rejects(
      checkArtifact(artifact.root, inventory, 'portable'),
      /missing/,
    );
    await writeFile(target, Buffer.concat([bytes, Buffer.from('\nchanged\n')]));
    await chmod(target, mode);
    await assert.rejects(
      checkArtifact(artifact.root, inventory, 'portable'),
      /Hash mismatch/,
    );
    await writeFile(target, bytes);
    await chmod(target, mode ^ 0o111);
    await assert.rejects(
      checkArtifact(artifact.root, inventory, 'portable'),
      /Executable mode/,
    );
    await chmod(target, mode);
    await checkArtifact(artifact.root, inventory, 'portable');
  }
});

test('relocated distribution and host copies guard real effects with explicit owning repositories', async (t) => {
  const output = await maintenanceScratch(t);
  const inventory = await readInventory();
  for (const { lane, host } of distributionCases) {
    await t.test(`${lane}/${host}`, async () => {
      const root = join(output, `${lane}-${host}`);
      await mkdir(root);
      const artifact = await packageRuntime(lane, join(root, 'artifact'));
      const initial = join(root, 'initial', 'temari');
      const installArgs =
        host === 'plugin'
          ? [
              join(artifact.root, 'scripts/build-codex-plugin.sh'),
              `--output=${initial}`,
            ]
          : [
              join(artifact.root, 'scripts/install-host.sh'),
              `--host=${host}`,
              '--mode=copy',
              `--dest=${initial}`,
              '--include-verification',
            ];
      execFileSync('bash', installArgs, { cwd: root });
      const moved = join(root, 'relocated');
      await rename(initial, moved);
      const bundle = join(
        moved,
        host === 'plugin' ? 'package' : '.temari-package',
      );
      const selected = inventory.files.filter(
        (file) => lane === 'archon' || file.lane === 'portable',
      );
      await checkPayload(bundle, selected);
      await rm(artifact.root, { recursive: true });
      const alias = join(root, 'package-link');
      await symlink(bundle, alias);
      const control = join(
        alias,
        maintenanceDirectory,
        'scripts/control-temari',
      );
      const owner = join(root, 'owning-repository');
      execFileSync('git', ['init', '-q', owner]);
      execFileSync('git', ['init', '-q', bundle]);
      const env = {
        ...process.env,
        TEMARI_MAINTENANCE_REPO: '',
        TEMARI_VERIFY_RUN_ID: '',
        TEMARI_HOST_SKILL_ROOT: '',
        TEMARI_VERIFY_ROOT: join(root, 'scratch'),
        TEMARI_VERIFY_EVIDENCE: join(root, 'retained'),
      };
      const run = (label: string, args: string[]) =>
        capturedCommand(root, label, 'bash', [control, ...args], env, bundle);
      assert.equal(
        (await run('missing-owner', ['maintenance-status'])).status,
        2,
      );
      const status = await run('due-status', [
        'maintenance-status',
        '--repo',
        owner,
      ]);
      assert.equal(status.status, 0, status.stderr);
      assert.equal(JSON.parse(status.stdout).reason, 'missing-receipt');
      const effect = join(owner, 'effect.tsv');
      const target = [
        'log',
        '--',
        effect,
        'verify',
        'synthetic copied CLI effect',
        'guard regression',
        'synthetic',
        'recorded',
      ];
      const drive = ['drive', '--repo', owner, '--', ...target];
      const denied = await run('due-before-effect', drive);
      assert.equal(denied.status, 3, denied.stderr);
      assert.equal(denied.stdout, '');
      assert.match(denied.stderr, /No maintenance was executed/);
      await assert.rejects(readFile(effect), { code: 'ENOENT' });
      const receipt = join(owner, maintenanceReceipt);
      for (const outcome of ['blocked', 'failed']) {
        const result = await run(`missing-${outcome}`, [
          'maintenance-record',
          '--repo',
          owner,
          '--outcome',
          outcome,
        ]);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(JSON.parse(result.stdout).refreshed, false);
        await assert.rejects(readFile(receipt), { code: 'ENOENT' });
      }
      const proof = join(owner, 'synthetic-evidence.md');
      await writeFile(
        proof,
        'Synthetic storage/entrypoint fixture. No maintenance skill was executed.\n',
      );
      const completedAt = new Date(Date.now() - 1000).toISOString();
      const record = [
        'maintenance-record',
        '--repo',
        owner,
        '--run-id',
        'synthetic-copy',
        '--outcome',
        'clean',
        '--completed-at',
        completedAt,
        '--evidence',
        proof,
        '--attest-completed',
      ];
      const recorded = await run('clean-record', record);
      assert.equal(recorded.status, 0, recorded.stderr);
      assert.equal(
        JSON.parse(recorded.stdout).operation,
        'record-caller-attested-result',
      );
      const before = await readFile(receipt, 'utf8');
      const stored = JSON.parse(before);
      assert.equal(stored.repositoryRoot, await realpath(owner));
      assert.equal(stored.attestation, 'caller-attested');
      assert.equal(stored.completedAt, completedAt);
      assert.equal(stored.evidence.sha256, hash(await readFile(proof, 'utf8')));
      assert.equal((await run('fresh-effect', drive)).status, 0);
      const effectBytes = await readFile(effect, 'utf8');
      assert.match(
        effectBytes,
        /^ts\tphase\tdecision\twhy\tevidence\tresult\n/,
      );
      assert.match(
        effectBytes,
        /\tverify\tsynthetic copied CLI effect\tguard regression\tsynthetic\trecorded\n$/,
      );
      const replay = await run('replay', record);
      assert.equal(replay.status, 0, replay.stderr);
      assert.equal(JSON.parse(replay.stdout).replay, true);
      for (const outcome of ['blocked', 'failed']) {
        const result = await run(`existing-${outcome}`, [
          'maintenance-record',
          '--repo',
          owner,
          '--outcome',
          outcome,
        ]);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(JSON.parse(result.stdout).refreshed, false);
        assert.equal(await readFile(receipt, 'utf8'), before);
      }
      const cacheStatus = await run('cache-is-not-owner', [
        'maintenance-status',
        '--repo',
        bundle,
      ]);
      assert.equal(cacheStatus.status, 0, cacheStatus.stderr);
      assert.equal(JSON.parse(cacheStatus.stdout).reason, 'missing-receipt');
      await assert.rejects(readFile(join(bundle, maintenanceReceipt)), {
        code: 'ENOENT',
      });
      await writeFile(proof, 'Changed synthetic evidence.\n');
      const invalid = await run('changed-evidence-before-effect', drive);
      assert.equal(invalid.status, 3, invalid.stderr);
      assert.match(invalid.stderr, /invalid-receipt/);
      assert.equal(await readFile(effect, 'utf8'), effectBytes);
      const conflict = await run('conflicting-replay', record);
      assert.equal(conflict.status, 2, conflict.stderr);
      assert.match(conflict.stderr, /conflicting replay/);
      await rm(proof);
      assert.equal(
        (await run('missing-evidence-before-effect', drive)).status,
        3,
      );
      assert.equal(await readFile(effect, 'utf8'), effectBytes);
      assert.equal(await readFile(receipt, 'utf8'), before);
    });
  }
});

test('copied upstream ten-test maintenance suite uses preprovisioned Bun dependencies', async (t) => {
  const root = await maintenanceScratch(t);
  const artifact = await packageRuntime('portable', join(root, 'artifact'));
  const destination = join(root, 'skills');
  execFileSync(
    'bash',
    [
      join(artifact.root, 'scripts/install-host.sh'),
      '--host=generic',
      '--mode=copy',
      `--dest=${destination}`,
      '--include-verification',
    ],
    { cwd: root },
  );
  const bundle = join(destination, '.temari-package');
  await checkPayload(
    bundle,
    (await readInventory()).files.filter((file) => file.lane === 'portable'),
  );
  await rm(artifact.root, { recursive: true });
  const tools = join(bundle, 'skills/poteto-mode/scripts');
  const temporary = join(root, 'tmp');
  await mkdir(temporary);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TMPDIR: temporary,
    BUN_INSTALL_CACHE_DIR: join(root, 'bun-cache'),
    TEMARI_MAINTENANCE_TEST_ROOT: join(root, 'upstream-evidence'),
    TEMARI_MAINTENANCE_REPO: '',
    TEMARI_VERIFY_RUN_ID: '',
    TEMARI_HOST_SKILL_ROOT: '',
    TEMARI_VERIFY_ROOT: join(root, 'verifier-scratch'),
    TEMARI_VERIFY_EVIDENCE: join(root, 'verifier-evidence'),
  };
  delete env.NODE_TEST_CONTEXT;
  delete env.FORCE_COLOR;
  const version = await capturedCommand(
    root,
    'bun-version',
    'bun',
    ['--version'],
    env,
  );
  assert.equal(
    version.status,
    0,
    'Provide Bun 1.4.2 before running workflow-runtime:test.',
  );
  assert.equal(version.stdout.trim(), '1.4.2');
  const prepared = process.env.TEMARI_RUNTIME_TEST_DEPENDENCIES;
  if (prepared)
    await cp(prepared, join(tools, 'node_modules'), { recursive: true });
  else {
    const install = await capturedCommand(
      root,
      'provision-dependencies',
      'bun',
      ['install', '--frozen-lockfile', '--ignore-scripts'],
      env,
      tools,
      120000,
    );
    assert.equal(install.status, 0, install.stderr);
  }
  const bootstrap = await capturedCommand(
    root,
    'prepare-bootstrap',
    'bun',
    ['orch/orch.ts', '--help'],
    env,
    tools,
    120000,
  );
  assert.equal(bootstrap.status, 0, bootstrap.stderr);
  assert.match(bootstrap.stdout, /Plain-file orchestrate bookkeeping/);
  const installKey = createHash('sha256')
    .update(await readFile(join(tools, 'package.json')))
    .update('\0')
    .update(await readFile(join(tools, 'bun.lock')))
    .digest('hex');
  assert.equal(
    (
      await readFile(
        join(tools, 'node_modules/.poteto-mode-tools-install-key'),
        'utf8',
      )
    ).trim(),
    installKey,
  );
  const suite = await capturedCommand(
    root,
    'upstream-ten-tests',
    process.execPath,
    [
      '--test',
      '--test-reporter=tap',
      join(
        bundle,
        maintenanceDirectory,
        'scripts/verification-maintenance-test.mjs',
      ),
    ],
    env,
    root,
    120000,
  );
  t.diagnostic(suite.stdout);
  assert.equal(suite.status, 0, suite.stderr + suite.stdout);
  assert.match(suite.stdout, /# tests 10\b/);
  assert.match(suite.stdout, /# pass 10\b/);
  assert.match(suite.stdout, /# skipped 0\b/);
  await assert.rejects(readFile(join(bundle, maintenanceReceipt)), {
    code: 'ENOENT',
  });
});
