import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  DEFAULT_STAGES,
  type EvidenceKind,
  type StageEvidenceReference,
  type WorkerEvidenceReference,
  type WorkflowStageId,
} from '@temari/contracts';
import type { StageReceiptResult } from '@temari/workflow-engine';
import type { EvidenceStore, PutEvidenceRequest } from './evidence-store.js';
import type { WorkflowReceiptStore } from './runtime.js';

export interface StageEvidencePayload {
  readonly name: string;
  readonly kind: EvidenceKind;
  readonly content: string | Uint8Array;
}

export interface VerifiedStageEvidence {
  readonly status: 'evidence-verified';
  readonly scope: 'persisted-stage-evidence-only';
  readonly runId: string;
  readonly revision: string;
  readonly stages: readonly {
    readonly stage: WorkflowStageId;
    readonly payloads: readonly {
      readonly name: string;
      readonly kind: EvidenceKind;
      readonly content: Uint8Array;
    }[];
  }[];
}

const kinds = new Set([
  'stdout',
  'stderr',
  'worker-result',
  'verification',
  'other',
]);
const maxBytes = 16 * 1024 * 1024;
const maxPayloads = 32;

function object(value: unknown): Record<string, unknown> {
  assert(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'Expected evidence record.',
  );
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, expected: string[]): void {
  assert.deepEqual(
    Object.keys(value).sort(),
    expected.sort(),
    'Unexpected evidence record fields.',
  );
}

function text(value: unknown): asserts value is string {
  assert(
    typeof value === 'string' && value.length > 0,
    'Expected nonempty evidence text.',
  );
}

function identity(runId: unknown, revision: unknown): void {
  text(runId);
  assert(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId),
    'Invalid evidence run ID.',
  );
  text(revision);
  assert(revision.length <= 512, 'Invalid evidence revision.');
}

function reference(value: unknown): StageEvidenceReference {
  const ref = object(value);
  keys(ref, ['schema', 'sha256', 'bytes']);
  assert.equal(ref.schema, 1, 'Unsupported stage evidence reference version.');
  assert(
    typeof ref.sha256 === 'string' && /^[0-9a-f]{64}$/.test(ref.sha256),
    'Invalid evidence digest.',
  );
  assert(
    typeof ref.bytes === 'number' &&
      Number.isSafeInteger(ref.bytes) &&
      ref.bytes >= 0 &&
      ref.bytes <= maxBytes,
    'Invalid evidence byte count.',
  );
  return ref as unknown as StageEvidenceReference;
}

async function load(
  store: EvidenceStore,
  ref: WorkerEvidenceReference,
): Promise<Uint8Array> {
  const bytes = await store.loadPortable(ref);
  assert(bytes instanceof Uint8Array, 'Evidence store returned invalid bytes.');
  assert.equal(bytes.byteLength, ref.bytes, 'Evidence byte count changed.');
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    ref.sha256,
    'Evidence hash changed.',
  );
  return bytes;
}

function named(value: unknown, names: Set<string>): asserts value is string {
  text(value);
  assert(
    value.length <= 128 && !names.has(value),
    'Duplicate or invalid evidence payload name.',
  );
  names.add(value);
}

function stageContext(
  value: unknown,
  expectedStage: WorkflowStageId,
): Record<string, unknown> {
  const stage = object(value);
  assert.equal(
    stage.stage,
    expectedStage,
    'Evidence stages must be an ordered canonical prefix.',
  );
  assert.equal(
    stage.status,
    'PASS',
    'Evidence verification requires PASS stages.',
  );
  assert(typeof stage.summary === 'string', 'Invalid stage summary.');
  assert(
    stage.workspaceManifestId === undefined ||
      stage.workspaceManifestId === null ||
      typeof stage.workspaceManifestId === 'string',
    'Invalid workspace manifest ID.',
  );
  for (const field of ['startedAt', 'completedAt']) {
    assert(
      typeof stage[field] === 'string' &&
        Number.isFinite(Date.parse(stage[field] as string)),
      'Invalid stage timestamp.',
    );
  }
  assert(
    Array.isArray(stage.evidencePaths) &&
      stage.evidencePaths.every((path) => typeof path === 'string'),
    'Invalid evidence paths.',
  );
  assert(
    stage.rawLogPath === null || typeof stage.rawLogPath === 'string',
    'Invalid raw log path.',
  );
  return stage;
}

async function verifyStage(
  store: EvidenceStore,
  runId: string,
  revision: string,
  stage: Record<string, unknown>,
) {
  const ref = reference(stage.stageEvidence);
  const bytes = await load(store, { ...ref, runId, revision, kind: 'other' });
  const record = object(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
  );
  keys(record, [
    'schema',
    'runId',
    'revision',
    'stage',
    'status',
    'summary',
    'workspaceManifestId',
    'payloads',
  ]);
  assert.equal(record.schema, 1, 'Unsupported stage attestation version.');
  assert.equal(record.runId, runId, 'Attestation run ID mismatch.');
  assert.equal(record.revision, revision, 'Attestation revision mismatch.');
  for (const field of ['stage', 'status', 'summary'])
    assert.equal(record[field], stage[field], `Attestation ${field} mismatch.`);
  assert.equal(
    record.workspaceManifestId,
    stage.workspaceManifestId ?? null,
    'Attestation manifest mismatch.',
  );
  assert(
    Array.isArray(record.payloads) &&
      record.payloads.length > 0 &&
      record.payloads.length <= maxPayloads,
    'Stage evidence requires 1 to 32 payloads.',
  );
  const names = new Set<string>();
  const validated = [];
  let totalBytes = 0;
  for (const value of record.payloads) {
    const payload = object(value);
    keys(payload, ['name', 'reference']);
    named(payload.name, names);
    const portable = object(payload.reference);
    keys(portable, ['schema', 'runId', 'revision', 'kind', 'sha256', 'bytes']);
    reference({
      schema: portable.schema,
      sha256: portable.sha256,
      bytes: portable.bytes,
    });
    assert.equal(portable.runId, runId, 'Payload run ID mismatch.');
    assert.equal(portable.revision, revision, 'Payload revision mismatch.');
    assert(
      typeof portable.kind === 'string' && kinds.has(portable.kind),
      'Invalid evidence kind.',
    );
    totalBytes += portable.bytes as number;
    assert(
      totalBytes <= maxBytes,
      'Stage evidence payload total exceeds 16 MiB.',
    );
    validated.push({
      name: payload.name,
      reference: portable as unknown as WorkerEvidenceReference,
    });
  }
  const payloads = [];
  for (const payload of validated)
    payloads.push({
      name: payload.name,
      kind: payload.reference.kind,
      content: await load(store, payload.reference),
    });
  return { stage: stage.stage as WorkflowStageId, payloads };
}

export async function verifyStageEvidenceRecord(
  value: unknown,
  runId: string,
  revision: string,
  store: EvidenceStore,
  complete: boolean,
): Promise<VerifiedStageEvidence> {
  identity(runId, revision);
  const record = object(value);
  assert.equal(record.schema, 1, 'Unsupported workflow record schema.');
  assert.equal(
    record.evidenceProfile,
    'stage-evidence-v1',
    'Unsupported or missing stage evidence profile.',
  );
  assert.equal(record.runId, runId, 'Workflow run ID mismatch.');
  assert.equal(record.revision, revision, 'Workflow revision mismatch.');
  assert.deepEqual(
    object(record.plan).stages,
    DEFAULT_STAGES,
    'Noncanonical evidence plan.',
  );
  assert(
    typeof record.startedAt === 'string' &&
      Number.isFinite(Date.parse(record.startedAt)),
    'Invalid workflow start time.',
  );
  assert(
    Array.isArray(record.stages) &&
      record.stages.length <= DEFAULT_STAGES.length,
    'Invalid workflow stages.',
  );
  if (complete) {
    assert.equal(
      record.status,
      'PASS',
      'Evidence verification requires a PASS receipt.',
    );
    assert.equal(record.failure, null, 'Evidence receipt has a failure.');
    assert(
      typeof record.completedAt === 'string' &&
        Number.isFinite(Date.parse(record.completedAt)),
      'Invalid workflow completion time.',
    );
    assert.equal(
      record.stages.length,
      DEFAULT_STAGES.length,
      'Incomplete stage evidence coverage.',
    );
  }
  const stages = [];
  for (let index = 0; index < record.stages.length; index++) {
    const stage = stageContext(record.stages[index], DEFAULT_STAGES[index]);
    stages.push(await verifyStage(store, runId, revision, stage));
  }
  return {
    status: 'evidence-verified',
    scope: 'persisted-stage-evidence-only',
    runId,
    revision,
    stages,
  };
}

async function publish(
  store: EvidenceStore,
  request: PutEvidenceRequest,
): Promise<WorkerEvidenceReference> {
  const content =
    typeof request.content === 'string'
      ? Buffer.from(request.content, 'utf8')
      : Buffer.from(request.content);
  const expected: WorkerEvidenceReference = {
    schema: 1,
    runId: request.runId,
    revision: request.revision,
    kind: request.kind,
    sha256: createHash('sha256').update(content).digest('hex'),
    bytes: content.byteLength,
  };
  const stored = object(await store.put({ ...request, content }));
  for (const key of [
    'schema',
    'runId',
    'revision',
    'kind',
    'sha256',
    'bytes',
  ] as const) {
    assert.equal(
      stored[key],
      expected[key],
      `Evidence publication ${key} mismatch.`,
    );
  }
  return expected;
}

export async function publishStageEvidence(
  store: EvidenceStore,
  runId: string,
  revision: string,
  stage: WorkflowStageId,
  result: StageReceiptResult,
  payloads: readonly StageEvidencePayload[] | undefined,
): Promise<StageEvidenceReference> {
  identity(runId, revision);
  assert(
    Array.isArray(payloads) &&
      payloads.length > 0 &&
      payloads.length <= maxPayloads,
    'Stage evidence requires 1 to 32 payloads.',
  );
  assert(typeof result.summary === 'string', 'Invalid stage summary.');
  assert(
    result.workspaceManifestId === undefined ||
      result.workspaceManifestId === null ||
      typeof result.workspaceManifestId === 'string',
    'Invalid workspace manifest ID.',
  );
  const names = new Set<string>();
  let totalBytes = 0;
  for (const payload of payloads) {
    object(payload);
    named(payload.name, names);
    assert(kinds.has(payload.kind), 'Invalid evidence kind.');
    assert(
      typeof payload.content === 'string' ||
        payload.content instanceof Uint8Array,
      'Invalid evidence content.',
    );
    totalBytes +=
      typeof payload.content === 'string'
        ? Buffer.byteLength(payload.content)
        : payload.content.byteLength;
    assert(
      totalBytes <= maxBytes,
      'Stage evidence payload total exceeds 16 MiB.',
    );
  }
  const references = [];
  for (const payload of payloads) {
    const portable = await publish(store, {
      runId,
      revision,
      kind: payload.kind,
      content: payload.content,
    });
    references.push({ name: payload.name, reference: portable });
  }
  const stored = await publish(store, {
    runId,
    revision,
    kind: 'other',
    content: JSON.stringify({
      schema: 1,
      runId,
      revision,
      stage,
      status: result.status,
      summary: result.summary,
      workspaceManifestId: result.workspaceManifestId ?? null,
      payloads: references,
    }),
  });
  const ref = {
    schema: stored.schema,
    sha256: stored.sha256,
    bytes: stored.bytes,
  };
  await verifyStage(store, runId, revision, {
    ...result,
    stage,
    stageEvidence: ref,
  });
  return ref;
}

export async function verifyPersistedStageEvidence(request: {
  readonly runId: string;
  readonly revision: string;
  readonly store: WorkflowReceiptStore;
  readonly evidenceStore: EvidenceStore;
}): Promise<VerifiedStageEvidence> {
  identity(request.runId, request.revision);
  const receipt = await request.store.load(request.runId);
  assert(receipt, 'Persisted workflow receipt is missing.');
  return verifyStageEvidenceRecord(
    receipt,
    request.runId,
    request.revision,
    request.evidenceStore,
    true,
  );
}
