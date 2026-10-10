import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, lstat, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import { extractManagedTarGz, prepareManagedAssets, readRuntimePins } from './unified-assets.mjs';
function tar(entries) {
  const chunks = [];
  for (const { name, type = '0', link = '', content = '', mode = 0o755 } of entries) {
    const payload = Buffer.from(content), header = Buffer.alloc(512);
    const oct = (start, length, value) => header.write(value.toString(8).padStart(length - 1, '0') + '\0', start);
    header.write(name, 0, 100); oct(100, 8, mode); oct(124, 12, payload.length); header.fill(32, 148, 156); header.write(type, 156); header.write(link, 157, 100); header.write('ustar\0', 257);
    oct(148, 8, header.reduce((sum, byte) => sum + byte, 0)); chunks.push(header, payload, Buffer.alloc((512 - payload.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}
async function fixture(t) { const root = await mkdtemp(join(tmpdir(), 'temari-assets-test-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }
function pin(bytes, extra = {}) { return { version: 'fixture', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), url: 'https://fixture.invalid/runtime', format: 'binary', executable: 'binary', ...extra }; }
function selected(bytes) { return { platforms: { 'fixture-x64': { node: pin(bytes), python: pin(bytes), archon: pin(bytes) } } }; }
test('all matrix pins have immutable identity and parity with the managed Archon harness', async () => {
  const pins = await readRuntimePins(), harness = await readFile(new URL('../libs/archon-harness/src/lib/managed-runtime.ts', import.meta.url), 'utf8');
  assert.deepEqual(Object.keys(pins.platforms), ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64']);
  for (const [platform, components] of Object.entries(pins.platforms)) {
    for (const value of Object.values(components)) { assert.match(value.sha256, /^[a-f0-9]{64}$/); assert.ok(value.size > 0); assert.match(value.url, /^https:\/\//); }
    assert.equal(components.node.version, '22.23.3'); assert.equal(components.python.version, '3.12.15');
    const block = harness.split(`platformKey: '${platform}'`)[1].split('},')[0];
    assert.ok(block.includes(`size: ${components.archon.size}`)); assert.ok(block.includes(`sha256: '${components.archon.sha256}'`));
  }
});
test('prepares private runtimes and reuses verified cache without network', async t => {
  const root = await fixture(t), bytes = Buffer.from('fixture binary'); let requests = 0;
  const args = { cacheRoot: join(root, 'cache'), platformKey: 'fixture-x64', pins: selected(bytes), download: async () => { requests++; return bytes; } };
  const first = await prepareManagedAssets({ ...args, outputRoot: join(root, 'first') });
  assert.equal(requests, 1); assert.equal(first.python.executable, 'runtime/python/binary'); assert.equal(first.upstream.length, 3);
  const second = await prepareManagedAssets({ ...args, outputRoot: join(root, 'second'), download: () => { throw Error('Network must not run'); } });
  assert.deepEqual(second, first); assert.equal(await readFile(join(root, 'second', second.node.executable), 'utf8'), 'fixture binary');
  await assert.rejects(prepareManagedAssets({ ...args, outputRoot: join(root, 'second') }), /must be fresh/);
});
test('fails closed for downloaded bytes, corrupt cache, unsupported platform, and cleans partial output', async t => {
  const root = await fixture(t), bytes = Buffer.from('fixture binary'), pins = selected(bytes), args = { outputRoot: join(root, 'out'), cacheRoot: join(root, 'cache'), platformKey: 'fixture-x64', pins };
  await assert.rejects(prepareManagedAssets({ ...args, download: async () => Buffer.from('bad') }), /integrity mismatch/);
  await prepareManagedAssets({ ...args, download: async () => bytes });
  await writeFile(join(args.cacheRoot, pin(bytes).sha256), 'corrupt');
  await assert.rejects(prepareManagedAssets({ ...args, outputRoot: join(root, 'second'), download: () => { throw Error('No redownload'); } }), /integrity mismatch/);
  await assert.rejects(lstat(join(root, 'second', 'runtime')), { code: 'ENOENT' });
  await assert.rejects(prepareManagedAssets({ ...args, platformKey: 'aix-ppc64' }), /Unsupported/);
});
test('extracts bounded root with executable modes and safe relative symlinks', async t => {
  const root = await fixture(t), output = join(root, 'out');
  await extractManagedTarGz(tar([{ name: 'python/bin/python3.12', content: 'interpreter' }, { name: 'python/bin/python3', type: '2', link: 'python3.12' }, { name: 'python/bin/copied', type: '1', link: 'python/bin/python3.12' }]), output, 'python');
  assert.equal(await readFile(join(output, 'bin/python3'), 'utf8'), 'interpreter'); assert.equal(await readFile(join(output, 'bin/copied'), 'utf8'), 'interpreter');
  assert.ok((await lstat(join(output, 'bin/python3.12'))).mode & 0o100);
});
test('rejects path traversal, root escapes, special entries and symlink attacks before writing', async t => {
  const root = await fixture(t);
  const cases = [
    [{ name: 'python/../escaped', content: 'bad' }], [{ name: '/python/absolute', content: 'bad' }], [{ name: 'other/file', content: 'bad' }],
    [{ name: 'python/device', type: '3' }], [{ name: 'python/bin/link', type: '2', link: '../../escaped' }],
    [{ name: 'python/link', type: '2', link: '/tmp/escaped' }], [{ name: 'python/link', type: '2', link: 'missing' }],
    [{ name: 'python/link', type: '2', link: 'file' }, { name: 'python/file', content: 'okay' }, { name: 'python/link/nested', content: 'bad' }],
    [{ name: 'python/a', type: '2', link: 'b' }, { name: 'python/b', type: '2', link: 'a' }],
    [{ name: 'python/file', content: '1' }, { name: 'python/file', content: '2' }],
    [{ name: 'python/link', type: '1', link: '../escaped' }],
  ];
  for (let i = 0; i < cases.length; i++) { const output = join(root, String(i)); await assert.rejects(extractManagedTarGz(tar(cases[i]), output, 'python')); await assert.rejects(lstat(output), { code: 'ENOENT' }); }
});
test('PAX and GNU long-name overrides receive the same traversal validation', async t => {
  const root = await fixture(t), value = 'path=python/../escaped\n'; let record = `00 ${value}`; record = `${Buffer.byteLength(record)} ${value}`;
  await assert.rejects(extractManagedTarGz(tar([{ name: 'pax', type: 'x', content: record }, { name: 'python/safe', content: 'bad' }]), join(root, 'pax'), 'python'), /Unsafe archive path/);
  await assert.rejects(extractManagedTarGz(tar([{ name: 'long', type: 'L', content: 'python/../escaped\0' }, { name: 'python/safe', content: 'bad' }]), join(root, 'gnu'), 'python'), /Unsafe archive path/);
});
test('an unsafe second component removes the partially prepared runtime tree', async t => {
  const root = await fixture(t), node = Buffer.from('node'), python = tar([{ name: 'python/bin/python3.12', content: 'python' }, { name: 'python/../escaped', content: 'bad' }]);
  const pins = { platforms: { 'fixture-x64': { node: pin(node, { url: 'https://fixture.invalid/node' }), python: pin(python, { url: 'https://fixture.invalid/python', format: 'tar.gz', archiveRoot: 'python', executable: 'bin/python3.12' }), archon: pin(node) } } };
  await assert.rejects(prepareManagedAssets({ outputRoot: join(root, 'out'), cacheRoot: join(root, 'cache'), platformKey: 'fixture-x64', pins, download: async url => url.endsWith('/python') ? python : node }), /Unsafe archive path/);
  await assert.rejects(lstat(join(root, 'out', 'runtime')), { code: 'ENOENT' }); await assert.rejects(lstat(join(root, 'out', 'escaped')), { code: 'ENOENT' });
});
test('resolves intermediate directory links before .. and rejects hidden subtree escapes', async t => {
  const root = await fixture(t), output = join(root, 'escaped');
  const entries = [{ name: 'python/safe/', type: '5' }, { name: 'python/outside', content: 'lexical target inside root' }, { name: 'python/deep/alias', type: '2', link: '../safe' }, { name: 'python/deep/escape', type: '2', link: 'alias/../../outside' }];
  await assert.rejects(extractManagedTarGz(tar(entries), output, 'python'), /Escaping symlink through intermediate link/);
  await assert.rejects(lstat(output), { code: 'ENOENT' });
  const safeOutput = join(root, 'safe');
  await extractManagedTarGz(tar([{ name: 'python/safe/file', content: 'safe internal target' }, { name: 'python/deep/alias', type: '2', link: '../safe' }, { name: 'python/deep/link', type: '2', link: 'alias/file' }]), safeOutput, 'python');
  assert.equal(await readFile(join(safeOutput, 'deep/link'), 'utf8'), 'safe internal target');
});
test('rejects case and Unicode-equivalent paths including inferred parent directories', async t => {
  const root = await fixture(t);
  const cases = [
    [{ name: 'python/tool', content: 'original' }, { name: 'python/other', content: 'replacement' }, { name: 'python/TOOL', type: '1', link: 'python/other' }],
    [{ name: 'python/tool', content: 'original' }, { name: 'python/TOOL', content: 'replacement' }],
    [{ name: 'python/Tools/one', content: 'one' }, { name: 'python/tools/two', content: 'two' }],
    [{ name: 'python/caf\u00e9', content: 'NFC' }, { name: 'python/cafe\u0301', content: 'NFD' }],
    [{ name: 'python/caf\u00e9/one', content: 'one' }, { name: 'python/cafe\u0301/two', content: 'two' }],
  ];
  for (let index = 0; index < cases.length; index++) {
    const output = join(root, String(index));
    await assert.rejects(extractManagedTarGz(tar(cases[index]), output, 'python'), /Filesystem-equivalent archive path collision/);
    await assert.rejects(lstat(output), { code: 'ENOENT' });
  }
});
test('rejects incomplete headers and padded entry blocks and requires complete EOF termination', async t => {
  const root = await fixture(t), valid = gunzipSync(tar([{ name: 'python/bin/python3.12', content: 'x' }]));
  const cases = [
    [Buffer.concat([valid.subarray(0, 1024), Buffer.alloc(31, 1)]), /Incomplete tar header/],
    [valid.subarray(0, 513), /Truncated tar entry padding/],
    [valid.subarray(0, 1024), /Missing tar EOF termination/],
    [valid.subarray(0, 1536), /Incomplete or invalid tar EOF termination/],
    [valid.subarray(0, valid.length - 1), /Incomplete or invalid tar EOF termination/],
    [Buffer.concat([valid, Buffer.alloc(512, 1)]), /Incomplete or invalid tar EOF termination/],
  ];
  for (let index = 0; index < cases.length; index++) {
    const output = join(root, `bad-${index}`), [bytes, message] = cases[index];
    await assert.rejects(extractManagedTarGz(gzipSync(bytes), output, 'python'), message);
    await assert.rejects(lstat(output), { code: 'ENOENT' });
  }
  for (const [name, bytes] of [['eof', valid], ['record-padding', Buffer.concat([valid, Buffer.alloc(1024)])]]) {
    const output = join(root, name);
    await extractManagedTarGz(gzipSync(bytes), output, 'python');
    assert.equal(await readFile(join(output, 'bin/python3.12'), 'utf8'), 'x');
  }
});
test('rejects NTFS alternate data stream names and symlink targets on every platform', async t => {
  const root = await fixture(t);
  const cases = [
    [{ name: 'python/bin/tool:payload', content: 'alternate data stream' }],
    [{ name: 'python/bin/python3.12', content: 'interpreter' }, { name: 'python/bin/link', type: '2', link: 'python3.12:payload' }],
    [{ name: 'python/bin/link', type: '2', link: '../dir:payload/file' }],
  ];
  for (let index = 0; index < cases.length; index++) {
    const output = join(root, String(index));
    await assert.rejects(extractManagedTarGz(tar(cases[index]), output, 'python'), /Unsafe archive path|Unsafe symlink/);
    await assert.rejects(lstat(output), { code: 'ENOENT' });
  }
});
