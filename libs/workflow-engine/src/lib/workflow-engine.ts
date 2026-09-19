import {
  DEFAULT_STAGES,
  expandedPlan,
  missingCapabilities,
  minimalPlan,
  type ExecutionPlan,
  type HostCapability,
  type WorkType,
  type WorkflowStageId,
} from '@temari/contracts';

export interface CapabilityGap {
  readonly required: readonly HostCapability[];
  readonly missing: readonly HostCapability[];
}

export type StageHandler = (
  stage: WorkflowStageId,
  plan: ExecutionPlan,
) => Promise<void> | void;

export class CapabilityError extends Error {
  constructor(readonly gap: CapabilityGap) {
    super(`Host is missing required capabilities: ${gap.missing.join(', ')}`);
    this.name = 'CapabilityError';
  }
}

export function planFor(
  workType: WorkType,
  risk: 'local' | 'shared',
): ExecutionPlan {
  return risk === 'local' ? minimalPlan(workType) : expandedPlan(workType);
}

export function assertCapabilities(
  plan: ExecutionPlan,
  available: readonly HostCapability[],
): void {
  const missing = missingCapabilities(plan.requiredCapabilities, available);
  if (missing.length > 0) {
    throw new CapabilityError({
      required: plan.requiredCapabilities,
      missing,
    });
  }
}

/**
 * Same stage sequence for every plan. Policy (delegation, review,
 * evidence, delivery) is read from the plan — never from a second engine.
 */
export async function runPlan(
  plan: ExecutionPlan,
  available: readonly HostCapability[],
  handler: StageHandler,
): Promise<void> {
  assertCapabilities(plan, available);
  const stages = plan.stages.length > 0 ? plan.stages : DEFAULT_STAGES;
  for (const stage of stages) {
    await handler(stage, plan);
  }
}
