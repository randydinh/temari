import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
} from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import {
  assertInitialReconciliationPlan,
  assertMergeObservation,
  assertReconciliationBinding,
  assertReconciliationPlan,
  type MergeObservation,
  type ReconciliationConfirmation,
  type ReconciliationPlan,
} from '@temari/contracts';

/**
 * A runtime-local binding. It deliberately contains no task-store reference:
 * callers must compare it with independently read task/run state before they
 * act. Recording or confirming an attempt never accepts or completes a task.
 */
export interface ReconciliationAttemptBinding {
  readonly taskId: string;
  readonly taskVersion: string;
  readonly runId: string;
  readonly revision: string;
  readonly observationId: string;
  readonly candidateId: string;
  readonly candidateSha256: string;
  /** Digest of the full immutable source/candidate/head/path/check scope. */
  readonly scopeSha256: string;
}

export type ReconciliationAttemptStatus = 'PENDING' | 'BLOCKED' | 'CONFIRMED';

export interface ReconciliationAttempt {
  readonly schema: 1;
  readonly id: string;
  readonly idempotencyKey: string;
  /** Repeated explicitly so an audit does not need to reinterpret the plan. */
  readonly canonicalRequestDigest: string;
  readonly binding: ReconciliationAttemptBinding;
  readonly observation: MergeObservation;
  readonly plan: ReconciliationPlan;
  readonly confirmation: ReconciliationConfirmation | null;
  readonly status: ReconciliationAttemptStatus;
  /** A blocked attempt is retained; it is never silently made current again. */
  readonly blockedReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateReconciliationAttemptRequest {
  readonly idempotencyKey: string;
  readonly observation: MergeObservation;
  readonly plan: ReconciliationPlan;
}

interface Ledger {
  readonly schema: 1;
  readonly kind: 'temari-merge-reconciliation-store';
  readonly attempts: readonly ReconciliationAttempt[];
}

const MAX_ATTEMPTS = 1_024;
const MAX_BYTES = 32 * 1024 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function reconciliationStoreDigest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function object(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Expected reconciliation object.');
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), 'Unexpected reconciliation field.');
}

function text(value: unknown, label: string, max = 4_096): asserts value is string {
  assert(typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value), `Invalid ${label}.`);
}

function safeId(value: unknown, label: string): asserts value is string {
  assert(typeof value === 'string' && ID.test(value), `Invalid ${label}.`);
}

function digest(value: unknown, label: string): asserts value is string {
  assert(typeof value === 'string' && SHA256.test(value), `Invalid ${label}.`);
}

function instant(value: unknown, label: string): asserts value is string {
  assert(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, `Invalid ${label}.`);
}

export function reconciliationAttemptBinding(
  observation: MergeObservation,
): ReconciliationAttemptBinding {
  assertMergeObservation(observation);
  return {
    taskId: observation.taskId,
    taskVersion: observation.taskVersion,
    runId: observation.runId,
    revision: observation.revision,
    observationId: observation.observationId,
    candidateId: observation.candidate.id,
    candidateSha256: observation.candidate.sha256,
    scopeSha256: reconciliationStoreDigest(observation.scope),
  };
}

function assertBinding(value: unknown): asserts value is ReconciliationAttemptBinding {
  object(value, ['taskId', 'taskVersion', 'runId', 'revision', 'observationId', 'candidateId', 'candidateSha256', 'scopeSha256']);
  safeId(value.taskId, 'task ID');
  safeId(value.taskVersion, 'task version');
  safeId(value.runId, 'run ID');
  text(value.revision, 'revision', 512);
  safeId(value.observationId, 'observation ID');
  safeId(value.candidateId, 'candidate ID');
  digest(value.candidateSha256, 'candidate SHA-256');
  digest(value.scopeSha256, 'reconciliation scope SHA-256');
}

function bindingsEqual(left: ReconciliationAttemptBinding, right: ReconciliationAttemptBinding): boolean {
  return canonical(left) === canonical(right);
}

function validateRequest(request: CreateReconciliationAttemptRequest): ReconciliationAttemptBinding {
  object(request, ['idempotencyKey', 'observation', 'plan']);
  safeId(request.idempotencyKey, 'idempotency key');
  assertMergeObservation(request.observation);
  assertInitialReconciliationPlan(request.plan);
  assertReconciliationBinding(request.plan, request.observation);
  const binding = reconciliationAttemptBinding(request.observation);
  assert.equal(request.plan.taskId, binding.taskId, 'Plan task binding differs from observation.');
  assert.equal(request.plan.taskVersion, binding.taskVersion, 'Plan task version differs from observation.');
  assert.equal(request.plan.runId, binding.runId, 'Plan run binding differs from observation.');
  assert.equal(request.plan.revision, binding.revision, 'Plan revision differs from observation.');
  assert.equal(request.plan.observationId, binding.observationId, 'Plan observation binding differs from observation.');
  assert.deepEqual(request.plan.candidate, request.observation.candidate, 'Plan candidate binding differs from observation.');
  assert.equal(request.plan.request.idempotencyKey, request.idempotencyKey, 'Plan idempotency key differs from request.');
  assert.equal(request.plan.request.canonicalRequestDigestAlgorithm, 'canonical-json-sha256-v1', 'Unsupported reconciliation request digest algorithm.');
  digest(request.plan.request.canonicalRequestSha256, 'canonical request digest');
  return binding;
}

function initialStatus(plan: ReconciliationPlan): Pick<ReconciliationAttempt, 'status' | 'blockedReason'> {
  if (plan.classification === 'manual-review' || plan.status === 'blocked') {
    return {
      status: 'BLOCKED',
      blockedReason: plan.blockedReason ?? 'Reconciliation plan requires manual review before it can proceed.',
    };
  }
  return { status: 'PENDING', blockedReason: null };
}

function validateAttempt(value: unknown): asserts value is ReconciliationAttempt {
  object(value, ['schema', 'id', 'idempotencyKey', 'canonicalRequestDigest', 'binding', 'observation', 'plan', 'confirmation', 'status', 'blockedReason', 'createdAt', 'updatedAt']);
  assert.equal(value.schema, 1);
  safeId(value.id, 'attempt ID');
  safeId(value.idempotencyKey, 'idempotency key');
  assert.equal(value.id, `attempt-${value.idempotencyKey}`, 'Attempt identity differs from its idempotency key.');
  digest(value.canonicalRequestDigest, 'canonical request digest');
  assertBinding(value.binding);
  assertMergeObservation(value.observation);
  assertReconciliationPlan(value.plan);
  assert.deepEqual(value.binding, reconciliationAttemptBinding(value.observation), 'Attempt binding differs from observation.');
  assert.equal(value.canonicalRequestDigest, value.plan.request.canonicalRequestSha256, 'Attempt request digest differs from plan.');
  assert.equal(value.idempotencyKey, value.plan.request.idempotencyKey, 'Attempt idempotency key differs from plan.');
  assert(['PENDING', 'BLOCKED', 'CONFIRMED'].includes(value.status as string), 'Invalid reconciliation attempt status.');
  if (value.blockedReason !== null) text(value.blockedReason, 'blocked reason');
  if (value.status === 'BLOCKED') assert(value.blockedReason, 'Blocked attempt must retain a reason.');
  if (value.confirmation !== null) {
    assertReconciliationBinding(value.plan, value.observation, value.confirmation);
  }
  if (value.status === 'CONFIRMED') assert(value.confirmation, 'Confirmed attempt requires confirmation evidence.');
  instant(value.createdAt, 'attempt creation time');
  instant(value.updatedAt, 'attempt update time');
}

/**
 * Small, append-by-replacement ledger for reconciliation intent. It has no
 * Git, task-runtime, or host adapter dependency. A caller must pass a fresh
 * independently observed binding to invalidate stale work before acting.
 */
export class FileMergeReconciliationStore {
  private constructor(readonly root: string) {}

  static async create(root: string): Promise<FileMergeReconciliationStore> {
    assert(isAbsolute(root), 'Reconciliation store root must be absolute.');
    await mkdir(root, { recursive: true, mode: 0o700 });
    const stat = await lstat(root);
    assert(stat.isDirectory() && !stat.isSymbolicLink(), 'Reconciliation store root must be a real directory.');
    const store = new FileMergeReconciliationStore(await realpath(root));
    await store.withLock(async () => {
      const marked = await store.hasMarker();
      if (marked) { await store.read(); return; }
      const entries = await readdir(store.root);
      assert(entries.every((entry) => entry === '.merge-reconciliation.lock'), 'Refusing to initialize a nonempty reconciliation store without its ledger.');
      await store.writeAtomic('.merge-reconciliation-store.json', JSON.stringify({ schema: 1, kind: 'temari-merge-reconciliation-store' }));
      await store.publish({ schema: 1, kind: 'temari-merge-reconciliation-store', attempts: [] });
    });
    return store;
  }

  static async openExisting(root: string): Promise<FileMergeReconciliationStore> {
    assert(isAbsolute(root), 'Reconciliation store root must be absolute.');
    const stat = await lstat(root);
    assert(stat.isDirectory() && !stat.isSymbolicLink(), 'Reconciliation store root must be a real directory.');
    const store = new FileMergeReconciliationStore(await realpath(root));
    assert(await store.hasMarker(), 'Reconciliation store initialization marker is missing.');
    await store.read();
    return store;
  }

  async list(): Promise<readonly ReconciliationAttempt[]> {
    return (await this.read()).attempts;
  }

  async get(id: string): Promise<ReconciliationAttempt | null> {
    safeId(id, 'attempt ID');
    return (await this.list()).find((attempt) => attempt.id === id) ?? null;
  }

  async createAttempt(request: CreateReconciliationAttemptRequest, now = new Date()): Promise<ReconciliationAttempt> {
    const binding = validateRequest(request);
    const at = now.toISOString();
    instant(at, 'attempt creation time');
    const id = `attempt-${request.idempotencyKey}`;
    return this.change(async (ledger) => {
      const existing = ledger.attempts.find((attempt) => attempt.idempotencyKey === request.idempotencyKey);
      if (existing) {
        assert.equal(existing.canonicalRequestDigest, request.plan.request.canonicalRequestSha256, 'Reconciliation idempotency key was reused with a changed request digest.');
        assert.deepEqual(existing.binding, binding, 'Reconciliation idempotency binding changed.');
        assert.deepEqual(existing.observation, request.observation, 'Reconciliation observation is immutable.');
        assert.deepEqual(existing.plan, request.plan, 'Reconciliation plan is immutable.');
        return existing;
      }
      assert(ledger.attempts.length < MAX_ATTEMPTS, 'Reconciliation attempt limit reached; preserve retained history before creating another attempt.');
      const attempt: ReconciliationAttempt = {
        schema: 1,
        id,
        idempotencyKey: request.idempotencyKey,
        canonicalRequestDigest: request.plan.request.canonicalRequestSha256,
        binding,
        observation: structuredClone(request.observation),
        plan: structuredClone(request.plan),
        confirmation: null,
        ...initialStatus(request.plan),
        createdAt: at,
        updatedAt: at,
      };
      validateAttempt(attempt);
      ledger.attempts = [...ledger.attempts, attempt];
      return attempt;
    });
  }

  /**
   * Fails closed when independently read task/run/candidate identity drifts.
   * The original observation, plan and evidence remain immutable in the
   * blocked record so a human can see exactly what was invalidated.
   */
  async invalidateStaleBinding(
    id: string,
    current: ReconciliationAttemptBinding,
    reason = 'The task, run, revision, candidate, or observation binding changed; create a new reconciliation attempt from a fresh observation.',
    now = new Date(),
  ): Promise<ReconciliationAttempt> {
    safeId(id, 'attempt ID');
    assertBinding(current);
    text(reason, 'blocked reason');
    const at = now.toISOString();
    instant(at, 'attempt update time');
    return this.change(async (ledger) => {
      const index = ledger.attempts.findIndex((attempt) => attempt.id === id);
      assert(index !== -1, 'Reconciliation attempt does not exist.');
      const attempt = ledger.attempts[index]!;
      if (bindingsEqual(attempt.binding, current)) return attempt;
      if (attempt.status === 'BLOCKED') return attempt;
      const blocked: ReconciliationAttempt = { ...attempt, status: 'BLOCKED', blockedReason: reason, updatedAt: at };
      validateAttempt(blocked);
      ledger.attempts = ledger.attempts.map((item, itemIndex) => itemIndex === index ? blocked : item);
      return blocked;
    });
  }

  /** Confirmation is evidence of the named plan, not task acceptance. */
  async confirm(
    id: string,
    confirmation: ReconciliationConfirmation,
    current: ReconciliationAttemptBinding,
    now = new Date(),
  ): Promise<ReconciliationAttempt> {
    safeId(id, 'attempt ID');
    assertBinding(current);
    const at = now.toISOString();
    instant(at, 'attempt update time');
    return this.change(async (ledger) => {
      const index = ledger.attempts.findIndex((attempt) => attempt.id === id);
      assert(index !== -1, 'Reconciliation attempt does not exist.');
      const attempt = ledger.attempts[index]!;
      if (!bindingsEqual(attempt.binding, current)) {
        const blocked: ReconciliationAttempt = attempt.status === 'BLOCKED'
          ? attempt
          : {
              ...attempt,
              status: 'BLOCKED',
              blockedReason: 'Current reconciliation binding differs from retained evidence; confirmation is blocked until a fresh attempt is created.',
              updatedAt: at,
            };
        if (blocked !== attempt) {
          validateAttempt(blocked);
          ledger.attempts = ledger.attempts.map((item, itemIndex) => itemIndex === index ? blocked : item);
        }
        return blocked;
      }
      assert.notEqual(attempt.status, 'BLOCKED', `Reconciliation attempt is blocked: ${attempt.blockedReason}`);
      assert.notEqual(attempt.plan.classification, 'manual-review', 'Manual-review reconciliation plans cannot be confirmed by this store.');
      assertReconciliationBinding(attempt.plan, attempt.observation, confirmation);
      if (attempt.confirmation) {
        assert.deepEqual(attempt.confirmation, confirmation, 'Reconciliation confirmation is immutable.');
        return attempt;
      }
      assert.equal(attempt.plan.classification, 'requires-confirmation', 'Only a confirmation-gated plan may be confirmed.');
      const confirmed: ReconciliationAttempt = {
        ...attempt,
        confirmation: structuredClone(confirmation),
        status: 'CONFIRMED',
        blockedReason: null,
        updatedAt: at,
      };
      validateAttempt(confirmed);
      ledger.attempts = ledger.attempts.map((item, itemIndex) => itemIndex === index ? confirmed : item);
      return confirmed;
    });
  }

  private async change<T>(operation: (ledger: { attempts: ReconciliationAttempt[] }) => Promise<T>): Promise<T> {
    return this.withLock(async () => {
      const previous = await this.read();
      const ledger = { attempts: [...previous.attempts] };
      const before = reconciliationStoreDigest(ledger.attempts);
      const result = await operation(ledger);
      if (reconciliationStoreDigest(ledger.attempts) !== before)
        await this.publish({ schema: 1, kind: 'temari-merge-reconciliation-store', attempts: ledger.attempts });
      return result;
    });
  }

  private async read(): Promise<Ledger> {
    const content = await this.readFile('attempts.json', MAX_BYTES, 'Reconciliation ledger is missing; restore retained reconciliation history before continuing.');
    const envelope = JSON.parse(content) as unknown;
    object(envelope, ['sha256', 'ledger']);
    digest(envelope.sha256, 'reconciliation ledger digest');
    assert.equal(envelope.sha256, reconciliationStoreDigest(envelope.ledger), 'Reconciliation ledger checksum mismatch.');
    const ledger = envelope.ledger as unknown;
    object(ledger, ['schema', 'kind', 'attempts']);
    assert.equal(ledger.schema, 1);
    assert.equal(ledger.kind, 'temari-merge-reconciliation-store');
    assert(Array.isArray(ledger.attempts) && ledger.attempts.length <= MAX_ATTEMPTS, 'Invalid reconciliation ledger.');
    const ids = new Set<string>();
    const keys = new Set<string>();
    for (const attempt of ledger.attempts) {
      validateAttempt(attempt);
      assert(!ids.has(attempt.id), 'Duplicate reconciliation attempt.');
      assert(!keys.has(attempt.idempotencyKey), 'Duplicate reconciliation idempotency key.');
      ids.add(attempt.id);
      keys.add(attempt.idempotencyKey);
    }
    return ledger as unknown as Ledger;
  }

  private async publish(ledger: Ledger): Promise<void> {
    for (const attempt of ledger.attempts) validateAttempt(attempt);
    const content = JSON.stringify({ sha256: reconciliationStoreDigest(ledger), ledger });
    assert(Buffer.byteLength(content) <= MAX_BYTES, 'Reconciliation ledger exceeds local storage bound.');
    await this.writeAtomic('attempts.json', content);
  }

  private async hasMarker(): Promise<boolean> {
    try {
      await lstat(join(this.root, '.merge-reconciliation-store.json'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    const content = await this.readFile('.merge-reconciliation-store.json', 256, 'Reconciliation store initialization marker is missing.');
    assert.deepEqual(JSON.parse(content), { schema: 1, kind: 'temari-merge-reconciliation-store' }, 'Reconciliation store initialization marker is invalid.');
    return true;
  }

  private async readFile(name: string, maxBytes: number, missing: string): Promise<string> {
    try {
      const file = await open(join(this.root, name), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        assert(stat.isFile() && stat.size <= maxBytes, 'Invalid or oversized reconciliation store file.');
        return await file.readFile('utf8');
      } finally { await file.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(missing, { cause: error });
      throw error;
    }
  }

  private async writeAtomic(name: string, content: string): Promise<void> {
    const temporary = join(this.root, `.${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      try { await file.writeFile(content); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, join(this.root, name));
      const directory = await open(this.root, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await unlink(temporary).catch(() => undefined); }
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const lock = join(this.root, '.merge-reconciliation.lock');
    let acquired = false;
    for (let retry = 0; retry < 100; retry++) {
      try { await mkdir(lock, { mode: 0o700 }); acquired = true; break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    assert(acquired, 'Reconciliation store is locked; inspect and manually recover the retained lock before retrying.');
    try { return await operation(); }
    finally { await rmdir(lock); }
  }
}
