import { createHash } from 'node:crypto';

import type {
  ExecutionHarness,
  HarnessRunRef,
  HarnessRunRequest,
  HarnessRunSnapshot,
} from '@temari/contracts';
import {
  selectExecutionHarness,
  type HarnessSelection,
} from './harness-selector.js';

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function planSha256(request: HarnessRunRequest): string {
  return createHash('sha256')
    .update(canonical(request.plan), 'utf8')
    .digest('hex');
}

function requireMatchingHarness(
  harness: ExecutionHarness,
  reference: HarnessRunRef,
): void {
  if (
    reference.schema !== 1 ||
    reference.harnessId !== harness.id ||
    reference.harnessVersion !== harness.version ||
    !reference.externalRunId ||
    !/^[a-f0-9]{64}$/.test(reference.planSha256)
  ) {
    throw new Error(
      'Harness reference does not match the selected implementation.',
    );
  }
}

/** Host-only source route. It is deliberately outside ExecutionHarness.start. */
export interface ReviewedLocalCandidatePaths {
  readonly specPath: string;
  readonly bridgePath: string;
  readonly expectedRequestSha256: string;
  readonly expectedBridgeSha256: string;
}
export interface ReviewedLocalCandidateHarness extends ExecutionHarness {
  startReviewedLocalCandidate(
    request: Omit<HarnessRunRequest, 'entrypoint' | 'inputs'>,
    paths: ReviewedLocalCandidatePaths,
  ): Promise<HarnessRunRef>;
}
export async function startReviewedLocalCandidateHarness(
  selection: HarnessSelection,
  request: Omit<HarnessRunRequest, 'entrypoint' | 'inputs'>,
  paths: ReviewedLocalCandidatePaths,
): Promise<HarnessRunRef> {
  const harness = selectExecutionHarness(
    selection,
  ) as Partial<ReviewedLocalCandidateHarness> & ExecutionHarness;
  if (!harness.verifyRunIdentity || !harness.startReviewedLocalCandidate)
    throw new Error(
      'Selected harness does not admit reviewed local candidates.',
    );
  const reference = await harness.startReviewedLocalCandidate(request, paths);
  requireMatchingHarness(harness, reference);
  if (
    reference.runId !== request.runId ||
    reference.revision !== request.revision ||
    reference.workspaceRoot !== request.workspaceRoot ||
    reference.entrypoint !== 'temari-reviewed-local-candidate' ||
    reference.planSha256 !==
      planSha256({ ...request, entrypoint: reference.entrypoint, inputs: {} })
  )
    throw new Error('Managed harness returned a different candidate binding.');
  return reference;
}

/** Start a native run through the host/configured/default composition point. */
export async function startExecutionHarness(
  selection: HarnessSelection,
  request: HarnessRunRequest,
): Promise<HarnessRunRef> {
  const harness = selectExecutionHarness(selection);
  if (request.recovery === 'required' && !harness.verifyRunIdentity) {
    throw new Error(
      `Execution harness ${harness.id}@${harness.version} does not support native run identity verification required for recovery.`,
    );
  }
  const reference = await harness.start(request);
  if (
    reference.runId !== request.runId ||
    reference.revision !== request.revision ||
    reference.workspaceRoot !== request.workspaceRoot ||
    reference.entrypoint !== request.entrypoint ||
    reference.planSha256 !== planSha256(request)
  ) {
    throw new Error(
      'Selected harness returned a reference for a different Temari run, revision, or plan.',
    );
  }
  requireMatchingHarness(harness, reference);
  return reference;
}

/** Read native status without converting it into a Temari stage receipt. */
export async function getExecutionHarnessStatus(
  selection: HarnessSelection,
  reference: HarnessRunRef,
): Promise<HarnessRunSnapshot> {
  const harness = selectExecutionHarness(selection);
  requireMatchingHarness(harness, reference);
  return harness.status(reference);
}

/** Resume only through the same selected harness identity and version. */
export async function resumeExecutionHarness(
  selection: HarnessSelection,
  reference: HarnessRunRef,
): Promise<HarnessRunSnapshot> {
  const harness = selectExecutionHarness(selection);
  requireMatchingHarness(harness, reference);
  return harness.resume(reference);
}

/** Cancel an exact native run through the same harness identity and version. */
export async function cancelExecutionHarness(
  selection: HarnessSelection,
  reference: HarnessRunRef,
): Promise<HarnessRunSnapshot> {
  const harness = selectExecutionHarness(selection);
  requireMatchingHarness(harness, reference);
  if (!harness.cancel) {
    throw new Error(
      `Execution harness ${harness.id}@${harness.version} does not support cancellation.`,
    );
  }
  return harness.cancel(reference);
}

/** Verify a recovered reference against identity retained by the native executor. */
export async function verifyExecutionHarnessRunIdentity(
  selection: HarnessSelection,
  reference: HarnessRunRef,
): Promise<void> {
  const harness = selectExecutionHarness(selection);
  requireMatchingHarness(harness, reference);
  if (!harness.verifyRunIdentity) {
    throw new Error(
      `Execution harness ${harness.id}@${harness.version} does not support native run identity verification required for recovery.`,
    );
  }
  await harness.verifyRunIdentity(reference);
}
