import { join } from 'node:path';

import type { WorkerEvidenceReference } from '@temari/contracts';

import {
  FileChildTaskStore,
  type ChildTaskRecord,
  type ChildTaskStore,
} from './child-task-store.js';
import { FileEvidenceStore, type EvidenceStore } from './evidence-store.js';
import {
  FileWorkflowRunStore,
  type MechanicalRunRecord,
  type RunEventPayload,
  type WorkflowRunStore,
} from './run-store.js';

export interface Nx05ConformanceAdapters {
  readonly scope: 'single-host-file' | 'shared-service';
  readonly runs: WorkflowRunStore;
  readonly children: ChildTaskStore;
  readonly artifacts: EvidenceStore;
}

export async function openNx05FileConformanceAdapters(
  root: string,
): Promise<Nx05ConformanceAdapters> {
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
  readonly event: RunEventPayload;
  readonly dispatch: readonly Nx05DispatchIntent[];
}

export interface Nx05ChildPublication {
  readonly taskId: string;
  readonly lease: Nx05LeaseWitness;
  readonly idempotencyKey: string;
  readonly evidence: readonly WorkerEvidenceReference[];
  readonly resultSha256: string;
}

export interface Nx05SharedControlProvider {
  readonly runs: WorkflowRunStore;
  readonly children: ChildTaskStore;

  /** Atomically persist the parent state, event, and dispatch intents under a live lease. */
  commitParentAndDispatch(
    request: Nx05ParentCommit,
  ): Promise<MechanicalRunRecord>;

  /** Refuse stale epochs and absent or hash-invalid evidence before publishing a child receipt. */
  publishChild(request: Nx05ChildPublication): Promise<ChildTaskRecord>;
}

export interface Nx05ImmutableArtifactProvider {
  put(input: {
    readonly runId: string;
    readonly revision: string;
    readonly content: Uint8Array;
  }): Promise<WorkerEvidenceReference>;
  load(reference: WorkerEvidenceReference): Promise<Uint8Array>;
}
