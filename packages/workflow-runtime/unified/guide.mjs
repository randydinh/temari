import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rename, rm, lstat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { promisify, isDeepStrictEqual } from 'node:util';
import { digest, verifyDistribution } from './inventory.mjs';
import { detectHosts, inspectHost, authenticateHost, listLocalModels, saveCredentials, readCredentials } from './hosts.mjs';
import { registerClients } from './clients.mjs';

const execute = promisify(execFile);
const json = value => `${JSON.stringify(value, null, 2)}\n`;
async function optional(path) {
  try { const stat = await lstat(path); assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, 'Guided setup state must be a regular private file.'); return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function atomic(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, json(value), { mode: 0o600, flag: 'wx' });
  try { await rename(temporary, path); } finally { await rm(temporary, { force: true }); }
}

export function terminalQuestions(input = process.stdin, output = process.stderr) {
  return {
    async ask(title, choices = [], fallback = '') {
      assert(input.isTTY, 'Use explicit guide options in a non-interactive terminal.');
      const reader = createInterface({ input, output });
      try {
        if (choices.length) output.write(`${choices.map((item, i) => `  ${i + 1}. ${item}`).join('\n')}\n`);
        const answer = (await reader.question(`${title}${fallback ? ` [${fallback}]` : ''}: `)).trim() || fallback;
        if (choices.length && /^[0-9]+$/.test(answer)) return choices[Number(answer) - 1] ?? '';
        return answer;
      } finally { reader.close(); }
    },
    async secret(title) {
      assert(input.isTTY && input.setRawMode, 'Set the credential in the process environment or use an interactive terminal.');
      output.write(`${title} (hidden; saved privately in this installation): `);
      const prior = input.isRaw;
      input.setRawMode(true); input.resume();
      try {
        return await new Promise((accept, reject) => {
          let value = '';
          const done = (error) => { input.off('data', onData); input.off('end', onEnd); error ? reject(error) : accept(value); };
          const onEnd = () => done(new Error('Credential input ended.'));
          const onData = chunk => {
            for (const character of chunk.toString('utf8')) {
              if (character === '\u0003' || character === '\u0004') return done(new Error('Guided setup cancelled.'));
              if (character === '\r' || character === '\n') return done();
              if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
              else if (character >= ' ' && value.length < 4096) value += character;
            }
          };
          input.on('data', onData); input.once('end', onEnd);
        });
      } finally { input.setRawMode(prior); input.pause(); output.write('\n'); }
    },
    report(message) { output.write(`${message}\n`); },
  };
}

export function generatedProfile(selection, worker, git) {
  const control = { schema: 1, workspaceRoot: selection.workspaceRoot, preparationRoot: join(selection.home, 'prepared'), recipes: [] };
  if (git) {
    const stages = {
      investigate: ['rev-parse', '--show-toplevel'], plan: ['rev-parse', '--verify', 'HEAD'],
      build: ['diff', '--exit-code', 'HEAD', '--'], review: ['diff', '--check', 'HEAD', '--'],
      verify: ['status', '--porcelain=v1', '--untracked-files=all'], deliver: ['log', '-1', '--format=%H'],
    };
    control.recipes.push({ id: 'check-clean-checkout', title: 'Verify the selected checkout', goal: 'Retain the selected Git revision and confirm its clean checkout remains unchanged during these checks.', stages: Object.fromEntries(Object.entries(stages).map(([stage, args]) => [stage, { executable: git, args, timeoutMs: 10000, summary: `Recorded the ${stage} checkout check.` }])) });
  }
  if (worker) control.swarm = { executable: worker.executable, providerSelection: worker.providerSelection, maxConcurrency: 2, maxWorkers: 4, timeoutMs: 180000 };
  return { schema: 1, id: selection.id, workspaceRoot: selection.workspaceRoot, port: selection.port, transport: selection.transport, control };
}

class ProbeRefusal extends Error {}
export async function probeChat(transport, credentials, send = fetch) {
  const request = transport.kind === 'ollama'
    ? { url: `${transport.baseUrl ?? 'http://127.0.0.1:11434'}/api/chat`, body: { model: transport.model, stream: false, messages: [{ role: 'user', content: 'Reply with OK.' }], options: { num_predict: 1024 } }, headers: {} }
    : { url: 'https://api.openai.com/v1/responses', body: { model: transport.model, input: 'Reply with OK.', max_output_tokens: 4096, store: false }, headers: { Authorization: `Bearer ${credentials.OPENAI_API_KEY}` } };
  try {
    const response = await send(request.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...request.headers }, body: JSON.stringify(request.body), signal: AbortSignal.timeout(90000), redirect: 'error' });
    assert(response.ok, 'Selected chat model rejected the connection. Check the selected model and authentication, then rerun guide.');
    assert(Number(response.headers.get('content-length') ?? 0) <= 1024 * 1024, 'Chat probe exceeds its response bound.');
    const reader = response.body?.getReader(); assert(reader, 'Chat probe returned no body.');
    let bytes = 0; const chunks = [];
    try { while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.length; assert(bytes <= 1024 * 1024, 'Chat probe exceeds its response bound.'); chunks.push(part.value); } }
    finally { await reader.cancel().catch(() => {}); }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body.incomplete_details?.reason === 'max_output_tokens' || body.done_reason === 'length') throw new ProbeRefusal('Chat service responded, but the test exhausted its token budget before completing. Select a faster model and retry; this is not an authentication failure.');
    const text = transport.kind === 'ollama' ? body.message?.content : body.output?.flatMap(item => item.content ?? []).filter(item => item.type === 'output_text').map(item => item.text).join('');
    assert(typeof text === 'string' && text.trim(), 'Selected chat model returned no answer. Select a working model and rerun guide.');
    return { status: 'PASS', model: transport.model, evidence: 'live harmless chat probe; no product sources transmitted' };
  } catch (error) { if (error instanceof ProbeRefusal) throw error; throw new Error('Chat connection failed. Check the selected model, service and authentication, then rerun guide.'); }
}

/** Native login remains with the host; installation receipts contain selections only. */
export async function guidedSetup(options, dependencies = {}) {
  const { root, expectedSha256, start = true } = options;
  const prompts = dependencies.prompts ?? terminalQuestions();
  const services = { verifyDistribution, detectHosts, inspectHost, authenticateHost, listLocalModels, saveCredentials, readCredentials, registerClients, probeChat, ...dependencies };
  const manifest = await services.verifyDistribution(root, expectedSha256);
  assert(process.platform !== 'win32', 'Native Windows knowledge is pending verification; use the Linux distribution inside WSL2.');
  assert.equal(manifest.assets.platform, `${process.platform}-${process.arch}`, 'Select the distribution for this native platform.');
  const home = resolve(options.home ?? await prompts.ask('Installation data directory', [], join(process.env.HOME ?? tmpdir(), '.temari-unified')));
  const prior = await optional(join(home, 'guided-setup.json'));
  const priorSetup = await optional(join(home, 'setup.json'));
  if (prior) assert(priorSetup && prior.schema === 1 && prior.releaseSha256 === expectedSha256 && prior.selection?.home === home && prior.profileSha256 === priorSetup.profileSha256, 'Guided setup state does not match the selected installation.');
  if (priorSetup) assert.equal(priorSetup.releaseSha256, expectedSha256, 'This installation belongs to another release. Select a new home.');
  if (priorSetup && !prior) throw new Error('Existing scripted installation has no guided selection. Select a new home for the guided journey.');
  const detected = await services.detectHosts();
  let selection = prior?.selection, worker, credentials = {};
  if (selection) {
    for (const [option, selected] of [['workspace', selection.workspaceRoot], ['id', selection.id], ['chat', selection.transport.kind], ['model', selection.transport.model], ['worker', selection.worker?.kind ?? 'none'], ['workerModel', selection.worker?.model], ['workerExecutable', selection.worker?.executable], ['workerReasoning', selection.worker?.reasoning], ['port', selection.port], ['ollamaUrl', selection.transport.baseUrl]]) {
      if (options[option] !== undefined) {
        const value = ['workspace', 'workerExecutable'].includes(option) ? await realpath(options[option]) : option === 'ollamaUrl' ? new URL(options[option]).origin : options[option];
        assert.equal(value, selected, 'Guided retry changes the installation selection. Select a new home.');
      }
    }
    if (options.clients !== undefined) assert.deepEqual(options.clients, selection.clients.map(client => client.kind), 'Guided retry changes selected clients.');
    if (options.claudeAuth !== undefined) assert.equal(options.claudeAuth, selection.worker?.authMode, 'Guided retry changes worker authentication. Select a new home.');
    for (const client of selection.clients) {
      const override = options[`${client.kind === 'codex' ? 'codex' : 'claude'}Executable`];
      if (override !== undefined) assert.equal(await realpath(override), client.executable, 'Guided retry changes the selected client.');
      if (options.clientHomes?.[client.kind] !== undefined) assert.equal(options.clientHomes[client.kind], client.configHome, 'Guided retry changes the client configuration home.');
    }
    credentials = priorSetup.phase === 'ready' ? await services.readCredentials({ home }) : {};
    prompts.report('Resuming the saved setup choices.');
  } else {
    assert(!priorSetup, 'Setup selection is missing.');
    const workspaceRoot = await realpath(resolve(options.workspace ?? await prompts.ask('Project directory', [], process.cwd())));
    assert((await lstat(workspaceRoot)).isDirectory(), 'Select a project directory.');
    const id = options.id ?? 'temari';
    assert.match(id, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u, 'Use a short installation name.');
    const chat = options.chat ?? await prompts.ask('Temari chat connection', ['ollama', 'openai-responses'], 'ollama');
    let transport;
    if (chat === 'ollama') {
      const requestedUrl = options.ollamaUrl ?? 'http://127.0.0.1:11434';
      const models = await services.listLocalModels({ baseUrl: requestedUrl });
      const baseUrl = new URL(requestedUrl).origin;
      assert(models.length, 'Ollama has no models. Install a model with Ollama and rerun guide.');
      const ids = models.map(model => typeof model === 'string' ? model : model.id ?? model.name);
      const model = options.model ?? await prompts.ask('Chat model', ids, ids[0]);
      assert(ids.includes(model), 'Select an installed Ollama chat model.');
      transport = { kind: chat, model, baseUrl };
    } else {
      assert.equal(chat, 'openai-responses', 'Select ollama or openai-responses for guided chat.');
      credentials.OPENAI_API_KEY = process.env.OPENAI_API_KEY || await prompts.secret('OpenAI API key');
      assert(credentials.OPENAI_API_KEY, 'An OpenAI API key is required for this chat connection.');
      const model = options.model ?? await prompts.ask('OpenAI API model');
      assert(model, 'Select an OpenAI API model.');
      transport = { kind: chat, model, credentialEnv: 'OPENAI_API_KEY' };
    }
    const kind = options.worker ?? await prompts.ask('Engineering worker host', ['codex', 'claude-code', 'none'], detected.find(host => host.kind === 'codex') ? 'codex' : 'none');
    assert(['codex', 'claude-code', 'none'].includes(kind), 'Unknown engineering host.');
    const executable = kind === 'none' ? null : options.workerExecutable ?? detected.find(host => host.kind === kind)?.executable ?? await prompts.ask(`${kind} executable (absolute path)`);
    selection = { schema: 1, home, workspaceRoot, id, port: options.port ?? 3095, transport, worker: kind === 'none' ? null : { kind, executable }, clients: [] };
    assert(Number.isInteger(selection.port) && selection.port >= 0 && selection.port <= 65535, 'Select a valid port.');
  }
  if (selection.transport.kind === 'openai-responses' && !credentials.OPENAI_API_KEY) {
    credentials.OPENAI_API_KEY = process.env.OPENAI_API_KEY || await prompts.secret('OpenAI API key');
    assert(credentials.OPENAI_API_KEY, 'An OpenAI API key is required for this chat connection.');
  }
  if (selection.worker) {
    const selected = selection.worker;
    if (selected.kind === 'claude-code') {
      selected.authMode ??= options.claudeAuth ?? await prompts.ask('Claude scoped workers use API credentials or local Ollama', ['api-key', 'ollama'], selection.transport.kind === 'ollama' ? 'ollama' : 'api-key');
        if (selected.authMode === 'ollama') {
          assert.equal(selection.transport.kind, 'ollama', 'Select Ollama for chat to reuse its local connection.');
          credentials.ANTHROPIC_API_KEY = ''; credentials.ANTHROPIC_AUTH_TOKEN = 'ollama'; credentials.ANTHROPIC_BASE_URL = selection.transport.baseUrl;
        } else {
          assert.equal(selected.authMode, 'api-key', 'Select api-key or ollama for scoped Claude authentication.');
          credentials.ANTHROPIC_API_KEY ||= process.env.ANTHROPIC_API_KEY || await prompts.secret('Anthropic API key for scoped workers');
          credentials.ANTHROPIC_AUTH_TOKEN = ''; credentials.ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
          assert(credentials.ANTHROPIC_API_KEY, 'An Anthropic API key is required for scoped workers.');
        }
    }
    let host = await services.inspectHost({ ...selected, env: { ...process.env, ...credentials } });
    assert(host.compatible, `Selected ${selected.kind} version is unsupported. Install a supported CLI and rerun guide.`);
    if (selected.kind === 'codex' && !host.authenticated) {
      prompts.report('Complete Codex sign-in in the native login flow. Temari does not copy its credentials.');
      await services.authenticateHost({ ...selected, method: options.deviceAuth ? 'device' : 'browser' });
      host = await services.inspectHost({ ...selected, env: { ...process.env, ...credentials } });
    }
    assert(host.workerReady, `Selected ${selected.kind} authentication is unavailable. Complete authentication and rerun guide.`);
    const modelIds = host.models.map(model => model.id);
    selected.model ??= options.workerModel ?? (selected.kind === 'claude-code' && selected.authMode === 'ollama' ? selection.transport.model : await prompts.ask('Worker model', modelIds, modelIds[0] ?? ''));
    assert(typeof selected.model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(selected.model), 'Select a worker model.');
    if (selected.kind === 'codex') {
      const model = host.models.find(item => item.id === selected.model);
      assert(model, 'Selected worker model is unavailable to this Codex CLI account.');
      selected.reasoning ??= options.workerReasoning ?? model.defaultReasoning ?? 'medium';
      if (model.reasoningLevels.length) assert(model.reasoningLevels.includes(selected.reasoning), 'Selected reasoning is unavailable for this worker model.');
    }
    if (prior) { assert.equal(host.sha256, selected.sha256, 'Worker executable changed. Select a new installation home.'); assert.equal(host.version, selected.version, 'Worker version changed. Select a new installation home.'); }
    selected.executable = host.executable; selected.sha256 = host.sha256; selected.version = host.version;
    const providerSelection = { provider: selected.kind, executableSha256: host.sha256, executableVersion: host.version, model: selected.model, ...(selected.kind === 'codex' ? { reasoning: selected.reasoning } : { policy: 'temari-scoped-tools-v1', maxTurns: 32, maxBudgetUsd: 5 }) };
    worker = { executable: host.executable, providerSelection };
  }
  if (!prior) {
    const choices = options.clients ?? (selection.worker ? [selection.worker.kind] : []);
    for (const kind of choices) {
      assert(['codex', 'claude-code'].includes(kind), 'Unknown client registration.');
      const executable = options[`${kind === 'codex' ? 'codex' : 'claude'}Executable`] ?? (selection.worker?.kind === kind ? selection.worker.executable : detected.find(host => host.kind === kind)?.executable);
      assert(executable && isAbsolute(executable), `Install ${kind} or select its absolute executable to register that client.`);
      selection.clients.push({ kind, executable, ...(options.clientHomes?.[kind] ? { configHome: options.clientHomes[kind] } : {}) });
    }
  }
  for (const client of selection.clients) {
    client.executable = await realpath(client.executable);
    const pin = digest(await readFile(client.executable));
    if (client.executableSha256) assert.equal(pin, client.executableSha256, 'Registered client executable changed. Select a new installation home.');
    client.executableSha256 = pin;
  }
  prompts.report('Checking the chat connection with a harmless test message.');
  const chat = await services.probeChat(selection.transport, credentials);
  let git = detected.find(host => host.kind === 'git')?.executable;
  if (git) {
    try { await execute(git, ['rev-parse', '--verify', 'HEAD'], { cwd: selection.workspaceRoot, timeout: 10000 }); }
    catch { git = undefined; }
  }
  let profile = generatedProfile(selection, worker, git);
  if (prior) {
    const saved = await optional(join(home, 'setup-profile.json'));
    assert(saved && digest(Buffer.from(json(saved))) === prior.profileSha256, 'Saved guided profile changed.');
    // Setup materializes Claude server pins into its own profile; original choices stay immutable.
    assert(isDeepStrictEqual(profile, saved), 'Generated profile differs from the saved setup. Select a new home.');
    profile = saved;
  }
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'temari-guide-')));
  try {
    const profilePath = join(temporary, 'profile.json');
    await writeFile(profilePath, json(profile), { mode: 0o600, flag: 'wx' });
    const install = services.setup ?? (await import('./setup.mjs')).setup;
    prompts.report('Installing the managed runtimes, Archon, dashboard and starter library.');
    const state = { schema: 1, releaseSha256: expectedSha256, profileSha256: digest(Buffer.from(json(profile))), selection, phase: 'installing', chat, worker: worker ? { status: 'authenticated-and-pinned', provider: selection.worker.kind, model: selection.worker.model, liveWorkerVerified: false } : { status: 'not-selected' } };
    const installed = await install({ root, expectedSha256, home, profilePath, start: false, onPrepared: async () => {
      await atomic(join(home, 'setup-profile.json'), profile);
      await atomic(join(home, 'guided-setup.json'), state);
    } });
    await services.saveCredentials({ home, values: credentials });
    await atomic(join(home, 'setup-profile.json'), profile);
    state.phase = 'registering';
    await atomic(join(home, 'guided-setup.json'), state);
    const connection = await optional(join(home, 'knowledge-mcp.json'));
    assert(connection, 'Installed knowledge connection is missing.');
    let registration;
    const marketplaceRoot = join(installed.installation, 'marketplace');
    const verifyExistingMarketplace = async existingRoot => {
      const { pathToFileURL } = await import('node:url');
      const verifier = await import(pathToFileURL(join(marketplaceRoot, 'temari-release-verify.mjs')).href);
      await verifier.checkTemariReleaseRoot(existingRoot, manifest.marketplace.releaseSha256, manifest.marketplace.publicManifestSha256);
      return { releaseSha256: manifest.marketplace.releaseSha256, publicManifestSha256: manifest.marketplace.publicManifestSha256 };
    };
    try { registration = await services.registerClients({ home, workspaceRoot: selection.workspaceRoot, clients: selection.clients, connection, marketplaceRoot, verifyExistingMarketplace }); }
    catch (error) { state.phase = 'registration-blocked'; if (error.receipt) state.registration = error.receipt; await atomic(join(home, 'guided-setup.json'), state); throw error; }
    state.phase = 'ready'; state.registration = registration; state.knowledge = { status: 'PASS', connected: installed.knowledge.mcpReadiness.connected, sourceId: installed.knowledge.sourceId };
    if (start) {
      const launch = dependencies.start ?? (async () => JSON.parse((await execute(installed.dashboard.command, ['start'], { timeout: 120000, maxBuffer: 1024 * 1024 })).stdout));
      state.dashboard = await launch(installed);
    }
    await atomic(join(home, 'guided-setup.json'), state);
    prompts.report('Temari is configured. Read-only workers and checkout verification are available for a Git project. Coding plans still require explicit project scopes and checks.');
    return { schema: 1, phase: state.phase, home, chat, worker: state.worker, knowledge: state.knowledge, registration, dashboard: state.dashboard ?? { command: installed.dashboard.command, started: false } };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
