import type { HostCapability } from './capabilities.js';

export const WORKFLOW_STAGES = [
  'investigate',
  'plan',
  'build',
  'review',
  'verify',
  'deliver',
] as const;

export type WorkflowStageId = (typeof WORKFLOW_STAGES)[number];

export type WorkType =
  'investigation' | 'design' | 'bug' | 'feature' | 'qa' | 'migration';

export type DelegationPolicy = 'none' | 'optional' | 'required';
export type ReviewPolicy = 'self' | 'coordinator' | 'independent';
export type EvidencePolicy = 'minimal' | 'standard' | 'revision-bound';
export type DeliveryPolicy = 'local' | 'commit' | 'pull-request';

/**
 * One workflow engine, many plans.
 * Behavioral differences live here — not in a second lifecycle.
 */
export interface ExecutionPlan {
  readonly version: 1;
  readonly workType: WorkType;
  readonly stages: readonly WorkflowStageId[];
  readonly delegation: DelegationPolicy;
  readonly review: ReviewPolicy;
  readonly evidence: EvidencePolicy;
  readonly delivery: DeliveryPolicy;
  readonly requiredCapabilities: readonly HostCapability[];
}

export const DEFAULT_STAGES: readonly WorkflowStageId[] = WORKFLOW_STAGES;

export function minimalPlan(workType: WorkType = 'bug'): ExecutionPlan {
  return {
    version: 1,
    workType,
    stages: DEFAULT_STAGES,
    delegation: 'none',
    review: 'self',
    evidence: 'minimal',
    delivery: 'local',
    requiredCapabilities: [],
  };
}

export function expandedPlan(workType: WorkType = 'feature'): ExecutionPlan {
  return {
    version: 1,
    workType,
    stages: DEFAULT_STAGES,
    delegation: 'required',
    review: 'independent',
    evidence: 'revision-bound',
    delivery: 'pull-request',
    requiredCapabilities: ['subagents', 'forge'],
  };
}
