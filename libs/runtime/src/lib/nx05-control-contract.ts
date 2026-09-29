import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import type {
  WorkerAssignment,
  WorkerEvidenceReference,
  WorkerResult,
  WorkerResultStatus,
} from '@temari/contracts';
import { assertWorkerAssignment } from '@temari/contracts';

import {
  FileChildTaskStore,
  type ClaimChildTaskGroupRequest,
  type ClaimChildTaskGroupResult,
  type ChildTaskRecord,
  type ChildTaskStore,
  type RenewChildTaskLeaseRequest,
} from './child-task-store.js';
import {
  FileEvidenceStore,
  type EvidenceStore,
  type PutEvidenceRequest,
} from './evidence-store.js';
import {
  FileWorkflowRunStore,
  type CancelRunRequest,
  type ClaimRunRequest,
  type ClaimRunResult,
  type CreateRunRequest,
  type MechanicalRunRecord,
  type MechanicalRunStatus,
  type RenewRunLeaseRequest,
  type RunEventPayload,
  type RunEventType,
  type WorkflowRunStore,
} from './run-store.js';

const MAX_DISPATCH_GROUPS = 64;
const MAX_TASKS_PER_GROUP = 256;
const MAX_ASSIGNMENT_BYTES = 1024 * 1024;

export interface Nx05FileProcessAdapters {
  readonly scope: 'single-host-file';
  readonly runs: WorkflowRunStore;
  readonly children: ChildTaskStore;
  readonly artifacts: EvidenceStore;
}

export async function openNx05FileConformanceAdapters(
  root: string,
): Promise<Nx05FileProcessAdapters> {
  return {
    scope: 'single-host-file',
    runs: await FileWorkflowRunStore.create(join(root, 'parent')),
    children: await FileChildTaskStore.create(join(root, 'child')),
    artifacts: await FileEvidenceStore.create(join(root, 'artifacts')),
  };
}

export interface Nx05LeaseWitness {
  readonly owner: string;
  readonly token: string;
  readonly fencingEpoch: number;
}

export interface Nx05DispatchIntent {
  readonly taskId: string;
  readonly idempotencyKey: string;
  readonly assignment: WorkerAssignment;
  readonly assignmentSha256: string;
  readonly dependsOn: readonly string[];
}

export interface Nx05DispatchGroup {
  readonly groupId: string;
  readonly maxConcurrency: number;
  readonly tasks: readonly Nx05DispatchIntent[];
}

export interface Nx05ParentCommit {
  readonly runId: string;
  readonly lease: Nx05LeaseWitness;
  readonly idempotencyKey: string;
  readonly status: MechanicalRunStatus;
  readonly event: {
    readonly type: Extract<RunEventType, 'run-event' | 'run-status-changed'>;
    readonly payload: RunEventPayload;
  };
  readonly dispatch: readonly Nx05DispatchGroup[];
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

/** Digest the complete assignment, including its required flag and brief. */
export function nx05AssignmentSha256(assignment: WorkerAssignment): string {
  assert.deepEqual(
    Object.keys(assignment).sort(),
    ['brief', 'id', 'required', 'role'],
    'Dispatch assignment fields changed.',
  );
  assert.deepEqual(
    Object.keys(assignment.brief).sort(),
    [
      'acceptanceCriteria',
      'context',
      'forbiddenActions',
      'goal',
      'reportFormat',
      'scope',
      'verificationCommand',
    ],
    'Dispatch brief fields changed.',
  );
  safeId(assignment.id, 'Dispatch assignment ID');
  assert(
    [
      'coordinator',
      'investigator',
      'implementer',
      'verifier',
      'reviewer',
      'judge',
      'integrator',
    ].includes(assignment.role),
    'Dispatch assignment role is invalid.',
  );
  assertWorkerAssignment(assignment);
  const serialized = canonical(assignment);
  assert(
    Buffer.byteLength(serialized) <= MAX_ASSIGNMENT_BYTES,
    'Dispatch assignment exceeds the byte limit.',
  );
  return createHash('sha256').update(serialized).digest('hex');
}

function safeId(value: string, label: string): void {
  assert(
    typeof value === 'string' &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value),
    `${label} must be a safe identifier.`,
  );
}

function nonempty(value: string, label: string): void {
  assert(
    typeof value === 'string' && value.length > 0 && value.length <= 512,
    `${label} must be nonempty and at most 512 characters.`,
  );
}

/** Check a complete immutable dispatch graph before a provider commits it. */
export function assertNx05ParentCommit(request: Nx05ParentCommit): void {
  safeId(request.runId, 'Parent run ID');
  nonempty(request.idempotencyKey, 'Parent idempotency key');
  nonempty(request.lease.owner, 'Parent lease owner');
  nonempty(request.lease.token, 'Parent lease token');
  assert(
    Number.isSafeInteger(request.lease.fencingEpoch) &&
      request.lease.fencingEpoch > 0,
    'Parent fencing epoch must be positive.',
  );
  assert(
    request.event.type === 'run-event' ||
      request.event.type === 'run-status-changed',
    'Parent event type is invalid.',
  );
  assert(
    request.event.payload &&
      typeof request.event.payload === 'object' &&
      !Array.isArray(request.event.payload),
    'Parent event payload is invalid.',
  );
  for (const value of Object.values(request.event.payload)) {
    assert(
      value === null ||
        typeof value === 'string' ||
        (typeof value === 'number' && Number.isFinite(value)) ||
        typeof value === 'boolean',
      'Parent event payload has an invalid value.',
    );
  }
  assert(
    [
      'QUEUED',
      'RUNNING',
      'SUCCEEDED',
      'FAILED',
      'BLOCKED',
      'CANCELLED',
    ].includes(request.status),
    'Parent status is invalid.',
  );
  assert(Array.isArray(request.dispatch), 'Dispatch groups are required.');
  assert(
    request.dispatch.length <= MAX_DISPATCH_GROUPS,
    'Too many dispatch groups.',
  );
  if (request.dispatch.length > 0) {
    assert.equal(
      request.status,
      'RUNNING',
      'Dispatch requires a RUNNING parent.',
    );
  }
  const groupIds = new Set<string>();
  const globalTaskIds = new Set<string>();
  const idempotencyKeys = new Set<string>();
  for (const group of request.dispatch) {
    safeId(group.groupId, 'Dispatch group ID');
    assert(!groupIds.has(group.groupId), 'Duplicate dispatch group ID.');
    groupIds.add(group.groupId);
    assert(
      Number.isSafeInteger(group.maxConcurrency) &&
        group.maxConcurrency > 0 &&
        group.maxConcurrency <= MAX_TASKS_PER_GROUP,
      'Dispatch maxConcurrency must be bounded.',
    );
    assert(
      Array.isArray(group.tasks) &&
        group.tasks.length > 0 &&
        group.tasks.length <= MAX_TASKS_PER_GROUP,
      'Dispatch group requires a bounded task set.',
    );
    const taskIds = new Set<string>();
    const assignmentIds = new Set<string>();
    for (const task of group.tasks) {
      safeId(task.taskId, 'Dispatch task ID');
      nonempty(task.idempotencyKey, 'Dispatch idempotency key');
      assert(
        /^[a-f0-9]{64}$/.test(task.assignmentSha256) &&
          task.assignmentSha256 === nx05AssignmentSha256(task.assignment),
        'Dispatch assignment digest mismatch.',
      );
      assert(!globalTaskIds.has(task.taskId), 'Duplicate dispatch task ID.');
      assert(
        !assignmentIds.has(task.assignment.id),
        'Duplicate dispatch assignment ID.',
      );
      assert(
        !idempotencyKeys.has(task.idempotencyKey),
        'Duplicate dispatch idempotency key.',
      );
      assert(
        Array.isArray(task.dependsOn),
        'Dispatch dependencies are required.',
      );
      assert(
        task.dependsOn.length <= MAX_TASKS_PER_GROUP,
        'Too many dispatch dependencies.',
      );
      taskIds.add(task.taskId);
      globalTaskIds.add(task.taskId);
      assignmentIds.add(task.assignment.id);
      idempotencyKeys.add(task.idempotencyKey);
    }
    const byTaskId = new Map<string, Nx05DispatchIntent>(
      group.tasks.map((task: Nx05DispatchIntent) => [task.taskId, task]),
    );
    for (const task of group.tasks) {
      const dependencies = new Set<string>();
      for (const dependency of task.dependsOn) {
        safeId(dependency, 'Dispatch dependency ID');
        assert(taskIds.has(dependency), 'Undeclared dispatch dependency.');
        assert.notEqual(dependency, task.taskId, 'Dispatch dependency cycle.');
        assert(!dependencies.has(dependency), 'Duplicate dispatch dependency.');
        dependencies.add(dependency);
      }
    }
    const visited = new Set<string>();
    const active = new Set<string>();
    function visit(taskId: string): void {
      assert(!active.has(taskId), 'Dispatch dependency cycle.');
      if (visited.has(taskId)) return;
      active.add(taskId);
      for (const dependency of byTaskId.get(taskId)!.dependsOn) {
        visit(dependency);
      }
      active.delete(taskId);
      visited.add(taskId);
    }
    for (const taskId of taskIds) visit(taskId);
  }
}

type Nx05WorkerPublication = {
  [Status in WorkerResultStatus]: {
    readonly status: Status extends 'PASS' ? 'SUCCEEDED' : Status;
    readonly result: WorkerResult & {
      readonly status: Status;
      readonly evidenceReferences: readonly [
        WorkerEvidenceReference,
        ...WorkerEvidenceReference[],
      ];
    };
    readonly error: null;
  };
}[WorkerResultStatus];

export type Nx05ChildPublication = {
  readonly taskId: string;
  readonly lease: Nx05LeaseWitness;
  readonly idempotencyKey: string;
} & (
  | Nx05WorkerPublication
  | { readonly status: 'FAILED'; readonly result: null; readonly error: string }
  | {
      readonly status: 'CANCELLED';
      readonly result: null;
      readonly error: null;
    }
);

export interface Nx05SharedControlProvider {
  readonly scope: 'shared-service';

  createParent(
    request: Omit<CreateRunRequest, 'now'>,
  ): Promise<MechanicalRunRecord>;
  loadParent(runId: string): Promise<MechanicalRunRecord | null>;
  claimParent(request: Omit<ClaimRunRequest, 'now'>): Promise<ClaimRunResult>;
  renewParent(
    request: Omit<RenewRunLeaseRequest, 'now'>,
  ): Promise<MechanicalRunRecord>;
  cancelParent(
    request: Omit<CancelRunRequest, 'now'>,
  ): Promise<MechanicalRunRecord>;
  claimChildGroup(
    request: Omit<ClaimChildTaskGroupRequest, 'now'>,
  ): Promise<ClaimChildTaskGroupResult>;
  renewChild(
    request: Omit<RenewChildTaskLeaseRequest, 'now'>,
  ): Promise<ChildTaskRecord>;
  loadChild(taskId: string): Promise<ChildTaskRecord | null>;

  commitParentAndDispatch(
    request: Nx05ParentCommit,
  ): Promise<MechanicalRunRecord>;

  publishChild(request: Nx05ChildPublication): Promise<ChildTaskRecord>;
}

export interface Nx05ImmutableArtifactProvider {
  put(input: PutEvidenceRequest): Promise<WorkerEvidenceReference>;
  load(reference: WorkerEvidenceReference): Promise<Uint8Array>;
}
