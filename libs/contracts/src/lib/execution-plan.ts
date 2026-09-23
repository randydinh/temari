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
  readonly parallelism?: ParallelismPolicy;
}

export interface ParallelismPolicy {
  readonly maxConcurrency: number;
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
  readonly parallelism?: ParallelismPolicy;
}

export const DEFAULT_STAGES: readonly WorkflowStageId[] = WORKFLOW_STAGES;

function capabilitiesFor(
  obligations: Required<
    Pick<
      PlanObligations,
      | 'delegation'
      | 'review'
      | 'delivery'
      | 'requiredCapabilities'
      | 'parallelism'
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
  if (obligations.parallelism.maxConcurrency > 1) {
    required.add('parallelism');
  }

  return HOST_CAPABILITIES.filter((capability) => required.has(capability));
}

function normalizeParallelism(
  parallelism: ParallelismPolicy | undefined,
): ParallelismPolicy | undefined {
  if (!parallelism) return undefined;
  if (
    !Number.isInteger(parallelism.maxConcurrency) ||
    parallelism.maxConcurrency < 1
  ) {
    throw new Error('parallelism.maxConcurrency must be a positive integer.');
  }
  return { maxConcurrency: parallelism.maxConcurrency };
}

/** Convert semantic obligations into the single workflow-engine plan shape. */
export function reconcilePlan(obligations: PlanObligations): ExecutionPlan {
  const delegation = obligations.delegation ?? 'none';
  const review = obligations.review ?? 'self';
  const evidence = obligations.evidence ?? 'minimal';
  const delivery = obligations.delivery ?? 'local';
  const parallelism = normalizeParallelism(obligations.parallelism);

  const plan: ExecutionPlan = {
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
      parallelism: parallelism ?? { maxConcurrency: 1 },
    }),
  };

  return parallelism ? { ...plan, parallelism } : plan;
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

export function parallelPlan(
  workType: WorkType = 'feature',
  maxConcurrency = 2,
): ExecutionPlan {
  return reconcilePlan({
    workType,
    delegation: 'required',
    review: 'independent',
    evidence: 'revision-bound',
    delivery: 'pull-request',
    parallelism: { maxConcurrency },
  });
}
