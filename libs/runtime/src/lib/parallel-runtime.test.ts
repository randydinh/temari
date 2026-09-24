import assert from 'node:assert/strict';
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
import { FileWorkspaceManifestStore } from './workspace-manifest.js';

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
    assert.deepEqual(
      second.receipt?.outcomes.map((outcome) => outcome.assignment.id),
      ['worker-1', 'worker-2', 'worker-3'],
    );
    assert.deepEqual(calls, ['worker-1', 'worker-2', 'worker-3']);

    const replay = await executeRestartableParallelWorkers(request);
    assert.equal(replay.state, 'COMPLETE');
    assert.deepEqual(replay.receipt, second.receipt);
    assert.deepEqual(calls, ['worker-1', 'worker-2', 'worker-3']);

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
