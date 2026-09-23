import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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

function at(value: string): Date {
  return new Date(value);
}
