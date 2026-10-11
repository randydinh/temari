import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { prepareProviderAssets, readProviderPins } from './unified-provider-assets.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function archive(entries) {
  const chunks = [];
  for (const { name, content = '', mode = 0o755 } of entries) {
    const bytes = Buffer.from(content), header = Buffer.alloc(512);
    const octal = (start, length, value) => header.write(value.toString(8).padStart(length - 1, '0') + '\0', start);
    header.write(name); octal(100, 8, mode); octal(124, 12, bytes.length); header.fill(32, 148, 156); header.write('0', 156); header.write('ustar\0', 257);
    octal(148, 8, header.reduce((sum, byte) => sum + byte, 0)); chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}
function fixturePins(bytes, executableBytes) {
  const pin = { version: '1.2.3', url: 'https://registry.npmjs.org/fixture/-/fixture-1.2.3.tgz', size: bytes.length, sha256: hash(bytes), integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`, format: 'tar.gz', archiveRoot: 'package', executable: 'native', executableSha256: hash(executableBytes), executableSize: executableBytes.length };
  return { platforms: { 'fixture-x64': { codex: pin, 'claude-code': pin } } };
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'temari-provider-assets-')); t.after(() => rm(root, { recursive: true, force: true }));
  const native = Buffer.from('fixture native'), bytes = archive([{ name: 'package/native', content: native }, { name: 'package/LICENSE', content: 'upstream license' }]);
  return { root, bytes, pins: fixturePins(bytes, native), outputRoot: join(root, 'out'), cacheRoot: join(root, 'cache'), platformKey: 'fixture-x64' };
}
test('official native provider pins cover both providers on all four Unix platforms', async () => {
  const pins = await readProviderPins();
  assert.deepEqual(Object.keys(pins.platforms), ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']);
  for (const platform of Object.keys(pins.platforms)) {
    const selected = pins.platforms[platform];
    assert.equal(selected.codex.version, '0.154.0'); assert.equal(selected['claude-code'].version, '2.1.296');
    for (const pin of Object.values(selected)) {
      assert.match(pin.url, /^https:\/\/registry\.npmjs\.org\//); assert.match(pin.sha256, /^[a-f0-9]{64}$/); assert.match(pin.integrity, /^sha512-/); assert.ok(pin.size > 0);
      assert.match(pin.executableSha256, /^[a-f0-9]{64}$/); assert.ok(pin.executableSize < 256 * 1024 * 1024);
    }
  }
});
test('bundles complete native package trees and reuses verified archive cache', async t => {
  const f = await fixture(t); let requests = 0;
  const first = await prepareProviderAssets({ ...f, download: async () => { requests++; return f.bytes; } });
  assert.equal(requests, 1); assert.equal(first.codex.executable, 'runtime/providers/codex/native'); assert.equal(first.upstream.length, 2);
  assert.deepEqual(first['claude-code'].environment, { DISABLE_AUTOUPDATER: '1', DISABLE_UPDATES: '1' });
  assert.equal(await readFile(join(f.outputRoot, 'runtime/providers/codex/LICENSE'), 'utf8'), 'upstream license');
  const second = await prepareProviderAssets({ ...f, outputRoot: join(f.root, 'retry'), download: () => { throw Error('Recipient network must not run'); } });
  assert.deepEqual(first, second);
  await assert.rejects(prepareProviderAssets({ ...f }), /must be fresh/);
});
test('refuses changed archives, integrity drift, executable drift and corrupt cache', async t => {
  const f = await fixture(t);
  await assert.rejects(prepareProviderAssets({ ...f, download: async () => Buffer.from('bad') }), /integrity mismatch/);
  const integrity = structuredClone(f.pins); integrity.platforms['fixture-x64'].codex.integrity = 'sha512-YmFk';
  await assert.rejects(prepareProviderAssets({ ...f, pins: integrity, download: async () => f.bytes }), /integrity mismatch/);
  const drift = structuredClone(f.pins); drift.platforms['fixture-x64']['claude-code'].executableSha256 = '0'.repeat(64);
  await assert.rejects(prepareProviderAssets({ ...f, pins: drift, download: async () => f.bytes }), /executable integrity mismatch/);
  await assert.rejects(lstat(join(f.outputRoot, 'runtime/providers')), { code: 'ENOENT' });
  await writeFile(join(f.cacheRoot, hash(f.bytes)), 'corrupt');
  await assert.rejects(prepareProviderAssets({ ...f, download: () => { throw Error('No redownload'); } }), /cache file/);
});
test('rejects symlink cache and archive traversal without adopting preexisting output', async t => {
  const f = await fixture(t); await prepareProviderAssets({ ...f, download: async () => f.bytes });
  const cache = join(f.cacheRoot, hash(f.bytes)); await rm(cache); await symlink(join(f.outputRoot, 'runtime/providers/codex/native'), cache);
  await assert.rejects(prepareProviderAssets({ ...f, outputRoot: join(f.root, 'retry') }), /cache file/);
  await assert.rejects(prepareProviderAssets({ ...f, platformKey: 'win32-x64' }), /Unsupported/);
  const escaped = archive([{ name: 'package/../outside', content: 'bad' }]);
  await assert.rejects(prepareProviderAssets({ ...f, outputRoot: join(f.root, 'escape'), cacheRoot: join(f.root, 'escape-cache'), pins: fixturePins(escaped, Buffer.from('bad')), download: async () => escaped }), /Unsafe archive path/);
});
