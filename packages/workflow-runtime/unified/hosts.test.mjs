import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { authenticateHost, detectHosts, inspectHost, listCodexModels, listLocalModels, readCredentials, saveCredentials } from './hosts.mjs';
import { launch } from './launch.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'temari-host-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'codex'), state = join(root, 'state'), configHome = join(root, 'config');
  await mkdir(configHome);
  await writeFile(executable, `#!${process.execPath}
const fs=require('node:fs'), readline=require('node:readline');
const args=process.argv.slice(2), state=process.env.MOCK_STATE;
if(args[0]==='--version')console.log(process.env.MOCK_VERSION||'codex-cli 0.154.0');
else if(args[0]==='login'&&args[1]==='status'||args[0]==='auth'&&args[1]==='status'){
 if(fs.existsSync(state)){console.error('Logged in using API key SENSITIVE_NATIVE_OUTPUT');process.exitCode=0;}else process.exitCode=1;
}else if(args[0]==='login'||args[0]==='auth'){
 if(process.env.MOCK_WAIT)setTimeout(()=>{},30000);
 else {fs.writeFileSync(state,JSON.stringify({args,home:process.env.CODEX_HOME||process.env.CLAUDE_CONFIG_DIR}));}
}else if(args[0]==='app-server'){
 if(process.env.MOCK_WAIT)setTimeout(()=>{},30000);
 else readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(m.id===undefined)return;
 if(m.method==='initialize')console.log(JSON.stringify({id:m.id,result:{userAgent:'fixture'}}));
 else if(m.method==='model/list')console.log(JSON.stringify({id:m.id,result:{data:[{id:'model-1',model:'available-model',supportedReasoningEfforts:[{reasoningEffort:'high'}],defaultReasoningEffort:'high'}],nextCursor:null}}));
 else process.exit(20);
 });
}
`, { mode: 0o700 });
  const env = { ...process.env, MOCK_STATE: state };
  return { root, executable, state, configHome, env };
}
async function readyHome(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'temari-credentials-test-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  await chmod(home, 0o700);
  await writeFile(join(home, 'setup.json'), JSON.stringify({ kind: 'temari-unified-installation', phase: 'ready' }), { mode: 0o600 });
  return home;
}

test('host discovery resolves executables and skips missing PATH entries', async (t) => {
  const f = await fixture(t);
  await symlink(f.executable, join(f.root, 'claude'));
  await symlink(f.executable, join(f.root, 'git'));
  const result = await detectHosts({ env: { PATH: `/missing:${f.root}` } });
  assert.deepEqual(result, ['codex', 'claude-code', 'git'].map((kind) => ({ kind, executable: f.executable })));
});

test('Codex login uses the native ceremony, rechecks status, and exposes no native secret', async (t) => {
  const f = await fixture(t);
  const absent = await inspectHost({ ...f, kind: 'codex', discoverModels: false });
  assert.equal(absent.compatible, true); assert.equal(absent.authenticated, false);
  const loggedIn = await authenticateHost({ ...f, kind: 'codex', method: 'device', stdio: 'ignore' });
  assert.equal(loggedIn.status, 'authenticated');
  assert.equal(loggedIn.workerReady, true);
  assert.deepEqual(JSON.parse(await readFile(f.state, 'utf8')), { args: ['login', '--device-auth'], home: f.configHome });
  const inspection = await inspectHost({ ...f, kind: 'codex' });
  assert.equal(inspection.modelCatalog.status, 'live'); assert.equal(inspection.models[0].id, 'available-model');
  assert.equal(inspection.models[0].defaultReasoning, 'high');
  assert(!JSON.stringify([loggedIn, inspection]).includes('SENSITIVE_NATIVE_OUTPUT'));
});

test('login cancellation returns an explicit cancelled result without retaining native output', async (t) => {
  const f = await fixture(t), controller = new AbortController();
  const pending = authenticateHost({ ...f, kind: 'codex', env: { ...f.env, MOCK_WAIT: '1' }, stdio: 'ignore', signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  assert.deepEqual(await pending, { kind: 'codex', status: 'cancelled' });
  assert.deepEqual(await authenticateHost({ ...f, kind: 'codex', signal: controller.signal }), { kind: 'codex', status: 'cancelled' });
});

test('Codex caches must be fresh and match the CLI; mismatches use bounded model/list', async (t) => {
  const f = await fixture(t);
  await writeFile(f.state, 'ready');
  const cache = { fetched_at: new Date().toISOString(), client_version: '0.154.0', models: [{ slug: 'cached-model', visibility: 'list', supported_reasoning_levels: [{ effort: 'medium' }], default_reasoning_level: 'medium' }, { slug: 'hidden-model', visibility: 'hide' }] };
  await writeFile(join(f.configHome, 'models_cache.json'), JSON.stringify(cache));
  const ready = await inspectHost({ ...f, kind: 'codex' });
  assert.equal(ready.modelCatalog.status, 'ready'); assert.equal(ready.models.length, 1); assert.equal(ready.models[0].defaultReasoning, 'medium');
  cache.client_version = '0.162.0';
  await writeFile(join(f.configHome, 'models_cache.json'), JSON.stringify(cache));
  const mismatch = await inspectHost({ ...f, kind: 'codex' });
  assert.equal(mismatch.modelCatalog.status, 'live'); assert.equal(mismatch.models[0].id, 'available-model');
  cache.client_version = '0.154.0'; cache.fetched_at = '2000-01-01T00:00:00Z';
  await writeFile(join(f.configHome, 'models_cache.json'), JSON.stringify(cache));
  const stale = await inspectHost({ ...f, kind: 'codex', discoverModels: false });
  assert.equal(stale.modelCatalog.status, 'stale'); assert.deepEqual(stale.models, []);
});

test('model discovery times out with a sanitized error', async (t) => {
  const f = await fixture(t);
  await assert.rejects(listCodexModels({ ...f, env: { ...f.env, MOCK_WAIT: '1' }, timeoutMs: 100 }), /Unable to discover account models/u);
});

test('Claude client OAuth and bare worker readiness are distinct; old CLIs are refused', async (t) => {
  const f = await fixture(t);
  await writeFile(f.state, 'ready');
  const env = { ...f.env, MOCK_VERSION: '2.1.296 (Claude Code)', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN: 'ignored-oauth-secret' };
  const client = await inspectHost({ ...f, kind: 'claude-code', env });
  assert.equal(client.compatible, true); assert.equal(client.authenticated, true); assert.equal(client.workerReady, false);
  const worker = await inspectHost({ ...f, kind: 'claude-code', env: { ...env, ANTHROPIC_AUTH_TOKEN: 'worker-secret' } });
  assert.equal(worker.workerReady, true); assert.equal(worker.authentication.method, 'auth-token');
  assert(!JSON.stringify(worker).includes('worker-secret'));
  assert.equal((await inspectHost({ ...f, kind: 'claude-code', env: { ...env, MOCK_VERSION: '2.1.285 (Claude Code)', ANTHROPIC_API_KEY: 'key' } })).workerReady, false);
});

test('local model discovery is bounded and restricted to loopback without redirects', async () => {
  let requested;
  const models = await listLocalModels({ fetchImpl: async (url, options) => { requested = { url: String(url), redirect: options.redirect }; return new Response(JSON.stringify({ models: [{ name: 'qwen3-coder:30b' }] })); } });
  assert.deepEqual(models, [{ id: 'qwen3-coder:30b', name: 'qwen3-coder:30b' }]);
  assert.deepEqual(requested, { url: 'http://127.0.0.1:11434/api/tags', redirect: 'error' });
  await assert.rejects(listLocalModels({ baseUrl: 'http://example.com' }), /loopback/u);
  await assert.rejects(listLocalModels({ baseUrl: 'http://secret@127.0.0.1' }), /loopback/u);
  await assert.rejects(listLocalModels({ fetchImpl: async () => new Response('x'.repeat(1024 * 1024 + 1)) }), /limit/u);
});

test('credentials persist privately across restarts and only expose key names in save metadata', async (t) => {
  const home = await readyHome(t), secret = 'test-secret-not-for-evidence';
  const saved = await saveCredentials({ home, values: { OPENAI_API_KEY: secret } });
  assert.equal((await lstat(saved.path)).mode & 0o777, 0o600);
  assert(!JSON.stringify(saved).includes(secret)); assert.deepEqual(saved.keys, ['OPENAI_API_KEY']);
  await saveCredentials({ home, values: { ANTHROPIC_AUTH_TOKEN: 'local-token', ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434' } });
  assert.deepEqual(await readCredentials({ home }), { OPENAI_API_KEY: secret, ANTHROPIC_AUTH_TOKEN: 'local-token', ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434' });
  await assert.rejects(saveCredentials({ home, values: { CODEX_TOKEN: secret } }), /Unsupported/u);
  await assert.rejects(saveCredentials({ home, values: { ANTHROPIC_BASE_URL: 'http://secret@example.com' } }), /HTTPS/u);
  assert.equal(await readFile(join(home, 'credentials.json'), 'utf8').then((text) => text.includes(secret)), true);
});

test('credential symlinks, hardlinks, public modes, and unfinished setup are refused', async (t) => {
  const home = await readyHome(t), path = join(home, 'credentials.json'), external = join(home, 'external');
  await writeFile(external, JSON.stringify({ schema: 1, values: { OPENAI_API_KEY: 'secret' } }), { mode: 0o600 });
  await symlink(external, path);
  await assert.rejects(readCredentials({ home }), /storage is invalid/u);
  await assert.rejects(saveCredentials({ home, values: { OPENAI_API_KEY: 'replacement' } }), /storage is invalid/u);
  await rm(path); await link(external, path);
  await assert.rejects(readCredentials({ home }), /storage is invalid/u);
  await rm(path); await saveCredentials({ home, values: { OPENAI_API_KEY: 'secret' } }); await chmod(path, 0o644);
  await assert.rejects(readCredentials({ home }), /storage is invalid/u);
  await chmod(home, 0o755); await assert.rejects(readCredentials({ home }), /private/u); await chmod(home, 0o700);
  await chmod(path, 0o600); await writeFile(path, '{secret-content-invalid-json');
  await assert.rejects(readCredentials({ home }), (error) => /storage is invalid/u.test(error.message) && !error.message.includes('secret-content'));
  await writeFile(join(home, 'setup.json'), JSON.stringify({ kind: 'temari-unified-installation', phase: 'preparing' }));
  await assert.rejects(readCredentials({ home }), /Complete setup/u);
});

test('launcher loads saved credential values without persisting them in profile, preserves cwd, and verifies executable hashes', async (t) => {
  const home = await readyHome(t), installation = join(home, 'installations', 'fixture'), node = join(installation, 'runtime', 'node'), dashboard = join(installation, 'dashboard', 'main.mjs'), output = join(home, 'observed.json');
  await mkdir(join(installation, 'runtime'), { recursive: true }); await mkdir(join(installation, 'dashboard'));
  const nodeBytes = Buffer.from(`#!/bin/sh\nexec '${process.execPath}' "$@"\n`);
  const dashboardBytes = Buffer.from(`import { writeFileSync } from 'node:fs'; writeFileSync(process.env.TEST_OUTPUT, JSON.stringify({correctKey:process.env.OPENAI_API_KEY==='saved-secret',localAuthSelected:process.env.ANTHROPIC_API_KEY===''&&process.env.ANTHROPIC_AUTH_TOKEN==='ollama'&&process.env.ANTHROPIC_BASE_URL==='http://127.0.0.1:11434',cloudAuthSelected:process.env.ANTHROPIC_API_KEY==='saved-cloud-key'&&process.env.ANTHROPIC_AUTH_TOKEN===''&&process.env.ANTHROPIC_BASE_URL==='https://api.anthropic.com',cwd:process.cwd(),args:process.argv.slice(2)})); process.exitCode=7;\n`);
  await writeFile(node, nodeBytes, { mode: 0o700 }); await writeFile(dashboard, dashboardBytes);
  const manifestBytes = Buffer.from(JSON.stringify({ assets: { node: { executable: 'runtime/node' } }, files: [{ path: 'runtime/node', kind: 'file', sha256: sha(nodeBytes) }, { path: 'dashboard/main.mjs', kind: 'file', sha256: sha(dashboardBytes) }] }));
  await writeFile(join(installation, 'UNIFIED.json'), manifestBytes);
  await writeFile(join(home, 'setup.json'), JSON.stringify({ kind: 'temari-unified-installation', phase: 'ready', installation, releaseSha256: sha(manifestBytes) }));
  await saveCredentials({ home, values: { OPENAI_API_KEY: 'saved-secret', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: 'ollama', ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434' } });
  const poisonedEnvironment = { ...process.env, TEST_OUTPUT: output, OPENAI_API_KEY: 'stale-terminal', ANTHROPIC_API_KEY: 'poison-cloud-key', ANTHROPIC_AUTH_TOKEN: 'poison-native-token', ANTHROPIC_BASE_URL: 'https://poison.invalid' };
  assert.deepEqual(await launch({ home, node, dashboard, args: ['doctor'], env: poisonedEnvironment, stdio: 'ignore' }), { exitCode: 7, signal: null });
  assert.deepEqual(JSON.parse(await readFile(output)), { correctKey: true, localAuthSelected: true, cloudAuthSelected: false, cwd: process.cwd(), args: ['doctor', '--home', join(home, 'dashboard')] });
  await saveCredentials({ home, values: { ANTHROPIC_API_KEY: 'saved-cloud-key', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } });
  assert.deepEqual(await launch({ home, node, dashboard, args: ['doctor'], env: { ...poisonedEnvironment, ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434' }, stdio: 'ignore' }), { exitCode: 7, signal: null });
  assert.deepEqual(JSON.parse(await readFile(output)), { correctKey: true, localAuthSelected: false, cloudAuthSelected: true, cwd: process.cwd(), args: ['doctor', '--home', join(home, 'dashboard')] });
  await writeFile(node, '#!/bin/sh\nexit 0\n');
  await assert.rejects(launch({ home, node, dashboard, stdio: 'ignore' }), /identity changed/u);
});
