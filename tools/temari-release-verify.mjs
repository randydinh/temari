import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const TEMARI_MARKETPLACE = 'temari-private';
export const TEMARI_PLUGIN_ID = `temari@${TEMARI_MARKETPLACE}`;
export const TEMARI_CURRENT_VERSION = '0.15.5';
export const TEMARI_HISTORICAL_VERSION = '0.15.4+codex.2';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function safePath(path) {
  assert(
    typeof path === 'string' &&
      path.length &&
      !posix.isAbsolute(path) &&
      !/[\\:\x00-\x1f\x7f]/.test(path) &&
      path.split('/').every((part) => part && part !== '.' && part !== '..'),
    `Unsafe release path: ${path}`,
  );
}

async function filesAt(root) {
  assert(isAbsolute(root), 'Root must be absolute');
  const files = new Map(),
    directories = new Set(),
    folded = new Set();
  async function walk(path = '') {
    const stat = await lstat(join(root, path));
    assert(
      !stat.isSymbolicLink(),
      `Release symlink not permitted: ${path || root}`,
    );
    if (stat.isDirectory()) {
      if (path) directories.add(path);
      for (const name of (await readdir(join(root, path))).sort(compare))
        await walk(path ? `${path}/${name}` : name);
    } else {
      assert(
        stat.isFile() && stat.size <= 16 * 1024 * 1024,
        `Invalid release file: ${path}`,
      );
      safePath(path);
      const lower = path.toLowerCase();
      assert(
        ![...folded].some(
          (old) =>
            old === lower ||
            old.startsWith(`${lower}/`) ||
            lower.startsWith(`${old}/`),
        ),
        `Conflicting release path: ${path}`,
      );
      folded.add(lower);
      files.set(path, {
        bytes: await readFile(join(root, path)),
        executable: Boolean(stat.mode & 0o111),
      });
    }
  }
  await walk();
  const expectedDirs = new Set();
  for (const path of files.keys())
    for (let dir = posix.dirname(path); dir !== '.'; dir = posix.dirname(dir))
      expectedDirs.add(dir);
  assert.deepEqual(
    [...directories].sort(compare),
    [...expectedDirs].sort(compare),
    'Unexpected empty release directory',
  );
  return files;
}

function records(files, modes) {
  return [...files]
    .sort(([a], [b]) => compare(a, b))
    .map(([path, file]) => ({
      path,
      sha256: sha256(file.bytes),
      bytes: file.bytes.length,
      ...(modes ? { executable: file.executable } : {}),
    }));
}

/** Read-only verification of a public artifact whose manifest digest was selected independently. */
export async function checkTemariInstalledArtifact(
  root,
  expectedManifestSha256,
  { historical = false } = {},
) {
  assert.match(expectedManifestSha256 ?? '', /^[a-f0-9]{64}$/);
  const files = await filesAt(root);
  const manifestBytes = files.get('public-entry-manifest.json')?.bytes;
  assert(manifestBytes, 'Public artifact manifest is missing');
  assert.equal(
    sha256(manifestBytes),
    expectedManifestSha256,
    'Public artifact manifest digest mismatch',
  );
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(
    manifest.source?.dirty,
    false,
    'Release requires a clean source commit',
  );
  assert.match(manifest.source.revision, /^[a-f0-9]{40,64}$/);
  if (historical) {
    assert(
      !Object.hasOwn(manifest, 'methodLibrary') &&
        ![...files.keys()].some((path) => path.startsWith('method/')),
      'Historical predecessor must use the shipped artifact shape without a method library',
    );
  } else {
    assert(
      manifest.methodLibrary && files.has('method/pstack/catalog.json'),
      'Current artifact requires the complete method library',
    );
  }
  const payload = new Map(files);
  payload.delete('public-entry-manifest.json');
  assert.deepEqual(
    manifest.files,
    records(payload, false),
    'Public artifact inventory drift',
  );
  const plugin = JSON.parse(
    files.get('.codex-plugin/plugin.json')?.bytes.toString('utf8') ?? 'null',
  );
  assert.equal(plugin?.name, 'temari');
  assert.equal(
    plugin.version,
    historical ? TEMARI_HISTORICAL_VERSION : TEMARI_CURRENT_VERSION,
    'Unexpected public plugin version',
  );
  assert.equal(plugin.skills, './skills/');
  const publicSkills = [...files.keys()]
    .filter((path) => /^skills\/[^/]+\/SKILL\.md$/.test(path))
    .map((path) => path.split('/')[1])
    .sort(compare);
  assert.deepEqual(publicSkills, [
    'closeout',
    'poteto-mode',
    'qa-review-verification',
    'qa-triage',
    'temari',
    'temari-knowledge',
  ]);
  const runtimePrefix = 'runtime/';
  const canonicalBytes = files.get(
    `${runtimePrefix}canonical-manifest.json`,
  )?.bytes;
  assert(canonicalBytes, 'Canonical manifest is missing');
  assert.equal(
    sha256(canonicalBytes),
    manifest.runtimeManifestSha256,
    'Canonical manifest digest differs',
  );
  const canonical = JSON.parse(canonicalBytes.toString('utf8'));
  assert.equal(canonical.schemaVersion, 1);
  assert.equal(
    canonical.source?.dirty,
    false,
    'Canonical runtime requires a clean source commit',
  );
  assert.equal(
    canonical.source.revision,
    manifest.source.revision,
    'Canonical source commit differs',
  );
  const runtime = new Map(
    [...files]
      .filter(
        ([path]) =>
          path.startsWith(runtimePrefix) &&
          path !== `${runtimePrefix}canonical-manifest.json`,
      )
      .map(([path, file]) => [path.slice(runtimePrefix.length), file]),
  );
  assert.deepEqual(
    canonical.files,
    records(runtime, false),
    'Canonical runtime inventory drift',
  );
  // Execute only the already digest-checked public validator and its bound helper.
  const { verifyBundle } = await import(
    pathToFileURL(join(root, 'bin/public-entry.mjs')).href
  );
  const policy = await verifyBundle(expectedManifestSha256, root);
  assert.equal(policy.policyId, 'temari-public-feature-v2');
  for (const path of [...files.keys()].filter((path) =>
    /^bin\/[^/]+\.mjs$/.test(path),
  ))
    if (process.platform !== 'win32')
      assert(
        files.get(path).executable,
        `Public entry is not executable: ${path}`,
      );
  return {
    sourceRevision: manifest.source.revision,
    publicManifestSha256: expectedManifestSha256,
    version: plugin.version,
    skills: publicSkills,
    methodLibrary: manifest.methodLibrary,
  };
}

/** Independently pinned descriptor plus exact bytes/modes, requiring no checkout or developer dependencies. */
export async function checkTemariReleaseRoot(
  root,
  expectedReleaseSha256,
  expectedManifestSha256,
  { historical = false } = {},
) {
  assert.match(expectedReleaseSha256 ?? '', /^[a-f0-9]{64}$/);
  assert.match(expectedManifestSha256 ?? '', /^[a-f0-9]{64}$/);
  const files = await filesAt(root);
  const descriptor = files.get('RELEASE.json');
  assert(descriptor && !descriptor.executable, 'Missing regular RELEASE.json');
  assert.equal(
    sha256(descriptor.bytes),
    expectedReleaseSha256,
    'Release descriptor digest mismatch',
  );
  const release = JSON.parse(descriptor.bytes.toString('utf8'));
  assert.deepEqual(Object.keys(release).sort(), [
    'distributionSourceRevision',
    'files',
    'publicManifestSha256',
    'schemaVersion',
    'sourceRevision',
    'version',
  ]);
  assert.equal(release.schemaVersion, 1);
  assert.equal(
    release.version,
    historical ? TEMARI_HISTORICAL_VERSION : TEMARI_CURRENT_VERSION,
    'Unsupported Temari release version',
  );
  assert.match(release.sourceRevision, /^[a-f0-9]{40,64}$/);
  assert.match(release.distributionSourceRevision, /^[a-f0-9]{40,64}$/);
  if (!historical)
    assert.equal(
      release.distributionSourceRevision,
      release.sourceRevision,
      'Current release distribution and public source commits differ',
    );
  assert.equal(
    release.publicManifestSha256,
    expectedManifestSha256,
    'Public manifest pin differs from release',
  );
  const payload = new Map(files);
  payload.delete('RELEASE.json');
  const actual = records(payload, true);
  if (process.platform === 'win32') {
    assert.deepEqual(
      release.files.map(({ executable, ...record }) => record),
      actual.map(({ executable, ...record }) => record),
      'Release inventory drift',
    );
  } else
    assert.deepEqual(
      release.files,
      actual,
      'Release inventory differs from files, hashes, sizes, or modes',
    );
  const rootPaths = new Set([
    'RELEASE.json',
    'README.md',
    '.agents/plugins/marketplace.json',
    'temari-release-verify.mjs',
    'temari-install-state.mjs',
  ]);
  assert(
    [...files.keys()].every(
      (path) => rootPaths.has(path) || path.startsWith('plugins/temari/'),
    ),
    'Unexpected release member',
  );
  for (const path of rootPaths)
    assert(files.has(path), `Missing release support file: ${path}`);
  const marketplace = JSON.parse(
    files.get('.agents/plugins/marketplace.json').bytes.toString('utf8'),
  );
  assert.deepEqual(
    marketplace,
    {
      name: TEMARI_MARKETPLACE,
      interface: { displayName: 'Temari private releases' },
      plugins: [
        {
          name: 'temari',
          source: { source: 'local', path: './plugins/temari' },
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
          category: 'Productivity',
        },
      ],
    },
    'Marketplace identity or policy differs',
  );
  const artifact = await checkTemariInstalledArtifact(
    join(root, 'plugins/temari'),
    expectedManifestSha256,
    { historical },
  );
  assert.equal(
    artifact.sourceRevision,
    release.sourceRevision,
    'Release source commit differs from public artifact',
  );
  return { ...release, releaseSha256: expectedReleaseSha256 };
}

if (
  process.argv[1] &&
  pathToFileURL(await realpath(process.argv[1])).href ===
    pathToFileURL(fileURLToPath(import.meta.url)).href
) {
  try {
    const { values } = parseArgs({
      options: {
        root: { type: 'string' },
        'expected-release-sha256': { type: 'string' },
        'expected-manifest-sha256': { type: 'string' },
        historical: { type: 'boolean', default: false },
      },
    });
    const result = await checkTemariReleaseRoot(
      values.root,
      values['expected-release-sha256'],
      values['expected-manifest-sha256'],
      { historical: values.historical },
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
