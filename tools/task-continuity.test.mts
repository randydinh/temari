import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
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
