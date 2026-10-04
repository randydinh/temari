import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  reconciliationStoreDigest,
} from '../libs/runtime/src/index.js';
import { observeGitReconciliation } from '../libs/host-adapters/src/lib/git-reconciliation-observer.js';
import {
  MergeReconciliationDashboard,
  createObservedGitReconciliationBindingReader,
  observedGitReconciliationScope,
  type CurrentReconciliationBindingReader,
} from './merge-reconciliation-dashboard.mjs';

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

function trustedSnapshot(seed: MergeObservation) {
  return {
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
}

function temporaryGit(root: string, args: readonly string[]): string {
  return execFileSync('git', [
    '-C', root, '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args,
  ], {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_AUTHOR_NAME: 'Reconciliation test',
      GIT_AUTHOR_EMAIL: 'reconciliation-test@example.invalid',
      GIT_COMMITTER_NAME: 'Reconciliation test',
      GIT_COMMITTER_EMAIL: 'reconciliation-test@example.invalid',
    },
  });
}

async function repositoryFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'temari-reconciliation-git-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  temporaryGit(root, ['init', '--quiet', '--initial-branch=main', '--object-format=sha1']);
  await writeFile(join(root, 'tracked.txt'), 'committed source\n');
  temporaryGit(root, ['add', '--', 'tracked.txt']);
  temporaryGit(root, ['commit', '--quiet', '-m', 'initial source']);
  return root;
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
  const gitObjectId = 'a'.repeat(40);
  const git = {
    schema: 1 as const,
    source: { repositoryRoot: '/trusted/source-root', commonGitDirectory: '/trusted/.git', headObjectId: gitObjectId, headReference: 'main' },
    operation: 'merge' as const, porcelainV2: 'u UU N... 100644 100644 100644 100644 a b c file.ts\0', porcelainSha256: DIGEST,
    unmerged: [{ path: 'file.ts', stages: [{ stage: 1 as const, mode: '100644', objectId: gitObjectId }] }],
    untrackedPaths: [], paths: [{ path: 'file.ts', pathSha256: SHA, indexBlobs: [], worktreeKind: 'file' as const, worktreeSha256: SHA, diffSha256: DIGEST }],
  };
  const snapshot = trustedSnapshot(seed);
  const selected = { ...seed, scope: observedGitReconciliationScope(git, snapshot) };
  assert.equal(selected.scope.baseHead.sha256, reconciliationStoreDigest({ headObjectId: gitObjectId }));
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

test('real SHA-1 Git HEAD is canonically digested and confirmation records intent only', async (t) => {
  const root = await repositoryFixture(t);
  await writeFile(join(root, 'tracked.txt'), 'retained local work\n');
  const before = {
    head: temporaryGit(root, ['rev-parse', 'HEAD']).trim(),
    status: temporaryGit(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all']),
    content: await readFile(join(root, 'tracked.txt'), 'utf8'),
  };
  assert.match(before.head, /^[0-9a-f]{40}$/);
  const git = await observeGitReconciliation(root);
  const seed = observation('real-head');
  const snapshot = trustedSnapshot(seed);
  const selected = { ...seed, scope: observedGitReconciliationScope(git, snapshot) };
  assert.equal(git.source.headObjectId, before.head);
  assert.equal(selected.scope.baseHead.sha256, reconciliationStoreDigest({ headObjectId: before.head }));
  assert.notEqual(selected.scope.baseHead.sha256, before.head);
  assert.deepEqual(selected.scope.affectedPaths.map((path) => path.path), ['tracked.txt']);
  assert.match(selected.scope.affectedPaths[0]!.indexBlobs[0]!.objectId, /^[0-9a-f]{40}$/);
  const reader = createObservedGitReconciliationBindingReader({
    repositoryRoot: root,
    snapshotReader: { async readCurrentSnapshot() { return snapshot; } },
  });
  const f = await fixture(t, reader);
  const selectedPlan = plan(selected, 'awaiting-confirmation', 'real-head-intent');
  const created = await f.dashboard.submitIntent({
    idempotencyKey: 'real-head-intent', observation: selected, plan: selectedPlan,
  });
  const stored = (await f.store.get(created.attemptId))!;
  assert.deepEqual(await reader.readCurrentBinding({ attemptId: created.attemptId, expected: stored.binding }), stored.binding);
  const confirmed = await f.dashboard.confirmIntent({
    attemptId: created.attemptId, confirmation: confirmation(selectedPlan),
  });
  assert.deepEqual({ state: confirmed.state, readiness: confirmed.candidate.readiness, terminal: confirmed.terminal }, {
    state: 'observed', readiness: 'not-ready', terminal: false,
  });
  assert.deepEqual((await f.store.get(created.attemptId))!.confirmation, confirmation(selectedPlan));
  assert.deepEqual({
    head: temporaryGit(root, ['rev-parse', 'HEAD']).trim(),
    status: temporaryGit(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all']),
    content: await readFile(join(root, 'tracked.txt'), 'utf8'),
  }, before);
});

test('a changed real Git HEAD blocks confirmation even when affected content and status are unchanged', async (t) => {
  const root = await repositoryFixture(t);
  await writeFile(join(root, 'tracked.txt'), 'retained local work\n');
  const initial = await observeGitReconciliation(root);
  const seed = observation('head-drift');
  const snapshot = trustedSnapshot(seed);
  const selected = { ...seed, scope: observedGitReconciliationScope(initial, snapshot) };
  const reader = createObservedGitReconciliationBindingReader({
    repositoryRoot: root,
    snapshotReader: { async readCurrentSnapshot() { return snapshot; } },
  });
  const f = await fixture(t, reader);
  const selectedPlan = plan(selected, 'awaiting-confirmation', 'head-drift-intent');
  const created = await f.dashboard.submitIntent({
    idempotencyKey: 'head-drift-intent', observation: selected, plan: selectedPlan,
  });
  temporaryGit(root, ['commit', '--quiet', '--allow-empty', '-m', 'new source head']);
  const changed = await observeGitReconciliation(root);
  assert.match(changed.source.headObjectId!, /^[0-9a-f]{40}$/);
  assert.notEqual(changed.source.headObjectId, initial.source.headObjectId);
  assert.equal(changed.porcelainV2, initial.porcelainV2);
  assert.deepEqual(changed.paths, initial.paths);
  const blocked = await f.dashboard.confirmIntent({
    attemptId: created.attemptId, confirmation: confirmation(selectedPlan),
  });
  assert.equal(blocked.state, 'blocked');
  const retained = (await f.store.get(created.attemptId))!;
  assert.equal(retained.confirmation, null);
  assert.deepEqual(retained.observation.scope, selected.scope);
  assert.equal(retained.observation.scope.baseHead.sha256, reconciliationStoreDigest({ headObjectId: initial.source.headObjectId }));
});

test('a clean real repository refuses scope preparation without inventing an affected path', async (t) => {
  const root = await repositoryFixture(t);
  const clean = await observeGitReconciliation(root);
  assert.match(clean.source.headObjectId!, /^[0-9a-f]{40}$/);
  assert.deepEqual(clean.paths, []);
  const seed = observation('clean');
  assert.throws(
    () => observedGitReconciliationScope(clean, trustedSnapshot(seed)),
    /^Error: No affected Git paths; no reconciliation attempt prepared\.$/,
  );
  const f = await fixture(t);
  // Even a caller bypassing preparation cannot admit an empty portable scope.
  const invalid = { ...seed, scope: { ...seed.scope, affectedPaths: [] } };
  await assert.rejects(f.dashboard.submitIntent({
    idempotencyKey: 'clean-intent', observation: invalid,
    plan: plan(invalid, 'awaiting-confirmation', 'clean-intent'),
  }), /affectedPaths must declare at least one affected path/);
  assert.deepEqual(await f.store.list(), []);
  assert.equal(temporaryGit(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all']), '');
});

test('a retained dirty attempt is invalidated when its real live source becomes clean', async (t) => {
  const root = await repositoryFixture(t);
  await writeFile(join(root, 'tracked.txt'), 'retained local work\n');
  const initial = await observeGitReconciliation(root);
  const seed = observation('clean-drift');
  const snapshot = trustedSnapshot(seed);
  const selected = { ...seed, scope: observedGitReconciliationScope(initial, snapshot) };
  const reader = createObservedGitReconciliationBindingReader({
    repositoryRoot: root,
    snapshotReader: { async readCurrentSnapshot() { return snapshot; } },
  });
  const f = await fixture(t, reader);
  const selectedPlan = plan(selected, 'awaiting-confirmation', 'clean-drift-intent');
  const created = await f.dashboard.submitIntent({
    idempotencyKey: 'clean-drift-intent', observation: selected, plan: selectedPlan,
  });
  await writeFile(join(root, 'tracked.txt'), 'committed source\n');
  const clean = await observeGitReconciliation(root);
  assert.deepEqual(clean.paths, []);
  assert.equal(clean.source.headObjectId, initial.source.headObjectId);
  assert.throws(() => observedGitReconciliationScope(clean, snapshot), /no reconciliation attempt prepared/);
  const blocked = await f.dashboard.invalidateIntent({ attemptId: created.attemptId });
  assert.equal(blocked.state, 'blocked');
  assert.equal(blocked.canConfirm, false);
  const retained = (await f.store.get(created.attemptId))!;
  assert.deepEqual(retained.observation.scope, selected.scope);
  assert.equal(retained.confirmation, null);
  assert.equal((await f.dashboard.confirmIntent({
    attemptId: created.attemptId, confirmation: confirmation(selectedPlan),
  })).state, 'blocked');
  assert.equal((await f.store.get(created.attemptId))!.confirmation, null);
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
