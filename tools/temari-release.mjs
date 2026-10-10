import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { gunzipSync, gzipSync } from 'node:zlib';
import { checkPublicEntryArtifact } from './public-entry-runtime.mjs';
import { checkTemariReleaseRoot as verifyReleaseRoot } from './temari-release-verify.mjs';

export const TEMARI_MARKETPLACE = 'temari-private';
export const TEMARI_PLUGIN_ID = `temari@${TEMARI_MARKETPLACE}`;
export const TEMARI_CURRENT_VERSION = '0.15.5';
export const TEMARI_HISTORICAL_VERSION = '0.15.4+codex.2';
const toolPath = fileURLToPath(import.meta.url);
const workspace = resolve(dirname(toolPath), '..');
const pluginPrefix = 'plugins/temari/';
const releasePath = 'RELEASE.json';
const marketplacePath = '.agents/plugins/marketplace.json';
const limit = 128 * 1024 * 1024;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function safePath(path) {
  assert(
    typeof path === 'string' &&
      path.length > 0 &&
      Buffer.byteLength(path) < 256 &&
      !posix.isAbsolute(path) &&
      !/[\\:\x00-\x1f\x7f]/.test(path) &&
      path.split('/').every((part) => part && part !== '.' && part !== '..'),
    `Unsafe release path: ${path}`,
  );
}

function assertPaths(paths) {
  const seen = new Set();
  for (const path of paths) {
    safePath(path);
    const folded = path.toLowerCase();
    assert(
      ![...seen].some(
        (prior) =>
          prior === folded ||
          prior.startsWith(`${folded}/`) ||
          folded.startsWith(`${prior}/`),
      ),
      `Duplicate or conflicting release path: ${path}`,
    );
    seen.add(folded);
  }
}

async function releaseFiles(root) {
  assert(isAbsolute(root), 'Release root must be absolute');
  const files = new Map();
  const dirs = new Set();
  async function walk(path = '') {
    const stat = await lstat(join(root, path));
    assert(
      !stat.isSymbolicLink(),
      `Release symlink not permitted: ${path || root}`,
    );
    if (stat.isDirectory()) {
      if (path) dirs.add(path);
      for (const name of (await readdir(join(root, path))).sort(compare))
        await walk(path ? `${path}/${name}` : name);
    } else {
      assert(stat.isFile(), `Nonregular release file: ${path}`);
      safePath(path);
      files.set(path, {
        bytes: await readFile(join(root, path)),
        executable: Boolean(stat.mode & 0o111),
      });
    }
  }
  await walk();
  assertPaths(files.keys());
  const expectedDirs = new Set();
  for (const path of files.keys())
    for (let dir = posix.dirname(path); dir !== '.'; dir = posix.dirname(dir))
      expectedDirs.add(dir);
  assert.deepEqual(
    [...dirs].sort(compare),
    [...expectedDirs].sort(compare),
    'Unexpected empty release directory',
  );
  return files;
}

function records(files) {
  return [...files]
    .sort(([a], [b]) => compare(a, b))
    .map(([path, file]) => ({
      path,
      sha256: sha256(file.bytes),
      bytes: file.bytes.length,
      executable: file.executable,
    }));
}

function field(header, value, offset, length) {
  const bytes = Buffer.from(value);
  assert(bytes.length <= length, `Tar field too long: ${value}`);
  bytes.copy(header, offset);
}
function octal(header, value, offset, length) {
  assert(Number.isSafeInteger(value) && value >= 0);
  const digits = value.toString(8);
  assert(digits.length < length, 'Tar numeric field overflow');
  field(header, `${digits.padStart(length - 1, '0')}\0`, offset, length);
}
function tarPath(path) {
  if (Buffer.byteLength(path) <= 100) return ['', path];
  for (
    let slash = path.lastIndexOf('/');
    slash > 0;
    slash = path.lastIndexOf('/', slash - 1)
  ) {
    const prefix = path.slice(0, slash),
      name = path.slice(slash + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100)
      return [prefix, name];
  }
  throw new Error(`Release path exceeds USTAR bounds: ${path}`);
}
function tarHeader(path, file) {
  const [prefix, name] = tarPath(path);
  const header = Buffer.alloc(512);
  field(header, name, 0, 100);
  octal(header, file.executable ? 0o755 : 0o644, 100, 8);
  octal(header, 0, 108, 8);
  octal(header, 0, 116, 8);
  octal(header, file.bytes.length, 124, 12);
  octal(header, 0, 136, 12);
  header.fill(0x20, 148, 156);
  field(header, '0', 156, 1);
  field(header, 'ustar\0', 257, 6);
  field(header, '00', 263, 2);
  field(header, prefix, 345, 155);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  field(header, `${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return header;
}

/** Canonical USTAR regular files, preserving every executable flag, with zero timestamps. */
export function temariArchiveBytes(files) {
  assertPaths(files.keys());
  const chunks = [];
  for (const [path, file] of [...files].sort(([a], [b]) => compare(a, b))) {
    assert(
      Buffer.isBuffer(file.bytes) && typeof file.executable === 'boolean',
      `Invalid release file: ${path}`,
    );
    chunks.push(tarHeader(path, file), file.bytes);
    if (file.bytes.length % 512)
      chunks.push(Buffer.alloc(512 - (file.bytes.length % 512)));
  }
  chunks.push(Buffer.alloc(1024));
  const tar = Buffer.concat(chunks);
  assert(tar.length <= limit, 'Release archive is too large');
  return gzipSync(tar, { level: 9, mtime: 0 });
}

function cString(block, offset, length) {
  const data = block.subarray(offset, offset + length),
    end = data.indexOf(0);
  return data.subarray(0, end < 0 ? data.length : end).toString('utf8');
}
function number(block, offset, length) {
  const value = cString(block, offset, length).trim();
  assert(/^[0-7]+$/.test(value), 'Invalid tar octal field');
  const result = Number.parseInt(value, 8);
  assert(Number.isSafeInteger(result) && result >= 0, 'Invalid tar number');
  return result;
}

export function parseTemariArchive(bytes) {
  assert(
    Buffer.isBuffer(bytes) && bytes.length <= limit,
    'Invalid release archive size',
  );
  const tar = gunzipSync(bytes, { maxOutputLength: limit });
  const files = new Map();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      assert(
        tar.length - offset >= 1024 &&
          tar.subarray(offset).every((byte) => byte === 0),
        'Invalid tar end blocks',
      );
      assertPaths(files.keys());
      return files;
    }
    assert.equal(cString(header, 257, 6), 'ustar', 'USTAR header required');
    assert.equal(
      cString(header, 156, 1),
      '0',
      'Only regular release files are allowed',
    );
    const checked = Buffer.from(header);
    checked.fill(0x20, 148, 156);
    assert.equal(
      number(header, 148, 8),
      checked.reduce((sum, byte) => sum + byte, 0),
      'Tar checksum mismatch',
    );
    const prefix = cString(header, 345, 155),
      name = cString(header, 0, 100);
    const path = prefix ? `${prefix}/${name}` : name;
    safePath(path);
    assert(!files.has(path), `Duplicate release path: ${path}`);
    const mode = number(header, 100, 8);
    assert(mode === 0o644 || mode === 0o755, 'Unsupported tar file mode');
    const size = number(header, 124, 12);
    assert(size < limit, 'Release file is too large');
    const start = offset + 512,
      next = start + Math.ceil(size / 512) * 512;
    assert(next <= tar.length, 'Truncated tar entry');
    files.set(path, {
      bytes: Buffer.from(tar.subarray(start, start + size)),
      executable: mode === 0o755,
    });
    offset = next;
  }
  throw new Error('Missing tar end blocks');
}

export function assertTemariVersionSuccessor(prior, candidate) {
  const parts = (value) => {
    assert(
      typeof value === 'string' &&
        /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[A-Za-z0-9.-]+)?$/.test(
          value,
        ),
      `Invalid stable plugin version: ${value}`,
    );
    const result = value.split('+')[0].split('.').map(Number);
    assert(result.every(Number.isSafeInteger));
    return result;
  };
  const oldParts = parts(prior),
    newParts = parts(candidate);
  const first = newParts.findIndex((part, i) => part !== oldParts[i]);
  assert(
    first >= 0 && newParts[first] > oldParts[first],
    `Changed release requires a higher plugin version than ${prior}; candidate is ${candidate}`,
  );
}

function marketplace() {
  return {
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
  };
}
function readme(release) {
  const historical = release.version === TEMARI_HISTORICAL_VERSION;
  const verify =
    'node /absolute/release-root/temari-release-verify.mjs --root /absolute/release-root --expected-release-sha256 RELEASE_SHA256 --expected-manifest-sha256 PUBLIC_MANIFEST_SHA256' +
    (historical ? ' --historical' : '');
  const inspect = historical
    ? 'node /absolute/current-release-root/temari-install-state.mjs inspect --codex-home /absolute/scratch/codex-home --candidate-root /absolute/current-release-root --candidate-release-sha256 CURRENT_RELEASE_SHA256 --candidate-manifest-sha256 CURRENT_PUBLIC_MANIFEST_SHA256 --prior-root /absolute/release-root --prior-release-sha256 RELEASE_SHA256 --prior-manifest-sha256 PUBLIC_MANIFEST_SHA256'
    : 'node /absolute/release-root/temari-install-state.mjs inspect --codex-home /absolute/scratch/codex-home --candidate-root /absolute/release-root --candidate-release-sha256 RELEASE_SHA256 --candidate-manifest-sha256 PUBLIC_MANIFEST_SHA256';
  return Buffer.from(
    `# Temari private release ${release.version}\n\n` +
      `Clean public source commit: \`${release.sourceRevision}\`. Clean distribution source commit: \`${release.distributionSourceRevision}\`. Public manifest SHA256: \`${release.publicManifestSha256}\`.\n\n` +
      'Verify the separately pinned archive SHA256 before extraction. Retain the extracted release at an immutable external path.\n' +
      (historical
        ? 'This is an independently pinned predecessor archive, not a current candidate. Verify it with --historical, then select it as --prior-root alongside an independently pinned current release.\n'
        : 'Inspect the pinned current release and the explicitly selected Codex home before changing installation state.\n') +
      `\n\`\`\`sh\n${verify}\n${inspect}\n\`\`\`\n\n` +
      (historical
        ? 'Follow only the native upgrade commands proposed by the verified current inspector. An available or disabled predecessor needs an explicit reinstall decision.\n'
        : '```sh\nCODEX_HOME=/absolute/scratch/codex-home codex plugin marketplace add /absolute/release-root --json\n' +
          `CODEX_HOME=/absolute/scratch/codex-home codex plugin add ${TEMARI_PLUGIN_ID} --json\n` +
          '```\n\nRepeat inspection after installation. Missing or disabled installation remains an explicit user choice; use native add only for an intentional reinstall.\n') +
      'For an independently verified predecessor, remove the selected plugin and marketplace before registering the new immutable root. Keep both releases and their external digests.\n' +
      (historical
        ? 'This predecessor preserves the shipped public entries and runtime; it does not contain the new method library.\n'
        : 'The current release contains the public entries, complete portable P-stack method, and separate canonical runtime. Method availability does not admit unsupported routes or prove host capabilities.\n') +
      'Knowledge setup is unchanged and remains explicit. This private release does not authorize activation of an active host, public distribution, or publication.\n' +
      'macOS Codex CLI is the verification target; desktop restart and native Windows remain unverified.\n',
  );
}

function validateFiles(files, historical) {
  const descriptor = files.get(releasePath);
  assert(
    descriptor && descriptor.executable === false,
    'Missing regular RELEASE.json',
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
  assert.match(release.publicManifestSha256, /^[a-f0-9]{64}$/);
  const payload = new Map(files);
  payload.delete(releasePath);
  assert.deepEqual(
    release.files,
    records(payload),
    'Release inventory differs from files, hashes, sizes, or modes',
  );
  assert.deepEqual(
    [...files.keys()],
    [...files.keys()].sort(compare),
    'Release entries must be sorted',
  );
  assert(
    [...files.keys()].every(
      (path) =>
        path === releasePath ||
        path === 'README.md' ||
        path === marketplacePath ||
        ['temari-release-verify.mjs', 'temari-install-state.mjs'].includes(
          path,
        ) ||
        path.startsWith(pluginPrefix),
    ),
    'Unexpected release member',
  );
  assert.deepEqual(
    files.get(marketplacePath),
    { bytes: json(marketplace()), executable: false },
    'Marketplace identity or policy differs',
  );
  assert.deepEqual(
    files.get('README.md'),
    { bytes: readme(release), executable: false },
    'Release guidance differs from metadata',
  );
  return release;
}

/** Root verification is read-only and requires independently supplied release and public pins. */
export const checkTemariReleaseRoot = verifyReleaseRoot;

async function checkArchive(archive, expectedSha256, historical) {
  assert(isAbsolute(archive));
  assert.match(expectedSha256 ?? '', /^[a-f0-9]{64}$/);
  const stat = await lstat(archive);
  assert(
    stat.isFile() && !stat.isSymbolicLink(),
    'Release archive must be a regular file',
  );
  const bytes = await readFile(archive);
  assert.equal(
    sha256(bytes),
    expectedSha256,
    'Release archive digest mismatch',
  );
  const files = parseTemariArchive(bytes);
  assert.deepEqual(
    bytes,
    temariArchiveBytes(files),
    'Release archive is not canonical',
  );
  const release = validateFiles(files, historical);
  const releaseSha256 = sha256(files.get(releasePath).bytes);
  const staging = await mkdtemp(join(tmpdir(), 'temari-release-check-'));
  try {
    for (const [path, file] of files) {
      await mkdir(dirname(join(staging, path)), { recursive: true });
      await writeFile(join(staging, path), file.bytes, { flag: 'wx' });
      await chmod(join(staging, path), file.executable ? 0o755 : 0o644);
    }
    await checkTemariReleaseRoot(
      staging,
      releaseSha256,
      release.publicManifestSha256,
      { historical },
    );
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return {
    ...release,
    releaseSha256,
    archiveSha256: expectedSha256,
    archiveBytes: bytes.length,
  };
}
export const checkTemariRelease = (archive, digest) =>
  checkArchive(archive, digest, false);
export const checkTemariHistoricalRelease = (archive, digest) =>
  checkArchive(archive, digest, true);

export async function checkTemariReleaseSuccessor(
  priorArchive,
  priorSha256,
  archive,
  expectedSha256,
) {
  const prior = await checkTemariHistoricalRelease(priorArchive, priorSha256);
  const candidate = await checkTemariRelease(archive, expectedSha256);
  assertTemariVersionSuccessor(prior.version, candidate.version);
  return {
    ...candidate,
    succession: 'advanced',
    priorArchiveSha256: priorSha256,
  };
}

export function assertTemariPackagingSource(
  sourceRoot,
  artifactRevision,
  { historical = false } = {},
) {
  assert(isAbsolute(sourceRoot), 'Packaging source root must be absolute');
  assert.match(artifactRevision ?? '', /^[a-f0-9]{40,64}$/);
  const git = (...args) =>
    execFileSync('git', ['-C', sourceRoot, ...args], {
      encoding: 'utf8',
    }).trim();
  assert.equal(
    git('status', '--porcelain=v1', '--untracked-files=normal'),
    '',
    'Release packaging requires a clean distribution source checkout',
  );
  const revision = git('rev-parse', 'HEAD');
  assert.match(revision, /^[a-f0-9]{40,64}$/);
  git(
    'ls-files',
    '--error-unmatch',
    'tools/temari-release.mjs',
    'tools/temari-release-verify.mjs',
    'tools/temari-install-state.mjs',
  );
  if (!historical)
    assert.equal(
      revision,
      artifactRevision,
      'Current distribution commit must equal the public artifact source commit',
    );
  return revision;
}

async function packageRelease(
  artifact,
  expectedManifestSha256,
  output,
  historical,
) {
  assert(isAbsolute(artifact) && isAbsolute(output));
  assert.match(expectedManifestSha256 ?? '', /^[a-f0-9]{64}$/);
  const plugin = await checkPublicEntryArtifact(
    artifact,
    expectedManifestSha256,
    { historicalVersion: historical },
  );
  assert.equal(
    plugin.source.dirty,
    false,
    'Release requires a clean source commit',
  );
  const distributionSourceRevision = assertTemariPackagingSource(
    workspace,
    plugin.source.revision,
    { historical },
  );
  const pluginFiles = await releaseFiles(artifact);
  const version = JSON.parse(
    pluginFiles.get('.codex-plugin/plugin.json').bytes,
  ).version;
  assert.equal(
    version,
    historical ? TEMARI_HISTORICAL_VERSION : TEMARI_CURRENT_VERSION,
  );
  const files = new Map(
    [...pluginFiles].map(([path, file]) => [`${pluginPrefix}${path}`, file]),
  );
  files.set(marketplacePath, { bytes: json(marketplace()), executable: false });
  for (const name of ['temari-release-verify.mjs', 'temari-install-state.mjs'])
    files.set(name, {
      bytes: execFileSync('git', [
        '-C',
        workspace,
        'show',
        `${distributionSourceRevision}:tools/${name}`,
      ]),
      executable: false,
    });
  const metadata = {
    schemaVersion: 1,
    version,
    sourceRevision: plugin.source.revision,
    distributionSourceRevision,
    publicManifestSha256: expectedManifestSha256,
  };
  files.set('README.md', { bytes: readme(metadata), executable: false });
  files.set(releasePath, {
    bytes: json({ ...metadata, files: records(files) }),
    executable: false,
  });
  const bytes = temariArchiveBytes(files);
  await mkdir(dirname(output), { recursive: true });
  const staging = await mkdtemp(
    join(dirname(output), `.${basename(output)}.staging-`),
  );
  const temporary = join(staging, basename(output));
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const result = await checkArchive(temporary, sha256(bytes), historical);
    await link(temporary, output);
    return result;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
export const packageTemariRelease = (artifact, manifest, output) =>
  packageRelease(artifact, manifest, output, false);
/** Explicit archival predecessor path; never the default current installation route. */
export const packageTemariHistoricalRelease = (artifact, manifest, output) =>
  packageRelease(artifact, manifest, output, true);

if (
  process.argv[1] &&
  pathToFileURL(await realpath(process.argv[1])).href ===
    pathToFileURL(toolPath).href
) {
  try {
    const { values, positionals, tokens } = parseArgs({
      options: {
        artifact: { type: 'string' },
        'expected-manifest-sha256': { type: 'string' },
        output: { type: 'string' },
        archive: { type: 'string' },
        'expected-sha256': { type: 'string' },
        'prior-archive': { type: 'string' },
        'prior-sha256': { type: 'string' },
      },
      allowPositionals: true,
      tokens: true,
    });
    assert.equal(positionals.length, 1);
    const command = positionals[0];
    const commandFields = {
      package: ['artifact', 'expected-manifest-sha256', 'output'],
      'package-historical': ['artifact', 'expected-manifest-sha256', 'output'],
      check: ['archive', 'expected-sha256'],
      'check-historical': ['archive', 'expected-sha256'],
      successor: [
        'archive',
        'expected-sha256',
        'prior-archive',
        'prior-sha256',
      ],
    };
    assert(
      Object.hasOwn(commandFields, command),
      'Unknown Temari release command',
    );
    assert.deepEqual(
      Object.keys(values).sort(),
      [...commandFields[command]].sort(),
      'Release command requires exactly its declared paths and independent digests; irrelevant or missing flags are forbidden',
    );
    const optionNames = tokens
      .filter((token) => token.kind === 'option')
      .map((token) => token.name);
    assert.equal(
      new Set(optionNames).size,
      optionNames.length,
      'Duplicate release flags are forbidden',
    );
    let result;
    if (command === 'package' || command === 'package-historical')
      result = await packageRelease(
        values.artifact,
        values['expected-manifest-sha256'],
        values.output,
        command === 'package-historical',
      );
    else if (command === 'check' || command === 'check-historical')
      result = await checkArchive(
        values.archive,
        values['expected-sha256'],
        command === 'check-historical',
      );
    else if (command === 'successor')
      result = await checkTemariReleaseSuccessor(
        values['prior-archive'],
        values['prior-sha256'],
        values.archive,
        values['expected-sha256'],
      );
    else
      throw new Error(
        'Usage: temari-release.mjs package|package-historical|check|check-historical|successor with independently pinned paths and digests',
      );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
