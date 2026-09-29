import type { WorkerEvidenceReference } from './evidence.js';

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
  /** Required work fails the join; optional work may be reported as degraded. */
  readonly required: boolean;
  readonly brief: WorkerBrief;
}

export interface WorkerResult {
  readonly status: WorkerResultStatus;
  readonly summary: string;
  readonly evidencePaths: readonly string[];
  readonly rawLogPath: string | null;
  /** Portable identities for evidence retained by the runtime. */
  readonly evidenceReferences?: readonly WorkerEvidenceReference[];
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

function evidenceReference(
  value: WorkerEvidenceReference,
  field: string,
  issues: string[],
): void {
  if (value.schema !== 1) issues.push(`${field}.schema must be 1.`);
  evidencePath(value.runId, `${field}.runId`, issues);
  evidencePath(value.revision, `${field}.revision`, issues);
  if (
    !['stdout', 'stderr', 'worker-result', 'verification', 'other'].includes(
      value.kind,
    )
  ) {
    issues.push(`${field}.kind is not supported.`);
  }
  if (!/^[0-9a-f]{64}$/.test(value.sha256)) {
    issues.push(`${field}.sha256 must be a lowercase SHA-256 digest.`);
  }
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 0) {
    issues.push(`${field}.bytes must be a non-negative safe integer.`);
  }
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
  result.evidenceReferences?.forEach((value, index) => {
    evidenceReference(value, `evidenceReferences[${index}]`, issues);
  });
  if (
    result.workspaceManifestId !== undefined &&
    result.workspaceManifestId !== null
  ) {
    evidencePath(result.workspaceManifestId, 'workspaceManifestId', issues);
  }
  if (
    result.evidencePaths.length === 0 &&
    result.rawLogPath === null &&
    (result.evidenceReferences?.length ?? 0) === 0
  ) {
    issues.push(
      'a worker result must retain evidencePaths, rawLogPath, or portable evidence references.',
    );
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

export function validateWorkerAssignment(
  assignment: WorkerAssignment,
): readonly string[] {
  const issues: string[] = [];
  if (typeof assignment.required !== 'boolean') {
    issues.push('required must be a boolean.');
  }
  issues.push(...validateWorkerBrief(assignment.brief));
  return issues;
}

export function assertWorkerAssignment(assignment: WorkerAssignment): void {
  const issues = validateWorkerAssignment(assignment);
  if (issues.length > 0) {
    throw new Error(`Invalid WorkerAssignment: ${issues.join(' ')}`);
  }
}
