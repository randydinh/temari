import type { HostCapabilityReport } from './capabilities.js';
import type { ExecutionPlan, WorkflowStageId } from './execution-plan.js';

export type WorkflowReceiptStatus = 'PASS' | 'ISSUES' | 'BLOCKED' | 'DROPPED';

export type WorkflowReceiptFailureKind =
  | 'capability-gap'
  | 'stage-handler-error';

export interface WorkflowReceiptFailure {
  readonly kind: WorkflowReceiptFailureKind;
  readonly message: string;
  readonly stage: WorkflowStageId | null;
  readonly missingCapabilities: readonly string[];
}

export interface WorkflowStageReceipt {
  readonly stage: WorkflowStageId;
  readonly status: WorkflowReceiptStatus;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly summary: string;
  readonly evidencePaths: readonly string[];
  readonly rawLogPath: string | null;
}

/**
 * The first durable-shape boundary for a workflow run.
 *
 * The current engine returns this value in memory. A later runtime may persist
 * the same shape without changing stage ownership or semantic decisions.
 */
export interface WorkflowReceipt {
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
