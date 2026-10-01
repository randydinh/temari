import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** Calendar times are exact UTC instants. Recurrence is an anchored elapsed
 * interval, with no timezone, cron, daylight-saving or wall-clock ambiguity. */
export type ScheduleCadence =
  | { readonly kind: 'once'; readonly at: string }
  | { readonly kind: 'interval'; readonly anchor: string; readonly everyMs: number };
export interface ScheduleTarget {
  readonly id: string;
  readonly title: string;
  readonly goal: string;
  /** Digest of the host-configured recipe, including its executable checks. */
  readonly pin: string;
}
export type ScheduleStatus = 'ACTIVE' | 'PAUSED' | 'CANCELLED';
export type ScheduleOccurrenceState =
  | 'INTENT' | 'PREPARED' | 'STARTING' | 'ACTIVE' | 'TERMINAL'
  | 'UNCERTAIN' | 'SKIPPED_OVERLAP' | 'CANCELLED';
export interface ScheduleOccurrence {
  readonly id: string;
  readonly dueAt: string;
  /** Older due times deliberately coalesced into this latest occurrence. */
  readonly coalescedCount: number;
  readonly requestId: string;
  readonly taskId: string;
  readonly startRequestId: string;
  readonly expectedVersion: number | null;
  readonly state: ScheduleOccurrenceState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly issue: string | null;
}
export interface ScheduleEvent {
  readonly version: number;
  readonly at: string;
  readonly kind: 'created' | 'paused' | 'resumed' | 'cancelled' | 'occurrence';
  readonly requestId: string;
  readonly digest: string;
}
export interface ScheduleRecord {
  readonly schema: 1;
  readonly id: string;
  readonly workspaceRoot: string;
  readonly version: number;
  readonly status: ScheduleStatus;
  readonly target: ScheduleTarget;
  readonly cadence: ScheduleCadence;
  readonly missedPolicy: 'coalesce-latest';
  readonly overlapPolicy: 'skip';
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastDueAt: string | null;
  readonly occurrences: readonly ScheduleOccurrence[];
  readonly events: readonly ScheduleEvent[];
}
export interface CreateScheduleRequest {
  readonly requestId: string;
  readonly target: ScheduleTarget;
  readonly cadence: ScheduleCadence;
}
export interface UpdateScheduleRequest {
  readonly requestId: string;
  readonly expectedVersion: number;
  readonly action: 'pause' | 'resume' | 'cancel';
}
interface Ledger {
  schema: 1;
  kind: 'temari-schedule-store';
  workspaceRoot: string;
  schedules: ScheduleRecord[];
}
interface LockOwner { schema: 1; host: string; pid: number; token: string }
const MAX_SCHEDULES = 128;
const MAX_OCCURRENCES = 2048;
const MAX_EVENTS = 8192;
const MAX_BYTES = 32 * 1024 * 1024;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function scheduleDigest(value: unknown): string {
  const canonical = (item: unknown): string => {
    if (Array.isArray(item)) return `[${item.map(canonical).join(',')}]`;
    if (item && typeof item === 'object')
      return `{${Object.entries(item).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
    return JSON.stringify(item);
  };
  return createHash('sha256').update(canonical(value)).digest('hex');
}
export function assertScheduleId(value: unknown): asserts value is string {
  assert(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(value), 'Invalid schedule ID.');
}
export function assertScheduleRequestId(value: unknown): asserts value is string {
  assert(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value), 'Invalid schedule request ID.');
}
function object(value: unknown, allowed: string[]): asserts value is Record<string, unknown> {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Expected schedule object.');
  assert(Object.keys(value).every((key) => allowed.includes(key)), 'Unexpected schedule field.');
}
function text(value: unknown, max: number): asserts value is string {
  assert(typeof value === 'string' && value.trim().length && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value), 'Invalid schedule text.');
}
export function assertScheduleInstant(value: unknown): asserts value is string {
  assert(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, 'Schedule time must be an exact UTC ISO instant.');
}
export function parseScheduleCadence(value: unknown): ScheduleCadence {
  object(value, ['kind', 'at', 'anchor', 'everyMs']);
  if (value.kind === 'once') {
    object(value, ['kind', 'at']);
    assertScheduleInstant(value.at);
    return { kind: 'once', at: value.at };
  }
  object(value, ['kind', 'anchor', 'everyMs']);
  assert.equal(value.kind, 'interval', 'Unknown schedule cadence.');
  assertScheduleInstant(value.anchor);
  assert(Number.isSafeInteger(value.everyMs) && (value.everyMs as number) >= 60_000
    && (value.everyMs as number) <= 366 * 24 * 60 * 60_000, 'Schedule interval must be between one minute and 366 days.');
  return { kind: 'interval', anchor: value.anchor, everyMs: value.everyMs as number };
}
export function assertScheduleTarget(value: ScheduleTarget): void {
  object(value, ['id', 'title', 'goal', 'pin']);
  assertScheduleId(value.id);
  text(value.title, 256);
  text(value.goal, 8192);
  assert(/^[a-f0-9]{64}$/.test(value.pin), 'Invalid schedule target pin.');
}
export function scheduleOccurrenceIdentity(scheduleId: string, dueAt: string) {
  assertScheduleId(scheduleId);
  assertScheduleInstant(dueAt);
  const digest = scheduleDigest({ scheduleId, dueAt }).slice(0, 40);
  return { id: `occ-${digest}`, requestId: `scheduled-${digest}`, taskId: `task-scheduled-${digest}`, startRequestId: `start-${digest}` };
}
function recordValid(record: ScheduleRecord, workspaceRoot: string): void {
  object(record, ['schema', 'id', 'workspaceRoot', 'version', 'status', 'target', 'cadence', 'missedPolicy', 'overlapPolicy', 'createdAt', 'updatedAt', 'lastDueAt', 'occurrences', 'events']);
  assert.equal(record.schema, 1);
  assertScheduleId(record.id);
  assert.equal(record.workspaceRoot, workspaceRoot, 'Schedule workspace binding changed.');
  assert(Number.isSafeInteger(record.version) && record.version >= 1);
  assert(['ACTIVE', 'PAUSED', 'CANCELLED'].includes(record.status));
  assertScheduleTarget(record.target);
  parseScheduleCadence(record.cadence);
  assert.equal(record.missedPolicy, 'coalesce-latest');
  assert.equal(record.overlapPolicy, 'skip');
  assertScheduleInstant(record.createdAt);
  assertScheduleInstant(record.updatedAt);
  if (record.lastDueAt !== null) assertScheduleInstant(record.lastDueAt);
  assert(Array.isArray(record.occurrences) && record.occurrences.length <= MAX_OCCURRENCES);
  const ids = new Set<string>();
  let previousDue = -Infinity;
  const occurrences = record.occurrences as readonly ScheduleOccurrence[];
  for (const occurrence of occurrences) {
    object(occurrence, ['id', 'dueAt', 'coalescedCount', 'requestId', 'taskId', 'startRequestId', 'expectedVersion', 'state', 'createdAt', 'updatedAt', 'issue']);
    const identity = scheduleOccurrenceIdentity(record.id, occurrence.dueAt);
    for (const key of ['id', 'requestId', 'taskId', 'startRequestId'] as const) assert.equal(occurrence[key], identity[key], 'Schedule occurrence identity changed.');
    assert(!ids.has(occurrence.id), 'Duplicate schedule occurrence.');
    ids.add(occurrence.id);
    const due = Date.parse(occurrence.dueAt);
    assert(due > previousDue, 'Schedule occurrences are not monotonic.');
    previousDue = due;
    if (record.cadence.kind === 'once') assert.equal(occurrence.dueAt, record.cadence.at, 'Once occurrence differs from its scheduled time.');
    else {
      const elapsed = due - Date.parse(record.cadence.anchor);
      assert(elapsed >= 0 && elapsed % record.cadence.everyMs === 0, 'Occurrence is not aligned to its anchored interval.');
    }
    assert(Number.isSafeInteger(occurrence.coalescedCount) && occurrence.coalescedCount >= 0);
    assert(occurrence.expectedVersion === null || (Number.isSafeInteger(occurrence.expectedVersion) && occurrence.expectedVersion >= 1));
    assert(['INTENT', 'PREPARED', 'STARTING', 'ACTIVE', 'TERMINAL', 'UNCERTAIN', 'SKIPPED_OVERLAP', 'CANCELLED'].includes(occurrence.state));
    if (['STARTING', 'ACTIVE'].includes(occurrence.state)) assert(occurrence.expectedVersion !== null, 'Dispatch version is missing.');
    assertScheduleInstant(occurrence.createdAt);
    assertScheduleInstant(occurrence.updatedAt);
    if (occurrence.issue !== null) text(occurrence.issue, 4096);
  }
  assert(record.lastDueAt === (record.occurrences.at(-1)?.dueAt ?? null), 'Schedule cursor differs from retained occurrences.');
  assert(Array.isArray(record.events) && record.events.length === record.version && record.events.length <= MAX_EVENTS);
  const commandIds = new Set<string>();
  const events = record.events as readonly ScheduleEvent[];
  for (const [index, event] of events.entries()) {
    object(event, ['version', 'at', 'kind', 'requestId', 'digest']);
    assert.equal(event.version, index + 1, 'Schedule event sequence is corrupt.');
    assertScheduleInstant(event.at);
    assert(['created', 'paused', 'resumed', 'cancelled', 'occurrence'].includes(event.kind));
    assertScheduleRequestId(event.requestId);
    assert(!commandIds.has(event.requestId), 'Duplicate schedule command.');
    commandIds.add(event.requestId);
    assert(/^[a-f0-9]{64}$/.test(event.digest));
  }
}
function ownerValid(value: unknown): asserts value is LockOwner {
  object(value, ['schema', 'host', 'pid', 'token']);
  assert.equal(value.schema, 1);
  text(value.host, 256);
  assert(Number.isSafeInteger(value.pid) && (value.pid as number) > 0);
  assert(typeof value.token === 'string' && /^[a-f0-9-]{36}$/.test(value.token));
}
function dead(owner: LockOwner): boolean {
  if (owner.host !== hostname()) return false;
  try { process.kill(owner.pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}

/** The clock ledger only owns scheduling intent and occurrence links. Task/run
 * evidence and semantic completion remain in the canonical task runtime. */
export class FileScheduleStore {
  private constructor(readonly root: string, readonly workspaceRoot: string) {}
  static async create(root: string, workspaceRoot: string): Promise<FileScheduleStore> {
    assert(isAbsolute(root) && isAbsolute(workspaceRoot), 'Schedule paths must be absolute.');
    const resolvedWorkspace = await realpath(workspaceRoot);
    assert((await lstat(resolvedWorkspace)).isDirectory(), 'Schedule workspace must be a directory.');
    await mkdir(root, { recursive: true, mode: 0o700 });
    assert((await lstat(root)).isDirectory() && !(await lstat(root)).isSymbolicLink(), 'Schedule store must be a real directory.');
    const store = new FileScheduleStore(await realpath(root), resolvedWorkspace);
    await store.withLock('.write.lock', async () => {
      let marker: unknown;
      try { marker = JSON.parse(await store.readFile('.schedule-store.json', 1024)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        assert((await readdir(store.root)).every((entry) => entry === '.write.lock'), 'Schedule store marker is missing from a nonempty directory.');
        // Publish the independent marker first: a later missing ledger can never
        // silently reset occurrence history and cause duplicate dispatch.
        await store.publishFile('.schedule-store.json', JSON.stringify({ schema: 1, kind: 'temari-schedule-store', workspaceRoot: resolvedWorkspace }));
        await store.publish({ schema: 1, kind: 'temari-schedule-store', workspaceRoot: resolvedWorkspace, schedules: [] });
        return;
      }
      assert.deepEqual(marker, { schema: 1, kind: 'temari-schedule-store', workspaceRoot: resolvedWorkspace }, 'Schedule store marker/workspace is invalid.');
      await store.read();
    });
    return store;
  }
  async list(): Promise<readonly ScheduleRecord[]> { return (await this.read()).schedules; }
  async get(id: string): Promise<ScheduleRecord | null> {
    assertScheduleId(id);
    return (await this.list()).find((record) => record.id === id) ?? null;
  }
  async createSchedule(request: CreateScheduleRequest, now = new Date()): Promise<ScheduleRecord> {
    object(request, ['requestId', 'target', 'cadence']);
    assertScheduleRequestId(request.requestId);
    assertScheduleTarget(request.target);
    const cadence = parseScheduleCadence(request.cadence);
    const at = now.toISOString();
    const id = `schedule-${request.requestId}`;
    return this.change(async (ledger) => {
      const existing = ledger.schedules.find((record) => record.id === id);
      const digest = scheduleDigest({ ...request, cadence });
      if (existing) {
        assert.equal(existing.events[0].digest, digest, 'Schedule creation idempotency conflict.');
        return existing;
      }
      assert(ledger.schedules.length < MAX_SCHEDULES, 'Schedule store limit reached; preserve/archive its history before creating another schedule.');
      const record: ScheduleRecord = {
        schema: 1, id, workspaceRoot: this.workspaceRoot, version: 1, status: 'ACTIVE',
        target: structuredClone(request.target), cadence, missedPolicy: 'coalesce-latest', overlapPolicy: 'skip',
        createdAt: at, updatedAt: at, lastDueAt: null, occurrences: [],
        events: [{ version: 1, at, kind: 'created', requestId: request.requestId, digest }],
      };
      ledger.schedules.push(record);
      return record;
    });
  }
  async update(id: string, request: UpdateScheduleRequest, now = new Date()): Promise<ScheduleRecord> {
    assertScheduleId(id);
    object(request, ['requestId', 'expectedVersion', 'action']);
    assertScheduleRequestId(request.requestId);
    assert(Number.isSafeInteger(request.expectedVersion) && request.expectedVersion >= 1);
    assert(['pause', 'resume', 'cancel'].includes(request.action), 'Unknown schedule action.');
    return this.change(async (ledger) => {
      const index = ledger.schedules.findIndex((record) => record.id === id);
      assert(index !== -1, 'Schedule does not exist.');
      const record = ledger.schedules[index];
      const digest = scheduleDigest(request);
      const duplicate = record.events.find((event) => event.requestId === request.requestId);
      if (duplicate) { assert.equal(duplicate.digest, digest, 'Schedule command idempotency conflict.'); return record; }
      // Operator intent changes future scheduling settings. Execution telemetry
      // may advance after the browser reads them without changing those settings.
      // Accept only that drift; never overwrite an intervening operator command
      // or accept a version the store has not actually published.
      assert(request.expectedVersion <= record.version &&
        record.events.slice(request.expectedVersion).every((event) => event.kind === 'occurrence'),
        'Schedule version conflict; refresh before changing its controls.');
      assert(record.status !== 'CANCELLED', 'Cancelled schedules cannot be resumed; create a new schedule.');
      const status: ScheduleStatus = request.action === 'pause' ? 'PAUSED' : request.action === 'resume' ? 'ACTIVE' : 'CANCELLED';
      assert(record.status !== status, 'Schedule already has the requested status.');
      const at = now.toISOString();
      const updated = this.event(record, { status, updatedAt: at }, { kind: request.action === 'pause' ? 'paused' : request.action === 'resume' ? 'resumed' : 'cancelled', at, requestId: request.requestId, digest });
      ledger.schedules[index] = updated;
      return updated;
    });
  }
  async claimOccurrence(id: string, dueAt: string, coalescedCount: number, state: 'INTENT' | 'SKIPPED_OVERLAP', issue: string | null, now = new Date()): Promise<ScheduleOccurrence | null> {
    assertScheduleId(id);
    assertScheduleInstant(dueAt);
    assert(Number.isSafeInteger(coalescedCount) && coalescedCount >= 0);
    assert(['INTENT', 'SKIPPED_OVERLAP'].includes(state));
    if (issue !== null) text(issue, 4096);
    return this.change(async (ledger) => {
      const index = ledger.schedules.findIndex((record) => record.id === id);
      assert(index !== -1, 'Schedule does not exist.');
      const record = ledger.schedules[index];
      const existing = record.occurrences.find((occurrence) => occurrence.dueAt === dueAt);
      if (existing) return existing;
      if (record.status !== 'ACTIVE' || (record.lastDueAt && Date.parse(record.lastDueAt) >= Date.parse(dueAt))) return null;
      assert(record.occurrences.length < MAX_OCCURRENCES, 'Schedule occurrence history limit reached; dispatch is blocked to preserve recovery evidence.');
      const at = now.toISOString();
      const occurrence: ScheduleOccurrence = { ...scheduleOccurrenceIdentity(id, dueAt), dueAt, coalescedCount, state, expectedVersion: null, createdAt: at, updatedAt: at, issue };
      ledger.schedules[index] = this.event(record, { lastDueAt: dueAt, updatedAt: at, occurrences: [...record.occurrences, occurrence] }, { kind: 'occurrence', at, requestId: randomUUID(), digest: scheduleDigest(occurrence) });
      return occurrence;
    });
  }
  async updateOccurrence(id: string, occurrenceId: string, patch: {
    readonly state: ScheduleOccurrenceState;
    readonly issue: string | null;
    readonly expectedVersion?: number;
  }, now = new Date()): Promise<ScheduleOccurrence> {
    assertScheduleId(id);
    object(patch, ['state', 'issue', 'expectedVersion']);
    if (patch.issue !== null) text(patch.issue, 4096);
    return this.change(async (ledger) => {
      const index = ledger.schedules.findIndex((record) => record.id === id);
      assert(index !== -1, 'Schedule does not exist.');
      const record = ledger.schedules[index];
      const previous = record.occurrences.find((occurrence) => occurrence.id === occurrenceId);
      assert(previous, 'Schedule occurrence does not exist.');
      if (patch.expectedVersion !== undefined) {
        assert(Number.isSafeInteger(patch.expectedVersion) && patch.expectedVersion >= 1);
        assert(previous.expectedVersion === null || previous.expectedVersion === patch.expectedVersion, 'Occurrence dispatch version is immutable.');
      }
      const unchanged = previous.state === patch.state && previous.issue === patch.issue && (patch.expectedVersion === undefined || patch.expectedVersion === previous.expectedVersion);
      if (unchanged) return previous;
      const transitions: Record<ScheduleOccurrenceState, ScheduleOccurrenceState[]> = {
        INTENT: ['PREPARED', 'UNCERTAIN', 'CANCELLED'], PREPARED: ['STARTING', 'UNCERTAIN', 'CANCELLED'],
        STARTING: ['ACTIVE', 'TERMINAL', 'UNCERTAIN', 'CANCELLED'], ACTIVE: ['ACTIVE', 'TERMINAL', 'UNCERTAIN'],
        UNCERTAIN: ['UNCERTAIN', 'ACTIVE', 'TERMINAL'], TERMINAL: [], SKIPPED_OVERLAP: [], CANCELLED: [],
      };
      assert(previous.state === patch.state || transitions[previous.state].includes(patch.state), 'Invalid schedule occurrence transition.');
      const at = now.toISOString();
      const occurrence = { ...previous, ...patch, updatedAt: at };
      ledger.schedules[index] = this.event(record, { updatedAt: at, occurrences: record.occurrences.map((item) => item.id === occurrence.id ? occurrence : item) }, { kind: 'occurrence', at, requestId: randomUUID(), digest: scheduleDigest(occurrence) });
      return occurrence;
    });
  }
  /** One host process owns a tick across external effects. Dead local owners
   * may be recovered; foreign/unknown/live owners are never stolen by timeout. */
  async withTickLock<T>(operation: () => Promise<T>): Promise<{ busy: true } | { busy: false; result: T }> {
    const release = await this.acquire('.tick.lock', 0);
    if (!release) return { busy: true };
    try { return { busy: false, result: await operation() }; }
    finally { await release(); }
  }
  private event(record: ScheduleRecord, patch: Partial<ScheduleRecord>, input: Omit<ScheduleEvent, 'version'>): ScheduleRecord {
    assert(record.events.length < MAX_EVENTS, 'Schedule event history limit reached; dispatch is blocked to preserve recovery evidence.');
    const version = record.version + 1;
    return { ...record, ...patch, version, events: [...record.events, { ...input, version }] };
  }
  private async change<T>(operation: (ledger: Ledger) => Promise<T>): Promise<T> {
    return this.withLock('.write.lock', async () => {
      const ledger = await this.read();
      const before = scheduleDigest(ledger);
      const result = await operation(ledger);
      if (scheduleDigest(ledger) !== before) await this.publish(ledger);
      return result;
    });
  }
  private async withLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire(name, 10_000);
    assert(release, 'Schedule store is busy; retry after the current transaction.');
    try { return await operation(); } finally { await release(); }
  }
  private async acquire(name: string, waitMs: number): Promise<(() => Promise<void>) | null> {
    const path = join(this.root, name);
    const recovery = join(this.root, `${name}.recovery`);
    const owner: LockOwner = { schema: 1, host: hostname(), pid: process.pid, token: randomUUID() };
    const content = JSON.stringify(owner);
    const deadline = Date.now() + waitMs;
    do {
      // Recovery claims serialize removal of a proven dead lock. A writer may
      // create its own lock after removal; the recovery owner never removes it.
      let recovering = false;
      try { await lstat(recovery); recovering = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (!recovering) {
        try {
          const file = await open(path, 'wx', 0o600);
          try { await file.writeFile(content); await file.sync(); }
          finally { await file.close(); }
          return async () => {
            assert.equal(await this.readFile(name, 1024), content, 'Schedule lock ownership changed.');
            await unlink(path);
          };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          let previous: string;
          try { previous = await this.readFile(name, 1024); }
          catch (readError) { if ((readError as NodeJS.ErrnoException).code === 'ENOENT') continue; throw readError; }
          // A concurrently acquiring owner may not have written its bytes yet.
          // Empty is busy, never proof of a dead owner.
          if (previous) {
            const previousOwner = JSON.parse(previous);
            ownerValid(previousOwner);
            if (dead(previousOwner)) {
              let claim;
              try { claim = await open(recovery, 'wx', 0o600); }
              catch (claimError) { if ((claimError as NodeJS.ErrnoException).code !== 'EEXIST') throw claimError; }
              if (claim) {
                try {
                  if (await this.readFile(name, 1024) === previous && dead(previousOwner)) await unlink(path);
                } catch (recoveryError) { if ((recoveryError as NodeJS.ErrnoException).code !== 'ENOENT') throw recoveryError; }
                finally { await claim.close(); await unlink(recovery); }
                continue;
              }
            }
          }
        }
      }
      if (Date.now() >= deadline) return null;
      await sleep(10);
    } while (true);
  }
  private async readFile(name: string, maxBytes: number): Promise<string> {
    const file = await open(join(this.root, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      assert(stat.isFile() && stat.size <= maxBytes, 'Invalid or oversized schedule store file.');
      return await file.readFile('utf8');
    } finally { await file.close(); }
  }
  private async read(): Promise<Ledger> {
    let content: string;
    try { content = await this.readFile('schedules.json', MAX_BYTES); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Schedule ledger is missing; restore retained scheduling history before dispatch.', { cause: error });
      throw error;
    }
    const envelope = JSON.parse(content);
    object(envelope, ['sha256', 'ledger']);
    assert.equal(envelope.sha256, scheduleDigest(envelope.ledger), 'Schedule ledger checksum mismatch.');
    const ledger = envelope.ledger as Ledger;
    object(ledger, ['schema', 'kind', 'workspaceRoot', 'schedules']);
    assert.equal(ledger.schema, 1);
    assert.equal(ledger.kind, 'temari-schedule-store');
    assert.equal(ledger.workspaceRoot, this.workspaceRoot, 'Schedule ledger workspace changed.');
    assert(Array.isArray(ledger.schedules) && ledger.schedules.length <= MAX_SCHEDULES);
    const ids = new Set<string>();
    for (const record of ledger.schedules) { recordValid(record, this.workspaceRoot); assert(!ids.has(record.id), 'Duplicate schedule.'); ids.add(record.id); }
    return ledger;
  }
  private async publish(ledger: Ledger): Promise<void> {
    for (const record of ledger.schedules) recordValid(record, this.workspaceRoot);
    const content = JSON.stringify({ sha256: scheduleDigest(ledger), ledger });
    assert(Buffer.byteLength(content) <= MAX_BYTES, 'Schedule ledger exceeds storage bound; dispatch is blocked.');
    await this.publishFile('schedules.json', content);
  }
  private async publishFile(name: string, content: string): Promise<void> {
    const temporary = join(this.root, `.tmp-${randomUUID()}`);
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
      await rename(temporary, join(this.root, name));
      const directory = await open(this.root, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await unlink(temporary).catch(() => undefined); }
  }
}
