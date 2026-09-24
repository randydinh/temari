import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { FileChildTaskStore } from './child-task-store.js';

test('creates child tasks idempotently and binds their parent graph', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-child-task-store-'));
  try {
    const store = await FileChildTaskStore.create(root);
    const request = {
      taskId: 'child-create-1',
      runId: 'run-create-1',
      revision: 'revision-create-1',
      dependsOn: ['dependency-b', 'dependency-a'],
      actor: 'coordinator',
      now: at('2026-09-23T12:00:00.000Z'),
    } as const;
    const first = await store.create(request);
    await rm(join(root, '.child-create-1.transaction.json'), { force: true });
    const replay = await store.create({
      ...request,
      dependsOn: ['dependency-a', 'dependency-b'],
      actor: 'resumed-coordinator',
      now: at('2026-09-23T13:00:00.000Z'),
    });

    assert.deepEqual(replay, first);
    assert.deepEqual(first.dependsOn, ['dependency-a', 'dependency-b']);
    await assert.rejects(
      store.create({ ...request, runId: 'another-run' }),
      /bound to another run/,
    );
    await assert.rejects(
      store.create({ ...request, dependsOn: ['dependency-a'] }),
      /bound to another dependency set/,
    );
    assert.deepEqual(await store.load('child-create-1'), first);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('persists immutable child task group membership idempotently', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-child-task-store-'));
  try {
    const store = await FileChildTaskStore.create(root);
    const request = {
      groupId: 'group-membership-1',
      runId: 'run-group-1',
      revision: 'revision-group-1',
      taskIds: ['task-b', 'task-a'],
      assignmentIds: ['assignment-b', 'assignment-a'],
      now: at('2026-09-23T12:00:00.000Z'),
    } as const;
    const first = await store.ensureGroup(request);
    const replay = await store.ensureGroup({
      ...request,
      now: at('2026-09-23T13:00:00.000Z'),
    });

    assert.deepEqual(replay, first);
    assert.deepEqual((await store.loadGroup(request.groupId))?.taskIds, [
      'task-b',
      'task-a',
    ]);
    assert(Object.isFrozen(first));
    assert(Object.isFrozen(first.taskIds));
    assert(Object.isFrozen(first.assignmentIds));

    await assert.rejects(
      store.ensureGroup({ ...request, taskIds: ['task-a', 'task-b'] }),
      /task membership is immutable/,
    );
    await assert.rejects(
      store.ensureGroup({
        ...request,
        assignmentIds: ['assignment-a', 'assignment-b'],
      }),
      /assignment membership is immutable/,
    );
    await assert.rejects(
      store.ensureGroup({
        ...request,
        taskIds: ['task-a'],
        assignmentIds: ['assignment-a', 'assignment-b'],
      }),
      /equal length/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('persists FAILED child outcomes without synthetic worker evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-child-task-store-'));
  try {
    const store = await FileChildTaskStore.create(root);
    await store.create({
      taskId: 'child-failed-1',
      runId: 'run-failed-1',
      revision: 'revision-failed-1',
      dependsOn: [],
      actor: 'coordinator',
    });
    const claimed = await store.claim({
      taskId: 'child-failed-1',
      owner: 'worker-a',
      leaseMs: 30_000,
    });
    assert(claimed.record.lease);

    const base = {
      taskId: 'child-failed-1',
      owner: 'worker-a',
      leaseToken: claimed.record.lease.token,
      fencingEpoch: claimed.record.lease.fencingEpoch,
      status: 'FAILED' as const,
      idempotencyKey: 'complete:child-failed-1:1',
    };
    await assert.rejects(
      store.complete({
        ...base,
        result: result('PASS', 'synthetic evidence'),
        error: 'handler threw',
      }),
      /cannot publish a worker result/,
    );
    await assert.rejects(
      store.complete({ ...base, error: '   ' }),
      /Task error must be non-empty/,
    );

    const failed = await store.complete({
      ...base,
      result: null,
      error: 'handler threw before producing a worker result',
    });
    assert.equal(failed.status, 'FAILED');
    assert.equal(failed.result, null);
    assert.equal(
      failed.error,
      'handler threw before producing a worker result',
    );
    assert.deepEqual(await store.load('child-failed-1'), failed);

    await writeFile(
      join(root, 'child-failed-1.task.json'),
      JSON.stringify({ ...failed, error: null }),
    );
    await assert.rejects(store.load('child-failed-1'), /non-empty error/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('requeues mechanical failures with an append-only retry event', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-child-task-store-'));
  try {
    const store = await FileChildTaskStore.create(root);
    await store.create({
      taskId: 'child-retry-1',
      runId: 'run-retry-1',
      revision: 'revision-retry-1',
      dependsOn: [],
      actor: 'coordinator',
      now: at('2026-09-24T12:00:00.000Z'),
    });
    const claimed = await store.claim({
      taskId: 'child-retry-1',
      owner: 'worker-a',
      leaseMs: 30_000,
      now: at('2026-09-24T12:00:01.000Z'),
    });
    assert(claimed.record.lease);
    const failed = await store.complete({
      taskId: 'child-retry-1',
      owner: 'worker-a',
      leaseToken: claimed.record.lease.token,
      fencingEpoch: claimed.record.lease.fencingEpoch,
      status: 'FAILED',
      idempotencyKey: 'complete:child-retry-1:1',
      error: 'first attempt failed',
      now: at('2026-09-24T12:00:02.000Z'),
    });

    const queued = await store.retry({
      taskId: 'child-retry-1',
      actor: 'coordinator',
      idempotencyKey: 'retry:child-retry-1:1',
      now: at('2026-09-24T12:00:03.000Z'),
    });
    assert.equal(failed.status, 'FAILED');
    assert.equal(queued.status, 'QUEUED');
    assert.equal(queued.attempt, 1);
    assert.equal(queued.result, null);
    assert.equal(queued.error, null);
    assert.deepEqual(
      await store.retry({
        taskId: 'child-retry-1',
        actor: 'coordinator',
        idempotencyKey: 'retry:child-retry-1:1',
        now: at('2026-09-24T12:00:04.000Z'),
      }),
      queued,
    );

    const secondClaim = await store.claim({
      taskId: 'child-retry-1',
      owner: 'worker-b',
      leaseMs: 30_000,
      now: at('2026-09-24T12:00:05.000Z'),
    });
    assert(secondClaim.record.lease);
    const succeeded = await store.complete({
      taskId: 'child-retry-1',
      owner: 'worker-b',
      leaseToken: secondClaim.record.lease.token,
      fencingEpoch: secondClaim.record.lease.fencingEpoch,
      status: 'SUCCEEDED',
      idempotencyKey: 'complete:child-retry-1:2',
      result: result('PASS', 'second attempt passed'),
      now: at('2026-09-24T12:00:06.000Z'),
    });
    assert.equal(succeeded.status, 'SUCCEEDED');
    assert.deepEqual(
      (await store.events('child-retry-1')).map((event) => event.type),
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

test('preserves semantic BLOCKED as a normal worker result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-child-task-store-'));
  try {
    const store = await FileChildTaskStore.create(root);
    await store.create({
      taskId: 'child-blocked-1',
      runId: 'run-blocked-1',
      revision: 'revision-blocked-1',
      dependsOn: [],
      actor: 'coordinator',
    });
    const claimed = await store.claim({
      taskId: 'child-blocked-1',
      owner: 'worker-a',
      leaseMs: 30_000,
    });
    assert(claimed.record.lease);
    const blocked = await store.complete({
      taskId: 'child-blocked-1',
      owner: 'worker-a',
      leaseToken: claimed.record.lease.token,
      fencingEpoch: claimed.record.lease.fencingEpoch,
      status: 'BLOCKED',
      idempotencyKey: 'complete:child-blocked-1:1',
      result: result('BLOCKED', 'worker reports a capability gap'),
    });

    assert.equal(blocked.status, 'BLOCKED');
    assert.equal(blocked.result?.status, 'BLOCKED');
    assert.equal(blocked.error, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('gates claims on successful dependencies and records a durable join trail', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-child-task-store-'));
  try {
    const store = await FileChildTaskStore.create(root);
    await store.create({
      taskId: 'child-dependency-a',
      runId: 'run-dependency-1',
      revision: 'revision-dependency-1',
      dependsOn: [],
      actor: 'coordinator',
    });
    await store.create({
      taskId: 'child-dependency-b',
      runId: 'run-dependency-1',
      revision: 'revision-dependency-1',
      dependsOn: ['child-dependency-a'],
      actor: 'coordinator',
    });

    const blocked = await store.claim({
      taskId: 'child-dependency-b',
      owner: 'worker-b',
      leaseMs: 30_000,
    });
    assert.equal(blocked.claimed, false);
    assert.equal(blocked.record.status, 'QUEUED');

    const dependency = await store.claim({
      taskId: 'child-dependency-a',
      owner: 'worker-a',
      leaseMs: 30_000,
    });
    assert(dependency.record.lease);
    await store.complete({
      taskId: 'child-dependency-a',
      owner: 'worker-a',
      leaseToken: dependency.record.lease.token,
      fencingEpoch: dependency.record.lease.fencingEpoch,
      status: 'SUCCEEDED',
      idempotencyKey: 'complete:child-dependency-a:1',
      result: result('PASS', 'dependency complete'),
    });

    const ready = await store.claim({
      taskId: 'child-dependency-b',
      owner: 'worker-b',
      leaseMs: 30_000,
    });
    assert.equal(ready.claimed, true);
    assert.deepEqual(
      (await store.events('child-dependency-a')).map((event) => event.type),
      ['task-created', 'task-claimed', 'task-completed'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('serializes concurrent claims so only one owner receives a child lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-child-task-store-'));
  try {
    const store = await FileChildTaskStore.create(root);
    await store.create({
      taskId: 'child-concurrent-1',
      runId: 'run-concurrent-1',
      revision: 'revision-concurrent-1',
      dependsOn: [],
      actor: 'coordinator',
    });
    const results = await Promise.all(
      ['worker-a', 'worker-b'].map((owner) =>
        store.claim({
          taskId: 'child-concurrent-1',
          owner,
          leaseMs: 30_000,
        }),
      ),
    );

    assert.equal(results.filter((claim) => claim.claimed).length, 1);
    assert.equal((await store.events('child-concurrent-1')).length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('serializes cyclic dependency claims without lock inversion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-child-task-store-'));
  try {
    const store = await FileChildTaskStore.create(root);
    await store.create({
      taskId: 'child-cycle-a',
      runId: 'run-cycle-1',
      revision: 'revision-cycle-1',
      dependsOn: ['child-cycle-b'],
      actor: 'coordinator',
    });
    await store.create({
      taskId: 'child-cycle-b',
      runId: 'run-cycle-1',
      revision: 'revision-cycle-1',
      dependsOn: ['child-cycle-a'],
      actor: 'coordinator',
    });

    const results = await Promise.all([
      store.claim({
        taskId: 'child-cycle-a',
        owner: 'worker-a',
        leaseMs: 30_000,
      }),
      store.claim({
        taskId: 'child-cycle-b',
        owner: 'worker-b',
        leaseMs: 30_000,
      }),
    ]);
    assert.deepEqual(
      results.map((result) => result.record.status),
      ['QUEUED', 'QUEUED'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('increments fencing epochs after expiry and rejects stale completion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-child-task-store-'));
  try {
    const store = await FileChildTaskStore.create(root);
    await store.create({
      taskId: 'child-fence-1',
      runId: 'run-fence-1',
      revision: 'revision-fence-1',
      dependsOn: [],
      actor: 'coordinator',
      now: at('2026-09-23T12:00:00.000Z'),
    });
    const first = await store.claim({
      taskId: 'child-fence-1',
      owner: 'worker-a',
      leaseMs: 1_000,
      now: at('2026-09-23T12:00:01.000Z'),
    });
    assert(first.record.lease);
    const resumed = await store.claim({
      taskId: 'child-fence-1',
      owner: 'worker-b',
      leaseMs: 1_000,
      now: at('2026-09-23T12:00:03.000Z'),
    });
    assert(resumed.record.lease);
    assert.equal(resumed.record.attempt, 2);
    assert.equal(resumed.record.lease.fencingEpoch, 2);

    await assert.rejects(
      store.complete({
        taskId: 'child-fence-1',
        owner: 'worker-a',
        leaseToken: first.record.lease.token,
        fencingEpoch: first.record.lease.fencingEpoch,
        status: 'SUCCEEDED',
        idempotencyKey: 'complete:child-fence-1:stale',
        result: result('PASS', 'stale completion'),
        now: at('2026-09-23T12:00:03.500Z'),
      }),
      /lease owner mismatch|lease token mismatch|fencing epoch mismatch/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('replays an idempotent completion but rejects a changed payload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-child-task-store-'));
  try {
    const store = await FileChildTaskStore.create(root);
    await store.create({
      taskId: 'child-idempotent-1',
      runId: 'run-idempotent-1',
      revision: 'revision-idempotent-1',
      dependsOn: [],
      actor: 'coordinator',
    });
    const claimed = await store.claim({
      taskId: 'child-idempotent-1',
      owner: 'worker-a',
      leaseMs: 30_000,
    });
    assert(claimed.record.lease);
    const completion = {
      taskId: 'child-idempotent-1',
      owner: 'worker-a',
      leaseToken: claimed.record.lease.token,
      fencingEpoch: claimed.record.lease.fencingEpoch,
      status: 'ISSUES',
      idempotencyKey: 'complete:child-idempotent-1:1',
      result: result('ISSUES', 'one issue'),
    } as const;
    const first = await store.complete(completion);
    const replay = await store.complete({
      ...completion,
      now: at('2026-09-23T13:00:00.000Z'),
    });

    assert.deepEqual(replay, first);
    await assert.rejects(
      store.complete({
        ...completion,
        result: result('ISSUES', 'different issue'),
      }),
      /Idempotency key result changed|Completed task result changed/,
    );
    assert.equal((await store.events('child-idempotent-1')).length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reconstructs a stable ready frontier for a run revision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-child-task-store-'));
  try {
    const store = await FileChildTaskStore.create(root);
    for (const taskId of ['child-ready-z', 'child-ready-a']) {
      await store.create({
        taskId,
        runId: 'run-ready-1',
        revision: 'revision-ready-1',
        dependsOn: [],
        actor: 'coordinator',
      });
    }
    await store.create({
      taskId: 'child-ready-dependent',
      runId: 'run-ready-1',
      revision: 'revision-ready-1',
      dependsOn: ['child-ready-a'],
      actor: 'coordinator',
    });

    assert.deepEqual(
      (
        await store.listReady({
          runId: 'run-ready-1',
          revision: 'revision-ready-1',
        })
      ).map((task) => task.taskId),
      ['child-ready-a', 'child-ready-z'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('repairs every transaction interruption boundary idempotently', async () => {
  const stages = [
    'after-sidecar-fsync',
    'after-state-publication',
    'after-event-publication',
    'after-sidecar-removal',
  ] as const;

  for (const stage of stages) {
    const root = await mkdtemp(join(tmpdir(), 'temari-child-task-store-'));
    try {
      const store = await FileChildTaskStore.create(root);
      await store.create({
        taskId: `child-recovery-${stage.slice(6, 8)}`,
        runId: 'run-recovery-1',
        revision: 'revision-recovery-1',
        dependsOn: [],
        actor: 'coordinator',
      });
      const claimed = await store.claim({
        taskId: `child-recovery-${stage.slice(6, 8)}`,
        owner: 'worker-a',
        leaseMs: 30_000,
      });
      assert(claimed.record.lease);
      const completion = {
        taskId: claimed.record.taskId,
        owner: 'worker-a',
        leaseToken: claimed.record.lease.token,
        fencingEpoch: claimed.record.lease.fencingEpoch,
        status: 'SUCCEEDED' as const,
        idempotencyKey: `complete:${claimed.record.taskId}:1`,
        result: result('PASS', `recovered at ${stage}`),
      };

      setFailureInjection(stage);
      await assert.rejects(store.complete(completion), /Injected child task/);
      const repaired = await store.reconcile(completion.taskId);
      assert.equal(repaired?.status, 'SUCCEEDED');
      assert.equal((await store.events(completion.taskId)).length, 3);
      assert.equal(
        (await readdir(root)).filter((name) => name.includes('transaction'))
          .length,
        0,
      );

      const replay = await store.complete(completion);
      assert.deepEqual(replay, repaired);
      assert.equal((await store.events(completion.taskId)).length, 3);
    } finally {
      setFailureInjection(null);
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('fails closed on partial JSONL, event-ahead state, and missing state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-child-task-store-'));
  try {
    const store = await FileChildTaskStore.create(root);
    const taskId = 'child-corrupt-1';
    await store.create({
      taskId,
      runId: 'run-corrupt-1',
      revision: 'revision-corrupt-1',
      dependsOn: [],
      actor: 'coordinator',
    });
    const eventPath = join(root, `${taskId}.events.jsonl`);
    const originalEvents = await readFile(eventPath, 'utf8');

    await writeFile(eventPath, `${originalEvents}\n`);
    await assert.rejects(store.load(taskId), /blank or partial JSONL/);

    const created = JSON.parse(originalEvents) as Record<string, unknown>;
    await writeFile(
      eventPath,
      `${originalEvents}${JSON.stringify({
        ...created,
        sequence: 2,
        type: 'task-claimed',
        idempotencyKey: 'claim:corrupt',
        actor: 'worker-a',
        payload: { attempt: 1, fencingEpoch: 1, expiresAt: created.at },
      })}\n`,
    );
    await assert.rejects(store.load(taskId), /event log is ahead of state/);

    await rm(join(root, `${taskId}.task.json`));
    await assert.rejects(store.load(taskId), /missing its state/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function result(
  status: 'PASS' | 'ISSUES' | 'BLOCKED' | 'DROPPED',
  summary: string,
) {
  return {
    status,
    summary,
    evidencePaths: ['worker.log'],
    rawLogPath: null,
  } as const;
}

function at(value: string): Date {
  return new Date(value);
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
