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

export interface WorkerAssignment {
  readonly id: string;
  readonly role: WorkerRole;
  readonly brief: WorkerBrief;
}

export interface WorkerResult {
  readonly status: WorkerResultStatus;
  readonly summary: string;
  readonly evidencePaths: readonly string[];
  readonly rawLogPath: string | null;
  readonly workspaceManifestId?: string | null;
}

const WORKER_RESULT_STATUSES: readonly WorkerResultStatus[] = [
  'PASS',
  'ISSUES',
  'BLOCKED',
  'DROPPED',
];

function nonEmpty(value: string, field: string, issues: string[]): void {
  if (value.trim().length === 0) issues.push(`${field} must not be empty.`);
}

function evidencePath(value: string, field: string, issues: string[]): void {
  nonEmpty(value, field, issues);
  if (value.includes('\0'))
    issues.push(`${field} must not contain a NUL byte.`);
}

/** Return shape and completeness issues without deciding whether work passed. */
export function validateWorkerBrief(brief: WorkerBrief): readonly string[] {
  const issues: string[] = [];
  nonEmpty(brief.goal, 'goal', issues);
  nonEmpty(brief.context, 'context', issues);
  nonEmpty(brief.scope, 'scope', issues);
  if (brief.acceptanceCriteria.length === 0) {
    issues.push('acceptanceCriteria must contain at least one criterion.');
  }
  brief.acceptanceCriteria.forEach((value, index) => {
    nonEmpty(value, `acceptanceCriteria[${index}]`, issues);
  });
  if (brief.verificationCommand !== null) {
    nonEmpty(brief.verificationCommand, 'verificationCommand', issues);
  }
  if (brief.reportFormat !== 'json' && brief.reportFormat !== 'markdown') {
    issues.push('reportFormat must be json or markdown.');
  }
  if (brief.forbiddenActions.length === 0) {
    issues.push('forbiddenActions must contain at least one boundary.');
  }
  brief.forbiddenActions.forEach((value, index) => {
    nonEmpty(value, `forbiddenActions[${index}]`, issues);
  });
  return issues;
}

/** Validate worker evidence shape while leaving semantic verdicts to Temari. */
export function validateWorkerResult(result: WorkerResult): readonly string[] {
  const issues: string[] = [];
  if (!WORKER_RESULT_STATUSES.includes(result.status)) {
    issues.push('status is not a supported worker result status.');
  }
  nonEmpty(result.summary, 'summary', issues);
  result.evidencePaths.forEach((value, index) => {
    evidencePath(value, `evidencePaths[${index}]`, issues);
  });
  if (result.rawLogPath !== null)
    evidencePath(result.rawLogPath, 'rawLogPath', issues);
  if (
    result.workspaceManifestId !== undefined &&
    result.workspaceManifestId !== null
  ) {
    evidencePath(result.workspaceManifestId, 'workspaceManifestId', issues);
  }
  if (result.evidencePaths.length === 0 && result.rawLogPath === null) {
    issues.push('a worker result must retain evidencePaths or rawLogPath.');
  }
  return issues;
}

export function assertWorkerBrief(brief: WorkerBrief): void {
  const issues = validateWorkerBrief(brief);
  if (issues.length > 0)
    throw new Error(`Invalid WorkerBrief: ${issues.join(' ')}`);
}

export function assertWorkerResult(result: WorkerResult): void {
  const issues = validateWorkerResult(result);
  if (issues.length > 0)
    throw new Error(`Invalid WorkerResult: ${issues.join(' ')}`);
}
