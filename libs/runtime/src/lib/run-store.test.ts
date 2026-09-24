import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { FileWorkflowRunStore } from './run-store.js';

test('claims a queued run once and records an append-only event trail', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-run-store-'));
  try {
    const store = await FileWorkflowRunStore.create(root);
    await store.create({
      runId: 'run-lease-1',
      revision: 'revision-1',
      actor: 'coordinator',
      now: at('2026-09-22T12:00:00.000Z'),
    });
    const first = await store.claim({
      runId: 'run-lease-1',
      owner: 'worker-a',
      leaseMs: 30_000,
      now: at('2026-09-22T12:00:01.000Z'),
    });
    const second = await store.claim({
      runId: 'run-lease-1',
      owner: 'worker-b',
      leaseMs: 30_000,
      now: at('2026-09-22T12:00:02.000Z'),
    });

    assert.equal(first.claimed, true);
    assert.equal(second.claimed, false);
    assert(first.record.lease);
    const completion = {
      runId: 'run-lease-1',
      owner: 'worker-a',
      leaseToken: first.record.lease.token,
      status: 'SUCCEEDED',
      idempotencyKey: 'complete:run-lease-1:1',
      payload: { receipt: 'run-lease-1.receipt.json' },
      now: at('2026-09-22T12:00:03.000Z'),
    } as const;
    const done = await store.transition(completion);
    const replay = await store.transition({
      ...completion,
      now: at('2026-09-22T13:00:03.000Z'),
    });

    assert.equal(done.status, 'SUCCEEDED');
    assert.equal(done.lease, null);
    assert.deepEqual(replay, done);
    assert.deepEqual(
      (await store.events('run-lease-1')).map((event) => event.type),
      ['run-created', 'run-claimed', 'run-status-changed'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('expires a lease before another worker can resume the same revision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-run-store-'));
  try {
    const store = await FileWorkflowRunStore.create(root);
    await store.create({
      runId: 'run-lease-2',
      revision: 'revision-2',
      actor: 'coordinator',
      now: at('2026-09-22T12:00:00.000Z'),
    });
    const first = await store.claim({
      runId: 'run-lease-2',
      owner: 'worker-a',
      leaseMs: 1_000,
      now: at('2026-09-22T12:00:01.000Z'),
    });
    const resumed = await store.claim({
      runId: 'run-lease-2',
      owner: 'worker-b',
      leaseMs: 1_000,
      now: at('2026-09-22T12:00:03.000Z'),
    });

    assert(first.record.lease);
    assert.equal(resumed.claimed, true);
    assert.equal(resumed.record.attempt, 2);
    assert.equal(resumed.record.lease?.owner, 'worker-b');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('renews an active lease with an append-only witness and idempotent replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-run-store-'));
  try {
    const store = await FileWorkflowRunStore.create(root);
    await store.create({
      runId: 'run-renew-1',
      revision: 'revision-renew-1',
      actor: 'coordinator',
      now: at('2026-09-24T12:00:00.000Z'),
    });
    const claimed = await store.claim({
      runId: 'run-renew-1',
      owner: 'worker-a',
      leaseMs: 1_000,
      now: at('2026-09-24T12:00:01.000Z'),
    });
    assert(claimed.record.lease);
    const renewal = {
      runId: 'run-renew-1',
      owner: 'worker-a',
      leaseToken: claimed.record.lease.token,
      leaseMs: 30_000,
      idempotencyKey: 'renew:run-renew-1:1:1',
      now: at('2026-09-24T12:00:01.500Z'),
    } as const;
    const renewed = await store.renew(renewal);
    const replay = await store.renew({
      ...renewal,
      now: at('2026-09-24T12:00:01.900Z'),
    });

    assert.equal(renewed.lease?.expiresAt, '2026-09-24T12:00:31.500Z');
    assert.deepEqual(replay, renewed);
    assert.deepEqual(
      (await store.events('run-renew-1')).map((event) => event.type),
      ['run-created', 'run-claimed', 'run-lease-renewed'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('serializes concurrent claims so one owner receives the lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-run-store-'));
  try {
    const store = await FileWorkflowRunStore.create(root);
    await store.create({
      runId: 'run-concurrent-1',
      revision: 'revision-concurrent-1',
      actor: 'coordinator',
      now: at('2026-09-22T12:00:00.000Z'),
    });
    const results = await Promise.all(
      ['worker-a', 'worker-b'].map((owner) =>
        store.claim({
          runId: 'run-concurrent-1',
          owner,
          leaseMs: 30_000,
          now: at('2026-09-22T12:00:01.000Z'),
        }),
      ),
    );

    assert.equal(results.filter((result) => result.claimed).length, 1);
    assert.equal((await store.events('run-concurrent-1')).length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('replaying an idempotency key returns the original event', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-run-store-'));
  try {
    const store = await FileWorkflowRunStore.create(root);
    await store.create({
      runId: 'run-event-1',
      revision: 'revision-3',
      actor: 'coordinator',
      now: at('2026-09-22T12:00:00.000Z'),
    });
    const first = await store.appendEvent({
      runId: 'run-event-1',
      actor: 'coordinator',
      idempotencyKey: 'dispatch:1',
      payload: { stage: 'build' },
      now: at('2026-09-22T12:00:01.000Z'),
    });
    const replay = await store.appendEvent({
      runId: 'run-event-1',
      actor: 'coordinator',
      idempotencyKey: 'dispatch:1',
      payload: { stage: 'build' },
      now: at('2026-09-22T12:01:01.000Z'),
    });

    assert.deepEqual(replay, first);
    assert.equal((await store.events('run-event-1')).length, 2);
    assert.equal(
      (await readFile(join(root, 'run-event-1.events.jsonl'), 'utf8'))
        .split('\n')
        .filter(Boolean).length,
      2,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('repairs every parent transaction interruption boundary idempotently', async () => {
  const stages = [
    'after-sidecar-fsync',
    'after-state-publication',
    'after-event-publication',
    'after-sidecar-removal',
  ] as const;

  for (const stage of stages) {
    const root = await mkdtemp(join(tmpdir(), 'temari-run-store-'));
    try {
      const store = await FileWorkflowRunStore.create(root);
      await store.create({
        runId: `run-recovery-${stage.slice(6, 8)}`,
        revision: 'revision-recovery-1',
        actor: 'coordinator',
        now: at('2026-09-24T06:00:00.000Z'),
      });
      const claimed = await store.claim({
        runId: `run-recovery-${stage.slice(6, 8)}`,
        owner: 'worker-a',
        leaseMs: 30_000,
        now: at('2026-09-24T06:00:01.000Z'),
      });
      assert(claimed.record.lease);
      const transition = {
        runId: claimed.record.runId,
        owner: 'worker-a',
        leaseToken: claimed.record.lease.token,
        status: 'SUCCEEDED' as const,
        idempotencyKey: `complete:${claimed.record.runId}:1`,
        payload: { receipt: 'run.receipt.json' },
        now: at('2026-09-24T06:00:02.000Z'),
      };

      setFailureInjection(stage);
      await assert.rejects(
        store.transition(transition),
        /Injected run store interruption/,
      );
      const repaired = await store.reconcile(transition.runId);
      assert.equal(repaired?.status, 'SUCCEEDED');
      assert.equal((await store.events(transition.runId)).length, 3);

      const replay = await store.transition(transition);
      assert.deepEqual(replay, repaired);
    } finally {
      setFailureInjection(null);
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('repairs an event-only append after an interrupted publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-run-store-'));
  try {
    const store = await FileWorkflowRunStore.create(root);
    await store.create({
      runId: 'run-event-recovery-1',
      revision: 'revision-event-recovery-1',
      actor: 'coordinator',
    });
    setFailureInjection('after-event-publication');
    await assert.rejects(
      store.appendEvent({
        runId: 'run-event-recovery-1',
        actor: 'coordinator',
        idempotencyKey: 'dispatch:recovery-1',
        payload: { stage: 'build' },
      }),
      /Injected run store interruption/,
    );

    const repaired = await store.reconcile('run-event-recovery-1');
    assert.equal(repaired?.status, 'QUEUED');
    assert.equal((await store.events('run-event-recovery-1')).length, 2);
  } finally {
    setFailureInjection(null);
    await rm(root, { recursive: true, force: true });
  }
});

test('fails closed on partial JSONL, event-ahead state, and missing state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-run-store-'));
  try {
    const store = await FileWorkflowRunStore.create(root);
    const runId = 'run-corrupt-1';
    await store.create({
      runId,
      revision: 'revision-corrupt-1',
      actor: 'coordinator',
    });
    const eventPath = join(root, `${runId}.events.jsonl`);
    const originalEvents = await readFile(eventPath, 'utf8');

    await writeFile(eventPath, `${originalEvents}\n`);
    await assert.rejects(store.load(runId), /blank or partial JSONL/);

    const created = JSON.parse(originalEvents) as Record<string, unknown>;
    await writeFile(
      eventPath,
      `${originalEvents}${JSON.stringify({
        ...created,
        sequence: 2,
        type: 'run-claimed',
        idempotencyKey: 'claim:corrupt',
        actor: 'worker-a',
        payload: {
          attempt: 1,
          expiresAt: '2026-09-24T06:01:00.000Z',
        },
      })}\n`,
    );
    await assert.rejects(store.load(runId), /Run attempt changed/);

    await rm(join(root, `${runId}.run.json`));
    await assert.rejects(store.load(runId), /missing its state/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function at(value: string): Date {
  return new Date(value);
}

type FailureInjectionStage =
  | 'after-sidecar-fsync'
  | 'after-state-publication'
  | 'after-event-publication'
  | 'after-sidecar-removal';

function setFailureInjection(stage: FailureInjectionStage | null): void {
  const constructor = FileWorkflowRunStore as unknown as {
    failureInjection: FailureInjectionStage | null;
  };
  constructor.failureInjection = stage;
}
