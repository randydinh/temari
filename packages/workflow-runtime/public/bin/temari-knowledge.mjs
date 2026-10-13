#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { existsSync, realpathSync } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const artifact = fileURLToPath(new URL('..', import.meta.url));
const registrar = join(artifact, 'registrar');
const knowledgeCli = join(
  artifact,
  'runtime/node_modules/@temari/knowledge/src/demo.js',
);
const defaultHome = join(homedir(), '.local', 'share', 'temari-knowledge');
const serverName = 'temari-content-registrar';
const providerSelectionKind = 'temari-knowledge-provider-selection';
const providerSelectionMaxBytes = 256;
const registrarVersion = '0.1.0';
// The reviewed upstream payload inventory and commit pins are trust anchors.
const registrarManifestSha256 = '5ecf0874189fcfe6d0a0ad317ef78877a3cc390171c0240823598ac7de3d6e83';
const registrarCommit = 'd73f626133b2543345c32805957e05b61e386bad';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function verifyRegistrarPayload() {
  const root = await realpath(registrar);
  assert.equal(root, registrar, 'Registrar source must be a regular bundled directory.');
  const manifestPath = join(root, 'UPSTREAM.json');
  const manifestStat = await lstat(manifestPath);
  assert(manifestStat.isFile() && !manifestStat.isSymbolicLink(),
    'Registrar manifest must be a regular file.');
  const bytes = await readFile(manifestPath);
  assert.equal(sha256(bytes), registrarManifestSha256,
    'Bundled Registrar manifest differs from the pinned payload.');
  const manifest = JSON.parse(bytes.toString('utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.upstream?.commit, registrarCommit);
  assert(Array.isArray(manifest.files));
  const expected = manifest.files.map((file) => file.path);
  assert.deepEqual(expected, [...new Set(expected)].sort(),
    'Registrar manifest paths must be sorted and unique.');
  for (const file of manifest.files) {
    assert(typeof file.path === 'string' &&
      !file.path.startsWith('/') &&
      file.path.split('/').every((part) => part && part !== '.' && part !== '..') &&
      /^[a-f0-9]{64}$/.test(file.sha256),
    'Registrar manifest contains an invalid path or digest.');
  }
  const actual = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = await lstat(path);
      assert(!stat.isSymbolicLink(), 'Registrar payload contains a symlink.');
      if (stat.isDirectory()) await walk(path);
      else {
        assert(stat.isFile(), 'Registrar payload contains a nonregular file.');
        actual.push(relative(root, path).split(sep).join('/'));
      }
    }
  }
  await walk(root);
  assert.deepEqual(actual.filter((path) => path !== 'UPSTREAM.json').sort(), expected,
    'Bundled Registrar file inventory differs from the pinned payload.');
  for (const file of manifest.files)
    assert.equal(sha256(await readFile(join(root, file.path))), file.sha256,
      `Bundled Registrar bytes differ: ${file.path}`);
  return root;
}

function usage() {
  return `Usage: temari-knowledge status [--home ABS]
       temari-knowledge area status|sources|mcp --area work|personal [--home ABS] [sources arguments]
                              (mcp requires repeatable --source SOURCE_ID)
       temari-knowledge setup [--home ABS] [--python PYTHON_3_12] [--connect-codex]
                              [--workspace ABS] [--codex CODEX]
       temari-knowledge connect-codex [--home ABS] [--workspace ABS] [--codex CODEX]
       temari-knowledge disconnect-codex [--home ABS] [--workspace ABS] [--codex CODEX]
       temari-knowledge disable [--home ABS] [--workspace ABS] [--codex CODEX]
       temari-knowledge enable [--home ABS]
       temari-knowledge journey-intake|journey-query|journey-jobs-create|journey-jobs-tick|journey-search|archive-collect ... [--home ABS]

Setup builds a wheel from the pinned bundled Registrar source and installs it in
a user-local Python venv. The registry and archives live outside the plugin.
Connecting Codex is a separate, explicit command. Source intake requires a
separately selected input plan; setup and connection do not register sources.`;
}

async function areaCommand(args) {
  const { home, forwarded } = delegatedArgs(args);
  const areaArgs = [];
  let area;
  for (let index = 0; index < forwarded.length; index++) {
    const argument = forwarded[index];
    if (argument === '--area') {
      assert(area === undefined, 'Select one --area.');
      area = forwarded[++index];
    } else {
      assert(argument !== '--workspace' && !argument.startsWith('--workspace='),
        'Area commands own the workspace; a workspace override is refused.');
      areaArgs.push(argument);
    }
  }
  assert(area === 'work' || area === 'personal', 'Select --area work or personal.');
  const place = locations({ '--home': home });
  const directory = join(place.home, 'areas', area);
  const workspace = join(directory, 'workspace');
  for (const path of [join(place.home, 'areas'), directory, workspace]) {
    try {
      const entry = await lstat(path);
      assert(entry.isDirectory() && !entry.isSymbolicLink(),
        'Area state must use separate regular directories.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const [operation, ...rest] = areaArgs;
  if (operation === 'status') {
    assert(rest.length === 0, usage());
    console.log(JSON.stringify({ area, workspace, home: place.home,
      initialized: existsSync(join(workspace, 'registry.sqlite3')),
      legacyWorkspace: place.workspace, legacyIncluded: false,
      mcp: { command: process.execPath, args: [fileURLToPath(import.meta.url),
        'area', 'mcp', '--area', area, '--home', place.home],
        requiredFlags: ['--source SOURCE_ID (repeat for each admitted source)'] },
    }, null, 2));
    return;
  }
  assert(operation === 'sources' || operation === 'mcp', usage());
  if (operation === 'mcp') {
    assert(rest.length > 0 && rest.length <= 200 && rest.length % 2 === 0 &&
      rest.every((value, index) => index % 2 === 0 ? value === '--source' :
        value.length > 0 && value.length <= 80 && !value.startsWith('--')),
    'Area MCP requires --source SOURCE_ID for each admitted source.');
  }
  else assert(['add', 'list', 'refresh', 'inventory', 'disable', 'enable', 'relink',
    'search', 'discover', 'read', 'outline', 'expand', 'validate-claims',
    'set-sharing', 'evidence-policy', 'retrieval-provider', 'add-testmo', 'add-remote'].includes(rest[0]),
  'Select a supported sources command.');
  await assertRegistrarSelected(place);
  await verifyRegistrarPayload();
  assert(await currentInstallation(place), 'Run setup before using an area.');
  if (operation === 'mcp') assert(existsSync(join(workspace, 'registry.sqlite3')),
    'Register the selected area before starting its read-only MCP server.');
  const argv = operation === 'mcp'
    ? ['mcp', 'serve', '--workspace', workspace, '--profile', 'source-read-only',
      ...rest.map((value, index) => index % 2 === 0 ? '--allow-source' : value)]
    : ['sources', '--workspace', workspace, ...rest];
  const result = await invoke(place.python, ['-m', 'knowledge_agent.cli', ...argv],
    { allowFailure: true });
  process.exitCode = result.code;
}

function options(args, permitted, booleans = []) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    assert(permitted.includes(key) && !Object.hasOwn(result, key), usage());
    if (booleans.includes(key)) result[key] = true;
    else {
      const value = args[++i];
      assert(value && !value.startsWith('--'), usage());
      result[key] = value;
    }
  }
  return result;
}

function locations(flags) {
  const home = flags['--home'] ?? defaultHome;
  assert(isAbsolute(home), '--home must be absolute.');
  const selected = resolve(home);
  let existing = selected;
  const suffix = [];
  while (!existsSync(existing)) {
    suffix.unshift(existing.slice(dirname(existing).length + 1));
    existing = dirname(existing);
  }
  const physical = resolve(realpathSync(existing), ...suffix);
  const artifactPhysical = realpathSync(artifact);
  assert(
    physical !== artifactPhysical && !physical.startsWith(`${artifactPhysical}${sep}`),
    'Knowledge home must be outside the immutable artifact.',
  );
  const venv = join(selected, 'venv');
  const python = join(
    venv,
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
  );
  return {
    home: selected,
    venv,
    python,
    workspace: join(selected, 'workspace'),
    receipt: join(selected, 'installation.json'),
    providerSelection: join(selected, 'provider-selection.json'),
  };
}

function selectionRecord(selection, phase) {
  return { schemaVersion: 1, kind: providerSelectionKind, selection, phase };
}

function canonicalSelectionBytes(record) {
  return `${JSON.stringify(record)}\n`;
}

async function readProviderSelection(place) {
  let file;
  try {
    file = await lstat(place.providerSelection);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  assert(file.isFile() && !file.isSymbolicLink() && file.size <= providerSelectionMaxBytes,
    'Provider selection must be a bounded regular file.');
  const bytes = await readFile(place.providerSelection);
  assert(bytes.length <= providerSelectionMaxBytes,
    'Provider selection exceeded its byte bound.');
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('Provider selection is malformed.');
  }
  const valid = parsed?.schemaVersion === 1 && parsed.kind === providerSelectionKind &&
    ((parsed.selection === 'registrar' && parsed.phase === 'ready') ||
     (parsed.selection === 'disabled' && ['disabling', 'disabled'].includes(parsed.phase)));
  assert(valid && bytes.equals(Buffer.from(canonicalSelectionBytes(selectionRecord(
    parsed.selection, parsed.phase,
  )))), 'Provider selection is unknown or noncanonical.');
  return parsed;
}

function effectiveSelection(record) {
  return record ?? { selection: 'registrar', phase: 'uninitialized' };
}

async function assertRegistrarSelected(place) {
  const selected = effectiveSelection(await readProviderSelection(place));
  assert(selected.selection === 'registrar',
    `Knowledge provider selection is ${selected.phase}; run enable after reviewing the local installation.`);
}

async function publishProviderSelection(place, record, { onlyAbsent = false } = {}) {
  await mkdir(place.home, { recursive: true, mode: 0o700 });
  await readProviderSelection(place);
  const temporary = `${place.providerSelection}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, canonicalSelectionBytes(record), { flag: 'wx', mode: 0o600 });
    if (onlyAbsent) {
      try {
        await link(temporary, place.providerSelection);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    } else {
      await rename(temporary, place.providerSelection);
    }
  } finally {
    await rm(temporary, { force: true });
  }
  return await readProviderSelection(place);
}

async function withProviderSelectionLock(place, operation) {
  await mkdir(place.home, { recursive: true, mode: 0o700 });
  const lockPath = join(place.home, 'provider-selection.lock');
  const helper = spawn('python3', ['-u', '-c', `
import fcntl, os, stat, sys, time
path = sys.argv[1]
fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
if not stat.S_ISREG(os.fstat(fd).st_mode):
    sys.exit(2)
deadline = time.monotonic() + 5
while True:
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        break
    except BlockingIOError:
        if time.monotonic() >= deadline:
            sys.exit(3)
        time.sleep(0.05)
sys.stdout.write('locked\\n')
sys.stdout.flush()
sys.stdin.buffer.read()
`, lockPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  helper.stderr.resume();
  helper.stdin.on('error', () => {});
  let ready = false;
  const closed = new Promise((resolvePromise) => helper.once('close', resolvePromise));
  const acquired = new Promise((resolvePromise, reject) => {
    let output = '';
    helper.stdout.setEncoding('utf8');
    helper.stdout.on('data', (chunk) => {
      output += chunk;
      if (output === 'locked\n') {
        ready = true;
        resolvePromise();
      } else if (output.length > 16 || output.includes('\n')) {
        reject(new Error('Provider selection lock returned an invalid response.'));
      }
    });
    helper.on('error', () => reject(new Error('Provider selection lock could not start.')));
    helper.on('close', (code) => {
      if (!ready) reject(new Error(code === 3
        ? 'Provider selection is busy; retry after inspecting the local state.'
        : 'Provider selection lock is invalid or unavailable.'));
    });
  });
  let lockAcquired = false;
  try {
    await acquired;
    lockAcquired = true;
    return await operation();
  } finally {
    if (lockAcquired) helper.stdin.end();
    else if (helper.exitCode === null) helper.kill('SIGTERM');
    const code = await closed;
    if (lockAcquired) assert.equal(code, 0,
      'Provider selection lock ended unexpectedly; inspect the local state.');
  }
}

async function initializeProviderSelection(place) {
  const current = await readProviderSelection(place);
  if (current) return current;
  return await publishProviderSelection(place, selectionRecord('registrar', 'ready'), {
    onlyAbsent: true,
  });
}

async function installationReceipt(place) {
  try {
    const stat = await lstat(place.receipt);
    assert(stat.isFile() && !stat.isSymbolicLink(),
      'Installation receipt must be a regular file.');
    return JSON.parse(await readFile(place.receipt, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function currentInstallation(place) {
  const receipt = await installationReceipt(place);
  const recorded = (await installedVersion(place.python)) === registrarVersion &&
    receipt?.schemaVersion === 1 &&
    receipt.registrarManifestSha256 === registrarManifestSha256 &&
    receipt.registrarVersion === registrarVersion;
  if (!recorded) return false;
  const located = await invoke(place.python, [
    '-c',
    'import importlib.metadata; print(importlib.metadata.distribution("knowledge-agent").locate_file("knowledge_agent"))',
  ], { capture: true, allowFailure: true });
  if (located.code !== 0) return false;
  let installedRoot;
  try {
    installedRoot = realpathSync(resolve(located.stdout.trim()));
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  const physicalVenv = realpathSync(place.venv);
  if (!installedRoot.startsWith(`${physicalVenv}${sep}`)) return false;
  const manifest = JSON.parse(await readFile(join(registrar, 'UPSTREAM.json'), 'utf8'));
  for (const file of manifest.files) {
    if (!file.path.startsWith('src/knowledge_agent/')) continue;
    const installedPath = join(installedRoot, file.path.slice('src/knowledge_agent/'.length));
    try {
      const stat = await lstat(installedPath);
      if (!stat.isFile() || stat.isSymbolicLink() ||
          sha256(await readFile(installedPath)) !== file.sha256) return false;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }
  return true;
}

function invoke(command, args, { capture = false, allowFailure = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let stdout = '';
    let stderr = '';
    if (capture) {
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.stderr.on('data', (chunk) => (stderr += chunk));
    }
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0 && !allowFailure)
        reject(new Error(`${command} exited ${code}: ${stderr.trim()}`));
      else resolvePromise({ code, stdout, stderr });
    });
  });
}

async function installedVersion(python) {
  if (!existsSync(python)) return null;
  const result = await invoke(
    python,
    ['-c', 'import importlib.metadata; print(importlib.metadata.version("knowledge-agent"))'],
    { capture: true, allowFailure: true },
  );
  return result.code === 0 ? result.stdout.trim() : null;
}

async function status(flags) {
  const place = locations(flags);
  const selection = effectiveSelection(await readProviderSelection(place));
  await verifyRegistrarPayload();
  return {
    schemaVersion: 1,
    capability: 'temari-knowledge',
    registrarVersion,
    installedVersion: await installedVersion(place.python),
    payloadInstalled: await currentInstallation(place),
    registrarManifestSha256,
    home: place.home,
    workspace: place.workspace,
    venv: place.venv,
    knowledgeCliAvailable: existsSync(knowledgeCli),
    registrarSourceAvailable: existsSync(join(registrar, 'pyproject.toml')),
    platformSupport: process.platform === 'win32' ? 'use-wsl2' : 'local',
    codexConnection: 'not-checked',
    providerSelection: {
      selection: selection.selection,
      phase: selection.phase,
      persisted: selection.phase !== 'uninitialized',
    },
  };
}

async function setup(flags) {
  assert(process.platform !== 'win32',
    'Native Windows setup is unsupported. Run this launcher in WSL2 with Python 3.12.');
  const place = locations(flags);
  await readProviderSelection(place);
  if (flags['--connect-codex']) await assertRegistrarSelected(place);
  const source = await verifyRegistrarPayload();
  const existing = await installedVersion(place.python);
  if (await currentInstallation(place)) {
    await initializeProviderSelection(place);
    return { ...(await status(flags)), setup: 'already-installed' };
  }
  const selectedPython = flags['--python'] ?? 'python3.12';
  const version = await invoke(selectedPython, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { capture: true });
  assert.equal(version.stdout.trim(), '3.12', 'Registrar requires Python 3.12.');
  await mkdir(place.home, { recursive: true, mode: 0o700 });
  await mkdir(place.workspace, { recursive: true, mode: 0o700 });
  if (!existsSync(place.python))
    await invoke(selectedPython, ['-m', 'venv', place.venv], { capture: true });
  const wheelDir = await mkdtemp(join(place.home, 'wheel-build-'));
  try {
    await invoke(place.python, [
      '-m', 'pip', 'wheel', '--no-deps', '--wheel-dir', wheelDir, source,
    ], { capture: true });
    const wheel = (await readdir(wheelDir)).filter((name) =>
      /^knowledge_agent-0\.1\.0-py3-none-any\.whl$/.test(name),
    );
    assert.equal(wheel.length, 1, 'Pinned Registrar wheel was not built.');
    const wheelPath = join(wheelDir, wheel[0]);
    const wheelStat = await lstat(wheelPath);
    assert(wheelStat.isFile() && !wheelStat.isSymbolicLink(),
      'Registrar wheel must be a regular file.');
    await invoke(place.python,
      ['-m', 'pip', 'install', ...(existing ? ['--force-reinstall'] : []), wheelPath],
      { capture: true });
  } finally {
    await rm(wheelDir, { recursive: true, force: true });
  }
  assert.equal(await installedVersion(place.python), registrarVersion);
  const receipt = {
    schemaVersion: 1,
    registrarVersion,
    registrarManifestSha256,
  };
  const tempReceipt = `${place.receipt}.${randomUUID()}.tmp`;
  await writeFile(tempReceipt, `${JSON.stringify(receipt)}\n`, {
    flag: 'wx', mode: 0o600,
  });
  await rename(tempReceipt, place.receipt);
  await initializeProviderSelection(place);
  return { ...(await status(flags)), setup: existing ? 'repaired' : 'installed' };
}

async function connectCodex(flags) {
  assert(process.platform !== 'win32',
    'Native Windows connection is unsupported here. Configure Windows Codex to launch the WSL2 Python MCP server.');
  const place = locations(flags);
  await assertRegistrarSelected(place);
  await verifyRegistrarPayload();
  assert(await currentInstallation(place),
    'Run setup before connecting Codex.');
  const workspace = flags['--workspace'] ?? place.workspace;
  assert(isAbsolute(workspace), '--workspace must be absolute.');
  assert((await lstat(workspace)).isDirectory(), 'Registrar workspace must exist.');
  const codex = flags['--codex'] ?? 'codex';
  const existing = await invoke(codex, ['mcp', 'get', serverName, '--json'], {
    capture: true,
    allowFailure: true,
  });
  assert.notEqual(existing.code, 0,
    `${serverName} is already configured; inspect it before changing the connection.`);
  assert.match(existing.stderr, /No MCP server named/u,
    'Could not establish that the Codex MCP name is unused.');
  await assertRegistrarSelected(place);
  await invoke(codex, [
    'mcp', 'add', serverName, '--', place.python,
    '-m', 'knowledge_agent.cli', 'mcp', 'serve', '--workspace', workspace,
  ], { capture: true });
  return { status: 'connected', serverName, workspace, python: place.python };
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function selectedCodexEntry(value, place, workspace) {
  if (
    !exactKeys(value, [
      'name',
      'enabled',
      'disabled_reason',
      'transport',
      'enabled_tools',
      'disabled_tools',
      'startup_timeout_sec',
      'tool_timeout_sec',
    ])
  )
    return false;
  const transport = value.transport;
  return (
    value.name === serverName &&
    value.enabled === true &&
    value.disabled_reason === null &&
    value.enabled_tools === null &&
    value.disabled_tools === null &&
    value.startup_timeout_sec === null &&
    value.tool_timeout_sec === null &&
    exactKeys(transport, [
      'type',
      'command',
      'args',
      'env',
      'env_vars',
      'cwd',
    ]) &&
    transport.type === 'stdio' &&
    transport.command === place.python &&
    Array.isArray(transport.args) &&
    transport.args.length === 6 &&
    transport.args.every(
      (item, index) =>
        item ===
        ['-m', 'knowledge_agent.cli', 'mcp', 'serve', '--workspace', workspace][
          index
        ],
    ) &&
    transport.env === null &&
    Array.isArray(transport.env_vars) &&
    transport.env_vars.length === 0 &&
    transport.cwd === null
  );
}

async function getCodexEntry(codex) {
  const result = await invoke(codex, ['mcp', 'get', serverName, '--json'], {
    capture: true,
    allowFailure: true,
  });
  assert(
    Buffer.byteLength(result.stdout) <= 65536 &&
      Buffer.byteLength(result.stderr) <= 65536,
    'Codex MCP inspection exceeded its output bound.',
  );
  if (result.code !== 0) {
    const lines = result.stderr.trim().split(/\r?\n/u);
    if (
      result.code === 1 &&
      result.stdout.trim() === '' &&
      /^Error: No MCP server named ['"]?temari-content-registrar['"]? found\.?$/u.test(
        lines.at(-1),
      ) &&
      lines.slice(0, -1).every((line) =>
        line.startsWith('WARNING: proceeding, even though we could not create PATH aliases: '))
    )
      return { status: 'absent' };
    throw new Error('Codex MCP inspection failed.');
  }
  let entry;
  try {
    entry = JSON.parse(result.stdout);
  } catch {
    throw new Error('Codex MCP inspection returned invalid JSON.');
  }
  return { status: 'present', entry };
}

async function disconnectCodex(flags) {
  const place = locations(flags);
  const workspace = flags['--workspace'] ?? place.workspace;
  assert(isAbsolute(workspace), '--workspace must be absolute.');
  const codex = flags['--codex'] ?? 'codex';
  const first = await getCodexEntry(codex);
  if (first.status === 'absent')
    return { status: 'already-disconnected', serverName };
  assert(
    selectedCodexEntry(first.entry, place, workspace),
    'Codex MCP entry differs from the selected Knowledge connection; inspect it before removal.',
  );
  const second = await getCodexEntry(codex);
  assert(
    second.status === 'present' &&
      selectedCodexEntry(second.entry, place, workspace) &&
      isDeepStrictEqual(first.entry, second.entry),
    'Codex MCP entry changed before removal.',
  );
  const removed = await invoke(codex, ['mcp', 'remove', serverName], {
    capture: true,
    allowFailure: true,
  });
  assert.equal(removed.code, 0, 'Codex MCP removal failed.');
  const after = await getCodexEntry(codex);
  assert.equal(
    after.status,
    'absent',
    'Codex MCP entry remains after removal.',
  );
  return { status: 'disconnected', serverName };
}

async function disableKnowledge(flags) {
  const place = locations(flags);
  await readProviderSelection(place);
  const workspace = flags['--workspace'] ?? place.workspace;
  assert(isAbsolute(workspace), '--workspace must be absolute.');
  const codex = flags['--codex'] ?? 'codex';
  let inspected;
  try {
    inspected = await getCodexEntry(codex);
  } catch {
    await publishProviderSelection(place, selectionRecord('disabled', 'disabling'));
    return {
      status: 'partial', providerSelection: 'disabling', codexConnection: 'unverified',
      reason: 'codex-inspection-failed',
    };
  }
  assert(inspected.status === 'absent' ||
    selectedCodexEntry(inspected.entry, place, workspace),
  'Codex MCP entry differs from the selected Knowledge connection; provider selection was not changed.');
  await publishProviderSelection(place, selectionRecord('disabled', 'disabling'));
  try {
    await disconnectCodex(flags);
    await publishProviderSelection(place, selectionRecord('disabled', 'disabled'));
    return { status: 'disabled', providerSelection: 'disabled', codexConnection: 'absent' };
  } catch {
    return {
      status: 'partial', providerSelection: 'disabling', codexConnection: 'unverified',
      reason: 'codex-disconnect-unverified',
    };
  }
}

async function enableKnowledge(flags, expectedSelection) {
  const place = locations(flags);
  assert(isDeepStrictEqual(await readProviderSelection(place), expectedSelection),
    'Provider selection changed while enabling; retry explicitly.');
  assert(expectedSelection?.phase !== 'disabling',
    'Complete or resolve the partial disable before enabling Knowledge.');
  await verifyRegistrarPayload();
  assert(await currentInstallation(place), 'Run setup before enabling Knowledge.');
  await publishProviderSelection(place, selectionRecord('registrar', 'ready'));
  return { status: 'enabled', providerSelection: 'registrar', codexConnection: 'not-changed' };
}

function delegatedArgs(args) {
  const forwarded = [];
  let home;
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== '--home') {
      forwarded.push(args[index]);
      continue;
    }
    assert(home === undefined && args[index + 1] &&
      !args[index + 1].startsWith('--'), 'Expected one absolute --home value.');
    home = args[++index];
  }
  return { home, forwarded };
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (command === 'area') {
    await areaCommand(rest);
    return;
  }
  if (!command || command === '--help' || command === 'help') {
    console.log(usage());
    if (existsSync(knowledgeCli))
      await invoke(process.execPath, [knowledgeCli, '--help']);
    return;
  }
  if (command === 'status') {
    console.log(JSON.stringify(await status(options(rest, ['--home'])), null, 2));
    return;
  }
  if (command === 'setup') {
    const flags = options(
      rest,
      ['--home', '--python', '--connect-codex', '--workspace', '--codex'],
      ['--connect-codex'],
    );
    assert(flags['--connect-codex'] ||
      (flags['--workspace'] === undefined && flags['--codex'] === undefined),
    '--workspace and --codex require --connect-codex.');
    const { installed, connection } = await withProviderSelectionLock(
      locations(flags), async () => ({
        installed: await setup(flags),
        connection: flags['--connect-codex'] ? await connectCodex(flags) : undefined,
      }),
    );
    console.log(JSON.stringify({ ...installed, ...(connection ? { connection } : {}) }, null, 2));
    return;
  }
  if (command === 'connect-codex') {
    const flags = options(rest, ['--home', '--workspace', '--codex']);
    console.log(JSON.stringify(await withProviderSelectionLock(
      locations(flags), () => connectCodex(flags),
    ), null, 2));
    return;
  }
  if (command === 'disconnect-codex') {
    const flags = options(rest, ['--home', '--workspace', '--codex']);
    console.log(
      JSON.stringify(
        await withProviderSelectionLock(locations(flags), () => disconnectCodex(flags)),
        null,
        2,
      ),
    );
    return;
  }
  if (command === 'disable') {
    const flags = options(rest, ['--home', '--workspace', '--codex']);
    const outcome = await withProviderSelectionLock(locations(flags), () => disableKnowledge(flags));
    console.log(JSON.stringify(outcome, null, 2));
    if (outcome.status === 'partial') process.exitCode = 1;
    return;
  }
  if (command === 'enable') {
    const flags = options(rest, ['--home']);
    const place = locations(flags);
    const expectedSelection = await readProviderSelection(place);
    console.log(JSON.stringify(await withProviderSelectionLock(
      place, () => enableKnowledge(flags, expectedSelection),
    ), null, 2));
    return;
  }
  const delegated = delegatedArgs(rest);
  await assertRegistrarSelected(locations({ '--home': delegated.home }));
  assert(existsSync(knowledgeCli), 'Compiled knowledge CLI is missing.');
  const result = await invoke(process.execPath, [knowledgeCli, command, ...delegated.forwarded], {
    allowFailure: true,
  });
  process.exitCode = result.code;
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
