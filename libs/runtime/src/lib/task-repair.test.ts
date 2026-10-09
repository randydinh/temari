import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { minimalPlan } from '@temari/contracts';
import { FileTaskStore, taskDigest } from './task-store.js';
import { TaskRuntime } from './task-runtime.js';
import { FileChildTaskStore } from './child-task-store.js';
import type { TaskRepairHost, TaskRepairReport } from './task-repair.js';

const report: TaskRepairReport = {
  repairId: 'duplicate-correction',
  counterexample: 'A repeated correction dispatched twice.',
  affectedSurface: 'installed entry',
  expectedInvariant: 'One repair launch per report.',
  evidenceRefs: [
    {
      kind: 'counterexample',
      location: '/tmp/observed',
      sha256: 'a'.repeat(64),
    },
  ],
  requestedScopes: ['entry'],
  regressionContract: 'fresh-entry-v1',
  requiredRoute: 'lightweight-engineering',
};

test('schema-1 ledgers replay with no repairs and repair facts leave an active parent binding intact', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'task-repair-ledger-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await FileTaskStore.create(join(root, 'tasks'));
  let task = await store.createTask({
    taskId: 'goal',
    actor: 'coordinator',
    idempotencyKey: 'create',
    title: 'Original goal',
    goal: 'Continue original work',
    workspaceRoot: root,
  });
  const ledger = JSON.parse(
    await readFile(join(root, 'tasks', 'tasks.json'), 'utf8'),
  );
  assert.equal(ledger.schema, 1);
  assert(!JSON.stringify(ledger).includes('repairs'));
  assert.deepEqual(
    (await (await FileTaskStore.openExisting(join(root, 'tasks'))).load('goal'))
      ?.repairs,
    [],
  );
  task = await store.bindRun({
    taskId: 'goal',
    actor: 'coordinator',
    idempotencyKey: 'bind',
    expectedVersion: task.version,
    run: { runId: 'parent', revision: 'original', plan: minimalPlan() },
  });
  task = (
    await store.append(
      {
        taskId: 'goal',
        actor: 'coordinator',
        idempotencyKey: 'dispatch',
        expectedVersion: task.version,
      },
      {
        type: 'dispatch-requested',
        runId: 'parent',
        entrypoint: 'run',
        inputs: {},
        harnessId: 'fixture',
        harnessVersion: '1',
      },
    )
  ).task;
  const parent = structuredClone(task.runs);
  let launches = 0;
  const childStore = await FileChildTaskStore.create(join(root, 'children'));
  const host: TaskRepairHost = {
    async reserve(_task, _report, executionId) {
      await childStore.create({
        taskId: 'worker',
        runId: executionId,
        revision: 'pinned',
        dependsOn: [],
        actor: 'host',
      });
      await childStore.ensureGroup({
        groupId: 'repair-group',
        runId: executionId,
        revision: 'pinned',
        taskIds: ['worker'],
        assignmentIds: ['build'],
      });
      return {
        status: 'ADMITTED',
        executionId,
        revision: 'pinned',
        frozenCandidate: { root, revision: 'pinned', tree: 'a'.repeat(40) },
        authorityRef: {
          kind: 'repair-admission-observation',
          location: join(root, 'admission.json'),
          sha256: 'b'.repeat(64),
        },
        childRef: {
          storeRoot: join(root, 'children'),
          groupId: 'repair-group',
        },
        selectionRef: {
          kind: 'repair-selection-context',
          location: join(root, 'selector.json'),
          sha256: 'b'.repeat(64),
        },
        selectionId: 'authority',
        selectionSha256: 'b'.repeat(64),
        manifestSha256: 'c'.repeat(64),
      };
    },
    async launch() {
      launches++;
      throw new Error('Connection lost after launching a write process.');
    },
    async inspect() {
      return {
        reference: null,
        workerStarted: false,
        heartbeatCurrent: false,
        drained: false,
        issues: [],
      };
    },
    async verify() {
      throw new Error('Not ready');
    },
  };
  const runtime = new TaskRuntime({ store, repairHost: host });
  const first = await runtime.initiateRepair({
    taskId: 'goal',
    actor: 'coordinator',
    idempotencyKey: 'signal-1',
    expectedVersion: task.version,
    report,
  });
  assert.equal(launches, 1);
  assert.equal(first.repairs[0]!.reportSha256, taskDigest(report));
  assert.equal(first.repairSnapshots[0]!.state, 'RECOVERY_REQUIRED');
  assert.deepEqual(first.runs, parent);
  assert.equal(first.currentRunId, 'parent');
  await store.updateTask({
    taskId: 'goal',
    actor: 'coordinator',
    idempotencyKey: 'parent-progress',
    expectedVersion: first.version,
    nextAction: 'Continue authorized parent work',
  });
  const reopened = new TaskRuntime({
    store: await FileTaskStore.openExisting(join(root, 'tasks')),
    repairHost: host,
  });
  const second = await reopened.initiateRepair({
    taskId: 'goal',
    actor: 'coordinator',
    idempotencyKey: 'signal-2',
    expectedVersion: first.version,
    report,
  });
  assert.equal(launches, 1);
  assert.equal(second.repairs.length, 1);
  assert.equal(second.nextAction, 'Continue authorized parent work');
  assert.deepEqual(second.runs, parent);
  await assert.rejects(
    () =>
      reopened.initiateRepair({
        taskId: 'goal',
        actor: 'coordinator',
        idempotencyKey: 'signal-3',
        expectedVersion: second.version,
        report: { ...report, expectedInvariant: 'Changed requirement' },
      }),
    /immutable/,
  );
  await assert.rejects(
    () =>
      reopened.initiateRepair({
        taskId: 'goal',
        actor: 'coordinator',
        idempotencyKey: 'other',
        expectedVersion: 1,
        report: { ...report, repairId: 'another' },
      }),
    /version conflict/,
  );
});

test('a no-run parent retains an explicit missing-authority obligation and pickup context', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'task-repair-no-run-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await FileTaskStore.create(join(root, 'tasks'));
  const task = await store.createTask({
    taskId: 'goal',
    actor: 'coordinator',
    idempotencyKey: 'create',
    title: 'Original',
    goal: 'Original goal',
    workspaceRoot: root,
  });
  const runtime = new TaskRuntime({ store });
  const result = await runtime.initiateRepair({
    taskId: 'goal',
    actor: 'coordinator',
    idempotencyKey: 'missing',
    expectedVersion: task.version,
    report,
  });
  assert.equal(result.currentRunId, null);
  assert.deepEqual(result.runs, []);
  assert.equal(result.repairSnapshots[0]!.state, 'BLOCKED');
  assert.match(result.repairSnapshots[0]!.issues[0]!, /authority/);
  const pickup = await runtime.pickup({ taskId: 'goal' });
  assert.equal(pickup.selected!.repairs[0]!.repairId, report.repairId);
});
