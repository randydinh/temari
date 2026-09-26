import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  link,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import type {
  WorkflowReceipt,
  WorkflowReceiptStatus,
  WorkflowStageId,
} from '@temari/contracts';
import type { TemariRequestPlan } from '@temari/temari-core';
import {
  runPlanWithReceipt,
  type WorkflowCheckpoint,
  type ReceiptRunRequest,
  type StageReceiptResult,
} from '@temari/workflow-engine';
import type { MechanicalRunStatus, WorkflowRunStore } from './run-store.js';
import type { WorkspaceManifestStore } from './workspace-manifest.js';
import type { EvidenceStore } from './evidence-store.js';
import {
  publishStageEvidence,
  verifyStageEvidenceRecord,
  type StageEvidencePayload,
} from './stage-evidence.js';

export interface WorkflowReceiptStore {
  save(receipt: WorkflowReceipt): Promise<string>;
  load(runId: string): Promise<WorkflowReceipt | null>;
}

interface StoredReceipt {
  readonly schema: 1;
  readonly sha256: string;
  readonly receipt: WorkflowReceipt;
}

interface StoredCheckpoint {
  readonly schema: 1;
  readonly sha256: string;
  readonly checkpoint: WorkflowCheckpoint;
}

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

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertRunId(runId: string): void {
  assert(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId),
    'Run ID must be a safe filename component.',
  );
}

function receiptBody(receipt: WorkflowReceipt): string {
  return canonical(receipt);
}

function storedBody(receipt: WorkflowReceipt): string {
  const body = receiptBody(receipt);
  const stored: StoredReceipt = {
    schema: 1,
    sha256: digest(body),
    receipt,
  };
  return canonical(stored);
}

function checkpointBody(checkpoint: WorkflowCheckpoint): string {
  return canonical(checkpoint);
}

function storedCheckpointBody(checkpoint: WorkflowCheckpoint): string {
  const body = checkpointBody(checkpoint);
  const stored: StoredCheckpoint = {
    schema: 1,
    sha256: digest(body),
    checkpoint,
  };
  return canonical(stored);
}

function parseStored(value: unknown): WorkflowReceipt {
  assert(
    value && typeof value === 'object',
    'Stored receipt must be an object.',
  );
  const stored = value as Partial<StoredReceipt>;
  assert(stored.schema === 1, 'Unsupported stored receipt schema.');
  assert(typeof stored.sha256 === 'string', 'Stored receipt hash is missing.');
  assert(
    stored.receipt && typeof stored.receipt === 'object',
    'Stored receipt body is missing.',
  );
  assert.equal(stored.sha256, digest(receiptBody(stored.receipt)));
  assert.equal(stored.receipt.schema, 1);
  assert(
    typeof stored.receipt.runId === 'string',
    'Stored receipt run ID is missing.',
  );
  return stored.receipt;
}

function parseStoredCheckpoint(value: unknown): WorkflowCheckpoint {
  assert(
    value && typeof value === 'object',
    'Stored workflow checkpoint must be an object.',
  );
  const stored = value as Partial<StoredCheckpoint>;
  assert(stored.schema === 1, 'Unsupported stored checkpoint schema.');
  assert(
    typeof stored.sha256 === 'string',
    'Stored checkpoint hash is missing.',
  );
  assert(
    stored.checkpoint && typeof stored.checkpoint === 'object',
    'Stored checkpoint body is missing.',
  );
  assert.equal(stored.sha256, digest(checkpointBody(stored.checkpoint)));
  const checkpoint = stored.checkpoint;
  assert.equal(checkpoint.schema, 1);
  assertRunId(checkpoint.runId);
  assert(
    typeof checkpoint.revision === 'string' && checkpoint.revision.length > 0,
    'Checkpoint revision is required.',
  );
  assert(Number.isFinite(Date.parse(checkpoint.startedAt)));
  assert(Array.isArray(checkpoint.stages));
  let previousStage: string | null = null;
  for (const stage of checkpoint.stages) {
    assert(stage && typeof stage === 'object');
    assert(typeof stage.stage === 'string');
    assert.equal(stage.status, 'PASS');
    assert(
      previousStage === null || previousStage !== stage.stage,
      'Checkpoint stages must not repeat.',
    );
    previousStage = stage.stage;
  }
  return checkpoint;
}

export interface WorkflowCheckpointStore {
  save(checkpoint: WorkflowCheckpoint): Promise<string>;
  load(runId: string): Promise<WorkflowCheckpoint | null>;
}

export class FileWorkflowCheckpointStore implements WorkflowCheckpointStore {
  private constructor(private readonly root: string) {}

  static async create(root: string): Promise<FileWorkflowCheckpointStore> {
    assert(isAbsolute(root), 'Checkpoint store root must be absolute.');
    await mkdir(root, { recursive: true, mode: 0o700 });
    return new FileWorkflowCheckpointStore(await realpath(root));
  }

  async save(checkpoint: WorkflowCheckpoint): Promise<string> {
    assertRunId(checkpoint.runId);
    assert(checkpoint.revision.length > 0, 'Checkpoint revision is required.');
    const path = join(this.root, `${checkpoint.runId}.checkpoint.json`);
    const existing = await this.load(checkpoint.runId);
    if (existing) {
      assert.equal(existing.revision, checkpoint.revision);
      assert.equal(existing.startedAt, checkpoint.startedAt);
      assert.equal(
        checkpointBody(existing),
        checkpointBody({
          ...checkpoint,
          stages: existing.stages,
        }),
        'Checkpoint identity changed.',
      );
      assert(
        existing.stages.length <= checkpoint.stages.length,
        'Checkpoint history cannot move backwards.',
      );
      assert.deepEqual(
        existing.stages,
        checkpoint.stages.slice(0, existing.stages.length),
        'Checkpoint history is not an append-only prefix.',
      );
    }

    const body = storedCheckpointBody(checkpoint);
    const temporary = join(
      this.root,
      `.${checkpoint.runId}.${randomUUID()}.tmp`,
    );
    const file = await open(temporary, 'wx', 0o600);
    try {
      try {
        await file.writeFile(body);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    return path;
  }

  async load(runId: string): Promise<WorkflowCheckpoint | null> {
    assertRunId(runId);
    try {
      const checkpoint = parseStoredCheckpoint(
        JSON.parse(
          await readFile(join(this.root, `${runId}.checkpoint.json`), 'utf8'),
        ),
      );
      assert.equal(
        checkpoint.runId,
        runId,
        'Checkpoint filename and body disagree.',
      );
      return checkpoint;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
}

export class FileWorkflowReceiptStore implements WorkflowReceiptStore {
  private constructor(private readonly root: string) {}

  static async create(root: string): Promise<FileWorkflowReceiptStore> {
    assert(isAbsolute(root), 'Receipt store root must be absolute.');
    await mkdir(root, { recursive: true, mode: 0o700 });
    const canonicalRoot = await realpath(root);
    return new FileWorkflowReceiptStore(canonicalRoot);
  }

  async save(receipt: WorkflowReceipt): Promise<string> {
    assertRunId(receipt.runId);
    assert(receipt.revision.length > 0, 'Receipt revision is required.');
    const path = join(this.root, `${receipt.runId}.receipt.json`);
    const body = storedBody(receipt);
    const temporary = join(this.root, `.${receipt.runId}.${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      try {
        await file.writeFile(body);
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        await link(temporary, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        assert.equal(
          await readFile(path, 'utf8'),
          body,
          'Receipt collision or mutation.',
        );
      }
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    return path;
  }

  async load(runId: string): Promise<WorkflowReceipt | null> {
    assertRunId(runId);
    try {
      const value: unknown = JSON.parse(
        await readFile(join(this.root, `${runId}.receipt.json`), 'utf8'),
      );
      const receipt = parseStored(value);
      assert.equal(receipt.runId, runId, 'Receipt filename and body disagree.');
      return receipt;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
}

export interface ExecuteAndPersistRequest extends Omit<
  ReceiptRunRequest,
  'handler'
> {
  readonly stageEvidence?: { readonly store: EvidenceStore };
  readonly handler: (
    stage: WorkflowStageId,
    plan: ReceiptRunRequest['plan'],
  ) =>
    | (StageReceiptResult & {
        readonly evidence?: readonly StageEvidencePayload[];
      })
    | Promise<
        StageReceiptResult & {
          readonly evidence?: readonly StageEvidencePayload[];
        }
      >;
  readonly store: WorkflowReceiptStore;
  readonly checkpointStore?: WorkflowCheckpointStore;
  readonly workspaceManifestStore?: WorkspaceManifestStore;
  readonly workspaceForStage?: (
    stage: WorkflowStageId,
  ) => StageWorkspaceBinding | null | undefined;
}

/**
 * Workspace bound to a serial stage. For checkpoint resume, callers should
 * bind a stable stage workspace; a later stage changing the same root causes
 * the earlier checkpoint manifest to fail closed.
 */
export interface StageWorkspaceBinding {
  readonly workspaceId: string;
  readonly root: string;
}

function workspaceManifestId(stage: WorkflowStageId): string {
  return stage;
}

async function persistStageWorkspaceManifest(
  request: ExecuteAndPersistRequest,
  stage: WorkflowStageId,
  now: () => Date,
): Promise<string | null> {
  const store = request.workspaceManifestStore;
  if (!store) return null;
  const binding = request.workspaceForStage?.(stage);
  assert(
    binding,
    'Workspace manifest storage requires a workspace binding for every stage.',
  );
  const manifest = await store.capture({
    runId: request.runId,
    revision: request.revision,
    subjectId: workspaceManifestId(stage),
    workspaceId: binding.workspaceId,
    workspaceRoot: binding.root,
    now: now(),
  });
  await store.save(manifest);
  return workspaceManifestId(stage);
}

async function verifyCheckpointWorkspaceManifests(
  request: ExecuteAndPersistRequest,
  checkpoint: WorkflowCheckpoint | null,
): Promise<void> {
  const store = request.workspaceManifestStore;
  if (!store || !checkpoint) return;
  await Promise.all(
    checkpoint.stages.map(async (stage) => {
      const id = stage.workspaceManifestId;
      assert(
        id === workspaceManifestId(stage.stage),
        `Checkpoint stage ${stage.stage} is missing its workspace manifest ID.`,
      );
      const binding = request.workspaceForStage?.(stage.stage);
      assert(
        binding,
        `Checkpoint stage ${stage.stage} has no workspace binding.`,
      );
      const manifest = await store.load(request.runId, id);
      assert(
        manifest,
        `Checkpoint stage ${stage.stage} is missing its workspace manifest.`,
      );
      assert.equal(manifest.revision, request.revision);
      assert.equal(manifest.workspaceId, binding.workspaceId);
      await store.verify(manifest, binding.root);
    }),
  );
}

export async function executeAndPersist(
  request: ExecuteAndPersistRequest,
): Promise<WorkflowReceipt> {
  if (request.workspaceManifestStore) {
    assert(
      request.workspaceForStage,
      'Workspace manifest storage requires workspaceForStage.',
    );
  }
  const checkpoint =
    (await request.checkpointStore?.load(request.runId)) ??
    request.checkpoint ??
    null;
  const evidenceProfile = request.stageEvidence
    ? 'stage-evidence-v1'
    : undefined;
  assert(
    request.evidenceProfile === undefined ||
      request.evidenceProfile === evidenceProfile,
    'Runtime evidence profile requires stageEvidence storage.',
  );
  if (checkpoint) {
    assert.equal(
      checkpoint.evidenceProfile,
      evidenceProfile,
      'Checkpoint evidence profile mismatch.',
    );
    if (request.stageEvidence)
      await verifyStageEvidenceRecord(
        checkpoint,
        request.runId,
        request.revision,
        request.stageEvidence.store,
        false,
      );
  }
  await verifyCheckpointWorkspaceManifests(request, checkpoint);
  const receipt = await runPlanWithReceipt({
    ...request,
    ...(evidenceProfile ? { evidenceProfile } : {}),
    checkpoint,
    handler: async (stage, plan): Promise<StageReceiptResult> => {
      const result = { ...(await request.handler(stage, plan)) };
      if (request.stageEvidence)
        assert(
          result.stageEvidence === undefined,
          'Handlers cannot supply raw stage evidence bindings.',
        );
      const manifestId = await persistStageWorkspaceManifest(
        request,
        stage,
        request.now ?? (() => new Date()),
      );
      const bound = manifestId
        ? { ...result, workspaceManifestId: manifestId }
        : result;
      if (request.stageEvidence && result.status === 'PASS') {
        return {
          ...bound,
          stageEvidence: await publishStageEvidence(
            request.stageEvidence.store,
            request.runId,
            request.revision,
            stage,
            bound,
            result.evidence,
          ),
        };
      }
      return bound;
    },
    onStageCheckpoint: async (nextCheckpoint) => {
      await request.checkpointStore?.save(nextCheckpoint);
      await request.onStageCheckpoint?.(nextCheckpoint);
    },
  });
  if (request.stageEvidence && receipt.status === 'PASS') {
    await verifyStageEvidenceRecord(
      receipt,
      request.runId,
      request.revision,
      request.stageEvidence.store,
      true,
    );
  }
  await request.store.save(receipt);
  return receipt;
}

export interface ExecuteRequestPlanAndPersistRequest extends Omit<
  ExecuteAndPersistRequest,
  'plan'
> {
  /** The coordinator has already classified this request and reconciled its plan. */
  readonly requestPlan: TemariRequestPlan;
}

/**
 * Execute a coordinator-produced request plan through the existing persisted
 * serial engine. Runtime services receive policy; they do not classify or
 * reinterpret the request.
 */
export async function executeRequestPlanAndPersist(
  request: ExecuteRequestPlanAndPersistRequest,
): Promise<WorkflowReceipt> {
  return executeAndPersist({
    ...request,
    plan: request.requestPlan.plan,
  });
}

export interface ExecuteScheduledAndPersistRequest extends ExecuteAndPersistRequest {
  readonly runStore: WorkflowRunStore;
  readonly owner: string;
  readonly leaseMs: number;
  /** Renew the parent lease while the revision is executing. */
  readonly leaseRenewal?: {
    readonly intervalMs: number;
  };
  /** Honor a durable parent cancellation request at the completion boundary. */
  readonly cancellation?: {
    readonly onRequested: 'cancel-before-completion';
  };
}

export interface ScheduledExecutionResult {
  readonly claimed: boolean;
  readonly record: import('./run-store.js').MechanicalRunRecord;
  readonly receipt: WorkflowReceipt | null;
}

function mechanicalStatus(status: WorkflowReceiptStatus): MechanicalRunStatus {
  if (status === 'PASS') return 'SUCCEEDED';
  if (status === 'BLOCKED') return 'BLOCKED';
  if (status === 'DROPPED') return 'CANCELLED';
  return 'FAILED';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertLeaseRenewalInterval(intervalMs: number): void {
  assert(
    Number.isInteger(intervalMs) && intervalMs > 0,
    'Lease renewal interval must be a positive integer.',
  );
}

/**
 * Run one revision through the mechanical boundary. The run store owns
 * leases, event ordering, retries, and status; the workflow engine still owns
 * stage order and receipt semantics.
 */
export async function executeScheduledAndPersist(
  request: ExecuteScheduledAndPersistRequest,
): Promise<ScheduledExecutionResult> {
  const now = request.now ?? (() => new Date());
  await request.runStore.create({
    runId: request.runId,
    revision: request.revision,
    actor: request.owner,
    now: now(),
  });
  const claim = await request.runStore.claim({
    runId: request.runId,
    owner: request.owner,
    leaseMs: request.leaseMs,
    now: now(),
  });
  if (!claim.claimed || !claim.record.lease) {
    return { claimed: false, record: claim.record, receipt: null };
  }

  const leaseToken = claim.record.lease.token;
  const attempt = claim.record.attempt;
  const renewalIntervalMs = request.leaseRenewal?.intervalMs;
  if (renewalIntervalMs !== undefined) {
    assertLeaseRenewalInterval(renewalIntervalMs);
  }
  await request.runStore.appendEvent({
    runId: request.runId,
    actor: request.owner,
    idempotencyKey: `dispatch:${request.runId}:${attempt}`,
    payload: { attempt, revision: request.revision },
    now: now(),
  });

  let renewalError: unknown = null;
  let renewalSequence = 0;
  let renewalInFlight: Promise<void> | null = null;
  let renewalTimer: ReturnType<typeof setInterval> | null = null;
  const renew = async (): Promise<void> => {
    if (renewalError) return;
    try {
      await request.runStore.renew({
        runId: request.runId,
        owner: request.owner,
        leaseToken,
        leaseMs: request.leaseMs,
        idempotencyKey: `renew:${request.runId}:${attempt}:${++renewalSequence}`,
        now: now(),
      });
    } catch (error) {
      renewalError = error;
      if (renewalTimer) clearInterval(renewalTimer);
    }
  };
  if (renewalIntervalMs !== undefined) {
    renewalTimer = setInterval(() => {
      if (renewalInFlight) return;
      renewalInFlight = renew().finally(() => {
        renewalInFlight = null;
      });
    }, renewalIntervalMs);
  }

  try {
    const receipt = await executeAndPersist(request);
    if (renewalInFlight) await renewalInFlight;
    if (renewalTimer) clearInterval(renewalTimer);
    if (renewalError) throw renewalError;
    const cancellationRequested =
      request.cancellation?.onRequested === 'cancel-before-completion' &&
      (await request.runStore.cancellationRequested(request.runId));
    const record = await request.runStore.transition({
      runId: request.runId,
      owner: request.owner,
      leaseToken,
      status: cancellationRequested
        ? 'CANCELLED'
        : mechanicalStatus(receipt.status),
      idempotencyKey: `complete:${request.runId}:${attempt}`,
      payload: {
        receipt: `${request.runId}.receipt.json`,
        receiptStatus: receipt.status,
        cancellationRequested,
      },
      now: now(),
    });
    return { claimed: true, record, receipt };
  } catch (error) {
    if (renewalTimer) clearInterval(renewalTimer);
    if (renewalInFlight) await renewalInFlight;
    try {
      const cancellationRequested =
        request.cancellation?.onRequested === 'cancel-before-completion' &&
        (await request.runStore.cancellationRequested(request.runId));
      await request.runStore.transition({
        runId: request.runId,
        owner: request.owner,
        leaseToken,
        status: cancellationRequested ? 'CANCELLED' : 'FAILED',
        idempotencyKey: `failed:${request.runId}:${attempt}`,
        payload: { error: errorMessage(error), cancellationRequested },
        now: now(),
      });
    } catch (transitionError) {
      throw new Error(
        `${errorMessage(error)}; run status transition failed: ${errorMessage(transitionError)}`,
      );
    }
    throw error;
  } finally {
    if (renewalTimer) clearInterval(renewalTimer);
  }
}
