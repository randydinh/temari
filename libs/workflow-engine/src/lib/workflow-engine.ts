import {
  DEFAULT_STAGES,
  missingCapabilities,
  type ExecutionPlan,
  type HostCapability,
  type HostCapabilityReport,
  assertWorkerBrief,
  assertWorkerResult,
  type WorkerAssignment,
  type WorkerResult,
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

export interface ParallelWorkerOutcome {
  readonly assignment: WorkerAssignment;
  readonly result: WorkerResult | null;
  readonly error: string | null;
}

export type ParallelWorkerFailureKind =
  'plan-gap' | 'capability-gap' | 'worker-error' | 'worker-status';

export interface ParallelWorkerFailure {
  readonly kind: ParallelWorkerFailureKind;
  readonly message: string;
  readonly workerId: string | null;
  readonly missingCapabilities: readonly HostCapability[];
}

export interface ParallelWorkerReceipt {
  readonly schema: 1;
  readonly runId: string;
  readonly revision: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly status: WorkflowReceiptStatus;
  readonly maxConcurrency: number;
  readonly peakConcurrency: number;
  readonly outcomes: readonly ParallelWorkerOutcome[];
  readonly failure: ParallelWorkerFailure | null;
}

export interface ParallelWorkerRunRequest {
  readonly runId: string;
  readonly revision: string;
  readonly plan: ExecutionPlan;
  readonly capabilities: HostCapabilityReport;
  readonly assignments: readonly WorkerAssignment[];
  readonly handler: (
    assignment: WorkerAssignment,
  ) => Promise<WorkerResult> | WorkerResult;
  readonly maxConcurrency?: number;
  readonly now?: () => Date;
}

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

function workerError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isWorkerId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function validateParallelAssignments(
  assignments: readonly WorkerAssignment[],
): void {
  if (assignments.length === 0) {
    throw new Error(
      'Parallel worker execution requires at least one assignment.',
    );
  }

  const ids = new Set<string>();
  assignments.forEach((assignment, index) => {
    if (!isWorkerId(assignment.id)) {
      throw new Error(`Worker assignment ${index} has an invalid ID.`);
    }
    if (ids.has(assignment.id)) {
      throw new Error(`Worker assignment ID is duplicated: ${assignment.id}.`);
    }
    ids.add(assignment.id);
    assertWorkerBrief(assignment.brief);
  });
}

function aggregateWorkerStatus(
  outcomes: readonly ParallelWorkerOutcome[],
): WorkflowReceiptStatus {
  if (outcomes.some((outcome) => outcome.error !== null)) return 'BLOCKED';
  if (outcomes.some((outcome) => outcome.result?.status === 'BLOCKED')) {
    return 'BLOCKED';
  }
  if (outcomes.some((outcome) => outcome.result?.status === 'ISSUES')) {
    return 'ISSUES';
  }
  if (outcomes.some((outcome) => outcome.result?.status === 'DROPPED')) {
    return 'DROPPED';
  }
  return 'PASS';
}

function firstWorkerFailure(
  outcomes: readonly ParallelWorkerOutcome[],
): ParallelWorkerFailure | null {
  const errored = outcomes.find((outcome) => outcome.error !== null);
  if (errored) {
    return {
      kind: 'worker-error',
      message: errored.error ?? 'Worker failed without an error message.',
      workerId: errored.assignment.id,
      missingCapabilities: [],
    };
  }

  const nonPass = outcomes.find(
    (outcome) => outcome.result && outcome.result.status !== 'PASS',
  );
  if (!nonPass?.result) return null;
  return {
    kind: 'worker-status',
    message: nonPass.result.summary,
    workerId: nonPass.assignment.id,
    missingCapabilities: [],
  };
}

/**
 * Execute independent worker assignments with a bounded fan-out and a stable
 * join. This is intentionally an in-memory execution primitive; durable child
 * task ownership, leases, retries, and recovery remain runtime work.
 */
export async function runParallelWorkers(
  request: ParallelWorkerRunRequest,
): Promise<ParallelWorkerReceipt> {
  const now = request.now ?? (() => new Date());
  const started = now();
  const declaredConcurrency = request.plan.parallelism?.maxConcurrency;
  const maxConcurrency = request.maxConcurrency ?? declaredConcurrency;

  if (declaredConcurrency === undefined) {
    const completed = now();
    return {
      schema: 1,
      runId: request.runId,
      revision: request.revision,
      startedAt: started.toISOString(),
      completedAt: completed.toISOString(),
      status: 'BLOCKED',
      maxConcurrency: 0,
      peakConcurrency: 0,
      outcomes: [],
      failure: {
        kind: 'plan-gap',
        message: 'Execution plan does not declare a parallelism policy.',
        workerId: null,
        missingCapabilities: [],
      },
    };
  }

  if (
    maxConcurrency === undefined ||
    !Number.isInteger(maxConcurrency) ||
    maxConcurrency < 1 ||
    maxConcurrency > declaredConcurrency
  ) {
    throw new Error(
      'Parallel worker maxConcurrency must be a positive integer no greater than the plan limit.',
    );
  }

  const missing = missingCapabilities(
    request.plan.requiredCapabilities,
    request.capabilities.available,
  );
  if (
    declaredConcurrency > 1 &&
    !request.capabilities.available.includes('parallelism')
  ) {
    if (!missing.includes('parallelism')) missing.push('parallelism');
  }
  if (missing.length > 0) {
    const completed = now();
    return {
      schema: 1,
      runId: request.runId,
      revision: request.revision,
      startedAt: started.toISOString(),
      completedAt: completed.toISOString(),
      status: 'BLOCKED',
      maxConcurrency,
      peakConcurrency: 0,
      outcomes: [],
      failure: {
        kind: 'capability-gap',
        message: `Host is missing required capabilities: ${missing.join(', ')}`,
        workerId: null,
        missingCapabilities: missing,
      },
    };
  }

  validateParallelAssignments(request.assignments);
  const outcomes = new Array<ParallelWorkerOutcome>(request.assignments.length);
  let next = 0;
  let active = 0;
  let peak = 0;

  async function drain(): Promise<void> {
    while (true) {
      const index = next;
      next += 1;
      const assignment = request.assignments[index];
      if (!assignment) return;
      active += 1;
      peak = Math.max(peak, active);
      try {
        const result = await request.handler(assignment);
        assertWorkerResult(result);
        outcomes[index] = { assignment, result, error: null };
      } catch (error) {
        outcomes[index] = {
          assignment,
          result: null,
          error: workerError(error),
        };
      } finally {
        active -= 1;
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(maxConcurrency, request.assignments.length) },
      () => drain(),
    ),
  );

  const completed = now();
  const stableOutcomes = outcomes.filter(
    (outcome): outcome is ParallelWorkerOutcome => outcome !== undefined,
  );
  return {
    schema: 1,
    runId: request.runId,
    revision: request.revision,
    startedAt: started.toISOString(),
    completedAt: completed.toISOString(),
    status: aggregateWorkerStatus(stableOutcomes),
    maxConcurrency,
    peakConcurrency: peak,
    outcomes: stableOutcomes,
    failure: firstWorkerFailure(stableOutcomes),
  };
}
