import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  checkPublicEntryArtifact,
  manifestSha256,
  packagePublicEntries,
} from './public-entry-runtime.mjs';
import { assertSourceEvidence } from '../packages/workflow-runtime/host/source.mjs';
import { syntheticQaRequest } from './fixtures/qa-synthetic.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const packager = fileURLToPath(
  new URL('./public-entry-runtime.mjs', import.meta.url),
);
let buildRoot;
let output;
let manifest;

before(async () => {
  buildRoot = await mkdtemp(join(tmpdir(), 'temari public-entry-build-'));
  output = join(buildRoot, 'artifact');
  manifest = await packagePublicEntries(output);
});

after(async () => {
  if (buildRoot) await rm(buildRoot, { recursive: true, force: true });
});

async function childResult(args, expectedCode = 0, env = {}) {
  const result = await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      args,
      {
        cwd: buildRoot,
        env: { ...process.env, ...env, NODE_OPTIONS: '', NODE_PATH: '' },
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        timeout: 30_000,
      },
      (error, stdout, stderr) => {
        if (error && (error.killed || typeof error.code !== 'number'))
          reject(error);
        else resolve({ code: error ? Number(error.code) : 0, stdout, stderr });
      },
    );
  });
  assert.equal(result.code, expectedCode, `${result.stderr}\n${result.stdout}`);
  return result;
}

async function child(args, expectedCode = 0) {
  const result = await childResult(args, expectedCode);
  return JSON.parse(result.stdout);
}

function expectedKnowledgeEntry(home, workspace) {
  return {
    name: 'temari-content-registrar',
    enabled: true,
    disabled_reason: null,
    transport: {
      type: 'stdio',
      command: join(home, 'venv', 'bin', 'python'),
      args: [
        '-m',
        'knowledge_agent.cli',
        'mcp',
        'serve',
        '--workspace',
        workspace,
      ],
      env: null,
      env_vars: [],
      cwd: null,
    },
    enabled_tools: null,
    disabled_tools: null,
    startup_timeout_sec: null,
    tool_timeout_sec: null,
  };
}

function providerSelectionBytes(selection, phase) {
  return `${JSON.stringify({
    schemaVersion: 1,
    kind: 'temari-knowledge-provider-selection',
    selection,
    phase,
  })}\n`;
}

async function statefulFakeCodex(root, codex) {
  const entryPath = join(root, 'fake-codex-entry.json');
  const controlPath = join(root, 'fake-codex-control.json');
  const countPath = join(root, 'fake-codex-get-count.txt');
  const logPath = join(root, 'fake-codex-operations.jsonl');
  const addStartPath = join(root, 'fake-codex-add-started');
  const removeStartPath = join(root, 'fake-codex-remove-started');
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const entryPath = ${JSON.stringify(entryPath)};
const controlPath = ${JSON.stringify(controlPath)};
const countPath = ${JSON.stringify(countPath)};
const logPath = ${JSON.stringify(logPath)};
const addStartPath = ${JSON.stringify(addStartPath)};
const removeStartPath = ${JSON.stringify(removeStartPath)};
const args = process.argv.slice(2);
const control = fs.existsSync(controlPath) ? JSON.parse(fs.readFileSync(controlPath, 'utf8')) : {};
fs.appendFileSync(logPath, JSON.stringify(args) + '\\n');
if (args[0] !== 'mcp') process.exit(2);
if (args[1] === 'get') {
  const count = (fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, 'utf8')) : 0) + 1;
  fs.writeFileSync(countPath, String(count));
  if (control.getMode === 'error') { console.error('TOP_SECRET inspection error'); process.exit(2); }
  if (control.getMode === 'malformed') { process.stdout.write('TOP_SECRET{invalid'); process.exit(0); }
  if (!fs.existsSync(entryPath)) {
    if (control.getMode === 'absent-warning')
      console.error('WARNING: proceeding, even though we could not create PATH aliases: Operation not permitted (os error 1)');
    console.error('Error: No MCP server named temari-content-registrar found.');
    process.exit(1);
  }
  const entry = JSON.parse(fs.readFileSync(entryPath, 'utf8'));
  if (control.getMode === 'changed-second' && count === 2)
    entry.transport.cwd = '/changed-between-reads';
  process.stdout.write(JSON.stringify(entry));
  process.exit(0);
}
if (args[1] === 'remove') {
  if (control.removeDelayMs) {
    fs.writeFileSync(removeStartPath, 'started');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, control.removeDelayMs);
  }
  if (control.removeMode === 'error') { console.error('TOP_SECRET removal error'); process.exit(2); }
  if (control.removeMode !== 'still-present') fs.rmSync(entryPath, { force: true });
  process.exit(0);
}
if (args[1] === 'add') {
  if (control.addDelayMs) {
    fs.writeFileSync(addStartPath, 'started');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, control.addDelayMs);
  }
  const separator = args.indexOf('--');
  if (separator < 0 || args[2] !== 'temari-content-registrar') process.exit(2);
  const command = args[separator + 1];
  const serverArgs = args.slice(separator + 2);
  fs.writeFileSync(entryPath, JSON.stringify({
    name: 'temari-content-registrar', enabled: true, disabled_reason: null,
    transport: { type: 'stdio', command, args: serverArgs, env: null, env_vars: [], cwd: null },
    enabled_tools: null, disabled_tools: null, startup_timeout_sec: null, tool_timeout_sec: null,
  }));
  process.exit(0);
}
process.exit(2);
`;
  await writeFile(codex, script);
  await chmod(codex, 0o755);
  return { entryPath, controlPath, countPath, logPath, addStartPath, removeStartPath };
}

async function waitForPath(path) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await lstat(path);
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function request(entry, overrides = {}) {
  return {
    schemaVersion: 1,
    entry,
    route: 'full-playbook',
    profile: 'feature-v1',
    obligations: {
      workType: 'feature',
      delegation: 'required',
      review: 'independent',
      evidence: 'revision-bound',
      delivery: 'pull-request',
    },
    ...overrides,
  };
}

test('packages an isolated relocated outer bundle with three current public entries', async () => {
  assert.deepEqual(
    await checkPublicEntryArtifact(output, manifestSha256(manifest)),
    manifest,
  );
  assert.deepEqual(manifest.entries, ['temari', 'poteto-mode', 'closeout']);
  assert(!JSON.stringify(manifest).includes(repository));

  const relocatedRoot = await mkdtemp(
    join(tmpdir(), 'temari public-entry-relocated-'),
  );
  try {
    const artifact = join(relocatedRoot, 'artifact');
    await cp(output, artifact, { recursive: true });
    assert.deepEqual(
      await checkPublicEntryArtifact(artifact, manifestSha256(manifest)),
      manifest,
    );
    assert.deepEqual(
      await child([
        packager,
        'check',
        '--artifact',
        artifact,
        '--expected-manifest-sha256',
        manifestSha256(manifest),
      ]),
      manifest,
    );
    const policy = await child([join(artifact, 'bin/temari.mjs'), 'policy']);
    assert.equal(policy.status, 'described');
    assert.equal(policy.supportedProfile, 'lightweight-engineering-v1');
  } finally {
    await rm(relocatedRoot, { recursive: true, force: true });
  }
});

test('relocated Knowledge cold install keeps state outside the artifact and connects Codex only on request', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'temari knowledge-relocated-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const artifact = join(root, 'installed', 'temari');
  const home = join(root, 'recipient-state');
  const launcher = join(artifact, 'bin/temari-knowledge.mjs');
  const codex = join(root, 'fake-codex');
  const codexLog = join(root, 'codex-args.txt');
  await cp(output, artifact, { recursive: true });
  await writeFile(codex, '#!/bin/sh\nif [ "$1" = mcp ] && [ "$2" = get ]; then echo "Error: No MCP server named temari-content-registrar found." >&2; exit 1; fi\nprintf "%s\\n" "$@" > "$FAKE_CODEX_LOG"\n');
  await chmod(codex, 0o755);
  const cold = await child([launcher, 'status', '--home', home]);
  assert.equal(cold.installedVersion, null);
  assert.deepEqual(cold.providerSelection, {
    selection: 'registrar', phase: 'uninitialized', persisted: false,
  });
  await assert.rejects(lstat(home), { code: 'ENOENT' });
  await assert.rejects(lstat(codexLog), { code: 'ENOENT' });

  const result = await new Promise((resolveResult, reject) => {
    execFile(
      process.execPath,
      [launcher, 'setup', '--home', home, '--python', 'python3.12',
        '--connect-codex', '--codex', codex],
      {
        cwd: root,
        env: { ...process.env, FAKE_CODEX_LOG: codexLog, NODE_OPTIONS: '', NODE_PATH: '' },
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        timeout: 180_000,
      },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`${error.message}\n${stderr}\n${stdout}`));
        else resolveResult(JSON.parse(stdout));
      },
    );
  });
  assert.equal(result.installedVersion, '0.1.0');
  assert.equal(result.connection.status, 'connected');
  assert.equal(result.connection.workspace, join(home, 'workspace'));
  assert.equal(result.home, home);
  assert.deepEqual(result.providerSelection, {
    selection: 'registrar', phase: 'ready', persisted: true,
  });
  const providerStatePath = join(home, 'provider-selection.json');
  assert.equal(await readFile(providerStatePath, 'utf8'),
    providerSelectionBytes('registrar', 'ready'));
  assert.deepEqual(await readdir(join(home, 'workspace')), []);
  assert.deepEqual(
    await checkPublicEntryArtifact(artifact, manifestSha256(manifest)),
    manifest,
  );
  const args = (await readFile(codexLog, 'utf8')).trim().split('\n');
  assert.deepEqual(args, [
    'mcp', 'add', 'temari-content-registrar', '--',
    join(home, 'venv', 'bin', 'python'), '-m', 'knowledge_agent.cli',
    'mcp', 'serve', '--workspace', join(home, 'workspace'),
  ]);
  const marker = join(home, 'workspace', 'preserved.txt');
  await writeFile(marker, 'recipient data\n');
  const stateful = await statefulFakeCodex(root, codex);
  await writeFile(
    stateful.entryPath,
    JSON.stringify(expectedKnowledgeEntry(home, join(home, 'workspace'))),
  );
  const disconnected = await child([
    launcher,
    'disconnect-codex',
    '--home',
    home,
    '--codex',
    codex,
  ]);
  assert.equal(disconnected.status, 'disconnected');
  await assert.rejects(lstat(stateful.entryPath), { code: 'ENOENT' });
  assert.equal(await readFile(marker, 'utf8'), 'recipient data\n');
  assert((await stat(join(home, 'venv', 'bin', 'python'))).isFile());
  const reconnected = await child([
    launcher,
    'connect-codex',
    '--home',
    home,
    '--codex',
    codex,
  ]);
  assert.equal(reconnected.status, 'connected');
  assert.deepEqual(
    JSON.parse(await readFile(stateful.entryPath, 'utf8')),
    expectedKnowledgeEntry(home, join(home, 'workspace')),
  );
  const repeated = await child([launcher, 'setup', '--home', home]);
  assert.equal(repeated.setup, 'already-installed');
  assert.equal(await readFile(marker, 'utf8'), 'recipient data\n');
  const disabled = await child([launcher, 'disable', '--home', home, '--codex', codex]);
  assert.equal(disabled.status, 'disabled');
  assert.equal(await readFile(providerStatePath, 'utf8'),
    providerSelectionBytes('disabled', 'disabled'));
  await assert.rejects(lstat(stateful.entryPath), { code: 'ENOENT' });
  assert.equal((await readFile(codexLog, 'utf8')).trim().split('\n').length, args.length);
  assert.equal((await child([launcher, 'status', '--home', home])).installedVersion, '0.1.0');

  const receiptPath = join(home, 'installation.json');
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  await writeFile(receiptPath, JSON.stringify({
    ...receipt,
    registrarManifestSha256: '0'.repeat(64),
  }));
  const installedModule = execFileSync(
    join(home, 'venv/bin/python'),
    ['-c', 'import knowledge_agent; print(knowledge_agent.__file__)'],
    { encoding: 'utf8' },
  ).trim();
  const originalModule = await readFile(installedModule);
  await writeFile(installedModule, 'stale same-version payload\n');
  const repaired = await child([launcher, 'setup', '--home', home]);
  assert.equal(repaired.setup, 'repaired');
  assert.equal(repaired.payloadInstalled, true);
  assert.equal(await readFile(providerStatePath, 'utf8'),
    providerSelectionBytes('disabled', 'disabled'));
  assert.deepEqual(await readFile(installedModule), originalModule);
  assert.equal(await readFile(marker, 'utf8'), 'recipient data\n');
  assert.equal(JSON.parse(await readFile(receiptPath)).registrarManifestSha256,
    receipt.registrarManifestSha256);
  await writeFile(installedModule, 'damaged installed module\n');
  assert.equal((await child([launcher, 'status', '--home', home])).payloadInstalled, false);
  assert.equal((await child([launcher, 'setup', '--home', home])).setup, 'repaired');
  assert.equal(await readFile(providerStatePath, 'utf8'),
    providerSelectionBytes('disabled', 'disabled'));
  assert.deepEqual(await readFile(installedModule), originalModule);
  assert.equal(await readFile(marker, 'utf8'), 'recipient data\n');
  await rm(artifact, { recursive: true });
  await cp(output, artifact, { recursive: true });
  assert.deepEqual((await child([launcher, 'status', '--home', home])).providerSelection, {
    selection: 'disabled', phase: 'disabled', persisted: true,
  });
  const enabled = await child([launcher, 'enable', '--home', home]);
  assert.equal(enabled.status, 'enabled');
  assert.equal(await readFile(providerStatePath, 'utf8'),
    providerSelectionBytes('registrar', 'ready'));
  await assert.rejects(lstat(stateful.entryPath), { code: 'ENOENT' });
  await writeFile(stateful.controlPath, JSON.stringify({ addDelayMs: 700 }));
  const connecting = childResult([
    launcher, 'connect-codex', '--home', home, '--codex', codex,
  ]);
  await waitForPath(stateful.addStartPath);
  const disablingAfterConnect = childResult([
    launcher, 'disable', '--home', home, '--codex', codex,
  ]);
  assert.equal(JSON.parse((await connecting).stdout).status, 'connected');
  assert.equal(JSON.parse((await disablingAfterConnect).stdout).status, 'disabled');
  await assert.rejects(lstat(stateful.entryPath), { code: 'ENOENT' });
  assert.equal(await readFile(providerStatePath, 'utf8'),
    providerSelectionBytes('disabled', 'disabled'));
  await unlink(stateful.controlPath);
  assert.equal((await child([launcher, 'enable', '--home', home])).status, 'enabled');
  assert.equal((await child([launcher, 'connect-codex', '--home', home, '--codex', codex])).status,
    'connected');

  await writeFile(stateful.controlPath, JSON.stringify({ removeDelayMs: 700 }));
  const disablingFirst = childResult([
    launcher, 'disable', '--home', home, '--codex', codex,
  ]);
  await waitForPath(stateful.removeStartPath);
  const lateConnect = childResult([
    launcher, 'connect-codex', '--home', home, '--codex', codex,
  ], 1);
  const overlappingEnable = childResult([launcher, 'enable', '--home', home], 1);
  assert.equal(JSON.parse((await disablingFirst).stdout).status, 'disabled');
  assert.match((await lateConnect).stderr, /provider selection is disabled/);
  assert.match((await overlappingEnable).stderr, /selection changed while enabling/);
  assert.equal(await readFile(providerStatePath, 'utf8'),
    providerSelectionBytes('disabled', 'disabled'));
  await assert.rejects(lstat(stateful.entryPath), { code: 'ENOENT' });
  await unlink(stateful.controlPath);
  assert.equal((await child([launcher, 'enable', '--home', home])).status, 'enabled');
  assert.equal((await child([launcher, 'connect-codex', '--home', home, '--codex', codex])).status,
    'connected');

  await unlink(stateful.removeStartPath);
  await writeFile(stateful.controlPath, JSON.stringify({ removeDelayMs: 700, removeMode: 'error' }));
  const failedDisable = childResult([
    launcher, 'disable', '--home', home, '--codex', codex,
  ], 1);
  await waitForPath(stateful.removeStartPath);
  const enableDuringFailure = childResult([launcher, 'enable', '--home', home], 1);
  assert.equal(JSON.parse((await failedDisable).stdout).status, 'partial');
  assert.match((await enableDuringFailure).stderr, /partial disable before enabling/);
  assert.equal(await readFile(providerStatePath, 'utf8'),
    providerSelectionBytes('disabled', 'disabling'));
  assert.deepEqual(JSON.parse(await readFile(stateful.entryPath, 'utf8')),
    expectedKnowledgeEntry(home, join(home, 'workspace')));
  await unlink(stateful.controlPath);
  assert.equal((await child([launcher, 'disable', '--home', home, '--codex', codex])).status,
    'disabled');
  assert.equal((await child([launcher, 'enable', '--home', home])).status, 'enabled');
  assert.equal((await child([launcher, 'connect-codex', '--home', home, '--codex', codex])).status,
    'connected');

  const sourcePath = join(artifact, 'registrar/src/knowledge_agent/cli.py');
  const sourceBytes = await readFile(sourcePath);
  await writeFile(sourcePath, Buffer.concat([sourceBytes, Buffer.from('\n# changed\n')]));
  const rejectedSetup = await childResult([launcher, 'setup', '--home', home], 1);
  assert.match(rejectedSetup.stderr, /Bundled Registrar bytes differ/);
  const rejectedConnect = await childResult(
    [launcher, 'connect-codex', '--home', home, '--codex', codex], 1,
    { FAKE_CODEX_LOG: codexLog },
  );
  assert.match(rejectedConnect.stderr, /Bundled Registrar bytes differ/);
  await writeFile(sourcePath, sourceBytes);

  const linkedHome = join(root, 'linked-home');
  await symlink(artifact, linkedHome, 'dir');
  const rejectedLinked = await childResult(
    [launcher, 'setup', '--home', linkedHome], 1,
  );
  assert.match(rejectedLinked.stderr, /outside the immutable artifact/);
  assert.equal(await readFile(marker, 'utf8'), 'recipient data\n');
  assert.deepEqual(
    await checkPublicEntryArtifact(artifact, manifestSha256(manifest)),
    manifest,
  );
  assert.equal((await lstat(join(artifact, 'registrar/UPSTREAM.json'))).isFile(), true);
});

test('Knowledge disconnect removes only the exact selected Codex entry and retains local data', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'temari knowledge-disconnect-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const home = join(root, 'state');
  const workspace = join(home, 'workspace');
  const customWorkspace = join(root, 'custom-workspace');
  const codex = join(root, 'fake-codex');
  const launcher = join(output, 'bin/temari-knowledge.mjs');
  await mkdir(workspace, { recursive: true });
  await mkdir(customWorkspace);
  await mkdir(join(home, 'venv', 'bin'), { recursive: true });
  const data = join(workspace, 'retained.txt');
  const customData = join(customWorkspace, 'retained.txt');
  const python = join(home, 'venv', 'bin', 'python');
  await writeFile(data, 'local source data\n');
  await writeFile(customData, 'custom source data\n');
  await writeFile(python, 'venv marker\n');
  const fake = await statefulFakeCodex(root, codex);
  const command = (extra = []) => [
    launcher,
    'disconnect-codex',
    '--home',
    home,
    '--codex',
    codex,
    ...extra,
  ];
  async function removeCount() {
    const lines = (await readFile(fake.logPath, 'utf8')).trim().split('\n');
    return lines.filter((line) => JSON.parse(line)[1] === 'remove').length;
  }
  const absent = await child(command());
  assert.equal(absent.status, 'already-disconnected');
  assert.equal(await removeCount(), 0);
  await writeFile(fake.controlPath, JSON.stringify({ getMode: 'absent-warning' }));
  assert.equal((await child(command())).status, 'already-disconnected');
  await unlink(fake.controlPath);
  assert.equal(await removeCount(), 0);

  const selected = expectedKnowledgeEntry(home, workspace);
  await writeFile(fake.entryPath, JSON.stringify(selected));
  const removed = await child(command());
  assert.equal(removed.status, 'disconnected');
  await assert.rejects(lstat(fake.entryPath), { code: 'ENOENT' });
  assert.equal((await child(command())).status, 'already-disconnected');
  assert.equal(await removeCount(), 1);
  assert.equal(await readFile(data, 'utf8'), 'local source data\n');
  assert.equal(await readFile(python, 'utf8'), 'venv marker\n');

  const custom = expectedKnowledgeEntry(home, customWorkspace);
  await writeFile(fake.entryPath, JSON.stringify(custom));
  const wrongSelection = await childResult(command(), 1);
  assert.match(
    wrongSelection.stderr,
    /differs from the selected Knowledge connection/,
  );
  assert.deepEqual(JSON.parse(await readFile(fake.entryPath, 'utf8')), custom);
  assert.equal(
    (await child(command(['--workspace', customWorkspace]))).status,
    'disconnected',
  );
  assert.equal(await readFile(customData, 'utf8'), 'custom source data\n');
  assert.equal(await removeCount(), 2);

  const mismatches = [
    (item) => {
      item.name = 'another-server';
    },
    (item) => {
      item.enabled = false;
    },
    (item) => {
      item.transport.type = 'http';
    },
    (item) => {
      item.transport.command = '/other/python';
    },
    (item) => {
      item.transport.args[5] = '/other/workspace';
    },
    (item) => {
      item.transport.args.push('--extra');
    },
    (item) => {
      item.transport.env = { TOKEN: 'TOP_SECRET' };
    },
    (item) => {
      item.transport.env_vars = ['TOKEN'];
    },
    (item) => {
      item.transport.cwd = '/other';
    },
    (item) => {
      item.transport.extra = true;
    },
    (item) => {
      item.enabled_tools = [];
    },
    (item) => {
      item.disabled_tools = [];
    },
    (item) => {
      item.startup_timeout_sec = 5;
    },
    (item) => {
      item.tool_timeout_sec = 5;
    },
    (item) => {
      item.extra = true;
    },
  ];
  for (const change of mismatches) {
    const item = structuredClone(selected);
    change(item);
    const bytes = JSON.stringify(item);
    await writeFile(fake.entryPath, bytes);
    const beforeRemoves = await removeCount();
    const refused = await childResult(command(), 1);
    assert.match(
      refused.stderr,
      /differs from the selected Knowledge connection/,
    );
    assert(!refused.stderr.includes('TOP_SECRET'));
    assert.equal(await readFile(fake.entryPath, 'utf8'), bytes);
    assert.equal(await removeCount(), beforeRemoves);
  }

  await writeFile(fake.entryPath, JSON.stringify(selected));
  for (const getMode of ['malformed', 'error', 'changed-second']) {
    await writeFile(fake.controlPath, JSON.stringify({ getMode }));
    await writeFile(fake.countPath, '0');
    const beforeRemoves = await removeCount();
    const refused = await childResult(command(), 1);
    assert(!refused.stderr.includes('TOP_SECRET'));
    assert.equal(await removeCount(), beforeRemoves);
    assert.deepEqual(
      JSON.parse(await readFile(fake.entryPath, 'utf8')),
      selected,
    );
  }
  for (const removeMode of ['error', 'still-present']) {
    await writeFile(fake.controlPath, JSON.stringify({ removeMode }));
    const refused = await childResult(command(), 1);
    assert(!refused.stderr.includes('TOP_SECRET'));
    assert.deepEqual(
      JSON.parse(await readFile(fake.entryPath, 'utf8')),
      selected,
    );
  }
  assert.equal(await readFile(data, 'utf8'), 'local source data\n');
  assert.equal(await readFile(python, 'utf8'), 'venv marker\n');
});

test('Knowledge provider selection gates delegation and records uncertain disconnects', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'temari knowledge-selection-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const home = join(root, 'state');
  const workspace = join(home, 'workspace');
  const statePath = join(home, 'provider-selection.json');
  const codex = join(root, 'fake-codex');
  const launcher = join(output, 'bin/temari-knowledge.mjs');
  await mkdir(workspace, { recursive: true });
  const marker = join(workspace, 'retained.txt');
  await writeFile(marker, 'source data\n');
  const fake = await statefulFakeCodex(root, codex);
  const entry = expectedKnowledgeEntry(home, workspace);
  const command = (name, extra = []) => [launcher, name, '--home', home, ...extra];
  await writeFile(fake.entryPath, JSON.stringify(entry));

  const foreign = structuredClone(entry);
  foreign.transport.env = { TOKEN: 'TOP_SECRET' };
  await writeFile(fake.entryPath, JSON.stringify(foreign));
  const preflightRefusal = await childResult(command('disable', ['--codex', codex]), 1);
  assert.match(preflightRefusal.stderr, /provider selection was not changed/);
  assert(!preflightRefusal.stderr.includes('TOP_SECRET'));
  await assert.rejects(lstat(statePath), { code: 'ENOENT' });
  assert.deepEqual(JSON.parse(await readFile(fake.entryPath, 'utf8')), foreign);

  await writeFile(fake.entryPath, JSON.stringify(entry));
  await writeFile(fake.controlPath, JSON.stringify({ getMode: 'changed-second' }));
  await writeFile(fake.countPath, '0');
  const changed = await childResult(command('disable', ['--codex', codex]), 1);
  assert.equal(JSON.parse(changed.stdout).status, 'partial');
  assert.equal(await readFile(statePath, 'utf8'),
    providerSelectionBytes('disabled', 'disabling'));
  assert.deepEqual(JSON.parse(await readFile(fake.entryPath, 'utf8')), entry);
  assert.match((await childResult(command('journey-query', [
    '--input', join(root, 'missing-plan.json'),
  ]), 1)).stderr, /provider selection is disabling/);
  assert.match((await childResult(command('connect-codex', [
    '--codex', codex,
  ]), 1)).stderr, /provider selection is disabling/);
  assert.match((await childResult(command('setup', [
    '--connect-codex', '--codex', codex,
  ]), 1)).stderr, /provider selection is disabling/);
  assert.deepEqual((await child(command('status'))).providerSelection, {
    selection: 'disabled', phase: 'disabling', persisted: true,
  });

  await writeFile(fake.controlPath, JSON.stringify({ removeMode: 'error' }));
  const failedRemove = await childResult(command('disable', ['--codex', codex]), 1);
  assert.equal(JSON.parse(failedRemove.stdout).status, 'partial');
  assert.equal(await readFile(statePath, 'utf8'),
    providerSelectionBytes('disabled', 'disabling'));
  assert.deepEqual(JSON.parse(await readFile(fake.entryPath, 'utf8')), entry);
  await unlink(fake.controlPath);
  const finished = await child(command('disable', ['--codex', codex]));
  assert.equal(finished.status, 'disabled');
  assert.equal(await readFile(statePath, 'utf8'),
    providerSelectionBytes('disabled', 'disabled'));
  await assert.rejects(lstat(fake.entryPath), { code: 'ENOENT' });
  assert.equal(await readFile(marker, 'utf8'), 'source data\n');
  assert.equal((await child(command('disable', ['--codex', codex]))).status,
    'disabled');
  await writeFile(fake.controlPath, JSON.stringify({ getMode: 'error' }));
  const inspectionFailure = await childResult(command('disable', ['--codex', codex]), 1);
  assert.equal(JSON.parse(inspectionFailure.stdout).reason, 'codex-inspection-failed');
  assert.equal(await readFile(statePath, 'utf8'),
    providerSelectionBytes('disabled', 'disabling'));
  await unlink(fake.controlPath);
  assert.equal((await child(command('disable', ['--codex', codex]))).status,
    'disabled');
  assert.match((await childResult(command('enable'), 1)).stderr,
    /Run setup before enabling Knowledge/);

  const holder = spawn('python3', ['-u', '-c', `
import fcntl, os, sys, time
fd = os.open(sys.argv[1], os.O_CREAT | os.O_RDWR, 0o600)
fcntl.flock(fd, fcntl.LOCK_EX)
print('held', flush=True)
time.sleep(30)
`, join(home, 'provider-selection.lock')], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => holder.kill('SIGKILL'));
  await new Promise((resolve, reject) => {
    holder.stdout.once('data', (chunk) => {
      if (chunk.toString() === 'held\n') resolve();
      else reject(new Error('External lock holder did not start.'));
    });
    holder.once('error', reject);
    holder.once('close', () => reject(new Error('External lock holder exited early.')));
  });
  const busyStart = Date.now();
  const busy = await childResult(command('disable', ['--codex', codex]), 1);
  assert.match(busy.stderr, /Provider selection is busy/);
  assert(Date.now() - busyStart < 8000);
  assert.equal(await readFile(statePath, 'utf8'),
    providerSelectionBytes('disabled', 'disabled'));
  holder.kill('SIGKILL');
  assert.equal((await child(command('disable', ['--codex', codex]))).status,
    'disabled');
  assert.equal(await readFile(statePath, 'utf8'),
    providerSelectionBytes('disabled', 'disabled'));
});

test('Knowledge provider selection refuses malformed, unknown, and symlink state', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'temari knowledge-state-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const home = join(root, 'state');
  const statePath = join(home, 'provider-selection.json');
  const launcher = join(output, 'bin/temari-knowledge.mjs');
  await mkdir(home);
  const commands = [
    [launcher, 'status', '--home', home],
    [launcher, 'setup', '--home', home],
    [launcher, 'journey-query', '--input', join(root, 'missing-plan.json'), '--home', home],
  ];
  for (const badBytes of [
    '{invalid',
    `${JSON.stringify({ schemaVersion: 1, kind: 'temari-knowledge-provider-selection', selection: 'other', phase: 'ready' })}\n`,
    providerSelectionBytes('registrar', 'ready').trimEnd(),
  ]) {
    await writeFile(statePath, badBytes);
    for (const command of commands) {
      const refused = await childResult(command, 1);
      assert.match(refused.stderr, /Provider selection/);
    }
  }
  const external = join(root, 'external-state.json');
  await writeFile(external, providerSelectionBytes('registrar', 'ready'));
  await unlink(statePath);
  await symlink(external, statePath);
  for (const command of commands)
    assert.match((await childResult(command, 1)).stderr, /bounded regular file/);
  assert.equal(await readFile(external, 'utf8'),
    providerSelectionBytes('registrar', 'ready'));
});

test('relocated QA entry runs the packaged evaluator without source-checkout access', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari qa-relocated-'));
  try {
    const artifact = join(root, 'artifact');
    const candidate = join(root, 'candidate');
    await cp(output, artifact, { recursive: true });
    const loader = join(root, 'deny-source-loader.mjs');
    await writeFile(
      loader,
      `export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  if (result.url.startsWith(${JSON.stringify(pathToFileURL(repository).href)})) throw Error('Source checkout import refused');
  return result;
}\n`,
    );
    const denied = await childResult(
      [
        '--experimental-loader',
        pathToFileURL(loader).href,
        '--input-type=module',
        '-e',
        `import(${JSON.stringify(pathToFileURL(packager).href)})`,
      ],
      1,
    );
    assert.match(denied.stderr, /Source checkout import refused/);
    await mkdir(candidate);
    await writeFile(join(candidate, 'product.txt'), 'synthetic fixture\n');
    const base = syntheticQaRequest(candidate, join(root, 'run'));
    await mkdir(base.invocation.evidenceRoot, { recursive: true });
    const invoke = async (input, name, expectedCode = 1) => {
      const path = join(root, `${name}.json`);
      const bytes = Buffer.from(`${JSON.stringify(input)}\n`);
      await writeFile(path, bytes);
      return childResult(
        [
          '--experimental-loader',
          pathToFileURL(loader).href,
          join(artifact, 'bin/temari.mjs'),
          'qa',
          '--request',
          path,
          '--expected-request-sha256',
          createHash('sha256').update(bytes).digest('hex'),
          '--expected-manifest-sha256',
          manifestSha256(manifest),
        ],
        expectedCode,
      );
    };
    const result = await invoke(base, 'valid');
    const qaOutput = JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.equal(qaOutput.route.route, 'qa-review');
    assert.equal(qaOutput.guidance.playbookId, 'ticket-acceptance-v1');
    assert.match(qaOutput.guidance.playbook.text, /pinned product decision/);
    assert.match(qaOutput.guidance.evidenceSkill.text, /QA/);
    assert.equal(
      qaOutput.guidance.projectVerifier.status,
      'missing-project-profile',
    );
    assert.equal(qaOutput.guidance.execution, 'not-observed');
    assert.deepEqual(qaOutput.plan.stages, [
      'investigate',
      'plan',
      'build',
      'review',
      'verify',
      'deliver',
    ]);
    assert.equal(qaOutput.qaDisposition.disposition, 'BlockedOrIncomplete');
    assert.equal(qaOutput.evaluator.decision.verdict, 'REVISE');
    assert.equal(qaOutput.record.evaluationRounds.length, 1);
    assert.equal(
      qaOutput.record.evaluationRounds[0].evaluatorId,
      'local-fresh-qa-evaluator-v1',
    );
    assert.equal(qaOutput.record.evaluationRounds[0].verdict, 'REVISE');
    assert.deepEqual(qaOutput.record.externalWriteReceipts, []);
    assert.equal(qaOutput.delivery.mode, 'local');
    assert.equal(qaOutput.delivery.externalWrites, 'denied');
    assert.equal(qaOutput.delivery.evaluatorLaunch, 'packaged-local-process');
    assert.deepEqual(
      JSON.parse(await readFile(join(root, 'run/config/qa-result.json'))),
      qaOutput,
    );

    // This legacy structural fixture checks honest missing-environment routing,
    // not the current-task-bound policy profile or actual product execution.
    const blockedAssignment = {
      ...base.assignment,
      missingEnvironmentBlocker: 'No owned nonproduction fixture is available',
    };
    delete blockedAssignment.environmentRef;
    const blocked = {
      ...base,
      assignment: blockedAssignment,
      invocation: {
        ...base.invocation,
        runId: 'synthetic-qa-environment-blocked',
        runDirectory: join(root, 'blocked-run'),
        evidenceRoot: join(root, 'blocked-run/evidence'),
      },
    };
    await mkdir(blocked.invocation.evidenceRoot, { recursive: true });
    const blockedRun = await invoke(blocked, 'blocked-environment');
    const blockedOutput = JSON.parse(
      blockedRun.stdout.trim().split('\n').at(-1),
    );
    assert.equal(blockedOutput.guidance.playbookId, 'ticket-acceptance-v1');
    assert.match(
      blockedOutput.guidance.playbook.text,
      /request to perform QA Review remains in this playbook/i,
    );
    assert.match(
      blockedOutput.guidance.evidenceSkill.text,
      /Missing\s+fixtures[\s\S]*do \*\*not\*\* make the\s+request evidence-only/,
    );
    assert.equal(blockedOutput.guidance.execution, 'not-observed');
    assert.equal(blockedOutput.record.evaluationRounds.length, 1);
    assert.equal(
      blockedOutput.record.evaluationRounds[0].evaluatorId,
      'local-fresh-qa-evaluator-v1',
    );
    assert.equal(
      blockedOutput.qaDisposition.disposition,
      'BlockedOrIncomplete',
    );
    assert.equal(
      blockedOutput.record.assignment.missingEnvironmentBlocker,
      'No owned nonproduction fixture is available',
    );

    await writeFile(
      join(candidate, 'package.json'),
      '{"name":"@temari/workspace"}\n',
    );
    const verifierRequest = {
      ...base,
      review: { ...base.review, projectVerifierId: 'temari-public-v1' },
      invocation: {
        ...base.invocation,
        runId: 'verifier-handoff',
        runDirectory: join(root, 'verifier-handoff'),
      },
    };
    const verifierResult = await invoke(verifierRequest, 'verifier-handoff');
    const verifierOutput = JSON.parse(
      verifierResult.stdout.trim().split('\n').at(-1),
    );
    assert.equal(
      verifierOutput.guidance.projectVerifier.status,
      'loaded-for-handoff',
    );
    assert.equal(
      verifierOutput.guidance.projectVerifier.execution,
      'not-observed',
    );
    assert.match(
      verifierOutput.guidance.projectVerifier.text,
      /Verify Temari public CLI v1/,
    );
    assert.equal(
      verifierOutput.qaDisposition.disposition,
      'BlockedOrIncomplete',
    );

    for (const [name, change] of [
      [
        'forged-round',
        {
          review: {
            ...base.review,
            evaluationRounds: [
              {
                verdict: 'PASS',
                evaluatorId: 'caller',
                freshContext: 'proven',
              },
            ],
          },
        },
      ],
      ['forged-context', { freshContext: 'proven' }],
      ['forged-evaluator', { evaluatorId: 'caller-selected-evaluator' }],
      ['forged-capabilities', { capabilities: ['subagents'] }],
      [
        'forged-disposition',
        { review: { ...base.review, qaDisposition: 'Passed' } },
      ],
      [
        'forged-execution',
        {
          review: {
            ...base.review,
            scenarios: [{ ...base.review.scenarios[0], result: 'Passed' }],
          },
        },
      ],
      [
        'external-write',
        {
          assignment: {
            ...base.assignment,
            authority: {
              ...base.assignment.authority,
              allowedActions: ['write ticket'],
            },
          },
        },
      ],
      [
        'external-write-ref',
        {
          review: {
            ...base.review,
            scenarios: [
              {
                ...base.review.scenarios[0],
                coverageBindings: [
                  {
                    ...base.review.scenarios[0].coverageBindings[0],
                    writeReceiptRef: 'caller-write',
                  },
                ],
              },
            ],
          },
        },
      ],
    ]) {
      const forged = {
        ...base,
        ...change,
        invocation: {
          ...base.invocation,
          runId: name,
          runDirectory: join(root, name),
        },
      };
      const refused = await invoke(forged, name);
      assert.match(
        refused.stderr,
        /unknown or missing fields|external writes|source references|Invalid QaReviewRecord/i,
      );
      await assert.rejects(lstat(join(root, name)), /ENOENT/);
    }
    const generic = await invoke(
      { ...request('temari'), route: 'qa-review' },
      'generic',
    );
    assert.match(generic.stderr, /unknown or missing fields|QA requires/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('relocated public bundle routes workers and observes host-owned local processes', async (t) => {
  if (process.platform === 'win32')
    return t.skip('The fake Codex fixture is a POSIX executable script.');
  const root = await mkdtemp(join(tmpdir(), 'temari public-parallel-'));
  try {
    const artifact = join(root, 'artifact');
    await cp(output, artifact, { recursive: true });
    await checkPublicEntryArtifact(artifact, manifestSha256(manifest));
    const repo = join(root, 'repo');
    execFileSync('git', ['init', '-q', repo]);
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@localhost'], {
      cwd: repo,
    });
    await writeFile(join(repo, 'README.md'), 'base\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: repo });
    const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repo,
      encoding: 'utf8',
    }).trim();
    const executable = join(root, 'fake-codex');
    await writeFile(
      executable,
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const final = args[args.indexOf('--output-last-message') + 1];
const sandbox = args[args.indexOf('--sandbox') + 1];
let prompt = '';
process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', () => {
  const id = prompt.match(/Goal: ([A-Za-z]+)/)?.[1] ?? 'unknown';
  setTimeout(() => {
    if (sandbox === 'workspace-write') fs.writeFileSync(id + '.txt', id + '\\n');
    fs.writeFileSync(final, JSON.stringify({status:'PASS',summary:id}));
  }, 150);
});

`,
    );
    await chmod(executable, 0o755);
    const brief = (id) => ({
      goal: id,
      context: 'relocated bundle test',
      scope: id,
      acceptanceCriteria: ['produce result'],
      verificationCommand: null,
      reportFormat: 'json',
      forbiddenActions: ['stay in scope'],
    });
    const readRequest = join(root, 'read-request.json');
    await writeFile(
      readRequest,
      JSON.stringify({
        runId: 'read-run',
        revision: 'base',
        workspaceRoot: repo,
        evidenceRoot: join(root, 'evidence'),
        maxConcurrency: 2,
        executable,
        timeoutMs: 5000,
        assignments: [
          {
            id: 'review',
            role: 'reviewer',
            required: true,
            brief: brief('review'),
          },
        ],
      }),
    );
    const runner = join(artifact, 'bin/codex-parallel.mjs');
    const read = await child([runner, readRequest]);
    assert.equal(read.route, 'read-only');
    assert.equal(read.status, 'PASS');
    assert.equal(
      JSON.parse(await readFile(read.receiptPath, 'utf8')).status,
      'PASS',
    );
    const invalidRequest = join(root, 'invalid-request.json');
    await writeFile(
      invalidRequest,
      JSON.stringify({
        ...JSON.parse(await readFile(readRequest, 'utf8')),
        runId: 'invalid-run',
        mode: 'write',
      }),
    );
    const rejected = await childResult([runner, invalidRequest], 1);
    assert.match(rejected.stderr, /mode is unsupported/);
    await assert.rejects(lstat(join(root, 'evidence', 'invalid-run')));

    const writeRequest = join(root, 'write-request.json');
    await writeFile(
      writeRequest,
      JSON.stringify({
        runId: 'write-run',
        sourceRepo: repo,
        baseCommit,
        evidenceRoot: join(root, 'evidence'),
        maxConcurrency: 2,
        executable,
        timeoutMs: 5000,
        verify: [
          {
            program: process.execPath,
            args: [
              '-e',
              "const fs=require('fs');if(!fs.existsSync('alpha.txt')||!fs.existsSync('beta.txt'))process.exit(5)",
            ],
          },
        ],
        assignments: ['alpha', 'beta'].map((id) => ({
          worker: { id, role: 'implementer', required: true, brief: brief(id) },
          owns: [{ kind: 'file', path: `${id}.txt` }],
        })),
      }),
    );
    const write = await child([runner, writeRequest]);
    assert.equal(write.route, 'write');
    assert.equal(write.status, 'PASS');
    assert.equal(
      await readFile(join(write.integrationPath, 'alpha.txt'), 'utf8'),
      'alpha\n',
    );
    assert.equal(
      await readFile(join(write.integrationPath, 'beta.txt'), 'utf8'),
      'beta\n',
    );
    assert.equal(
      execFileSync('git', ['status', '--porcelain'], {
        cwd: repo,
        encoding: 'utf8',
      }),
      '',
    );
    assert.equal(
      execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repo,
        encoding: 'utf8',
      }).trim(),
      baseCommit,
    );
    const receipt = JSON.parse(await readFile(write.receiptPath, 'utf8'));
    assert.equal(receipt.workerReceipt.peakConcurrency, 2);
    assert.equal(receipt.verification[0].code, 0);

    const {
      runLocalHostWorker,
      runLocalFeatureWorkerPair,
      verifyLocalFeatureWorkerPair,
    } = await import(
      pathToFileURL(join(artifact, 'host/local-worker.mjs')).href
    );
    const hostInput = {
      runId: 'host-review-run',
      revision: 'base',
      candidateRoot: repo,
      evidenceRoot: join(root, 'evidence'),
      baseCommit,
      executable,
      timeoutMs: 15000,
      assignment: {
        id: 'host-reviewer',
        role: 'reviewer',
        required: true,
        brief: brief('review'),
      },
    };
    const observedReview = await runLocalHostWorker(hostInput);
    assert.equal(observedReview.status, 'PASS');
    assert.equal(observedReview.route, 'read-only');
    assert.equal(observedReview.candidate.baseCommit, baseCommit);
    assert.notEqual(observedReview.worker.pid, process.pid);
    assert.equal(
      observedReview.receipt.sha256,
      createHash('sha256')
        .update(await readFile(observedReview.receipt.path))
        .digest('hex'),
    );
    assert.equal(
      observedReview.observationSha256,
      createHash('sha256')
        .update(await readFile(observedReview.observationPath))
        .digest('hex'),
    );
    await assert.rejects(
      runLocalHostWorker({
        ...hostInput,
        runId: 'spoofed-host-run',
        receiptPath: write.receiptPath,
      }),
      /Unexpected or missing JSON fields/,
    );
    await assert.rejects(lstat(join(root, 'evidence', 'spoofed-host-run')));
    await assert.rejects(
      runLocalHostWorker({
        ...hostInput,
        runId: 'invalid/revision',
        revision: 'base',
      }),
      /runId must be a safe identifier/,
    );
    await assert.rejects(
      runLocalHostWorker({
        ...hostInput,
        runId: 'nested-host-run',
        evidenceRoot: repo,
      }),
      /Candidate and worker evidence must be disjoint/,
    );
    await assert.rejects(lstat(join(repo, 'nested-host-run')));
    await writeFile(join(repo, 'untracked.txt'), 'dirty\n');
    await assert.rejects(
      runLocalHostWorker({ ...hostInput, runId: 'dirty-host-run' }),
      /Candidate must be clean/,
    );
    await unlink(join(repo, 'untracked.txt'));
    await assert.rejects(lstat(join(root, 'evidence', 'dirty-host-run')));

    const observedWrite = await runLocalHostWorker({
      ...hostInput,
      runId: 'host-write-run',
      assignment: {
        id: 'host-builder',
        role: 'implementer',
        required: true,
        brief: brief('gamma'),
      },
      owns: [{ kind: 'file', path: 'gamma.txt' }],
      verify: [
        {
          program: process.execPath,
          args: [
            '-e',
            "if(!require('fs').existsSync('gamma.txt'))process.exit(5)",
          ],
        },
      ],
    });
    assert.equal(observedWrite.status, 'PASS');
    assert.equal(observedWrite.route, 'write');
    assert.notEqual(observedWrite.worker.pid, observedReview.worker.pid);
    assert.match(observedWrite.integratedCommit, /^[0-9a-f]{40}$/);
    assert.equal(
      await readFile(join(observedWrite.integrationPath, 'gamma.txt'), 'utf8'),
      'gamma\n',
    );
    assert.equal(
      execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repo,
        encoding: 'utf8',
      }).trim(),
      baseCommit,
    );

    const pairInput = {
      runId: 'feature-pair',
      revision: 'feature-request',
      candidateRoot: repo,
      evidenceRoot: join(root, 'evidence'),
      baseCommit,
      executable,
      timeoutMs: 5000,
      builder: {
        id: 'pair-builder',
        role: 'implementer',
        required: true,
        brief: brief('delta'),
      },
      owns: [{ kind: 'file', path: 'delta.txt' }],
      verify: [
        {
          program: process.execPath,
          args: [
            '-e',
            "if(!require('fs').existsSync('delta.txt'))process.exit(5)",
          ],
        },
      ],
      reviewer: {
        id: 'pair-reviewer',
        role: 'reviewer',
        required: true,
        brief: brief('review'),
      },
    };
    const pair = await runLocalFeatureWorkerPair(pairInput);
    assert.equal(pair.status, 'PASS');
    assert.notEqual(pair.builder.pid, pair.reviewer.pid);
    assert.equal(pair.reviewer.candidate.baseCommit, pair.integratedCommit);
    assert.equal(
      pair.reviewer.candidate.root,
      await realpath(
        join(
          root,
          'evidence',
          'feature-pair',
          'build',
          'feature-pair-build',
          'integration',
        ),
      ),
    );
    assert.equal(
      pair.reportSha256,
      createHash('sha256')
        .update(await readFile(pair.reportPath))
        .digest('hex'),
    );
    assert.equal(
      execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repo,
        encoding: 'utf8',
      }).trim(),
      baseCommit,
    );

    await symlink(executable, join(root, 'codex'));
    const publicWorkerRequest = {
      schemaVersion: 1,
      entry: 'temari',
      ...pairInput,
      runId: 'public-feature-pair',
    };
    delete publicWorkerRequest.executable;
    const publicWorkerBytes = Buffer.from(JSON.stringify(publicWorkerRequest));
    const publicWorkerPath = join(root, 'public-workers.json');
    await writeFile(publicWorkerPath, publicWorkerBytes);
    const publicWorkerArgs = [
      join(artifact, 'bin/temari.mjs'),
      'run-workers',
      '--request',
      publicWorkerPath,
      '--expected-request-sha256',
      createHash('sha256').update(publicWorkerBytes).digest('hex'),
      '--expected-manifest-sha256',
      manifestSha256(manifest),
    ];
    const publicResult = JSON.parse(
      (
        await childResult(publicWorkerArgs, 0, {
          PATH: `${root}:${process.env.PATH}`,
        })
      ).stdout,
    );
    assert.equal(publicResult.status, 'PASS');
    assert.deepEqual(publicResult.hostBinding, {
      entry: 'temari',
      policyId: 'temari-public-feature-v2',
      requestSha256: createHash('sha256')
        .update(publicWorkerBytes)
        .digest('hex'),
      manifestSha256: manifestSha256(manifest),
    });
    assert.notEqual(publicResult.builder.pid, publicResult.reviewer.pid);
    assert.equal(
      publicResult.reviewer.candidate.baseCommit,
      publicResult.integratedCommit,
    );
    const retainedPair = {
      runId: publicWorkerRequest.runId,
      revision: publicWorkerRequest.revision,
      candidateRoot: repo,
      evidenceRoot: join(root, 'evidence'),
      baseCommit,
      hostBinding: publicResult.hostBinding,
      reportSha256: publicResult.reportSha256,
    };
    assert.equal(
      (await verifyLocalFeatureWorkerPair(retainedPair)).integratedCommit,
      publicResult.integratedCommit,
    );
    const wrongDigest = [...publicWorkerArgs];
    wrongDigest[5] = '0'.repeat(64);
    const rejectedWorkers = await childResult(wrongDigest, 1, {
      PATH: `${root}:${process.env.PATH}`,
    });
    assert.match(rejectedWorkers.stderr, /Request bytes differ/);
    const spoofedWorkerRequest = {
      ...publicWorkerRequest,
      runId: 'public-spoofed-pair',
      executable,
    };
    const spoofedWorkerBytes = Buffer.from(
      JSON.stringify(spoofedWorkerRequest),
    );
    const spoofedWorkerPath = join(root, 'spoofed-public-workers.json');
    await writeFile(spoofedWorkerPath, spoofedWorkerBytes);
    const spoofedWorkerArgs = [
      ...publicWorkerArgs.slice(0, 3),
      spoofedWorkerPath,
      publicWorkerArgs[4],
      createHash('sha256').update(spoofedWorkerBytes).digest('hex'),
      ...publicWorkerArgs.slice(6),
    ];
    const rejectedExecutable = await childResult(spoofedWorkerArgs, 1, {
      PATH: `${root}:${process.env.PATH}`,
    });
    assert.match(
      rejectedExecutable.stderr,
      /Request has unknown or missing fields/,
    );
    await assert.rejects(lstat(join(root, 'evidence', 'public-spoofed-pair')));
    const retainedBuilder = JSON.parse(
      await readFile(publicResult.builder.observationPath, 'utf8'),
    );
    await writeFile(retainedBuilder.process.path, 'tampered');
    await assert.rejects(
      verifyLocalFeatureWorkerPair(retainedPair),
      /Expected values to be strictly equal/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('host forge gate observes repository access and exact pull-request head', async (t) => {
  if (process.platform === 'win32')
    return t.skip('The fake gh fixture is a POSIX executable script.');
  const root = await mkdtemp(join(tmpdir(), 'temari-forge-'));
  try {
    const artifact = join(root, 'artifact');
    await cp(output, artifact, { recursive: true });
    const repo = join(root, 'repo');
    execFileSync('git', ['init', '-q', repo]);
    execFileSync('git', [
      '-C',
      repo,
      'remote',
      'add',
      'origin',
      'git@github.com:test/repo.git',
    ]);
    const fakeGh = join(root, 'gh');
    await writeFile(
      fakeGh,
      `#!/usr/bin/env node
const args = process.argv.slice(2).join(' ');
if (args === 'api user --jq .login') console.log('test-user');
else if (args === 'api repos/test/repo') console.log(JSON.stringify({full_name:'test/repo',html_url:'https://github.com/test/repo',permissions:{push:true}}));
else if (args === 'api repos/test/repo/pulls/7') console.log(JSON.stringify({html_url:'https://github.com/test/repo/pull/7',base:{repo:{full_name:'test/repo'}},head:{sha:'${'a'.repeat(40)}'},state:'open'}));
else process.exit(3);
`,
    );
    await chmod(fakeGh, 0o755);
    const moduleUrl = pathToFileURL(join(artifact, 'host/forge.mjs')).href;
    const runForge = (commit, expectedCode = 0) =>
      childResult(
        [
          '--input-type=module',
          '-e',
          `import {observeLocalForge,verifyLocalPullRequest} from '${moduleUrl}'; const proof=observeLocalForge(process.argv[1]); console.log(JSON.stringify(verifyLocalPullRequest(proof,process.argv[2],'https://github.com/test/repo/pull/7')));`,
          repo,
          commit,
        ],
        expectedCode,
        { PATH: `${root}:${process.env.PATH}` },
      );
    const result = JSON.parse((await runForge('a'.repeat(40))).stdout);
    assert.equal(result.status, 'proven');
    assert.equal(result.integratedCommit, 'a'.repeat(40));
    assert.match(
      (await runForge('b'.repeat(40), 1)).stderr,
      /Pull request head differs from the integrated commit/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('feature host proof requires architect, builder, reviewer, and forge evidence', async (t) => {
  if (process.platform === 'win32')
    return t.skip('The fake host tools are POSIX executable scripts.');
  const root = await mkdtemp(join(tmpdir(), 'temari-feature-proof-'));
  try {
    const artifact = join(root, 'artifact');
    await cp(output, artifact, { recursive: true });
    const repo = join(root, 'repo');
    execFileSync('git', ['init', '-q', repo]);
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@localhost'], {
      cwd: repo,
    });
    await writeFile(join(repo, 'README.md'), 'base\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: repo });
    execFileSync('git', [
      '-C',
      repo,
      'remote',
      'add',
      'origin',
      'git@github.com:test/repo.git',
    ]);
    const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repo,
      encoding: 'utf8',
    }).trim();
    const evidenceRoot = join(root, 'evidence');
    await mkdir(evidenceRoot);
    const fakeGh = join(root, 'gh');
    await writeFile(
      fakeGh,
      `#!/usr/bin/env node
const args = process.argv.slice(2).join(' ');
if (args === 'api user --jq .login') console.log('test-user');
else if (args === 'api repos/test/repo') console.log(JSON.stringify({full_name:'test/repo',html_url:'https://github.com/test/repo',permissions:{push:true}}));
else process.exit(3);
`,
    );
    await chmod(fakeGh, 0o755);
    const executable = join(root, 'fake-codex');
    await writeFile(
      executable,
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const final = args[args.indexOf('--output-last-message') + 1];
const sandbox = args[args.indexOf('--sandbox') + 1];
let prompt = '';
process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', () => {
  const id = prompt.match(/Goal: ([A-Za-z]+)/)?.[1] ?? 'unknown';
  if (sandbox === 'workspace-write') fs.writeFileSync(id + '.txt', id + '\\n');
  fs.writeFileSync(final, JSON.stringify({status:'PASS',summary:id}));
});
`,
    );
    await chmod(executable, 0o755);
    const brief = (id) => ({
      goal: id,
      context: 'feature proof test',
      scope: id,
      acceptanceCriteria: ['produce result'],
      verificationCommand: null,
      reportFormat: 'json',
      forbiddenActions: ['stay in scope'],
    });
    const hostBinding = {
      entry: 'temari',
      policyId: 'temari-public-feature-v2',
      requestSha256: 'a'.repeat(64),
      manifestSha256: manifestSha256(manifest),
    };
    const input = {
      runId: 'feature-proof',
      revision: 'selected-revision',
      candidateRoot: repo,
      evidenceRoot,
      baseCommit,
      executable,
      timeoutMs: 5000,
      hostBinding,
      architect: {
        id: 'architect',
        role: 'investigator',
        required: true,
        brief: brief('design'),
      },
      builder: {
        id: 'builder',
        role: 'implementer',
        required: true,
        brief: brief('delta'),
      },
      owns: [{ kind: 'file', path: 'delta.txt' }],
      verify: [
        {
          program: process.execPath,
          args: [
            '-e',
            "if(!require('fs').existsSync('delta.txt'))process.exit(5)",
          ],
        },
      ],
      reviewer: {
        id: 'reviewer',
        role: 'reviewer',
        required: true,
        brief: brief('review'),
      },
    };
    const moduleUrl = pathToFileURL(
      join(artifact, 'host/feature-proof.mjs'),
    ).href;
    const requestPath = join(root, 'feature-input.json');
    await writeFile(requestPath, JSON.stringify(input));
    const script = `import {readFileSync} from 'node:fs'; import {runLocalFeatureHostProof,verifyLocalFeatureHostProof} from '${moduleUrl}'; const input=JSON.parse(readFileSync(process.argv[1],'utf8')); const result=process.argv[2]==='run' ? await runLocalFeatureHostProof(input) : await verifyLocalFeatureHostProof(input); console.log(JSON.stringify(result));`;
    const call = (mode, path, code = 0) =>
      childResult(['--input-type=module', '-e', script, path, mode], code, {
        PATH: `${root}:${process.env.PATH}`,
      });
    const proof = JSON.parse((await call('run', requestPath)).stdout);
    assert.equal(proof.status, 'proven');
    assert.equal(
      new Set([proof.architect.pid, proof.integratedCommit]).size,
      2,
    );
    const verifyInput = {
      runId: input.runId,
      revision: input.revision,
      candidateRoot: repo,
      evidenceRoot,
      baseCommit,
      hostBinding,
      proofSha256: proof.proofSha256,
    };
    const verifyPath = join(root, 'verify-input.json');
    await writeFile(verifyPath, JSON.stringify(verifyInput));
    assert.equal(
      JSON.parse((await call('verify', verifyPath)).stdout).integratedCommit,
      proof.integratedCommit,
    );
    await writeFile(proof.architect.observationPath, 'tampered');
    assert.match(
      (await call('verify', verifyPath, 1)).stderr,
      /Expected values to be strictly equal/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const trackingMode of [
  'untracked',
  'tracked',
  'worker-failure',
  'duplicate-start',
]) {
  test(`full feature start binds local host proof to six persisted stages (${trackingMode})`, async (t) => {
    if (process.platform === 'win32')
      return t.skip('The fake host tools are POSIX executable scripts.');
    const root = await mkdtemp(join(tmpdir(), 'temari-feature-start-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const artifact = join(root, 'artifact');
    await cp(output, artifact, { recursive: true });
    const candidate = join(root, 'candidate');
    execFileSync('git', ['init', '-q', candidate]);
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: candidate });
    execFileSync('git', ['config', 'user.email', 'test@localhost'], {
      cwd: candidate,
    });
    await writeFile(join(candidate, 'README.md'), 'base\n');
    execFileSync('git', ['add', 'README.md'], { cwd: candidate });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: candidate });
    execFileSync('git', [
      '-C',
      candidate,
      'remote',
      'add',
      'origin',
      'git@github.com:test/repo.git',
    ]);
    const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: candidate,
      encoding: 'utf8',
    }).trim();
    const evidenceRoot = join(root, 'worker-evidence');
    await mkdir(evidenceRoot);
    const integrationPath = join(
      evidenceRoot,
      'feature-start-workers',
      'build',
      'feature-start-workers-build',
      'integration',
    );
    const fakeGh = join(root, 'gh');
    await writeFile(
      fakeGh,
      `#!/usr/bin/env node
const {execFileSync} = require('node:child_process');
require('node:fs').appendFileSync(process.env.FAKE_FORGE_LOG, 'forge\\n');
const args = process.argv.slice(2).join(' ');
if (args === 'api user --jq .login') console.log('test-user');
else if (args === 'api repos/test/repo') console.log(JSON.stringify({full_name:'test/repo',html_url:'https://github.com/test/repo',permissions:{push:true}}));
else if (args === 'api repos/test/repo/pulls/7') console.log(JSON.stringify({html_url:'https://github.com/test/repo/pull/7',base:{repo:{full_name:'test/repo'}},head:{sha:execFileSync('git',['-C',process.env.FAKE_INTEGRATION_PATH,'rev-parse','HEAD'],{encoding:'utf8'}).trim()},state:'open'}));
else process.exit(3);
`,
    );
    await chmod(fakeGh, 0o755);
    const fakeCodex = join(root, 'codex');
    await writeFile(
      fakeCodex,
      `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.FAKE_WORKER_LOG, 'worker\\n');
const args = process.argv.slice(2);
const final = args[args.indexOf('--output-last-message') + 1];
const sandbox = args[args.indexOf('--sandbox') + 1];
let prompt = '';
process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', () => {
  const finish = () => {
  const id = prompt.match(/Goal: ([A-Za-z]+)/)?.[1] ?? 'unknown';
  if (sandbox === 'workspace-write') fs.writeFileSync(id + '.txt', id + '\\n');
  fs.writeFileSync(final, JSON.stringify({status:process.env.FAKE_WORKER_FAIL === 'yes' ? 'ISSUES' : 'PASS',summary:id}));
  };
  if (process.env.FAKE_WAIT_GATE && !fs.existsSync(process.env.FAKE_WAIT_GATE)) {
    const timer = setInterval(() => {
      if (!fs.existsSync(process.env.FAKE_WAIT_GATE)) return;
      clearInterval(timer);
      finish();
    }, 10);
  } else finish();
});
`,
    );
    await chmod(fakeCodex, 0o755);
    const brief = (id) => ({
      goal: id,
      context: 'feature lifecycle test',
      scope: id,
      acceptanceCriteria: ['produce result'],
      verificationCommand: null,
      reportFormat: 'json',
      forbiddenActions: ['stay in scope'],
    });
    const runDirectory = join(root, 'run');
    const featureRequest = {
      ...request('temari'),
      invocation: {
        runId: 'feature-start',
        revision: 'selected-feature',
        candidate: { scopeId: 'feature-candidate', root: candidate },
        runDirectory,
      },
      featureWorkers: {
        evidenceRoot,
        baseCommit,
        timeoutMs: 5000,
        architect: {
          id: 'architect',
          role: 'investigator',
          required: true,
          brief: brief('design'),
        },
        builder: {
          id: 'builder',
          role: 'implementer',
          required: true,
          brief: brief('delta'),
        },
        owns: [{ kind: 'file', path: 'delta.txt' }],
        verify: [
          {
            program: process.execPath,
            args: [
              '-e',
              "if(!require('fs').existsSync('delta.txt'))process.exit(5)",
            ],
          },
        ],
        reviewer: {
          id: 'reviewer',
          role: 'reviewer',
          required: true,
          brief: brief('review'),
        },
      },
    };
    const requestBytes = Buffer.from(JSON.stringify(featureRequest));
    const requestPath = join(root, 'request.json');
    await writeFile(requestPath, requestBytes);
    const fixture = {
      root,
      artifact,
      candidate,
      runDirectory,
      request: featureRequest,
    };
    let tracking =
      trackingMode === 'untracked'
        ? null
        : await installedTracking(fixture, {
            schemaVersion: 2,
            expected: {
              runId: featureRequest.invocation.runId,
              revision: featureRequest.invocation.revision,
              runDirectory: join(await realpath(root), 'run'),
              sourceCandidateRoot: await realpath(candidate),
              requestSha256: digest(requestBytes),
              manifestSha256: manifestSha256(manifest),
            },
          });
    const launch = (mode, extra = tracking?.args ?? []) => {
      const child = spawn(
        process.execPath,
        [
          join(artifact, 'bin/temari.mjs'),
          mode,
          '--request',
          requestPath,
          '--expected-request-sha256',
          digest(requestBytes),
          '--expected-manifest-sha256',
          manifestSha256(manifest),
          ...extra,
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            PATH: `${root}:${process.env.PATH}`,
            FAKE_INTEGRATION_PATH: integrationPath,
            FAKE_FORGE_LOG: join(root, 'forge-calls.log'),
            FAKE_WORKER_LOG: join(root, 'worker-calls.log'),
            FAKE_WORKER_FAIL: trackingMode === 'worker-failure' ? 'yes' : 'no',
            FAKE_WAIT_GATE:
              trackingMode === 'duplicate-start'
                ? join(root, 'release-workers')
                : '',
            NODE_OPTIONS: '',
            NODE_PATH: '',
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      let buffer = '';
      let stderr = '';
      const messages = [];
      let waiter;
      child.stderr.setEncoding('utf8').on('data', (part) => (stderr += part));
      child.stdout.setEncoding('utf8').on('data', (part) => {
        buffer += part;
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const message = JSON.parse(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
          if (waiter) {
            clearTimeout(waiter.timer);
            waiter.resolve(message);
            waiter = undefined;
          } else messages.push(message);
        }
      });
      const done = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code) => resolve(code));
      });
      t.after(async () => {
        if (child.exitCode === null) child.kill('SIGKILL');
        await done;
      });
      return {
        child,
        done,
        stderr: () => stderr,
        next: async () => {
          if (messages.length) return messages.shift();
          return new Promise((resolve, reject) => {
            waiter = {
              resolve,
              reject,
              timer: setTimeout(
                () => reject(new Error(`Feature stage timeout: ${stderr}`)),
                15000,
              ),
            };
          });
        },
      };
    };
    if (tracking) {
      for (const variant of [
        'wrong-digest',
        'wrong-request',
        'wrong-source',
        'evidence-overlap',
      ]) {
        let invalid = tracking;
        if (variant === 'wrong-digest')
          invalid = { args: [...tracking.args.slice(0, 3), '0'.repeat(64)] };
        else {
          const expected = { ...tracking.payload.expected };
          if (variant === 'wrong-request')
            expected.requestSha256 = '0'.repeat(64);
          if (variant === 'wrong-source')
            expected.sourceCandidateRoot = await realpath(evidenceRoot);
          invalid = await installedTracking(
            fixture,
            {
              ...tracking.payload,
              expected,
              ...(variant === 'evidence-overlap'
                ? { taskRoot: join(await realpath(evidenceRoot), 'tasks') }
                : {}),
            },
            variant,
          );
        }
        const rejected = launch('start', invalid.args);
        assert.notEqual(await rejected.done, 0, variant);
        await assert.rejects(lstat(join(root, 'forge-calls.log')), {
          code: 'ENOENT',
        });
        await assert.rejects(lstat(join(root, 'worker-calls.log')), {
          code: 'ENOENT',
        });
        assert.deepEqual(await readdir(evidenceRoot), []);
        await assert.rejects(lstat(tracking.payload.taskRoot), {
          code: 'ENOENT',
        });
      }
    }
    let session = launch('start');
    if (trackingMode === 'duplicate-start') {
      const deadline = Date.now() + 5000;
      while (true) {
        try {
          await lstat(join(root, 'worker-calls.log'));
          break;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          assert(
            Date.now() < deadline,
            'Original feature worker did not start.',
          );
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      const before = (await installedTask(fixture, tracking)).task;
      assert.equal(before.version, 2);
      const workersBefore = await readFile(join(root, 'worker-calls.log'));
      const forgeBefore = await readFile(join(root, 'forge-calls.log'));
      const duplicate = launch('start');
      assert.notEqual(await duplicate.done, 0);
      assert.match(duplicate.stderr(), /reserved|already/i);
      assert.deepEqual((await installedTask(fixture, tracking)).task, before);
      assert.deepEqual(
        await readFile(join(root, 'worker-calls.log')),
        workersBefore,
      );
      assert.deepEqual(
        await readFile(join(root, 'forge-calls.log')),
        forgeBefore,
      );
      await writeFile(join(root, 'release-workers'), 'continue\n');
    }
    if (trackingMode === 'worker-failure') {
      assert.notEqual(await session.done, 0);
      const failed = await installedTask(fixture, tracking);
      assert.equal(failed.task.version, 3);
      assert.match(failed.task.handoff.summary, /interrupted/i);
      assert.equal((await failed.pickup()).selected.status, 'BLOCKED');
      const canonicalEvidenceRoot = await realpath(evidenceRoot);
      assert(
        failed.task.handoff.contextRefs.some((ref) =>
          ref.location.startsWith(canonicalEvidenceRoot),
        ),
      );
      await assert.rejects(lstat(runDirectory), { code: 'ENOENT' });
      const workersBefore = await readFile(join(root, 'worker-calls.log'));
      const forgeBefore = await readFile(join(root, 'forge-calls.log'));
      const omitted = launch('start', []);
      assert.notEqual(await omitted.done, 0);
      assert.match(omitted.stderr(), /task-tracked/);
      assert.deepEqual(
        await readFile(join(root, 'worker-calls.log')),
        workersBefore,
      );
      assert.deepEqual(
        await readFile(join(root, 'forge-calls.log')),
        forgeBefore,
      );
      return;
    }
    let resumed = false;
    const seen = [];
    while (true) {
      const message = await session.next();
      if (message.type === 'complete') {
        assert.equal(message.status, 'PASS', session.stderr());
        break;
      }
      if (message.type !== 'stage') continue;
      if (message.stage === 'plan' && !resumed) {
        session.child.kill('SIGKILL');
        await session.done;
        if (tracking) {
          const retained = await installedTask(fixture, tracking);
          assert.equal(retained.task.workspaceRoot, await realpath(candidate));
          assert.notEqual(
            retained.task.workspaceRoot,
            await realpath(integrationPath),
          );
          const omitted = launch('resume', []);
          assert.notEqual(await omitted.done, 0);
          assert.match(omitted.stderr(), /task-tracked/);
          const switched = await installedTracking(
            fixture,
            {
              ...tracking.payload,
              taskId: 'switched-goal',
            },
            'switched-feature',
          );
          assert.notEqual(await launch('resume', switched.args).done, 0);
          tracking = await installedTracking(
            fixture,
            {
              ...tracking.payload,
              expectedVersion: retained.task.version,
              create: undefined,
              idempotencyKey: 'installed-feature-resume',
              session: {
                host: 'codex',
                sessionId: 'installed-feature-chat-two',
              },
            },
            'resume-feature',
          );
        }
        session = launch('resume');
        resumed = true;
        continue;
      }
      seen.push(message.stage);
      const sourceRequired = ['investigate', 'plan', 'deliver'].includes(
        message.stage,
      );
      await writeFile(
        join(message.workspace, 'observation.txt'),
        `stage ${message.stage}\n`,
      );
      if (sourceRequired)
        await writeFile(
          join(message.workspace, 'source.txt'),
          message.stage === 'deliver'
            ? JSON.stringify({
                pullRequestUrl: 'https://github.com/test/repo/pull/7',
              })
            : `documented ${message.stage}\n`,
        );
      await writeFile(
        join(message.workspace, 'host-result.json'),
        JSON.stringify({
          schemaVersion: 1,
          sessionId: message.sessionId,
          requestId: message.requestId,
          stage: message.stage,
          status: 'PASS',
          summary: `feature ${message.stage} complete`,
          evidence: [
            {
              name: 'observation',
              kind: 'verification',
              path: 'observation.txt',
            },
            ...(sourceRequired
              ? [{ name: 'source', kind: 'other', path: 'source.txt' }]
              : []),
          ],
        }),
      );
      session.child.stdin.write(
        JSON.stringify({
          type: 'result',
          sessionId: message.sessionId,
          requestId: message.requestId,
          stage: message.stage,
        }) + '\n',
      );
    }
    assert.equal(await session.done, 0, session.stderr());
    assert(resumed, 'Feature lifecycle did not resume.');
    assert.equal(
      (await readFile(join(root, 'worker-calls.log'), 'utf8'))
        .trim()
        .split('\n').length,
      3,
    );
    if (tracking) {
      const completed = await installedTask(fixture, tracking);
      assert.equal(completed.task.sessions.length, 2);
      assert.equal(
        completed.task.events.filter(
          (event) => event.change.type === 'task-entered',
        ).length,
        2,
      );
      assert.equal(completed.task.workspaceRoot, await realpath(candidate));
      assert.deepEqual(completed.task.runs, []);
      assert.equal(completed.task.acceptance, null);
      assert.match(completed.task.handoff.summary, /PASS/);
      assert.equal((await completed.pickup()).selected.status, 'OPEN');
    }
    assert.deepEqual(seen, [
      'investigate',
      'plan',
      'build',
      'review',
      'verify',
      'deliver',
    ]);
    assert.equal(
      execFileSync('git', ['-C', candidate, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim(),
      baseCommit,
    );
    const descriptor = JSON.parse(
      await readFile(join(runDirectory, 'config/input.json'), 'utf8'),
    );
    assert.deepEqual(descriptor.plan.requiredCapabilities, [
      'subagents',
      'forge',
    ]);
    assert.equal(descriptor.candidate.root, await realpath(integrationPath));
    const artifactRequire = createRequire(
      pathToFileURL(join(artifact, 'runtime/consumer.mjs')),
    );
    const runtime = await import(
      pathToFileURL(artifactRequire.resolve('@temari/runtime')).href
    );
    const current = await runtime.observeCandidate(descriptor.candidate);
    const currentBytes = Buffer.from(JSON.stringify(current));
    const currentPath = join(root, 'current.json');
    await writeFile(currentPath, currentBytes);
    const closeout = await childResult(
      [
        join(artifact, 'bin/closeout.mjs'),
        'verify',
        '--request',
        requestPath,
        '--expected-request-sha256',
        digest(requestBytes),
        '--expected-manifest-sha256',
        manifestSha256(manifest),
        '--expected-current',
        currentPath,
        '--expected-current-sha256',
        digest(currentBytes),
      ],
      0,
      {
        PATH: `${root}:${process.env.PATH}`,
        FAKE_INTEGRATION_PATH: integrationPath,
        FAKE_FORGE_LOG: join(root, 'forge-calls.log'),
      },
    );
    assert.equal(JSON.parse(closeout.stdout).status, 'candidate-verified');
  });
}

test('both engineering skills reach the complete versioned QA writer inside the artifact', async () => {
  for (const entry of ['temari', 'poteto-mode']) {
    const visited = new Set();
    const visit = async (path) => {
      if (visited.has(path)) return;
      visited.add(path);
      const bytes = await readFile(join(output, path));
      const artifactRecord = manifest.files.find((file) => file.path === path);
      assert(artifactRecord, `Unmanifested skill resource: ${path}`);
      assert.equal(
        artifactRecord.sha256,
        createHash('sha256').update(bytes).digest('hex'),
      );
      for (const [, link] of bytes.toString().matchAll(/\]\(([^)]+)\)/g)) {
        if (/^[a-z][a-z\d+.-]*:|^#/i.test(link)) continue;
        const target = fileURLToPath(
          new URL(link, pathToFileURL(join(output, path))),
        );
        const resource = relative(output, target).split('\\').join('/');
        assert(
          resource.startsWith('skills/'),
          `Link escapes bundled skills: ${link}`,
        );
        await visit(resource);
      }
    };
    await visit(`skills/${entry}/SKILL.md`);
    for (const resource of [
      'SKILL.md',
      'CHANGELOG.md',
      'references/maintenance.md',
      'assets/ticket-comment.md',
      'assets/ticket-verification.md',
      'assets/release-qa-report.md',
    ]) {
      const path = `skills/qa-review-verification/${resource}`;
      assert(
        visited.has(path),
        `Unreachable QA resource from ${entry}: ${resource}`,
      );
      assert(
        manifest.source.files.some(
          (file) => file.path === `packages/workflow-runtime/public/${path}`,
        ),
      );
    }
    const skill = await readFile(
      join(output, 'skills/qa-review-verification/SKILL.md'),
      'utf8',
    );
    const frontmatter = skill.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    assert(frontmatter, 'Missing QA skill frontmatter');
    assert.match(frontmatter[1], /^name: qa-review-verification$/m);
    assert.match(frontmatter[1], /^description: .+$/m);
    assert.match(
      frontmatter[1],
      /^metadata:\r?\n  version: (['"]?)\d+\.\d+\.\d+\1$/m,
    );
  }
});

test('installed overlay checker accepts pinned external assets and refuses incompatible overlays', async () => {
  const checker = join(output, 'bin/overlay-check.mjs');
  const publicDigest = manifestSha256(manifest);
  const absent = await child([
    checker,
    '--expected-manifest-sha256',
    publicDigest,
  ]);
  assert.equal(absent.status, 'compatible');
  assert.equal(absent.overlayId, null);

  const overlayRoot = await mkdtemp(join(tmpdir(), 'temari-overlay-'));
  const assetPath = 'knowledge/context.md';
  const assetBytes = Buffer.from('Sanitized overlay fixture.\n');
  const assetFile = join(overlayRoot, assetPath);
  const overlayManifest = {
    schemaVersion: 1,
    overlayId: 'fixture-overlay',
    compatiblePublicManifestSha256: publicDigest,
    assets: [
      {
        path: assetPath,
        kind: 'knowledge',
        sha256: createHash('sha256').update(assetBytes).digest('hex'),
        bytes: assetBytes.length,
      },
    ],
    credentialRefs: [
      {
        id: 'model',
        provider: 'openai',
        handle: 'credential-ref:fixture-model',
      },
    ],
  };
  const run = async (value, expectedCode = 0) => {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
    await writeFile(join(overlayRoot, 'temari-overlay.json'), bytes);
    return childResult(
      [
        checker,
        '--expected-manifest-sha256',
        publicDigest,
        '--overlay-root',
        overlayRoot,
        '--expected-overlay-sha256',
        createHash('sha256').update(bytes).digest('hex'),
      ],
      expectedCode,
    );
  };
  try {
    await mkdir(join(overlayRoot, 'knowledge'));
    await writeFile(assetFile, assetBytes);
    const accepted = await run(overlayManifest);
    assert.equal(accepted.code, 0);
    const report = JSON.parse(accepted.stdout);
    assert.equal(report.overlayId, 'fixture-overlay');
    assert.equal(report.assetCount, 1);
    assert.equal(report.credentialReferenceCount, 1);
    assert(!accepted.stdout.includes('fixture-model'));

    await writeFile(assetFile, 'Changed overlay fixture.\n');
    assert.equal((await run(overlayManifest, 1)).code, 1);
    await writeFile(assetFile, assetBytes);
    assert.equal(
      (
        await run(
          {
            ...overlayManifest,
            compatiblePublicManifestSha256: '0'.repeat(64),
          },
          1,
        )
      ).code,
      1,
    );
    assert.equal(
      (
        await run(
          {
            ...overlayManifest,
            credentialRefs: [
              {
                ...overlayManifest.credentialRefs[0],
                value: 'forbidden-secret',
              },
            ],
          },
          1,
        )
      ).code,
      1,
    );
    assert.equal(
      (
        await run(
          {
            ...overlayManifest,
            assets: [{ ...overlayManifest.assets[0], path: '../outside.md' }],
          },
          1,
        )
      ).code,
      1,
    );
    await writeFile(join(overlayRoot, 'undeclared.txt'), 'extra');
    assert.equal((await run(overlayManifest, 1)).code, 1);
  } finally {
    await rm(overlayRoot, { recursive: true, force: true });
  }
});

test('public policy records the exact reviewed legacy profile and playbook provenance', async () => {
  const policy = JSON.parse(
    await readFile(join(output, 'policy.json'), 'utf8'),
  );
  assert.equal(policy.policyId, 'temari-public-feature-v2');
  assert.deepEqual(policy.feature.unsupportedRoutes, ['qa-review']);
  const sha256 = (text) => createHash('sha256').update(text).digest('hex');
  const profile = await readFile(
    join(
      repository,
      'packages/workflow-runtime/assets/v4.1/skills/poteto-mode/playbook-contracts/v1/feature.json',
    ),
    'utf8',
  );
  const playbook = await readFile(
    join(
      repository,
      'packages/workflow-runtime/assets/v4.1/skills/poteto-mode/playbooks/feature.md',
    ),
    'utf8',
  );
  assert.equal(
    sha256(profile.replace(/\r\n?/g, '\n')),
    policy.feature.source.profileSha256,
  );
  assert.equal(
    sha256(playbook.replace(/\r\n?/g, '\n')),
    policy.feature.source.playbookSha256,
  );
  const lightweightProfile = await readFile(
    join(
      repository,
      'packages/workflow-runtime/assets/v4.1/skills/poteto-mode/playbook-contracts/v1/lightweight-engineering.json',
    ),
    'utf8',
  );
  const lightweightPlaybook = await readFile(
    join(
      repository,
      'packages/workflow-runtime/assets/v4.1/skills/poteto-mode/playbooks/lightweight-engineering.md',
    ),
    'utf8',
  );
  assert.equal(
    sha256(lightweightProfile.replace(/\r\n?/g, '\n')),
    policy.lightweight.source.profileSha256,
  );
  assert.equal(
    sha256(lightweightPlaybook.replace(/\r\n?/g, '\n')),
    policy.lightweight.source.playbookSha256,
  );
  const requirementIds = JSON.parse(lightweightProfile).stages.flatMap(
    (stage) => stage.requirements.map((requirement) => requirement.id),
  );
  assert.deepEqual(
    [...new Set(Object.values(policy.lightweight.stageMapping).flat())].sort(),
    requirementIds.sort(),
  );
  assert.deepEqual(Object.keys(policy.lightweight.stageMapping), [
    'investigate',
    'plan',
    'build',
    'review',
    'verify',
    'deliver',
  ]);
  assert.equal(policy.lightweight.publishGate, 'operator-approval');
});

test('artifact checking requires an external expected manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari public-entry-untrusted-'));
  try {
    const artifact = join(root, 'artifact');
    await cp(output, artifact, { recursive: true });
    const policyPath = join(artifact, 'policy.json');
    const policy = JSON.parse(await readFile(policyPath, 'utf8'));
    policy.feature.source.playbookSha256 = '0'.repeat(64);
    const policyBytes = Buffer.from(`${JSON.stringify(policy, null, 2)}\n`);
    await writeFile(policyPath, policyBytes);

    const manifestPath = join(artifact, 'public-entry-manifest.json');
    const rewrittenManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const policyRecord = rewrittenManifest.files.find(
      (record) => record.path === 'policy.json',
    );
    policyRecord.sha256 = createHash('sha256')
      .update(policyBytes)
      .digest('hex');
    policyRecord.bytes = policyBytes.byteLength;
    await writeFile(
      manifestPath,
      `${JSON.stringify(rewrittenManifest, null, 2)}\n`,
    );

    await assert.rejects(
      checkPublicEntryArtifact(artifact),
      /external expected manifest/i,
    );
    await assert.rejects(
      checkPublicEntryArtifact(artifact, manifestSha256(manifest)),
      /external expected digest/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('public engineering admission refuses unsupported routes and blocks unproven capabilities', async () => {
  const requestPath = join(buildRoot, 'feature-request.json');
  await writeFile(requestPath, JSON.stringify(request('temari')));
  const temari = await child(
    [join(output, 'bin/temari.mjs'), 'admit', '--request', requestPath],
    1,
  );
  assert.equal(temari.status, 'blocked');
  assert.deepEqual(temari.missingCapabilities, ['subagents', 'forge']);
  assert.deepEqual(temari.reasons, ['host-capability-proof-missing']);

  const poteto = await child(
    [join(output, 'bin/poteto-mode.mjs'), 'admit', '--request', requestPath],
    1,
  );
  assert.equal(poteto.status, 'rejected');
  assert(poteto.reasons.includes('entry-mismatch'));

  await writeFile(
    requestPath,
    JSON.stringify(
      request('poteto-mode', {
        route: 'lightweight-engineering',
        profile: 'lightweight-engineering',
      }),
    ),
  );
  const lightweight = await child(
    [join(output, 'bin/poteto-mode.mjs'), 'admit', '--request', requestPath],
    1,
  );
  assert.equal(lightweight.status, 'rejected');
  assert(lightweight.reasons.includes('profile-not-admitted'));
});

test('installed skills keep worker contract host-neutral and bundle the Codex adapter separately', async () => {
  const temariSkill = await readFile(
    join(output, 'skills/temari/SKILL.md'),
    'utf8',
  );
  const potetoSkill = await readFile(
    join(output, 'skills/poteto-mode/SKILL.md'),
    'utf8',
  );
  const guide = await readFile(
    join(output, 'adapters/codex/parallel-workers.md'),
    'utf8',
  );
  assert.match(temariSkill, /selected host adapter/);
  assert.match(potetoSkill, /selected host adapter/);
  assert.doesNotMatch(temariSkill, /codex-parallel-workers|local Codex/i);
  assert.doesNotMatch(potetoSkill, /codex-parallel-workers|local Codex/i);
  assert.match(guide, /^# Codex host adapter:/);
  assert.match(guide, /version-2 sidecar/);
  const trackingLink = guide.match(/\[task tracking\]\(([^)]+)\)/);
  assert(trackingLink, 'the moved guide retains the modern tracking reference');
  assert.equal(
    await readFile(join(output, 'adapters/codex', trackingLink[1]), 'utf8'),
    await readFile(join(output, 'skills/temari/references/task-tracking.md'), 'utf8'),
  );
  await assert.rejects(
    lstat(join(output, 'skills/poteto-mode/references/codex-parallel-workers.md')),
    { code: 'ENOENT' },
  );
  assert.match(guide, /bin\/codex-parallel\.mjs/);
  assert((await lstat(join(output, 'bin/codex-parallel.mjs'))).isFile());
});

test('closeout preflight blocks without trusted candidate selection', async () => {
  const closeout = await child(
    [
      join(output, 'bin/closeout.mjs'),
      'admit',
      '--run-directory',
      join(buildRoot, 'run'),
    ],
    1,
  );
  assert.equal(closeout.status, 'blocked');
  assert.deepEqual(closeout.reasons, [
    'trusted-invocation-and-current-candidate-selection-required',
  ]);
});

test('public entries refuse symlinked policy and request inputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari public-entry-inputs-'));
  try {
    const artifact = join(root, 'artifact');
    await cp(output, artifact, { recursive: true });
    const policyPath = join(artifact, 'policy.json');
    const policyTarget = join(root, 'policy-target.json');
    await rename(policyPath, policyTarget);
    await symlink(policyTarget, policyPath);
    const policyResult = await childResult(
      [join(artifact, 'bin/temari.mjs'), 'policy'],
      1,
    );
    assert.match(
      policyResult.stderr,
      /regular file|symbolic|symlink|nofollow/i,
    );

    await unlink(policyPath);
    await writeFile(policyPath, await readFile(policyTarget));
    const requestTarget = join(root, 'request-target.json');
    const requestPath = join(root, 'request.json');
    await writeFile(requestTarget, JSON.stringify(request('temari')));
    await symlink(requestTarget, requestPath);
    const requestResult = await childResult(
      [join(artifact, 'bin/temari.mjs'), 'admit', '--request', requestPath],
      1,
    );
    assert.match(
      requestResult.stderr,
      /regular file|symbolic|symlink|nofollow/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('failed publication removes staging and leaves no destination', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari public-entry-failure-'));
  try {
    const artifact = join(root, 'artifact');
    await assert.rejects(
      packagePublicEntries(artifact, {
        packageCanonical: async () => {
          throw new Error('injected canonical packaging failure');
        },
      }),
      /injected canonical packaging failure/,
    );
    await assert.rejects(lstat(artifact), { code: 'ENOENT' });
    const leftovers = await readdir(root);
    assert.deepEqual(leftovers, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('concurrent publication has one exclusive owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari public-entry-race-'));
  try {
    const artifact = join(root, 'artifact');
    const results = await Promise.allSettled([
      packagePublicEntries(artifact),
      packagePublicEntries(artifact),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].reason.message, /reserved|exists/i);
    const publishedManifest = fulfilled[0].value;
    assert.deepEqual(
      await checkPublicEntryArtifact(
        artifact,
        manifestSha256(publishedManifest),
      ),
      publishedManifest,
    );
    await assert.rejects(lstat(`${artifact}.publish-lock`), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('outer publication is no-overwrite and rejects tampering or symlinks', async () => {
  await assert.rejects(packagePublicEntries(output), /Output already exists/);

  const policyPath = join(output, 'policy.json');
  const policyBytes = await readFile(policyPath);
  const tampered = Buffer.from(policyBytes);
  tampered[tampered.length - 2] ^= 1;
  await writeFile(policyPath, tampered);
  await assert.rejects(
    checkPublicEntryArtifact(output, manifestSha256(manifest)),
    /inventory|digest|hash|policy/i,
  );
  await writeFile(policyPath, policyBytes);
  assert.deepEqual(
    await checkPublicEntryArtifact(output, manifestSha256(manifest)),
    manifest,
  );

  const symlinkPath = join(output, 'bin/temari.mjs');
  const entryBytes = await readFile(symlinkPath);
  await unlink(symlinkPath);
  await symlink('../policy.json', symlinkPath);
  await assert.rejects(
    checkPublicEntryArtifact(output, manifestSha256(manifest)),
    /Symlink/,
  );
  await unlink(symlinkPath);
  await writeFile(symlinkPath, entryBytes, { mode: 0o755 });
  assert.deepEqual(
    await checkPublicEntryArtifact(output, manifestSha256(manifest)),
    manifest,
  );
});

function lightweightRequest(entry, candidate, runDirectory) {
  return {
    schemaVersion: 1,
    entry,
    route: 'lightweight-engineering',
    profile: 'lightweight-engineering-v1',
    obligations: {
      workType: 'feature',
      delegation: 'none',
      review: 'self',
      evidence: 'revision-bound',
      delivery: 'local',
    },
    routeInput: {
      workType: 'feature',
      lightweight: {
        resultIsClearLocalAndReversible: true,
        changesSharedBoundary: false,
        isReportedDefect: false,
        hasUnexplainedSymptom: false,
        makesPerformanceClaim: false,
        isDesignChoice: false,
        isMigration: false,
        affectedCallersAreKnown: true,
        crossesArchitecturalBoundary: false,
        directCheckAvailable: true,
      },
    },
    invocation: {
      runId: 'installed-lightweight',
      revision: 'synthetic-candidate-v1',
      candidate: { scopeId: 'synthetic-product', root: candidate },
      runDirectory,
    },
  };
}

async function installedFixture(t, entry = 'temari') {
  const root = await mkdtemp(join(tmpdir(), 'temari installed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifact = join(root, 'artifact');
  await cp(output, artifact, { recursive: true });
  const candidate = join(root, 'candidate');
  await mkdir(candidate);
  await writeFile(join(candidate, 'product.txt'), 'pear\napple\n');
  const runDirectory = join(root, 'run');
  const request = lightweightRequest(entry, candidate, runDirectory);
  const requestPath = join(root, 'request.json');
  const requestBytes = Buffer.from(JSON.stringify(request));
  await writeFile(requestPath, requestBytes);
  const launch = (
    mode = 'start',
    digest = createHash('sha256').update(requestBytes).digest('hex'),
    loader,
    extra = [],
  ) => {
    const args = [
      ...(loader ? ['--experimental-loader', pathToFileURL(loader).href] : []),
      join(artifact, `bin/${entry}.mjs`),
      mode,
      '--request',
      requestPath,
      '--expected-request-sha256',
      digest,
      '--expected-manifest-sha256',
      manifestSha256(manifest),
      ...extra,
    ];
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    let tail = '';
    const messages = [];
    let pending;
    let closed = false;
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk;
    });
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      tail += chunk;
      let end;
      while ((end = tail.indexOf('\n')) !== -1) {
        const message = JSON.parse(tail.slice(0, end));
        tail = tail.slice(end + 1);
        if (pending) {
          clearTimeout(pending.timer);
          pending.resolve(message);
          pending = undefined;
        } else messages.push(message);
      }
    });
    const done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => {
        closed = true;
        if (pending) {
          clearTimeout(pending.timer);
          pending.reject(new Error(`Entry closed: ${code}: ${stderr}`));
          pending = undefined;
        }
        resolve({ code, stderr, messages });
      });
    });
    t.after(async () => {
      if (!closed) child.kill('SIGKILL');
      await done;
    });
    return {
      child,
      done,
      next: async () => {
        if (messages.length) return messages.shift();
        assert(!closed, stderr);
        return new Promise((resolve, reject) => {
          pending = {
            resolve,
            reject,
            timer: setTimeout(() => {
              pending = undefined;
              reject(new Error(`Stage timeout: ${stderr}`));
            }, 10_000),
          };
        });
      },
      reply(message) {
        child.stdin.write(
          JSON.stringify({
            type: 'result',
            sessionId: message.sessionId,
            requestId: message.requestId,
            stage: message.stage,
          }) + '\n',
        );
      },
    };
  };
  return {
    root,
    artifact,
    candidate,
    runDirectory,
    request,
    requestPath,
    requestBytes,
    launch,
  };
}

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function installedTracking(f, changes = {}, name = 'tracking') {
  const root = await realpath(f.root);
  const candidateRoot = await realpath(f.candidate);
  const payload = {
    schemaVersion: 1,
    taskRoot: join(root, 'tasks'),
    taskId: 'installed-goal',
    actor: 'temari-coordinator',
    session: { host: 'codex', sessionId: 'installed-chat-one' },
    expectedVersion: 0,
    idempotencyKey: 'installed-start',
    create: {
      title: 'Continue work through the installed entry',
      goal: 'Retain one goal across process loss and fresh chats.',
      workspaceRoot: candidateRoot,
    },
    expected: {
      runId: f.request.invocation.runId,
      revision: f.request.invocation.revision,
      runDirectory: join(root, 'run'),
      candidateRoot,
    },
    ...changes,
  };
  if (Object.hasOwn(changes, 'create') && changes.create === undefined)
    delete payload.create;
  const path = join(root, `${name}.json`);
  const bytes = JSON.stringify(payload);
  await writeFile(path, bytes);
  return {
    payload,
    path,
    args: [
      '--task-tracking',
      path,
      '--expected-task-tracking-sha256',
      digest(bytes),
    ],
  };
}

async function installedTask(f, tracking) {
  const require = createRequire(
    pathToFileURL(join(f.artifact, 'runtime/consumer.mjs')),
  );
  const runtime = await import(
    pathToFileURL(require.resolve('@temari/runtime')).href
  );
  const store = await runtime.FileTaskStore.openExisting(
    tracking.payload.taskRoot,
  );
  return {
    runtime,
    store,
    task: await store.load(tracking.payload.taskId),
    pickup: () =>
      new runtime.TaskRuntime({ store }).pickup({
        taskId: tracking.payload.taskId,
      }),
  };
}

for (const entry of ['temari', 'poteto-mode']) {
  test(`installed ${entry} retains task context through interruption and a fresh-chat resume`, async (t) => {
    const f = await installedFixture(t, entry);
    const tracking = await installedTracking(f);
    const first = f.launch('start', undefined, undefined, tracking.args);
    const stages = [];
    while (true) {
      const message = await first.next();
      if (message.type === 'checkpoint' && message.stage === 'build') break;
      if (message.type !== 'stage') continue;
      stages.push(message.stage);
      await answerStage(f, first, message);
    }
    first.child.stdin.end();
    assert.notEqual((await first.done).code, 0);
    const descriptor = await readFile(
      join(f.runDirectory, 'config/input.json'),
    );
    const interrupted = await installedTask(f, tracking);
    assert.equal(interrupted.task.version, 2);
    assert.match(interrupted.task.handoff.summary, /Starting or resuming/);
    assert(
      interrupted.task.handoff.contextRefs.some(
        (ref) => ref.kind === 'host-checkpoint',
      ),
    );
    assert.equal((await interrupted.pickup()).selected.status, 'OPEN');
    const omitted = await f.launch('resume').done;
    assert.notEqual(omitted.code, 0);
    assert.match(omitted.stderr, /task-tracked/);
    const switched = await installedTracking(
      f,
      { taskId: 'another-goal' },
      'switched',
    );
    assert.notEqual(
      (await f.launch('resume', undefined, undefined, switched.args).done).code,
      0,
    );
    const resumedTracking = await installedTracking(
      f,
      {
        expectedVersion: interrupted.task.version,
        create: undefined,
        idempotencyKey: 'installed-resume',
        session: { host: 'codex', sessionId: 'installed-chat-two' },
      },
      'resume-tracking',
    );
    const resumed = f.launch(
      'resume',
      undefined,
      undefined,
      resumedTracking.args,
    );
    while (true) {
      const message = await resumed.next();
      if (message.type === 'complete') {
        assert.equal(message.status, 'PASS');
        break;
      }
      if (message.type !== 'stage') continue;
      stages.push(message.stage);
      await answerStage(f, resumed, message);
    }
    const result = await resumed.done;
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(stages, [
      'investigate',
      'plan',
      'build',
      'review',
      'verify',
      'deliver',
    ]);
    assert.deepEqual(
      await readFile(join(f.runDirectory, 'config/input.json')),
      descriptor,
    );
    const completed = await installedTask(f, tracking);
    assert.equal(completed.task.version, 5);
    assert.equal(completed.task.sessions.length, 2);
    assert.deepEqual(completed.task.runs, []);
    assert.equal(completed.task.acceptance, null);
    assert.match(completed.task.handoff.summary, /PASS/);
    assert.equal((await completed.pickup()).selected.status, 'OPEN');
    assert(
      completed.task.handoff.contextRefs.some(
        (ref) => ref.kind === 'host-receipt-pending-closeout',
      ),
    );
    const terminal = await f.launch(
      'resume',
      undefined,
      undefined,
      resumedTracking.args,
    ).done;
    assert.notEqual(terminal.code, 0);
    assert.deepEqual((await installedTask(f, tracking)).task, completed.task);
  });
}

test('installed tracking rejects invalid selection and malformed flag pairs before stage work', async (t) => {
  for (const variant of [
    'missing-digest',
    'wrong-digest',
    'duplicate',
    'unknown',
    'wrong-run',
    'bundle-overlap',
    'stale-version',
  ]) {
    await t.test(variant, async (t) => {
      const f = await installedFixture(t);
      const tracking = await installedTracking(f);
      let args = tracking.args;
      if (variant === 'missing-digest') args = args.slice(0, 2);
      if (variant === 'wrong-digest')
        args = [...args.slice(0, 3), '0'.repeat(64)];
      if (variant === 'duplicate') args = [...args, ...args];
      if (variant === 'unknown') args = [...args, '--unexpected', 'value'];
      if (variant === 'wrong-run')
        args = (
          await installedTracking(f, {
            expected: { ...tracking.payload.expected, runId: 'unselected-run' },
          })
        ).args;
      if (variant === 'bundle-overlap')
        args = (
          await installedTracking(f, {
            taskRoot: join(await realpath(f.artifact), 'new-task-store'),
          })
        ).args;
      if (variant === 'stale-version')
        args = (
          await installedTracking(f, { expectedVersion: 7, create: undefined })
        ).args;
      const result = await f.launch('start', undefined, undefined, args).done;
      assert.notEqual(result.code, 0);
      assert(!result.messages.some((message) => message.type === 'stage'));
      assert.equal(
        await readFile(join(f.candidate, 'product.txt'), 'utf8'),
        'pear\napple\n',
      );
      await assert.rejects(lstat(tracking.payload.taskRoot), {
        code: 'ENOENT',
      });
      await assert.rejects(
        lstat(
          join(f.runDirectory, 'receipts/installed-lightweight.receipt.json'),
        ),
        { code: 'ENOENT' },
      );
    });
  }
});

test('task tracking is refused on QA, worker-only and admission commands', async (t) => {
  for (const command of ['qa', 'run-workers', 'admit']) {
    await t.test(command, async (t) => {
      const f = await installedFixture(t);
      const tracking = await installedTracking(f);
      const result = await f.launch(
        command,
        undefined,
        undefined,
        tracking.args,
      ).done;
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /tracking|digests|Usage/i);
      await assert.rejects(lstat(f.runDirectory), { code: 'ENOENT' });
      await assert.rejects(lstat(tracking.payload.taskRoot), {
        code: 'ENOENT',
      });
    });
  }
});

function canonicalReceipt(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalReceipt).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalReceipt(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

async function completeInstalledFixture(t) {
  const fixture = await installedFixture(t);
  const session = fixture.launch();
  while (true) {
    const message = await session.next();
    if (message.type === 'complete') {
      assert.equal(message.status, 'PASS');
      break;
    }
    if (message.type === 'stage') await answerStage(fixture, session, message);
  }
  assert.equal((await session.done).code, 0);
  return fixture;
}

async function selectedCurrent(fixture) {
  const bytes = Buffer.from('APPLE\nPEAR\n');
  const mode = Number(
    (await lstat(join(fixture.candidate, 'product.txt'))).mode & 0o777,
  );
  return {
    scope: 'local-regular-files-v1',
    sha256: digest(
      JSON.stringify([
        'local-regular-files-v1',
        [['product.txt', mode, bytes.length, digest(bytes)]],
      ]),
    ),
  };
}

async function filesystemSnapshot(...roots) {
  const entries = [];
  async function walk(root, path) {
    const stat = await lstat(path, { bigint: true });
    entries.push([
      relative(root, path),
      stat.mode.toString(),
      stat.size.toString(),
      stat.mtimeNs.toString(),
      stat.isFile() ? digest(await readFile(path)) : null,
    ]);
    if (stat.isDirectory())
      for (const name of (await readdir(path)).sort())
        await walk(root, join(path, name));
  }
  for (const root of roots) await walk(root, root);
  return entries;
}

let closeoutSequence = 0;
async function closeoutArgs(
  fixture,
  expectedCurrent,
  request = fixture.request,
) {
  const sequence = ++closeoutSequence;
  const currentPath = join(fixture.root, `selected-current-${sequence}.json`);
  const currentBytes = Buffer.from(JSON.stringify(expectedCurrent));
  await writeFile(currentPath, currentBytes);
  const requestPath = join(fixture.root, `closeout-request-${sequence}.json`);
  const requestBytes = Buffer.from(JSON.stringify(request));
  await writeFile(requestPath, requestBytes);
  return [
    join(fixture.artifact, 'bin/closeout.mjs'),
    'verify',
    '--request',
    requestPath,
    '--expected-request-sha256',
    digest(requestBytes),
    '--expected-manifest-sha256',
    manifestSha256(manifest),
    '--expected-current',
    currentPath,
    '--expected-current-sha256',
    digest(currentBytes),
  ];
}

async function answerStage(
  fixture,
  session,
  message,
  withSource = true,
  sourceKindOverride,
  sourceMode = 'dedicated',
) {
  assert.equal(message.type, 'stage');
  let evidence = `observed ${message.stage}\n`;
  if (message.stage === 'build') {
    assert.equal(
      await readFile(join(fixture.candidate, 'product.txt'), 'utf8'),
      'pear\napple\n',
    );
    await writeFile(join(fixture.candidate, 'product.txt'), 'APPLE\nPEAR\n');
    evidence =
      'diff --git a/product.txt b/product.txt\n-pear\n-apple\n+APPLE\n+PEAR\n';
  }
  if (message.stage === 'review') {
    assert.equal(
      await readFile(join(fixture.candidate, 'product.txt'), 'utf8'),
      'APPLE\nPEAR\n',
    );
    evidence = 'Reviewed product.txt change from pear/apple to APPLE/PEAR.\n';
  }
  if (message.stage === 'verify') {
    const bytes = await readFile(join(fixture.candidate, 'product.txt'));
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      'a356e1ad77377b48e6090cda3e5ae651809c835b3b9e65aa742d3d031b283fa8',
    );
    evidence = 'Direct check: product.txt is APPLE\\nPEAR\\n.\n';
  }
  if (message.stage === 'deliver') {
    evidence =
      'Result: product.txt is APPLE\\nPEAR\\n. Publish approval remains unresolved.\n';
  }
  await writeFile(join(message.workspace, 'evidence.txt'), evidence);
  const genericSourceAlias = sourceMode === 'generic-alias';
  const claims = {
    investigate: { id: 'lightweight.intake.inspect', sourceKind: 'document' },
    plan: { id: 'lightweight.route.qualifies', sourceKind: 'document' },
    build: {
      id: 'lightweight.build.smallest-complete-change',
      sourceKind: 'diff',
    },
    review: { id: 'lightweight.verify.direct-check', sourceKind: 'diff' },
    verify: { id: 'lightweight.verify.direct-check', sourceKind: 'command' },
  };
  if (withSource)
    await writeFile(join(message.workspace, 'source.txt'), evidence);
  await writeFile(
    join(message.workspace, 'host-result.json'),
    JSON.stringify({
      schemaVersion: 1,
      sessionId: message.sessionId,
      requestId: message.requestId,
      stage: message.stage,
      status: 'PASS',
      summary: `synthetic ${message.stage} complete`,
      evidence: [
        { name: 'observation', kind: 'verification', path: 'evidence.txt' },
        ...(withSource && !genericSourceAlias
          ? [
              {
                name: 'source',
                kind: sourceMode === 'wrong-kind' ? 'verification' : 'other',
                path: 'source.txt',
              },
            ]
          : []),
        ...(sourceMode === 'reserved-name'
          ? [{ name: 'source-requirements', kind: 'other', path: 'source.txt' }]
          : []),
        ...(sourceMode === 'duplicate-name'
          ? [{ name: 'source', kind: 'other', path: 'source.txt' }]
          : []),
      ],
      ...(withSource
        ? {
            sourceRequirements: claims[message.stage]
              ? [
                  {
                    ...claims[message.stage],
                    sourceKind:
                      sourceKindOverride ?? claims[message.stage].sourceKind,
                    evidenceName: genericSourceAlias ? 'observation' : 'source',
                  },
                ]
              : [],
          }
        : {}),
    }),
  );
  session.reply(message);
}

async function retainedClaims(runDirectory, stage) {
  const checkpointNames = await readdir(join(runDirectory, 'checkpoints'));
  const checkpoint = JSON.parse(
    await readFile(
      join(runDirectory, 'checkpoints', checkpointNames[0]),
      'utf8',
    ),
  );
  const record = checkpoint.checkpoint ?? checkpoint;
  const stageRecord = record.stages.find((item) => item.stage === stage);
  assert(stageRecord);
  const evidenceRoot = join(runDirectory, 'evidence');
  const attestation = JSON.parse(
    await readFile(
      join(evidenceRoot, `${stageRecord.stageEvidence.sha256}.artifact`),
      'utf8',
    ),
  );
  const sourcePayload = attestation.payloads.find(
    (item) => item.name === 'source-requirements',
  );
  assert(sourcePayload);
  const bytes = await readFile(
    join(evidenceRoot, `${sourcePayload.reference.sha256}.artifact`),
  );
  return {
    source: JSON.parse(bytes.toString()),
    path: join(evidenceRoot, `${sourcePayload.reference.sha256}.artifact`),
    attestation,
  };
}

test('installed entry refuses a six-stage PASS without source requirement evidence', async (t) => {
  const f = await installedFixture(t);
  const session = f.launch();
  while (true) {
    const message = await session.next();
    if (message.type === 'complete') {
      assert.notEqual(message.status, 'PASS');
      break;
    }
    if (message.type === 'checkpoint') continue;
    await answerStage(f, session, message, false);
  }
  assert.notEqual((await session.done).code, 0);
  const receipt = JSON.parse(
    await readFile(
      join(f.runDirectory, 'receipts/installed-lightweight.receipt.json'),
      'utf8',
    ),
  ).receipt;
  assert.notEqual(receipt.status, 'PASS');
});

test('installed entry rejects a renamed source evidence kind before a PASS checkpoint', async (t) => {
  const f = await installedFixture(t);
  const session = f.launch();
  await answerStage(f, session, await session.next(), true, 'verification');
  const complete = await session.next();
  assert.equal(complete.type, 'complete');
  assert.equal(complete.status, 'BLOCKED');
  assert.notEqual((await session.done).code, 0);
  assert.deepEqual(await readdir(join(f.runDirectory, 'checkpoints')), [
    'installed-lightweight.checkpoint.json',
  ]);
  const checkpoint = JSON.parse(
    await readFile(
      join(f.runDirectory, 'checkpoints/installed-lightweight.checkpoint.json'),
      'utf8',
    ),
  );
  assert.equal((checkpoint.checkpoint ?? checkpoint).stages.length, 0);
});

test('installed entry rejects allowed source kinds bound to generic verification payloads', async (t) => {
  const f = await installedFixture(t);
  const session = f.launch();
  await answerStage(
    f,
    session,
    await session.next(),
    true,
    undefined,
    'generic-alias',
  );
  const complete = await session.next();
  assert.equal(complete.type, 'complete');
  assert.equal(complete.status, 'BLOCKED');
  assert.notEqual((await session.done).code, 0);
  const checkpoint = JSON.parse(
    await readFile(
      join(f.runDirectory, 'checkpoints/installed-lightweight.checkpoint.json'),
      'utf8',
    ),
  );
  assert.equal((checkpoint.checkpoint ?? checkpoint).stages.length, 0);
});

test('installed entry rejects wrong generic kind and reserved or duplicate source names', async (t) => {
  for (const sourceMode of ['wrong-kind', 'reserved-name', 'duplicate-name']) {
    await t.test(sourceMode, async (t) => {
      const f = await installedFixture(t);
      const session = f.launch();
      await answerStage(
        f,
        session,
        await session.next(),
        true,
        undefined,
        sourceMode,
      );
      const complete = await session.next();
      assert.equal(complete.type, 'complete');
      assert.equal(complete.status, 'BLOCKED');
      assert.notEqual((await session.done).code, 0);
      const checkpoint = JSON.parse(
        await readFile(
          join(
            f.runDirectory,
            'checkpoints/installed-lightweight.checkpoint.json',
          ),
          'utf8',
        ),
      );
      assert.equal((checkpoint.checkpoint ?? checkpoint).stages.length, 0);
    });
  }
});

test('retained validation rejects a previously acknowledged generic payload alias', async () => {
  const runId = 'retained-alias';
  const revision = 'synthetic-v1';
  const payload = Buffer.from('generic verification for investigate\n');
  const reference = {
    schema: 1,
    runId,
    revision,
    kind: 'verification',
    sha256: createHash('sha256').update(payload).digest('hex'),
    bytes: payload.byteLength,
  };
  const claims = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      stage: 'investigate',
      claims: [
        {
          id: 'lightweight.intake.inspect',
          sourceKind: 'document',
          evidenceName: 'observation',
          reference,
        },
      ],
    }),
  );
  const claimReference = {
    ...reference,
    kind: 'other',
    sha256: createHash('sha256').update(claims).digest('hex'),
    bytes: claims.byteLength,
  };
  const attestation = Buffer.from(
    JSON.stringify({
      payloads: [
        { name: 'observation', reference },
        { name: 'source-requirements', reference: claimReference },
      ],
    }),
  );
  const attestationReference = {
    ...reference,
    kind: 'other',
    sha256: createHash('sha256').update(attestation).digest('hex'),
    bytes: attestation.byteLength,
  };
  const artifacts = new Map([
    [attestationReference.sha256, attestation],
    [claimReference.sha256, claims],
    [reference.sha256, payload],
  ]);
  const record = {
    runId,
    revision,
    stages: [{ stage: 'investigate', stageEvidence: attestationReference }],
  };
  const store = {
    loadPortable: async (item) => {
      const bytes = artifacts.get(item.sha256);
      assert(bytes);
      assert.equal(bytes.byteLength, item.bytes);
      assert.equal(
        createHash('sha256').update(bytes).digest('hex'),
        item.sha256,
      );
      return bytes;
    },
  };
  const contract = {
    requirements: new Map([
      ['lightweight.intake.inspect', { allowedEvidenceKinds: ['document'] }],
    ]),
    stageRequirements: { investigate: ['lightweight.intake.inspect'] },
  };
  const runtime = { verifyCandidateEvidenceRecord: async () => undefined };
  await assert.rejects(
    assertSourceEvidence(record, store, contract, runtime),
    /Retained dedicated source evidence differs/,
  );
});

test('relocated public entry starts, resumes, and persists the six-stage candidate result', async (t) => {
  const f = await installedFixture(t, 'poteto-mode');
  assert.deepEqual(
    await checkPublicEntryArtifact(f.artifact, manifestSha256(manifest)),
    manifest,
  );
  const loader = join(f.root, 'deny-legacy-loader.mjs');
  await writeFile(
    loader,
    `export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  if (result.url.startsWith(${JSON.stringify(pathToFileURL(repository).href)})) throw Error('Legacy checkout import refused');
  return result;
}\n`,
  );
  const denied = await childResult(
    [
      '--experimental-loader',
      pathToFileURL(loader).href,
      '--input-type=module',
      '-e',
      `import(${JSON.stringify(pathToFileURL(packager).href)})`,
    ],
    1,
  );
  assert.match(denied.stderr, /Legacy checkout import refused/);
  const first = f.launch('start', undefined, loader);
  const requested = [];
  while (true) {
    const message = await first.next();
    if (message.type === 'checkpoint' && message.stage === 'build') break;
    if (message.type === 'checkpoint') continue;
    requested.push(message.stage);
    await answerStage(f, first, message);
  }
  first.child.stdin.end();
  assert.notEqual((await first.done).code, 0);
  assert.deepEqual(requested, ['investigate', 'plan', 'build']);
  const resumed = f.launch('resume', undefined, loader);
  while (true) {
    const message = await resumed.next();
    if (message.type === 'complete') {
      assert.equal(message.status, 'PASS');
      break;
    }
    if (message.type === 'checkpoint') continue;
    requested.push(message.stage);
    await answerStage(f, resumed, message);
  }
  assert.equal((await resumed.done).code, 0);
  assert.deepEqual(requested, [
    'investigate',
    'plan',
    'build',
    'review',
    'verify',
    'deliver',
  ]);
  const bytes = await readFile(join(f.candidate, 'product.txt'));
  assert.equal(bytes.toString(), 'APPLE\nPEAR\n');
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    'a356e1ad77377b48e6090cda3e5ae651809c835b3b9e65aa742d3d031b283fa8',
  );
  const receipt = JSON.parse(
    await readFile(
      join(f.runDirectory, 'receipts/installed-lightweight.receipt.json'),
      'utf8',
    ),
  ).receipt;
  assert.equal(receipt.status, 'PASS');
  assert.deepEqual(
    receipt.stages.map((stage) => stage.stage),
    requested,
  );
  assert.deepEqual(receipt.capabilities.available, []);
  assert.equal(receipt.plan.review, 'self');
  assert.equal(receipt.plan.delivery, 'local');
  const retained = await Promise.all(
    ['investigate', 'plan', 'build', 'review', 'verify', 'deliver'].map(
      (stage) => retainedClaims(f.runDirectory, stage),
    ),
  );
  const expectedIds = [
    'lightweight.intake.inspect',
    'lightweight.route.qualifies',
    'lightweight.build.smallest-complete-change',
    'lightweight.verify.direct-check',
  ];
  assert.deepEqual(
    [
      ...new Set(
        retained.flatMap((item) => item.source.claims.map((claim) => claim.id)),
      ),
    ].sort(),
    expectedIds.sort(),
  );
  assert.deepEqual(
    retained.map((item) => [
      item.source.stage,
      item.source.claims.map((claim) => claim.id),
    ]),
    [
      ['investigate', ['lightweight.intake.inspect']],
      ['plan', ['lightweight.route.qualifies']],
      ['build', ['lightweight.build.smallest-complete-change']],
      ['review', ['lightweight.verify.direct-check']],
      ['verify', ['lightweight.verify.direct-check']],
      ['deliver', []],
    ],
  );
  for (const item of retained)
    for (const claim of item.source.claims) {
      const reference = item.attestation.payloads.find(
        (payload) => payload.name === claim.evidenceName,
      )?.reference;
      assert.deepEqual(claim.reference, reference);
      assert.equal(reference.kind, 'other');
      const bytes = await readFile(
        join(f.runDirectory, 'evidence', `${reference.sha256}.artifact`),
      );
      assert.equal(
        createHash('sha256').update(bytes).digest('hex'),
        reference.sha256,
      );
    }
});

test('packaged closeout verifies an independently selected current candidate without mutating the run', async (t) => {
  const fixture = await completeInstalledFixture(t);
  const current = await selectedCurrent(fixture);
  const args = await closeoutArgs(fixture, current);
  const loader = join(fixture.root, 'deny-legacy-loader.mjs');
  await writeFile(
    loader,
    `export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  if (result.url.startsWith(${JSON.stringify(pathToFileURL(repository).href)})) throw Error('Legacy checkout import refused');
  return result;
}\n`,
  );
  const denied = await childResult(
    [
      '--experimental-loader',
      pathToFileURL(loader).href,
      '--input-type=module',
      '-e',
      `import(${JSON.stringify(pathToFileURL(packager).href)})`,
    ],
    1,
  );
  assert.match(denied.stderr, /Legacy checkout import refused/);
  const before = await filesystemSnapshot(
    fixture.runDirectory,
    fixture.candidate,
  );
  const result = await childResult([
    '--experimental-loader',
    pathToFileURL(loader).href,
    ...args,
  ]);
  const verified = JSON.parse(result.stdout);
  assert.equal(verified.entry, 'closeout');
  assert.equal(verified.status, 'candidate-verified');
  assert.equal(verified.scope, 'local-regular-file-candidate-only');
  assert.deepEqual(verified.current, current);
  assert.equal(verified.runId, fixture.request.invocation.runId);
  assert.deepEqual(
    await filesystemSnapshot(fixture.runDirectory, fixture.candidate),
    before,
  );
});

test('packaged closeout refuses a rehashed PASS receipt with a different plan', async (t) => {
  const fixture = await completeInstalledFixture(t);
  const args = await closeoutArgs(fixture, await selectedCurrent(fixture));
  const receiptPath = join(
    fixture.runDirectory,
    'receipts/installed-lightweight.receipt.json',
  );
  const stored = JSON.parse(await readFile(receiptPath, 'utf8'));
  assert.equal(stored.receipt.status, 'PASS');
  assert.equal(stored.receipt.stages.length, 6);
  assert.equal(stored.receipt.plan.review, 'self');
  stored.receipt.plan.review = 'independent';
  stored.sha256 = digest(canonicalReceipt(stored.receipt));
  await writeFile(receiptPath, canonicalReceipt(stored));
  const result = await childResult(args, 1);
  assert(!result.stdout.includes('candidate-verified'));
  assert.match(
    result.stderr,
    /Retained receipt plan differs from admitted policy/,
  );
});

test('packaged closeout refuses changed selection, product, retained records, invocation, and absent stores', async (t) => {
  const fixture = await completeInstalledFixture(t);
  const current = await selectedCurrent(fixture);
  const args = await closeoutArgs(fixture, current);
  const refuse = async (selected = args) => {
    const result = await childResult(selected, 1);
    assert(!result.stdout.includes('candidate-verified'));
    return result;
  };
  await refuse(
    await closeoutArgs(fixture, { ...current, sha256: '0'.repeat(64) }),
  );
  await refuse([...args.slice(0, -1), '0'.repeat(64)]);
  const retainedSelection = join(fixture.runDirectory, 'config/selected.json');
  await writeFile(retainedSelection, JSON.stringify(current));
  const insideRun = [...args];
  insideRun[insideRun.indexOf('--expected-current') + 1] = retainedSelection;
  await refuse(insideRun);
  const product = join(fixture.candidate, 'product.txt');
  const originalMode = (await lstat(product)).mode & 0o777;
  await writeFile(product, 'ALTERED\n');
  await refuse(args);
  await writeFile(product, 'APPLE\nPEAR\n');
  const changedMode =
    originalMode & 0o200 ? originalMode & ~0o222 : originalMode | 0o200;
  await chmod(product, changedMode);
  assert.notEqual(
    (await lstat(product)).mode & 0o777,
    originalMode,
    'The file mode did not change.',
  );
  await refuse(args);
  await chmod(product, originalMode);

  const receipt = join(
    fixture.runDirectory,
    'receipts/installed-lightweight.receipt.json',
  );
  const manifestFile = join(
    fixture.runDirectory,
    'manifests/installed-lightweight.build.workspace.json',
  );
  const source = (await retainedClaims(fixture.runDirectory, 'investigate'))
    .path;
  for (const path of [receipt, manifestFile, source]) {
    const original = await readFile(path);
    await writeFile(path, Buffer.concat([original, Buffer.from('x')]));
    await refuse(args);
    await writeFile(path, original);
  }
  const movedReceipt = join(fixture.root, 'redirected-receipt.json');
  await rename(receipt, movedReceipt);
  await symlink(movedReceipt, receipt);
  await refuse(args);
  await unlink(receipt);
  await rename(movedReceipt, receipt);

  const redirected = join(fixture.root, 'redirected-candidate');
  await cp(fixture.candidate, redirected, { recursive: true });
  await refuse(
    await closeoutArgs(fixture, current, {
      ...fixture.request,
      invocation: {
        ...fixture.request.invocation,
        candidate: {
          ...fixture.request.invocation.candidate,
          root: redirected,
        },
      },
    }),
  );
  const otherRun = join(fixture.root, 'other-run');
  await mkdir(otherRun);
  await refuse(
    await closeoutArgs(fixture, current, {
      ...fixture.request,
      invocation: { ...fixture.request.invocation, runDirectory: otherRun },
    }),
  );
  for (const name of ['receipts', 'evidence', 'manifests', 'checkpoints']) {
    const path = join(fixture.runDirectory, name);
    const moved = join(fixture.root, `missing-${name}`);
    await rename(path, moved);
    await refuse(args);
    await assert.rejects(lstat(path), { code: 'ENOENT' });
    await rename(moved, path);
  }
  const evidenceRoot = join(fixture.runDirectory, 'evidence');
  const movedEvidence = join(fixture.root, 'redirected-evidence');
  await rename(evidenceRoot, movedEvidence);
  await symlink(movedEvidence, evidenceRoot);
  await refuse(args);
  await unlink(evidenceRoot);
  await rename(movedEvidence, evidenceRoot);
  await rename(receipt, join(fixture.root, 'missing-receipt.json'));
  await refuse(args);
  await assert.rejects(lstat(receipt), { code: 'ENOENT' });
});

test('packaged closeout refuses a genuine non-PASS terminal run', async (t) => {
  const fixture = await installedFixture(t);
  const session = fixture.launch();
  const stage = await session.next();
  assert.equal(stage.type, 'stage');
  await writeFile(
    join(stage.workspace, 'host-result.json'),
    JSON.stringify({
      schemaVersion: 1,
      sessionId: stage.sessionId,
      requestId: stage.requestId,
      stage: stage.stage,
      status: 'ISSUES',
      summary: 'Synthetic issue stops the run.',
      evidence: [],
    }),
  );
  session.reply(stage);
  const completed = await session.next();
  assert.equal(completed.type, 'complete');
  assert.equal(completed.status, 'ISSUES');
  assert.notEqual((await session.done).code, 0);
  const args = await closeoutArgs(fixture, {
    scope: 'local-regular-files-v1',
    sha256: '0'.repeat(64),
  });
  const result = await childResult(args, 1);
  assert(!result.stdout.includes('candidate-verified'));
});

test('restart refuses changed retained source requirement references', async (t) => {
  const f = await installedFixture(t);
  const first = f.launch();
  await answerStage(f, first, await first.next());
  assert.equal((await first.next()).type, 'checkpoint');
  first.child.stdin.end();
  assert.notEqual((await first.done).code, 0);
  const retained = await retainedClaims(f.runDirectory, 'investigate');
  assert.equal(retained.source.claims[0].id, 'lightweight.intake.inspect');
  const claimed = retained.source.claims[0].reference.sha256;
  retained.source.claims[0].reference.sha256 = `${claimed.slice(0, -1)}${claimed.endsWith('0') ? '1' : '0'}`;
  await writeFile(retained.path, JSON.stringify(retained.source));
  const resumed = await f.launch('resume').done;
  assert.notEqual(resumed.code, 0);
  assert(!resumed.messages.some((message) => message.type === 'stage'));
  assert.match(resumed.stderr, /hash changed|source kind|source reference/i);
});

test('restart refuses a changed source profile in the retained descriptor', async (t) => {
  const f = await installedFixture(t);
  const first = f.launch();
  await answerStage(f, first, await first.next());
  assert.equal((await first.next()).type, 'checkpoint');
  first.child.stdin.end();
  assert.notEqual((await first.done).code, 0);
  const descriptorPath = join(f.runDirectory, 'config/input.json');
  const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8'));
  descriptor.sourceProfile = 'feature-v1';
  await writeFile(descriptorPath, JSON.stringify(descriptor));
  const resumed = await f.launch('resume').done;
  assert.notEqual(resumed.code, 0);
  assert(!resumed.messages.some((message) => message.type === 'stage'));
  assert.match(resumed.stderr, /Retained source profile differs/);
});

test('installed entry refuses altered artifact, request, route, obligations, capability labels, and retained evidence', async (t) => {
  for (const mode of [
    'policy',
    'package',
    'profile',
    'playbook',
    'request',
    'route',
    'obligations',
    'capabilities',
    'worker-receipt',
    'qa',
    'full',
    'qa-template',
  ]) {
    await t.test(mode, async (t) => {
      const f = await installedFixture(t);
      if (mode === 'policy')
        await writeFile(join(f.artifact, 'policy.json'), '{}');
      if (mode === 'package')
        await writeFile(
          join(f.artifact, 'host/entry.mjs'),
          'throw Error("altered")',
        );
      if (mode === 'qa-template')
        await writeFile(
          join(
            f.artifact,
            'skills/qa-review-verification/assets/ticket-comment.md',
          ),
          'altered template',
        );
      if (mode === 'profile')
        await writeFile(
          join(f.artifact, 'source/lightweight-engineering.json'),
          '{}',
        );
      if (mode === 'playbook')
        await writeFile(
          join(f.artifact, 'source/lightweight-engineering.md'),
          'changed',
        );
      if (mode === 'request')
        await writeFile(
          f.requestPath,
          JSON.stringify({ ...f.request, profile: 'feature-v1' }),
        );
      if (mode === 'route') {
        f.request.routeInput.lightweight.isMigration = true;
        await writeFile(f.requestPath, JSON.stringify(f.request));
      }
      if (mode === 'obligations') {
        f.request.obligations.review = 'independent';
        await writeFile(f.requestPath, JSON.stringify(f.request));
      }
      if (mode === 'capabilities') {
        f.request.capabilities = ['subagents'];
        await writeFile(f.requestPath, JSON.stringify(f.request));
      }
      if (mode === 'worker-receipt') {
        const receiptPath = join(f.root, 'worker-receipt.json');
        await writeFile(receiptPath, JSON.stringify({ status: 'PASS' }));
        await writeFile(
          f.requestPath,
          JSON.stringify(request('temari', { workerReceipt: receiptPath })),
        );
      }
      if (mode === 'qa') {
        f.request.route = 'qa-review';
        f.request.profile = 'qa-review-v1';
        await writeFile(f.requestPath, JSON.stringify(f.request));
      }
      if (mode === 'full')
        await writeFile(f.requestPath, JSON.stringify(request('temari')));
      const digest = [
        'route',
        'obligations',
        'capabilities',
        'worker-receipt',
        'qa',
        'full',
      ].includes(mode)
        ? createHash('sha256')
            .update(await readFile(f.requestPath))
            .digest('hex')
        : undefined;
      const result = await f.launch('start', digest).done;
      assert.notEqual(result.code, 0);
      assert(!result.messages.some((message) => message.type === 'stage'));
      await assert.rejects(lstat(f.runDirectory), { code: 'ENOENT' });
      if (
        ['policy', 'package', 'profile', 'playbook', 'qa-template'].includes(
          mode,
        )
      )
        assert.match(result.stderr, /Artifact (bytes|size) changed/);
      if (mode === 'request')
        assert.match(
          result.stderr,
          /Request bytes differ from trusted invocation/,
        );
      if (mode === 'route')
        assert.deepEqual(result.messages[0].reasons, [
          'lightweight-conditions-not-proven',
        ]);
      if (mode === 'obligations')
        assert.deepEqual(result.messages[0].reasons, [
          'obligations-not-admitted',
        ]);
      if (mode === 'capabilities')
        assert.match(result.stderr, /unknown or missing fields/);
      if (mode === 'worker-receipt')
        assert.match(result.stderr, /unknown or missing fields/);
      if (mode === 'qa')
        assert(result.messages[0].reasons.includes('route-not-admitted'));
      if (mode === 'full') {
        assert.deepEqual(result.messages[0].reasons, [
          'host-capability-proof-missing',
        ]);
        assert.deepEqual(result.messages[0].missingCapabilities, [
          'subagents',
          'forge',
        ]);
      }
    });
  }
  const f = await installedFixture(t);
  const first = f.launch();
  const stage = await first.next();
  await answerStage(f, first, stage);
  assert.equal((await first.next()).type, 'checkpoint');
  first.child.stdin.end();
  assert.notEqual((await first.done).code, 0);
  await writeFile(join(stage.workspace, 'evidence.txt'), 'altered evidence\n');
  const resumed = await f.launch('resume').done;
  assert.notEqual(resumed.code, 0);
  assert(!resumed.messages.some((message) => message.type === 'stage'));
  await assert.rejects(
    lstat(join(f.runDirectory, 'receipts/installed-lightweight.receipt.json')),
    { code: 'ENOENT' },
  );
});
