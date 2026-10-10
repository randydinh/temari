import assert from 'node:assert/strict';
import type { HarnessRunRef } from '@temari/contracts';
import {
  verifyExecutionHarnessRunIdentity,
  getExecutionHarnessStatus,
} from './harness-runtime.js';
import type { HarnessSelection } from './harness-selector.js';
import { TaskRuntime } from './task-runtime.js';
import { FileTaskStore } from './task-store.js';

export interface ReviewedLocalCandidateCompletion {
  readonly schema: 1;
  readonly profile: 'reviewed-local-candidate-v1';
  readonly status: 'PASS';
  readonly taskId: string;
  readonly binding: {
    readonly runId: string;
    readonly nativeRunId: string;
    readonly baseCommit: string;
    readonly planSha256: string;
    readonly requestSha256: string;
    readonly policySha256: string;
  };
  readonly candidate: { readonly root: string; readonly commit: string };
  readonly receiptSha256: string;
  readonly scope: 'reviewed-local-candidate-only';
  readonly publication: 'denied';
}

/** A host-selected verifier, never caller-supplied PASS or generic acceptance.
 * Every retrieval checks the exact native run and reopens protected evidence.
 * Generic TaskRuntime.accept retains its stronger-route refusal unchanged. */
export async function readReviewedLocalCandidateResult(options: {
  readonly store: FileTaskStore;
  readonly selection: HarnessSelection;
  readonly taskId: string;
  readonly runId: string;
  readonly requestSha256: string;
  readonly policySha256: string;
  readonly verifyCandidate: (
    reference: HarnessRunRef,
  ) => Promise<ReviewedLocalCandidateCompletion>;
}): Promise<ReviewedLocalCandidateCompletion> {
  const runtime = new TaskRuntime({
    store: options.store,
    selection: options.selection,
  });
  const snapshot = await runtime.snapshot(options.taskId);
  assert.equal(
    snapshot.currentRunId,
    options.runId,
    'Candidate result requires current task run.',
  );
  const run = snapshot.runs.find((item) => item.runId === options.runId)!;
  assert(run.nativeRef, 'Candidate result has no exact native reference.');
  assert(
    run.operations.every((item) => item.state === 'CONFIRMED'),
    'Candidate controls remain unresolved.',
  );
  assert(
    run.plan.delegation === 'required' &&
      run.plan.review === 'independent' &&
      run.plan.delivery === 'local' &&
      run.plan.evidence === 'revision-bound' &&
      run.plan.parallelism?.maxConcurrency === 1,
    'Candidate obligations changed.',
  );
  await verifyExecutionHarnessRunIdentity(options.selection, run.nativeRef);
  assert.equal(
    (await getExecutionHarnessStatus(options.selection, run.nativeRef)).status,
    'SUCCEEDED',
    'Native candidate run has not succeeded.',
  );
  assert.equal(
    run.nativeSnapshot?.status,
    'SUCCEEDED',
    'Retain the exact native observation before closeout.',
  );
  assert(snapshot.evidence.verified, snapshot.evidence.issues.join('; '));
  assert(!snapshot.blocker, 'Task has an unresolved blocker.');
  const completion = await options.verifyCandidate(run.nativeRef);
  assert.equal(completion.schema, 1);
  assert.equal(completion.profile, 'reviewed-local-candidate-v1');
  assert.equal(completion.status, 'PASS');
  assert.equal(completion.taskId, options.taskId);
  assert.equal(completion.binding.runId, run.runId);
  assert.equal(completion.binding.nativeRunId, run.nativeRef.externalRunId);
  assert.equal(completion.binding.baseCommit, run.revision);
  assert.equal(completion.binding.planSha256, run.planSha256);
  assert.equal(completion.binding.requestSha256, options.requestSha256);
  assert.equal(completion.binding.policySha256, options.policySha256);
  assert.equal(completion.receiptSha256, snapshot.evidence.receiptSha256);
  assert.equal(completion.scope, 'reviewed-local-candidate-only');
  assert.equal(completion.publication, 'denied');
  // Recheck task version after filesystem/native evidence work. A concurrent
  // cancel, replan or completion update must be reconciled before result use.
  assert.equal(
    (await options.store.load(options.taskId))?.version,
    snapshot.version,
    'Task changed during candidate closeout.',
  );
  return completion;
}
