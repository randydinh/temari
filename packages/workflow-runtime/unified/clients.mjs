import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

const LIMIT = 1024 * 1024;
class RegistrationError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function requireValue(condition, code, message) {
  if (!condition) throw new RegistrationError(code, message);
}
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Bounded CLI capture. Raw stdout/stderr are transient and never appear in receipts. */
export function executeClientCommand({ executable, args, cwd, env, timeoutMs = 30000, maxOutputBytes = LIMIT }) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(executable, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' }); }
    catch { resolve({ code: null, stdout: '', stderr: '', failed: true }); return; }
    let stdout = '', stderr = '', bytes = 0, timedOut = false, truncated = false;
    const kill = () => { try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const capture = (kind, chunk) => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) { truncated = true; kill(); return; }
      if (kind === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
    };
    child.stdout.on('data', (chunk) => capture('stdout', chunk));
    child.stderr.on('data', (chunk) => capture('stderr', chunk));
    child.on('error', () => { clearTimeout(timer); resolve({ code: null, stdout: '', stderr: '', failed: true }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut, truncated }); });
  });
}

async function configJson(path, optional = false) {
  try {
    requireValue((await stat(path)).size <= LIMIT, 'config-too-large', 'Client configuration is too large to inspect safely.');
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    if (error instanceof RegistrationError) throw error;
    throw new RegistrationError('config-unreadable', 'Client configuration cannot be inspected. Repair it with the client before retrying.');
  }
}
function jsonOutput(result) {
  try { return JSON.parse(result.stdout); }
  catch { throw new RegistrationError('invalid-client-response', 'The client returned an unsupported configuration response. Update the client and retry.'); }
}
function success(result, phase) {
  requireValue(result && result.code === 0 && !result.timedOut && !result.truncated && !result.failed,
    `client-${phase}-failed`, `Client ${phase} failed. Run the client's configuration command directly to diagnose it, then retry setup.`);
}
function exactConnection(value, connection, codex = false) {
  const entry = codex ? value?.transport : value;
  return entry?.type === 'stdio' && entry.command === connection.command
    && JSON.stringify(entry.args ?? []) === JSON.stringify(connection.args)
    && Object.keys(entry.env ?? {}).length === 0 && (entry.env_vars ?? []).length === 0
    && (entry.cwd === undefined || entry.cwd === null)
    && (!codex || (value.enabled === true && value.disabled_reason == null
      && value.enabled_tools == null && value.disabled_tools == null));
}
function absentCodex(result, name) {
  return result.code !== 0 && !result.timedOut && !result.truncated && !result.failed
    && result.stderr.trim() === `Error: No MCP server named '${name}' found.`;
}

async function registerKnowledge(client, call, connection, name, workspaceRoot) {
  if (client.kind === 'codex') {
    const get = await call(['mcp', 'get', name, '--json']);
    if (get.code === 0) {
      success(get, 'inspection');
      requireValue(exactConnection(jsonOutput(get), connection, true), 'knowledge-conflict', 'A different or disabled server already uses this Temari knowledge name. Resolve it in the client before retrying.');
      return 'already-registered';
    }
    requireValue(absentCodex(get, name), 'client-inspection-failed', 'Codex could not inspect the Temari knowledge server. Update or repair Codex configuration and retry.');
    success(await call(['mcp', 'add', name, '--', connection.command, ...connection.args]), 'registration');
    const after = await call(['mcp', 'get', name, '--json']);
    success(after, 'verification');
    requireValue(exactConnection(jsonOutput(after), connection, true), 'knowledge-verification-failed', 'Codex did not retain the requested Temari knowledge connection. Check managed client policy and retry.');
    return 'registered';
  }
  // Claude has no JSON get command. Select only the named MCP entry; auth fields
  // and unrelated servers are never used or copied into the result.
  const configHome = client.configHome ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  const configFile = client.configHome || process.env.CLAUDE_CONFIG_DIR ? join(configHome, '.claude.json') : join(homedir(), '.claude.json');
  const inspectEntry = async () => {
    const selectedConfig = await configJson(configFile, true);
    const projectSettings = selectedConfig?.projects?.[workspaceRoot];
    requireValue(!projectSettings?.disabledMcpServers?.includes(name), 'knowledge-disabled', 'Claude Code has disabled this Temari knowledge server for the workspace. Enable it in Claude Code before retrying.');
    const local = projectSettings?.mcpServers?.[name];
    const project = (await configJson(join(workspaceRoot, '.mcp.json'), true))?.mcpServers?.[name];
    requireValue(!local && !project, 'knowledge-shadowed', 'A project or local server shadows this Temari knowledge name. Resolve it in Claude Code before retrying.');
    return selectedConfig?.mcpServers?.[name];
  };
  const entry = await inspectEntry();
  if (entry) {
    requireValue(exactConnection(entry, connection), 'knowledge-conflict', 'A different server already uses this Temari knowledge name. Resolve it in Claude Code before retrying.');
    success(await call(['mcp', 'get', name]), 'inspection');
    requireValue(exactConnection(await inspectEntry(), connection), 'knowledge-verification-failed', 'Claude Code did not retain the requested Temari knowledge connection. Check client policy and retry.');
    return 'already-registered';
  }
  success(await call(['mcp', 'add-json', name, JSON.stringify({ type: 'stdio', command: connection.command, args: connection.args }), '--scope', 'user']), 'registration');
  const after = await inspectEntry();
  requireValue(exactConnection(after, connection), 'knowledge-verification-failed', 'Claude Code did not retain the requested Temari knowledge connection. Check client policy and retry.');
  success(await call(['mcp', 'get', name]), 'verification');
  requireValue(exactConnection(await inspectEntry(), connection), 'knowledge-verification-failed', 'Claude Code did not retain the requested Temari knowledge connection. Check client policy and retry.');
  return 'registered';
}

async function registerPlugin(call, marketplaceRoot, verifyExistingMarketplace) {
  const manifest = await configJson(join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'));
  requireValue(manifest.name === 'temari-private' && manifest.plugins?.some((p) => p.name === 'temari'), 'marketplace-invalid', 'The selected release does not contain the expected Temari marketplace.');
  const listResult = await call(['plugin', 'marketplace', 'list', '--json']);
  success(listResult, 'plugin-inspection');
  const marketplaces = jsonOutput(listResult).marketplaces;
  requireValue(Array.isArray(marketplaces), 'invalid-client-response', 'Codex returned an unsupported marketplace response. Update Codex and retry.');
  const existing = marketplaces.find((m) => m.name === manifest.name);
  let selectedRoot = marketplaceRoot;
  let marketplace = { status: existing ? 'already-registered' : 'registered', root: marketplaceRoot };
  if (existing) {
    const local = isAbsolute(existing.root ?? '') && (!existing.marketplaceSource
      || (existing.marketplaceSource.sourceType === 'local' && existing.marketplaceSource.source === existing.root));
    requireValue(local, 'marketplace-conflict', 'Another marketplace already uses the Temari release name. Resolve it in Codex before retrying.');
    if (existing.root !== marketplaceRoot) {
      let proof;
      try { if (typeof verifyExistingMarketplace === 'function') proof = await verifyExistingMarketplace(existing.root); } catch { /* Never retain verifier diagnostics or source data. */ }
      requireValue(proof && /^[a-f0-9]{64}$/.test(proof.releaseSha256) && /^[a-f0-9]{64}$/.test(proof.publicManifestSha256),
        'marketplace-conflict', 'Another marketplace already uses the Temari release name and could not be verified against this immutable release. Resolve it in Codex before retrying.');
      selectedRoot = existing.root;
      marketplace = { status: 'already-registered-verified-other-root', root: selectedRoot, releaseSha256: proof.releaseSha256, publicManifestSha256: proof.publicManifestSha256 };
    }
  } else success(await call(['plugin', 'marketplace', 'add', marketplaceRoot, '--json']), 'marketplace-registration');
  const list = await call(['plugin', 'list', '--marketplace', manifest.name, '--json']);
  success(list, 'plugin-inspection');
  const installed = jsonOutput(list).installed;
  requireValue(Array.isArray(installed), 'invalid-client-response', 'Codex returned an unsupported plugin response. Update Codex and retry.');
  const prior = installed.find((p) => p.pluginId === 'temari@temari-private');
  const valid = (p) => p?.installed === true && p.enabled === true && p.version === '0.15.5'
    && p.source?.source === 'local' && p.source.path === join(selectedRoot, 'plugins', 'temari');
  if (prior) {
    requireValue(valid(prior), 'plugin-conflict', 'The installed Temari plugin differs from this release or is disabled. Resolve it in Codex before retrying.');
    return { plugin: 'already-installed', marketplace };
  }
  success(await call(['plugin', 'add', 'temari@temari-private', '--json']), 'plugin-installation');
  const after = await call(['plugin', 'list', '--marketplace', manifest.name, '--json']);
  success(after, 'plugin-verification');
  requireValue(jsonOutput(after).installed?.some((p) => p.pluginId === 'temari@temari-private' && valid(p)), 'plugin-verification-failed', 'Codex did not enable the expected Temari release. Check client policy and retry.');
  return { plugin: 'installed', marketplace };
}

/**
 * Register only selected clients using their official CLI mutation commands.
 * `execute` is injectable for fixture tests and receives a bounded command spec.
 * Each client may pin `executableSha256`; otherwise its initial bytes are pinned.
 * Partial failures are retained per client; rerunning inspects actual state.
 * No credential, configuration dump, raw CLI output, or command arguments are
 * included in the safe receipt. Claude receives knowledge access only. A blocked
 * registration throws a sanitized error with the partial safe result in .receipt.
 * `verifyExistingMarketplace(root)` may reuse another local root only after the
 * caller independently verifies this exact immutable release; it returns the
 * releaseSha256 and publicManifestSha256 proof hashes, which are safe to retain.
 */
export async function registerClients({ home, workspaceRoot, clients, connection, marketplaceRoot, verifyExistingMarketplace, execute = executeClientCommand }) {
  requireValue(isAbsolute(home ?? '') && isAbsolute(workspaceRoot ?? ''), 'invalid-path', 'Temari home and workspace must be absolute paths.');
  requireValue(Array.isArray(clients) && clients.length <= 2 && new Set(clients.map((c) => c.kind)).size === clients.length,
    'invalid-clients', 'Select each supported client at most once.');
  requireValue(connection?.transport === 'stdio' && isAbsolute(connection.command ?? '') && Array.isArray(connection.args)
    && connection.args.every((a) => typeof a === 'string' && !a.includes('\0')) && Object.keys(connection).every((k) => ['transport', 'command', 'args'].includes(k)),
  'invalid-connection', 'Registration requires the generated local Temari knowledge connection without embedded credentials.');
  const canonicalHome = await realpath(home);
  const canonicalWorkspace = await realpath(workspaceRoot);
  const canonicalMarketplace = marketplaceRoot ? await realpath(marketplaceRoot) : null;
  const serverName = `temari-knowledge-${digest(canonicalHome).slice(0, 12)}`;
  const receipts = [];
  for (const client of clients) {
    const receipt = { kind: ['codex', 'claude-code'].includes(client.kind) ? client.kind : 'unsupported', serverName, status: 'blocked', knowledge: 'pending', plugin: client.kind === 'claude-code' ? 'not-supported' : 'pending' };
    receipts.push(receipt);
    try {
      requireValue(['codex', 'claude-code'].includes(client.kind) && isAbsolute(client.executable ?? '')
        && (!client.configHome || isAbsolute(client.configHome)) && (!client.executableSha256 || /^[a-f0-9]{64}$/.test(client.executableSha256)),
      'invalid-client', 'Client executable, configuration home, and optional binary pin must be valid absolute paths.');
      const pinnedSha256 = client.executableSha256 ?? digest(await readFile(client.executable));
      receipt.executableSha256 = pinnedSha256;
      const call = async (args) => {
        requireValue(digest(await readFile(client.executable)) === pinnedSha256, 'client-drift', 'The selected client executable changed. Run guided host selection again before registering.');
        const env = { ...process.env, ...(client.managed && client.kind === 'claude-code' ? { DISABLE_AUTOUPDATER: '1', DISABLE_UPDATES: '1' } : {}) };
        if (client.configHome) env[client.kind === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'] = client.configHome;
        return execute({ executable: client.executable, args, cwd: canonicalWorkspace, env, timeoutMs: 30000, maxOutputBytes: LIMIT });
      };
      receipt.knowledge = await registerKnowledge(client, call, connection, serverName, canonicalWorkspace);
      if (client.kind === 'codex' && canonicalMarketplace) Object.assign(receipt, await registerPlugin(call, canonicalMarketplace, verifyExistingMarketplace));
      else if (client.kind === 'codex') receipt.plugin = 'not-requested';
      receipt.status = 'ready';
      receipt.nextAction = client.kind === 'codex' && canonicalMarketplace
        ? 'Start a new Codex session to load Temari knowledge and installed skills.'
        : 'Start a new client session to load Temari knowledge. Engineering work remains in the Temari dashboard.';
    } catch (error) {
      receipt.error = error instanceof RegistrationError ? error.code : 'client-registration-failed';
      receipt.nextAction = error instanceof RegistrationError ? error.message : 'Client registration failed. Repair the selected client installation and retry guided setup.';
    }
  }
  const result = { schema: 1, status: receipts.every((r) => r.status === 'ready') ? 'ready' : 'blocked', serverName, clients: receipts };
  if (result.status === 'blocked') {
    const error = new RegistrationError('registration-blocked', receipts.find((r) => r.status === 'blocked').nextAction);
    error.receipt = result;
    throw error;
  }
  return result;
}
