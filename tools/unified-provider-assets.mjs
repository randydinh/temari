/** Publisher-only acquisition. Recipients use the bundled, inventoried native trees. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { extractManagedTarGz } from './unified-assets.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const kinds = ['codex', 'claude-code'];
export async function readProviderPins() {
  return JSON.parse(await readFile(new URL('../packages/workflow-runtime/unified/provider-pins.json', import.meta.url), 'utf8'));
}
function validatePin(pin) {
  assert(pin && /^\d+\.\d+\.\d+$/u.test(pin.version), 'Invalid provider version pin.');
  assert(/^https:\/\/registry\.npmjs\.org\//u.test(pin.url) && /^[a-f0-9]{64}$/u.test(pin.sha256), 'Invalid provider archive identity.');
  assert(/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(pin.integrity), 'Invalid provider registry integrity.');
  assert(Number.isSafeInteger(pin.size) && pin.size > 0 && pin.size <= 256 * 1024 * 1024, 'Invalid provider archive size.');
  assert(pin.format === 'tar.gz' && pin.archiveRoot === 'package', 'Invalid provider archive format.');
  assert(typeof pin.executable === 'string' && pin.executable.split('/').every(part => /^[A-Za-z0-9._-]+$/u.test(part) && !['.', '..'].includes(part)), 'Invalid provider executable path.');
  assert(/^[a-f0-9]{64}$/u.test(pin.executableSha256) && Number.isSafeInteger(pin.executableSize) && pin.executableSize > 0, 'Invalid provider executable identity.');
}
function verify(bytes, pin) {
  assert(bytes.length === pin.size && digest(bytes) === pin.sha256 && `sha512-${createHash('sha512').update(bytes).digest('base64')}` === pin.integrity, 'Managed provider archive integrity mismatch.');
}
async function downloadAsset(url, pin) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180000), redirect: 'error' });
  assert(response.ok, `Provider download failed (${response.status}).`);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; assert(size <= pin.size, 'Provider archive exceeds its pinned byte count.'); chunks.push(chunk); }
  return Buffer.concat(chunks, size);
}
async function cachedAsset(pin, cacheRoot, download) {
  await mkdir(cacheRoot, { recursive: true });
  const path = join(cacheRoot, pin.sha256);
  try {
    const stat = await lstat(path);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.size === pin.size, 'Invalid managed provider cache file.');
    const bytes = await readFile(path); verify(bytes, pin); return bytes;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const bytes = Buffer.from(await download(pin.url, pin)); verify(bytes, pin);
  const temporary = `${path}.${randomUUID()}`;
  try { await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
  return bytes;
}
export async function prepareProviderAssets({ outputRoot, cacheRoot, platformKey = process.platform + '-' + process.arch, download = downloadAsset, pins }) {
  const catalog = pins ?? await readProviderPins(), selected = catalog.platforms?.[platformKey];
  assert(selected, `Unsupported managed provider platform: ${platformKey}`);
  // Validate the whole selection before touching either destination or network.
  for (const kind of kinds) validatePin(selected[kind]);
  const root = resolve(outputRoot), targetRoot = join(root, 'runtime', 'providers');
  try { await lstat(targetRoot); throw new Error('Managed provider destination must be fresh.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const result = { platform: platformKey, upstream: [] };
  try {
    for (const kind of kinds) {
      const pin = selected[kind], destination = join(targetRoot, kind);
      await extractManagedTarGz(await cachedAsset(pin, resolve(cacheRoot), download), destination, pin.archiveRoot);
      const executable = join(destination, pin.executable), physical = await realpath(executable);
      assert(physical === join(await realpath(destination), pin.executable) && physical.startsWith((await realpath(destination)) + sep), 'Provider executable path drift.');
      const stat = await lstat(executable), bytes = await readFile(executable);
      assert(stat.isFile() && !stat.isSymbolicLink() && stat.size === pin.executableSize && digest(bytes) === pin.executableSha256, 'Managed provider executable integrity mismatch.');
      await chmod(executable, 0o755);
      result[kind] = { executable: `runtime/providers/${kind}/${pin.executable}`, version: pin.version, executableSha256: pin.executableSha256, executableSize: pin.executableSize,
        environment: kind === 'claude-code' ? { DISABLE_AUTOUPDATER: '1', DISABLE_UPDATES: '1' } : {} };
      result.upstream.push({ kind, ...pin });
    }
    return result;
  } catch (error) { await rm(targetRoot, { recursive: true, force: true }); throw error; }
}
