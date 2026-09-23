import { HOST_CAPABILITIES, type HostCapability } from './capabilities.js';

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
 * Semantic obligations that are projected into one executable plan.
 *
 * The defaults describe the serial, local path. Stronger obligations add the
 * host capabilities they inherently require; callers do not have to duplicate
 * that mapping manually.
 */
export interface PlanObligations {
  readonly workType: WorkType;
  readonly delegation?: DelegationPolicy;
  readonly review?: ReviewPolicy;
  readonly evidence?: EvidencePolicy;
  readonly delivery?: DeliveryPolicy;
  readonly requiredCapabilities?: readonly HostCapability[];
}

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

function capabilitiesFor(
  obligations: Required<
    Pick<
      PlanObligations,
      'delegation' | 'review' | 'delivery' | 'requiredCapabilities'
    >
  >,
): readonly HostCapability[] {
  const required = new Set(obligations.requiredCapabilities);

  if (obligations.delegation === 'required') {
    required.add('subagents');
  }
  if (obligations.review === 'independent') {
    required.add('subagents');
  }
  if (obligations.delivery === 'pull-request') {
    required.add('forge');
  }

  return HOST_CAPABILITIES.filter((capability) => required.has(capability));
}

/** Convert semantic obligations into the single workflow-engine plan shape. */
export function reconcilePlan(obligations: PlanObligations): ExecutionPlan {
  const delegation = obligations.delegation ?? 'none';
  const review = obligations.review ?? 'self';
  const evidence = obligations.evidence ?? 'minimal';
  const delivery = obligations.delivery ?? 'local';

  return {
    version: 1,
    workType: obligations.workType,
    stages: DEFAULT_STAGES,
    delegation,
    review,
    evidence,
    delivery,
    requiredCapabilities: capabilitiesFor({
      delegation,
      review,
      delivery,
      requiredCapabilities: obligations.requiredCapabilities ?? [],
    }),
  };
}

export function minimalPlan(workType: WorkType = 'bug'): ExecutionPlan {
  return reconcilePlan({ workType });
}

export function expandedPlan(workType: WorkType = 'feature'): ExecutionPlan {
  return reconcilePlan({
    workType,
    delegation: 'required',
    review: 'independent',
    evidence: 'revision-bound',
    delivery: 'pull-request',
  });
}
