import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { digest, inventory } from './inventory.mjs';
import { installManagedProvider } from './providers.mjs';

async function fixture(t, kind = 'codex') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'temari-provider-recipient-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const relative = `runtime/providers/${kind}/native`, executable = join(root, relative), bytes = Buffer.from('fixture native');
  await mkdir(dirname(executable), { recursive: true }); await writeFile(executable, bytes, { mode: 0o755 });
  const platform = process.platform + '-' + process.arch;
  const manifest = { assets: { platform }, providers: { platform, [kind]: { executable: relative, version: '1.2.3', executableSha256: digest(bytes), executableSize: bytes.length } }, files: await inventory(root) };
  return { root, executable, manifest, kind, execute: async () => ({ stdout: kind === 'codex' ? 'codex-cli 1.2.3\n' : '1.2.3 (Claude Code)\n', stderr: '' }) };
}
test('selects pinned native executable repeatedly without a recipient download or home mutation', async t => {
  const f = await fixture(t); const first = await installManagedProvider(f), second = await installManagedProvider(f);
  assert.deepEqual(first, second); assert.equal(first.executable, f.executable); assert.equal(first.managed, true); assert.equal(first.version, '1.2.3');
});
test('forces Claude update suppression before the native version probe', async t => {
  const f = await fixture(t, 'claude-code');
  const result = await installManagedProvider({ ...f, env: { DISABLE_UPDATES: '0' }, execute: async (executable, args, options) => {
    assert.equal(executable, f.executable); assert.deepEqual(args, ['--version']); assert.equal(options.env.DISABLE_AUTOUPDATER, '1'); assert.equal(options.env.DISABLE_UPDATES, '1');
    return f.execute();
  } });
  assert.deepEqual(result.environment, { DISABLE_AUTOUPDATER: '1', DISABLE_UPDATES: '1' });
});
test('rejects wrong platform, inventory/digest drift and wrong native version before auth', async t => {
  const f = await fixture(t); let commands = 0; const execute = async () => { commands++; return f.execute(); };
  await assert.rejects(installManagedProvider({ ...f, platformKey: 'linux-other', execute }), /platform differs/);
  const drift = structuredClone(f.manifest); drift.providers.codex.executableSha256 = '0'.repeat(64);
  await assert.rejects(installManagedProvider({ ...f, manifest: drift, execute }), /not inventoried/);
  await writeFile(f.executable, 'changed'); await assert.rejects(installManagedProvider({ ...f, execute }), /Invalid managed provider file/);
  assert.equal(commands, 0);
  await writeFile(f.executable, 'fixture native');
  await assert.rejects(installManagedProvider({ ...f, execute: async () => ({ stdout: 'codex-cli 9.9.9' }) }), /version differs/);
  await assert.rejects(installManagedProvider({ ...f, execute: async () => { throw Error('private native diagnostic'); } }), error => !error.message.includes('private native diagnostic') && error.message.includes('cannot run'));
});
test('rejects symlink and traversal executable paths, plus changes during version inspection', async t => {
  const f = await fixture(t); const bytes = await readFile(f.executable);
  await rm(f.executable); const other = join(f.root, 'other'); await writeFile(other, bytes, { mode: 0o755 }); await symlink(other, f.executable);
  await assert.rejects(installManagedProvider(f), /path drift/);
  await rm(f.executable); await writeFile(f.executable, bytes, { mode: 0o755 });
  const manifest = structuredClone(f.manifest); manifest.providers.codex.executable = 'runtime/providers/codex/../../other';
  await assert.rejects(installManagedProvider({ ...f, manifest }), /Unsafe/);
  await assert.rejects(installManagedProvider({ ...f, execute: async () => { await writeFile(f.executable, 'changed after probe'); return f.execute(); } }), /changed during/);
});
