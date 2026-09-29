import type { WorkerResult } from '@temari/contracts';

import type {
  Nx05ChildPublication,
  Nx05DispatchGroup,
  Nx05DispatchIntent,
  Nx05FileProcessAdapters,
  Nx05LeaseWitness,
  Nx05ParentCommit,
  Nx05SharedControlProvider,
} from './nx05-control-contract.js';

type Reject<Condition extends false> = Condition;

export type FileAdapterIsNotShared = Reject<
  Nx05FileProcessAdapters extends Nx05SharedControlProvider ? true : false
>;

export type SharedProviderHasNoRawStores = Reject<
  Extract<
    'runs' | 'children' | 'appendEvent' | 'complete',
    keyof Nx05SharedControlProvider
  > extends never
    ? false
    : true
>;

export type ParentCommitRequiresStatus = Reject<
  Omit<Nx05ParentCommit, 'status'> extends Nx05ParentCommit ? true : false
>;

export type DispatchRequiresAssignment = Reject<
  Omit<Nx05DispatchIntent, 'assignment'> extends Nx05DispatchIntent
    ? true
    : false
>;

export type DispatchGroupRequiresBound = Reject<
  Omit<Nx05DispatchGroup, 'maxConcurrency'> extends Nx05DispatchGroup
    ? true
    : false
>;

type SuccessWithoutArtifactReferences = {
  readonly taskId: string;
  readonly lease: Nx05LeaseWitness;
  readonly idempotencyKey: string;
  readonly status: 'SUCCEEDED';
  readonly result: WorkerResult & { readonly status: 'PASS' };
  readonly error: null;
};

export type SuccessfulChildRequiresArtifactReferences = Reject<
  SuccessWithoutArtifactReferences extends Nx05ChildPublication ? true : false
>;
