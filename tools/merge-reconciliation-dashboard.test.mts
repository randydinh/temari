import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type {
  MergeObservation,
  ReconciliationConfirmation,
  ReconciliationPlan,
  ReconciliationStatus,
} from '../libs/contracts/src/index.js';
import {
  FileMergeReconciliationStore,
  reconciliationAttemptBinding,
} from '../libs/runtime/src/index.js';
import {
  MergeReconciliationDashboard,
  createObservedGitReconciliationBindingReader,
  observedGitReconciliationScope,
  type CurrentReconciliationBindingReader,
} from './merge-reconciliation-dashboard.mts';

const SHA = 'a'.repeat(64);
const DIGEST = 'b'.repeat(64);
const now = '2026-10-01T12:00:00.000Z';

function evidence(id: string) {
  return [{ schema: 1 as const, id, sha256: SHA, bytes: 3, mediaType: 'application/json' }];
}
function scope(version: string) {
  return {
    schema: 1 as const,
    sourceRoot: { id: 'source-root', sha256: 'b'.repeat(64) },
    candidateRoot: { id: `candidate-root-${version}`, sha256: 'c'.repeat(64) },
    baseHead: { id: 'base-head', sha256: 'd'.repeat(64) },
    operationHead: { id: 'operation-head', sha256: 'e'.repeat(64) },
    affectedPaths: [{
      path: 'tools/merge-reconciliation-dashboard.mts', classification: 'unmerged' as const,
      pathSha256: '1'.repeat(64),
      indexBlobs: [{ stage: 1 as const, mode: '100644', objectId: '2'.repeat(64) }],
      unmergedStages: [{ stage: 1 as const, mode: '100644', objectId: '2'.repeat(64) }],
      worktreeKind: 'file' as const, worktreeSha256: '3'.repeat(64), diffSha256: '4'.repeat(64),
    }],
    resolutionIntent: 'preserve' as const,
    requiredChecks: [{ id: 'dashboard-test', definitionSha256: 'f'.repeat(64) }],
    expectedComparison: {
      candidateEvidence: evidence(`candidate-comparison-${version}`)[0]!,
      verificationEvidence: evidence(`verification-comparison-${version}`)[0]!,
    },
  };
}

function observation(version = 'v1'): MergeObservation {
  return {
    schema: 1,
    observationId: `observation-${version}`,
    taskId: 'task-1',
    taskVersion: version,
    runId: 'run-1',
    revision: 'revision-1',
    candidate: { schema: 'reconciliation-candidate-v1', id: 'candidate-1', sha256: SHA },
    scope: scope(version),
    observedAt: now,
    kind: 'mixed',
    evidence: evidence(`observation-evidence-${version}`),
  };
}

function plan(
  selected: MergeObservation,
  status: ReconciliationStatus = 'awaiting-confirmation',
  key = 'intent-1',
  digest = DIGEST,
): ReconciliationPlan {
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
    classification: status === 'awaiting-confirmation' ? 'requires-confirmation' : 'automatic',
    status,
    request: {
      idempotencyKey: key,
      canonicalRequestDigestAlgorithm: 'canonical-json-sha256-v1',
      canonicalRequestSha256: digest,
    },
    summary: 'Retain exact reconciliation evidence.',
    actions: [{ id: 'preserve-1', kind: 'preserve', targetId: selected.taskId }],
    evidence: evidence(`plan-evidence-${selected.observationId}`),
  };
}

function confirmation(selected: ReconciliationPlan): ReconciliationConfirmation {
  return {
    schema: 1,
    confirmationId: 'confirm-1',
    planId: selected.id,
    observationId: selected.observationId,
    canonicalRequestSha256: selected.request.canonicalRequestSha256,
    confirmedAt: now,
    confirmedBy: 'operator-1',
    evidence: evidence('confirmation-evidence'),
  };
}

function echoBindingReader(): CurrentReconciliationBindingReader {
  return {
    async readCurrentBinding({ expected }) {
      return expected;
    },
  };
}

async function fixture(t: TestContext, reader: CurrentReconciliationBindingReader | null = echoBindingReader()) {
  const root = await mkdtemp(join(tmpdir(), 'temari-reconciliation-dashboard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await FileMergeReconciliationStore.create(join(root, 'attempts'));
  return { store, dashboard: new MergeReconciliationDashboard(store, reader ?? undefined) };
}

test('projects externally creatable states and rejects executor-only plan states', async (t) => {
  const f = await fixture(t);
  for (const [index, state] of (['observed', 'awaiting-confirmation'] as const).entries()) {
    const selected = observation(`v${index}`);
    const selectedPlan = plan(selected, state, `intent-${index}`);
    const view = await f.dashboard.submitIntent({ idempotencyKey: `intent-${index}`, observation: selected, plan: selectedPlan });
    assert.equal(view.state, state);
    assert.equal(view.terminal, false);
  }
  for (const state of ['integrating', 'verifying'] as const) {
    const selected = observation(state);
    await assert.rejects(
      f.dashboard.submitIntent({
        idempotencyKey: `executor-${state}`,
        observation: selected,
        plan: plan(selected, state, `executor-${state}`),
      }),
      /initial.*status/i,
    );
  }
  const selected = observation('blocked');
  const blockedPlan: ReconciliationPlan = {
    ...plan(selected, 'blocked', 'blocked-intent'),
    classification: 'manual-review',
    blockedReason: 'manual-intervention-required',
  };
  const blocked = await f.dashboard.submitIntent({ idempotencyKey: 'blocked-intent', observation: selected, plan: blockedPlan });
  assert.equal(blocked.state, 'blocked');
  assert.equal(blocked.blockedReason, 'manual-intervention-required');
});

test('confirmation remains observed and non-ready without separate executor evidence', async (t) => {
  const f = await fixture(t);
  const selected = observation();
  const selectedPlan = plan(selected);
  const awaiting = await f.dashboard.submitIntent({ idempotencyKey: 'intent-1', observation: selected, plan: selectedPlan });
  assert.deepEqual({ state: awaiting.state, readiness: awaiting.candidate.readiness, terminal: awaiting.terminal }, {
    state: 'awaiting-confirmation', readiness: 'not-ready', terminal: false,
  });
  const confirmed = await f.dashboard.confirmIntent({ attemptId: awaiting.attemptId, confirmation: confirmation(selectedPlan) });
  assert.deepEqual({ state: confirmed.state, readiness: confirmed.candidate.readiness, terminal: confirmed.terminal }, {
    state: 'observed', readiness: 'not-ready', terminal: false,
  });
});

test('stale bindings remain visibly blocked with their retained invalidation reason', async (t) => {
  const f = await fixture(t);
  const selected = observation();
  const selectedPlan = plan(selected);
  const view = await f.dashboard.submitIntent({ idempotencyKey: 'intent-1', observation: selected, plan: selectedPlan });
  const stale = observation('v2');
  const staleReader: CurrentReconciliationBindingReader = {
    async readCurrentBinding() { return reconciliationAttemptBinding(stale); },
  };
  const blocked = await new MergeReconciliationDashboard(f.store, staleReader).invalidateIntent({ attemptId: view.attemptId });
  assert.equal(blocked.state, 'blocked');
  assert.match(blocked.blockedReason ?? '', /task, run, revision, candidate, or observation binding changed/i);
  assert.equal((await f.dashboard.view(view.attemptId))?.blockedReason, blocked.blockedReason);
});

test('confirmation fails closed without a trusted current-binding reader', async (t) => {
  const f = await fixture(t, null);
  const selected = observation();
  const selectedPlan = plan(selected);
  const awaiting = await f.dashboard.submitIntent({ idempotencyKey: 'intent-1', observation: selected, plan: selectedPlan });
  assert.equal(awaiting.canConfirm, false);
  await assert.rejects(
    f.dashboard.confirmIntent({ attemptId: awaiting.attemptId, confirmation: confirmation(selectedPlan) }),
    /binding reader is not configured/i,
  );
});

test('reader-returned drift blocks confirmation without accepting request-supplied bindings', async (t) => {
  const selected = observation();
  const driftReader: CurrentReconciliationBindingReader = {
    async readCurrentBinding({ expected }) {
      return { ...expected, revision: 'trusted-reader-observed-drift' };
    },
  };
  const f = await fixture(t, driftReader);
  const selectedPlan = plan(selected);
  const awaiting = await f.dashboard.submitIntent({ idempotencyKey: 'intent-1', observation: selected, plan: selectedPlan });
  const blocked = await f.dashboard.confirmIntent({ attemptId: awaiting.attemptId, confirmation: confirmation(selectedPlan) });
  assert.equal(blocked.state, 'blocked');
  assert.equal((await f.store.get(awaiting.attemptId))?.confirmation, null);
});

test('portable observed Git scope matches a stored attempt and reader drift blocks it', async (t) => {
  const seed = observation();
  const git = {
    schema: 1 as const,
    source: { repositoryRoot: '/trusted/source-root', commonGitDirectory: '/trusted/.git', headObjectId: SHA, headReference: 'main' },
    operation: 'merge' as const, porcelainV2: 'u UU N... 100644 100644 100644 100644 a b c file.ts\0', porcelainSha256: DIGEST,
    unmerged: [{ path: 'file.ts', stages: [{ stage: 1 as const, mode: '100644', objectId: SHA }] }],
    untrackedPaths: [], paths: [{ path: 'file.ts', pathSha256: SHA, indexBlobs: [], worktreeKind: 'file' as const, worktreeSha256: SHA, diffSha256: DIGEST }],
  };
  const snapshot = {
    taskId: seed.taskId,
    taskVersion: seed.taskVersion,
    runId: seed.runId,
    revision: seed.revision,
    observationId: seed.observationId,
    candidateId: seed.candidate.id,
    candidateSha256: seed.candidate.sha256,
    candidateRoot: seed.scope.candidateRoot,
    resolutionIntent: seed.scope.resolutionIntent,
    requiredChecks: seed.scope.requiredChecks,
    expectedComparison: seed.scope.expectedComparison,
  };
  const selected = { ...seed, scope: observedGitReconciliationScope(git, snapshot) };
  assert.match(selected.scope.sourceRoot.id, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
  assert.equal(selected.scope.sourceRoot.id.includes('/'), false);
  const reader = createObservedGitReconciliationBindingReader({
    repositoryRoot: '/trusted/source-root',
    snapshotReader: { async readCurrentSnapshot() { return snapshot; } },
    observe: async () => git,
  });
  const f = await fixture(t, reader);
  const selectedPlan = plan(selected);
  const created = await f.dashboard.submitIntent({ idempotencyKey: 'intent-1', observation: selected, plan: selectedPlan });
  assert.equal(
    (await reader.readCurrentBinding({ attemptId: created.attemptId, expected: (await f.store.get(created.attemptId))!.binding })).scopeSha256,
    (await f.store.get(created.attemptId))!.binding.scopeSha256,
  );
  assert.equal(
    (await f.dashboard.confirmIntent({ attemptId: created.attemptId, confirmation: confirmation(selectedPlan) })).state,
    'observed',
  );
  const sameStatusContentDrift = {
    ...git,
    paths: [{
      ...git.paths[0]!,
      worktreeSha256: '9'.repeat(64),
      diffSha256: '8'.repeat(64),
    }],
  };
  assert.equal(sameStatusContentDrift.source.headObjectId, git.source.headObjectId);
  assert.equal(sameStatusContentDrift.porcelainV2, git.porcelainV2);
  assert.deepEqual(
    sameStatusContentDrift.paths.map((entry) => entry.path),
    git.paths.map((entry) => entry.path),
  );
  const driftReader = createObservedGitReconciliationBindingReader({
    repositoryRoot: '/trusted/source-root',
    snapshotReader: { async readCurrentSnapshot() { return snapshot; } },
    observe: async () => sameStatusContentDrift,
  });
  assert.equal(
    (await new MergeReconciliationDashboard(f.store, driftReader).confirmIntent({ attemptId: created.attemptId, confirmation: confirmation(selectedPlan) })).state,
    'blocked',
  );
});

test('delegated idempotency replay is stable and changed request identity conflicts', async (t) => {
  const f = await fixture(t);
  const selected = observation();
  const original = plan(selected);
  const request = { idempotencyKey: 'intent-1', observation: selected, plan: original };
  const first = await f.dashboard.submitIntent(request);
  assert.deepEqual(await f.dashboard.submitIntent(request), first);
  await assert.rejects(
    f.dashboard.submitIntent({
      idempotencyKey: 'intent-1',
      observation: selected,
      plan: plan(selected, 'awaiting-confirmation', 'intent-1', 'c'.repeat(64)),
    }),
    /changed request digest/,
  );
});
