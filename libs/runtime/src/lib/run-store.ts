import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  lstat,
  open,
  readFile,
  realpath,
  rename,
  rmdir,
  unlink,
} from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

export type MechanicalRunStatus =
  'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'BLOCKED' | 'CANCELLED';

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
  | 'run-lease-renewed'
  | 'run-cancellation-requested'
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

export interface RenewRunLeaseRequest {
  readonly runId: string;
  readonly owner: string;
  readonly leaseToken: string;
  readonly leaseMs: number;
  readonly idempotencyKey: string;
  readonly now?: Date;
}

export interface CancelRunRequest {
  readonly runId: string;
  readonly actor: string;
  readonly idempotencyKey: string;
  readonly now?: Date;
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
  reconcile(runId: string): Promise<MechanicalRunRecord | null>;
  claim(request: ClaimRunRequest): Promise<ClaimRunResult>;
  renew(request: RenewRunLeaseRequest): Promise<MechanicalRunRecord>;
  cancel(request: CancelRunRequest): Promise<MechanicalRunRecord>;
  cancellationRequested(runId: string): Promise<boolean>;
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
  assert(value.length > 0 && value.length <= 512, `${label} is required.`);
}

function assertLeaseMs(leaseMs: number): void {
  assert(
    Number.isInteger(leaseMs) && leaseMs > 0,
    'Lease duration must be positive.',
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertDate(value: Date): void {
  assert(Number.isFinite(value.getTime()), 'Timestamp must be valid.');
}

function isTerminal(status: MechanicalRunStatus): boolean {
  return (
    status === 'SUCCEEDED' ||
    status === 'FAILED' ||
    status === 'BLOCKED' ||
    status === 'CANCELLED'
  );
}

function parseRecord(value: unknown): MechanicalRunRecord {
  assert(value && typeof value === 'object', 'Run record must be an object.');
  const record = value as Partial<MechanicalRunRecord>;
  assert.equal(record.schema, 1);
  assert(typeof record.runId === 'string', 'Run record ID is missing.');
  assertRunId(record.runId);
  assert(typeof record.revision === 'string' && record.revision.length > 0);
  assert(typeof record.status === 'string', 'Run record status is missing.');
  assert(
    [
      'QUEUED',
      'RUNNING',
      'SUCCEEDED',
      'FAILED',
      'BLOCKED',
      'CANCELLED',
    ].includes(record.status),
  );
  const attempt = record.attempt as number | undefined;
  assert(Number.isInteger(attempt) && (attempt as number) >= 0);
  assert(
    typeof record.createdAt === 'string' &&
      typeof record.updatedAt === 'string',
  );
  assert(Number.isFinite(Date.parse(record.createdAt)));
  assert(Number.isFinite(Date.parse(record.updatedAt)));
  assert(
    record.lease === null || (record.lease && typeof record.lease === 'object'),
  );
  if (record.lease !== null) {
    const lease = record.lease as Partial<RunLease>;
    assert(typeof lease.owner === 'string' && lease.owner.length > 0);
    assert(typeof lease.token === 'string' && lease.token.length > 0);
    assert(typeof lease.acquiredAt === 'string');
    assert(typeof lease.expiresAt === 'string');
    assert(Number.isFinite(Date.parse(lease.acquiredAt)));
    assert(Number.isFinite(Date.parse(lease.expiresAt)));
  }
  if (record.status === 'RUNNING') assert(record.lease);
  if (record.status !== 'RUNNING') assert(record.lease === null);
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
  assert(
    event.type === 'run-created' ||
      event.type === 'run-claimed' ||
      event.type === 'run-lease-renewed' ||
      event.type === 'run-cancellation-requested' ||
      event.type === 'run-event' ||
      event.type === 'run-status-changed',
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
      'Run event payload is invalid.',
    );
  }
  return { ...event, sequence } as RunEvent;
}

type FailureInjectionStage =
  | 'after-sidecar-fsync'
  | 'after-state-publication'
  | 'after-event-publication'
  | 'after-sidecar-removal';

interface RunTransaction {
  readonly version: 1;
  readonly runId: string;
  readonly baseStateDigest: string | null;
  readonly baseEventDigest: string;
  readonly baseEventSequence: number;
  readonly nextState: MechanicalRunRecord;
  readonly nextEvents: readonly RunEvent[];
}

function assertDigest(value: unknown, label: string): asserts value is string {
  assert(
    typeof value === 'string' && /^[a-f0-9]{64}$/.test(value),
    `${label} is invalid.`,
  );
}

function assertRunHistory(
  runId: string,
  record: MechanicalRunRecord,
  events: readonly RunEvent[],
): void {
  assert(events.length > 0, `Run ${runId} event history is missing.`);
  const idempotencyKeys = new Set<string>();
  events.forEach((event, index) => {
    assert.equal(event.runId, runId);
    assert.equal(event.revision, record.revision);
    assert.equal(event.sequence, index + 1);
    assert(!idempotencyKeys.has(event.idempotencyKey));
    idempotencyKeys.add(event.idempotencyKey);
  });

  const created = events[0];
  assert(created);
  assert.equal(created.type, 'run-created');
  assert.equal(created.idempotencyKey, `create:${runId}:${record.revision}`);
  assert.equal(created.payload.status, 'QUEUED');

  let status: MechanicalRunStatus = 'QUEUED';
  let attempt = 0;
  let lastClaim: RunEvent | null = null;
  let lastLease: RunEvent | null = null;
  let lastStatusChange: RunEvent | null = null;
  let cancellationRequested = false;
  for (const event of events.slice(1)) {
    if (event.type === 'run-claimed') {
      attempt += 1;
      assert.equal(event.payload.attempt, attempt);
      assert(typeof event.payload.expiresAt === 'string');
      assert(Number.isFinite(Date.parse(event.payload.expiresAt)));
      status = 'RUNNING';
      lastClaim = event;
      lastLease = event;
      continue;
    }
    if (event.type === 'run-lease-renewed') {
      assert.equal(status, 'RUNNING');
      assert.equal(event.payload.attempt, attempt);
      assert(typeof event.payload.expiresAt === 'string');
      assert(Number.isFinite(Date.parse(event.payload.expiresAt)));
      lastLease = event;
      continue;
    }
    if (event.type === 'run-cancellation-requested') {
      assert.equal(status, 'RUNNING');
      assert(!cancellationRequested, 'Run cancellation was requested twice.');
      assert.equal(event.payload.requested, true);
      cancellationRequested = true;
      continue;
    }
    if (event.type === 'run-status-changed') {
      assert.equal(event.payload.from, status);
      assert(typeof event.payload.to === 'string');
      assert(
        [
          'QUEUED',
          'RUNNING',
          'SUCCEEDED',
          'FAILED',
          'BLOCKED',
          'CANCELLED',
        ].includes(event.payload.to),
      );
      status = event.payload.to as MechanicalRunStatus;
      lastStatusChange = event;
    }
  }

  assert.equal(attempt, record.attempt, 'Run attempt changed independently.');
  assert.equal(status, record.status, 'Run status changed independently.');
  if (record.status === 'RUNNING') {
    assert(record.lease);
    assert(lastClaim, 'Running run lease has no claim witness.');
    assert(lastLease, 'Running run lease has no lease witness.');
    assert.equal(lastLease.actor, record.lease.owner);
    assert.equal(lastLease.payload.expiresAt, record.lease.expiresAt);
  } else if (isTerminal(record.status)) {
    assert(lastStatusChange, 'Terminal run has no status-change witness.');
    assert.equal(lastStatusChange.payload.to, record.status);
    assert.equal(record.lease, null);
  } else {
    assert.equal(record.lease, null);
  }
}

function parseTransaction(value: unknown, runId: string): RunTransaction {
  assert(value && typeof value === 'object', 'Run transaction is invalid.');
  const transaction = value as Partial<RunTransaction>;
  assert.equal(transaction.version, 1);
  assert.equal(transaction.runId, runId);
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
  assert.equal(nextState.runId, runId);
  assert(Array.isArray(transaction.nextEvents));
  const nextEvents = transaction.nextEvents.map(parseEvent);
  assertRunHistory(runId, nextState, nextEvents);
  assert(nextEvents.length > (transaction.baseEventSequence as number));
  return {
    version: 1,
    runId,
    baseStateDigest: transaction.baseStateDigest as string | null,
    baseEventDigest: transaction.baseEventDigest as string,
    baseEventSequence: transaction.baseEventSequence as number,
    nextState,
    nextEvents,
  };
}

export class FileWorkflowRunStore implements WorkflowRunStore {
  private static failureInjection: FailureInjectionStage | null = null;

  private constructor(private readonly root: string) {}

  static async create(root: string): Promise<FileWorkflowRunStore> {
    assert(isAbsolute(root), 'Run store root must be absolute.');
    await mkdir(root, { recursive: true, mode: 0o700 });
    return new FileWorkflowRunStore(await realpath(root));
  }

  async create(request: CreateRunRequest): Promise<MechanicalRunRecord> {
    assertRunId(request.runId);
    assertText(request.revision, 'Revision');
    assertText(request.actor, 'Actor');
    return this.withLock(request.runId, async () => {
      await this.reconcileLocked(request.runId);
      const existing = await this.readRecord(request.runId);
      if (existing) {
        assert.equal(
          existing.revision,
          request.revision,
          'Run ID is bound to another revision.',
        );
        return existing;
      }
      const now = request.now ?? new Date();
      assertDate(now);
      const at = now.toISOString();
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
      const events = [
        this.createEvent({
          sequence: 1,
          runId: request.runId,
          revision: request.revision,
          actor: request.actor,
          type: 'run-created',
          idempotencyKey: `create:${request.runId}:${request.revision}`,
          payload: { status: 'QUEUED' },
          now,
        }),
      ];
      await this.commitTransitionLocked({
        runId: request.runId,
        baseState: null,
        baseEvents: [],
        nextState: record,
        nextEvents: events,
      });
      return record;
    });
  }

  async load(runId: string): Promise<MechanicalRunRecord | null> {
    assertRunId(runId);
    return this.withLock(runId, async () => {
      await this.reconcileLocked(runId);
      return this.readRecord(runId);
    });
  }

  async reconcile(runId: string): Promise<MechanicalRunRecord | null> {
    assertRunId(runId);
    return this.withLock(runId, () => this.reconcileLocked(runId));
  }

  async claim(request: ClaimRunRequest): Promise<ClaimRunResult> {
    assertRunId(request.runId);
    assertText(request.owner, 'Owner');
    assertLeaseMs(request.leaseMs);
    return this.withLock(request.runId, async () => {
      await this.reconcileLocked(request.runId);
      const record = await this.requireRecord(request.runId);
      const now = request.now ?? new Date();
      assertDate(now);
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
      const events = await this.readEvents(request.runId, record.revision);
      const event = this.createEvent({
        sequence: events.length + 1,
        runId: request.runId,
        revision: record.revision,
        actor: request.owner,
        type: 'run-claimed',
        idempotencyKey: `claim:${request.runId}:${request.owner}:${next.attempt}`,
        payload: {
          attempt: next.attempt,
          expiresAt: next.lease?.expiresAt ?? null,
        },
        now,
      });
      await this.commitTransitionLocked({
        runId: request.runId,
        baseState: record,
        baseEvents: events,
        nextState: next,
        nextEvents: [...events, event],
      });
      return { claimed: true, record: next };
    });
  }

  async appendEvent(request: AppendRunEventRequest): Promise<RunEvent> {
    assertRunId(request.runId);
    assertText(request.actor, 'Actor');
    assertText(request.idempotencyKey, 'Idempotency key');
    return this.withLock(request.runId, async () => {
      await this.reconcileLocked(request.runId);
      const record = await this.requireRecord(request.runId);
      return this.appendEventLocked(record, {
        ...request,
        revision: record.revision,
        type: request.type ?? 'run-event',
      });
    });
  }

  async renew(request: RenewRunLeaseRequest): Promise<MechanicalRunRecord> {
    assertRunId(request.runId);
    assertText(request.owner, 'Owner');
    assertText(request.leaseToken, 'Lease token');
    assertLeaseMs(request.leaseMs);
    assertText(request.idempotencyKey, 'Idempotency key');
    return this.withLock(request.runId, async () => {
      await this.reconcileLocked(request.runId);
      const record = await this.requireRecord(request.runId);
      const events = await this.readEvents(request.runId, record.revision);
      const existing = events.find(
        (event) => event.idempotencyKey === request.idempotencyKey,
      );
      if (existing) {
        assert.equal(
          existing.type,
          'run-lease-renewed',
          'Idempotency key was used for another run event.',
        );
        assert.equal(existing.payload.attempt, record.attempt);
        return record;
      }
      const now = request.now ?? new Date();
      assertDate(now);
      assert.equal(
        record.status,
        'RUNNING',
        'Only a running lease can be renewed.',
      );
      assert(record.lease, 'Run lease is missing.');
      assert.equal(
        record.lease.owner,
        request.owner,
        'Run lease owner mismatch.',
      );
      assert.equal(
        record.lease.token,
        request.leaseToken,
        'Run lease token mismatch.',
      );
      assert(
        Date.parse(record.lease.expiresAt) > now.getTime(),
        'Run lease has expired.',
      );
      const next: MechanicalRunRecord = {
        ...record,
        updatedAt: now.toISOString(),
        lease: {
          ...record.lease,
          expiresAt: new Date(now.getTime() + request.leaseMs).toISOString(),
        },
      };
      const expiresAt = next.lease?.expiresAt;
      assert(expiresAt);
      const event = this.createEvent({
        sequence: events.length + 1,
        runId: request.runId,
        revision: record.revision,
        actor: request.owner,
        type: 'run-lease-renewed',
        idempotencyKey: request.idempotencyKey,
        payload: {
          attempt: record.attempt,
          expiresAt,
        },
        now,
      });
      await this.commitTransitionLocked({
        runId: request.runId,
        baseState: record,
        baseEvents: events,
        nextState: next,
        nextEvents: [...events, event],
      });
      return next;
    });
  }

  async cancel(request: CancelRunRequest): Promise<MechanicalRunRecord> {
    assertRunId(request.runId);
    assertText(request.actor, 'Actor');
    assertText(request.idempotencyKey, 'Idempotency key');
    return this.withLock(request.runId, async () => {
      await this.reconcileLocked(request.runId);
      const record = await this.requireRecord(request.runId);
      if (isTerminal(record.status)) return record;
      const events = await this.readEvents(request.runId, record.revision);
      const existing = events.find(
        (event) => event.idempotencyKey === request.idempotencyKey,
      );
      if (existing) {
        assert(
          existing.type === 'run-cancellation-requested' ||
            (existing.type === 'run-status-changed' &&
              existing.payload.reason === 'cancellation-requested'),
          'Idempotency key was used for another run event.',
        );
        return record;
      }
      if (events.some((event) => event.type === 'run-cancellation-requested')) {
        return record;
      }
      const now = request.now ?? new Date();
      assertDate(now);
      if (record.status === 'QUEUED') {
        const next: MechanicalRunRecord = {
          ...record,
          status: 'CANCELLED',
          updatedAt: now.toISOString(),
          lease: null,
        };
        const event = this.createEvent({
          sequence: events.length + 1,
          runId: request.runId,
          revision: record.revision,
          actor: request.actor,
          type: 'run-status-changed',
          idempotencyKey: request.idempotencyKey,
          payload: {
            from: record.status,
            to: 'CANCELLED',
            reason: 'cancellation-requested',
          },
          now,
        });
        await this.commitTransitionLocked({
          runId: request.runId,
          baseState: record,
          baseEvents: events,
          nextState: next,
          nextEvents: [...events, event],
        });
        return next;
      }

      assert.equal(record.status, 'RUNNING');
      assert(record.lease, 'Running run lease is missing.');
      const event = this.createEvent({
        sequence: events.length + 1,
        runId: request.runId,
        revision: record.revision,
        actor: request.actor,
        type: 'run-cancellation-requested',
        idempotencyKey: request.idempotencyKey,
        payload: { requested: true },
        now,
      });
      await this.commitTransitionLocked({
        runId: request.runId,
        baseState: record,
        baseEvents: events,
        nextState: record,
        nextEvents: [...events, event],
      });
      return record;
    });
  }

  async cancellationRequested(runId: string): Promise<boolean> {
    assertRunId(runId);
    return this.withLock(runId, async () => {
      await this.reconcileLocked(runId);
      const record = await this.requireRecord(runId);
      if (record.status === 'CANCELLED') return true;
      const events = await this.readEvents(runId, record.revision);
      return events.some(
        (event) =>
          event.type === 'run-cancellation-requested' ||
          (event.type === 'run-status-changed' &&
            event.payload.reason === 'cancellation-requested'),
      );
    });
  }

  async transition(
    request: TransitionRunRequest,
  ): Promise<MechanicalRunRecord> {
    assertRunId(request.runId);
    assertText(request.owner, 'Owner');
    assertText(request.leaseToken, 'Lease token');
    assertText(request.idempotencyKey, 'Idempotency key');
    return this.withLock(request.runId, async () => {
      await this.reconcileLocked(request.runId);
      const record = await this.requireRecord(request.runId);
      const existing = (
        await this.readEvents(request.runId, record.revision)
      ).find((event) => event.idempotencyKey === request.idempotencyKey);
      if (existing) {
        assert.equal(
          existing.payload.to,
          request.status,
          'Idempotency key target changed.',
        );
        for (const [key, value] of Object.entries(request.payload ?? {})) {
          assert.equal(
            existing.payload[key],
            value,
            'Idempotency key payload changed.',
          );
        }
        return record;
      }
      const now = request.now ?? new Date();
      assertDate(now);
      assert.equal(
        record.status,
        'RUNNING',
        'Only a running lease can transition a run.',
      );
      assert(record.lease, 'Run lease is missing.');
      assert.equal(
        record.lease.owner,
        request.owner,
        'Run lease owner mismatch.',
      );
      assert.equal(
        record.lease.token,
        request.leaseToken,
        'Run lease token mismatch.',
      );
      assert(
        Date.parse(record.lease.expiresAt) > now.getTime(),
        'Run lease has expired.',
      );
      const next: MechanicalRunRecord = {
        ...record,
        status: request.status,
        updatedAt: now.toISOString(),
        lease: isTerminal(request.status) ? null : record.lease,
      };
      const events = await this.readEvents(request.runId, record.revision);
      const event = this.createEvent({
        sequence: events.length + 1,
        runId: request.runId,
        revision: record.revision,
        actor: request.owner,
        type: 'run-status-changed',
        idempotencyKey: request.idempotencyKey,
        payload: {
          from: record.status,
          to: request.status,
          ...(request.payload ?? {}),
        },
        now,
      });
      await this.commitTransitionLocked({
        runId: request.runId,
        baseState: record,
        baseEvents: events,
        nextState: next,
        nextEvents: [...events, event],
      });
      return next;
    });
  }

  async events(runId: string): Promise<readonly RunEvent[]> {
    assertRunId(runId);
    return this.withLock(runId, async () => {
      await this.reconcileLocked(runId);
      const record = await this.requireRecord(runId);
      return this.readEvents(runId, record.revision);
    });
  }

  private statePath(runId: string): string {
    return join(this.root, `${runId}.run.json`);
  }

  private eventPath(runId: string): string {
    return join(this.root, `${runId}.events.jsonl`);
  }

  private transactionPath(runId: string): string {
    return join(this.root, `.${runId}.transaction.json`);
  }

  private lockPath(runId: string): string {
    return join(this.root, `.${runId}.lock`);
  }

  private async readRecord(runId: string): Promise<MechanicalRunRecord | null> {
    try {
      return parseRecord(
        JSON.parse(await readFile(this.statePath(runId), 'utf8')),
      );
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

  private async readTransaction(runId: string): Promise<RunTransaction | null> {
    try {
      return parseTransaction(
        JSON.parse(await readFile(this.transactionPath(runId), 'utf8')),
        runId,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async reconcileLocked(
    runId: string,
  ): Promise<MechanicalRunRecord | null> {
    const transaction = await this.readTransaction(runId);
    const currentState = await this.readRecord(runId);
    const currentEvents = await this.readEvents(runId);
    if (!transaction) {
      if (!currentState) {
        assert(
          currentEvents.length === 0,
          `Run ${runId} is missing its state.`,
        );
        return null;
      }
      assertRunHistory(runId, currentState, currentEvents);
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
      await this.removeTransaction(runId);
      return transaction.nextState;
    }
    if (baseState && nextEvents && !nextState) {
      throw new Error('Run state conflicts with its transaction.');
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
      throw new Error('Run transaction base digest conflict.');
    }
    if (nextState && !nextEvents) {
      throw new Error('Run transaction event publication is ambiguous.');
    }
    throw new Error('Run transaction state is ambiguous.');
  }

  private async commitTransitionLocked(input: {
    readonly runId: string;
    readonly baseState: MechanicalRunRecord | null;
    readonly baseEvents: readonly RunEvent[];
    readonly nextState: MechanicalRunRecord;
    readonly nextEvents: readonly RunEvent[];
  }): Promise<void> {
    assertRunHistory(input.runId, input.nextState, input.nextEvents);
    assert.equal(
      input.baseEvents.length,
      input.nextEvents.length - 1,
      'Run transition must append exactly one event.',
    );
    const transaction: RunTransaction = {
      version: 1,
      runId: input.runId,
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

  private async publishTransaction(transaction: RunTransaction): Promise<void> {
    await this.writeRecord(transaction.nextState);
    this.injectFailure('after-state-publication');
    await this.writeEvents(transaction.runId, transaction.nextEvents);
    this.injectFailure('after-event-publication');
    await this.removeTransaction(transaction.runId);
    this.injectFailure('after-sidecar-removal');
  }

  private async removeTransaction(runId: string): Promise<void> {
    await unlink(this.transactionPath(runId)).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }

  private injectFailure(stage: FailureInjectionStage): void {
    if (FileWorkflowRunStore.failureInjection !== stage) return;
    FileWorkflowRunStore.failureInjection = null;
    throw new Error(`Injected run store interruption at ${stage}.`);
  }

  private async writeTransaction(transaction: RunTransaction): Promise<void> {
    await this.writeFileAtomic(
      this.transactionPath(transaction.runId),
      canonical(transaction),
    );
  }

  private async writeRecord(record: MechanicalRunRecord): Promise<void> {
    await this.writeFileAtomic(this.statePath(record.runId), canonical(record));
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
    runId: string,
    revision?: string,
  ): Promise<readonly RunEvent[]> {
    let body: string;
    try {
      body = await readFile(this.eventPath(runId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    if (body.length === 0) return [];
    const lines = body.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    assert(
      lines.every((line) => line.length > 0),
      'Run event log contains a blank or partial JSONL record.',
    );
    const events = lines.map((line) => parseEvent(JSON.parse(line)));
    events.forEach((event, index) => {
      assert.equal(event.runId, runId);
      if (revision !== undefined) assert.equal(event.revision, revision);
      assert.equal(
        event.sequence,
        index + 1,
        'Run event sequence is not contiguous.',
      );
    });
    return events;
  }

  private async writeEvents(
    runId: string,
    events: readonly RunEvent[],
  ): Promise<void> {
    await this.writeFileAtomic(
      this.eventPath(runId),
      events.map((event) => canonical(event)).join('\n') + '\n',
    );
  }

  private createEvent(input: {
    readonly sequence: number;
    readonly runId: string;
    readonly revision: string;
    readonly type: RunEventType;
    readonly idempotencyKey: string;
    readonly actor: string;
    readonly payload: RunEventPayload;
    readonly now: Date;
  }): RunEvent {
    assertDate(input.now);
    return {
      schema: 1,
      sequence: input.sequence,
      runId: input.runId,
      revision: input.revision,
      type: input.type,
      idempotencyKey: input.idempotencyKey,
      actor: input.actor,
      at: input.now.toISOString(),
      payload: input.payload,
    };
  }

  private async appendEventLocked(
    record: MechanicalRunRecord,
    input: AppendRunEventRequest & { readonly revision: string },
  ): Promise<RunEvent> {
    const events = await this.readEvents(input.runId, input.revision);
    const existing = events.find(
      (event) => event.idempotencyKey === input.idempotencyKey,
    );
    if (existing) {
      assert.equal(
        canonical(existing.payload),
        canonical(input.payload ?? {}),
        'Idempotency key payload changed.',
      );
      return existing;
    }
    const event = this.createEvent({
      sequence: events.length + 1,
      runId: input.runId,
      revision: input.revision,
      type: input.type ?? 'run-event',
      idempotencyKey: input.idempotencyKey,
      actor: input.actor,
      payload: input.payload ?? {},
      now: input.now ?? new Date(),
    });
    await this.commitTransitionLocked({
      runId: input.runId,
      baseState: record,
      baseEvents: events,
      nextState: record,
      nextEvents: [...events, event],
    });
    return event;
  }

  private async withLock<T>(
    runId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const path = this.lockPath(runId);
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
    assert(acquired, `Could not acquire run lock for ${runId}.`);
    try {
      return await operation();
    } catch (error) {
      throw new Error(`Run store operation failed: ${message(error)}`, {
        cause: error,
      });
    } finally {
      await rmdir(path).catch(() => undefined);
    }
  }
}
