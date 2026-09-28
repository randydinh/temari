import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import {
  assertCandidateBinding,
  assertCandidateIdentity,
  assertEvidenceProfile,
  DEFAULT_STAGES,
  type CandidateBinding,
  type CandidateIdentity,
  type WorkflowReceipt,
  type WorkflowReceiptStatus,
  type WorkflowStageId,
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
  verifyCandidateEvidenceRecord,
  type StageEvidencePayload,
} from './stage-evidence.js';
import {
  observeCandidate,
  prepareCandidateRoots,
  type CandidateRunOptions,
  type LocalCandidateScope,
} from './candidate.js';

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

  static async openExisting(root: string): Promise<FileWorkflowReceiptStore> {
    assert(isAbsolute(root), 'Receipt store root must be absolute.');
    assert((await lstat(root)).isDirectory(), 'Receipt store must exist.');
    return new FileWorkflowReceiptStore(await realpath(root));
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

interface ExecuteAndPersistBase extends Omit<
  ReceiptRunRequest,
  'handler' | 'candidateBinding' | 'onInitialCheckpoint' | 'evidenceProfile'
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

export type ExecuteAndPersistRequest = ExecuteAndPersistBase &
  (
    | {
        readonly candidate?: never;
        readonly evidenceProfile?: 'stage-evidence-v1';
      }
    | {
        readonly candidate: CandidateRunOptions;
        readonly evidenceProfile?: 'candidate-stage-evidence-v1';
        readonly checkpointStore: WorkflowCheckpointStore;
        readonly stageEvidence: { readonly store: EvidenceStore };
        readonly workspaceManifestStore: WorkspaceManifestStore;
        readonly workspaceForStage: (
          stage: WorkflowStageId,
        ) => StageWorkspaceBinding;
      }
  );

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
  request: Pick<
    ExecuteAndPersistBase,
    'runId' | 'revision' | 'workspaceManifestStore' | 'workspaceForStage'
  >,
  checkpoint: Pick<WorkflowCheckpoint, 'stages'> | null,
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
      assert.equal(manifest.runId, request.runId);
      assert.equal(manifest.subjectId, id);
      assert.equal(manifest.workspaceId, binding.workspaceId);
      await store.verify(manifest, binding.root);
    }),
  );
}

function immutableCopy<T>(value: T): T {
  function freeze(item: unknown): void {
    if (!item || typeof item !== 'object' || Object.isFrozen(item)) return;
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
  }
  const copy = structuredClone(value);
  freeze(copy);
  return copy;
}

async function saveCandidateCheckpoint(
  store: WorkflowCheckpointStore,
  checkpoint: WorkflowCheckpoint,
): Promise<void> {
  const expected = immutableCopy(checkpoint);
  await store.save(structuredClone(expected));
  assert.deepEqual(
    await store.load(expected.runId),
    expected,
    'Candidate checkpoint readback changed.',
  );
}

function captureExecutionRequest<T extends ExecuteAndPersistRequest>(
  request: T,
) {
  assert(
    request.candidate === undefined ||
      (request.candidate !== null &&
        typeof request.candidate === 'object' &&
        !Array.isArray(request.candidate)),
    'Candidate options must be an object.',
  );
  if (request.candidate) {
    assert(
      request.checkpointStore &&
        request.stageEvidence?.store &&
        request.workspaceManifestStore &&
        request.workspaceForStage,
      'Candidate execution requires checkpoint, evidence, manifest stores and stage bindings.',
    );
    request = {
      ...request,
      plan: immutableCopy(request.plan),
      capabilities: immutableCopy(request.capabilities),
      candidate: immutableCopy(request.candidate),
      stageEvidence: { store: request.stageEvidence.store },
      checkpoint: request.checkpoint
        ? immutableCopy(request.checkpoint)
        : request.checkpoint,
    };
  }
  const candidate = request.candidate;
  const binding = candidate
    ? immutableCopy({
        scopeId: candidate.scope.scopeId,
        initial: candidate.expectedInitial,
      })
    : undefined;
  const evidenceProfile = candidate
    ? 'candidate-stage-evidence-v1'
    : request.stageEvidence
      ? 'stage-evidence-v1'
      : undefined;
  assertEvidenceProfile(evidenceProfile, binding);
  assert(
    request.evidenceProfile === undefined ||
      request.evidenceProfile === evidenceProfile,
    'Runtime evidence profile requires matching candidate options and stageEvidence storage.',
  );
  assert(
    !('candidateBinding' in request),
    'Runtime constructs candidateBinding from candidate options.',
  );
  return { request: { ...request }, binding, evidenceProfile } as const;
}

export async function executeAndPersist(
  request: ExecuteAndPersistRequest,
): Promise<WorkflowReceipt> {
  const captured = captureExecutionRequest(request);
  request = captured.request;
  const { binding, evidenceProfile } = captured;
  const candidate = request.candidate;
  const roots = candidate
    ? await prepareCandidateRoots(
        candidate.scope,
        request.workspaceForStage!,
        candidate.knownWriteRoots,
      )
    : undefined;
  if (roots && request.candidate)
    request = { ...request, workspaceForStage: roots.workspaceForStage };
  const terminal = await request.store.load(request.runId);
  if (
    candidate ||
    terminal?.evidenceProfile === 'candidate-stage-evidence-v1' ||
    terminal?.candidateBinding !== undefined
  ) {
    assert.equal(
      terminal,
      null,
      'Terminal workflow receipt already exists; use the persisted reader or a new run ID.',
    );
  }
  if (request.workspaceManifestStore) {
    assert(
      request.workspaceForStage,
      'Workspace manifest storage requires workspaceForStage.',
    );
  }
  const durable = await request.checkpointStore?.load(request.runId);
  if (candidate) {
    assert(
      durable === null ||
        (durable && typeof durable === 'object' && !Array.isArray(durable)),
      'Invalid durable candidate checkpoint.',
    );
    assert(
      request.checkpoint === undefined ||
        request.checkpoint === null ||
        (typeof request.checkpoint === 'object' &&
          !Array.isArray(request.checkpoint)),
      'Invalid supplied candidate checkpoint.',
    );
  }
  if (
    candidate &&
    request.checkpoint !== undefined &&
    request.checkpoint !== null
  )
    assert.deepEqual(
      durable,
      request.checkpoint,
      'Supplied candidate checkpoint differs from durable checkpoint.',
    );
  const checkpoint = structuredClone(durable ?? request.checkpoint ?? null);
  let current = binding?.initial;
  if (checkpoint) {
    assertEvidenceProfile(
      checkpoint.evidenceProfile,
      checkpoint.candidateBinding,
    );
    assert.equal(
      checkpoint.evidenceProfile,
      evidenceProfile,
      'Checkpoint evidence profile mismatch.',
    );
    if (binding) {
      current = await verifyCandidateEvidenceRecord(
        checkpoint,
        request.runId,
        request.revision,
        request.stageEvidence!.store,
        false,
        binding,
      );
    } else if (request.stageEvidence)
      await verifyStageEvidenceRecord(
        checkpoint,
        request.runId,
        request.revision,
        request.stageEvidence.store,
        false,
      );
  }
  await verifyCheckpointWorkspaceManifests(request, checkpoint);
  const observeCurrent = async (
    expected: CandidateIdentity,
  ): Promise<CandidateIdentity> => {
    assert(candidate && roots);
    await roots.recheck();
    const observed = await observeCandidate(candidate.scope);
    assert.deepEqual(
      observed,
      expected,
      'Candidate identity changed from acknowledged observation.',
    );
    await roots.recheck();
    return observed;
  };
  if (current) {
    await observeCurrent(current);
    const nextStage = DEFAULT_STAGES[checkpoint?.stages.length ?? 0];
    if (nextStage)
      assert.equal(
        await request.workspaceManifestStore!.load(request.runId, nextStage),
        null,
        'Unacknowledged stage has an orphan workspace manifest; a new run or explicit recovery is required.',
      );
  }
  const receipt = await runPlanWithReceipt({
    ...request,
    ...(evidenceProfile ? { evidenceProfile } : {}),
    ...(binding ? { candidateBinding: binding } : {}),
    checkpoint,
    onInitialCheckpoint: binding
      ? async (initial) => {
          await saveCandidateCheckpoint(request.checkpointStore!, initial);
          await observeCurrent(binding.initial);
        }
      : undefined,
    handler: async (stage, plan): Promise<StageReceiptResult> => {
      const before = current ? await observeCurrent(current) : undefined;
      if (candidate)
        assert.equal(
          await request.workspaceManifestStore!.load(request.runId, stage),
          null,
          'Unacknowledged stage has an orphan workspace manifest; a new run or explicit recovery is required.',
        );
      const result = structuredClone(await request.handler(stage, plan));
      const after = candidate
        ? await observeCandidate(candidate.scope)
        : undefined;
      if (before && stage !== 'build')
        assert.deepEqual(
          after,
          before,
          'Only build may change candidate identity.',
        );
      await roots?.recheck();
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
            binding && before && after ? { binding, before, after } : undefined,
          ),
        };
      }
      return bound;
    },
    onStageCheckpoint: async (nextCheckpoint) => {
      if (binding) {
        const acknowledged = await verifyCandidateEvidenceRecord(
          nextCheckpoint,
          request.runId,
          request.revision,
          request.stageEvidence!.store,
          false,
          binding,
        );
        await verifyCheckpointWorkspaceManifests(request, nextCheckpoint);
        await observeCurrent(acknowledged);
        await saveCandidateCheckpoint(request.checkpointStore!, nextCheckpoint);
        await observeCurrent(acknowledged);
        current = acknowledged;
        await request.onStageCheckpoint?.(structuredClone(nextCheckpoint));
      } else {
        await request.checkpointStore?.save(nextCheckpoint);
        await request.onStageCheckpoint?.(nextCheckpoint);
      }
    },
  });
  if (request.stageEvidence && receipt.status === 'PASS') {
    if (binding) {
      const final = await verifyCandidateEvidenceRecord(
        receipt,
        request.runId,
        request.revision,
        request.stageEvidence.store,
        true,
        binding,
      );
      await verifyCheckpointWorkspaceManifests(request, receipt);
      await observeCurrent(final);
    } else
      await verifyStageEvidenceRecord(
        receipt,
        request.runId,
        request.revision,
        request.stageEvidence.store,
        true,
      );
  }
  if (binding) {
    const expected = immutableCopy(receipt);
    await request.store.save(structuredClone(expected));
    assert.deepEqual(
      await request.store.load(request.runId),
      expected,
      'Candidate receipt readback changed.',
    );
  } else await request.store.save(receipt);
  return receipt;
}

export interface CandidateCloseoutRequest {
  readonly runId: string;
  readonly revision: string;
  readonly store: WorkflowReceiptStore;
  readonly evidenceStore: EvidenceStore;
  readonly workspaceManifestStore: WorkspaceManifestStore;
  readonly workspaceForStage: (stage: WorkflowStageId) => StageWorkspaceBinding;
  readonly scope: LocalCandidateScope;
  readonly knownWriteRoots: readonly string[];
  readonly expectedCurrent: CandidateIdentity;
}

export interface VerifiedCandidateCloseout {
  readonly status: 'candidate-verified';
  readonly scope: 'local-regular-file-candidate-only';
  readonly runId: string;
  readonly revision: string;
  readonly initial: CandidateIdentity;
  readonly current: CandidateIdentity;
}

export async function verifyCandidateCloseout(
  request: CandidateCloseoutRequest,
): Promise<VerifiedCandidateCloseout> {
  assert(
    request.store &&
      request.evidenceStore &&
      request.workspaceManifestStore &&
      typeof request.workspaceForStage === 'function',
    'Candidate verification requires receipt, evidence, manifest stores and stage bindings.',
  );
  const selected = {
    ...request,
    scope: immutableCopy(request.scope),
    knownWriteRoots: immutableCopy(request.knownWriteRoots),
    expectedCurrent: immutableCopy(request.expectedCurrent),
  };
  assertRunId(selected.runId);
  assert(
    typeof selected.revision === 'string' &&
      selected.revision.length > 0 &&
      selected.revision.length <= 512,
    'Invalid candidate revision.',
  );
  assertCandidateIdentity(selected.expectedCurrent);
  const roots = await prepareCandidateRoots(
    selected.scope,
    selected.workspaceForStage,
    selected.knownWriteRoots,
  );
  const receipt = structuredClone(await selected.store.load(selected.runId));
  assert(receipt, 'Persisted workflow receipt is missing.');
  assertCandidateBinding(receipt.candidateBinding);
  const binding: CandidateBinding = immutableCopy(receipt.candidateBinding);
  assert.equal(
    binding.scopeId,
    selected.scope.scopeId,
    'Candidate scope ID mismatch.',
  );
  const current = await verifyCandidateEvidenceRecord(
    receipt,
    selected.runId,
    selected.revision,
    selected.evidenceStore,
    true,
    binding,
  );
  assert.deepEqual(
    current,
    selected.expectedCurrent,
    'Candidate differs from independently expected current identity.',
  );
  await verifyCheckpointWorkspaceManifests(
    { ...selected, workspaceForStage: roots.workspaceForStage },
    receipt,
  );
  await roots.recheck();
  assert.deepEqual(
    await observeCandidate(selected.scope),
    current,
    'Candidate identity changed after verification.',
  );
  await roots.recheck();
  return {
    status: 'candidate-verified',
    scope: 'local-regular-file-candidate-only',
    runId: selected.runId,
    revision: selected.revision,
    initial: { ...binding.initial },
    current: { ...current },
  };
}

type WithoutPlan<T> = T extends unknown ? Omit<T, 'plan'> : never;
export type ExecuteRequestPlanAndPersistRequest =
  WithoutPlan<ExecuteAndPersistRequest> & {
    /** The coordinator has already classified this request and reconciled its plan. */
    readonly requestPlan: TemariRequestPlan;
  };

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

export type ExecuteScheduledAndPersistRequest = ExecuteAndPersistRequest & {
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
};

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
  request = {
    ...captureExecutionRequest(request).request,
    leaseRenewal: request.leaseRenewal
      ? immutableCopy(request.leaseRenewal)
      : undefined,
    cancellation: request.cancellation
      ? immutableCopy(request.cancellation)
      : undefined,
  };
  const roots = request.candidate
    ? await prepareCandidateRoots(
        request.candidate.scope,
        request.workspaceForStage,
        request.candidate.knownWriteRoots,
      )
    : undefined;
  if (roots && request.candidate)
    request = { ...request, workspaceForStage: roots.workspaceForStage };
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
    await roots?.recheck();
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
