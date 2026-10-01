import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type {
  MergeObservation,
  ReconciliationConfirmation,
  ReconciliationPlan,
} from '@temari/contracts';
import {
  FileMergeReconciliationStore,
  reconciliationAttemptBinding,
} from './merge-reconciliation-store.js';

const SHA = 'a'.repeat(64);
const DIGEST = 'b'.repeat(64);
const now = new Date('2026-10-01T12:00:00.000Z');

function evidence(id: string) {
  return [{ schema: 1 as const, id, sha256: SHA, bytes: 12, mediaType: 'application/json' }];
}
function scope(version: string) {
  return {
    schema: 1 as const,
    sourceRoot: { id: 'source-root', sha256: 'b'.repeat(64) },
    candidateRoot: { id: `candidate-root-${version}`, sha256: 'c'.repeat(64) },
    baseHead: { id: 'base-head', sha256: 'd'.repeat(64) },
    operationHead: { id: 'operation-head', sha256: 'e'.repeat(64) },
    affectedPaths: [{
      path: 'libs/runtime/merge-reconciliation-store.ts', classification: 'unmerged' as const,
      pathSha256: '1'.repeat(64),
      indexBlobs: [{ stage: 1 as const, mode: '100644', objectId: '2'.repeat(64) }],
      unmergedStages: [{ stage: 1 as const, mode: '100644', objectId: '2'.repeat(64) }],
      worktreeKind: 'file' as const, worktreeSha256: '3'.repeat(64), diffSha256: '4'.repeat(64),
    }],
    resolutionIntent: 'preserve' as const,
    requiredChecks: [{ id: 'runtime-test', definitionSha256: 'f'.repeat(64) }],
    expectedComparison: {
      candidateEvidence: evidence(`candidate-comparison-${version}`)[0]!,
      verificationEvidence: evidence(`verification-comparison-${version}`)[0]!,
    },
  };
}

function observation(taskVersion = 'v1'): MergeObservation {
  return {
    schema: 1,
    observationId: `observation-${taskVersion}`,
    taskId: 'task-reconcile',
    taskVersion,
    runId: 'run-reconcile',
    revision: 'revision-1',
    candidate: { schema: 'reconciliation-candidate-v1', id: 'candidate-1', sha256: SHA },
    scope: scope(taskVersion),
    observedAt: now.toISOString(),
    kind: 'unmerged',
    evidence: evidence(`observation-evidence-${taskVersion}`),
  };
}

function plan(
  selected: MergeObservation,
  options: {
    readonly key?: string;
    readonly digest?: string;
    readonly classification?: ReconciliationPlan['classification'];
    readonly status?: ReconciliationPlan['status'];
  } = {},
): ReconciliationPlan {
  const classification = options.classification ?? 'requires-confirmation';
  return {
    schema: 1,
    id: `plan-${selected.observationId}`,
    taskId: selected.taskId,
    taskVersion: selected.taskVersion,
    runId: selected.runId,
    revision: selected.revision,
    observationId: selected.observationId,
    candidate: selected.candidate,
    scope: selected.scope,
    classification,
    status: options.status ?? (classification === 'requires-confirmation' ? 'awaiting-confirmation' : 'observed'),
    request: {
      idempotencyKey: options.key ?? 'request-1',
      canonicalRequestDigestAlgorithm: 'canonical-json-sha256-v1',
      canonicalRequestSha256: options.digest ?? DIGEST,
    },
    summary: 'Preserve the observed merge state for review.',
    actions: [{ id: 'preserve-1', kind: 'preserve', targetId: selected.taskId }],
    evidence: evidence(`plan-evidence-${selected.observationId}`),
  };
}

function confirmation(selected: ReconciliationPlan): ReconciliationConfirmation {
  return {
    schema: 1,
    confirmationId: 'confirmation-1',
    planId: selected.id,
    observationId: selected.observationId,
    canonicalRequestSha256: selected.request.canonicalRequestSha256,
    confirmedAt: now.toISOString(),
    confirmedBy: 'operator-1',
    evidence: evidence('confirmation-evidence'),
  };
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'temari-merge-reconciliation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'attempts');
  return { root, directory, store: await FileMergeReconciliationStore.create(directory) };
}

test('creates once, replays exact idempotency, and survives reopening', async (t) => {
  const f = await fixture(t);
  const selected = observation();
  const selectedPlan = plan(selected);
  const request = { idempotencyKey: selectedPlan.request.idempotencyKey, observation: selected, plan: selectedPlan };
  const created = await f.store.createAttempt(request, now);
  const bytes = await readFile(join(f.directory, 'attempts.json'));
  const replayed = await f.store.createAttempt(request, new Date(Date.parse(now.toISOString()) + 1_000));
  assert.deepEqual(replayed, created);
  assert.deepEqual(await readFile(join(f.directory, 'attempts.json')), bytes);
  const reopened = await FileMergeReconciliationStore.openExisting(f.directory);
  assert.deepEqual(await reopened.get(created.id), created);
  assert.equal((await reopened.list()).length, 1);
});

test('rejects reusing an idempotency key for a changed canonical request digest', async (t) => {
  const f = await fixture(t);
  const selected = observation();
  const original = plan(selected);
  await f.store.createAttempt({ idempotencyKey: 'request-1', observation: selected, plan: original });
  await assert.rejects(
    f.store.createAttempt({
      idempotencyKey: 'request-1',
      observation: selected,
      plan: plan(selected, { digest: 'c'.repeat(64) }),
    }),
    /changed request digest/,
  );
});

test('refuses creation when the immutable reconciliation scope is not exact', async (t) => {
  const f = await fixture(t);
  const selected = observation();
  const selectedPlan = plan(selected);
  await assert.rejects(
    f.store.createAttempt({
      idempotencyKey: 'request-1',
      observation: selected,
      plan: {
        ...selectedPlan,
        scope: {
          ...selected.scope,
          operationHead: { ...selected.scope.operationHead, sha256: '9'.repeat(64) },
        },
      },
    }),
    /scope/,
  );
});

test('refuses client-claimed integrating and verifying initial plans', async (t) => {
  const f = await fixture(t);
  for (const status of ['integrating', 'verifying'] as const) {
    const selected = observation(status);
    await assert.rejects(
      f.store.createAttempt({
        idempotencyKey: `request-${status}`,
        observation: selected,
        plan: plan(selected, { key: `request-${status}`, classification: 'automatic', status }),
      }),
      /initial.*status/i,
    );
  }
});

test('invalidates stale task/run/candidate bindings as retained blocked attempts', async (t) => {
  const f = await fixture(t);
  const selected = observation();
  const created = await f.store.createAttempt({ idempotencyKey: 'request-1', observation: selected, plan: plan(selected) });
  const unchanged = await f.store.invalidateStaleBinding(created.id, reconciliationAttemptBinding(selected));
  assert.deepEqual(unchanged, created);
  const fresh = observation('v2');
  const blocked = await f.store.invalidateStaleBinding(created.id, reconciliationAttemptBinding(fresh));
  assert.equal(blocked.status, 'BLOCKED');
  assert.match(blocked.blockedReason ?? '', /binding changed/);
  assert.deepEqual(blocked.observation, selected);
  assert.deepEqual(blocked.plan, plan(selected));
  const reopened = await FileMergeReconciliationStore.openExisting(f.directory);
  assert.deepEqual(await reopened.get(created.id), blocked);
});

test('requires a fresh exact confirmation binding and never treats confirmation as task completion', async (t) => {
  const f = await fixture(t);
  const selected = observation();
  const selectedPlan = plan(selected);
  const created = await f.store.createAttempt({ idempotencyKey: 'request-1', observation: selected, plan: selectedPlan });
  await assert.rejects(
    f.store.confirm(created.id, { ...confirmation(selectedPlan), canonicalRequestSha256: 'c'.repeat(64) }, reconciliationAttemptBinding(selected)),
    /canonical request digest/,
  );
  const confirmed = await f.store.confirm(created.id, confirmation(selectedPlan), reconciliationAttemptBinding(selected), now);
  assert.equal(confirmed.status, 'CONFIRMED');
  assert.equal(confirmed.confirmation?.planId, selectedPlan.id);
  assert.equal('taskAccepted' in confirmed, false);
  assert.deepEqual(await f.store.confirm(created.id, confirmation(selectedPlan), reconciliationAttemptBinding(selected)), confirmed);

  const automaticObservation = observation('v2');
  const automaticPlan = plan(automaticObservation, {
    key: 'automatic-request',
    classification: 'automatic',
    status: 'observed',
  });
  const automatic = await f.store.createAttempt({ idempotencyKey: 'automatic-request', observation: automaticObservation, plan: automaticPlan });
  await assert.rejects(
    f.store.confirm(automatic.id, confirmation(automaticPlan), reconciliationAttemptBinding(automaticObservation)),
    /Only a confirmation-gated plan/,
  );
});

test('stale confirmation blocks even a previously confirmed record while retaining immutable evidence', async (t) => {
  const f = await fixture(t);
  const selected = observation();
  const selectedPlan = plan(selected);
  const created = await f.store.createAttempt({ idempotencyKey: 'request-1', observation: selected, plan: selectedPlan });
  const confirmed = await f.store.confirm(created.id, confirmation(selectedPlan), reconciliationAttemptBinding(selected));
  const stale = observation('v2');
  const blocked = await f.store.confirm(confirmed.id, confirmation(selectedPlan), reconciliationAttemptBinding(stale));
  assert.equal(blocked.status, 'BLOCKED');
  assert(blocked.confirmation);
  assert.match(blocked.blockedReason ?? '', /binding differs/);
});
