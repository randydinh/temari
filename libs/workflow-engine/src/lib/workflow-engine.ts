import {
  DEFAULT_STAGES,
  missingCapabilities,
  type ExecutionPlan,
  type HostCapability,
  type HostCapabilityReport,
  type WorkflowReceipt,
  type WorkflowReceiptStatus,
  type WorkflowStageReceipt,
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

export interface StageReceiptResult {
  readonly status: WorkflowReceiptStatus;
  readonly summary: string;
  readonly evidencePaths?: readonly string[];
  readonly rawLogPath?: string | null;
}

export type StageReceiptHandler = (
  stage: WorkflowStageId,
  plan: ExecutionPlan,
) => Promise<StageReceiptResult> | StageReceiptResult;

export interface ReceiptRunRequest {
  readonly runId: string;
  readonly revision: string;
  readonly plan: ExecutionPlan;
  readonly capabilities: HostCapabilityReport;
  readonly handler: StageReceiptHandler;
  readonly now?: () => Date;
}

export class CapabilityError extends Error {
  constructor(readonly gap: CapabilityGap) {
    super(`Host is missing required capabilities: ${gap.missing.join(', ')}`);
    this.name = 'CapabilityError';
  }
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

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stageReceipt(
  stage: WorkflowStageId,
  startedAt: Date,
  completedAt: Date,
  result: StageReceiptResult,
): WorkflowStageReceipt {
  return {
    stage,
    status: result.status,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    summary: result.summary,
    evidencePaths: [...(result.evidencePaths ?? [])],
    rawLogPath: result.rawLogPath ?? null,
  };
}

/**
 * Run one plan while returning a revision-bound in-memory receipt.
 *
 * This adds evidence shape without adding persistence or a second lifecycle.
 * Capability gaps are represented as BLOCKED receipts so callers can retain
 * the reason instead of losing it to an exception.
 */
export async function runPlanWithReceipt(
  request: ReceiptRunRequest,
): Promise<WorkflowReceipt> {
  const now = request.now ?? (() => new Date());
  const started = now();
  const stages: WorkflowStageReceipt[] = [];
  const missing = missingCapabilities(
    request.plan.requiredCapabilities,
    request.capabilities.available,
  );

  if (missing.length > 0) {
    const completed = now();
    return {
      schema: 1,
      runId: request.runId,
      revision: request.revision,
      plan: request.plan,
      capabilities: request.capabilities,
      startedAt: started.toISOString(),
      completedAt: completed.toISOString(),
      status: 'BLOCKED',
      stages,
      failure: {
        kind: 'capability-gap',
        message: `Host is missing required capabilities: ${missing.join(', ')}`,
        stage: null,
        missingCapabilities: missing,
      },
    };
  }

  const declaredStages =
    request.plan.stages.length > 0 ? request.plan.stages : DEFAULT_STAGES;

  for (const stage of declaredStages) {
    const stageStarted = now();
    try {
      const result = await request.handler(stage, request.plan);
      const stageCompleted = now();
      stages.push(stageReceipt(stage, stageStarted, stageCompleted, result));

      if (result.status !== 'PASS') {
        const completed = now();
        return {
          schema: 1,
          runId: request.runId,
          revision: request.revision,
          plan: request.plan,
          capabilities: request.capabilities,
          startedAt: started.toISOString(),
          completedAt: completed.toISOString(),
          status: result.status,
          stages,
          failure: null,
        };
      }
    } catch (error) {
      const completed = now();
      stages.push(
        stageReceipt(stage, stageStarted, completed, {
          status: 'BLOCKED',
          summary: failureMessage(error),
        }),
      );
      return {
        schema: 1,
        runId: request.runId,
        revision: request.revision,
        plan: request.plan,
        capabilities: request.capabilities,
        startedAt: started.toISOString(),
        completedAt: completed.toISOString(),
        status: 'BLOCKED',
        stages,
        failure: {
          kind: 'stage-handler-error',
          message: failureMessage(error),
          stage,
          missingCapabilities: [],
        },
      };
    }
  }

  const completed = now();
  return {
    schema: 1,
    runId: request.runId,
    revision: request.revision,
    plan: request.plan,
    capabilities: request.capabilities,
    startedAt: started.toISOString(),
    completedAt: completed.toISOString(),
    status: 'PASS',
    stages,
    failure: null,
  };
}
