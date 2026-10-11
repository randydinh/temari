import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from './inventory.mjs';
import { guidedSetup, probeChat } from './guide.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'temari-guide-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'), workspace = join(root, 'project'); await mkdir(workspace);
  const options = { root, home, workspace, expectedSha256: 'a'.repeat(64), chat: 'ollama', model: 'local-model', worker: 'none', clients: [], start: false };
  const calls = [], messages = []; let credentials = {};
  const services = {
    prompts: { ask: async title => { throw new Error(`Unexpected prompt: ${title}`); }, secret: async () => 'private-key-marker', report: text => messages.push(text) },
    verifyDistribution: async () => { calls.push('verify'); return { assets: { platform: `${process.platform}-${process.arch}` } }; }, detectHosts: async () => [], listLocalModels: async () => ['local-model'],
    probeChat: async () => { calls.push('chat'); return { status: 'PASS', evidence: 'fixture' }; },
    readCredentials: async () => ({ ...credentials }), saveCredentials: async ({ values }) => { calls.push('credentials'); credentials = { ...credentials, ...values }; },
    registerClients: async () => { calls.push('clients'); return { status: 'PASS', clients: [] }; },
    setup: async ({ profilePath, onPrepared }) => {
      calls.push('install'); await mkdir(home, { recursive: true, mode: 0o700 });
      await writeFile(join(home, 'setup.json'), JSON.stringify({ schema: 1, kind: 'temari-unified-installation', releaseSha256: options.expectedSha256, profileSha256: digest(await readFile(profilePath)), phase: 'preparing' }), { mode: 0o600 });
      await onPrepared();
      await writeFile(join(home, 'setup.json'), JSON.stringify({ schema: 1, kind: 'temari-unified-installation', releaseSha256: options.expectedSha256, profileSha256: digest(await readFile(profilePath)), phase: 'ready' }), { mode: 0o600 });
      await writeFile(join(home, 'knowledge-mcp.json'), JSON.stringify({ command: '/managed/python', args: ['-I'] }), { mode: 0o600 });
      return { installation: join(home, 'installation'), dashboard: { command: join(home, 'temari') }, knowledge: { mcpReadiness: { connected: true }, sourceId: 'starter' } };
    },
  };
  return { root, home, options, services, calls, messages };
}
test('guided setup generates an immutable profile and replays without asking for JSON', async t => {
  const f = await fixture(t), first = await guidedSetup(f.options, f.services);
  assert.equal(first.phase, 'ready'); assert(first.knowledge.connected);
  const profile = await readFile(join(f.home, 'setup-profile.json'));
  await guidedSetup(f.options, f.services);
  assert.deepEqual(await readFile(join(f.home, 'setup-profile.json')), profile);
  assert.equal(f.calls.filter(call => call === 'install').length, 2);
  await assert.rejects(guidedSetup({ ...f.options, model: 'other' }, f.services), /retry changes/);
});
test('distribution admission precedes authentication or client writes', async t => {
  const f = await fixture(t);
  f.services.verifyDistribution = async () => { throw new Error('manifest refused'); };
  await assert.rejects(guidedSetup(f.options, f.services), /manifest refused/);
  assert.deepEqual(f.calls, []);
});
test('unavailable models and failed chat do not install or register', async t => {
  const f = await fixture(t);
  await assert.rejects(guidedSetup({ ...f.options, model: 'missing' }, f.services), /installed Ollama/);
  f.services.probeChat = async () => { throw new Error('chat failed'); };
  await assert.rejects(guidedSetup(f.options, f.services), /chat failed/);
  assert(!f.calls.includes('install') && !f.calls.includes('clients'));
});
test('native sign-in is checked again and worker identity/model are pinned', async t => {
  const f = await fixture(t); let authenticated = false;
  f.services.inspectHost = async () => ({ compatible: true, authenticated, workerReady: authenticated, executable: '/native/codex', sha256: 'b'.repeat(64), version: 'codex-cli 0.154.0', models: [{ id: 'account-model', reasoningLevels: ['high'], defaultReasoning: 'high' }] });
  f.services.authenticateHost = async () => { f.calls.push('login'); authenticated = true; };
  await guidedSetup({ ...f.options, worker: 'codex', workerExecutable: '/native/codex', workerModel: 'account-model' }, f.services);
  const profile = JSON.parse(await readFile(join(f.home, 'setup-profile.json')));
  assert.equal(profile.control.swarm.providerSelection.model, 'account-model');
  assert.equal(profile.control.swarm.providerSelection.executableSha256, 'b'.repeat(64));
  assert.equal(f.calls.filter(call => call === 'login').length, 1);
  assert.equal(profile.control.implementation, undefined);
});
test('failed authentication and incompatible CLI remain blocked', async t => {
  const f = await fixture(t), options = { ...f.options, worker: 'codex', workerExecutable: '/native/codex', workerModel: 'account-model' };
  f.services.inspectHost = async () => ({ compatible: true, authenticated: false, workerReady: false, models: [] });
  f.services.authenticateHost = async () => {};
  await assert.rejects(guidedSetup(options, f.services), /authentication is unavailable/);
  f.services.inspectHost = async () => ({ compatible: false });
  await assert.rejects(guidedSetup(options, f.services), /version is unsupported/);
  assert(!f.calls.includes('install'));
});
test('private key never appears in generated profiles, receipts or user reports', async t => {
  const f = await fixture(t), result = await guidedSetup({ ...f.options, chat: 'openai-responses', model: 'api-model' }, f.services);
  for (const value of [JSON.stringify(result), JSON.stringify(f.messages), await readFile(join(f.home, 'setup-profile.json'), 'utf8'), await readFile(join(f.home, 'guided-setup.json'), 'utf8')]) assert(!value.includes('private-key-marker'));
  assert(f.calls.indexOf('credentials') > f.calls.indexOf('install'));
});
test('partially completed installation keeps exact choices and can recover', async t => {
  const f = await fixture(t), install = f.services.setup; let failed = false;
  f.services.setup = async args => {
    if (!failed) { failed = true; const callback = args.onPrepared; args.onPrepared = async () => { await callback(); throw new Error('interrupted runtime copy'); }; }
    return install(args);
  };
  await assert.rejects(guidedSetup(f.options, f.services), /interrupted runtime copy/);
  assert.equal(JSON.parse(await readFile(join(f.home, 'guided-setup.json'))).phase, 'installing');
  assert.equal((await guidedSetup(f.options, f.services)).phase, 'ready');
});
test('partial registration stays pending and retry retains completed installation', async t => {
  const f = await fixture(t); let failed = false;
  f.services.registerClients = async () => { if (!failed) { failed = true; throw Object.assign(new Error('registration blocked'), { receipt: { status: 'BLOCKED', clients: [] } }); } return { status: 'PASS', clients: [] }; };
  await assert.rejects(guidedSetup(f.options, f.services), /registration blocked/);
  const pending = JSON.parse(await readFile(join(f.home, 'guided-setup.json')));
  assert.equal(pending.phase, 'registration-blocked'); assert.equal(pending.registration.status, 'BLOCKED');
  assert.equal((await guidedSetup(f.options, f.services)).phase, 'ready');
});
test('explicit Claude backend replaces inherited authentication and retries reject backend changes', async t => {
  const f = await fixture(t), observed = [];
  const original = { key: process.env.ANTHROPIC_API_KEY, token: process.env.ANTHROPIC_AUTH_TOKEN, url: process.env.ANTHROPIC_BASE_URL };
  process.env.ANTHROPIC_API_KEY = 'inherited-cloud-key'; process.env.ANTHROPIC_AUTH_TOKEN = 'inherited-token'; process.env.ANTHROPIC_BASE_URL = 'https://unselected.invalid';
  t.after(() => { for (const [name, value] of [['ANTHROPIC_API_KEY', original.key], ['ANTHROPIC_AUTH_TOKEN', original.token], ['ANTHROPIC_BASE_URL', original.url]]) value === undefined ? delete process.env[name] : process.env[name] = value; });
  f.services.inspectHost = async ({ env }) => { observed.push(env); return { compatible: true, workerReady: true, executable: '/native/claude', sha256: 'c'.repeat(64), version: '2.1.296 (Claude Code)', models: [] }; };
  const options = { ...f.options, worker: 'claude-code', workerExecutable: '/native/claude', workerModel: 'local-model', claudeAuth: 'ollama' };
  await guidedSetup(options, f.services);
  assert.equal(observed[0].ANTHROPIC_API_KEY, ''); assert.equal(observed[0].ANTHROPIC_AUTH_TOKEN, 'ollama'); assert.equal(observed[0].ANTHROPIC_BASE_URL, 'http://127.0.0.1:11434');
  await assert.rejects(guidedSetup({ ...options, workerExecutable: undefined, claudeAuth: 'api-key' }, f.services), /changes worker authentication/);
  const other = await fixture(t); other.services.inspectHost = f.services.inspectHost;
  await guidedSetup({ ...other.options, worker: 'claude-code', workerExecutable: '/native/claude', workerModel: 'cloud-model', claudeAuth: 'api-key' }, other.services);
  assert.equal(observed.at(-1).ANTHROPIC_AUTH_TOKEN, ''); assert.equal(observed.at(-1).ANTHROPIC_BASE_URL, 'https://api.anthropic.com');
});
test('local chat with cloud Claude workers asks for the cloud worker model', async t => {
  const f = await fixture(t), asked = [];
  f.services.prompts.ask = async title => { asked.push(title); return 'sonnet'; };
  f.services.inspectHost = async () => ({ compatible: true, workerReady: true, executable: '/native/claude', sha256: 'c'.repeat(64), version: '2.1.296 (Claude Code)', models: [] });
  await guidedSetup({ ...f.options, worker: 'claude-code', workerExecutable: '/native/claude', claudeAuth: 'api-key' }, f.services);
  const profile = JSON.parse(await readFile(join(f.home, 'setup-profile.json')));
  assert.deepEqual(asked, ['Worker model']); assert.equal(profile.control.swarm.providerSelection.model, 'sonnet'); assert.equal(profile.transport.model, 'local-model');
});
test('chat probe allows reasoning and distinguishes exhausted budgets from authentication', async () => {
  let packet;
  await assert.rejects(probeChat({ kind: 'openai-responses', model: 'reasoning-model' }, { OPENAI_API_KEY: 'secret' }, async (_, request) => {
    packet = JSON.parse(request.body); assert.equal(request.redirect, 'error');
    return new Response(JSON.stringify({ status: 'incomplete', output: [], incomplete_details: { reason: 'max_output_tokens' } }));
  }), /exhausted its token budget/);
  assert.equal(packet.max_output_tokens, 4096);
  await assert.rejects(probeChat({ kind: 'ollama', model: 'thinking-model' }, {}, async (_, request) => {
    packet = JSON.parse(request.body); return new Response(JSON.stringify({ done: true, done_reason: 'length', message: { content: '' } }));
  }), /not an authentication failure/);
  assert.equal(packet.options.num_predict, 1024);
  assert.equal((await probeChat({ kind: 'ollama', model: 'local' }, {}, async () => new Response(JSON.stringify({ message: { content: 'OK' } })))).status, 'PASS');
  await assert.rejects(probeChat({ kind: 'ollama', model: 'local' }, {}, async () => new Response('x'.repeat(1024 * 1024 + 1))), /Chat connection failed/);
});
