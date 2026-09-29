import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  writeFile,
} from 'node:fs/promises';
import { arch, platform, release, tmpdir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const stages = ['investigate', 'plan', 'build', 'review', 'verify', 'deliver'];
const productBefore = 'pear\napple\n';
const productAfter = 'APPLE\nPEAR\n';
const productAfterSha =
  'a356e1ad77377b48e6090cda3e5ae651809c835b3b9e65aa742d3d031b283fa8';
let childEnvironment;

async function assertAbsent(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`Refusing existing output target: ${path}`);
}

async function inventory(root) {
  const entries = [];
  async function visit(path, name) {
    const stat = await lstat(path);
    assert(!stat.isSymbolicLink(), `Symlink in artifact: ${path}`);
    if (stat.isDirectory()) {
      for (const child of (await readdir(path)).sort())
        await visit(join(path, child), name ? `${name}/${child}` : child);
      return;
    }
    assert(stat.isFile(), `Nonregular artifact entry: ${path}`);
    const bytes = await readFile(path);
    entries.push({
      path: name,
      sha256: sha(bytes),
      bytes: bytes.length,
      mode: stat.mode & 0o777,
    });
  }
  await visit(root, '');
  return entries;
}

const inventorySha = (items) => sha(Buffer.from(JSON.stringify(items)));

function within(root, path) {
  const rel = relative(root, path);
  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}

function bashPath(path) {
  const absolute = resolve(path);
  if (platform() !== 'win32') return absolute;
  const unix = absolute.replaceAll('\\', '/');
  const drive = /^([a-z]):(\/.*)$/i.exec(unix);
  assert(drive, `Git Bash requires a drive-backed absolute path: ${absolute}`);
  return `/${drive[1].toLowerCase()}${drive[2]}`;
}

function requireInventory(actual, expected, manifestName) {
  const files = new Map(actual.map((file) => [file.path, file]));
  assert.equal(files.size, expected.length + 1);
  assert(files.has(manifestName));
  for (const file of expected) {
    const found = files.get(file.path);
    assert(found, `Missing artifact file: ${file.path}`);
    assert.equal(
      found.sha256,
      file.sha256,
      `Changed artifact file: ${file.path}`,
    );
    assert.equal(
      found.bytes,
      file.bytes ?? found.bytes,
      `Changed length: ${file.path}`,
    );
  }
}

async function verifyArtifacts(
  publicRoot,
  publicSha,
  previousRoot,
  previousSha,
  candidateSha,
) {
  const publicBytes = await readFile(
    join(publicRoot, 'public-entry-manifest.json'),
  );
  assert.equal(
    sha(publicBytes),
    publicSha,
    'Public manifest differs from the external digest',
  );
  const publicManifest = JSON.parse(publicBytes);
  assert.equal(publicManifest.source.revision, candidateSha);
  assert.equal(publicManifest.source.dirty, false);
  assert.deepEqual(publicManifest.entries, [
    'temari',
    'poteto-mode',
    'closeout',
  ]);
  const publicInventory = await inventory(publicRoot);
  requireInventory(
    publicInventory,
    publicManifest.files,
    'public-entry-manifest.json',
  );

  const previousBytes = await readFile(
    join(previousRoot, '.temari-distribution.json'),
  );
  assert.equal(
    sha(previousBytes),
    previousSha,
    'v4.1 manifest differs from the external digest',
  );
  const previousManifest = JSON.parse(previousBytes);
  assert.equal(previousManifest.lane, 'portable');
  assert.equal(
    previousManifest.sourceRevision,
    '959c8f7be3d7b684207d9e626263d41540d5ecdc',
  );
  const previousInventory = await inventory(previousRoot);
  requireInventory(
    previousInventory,
    previousManifest.files.map((file) => ({
      path: file.path,
      sha256: file.artifactSha256,
    })),
    '.temari-distribution.json',
  );
  return {
    publicManifest,
    previousManifest,
    publicTreeSha256: inventorySha(publicInventory),
    previousTreeSha256: inventorySha(previousInventory),
  };
}

function request(entry, candidate, runDirectory, runId) {
  return {
    schemaVersion: 1,
    entry,
    route: 'lightweight-engineering',
    profile: 'lightweight-engineering-v1',
    obligations: {
      workType: 'feature',
      delegation: 'none',
      review: 'self',
      evidence: 'revision-bound',
      delivery: 'local',
    },
    routeInput: {
      workType: 'feature',
      lightweight: {
        resultIsClearLocalAndReversible: true,
        changesSharedBoundary: false,
        isReportedDefect: false,
        hasUnexplainedSymptom: false,
        makesPerformanceClaim: false,
        isDesignChoice: false,
        isMigration: false,
        affectedCallersAreKnown: true,
        crossesArchitecturalBoundary: false,
        directCheckAvailable: true,
      },
    },
    invocation: {
      runId,
      revision: 'nx06-synthetic-candidate-v1',
      candidate: { scopeId: 'nx06-synthetic-product', root: candidate },
      runDirectory,
    },
  };
}

async function runCommand(report, name, command, args, cwd, expectedExit = 0) {
  const output = await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: childEnvironment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (part) => {
      stdout += part;
    });
    child.stderr.on('data', (part) => {
      stderr += part;
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ exit: code, stdout, stderr }));
  });
  report.commands.push({ name, command, args, cwd, ...output });
  assert.equal(
    output.exit,
    expectedExit,
    `${name}: ${output.stderr}\n${output.stdout}`,
  );
  return output;
}

async function answerStage(root, candidate, message) {
  assert(within(root, message.workspace), 'Stage workspace left scratch root');
  assert.equal(message.type, 'stage');
  let evidence = `Observed ${message.stage} in synthetic fixture.\n`;
  if (message.stage === 'build') {
    assert.equal(
      await readFile(join(candidate, 'product.txt'), 'utf8'),
      productBefore,
    );
    await writeFile(join(candidate, 'product.txt'), productAfter);
    evidence =
      'diff --git a/product.txt b/product.txt\n-pear\n-apple\n+APPLE\n+PEAR\n';
  }
  if (message.stage === 'review') {
    assert.equal(
      await readFile(join(candidate, 'product.txt'), 'utf8'),
      productAfter,
    );
    evidence = 'Reviewed synthetic product.txt change.\n';
  }
  if (message.stage === 'verify') {
    assert.equal(
      sha(await readFile(join(candidate, 'product.txt'))),
      productAfterSha,
    );
    evidence = 'Direct check: synthetic product.txt has the expected bytes.\n';
  }
  if (message.stage === 'deliver')
    evidence =
      'Synthetic candidate is local. Publication approval remains open.\n';
  await writeFile(join(message.workspace, 'evidence.txt'), evidence);
  await writeFile(join(message.workspace, 'source.txt'), evidence);
  const claims = {
    investigate: ['lightweight.intake.inspect', 'document'],
    plan: ['lightweight.route.qualifies', 'document'],
    build: ['lightweight.build.smallest-complete-change', 'diff'],
    review: ['lightweight.verify.direct-check', 'diff'],
    verify: ['lightweight.verify.direct-check', 'command'],
  };
  await writeFile(
    join(message.workspace, 'host-result.json'),
    JSON.stringify({
      schemaVersion: 1,
      sessionId: message.sessionId,
      requestId: message.requestId,
      stage: message.stage,
      status: 'PASS',
      summary: `Synthetic ${message.stage} complete`,
      evidence: [
        { name: 'observation', kind: 'verification', path: 'evidence.txt' },
        { name: 'source', kind: 'other', path: 'source.txt' },
      ],
      sourceRequirements: claims[message.stage]
        ? [
            {
              id: claims[message.stage][0],
              sourceKind: claims[message.stage][1],
              evidenceName: 'source',
            },
          ]
        : [],
    }),
  );
}

async function installedRun(report, slot, root, entry, publicSha) {
  const candidate = join(root, `${entry}-candidate`);
  await mkdir(candidate);
  await writeFile(join(candidate, 'product.txt'), productBefore);
  const runDirectory = join(root, `${entry}-run`);
  const runId = `nx06-${entry}`;
  const requestPath = join(root, `${entry}-request.json`);
  const bytes = Buffer.from(
    JSON.stringify(request(entry, candidate, runDirectory, runId)),
  );
  await writeFile(requestPath, bytes);
  const args = [
    join(slot, `bin/${entry}.mjs`),
    'start',
    '--request',
    requestPath,
    '--expected-request-sha256',
    sha(bytes),
    '--expected-manifest-sha256',
    publicSha,
  ];
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: childEnvironment,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stderr.on('data', (part) => {
    stderr += part;
  });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (exit) => resolve(exit));
  });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 45_000);
  const observed = [];
  let completed;
  try {
    for await (const line of createInterface({ input: child.stdout })) {
      stdout += `${line}\n`;
      const message = JSON.parse(line);
      if (message.type === 'checkpoint') continue;
      if (message.type === 'complete') {
        completed = message;
        continue;
      }
      assert.equal(message.stage, stages[observed.length]);
      observed.push(message.stage);
      await answerStage(root, candidate, message);
      child.stdin.write(
        `${JSON.stringify({
          type: 'result',
          sessionId: message.sessionId,
          requestId: message.requestId,
          stage: message.stage,
        })}\n`,
      );
    }
  } finally {
    clearTimeout(timeout);
    child.stdin.end();
  }
  const exit = await closed;
  report.commands.push({
    name: `${entry}-installed-start`,
    command: process.execPath,
    args,
    cwd: root,
    exit,
    stdout,
    stderr,
  });
  assert.equal(exit, 0, stderr);
  assert.equal(completed?.status, 'PASS');
  assert.deepEqual(observed, stages);
  assert.equal(
    sha(await readFile(join(candidate, 'product.txt'))),
    productAfterSha,
  );
  const receipt = JSON.parse(
    await readFile(
      join(runDirectory, 'receipts', `${runId}.receipt.json`),
      'utf8',
    ),
  ).receipt;
  assert.equal(receipt.status, 'PASS');
  assert.deepEqual(
    receipt.stages.map((stage) => stage.stage),
    stages,
  );
  assert.deepEqual(receipt.capabilities.available, []);
  return {
    candidate,
    runDirectory,
    requestPath,
    requestBytes: bytes,
    runId,
    receiptSha256: sha(Buffer.from(JSON.stringify(receipt))),
  };
}

async function selectedCurrent(candidate) {
  const bytes = await readFile(join(candidate, 'product.txt'));
  assert.equal(bytes.toString(), productAfter);
  const mode = (await lstat(join(candidate, 'product.txt'))).mode & 0o777;
  return {
    scope: 'local-regular-files-v1',
    sha256: sha(
      Buffer.from(
        JSON.stringify([
          'local-regular-files-v1',
          [['product.txt', mode, bytes.length, sha(bytes)]],
        ]),
      ),
    ),
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      'public-artifact': { type: 'string' },
      'public-sha256': { type: 'string' },
      'previous-artifact': { type: 'string' },
      'previous-sha256': { type: 'string' },
      'candidate-sha': { type: 'string' },
      output: { type: 'string' },
    },
  });
  for (const key of ['public-artifact', 'previous-artifact', 'output'])
    assert(isAbsolute(values[key] ?? ''), `${key} must be absolute`);
  for (const key of ['public-sha256', 'previous-sha256'])
    assert(/^[a-f0-9]{64}$/.test(values[key] ?? ''), `${key} must be SHA-256`);
  assert(/^[a-f0-9]{40}$/.test(values['candidate-sha'] ?? ''));
  const publicRoot = resolve(values['public-artifact']);
  const previousRoot = resolve(values['previous-artifact']);
  const requestedOutput = resolve(values.output);
  const output = resolve(
    await realpath(dirname(requestedOutput)),
    basename(requestedOutput),
  );
  const [publicRealRoot, previousRealRoot] = await Promise.all([
    realpath(publicRoot),
    realpath(previousRoot),
  ]);
  assert(!within(publicRealRoot, output) && !within(previousRealRoot, output));
  assert(!within(output, publicRealRoot) && !within(output, previousRealRoot));
  await assertAbsent(output);
  await mkdir(output);
  const nx06Temporary = join(output, 'nx06-temporary');
  await mkdir(nx06Temporary);
  childEnvironment = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    TMPDIR: nx06Temporary,
    TMP: nx06Temporary,
    TEMP: nx06Temporary,
    LANG: 'C',
    LC_ALL: 'C',
    NODE_OPTIONS: '',
    NODE_PATH: '',
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  };
  const report = {
    schemaVersion: 1,
    candidateSha: values['candidate-sha'],
    environment: {
      node: process.version,
      os: platform(),
      arch: arch(),
      release: release(),
      tmpdir: tmpdir(),
      childEnvironmentKeys: Object.keys(childEnvironment),
    },
    input: {
      publicArtifact: publicRoot,
      publicManifestSha256: values['public-sha256'],
      previousArtifact: previousRoot,
      previousManifestSha256: values['previous-sha256'],
    },
    commands: [],
    gates: {
      localPreparatoryRehearsal: 'NOT VERIFIED',
      qa: 'OPEN',
      privacy: 'OPEN',
      sharedService: 'BLOCKED',
      secondHost: 'OPEN',
      cutover: 'BLOCKED',
    },
  };
  try {
    const checked = await verifyArtifacts(
      publicRoot,
      values['public-sha256'],
      previousRoot,
      values['previous-sha256'],
      values['candidate-sha'],
    );
    report.input.publicTreeSha256 = checked.publicTreeSha256;
    report.input.previousTreeSha256 = checked.previousTreeSha256;
    const pnpm = await runCommand(
      report,
      'pnpm-version',
      platform() === 'win32'
        ? join(process.env.SystemRoot, 'System32', 'cmd.exe')
        : 'pnpm',
      platform() === 'win32'
        ? ['/d', '/s', '/c', 'pnpm.cmd --version']
        : ['--version'],
      output,
    );
    report.environment.pnpm = pnpm.stdout.trim();

    const slot = join(output, 'slot');
    await assertAbsent(slot);
    await cp(publicRoot, slot, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    const beforeRollbackSha256 = inventorySha(await inventory(slot));
    assert.equal(beforeRollbackSha256, checked.publicTreeSha256);
    report.rollback = { beforeSha256: beforeRollbackSha256 };
    for (const entry of ['temari', 'poteto-mode']) {
      const policy = await runCommand(
        report,
        `${entry}-policy`,
        process.execPath,
        [join(slot, `bin/${entry}.mjs`), 'policy'],
        output,
      );
      assert.equal(JSON.parse(policy.stdout).status, 'described');
    }
    const fullRequestPath = join(output, 'full-request.json');
    await writeFile(
      fullRequestPath,
      JSON.stringify({
        schemaVersion: 1,
        entry: 'temari',
        route: 'full-playbook',
        profile: 'feature-v1',
        obligations: {
          workType: 'feature',
          delegation: 'required',
          review: 'independent',
          evidence: 'revision-bound',
          delivery: 'pull-request',
        },
      }),
    );
    const full = await runCommand(
      report,
      'full-capability-refusal',
      process.execPath,
      [join(slot, 'bin/temari.mjs'), 'admit', '--request', fullRequestPath],
      output,
      1,
    );
    assert.equal(JSON.parse(full.stdout).status, 'blocked');
    assert.deepEqual(JSON.parse(full.stdout).missingCapabilities, [
      'subagents',
      'forge',
    ]);
    const qaRequestPath = join(output, 'qa-request.json');
    await writeFile(
      qaRequestPath,
      JSON.stringify({
        schemaVersion: 1,
        entry: 'temari',
        route: 'qa-review',
        profile: 'qa-review-v1',
        obligations: {
          workType: 'qa',
          delegation: 'none',
          review: 'independent',
          evidence: 'revision-bound',
          delivery: 'local',
        },
      }),
    );
    const qa = await runCommand(
      report,
      'qa-refusal',
      process.execPath,
      [join(slot, 'bin/temari.mjs'), 'admit', '--request', qaRequestPath],
      output,
      1,
    );
    assert.equal(JSON.parse(qa.stdout).status, 'rejected');

    const temari = await installedRun(
      report,
      slot,
      output,
      'temari',
      values['public-sha256'],
    );
    await installedRun(
      report,
      slot,
      output,
      'poteto-mode',
      values['public-sha256'],
    );
    const current = await selectedCurrent(temari.candidate);
    const currentPath = join(output, 'selected-current.json');
    const currentBytes = Buffer.from(JSON.stringify(current));
    await writeFile(currentPath, currentBytes);
    const runBefore = inventorySha(await inventory(temari.runDirectory));
    const candidateBefore = inventorySha(await inventory(temari.candidate));
    const closeout = await runCommand(
      report,
      'installed-closeout',
      process.execPath,
      [
        join(slot, 'bin/closeout.mjs'),
        'verify',
        '--request',
        temari.requestPath,
        '--expected-request-sha256',
        sha(temari.requestBytes),
        '--expected-manifest-sha256',
        values['public-sha256'],
        '--expected-current',
        currentPath,
        '--expected-current-sha256',
        sha(currentBytes),
      ],
      output,
    );
    assert.equal(JSON.parse(closeout.stdout).status, 'candidate-verified');
    assert.equal(inventorySha(await inventory(temari.runDirectory)), runBefore);
    assert.equal(
      inventorySha(await inventory(temari.candidate)),
      candidateBefore,
    );
    report.installed = {
      productSha256: productAfterSha,
      closeoutCurrent: current,
      temariReceiptSha256: temari.receiptSha256,
    };

    const previous = join(output, 'previous-projection');
    await assertAbsent(previous);
    await runCommand(
      report,
      'install-prior-v4.1',
      'bash',
      [
        bashPath(join(previousRoot, 'scripts/install-host.sh')),
        '--host=generic',
        '--mode=copy',
        `--dest=${bashPath(previous)}`,
        '--include-verification',
      ],
      output,
    );
    await assertAbsent(join(previous, '.temari-backups'));
    const previousProjectionSha256 = inventorySha(await inventory(previous));
    const quarantined = join(output, 'quarantined-successor');
    await assertAbsent(quarantined);
    await rename(slot, quarantined);
    await assertAbsent(slot);
    await cp(previous, slot, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    const afterRollbackSha256 = inventorySha(await inventory(slot));
    assert.equal(afterRollbackSha256, previousProjectionSha256);
    const routing = await runCommand(
      report,
      'restored-v4.1-routing',
      'bash',
      [
        bashPath(
          join(
            slot,
            '.temari-package/verification/verify-temari/scripts/control-temari',
          ),
        ),
        'routing',
        '--dest',
        bashPath(slot),
      ],
      output,
    );
    assert.match(routing.stdout, /routing_ok=yes/);
    assert.match(routing.stdout, /install_mode=copy/);
    report.rollback = {
      ...report.rollback,
      previousProjectionSha256,
      afterSha256: afterRollbackSha256,
      quarantinedSuccessorSha256: inventorySha(await inventory(quarantined)),
      restoredInvocation: 'routing_ok=yes',
    };
    assert.equal(
      report.rollback.quarantinedSuccessorSha256,
      beforeRollbackSha256,
    );
    report.gates.localPreparatoryRehearsal = 'PASS';
  } catch (error) {
    report.error = String(error.stack ?? error);
    process.exitCode = 1;
  }
  await writeFile(
    join(output, 'result.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(
    JSON.stringify({
      output,
      candidateSha: report.candidateSha,
      gates: report.gates,
      rollback: report.rollback,
      error: report.error,
    }),
  );
}

await main();
