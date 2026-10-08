import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  link,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  unlink,
} from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import {
  assertWorkerResult,
  missingCapabilities,
  type ExecutionPlan,
  type EvidenceKind,
  type HostCapabilityReport,
  type WorkerAssignment,
  type WorkerEvidenceReference,
  type WorkerResult,
} from '@temari/contracts';
import {
  joinParallelWorkers,
  preflightParallelWorkers,
  type ParallelWorkerFailure,
  type ParallelWorkerReceipt,
} from '@temari/workflow-engine';
import {
  MAX_CHILD_TASK_ERROR_LENGTH,
  childFailureDiagnosticsFromEvent,
  type ChildFailureDiagnostics,
  type ChildTaskGroupRecord,
  type ChildTaskRecord,
  type ChildTaskStatus,
  type ChildTaskStore,
} from './child-task-store.js';
import {
  putStreamedEvidence,
  verifyPortableEvidence,
  type EvidenceBytes,
  type EvidenceReference,
  type EvidenceStore,
} from './evidence-store.js';
import type { WorkspaceManifestStore } from './workspace-manifest.js';

export interface ParallelWorkerReceiptStore {
  save(
    receipt: ParallelWorkerReceipt,
    binding: ParallelWorkerReceiptBinding,
  ): Promise<string>;
  load(runId: string): Promise<ParallelWorkerReceiptRecord | null>;
  /** Retain the highest observed reservation across invocations/restarts.
   * Stores without this optional port report this invocation's peak only. */
  observeConcurrency?(
    runId: string,
    binding: ParallelWorkerReceiptBinding,
    concurrency: number,
  ): Promise<number>;
}

export interface ParallelWorkerReceiptBinding {
  readonly groupId: string;
  readonly fingerprint: string;
}

export interface ParallelWorkerReceiptRecord {
  readonly receipt: ParallelWorkerReceipt;
  readonly binding: ParallelWorkerReceiptBinding;
}

interface StoredParallelReceipt {
  readonly schema: 1;
  readonly sha256: string;
  readonly groupId: string;
  readonly fingerprint: string;
  readonly receipt: ParallelWorkerReceipt;
}

export type RestartableParallelState = 'RUNNING' | 'COMPLETE' | 'BLOCKED';

export type RestartableParallelPendingReason =
  'missing' | 'queued' | 'active-lease' | 'lease-lost' | 'cancellation-gated';

export interface RestartableParallelPendingTask {
  readonly taskId: string;
  readonly assignmentId: string;
  readonly reason: RestartableParallelPendingReason;
}

export interface RestartableParallelWorkersResult {
  readonly state: RestartableParallelState;
  readonly group: ChildTaskGroupRecord | null;
  readonly tasks: readonly ChildTaskRecord[];
  readonly pending: readonly RestartableParallelPendingTask[];
  readonly receipt: ParallelWorkerReceipt | null;
}

export interface ExecuteRestartableParallelWorkersRequest {
  readonly runId: string;
  readonly revision: string;
  readonly plan: ExecutionPlan;
  readonly capabilities: HostCapabilityReport;
  readonly assignments: readonly WorkerAssignment[];
  readonly childStore: ChildTaskStore;
  readonly receiptStore: ParallelWorkerReceiptStore;
  readonly owner: string;
  readonly leaseMs: number;
  /** Renew child leases while their handlers and evidence work are running. */
  readonly leaseRenewal?: {
    readonly intervalMs: number;
  };
  readonly evidenceStore?: EvidenceStore;
  readonly evidenceForAssignment?: (
    assignment: WorkerAssignment,
    result: WorkerResult,
  ) => readonly WorkerEvidenceInput[] | Promise<readonly WorkerEvidenceInput[]>;
  readonly evidenceForFailure?: (
    assignment: WorkerAssignment,
    error: unknown,
  ) => readonly WorkerEvidenceInput[] | Promise<readonly WorkerEvidenceInput[]>;
  readonly failureDiagnostics?: { readonly mode: 'required' };
  readonly workspaceManifestStore?: WorkspaceManifestStore;
  readonly workspaceForAssignment?: (
    assignment: WorkerAssignment,
  ) => WorkspaceBinding | null | undefined;
  readonly cancellation?: {
    /** Assignment IDs whose queued or expired work should be durably cancelled. */
    readonly assignmentIds: readonly string[];
  };
  readonly retryPolicy?: {
    /** Total mechanical handler attempts allowed for one child, including the first. */
    readonly maxAttempts: number;
  };
  readonly maxConcurrency?: number;
  readonly signal?: AbortSignal;
  readonly handler: (
    assignment: WorkerAssignment,
    context: { readonly signal: AbortSignal; readonly child: ChildTaskRecord },
  ) => Promise<WorkerResult> | WorkerResult;
  readonly now?: () => Date;
}

export type WorkerEvidenceInput =
  | {
      readonly source?: 'buffer';
      readonly kind: EvidenceKind;
      readonly content: string | Uint8Array;
    }
  | {
      readonly source: 'stream';
      readonly kind: EvidenceKind;
      readonly content: EvidenceBytes;
    };

/** Adapter-owned sources and capture completeness; never infer paths from prose. */
export class WorkerExecutionFailure extends Error {
  constructor(
    message: string,
    readonly diagnostics: {
      readonly complete: boolean;
      readonly evidence: readonly WorkerEvidenceInput[];
      readonly reason?: string;
    },
  ) {
    super(message);
    this.name = 'WorkerExecutionFailure';
  }
}

export interface WorkspaceBinding {
  readonly workspaceId: string;
  readonly root: string;
}

interface TaskIdentity {
  readonly groupId: string;
  readonly fingerprint: string;
  readonly taskIds: readonly string[];
}

interface ClaimedTask {
  readonly assignment: WorkerAssignment;
  readonly record: ChildTaskRecord;
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
  return JSON.stringify(value) ?? 'undefined';
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function assertRunId(runId: string): void {
  assert(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId),
    'Run ID must be a safe filename component.',
  );
}

function assertText(value: string, label: string): void {
  assert(value.trim().length > 0, `${label} is required.`);
}

function assertLeaseMs(value: number): void {
  assert(
    Number.isInteger(value) && value > 0,
    'Lease duration must be positive.',
  );
}

function assertLeaseRenewalInterval(value: number): void {
  assert(
    Number.isInteger(value) && value > 0,
    'Lease renewal interval must be a positive integer.',
  );
}

function assertMaxAttempts(value: number): void {
  assert(
    Number.isInteger(value) && value > 0,
    'Retry policy maxAttempts must be a positive integer.',
  );
}

function assertParallelExecutionEvidence(receipt: ParallelWorkerReceipt): void {
  const evidence = receipt.executionEvidence;
  if (evidence === undefined) return;
  assert.equal(evidence.schema, 1);
  assert(evidence.groupId === null || typeof evidence.groupId === 'string');
  if (evidence.groupId !== null)
    assertText(evidence.groupId, 'Evidence group ID');
  assert(Array.isArray(evidence.assignmentIds));
  const assignmentIds = new Set<string>();
  for (const assignmentId of evidence.assignmentIds) {
    assertText(assignmentId, 'Evidence assignment ID');
    assert(
      !assignmentIds.has(assignmentId),
      'Evidence assignment IDs are duplicated.',
    );
    assignmentIds.add(assignmentId);
  }
  assert(Number.isInteger(evidence.maxConcurrency));
  assert(evidence.maxConcurrency >= 0);
  assert(Number.isInteger(evidence.peakConcurrency));
  assert(evidence.peakConcurrency >= 0);
  assert.equal(evidence.maxConcurrency, receipt.maxConcurrency);
  assert.equal(evidence.peakConcurrency, receipt.peakConcurrency);
}

function receiptBody(receipt: ParallelWorkerReceipt): string {
  return canonical(receipt);
}

function storedBody(
  receipt: ParallelWorkerReceipt,
  binding: ParallelWorkerReceiptBinding,
): string {
  const body = receiptBody(receipt);
  const stored: StoredParallelReceipt = {
    schema: 1,
    sha256: digest(body),
    groupId: binding.groupId,
    fingerprint: binding.fingerprint,
    receipt,
  };
  return canonical(stored);
}

function parseStored(value: unknown): ParallelWorkerReceiptRecord {
  assert(
    value && typeof value === 'object',
    'Stored parallel receipt is invalid.',
  );
  const stored = value as Partial<StoredParallelReceipt>;
  assert.equal(stored.schema, 1);
  assert(typeof stored.sha256 === 'string');
  assert(typeof stored.groupId === 'string');
  assert(typeof stored.fingerprint === 'string');
  assert(stored.receipt && typeof stored.receipt === 'object');
  assert.equal(stored.sha256, digest(receiptBody(stored.receipt)));
  assert.equal(stored.receipt.schema, 1);
  assert(typeof stored.receipt.runId === 'string');
  assert(typeof stored.receipt.revision === 'string');
  assertParallelExecutionEvidence(stored.receipt);
  return {
    receipt: stored.receipt,
    binding: {
      groupId: stored.groupId,
      fingerprint: stored.fingerprint,
    },
  };
}

export class FileParallelWorkerReceiptStore implements ParallelWorkerReceiptStore {
  private constructor(private readonly root: string) {}

  static async create(root: string): Promise<FileParallelWorkerReceiptStore> {
    assert(isAbsolute(root), 'Receipt store root must be absolute.');
    await mkdir(root, { recursive: true, mode: 0o700 });
    return new FileParallelWorkerReceiptStore(await realpath(root));
  }

  async save(
    receipt: ParallelWorkerReceipt,
    binding: ParallelWorkerReceiptBinding,
  ): Promise<string> {
    assertParallelExecutionEvidence(receipt);
    assertRunId(receipt.runId);
    assertText(receipt.revision, 'Receipt revision');
    const path = join(this.root, `${receipt.runId}.parallel.receipt.json`);
    const body = storedBody(receipt, binding);
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
        const existing = parseStored(JSON.parse(await readFile(path, 'utf8')));
        assert.equal(existing.receipt.runId, receipt.runId);
        assert.equal(existing.receipt.revision, receipt.revision);
        assert.deepEqual(existing.binding, binding);
      }
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    return path;
  }

  async load(runId: string): Promise<ParallelWorkerReceiptRecord | null> {
    assertRunId(runId);
    try {
      const record = parseStored(
        JSON.parse(
          await readFile(
            join(this.root, `${runId}.parallel.receipt.json`),
            'utf8',
          ),
        ),
      );
      assert.equal(record.receipt.runId, runId);
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async observeConcurrency(
    runId: string,
    binding: ParallelWorkerReceiptBinding,
    concurrency: number,
  ): Promise<number> {
    assertRunId(runId);
    assert(Number.isSafeInteger(concurrency) && concurrency >= 0);
    const prefix = `${runId}.parallel.peak.`;
    if (concurrency > 0) {
      const path = join(this.root, `${prefix}${concurrency}.json`);
      const content = canonical({ schema: 1, runId, binding, concurrency });
      const temporary = join(this.root, `.${runId}.${randomUUID()}.tmp`);
      const file = await open(temporary, 'wx', 0o600);
      try {
        try {
          await file.writeFile(content);
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
            content,
            'Parallel concurrency observation binding changed.',
          );
        }
        const directory = await open(this.root, 'r');
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
    }
    let peak = 0;
    for (const name of await readdir(this.root)) {
      if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
      const count = Number(name.slice(prefix.length, -'.json'.length));
      assert(
        Number.isSafeInteger(count) && count > 0,
        'Invalid concurrency observation.',
      );
      assert.deepEqual(
        JSON.parse(await readFile(join(this.root, name), 'utf8')),
        { schema: 1, runId, binding, concurrency: count },
        'Parallel concurrency observation binding changed.',
      );
      peak = Math.max(peak, count);
    }
    return peak;
  }
}

async function persistReceipt(
  request: ExecuteRestartableParallelWorkersRequest,
  receipt: ParallelWorkerReceipt,
  binding: ParallelWorkerReceiptBinding,
): Promise<ParallelWorkerReceipt> {
  await request.receiptStore.save(receipt, binding);
  const persisted = await request.receiptStore.load(request.runId);
  assert(persisted, 'Parallel receipt disappeared after publication.');
  assert.deepEqual(persisted.binding, binding);
  return persisted.receipt;
}

function taskIdentity(
  runId: string,
  revision: string,
  plan: ExecutionPlan,
  assignments: readonly WorkerAssignment[],
  maxConcurrency: number,
): TaskIdentity {
  const identity = { runId, revision, plan, assignments, maxConcurrency };
  const groupId = `pwg-${digest(identity).slice(0, 48)}`;
  return {
    groupId,
    fingerprint: digest(identity),
    taskIds: assignments.map(
      (assignment, index) =>
        `pwt-${digest({ groupId, index, assignmentId: assignment.id }).slice(0, 48)}`,
    ),
  };
}

function assertReplayExecutionEvidence(
  receipt: ParallelWorkerReceipt,
  identity: TaskIdentity,
  assignments: readonly WorkerAssignment[],
): void {
  const evidence = receipt.executionEvidence;
  assert(
    evidence,
    'Parallel receipt is missing execution evidence; refusing stale replay.',
  );
  assert.deepEqual(
    evidence.assignmentIds,
    assignments.map((assignment) => assignment.id),
    'Parallel receipt execution assignment evidence changed; refusing stale replay.',
  );
  const expectedGroupId =
    receipt.failure?.kind === 'plan-gap' ||
    receipt.failure?.kind === 'capability-gap'
      ? null
      : identity.groupId;
  assert.equal(
    evidence.groupId,
    expectedGroupId,
    'Parallel receipt execution group evidence changed; refusing stale replay.',
  );
}

function cancellationTaskIds(
  assignments: readonly WorkerAssignment[],
  taskIds: readonly string[],
  requested: readonly string[],
): readonly string[] {
  const requestedIds = new Set<string>();
  const taskByAssignment = new Map(
    assignments.map((assignment, index) => [assignment.id, taskIds[index]!]),
  );
  for (const assignmentId of requested) {
    assert(
      !requestedIds.has(assignmentId),
      `Cancellation assignment ID is duplicated: ${assignmentId}.`,
    );
    requestedIds.add(assignmentId);
    assert(
      taskByAssignment.has(assignmentId),
      `Cancellation assignment is not declared: ${assignmentId}.`,
    );
  }
  return requested.map((assignmentId) => {
    const taskId = taskByAssignment.get(assignmentId);
    assert(taskId);
    return taskId;
  });
}

function workerStatus(
  status: WorkerResult['status'],
): Exclude<ChildTaskStatus, 'QUEUED' | 'RUNNING'> {
  switch (status) {
    case 'PASS':
      return 'SUCCEEDED';
    case 'ISSUES':
      return 'ISSUES';
    case 'BLOCKED':
      return 'BLOCKED';
    case 'DROPPED':
      return 'DROPPED';
  }
}

function errorMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return typeof value === 'string' ? value : String(value);
}

function boundedFailureMessage(error: unknown): string {
  let original: string;
  try {
    original = errorMessage(error);
  } catch {
    original = '';
  }
  const message =
    original.trim().length > 0
      ? original
      : 'Worker failed without a diagnostic message.';
  if (message.length <= MAX_CHILD_TASK_ERROR_LENGTH) return message;

  const digest = createHash('sha256').update(message).digest('hex');
  const suffix = `... [truncated; sha256=${digest}]`;
  return `${message.slice(0, MAX_CHILD_TASK_ERROR_LENGTH - suffix.length)}${suffix}`;
}

function isLeaseLoss(error: unknown): boolean {
  return /lease|fencing|owner mismatch|token mismatch|only a running/i.test(
    errorMessage(error),
  );
}

function capabilityFailure(
  plan: ExecutionPlan,
  capabilities: HostCapabilityReport,
): ParallelWorkerFailure | null {
  const declaredConcurrency = plan.parallelism?.maxConcurrency;
  if (declaredConcurrency === undefined) {
    return {
      kind: 'plan-gap',
      message: 'Execution plan does not declare a parallelism policy.',
      workerId: null,
      missingCapabilities: [],
    };
  }
  const missing = missingCapabilities(
    plan.requiredCapabilities,
    capabilities.available,
  );
  if (
    declaredConcurrency > 1 &&
    !capabilities.available.includes('parallelism') &&
    !missing.includes('parallelism')
  ) {
    missing.push('parallelism');
  }
  if (missing.length === 0) return null;
  return {
    kind: 'capability-gap',
    message: `Host is missing required capabilities: ${missing.join(', ')}`,
    workerId: null,
    missingCapabilities: missing,
  };
}

function blockedReceipt(
  request: ExecuteRestartableParallelWorkersRequest,
  failure: ParallelWorkerFailure,
  maxConcurrency: number,
  assignmentIds: readonly string[],
  now: () => Date,
): ParallelWorkerReceipt {
  const startedAt = now().toISOString();
  return {
    schema: 1,
    runId: request.runId,
    revision: request.revision,
    startedAt,
    completedAt: now().toISOString(),
    status: 'BLOCKED',
    maxConcurrency,
    peakConcurrency: 0,
    executionEvidence: {
      schema: 1,
      groupId: null,
      assignmentIds: [...assignmentIds],
      maxConcurrency,
      peakConcurrency: 0,
    },
    outcomes: [],
    degradations: [],
    failure,
  };
}

function pendingForRecord(
  record: ChildTaskRecord,
  assignmentId: string,
  leaseLost: boolean,
  cancellationRequested: boolean,
): RestartableParallelPendingTask | null {
  if (record.status === 'QUEUED') {
    return { taskId: record.taskId, assignmentId, reason: 'queued' };
  }
  if (record.status === 'RUNNING') {
    return {
      taskId: record.taskId,
      assignmentId,
      reason: cancellationRequested
        ? 'cancellation-gated'
        : leaseLost
          ? 'lease-lost'
          : 'active-lease',
    };
  }
  if (record.status === 'CANCELLED') {
    return {
      taskId: record.taskId,
      assignmentId,
      reason: 'cancellation-gated',
    };
  }
  return null;
}

function outcomeForRecord(
  assignment: WorkerAssignment,
  record: ChildTaskRecord,
): {
  readonly assignment: WorkerAssignment;
  readonly result: WorkerResult | null;
  readonly error: string | null;
} {
  if (record.status === 'FAILED') {
    assert(record.error);
    return { assignment, result: null, error: record.error };
  }
  assert(
    record.result,
    `Terminal child ${record.taskId} is missing its result.`,
  );
  return { assignment, result: record.result, error: null };
}

async function ensureGroup(
  request: Pick<
    ExecuteRestartableParallelWorkersRequest,
    'runId' | 'revision' | 'assignments' | 'childStore' | 'owner'
  >,
  identity: TaskIdentity,
  now: () => Date,
): Promise<ChildTaskGroupRecord> {
  const existing = await request.childStore.loadGroup(identity.groupId);
  if (existing) {
    return request.childStore.ensureGroup({
      groupId: identity.groupId,
      runId: request.runId,
      revision: request.revision,
      taskIds: identity.taskIds,
      assignmentIds: request.assignments.map((assignment) => assignment.id),
      now: now(),
    });
  }

  for (const taskId of identity.taskIds) {
    await request.childStore.create({
      taskId,
      runId: request.runId,
      revision: request.revision,
      dependsOn: [],
      actor: request.owner,
      now: now(),
    });
  }
  return request.childStore.ensureGroup({
    groupId: identity.groupId,
    runId: request.runId,
    revision: request.revision,
    taskIds: identity.taskIds,
    assignmentIds: request.assignments.map((assignment) => assignment.id),
    now: now(),
  });
}

function workspaceBinding(
  request: ExecuteRestartableParallelWorkersRequest,
  assignment: WorkerAssignment,
): WorkspaceBinding | null {
  if (!request.workspaceManifestStore) return null;
  const binding = request.workspaceForAssignment?.(assignment);
  assert(
    binding,
    'Workspace manifest storage requires a workspace binding for every assignment.',
  );
  return binding;
}

async function persistWorkspaceManifest(
  request: ExecuteRestartableParallelWorkersRequest,
  assignment: WorkerAssignment,
  taskId: string,
  now: () => Date,
): Promise<string | null> {
  const store = request.workspaceManifestStore;
  if (!store) return null;
  const binding = workspaceBinding(request, assignment);
  assert(binding);
  const manifest = await store.capture({
    runId: request.runId,
    revision: request.revision,
    subjectId: taskId,
    workspaceId: binding.workspaceId,
    workspaceRoot: binding.root,
    now: now(),
  });
  return store.save(manifest);
}

async function verifyWorkspaceManifest(
  request: ExecuteRestartableParallelWorkersRequest,
  assignment: WorkerAssignment,
  record: ChildTaskRecord,
): Promise<void> {
  const store = request.workspaceManifestStore;
  if (!store) return;
  if (record.status === 'QUEUED' || record.status === 'RUNNING') return;
  if (record.status === 'CANCELLED') return;
  const binding = workspaceBinding(request, assignment);
  assert(binding);
  const manifest = await store.load(request.runId, record.taskId);
  assert(
    manifest,
    `Terminal child ${record.taskId} is missing its workspace manifest.`,
  );
  assert.equal(manifest.revision, request.revision);
  assert.equal(manifest.workspaceId, binding.workspaceId);
  await store.verify(manifest, binding.root);
}

async function verifyExpectedWorkspaces(
  request: ExecuteRestartableParallelWorkersRequest,
  records: readonly (ChildTaskRecord | null)[],
  assignmentByTaskId: ReadonlyMap<string, WorkerAssignment>,
): Promise<void> {
  await Promise.all(
    records.map(async (record) => {
      if (!record) return;
      await verifyChildTaskEvidence(request, record);
      const assignment = assignmentByTaskId.get(record.taskId);
      assert(assignment);
      await verifyWorkspaceManifest(request, assignment, record);
    }),
  );
}

function portableEvidenceReference(
  reference: EvidenceReference,
): WorkerEvidenceReference {
  return {
    schema: reference.schema,
    runId: reference.runId,
    revision: reference.revision,
    kind: reference.kind,
    sha256: reference.sha256,
    bytes: reference.bytes,
  };
}

export async function verifyChildTaskEvidence(
  request: Pick<
    ExecuteRestartableParallelWorkersRequest,
    'childStore' | 'evidenceStore' | 'runId' | 'revision'
  >,
  record: ChildTaskRecord,
): Promise<void> {
  const successReferences = record.result?.evidenceReferences ?? [];
  const failureReferences = [...(record.failureDiagnostics?.references ?? [])];
  for (const event of await request.childStore.events(record.taskId)) {
    failureReferences.push(
      ...(childFailureDiagnosticsFromEvent(event)?.references ?? []),
    );
    failureReferences.push(
      ...(childFailureDiagnosticsFromEvent(event, 'requestFailureDiagnostics')
        ?.references ?? []),
    );
  }
  if (successReferences.length === 0 && failureReferences.length === 0) return;
  const store = request.evidenceStore;
  assert(
    store,
    `Child ${record.taskId} has retained evidence but no evidence store was configured.`,
  );
  for (const reference of successReferences) {
    assert.equal(reference.runId, request.runId);
    assert.equal(reference.revision, request.revision);
    await verifyPortableEvidence(store, reference);
  }
  assert(
    failureReferences.length === 0 || store.verifyPortable,
    'Failure diagnostics require streaming verification.',
  );
  const verified = new Set<string>();
  for (const reference of failureReferences) {
    assert.equal(reference.runId, request.runId);
    assert.equal(reference.revision, request.revision);
    const key = canonical(reference);
    if (verified.has(key)) continue;
    await store.verifyPortable!(reference);
    verified.add(key);
  }
}

async function publishEvidenceInput(
  request: ExecuteRestartableParallelWorkersRequest,
  input: WorkerEvidenceInput,
): Promise<WorkerEvidenceReference> {
  const store = request.evidenceStore;
  assert(store, 'Evidence publication requires an evidenceStore.');
  const binding = {
    runId: request.runId,
    revision: request.revision,
    kind: input.kind,
  };
  if (input.source === 'stream') {
    return portableEvidenceReference(
      await putStreamedEvidence(store, { ...binding, content: input.content }),
    );
  }
  const reference = await store.put({ ...binding, content: input.content });
  await verifyPortableEvidence(store, reference);
  return portableEvidenceReference(reference);
}

async function publishWorkerEvidence(
  request: ExecuteRestartableParallelWorkersRequest,
  assignment: WorkerAssignment,
  result: WorkerResult,
): Promise<WorkerResult> {
  if (!request.evidenceForAssignment) return result;
  const inputs = await request.evidenceForAssignment(assignment, result);
  const references: WorkerEvidenceReference[] = [];
  for (const input of inputs)
    references.push(await publishEvidenceInput(request, input));
  if (references.length === 0) return result;
  return {
    ...result,
    evidenceReferences: [...(result.evidenceReferences ?? []), ...references],
  };
}

function fullFailureText(error: unknown): string {
  if (error instanceof Error) {
    let message = '';
    let stack = '';
    try {
      message =
        typeof error.message === 'string'
          ? error.message
          : String(error.message);
    } catch {}
    try {
      stack = typeof error.stack === 'string' ? error.stack : '';
    } catch {}
    if (stack.trim())
      return message.trim() && !stack.includes(message)
        ? `${message}\n${stack}`
        : stack;
    if (message.trim()) return message;
  } else {
    try {
      const text = String(error);
      if (text.trim()) return text;
    } catch {}
  }
  return 'Worker failed without a diagnostic message.';
}

async function* textEvidence(text: string): EvidenceBytes {
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(offset + 16_384, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    yield Buffer.from(text.slice(offset, end), 'utf8');
    offset = end;
  }
}

function privateFailureSummary(error: unknown): string {
  const sha256 = createHash('sha256')
    .update(fullFailureText(error))
    .digest('hex');
  return `sha256=${sha256}`;
}

function failureProjection(
  request: ExecuteRestartableParallelWorkersRequest,
  error: unknown,
  diagnostics: ChildFailureDiagnostics | undefined,
): string {
  if (
    !request.evidenceStore &&
    !request.failureDiagnostics &&
    !request.evidenceForFailure
  )
    return boundedFailureMessage(error);
  if (error instanceof WorkerExecutionFailure) {
    try {
      if (
        typeof error.message === 'string' &&
        error.message.trim() &&
        error.message.length <= MAX_CHILD_TASK_ERROR_LENGTH
      )
        return error.message;
    } catch {}
  }
  const identity = diagnostics?.references[0]?.sha256;
  return `Worker execution failed; diagnostics ${diagnostics?.status === 'retained' ? 'retained' : 'archive failed'}; ${identity ? `sha256=${identity}` : privateFailureSummary(error)}.`;
}

async function retainFailureDiagnostics(
  request: ExecuteRestartableParallelWorkersRequest,
  assignment: WorkerAssignment,
  error: unknown,
): Promise<ChildFailureDiagnostics | undefined> {
  if (
    !request.evidenceStore &&
    !request.failureDiagnostics &&
    !request.evidenceForFailure &&
    !(error instanceof WorkerExecutionFailure)
  )
    return undefined;
  const references: WorkerEvidenceReference[] = [];
  const failures: string[] = [];
  const store = request.evidenceStore;
  if (!store?.putStream || !store.verifyPortable) {
    return {
      schema: 1,
      status: 'archive-failed',
      references,
      message:
        'Complete diagnostics require streaming evidence publication and verification.',
    };
  }
  const archiveProblem = async (
    cause: unknown,
    category: string,
  ): Promise<void> => {
    failures.push(`${category} (${privateFailureSummary(cause)}).`);
    try {
      const reference = await store.putStream!({
        runId: request.runId,
        revision: request.revision,
        kind: 'other',
        content: textEvidence(fullFailureText(cause)),
      });
      const portable = portableEvidenceReference(reference);
      references.push(portable);
      await store.verifyPortable!(portable);
    } catch (secondaryError) {
      failures.push(
        `Secondary diagnostic archive failed (${privateFailureSummary(secondaryError)}).`,
      );
    }
  };
  const archive = async (input: WorkerEvidenceInput) => {
    try {
      const content =
        input.source === 'stream'
          ? input.content
          : textOrBytesEvidence(input.content);
      const reference = await store.putStream!({
        runId: request.runId,
        revision: request.revision,
        kind: input.kind,
        content,
      });
      const portable = portableEvidenceReference(reference);
      references.push(portable);
      await store.verifyPortable!(portable);
    } catch (archiveError) {
      await archiveProblem(archiveError, 'Diagnostic archive failed');
    }
  };
  await archive({
    source: 'stream',
    kind: 'stderr',
    content: textEvidence(fullFailureText(error)),
  });
  if (error instanceof WorkerExecutionFailure) {
    if (!error.diagnostics.complete)
      failures.push(
        error.diagnostics.reason &&
          error.diagnostics.reason.length <= MAX_CHILD_TASK_ERROR_LENGTH
          ? error.diagnostics.reason
          : 'Worker diagnostic capture was incomplete.',
      );
    for (const input of error.diagnostics.evidence) await archive(input);
  }
  if (request.evidenceForFailure) {
    try {
      for (const input of await request.evidenceForFailure(assignment, error))
        await archive(input);
    } catch (sourceError) {
      await archiveProblem(sourceError, 'Diagnostic source discovery failed');
    }
  }
  if (failures.length > 0)
    return {
      schema: 1,
      status: 'archive-failed',
      references,
      message: boundedFailureMessage(failures.join('; ')),
    };
  assert(references.length > 0, 'Retained diagnostics require evidence.');
  return {
    schema: 1,
    status: 'retained',
    references: references as [
      WorkerEvidenceReference,
      ...WorkerEvidenceReference[],
    ],
  };
}

async function* textOrBytesEvidence(
  content: string | Uint8Array,
): EvidenceBytes {
  if (typeof content === 'string') yield* textEvidence(content);
  else
    for (let offset = 0; offset < content.byteLength; offset += 64 * 1024)
      yield content.subarray(offset, offset + 64 * 1024);
}

async function reconcileExpectedTasks(
  request: ExecuteRestartableParallelWorkersRequest,
  identity: TaskIdentity,
): Promise<readonly (ChildTaskRecord | null)[]> {
  return Promise.all(
    identity.taskIds.map((taskId) => request.childStore.reconcile(taskId)),
  );
}

async function executeClaimed(
  request: ExecuteRestartableParallelWorkersRequest,
  claimed: ClaimedTask,
  now: () => Date,
): Promise<boolean> {
  const lease = claimed.record.lease;
  assert(lease);
  const idempotencyKey = `complete:${claimed.record.taskId}:${claimed.record.attempt}:${lease.fencingEpoch}`;
  const controller = new AbortController();
  let cancellation: Promise<unknown> | undefined;
  const abort = (): void => {
    controller.abort();
    if (renewalTimer) clearInterval(renewalTimer);
    cancellation ??= request.childStore.cancel({
      taskId: claimed.record.taskId,
      actor: request.owner,
      idempotencyKey: `signal-cancel:${claimed.record.taskId}:${claimed.record.attempt}`,
    });
  };
  let renewalError: unknown = null;
  let renewalSequence = 0;
  let renewalInFlight: Promise<void> | null = null;
  let renewalTimer: ReturnType<typeof setInterval> | null = null;
  const renew = async (): Promise<void> => {
    if (renewalError) return;
    try {
      await request.childStore.renew({
        taskId: claimed.record.taskId,
        owner: request.owner,
        leaseToken: lease.token,
        fencingEpoch: lease.fencingEpoch,
        leaseMs: request.leaseMs,
        idempotencyKey: `renew:${claimed.record.taskId}:${claimed.record.attempt}:${lease.fencingEpoch}:${++renewalSequence}`,
        now: now(),
      });
    } catch (error) {
      renewalError = error;
      controller.abort(error);
      if (renewalTimer) clearInterval(renewalTimer);
    }
  };
  const stopRenewal = async (): Promise<void> => {
    if (renewalTimer) clearInterval(renewalTimer);
    if (renewalInFlight) await renewalInFlight;
    renewalTimer = null;
    renewalInFlight = null;
    if (cancellation) await cancellation;
  };
  const renewalIntervalMs = request.leaseRenewal?.intervalMs;
  if (renewalIntervalMs !== undefined) {
    renewalTimer = setInterval(() => {
      if (renewalInFlight) return;
      renewalInFlight = renew().finally(() => {
        renewalInFlight = null;
      });
    }, renewalIntervalMs);
  }
  request.signal?.addEventListener('abort', abort, { once: true });
  if (request.signal?.aborted) abort();
  try {
  let result: WorkerResult | null = null;
  let failure: unknown = null;
  let failed = false;
  let failureDiagnostics: ChildFailureDiagnostics | undefined;
  try {
    assert(!controller.signal.aborted, 'Worker authority cancelled before dispatch.');
    result = await request.handler(claimed.assignment, { signal: controller.signal, child: claimed.record });
    assert(!controller.signal.aborted, 'Late worker result after authority loss.');
    assertWorkerResult(result);
    result = await publishWorkerEvidence(request, claimed.assignment, result);
    const saved = await persistWorkspaceManifest(
      request,
      claimed.assignment,
      claimed.record.taskId,
      now,
    );
    if (saved)
      result = { ...result, workspaceManifestId: claimed.record.taskId };
    await stopRenewal();
    assert(!controller.signal.aborted && !request.signal?.aborted, 'Late result after worker cancellation.');
  } catch (error) {
    failed = true;
    failure = error;
    try {
      failureDiagnostics = await retainFailureDiagnostics(
        request,
        claimed.assignment,
        error,
      );
      try {
        await persistWorkspaceManifest(
          request,
          claimed.assignment,
          claimed.record.taskId,
          now,
        );
      } catch (manifestError) {
        if (failureDiagnostics) {
          const references = [...failureDiagnostics.references];
          let secondaryIssue = '';
          try {
            references.push(
              await publishEvidenceInput(request, {
                source: 'stream',
                kind: 'other',
                content: textEvidence(fullFailureText(manifestError)),
              }),
            );
          } catch (archiveError) {
            secondaryIssue = `; Secondary diagnostic archive failed (${privateFailureSummary(archiveError)})`;
          }
          failureDiagnostics = {
            schema: 1,
            status: 'archive-failed',
            references,
            message: boundedFailureMessage(
              `${failureDiagnostics.status === 'archive-failed' ? failureDiagnostics.message + '; ' : ''}Workspace manifest failed (${privateFailureSummary(manifestError)})${secondaryIssue}`,
            ),
          };
        } else
          failure = new Error(
            `${boundedFailureMessage(error)}; workspace manifest failed: ${boundedFailureMessage(manifestError)}`,
          );
      }
    } finally {
      await stopRenewal();
    }
  } finally {
    await stopRenewal();
  }
  if (
    renewalError &&
    !(await request.childStore.cancellationRequested(claimed.record.taskId))
  ) {
    const { evidenceForFailure: _failureSources, ...renewalRequest } = request;
    const renewalDiagnostics = await retainFailureDiagnostics(
      renewalRequest,
      claimed.assignment,
      renewalError,
    );
    if (failureDiagnostics && renewalDiagnostics) {
      const references = [
        ...failureDiagnostics.references,
        ...renewalDiagnostics.references,
      ];
      const issues = [failureDiagnostics, renewalDiagnostics]
        .filter((item) => item.status === 'archive-failed')
        .map((item) => (item.status === 'archive-failed' ? item.message : ''));
      failureDiagnostics =
        issues.length > 0
          ? {
              schema: 1,
              status: 'archive-failed',
              references,
              message: boundedFailureMessage(issues.join('; ')),
            }
          : {
              schema: 1,
              status: 'retained',
              references: references as [
                WorkerEvidenceReference,
                ...WorkerEvidenceReference[],
              ],
            };
    } else failureDiagnostics = renewalDiagnostics;
    failure = failed
      ? new Error(
          `${boundedFailureMessage(failure)}; lease renewal failed: ${boundedFailureMessage(renewalError)}`,
        )
      : renewalError;
    failed = true;
  }
  try {
    assert(failed || result, 'Successful child result is missing.');
    await request.childStore.complete({
      taskId: claimed.record.taskId,
      owner: request.owner,
      leaseToken: lease.token,
      fencingEpoch: lease.fencingEpoch,
      status: failed ? 'FAILED' : workerStatus(result!.status),
      idempotencyKey,
      result: failed ? null : result,
      error: failed
        ? failureProjection(request, failure, failureDiagnostics)
        : null,
      ...(failureDiagnostics === undefined ? {} : { failureDiagnostics }),
      now: now(),
    });
    return false;
  } catch (completionError) {
    if (isLeaseLoss(completionError)) return true;
    throw completionError;
  }
  } finally {
    request.signal?.removeEventListener('abort', abort);
    if (cancellation) await cancellation;
  }
}

/** Publish the runtime's immutable child identities before a host binds them to
 * a parent task. Preparation never claims a lease or invokes a worker. */
export async function prepareRestartableParallelWorkers(
  request: Pick<
    ExecuteRestartableParallelWorkersRequest,
    | 'runId'
    | 'revision'
    | 'plan'
    | 'capabilities'
    | 'assignments'
    | 'childStore'
    | 'owner'
    | 'maxConcurrency'
    | 'now'
  >,
): Promise<{
  readonly group: ChildTaskGroupRecord;
  readonly tasks: readonly ChildTaskRecord[];
}> {
  assertRunId(request.runId);
  assertText(request.revision, 'Revision');
  assertText(request.owner, 'Owner');
  const failure = capabilityFailure(request.plan, request.capabilities);
  assert(!failure, failure?.message);
  const declaredConcurrency = request.plan.parallelism?.maxConcurrency ?? 0;
  const maxConcurrency = request.maxConcurrency ?? declaredConcurrency;
  assert(
    Number.isInteger(maxConcurrency) &&
      maxConcurrency > 0 &&
      maxConcurrency <= declaredConcurrency,
    'Parallel worker maxConcurrency must be a positive integer no greater than the plan limit.',
  );
  preflightParallelWorkers(request.assignments);
  const identity = taskIdentity(
    request.runId,
    request.revision,
    request.plan,
    request.assignments,
    maxConcurrency,
  );
  const group = await ensureGroup(
    request,
    identity,
    request.now ?? (() => new Date()),
  );
  const tasks = await Promise.all(
    group.taskIds.map(async (taskId) => {
      const task = await request.childStore.load(taskId);
      assert(task, 'Prepared child task is missing.');
      return task;
    }),
  );
  return { group, tasks };
}

export async function executeRestartableParallelWorkers(
  request: ExecuteRestartableParallelWorkersRequest,
): Promise<RestartableParallelWorkersResult> {
  assertRunId(request.runId);
  assertText(request.revision, 'Revision');
  assertText(request.owner, 'Owner');
  assertLeaseMs(request.leaseMs);
  if (request.failureDiagnostics?.mode === 'required') {
    assert(
      request.evidenceStore?.putStream && request.evidenceStore.verifyPortable,
      'Complete diagnostics require streaming evidence publication and verification before child claim.',
    );
  }
  if (request.leaseRenewal) {
    assertLeaseRenewalInterval(request.leaseRenewal.intervalMs);
  }
  const maxAttempts = request.retryPolicy?.maxAttempts ?? 1;
  assertMaxAttempts(maxAttempts);
  if (request.workspaceManifestStore) {
    assert(
      request.workspaceForAssignment,
      'Workspace manifest storage requires workspaceForAssignment.',
    );
  }
  const now = request.now ?? (() => new Date());
  const declaredConcurrency = request.plan.parallelism?.maxConcurrency ?? 0;
  const maxConcurrency = request.maxConcurrency ?? declaredConcurrency;
  const identity = taskIdentity(
    request.runId,
    request.revision,
    request.plan,
    request.assignments,
    maxConcurrency,
  );
  const replay = await request.receiptStore.load(request.runId);
  if (replay) {
    assert.equal(replay.receipt.revision, request.revision);
    assert.deepEqual(
      replay.binding,
      {
        groupId: identity.groupId,
        fingerprint: identity.fingerprint,
      },
      'Parallel receipt binding changed; refusing stale replay.',
    );
    assertReplayExecutionEvidence(
      replay.receipt,
      identity,
      request.assignments,
    );
    if (
      replay.receipt.failure?.kind === 'plan-gap' ||
      replay.receipt.failure?.kind === 'capability-gap'
    ) {
      return {
        state: 'BLOCKED',
        group: null,
        tasks: [],
        pending: [],
        receipt: replay.receipt,
      };
    }
    const replayGroup = await request.childStore.loadGroup(identity.groupId);
    assert(
      replayGroup,
      'Parallel receipt child group is missing; refusing stale replay.',
    );
    assert.deepEqual(
      replayGroup.taskIds,
      identity.taskIds,
      'Parallel receipt child group membership changed; refusing stale replay.',
    );
    const replayTasks = await reconcileExpectedTasks(request, identity);
    assert(
      replayTasks.every((task): task is ChildTaskRecord => task !== null),
      'Parallel receipt is missing an expected child task; refusing stale replay.',
    );
    const replayAssignments = new Map(
      identity.taskIds.map((taskId, index) => [
        taskId,
        request.assignments[index]!,
      ]),
    );
    await verifyExpectedWorkspaces(request, replayTasks, replayAssignments);
    return {
      state: 'COMPLETE',
      group: replayGroup,
      tasks: replayTasks,
      pending: [],
      receipt: replay.receipt,
    };
  }

  const failure = capabilityFailure(request.plan, request.capabilities);
  if (failure) {
    const receipt = blockedReceipt(
      request,
      failure,
      maxConcurrency,
      request.assignments.map((assignment) => assignment.id),
      now,
    );
    const binding = {
      groupId: identity.groupId,
      fingerprint: identity.fingerprint,
    };
    const persisted = await persistReceipt(request, receipt, binding);
    return {
      state: 'BLOCKED',
      group: null,
      tasks: [],
      pending: [],
      receipt: persisted,
    };
  }
  assert(
    Number.isInteger(maxConcurrency) &&
      maxConcurrency > 0 &&
      maxConcurrency <= declaredConcurrency,
    'Parallel worker maxConcurrency must be a positive integer no greater than the plan limit.',
  );
  preflightParallelWorkers(request.assignments);
  const group = await ensureGroup(request, identity, now);
  const assignmentByTaskId = new Map(
    identity.taskIds.map((taskId, index) => [
      taskId,
      request.assignments[index]!,
    ]),
  );
  const expectedTasks = await reconcileExpectedTasks(request, identity);
  await verifyExpectedWorkspaces(request, expectedTasks, assignmentByTaskId);
  const cancellationIds = cancellationTaskIds(
    request.assignments,
    identity.taskIds,
    request.cancellation?.assignmentIds ?? [],
  );
  await Promise.all(
    cancellationIds.map((taskId) =>
      request.childStore.cancel({
        taskId,
        actor: request.owner,
        idempotencyKey: `cancel:${taskId}`,
        now: now(),
      }),
    ),
  );
  let peakConcurrency = 0;
  while (true) {
    const reservationTime = now();
    const reservation = await request.childStore.claimGroup({
      groupId: identity.groupId,
      runId: request.runId,
      revision: request.revision,
      taskIds: identity.taskIds,
      maxConcurrency,
      owner: request.owner,
      leaseMs: request.leaseMs,
      now: reservationTime,
    });
    const claimed = reservation.claimed.map((record) => {
      const assignment = assignmentByTaskId.get(record.taskId);
      assert(assignment);
      return { assignment, record };
    });
    const activeReservations = reservation.records.filter(
      (record) =>
        record.status === 'RUNNING' &&
        record.lease &&
        Date.parse(record.lease.expiresAt) > reservationTime.getTime(),
    ).length;
    peakConcurrency = Math.max(peakConcurrency, activeReservations);
    if (request.receiptStore.observeConcurrency) {
      peakConcurrency = Math.max(
        peakConcurrency,
        await request.receiptStore.observeConcurrency(
          request.runId,
          { groupId: identity.groupId, fingerprint: identity.fingerprint },
          activeReservations,
        ),
      );
      assert(
        peakConcurrency <= maxConcurrency,
        'Retained concurrency exceeds the plan limit.',
      );
    }

    const leaseLost = new Set<string>();
    await Promise.all(
      claimed.map(async (task) => {
        if (await executeClaimed(request, task, now)) {
          leaseLost.add(task.record.taskId);
        }
      }),
    );

    const finalTasks: ChildTaskRecord[] = [];
    const pending: RestartableParallelPendingTask[] = [];
    const outcomes = [];
    for (const taskId of identity.taskIds) {
      const assignment = assignmentByTaskId.get(taskId);
      assert(assignment);
      const record = await request.childStore.reconcile(taskId);
      if (!record) {
        pending.push({
          taskId,
          assignmentId: assignment.id,
          reason: 'missing',
        });
        continue;
      }
      await verifyChildTaskEvidence(request, record);
      await verifyWorkspaceManifest(request, assignment, record);
      finalTasks.push(record);
      const pendingTask = pendingForRecord(
        record,
        assignment.id,
        leaseLost.has(taskId),
        record.status === 'RUNNING'
          ? await request.childStore.cancellationRequested(taskId)
          : false,
      );
      if (pendingTask) pending.push(pendingTask);
      if (pendingTask) continue;
      outcomes.push(outcomeForRecord(assignment, record));
    }

    if (pending.length > 0) {
      const state = pending.some((item) => item.reason === 'cancellation-gated')
        ? 'BLOCKED'
        : 'RUNNING';
      return {
        state,
        group,
        tasks: finalTasks,
        pending,
        receipt: null,
      };
    }

    const retryable = finalTasks.filter(
      (record) => record.status === 'FAILED' && record.attempt < maxAttempts,
    );
    if (retryable.length > 0) {
      await Promise.all(
        retryable.map((record) =>
          request.childStore.retry({
            taskId: record.taskId,
            actor: request.owner,
            idempotencyKey: `retry:${record.taskId}:${record.attempt}`,
            now: now(),
          }),
        ),
      );
      continue;
    }

    const joined = joinParallelWorkers(request.assignments, outcomes);
    const receipt: ParallelWorkerReceipt = {
      schema: 1,
      runId: request.runId,
      revision: request.revision,
      startedAt: now().toISOString(),
      completedAt: now().toISOString(),
      status: joined.status,
      maxConcurrency,
      peakConcurrency,
      executionEvidence: {
        schema: 1,
        groupId: identity.groupId,
        assignmentIds: request.assignments.map((assignment) => assignment.id),
        maxConcurrency,
        peakConcurrency,
      },
      outcomes: joined.outcomes,
      degradations: joined.degradations,
      failure: joined.failure,
    };
    const binding = {
      groupId: identity.groupId,
      fingerprint: identity.fingerprint,
    };
    const persisted = await persistReceipt(request, receipt, binding);
    return {
      state: 'COMPLETE',
      group,
      tasks: finalTasks,
      pending: [],
      receipt: persisted,
    };
  }
}
