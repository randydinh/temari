import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import type {
  ExecutionHarness,
  HarnessRunRef,
  WorkflowReceipt,
} from '@temari/contracts';
import type { EvidenceStore } from './evidence-store.js';
import type { WorkflowReceiptStore } from './runtime.js';
import { verifyStageEvidenceRecord } from './stage-evidence.js';

export interface ReceiptEvidenceSource {
  readonly runId: string;
  readonly receipts: WorkflowReceiptStore;
  readonly evidence: EvidenceStore;
}

export interface ArchonReceiptParityRequest {
  readonly harness: ExecutionHarness;
  readonly reference: HarnessRunRef;
  readonly serial: ReceiptEvidenceSource;
  readonly archon: ReceiptEvidenceSource;
}

/** Local deterministic comparison; it does not authorize workflow closeout. */
export interface ArchonReceiptParityBundle {
  readonly schema: 1;
  readonly scope: 'deterministic-receipt-parity';
  readonly nativeRun: HarnessRunRef;
  readonly serialReceipt: WorkflowReceipt;
  readonly archonReceipt: WorkflowReceipt;
}

function canonical(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((item) => canonical(item)).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

function planDigest(receipt: WorkflowReceipt): string {
  return createHash('sha256').update(canonical(receipt.plan)).digest('hex');
}

function assertReference(
  harness: ExecutionHarness,
  reference: HarnessRunRef,
  serialRunId: string,
  archonRunId: string,
): void {
  assert.equal(harness.id, 'archon', 'Archon harness is required.');
  assert.equal(reference.schema, 1, 'Invalid native run reference.');
  assert.equal(reference.harnessId, harness.id, 'Harness identity changed.');
  assert.equal(
    reference.harnessVersion,
    harness.version,
    'Harness version changed.',
  );
  assert.match(reference.externalRunId, /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/);
  assert(!reference.externalRunId.includes('..'), 'Invalid native run ID.');
  assert.equal(reference.runId, archonRunId, 'Archon run ID changed.');
  assert.notEqual(
    serialRunId,
    archonRunId,
    'Parity requires two distinct runs.',
  );
  assert(reference.revision.length > 0, 'Frozen revision is missing.');
  assert.match(reference.planSha256, /^[a-f0-9]{64}$/);
}

async function verifiedReceipt(
  source: ReceiptEvidenceSource,
  reference: HarnessRunRef,
): Promise<{
  receipt: WorkflowReceipt;
  evidence: Awaited<ReturnType<typeof verifyStageEvidenceRecord>>;
}> {
  const receipt = await source.receipts.load(source.runId);
  assert(receipt, `Persisted receipt is missing for ${source.runId}.`);
  assert.equal(receipt.runId, source.runId, 'Receipt run ID changed.');
  assert.equal(
    receipt.revision,
    reference.revision,
    'Receipt revision is stale.',
  );
  assert.equal(
    planDigest(receipt),
    reference.planSha256,
    'Receipt plan is stale.',
  );
  assert.equal(
    receipt.evidenceProfile,
    'stage-evidence-v1',
    'Deterministic parity requires stage evidence v1.',
  );
  return {
    receipt,
    evidence: await verifyStageEvidenceRecord(
      receipt,
      source.runId,
      reference.revision,
      source.evidence,
      true,
    ),
  };
}

/**
 * Compare two persisted receipts for one frozen plan after the selected
 * Archon harness reports success. Exact payload comparison is appropriate for
 * deterministic conformance fixtures, not variable model output.
 */
export async function verifyDeterministicArchonReceiptParity(
  request: ArchonReceiptParityRequest,
): Promise<ArchonReceiptParityBundle> {
  const { harness, reference, serial, archon } = request;
  assertReference(harness, reference, serial.runId, archon.runId);
  const native = await harness.status(reference);
  assert.equal(native.status, 'SUCCEEDED', 'Native run has not succeeded.');
  const serialVerified = await verifiedReceipt(serial, reference);
  const archonVerified = await verifiedReceipt(archon, reference);
  for (let index = 0; index < serialVerified.receipt.stages.length; index++) {
    const serialStage = serialVerified.receipt.stages[index]!;
    const archonStage = archonVerified.receipt.stages[index]!;
    assert.equal(serialStage.stage, archonStage.stage, 'Stage order differs.');
    assert.equal(
      serialStage.summary,
      archonStage.summary,
      'Stage result differs.',
    );
    const serialPayloads = serialVerified.evidence.stages[index]!.payloads;
    const archonPayloads = archonVerified.evidence.stages[index]!.payloads;
    assert.equal(
      serialPayloads.length,
      archonPayloads.length,
      'Stage payload count differs.',
    );
    for (
      let payloadIndex = 0;
      payloadIndex < serialPayloads.length;
      payloadIndex++
    ) {
      const left = serialPayloads[payloadIndex]!;
      const right = archonPayloads[payloadIndex]!;
      assert.equal(left.name, right.name, 'Stage payload name differs.');
      assert.equal(left.kind, right.kind, 'Stage payload kind differs.');
      assert.deepEqual(
        left.content,
        right.content,
        'Stage payload bytes differ.',
      );
    }
  }
  return {
    schema: 1,
    scope: 'deterministic-receipt-parity',
    nativeRun: structuredClone(reference),
    serialReceipt: structuredClone(serialVerified.receipt),
    archonReceipt: structuredClone(archonVerified.receipt),
  };
}
