import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  checkCanonicalArtifact,
  packageCanonicalRuntime,
} from './canonical-runtime.mjs';

const toolPath = fileURLToPath(import.meta.url);
const workspace = resolve(dirname(toolPath), '..');
const manifestName = 'public-entry-manifest.json';
const entries = ['temari', 'poteto-mode', 'closeout'];
const generatedFiles = ['bin/codex-parallel.mjs'];
const publicFiles = [
  ['packages/workflow-runtime/public/policy.json', 'policy.json'],
  [
    'packages/workflow-runtime/public/.codex-plugin/plugin.json',
    '.codex-plugin/plugin.json',
  ],
  ['packages/workflow-runtime/host/entry.mjs', 'host/entry.mjs'],
  ['packages/workflow-runtime/host/stdio.mjs', 'host/stdio.mjs'],
  ['packages/workflow-runtime/host/source.mjs', 'host/source.mjs'],
  ['packages/workflow-runtime/host/invocation.mjs', 'host/invocation.mjs'],
  ['packages/workflow-runtime/host/closeout.mjs', 'host/closeout.mjs'],
  [
    'packages/workflow-runtime/assets/v4.1/skills/poteto-mode/playbook-contracts/v1/lightweight-engineering.json',
    'source/lightweight-engineering.json',
  ],
  [
    'packages/workflow-runtime/assets/v4.1/skills/poteto-mode/playbooks/lightweight-engineering.md',
    'source/lightweight-engineering.md',
  ],
  [
    'packages/workflow-runtime/public/bin/public-entry.mjs',
    'bin/public-entry.mjs',
  ],
  [
    'packages/workflow-runtime/public/bin/overlay-check.mjs',
    'bin/overlay-check.mjs',
  ],
  ['packages/workflow-runtime/public/bin/temari.mjs', 'bin/temari.mjs'],
  [
    'packages/workflow-runtime/public/bin/poteto-mode.mjs',
    'bin/poteto-mode.mjs',
  ],
  ['packages/workflow-runtime/public/bin/closeout.mjs', 'bin/closeout.mjs'],
  [
    'packages/workflow-runtime/public/skills/temari/SKILL.md',
    'skills/temari/SKILL.md',
  ],
  [
    'packages/workflow-runtime/public/skills/poteto-mode/SKILL.md',
    'skills/poteto-mode/SKILL.md',
  ],
  [
    'packages/workflow-runtime/public/skills/poteto-mode/references/codex-parallel-workers.md',
    'skills/poteto-mode/references/codex-parallel-workers.md',
  ],
  [
    'packages/workflow-runtime/public/skills/closeout/SKILL.md',
    'skills/closeout/SKILL.md',
  ],
  ...[
    'SKILL.md',
    'CHANGELOG.md',
    'references/maintenance.md',
    'assets/ticket-comment.md',
    'assets/ticket-verification.md',
    'assets/release-qa-report.md',
  ].map((path) => [
    `packages/workflow-runtime/public/skills/qa-review-verification/${path}`,
    `skills/qa-review-verification/${path}`,
  ]),
];

function digest(content) {
  return createHash('sha256').update(content).digest('hex');
}

function record(path, content) {
  return { path, sha256: digest(content), bytes: Buffer.byteLength(content) };
}

function safePath(path) {
  assert(
    typeof path === 'string' &&
      path.length > 0 &&
      !path.includes('\\') &&
      !path.includes(':') &&
      !/[\x00-\x1f]/.test(path) &&
      !posix.isAbsolute(path) &&
      path
        .split('/')
        .every((part) => part !== '' && part !== '.' && part !== '..'),
    `Unsafe artifact path: ${path}`,
  );
  return path;
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

export function manifestSha256(manifest) {
  return digest(jsonBytes(manifest));
}

function sortedRecords(files) {
  return [...files]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, content]) => record(path, content));
}

function git(...args) {
  return execFileSync('git', ['-C', workspace, ...args], {
    encoding: 'utf8',
  }).trim();
}

async function artifactFiles(root) {
  const files = new Map();
  const walk = async (path) => {
    const absolute = path ? join(root, path) : root;
    const stat = await lstat(absolute);
    assert(!stat.isSymbolicLink(), `Symlink not permitted: ${absolute}`);
    if (stat.isDirectory()) {
      for (const entry of await readdir(absolute))
        await walk(path ? `${path}/${entry}` : entry);
    } else {
      assert(stat.isFile(), `Nonregular artifact file: ${absolute}`);
      safePath(path);
      files.set(path, await readFile(absolute));
    }
  };
  await walk('');
  return files;
}

async function exclusiveCopy(sourceRelative, destination, executable = false) {
  const source = join(workspace, sourceRelative);
  const sourceStat = await lstat(source);
  assert(sourceStat.isFile() && !sourceStat.isSymbolicLink());
  const content = await readFile(source);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, content, { flag: 'wx' });
  if (executable) await chmod(destination, 0o755);
  return content;
}

function expectedPublicPaths(files) {
  return [...files.keys(), 'public-entry-manifest.json'].sort();
}

function assertPolicy(policy) {
  assert.equal(policy.schemaVersion, 1);
  assert.equal(policy.policyId, 'temari-public-lightweight-v1');
  assert.deepEqual(Object.keys(policy.entries).sort(), [...entries].sort());
  for (const entry of ['temari', 'poteto-mode']) {
    assert.equal(
      policy.entries[entry].supportedRoute,
      'lightweight-engineering',
    );
    assert.equal(
      policy.entries[entry].supportedProfile,
      'lightweight-engineering-v1',
    );
  }
  assert.equal(policy.entries.closeout.supportedRoute, null);
  assert.equal(policy.lightweight.source.family, 'v4.1');
  assert.equal(
    policy.lightweight.source.sourceRevision,
    '959c8f7be3d7b684207d9e626263d41540d5ecdc',
  );
  assert.equal(
    policy.lightweight.source.profilePath,
    'skills/poteto-mode/playbook-contracts/v1/lightweight-engineering.json',
  );
  assert.equal(
    policy.lightweight.source.profileSha256,
    '94370c4bbbd48666807630abd2866f0727ccf3ab614d23fd4b2d3c3b98d493e7',
  );
  assert.equal(
    policy.lightweight.source.playbookPath,
    'skills/poteto-mode/playbooks/lightweight-engineering.md',
  );
  assert.equal(
    policy.lightweight.source.playbookSha256,
    '320f33d095434c5a58fd2adb2abf6a1fcd458fe3a2af431a227d6f51dde6e492',
  );
  assert.deepEqual(policy.lightweight.obligations, {
    workType: 'feature',
    delegation: 'none',
    review: 'self',
    evidence: 'revision-bound',
    delivery: 'local',
  });
  assert.deepEqual(policy.lightweight.stageMapping, {
    investigate: ['lightweight.intake.inspect'],
    plan: ['lightweight.route.qualifies'],
    build: ['lightweight.build.smallest-complete-change'],
    review: ['lightweight.verify.direct-check'],
    verify: ['lightweight.verify.direct-check'],
    deliver: [
      'lightweight.intake.inspect',
      'lightweight.route.qualifies',
      'lightweight.build.smallest-complete-change',
      'lightweight.verify.direct-check',
    ],
  });
  assert.equal(policy.lightweight.publishGate, 'operator-approval');
  assert.equal(policy.feature.source.family, 'v4.1');
  assert.match(policy.feature.source.sourceRevision, /^[a-f0-9]{40}$/);
  assert.match(policy.feature.source.profileSha256, /^[a-f0-9]{64}$/);
  assert.match(policy.feature.source.playbookSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(policy.feature.requiredCapabilities, ['subagents', 'forge']);
  assert.deepEqual(policy.feature.unsupportedRoutes, ['qa-review']);
  assert.equal(policy.admission.capabilitiesMustBeProvenByHost, true);
  assert.equal(policy.admission.callerDeclaredCapabilitiesAreNotProof, true);
  assert.equal(policy.admission.publicEntriesStartNoLifecycle, false);
  assert.equal(
    policy.admission.externalArtifactAndInvocationDigestsRequired,
    true,
  );
  assert.equal(
    policy.admission.closeoutRequiresTrustedInvocationAndCurrentCandidate,
    true,
  );
}

/** Checks the complete outer bundle, including the nested canonical runtime. */
export async function checkPublicEntryArtifact(root, expectedManifestSha256) {
  assert(isAbsolute(root), 'Artifact path must be absolute');
  assert.match(
    expectedManifestSha256 ?? '',
    /^[a-f0-9]{64}$/,
    'An external expected manifest digest is required.',
  );
  const files = await artifactFiles(root);
  assert(files.has(manifestName), `Missing ${manifestName}`);
  const manifestBytes = files.get(manifestName);
  assert.equal(
    digest(manifestBytes),
    expectedManifestSha256,
    'Manifest does not match the external expected digest.',
  );
  const manifest = JSON.parse(manifestBytes.toString());
  assert.equal(manifest.schemaVersion, 1);
  assert.match(manifest.source.revision, /^[a-f0-9]{40,64}$/);
  assert.equal(typeof manifest.source.dirty, 'boolean');
  assert(Array.isArray(manifest.source.files));
  assert(Array.isArray(manifest.files));
  assert.deepEqual(manifest.entries, entries);
  assert.match(manifest.runtimeManifestSha256, /^[a-f0-9]{64}$/);
  for (const entry of [...manifest.source.files, ...manifest.files]) {
    safePath(entry.path);
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    assert(Number.isSafeInteger(entry.bytes) && entry.bytes >= 0);
  }
  files.delete(manifestName);
  assert.deepEqual(
    manifest.files,
    sortedRecords(files),
    'Outer artifact inventory differs from its files.',
  );
  const expectedPaths = [
    ...publicFiles.map(([, destination]) => destination),
    ...generatedFiles,
    ...[...files.keys()].filter((path) => path.startsWith('runtime/')),
    manifestName,
  ].sort();
  assert.deepEqual(expectedPublicPaths(files), expectedPaths);
  const policy = JSON.parse(files.get('policy.json').toString());
  assertPolicy(policy);
  const plugin = JSON.parse(files.get('.codex-plugin/plugin.json').toString());
  assert.equal(plugin.name, 'temari');
  assert.equal(plugin.skills, './skills/');
  assert.equal(manifest.build.parallelBundler.name, 'bun');
  assert.match(manifest.build.parallelBundler.version, /^\d+\.\d+\.\d+/);
  assert(files.has('bin/codex-parallel.mjs'));
  for (const entry of entries) {
    const path = `bin/${entry}.mjs`;
    assert(files.has(path), `Missing public entry: ${entry}`);
    const stat = await lstat(join(root, path));
    // Windows does not expose POSIX execute bits for these Node entry files.
    if (process.platform !== 'win32')
      assert(stat.mode & 0o111, `Entry is not executable: ${path}`);
  }
  for (const [path, content] of files) {
    assert(
      !content.toString().includes(workspace),
      `Leaked workspace path: ${path}`,
    );
  }

  const canonicalManifest = await checkCanonicalArtifact(join(root, 'runtime'));
  assert.equal(
    manifest.runtimeManifestSha256,
    digest(jsonBytes(canonicalManifest)),
  );
  return manifest;
}

/** Builds an exclusive outer bundle; it never replaces an existing destination. */
export async function packagePublicEntries(
  output,
  { packageCanonical = packageCanonicalRuntime } = {},
) {
  assert(isAbsolute(output), 'Output path must be absolute');
  try {
    await lstat(output);
    throw new Error(`Output already exists: ${output}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const sourceFiles = new Map();
  sourceFiles.set('tools/public-entry-runtime.mjs', await readFile(toolPath));
  sourceFiles.set(
    'tools/canonical-runtime.mjs',
    await readFile(join(workspace, 'tools/canonical-runtime.mjs')),
  );
  for (const [source, destination] of publicFiles) {
    sourceFiles.set(source, await readFile(join(workspace, source)));
  }

  await mkdir(dirname(output), { recursive: true });
  const reservationPath = `${output}.publish-lock`;
  let reservation;
  try {
    reservation = await open(reservationPath, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST')
      throw new Error(`Output is already reserved: ${output}`);
    throw error;
  }
  let staging;
  let published = false;
  try {
    staging = await mkdtemp(
      join(dirname(output), `.${basename(output)}.staging-`),
    );
    const runtime = join(staging, 'runtime');
    await packageCanonical(runtime);
    for (const [source, destination] of publicFiles) {
      await exclusiveCopy(
        source,
        join(staging, destination),
        destination.startsWith('bin/'),
      );
    }
    const parallelBundle = join(staging, generatedFiles[0]);
    const parallelMetafile = join(staging, 'parallel-metafile.json');
    execFileSync(
      'bun',
      [
        'build',
        '--target=node',
        '--format=esm',
        '--reject-unresolved',
        `--metafile=${parallelMetafile}`,
        `--outfile=${parallelBundle}`,
        'tools/run-codex-parallel.mts',
      ],
      { cwd: workspace, encoding: 'utf8' },
    );
    const parallelInputs = Object.keys(
      JSON.parse(await readFile(parallelMetafile, 'utf8')).inputs,
    );
    assert(parallelInputs.includes('tools/run-codex-parallel.mts'));
    for (const source of parallelInputs) {
      safePath(source);
      sourceFiles.set(source, await readFile(join(workspace, source)));
    }
    await rm(parallelMetafile);
    await chmod(parallelBundle, 0o755);

    const canonicalBytes = await readFile(
      join(runtime, 'canonical-manifest.json'),
    );
    const manifest = {
      schemaVersion: 1,
      source: {
        revision: git('rev-parse', 'HEAD'),
        dirty: git('status', '--porcelain=v1', '--untracked-files=all') !== '',
        files: sortedRecords(sourceFiles),
      },
      build: {
        node: process.version,
        parallelBundler: {
          name: 'bun',
          version: execFileSync('bun', ['--version'], {
            encoding: 'utf8',
          }).trim(),
        },
        tool: record(
          'tools/public-entry-runtime.mjs',
          await readFile(toolPath),
        ),
      },
      entries,
      runtimeManifestSha256: digest(canonicalBytes),
      files: [],
    };
    const files = await artifactFiles(staging);
    files.delete(manifestName);
    manifest.files = sortedRecords(files);
    const manifestBytes = jsonBytes(manifest);
    await writeFile(join(staging, manifestName), manifestBytes, {
      flag: 'wx',
    });
    const expectedManifestSha256 = digest(manifestBytes);
    await checkPublicEntryArtifact(staging, expectedManifestSha256);

    try {
      await lstat(output);
      throw new Error(`Output already exists: ${output}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await rename(staging, output);
    published = true;
    return checkPublicEntryArtifact(output, expectedManifestSha256);
  } finally {
    if (staging && !published)
      await rm(staging, { recursive: true, force: true });
    await reservation.close();
    await rm(reservationPath, { force: true });
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === pathToFileURL(toolPath).href
) {
  try {
    const { values, positionals } = parseArgs({
      options: {
        output: { type: 'string' },
        artifact: { type: 'string' },
        'expected-manifest-sha256': { type: 'string' },
      },
      allowPositionals: true,
    });
    const [command] = positionals;
    const expectedManifestSha256 = values['expected-manifest-sha256'];
    assert(
      positionals.length === 1 &&
        ((command === 'package' &&
          values.output &&
          !values.artifact &&
          expectedManifestSha256 === undefined) ||
          (command === 'check' &&
            values.artifact &&
            !values.output &&
            expectedManifestSha256 !== undefined)),
      'Usage: public-entry-runtime.mjs package --output ABSOLUTE_NEW_PATH | check --artifact ABSOLUTE_PATH --expected-manifest-sha256 HEX',
    );
    const manifest =
      command === 'package'
        ? await packagePublicEntries(values.output)
        : await checkPublicEntryArtifact(
            values.artifact,
            expectedManifestSha256,
          );
    console.log(JSON.stringify(manifest, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
