import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { assertWorkerResult } from '@temari/contracts';
import type {
  ChildTaskGroupRecord,
  ChildTaskRecord,
  ClaimChildTaskGroupRequest,
  ClaimChildTaskGroupResult,
  ClaimRunRequest,
  ClaimRunResult,
  CreateRunRequest,
  MechanicalRunRecord,
  Nx05ChildPublication,
  Nx05DispatchGroup,
  Nx05ParentCommit,
  RenewChildTaskLeaseRequest,
  RenewRunLeaseRequest,
  CancelRunRequest,
  RunEvent,
} from '@temari/runtime';
import { assertNx05ParentCommit } from '@temari/runtime';

import { SqliteImmutableArtifactProvider } from './sqlite-artifact-provider.js';

type JsonRow = { json: string };
type CommandRow = { request_json: string; response_json: string };
type StoredGroup = ChildTaskGroupRecord & {
  maxConcurrency: number;
  dispatch: Nx05DispatchGroup;
};

const terminalParent = new Set(['SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED']);
const terminalChild = new Set([
  'SUCCEEDED',
  'ISSUES',
  'BLOCKED',
  'DROPPED',
  'FAILED',
  'CANCELLED',
]);

function safeId(value: string, label: string): void {
  assert(
    typeof value === 'string' &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value),
    `${label} is invalid.`,
  );
}

function text(value: string, label: string): void {
  assert(
    typeof value === 'string' && value.length > 0 && value.length <= 512,
    `${label} is invalid.`,
  );
}

function leaseMs(value: number): void {
  assert(Number.isSafeInteger(value) && value > 0 && value <= 86_400_000);
}

function json<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Same-disk SQLite stand-in for exercising NX05 command atomicity and fencing.
 * This is deliberately not exported as the production shared-service adapter.
 */
export class SqliteNx05ControlTestProvider {
  private constructor(
    private readonly database: DatabaseSync,
    private readonly clock: () => Date,
  ) {}

  static async open(
    path: string,
    clock: () => Date = () => new Date(),
  ): Promise<SqliteNx05ControlTestProvider> {
    const artifacts = await SqliteImmutableArtifactProvider.open(path);
    artifacts.close();
    const database = new DatabaseSync(path);
    database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    database.exec(`
      CREATE TABLE IF NOT EXISTS nx05_parents (
        run_id TEXT PRIMARY KEY, json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS nx05_parent_events (
        run_id TEXT NOT NULL, sequence INTEGER NOT NULL,
        json TEXT NOT NULL, PRIMARY KEY (run_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS nx05_groups (
        group_id TEXT PRIMARY KEY, json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS nx05_tasks (
        task_id TEXT PRIMARY KEY, group_id TEXT NOT NULL,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS nx05_commands (
        scope TEXT NOT NULL, identity TEXT NOT NULL, key TEXT NOT NULL,
        request_json TEXT NOT NULL, response_json TEXT NOT NULL,
        PRIMARY KEY (scope, identity, key)
      );
    `);
    return new SqliteNx05ControlTestProvider(database, clock);
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
  }

  private now(): Date {
    const now = this.clock();
    assert(Number.isFinite(now.getTime()), 'Service clock is invalid.');
    return now;
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE;');
    try {
      const result = operation();
      this.database.exec('COMMIT;');
      return result;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK;');
      throw error;
    }
  }

  private read<T>(table: string, field: string, id: string): T | null {
    const row = this.database
      .prepare(`SELECT json FROM ${table} WHERE ${field} = ?`)
      .get(id) as JsonRow | undefined;
    return row ? (JSON.parse(row.json) as T) : null;
  }

  private put<T>(table: string, field: string, id: string, value: T): void {
    this.database
      .prepare(
        `INSERT INTO ${table} (${field}, json) VALUES (?, ?)
         ON CONFLICT (${field}) DO UPDATE SET json = excluded.json`,
      )
      .run(id, JSON.stringify(value));
  }

  private parent(runId: string): MechanicalRunRecord {
    const record = this.read<MechanicalRunRecord>(
      'nx05_parents',
      'run_id',
      runId,
    );
    assert(record, `Parent ${runId} does not exist.`);
    return record;
  }

  private child(taskId: string): ChildTaskRecord {
    const record = this.read<ChildTaskRecord>('nx05_tasks', 'task_id', taskId);
    assert(record, `Child ${taskId} does not exist.`);
    return record;
  }

  private saveChild(record: ChildTaskRecord): void {
    const result = this.database
      .prepare('UPDATE nx05_tasks SET json = ? WHERE task_id = ?')
      .run(JSON.stringify(record), record.taskId);
    assert.equal(result.changes, 1, 'Child task disappeared.');
  }

  private command<T>(
    scope: string,
    identity: string,
    key: string,
    request: unknown,
  ): T | null {
    const row = this.database
      .prepare(
        'SELECT request_json, response_json FROM nx05_commands WHERE scope = ? AND identity = ? AND key = ?',
      )
      .get(scope, identity, key) as CommandRow | undefined;
    if (!row) return null;
    assert.deepEqual(
      JSON.parse(row.request_json),
      json(request),
      'Idempotency key was reused for a different command.',
    );
    return JSON.parse(row.response_json) as T;
  }

  private saveCommand(
    scope: string,
    identity: string,
    key: string,
    request: unknown,
    response: unknown,
  ): void {
    this.database
      .prepare(
        'INSERT INTO nx05_commands (scope, identity, key, request_json, response_json) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        scope,
        identity,
        key,
        JSON.stringify(request),
        JSON.stringify(response),
      );
  }

  private event(
    record: MechanicalRunRecord,
    type: RunEvent['type'],
    idempotencyKey: string,
    actor: string,
    payload: RunEvent['payload'],
    at: string,
  ): void {
    const sequence =
      (
        this.database
          .prepare(
            'SELECT COALESCE(MAX(sequence), 0) AS sequence FROM nx05_parent_events WHERE run_id = ?',
          )
          .get(record.runId) as { sequence: number }
      ).sequence + 1;
    const event: RunEvent = {
      schema: 1,
      sequence,
      runId: record.runId,
      revision: record.revision,
      type,
      idempotencyKey,
      actor,
      at,
      payload,
    };
    this.database
      .prepare(
        'INSERT INTO nx05_parent_events (run_id, sequence, json) VALUES (?, ?, ?)',
      )
      .run(record.runId, sequence, JSON.stringify(event));
  }

  async events(runId: string): Promise<readonly RunEvent[]> {
    safeId(runId, 'Parent ID');
    return (
      this.database
        .prepare(
          'SELECT json FROM nx05_parent_events WHERE run_id = ? ORDER BY sequence',
        )
        .all(runId) as JsonRow[]
    ).map((row) => JSON.parse(row.json) as RunEvent);
  }

  async createParent(
    request: Omit<CreateRunRequest, 'now'>,
  ): Promise<MechanicalRunRecord> {
    safeId(request.runId, 'Parent ID');
    text(request.revision, 'Revision');
    text(request.actor, 'Actor');
    return this.transaction(() => {
      const prior = this.read<MechanicalRunRecord>(
        'nx05_parents',
        'run_id',
        request.runId,
      );
      if (prior) {
        assert.equal(
          prior.revision,
          request.revision,
          'Parent revision changed.',
        );
        return prior;
      }
      const at = this.now().toISOString();
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
      this.put('nx05_parents', 'run_id', request.runId, record);
      this.event(
        record,
        'run-created',
        `create:${request.runId}`,
        request.actor,
        {},
        at,
      );
      return record;
    });
  }

  async loadParent(runId: string): Promise<MechanicalRunRecord | null> {
    safeId(runId, 'Parent ID');
    return this.read('nx05_parents', 'run_id', runId);
  }

  async claimParent(
    request: Omit<ClaimRunRequest, 'now'>,
  ): Promise<ClaimRunResult> {
    safeId(request.runId, 'Parent ID');
    text(request.owner, 'Owner');
    leaseMs(request.leaseMs);
    return this.transaction(() => {
      const record = this.parent(request.runId);
      const now = this.now();
      if (
        terminalParent.has(record.status) ||
        (record.lease && Date.parse(record.lease.expiresAt) > now.getTime())
      ) {
        return { claimed: false, record };
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
          expiresAt: new Date(now.getTime() + request.leaseMs).toISOString(),
        },
      };
      this.put('nx05_parents', 'run_id', request.runId, next);
      this.event(
        next,
        'run-claimed',
        `claim:${request.runId}:${next.attempt}`,
        request.owner,
        { attempt: next.attempt },
        now.toISOString(),
      );
      return { claimed: true, record: next };
    });
  }

  async renewParent(
    request: Omit<RenewRunLeaseRequest, 'now'>,
  ): Promise<MechanicalRunRecord> {
    safeId(request.runId, 'Parent ID');
    text(request.owner, 'Owner');
    text(request.leaseToken, 'Lease token');
    text(request.idempotencyKey, 'Idempotency key');
    leaseMs(request.leaseMs);
    return this.transaction(() => {
      const prior = this.command<MechanicalRunRecord>(
        'parent',
        request.runId,
        request.idempotencyKey,
        { kind: 'renew', ...request },
      );
      if (prior) return prior;
      const record = this.parent(request.runId);
      const now = this.now();
      assert.equal(record.status, 'RUNNING');
      assert.equal(record.lease?.owner, request.owner, 'Parent owner changed.');
      assert.equal(
        record.lease.token,
        request.leaseToken,
        'Parent fence changed.',
      );
      assert(
        Date.parse(record.lease.expiresAt) > now.getTime(),
        'Parent lease expired.',
      );
      const next: MechanicalRunRecord = {
        ...record,
        updatedAt: now.toISOString(),
        lease: {
          ...record.lease,
          expiresAt: new Date(now.getTime() + request.leaseMs).toISOString(),
        },
      };
      this.put('nx05_parents', 'run_id', request.runId, next);
      this.event(
        next,
        'run-lease-renewed',
        request.idempotencyKey,
        request.owner,
        {},
        now.toISOString(),
      );
      this.saveCommand(
        'parent',
        request.runId,
        request.idempotencyKey,
        { kind: 'renew', ...request },
        next,
      );
      return next;
    });
  }

  async cancelParent(
    request: Omit<CancelRunRequest, 'now'>,
  ): Promise<MechanicalRunRecord> {
    safeId(request.runId, 'Parent ID');
    text(request.actor, 'Actor');
    text(request.idempotencyKey, 'Idempotency key');
    return this.transaction(() => {
      const prior = this.command<MechanicalRunRecord>(
        'parent',
        request.runId,
        request.idempotencyKey,
        { kind: 'cancel', ...request },
      );
      if (prior) return prior;
      const record = this.parent(request.runId);
      if (terminalParent.has(record.status)) return record;
      const at = this.now().toISOString();
      const next: MechanicalRunRecord =
        record.status === 'QUEUED'
          ? { ...record, status: 'CANCELLED', lease: null, updatedAt: at }
          : record;
      if (next !== record)
        this.put('nx05_parents', 'run_id', request.runId, next);
      this.event(
        next,
        record.status === 'QUEUED'
          ? 'run-status-changed'
          : 'run-cancellation-requested',
        request.idempotencyKey,
        request.actor,
        { requested: true },
        at,
      );
      this.saveCommand(
        'parent',
        request.runId,
        request.idempotencyKey,
        { kind: 'cancel', ...request },
        next,
      );
      return next;
    });
  }

  async commitParentAndDispatch(
    request: Nx05ParentCommit,
  ): Promise<MechanicalRunRecord> {
    assertNx05ParentCommit(request);
    const command = json(request);
    return this.transaction(() => {
      const prior = this.command<MechanicalRunRecord>(
        'parent',
        request.runId,
        request.idempotencyKey,
        { kind: 'commit', ...command },
      );
      if (prior) return prior;
      const record = this.parent(request.runId);
      const now = this.now();
      assert.equal(record.status, 'RUNNING');
      assert.equal(
        record.lease?.owner,
        request.lease.owner,
        'Parent owner changed.',
      );
      assert.equal(
        record.lease.token,
        request.lease.token,
        'Parent fence changed.',
      );
      assert.equal(
        record.attempt,
        request.lease.fencingEpoch,
        'Parent epoch changed.',
      );
      assert(
        Date.parse(record.lease.expiresAt) > now.getTime(),
        'Parent lease expired.',
      );
      const cancellationRequested = (
        this.database
          .prepare('SELECT json FROM nx05_parent_events WHERE run_id = ?')
          .all(request.runId) as JsonRow[]
      ).some(
        (row) =>
          (JSON.parse(row.json) as RunEvent).type ===
          'run-cancellation-requested',
      );
      if (cancellationRequested) {
        assert.equal(
          request.status,
          'CANCELLED',
          'Parent cancellation is pending.',
        );
      }
      for (const group of command.dispatch) {
        assert(
          !this.read<StoredGroup>('nx05_groups', 'group_id', group.groupId),
          'Dispatch group already exists.',
        );
        for (const task of group.tasks) {
          assert(
            !this.read<ChildTaskRecord>('nx05_tasks', 'task_id', task.taskId),
            'Dispatch task already exists.',
          );
        }
      }
      const at = now.toISOString();
      const next: MechanicalRunRecord = {
        ...record,
        status: request.status,
        updatedAt: at,
        lease: terminalParent.has(request.status) ? null : record.lease,
      };
      this.put('nx05_parents', 'run_id', request.runId, next);
      this.event(
        next,
        request.event.type,
        request.idempotencyKey,
        request.lease.owner,
        request.event.payload,
        at,
      );
      for (const group of command.dispatch) {
        const groupRecord: StoredGroup = {
          schema: 1,
          groupId: group.groupId,
          runId: record.runId,
          revision: record.revision,
          taskIds: group.tasks.map((task) => task.taskId),
          assignmentIds: group.tasks.map((task) => task.assignment.id),
          maxConcurrency: group.maxConcurrency,
          dispatch: group,
          createdAt: at,
        };
        this.put('nx05_groups', 'group_id', group.groupId, groupRecord);
        for (const task of group.tasks) {
          const child: ChildTaskRecord = {
            schema: 1,
            taskId: task.taskId,
            runId: record.runId,
            revision: record.revision,
            status: 'QUEUED',
            attempt: 0,
            createdAt: at,
            updatedAt: at,
            dependsOn: task.dependsOn,
            lease: null,
            result: null,
            error: null,
          };
          this.database
            .prepare(
              'INSERT INTO nx05_tasks (task_id, group_id, json) VALUES (?, ?, ?)',
            )
            .run(task.taskId, group.groupId, JSON.stringify(child));
        }
      }
      this.saveCommand(
        'parent',
        request.runId,
        request.idempotencyKey,
        { kind: 'commit', ...command },
        next,
      );
      return next;
    });
  }

  async loadChild(taskId: string): Promise<ChildTaskRecord | null> {
    safeId(taskId, 'Child ID');
    return this.read('nx05_tasks', 'task_id', taskId);
  }

  async claimChildGroup(
    request: Omit<ClaimChildTaskGroupRequest, 'now'>,
  ): Promise<
    ClaimChildTaskGroupResult & { readonly dispatch: Nx05DispatchGroup }
  > {
    safeId(request.groupId, 'Group ID');
    safeId(request.runId, 'Parent ID');
    text(request.revision, 'Revision');
    text(request.owner, 'Owner');
    leaseMs(request.leaseMs);
    return this.transaction(() => {
      const group = this.read<StoredGroup>(
        'nx05_groups',
        'group_id',
        request.groupId,
      );
      assert(group, 'Dispatch group does not exist.');
      assert.equal(group.runId, request.runId);
      assert.equal(group.revision, request.revision);
      assert.equal(
        this.parent(group.runId).status,
        'RUNNING',
        'Parent is not running.',
      );
      assert.equal(
        group.maxConcurrency,
        request.maxConcurrency,
        'Dispatch concurrency changed.',
      );
      assert.deepEqual(
        group.taskIds,
        request.taskIds,
        'Dispatch task set changed.',
      );
      const now = this.now();
      const records = group.taskIds.map((id) => this.child(id));
      let active = records.filter(
        (record) =>
          record.status === 'RUNNING' &&
          record.lease &&
          Date.parse(record.lease.expiresAt) > now.getTime(),
      ).length;
      const claimed: ChildTaskRecord[] = [];
      const current = new Map(records.map((record) => [record.taskId, record]));
      for (const record of records) {
        if (active >= group.maxConcurrency) break;
        if (terminalChild.has(record.status)) continue;
        if (
          record.status === 'RUNNING' &&
          record.lease &&
          Date.parse(record.lease.expiresAt) > now.getTime()
        )
          continue;
        if (
          !record.dependsOn.every(
            (id) => current.get(id)?.status === 'SUCCEEDED',
          )
        )
          continue;
        const next: ChildTaskRecord = {
          ...record,
          status: 'RUNNING',
          attempt: record.attempt + 1,
          updatedAt: now.toISOString(),
          lease: {
            owner: request.owner,
            token: randomUUID(),
            fencingEpoch: (record.lease?.fencingEpoch ?? 0) + 1,
            acquiredAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + request.leaseMs).toISOString(),
          },
        };
        this.saveChild(next);
        current.set(record.taskId, next);
        claimed.push(next);
        active += 1;
      }
      const publicGroup: ChildTaskGroupRecord = {
        schema: 1,
        groupId: group.groupId,
        runId: group.runId,
        revision: group.revision,
        taskIds: group.taskIds,
        assignmentIds: group.assignmentIds,
        createdAt: group.createdAt,
      };
      return {
        group: publicGroup,
        dispatch: group.dispatch,
        claimed,
        records: group.taskIds.map((id) => current.get(id)!),
        missingTaskIds: [],
      };
    });
  }

  async renewChild(
    request: Omit<RenewChildTaskLeaseRequest, 'now'>,
  ): Promise<ChildTaskRecord> {
    safeId(request.taskId, 'Child ID');
    text(request.owner, 'Owner');
    text(request.leaseToken, 'Lease token');
    text(request.idempotencyKey, 'Idempotency key');
    leaseMs(request.leaseMs);
    return this.transaction(() => {
      const prior = this.command<ChildTaskRecord>(
        'child',
        request.taskId,
        request.idempotencyKey,
        { kind: 'renew', ...request },
      );
      if (prior) return prior;
      const record = this.child(request.taskId);
      const now = this.now();
      assert.equal(record.status, 'RUNNING');
      assert.equal(record.lease?.owner, request.owner, 'Child owner changed.');
      assert.equal(
        record.lease.token,
        request.leaseToken,
        'Child fence changed.',
      );
      assert.equal(
        record.lease.fencingEpoch,
        request.fencingEpoch,
        'Child epoch changed.',
      );
      assert(
        Date.parse(record.lease.expiresAt) > now.getTime(),
        'Child lease expired.',
      );
      const next: ChildTaskRecord = {
        ...record,
        updatedAt: now.toISOString(),
        lease: {
          ...record.lease,
          expiresAt: new Date(now.getTime() + request.leaseMs).toISOString(),
        },
      };
      this.saveChild(next);
      this.saveCommand(
        'child',
        request.taskId,
        request.idempotencyKey,
        { kind: 'renew', ...request },
        next,
      );
      return next;
    });
  }

  async publishChild(request: Nx05ChildPublication): Promise<ChildTaskRecord> {
    safeId(request.taskId, 'Child ID');
    text(request.idempotencyKey, 'Idempotency key');
    text(request.lease.owner, 'Owner');
    text(request.lease.token, 'Lease token');
    const command = json(request);
    return this.transaction(() => {
      const prior = this.command<ChildTaskRecord>(
        'child',
        request.taskId,
        request.idempotencyKey,
        { kind: 'publish', ...command },
      );
      if (prior) return prior;
      const record = this.child(request.taskId);
      const now = this.now();
      assert.equal(record.status, 'RUNNING');
      assert.equal(
        record.lease?.owner,
        request.lease.owner,
        'Child owner changed.',
      );
      assert.equal(
        record.lease.token,
        request.lease.token,
        'Child fence changed.',
      );
      assert.equal(
        record.lease.fencingEpoch,
        request.lease.fencingEpoch,
        'Child epoch changed.',
      );
      assert(
        Date.parse(record.lease.expiresAt) > now.getTime(),
        'Child lease expired.',
      );
      assert(
        terminalChild.has(request.status),
        'Child status is not terminal.',
      );
      if (request.result) {
        assertWorkerResult(request.result);
        assert.equal(
          request.status,
          request.result.status === 'PASS'
            ? 'SUCCEEDED'
            : request.result.status,
        );
        assert.equal(request.error, null);
        assert(
          request.result.evidenceReferences?.length,
          'Portable evidence is required.',
        );
        for (const reference of request.result.evidenceReferences) {
          assert.equal(reference.runId, record.runId, 'Artifact run changed.');
          assert.equal(
            reference.revision,
            record.revision,
            'Artifact revision changed.',
          );
          const row = this.database
            .prepare(
              `SELECT a.bytes, a.byte_length FROM artifacts a
             JOIN artifact_bindings b ON b.sha256 = a.sha256
             WHERE b.run_id = ? AND b.revision = ? AND b.kind = ? AND b.sha256 = ?`,
            )
            .get(
              reference.runId,
              reference.revision,
              reference.kind,
              reference.sha256,
            ) as { bytes: Uint8Array; byte_length: number } | undefined;
          assert(row, 'Artifact reference is absent.');
          assert.equal(
            row.byte_length,
            reference.bytes,
            'Artifact byte count changed.',
          );
          assert.equal(
            Buffer.from(row.bytes).length,
            reference.bytes,
            'Artifact bytes changed.',
          );
          // The immutable store verifies its hash on read; publication does it here too.
          assert.equal(
            createHash('sha256').update(row.bytes).digest('hex'),
            reference.sha256,
            'Artifact hash changed.',
          );
        }
      } else {
        assert(request.status === 'FAILED' || request.status === 'CANCELLED');
        assert.equal(request.status === 'FAILED', Boolean(request.error));
      }
      const next: ChildTaskRecord = {
        ...record,
        status: request.status,
        updatedAt: now.toISOString(),
        lease: null,
        result: request.result,
        error: request.error,
      };
      this.saveChild(next);
      this.saveCommand(
        'child',
        request.taskId,
        request.idempotencyKey,
        { kind: 'publish', ...command },
        next,
      );
      return next;
    });
  }
}
