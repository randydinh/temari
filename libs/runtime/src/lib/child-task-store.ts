import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  readdir,
  rename,
  rmdir,
  unlink,
} from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { assertWorkerResult, type WorkerResult } from '@temari/contracts';

export type ChildTaskStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'ISSUES'
  | 'BLOCKED'
  | 'DROPPED'
  | 'FAILED'
  | 'CANCELLED';

export interface ChildTaskLease {
  readonly owner: string;
  readonly token: string;
  readonly fencingEpoch: number;
  readonly acquiredAt: string;
  readonly expiresAt: string;
}

export interface ChildTaskRecord {
  readonly schema: 1;
  readonly taskId: string;
  readonly runId: string;
  readonly revision: string;
  readonly status: ChildTaskStatus;
  readonly attempt: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly dependsOn: readonly string[];
  readonly lease: ChildTaskLease | null;
  readonly result: WorkerResult | null;
  readonly error: string | null;
}

export interface ChildTaskGroupRecord {
  readonly schema: 1;
  readonly groupId: string;
  readonly runId: string;
  readonly revision: string;
  readonly taskIds: readonly string[];
  readonly assignmentIds: readonly string[];
  readonly createdAt: string;
}

export type ChildTaskEventPayload = Readonly<
  Record<string, string | number | boolean | null>
>;

export type ChildTaskEventType =
  'task-created' | 'task-claimed' | 'task-completed' | 'task-retried';

export interface ChildTaskEvent {
  readonly schema: 1;
  readonly sequence: number;
  readonly taskId: string;
  readonly runId: string;
  readonly revision: string;
  readonly type: ChildTaskEventType;
  readonly idempotencyKey: string;
  readonly actor: string;
  readonly at: string;
  readonly payload: ChildTaskEventPayload;
}

export interface CreateChildTaskRequest {
  readonly taskId: string;
  readonly runId: string;
  readonly revision: string;
  readonly dependsOn: readonly string[];
  readonly actor: string;
  readonly now?: Date;
}

export interface EnsureChildTaskGroupRequest {
  readonly groupId: string;
  readonly runId: string;
  readonly revision: string;
  readonly taskIds: readonly string[];
  readonly assignmentIds: readonly string[];
  readonly now?: Date;
}

export interface ClaimChildTaskRequest {
  readonly taskId: string;
  readonly owner: string;
  readonly leaseMs: number;
  readonly now?: Date;
}

export interface ClaimChildTaskResult {
  readonly claimed: boolean;
  readonly record: ChildTaskRecord;
}

export interface ClaimChildTaskGroupRequest {
  readonly groupId: string;
  readonly runId: string;
  readonly revision: string;
  readonly taskIds: readonly string[];
  readonly maxConcurrency: number;
  readonly owner: string;
  readonly leaseMs: number;
  readonly now?: Date;
}

export interface ClaimChildTaskGroupResult {
  readonly group: ChildTaskGroupRecord;
  readonly claimed: readonly ChildTaskRecord[];
  readonly records: readonly ChildTaskRecord[];
  readonly missingTaskIds: readonly string[];
}

export interface CompleteChildTaskRequest {
  readonly taskId: string;
  readonly owner: string;
  readonly leaseToken: string;
  readonly fencingEpoch: number;
  readonly status: Exclude<ChildTaskStatus, 'QUEUED' | 'RUNNING'>;
  readonly idempotencyKey: string;
  readonly result?: WorkerResult | null;
  readonly error?: string | null;
  readonly now?: Date;
}

export interface RetryChildTaskRequest {
  readonly taskId: string;
  readonly actor: string;
  readonly idempotencyKey: string;
  readonly now?: Date;
}

export interface ListReadyChildTasksRequest {
  readonly runId: string;
  readonly revision: string;
}

export interface ChildTaskStore {
  create(request: CreateChildTaskRequest): Promise<ChildTaskRecord>;
  load(taskId: string): Promise<ChildTaskRecord | null>;
  reconcile(taskId: string): Promise<ChildTaskRecord | null>;
  ensureGroup(
    request: EnsureChildTaskGroupRequest,
  ): Promise<ChildTaskGroupRecord>;
  loadGroup(groupId: string): Promise<ChildTaskGroupRecord | null>;
  claim(request: ClaimChildTaskRequest): Promise<ClaimChildTaskResult>;
  claimGroup(
    request: ClaimChildTaskGroupRequest,
  ): Promise<ClaimChildTaskGroupResult>;
  complete(request: CompleteChildTaskRequest): Promise<ChildTaskRecord>;
  retry(request: RetryChildTaskRequest): Promise<ChildTaskRecord>;
  listReady(
    request: ListReadyChildTasksRequest,
  ): Promise<readonly ChildTaskRecord[]>;
  events(taskId: string): Promise<readonly ChildTaskEvent[]>;
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

function assertSafeId(value: string, label: string): void {
  assert(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value),
    `${label} must be a safe filename component.`,
  );
}

function assertText(value: string, label: string, max = 512): void {
  assert(value.length > 0 && value.length <= max, `${label} is required.`);
}

function assertLeaseMs(leaseMs: number): void {
  assert(
    Number.isInteger(leaseMs) && leaseMs > 0,
    'Lease duration must be positive.',
  );
}

function assertDate(value: Date): void {
  assert(Number.isFinite(value.getTime()), 'Timestamp must be valid.');
}

function requestForTask(
  request: ClaimChildTaskGroupRequest,
  taskId: string,
  now: Date,
): ClaimChildTaskRequest {
  return {
    taskId,
    owner: request.owner,
    leaseMs: request.leaseMs,
    now,
  };
}

function normalizedDependencies(
  taskId: string,
  dependsOn: readonly string[],
): readonly string[] {
  assert(Array.isArray(dependsOn), 'Dependencies must be an array.');
  const seen = new Set<string>();
  for (const dependency of dependsOn) {
    assertSafeId(dependency, 'Dependency ID');
    assert.notEqual(dependency, taskId, 'A task cannot depend on itself.');
    assert(!seen.has(dependency), 'Dependencies must be unique.');
    seen.add(dependency);
  }
  return [...seen].sort();
}

function orderedIds(
  value: readonly string[],
  label: string,
): readonly string[] {
  assert(Array.isArray(value), `${label} must be an array.`);
  assert(value.length > 0, `${label} must contain at least one ID.`);
  const seen = new Set<string>();
  for (const id of value) {
    assertSafeId(id, `${label} ID`);
    assert(!seen.has(id), `${label} IDs must be unique.`);
    seen.add(id);
  }
  return [...value];
}

function assertGroupMembership(
  taskIds: readonly string[],
  assignmentIds: readonly string[],
): void {
  assert.equal(
    taskIds.length,
    assignmentIds.length,
    'Child task group task and assignment membership must have equal length.',
  );
}

function immutableGroupRecord(
  record: ChildTaskGroupRecord,
): ChildTaskGroupRecord {
  return Object.freeze({
    ...record,
    taskIds: Object.freeze([...record.taskIds]),
    assignmentIds: Object.freeze([...record.assignmentIds]),
  });
}

function assertError(error: string | null): void {
  assert(
    error === null || (error.trim().length > 0 && error.length <= 4096),
    'Task error must be non-empty and no longer than 4096 characters.',
  );
}

function isTerminal(status: ChildTaskStatus): boolean {
  return (
    status === 'SUCCEEDED' ||
    status === 'ISSUES' ||
    status === 'BLOCKED' ||
    status === 'DROPPED' ||
    status === 'FAILED' ||
    status === 'CANCELLED'
  );
}

function expectedResultStatus(
  status: Exclude<ChildTaskStatus, 'QUEUED' | 'RUNNING'>,
): WorkerResult['status'] | null {
  switch (status) {
    case 'SUCCEEDED':
      return 'PASS';
    case 'ISSUES':
      return 'ISSUES';
    case 'BLOCKED':
      return 'BLOCKED';
    case 'DROPPED':
      return 'DROPPED';
    case 'FAILED':
      return null;
    case 'CANCELLED':
      return null;
  }
}

function assertCompletionPayload(
  status: Exclude<ChildTaskStatus, 'QUEUED' | 'RUNNING'>,
  result: WorkerResult | null,
  error: string | null,
): void {
  if (status === 'FAILED') {
    assert(result === null, 'Failed tasks cannot publish a worker result.');
    assert(
      error !== null && error.trim().length > 0,
      'Failed tasks require a non-empty error.',
    );
    return;
  }

  assert(error === null, `${status} tasks cannot retain a mechanical error.`);
  const expected = expectedResultStatus(status);
  if (expected === null) {
    assert(result === null, 'Cancelled tasks cannot publish a worker result.');
    return;
  }
  assert(result, `A ${status} task must retain a worker result.`);
  assertWorkerResult(result);
  assert.equal(
    result.status,
    expected,
    `Task status ${status} does not match worker result ${result.status}.`,
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseLease(value: unknown): ChildTaskLease {
  assert(value && typeof value === 'object', 'Task lease is invalid.');
  const lease = value as Partial<ChildTaskLease>;
  assert(typeof lease.owner === 'string' && lease.owner.length > 0);
  assert(typeof lease.token === 'string' && lease.token.length > 0);
  assert(
    Number.isInteger(lease.fencingEpoch) && (lease.fencingEpoch as number) > 0,
  );
  assert(typeof lease.acquiredAt === 'string');
  assert(typeof lease.expiresAt === 'string');
  assert(Number.isFinite(Date.parse(lease.acquiredAt)));
  assert(Number.isFinite(Date.parse(lease.expiresAt)));
  return lease as ChildTaskLease;
}

function parseRecord(value: unknown): ChildTaskRecord {
  assert(value && typeof value === 'object', 'Child task record is invalid.');
  const record = value as Partial<ChildTaskRecord>;
  assert.equal(record.schema, 1);
  assert(typeof record.taskId === 'string');
  assertSafeId(record.taskId, 'Task ID');
  assert(typeof record.runId === 'string');
  assertSafeId(record.runId, 'Run ID');
  assert(typeof record.revision === 'string');
  assertText(record.revision, 'Revision');
  assert(typeof record.status === 'string');
  assert(
    [
      'QUEUED',
      'RUNNING',
      'SUCCEEDED',
      'ISSUES',
      'BLOCKED',
      'DROPPED',
      'FAILED',
      'CANCELLED',
    ].includes(record.status),
  );
  assert(Number.isInteger(record.attempt) && (record.attempt as number) >= 0);
  assert(typeof record.createdAt === 'string');
  assert(typeof record.updatedAt === 'string');
  assert(Number.isFinite(Date.parse(record.createdAt)));
  assert(Number.isFinite(Date.parse(record.updatedAt)));
  assert(Array.isArray(record.dependsOn));
  const dependsOn = normalizedDependencies(
    record.taskId,
    record.dependsOn as readonly string[],
  );
  const lease = record.lease === null ? null : parseLease(record.lease);
  if (record.status === 'RUNNING')
    assert(lease, 'Running task lease is missing.');
  if (record.status !== 'RUNNING')
    assert(lease === null, 'Only running tasks may retain a lease.');
  assert(record.result === null || typeof record.result === 'object');
  if (record.result) assertWorkerResult(record.result as WorkerResult);
  assert(record.error === null || typeof record.error === 'string');
  const result = (record.result ?? null) as WorkerResult | null;
  const error = (record.error ?? null) as string | null;
  assertError(error);
  if (record.status === 'QUEUED' || record.status === 'RUNNING') {
    assert(result === null, `${record.status} tasks cannot retain a result.`);
    assert(error === null, `${record.status} tasks cannot retain an error.`);
  } else {
    assertCompletionPayload(
      record.status as Exclude<ChildTaskStatus, 'QUEUED' | 'RUNNING'>,
      result,
      error,
    );
  }
  return {
    ...record,
    status: record.status as ChildTaskStatus,
    attempt: record.attempt as number,
    dependsOn,
    lease,
    result,
    error,
  } as ChildTaskRecord;
}

function parseGroupRecord(value: unknown): ChildTaskGroupRecord {
  assert(
    value && typeof value === 'object',
    'Child task group record is invalid.',
  );
  const record = value as Partial<ChildTaskGroupRecord>;
  assert.equal(record.schema, 1);
  assert(typeof record.groupId === 'string');
  assertSafeId(record.groupId, 'Group ID');
  assert(typeof record.runId === 'string');
  assertSafeId(record.runId, 'Run ID');
  assert(typeof record.revision === 'string');
  assertText(record.revision, 'Revision');
  const taskIds = orderedIds(
    record.taskIds as readonly string[],
    'Child task group task',
  );
  const assignmentIds = orderedIds(
    record.assignmentIds as readonly string[],
    'Child task group assignment',
  );
  assertGroupMembership(taskIds, assignmentIds);
  assert(typeof record.createdAt === 'string');
  assert(Number.isFinite(Date.parse(record.createdAt)));
  return immutableGroupRecord({
    schema: 1,
    groupId: record.groupId,
    runId: record.runId,
    revision: record.revision,
    taskIds,
    assignmentIds,
    createdAt: record.createdAt,
  });
}

function parseEvent(value: unknown): ChildTaskEvent {
  assert(value && typeof value === 'object', 'Child task event is invalid.');
  const event = value as Partial<ChildTaskEvent>;
  assert.equal(event.schema, 1);
  assert(Number.isInteger(event.sequence) && (event.sequence as number) > 0);
  assert(typeof event.taskId === 'string');
  assertSafeId(event.taskId, 'Task ID');
  assert(typeof event.runId === 'string');
  assertSafeId(event.runId, 'Run ID');
  assert(typeof event.revision === 'string');
  assertText(event.revision, 'Revision');
  assert(
    event.type === 'task-created' ||
      event.type === 'task-claimed' ||
      event.type === 'task-completed' ||
      event.type === 'task-retried',
  );
  assert(
    typeof event.idempotencyKey === 'string' && event.idempotencyKey.length > 0,
  );
  assert(typeof event.actor === 'string' && event.actor.length > 0);
  assert(typeof event.at === 'string' && Number.isFinite(Date.parse(event.at)));
  assert(
    event.payload &&
      typeof event.payload === 'object' &&
      !Array.isArray(event.payload),
  );
  for (const payloadValue of Object.values(
    event.payload as Record<string, unknown>,
  )) {
    assert(
      payloadValue === null ||
        typeof payloadValue === 'string' ||
        typeof payloadValue === 'number' ||
        typeof payloadValue === 'boolean',
      'Child task event payload is invalid.',
    );
  }
  return {
    ...event,
    sequence: event.sequence as number,
    type: event.type as ChildTaskEventType,
    payload: event.payload as ChildTaskEventPayload,
  } as ChildTaskEvent;
}

type FailureInjectionStage =
  | 'after-sidecar-fsync'
  | 'after-state-publication'
  | 'after-event-publication'
  | 'after-sidecar-removal';

interface ChildTaskTransaction {
  readonly version: 1;
  readonly taskId: string;
  readonly baseStateDigest: string | null;
  readonly baseEventDigest: string;
  readonly baseEventSequence: number;
  readonly nextState: ChildTaskRecord;
  readonly nextEvents: readonly ChildTaskEvent[];
}

function assertDigest(value: unknown, label: string): asserts value is string {
  assert(
    typeof value === 'string' && /^[a-f0-9]{64}$/.test(value),
    `${label} is invalid.`,
  );
}

function assertEventHistory(
  taskId: string,
  record: ChildTaskRecord,
  events: readonly ChildTaskEvent[],
): void {
  assert(events.length > 0, `Child task ${taskId} event history is missing.`);
  const idempotencyKeys = new Set<string>();
  events.forEach((event, index) => {
    assert.equal(event.taskId, taskId);
    assert.equal(event.runId, record.runId);
    assert.equal(event.revision, record.revision);
    assert.equal(event.sequence, index + 1);
    assert(!idempotencyKeys.has(event.idempotencyKey));
    idempotencyKeys.add(event.idempotencyKey);
  });

  const created = events[0];
  assert(created);
  assert.equal(created.type, 'task-created');
  assert.equal(created.idempotencyKey, `create:${taskId}:${record.revision}`);
  assert.equal(created.payload.status, 'QUEUED');
  assert.equal(created.payload.dependencyCount, record.dependsOn.length);

  let status: ChildTaskStatus = 'QUEUED';
  let attempts = 0;
  let completions = 0;
  let retries = 0;
  let latestClaim: ChildTaskEvent | null = null;
  let latestCompletion: ChildTaskEvent | null = null;
  for (const event of events.slice(1)) {
    if (event.type === 'task-claimed') {
      assert(status === 'QUEUED' || status === 'RUNNING');
      attempts += 1;
      assert.equal(event.payload.attempt, attempts);
      assert(Number.isInteger(event.payload.fencingEpoch));
      assert(typeof event.payload.expiresAt === 'string');
      assert(Number.isFinite(Date.parse(event.payload.expiresAt)));
      status = 'RUNNING';
      latestClaim = event;
      continue;
    }
    if (event.type === 'task-completed') {
      assert.equal(status, 'RUNNING');
      assert.equal(event.payload.from, 'RUNNING');
      assert(
        typeof event.payload.to === 'string' &&
          isTerminal(event.payload.to as ChildTaskStatus),
      );
      assert.equal(event.payload.attempt, attempts);
      status = event.payload.to as ChildTaskStatus;
      completions += 1;
      latestCompletion = event;
      continue;
    }
    assert.equal(event.type, 'task-retried');
    assert.equal(status, 'FAILED');
    assert.equal(event.payload.from, 'FAILED');
    assert.equal(event.payload.to, 'QUEUED');
    assert.equal(event.payload.attempt, attempts);
    status = 'QUEUED';
    retries += 1;
  }

  const expectedLength = 1 + record.attempt + completions + retries;
  assert(
    events.length <= expectedLength,
    'Child task event log is ahead of state.',
  );
  assert(
    events.length >= expectedLength,
    'Child task state is ahead of its event log.',
  );
  assert.equal(attempts, record.attempt);
  assert.equal(status, record.status);
  if (record.status === 'RUNNING') {
    assert(record.lease, 'Running task lease is missing.');
    assert(latestClaim);
    assert.equal(latestClaim.payload.fencingEpoch, record.lease.fencingEpoch);
    assert.equal(latestClaim.payload.expiresAt, record.lease.expiresAt);
  }
  if (isTerminal(record.status)) {
    assert(latestCompletion);
    assert.equal(latestCompletion.payload.to, record.status);
    assert.equal(latestCompletion.payload.resultDigest, digest(record.result));
    assert.equal(latestCompletion.payload.error, record.error);
  }
}

function parseTransaction(
  value: unknown,
  taskId: string,
): ChildTaskTransaction {
  assert(
    value && typeof value === 'object',
    'Child task transaction is invalid.',
  );
  const transaction = value as Partial<ChildTaskTransaction>;
  assert.equal(transaction.version, 1);
  assert.equal(transaction.taskId, taskId);
  assert(
    transaction.baseStateDigest === null ||
      typeof transaction.baseStateDigest === 'string',
  );
  if (transaction.baseStateDigest !== null) {
    assertDigest(transaction.baseStateDigest, 'Base state digest');
  }
  assertDigest(transaction.baseEventDigest, 'Base event digest');
  assert(
    Number.isInteger(transaction.baseEventSequence) &&
      (transaction.baseEventSequence as number) >= 0,
  );
  const nextState = parseRecord(transaction.nextState);
  assert.equal(nextState.taskId, taskId);
  assert(Array.isArray(transaction.nextEvents));
  const nextEvents = transaction.nextEvents.map(parseEvent);
  assertEventHistory(taskId, nextState, nextEvents);
  assert(nextEvents.length > (transaction.baseEventSequence as number));
  return {
    version: 1,
    taskId,
    baseStateDigest: transaction.baseStateDigest as string | null,
    baseEventDigest: transaction.baseEventDigest as string,
    baseEventSequence: transaction.baseEventSequence as number,
    nextState,
    nextEvents,
  };
}

export class FileChildTaskStore implements ChildTaskStore {
  private static failureInjection: FailureInjectionStage | null = null;

  private constructor(private readonly root: string) {}

  static async create(root: string): Promise<FileChildTaskStore> {
    assert(isAbsolute(root), 'Child task store root must be absolute.');
    await mkdir(root, { recursive: true, mode: 0o700 });
    return new FileChildTaskStore(await realpath(root));
  }

  async create(request: CreateChildTaskRequest): Promise<ChildTaskRecord> {
    assertSafeId(request.taskId, 'Task ID');
    assertSafeId(request.runId, 'Run ID');
    assertText(request.revision, 'Revision');
    assertText(request.actor, 'Actor');
    const dependsOn = normalizedDependencies(request.taskId, request.dependsOn);
    return this.withStoreLock(() =>
      this.withLock(request.taskId, async () => {
        await this.reconcileLocked(request.taskId);
        const existing = await this.readRecord(request.taskId);
        if (existing) {
          assert.equal(
            existing.runId,
            request.runId,
            'Task ID is bound to another run.',
          );
          assert.equal(
            existing.revision,
            request.revision,
            'Task ID is bound to another revision.',
          );
          assert.deepEqual(
            existing.dependsOn,
            dependsOn,
            'Task ID is bound to another dependency set.',
          );
          return existing;
        }
        const now = request.now ?? new Date();
        assertDate(now);
        const at = now.toISOString();
        const record: ChildTaskRecord = {
          schema: 1,
          taskId: request.taskId,
          runId: request.runId,
          revision: request.revision,
          status: 'QUEUED',
          attempt: 0,
          createdAt: at,
          updatedAt: at,
          dependsOn,
          lease: null,
          result: null,
          error: null,
        };
        const events = [
          this.createEvent({
            taskId: request.taskId,
            runId: request.runId,
            revision: request.revision,
            actor: request.actor,
            type: 'task-created',
            idempotencyKey: `create:${request.taskId}:${request.revision}`,
            payload: {
              status: 'QUEUED',
              dependencyCount: dependsOn.length,
            },
            now,
            sequence: 1,
          }),
        ];
        await this.commitTransitionLocked({
          taskId: request.taskId,
          baseState: null,
          baseEvents: [],
          nextState: record,
          nextEvents: events,
        });
        return record;
      }),
    );
  }

  async load(taskId: string): Promise<ChildTaskRecord | null> {
    assertSafeId(taskId, 'Task ID');
    return this.withLock(taskId, async () => {
      await this.reconcileLocked(taskId);
      return this.readRecord(taskId);
    });
  }

  async reconcile(taskId: string): Promise<ChildTaskRecord | null> {
    assertSafeId(taskId, 'Task ID');
    return this.withLock(taskId, () => this.reconcileLocked(taskId));
  }

  async ensureGroup(
    request: EnsureChildTaskGroupRequest,
  ): Promise<ChildTaskGroupRecord> {
    assertSafeId(request.groupId, 'Group ID');
    assertSafeId(request.runId, 'Run ID');
    assertText(request.revision, 'Revision');
    const taskIds = orderedIds(request.taskIds, 'Child task group task');
    const assignmentIds = orderedIds(
      request.assignmentIds,
      'Child task group assignment',
    );
    assertGroupMembership(taskIds, assignmentIds);

    return this.withStoreLock(() =>
      this.withGroupLock(request.groupId, async () => {
        for (const taskId of taskIds) await this.reconcile(taskId);
        const existing = await this.readGroup(request.groupId);
        if (existing) {
          assert.equal(
            existing.groupId,
            request.groupId,
            'Child task group ID does not match its filename.',
          );
          assert.equal(
            existing.runId,
            request.runId,
            'Child task group is bound to another run.',
          );
          assert.equal(
            existing.revision,
            request.revision,
            'Child task group is bound to another revision.',
          );
          assert.deepEqual(
            existing.taskIds,
            taskIds,
            'Child task group task membership is immutable.',
          );
          assert.deepEqual(
            existing.assignmentIds,
            assignmentIds,
            'Child task group assignment membership is immutable.',
          );
          return existing;
        }

        const now = request.now ?? new Date();
        assertDate(now);
        const record = immutableGroupRecord({
          schema: 1,
          groupId: request.groupId,
          runId: request.runId,
          revision: request.revision,
          taskIds,
          assignmentIds,
          createdAt: now.toISOString(),
        });
        await this.writeGroup(record);
        return record;
      }),
    );
  }

  async loadGroup(groupId: string): Promise<ChildTaskGroupRecord | null> {
    assertSafeId(groupId, 'Group ID');
    return this.withGroupLock(groupId, () => this.readGroup(groupId));
  }

  async claim(request: ClaimChildTaskRequest): Promise<ClaimChildTaskResult> {
    assertSafeId(request.taskId, 'Task ID');
    assertText(request.owner, 'Owner');
    assertLeaseMs(request.leaseMs);
    return this.withStoreLock(() =>
      this.withLock(request.taskId, async () => {
        await this.reconcileLocked(request.taskId);
        return this.claimLocked(request);
      }),
    );
  }

  async claimGroup(
    request: ClaimChildTaskGroupRequest,
  ): Promise<ClaimChildTaskGroupResult> {
    assertSafeId(request.groupId, 'Group ID');
    assertSafeId(request.runId, 'Run ID');
    assertText(request.revision, 'Revision');
    assertText(request.owner, 'Owner');
    assertLeaseMs(request.leaseMs);
    assert(
      Number.isInteger(request.maxConcurrency) && request.maxConcurrency > 0,
      'Group maxConcurrency must be a positive integer.',
    );
    const taskIds = orderedIds(request.taskIds, 'Child task group task');
    return this.withStoreLock(() =>
      this.withGroupLock(request.groupId, async () => {
        const group = await this.readGroup(request.groupId);
        assert(group, `Child task group ${request.groupId} does not exist.`);
        assert.equal(group.groupId, request.groupId);
        assert.equal(group.runId, request.runId);
        assert.equal(group.revision, request.revision);
        assert.deepEqual(group.taskIds, taskIds);

        const records: ChildTaskRecord[] = [];
        const claimed: ChildTaskRecord[] = [];
        const missingTaskIds: string[] = [];
        let activeLeases = 0;
        const now = request.now ?? new Date();
        assertDate(now);
        for (const taskId of taskIds) {
          const result = await this.withLock(taskId, async () => {
            await this.reconcileLocked(taskId);
            const existing = await this.readRecord(taskId);
            if (!existing) return null;
            if (
              existing.status === 'RUNNING' &&
              existing.lease !== null &&
              Date.parse(existing.lease.expiresAt) > now.getTime()
            ) {
              activeLeases += 1;
            }
            if (
              activeLeases >= request.maxConcurrency ||
              isTerminal(existing.status)
            ) {
              return { claimed: false, record: existing };
            }
            return this.claimLocked(requestForTask(request, taskId, now));
          });
          if (!result) {
            missingTaskIds.push(taskId);
            continue;
          }
          records.push(result.record);
          if (result.claimed) {
            claimed.push(result.record);
            activeLeases += 1;
          }
        }
        return { group, claimed, records, missingTaskIds };
      }),
    );
  }

  private async claimLocked(
    request: ClaimChildTaskRequest,
  ): Promise<ClaimChildTaskResult> {
    const record = await this.requireRecord(request.taskId);
    const now = request.now ?? new Date();
    assertDate(now);
    const nowMs = now.getTime();
    if (isTerminal(record.status)) return { claimed: false, record };
    if (record.status === 'RUNNING') {
      assert(record.lease);
      if (Date.parse(record.lease.expiresAt) > nowMs) {
        return { claimed: false, record };
      }
    }
    if (!(await this.dependenciesSucceeded(record))) {
      return { claimed: false, record };
    }
    const fencingEpoch = (record.lease?.fencingEpoch ?? 0) + 1;
    const next: ChildTaskRecord = {
      ...record,
      status: 'RUNNING',
      attempt: record.attempt + 1,
      updatedAt: now.toISOString(),
      lease: {
        owner: request.owner,
        token: randomUUID(),
        fencingEpoch,
        acquiredAt: now.toISOString(),
        expiresAt: new Date(nowMs + request.leaseMs).toISOString(),
      },
    };
    assert(next.lease);
    const events = await this.readEvents(request.taskId, record.revision);
    const event = this.createEvent({
      taskId: request.taskId,
      sequence: events.length + 1,
      runId: record.runId,
      revision: record.revision,
      actor: request.owner,
      type: 'task-claimed',
      idempotencyKey: `claim:${request.taskId}:${request.owner}:${next.attempt}`,
      payload: {
        attempt: next.attempt,
        fencingEpoch,
        expiresAt: next.lease.expiresAt,
      },
      now,
    });
    await this.commitTransitionLocked({
      taskId: request.taskId,
      baseState: record,
      baseEvents: events,
      nextState: next,
      nextEvents: [...events, event],
    });
    return { claimed: true, record: next };
  }

  async complete(request: CompleteChildTaskRequest): Promise<ChildTaskRecord> {
    assertSafeId(request.taskId, 'Task ID');
    assertText(request.owner, 'Owner');
    assertText(request.leaseToken, 'Lease token');
    assert(Number.isInteger(request.fencingEpoch) && request.fencingEpoch > 0);
    assertText(request.idempotencyKey, 'Idempotency key');
    const result = request.result ?? null;
    const error = request.error ?? null;
    assertError(error);
    assertCompletionPayload(request.status, result, error);
    return this.withStoreLock(() =>
      this.withLock(request.taskId, async () => {
        await this.reconcileLocked(request.taskId);
        const record = await this.requireRecord(request.taskId);
        const events = await this.readEvents(request.taskId, record.revision);
        const existing = events.find(
          (event) => event.idempotencyKey === request.idempotencyKey,
        );
        const resultDigest = digest(result);
        if (existing) {
          assert.equal(existing.type, 'task-completed');
          assert.equal(
            existing.payload.to,
            request.status,
            'Idempotency key target changed.',
          );
          assert.equal(
            existing.payload.fencingEpoch,
            request.fencingEpoch,
            'Idempotency key fencing epoch changed.',
          );
          assert.equal(
            existing.payload.resultDigest,
            resultDigest,
            'Idempotency key result changed.',
          );
          assert.equal(
            existing.payload.error,
            error,
            'Idempotency key error changed.',
          );
          assert.equal(
            existing.actor,
            request.owner,
            'Idempotency key actor changed.',
          );
          if (existing.payload.leaseTokenDigest !== undefined) {
            assert.equal(
              existing.payload.leaseTokenDigest,
              digest(request.leaseToken),
              'Idempotency key lease changed.',
            );
          }
          assert.equal(
            record.status,
            request.status,
            'Completed task status changed.',
          );
          assert.equal(
            canonical(record.result),
            canonical(result),
            'Completed task result changed.',
          );
          assert.equal(record.error, error, 'Completed task error changed.');
          return record;
        }
        const now = request.now ?? new Date();
        assertDate(now);
        assert.equal(
          record.status,
          'RUNNING',
          'Only a running lease can complete a child task.',
        );
        assert(record.lease, 'Child task lease is missing.');
        assert.equal(
          record.lease.owner,
          request.owner,
          'Child task lease owner mismatch.',
        );
        assert.equal(
          record.lease.token,
          request.leaseToken,
          'Child task lease token mismatch.',
        );
        assert.equal(
          record.lease.fencingEpoch,
          request.fencingEpoch,
          'Child task fencing epoch mismatch.',
        );
        assert(
          Date.parse(record.lease.expiresAt) > now.getTime(),
          'Child task lease has expired.',
        );
        const next: ChildTaskRecord = {
          ...record,
          status: request.status,
          updatedAt: now.toISOString(),
          lease: null,
          result,
          error,
        };
        const event = this.createEvent({
          taskId: request.taskId,
          sequence: events.length + 1,
          runId: record.runId,
          revision: record.revision,
          actor: request.owner,
          type: 'task-completed',
          idempotencyKey: request.idempotencyKey,
          payload: {
            from: record.status,
            to: request.status,
            attempt: record.attempt,
            fencingEpoch: request.fencingEpoch,
            resultDigest,
            error,
            leaseTokenDigest: digest(request.leaseToken),
          },
          now,
        });
        await this.commitTransitionLocked({
          taskId: request.taskId,
          baseState: record,
          baseEvents: events,
          nextState: next,
          nextEvents: [...events, event],
        });
        return next;
      }),
    );
  }

  async retry(request: RetryChildTaskRequest): Promise<ChildTaskRecord> {
    assertSafeId(request.taskId, 'Task ID');
    assertText(request.actor, 'Actor');
    assertText(request.idempotencyKey, 'Idempotency key');
    return this.withStoreLock(() =>
      this.withLock(request.taskId, async () => {
        await this.reconcileLocked(request.taskId);
        const record = await this.requireRecord(request.taskId);
        const events = await this.readEvents(request.taskId, record.revision);
        const existing = events.find(
          (event) => event.idempotencyKey === request.idempotencyKey,
        );
        if (existing) {
          assert.equal(existing.type, 'task-retried');
          assert.equal(existing.actor, request.actor);
          return record;
        }
        assert.equal(
          record.status,
          'FAILED',
          'Only mechanically failed child tasks can be retried.',
        );
        assert(record.error, 'Failed child task error is missing.');
        const now = request.now ?? new Date();
        assertDate(now);
        const next: ChildTaskRecord = {
          ...record,
          status: 'QUEUED',
          updatedAt: now.toISOString(),
          lease: null,
          result: null,
          error: null,
        };
        const event = this.createEvent({
          taskId: request.taskId,
          sequence: events.length + 1,
          runId: record.runId,
          revision: record.revision,
          actor: request.actor,
          type: 'task-retried',
          idempotencyKey: request.idempotencyKey,
          payload: {
            from: 'FAILED',
            to: 'QUEUED',
            attempt: record.attempt,
            error: record.error,
          },
          now,
        });
        await this.commitTransitionLocked({
          taskId: request.taskId,
          baseState: record,
          baseEvents: events,
          nextState: next,
          nextEvents: [...events, event],
        });
        return next;
      }),
    );
  }

  async listReady(
    request: ListReadyChildTasksRequest,
  ): Promise<readonly ChildTaskRecord[]> {
    assertSafeId(request.runId, 'Run ID');
    assertText(request.revision, 'Revision');
    const entries = await readdir(this.root, { withFileTypes: true });
    const records: ChildTaskRecord[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.task.json')) continue;
      const taskId = entry.name.slice(0, -'.task.json'.length);
      assertSafeId(taskId, 'Task ID');
      const record = await this.load(taskId);
      if (
        !record ||
        record.runId !== request.runId ||
        record.revision !== request.revision
      ) {
        continue;
      }
      const now = Date.now();
      const reclaimable =
        record.status === 'QUEUED' ||
        (record.status === 'RUNNING' &&
          record.lease !== null &&
          Date.parse(record.lease.expiresAt) <= now);
      if (reclaimable && (await this.dependenciesSucceeded(record))) {
        records.push(record);
      }
    }
    return records.sort((left, right) =>
      left.taskId.localeCompare(right.taskId),
    );
  }

  async events(taskId: string): Promise<readonly ChildTaskEvent[]> {
    assertSafeId(taskId, 'Task ID');
    return this.withLock(taskId, async () => {
      await this.reconcileLocked(taskId);
      const record = await this.requireRecord(taskId);
      return this.readEvents(taskId, record.revision);
    });
  }

  private statePath(taskId: string): string {
    return join(this.root, `${taskId}.task.json`);
  }

  private groupPath(groupId: string): string {
    return join(this.root, `${groupId}.group.json`);
  }

  private eventPath(taskId: string): string {
    return join(this.root, `${taskId}.events.jsonl`);
  }

  private transactionPath(taskId: string): string {
    return join(this.root, `.${taskId}.transaction.json`);
  }

  private lockPath(taskId: string): string {
    return join(this.root, `.${taskId}.lock`);
  }

  private groupLockPath(groupId: string): string {
    return join(this.root, `.${groupId}.group.lock`);
  }

  private storeLockPath(): string {
    return join(this.root, '.store.lock');
  }

  private async readRecord(taskId: string): Promise<ChildTaskRecord | null> {
    try {
      return parseRecord(
        JSON.parse(await readFile(this.statePath(taskId), 'utf8')),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async readGroup(
    groupId: string,
  ): Promise<ChildTaskGroupRecord | null> {
    try {
      return parseGroupRecord(
        JSON.parse(await readFile(this.groupPath(groupId), 'utf8')),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async requireRecord(taskId: string): Promise<ChildTaskRecord> {
    const record = await this.readRecord(taskId);
    assert(record, `Child task ${taskId} does not exist.`);
    return record;
  }

  private async readTransaction(
    taskId: string,
  ): Promise<ChildTaskTransaction | null> {
    try {
      return parseTransaction(
        JSON.parse(await readFile(this.transactionPath(taskId), 'utf8')),
        taskId,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async reconcileLocked(
    taskId: string,
  ): Promise<ChildTaskRecord | null> {
    const transaction = await this.readTransaction(taskId);
    const currentState = await this.readRecord(taskId);
    const currentEvents = await this.readEvents(taskId);
    if (!transaction) {
      if (!currentState) {
        assert(
          currentEvents.length === 0,
          `Child task ${taskId} is missing its state.`,
        );
        return null;
      }
      assertEventHistory(taskId, currentState, currentEvents);
      return currentState;
    }

    const currentStateDigest = currentState ? digest(currentState) : null;
    const currentEventDigest = digest(currentEvents);
    const baseState = currentStateDigest === transaction.baseStateDigest;
    const baseEvents =
      currentEvents.length === transaction.baseEventSequence &&
      currentEventDigest === transaction.baseEventDigest;
    const nextState = currentStateDigest === digest(transaction.nextState);
    const nextEvents =
      currentEvents.length === transaction.nextEvents.length &&
      currentEventDigest === digest(transaction.nextEvents);

    if (nextState && nextEvents) {
      await this.removeTransaction(taskId);
      return transaction.nextState;
    }
    if (baseState && nextEvents && !nextState) {
      throw new Error('Child task state conflicts with its transaction.');
    }
    if (baseEvents && nextState && !nextEvents) {
      await this.publishTransaction(transaction);
      return transaction.nextState;
    }
    if (baseState && baseEvents) {
      await this.publishTransaction(transaction);
      return transaction.nextState;
    }
    if (baseEvents && !nextEvents) {
      throw new Error('Child task transaction base digest conflict.');
    }
    if (nextState && !nextEvents) {
      throw new Error('Child task transaction event publication is ambiguous.');
    }
    throw new Error('Child task transaction state is ambiguous.');
  }

  private async commitTransitionLocked(input: {
    readonly taskId: string;
    readonly baseState: ChildTaskRecord | null;
    readonly baseEvents: readonly ChildTaskEvent[];
    readonly nextState: ChildTaskRecord;
    readonly nextEvents: readonly ChildTaskEvent[];
  }): Promise<void> {
    assertEventHistory(input.taskId, input.nextState, input.nextEvents);
    assert.equal(
      input.baseEvents.length,
      input.nextEvents.length - 1,
      'Child task transition must append exactly one event.',
    );
    const transaction: ChildTaskTransaction = {
      version: 1,
      taskId: input.taskId,
      baseStateDigest: input.baseState ? digest(input.baseState) : null,
      baseEventDigest: digest(input.baseEvents),
      baseEventSequence: input.baseEvents.length,
      nextState: input.nextState,
      nextEvents: input.nextEvents,
    };
    await this.writeTransaction(transaction);
    this.injectFailure('after-sidecar-fsync');
    await this.publishTransaction(transaction);
  }

  private async publishTransaction(
    transaction: ChildTaskTransaction,
  ): Promise<void> {
    await this.writeRecord(transaction.nextState);
    this.injectFailure('after-state-publication');
    await this.writeEvents(transaction.taskId, transaction.nextEvents);
    this.injectFailure('after-event-publication');
    await this.removeTransaction(transaction.taskId);
    this.injectFailure('after-sidecar-removal');
  }

  private async removeTransaction(taskId: string): Promise<void> {
    await unlink(this.transactionPath(taskId)).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }

  private injectFailure(stage: FailureInjectionStage): void {
    if (FileChildTaskStore.failureInjection !== stage) return;
    FileChildTaskStore.failureInjection = null;
    throw new Error(`Injected child task store interruption at ${stage}.`);
  }

  private async writeTransaction(
    transaction: ChildTaskTransaction,
  ): Promise<void> {
    await this.writeFileAtomic(
      this.transactionPath(transaction.taskId),
      canonical(transaction),
    );
  }

  private async writeRecord(record: ChildTaskRecord): Promise<void> {
    await this.writeFileAtomic(
      this.statePath(record.taskId),
      canonical(record),
    );
  }

  private async writeGroup(record: ChildTaskGroupRecord): Promise<void> {
    await this.writeFileAtomic(
      this.groupPath(record.groupId),
      canonical(record),
    );
  }

  private async writeFileAtomic(path: string, body: string): Promise<void> {
    const temporary = join(this.root, `.${randomUUID()}.tmp`);
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
  }

  private async readEvents(
    taskId: string,
    revision?: string,
  ): Promise<readonly ChildTaskEvent[]> {
    let body: string;
    try {
      body = await readFile(this.eventPath(taskId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    if (body.length === 0) return [];
    const lines = body.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    assert(
      lines.every((line) => line.length > 0),
      'Child task event log contains a blank or partial JSONL record.',
    );
    const events = lines.map((line) => parseEvent(JSON.parse(line)));
    events.forEach((event, index) => {
      assert.equal(event.taskId, taskId);
      if (revision !== undefined) assert.equal(event.revision, revision);
      assert.equal(
        event.sequence,
        index + 1,
        'Task event sequence is not contiguous.',
      );
    });
    return events;
  }

  private async writeEvents(
    taskId: string,
    events: readonly ChildTaskEvent[],
  ): Promise<void> {
    await this.writeFileAtomic(
      this.eventPath(taskId),
      events.map((event) => canonical(event)).join('\n') + '\n',
    );
  }

  private createEvent(input: {
    readonly sequence: number;
    readonly taskId: string;
    readonly runId: string;
    readonly revision: string;
    readonly type: ChildTaskEventType;
    readonly idempotencyKey: string;
    readonly actor: string;
    readonly payload: ChildTaskEventPayload;
    readonly now: Date;
  }): ChildTaskEvent {
    assertDate(input.now);
    return {
      schema: 1,
      sequence: input.sequence,
      taskId: input.taskId,
      runId: input.runId,
      revision: input.revision,
      type: input.type,
      idempotencyKey: input.idempotencyKey,
      actor: input.actor,
      at: input.now.toISOString(),
      payload: input.payload,
    };
  }

  private async dependenciesSucceeded(
    record: ChildTaskRecord,
  ): Promise<boolean> {
    for (const dependencyId of record.dependsOn) {
      const dependency = await this.load(dependencyId);
      assert(dependency, `Dependency ${dependencyId} does not exist.`);
      assert.equal(
        dependency.runId,
        record.runId,
        'Dependency belongs to another run.',
      );
      assert.equal(
        dependency.revision,
        record.revision,
        'Dependency belongs to another revision.',
      );
      if (dependency.status !== 'SUCCEEDED') return false;
    }
    return true;
  }

  private async withStoreLock<T>(operation: () => Promise<T>): Promise<T> {
    return this.withLockPath(
      this.storeLockPath(),
      'child task store',
      operation,
    );
  }

  private async withLock<T>(
    taskId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.withLockPath(
      this.lockPath(taskId),
      `child task ${taskId}`,
      operation,
    );
  }

  private async withGroupLock<T>(
    groupId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.withLockPath(
      this.groupLockPath(groupId),
      `child task group ${groupId}`,
      operation,
    );
  }

  private async withLockPath<T>(
    path: string,
    subject: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    let acquired = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await mkdir(path, { mode: 0o700 });
        acquired = true;
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        let lockExists = code === 'EEXIST';
        if (code === 'EPERM' || code === 'EACCES') {
          lockExists = true;
          try {
            lockExists = (await lstat(path)).isDirectory();
          } catch {
            lockExists = true;
          }
        }
        if (!lockExists) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    assert(acquired, `Could not acquire ${subject} lock.`);
    try {
      return await operation();
    } catch (error) {
      throw new Error(`Child task store operation failed: ${message(error)}`, {
        cause: error,
      });
    } finally {
      await rmdir(path).catch(() => undefined);
    }
  }
}
