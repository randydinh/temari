/** Release-builder only: acquire immutable upstream runtimes into a private distribution. */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, posix, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';

export async function readRuntimePins() {
  return JSON.parse(await readFile(new URL('../packages/workflow-runtime/unified/runtime-pins.json', import.meta.url), 'utf8'));
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function safePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || value.includes(':') || value.startsWith('/') || /^[a-z]:/i.test(value) || value.split('/').includes('..')) throw new Error(`Unsafe archive path: ${value}`);
  const normalized = posix.normalize(value).replace(/\/$/, '');
  if (!normalized || normalized === '.') throw new Error(`Unsafe archive path: ${value}`);
  return normalized;
}
function stripRoot(value, root) {
  const normalized = safePath(value);
  if (normalized === root) return '';
  if (!normalized.startsWith(root + '/')) throw new Error(`Archive entry outside expected root: ${value}`);
  return normalized.slice(root.length + 1);
}
function tarNumber(bytes) {
  if (bytes[0] & 128) throw new Error('Unsupported binary tar number');
  const text = bytes.toString('ascii').replace(/\0/g, '').trim();
  if (!/^[0-7]*$/.test(text)) throw new Error('Invalid tar number');
  const value = parseInt(text || '0', 8);
  if (!Number.isSafeInteger(value)) throw new Error('Oversized tar number');
  return value;
}
const tarText = bytes => bytes.toString('utf8').split('\0')[0];
function paxRecords(bytes) {
  const result = {};
  for (let offset = 0; offset < bytes.length;) {
    const end = bytes.indexOf(32, offset), length = Number(bytes.subarray(offset, end).toString());
    if (end < offset || !Number.isSafeInteger(length) || length <= end - offset + 1 || offset + length > bytes.length || bytes[offset + length - 1] !== 10) throw new Error('Invalid PAX record');
    const record = bytes.subarray(end + 1, offset + length - 1).toString('utf8'), equal = record.indexOf('=');
    if (equal < 1) throw new Error('Invalid PAX record');
    result[record.slice(0, equal)] = record.slice(equal + 1); offset += length;
  }
  return result;
}
/** Probe the actual destination filesystem; a portable archive may have case-distinct files. */
export async function probeFilesystemSemantics(directory) {
  // Missing parents inherit the filesystem of their nearest existing ancestor.
  // Probe there without creating any part of the archive's destination tree.
  let parent = resolve(directory);
  for (;;) {
    try { if (!(await stat(parent)).isDirectory()) throw new Error('Filesystem probe parent is not a directory'); break; }
    catch (error) { if (error.code !== 'ENOENT' || dirname(parent) === parent) throw error; parent = dirname(parent); }
  }
  const probe = await mkdtemp(join(parent, '.temari-fs-probe-'));
  try {
    await writeFile(join(probe, 'CaseProbe'), 'case', { flag: 'wx' });
    await writeFile(join(probe, 'caf\u00e9'), 'unicode', { flag: 'wx' });
    async function exists(name) {
      try { await lstat(join(probe, name)); return true; } catch (error) { if (error.code !== 'ENOENT') throw error; return false; }
    }
    return { caseSensitive: !await exists('caseprobe'), unicodeNormalizationSensitive: !await exists('cafe\u0301') };
  } finally { await rm(probe, { recursive: true, force: true }); }
}
/** Validate the whole archive before any entry is written. No system extraction commands. */
export async function extractManagedTarGz(bytes, destination, archiveRoot) {
  safePath(archiveRoot);
  try { await lstat(destination); throw new Error('Extraction destination must be fresh'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const tar = gunzipSync(bytes, { maxOutputLength: 1024 * 1024 * 1024 }), entries = new Map();
  let local = {}, global = {}, longName, longLink, terminated = false;
  for (let offset = 0; offset < tar.length;) {
    if (offset + 512 > tar.length) throw new Error('Incomplete tar header');
    const header = tar.subarray(offset, offset + 512); offset += 512;
    if (header.every(byte => byte === 0)) {
      // POSIX EOF is two complete zero blocks; any record padding must also be
      // whole zero blocks. Do not silently ignore partial headers or trailing data.
      if (tar.length - offset < 512 || (tar.length - offset) % 512 !== 0 || !tar.subarray(offset).every(byte => byte === 0)) throw new Error('Incomplete or invalid tar EOF termination');
      terminated = true;
      break;
    }
    const stored = tarNumber(header.subarray(148, 156));
    const calculated = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (stored !== calculated) throw new Error('Invalid tar header checksum');
    const size = tarNumber(header.subarray(124, 136));
    if (offset + size > tar.length) throw new Error('Truncated tar entry');
    const paddedSize = Math.ceil(size / 512) * 512;
    if (offset + paddedSize > tar.length) throw new Error('Truncated tar entry padding');
    const content = tar.subarray(offset, offset + size); offset += paddedSize;
    const type = String.fromCharCode(header[156] || 48);
    if (type === 'x' || type === 'g') { const records = paxRecords(content); if (type === 'g') global = { ...global, ...records }; else local = records; continue; }
    if (type === 'L') { longName = tarText(content).replace(/\n$/, ''); continue; }
    if (type === 'K') { longLink = tarText(content).replace(/\n$/, ''); continue; }
    const attrs = { ...global, ...local }, prefix = tarText(header.subarray(345, 500));
    const name = attrs.path ?? longName ?? (prefix ? prefix + '/' : '') + tarText(header.subarray(0, 100));
    const link = attrs.linkpath ?? longLink ?? tarText(header.subarray(157, 257));
    local = {}; longName = undefined; longLink = undefined;
    if (Object.keys(attrs).some(key => key.startsWith('GNU.sparse')) || (attrs.size !== undefined && Number(attrs.size) !== size)) throw new Error('Unsupported tar extension');
    if (!['0', '1', '2', '5'].includes(type)) throw new Error(`Unsupported tar entry type: ${type}`);
    const path = stripRoot(name, archiveRoot);
    if (!path) { if (type !== '5') throw new Error('Archive root must be a directory'); continue; }
    if (entries.has(path) && !(type === '5' && entries.get(path).type === '5')) throw new Error(`Duplicate archive entry: ${path}`);
    let target;
    if (type === '1') target = stripRoot(link, archiveRoot);
    if (type === '2') {
      if (!link || link.includes('\\') || link.includes('\0') || link.includes(':') || link.startsWith('/') || /^[a-z]:/i.test(link)) throw new Error(`Unsafe symlink: ${path}`);
      target = posix.normalize(posix.join(posix.dirname(path), link));
      if (target === '..' || target.startsWith('../') || target.startsWith('/')) throw new Error(`Escaping symlink: ${path}`);
    }
    entries.set(path, { path, type, content, link, target, mode: tarNumber(header.subarray(100, 108)) & 0o777 });
  }
  if (!terminated) throw new Error('Missing tar EOF termination');
  if (longName !== undefined || longLink !== undefined || Object.keys(local).length) throw new Error('Incomplete tar extended entry');
  // Include inferred directories so a later file/link cannot alias an earlier
  // subtree. Apply equivalence only where the actual filesystem aliases names.
  const semantics = await probeFilesystemSemantics(dirname(destination)), filesystemNames = new Map();
  for (const entry of entries.values()) {
    const components = entry.path.split('/');
    for (let length = 1; length <= components.length; length++) {
      const path = components.slice(0, length).join('/');
      let key = semantics.unicodeNormalizationSensitive ? path : path.normalize('NFC');
      if (!semantics.caseSensitive) key = key.toLowerCase();
      if (filesystemNames.has(key) && filesystemNames.get(key) !== path) throw new Error(`Filesystem-equivalent archive path collision: ${path}`);
      filesystemNames.set(key, path);
    }
  }
  for (const entry of entries.values()) {
    for (let parent = posix.dirname(entry.path); parent !== '.'; parent = posix.dirname(parent)) {
      if (entries.has(parent) && entries.get(parent).type !== '5') throw new Error(`Archive entry has non-directory ancestor: ${entry.path}`);
    }
    if (entry.type === '1' && entries.get(entry.target)?.type !== '0') throw new Error(`Unsafe hardlink: ${entry.path}`);
  }
  const directories = new Set(['']);
  for (const entry of entries.values()) {
    if (entry.type === '5') directories.add(entry.path);
    for (let parent = posix.dirname(entry.path); parent !== '.'; parent = posix.dirname(parent)) directories.add(parent);
  }
  // Resolve components before processing '..', matching filesystem semantics. Lexical
  // normalization alone can hide an escape through an intermediate directory link.
  function resolveLink(stack, link, active, state) {
    const components = link.split('/');
    for (let index = 0; index < components.length; index++) {
      const component = components[index];
      if (!component || component === '.') continue;
      if (component === '..') {
        if (!stack.length) throw new Error('Escaping symlink through intermediate link');
        stack.pop();
        continue;
      }
      const candidate = [...stack, component].join('/'), entry = entries.get(candidate);
      if (entry?.type === '2') {
        if (active.has(candidate)) throw new Error(`Cyclic symlink: ${candidate}`);
        if (++state.hops > 40) throw new Error('Too many symlinks in archive target');
        stack = resolveLink([...stack], entry.link, new Set([...active, candidate]), state);
      } else {
        if (!entry && !directories.has(candidate)) throw new Error(`Dangling symlink: ${candidate}`);
        stack.push(component);
      }
      if (index < components.length - 1 && !directories.has(stack.join('/'))) throw new Error(`Non-directory symlink target component: ${candidate}`);
    }
    return stack;
  }
  for (const entry of entries.values()) {
    if (entry.type === '2') {
      const parent = posix.dirname(entry.path);
      resolveLink(parent === '.' ? [] : parent.split('/'), entry.link, new Set([entry.path]), { hops: 1 });
    }
  }
  try { await lstat(destination); throw new Error('Extraction destination must be fresh'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(destination, { recursive: true });
  for (const entry of entries.values()) {
    const target = join(destination, ...entry.path.split('/'));
    if (entry.type === '5') await mkdir(target, { recursive: true });
    else if (entry.type === '0') { await mkdir(dirname(target), { recursive: true }); await writeFile(target, entry.content, { flag: 'wx', mode: entry.mode }); await chmod(target, entry.mode); }
  }
  for (const entry of entries.values()) {
    const target = join(destination, ...entry.path.split('/'));
    if (entry.type === '1') { await mkdir(dirname(target), { recursive: true }); await copyFile(join(destination, entry.target), target, constants.COPYFILE_EXCL); }
    if (entry.type === '2') { await mkdir(dirname(target), { recursive: true }); await symlink(entry.link, target); }
  }
}
async function defaultDownload(url, pin) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${url}`);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > pin.size) throw new Error(`Managed asset exceeds pinned byte count: ${url}`); chunks.push(chunk); }
  return Buffer.concat(chunks, size);
}
function verify(bytes, pin) {
  if (bytes.length !== pin.size || digest(bytes) !== pin.sha256) throw new Error(`Managed asset integrity mismatch: ${pin.url}`);
}
async function cachedAsset(pin, cacheRoot, download) {
  await mkdir(cacheRoot, { recursive: true });
  const path = join(cacheRoot, pin.sha256);
  try { if (!(await lstat(path)).isFile()) throw new Error('Managed asset cache is not a regular file'); const bytes = await readFile(path); verify(bytes, pin); return bytes; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const bytes = Buffer.from(await download(pin.url, pin)); verify(bytes, pin);
  const temporary = path + '.' + randomUUID();
  try { await writeFile(temporary, bytes, { flag: 'wx' }); await rename(temporary, path); } finally { await rm(temporary, { force: true }); }
  return bytes;
}
export async function prepareManagedAssets({ outputRoot, cacheRoot, platformKey = process.platform + '-' + process.arch, download = defaultDownload, pins }) {
  const manifest = pins ?? await readRuntimePins(), selected = manifest.platforms[platformKey];
  if (!selected) throw new Error(`Unsupported managed runtime platform: ${platformKey}`);
  const root = resolve(outputRoot), runtime = join(root, 'runtime');
  try { await lstat(runtime); throw new Error('Managed runtime destination must be fresh'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const result = { platform: platformKey, upstream: [] };
  try {
    for (const component of ['node', 'python', 'archon']) {
      const pin = selected[component];
      if (!pin || !/^[a-f0-9]{64}$/.test(pin.sha256) || !Number.isSafeInteger(pin.size) || pin.size <= 0 || !['binary', 'tar.gz'].includes(pin.format)) throw new Error(`Invalid ${component} asset pin`);
      const executable = safePath(pin.executable), bytes = await cachedAsset(pin, resolve(cacheRoot), download), target = join(runtime, component);
      if (pin.format === 'tar.gz') await extractManagedTarGz(bytes, target, pin.archiveRoot);
      else { await mkdir(target, { recursive: true }); await writeFile(join(target, executable), bytes, { flag: 'wx', mode: 0o755 }); }
      const canonicalTarget = await realpath(target), actual = await realpath(join(target, executable));
      if (!actual.startsWith(canonicalTarget + sep) || !(await lstat(actual)).isFile()) throw new Error(`Managed ${component} executable is unsafe or missing`);
      await chmod(actual, 0o755);
      result[component] = { executable: `runtime/${component}/${executable}`, version: pin.version };
      result.upstream.push({ component, ...pin });
    }
    return result;
  } catch (error) { await rm(runtime, { recursive: true, force: true }); throw error; }
}
