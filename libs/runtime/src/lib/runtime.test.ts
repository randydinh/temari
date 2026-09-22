import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { minimalPlan } from '@temari/contracts';

import {
  FileWorkflowReceiptStore,
  executeAndPersist,
  executeScheduledAndPersist,
} from './runtime.js';
import { FileWorkflowRunStore } from './run-store.js';
import { FileEvidenceStore } from './evidence-store.js';

test('persists and reloads a revision-bound receipt idempotently', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-runtime-'));
  try {
    const store = await FileWorkflowReceiptStore.create(root);
    const canonicalRoot = await realpath(root);
    const receipt = await executeAndPersist({
      runId: 'run-1',
      revision: 'revision-1',
      plan: minimalPlan('feature'),
      capabilities: serialCapabilities(),
      store,
      now: sequenceClock(),
      handler: (stage) => ({ status: 'PASS', summary: `${stage} complete` }),
    });

    const path = await store.save(receipt);
    assert.equal(path, join(canonicalRoot, 'run-1.receipt.json'));
    assert.deepEqual(await store.load('run-1'), receipt);
    assert.equal((await readFile(path, 'utf8')).includes(receipt.revision), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('persists blocked capability gaps instead of losing the reason', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-runtime-'));
  try {
    const store = await FileWorkflowReceiptStore.create(root);
    const receipt = await executeAndPersist({
      runId: 'run-2',
      revision: 'revision-2',
      plan: { ...minimalPlan('feature'), requiredCapabilities: ['forge'] },
      capabilities: serialCapabilities(),
      store,
      now: sequenceClock(),
      handler: () => ({ status: 'PASS', summary: 'must not run' }),
    });

    assert.equal(receipt.status, 'BLOCKED');
    assert.deepEqual((await store.load('run-2'))?.failure?.missingCapabilities, [
      'forge',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a different receipt for an existing run ID', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-runtime-'));
  try {
    const store = await FileWorkflowReceiptStore.create(root);
    const receipt = await executeAndPersist({
      runId: 'run-3',
      revision: 'revision-3',
      plan: minimalPlan('bug'),
      capabilities: serialCapabilities(),
      store,
      now: sequenceClock(),
      handler: () => ({ status: 'PASS', summary: 'complete' }),
    });

    await assert.rejects(
      store.save({ ...receipt, revision: 'different-revision' }),
      /collision or mutation/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('executes a revision through the run lease and closes with a receipt status', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-runtime-'));
  try {
    const receiptStore = await FileWorkflowReceiptStore.create(join(root, 'receipts'));
    const runStore = await FileWorkflowRunStore.create(join(root, 'runs'));
    const result = await executeScheduledAndPersist({
      runId: 'scheduled-1',
      revision: 'revision-scheduled-1',
      plan: minimalPlan('feature'),
      capabilities: serialCapabilities(),
      store: receiptStore,
      runStore,
      owner: 'worker-a',
      leaseMs: 30_000,
      now: sequenceClock(),
      handler: () => ({ status: 'PASS', summary: 'complete' }),
    });

    assert.equal(result.claimed, true);
    assert.equal(result.receipt?.status, 'PASS');
    assert.equal(result.record.status, 'SUCCEEDED');
    assert.equal((await runStore.events('scheduled-1')).length, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('does not start a duplicate while a lease is active', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-runtime-'));
  try {
    const receiptStore = await FileWorkflowReceiptStore.create(join(root, 'receipts'));
    const runStore = await FileWorkflowRunStore.create(join(root, 'runs'));
    await runStore.create({
      runId: 'scheduled-2',
      revision: 'revision-scheduled-2',
      actor: 'worker-a',
      now: new Date('2026-09-22T12:00:00.000Z'),
    });
    await runStore.claim({
      runId: 'scheduled-2',
      owner: 'worker-a',
      leaseMs: 30_000,
      now: new Date('2026-09-22T12:00:01.000Z'),
    });
    const result = await executeScheduledAndPersist({
      runId: 'scheduled-2',
      revision: 'revision-scheduled-2',
      plan: minimalPlan('bug'),
      capabilities: serialCapabilities(),
      store: receiptStore,
      runStore,
      owner: 'worker-a',
      leaseMs: 30_000,
      now: sequenceClock(),
      handler: () => ({ status: 'PASS', summary: 'must not execute' }),
    });

    assert.equal(result.claimed, false);
    assert.equal(result.receipt, null);
    assert.equal(await receiptStore.load('scheduled-2'), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('stores immutable content-addressed evidence and verifies it on reload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-runtime-'));
  try {
    const store = await FileEvidenceStore.create(root);
    const reference = await store.put({
      runId: 'evidence-1',
      revision: 'revision-evidence-1',
      kind: 'stdout',
      content: 'verification output\n',
    });
    const replay = await store.put({
      runId: 'evidence-1',
      revision: 'revision-evidence-1',
      kind: 'stdout',
      content: 'verification output\n',
    });

    assert.equal(reference.sha256, replay.sha256);
    assert.deepEqual(await store.load(reference), Buffer.from('verification output\n'));
    await assert.rejects(
      store.load({ ...reference, sha256: '0'.repeat(64) }),
      /Evidence hash changed|Evidence path is outside|ENOENT/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function serialCapabilities() {
  return {
    host: 'generic',
    available: [],
    missing: [
      'subagents',
      'parallelism',
      'model_diversity',
      'worktree_isolation',
      'durable_delivery',
      'forge',
    ] as const,
    notes: {},
  };
}

function sequenceClock(): () => Date {
  let count = 0;
  const start = new Date('2026-09-22T12:00:00.000Z').getTime();
  return () => new Date(start + count++ * 1000);
}
