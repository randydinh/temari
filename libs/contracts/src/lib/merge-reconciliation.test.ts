import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertMergeObservation,
  assertReconciliationBinding,
  assertReconciliationPlan,
  validateReconciliationIdempotencyReuse,
  validateInitialReconciliationPlan,
  validateReconciliationPlan,
} from './merge-reconciliation.js';

const digest = (character: string) => character.repeat(64);

const evidence = {
  schema: 1 as const,
  id: 'evidence-1',
  sha256: digest('a'),
  bytes: 42,
  mediaType: 'application/json',
};

const candidate = {
  schema: 'reconciliation-candidate-v1' as const,
  id: 'candidate-1',
  sha256: digest('b'),
};
const scope = {
  schema: 1 as const,
  sourceRoot: { id: 'source-root', sha256: digest('d') },
  candidateRoot: { id: 'candidate-root', sha256: digest('e') },
  baseHead: { id: 'base-head', sha256: digest('f') },
  operationHead: { id: 'operation-head', sha256: digest('0') },
  affectedPaths: [{
    path: 'libs/runtime/file.ts', classification: 'unmerged' as const,
    pathSha256: digest('4'),
    indexBlobs: [{ stage: 1 as const, mode: '100644', objectId: digest('5') }],
    unmergedStages: [{ stage: 1 as const, mode: '100644', objectId: digest('5') }],
    worktreeKind: 'file' as const, worktreeSha256: digest('6'), diffSha256: digest('7'),
  }],
  resolutionIntent: 'preserve' as const,
  requiredChecks: [{ id: 'typecheck', definitionSha256: digest('1') }],
  expectedComparison: { candidateEvidence: evidence, verificationEvidence: { ...evidence, id: 'verification-evidence' } },
};

const observation = {
  schema: 1 as const,
  observationId: 'observation-1',
  taskId: 'task-1',
  taskVersion: 'v1',
  runId: 'run-1',
  revision: 'revision-1',
  candidate,
  scope,
  observedAt: '2026-10-01T12:00:00.000Z',
  kind: 'mixed' as const,
  evidence: [evidence],
};

const plan = {
  schema: 1 as const,
  id: 'plan-1',
  taskId: observation.taskId,
  taskVersion: observation.taskVersion,
  runId: observation.runId,
  revision: observation.revision,
  observationId: observation.observationId,
  candidate,
  scope,
  classification: 'requires-confirmation' as const,
  status: 'awaiting-confirmation' as const,
  request: {
    idempotencyKey: 'reconcile:task-1:1',
    canonicalRequestDigestAlgorithm: 'canonical-json-sha256-v1' as const,
    canonicalRequestSha256: digest('c'),
  },
  summary: 'Preserve the current candidate before integration.',
  actions: [{ id: 'preserve-1', kind: 'preserve' as const, targetId: 'candidate-1' }],
  evidence: [evidence],
};

test('accepts evidence-backed observations and a confirmation-bound plan', () => {
  const confirmation = {
    schema: 1 as const,
    confirmationId: 'confirmation-1',
    planId: plan.id,
    observationId: observation.observationId,
    canonicalRequestSha256: plan.request.canonicalRequestSha256,
    confirmedAt: '2026-10-01T12:01:00.000Z',
    confirmedBy: 'coordinator-1',
    evidence: [evidence],
  };

  assert.doesNotThrow(() => assertMergeObservation(observation));
  assert.doesNotThrow(() => assertReconciliationPlan(plan));
  assert.doesNotThrow(() =>
    assertReconciliationBinding(plan, observation, confirmation),
  );
});

test('requires an explicit invalidated reason for blocked plans', () => {
  const blocked = {
    ...plan,
    status: 'blocked' as const,
    classification: 'manual-review' as const,
    blockedReason: 'invalidated' as const,
  };

  assert.deepEqual(validateReconciliationPlan(blocked), []);
  assert(
    validateReconciliationPlan({ ...blocked, blockedReason: undefined }).some(
      (issue) => issue.includes('blockedReason'),
    ),
  );
});

test('rejects confirmation for a different observation or canonical request', () => {
  const confirmation = {
    schema: 1 as const,
    confirmationId: 'confirmation-1',
    planId: plan.id,
    observationId: 'observation-2',
    canonicalRequestSha256: digest('d'),
    confirmedAt: '2026-10-01T12:01:00.000Z',
    confirmedBy: 'coordinator-1',
    evidence: [evidence],
  };

  assert.throws(
    () => assertReconciliationBinding(plan, observation, confirmation),
    /confirmation\.observationId.*canonical request digest/,
  );
});

test('rejects reuse of an idempotency key for a different canonical request', () => {
  const changedDigest = {
    ...plan.request,
    canonicalRequestSha256: digest('d'),
  };

  assert.deepEqual(
    validateReconciliationIdempotencyReuse(plan.request, plan.request),
    [],
  );
  assert(
    validateReconciliationIdempotencyReuse(plan.request, changedDigest).some(
      (issue) => issue.includes('idempotencyKey must not be reused'),
    ),
  );
});

test('rejects close/archive actions and scope drift', () => {
  for (const kind of ['archive', 'close'])
    assert(
      validateReconciliationPlan({
        ...plan,
        actions: [{ ...plan.actions[0]!, kind }],
      }).some((issue) => issue.includes('kind is not supported')),
    );
  assert(
    validateReconciliationPlan({ ...plan, status: 'ready-for-review' }).some(
      (issue) => issue.includes('status is not supported'),
    ),
  );
  assert.throws(
    () => assertReconciliationBinding({ ...plan, scope: { ...scope, operationHead: { ...scope.operationHead, sha256: digest('2') } } }, observation),
    /scope/,
  );
});

test('rejects executor-only integration and verification states from initial plans', () => {
  for (const status of ['integrating', 'verifying'] as const) {
    assert(
      validateInitialReconciliationPlan({ ...plan, status }).some((issue) =>
        issue.includes('initial plan status'),
      ),
    );
    assert.deepEqual(validateReconciliationPlan({ ...plan, status }), []);
  }
});

test('requires canonically ordered full observed path identities', () => {
  const path = scope.affectedPaths[0]!;
  assert(
    validateReconciliationPlan({
      ...plan,
      scope: { ...scope, affectedPaths: [{ ...path, diffSha256: 'not-a-digest' }] },
    }).some((issue) => issue.includes('diffSha256')),
  );
  assert(
    validateReconciliationPlan({
      ...plan,
      scope: {
        ...scope,
        affectedPaths: [{
          ...path,
          indexBlobs: [
            { stage: 2 as const, mode: '100644', objectId: digest('8') },
            { stage: 1 as const, mode: '100644', objectId: digest('9') },
          ],
        }],
      },
    }).some((issue) => issue.includes('sorted by stage')),
  );
});
