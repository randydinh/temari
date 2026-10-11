import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerClients as runRegistration, executeClientCommand } from './clients.mjs';

async function registerClients(options) {
  try { return await runRegistration(options); }
  catch (error) { if (error.receipt) return error.receipt; throw error; }
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'temari-clients-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'), workspaceRoot = join(root, 'workspace'), configHome = join(root, 'config'), marketplaceRoot = join(root, 'marketplace');
  for (const p of [home, workspaceRoot, configHome, join(marketplaceRoot, '.agents', 'plugins')]) await mkdir(p, { recursive: true });
  await writeFile(join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({ name: 'temari-private', plugins: [{ name: 'temari' }] }));
  const connection = { transport: 'stdio', command: '/managed/python', args: ['-I', '-B', 'path with spaces', '--workspace', workspaceRoot] };
  const executable = join(home, 'fixture-client');
  await writeFile(executable, 'fixture client bytes');
  const clients = [{ kind: 'codex', executable, configHome }];
  const calls = [], servers = new Map();
  let marketplace = null, plugin = null;
  const execute = async (spec) => {
    calls.push(spec);
    const a = spec.args;
    const ok = (value) => ({ code: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' });
    if (a[0] === 'mcp' && a[1] === 'get') return servers.has(a[2]) ? ok(servers.get(a[2])) : { code: 1, stdout: '', stderr: `Error: No MCP server named '${a[2]}' found.` };
    if (a[0] === 'mcp' && a[1] === 'add') {
      servers.set(a[2], { enabled: true, disabled_reason: null, transport: { type: 'stdio', command: a[4], args: a.slice(5) }, enabled_tools: null, disabled_tools: null });
      return ok('added');
    }
    if (a[0] === 'plugin' && a[1] === 'marketplace' && a[2] === 'list') return ok({ marketplaces: marketplace ? [marketplace] : [] });
    if (a[0] === 'plugin' && a[1] === 'marketplace' && a[2] === 'add') { marketplace = { name: 'temari-private', root: a[3] }; return ok('added'); }
    if (a[0] === 'plugin' && a[1] === 'list') return ok({ installed: plugin ? [plugin] : [] });
    if (a[0] === 'plugin' && a[1] === 'add') { plugin = { pluginId: 'temari@temari-private', installed: true, enabled: true, version: '0.15.5', source: { source: 'local', path: join(marketplaceRoot, 'plugins', 'temari') } }; return ok('installed'); }
    throw Error('unexpected fixture command');
  };
  return { home, workspaceRoot, configHome, marketplaceRoot, connection, clients, calls, servers, execute,
    setMarketplace: (v) => { marketplace = v; }, setPlugin: (v) => { plugin = v; } };
}

test('Codex registers knowledge and plugin using official CLI commands, then retries without mutations', async (t) => {
  const f = await fixture(t);
  const first = await registerClients(f);
  assert.equal(first.status, 'ready');
  assert.equal(first.clients[0].knowledge, 'registered');
  assert.equal(first.clients[0].plugin, 'installed');
  assert.ok(f.calls.every((c) => c.env.CODEX_HOME === f.configHome && c.cwd === f.workspaceRoot && c.timeoutMs === 30000));
  assert.deepEqual(f.calls.find((c) => c.args[1] === 'add' && c.args[0] === 'mcp').args.slice(3), ['--', f.connection.command, ...f.connection.args]);
  f.calls.length = 0;
  const again = await registerClients(f);
  assert.equal(again.clients[0].knowledge, 'already-registered');
  assert.equal(again.clients[0].plugin, 'already-installed');
  assert.ok(f.calls.every((c) => !c.args.includes('add')));
});

test('Codex refuses conflicting, disabled, or filtered named server without overwriting', async (t) => {
  const f = await fixture(t);
  const name = (await registerClients(f)).serverName;
  for (const change of [
    { transport: { type: 'stdio', command: '/different', args: [] } },
    { enabled: false }, { enabled_tools: ['one'] },
    { transport: { type: 'stdio', command: f.connection.command, args: f.connection.args, env: { TOKEN: 'never-retain' } } },
  ]) {
    f.servers.set(name, { enabled: true, transport: { type: 'stdio', command: f.connection.command, args: f.connection.args }, ...change });
    f.calls.length = 0;
    const result = await registerClients(f);
    assert.equal(result.clients[0].error, 'knowledge-conflict');
    assert.equal(f.calls.length, 1);
    assert.ok(!JSON.stringify(result).includes('never-retain'));
  }
});

test('inspection failure is not mistaken for absence and raw errors are not retained', async (t) => {
  const f = await fixture(t);
  const result = await registerClients({ ...f, execute: async () => ({ code: 1, stdout: 'secret-credential', stderr: 'secret-credential' }) });
  assert.equal(result.clients[0].error, 'client-inspection-failed');
  assert.ok(!JSON.stringify(result).includes('secret-credential'));
});

test('marketplace collision refuses plugin mutation and retry preserves successful knowledge registration', async (t) => {
  const f = await fixture(t);
  f.setMarketplace({ name: 'temari-private', root: '/unrelated' });
  const result = await registerClients(f);
  assert.equal(result.status, 'blocked');
  assert.equal(result.clients[0].knowledge, 'registered');
  assert.equal(result.clients[0].error, 'marketplace-conflict');
  assert.ok(!f.calls.some((c) => c.args[0] === 'plugin' && c.args.includes('add')));
  f.setMarketplace(null);
  f.calls.length = 0;
  const retry = await registerClients(f);
  assert.equal(retry.status, 'ready');
  assert.equal(retry.clients[0].knowledge, 'already-registered');
});

test('disabled or different version plugin is not silently replaced', async (t) => {
  const f = await fixture(t);
  f.setPlugin({ pluginId: 'temari@temari-private', installed: true, enabled: false, version: '0.15.5' });
  const result = await registerClients(f);
  assert.equal(result.clients[0].error, 'plugin-conflict');
  assert.ok(!f.calls.some((c) => c.args[0] === 'plugin' && c.args[1] === 'add'));
});

test('independently verified identical release at another root is reused without changing the marketplace', async (t) => {
  const f = await fixture(t);
  const existingRoot = join(f.home, 'previous-marketplace');
  const proof = { releaseSha256: 'a'.repeat(64), publicManifestSha256: 'b'.repeat(64), privateData: 'never-retain' };
  f.setMarketplace({ name: 'temari-private', root: existingRoot, marketplaceSource: { sourceType: 'local', source: existingRoot } });
  f.setPlugin({ pluginId: 'temari@temari-private', installed: true, enabled: true, version: '0.15.5', source: { source: 'local', path: join(existingRoot, 'plugins', 'temari') } });
  let observedRoot;
  const result = await registerClients({ ...f, verifyExistingMarketplace: async (root) => { observedRoot = root; return proof; } });
  assert.equal(result.status, 'ready');
  assert.equal(observedRoot, existingRoot);
  assert.equal(result.clients[0].plugin, 'already-installed');
  assert.deepEqual(result.clients[0].marketplace, { status: 'already-registered-verified-other-root', root: existingRoot, releaseSha256: proof.releaseSha256, publicManifestSha256: proof.publicManifestSha256 });
  assert.ok(!JSON.stringify(result).includes('never-retain'));
  assert.ok(!f.calls.some((c) => c.args[0] === 'plugin' && c.args.includes('add')));
});

test('other root with altered bytes or invalid proof remains a conflict without retaining verifier errors', async (t) => {
  const f = await fixture(t);
  f.setMarketplace({ name: 'temari-private', root: '/existing-other-root' });
  for (const verifier of [async () => { throw Error('altered bytes private-source'); }, async () => true, async () => ({ releaseSha256: 'bad', publicManifestSha256: 'bad' })]) {
    f.calls.length = 0;
    const result = await registerClients({ ...f, verifyExistingMarketplace: verifier });
    assert.equal(result.clients[0].error, 'marketplace-conflict');
    assert.ok(!JSON.stringify(result).includes('private-source'));
    assert.ok(!f.calls.some((c) => c.args[0] === 'plugin' && c.args.includes('add')));
  }
});

test('Claude user registration preserves unrelated config and supports exact spaced arguments on retry', async (t) => {
  const f = await fixture(t);
  f.clients = [{ kind: 'claude-code', executable: f.clients[0].executable, configHome: f.configHome }];
  const file = join(f.configHome, '.claude.json');
  await writeFile(file, JSON.stringify({ unrelated: 'unchanged', mcpServers: { unrelated: { type: 'stdio', command: '/other', args: [] } } }));
  f.execute = async (spec) => {
    f.calls.push(spec);
    assert.equal(spec.env.CLAUDE_CONFIG_DIR, f.configHome);
    if (spec.args[1] === 'add-json') {
      const config = JSON.parse(await readFile(file, 'utf8'));
      config.mcpServers[spec.args[2]] = JSON.parse(spec.args[3]);
      assert.deepEqual(spec.args.slice(4), ['--scope', 'user']);
      await writeFile(file, JSON.stringify(config));
    }
    return { code: 0, stdout: 'native response containing secret-not-retained', stderr: '' };
  };
  const result = await registerClients(f);
  assert.equal(result.status, 'ready');
  assert.equal(result.clients[0].plugin, 'not-supported');
  assert.equal(JSON.parse(await readFile(file, 'utf8')).unrelated, 'unchanged');
  assert.ok(!JSON.stringify(result).includes('secret-not-retained'));
  f.calls.length = 0;
  assert.equal((await registerClients(f)).clients[0].knowledge, 'already-registered');
  assert.equal(f.calls.length, 1);
  const config = JSON.parse(await readFile(file, 'utf8'));
  const name = result.serverName;
  config.mcpServers[name].args = ['-I', '-B', 'path', 'with', 'spaces', '--workspace', f.workspaceRoot];
  await writeFile(file, JSON.stringify(config));
  f.calls.length = 0;
  assert.equal((await registerClients(f)).clients[0].error, 'knowledge-conflict');
  assert.equal(f.calls.length, 0);
});

test('Claude refuses project shadowing before get can health-check an unrelated server', async (t) => {
  const f = await fixture(t);
  const name = (await registerClients(f)).serverName;
  f.clients = [{ kind: 'claude-code', executable: f.clients[0].executable, configHome: f.configHome }];
  await writeFile(join(f.workspaceRoot, '.mcp.json'), JSON.stringify({ mcpServers: { [name]: { command: '/unrelated' } } }));
  f.calls.length = 0;
  const result = await registerClients(f);
  assert.equal(result.clients[0].error, 'knowledge-shadowed');
  assert.equal(f.calls.length, 0);
});

test('Claude named workspace disable is refused before registration and after successful get', async (t) => {
  const f = await fixture(t);
  const name = (await registerClients(f)).serverName;
  f.clients = [{ kind: 'claude-code', executable: f.clients[0].executable, configHome: f.configHome }];
  const file = join(f.configHome, '.claude.json');
  const entry = { type: 'stdio', command: f.connection.command, args: f.connection.args };
  const config = { mcpServers: { [name]: entry }, projects: { [f.workspaceRoot]: { disabledMcpServers: [name] } } };
  await writeFile(file, JSON.stringify(config));
  f.calls.length = 0;
  assert.equal((await registerClients(f)).clients[0].error, 'knowledge-disabled');
  assert.equal(f.calls.length, 0);
  config.projects[f.workspaceRoot].disabledMcpServers = [];
  await writeFile(file, JSON.stringify(config));
  f.execute = async (spec) => {
    f.calls.push(spec);
    config.projects[f.workspaceRoot].disabledMcpServers = [name];
    await writeFile(file, JSON.stringify(config));
    return { code: 0, stdout: 'get success does not prove enablement', stderr: '' };
  };
  assert.equal((await registerClients(f)).clients[0].error, 'knowledge-disabled');
  assert.equal(f.calls.length, 1);
});

test('Claude named workspace disable after add-json blocks readiness despite successful mutation', async (t) => {
  const f = await fixture(t);
  const name = (await registerClients(f)).serverName;
  f.clients = [{ kind: 'claude-code', executable: f.clients[0].executable, configHome: f.configHome }];
  const file = join(f.configHome, '.claude.json');
  f.calls.length = 0;
  f.execute = async (spec) => {
    f.calls.push(spec);
    await writeFile(file, JSON.stringify({ mcpServers: { [name]: JSON.parse(spec.args[3]) }, projects: { [f.workspaceRoot]: { disabledMcpServers: [name] } } }));
    return { code: 0, stdout: 'added', stderr: '' };
  };
  assert.equal((await registerClients(f)).clients[0].error, 'knowledge-disabled');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].args[1], 'add-json');
});

test('binary drift refuses invocation and malformed or credential-bearing connection is rejected', async (t) => {
  const f = await fixture(t);
  const executable = join(f.home, 'client');
  await writeFile(executable, 'changed binary');
  f.clients[0].executable = executable;
  f.clients[0].executableSha256 = '0'.repeat(64);
  const result = await registerClients(f);
  assert.equal(result.clients[0].error, 'client-drift');
  assert.equal(f.calls.length, 0);
  await assert.rejects(registerClients({ ...f, connection: { ...f.connection, env: { TOKEN: 'never-retain' } } }), /without embedded credentials/);
});

test('binary changes between commands stop further mutations, and blocked registration throws its safe receipt', async (t) => {
  const f = await fixture(t);
  const execute = f.execute;
  f.execute = async (spec) => {
    const result = await execute(spec);
    await writeFile(f.clients[0].executable, 'updated client bytes');
    return result;
  };
  await assert.rejects(runRegistration(f), (error) => {
    assert.equal(error.code, 'registration-blocked');
    assert.equal(error.receipt.clients[0].error, 'client-drift');
    assert.equal(f.calls.length, 1);
    return true;
  });
});

test('unsupported plugin CLI leaves knowledge registered and reports an actionable partial failure', async (t) => {
  const f = await fixture(t);
  const execute = f.execute;
  f.execute = (spec) => spec.args[0] === 'plugin'
    ? Promise.resolve({ code: 2, stdout: '', stderr: 'unsupported command and private-secret' }) : execute(spec);
  const result = await registerClients(f);
  assert.equal(result.clients[0].knowledge, 'registered');
  assert.equal(result.clients[0].error, 'client-plugin-inspection-failed');
  assert.ok(!JSON.stringify(result).includes('private-secret'));
});

test('default command runner bounds output and time without returning partial stdout in receipt', async () => {
  const cwd = tmpdir(), env = { ...process.env };
  const large = await executeClientCommand({ executable: process.execPath, args: ['-e', 'process.stdout.write("x".repeat(10000))'], cwd, env, maxOutputBytes: 100 });
  assert.equal(large.truncated, true);
  const slow = await executeClientCommand({ executable: process.execPath, args: ['-e', 'setTimeout(()=>{},10000)'], cwd, env, timeoutMs: 40 });
  assert.equal(slow.timedOut, true);
});
