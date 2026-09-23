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

import type { WorkflowReceipt, WorkflowReceiptStatus } from '@temari/contracts';
import {
  runPlanWithReceipt,
  type ReceiptRunRequest,
} from '@temari/workflow-engine';
import type { MechanicalRunStatus, WorkflowRunStore } from './run-store.js';

export interface WorkflowReceiptStore {
  save(receipt: WorkflowReceipt): Promise<string>;
  load(runId: string): Promise<WorkflowReceipt | null>;
}

interface StoredReceipt {
  readonly schema: 1;
  readonly sha256: string;
  readonly receipt: WorkflowReceipt;
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

export class FileWorkflowReceiptStore implements WorkflowReceiptStore {
  private constructor(private readonly root: string) {}

  static async create(root: string): Promise<FileWorkflowReceiptStore> {
    assert(isAbsolute(root), 'Receipt store root must be absolute.');
    await mkdir(root, { recursive: true, mode: 0o700 });
    const canonicalRoot = await realpath(root);
    return new FileWorkflowReceiptStore(canonicalRoot);
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

export interface ExecuteAndPersistRequest extends ReceiptRunRequest {
  readonly store: WorkflowReceiptStore;
}

export async function executeAndPersist(
  request: ExecuteAndPersistRequest,
): Promise<WorkflowReceipt> {
  const receipt = await runPlanWithReceipt(request);
  await request.store.save(receipt);
  return receipt;
}

export interface ExecuteScheduledAndPersistRequest extends ExecuteAndPersistRequest {
  readonly runStore: WorkflowRunStore;
  readonly owner: string;
  readonly leaseMs: number;
}

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

/**
 * Run one revision through the mechanical boundary. The run store owns
 * leases, event ordering, retries, and status; the workflow engine still owns
 * stage order and receipt semantics.
 */
export async function executeScheduledAndPersist(
  request: ExecuteScheduledAndPersistRequest,
): Promise<ScheduledExecutionResult> {
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
  await request.runStore.appendEvent({
    runId: request.runId,
    actor: request.owner,
    idempotencyKey: `dispatch:${request.runId}:${attempt}`,
    payload: { attempt, revision: request.revision },
    now: now(),
  });

  try {
    const receipt = await executeAndPersist(request);
    const record = await request.runStore.transition({
      runId: request.runId,
      owner: request.owner,
      leaseToken,
      status: mechanicalStatus(receipt.status),
      idempotencyKey: `complete:${request.runId}:${attempt}`,
      payload: {
        receipt: `${request.runId}.receipt.json`,
        receiptStatus: receipt.status,
      },
      now: now(),
    });
    return { claimed: true, record, receipt };
  } catch (error) {
    await request.runStore.transition({
      runId: request.runId,
      owner: request.owner,
      leaseToken,
      status: 'FAILED',
      idempotencyKey: `failed:${request.runId}:${attempt}`,
      payload: { error: errorMessage(error) },
      now: now(),
    });
    throw error;
  }
}
