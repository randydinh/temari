import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  readdir,
  symlink,
  open,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parallelPlan, type WorkerAssignment } from '@temari/contracts';

import {
  executeRestartableParallelWorkers,
  prepareRestartableParallelWorkers,
  FileParallelWorkerReceiptStore,
  WorkerExecutionFailure,
} from './parallel-runtime.js';
import { FileChildTaskStore } from './child-task-store.js';
import {
  FileEvidenceStore,
  streamEvidenceFile,
  verifyEvidenceFile,
  type EvidenceStore,
} from './evidence-store.js';
import { FileWorkspaceManifestStore } from './workspace-manifest.js';

test('prepares stable child identities without claiming work before the parent binds them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-parallel-prepare-'));
  try {
    const childStore = await FileChildTaskStore.create(join(root, 'children'));
    const request = {
      runId: 'prepare-1',
      revision: 'revision-1',
      plan: parallelPlan('feature', 2),
      capabilities: parallelCapabilities(),
      assignments: workerAssignments(2),
      childStore,
      owner: 'preparer',
    };
    const first = await prepareRestartableParallelWorkers(request);
    assert(
      first.tasks.every(
        (task) =>
          task.status === 'QUEUED' && task.attempt === 0 && task.lease === null,
      ),
    );
    assert.deepEqual(await prepareRestartableParallelWorkers(request), first);
    for (const task of first.tasks)
      assert.deepEqual(
        (await childStore.events(task.taskId)).map((event) => event.type),
        ['task-created'],
      );
    const executed = await executeRestartableParallelWorkers({
      ...request,
      receiptStore: await FileParallelWorkerReceiptStore.create(
        join(root, 'receipts'),
      ),
      leaseMs: 30_000,
      handler: (assignment) => result(assignment.id),
    });
    assert.deepEqual(executed.group, first.group);
    assert.equal(executed.receipt?.status, 'PASS');
    await assert.rejects(
      () =>
        prepareRestartableParallelWorkers({ ...request, maxConcurrency: 3 }),
      /plan limit/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('renews a child lease while a long-running worker is executing', async (t) => {
  for (const missedDeadline of [false, true]) {
    await t.test(
      missedDeadline
        ? 'a missed logical deadline leaves the child incomplete'
        : 'durable renewals carry the child beyond its initial lease',
      async () => {
        const root = await mkdtemp(join(tmpdir(), 'temari-parallel-runtime-'));
        try {
          const childStore = await FileChildTaskStore.create(
            join(root, 'children'),
          );
          const receiptStore = await FileParallelWorkerReceiptStore.create(
            join(root, 'receipts'),
          );
          const initialTime = Date.parse('2026-09-24T04:00:00.000Z');
          let clockMs = initialTime;
          let renewals = 0;
          let handlerCalls = 0;
          type RenewalOutcome = { ok: true } | { ok: false; error: unknown };
          let signalRenewals!: (outcome: RenewalOutcome) => void;
          const renewalsDone = new Promise<RenewalOutcome>((resolve) => {
            signalRenewals = resolve;
          });
          const renew = childStore.renew.bind(childStore);
          childStore.renew = async (request) => {
            try {
              const record = await renew(request);
              assert.deepEqual(await childStore.load(record.taskId), record);
              renewals += 1;
              if (!missedDeadline && renewals < 3) clockMs += 250;
              else signalRenewals({ ok: true });
              return record;
            } catch (error) {
              signalRenewals({ ok: false, error });
              throw error;
            }
          };
          const completed = await executeRestartableParallelWorkers({
            runId: 'parallel-runtime-renew-1',
            revision: 'revision-parallel-runtime-renew-1',
            plan: parallelPlan('feature', 1),
            capabilities: parallelCapabilities(),
            assignments: workerAssignments(1),
            childStore,
            receiptStore,
            owner: 'worker-a',
            leaseMs: 300,
            leaseRenewal: { intervalMs: 50 },
            now: () => new Date(clockMs),
            handler: async (assignment: WorkerAssignment) => {
              handlerCalls += 1;
              clockMs += missedDeadline ? 300 : 250;
              const deadline = setTimeout(
                () =>
                  signalRenewals({
                    ok: false,
                    error: new Error('Child lease renewal deadline exceeded'),
                  }),
                10_000,
              );
              try {
                const outcome = await renewalsDone;
                if (!outcome.ok) throw outcome.error;
                return result(`${assignment.id} completed after lease renewal`);
              } finally {
                clearTimeout(deadline);
              }
            },
          });

          assert.equal(handlerCalls, 1);
          const outcome = await renewalsDone;
          assert(completed.tasks[0]);
          const events = await childStore.events(completed.tasks[0].taskId);
          if (missedDeadline) {
            assert.equal(outcome.ok, false);
            if (!outcome.ok) {
              assert(outcome.error instanceof Error);
              assert.match(
                outcome.error.message,
                /Child task lease has expired/,
              );
            }
            assert.equal(renewals, 0);
            assert.equal(completed.state, 'RUNNING');
            assert.equal(completed.receipt, null);
            assert.equal(completed.tasks[0].status, 'RUNNING');
            assert.equal(
              completed.tasks[0].lease?.expiresAt,
              '2026-09-24T04:00:00.300Z',
            );
            assert.deepEqual(
              completed.pending.map((pending) => pending.reason),
              ['lease-lost'],
            );
            assert.deepEqual(
              events.map((event) => event.type),
              ['task-created', 'task-claimed'],
            );
            assert.equal(
              await receiptStore.load('parallel-runtime-renew-1'),
              null,
            );
          } else {
            if (!outcome.ok) throw outcome.error;
            assert.equal(clockMs - initialTime, 750);
            assert.equal(completed.state, 'COMPLETE');
            assert.equal(completed.receipt?.status, 'PASS');
            assert.equal(events[0]?.type, 'task-created');
            assert.equal(events[1]?.type, 'task-claimed');
            assert(
              events.some((event) => event.type === 'task-lease-renewed'),
              'The long-running child should publish at least one lease renewal.',
            );
            assert.deepEqual(
              events
                .filter((event) => event.type === 'task-lease-renewed')
                .slice(0, 3)
                .map((event) => event.payload.expiresAt),
              [
                '2026-09-24T04:00:00.550Z',
                '2026-09-24T04:00:00.800Z',
                '2026-09-24T04:00:01.050Z',
              ],
            );
            assert.equal(events.at(-1)?.type, 'task-completed');
          }
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      },
    );
  }
});

test('keeps a larger restartable batch within its declared concurrency bound', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-parallel-runtime-'));
  try {
    const childStore = await FileChildTaskStore.create(join(root, 'children'));
    const receiptStore = await FileParallelWorkerReceiptStore.create(
      join(root, 'receipts'),
    );
    let active = 0;
    let peak = 0;
    let calls = 0;
    const request = {
      runId: 'parallel-runtime-bound-1',
      revision: 'revision-parallel-runtime-bound-1',
      plan: parallelPlan('feature', 3),
      capabilities: parallelCapabilities(),
      assignments: workerAssignments(12),
      childStore,
      receiptStore,
      owner: 'worker-a',
      leaseMs: 30_000,
      now: fixedClock(),
      handler: async (assignment: WorkerAssignment) => {
        calls += 1;
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return result(`${assignment.id} bounded complete`);
      },
    } as const;
    let completed = await executeRestartableParallelWorkers(request);
    while (completed.state === 'RUNNING') {
      completed = await executeRestartableParallelWorkers(request);
    }

    assert.equal(completed.state, 'COMPLETE');
    assert.equal(completed.receipt?.status, 'PASS');
    assert.equal(calls, 12);
    assert(peak <= 3);
    assert.equal(completed.receipt?.peakConcurrency, peak);
    assert.equal(completed.receipt?.executionEvidence?.maxConcurrency, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resumes a bounded child batch and joins terminal results in declaration order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-parallel-runtime-'));
  try {
    const childStore = await FileChildTaskStore.create(join(root, 'children'));
    const receiptStore = await FileParallelWorkerReceiptStore.create(
      join(root, 'receipts'),
    );
    const assignments = workerAssignments(3);
    const calls: string[] = [];
    const request = {
      runId: 'parallel-runtime-1',
      revision: 'revision-parallel-runtime-1',
      plan: parallelPlan('feature', 2),
      capabilities: parallelCapabilities(),
      assignments,
      childStore,
      receiptStore,
      owner: 'worker-a',
      leaseMs: 30_000,
      now: fixedClock(),
      handler: async (assignment: WorkerAssignment) => {
        calls.push(assignment.id);
        await new Promise((resolve) => setTimeout(resolve, 2));
        return result(`${assignment.id} complete`);
      },
    } as const;

    const first = await executeRestartableParallelWorkers(request);
    assert.equal(first.state, 'RUNNING');
    assert.equal(first.receipt, null);
    assert.deepEqual(
      first.pending.map((item) => item.reason),
      ['queued'],
    );
    assert.equal(calls.length, 2);

    const second = await executeRestartableParallelWorkers({
      ...request,
      receiptStore: await FileParallelWorkerReceiptStore.create(
        join(root, 'receipts'),
      ),
    });
    assert.equal(second.state, 'COMPLETE');
    assert.equal(second.receipt?.status, 'PASS');
    assert.equal(second.receipt?.peakConcurrency, 2);
    assert.deepEqual(second.receipt?.executionEvidence, {
      schema: 1,
      groupId: second.group?.groupId,
      assignmentIds: assignments.map((assignment) => assignment.id),
      maxConcurrency: 2,
      peakConcurrency: 2,
    });
    assert.deepEqual(
      second.receipt?.outcomes.map((outcome) => outcome.assignment.id),
      ['worker-1', 'worker-2', 'worker-3'],
    );
    assert.deepEqual(calls, ['worker-1', 'worker-2', 'worker-3']);

    const replay = await executeRestartableParallelWorkers(request);
    assert.equal(replay.state, 'COMPLETE');
    assert.deepEqual(replay.receipt, second.receipt);
    assert.deepEqual(calls, ['worker-1', 'worker-2', 'worker-3']);

    const persisted = await receiptStore.load(request.runId);
    assert(persisted);
    const legacyReceiptStore = {
      save: receiptStore.save.bind(receiptStore),
      load: async () => ({
        ...persisted,
        receipt: { ...persisted.receipt, executionEvidence: undefined },
      }),
    };
    await assert.rejects(
      executeRestartableParallelWorkers({
        ...request,
        receiptStore: legacyReceiptStore,
      }),
      /missing execution evidence/,
    );

    await assert.rejects(
      executeRestartableParallelWorkers({
        ...request,
        assignments: workerAssignments(2),
      }),
      /Parallel receipt binding changed/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('retains a thrown handler as FAILED mechanics and a blocked semantic receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-parallel-runtime-'));
  try {
    const childStore = await FileChildTaskStore.create(join(root, 'children'));
    const receiptStore = await FileParallelWorkerReceiptStore.create(
      join(root, 'receipts'),
    );
    const assignments = workerAssignments(1);
    const result = await executeRestartableParallelWorkers({
      runId: 'parallel-runtime-2',
      revision: 'revision-parallel-runtime-2',
      plan: parallelPlan('feature', 1),
      capabilities: parallelCapabilities(),
      assignments,
      childStore,
      receiptStore,
      owner: 'worker-a',
      leaseMs: 30_000,
      now: fixedClock(),
      handler: () => {
        throw new Error('lease expired while contacting worker');
      },
    });

    assert.equal(result.state, 'COMPLETE');
    assert.equal(result.receipt?.status, 'BLOCKED');
    assert.equal(result.receipt?.failure?.kind, 'worker-error');
    assert.equal(result.receipt?.outcomes[0]?.result, null);
    assert.equal(
      result.receipt?.outcomes[0]?.error,
      'lease expired while contacting worker',
    );
    assert.equal(result.tasks[0]?.status, 'FAILED');
    assert.equal(result.tasks[0]?.result, null);
    assert.equal(
      result.tasks[0]?.error,
      'lease expired while contacting worker',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('persists bounded diagnostics for blank and oversized worker failures', async (t) => {
  const oversized = 'worker failed: '.repeat(400);
  const combined = `${'handler failure; '.repeat(200)}lease renewal failed: ${'timeout '.repeat(200)}`;
  const cases = [
    {
      name: 'empty Error',
      thrown: new Error(''),
      expected: 'Worker failed without a diagnostic message.',
    },
    {
      name: 'whitespace Error',
      thrown: new Error('   '),
      expected: 'Worker failed without a diagnostic message.',
    },
    { name: 'oversized Error', thrown: new Error(oversized), expected: null },
    {
      name: 'combined oversized Error',
      thrown: new Error(combined),
      expected: null,
    },
    {
      name: 'unprintable thrown value',
      thrown: {
        toString: () => {
          throw new Error('unprintable');
        },
      },
      expected: 'Worker failed without a diagnostic message.',
    },
  ];

  for (const [index, entry] of cases.entries()) {
    await t.test(entry.name, async () => {
      const root = await mkdtemp(join(tmpdir(), 'temari-parallel-runtime-'));
      try {
        const childStore = await FileChildTaskStore.create(
          join(root, 'children'),
        );
        const receiptStore = await FileParallelWorkerReceiptStore.create(
          join(root, 'receipts'),
        );
        const completed = await executeRestartableParallelWorkers({
          runId: `parallel-runtime-error-${index}`,
          revision: `revision-parallel-runtime-error-${index}`,
          plan: parallelPlan('feature', 1),
          capabilities: parallelCapabilities(),
          assignments: workerAssignments(1),
          childStore,
          receiptStore,
          owner: 'worker-a',
          leaseMs: 30_000,
          now: fixedClock(),
          handler: () => {
            throw entry.thrown;
          },
        });

        const task = completed.tasks[0];
        assert(task);
        assert.equal(completed.state, 'COMPLETE');
        assert.equal(completed.receipt?.status, 'BLOCKED');
        assert.equal(completed.receipt?.failure?.kind, 'worker-error');
        assert.equal(task.status, 'FAILED');
        assert.equal(task.result, null);
        assert(task.error);
        assert(task.error.trim().length > 0);
        assert(task.error.length <= 4096);
        assert.equal(completed.receipt?.outcomes[0]?.error, task.error);
        assert.deepEqual(await childStore.load(task.taskId), task);
        assert.equal(
          (await childStore.events(task.taskId)).at(-1)?.type,
          'task-completed',
        );
        if (entry.expected !== null) {
          assert.equal(task.error, entry.expected);
        } else {
          const original = (entry.thrown as Error).message;
          const digest = createHash('sha256').update(original).digest('hex');
          assert.equal(task.error.length, 4096);
          assert(task.error.endsWith(`... [truncated; sha256=${digest}]`));
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test('an oversized first failure remains retryable under the attempt bound', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-parallel-runtime-'));
  try {
    const childStore = await FileChildTaskStore.create(join(root, 'children'));
    const receiptStore = await FileParallelWorkerReceiptStore.create(
      join(root, 'receipts'),
    );
    let calls = 0;
    const completed = await executeRestartableParallelWorkers({
      runId: 'parallel-runtime-error-retry',
      revision: 'revision-parallel-runtime-error-retry',
      plan: parallelPlan('feature', 1),
      capabilities: parallelCapabilities(),
      assignments: workerAssignments(1),
      childStore,
      receiptStore,
      owner: 'worker-a',
      leaseMs: 30_000,
      retryPolicy: { maxAttempts: 2 },
      now: fixedClock(),
      handler: () => {
        calls += 1;
        if (calls === 1) throw new Error('x'.repeat(4097));
        return result('retry succeeded');
      },
    });

    assert.equal(calls, 2);
    assert.equal(completed.state, 'COMPLETE');
    assert.equal(completed.receipt?.status, 'PASS');
    assert.equal(completed.tasks[0]?.attempt, 2);
    assert.equal(completed.tasks[0]?.status, 'SUCCEEDED');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('retries mechanical child failures within an explicit attempt bound', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-parallel-runtime-'));
  try {
    const childStore = await FileChildTaskStore.create(join(root, 'children'));
    const receiptStore = await FileParallelWorkerReceiptStore.create(
      join(root, 'receipts'),
    );
    let calls = 0;
    const request = {
      runId: 'parallel-runtime-retry-1',
      revision: 'revision-parallel-runtime-retry-1',
      plan: parallelPlan('feature', 1),
      capabilities: parallelCapabilities(),
      assignments: workerAssignments(1),
      childStore,
      receiptStore,
      owner: 'worker-a',
      leaseMs: 30_000,
      retryPolicy: { maxAttempts: 2 },
      now: fixedClock(),
      handler: () => {
        calls += 1;
        if (calls === 1) throw new Error('transient worker failure');
        return result('retry succeeded');
      },
    } as const;

    const completed = await executeRestartableParallelWorkers(request);
    assert.equal(completed.state, 'COMPLETE');
    assert.equal(completed.receipt?.status, 'PASS');
    assert.equal(calls, 2);
    assert.equal(completed.tasks[0]?.attempt, 2);
    assert.equal(completed.tasks[0]?.status, 'SUCCEEDED');
    assert.deepEqual(
      (await childStore.events(completed.tasks[0]?.taskId as string)).map(
        (event) => event.type,
      ),
      [
        'task-created',
        'task-claimed',
        'task-completed',
        'task-retried',
        'task-claimed',
        'task-completed',
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('stops mechanical retries at the declared attempt bound', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-parallel-runtime-'));
  try {
    const childStore = await FileChildTaskStore.create(join(root, 'children'));
    const receiptStore = await FileParallelWorkerReceiptStore.create(
      join(root, 'receipts'),
    );
    let calls = 0;
    const completed = await executeRestartableParallelWorkers({
      runId: 'parallel-runtime-retry-2',
      revision: 'revision-parallel-runtime-retry-2',
      plan: parallelPlan('feature', 1),
      capabilities: parallelCapabilities(),
      assignments: workerAssignments(1),
      childStore,
      receiptStore,
      owner: 'worker-a',
      leaseMs: 30_000,
      retryPolicy: { maxAttempts: 2 },
      now: fixedClock(),
      handler: () => {
        calls += 1;
        throw new Error(`failure ${calls}`);
      },
    });

    assert.equal(completed.state, 'COMPLETE');
    assert.equal(completed.receipt?.status, 'BLOCKED');
    assert.equal(calls, 2);
    assert.equal(completed.tasks[0]?.attempt, 2);
    assert.equal(completed.tasks[0]?.status, 'FAILED');
    assert.equal(completed.tasks[0]?.error, 'failure 2');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('durably cancels queued assignments and keeps the join incomplete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-parallel-runtime-'));
  try {
    const childStore = await FileChildTaskStore.create(join(root, 'children'));
    const receiptStore = await FileParallelWorkerReceiptStore.create(
      join(root, 'receipts'),
    );
    let calls = 0;
    const execution = await executeRestartableParallelWorkers({
      runId: 'parallel-runtime-cancel-1',
      revision: 'revision-parallel-runtime-cancel-1',
      plan: parallelPlan('feature', 1),
      capabilities: parallelCapabilities(),
      assignments: workerAssignments(2),
      childStore,
      receiptStore,
      owner: 'worker-a',
      leaseMs: 30_000,
      cancellation: { assignmentIds: ['worker-2'] },
      now: fixedClock(),
      handler: () => {
        calls += 1;
        return result('first assignment complete');
      },
    });

    assert.equal(execution.state, 'BLOCKED');
    assert.equal(execution.receipt, null);
    assert.equal(calls, 1);
    assert.deepEqual(
      execution.pending.map((item) => item.reason),
      ['cancellation-gated'],
    );
    assert.equal(execution.tasks[1]?.status, 'CANCELLED');
    assert.equal(await receiptStore.load('parallel-runtime-cancel-1'), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an active child cancellation blocks the join even when its handler returns PASS', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-parallel-runtime-'));
  try {
    const childStore = await FileChildTaskStore.create(join(root, 'children'));
    const receiptStore = await FileParallelWorkerReceiptStore.create(
      join(root, 'receipts'),
    );
    const claimGroup = childStore.claimGroup.bind(childStore);
    let taskId: string | null = null;
    childStore.claimGroup = async (request) => {
      const reservation = await claimGroup(request);
      taskId = reservation.group.taskIds[0] ?? null;
      return reservation;
    };
    let calls = 0;
    const request = {
      runId: 'parallel-runtime-active-cancel',
      revision: 'revision-parallel-runtime-active-cancel',
      plan: parallelPlan('feature', 1),
      capabilities: parallelCapabilities(),
      assignments: workerAssignments(1),
      childStore,
      receiptStore,
      owner: 'worker-a',
      leaseMs: 30_000,
      now: fixedClock(),
      handler: async () => {
        calls += 1;
        assert(taskId);
        await childStore.cancel({
          taskId,
          actor: 'coordinator',
          idempotencyKey: 'cancel:active-worker',
          now: fixedClock()(),
        });
        return result('handler completed after cancellation');
      },
    } as const;
    const execution = await executeRestartableParallelWorkers(request);
    assert.equal(execution.state, 'BLOCKED');
    assert.equal(execution.receipt, null);
    assert.equal(execution.tasks[0]?.status, 'CANCELLED');
    assert.deepEqual(
      execution.pending.map((item) => item.reason),
      ['cancellation-gated'],
    );
    assert.equal(calls, 1);
    assert(taskId);
    const events = await childStore.events(taskId);
    assert.deepEqual(
      events.map((event) => event.type),
      [
        'task-created',
        'task-claimed',
        'task-cancellation-requested',
        'task-completed',
      ],
    );
    assert.equal(events.at(-1)?.payload.cancellationRequested, true);
    const replay = await executeRestartableParallelWorkers(request);
    assert.equal(replay.state, 'BLOCKED');
    assert.equal(calls, 1);
    assert.equal(await receiptStore.load(request.runId), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('publishes and verifies a workspace manifest for every completed child', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-parallel-runtime-'));
  try {
    const childStore = await FileChildTaskStore.create(join(root, 'children'));
    const receiptStore = await FileParallelWorkerReceiptStore.create(
      join(root, 'receipts'),
    );
    const manifestStore = await FileWorkspaceManifestStore.create(
      join(root, 'manifests'),
    );
    const assignments = workerAssignments(2);
    for (const assignment of assignments) {
      const workspaceRoot = join(root, assignment.id);
      await mkdir(workspaceRoot, { recursive: true });
      await writeFile(join(workspaceRoot, 'input.txt'), assignment.id);
    }
    const request = {
      runId: 'parallel-runtime-manifest-1',
      revision: 'revision-parallel-runtime-manifest-1',
      plan: parallelPlan('feature', 2),
      capabilities: parallelCapabilities(),
      assignments,
      childStore,
      receiptStore,
      owner: 'worker-a',
      leaseMs: 30_000,
      workspaceManifestStore: manifestStore,
      workspaceForAssignment: (assignment: WorkerAssignment) => ({
        workspaceId: assignment.id,
        root: join(root, assignment.id),
      }),
      now: fixedClock(),
      handler: async (assignment: WorkerAssignment) => {
        await writeFile(
          join(root, assignment.id, 'output.txt'),
          `${assignment.id} output`,
        );
        return result(`${assignment.id} complete`);
      },
    } as const;

    const completed = await executeRestartableParallelWorkers(request);
    assert.equal(completed.state, 'COMPLETE');
    assert.equal(completed.receipt?.status, 'PASS');
    for (const task of completed.tasks) {
      assert.equal(task.result?.workspaceManifestId, task.taskId);
      assert(await manifestStore.load(request.runId, task.taskId));
    }

    await writeFile(join(root, assignments[0]!.id, 'output.txt'), 'changed');
    await assert.rejects(
      executeRestartableParallelWorkers(request),
      /Workspace manifest changed|Workspace file changed/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('publishes portable worker evidence and refuses replay when the artifact is missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-parallel-runtime-'));
  try {
    const childStore = await FileChildTaskStore.create(join(root, 'children'));
    const receiptStore = await FileParallelWorkerReceiptStore.create(
      join(root, 'receipts'),
    );
    const evidenceStore = await FileEvidenceStore.create(
      join(root, 'evidence'),
    );
    let calls = 0;
    const request = {
      runId: 'parallel-runtime-evidence-1',
      revision: 'revision-parallel-runtime-evidence-1',
      plan: parallelPlan('feature', 1),
      capabilities: parallelCapabilities(),
      assignments: workerAssignments(1),
      childStore,
      receiptStore,
      evidenceStore,
      evidenceForAssignment: (assignment: WorkerAssignment) => [
        {
          kind: 'worker-result' as const,
          content: JSON.stringify({
            assignment: assignment.id,
            verdict: 'PASS',
          }),
        },
      ],
      owner: 'worker-a',
      leaseMs: 30_000,
      now: fixedClock(),
      handler: () => {
        calls += 1;
        return result('evidence published');
      },
    } as const;

    const completed = await executeRestartableParallelWorkers(request);
    assert.equal(completed.state, 'COMPLETE');
    assert.equal(calls, 1);
    const reference = completed.tasks[0]?.result?.evidenceReferences?.[0];
    assert(reference);
    assert.equal(reference.runId, request.runId);
    assert.equal(reference.revision, request.revision);
    assert.equal('path' in reference, false);
    assert.deepEqual(
      await evidenceStore.loadPortable(reference),
      Buffer.from(JSON.stringify({ assignment: 'worker-1', verdict: 'PASS' })),
    );

    const replay = await executeRestartableParallelWorkers(request);
    assert.equal(replay.state, 'COMPLETE');
    assert.equal(calls, 1);

    await rm(join(root, 'evidence', `${reference.sha256}.artifact`));
    await assert.rejects(
      executeRestartableParallelWorkers(request),
      /ENOENT|Evidence artifact|evidence/i,
    );
    assert.equal(calls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses a partial join while another owner holds a child lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-parallel-runtime-'));
  try {
    const childStore = await FileChildTaskStore.create(join(root, 'children'));
    const receiptStore = await FileParallelWorkerReceiptStore.create(
      join(root, 'receipts'),
    );
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const request = {
      runId: 'parallel-runtime-3',
      revision: 'revision-parallel-runtime-3',
      plan: parallelPlan('feature', 1),
      capabilities: parallelCapabilities(),
      assignments: workerAssignments(2),
      childStore,
      receiptStore,
      owner: 'worker-a',
      leaseMs: 30_000,
      now: fixedClock(),
      handler: async () => {
        markStarted();
        await blocked;
        return result('complete after lease');
      },
    } as const;
    const firstPromise = executeRestartableParallelWorkers(request);
    await started;

    const concurrent = await executeRestartableParallelWorkers({
      ...request,
      owner: 'worker-b',
      handler: () => result('must not execute'),
    });
    assert.equal(concurrent.state, 'RUNNING');
    assert.equal(concurrent.receipt, null);
    assert.equal(concurrent.pending[0]?.reason, 'active-lease');
    assert.equal(concurrent.pending[1]?.reason, 'queued');

    release();
    const first = await firstPromise;
    assert.equal(first.state, 'RUNNING');
    assert.equal(first.pending[0]?.reason, 'queued');

    const resumed = await executeRestartableParallelWorkers({
      ...request,
      handler: () => result('second child complete'),
    });
    assert.equal(resumed.state, 'COMPLETE');
    assert.equal(resumed.receipt?.status, 'PASS');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const fault of [
  'none',
  'evidence',
  'completion',
  'readback',
  'missing-signal',
  'failed-drain',
  'slow-held-start',
] as const) {
  test(
    fault === 'none'
      ? 'recovers one expired child through a second independent coordinator'
      : `takeover barrier propagates ${fault} and drains the held child`,
    async () => {
      let cleaned = false;
      let secondStarted = false;
      let secondSettled = false;
      let secondDone: Promise<void> | null = null;
      const run = (async () => {
        const root = await mkdtemp(join(tmpdir(), 'temari-parallel-runtime-'));
        let release = (): void => undefined;
        let first: ReturnType<typeof executeRestartableParallelWorkers> | null =
          null;
        try {
          const childRoot = join(root, 'children');
          const receiptRoot = join(root, 'receipts');
          const evidenceRoot = join(root, 'evidence');
          const manifestRoot = join(root, 'manifests');
          const childStoreA = await FileChildTaskStore.create(childRoot);
          const childStoreB = await FileChildTaskStore.create(childRoot);
          const receiptStoreA =
            await FileParallelWorkerReceiptStore.create(receiptRoot);
          const receiptStoreB =
            await FileParallelWorkerReceiptStore.create(receiptRoot);
          const evidenceStoreA = await FileEvidenceStore.create(evidenceRoot);
          const evidenceStoreB = await FileEvidenceStore.create(evidenceRoot);
          const manifestStoreA =
            await FileWorkspaceManifestStore.create(manifestRoot);
          const manifestStoreB =
            await FileWorkspaceManifestStore.create(manifestRoot);
          const assignments = workerAssignments(2);
          for (const assignment of assignments) {
            const workspaceRoot = join(root, assignment.id);
            await mkdir(workspaceRoot, { recursive: true });
            await writeFile(join(workspaceRoot, 'input.txt'), assignment.id);
          }

          let markStarted!: () => void;
          const started = new Promise<void>((resolve) => {
            markStarted = resolve;
          });
          let markWorkerOneDone!: () => void;
          let rejectWorkerOneDone!: (error: unknown) => void;
          const workerOneDone = new Promise<void>((resolve, reject) => {
            markWorkerOneDone = resolve;
            rejectWorkerOneDone = reject;
          });
          let markSecondDone!: () => void;
          secondDone = new Promise<void>((resolve) => {
            markSecondDone = resolve;
          });
          let secondTaskId: string | undefined;
          const claimGroupA = childStoreA.claimGroup.bind(childStoreA);
          childStoreA.claimGroup = async (request) => {
            const claimed = await claimGroupA(request);
            const index = claimed.group.assignmentIds.indexOf('worker-2');
            assert(index >= 0);
            secondTaskId = claimed.group.taskIds[index];
            assert(secondTaskId);
            return claimed;
          };
          const completeChildA = childStoreA.complete.bind(childStoreA);
          childStoreA.complete = async (request) => {
            const isSecond = request.taskId === secondTaskId;
            try {
              if (!isSecond && fault === 'completion')
                throw new Error('takeover probe: completion');
              const record = await completeChildA(request);
              if (!isSecond) {
                if (
                  record.status !== 'SUCCEEDED' &&
                  record.failureDiagnostics?.references[0]
                ) {
                  const retained = await evidenceStoreA.loadPortable(
                    record.failureDiagnostics.references[0],
                  );
                  assert(
                    Buffer.from(retained)
                      .toString()
                      .includes(`takeover probe: ${fault}`),
                  );
                }
                if (record.status !== 'SUCCEEDED')
                  throw new Error(
                    record.error ?? `Worker-1 completed as ${record.status}`,
                  );
                assert.equal(record.result?.summary, 'worker-1 complete');
                if (fault === 'readback')
                  throw new Error('takeover probe: readback');
                assert.deepEqual(await childStoreB.load(record.taskId), record);
                if (fault !== 'missing-signal') markWorkerOneDone();
              }
              return record;
            } catch (error) {
              if (!isSecond) rejectWorkerOneDone(error);
              throw error;
            } finally {
              if (isSecond) {
                secondSettled = true;
                markSecondDone();
              }
            }
          };
          const interrupted = new Promise<void>((resolve) => {
            release = resolve;
          });
          let firstWorkerCalls = 0;
          let resumedWorkerCalls = 0;
          let clockMs = Date.now();
          const now = () => new Date(clockMs);
          const common = {
            runId: 'parallel-runtime-takeover-1',
            revision: 'revision-parallel-runtime-takeover-1',
            plan: parallelPlan('feature', 2),
            capabilities: parallelCapabilities(),
            assignments,
            leaseMs: 200,
            maxConcurrency: 2,
            evidenceForAssignment: (assignment: WorkerAssignment) => [
              {
                kind: 'worker-result' as const,
                content: `${assignment.id}:retained-evidence`,
              },
            ],
            workspaceForAssignment: (assignment: WorkerAssignment) => ({
              workspaceId: assignment.id,
              root: join(root, assignment.id),
            }),
            now,
          } as const;
          first = executeRestartableParallelWorkers({
            ...common,
            childStore: childStoreA,
            receiptStore: receiptStoreA,
            evidenceStore: evidenceStoreA,
            workspaceManifestStore: manifestStoreA,
            owner: 'coordinator-a',
            evidenceForAssignment: async (assignment: WorkerAssignment) => {
              if (assignment.id === 'worker-1') {
                await new Promise((resolve) => setTimeout(resolve, 250));
                if (
                  fault === 'evidence' ||
                  fault === 'failed-drain' ||
                  fault === 'slow-held-start'
                )
                  throw new Error(`takeover probe: ${fault}`);
              }
              if (assignment.id === 'worker-2' && fault === 'failed-drain')
                throw new Error('held child evidence failure');
              return common.evidenceForAssignment(assignment);
            },
            handler: async (assignment: WorkerAssignment) => {
              firstWorkerCalls += 1;
              if (assignment.id === 'worker-2') secondStarted = true;
              if (assignment.id === 'worker-2' && fault === 'slow-held-start')
                await new Promise((resolve) => setTimeout(resolve, 750));
              await writeFile(
                join(root, assignment.id, 'output.txt'),
                `${assignment.id}:resumed-output`,
              );
              if (assignment.id === 'worker-2') {
                markStarted();
                await interrupted;
              }
              return result(`${assignment.id} complete`);
            },
          });
          let deadline: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              Promise.all([started, workerOneDone]),
              first.then(() => {
                throw new Error(
                  'Coordinator completed before takeover readiness',
                );
              }),
              new Promise<never>((_resolve, reject) => {
                deadline = setTimeout(
                  () =>
                    reject(new Error('takeover readiness deadline exceeded')),
                  fault === 'missing-signal' ? 1000 : 10_000,
                );
              }),
            ]);
          } finally {
            clearTimeout(deadline);
          }
          clockMs += 350;

          const resumed = await executeRestartableParallelWorkers({
            ...common,
            childStore: childStoreB,
            receiptStore: receiptStoreB,
            evidenceStore: evidenceStoreB,
            workspaceManifestStore: manifestStoreB,
            owner: 'coordinator-b',
            handler: async (assignment: WorkerAssignment) => {
              resumedWorkerCalls += 1;
              assert.equal(assignment.id, 'worker-2');
              await writeFile(
                join(root, assignment.id, 'output.txt'),
                `${assignment.id}:resumed-output`,
              );
              return result(`${assignment.id} complete`);
            },
          });

          assert.equal(resumed.state, 'COMPLETE');
          assert.equal(resumed.receipt?.status, 'PASS');
          assert.equal(resumed.receipt?.peakConcurrency, 2);
          assert.equal(resumedWorkerCalls, 1);
          for (const outcome of resumed.receipt?.outcomes ?? []) {
            assert(outcome.result?.evidenceReferences?.length);
            for (const reference of outcome.result.evidenceReferences) {
              await evidenceStoreB.loadPortable(reference);
            }
          }
          for (const task of resumed.tasks) {
            assert(await manifestStoreB.load(common.runId, task.taskId));
          }

          release();
          assert(first);
          const firstResult = await first;
          assert.equal(firstResult.state, 'COMPLETE');
          assert.equal(firstResult.receipt?.status, 'PASS');
          assert.equal(firstWorkerCalls, 2);
          const persisted = await receiptStoreB.load(common.runId);
          assert(persisted);
          assert.equal(persisted.receipt.status, 'PASS');
        } finally {
          release();
          if (first) await first.catch(() => undefined);
          if (secondStarted) await secondDone;
          await rm(root, { recursive: true, force: true });
          cleaned = true;
        }
      })();
      if (fault === 'none') await run;
      else
        await assert.rejects(
          run,
          fault === 'evidence' ||
            fault === 'slow-held-start' ||
            fault === 'failed-drain'
            ? /Worker execution failed; diagnostics retained; sha256=/
            : {
                message:
                  fault === 'missing-signal'
                    ? 'takeover readiness deadline exceeded'
                    : `takeover probe: ${fault}`,
              },
        );
      assert.equal(secondSettled, true);
      assert.equal(cleaned, true);
    },
  );
}

test('repairs an interrupted completion without rerunning the handler', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-parallel-runtime-'));
  try {
    const childStore = await FileChildTaskStore.create(join(root, 'children'));
    const receiptStore = await FileParallelWorkerReceiptStore.create(
      join(root, 'receipts'),
    );
    const assignments = workerAssignments(1);
    let calls = 0;
    const request = {
      runId: 'parallel-runtime-recovery-1',
      revision: 'revision-parallel-runtime-recovery-1',
      plan: parallelPlan('feature', 1),
      capabilities: parallelCapabilities(),
      assignments,
      childStore,
      receiptStore,
      owner: 'worker-a',
      leaseMs: 30_000,
      now: fixedClock(),
      handler: () => {
        calls += 1;
        return result('recovered completion');
      },
    } as const;

    setFailureInjection('after-state-publication');
    await assert.rejects(
      executeRestartableParallelWorkers(request),
      /Injected child task store interruption/,
    );

    const resumed = await executeRestartableParallelWorkers(request);
    assert.equal(resumed.state, 'COMPLETE');
    assert.equal(resumed.receipt?.status, 'PASS');
    assert.equal(calls, 1);
  } finally {
    setFailureInjection(null);
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses receipt replay when an expected child state is missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-parallel-runtime-'));
  try {
    const childStore = await FileChildTaskStore.create(join(root, 'children'));
    const receiptStore = await FileParallelWorkerReceiptStore.create(
      join(root, 'receipts'),
    );
    const request = {
      runId: 'parallel-runtime-recovery-2',
      revision: 'revision-parallel-runtime-recovery-2',
      plan: parallelPlan('feature', 1),
      capabilities: parallelCapabilities(),
      assignments: workerAssignments(1),
      childStore,
      receiptStore,
      owner: 'worker-a',
      leaseMs: 30_000,
      now: fixedClock(),
      handler: () => result('complete before corruption'),
    } as const;

    const completed = await executeRestartableParallelWorkers(request);
    assert.equal(completed.state, 'COMPLETE');
    const taskId = completed.tasks[0]?.taskId;
    assert(taskId);
    await rm(join(root, 'children', `${taskId}.task.json`));

    await assert.rejects(
      executeRestartableParallelWorkers(request),
      /missing its state|refusing stale replay/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('concurrent receipt publication converges on one persisted winner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-parallel-runtime-'));
  try {
    const receiptStore = await FileParallelWorkerReceiptStore.create(root);
    const binding = {
      groupId: 'parallel-receipt-race-group',
      fingerprint: 'a'.repeat(64),
    };
    const first = receipt('parallel-receipt-race', 0);
    const second = receipt('parallel-receipt-race', 1);
    await Promise.all([
      receiptStore.save(first, binding),
      receiptStore.save(second, binding),
    ]);

    const persisted = await receiptStore.load('parallel-receipt-race');
    assert(persisted);
    assert.equal(persisted.binding.groupId, binding.groupId);
    assert([0, 1].includes(persisted.receipt.peakConcurrency));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function result(summary: string) {
  return {
    status: 'PASS' as const,
    summary,
    evidencePaths: [`evidence/${summary.replaceAll(' ', '-')}.json`],
    rawLogPath: null,
  };
}

function receipt(runId: string, peakConcurrency: number) {
  return {
    schema: 1 as const,
    runId,
    revision: 'revision-parallel-receipt-race',
    startedAt: '2026-09-24T04:00:00.000Z',
    completedAt: '2026-09-24T04:00:01.000Z',
    status: 'PASS' as const,
    maxConcurrency: 1,
    peakConcurrency,
    outcomes: [],
    failure: null,
  };
}

function workerAssignments(count: number): WorkerAssignment[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `worker-${index + 1}`,
    role: 'investigator' as const,
    required: true,
    brief: {
      goal: `Inspect work item ${index + 1}`,
      context: 'The coordinator supplied bounded context.',
      scope: `Work item ${index + 1} only`,
      acceptanceCriteria: ['Return retained evidence.'],
      verificationCommand: null,
      reportFormat: 'json' as const,
      forbiddenActions: ['Do not modify shared state.'],
    },
  }));
}

function parallelCapabilities() {
  return {
    host: 'cursor',
    available: [
      'subagents',
      'parallelism',
      'model_diversity',
      'worktree_isolation',
      'durable_delivery',
      'forge',
    ] as const,
    missing: [] as const,
    notes: {},
  };
}

function fixedClock(): () => Date {
  return () => new Date('2026-09-24T04:00:00.000Z');
}

type FailureInjectionStage =
  | 'after-sidecar-fsync'
  | 'after-state-publication'
  | 'after-event-publication'
  | 'after-sidecar-removal';

function setFailureInjection(stage: FailureInjectionStage | null): void {
  const constructor = FileChildTaskStore as unknown as {
    failureInjection: FailureInjectionStage | null;
  };
  constructor.failureInjection = stage;
}

async function* largeDiagnosticBytes() {
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  for (let index = 0; index < 256; index++) yield chunk;
  yield Buffer.from('!');
}

function largeDiagnosticHash() {
  const hash = createHash('sha256');
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  for (let index = 0; index < 256; index++) hash.update(chunk);
  return hash.update('!').digest('hex');
}

test('streamed evidence retains exact bytes beyond 16 MiB, validates duplicates, and refuses tamper, missing and symlink sources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-stream-evidence-'));
  try {
    const store = await FileEvidenceStore.create(join(root, 'evidence'));
    const request = {
      runId: 'stream-1',
      revision: 'revision-1',
      kind: 'stderr' as const,
    };
    const reference = await store.putStream({
      ...request,
      content: largeDiagnosticBytes(),
    });
    assert.equal(reference.bytes, 16_777_217);
    assert.equal(reference.sha256, largeDiagnosticHash());
    await store.verifyPortable(reference);
    assert.deepEqual(
      await store.putStream({ ...request, content: largeDiagnosticBytes() }),
      reference,
    );
    await assert.rejects(store.load(reference), /16 MiB/);
    await assert.rejects(
      store.put({ ...request, content: Buffer.alloc(16_777_217) }),
      /16 MiB/,
    );
    await assert.rejects(
      store.verifyPortable({ ...reference, bytes: reference.bytes + 1 }),
      /byte count/,
    );
    await mkdir(join(root, 'sources'));
    await symlink(reference.path, join(root, 'sources', 'linked'));
    await assert.rejects(
      store.putStream({
        ...request,
        content: streamEvidenceFile(
          join(root, 'sources', 'linked'),
          join(root, 'sources'),
        ),
      }),
      /symlink/,
    );
    await assert.rejects(
      store.putStream({
        ...request,
        content: streamEvidenceFile(reference.path, join(root, 'sources')),
      }),
      /outside/,
    );
    await symlink(
      join(root, 'evidence'),
      join(root, 'sources', 'linked-parent'),
    );
    await assert.rejects(
      store.putStream({
        ...request,
        content: streamEvidenceFile(
          join(
            root,
            'sources',
            'linked-parent',
            `${reference.sha256}.artifact`,
          ),
          join(root, 'sources'),
        ),
      }),
      /symlink/,
    );
    const file = await open(reference.path, 'r+');
    await file.write(Buffer.from('b'), 0, 1, 0);
    await file.close();
    await assert.rejects(store.verifyPortable(reference), /hash changed/);
    await assert.rejects(
      store.putStream({ ...request, content: largeDiagnosticBytes() }),
      /hash changed/,
    );
    await rm(reference.path);
    await assert.rejects(store.verifyPortable(reference), /ENOENT/);
    await store.putStream({ ...request, content: largeDiagnosticBytes() });
    await rm(reference.path);
    await symlink(join(root, 'sources'), reference.path);
    await assert.rejects(store.verifyPortable(reference), /symlink/);
    assert(
      (await readdir(join(root, 'evidence'))).every(
        (name) => !name.endsWith('.tmp'),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('stream publication cleans temporary files after source, write, fsync, and publication errors', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'temari-stream-errors-'));
  try {
    const store = await FileEvidenceStore.create(join(root, 'evidence'));
    const request = {
      runId: 'stream-errors',
      revision: 'revision-1',
      kind: 'stderr' as const,
    };
    await assert.rejects(
      store.putStream({
        ...request,
        content: (async function* () {
          yield Buffer.from('partial');
          throw new Error('source read failed');
        })(),
      }),
      /source read failed/,
    );
    for (const operation of ['writeFile', 'sync'] as const) {
      const probe = await open(join(root, 'probe'), 'w');
      const prototype = Object.getPrototypeOf(probe);
      await probe.close();
      const mocked = t.mock.method(prototype, operation, async () => {
        throw new Error(`${operation} failed`);
      });
      try {
        await assert.rejects(
          store.putStream({ ...request, content: largeDiagnosticBytes() }),
          new RegExp(`${operation} failed`),
        );
      } finally {
        mocked.mock.restore();
      }
    }
    const blocked = createHash('sha256')
      .update('blocked publication')
      .digest('hex');
    await mkdir(join(root, 'evidence', `${blocked}.artifact`));
    await assert.rejects(
      store.putStream({
        ...request,
        content: (async function* () {
          yield Buffer.from('blocked publication');
        })(),
      }),
      /regular file/,
    );
    assert(
      (await readdir(join(root, 'evidence'))).every(
        (name) => !name.endsWith('.tmp'),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('failed children archive full thrown text and typed sources, then replay without handler execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-full-failure-'));
  try {
    const evidenceStore = await FileEvidenceStore.create(
      join(root, 'evidence'),
    );
    const childStore = await FileChildTaskStore.create(join(root, 'children'));
    let calls = 0;
    const text = 'available failure text '.repeat(800_000);
    const request = {
      runId: 'full-failure',
      revision: 'revision-1',
      plan: parallelPlan('feature', 1),
      capabilities: parallelCapabilities(),
      assignments: workerAssignments(1),
      childStore,
      receiptStore: await FileParallelWorkerReceiptStore.create(
        join(root, 'receipts'),
      ),
      evidenceStore,
      failureDiagnostics: { mode: 'required' as const },
      owner: 'worker-a',
      leaseMs: 30_000,
      handler: () => {
        calls++;
        throw new WorkerExecutionFailure(text, {
          complete: true,
          evidence: [
            {
              source: 'stream',
              kind: 'stdout',
              content: largeDiagnosticBytes(),
            },
          ],
        });
      },
    };
    const completed = await executeRestartableParallelWorkers(request);
    const diagnostics = completed.tasks[0]?.failureDiagnostics;
    assert.equal(diagnostics?.status, 'retained');
    assert.equal(diagnostics?.references.length, 2);
    assert(diagnostics!.references[0]!.bytes > 16_777_216);
    assert.equal(diagnostics!.references[1]!.sha256, largeDiagnosticHash());
    assert(completed.tasks[0]!.error!.length <= 4096);
    assert.deepEqual(
      await executeRestartableParallelWorkers(request),
      completed,
    );
    assert.equal(calls, 1);
    const source = diagnostics!.references[1]!;
    const path = join(root, 'evidence', `${source.sha256}.artifact`);
    await verifyEvidenceFile(path, join(root, 'evidence'), source);
    await rm(path);
    await assert.rejects(executeRestartableParallelWorkers(request), /ENOENT/);
    assert.equal(calls, 1);
    await evidenceStore.putStream({
      runId: request.runId,
      revision: request.revision,
      kind: 'stdout',
      content: largeDiagnosticBytes(),
    });
    const file = await open(path, 'r+');
    await file.write(Buffer.from('b'), 0, 1, 0);
    await file.close();
    await assert.rejects(
      executeRestartableParallelWorkers(request),
      /hash changed/,
    );
    assert.equal(calls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('complete diagnostics preflight preserves legacy custom stores and refuses required routes before claim', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-diagnostic-preflight-'));
  try {
    const files = await FileEvidenceStore.create(join(root, 'evidence'));
    const legacy: EvidenceStore = {
      put: files.put.bind(files),
      load: files.load.bind(files),
      loadPortable: files.loadPortable.bind(files),
    };
    const childStore = await FileChildTaskStore.create(join(root, 'children'));
    let calls = 0;
    const request = {
      runId: 'preflight',
      revision: 'revision-1',
      plan: parallelPlan('feature', 1),
      capabilities: parallelCapabilities(),
      assignments: workerAssignments(1),
      childStore,
      receiptStore: await FileParallelWorkerReceiptStore.create(
        join(root, 'receipts'),
      ),
      evidenceStore: legacy,
      owner: 'worker-a',
      leaseMs: 30_000,
      handler: () => {
        calls++;
        throw new Error('original failure');
      },
    };
    await assert.rejects(
      executeRestartableParallelWorkers({
        ...request,
        failureDiagnostics: { mode: 'required' },
      }),
      /before child claim/,
    );
    assert.equal(calls, 0);
    assert.deepEqual(await readdir(join(root, 'children')), []);
    const completed = await executeRestartableParallelWorkers(request);
    assert.match(
      completed.tasks[0]!.error!,
      /Worker execution failed; diagnostics archive failed; sha256=/,
    );
    assert.equal(
      completed.tasks[0]?.failureDiagnostics?.status,
      'archive-failed',
    );
    assert.deepEqual(
      await executeRestartableParallelWorkers(request),
      completed,
    );
    assert.equal(calls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('failure archival retains partial evidence and original failure when capture or a stream fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-partial-failure-'));
  try {
    const completed = await executeRestartableParallelWorkers({
      runId: 'partial-failure',
      revision: 'revision-1',
      plan: parallelPlan('feature', 1),
      capabilities: parallelCapabilities(),
      assignments: workerAssignments(1),
      childStore: await FileChildTaskStore.create(join(root, 'children')),
      receiptStore: await FileParallelWorkerReceiptStore.create(
        join(root, 'receipts'),
      ),
      evidenceStore: await FileEvidenceStore.create(join(root, 'evidence')),
      failureDiagnostics: { mode: 'required' },
      owner: 'worker-a',
      leaseMs: 30_000,
      handler: () => {
        throw new WorkerExecutionFailure('primary worker failure', {
          complete: false,
          reason: 'stderr capture failed',
          evidence: [
            {
              source: 'stream',
              kind: 'stdout',
              content: (async function* () {
                yield Buffer.from('available subset');
              })(),
            },
            {
              source: 'stream',
              kind: 'stderr',
              content: (async function* () {
                throw new Error('source read failed');
                yield Buffer.from('unreachable');
              })(),
            },
          ],
        });
      },
    });
    const diagnostics = completed.tasks[0]?.failureDiagnostics;
    assert.equal(completed.tasks[0]?.error, 'primary worker failure');
    assert.equal(diagnostics?.status, 'archive-failed');
    assert.equal(diagnostics?.references.length, 3);
    assert(
      diagnostics?.status === 'archive-failed' &&
        /stderr capture failed.*Diagnostic archive failed.*sha256=/.test(
          diagnostics.message,
        ),
    );
    assert(
      (await readdir(join(root, 'evidence'))).every(
        (name) => !name.endsWith('.tmp'),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('failure archival renews through a slow stream and refuses a lost lease fence', async (t) => {
  for (const loseLease of [false, true])
    await t.test(
      loseLease ? 'renewal loss' : 'renewed slow archive',
      async () => {
        const root = await mkdtemp(join(tmpdir(), 'temari-slow-failure-'));
        try {
          const childStore = await FileChildTaskStore.create(
            join(root, 'children'),
          );
          const files = await FileEvidenceStore.create(join(root, 'evidence'));
          let archiveStarted = false;
          let renewals = 0;
          const originalRenew = childStore.renew.bind(childStore);
          childStore.renew = async (request) => {
            renewals++;
            if (loseLease && archiveStarted)
              throw new Error('lease renewal rejected');
            return originalRenew(request);
          };
          const completed = await executeRestartableParallelWorkers({
            runId: 'slow-failure',
            revision: 'revision-1',
            plan: parallelPlan('feature', 1),
            capabilities: parallelCapabilities(),
            assignments: workerAssignments(1),
            childStore,
            receiptStore: await FileParallelWorkerReceiptStore.create(
              join(root, 'receipts'),
            ),
            evidenceStore: files,
            failureDiagnostics: { mode: 'required' },
            owner: 'worker-a',
            leaseMs: 400,
            leaseRenewal: { intervalMs: 30 },
            evidenceForFailure: () => [
              {
                source: 'stream',
                kind: 'stdout',
                content: (async function* () {
                  archiveStarted = true;
                  await new Promise((resolve) => setTimeout(resolve, 600));
                  yield Buffer.from('slow diagnostics');
                })(),
              },
            ],
            handler: () => {
              throw new Error('slow worker failure');
            },
          });
          assert(renewals > 0);
          if (loseLease) {
            assert.equal(completed.state, 'RUNNING');
            assert.equal(completed.receipt, null);
            assert.equal(completed.tasks[0]?.status, 'RUNNING');
            assert(
              !(await childStore.events(completed.tasks[0]!.taskId)).some(
                (event) => event.type === 'task-completed',
              ),
            );
          } else {
            assert.equal(completed.state, 'COMPLETE');
            assert.equal(
              completed.tasks[0]?.failureDiagnostics?.status,
              'retained',
            );
          }
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      },
    );
});

test('retry replay verifies diagnostic artifacts from the prior failed attempt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-retry-diagnostics-'));
  try {
    const childStore = await FileChildTaskStore.create(join(root, 'children'));
    let calls = 0;
    const request = {
      runId: 'retry-diagnostics',
      revision: 'revision-1',
      plan: parallelPlan('feature', 1),
      capabilities: parallelCapabilities(),
      assignments: workerAssignments(1),
      childStore,
      receiptStore: await FileParallelWorkerReceiptStore.create(
        join(root, 'receipts'),
      ),
      evidenceStore: await FileEvidenceStore.create(join(root, 'evidence')),
      failureDiagnostics: { mode: 'required' as const },
      owner: 'worker-a',
      leaseMs: 30_000,
      retryPolicy: { maxAttempts: 2 },
      handler: () => {
        if (++calls === 1) throw new Error('first attempt failure');
        return result('recovered');
      },
    };
    const completed = await executeRestartableParallelWorkers(request);
    assert.equal(completed.tasks[0]?.status, 'SUCCEEDED');
    assert.equal(
      Object.hasOwn(completed.tasks[0]!, 'failureDiagnostics'),
      false,
    );
    const events = await childStore.events(completed.tasks[0]!.taskId);
    const terminal = events.find(
      (event) =>
        event.type === 'task-completed' && event.payload.to === 'FAILED',
    )!;
    const retry = events.find((event) => event.type === 'task-retried')!;
    assert.equal(
      terminal.payload.failureDiagnostics,
      retry.payload.failureDiagnostics,
    );
    const diagnostics = JSON.parse(
      terminal.payload.failureDiagnostics as string,
    );
    await rm(
      join(root, 'evidence', `${diagnostics.references[0].sha256}.artifact`),
    );
    await assert.rejects(executeRestartableParallelWorkers(request), /ENOENT/);
    assert.equal(calls, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a non-fencing renewal failure retains its full cause and terminalizes FAILED under the still-valid lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-renewal-cause-'));
  try {
    const childStore = await FileChildTaskStore.create(join(root, 'children'));
    const files = await FileEvidenceStore.create(join(root, 'evidence'));
    const cause = 'renewal storage error '.repeat(800_000);
    childStore.renew = async () => {
      throw cause;
    };
    const completed = await executeRestartableParallelWorkers({
      runId: 'renewal-cause',
      revision: 'revision-1',
      plan: parallelPlan('feature', 1),
      capabilities: parallelCapabilities(),
      assignments: workerAssignments(1),
      childStore,
      receiptStore: await FileParallelWorkerReceiptStore.create(
        join(root, 'receipts'),
      ),
      evidenceStore: files,
      failureDiagnostics: { mode: 'required' },
      owner: 'worker-a',
      leaseMs: 30_000,
      leaseRenewal: { intervalMs: 20 },
      handler: async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return result('handler succeeded');
      },
    });
    assert.equal(completed.state, 'COMPLETE');
    assert.equal(completed.tasks[0]?.status, 'FAILED');
    const diagnostics = completed.tasks[0]!.failureDiagnostics!;
    assert.equal(diagnostics.status, 'retained');
    assert.equal(diagnostics.references.length, 1);
    assert.equal(diagnostics.references[0]!.bytes, Buffer.byteLength(cause));
    assert.equal(
      diagnostics.references[0]!.sha256,
      createHash('sha256').update(cause).digest('hex'),
    );
    await files.verifyPortable(diagnostics.references[0]!);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cancellation during failure archival clears current diagnostics and retains the requested archive in history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-cancel-archive-'));
  try {
    const childStore = await FileChildTaskStore.create(join(root, 'children'));
    const request = {
      runId: 'cancel-archive',
      revision: 'revision-1',
      plan: parallelPlan('feature', 1),
      capabilities: parallelCapabilities(),
      assignments: workerAssignments(1),
      childStore,
      receiptStore: await FileParallelWorkerReceiptStore.create(
        join(root, 'receipts'),
      ),
      evidenceStore: await FileEvidenceStore.create(join(root, 'evidence')),
      failureDiagnostics: { mode: 'required' as const },
      owner: 'worker-a',
      leaseMs: 30_000,
      leaseRenewal: { intervalMs: 20 },
      handler: () => {
        throw new Error('original failure');
      },
    };
    const prepared = await prepareRestartableParallelWorkers(request);
    const completed = await executeRestartableParallelWorkers({
      ...request,
      evidenceForFailure: () => [
        {
          source: 'stream',
          kind: 'stdout',
          content: (async function* () {
            await childStore.cancel({
              taskId: prepared.tasks[0]!.taskId,
              actor: 'coordinator',
              idempotencyKey: 'cancel-in-archive',
            });
            await new Promise((resolve) => setTimeout(resolve, 60));
            yield Buffer.from('private diagnostic sentinel');
          })(),
        },
      ],
    });
    const task = completed.tasks[0]!;
    assert.equal(task.status, 'CANCELLED');
    assert.equal(Object.hasOwn(task, 'failureDiagnostics'), false);
    const terminal = (await childStore.events(task.taskId)).at(-1)!;
    const diagnostics = JSON.parse(
      terminal.payload.requestFailureDiagnostics as string,
    );
    assert.equal(diagnostics.references.length, 2);
    const historyText = JSON.stringify(await childStore.events(task.taskId));
    assert(!historyText.includes('private diagnostic sentinel'));
    await rm(
      join(root, 'evidence', `${diagnostics.references[1].sha256}.artifact`),
    );
    await assert.rejects(executeRestartableParallelWorkers(request), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a replacement owner can reclaim during slow failed archival and the old owner cannot complete its attempt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-archive-reclaim-'));
  try {
    const childStore = await FileChildTaskStore.create(join(root, 'children'));
    const files = await FileEvidenceStore.create(join(root, 'evidence'));
    let archiveStarted = false;
    let replacement: import('./child-task-store.js').ChildTaskRecord | null =
      null;
    const originalRenew = childStore.renew.bind(childStore);
    childStore.renew = async (request) => {
      if (archiveStarted) throw new Error('lease renewal storage failed');
      return originalRenew(request);
    };
    const request = {
      runId: 'archive-reclaim',
      revision: 'revision-1',
      plan: parallelPlan('feature', 1),
      capabilities: parallelCapabilities(),
      assignments: workerAssignments(1),
      childStore,
      receiptStore: await FileParallelWorkerReceiptStore.create(
        join(root, 'receipts'),
      ),
      evidenceStore: files,
      failureDiagnostics: { mode: 'required' as const },
      owner: 'worker-a',
      leaseMs: 400,
      leaseRenewal: { intervalMs: 25 },
      handler: () => {
        throw new Error('old attempt failed');
      },
    };
    const prepared = await prepareRestartableParallelWorkers(request);
    await executeRestartableParallelWorkers({
      ...request,
      evidenceForFailure: () => [
        {
          source: 'stream',
          kind: 'stdout',
          content: (async function* () {
            archiveStarted = true;
            await new Promise((resolve) => setTimeout(resolve, 600));
            const claimed = await childStore.claim({
              taskId: prepared.tasks[0]!.taskId,
              owner: 'replacement',
              leaseMs: 30_000,
            });
            assert(claimed.claimed);
            assert.equal(claimed.record.attempt, 2);
            replacement = await childStore.complete({
              taskId: claimed.record.taskId,
              owner: 'replacement',
              leaseToken: claimed.record.lease!.token,
              fencingEpoch: claimed.record.lease!.fencingEpoch,
              status: 'SUCCEEDED',
              result: result('replacement succeeded'),
              idempotencyKey: 'replacement-complete',
            });
            yield Buffer.from('old retained diagnostic bytes');
          })(),
        },
      ],
    });
    const retained = await childStore.load(prepared.tasks[0]!.taskId);
    assert.deepEqual(retained, replacement);
    const terminal = (
      await childStore.events(prepared.tasks[0]!.taskId)
    ).filter((event) => event.type === 'task-completed');
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0]!.actor, 'replacement');
    assert.equal(terminal[0]!.payload.attempt, 2);
    assert.equal(Object.hasOwn(retained!, 'failureDiagnostics'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('required diagnostics keep ordinary thrown sentinel text exclusively in the exact private artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-private-failure-'));
  try {
    const text =
      'PRIVATE_FAILURE_SENTINEL:' +
      'a'.repeat(16_383) +
      '😀' +
      'b'.repeat(16_777_217);
    const childStore = await FileChildTaskStore.create(join(root, 'children'));
    const completed = await executeRestartableParallelWorkers({
      runId: 'private-failure',
      revision: 'revision-1',
      plan: parallelPlan('feature', 1),
      capabilities: parallelCapabilities(),
      assignments: workerAssignments(1),
      childStore,
      receiptStore: await FileParallelWorkerReceiptStore.create(
        join(root, 'receipts'),
      ),
      evidenceStore: await FileEvidenceStore.create(join(root, 'evidence')),
      failureDiagnostics: { mode: 'required' },
      owner: 'worker-a',
      leaseMs: 30_000,
      handler: () => {
        throw text;
      },
    });
    const reference = completed.tasks[0]!.failureDiagnostics!.references[0]!;
    assert.equal(reference.bytes, Buffer.byteLength(text));
    assert.equal(
      reference.sha256,
      createHash('sha256').update(text).digest('hex'),
    );
    assert(completed.tasks[0]!.error!.includes(reference.sha256));
    assert(!JSON.stringify(completed).includes('PRIVATE_FAILURE_SENTINEL'));
    assert(
      !JSON.stringify(
        await childStore.events(completed.tasks[0]!.taskId),
      ).includes('PRIVATE_FAILURE_SENTINEL'),
    );
    const file = await open(
      join(root, 'evidence', `${reference.sha256}.artifact`),
      'r',
    );
    try {
      const prefix = Buffer.alloc(64);
      await file.read(prefix, 0, prefix.length, 0);
      assert(prefix.toString('utf8').startsWith('PRIVATE_FAILURE_SENTINEL:'));
    } finally {
      await file.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('full thrown-text normalization preserves messages with hostile and custom stack properties', async (t) => {
  for (const hostile of [false, true])
    await t.test(
      hostile ? 'throwing stack getter' : 'custom stack omits message',
      async () => {
        const root = await mkdtemp(join(tmpdir(), 'temari-stack-failure-'));
        try {
          const error = new Error('available primary diagnostic');
          if (hostile)
            Object.defineProperty(error, 'stack', {
              get() {
                throw new Error('unreadable stack');
              },
            });
          else error.stack = 'custom stack';
          const expected = hostile
            ? error.message
            : `${error.message}\ncustom stack`;
          const completed = await executeRestartableParallelWorkers({
            runId: 'stack-failure',
            revision: 'revision-1',
            plan: parallelPlan('feature', 1),
            capabilities: parallelCapabilities(),
            assignments: workerAssignments(1),
            childStore: await FileChildTaskStore.create(join(root, 'children')),
            receiptStore: await FileParallelWorkerReceiptStore.create(
              join(root, 'receipts'),
            ),
            evidenceStore: await FileEvidenceStore.create(
              join(root, 'evidence'),
            ),
            failureDiagnostics: { mode: 'required' },
            owner: 'worker-a',
            leaseMs: 30_000,
            handler: () => {
              throw error;
            },
          });
          const reference =
            completed.tasks[0]!.failureDiagnostics!.references[0]!;
          assert.equal(
            reference.sha256,
            createHash('sha256').update(expected).digest('hex'),
          );
          assert.equal(reference.bytes, Buffer.byteLength(expected));
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      },
    );
});

test('source-discovery failure retains its entire secondary cause separately from the primary failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-secondary-source-'));
  try {
    const primary = 'primary worker failure';
    const secondary = 'PRIVATE_SOURCE_FAILURE:' + 'x'.repeat(16_777_217);
    const files = await FileEvidenceStore.create(join(root, 'evidence'));
    const completed = await executeRestartableParallelWorkers({
      runId: 'secondary-source',
      revision: 'revision-1',
      plan: parallelPlan('feature', 1),
      capabilities: parallelCapabilities(),
      assignments: workerAssignments(1),
      childStore: await FileChildTaskStore.create(join(root, 'children')),
      receiptStore: await FileParallelWorkerReceiptStore.create(
        join(root, 'receipts'),
      ),
      evidenceStore: files,
      failureDiagnostics: { mode: 'required' },
      evidenceForFailure: () => {
        throw secondary;
      },
      owner: 'worker-a',
      leaseMs: 30_000,
      handler: () => {
        throw primary;
      },
    });
    const diagnostics = completed.tasks[0]!.failureDiagnostics!;
    assert.equal(diagnostics.status, 'archive-failed');
    assert.equal(diagnostics.references.length, 2);
    assert.equal(
      diagnostics.references[0]!.sha256,
      createHash('sha256').update(primary).digest('hex'),
    );
    assert.equal(
      diagnostics.references[1]!.bytes,
      Buffer.byteLength(secondary),
    );
    assert.equal(
      diagnostics.references[1]!.sha256,
      createHash('sha256').update(secondary).digest('hex'),
    );
    await files.verifyPortable(diagnostics.references[1]!);
    assert(!JSON.stringify(completed).includes('PRIVATE_SOURCE_FAILURE'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
