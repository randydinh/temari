import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, resolve } from 'node:path';
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
const publicFiles = [
  ['packages/workflow-runtime/public/policy.json', 'policy.json'],
  [
    'packages/workflow-runtime/public/.codex-plugin/plugin.json',
    '.codex-plugin/plugin.json',
  ],
  ['packages/workflow-runtime/host/entry.mjs', 'host/entry.mjs'],
  ['packages/workflow-runtime/host/stdio.mjs', 'host/stdio.mjs'],
  [
    'packages/workflow-runtime/public/bin/public-entry.mjs',
    'bin/public-entry.mjs',
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
    'packages/workflow-runtime/public/skills/closeout/SKILL.md',
    'skills/closeout/SKILL.md',
  ],
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
  assert.equal(policy.policyId, 'temari-public-feature-v1');
  assert.deepEqual(Object.keys(policy.entries).sort(), [...entries].sort());
  assert.equal(policy.entries.temari.supportedRoute, 'full-playbook');
  assert.equal(policy.entries['poteto-mode'].supportedProfile, 'feature-v1');
  assert.equal(policy.entries.closeout.supportedRoute, null);
  assert.equal(policy.feature.source.family, 'v4.1');
  assert.match(policy.feature.source.sourceRevision, /^[a-f0-9]{40}$/);
  assert.match(policy.feature.source.profileSha256, /^[a-f0-9]{64}$/);
  assert.match(policy.feature.source.playbookSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(policy.feature.requiredCapabilities, ['subagents', 'forge']);
  assert.deepEqual(policy.feature.unsupportedRoutes, [
    'lightweight-engineering',
    'qa-review',
  ]);
  assert.equal(policy.admission.capabilitiesMustBeProvenByHost, true);
  assert.equal(policy.admission.callerDeclaredCapabilitiesAreNotProof, true);
  assert.equal(policy.admission.publicEntriesStartNoLifecycle, true);
  assert.equal(
    policy.admission.closeoutRequiresTrustedInvocationAndCurrentCandidate,
    true,
  );
}

/** Checks the complete outer bundle, including the nested canonical runtime. */
export async function checkPublicEntryArtifact(root, expectedManifest) {
  assert(isAbsolute(root), 'Artifact path must be absolute');
  const files = await artifactFiles(root);
  assert(files.has(manifestName), `Missing ${manifestName}`);
  const manifest = JSON.parse(files.get(manifestName).toString());
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
  if (expectedManifest !== undefined)
    assert.deepEqual(manifest, expectedManifest);

  files.delete(manifestName);
  assert.deepEqual(
    manifest.files,
    sortedRecords(files),
    'Outer artifact inventory differs from its files.',
  );
  const expectedPaths = [
    ...publicFiles.map(([, destination]) => destination),
    ...[...files.keys()].filter((path) => path.startsWith('runtime/')),
    manifestName,
  ].sort();
  assert.deepEqual(expectedPublicPaths(files), expectedPaths);
  const policy = JSON.parse(files.get('policy.json').toString());
  assertPolicy(policy);
  const plugin = JSON.parse(files.get('.codex-plugin/plugin.json').toString());
  assert.equal(plugin.name, 'temari');
  assert.equal(plugin.skills, './skills/');
  for (const entry of entries) {
    const path = `bin/${entry}.mjs`;
    assert(files.has(path), `Missing public entry: ${entry}`);
    const stat = await lstat(join(root, path));
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
export async function packagePublicEntries(output) {
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
  await mkdir(output);
  const runtime = join(output, 'runtime');
  await packageCanonicalRuntime(runtime);
  for (const [source, destination] of publicFiles) {
    await exclusiveCopy(
      source,
      join(output, destination),
      destination.startsWith('bin/'),
    );
  }

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
      tool: record('tools/public-entry-runtime.mjs', await readFile(toolPath)),
    },
    entries,
    runtimeManifestSha256: digest(canonicalBytes),
    files: [],
  };
  const files = await artifactFiles(output);
  files.delete(manifestName);
  manifest.files = sortedRecords(files);
  await writeFile(join(output, manifestName), jsonBytes(manifest), {
    flag: 'wx',
  });
  return checkPublicEntryArtifact(output, manifest);
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === pathToFileURL(toolPath).href
) {
  try {
    const { values, positionals } = parseArgs({
      options: { output: { type: 'string' }, artifact: { type: 'string' } },
      allowPositionals: true,
    });
    const [command] = positionals;
    assert(
      positionals.length === 1 &&
        ((command === 'package' && values.output && !values.artifact) ||
          (command === 'check' && values.artifact && !values.output)),
      'Usage: public-entry-runtime.mjs package --output ABSOLUTE_NEW_PATH | check --artifact ABSOLUTE_PATH',
    );
    const manifest =
      command === 'package'
        ? await packagePublicEntries(values.output)
        : await checkPublicEntryArtifact(values.artifact);
    console.log(JSON.stringify(manifest, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
