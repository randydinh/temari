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

export type ChildTaskEventPayload = Readonly<
  Record<string, string | number | boolean | null>
>;

export type ChildTaskEventType =
  'task-created' | 'task-claimed' | 'task-completed';

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

export interface ListReadyChildTasksRequest {
  readonly runId: string;
  readonly revision: string;
}

export interface ChildTaskStore {
  create(request: CreateChildTaskRequest): Promise<ChildTaskRecord>;
  load(taskId: string): Promise<ChildTaskRecord | null>;
  claim(request: ClaimChildTaskRequest): Promise<ClaimChildTaskResult>;
  complete(request: CompleteChildTaskRequest): Promise<ChildTaskRecord>;
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

function assertError(error: string | null): void {
  assert(error === null || error.length <= 4096, 'Task error is too long.');
}

function isTerminal(status: ChildTaskStatus): boolean {
  return (
    status === 'SUCCEEDED' ||
    status === 'ISSUES' ||
    status === 'BLOCKED' ||
    status === 'DROPPED' ||
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
    case 'CANCELLED':
      return null;
  }
}

function assertCompletionPayload(
  status: Exclude<ChildTaskStatus, 'QUEUED' | 'RUNNING'>,
  result: WorkerResult | null,
): void {
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
  assertError(record.error ?? null);
  return {
    ...record,
    status: record.status as ChildTaskStatus,
    attempt: record.attempt as number,
    dependsOn,
    lease,
    result: (record.result ?? null) as WorkerResult | null,
    error: (record.error ?? null) as string | null,
  } as ChildTaskRecord;
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
      event.type === 'task-completed',
  );
  assert(
    typeof event.idempotencyKey === 'string' && event.idempotencyKey.length > 0,
  );
  assert(typeof event.actor === 'string' && event.actor.length > 0);
  assert(typeof event.at === 'string' && Number.isFinite(Date.parse(event.at)));
  assert(event.payload && typeof event.payload === 'object');
  return {
    ...event,
    sequence: event.sequence as number,
    type: event.type as ChildTaskEventType,
    payload: event.payload as ChildTaskEventPayload,
  } as ChildTaskEvent;
}

export class FileChildTaskStore implements ChildTaskStore {
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
    return this.withLock(request.taskId, async () => {
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
      await this.writeRecord(record);
      await this.appendEventLocked({
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
      });
      return record;
    });
  }

  async load(taskId: string): Promise<ChildTaskRecord | null> {
    assertSafeId(taskId, 'Task ID');
    return this.readRecord(taskId);
  }

  async claim(request: ClaimChildTaskRequest): Promise<ClaimChildTaskResult> {
    assertSafeId(request.taskId, 'Task ID');
    assertText(request.owner, 'Owner');
    assertLeaseMs(request.leaseMs);
    return this.withLock(request.taskId, async () => {
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
      await this.writeRecord(next);
      assert(next.lease);
      await this.appendEventLocked({
        taskId: request.taskId,
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
      return { claimed: true, record: next };
    });
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
    assertCompletionPayload(request.status, result);
    return this.withLock(request.taskId, async () => {
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
      await this.writeRecord(next);
      await this.appendEventLocked({
        taskId: request.taskId,
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
        },
        now,
      });
      return next;
    });
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
      const record = await this.readRecord(taskId);
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
    const record = await this.requireRecord(taskId);
    return this.readEvents(taskId, record.revision);
  }

  private statePath(taskId: string): string {
    return join(this.root, `${taskId}.task.json`);
  }

  private eventPath(taskId: string): string {
    return join(this.root, `${taskId}.events.jsonl`);
  }

  private lockPath(taskId: string): string {
    return join(this.root, `.${taskId}.lock`);
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

  private async requireRecord(taskId: string): Promise<ChildTaskRecord> {
    const record = await this.readRecord(taskId);
    assert(record, `Child task ${taskId} does not exist.`);
    return record;
  }

  private async writeRecord(record: ChildTaskRecord): Promise<void> {
    const path = this.statePath(record.taskId);
    const temporary = join(this.root, `.${record.taskId}.${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      try {
        await file.writeFile(canonical(record));
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
    revision: string,
  ): Promise<readonly ChildTaskEvent[]> {
    let body: string;
    try {
      body = await readFile(this.eventPath(taskId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const events = body
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => parseEvent(JSON.parse(line)));
    events.forEach((event, index) => {
      assert.equal(event.taskId, taskId);
      assert.equal(event.revision, revision);
      assert.equal(
        event.sequence,
        index + 1,
        'Task event sequence is not contiguous.',
      );
    });
    return events;
  }

  private async appendEventLocked(
    input: Omit<ChildTaskEvent, 'schema' | 'sequence' | 'at' | 'payload'> & {
      readonly payload: ChildTaskEventPayload;
      readonly now?: Date;
    },
  ): Promise<ChildTaskEvent> {
    const events = await this.readEvents(input.taskId, input.revision);
    const existing = events.find(
      (event) => event.idempotencyKey === input.idempotencyKey,
    );
    if (existing) {
      assert.equal(canonical(existing.payload), canonical(input.payload));
      return existing;
    }
    const now = input.now ?? new Date();
    assertDate(now);
    const event: ChildTaskEvent = {
      schema: 1,
      sequence: events.length + 1,
      taskId: input.taskId,
      runId: input.runId,
      revision: input.revision,
      type: input.type,
      idempotencyKey: input.idempotencyKey,
      actor: input.actor,
      at: now.toISOString(),
      payload: input.payload,
    };
    const file = await open(this.eventPath(input.taskId), 'a', 0o600);
    try {
      await file.writeFile(`${canonical(event)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    return event;
  }

  private async dependenciesSucceeded(
    record: ChildTaskRecord,
  ): Promise<boolean> {
    for (const dependencyId of record.dependsOn) {
      const dependency = await this.readRecord(dependencyId);
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

  private async withLock<T>(
    taskId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const path = this.lockPath(taskId);
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
    assert(acquired, `Could not acquire child task lock for ${taskId}.`);
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
