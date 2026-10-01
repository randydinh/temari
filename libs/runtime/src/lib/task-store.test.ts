import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test, { type TestContext } from 'node:test';
import { minimalPlan } from '@temari/contracts';
import { FileTaskStore, taskDigest } from './task-store.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'temari-tasks-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await FileTaskStore.create(root);
  const create = {
    taskId: 'goal-1',
    actor: 'coordinator',
    idempotencyKey: 'create',
    title: 'Retain one goal',
    goal: 'Keep the goal through retries and replans.',
    workspaceRoot: root,
  };
  const task = await store.createTask(create);
  const bind = {
    taskId: task.taskId,
    actor: 'coordinator',
    idempotencyKey: 'bind-run-1',
    expectedVersion: task.version,
    run: {
      runId: 'run-1',
      revision: 'revision-1',
      plan: minimalPlan(),
      receiptRoot: join(root, 'receipts'),
      evidenceRoot: join(root, 'evidence'),
      sourceRefs: [
        {
          sourceId: 'source-1',
          publicationId: 'publication-1',
          location: 'registrar://source-1/publication-1',
        },
      ],
    },
  };
  return { root, store, create, task, bind };
}

test('stale lock reports its owner and is never automatically taken over', async (t) => {
  const f = await fixture(t);
  const lock = join(f.root, '.tasks.lock');
  await mkdir(lock);
  const owner = {
    pid: 987654321,
    hostname: 'another-host',
    startedAt: '2020-01-01T00:00:00.000Z',
    nonce: 'fafe629b-7cbe-4d17-b7c3-d36f85259304',
  };
  const ownerPath = join(lock, 'owner.json');
  await writeFile(ownerPath, JSON.stringify(owner));
  const before = await readFile(join(f.root, 'tasks.json'), 'utf8');
  await assert.rejects(
    f.store.updateTask({
      taskId: 'goal-1',
      actor: 'coordinator',
      idempotencyKey: 'blocked-update',
      expectedVersion: 1,
      nextAction: 'Must not acquire this lock.',
    }),
    (error: unknown) => {
      assert(error instanceof Error);
      assert.match(error.message, /987654321/);
      assert.match(error.message, /another-host/);
      assert.match(error.message, /No automatic takeover/);
      return true;
    },
  );
  assert.deepEqual(JSON.parse(await readFile(ownerPath, 'utf8')), owner);
  assert.equal(await readFile(join(f.root, 'tasks.json'), 'utf8'), before);
});

test('missing persisted ledger is an error for existing readers and initializers', async (t) => {
  const f = await fixture(t);
  const existing = await FileTaskStore.openExisting(f.root);
  await unlink(join(f.root, 'tasks.json'));
  await assert.rejects(existing.list(), /Task ledger is missing/);
  await assert.rejects(existing.load('goal-1'), /Task ledger is missing/);
  await assert.rejects(
    existing.createTask({ ...f.create, taskId: 'replacement' }),
    /Task ledger is missing/,
  );
  await assert.rejects(
    FileTaskStore.openExisting(f.root),
    /Task ledger is missing/,
  );
  await assert.rejects(FileTaskStore.create(f.root), /Task ledger is missing/);
  await assert.rejects(readFile(join(f.root, 'tasks.json')), {
    code: 'ENOENT',
  });
});

test('concurrent initialization persists one empty ledger and preserves later work', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'temari-task-init-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'tasks');
  const stores = await Promise.all(
    Array.from({ length: 4 }, () => FileTaskStore.create(root)),
  );
  const ledger = JSON.parse(await readFile(join(root, 'tasks.json'), 'utf8'));
  assert.deepEqual(ledger.events, []);
  assert.equal(ledger.sha256, taskDigest([]));
  assert.deepEqual(
    await FileTaskStore.openExisting(root).then((store) => store.list()),
    [],
  );
  const task = await stores[0]!.createTask({
    taskId: 'retained',
    actor: 'temari',
    idempotencyKey: 'create',
    title: 'Retained',
    goal: 'Preserve this history.',
    workspaceRoot: directory,
  });
  const reopened = await Promise.all(
    Array.from({ length: 4 }, () => FileTaskStore.create(root)),
  );
  for (const store of reopened)
    assert.deepEqual(await store.load(task.taskId), task);
  const filePath = join(directory, 'file');
  await writeFile(filePath, 'not a directory');
  await assert.rejects(
    FileTaskStore.openExisting(filePath),
    /must be a directory/,
  );
  const unknown = join(directory, 'unknown');
  await mkdir(unknown);
  await writeFile(join(unknown, 'unrelated.json'), '{}');
  await assert.rejects(FileTaskStore.create(unknown), /nonempty directory/);
});

test('one native identity cannot be attached to two Temari runs', async (t) => {
  const f = await fixture(t);
  for (const taskId of ['goal-1', 'goal-2']) {
    if (taskId === 'goal-2') await f.store.createTask({ ...f.create, taskId });
    const runId = `run-${taskId}`;
    const bound = await f.store.bindRun({
      ...f.bind,
      taskId,
      run: { ...f.bind.run, runId },
    });
    const intent = await f.store.append(
      {
        taskId,
        actor: 'coordinator',
        idempotencyKey: 'dispatch',
        expectedVersion: bound.version,
      },
      {
        type: 'dispatch-requested',
        runId,
        entrypoint: 'workflow.yml',
        inputs: {},
        harnessId: 'fixture',
        harnessVersion: '1.0.0',
      },
    );
    const write = () =>
      f.store.append(
        {
          taskId,
          actor: 'coordinator',
          idempotencyKey: 'native-bound',
          expectedVersion: intent.task.version,
        },
        {
          type: 'native-bound',
          runId,
          operationId: 'dispatch',
          reference: {
            schema: 1,
            runId,
            revision: f.bind.run.revision,
            planSha256: taskDigest(f.bind.run.plan),
            harnessId: 'fixture',
            harnessVersion: '1.0.0',
            externalRunId: 'same-native-run',
            workspaceRoot: f.root,
            entrypoint: 'workflow.yml',
            startedAt: new Date().toISOString(),
          },
        },
      );
    if (taskId === 'goal-1') await write();
    else await assert.rejects(write(), /Native run ID is already bound/);
  }
});

test('deferred evidence roots attach once to the exact existing run', async (t) => {
  const f = await fixture(t);
  const bound = await f.store.bindRun({
    ...f.bind,
    run: { runId: 'deferred', revision: 'rev', plan: minimalPlan() },
  });
  assert.equal(bound.runs[0]?.receiptRoot, undefined);
  const attach = {
    taskId: 'goal-1',
    actor: 'coordinator',
    idempotencyKey: 'roots',
    expectedVersion: bound.version,
    runId: 'deferred',
    receiptRoot: f.bind.run.receiptRoot,
    evidenceRoot: f.bind.run.evidenceRoot,
  };
  const attached = await f.store.attachEvidenceRoots(attach);
  assert.equal(attached.runs[0]?.receiptRoot, attach.receiptRoot);
  assert.deepEqual(await f.store.attachEvidenceRoots(attach), attached);
  await assert.rejects(
    f.store.attachEvidenceRoots({
      ...attach,
      idempotencyKey: 'changed-roots',
      expectedVersion: attached.version,
      receiptRoot: join(f.root, 'other'),
    }),
    /binding is immutable/,
  );
  await assert.rejects(
    f.store.attachEvidenceRoots({
      ...attach,
      idempotencyKey: 'wrong-run',
      expectedVersion: attached.version,
      runId: 'not-bound',
    }),
    /not bound to this task/,
  );
  await assert.rejects(
    f.store.bindRun({
      ...f.bind,
      expectedVersion: attached.version,
      idempotencyKey: 'unpaired',
      run: {
        runId: 'unpaired',
        revision: 'rev',
        plan: minimalPlan(),
        receiptRoot: f.bind.run.receiptRoot,
      },
    }),
    /attached together/,
  );
});

test('reopens one goal, immutable history and distinct run revisions', async (t) => {
  const f = await fixture(t);
  const first = await f.store.bindRun(f.bind);
  const next = await f.store.bindRun({
    ...f.bind,
    expectedVersion: first.version,
    idempotencyKey: 'replan',
    run: {
      ...f.bind.run,
      runId: 'run-2',
      revision: 'revision-2',
      plan: { ...minimalPlan(), workType: 'design' },
    },
  });
  const reopened = await FileTaskStore.openExisting(f.root);
  assert.deepEqual(await reopened.load('goal-1'), next);
  assert.equal(next.goal, f.create.goal);
  assert.equal(next.currentRunId, 'run-2');
  assert.deepEqual(
    next.runs.map((r) => [r.runId, r.revision]),
    [
      ['run-1', 'revision-1'],
      ['run-2', 'revision-2'],
    ],
  );
  assert.equal((await reopened.list()).length, 1);
  assert.equal(next.events.length, 3);
  assert.deepEqual(next.runs[0]?.sourceRefs, f.bind.run.sourceRefs);
});

test('commands are idempotent but changed payload, actor and reused run IDs fail', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.store.createTask(f.create), f.task);
  const bound = await f.store.bindRun(f.bind);
  assert.deepEqual(await f.store.bindRun(f.bind), bound);
  await assert.rejects(
    f.store.bindRun({
      ...f.bind,
      run: { ...f.bind.run, revision: 'different' },
    }),
    /Idempotency payload conflict/,
  );
  await assert.rejects(
    f.store.bindRun({ ...f.bind, actor: 'other' }),
    /Idempotency actor conflict/,
  );
  const second = await f.store.createTask({ ...f.create, taskId: 'goal-2' });
  await assert.rejects(
    f.store.bindRun({
      ...f.bind,
      taskId: second.taskId,
      expectedVersion: second.version,
    }),
    /Run ID already belongs/,
  );
  await assert.rejects(
    f.store.bindRun({
      ...f.bind,
      expectedVersion: bound.version,
      idempotencyKey: 'replace-run',
    }),
    /Run ID already belongs/,
  );
});

test('concurrent metadata updates compare versions without losing either command', async (t) => {
  const f = await fixture(t);
  const secondStore = await FileTaskStore.openExisting(f.root);
  const base = {
    taskId: f.task.taskId,
    actor: 'coordinator',
    expectedVersion: 1,
  };
  const results = await Promise.allSettled([
    f.store.updateTask({
      ...base,
      idempotencyKey: 'next-action',
      nextAction: 'Run the check.',
    }),
    secondStore.updateTask({
      ...base,
      idempotencyKey: 'blocker',
      blocker: 'Waiting for evidence.',
    }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const rejected = results.find((r) => r.status === 'rejected');
  assert(rejected?.status === 'rejected');
  assert.match(String(rejected.reason), /version conflict/);
  const current = (await f.store.load('goal-1'))!;
  const complete = await secondStore.updateTask({
    ...base,
    expectedVersion: current.version,
    idempotencyKey: 'reconcile-metadata',
    nextAction: 'Run the check.',
    blocker: 'Waiting for evidence.',
  });
  assert.equal(complete.nextAction, 'Run the check.');
  assert.equal(complete.blocker, 'Waiting for evidence.');
  assert.equal(complete.version, 3);
});

test('rejects unsafe IDs, unbounded metadata, invalid plans and corrupt ledgers visibly', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.store.load('../escape'), /safe filename/);
  await assert.rejects(
    f.store.createTask({
      ...f.create,
      taskId: 'another',
      title: 'x'.repeat(257),
    }),
    /Invalid title/,
  );
  await assert.rejects(
    f.store.bindRun({
      ...f.bind,
      run: { ...f.bind.run, plan: { ...minimalPlan(), stages: ['build'] } },
    }),
    /canonical/,
  );
  const ledgerPath = join(f.root, 'tasks.json');
  const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
  ledger.events[0].change.goal = 'Changed without valid digest';
  await writeFile(ledgerPath, JSON.stringify(ledger));
  await assert.rejects(f.store.list(), /digest mismatch/);
  ledger.events[0].change.title = 7;
  ledger.sha256 = taskDigest(ledger.events);
  await writeFile(ledgerPath, JSON.stringify(ledger));
  await assert.rejects(f.store.list(), /Invalid title/);
  await writeFile(ledgerPath, '{truncated');
  await assert.rejects(f.store.list(), SyntaxError);
});

test('entry atomically creates one task and links its session with replay-safe context', async (t) => {
  const f = await fixture(t);
  const legacy = await FileTaskStore.openExisting(f.root).then((store) =>
    store.load('goal-1'),
  );
  assert.deepEqual(legacy?.sessions, []);
  assert.equal(legacy?.handoff, null);
  const entry = {
    taskId: 'entered-goal',
    actor: 'temari',
    idempotencyKey: 'first-entry',
    expectedVersion: 0,
    session: { host: 'codex', sessionId: 'session-1' },
    create: {
      title: 'Continue my work',
      goal: 'Retain a bounded handoff.',
      workspaceRoot: f.root,
    },
  };
  await assert.rejects(
    f.store.enterTask({ ...entry, session: { host: 'codex', sessionId: '' } }),
    /session ID/,
  );
  assert.equal(await f.store.load(entry.taskId), null);
  const entered = await f.store.enterTask(entry);
  assert.equal(entered.version, 1);
  assert.equal(entered.events.length, 1);
  assert.equal(entered.events[0]?.change.type, 'task-entered');
  assert.deepEqual(entered.sessions, [
    {
      ...entry.session,
      enteredAt: entered.createdAt,
      lastEnteredAt: entered.createdAt,
    },
  ]);
  const handoff = {
    summary: 'The first inspection is complete.',
    decisions: ['Keep Archon as executor.'],
    nextAction: 'Verify the candidate.',
    blocker: null,
    contextRefs: [
      { kind: 'document', location: '/docs/plan.md', sha256: 'a'.repeat(64) },
    ],
  };
  const retained = await f.store.handoffTask({
    taskId: entry.taskId,
    actor: 'reviewer',
    idempotencyKey: 'handoff',
    expectedVersion: entered.version,
    handoff,
  });
  assert.equal(retained.handoff?.actor, 'reviewer');
  assert.equal(retained.handoff?.taskVersion, 2);
  assert.equal(retained.handoff?.runId, null);
  assert.equal(retained.nextAction, handoff.nextAction);
  const fresh = await FileTaskStore.openExisting(f.root);
  assert.deepEqual(await fresh.load(entry.taskId), retained);
  assert.deepEqual(await fresh.enterTask(entry), retained);
  assert.equal((await fresh.load(entry.taskId))?.events.length, 2);
});

test('sessions and tasks retain many-to-many identity links without changing goals', async (t) => {
  const f = await fixture(t);
  const session = { host: 'codex', sessionId: 'same-chat' };
  const first = await f.store.enterTask({
    taskId: 'goal-1',
    actor: 'temari',
    idempotencyKey: 'enter',
    expectedVersion: f.task.version,
    session,
  });
  const second = await f.store.enterTask({
    taskId: 'goal-2',
    actor: 'temari',
    idempotencyKey: 'enter',
    expectedVersion: 0,
    session,
    create: {
      title: 'Second goal',
      goal: 'Another request in the same chat.',
      workspaceRoot: f.root,
    },
  });
  const otherSession = { host: 'archon', sessionId: 'other-chat' };
  const linked = await f.store.enterTask({
    taskId: 'goal-1',
    actor: 'temari',
    idempotencyKey: 'another-session',
    expectedVersion: first.version,
    session: otherSession,
  });
  const reentered = await f.store.enterTask({
    taskId: 'goal-1',
    actor: 'temari',
    idempotencyKey: 'return-to-session',
    expectedVersion: linked.version,
    session,
  });
  assert.equal(reentered.sessions.length, 2);
  assert.equal(second.sessions.length, 1);
  assert.equal(reentered.sessions[0]?.enteredAt, first.sessions[0]?.enteredAt);
  assert.equal(
    reentered.sessions[0]?.lastEnteredAt,
    reentered.events.at(-1)?.at,
  );
  assert.equal(reentered.goal, f.task.goal);
  assert.equal(reentered.title, f.task.title);
  await assert.rejects(
    f.store.enterTask({
      taskId: 'goal-1',
      actor: 'temari',
      idempotencyKey: 'replace-goal',
      expectedVersion: reentered.version,
      session,
      create: {
        title: 'Changed',
        goal: 'Silently replace intent',
        workspaceRoot: f.root,
      },
    }),
    /cannot create or replace/,
  );
});

test('concurrent entry and handoff reject stale updates while preserving idempotency', async (t) => {
  const f = await fixture(t);
  const other = await FileTaskStore.openExisting(f.root);
  const command = {
    taskId: 'goal-1',
    actor: 'temari',
    expectedVersion: f.task.version,
  };
  const enter = {
    ...command,
    idempotencyKey: 'entry',
    session: { host: 'codex', sessionId: 'session' },
  };
  const handoff = {
    ...command,
    idempotencyKey: 'handoff',
    handoff: {
      summary: 'Need source evidence.',
      decisions: [],
      nextAction: 'Inspect source.',
      blocker: 'Missing evidence',
      contextRefs: [],
    },
  };
  const results = await Promise.allSettled([
    f.store.enterTask(enter),
    other.handoffTask(handoff),
  ]);
  assert.equal(
    results.filter((result) => result.status === 'fulfilled').length,
    1,
  );
  const rejected = results.find((result) => result.status === 'rejected');
  assert(rejected?.status === 'rejected');
  assert.match(String(rejected.reason), /version conflict/);
  let current = (await f.store.load('goal-1'))!;
  if (current.sessions.length === 0)
    current = await f.store.enterTask({
      ...enter,
      expectedVersion: current.version,
    });
  else
    current = await f.store.handoffTask({
      ...handoff,
      expectedVersion: current.version,
    });
  assert.equal(current.sessions.length, 1);
  assert.equal(current.handoff?.summary, handoff.handoff.summary);
  assert.equal(current.version, 3);
  assert.deepEqual(await other.enterTask(enter), current);
  assert.deepEqual(await other.handoffTask(handoff), current);
  await assert.rejects(
    other.enterTask({
      ...enter,
      session: { ...enter.session, sessionId: 'different' },
    }),
    /Idempotency payload conflict/,
  );
  await assert.rejects(
    other.handoffTask({ ...handoff, actor: 'different' }),
    /Idempotency actor conflict/,
  );
  await assert.rejects(
    other.handoffTask({
      ...handoff,
      handoff: { ...handoff.handoff, summary: 'Changed' },
    }),
    /Idempotency payload conflict/,
  );
});

test('handoff bounds reject malformed context without changing acceptance or execution', async (t) => {
  const f = await fixture(t);
  const bound = await f.store.bindRun(f.bind);
  const request = {
    taskId: 'goal-1',
    actor: 'temari',
    expectedVersion: bound.version,
    idempotencyKey: 'handoff',
    handoff: {
      summary: 'Ready for another session.',
      decisions: [],
      nextAction: 'Continue.',
      blocker: null,
      contextRefs: [],
    },
  };
  await assert.rejects(
    f.store.handoffTask({
      ...request,
      handoff: { ...request.handoff, decisions: Array(17).fill('decision') },
    }),
    /16-item limit/,
  );
  await assert.rejects(
    f.store.handoffTask({
      ...request,
      handoff: {
        ...request.handoff,
        contextRefs: [
          { kind: 'document', location: 'reference', sha256: 'not-a-hash' },
        ],
      },
    }),
    /digest/,
  );
  const saved = await f.store.handoffTask(request);
  assert.equal(saved.handoff?.runId, f.bind.run.runId);
  assert.equal(saved.acceptance, bound.acceptance);
  assert.deepEqual(saved.runs, bound.runs);
  assert.equal(saved.events.at(-1)?.change.type, 'handoff-recorded');
});
