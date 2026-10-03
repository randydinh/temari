import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdtemp, mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { gunzipSync, gzipSync } from 'node:zlib';
import { checkKnowledgePlugin } from './knowledge-plugin.mjs';

const toolPath = fileURLToPath(import.meta.url);
const pluginPrefix = 'plugins/content-registrar-knowledge/';
const marketplacePath = '.agents/plugins/marketplace.json';
const releasePath = 'RELEASE.json';
const readmePath = 'README.md';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

function safePath(path) {
  assert(
    path && Buffer.byteLength(path) < 256 &&
      !posix.isAbsolute(path) &&
      !/[\\:\x00-\x1f\x7f]/.test(path) &&
      path.split('/').every((part) => part && part !== '.' && part !== '..'),
    `Unsafe release path: ${path}`,
  );
}

async function regularFiles(root) {
  const files = new Map();
  async function walk(path = '') {
    const stat = await lstat(join(root, path));
    assert(!stat.isSymbolicLink(), `Symlink in release input: ${path}`);
    if (stat.isDirectory()) {
      for (const entry of (await readdir(join(root, path))).sort())
        await walk(path ? `${path}/${entry}` : entry);
      return;
    }
    assert(stat.isFile(), `Nonregular release input: ${path}`);
    safePath(path);
    files.set(path, await readFile(join(root, path)));
  }
  await walk();
  return files;
}

function records(files) {
  return [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([path, bytes]) => ({ path, sha256: sha256(bytes), bytes: bytes.length }));
}

function field(header, value, offset, length) {
  const bytes = Buffer.from(value);
  assert(bytes.length <= length, `Tar field too long: ${value}`);
  bytes.copy(header, offset);
}

function octal(header, value, offset, length) {
  assert(Number.isSafeInteger(value) && value >= 0);
  const digits = value.toString(8);
  assert(digits.length <= length - 1);
  field(header, digits.padStart(length - 1, '0') + '\0', offset, length);
}

function splitTarPath(path) {
  if (Buffer.byteLength(path) <= 100) return ['', path];
  const slash = path.lastIndexOf('/');
  for (let index = slash; index > 0; index = path.lastIndexOf('/', index - 1)) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100)
      return [prefix, name];
  }
  throw new Error(`Tar path exceeds USTAR bounds: ${path}`);
}

function tarHeader(path, bytes, executable = false) {
  safePath(path);
  const [prefix, name] = splitTarPath(path);
  const header = Buffer.alloc(512);
  field(header, name, 0, 100);
  octal(header, executable ? 0o755 : 0o644, 100, 8);
  octal(header, 0, 108, 8);
  octal(header, 0, 116, 8);
  octal(header, bytes.length, 124, 12);
  octal(header, 0, 136, 12);
  header.fill(0x20, 148, 156);
  field(header, '0', 156, 1);
  field(header, 'ustar\0', 257, 6);
  field(header, '00', 263, 2);
  field(header, prefix, 345, 155);
  const sum = header.reduce((total, byte) => total + byte, 0);
  field(header, sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return header;
}

function archiveBytes(files) {
  const chunks = [];
  for (const [path, bytes] of [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    chunks.push(tarHeader(path, bytes, path === `${pluginPrefix}bin/temari-knowledge.mjs`));
    chunks.push(bytes);
    const remainder = bytes.length % 512;
    if (remainder) chunks.push(Buffer.alloc(512 - remainder));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 });
}

function cString(block, offset, length) {
  const field = block.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? field.length : end).toString('utf8');
}

function parseArchive(bytes) {
  const tar = gunzipSync(bytes, { maxOutputLength: 128 * 1024 * 1024 });
  const files = new Map();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      assert(tar.subarray(offset).every((byte) => byte === 0), 'Trailing tar payload');
      assert(tar.length - offset >= 1024, 'Missing tar end blocks');
      return files;
    }
    assert.equal(cString(header, 257, 6), 'ustar', 'USTAR header required');
    assert.equal(cString(header, 156, 1), '0', 'Only regular files are allowed');
    const stored = Number.parseInt(cString(header, 148, 8).trim(), 8);
    const copy = Buffer.from(header);
    copy.fill(0x20, 148, 156);
    assert.equal(stored, copy.reduce((total, byte) => total + byte, 0), 'Tar checksum mismatch');
    const prefix = cString(header, 345, 155);
    const name = cString(header, 0, 100);
    const path = prefix ? `${prefix}/${name}` : name;
    safePath(path);
    assert(!files.has(path), `Duplicate release path: ${path}`);
    const size = Number.parseInt(cString(header, 124, 12), 8);
    assert(Number.isSafeInteger(size) && size >= 0 && size < 128 * 1024 * 1024);
    const dataStart = offset + 512;
    const next = dataStart + Math.ceil(size / 512) * 512;
    assert(next <= tar.length, 'Truncated tar entry');
    files.set(path, Buffer.from(tar.subarray(dataStart, dataStart + size)));
    offset = next;
  }
  throw new Error('Missing tar end blocks');
}

function marketplace() {
  return {
    name: 'temari-knowledge',
    interface: { displayName: 'Temari Knowledge' },
    plugins: [{
      name: 'content-registrar-knowledge',
      source: { source: 'local', path: './plugins/content-registrar-knowledge' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      category: 'Productivity',
    }],
  };
}

function readme(release) {
  return Buffer.from(`# Content Registrar Knowledge private release ${release.version}\n\n` +
    `Built from Temari commit \`${release.sourceRevision}\`. The standalone plugin manifest SHA256 is\n` +
    `\`${release.pluginManifestSha256}\`. This private bundle contains no API key or registered user sources.\n\n` +
    `Verify the archive SHA256 against the separately provided release digest before extracting it:\n\n` +
    '```sh\nshasum -a 256 content-registrar-knowledge-*.tar.gz\n```\n\n' +
    'Extract only when the printed digest matches the pinned value. From the extracted root:\n\n' +
    '```sh\ncodex plugin marketplace add .\ncodex plugin add content-registrar-knowledge@temari-knowledge\n' +
    'node plugins/content-registrar-knowledge/bin/temari-knowledge.mjs setup\n```\n\n' +
    'Open a new Codex chat after installation. Python 3.12 and Python package download access are\n' +
    'required for cold setup. Local-only sources need no TypeSafe key or hosted Jev call.\n' +
    'The macOS CLI path is tested; native Windows and desktop Plugins Directory installation are not.\n' +
    'Use the launcher `disable` command to stop new Knowledge launches, then\n' +
    '`codex plugin remove content-registrar-knowledge@temari-knowledge` to uninstall.\n' +
    'The external Knowledge home remains; removal does not erase user sources or archives.\n' +
    'Reinstallation preserves an explicit disabled provider choice.\n\n' +
    'Public distribution terms for the bundled Content Registrar source remain unresolved.\n');
}

function validateReleaseFiles(files) {
  const release = JSON.parse(files.get(releasePath)?.toString() ?? 'null');
  assert.equal(release?.schemaVersion, 1);
  assert.match(release.version, /^\d+\.\d+\.\d+$/);
  assert.match(release.sourceRevision, /^[a-f0-9]{40,64}$/);
  assert.match(release.pluginManifestSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(files.get(marketplacePath)?.toString() ?? 'null'), marketplace());
  assert.deepEqual(files.get(readmePath), readme(release));
  const payload = new Map(files);
  payload.delete(releasePath);
  assert.deepEqual(release.files, records(payload));
  const paths = [...files.keys()];
  assert.deepEqual(paths, [...paths].sort(), 'Archive entries must be sorted');
  assert(paths.every((path) => path === releasePath || path === readmePath || path === marketplacePath || path.startsWith(pluginPrefix)));
  return release;
}

export async function checkKnowledgeRelease(archive, expectedSha256) {
  assert(isAbsolute(archive));
  assert.match(expectedSha256 ?? '', /^[a-f0-9]{64}$/);
  const bytes = await readFile(archive);
  assert(bytes.length < 128 * 1024 * 1024, 'Release archive is too large');
  assert.equal(sha256(bytes), expectedSha256, 'Release archive digest mismatch');
  const files = parseArchive(bytes);
  assert.deepEqual(bytes, archiveBytes(files), 'Release archive is not canonical');
  const release = validateReleaseFiles(files);
  const staging = await mkdtemp(join(tmpdir(), 'knowledge-release-check-'));
  try {
    for (const [path, data] of files) {
      const target = join(staging, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, data, { flag: 'wx' });
      if (path === `${pluginPrefix}bin/temari-knowledge.mjs`)
        await chmod(target, 0o755);
    }
    const plugin = await checkKnowledgePlugin(join(staging, pluginPrefix), release.pluginManifestSha256);
    assert.equal(plugin.source.revision, release.sourceRevision);
    assert.equal(JSON.parse(files.get(`${pluginPrefix}.codex-plugin/plugin.json`).toString()).version, release.version);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return { ...release, archiveSha256: expectedSha256, archiveBytes: bytes.length };
}

export async function packageKnowledgeRelease(artifact, expectedManifestSha256, output) {
  assert(isAbsolute(artifact) && isAbsolute(output));
  assert.match(expectedManifestSha256 ?? '', /^[a-f0-9]{64}$/);
  const plugin = await checkKnowledgePlugin(artifact, expectedManifestSha256);
  assert.equal(plugin.source.dirty, false, 'Release requires a clean source commit');
  const pluginFiles = await regularFiles(artifact);
  const files = new Map([...pluginFiles].map(([path, bytes]) => [`${pluginPrefix}${path}`, bytes]));
  const version = JSON.parse(pluginFiles.get('.codex-plugin/plugin.json').toString()).version;
  assert.match(version, /^\d+\.\d+\.\d+$/);
  files.set(marketplacePath, jsonBytes(marketplace()));
  const metadata = {
    schemaVersion: 1,
    version,
    sourceRevision: plugin.source.revision,
    pluginManifestSha256: expectedManifestSha256,
  };
  files.set(readmePath, readme(metadata));
  files.set(releasePath, jsonBytes({ ...metadata, files: records(files) }));
  const bytes = archiveBytes(files);
  await mkdir(dirname(output), { recursive: true });
  const handle = await open(output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try { await handle.writeFile(bytes); } finally { await handle.close(); }
  try { return await checkKnowledgeRelease(output, sha256(bytes)); }
  catch (error) { await rm(output, { force: true }); throw error; }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === pathToFileURL(toolPath).href) {
  const { values, positionals } = parseArgs({
    options: {
      artifact: { type: 'string' },
      'expected-manifest-sha256': { type: 'string' },
      output: { type: 'string' },
      archive: { type: 'string' },
      'expected-sha256': { type: 'string' },
    },
    allowPositionals: true,
  });
  const [command] = positionals;
  assert.equal(positionals.length, 1);
  const result = command === 'package' && values.artifact && values['expected-manifest-sha256'] && values.output && !values.archive
    ? await packageKnowledgeRelease(values.artifact, values['expected-manifest-sha256'], values.output)
    : command === 'check' && values.archive && values['expected-sha256'] && !values.output && !values.artifact
      ? await checkKnowledgeRelease(values.archive, values['expected-sha256'])
      : (() => { throw new Error('Usage: knowledge-release.mjs package --artifact ABS --expected-manifest-sha256 HEX --output ABS | check --archive ABS --expected-sha256 HEX'); })();
  process.stdout.write(`${JSON.stringify({ version: result.version, sourceRevision: result.sourceRevision, pluginManifestSha256: result.pluginManifestSha256, archiveSha256: result.archiveSha256, archiveBytes: result.archiveBytes }, null, 2)}\n`);
}
