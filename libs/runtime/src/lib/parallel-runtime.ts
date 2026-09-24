import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  link,
  mkdir,
  open,
  readFile,
  realpath,
  unlink,
} from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import {
  assertWorkerResult,
  missingCapabilities,
  type ExecutionPlan,
  type HostCapabilityReport,
  type WorkerAssignment,
  type WorkerResult,
} from '@temari/contracts';
import {
  joinParallelWorkers,
  preflightParallelWorkers,
  type ParallelWorkerFailure,
  type ParallelWorkerReceipt,
} from '@temari/workflow-engine';
import type {
  ChildTaskGroupRecord,
  ChildTaskRecord,
  ChildTaskStatus,
  ChildTaskStore,
} from './child-task-store.js';
import type { WorkspaceManifestStore } from './workspace-manifest.js';

export interface ParallelWorkerReceiptStore {
  save(
    receipt: ParallelWorkerReceipt,
    binding: ParallelWorkerReceiptBinding,
  ): Promise<string>;
  load(runId: string): Promise<ParallelWorkerReceiptRecord | null>;
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
  readonly handler: (
    assignment: WorkerAssignment,
  ) => Promise<WorkerResult> | WorkerResult;
  readonly now?: () => Date;
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

function assertMaxAttempts(value: number): void {
  assert(
    Number.isInteger(value) && value > 0,
    'Retry policy maxAttempts must be a positive integer.',
  );
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
  return error instanceof Error ? error.message : String(error);
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
    outcomes: [],
    failure,
  };
}

function pendingForRecord(
  record: ChildTaskRecord,
  assignmentId: string,
  leaseLost: boolean,
): RestartableParallelPendingTask | null {
  if (record.status === 'QUEUED') {
    return { taskId: record.taskId, assignmentId, reason: 'queued' };
  }
  if (record.status === 'RUNNING') {
    return {
      taskId: record.taskId,
      assignmentId,
      reason: leaseLost ? 'lease-lost' : 'active-lease',
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
  request: ExecuteRestartableParallelWorkersRequest,
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
      const assignment = assignmentByTaskId.get(record.taskId);
      assert(assignment);
      await verifyWorkspaceManifest(request, assignment, record);
    }),
  );
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
  let result: WorkerResult;
  try {
    result = await request.handler(claimed.assignment);
    assertWorkerResult(result);
    const workspaceManifestSaved = await persistWorkspaceManifest(
      request,
      claimed.assignment,
      claimed.record.taskId,
      now,
    );
    if (workspaceManifestSaved) {
      result = {
        ...result,
        workspaceManifestId: claimed.record.taskId,
      };
    }
  } catch (error) {
    try {
      await persistWorkspaceManifest(
        request,
        claimed.assignment,
        claimed.record.taskId,
        now,
      );
    } catch (manifestError) {
      error = new Error(
        `${errorMessage(error)}; workspace manifest failed: ${errorMessage(manifestError)}`,
      );
    }
    try {
      await request.childStore.complete({
        taskId: claimed.record.taskId,
        owner: request.owner,
        leaseToken: lease.token,
        fencingEpoch: lease.fencingEpoch,
        status: 'FAILED',
        idempotencyKey,
        result: null,
        error: errorMessage(error),
        now: now(),
      });
      return false;
    } catch (completionError) {
      if (isLeaseLoss(completionError)) return true;
      throw completionError;
    }
  }
  try {
    await request.childStore.complete({
      taskId: claimed.record.taskId,
      owner: request.owner,
      leaseToken: lease.token,
      fencingEpoch: lease.fencingEpoch,
      status: workerStatus(result.status),
      idempotencyKey,
      result,
      error: null,
      now: now(),
    });
    return false;
  } catch (completionError) {
    if (isLeaseLoss(completionError)) return true;
    throw completionError;
  }
}

export async function executeRestartableParallelWorkers(
  request: ExecuteRestartableParallelWorkersRequest,
): Promise<RestartableParallelWorkersResult> {
  assertRunId(request.runId);
  assertText(request.revision, 'Revision');
  assertText(request.owner, 'Owner');
  assertLeaseMs(request.leaseMs);
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
    const receipt = blockedReceipt(request, failure, maxConcurrency, now);
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
    const reservation = await request.childStore.claimGroup({
      groupId: identity.groupId,
      runId: request.runId,
      revision: request.revision,
      taskIds: identity.taskIds,
      maxConcurrency,
      owner: request.owner,
      leaseMs: request.leaseMs,
      now: now(),
    });
    const claimed = reservation.claimed.map((record) => {
      const assignment = assignmentByTaskId.get(record.taskId);
      assert(assignment);
      return { assignment, record };
    });
    peakConcurrency = Math.max(peakConcurrency, claimed.length);

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
      await verifyWorkspaceManifest(request, assignment, record);
      finalTasks.push(record);
      const pendingTask = pendingForRecord(
        record,
        assignment.id,
        leaseLost.has(taskId),
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
      outcomes: joined.outcomes,
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
