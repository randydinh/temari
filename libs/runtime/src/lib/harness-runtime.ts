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

/** Start a native run through the host/configured/default composition point. */
export async function startExecutionHarness(
  selection: HarnessSelection,
  request: HarnessRunRequest,
): Promise<HarnessRunRef> {
  const harness = selectExecutionHarness(selection);
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
