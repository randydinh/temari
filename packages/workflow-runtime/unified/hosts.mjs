import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdtemp, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const credentialKeys = new Set(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']);
const limit = 1024 * 1024;
function checkKind(kind) { assert(['codex', 'claude-code'].includes(kind), 'Select Codex or Claude Code.'); }
function hostEnvironment(kind, configHome, env) {
  const result = { ...env };
  if (configHome) {
    assert(isAbsolute(configHome), 'Host configuration home must be absolute.');
    result[kind === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'] = configHome;
  }
  return result;
}
async function canonicalExecutable(executable) {
  assert(isAbsolute(executable ?? ''), 'Host executable must be absolute.');
  const path = await realpath(executable);
  assert((await lstat(path)).isFile(), 'Host executable must be a regular file.');
  await access(path, constants.X_OK);
  return path;
}
async function command(executable, args, env) {
  try {
    const result = await execute(executable, args, { env, timeout: 15000, maxBuffer: 65536 });
    return { ok: true, output: `${result.stdout}\n${result.stderr}` };
  } catch { return { ok: false, output: '' }; }
}

export async function detectHosts({ env = process.env } = {}) {
  const found = [];
  for (const [kind, name] of [['codex', 'codex'], ['claude-code', 'claude'], ['git', 'git']]) {
    for (const directory of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
      try {
        const executable = await canonicalExecutable(resolve(directory, name));
        found.push({ kind, executable });
        break;
      } catch { /* Continue to the next PATH entry. */ }
    }
  }
  return found;
}

function codexModels(rows, cached = false) {
  if (!Array.isArray(rows) || rows.length > 500) throw new Error('Host model list is invalid.');
  const models = rows.filter((model) => !model.hidden && model.visibility !== 'hide').map((model) => {
    const id = cached ? model.slug : (model.model ?? model.id);
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(id)) throw new Error('Host model identifier is invalid.');
    const levels = cached ? model.supported_reasoning_levels : model.supportedReasoningEfforts;
    const reasoningLevels = (Array.isArray(levels) ? levels : []).map((item) => cached ? item.effort : item.reasoningEffort ?? item.effort).filter((effort) => ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort));
    const suggested = cached ? model.default_reasoning_level : model.defaultReasoningEffort;
    return { id, name: id, reasoningLevels, defaultReasoning: reasoningLevels.includes(suggested) ? suggested : reasoningLevels[0] ?? null };
  });
  return [...new Map(models.map((model) => [model.id, model])).values()];
}

async function cachedModels(configHome, version) {
  const path = join(configHome, 'models_cache.json');
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) return { status: 'invalid', path };
    const bytes = await readFile(path), catalog = JSON.parse(bytes);
    const age = Date.now() - Date.parse(catalog.fetched_at);
    if (!Number.isFinite(age) || age < -60000 || age > 86400000) return { status: 'stale', path };
    if (`codex-cli ${catalog.client_version}` !== version) return { status: 'version-mismatch', path };
    return { status: 'ready', path, sha256: sha(bytes), fetchedAt: catalog.fetched_at, clientVersion: catalog.client_version, models: codexModels(catalog.models, true) };
  } catch { return { status: 'unavailable', path }; }
}

// Only initialize and model/list are sent. No thread, prompt, source, or credentials
// are copied into protocol metadata; native status/error output is never returned.
export async function listCodexModels({ executable, configHome, env = process.env, timeoutMs = 15000 }) {
  executable = await canonicalExecutable(executable);
  assert(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60000, 'Model discovery timeout is invalid.');
  const scratch = await mkdtemp(join(tmpdir(), 'temari-model-discovery-'));
  let child;
  try {
    return await new Promise((resolveResult, reject) => {
      child = spawn(executable, ['app-server'], { cwd: scratch, env: hostEnvironment('codex', configHome, env), stdio: ['pipe', 'pipe', 'ignore'], detached: process.platform !== 'win32' });
      let buffer = '', bytes = 0, complete = false, pending = 0, models = [];
      const stop = () => {
        try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM'); } catch { /* Already stopped. */ }
      };
      const finish = (error) => {
        if (complete) return;
        complete = true; clearTimeout(timer); stop();
        if (error) reject(new Error('Unable to discover account models through the selected Codex CLI. Sign in or retry.'));
        else resolveResult(models);
      };
      const send = (value) => { if (!complete && !child.stdin.destroyed) child.stdin.write(`${JSON.stringify(value)}\n`); };
      const timer = setTimeout(() => finish(true), timeoutMs);
      child.on('error', () => finish(true));
      child.on('close', () => finish(true));
      child.stdin.on('error', () => finish(true));
      child.stdout.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > limit) return finish(true);
        buffer += chunk.toString('utf8');
        while (buffer.includes('\n') && !complete) {
          const boundary = buffer.indexOf('\n'), line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
          let message;
          try { message = JSON.parse(line); } catch { return finish(true); }
          if (message.method && message.id !== undefined) return finish(true);
          if (message.id !== pending) continue;
          if (message.error || !message.result) return finish(true);
          if (pending === 0) {
            send({ method: 'initialized', params: {} }); pending = 1;
            send({ id: pending, method: 'model/list', params: { limit: 100, includeHidden: false } });
          } else {
            try { models.push(...codexModels(message.result.data)); } catch { return finish(true); }
            if (models.length > 500) return finish(true);
            const cursor = message.result.nextCursor;
            if (cursor) {
              if (typeof cursor !== 'string' || cursor.length > 4096 || pending >= 5) return finish(true);
              pending += 1; send({ id: pending, method: 'model/list', params: { limit: 100, includeHidden: false, cursor } });
            } else finish(false);
          }
        }
      });
      send({ id: 0, method: 'initialize', params: { clientInfo: { name: 'temari_setup', title: 'Temari Setup', version: '1.0.0' } } });
    });
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise((done) => {
        const timer = setTimeout(() => {
          try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* Already stopped. */ }
          done();
        }, 1000);
        child.once('close', () => { clearTimeout(timer); done(); });
      });
    }
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function inspectHost({ kind, executable, configHome, env = process.env, discoverModels = true }) {
  checkKind(kind);
  executable = await canonicalExecutable(executable);
  const selectedEnv = hostEnvironment(kind, configHome, env);
  const observation = await command(executable, ['--version'], selectedEnv);
  const pattern = kind === 'codex' ? /codex-cli \d+\.\d+\.\d+(?:-alpha\.\d+)?/u : /\d+\.\d+\.\d+ \(Claude Code\)/u;
  const version = observation.ok ? observation.output.match(pattern)?.[0] ?? null : null;
  const result = { kind, executable, version, sha256: sha(await readFile(executable)), compatible: false, authenticated: false, workerReady: false, authentication: { status: 'required', method: null }, models: [] };
  if (kind === 'codex') {
    result.compatible = Boolean(version);
    const status = await command(executable, ['login', 'status'], selectedEnv);
    result.authenticated = status.ok;
    result.authentication = { status: status.ok ? 'present-not-live-verified' : 'required', method: status.ok ? (status.output.includes('ChatGPT') ? 'chatgpt' : 'native') : null };
    result.workerReady = result.compatible && result.authenticated;
    const cached = await cachedModels(configHome ?? env.CODEX_HOME ?? join(env.HOME ?? homedir(), '.codex'), version);
    result.modelCatalog = { ...cached }; delete result.modelCatalog.models;
    if (cached.status === 'ready') result.models = cached.models;
    else if (discoverModels && result.workerReady) {
      try {
        result.models = await listCodexModels({ executable, configHome, env });
        result.modelCatalog = { status: 'live', source: 'codex-app-server-model/list' };
      } catch { result.modelCatalog.status = 'discovery-required'; }
    }
  } else {
    const parts = version?.split(' ')[0].split('.').map(Number);
    result.compatible = Boolean(parts && (parts[0] > 2 || parts[0] === 2 && (parts[1] > 1 || parts[1] === 1 && parts[2] >= 286)));
    const status = await command(executable, ['auth', 'status'], selectedEnv);
    result.authenticated = status.ok;
    const explicit = Boolean(env.ANTHROPIC_API_KEY?.trim() || env.ANTHROPIC_AUTH_TOKEN?.trim());
    result.workerReady = result.compatible && explicit;
    result.authentication = { status: explicit ? 'present-not-live-verified' : 'explicit-worker-credential-required', method: explicit ? (env.ANTHROPIC_API_KEY?.trim() ? 'api-key' : 'auth-token') : null, clientLoginPresent: status.ok, note: 'Scoped Claude workers use bare mode; client OAuth login is not a worker credential.' };
  }
  return result;
}

export async function authenticateHost({ kind, executable, configHome, method = 'browser', env = process.env, stdio = 'inherit', signal }) {
  checkKind(kind);
  executable = await canonicalExecutable(executable);
  assert(['browser', 'device'].includes(method), 'Select browser or device authentication.');
  assert(kind === 'codex' || method === 'browser', 'Claude Code client login uses browser authentication.');
  const args = kind === 'codex' ? ['login', ...(method === 'device' ? ['--device-auth'] : [])] : ['auth', 'login'];
  if (signal?.aborted) return { kind, status: 'cancelled' };
  const status = await new Promise((done) => {
    const child = spawn(executable, args, { env: hostEnvironment(kind, configHome, env), stdio, signal });
    child.once('error', () => done(signal?.aborted ? 'cancelled' : 'failed'));
    child.once('close', (code, nativeSignal) => done(signal?.aborted || nativeSignal ? 'cancelled' : code === 0 ? 'completed' : 'failed'));
  });
  if (status !== 'completed') return { kind, status };
  const inspection = await inspectHost({ kind, executable, configHome, env, discoverModels: false });
  return { kind, status: inspection.authenticated ? 'authenticated' : 'required', workerReady: inspection.workerReady, authentication: inspection.authentication };
}

function localURL(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Select a valid local model endpoint.'); }
  assert(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'Local model discovery requires a loopback HTTP endpoint.');
  return url;
}
export async function listLocalModels({ baseUrl = 'http://127.0.0.1:11434', fetchImpl = fetch } = {}) {
  const url = localURL(baseUrl);
  let response;
  try { response = await fetchImpl(new URL('/api/tags', url), { signal: AbortSignal.timeout(10000), redirect: 'error' }); }
  catch { throw new Error('Local model service is unavailable. Start Ollama and retry.'); }
  assert(response.ok, 'Local model service did not return a model list.');
  assert(Number(response.headers.get('content-length') ?? 0) <= limit, 'Local model list exceeds the setup limit.');
  const reader = response.body?.getReader();
  assert(reader, 'Local model list is empty.');
  const chunks = []; let size = 0;
  try {
    while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; assert(size <= limit, 'Local model list exceeds the setup limit.'); chunks.push(part.value); }
  } finally { await reader.cancel().catch(() => {}); }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('Local model list is invalid.'); }
  assert(Array.isArray(data.models) && data.models.length <= 500, 'Local model list is invalid.');
  return data.models.map((model) => {
    const id = model.name ?? model.model;
    assert(typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(id), 'Local model identifier is invalid.');
    return { id, name: id };
  });
}

function validateValues(values) {
  assert(values && typeof values === 'object' && !Array.isArray(values), 'Credential values must be an object.');
  for (const [key, value] of Object.entries(values)) {
    assert(credentialKeys.has(key), 'Unsupported credential environment key.');
    assert(typeof value === 'string' && value.length <= 16384 && !/[\x00\r\n]/u.test(value), 'Credential value is invalid.');
    if (key === 'ANTHROPIC_BASE_URL' && value) {
      let url; try { url = new URL(value); } catch { throw new Error('Anthropic endpoint is invalid.'); }
      assert(!url.username && !url.password && !url.search && !url.hash && (url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)), 'Anthropic endpoint must use HTTPS or loopback HTTP.');
    }
  }
}
async function privateHome(home) {
  assert(isAbsolute(home ?? ''), 'Installation home must be absolute.');
  home = resolve(home);
  const stat = await lstat(home);
  assert(stat.isDirectory() && !stat.isSymbolicLink() && await realpath(home) === home, 'Installation home must be a canonical owned directory.');
  assert((stat.mode & 0o077) === 0 && (!process.getuid || stat.uid === process.getuid()), 'Installation home must be private to its owner.');
  const receipt = JSON.parse(await readPrivateFile(join(home, 'setup.json')));
  assert(receipt.kind === 'temari-unified-installation' && receipt.phase === 'ready', 'Complete setup before saving or using credentials.');
  return home;
}
async function readPrivateFile(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    assert(stat.isFile() && stat.nlink === 1 && stat.size <= 65536 && (stat.mode & 0o777) === 0o600 && (!process.getuid || stat.uid === process.getuid()), 'Credential storage must be a private owned regular file.');
    return await file.readFile('utf8');
  } finally { await file.close(); }
}
export async function readCredentials({ home }) {
  home = await privateHome(home);
  try {
    const record = JSON.parse(await readPrivateFile(join(home, 'credentials.json')));
    assert(record.schema === 1 && Object.keys(record).every((key) => ['schema', 'values'].includes(key)), 'Credential storage format is invalid.');
    validateValues(record.values);
    return { ...record.values };
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error('Cannot use credentials: storage is invalid or its ownership/permissions changed.');
  }
}
export async function saveCredentials({ home, values }) {
  validateValues(values);
  home = await privateHome(home);
  const merged = { ...await readCredentials({ home }), ...values };
  const bytes = Buffer.from(`${JSON.stringify({ schema: 1, values: merged })}\n`);
  assert(bytes.length <= 65536, 'Credential storage exceeds its size limit.');
  const path = join(home, 'credentials.json'), temporary = join(home, `.credentials-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
  return { path, keys: Object.keys(merged).sort(), mode: '0600' };
}
