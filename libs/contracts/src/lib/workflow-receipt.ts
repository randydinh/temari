import type { HostCapabilityReport } from './capabilities.js';
import type { ExecutionPlan, WorkflowStageId } from './execution-plan.js';

export type WorkflowReceiptStatus = 'PASS' | 'ISSUES' | 'BLOCKED' | 'DROPPED';

export type StageEvidenceProfile =
  'stage-evidence-v1' | 'candidate-stage-evidence-v1';

export interface CandidateIdentity {
  readonly scope: 'local-regular-files-v1' | 'git-tracked-files-v1';
  readonly sha256: string;
}

export interface CandidateBinding {
  readonly scopeId: string;
  readonly initial: CandidateIdentity;
}

export function assertCandidateIdentity(
  value: unknown,
): asserts value is CandidateIdentity {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'scope,sha256' ||
    !('scope' in value) ||
    (value.scope !== 'local-regular-files-v1' &&
      value.scope !== 'git-tracked-files-v1') ||
    !('sha256' in value) ||
    typeof value.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.sha256)
  ) {
    throw new Error('Invalid candidate identity.');
  }
}

export function assertCandidateBinding(
  value: unknown,
): asserts value is CandidateBinding {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'initial,scopeId' ||
    !('scopeId' in value) ||
    typeof value.scopeId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.scopeId) ||
    !('initial' in value)
  ) {
    throw new Error('Invalid candidate binding.');
  }
  assertCandidateIdentity(value.initial);
}

export function assertEvidenceProfile(
  profile: unknown,
  binding: unknown,
): void {
  if (profile === 'candidate-stage-evidence-v1') {
    assertCandidateBinding(binding);
  } else {
    if (profile !== undefined && profile !== 'stage-evidence-v1') {
      throw new Error('Unsupported stage evidence profile.');
    }
    if (binding !== undefined)
      throw new Error('Candidate binding requires candidate evidence profile.');
  }
}

export interface StageEvidenceReference {
  readonly schema: 1;
  readonly sha256: string;
  readonly bytes: number;
}

export type WorkflowReceiptFailureKind =
  'capability-gap' | 'stage-handler-error';

export interface WorkflowReceiptFailure {
  readonly kind: WorkflowReceiptFailureKind;
  readonly message: string;
  readonly stage: WorkflowStageId | null;
  readonly missingCapabilities: readonly string[];
}

export interface WorkflowStageReceipt {
  readonly stageEvidence?: StageEvidenceReference;
  readonly stage: WorkflowStageId;
  readonly status: WorkflowReceiptStatus;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly summary: string;
  readonly evidencePaths: readonly string[];
  readonly rawLogPath: string | null;
  /** Portable ID for the immutable workspace manifest captured at completion. */
  readonly workspaceManifestId?: string | null;
}

/**
 * The first durable-shape boundary for a workflow run.
 *
 * The current engine returns this value in memory. A later runtime may persist
 * the same shape without changing stage ownership or semantic decisions.
 */
export interface WorkflowReceipt {
  readonly evidenceProfile?: StageEvidenceProfile;
  readonly candidateBinding?: CandidateBinding;
  readonly schema: 1;
  readonly runId: string;
  readonly revision: string;
  readonly plan: ExecutionPlan;
  readonly capabilities: HostCapabilityReport;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly status: WorkflowReceiptStatus;
  readonly stages: readonly WorkflowStageReceipt[];
  readonly failure: WorkflowReceiptFailure | null;
}
