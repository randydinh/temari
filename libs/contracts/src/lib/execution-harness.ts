import type { ExecutionPlan } from './execution-plan.js';

/** Provider-neutral status for one native harness run. */
export type HarnessRunStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'BLOCKED'
  | 'CANCELLED'
  | 'UNKNOWN';

/** A plan execution request contains intent, never host credentials. */
export interface HarnessRunRequest {
  readonly runId: string;
  readonly revision: string;
  readonly plan: ExecutionPlan;
  readonly workspaceRoot: string;
  readonly entrypoint: string;
  readonly inputs: Readonly<Record<string, string>>;
}

/** Identity binding between a Temari run and a native harness run. */
export interface HarnessRunRef {
  readonly schema: 1;
  readonly harnessId: string;
  readonly harnessVersion: string;
  readonly runId: string;
  readonly revision: string;
  readonly planSha256: string;
  readonly externalRunId: string;
  readonly workspaceRoot: string;
  readonly entrypoint: string;
  readonly startedAt: string;
}

export interface HarnessRunSnapshot {
  readonly status: HarnessRunStatus;
  readonly observedAt: string;
  readonly summary: string;
  readonly rawLogPath: string | null;
}

/**
 * Run-level boundary for interchangeable workflow schedulers.
 * Host APIs/capabilities remain a separate adapter boundary.
 */
export interface ExecutionHarness {
  readonly id: string;
  readonly version: string;
  start(request: HarnessRunRequest): Promise<HarnessRunRef>;
  status(reference: HarnessRunRef): Promise<HarnessRunSnapshot>;
  resume(reference: HarnessRunRef): Promise<HarnessRunSnapshot>;
  /** Request cancellation of this exact run and return its observed status. */
  cancel?(reference: HarnessRunRef): Promise<HarnessRunSnapshot>;
}
