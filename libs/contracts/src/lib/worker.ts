export type WorkerRole =
  | 'coordinator'
  | 'investigator'
  | 'implementer'
  | 'verifier'
  | 'reviewer'
  | 'judge'
  | 'integrator';

export type WorkerResultStatus = 'PASS' | 'ISSUES' | 'BLOCKED' | 'DROPPED';

export interface WorkerBrief {
  readonly goal: string;
  readonly context: string;
  readonly scope: string;
  readonly acceptanceCriteria: readonly string[];
  readonly verificationCommand: string | null;
  readonly reportFormat: 'json' | 'markdown';
  readonly forbiddenActions: readonly string[];
}

export interface WorkerResult {
  readonly status: WorkerResultStatus;
  readonly summary: string;
  readonly evidencePaths: readonly string[];
  readonly rawLogPath: string | null;
}
