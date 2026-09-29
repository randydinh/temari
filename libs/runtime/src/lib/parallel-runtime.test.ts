import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parallelPlan, type WorkerAssignment } from '@temari/contracts';

import {
  executeRestartableParallelWorkers,
  FileParallelWorkerReceiptStore,
} from './parallel-runtime.js';
import { FileChildTaskStore } from './child-task-store.js';
import { FileEvidenceStore } from './evidence-store.js';
import { FileWorkspaceManifestStore } from './workspace-manifest.js';

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

    const second = await executeRestartableParallelWorkers(request);
    assert.equal(second.state, 'COMPLETE');
    assert.equal(second.receipt?.status, 'PASS');
    assert.equal(second.receipt?.peakConcurrency, 1);
    assert.deepEqual(second.receipt?.executionEvidence, {
      schema: 1,
      groupId: second.group?.groupId,
      assignmentIds: assignments.map((assignment) => assignment.id),
      maxConcurrency: 2,
      peakConcurrency: 1,
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
          assert.equal(resumed.receipt?.peakConcurrency, 1);
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
        await assert.rejects(run, {
          message:
            fault === 'missing-signal'
              ? 'takeover readiness deadline exceeded'
              : `takeover probe: ${fault}`,
        });
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
