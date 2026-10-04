import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, mkdir, realpath, readdir, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  createTaskContinuityReconciliationDashboard,
  runTaskCommand,
} from './task-continuity.mjs';

const run = promisify(execFile);

test('task-continuity leaves reconciliation controls unavailable without explicit host configuration', async () => {
  const dashboard = await createTaskContinuityReconciliationDashboard(
    {
      schema: 1 as const,
      workspaceRoot: '/configured-workspace',
      preparationRoot: '/configured-preparations',
      recipes: [],
    },
    {} as never,
  );
  assert.equal(dashboard, undefined);
});

test('fresh CLI processes recover the same task, next action and version', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'temari-task-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const create = join(root, 'create.json');
  const store = join(root, 'tasks');
  await writeFile(
    create,
    JSON.stringify({
      taskId: 'continued-task',
      title: 'Continue work',
      goal: 'Return without searching a chat',
      workspaceRoot: resolve('.'),
      actor: 'temari',
      idempotencyKey: 'create-1',
    }),
  );
  const cli = resolve('tools/task-continuity.mts');
  const first = await run(process.execPath, [
    '--import',
    '@swc-node/register/esm-register',
    cli,
    'create',
    '--root',
    store,
    '--input',
    create,
  ]);
  assert.equal(JSON.parse(first.stdout).version, 1);
  const update = join(root, 'update.json');
  await writeFile(
    update,
    JSON.stringify({
      taskId: 'continued-task',
      actor: 'temari',
      idempotencyKey: 'next-1',
      expectedVersion: 1,
      nextAction: 'Review the retained candidate',
      blocker: null,
    }),
  );
  await run(process.execPath, [
    '--import',
    '@swc-node/register/esm-register',
    cli,
    'update',
    '--root',
    store,
    '--input',
    update,
  ]);
  const reopened = JSON.parse(
    (
      await run(process.execPath, [
        '--import',
        '@swc-node/register/esm-register',
        cli,
        'show',
        '--root',
        store,
        '--task',
        'continued-task',
      ])
    ).stdout,
  );
  assert.equal(reopened.nextAction, 'Review the retained candidate');
  assert.equal(reopened.version, 2);
  assert.equal(reopened.events.length, 2);
  assert.equal(reopened.status, 'OPEN');
  const listed = (await runTaskCommand(['list', '--root', store])) as {
    taskId: string;
  }[];
  assert.equal(listed[0]?.taskId, 'continued-task');
});

test('CLI rejects unknown commands and relative storage roots', async () => {
  await assert.rejects(
    runTaskCommand(['unknown', '--root', '/tmp']),
    /Unknown task command/,
  );
  await assert.rejects(
    runTaskCommand(['list', '--root', './tasks']),
    /absolute path/,
  );
  assert.match(
    ((await runTaskCommand(['--help'])) as { help: string }).help,
    /idempotencyKey/,
  );
});

test('host entry, handoff and scoped pickup survive separate CLI processes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'temari-host-entry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = join(root, 'tasks');
  const cli = resolve('tools/task-continuity.mts');
  const invoke = async (...args: string[]) =>
    JSON.parse(
      (
        await run(process.execPath, [
          '--import',
          '@swc-node/register/esm-register',
          cli,
          ...args,
          '--root',
          store,
        ])
      ).stdout,
    );
  const command = async (name: string, input: Record<string, unknown>) => {
    const path = join(root, `${name}.json`);
    await writeFile(path, JSON.stringify(input));
    return invoke(name, '--input', path);
  };
  const session = { host: 'codex', sessionId: 'conversation-one' };
  const entry = {
    taskId: 'first',
    actor: 'temari',
    idempotencyKey: 'entry-first',
    expectedVersion: 0,
    session,
    create: {
      title: 'First goal',
      goal: 'Keep the actual next step',
      workspaceRoot: root,
    },
  };
  const entered = await command('enter', entry);
  assert.equal(entered.version, 1);
  assert.equal((await command('enter', entry)).version, 1);
  assert.equal(entered.sessions[0].sessionId, session.sessionId);
  const handoff = await command('handoff', {
    taskId: 'first',
    actor: 'temari',
    idempotencyKey: 'handoff-first',
    expectedVersion: 1,
    handoff: {
      summary: 'The candidate is ready for review.',
      decisions: ['Keep Archon replaceable.'],
      nextAction: 'Review the retained candidate.',
      blocker: null,
      contextRefs: [{ kind: 'design', location: '/local/design.md' }],
    },
  });
  assert.equal(handoff.version, 2);
  const scoped = await invoke(
    'pickup',
    '--workspace',
    root,
    '--host',
    session.host,
    '--session',
    session.sessionId,
  );
  assert.equal(scoped.status, 'selected');
  assert.equal(scoped.selected.taskId, 'first');
  assert.equal(scoped.selected.nextAction, 'Review the retained candidate.');
  assert.equal(scoped.selected.handoff.contextOnly, true);
  assert.equal(scoped.selected.currentRun, null);
  assert.equal(scoped.selected.status, 'OPEN');
  assert.equal(JSON.stringify(scoped).includes('dispatchInputs'), false);
  await command('enter', {
    ...entry,
    taskId: 'second',
    idempotencyKey: 'entry-second',
    create: { ...entry.create, title: 'Second goal' },
  });
  const ambiguous = await invoke(
    'pickup',
    '--workspace',
    root,
    '--host',
    session.host,
    '--session',
    session.sessionId,
    '--limit',
    '1',
  );
  assert.equal(ambiguous.status, 'choices');
  assert.equal(ambiguous.hasMore, true);
  assert.equal(ambiguous.selected, null);
  assert.equal(ambiguous.choices.length, 1);
  assert.equal(
    (await invoke('pickup', '--task', 'first')).selected.taskId,
    'first',
  );
  assert.equal(
    (await invoke('pickup', '--task', 'first', '--workspace', resolve('.')))
      .status,
    'empty',
  );
  assert.equal(
    (
      await invoke(
        'pickup',
        '--workspace',
        root,
        '--host',
        'codex',
        '--session',
        'different',
      )
    ).status,
    'empty',
  );
  await assert.rejects(
    invoke('pickup'),
    /exact task ID or an absolute workspace root/,
  );
  await assert.rejects(
    invoke('pickup', '--task', 'first', '--host', 'codex'),
    /--host and --session together/,
  );
  await assert.rejects(
    invoke('pickup', '--task', 'first', '--limit', '0'),
    /Pickup limit/,
  );
});

test('open-work CLI flags are paired, serve-only and validated before store access', async () => {
  const pin = 'a'.repeat(64);
  await assert.rejects(
    runTaskCommand([
      'list',
      '--open-work-manifest',
      '/capture',
      '--open-work-sha256',
      pin,
    ]),
    /only supported by serve/,
  );
  await assert.rejects(
    runTaskCommand(['serve', '--open-work-manifest', '/capture']),
    /must be paired/,
  );
  await assert.rejects(
    runTaskCommand(['serve', '--open-work-sha256', pin]),
    /must be paired/,
  );
  await assert.rejects(
    runTaskCommand([
      'serve',
      '--open-work-manifest',
      'relative',
      '--open-work-sha256',
      pin,
    ]),
    /absolute path/,
  );
  await assert.rejects(
    runTaskCommand([
      'serve',
      '--open-work-manifest',
      '/capture',
      '--open-work-sha256',
      'bad',
    ]),
    /64hex/,
  );
});

test('Talk config is optional, serve-only and validated before task-store access', async () => {
  await assert.rejects(runTaskCommand(['list', '--root', '/not-a-selected-task-store', '--talk-config', '/not-a-config']), /only supported by serve/);
  await assert.rejects(runTaskCommand(['serve', '--root', '/not-a-selected-task-store', '--talk-config', 'relative.json']), /--talk-config requires an absolute path/);
  const help = (await runTaskCommand(['--help'])) as { help: string };
  assert.match(help.help, /--talk-config/);
  assert.match(help.help, /does not install or launch Archon/);
});

test('Talk CLI rejects in-source storage before creating task or conversation data', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'temari-talk-storage-admission-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  await writeFile(join(workspace, 'sentinel.txt'), 'Existing source stays intact.');
  const config = join(root, 'talk.json');
  const outsideTasks = join(root, 'tasks');
  const selected = { schema: 1, workspaceRoot: workspace, hostId: 'fixture-host', workspaceId: 'fixture-workspace', taskStoreId: 'fixture-tasks' };
  await writeFile(config, JSON.stringify({ ...selected, root: join(workspace, '..talk') }));
  await assert.rejects(runTaskCommand(['serve', '--root', outsideTasks, '--talk-config', config, '--port', '0']), /outside the selected source workspace/);
  await assert.rejects(readdir(outsideTasks), { code: 'ENOENT' });
  await writeFile(config, JSON.stringify({ ...selected, root: join(root, 'conversations') }));
  await assert.rejects(runTaskCommand(['serve', '--root', join(workspace, 'tasks'), '--talk-config', config, '--port', '0']), /outside the selected source workspace/);
  assert.deepEqual(await readdir(workspace), ['sentinel.txt']);
  assert.equal(await readFile(join(workspace, 'sentinel.txt'), 'utf8'), 'Existing source stays intact.');
  await assert.rejects(readdir(join(root, 'conversations')), { code: 'ENOENT' });
});

test('Talk CLI refuses symlink-parent storage traversal before any source write', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'temari-talk-symlink-parent-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const outside = join(root, 'outside');
  await mkdir(join(workspace, 'nested'), { recursive: true });
  await mkdir(outside);
  await writeFile(join(workspace, 'sentinel.txt'), 'Original source.');
  await symlink(join(workspace, 'nested'), join(outside, 'alias'));
  const conversations = join(root, 'conversations');
  const config = join(root, 'talk.json');
  await writeFile(config, JSON.stringify({ schema: 1, root: conversations, workspaceRoot: workspace, hostId: 'fixture-host', workspaceId: 'fixture-workspace', taskStoreId: 'fixture-tasks' }));
  // Keep the raw parent segment: join() would collapse it before the CLI sees it.
  const rawTaskRoot = `${outside}/alias/../tasks`;
  await assert.rejects(runTaskCommand(['serve', '--root', rawTaskRoot, '--talk-config', config, '--port', '0']), /storage.*segments|parent|dot|canonical/i);
  assert.deepEqual((await readdir(workspace)).sort(), ['nested', 'sentinel.txt']);
  assert.equal(await readFile(join(workspace, 'sentinel.txt'), 'utf8'), 'Original source.');
  await assert.rejects(readdir(join(outside, 'tasks')), { code: 'ENOENT' });
  await assert.rejects(readdir(conversations), { code: 'ENOENT' });
});

test('advice-only Talk CLI serves topic organization with no Archon admission or model launch', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'temari-talk-cli-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const conversations = join(root, 'conversations');
  await mkdir(workspace);
  await mkdir(conversations);
  const config = join(root, 'talk-config.json');
  const tasks = join(root, 'tasks');
  await writeFile(config, JSON.stringify({ schema: 1, root: conversations, workspaceRoot: workspace, hostId: 'fixture-host', workspaceId: 'fixture-workspace', taskStoreId: 'fixture-tasks' }));
  const child = spawn(process.execPath, [
    '--import', '@swc-node/register/esm-register', resolve('tools/task-continuity.mts'),
    'serve', '--root', tasks, '--talk-config', config, '--port', '0',
    // These unselected native paths would fail before any installation if the
    // Talk-only branch accidentally tried to initialize Archon.
    '--archon-home', 'unselected-relative-home', '--archon-cache', 'unselected-relative-cache',
  ], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = new Promise<void>((done) => child.once('close', () => done()));
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 2_000);
    force.unref();
    await closed;
    clearTimeout(force);
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const started = await new Promise<{ url: string; mode: string }>((done, reject) => {
    let stdout = '';
    const timer = setTimeout(() => reject(new Error(`Talk CLI readiness timed out: ${stderr}`)), 10_000);
    const finish = (error?: Error, value?: { url: string; mode: string }) => {
      clearTimeout(timer);
      if (error) reject(error); else done(value!);
    };
    child.once('error', (error) => finish(error));
    child.once('exit', (code) => finish(new Error(`Talk CLI exited before readiness (${code}): ${stderr}`)));
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      let parsed: { url?: string; mode?: string };
      try { parsed = JSON.parse(stdout); } catch { return; }
      if (typeof parsed.url === 'string' && typeof parsed.mode === 'string') finish(undefined, parsed as { url: string; mode: string });
    });
  });
  assert.equal(started.mode, 'read-only');
  const dashboard = await (await fetch(`${started.url}/api/dashboard`)).json();
  assert.equal(dashboard.mode, 'read-only');
  assert.equal(dashboard.talkAvailable, true);
  const before = await (await fetch(`${started.url}/api/topics`)).json();
  assert.equal(before.configured, true);
  assert.equal(before.capabilities.canSendTurn, false);
  assert.deepEqual(before.topics, []);
  const headers = { origin: started.url, 'content-type': 'application/json', 'x-temari-token': dashboard.csrfToken as string };
  const created = await fetch(`${started.url}/api/topics`, { method: 'POST', headers, body: JSON.stringify({ requestId: 'advice-topic', title: 'Keep advice separate' }) });
  assert.equal(created.status, 200);
  const topic = (await created.json()).topic;
  assert.match(topic.topicId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
  const turn = await fetch(`${started.url}/api/topics/${topic.topicId}/turns`, { method: 'POST', headers, body: JSON.stringify({ requestId: 'unavailable-turn', expectedVersion: topic.version, text: 'No model is selected.' }) });
  assert.equal(turn.status, 503);
  assert.deepEqual((await (await fetch(`${started.url}/api/tasks`)).json()).tasks, []);
  assert.equal((await fetch(`${started.url}/api/tasks`, { method: 'POST', headers, body: '{}' })).status, 405);
});
