import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rmdir,
  unlink,
} from 'node:fs/promises';
import { join } from 'node:path';

export type MechanicalRunStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'BLOCKED'
  | 'CANCELLED';

export interface RunLease {
  readonly owner: string;
  readonly token: string;
  readonly acquiredAt: string;
  readonly expiresAt: string;
}

export interface MechanicalRunRecord {
  readonly schema: 1;
  readonly runId: string;
  readonly revision: string;
  readonly status: MechanicalRunStatus;
  readonly attempt: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lease: RunLease | null;
}

export type RunEventPayload = Readonly<
  Record<string, string | number | boolean | null>
>;

export type RunEventType =
  | 'run-created'
  | 'run-claimed'
  | 'run-event'
  | 'run-status-changed';

export interface RunEvent {
  readonly schema: 1;
  readonly sequence: number;
  readonly runId: string;
  readonly revision: string;
  readonly type: RunEventType;
  readonly idempotencyKey: string;
  readonly actor: string;
  readonly at: string;
  readonly payload: RunEventPayload;
}

export interface CreateRunRequest {
  readonly runId: string;
  readonly revision: string;
  readonly actor: string;
  readonly now?: Date;
}

export interface ClaimRunRequest {
  readonly runId: string;
  readonly owner: string;
  readonly leaseMs: number;
  readonly now?: Date;
}

export interface ClaimRunResult {
  readonly claimed: boolean;
  readonly record: MechanicalRunRecord;
}

export interface AppendRunEventRequest {
  readonly runId: string;
  readonly actor: string;
  readonly type?: RunEventType;
  readonly idempotencyKey: string;
  readonly payload?: RunEventPayload;
  readonly now?: Date;
}

export interface TransitionRunRequest {
  readonly runId: string;
  readonly owner: string;
  readonly leaseToken: string;
  readonly status: MechanicalRunStatus;
  readonly idempotencyKey: string;
  readonly payload?: RunEventPayload;
  readonly now?: Date;
}

export interface WorkflowRunStore {
  create(request: CreateRunRequest): Promise<MechanicalRunRecord>;
  load(runId: string): Promise<MechanicalRunRecord | null>;
  claim(request: ClaimRunRequest): Promise<ClaimRunResult>;
  appendEvent(request: AppendRunEventRequest): Promise<RunEvent>;
  transition(request: TransitionRunRequest): Promise<MechanicalRunRecord>;
  events(runId: string): Promise<readonly RunEvent[]>;
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

function assertRunId(runId: string): void {
  assert(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId),
    'Run ID must be a safe filename component.',
  );
}

function assertText(value: string, label: string): void {
  assert(value.length > 0 && value.length <= 512, `${label} is required.`);
}

function assertLeaseMs(leaseMs: number): void {
  assert(Number.isInteger(leaseMs) && leaseMs > 0, 'Lease duration must be positive.');
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTerminal(status: MechanicalRunStatus): boolean {
  return status === 'SUCCEEDED' || status === 'FAILED' || status === 'BLOCKED' || status === 'CANCELLED';
}

function parseRecord(value: unknown): MechanicalRunRecord {
  assert(value && typeof value === 'object', 'Run record must be an object.');
  const record = value as Partial<MechanicalRunRecord>;
  assert.equal(record.schema, 1);
  assert(typeof record.runId === 'string', 'Run record ID is missing.');
  assertRunId(record.runId);
  assert(typeof record.revision === 'string' && record.revision.length > 0);
  assert(typeof record.status === 'string', 'Run record status is missing.');
  assert(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED'].includes(record.status));
  const attempt = record.attempt as number | undefined;
  assert(Number.isInteger(attempt) && (attempt as number) >= 0);
  assert(typeof record.createdAt === 'string' && typeof record.updatedAt === 'string');
  assert(record.lease === null || (record.lease && typeof record.lease === 'object'));
  return { ...record, attempt } as MechanicalRunRecord;
}

function parseEvent(value: unknown): RunEvent {
  assert(value && typeof value === 'object', 'Run event must be an object.');
  const event = value as Partial<RunEvent>;
  assert.equal(event.schema, 1);
  const sequence = event.sequence as number | undefined;
  assert(Number.isInteger(sequence) && (sequence as number) > 0);
  assert(typeof event.runId === 'string');
  assertRunId(event.runId);
  assert(typeof event.revision === 'string' && event.revision.length > 0);
  assert(typeof event.type === 'string');
  assert(typeof event.idempotencyKey === 'string' && event.idempotencyKey.length > 0);
  assert(typeof event.actor === 'string' && event.actor.length > 0);
  assert(typeof event.at === 'string');
  assert(event.payload && typeof event.payload === 'object');
  return { ...event, sequence } as RunEvent;
}

export class FileWorkflowRunStore implements WorkflowRunStore {
  private constructor(private readonly root: string) {}

  static async create(root: string): Promise<FileWorkflowRunStore> {
    assert(root.startsWith('/'), 'Run store root must be absolute.');
    await mkdir(root, { recursive: true, mode: 0o700 });
    return new FileWorkflowRunStore(await realpath(root));
  }

  async create(request: CreateRunRequest): Promise<MechanicalRunRecord> {
    assertRunId(request.runId);
    assertText(request.revision, 'Revision');
    assertText(request.actor, 'Actor');
    return this.withLock(request.runId, async () => {
      const existing = await this.readRecord(request.runId);
      if (existing) {
        assert.equal(existing.revision, request.revision, 'Run ID is bound to another revision.');
        return existing;
      }
      const at = (request.now ?? new Date()).toISOString();
      const record: MechanicalRunRecord = {
        schema: 1,
        runId: request.runId,
        revision: request.revision,
        status: 'QUEUED',
        attempt: 0,
        createdAt: at,
        updatedAt: at,
        lease: null,
      };
      await this.writeRecord(record);
      await this.appendEventLocked({
        runId: request.runId,
        revision: request.revision,
        actor: request.actor,
        type: 'run-created',
        idempotencyKey: `create:${request.runId}:${request.revision}`,
        payload: { status: 'QUEUED' },
        now: request.now,
      });
      return record;
    });
  }

  async load(runId: string): Promise<MechanicalRunRecord | null> {
    assertRunId(runId);
    return this.readRecord(runId);
  }

  async claim(request: ClaimRunRequest): Promise<ClaimRunResult> {
    assertRunId(request.runId);
    assertText(request.owner, 'Owner');
    assertLeaseMs(request.leaseMs);
    return this.withLock(request.runId, async () => {
      const record = await this.requireRecord(request.runId);
      const now = request.now ?? new Date();
      const nowMs = now.getTime();
      const lease = record.lease;
      if (isTerminal(record.status)) return { claimed: false, record };
      if (record.status === 'RUNNING' && lease) {
        const leaseActive = Date.parse(lease.expiresAt) > nowMs;
        if (leaseActive) return { claimed: false, record };
      }

      const next: MechanicalRunRecord = {
        ...record,
        status: 'RUNNING',
        attempt: record.attempt + 1,
        updatedAt: now.toISOString(),
        lease: {
          owner: request.owner,
          token: randomUUID(),
          acquiredAt: now.toISOString(),
          expiresAt: new Date(nowMs + request.leaseMs).toISOString(),
        },
      };
      await this.writeRecord(next);
      await this.appendEventLocked({
        runId: request.runId,
        revision: record.revision,
        actor: request.owner,
        type: 'run-claimed',
        idempotencyKey: `claim:${request.runId}:${request.owner}:${next.attempt}`,
        payload: { attempt: next.attempt, expiresAt: next.lease?.expiresAt ?? null },
        now,
      });
      return { claimed: true, record: next };
    });
  }

  async appendEvent(request: AppendRunEventRequest): Promise<RunEvent> {
    assertRunId(request.runId);
    assertText(request.actor, 'Actor');
    assertText(request.idempotencyKey, 'Idempotency key');
    return this.withLock(request.runId, async () => {
      const record = await this.requireRecord(request.runId);
      return this.appendEventLocked({
        ...request,
        revision: record.revision,
        type: request.type ?? 'run-event',
      });
    });
  }

  async transition(request: TransitionRunRequest): Promise<MechanicalRunRecord> {
    assertRunId(request.runId);
    assertText(request.owner, 'Owner');
    assertText(request.leaseToken, 'Lease token');
    assertText(request.idempotencyKey, 'Idempotency key');
    return this.withLock(request.runId, async () => {
      const record = await this.requireRecord(request.runId);
      const existing = (await this.readEvents(request.runId, record.revision)).find(
        (event) => event.idempotencyKey === request.idempotencyKey,
      );
      if (existing) {
        assert.equal(existing.payload.to, request.status, 'Idempotency key target changed.');
        for (const [key, value] of Object.entries(request.payload ?? {})) {
          assert.equal(existing.payload[key], value, 'Idempotency key payload changed.');
        }
        return record;
      }
      const now = request.now ?? new Date();
      assert.equal(record.status, 'RUNNING', 'Only a running lease can transition a run.');
      assert(record.lease, 'Run lease is missing.');
      assert.equal(record.lease.owner, request.owner, 'Run lease owner mismatch.');
      assert.equal(record.lease.token, request.leaseToken, 'Run lease token mismatch.');
      assert(Date.parse(record.lease.expiresAt) > now.getTime(), 'Run lease has expired.');
      const next: MechanicalRunRecord = {
        ...record,
        status: request.status,
        updatedAt: now.toISOString(),
        lease: isTerminal(request.status) ? null : record.lease,
      };
      await this.writeRecord(next);
      await this.appendEventLocked({
        runId: request.runId,
        revision: record.revision,
        actor: request.owner,
        type: 'run-status-changed',
        idempotencyKey: request.idempotencyKey,
        payload: { from: record.status, to: request.status, ...(request.payload ?? {}) },
        now,
      });
      return next;
    });
  }

  async events(runId: string): Promise<readonly RunEvent[]> {
    assertRunId(runId);
    const record = await this.requireRecord(runId);
    return this.readEvents(runId, record.revision);
  }

  private statePath(runId: string): string {
    return join(this.root, `${runId}.run.json`);
  }

  private eventPath(runId: string): string {
    return join(this.root, `${runId}.events.jsonl`);
  }

  private lockPath(runId: string): string {
    return join(this.root, `.${runId}.lock`);
  }

  private async readRecord(runId: string): Promise<MechanicalRunRecord | null> {
    try {
      return parseRecord(JSON.parse(await readFile(this.statePath(runId), 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async requireRecord(runId: string): Promise<MechanicalRunRecord> {
    const record = await this.readRecord(runId);
    assert(record, `Run ${runId} does not exist.`);
    return record;
  }

  private async writeRecord(record: MechanicalRunRecord): Promise<void> {
    const path = this.statePath(record.runId);
    const temporary = join(this.root, `.${record.runId}.${randomUUID()}.tmp`);
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

  private async readEvents(runId: string, revision: string): Promise<readonly RunEvent[]> {
    let body: string;
    try {
      body = await readFile(this.eventPath(runId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const events = body
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => parseEvent(JSON.parse(line)));
    events.forEach((event, index) => {
      assert.equal(event.runId, runId);
      assert.equal(event.revision, revision);
      assert.equal(event.sequence, index + 1, 'Run event sequence is not contiguous.');
    });
    return events;
  }

  private async appendEventLocked(input: AppendRunEventRequest & { readonly revision: string }): Promise<RunEvent> {
    const events = await this.readEvents(input.runId, input.revision);
    const existing = events.find((event) => event.idempotencyKey === input.idempotencyKey);
    if (existing) {
      assert.equal(canonical(existing.payload), canonical(input.payload ?? {}), 'Idempotency key payload changed.');
      return existing;
    }
    const event: RunEvent = {
      schema: 1,
      sequence: events.length + 1,
      runId: input.runId,
      revision: input.revision,
      type: input.type ?? 'run-event',
      idempotencyKey: input.idempotencyKey,
      actor: input.actor,
      at: (input.now ?? new Date()).toISOString(),
      payload: input.payload ?? {},
    };
    const file = await open(this.eventPath(input.runId), 'a', 0o600);
    try {
      await file.writeFile(`${canonical(event)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    return event;
  }

  private async withLock<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const path = this.lockPath(runId);
    let acquired = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        await mkdir(path, { mode: 0o700 });
        acquired = true;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    assert(acquired, `Could not acquire run lock for ${runId}.`);
    try {
      return await operation();
    } catch (error) {
      throw new Error(`Run store operation failed: ${message(error)}`, { cause: error });
    } finally {
      await rmdir(path).catch(() => undefined);
    }
  }
}
