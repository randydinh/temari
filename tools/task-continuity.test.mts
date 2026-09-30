import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { runTaskCommand } from './task-continuity.mjs';

const run = promisify(execFile);
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
