import { join } from 'node:path';

import type {
  WorkerEvidenceReference,
  WorkerResult,
  WorkerResultStatus,
} from '@temari/contracts';

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
  readonly assignmentSha256: string;
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
  readonly dispatch: readonly Nx05DispatchIntent[];
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
