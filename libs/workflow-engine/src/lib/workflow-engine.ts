import {
  DEFAULT_STAGES,
  missingCapabilities,
  type ExecutionPlan,
  type HostCapability,
  type HostCapabilityReport,
  assertWorkerAssignment,
  assertWorkerResult,
  type WorkerAssignment,
  type WorkerResult,
  type WorkerResultStatus,
  type WorkflowReceipt,
  type WorkflowReceiptStatus,
  type WorkflowStageReceipt,
  type WorkflowStageId,
  type StageEvidenceProfile,
  type StageEvidenceReference,
  type CandidateBinding,
  assertEvidenceProfile,
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
  readonly stageEvidence?: StageEvidenceReference;
  readonly status: WorkflowReceiptStatus;
  readonly summary: string;
  readonly evidencePaths?: readonly string[];
  readonly rawLogPath?: string | null;
  readonly workspaceManifestId?: string | null;
}

export type StageReceiptHandler = (
  stage: WorkflowStageId,
  plan: ExecutionPlan,
) => Promise<StageReceiptResult> | StageReceiptResult;

/**
 * Durable prefix state for a workflow that has not yet published its final
 * receipt. Only PASS stages belong in a checkpoint; a non-pass stage must be
 * retried rather than treated as completed.
 */
export interface WorkflowCheckpoint {
  readonly evidenceProfile?: StageEvidenceProfile;
  readonly candidateBinding?: CandidateBinding;
  readonly schema: 1;
  readonly runId: string;
  readonly revision: string;
  readonly plan: ExecutionPlan;
  readonly capabilities: HostCapabilityReport;
  readonly startedAt: string;
  readonly stages: readonly WorkflowStageReceipt[];
}

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
  /** Optional portable evidence describing the execution measured above. */
  readonly executionEvidence?: ParallelExecutionEvidence;
  readonly outcomes: readonly ParallelWorkerOutcome[];
  readonly degradations?: readonly ParallelWorkerDegradation[];
  readonly failure: ParallelWorkerFailure | null;
}

export interface ParallelWorkerDegradation {
  readonly workerId: string;
  readonly status: WorkerResultStatus | 'ERROR';
  readonly message: string;
}

export interface ParallelExecutionEvidence {
  readonly schema: 1;
  readonly groupId: string | null;
  readonly assignmentIds: readonly string[];
  readonly maxConcurrency: number;
  readonly peakConcurrency: number;
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

export interface ParallelWorkerPreflight {
  readonly assignmentIds: readonly string[];
}

export interface ParallelWorkerJoin {
  readonly status: WorkflowReceiptStatus;
  readonly outcomes: readonly ParallelWorkerOutcome[];
  readonly degradations: readonly ParallelWorkerDegradation[];
  readonly failure: ParallelWorkerFailure | null;
}

export interface ReceiptRunRequest {
  readonly evidenceProfile?: StageEvidenceProfile;
  readonly candidateBinding?: CandidateBinding;
  readonly runId: string;
  readonly revision: string;
  readonly plan: ExecutionPlan;
  readonly capabilities: HostCapabilityReport;
  readonly handler: StageReceiptHandler;
  readonly now?: () => Date;
  readonly checkpoint?: WorkflowCheckpoint | null;
  readonly onInitialCheckpoint?: (
    checkpoint: WorkflowCheckpoint,
  ) => Promise<void> | void;
  readonly onStageCheckpoint?: (
    checkpoint: WorkflowCheckpoint,
  ) => Promise<void> | void;
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
 * Reject hand-built plans that attempt to reorder or omit the lifecycle.
 * Policy changes through the plan's obligations; lifecycle order does not.
 */
export function assertCanonicalStageSequence(plan: ExecutionPlan): void {
  if (
    plan.stages.length !== DEFAULT_STAGES.length ||
    plan.stages.some((stage, index) => stage !== DEFAULT_STAGES[index])
  ) {
    throw new Error(
      `Execution plan must use the canonical workflow stage sequence: ${DEFAULT_STAGES.join(', ')}.`,
    );
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
  assertCanonicalStageSequence(plan);
  assertCapabilities(plan, available);
  for (const stage of DEFAULT_STAGES) {
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
    ...(result.stageEvidence
      ? { stageEvidence: { ...result.stageEvidence } }
      : {}),
    status: result.status,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    summary: result.summary,
    evidencePaths: [...(result.evidencePaths ?? [])],
    rawLogPath: result.rawLogPath ?? null,
    workspaceManifestId: result.workspaceManifestId ?? null,
  };
}

function executionEvidence(
  assignments: readonly WorkerAssignment[],
  maxConcurrency: number,
  peakConcurrency: number,
): ParallelExecutionEvidence {
  return {
    schema: 1,
    groupId: null,
    assignmentIds: assignments.map((assignment) => assignment.id),
    maxConcurrency,
    peakConcurrency,
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function assertCheckpoint(
  request: ReceiptRunRequest,
  declaredStages: readonly WorkflowStageId[],
): readonly WorkflowStageReceipt[] {
  const checkpoint = request.checkpoint;
  assertEvidenceProfile(request.evidenceProfile, request.candidateBinding);
  if (!checkpoint) return [];
  assertEvidenceProfile(
    checkpoint.evidenceProfile,
    checkpoint.candidateBinding,
  );
  if (
    canonical(checkpoint.candidateBinding) !==
    canonical(request.candidateBinding)
  ) {
    throw new Error(
      'Workflow checkpoint candidate binding does not match the request.',
    );
  }
  if (checkpoint.evidenceProfile !== request.evidenceProfile) {
    throw new Error(
      'Workflow checkpoint evidence profile does not match the request.',
    );
  }
  if (checkpoint.schema !== 1)
    throw new Error('Unsupported workflow checkpoint schema.');
  if (checkpoint.runId !== request.runId) {
    throw new Error('Workflow checkpoint run ID does not match the request.');
  }
  if (checkpoint.revision !== request.revision) {
    throw new Error('Workflow checkpoint revision does not match the request.');
  }
  if (canonical(checkpoint.plan) !== canonical(request.plan)) {
    throw new Error('Workflow checkpoint plan does not match the request.');
  }
  if (canonical(checkpoint.capabilities) !== canonical(request.capabilities)) {
    throw new Error(
      'Workflow checkpoint capabilities do not match the request.',
    );
  }
  if (!Number.isFinite(Date.parse(checkpoint.startedAt))) {
    throw new Error('Workflow checkpoint start time is invalid.');
  }
  if (checkpoint.stages.length > declaredStages.length) {
    throw new Error('Workflow checkpoint contains too many stages.');
  }
  checkpoint.stages.forEach((stage, index) => {
    assertStageEvidence(request.evidenceProfile, stage);
    if (stage.stage !== declaredStages[index]) {
      throw new Error('Workflow checkpoint stages are not a declared prefix.');
    }
    if (stage.status !== 'PASS') {
      throw new Error('Workflow checkpoints may contain only PASS stages.');
    }
  });
  return [...checkpoint.stages];
}

function assertStageEvidence(
  profile: StageEvidenceProfile | undefined,
  result: StageReceiptResult,
): void {
  const reference = result.stageEvidence;
  if (!profile) {
    if (reference !== undefined)
      throw new Error('Stage evidence requires an evidence profile.');
    return;
  }
  if (result.status !== 'PASS' && reference === undefined) return;
  if (
    !reference ||
    reference.schema !== 1 ||
    !/^[0-9a-f]{64}$/.test(reference.sha256) ||
    !Number.isSafeInteger(reference.bytes) ||
    reference.bytes < 1
  ) {
    throw new Error('Invalid or missing stage evidence reference.');
  }
}

/**
 * Run one plan while returning a revision-bound in-memory receipt.
 *
 * This adds evidence shape and an optional durable checkpoint hook without
 * adding a second lifecycle. Capability gaps are represented as BLOCKED
 * receipts so callers can retain the reason instead of losing it to an
 * exception.
 */
export async function runPlanWithReceipt(
  request: ReceiptRunRequest,
): Promise<WorkflowReceipt> {
  assertCanonicalStageSequence(request.plan);
  const now = request.now ?? (() => new Date());
  const profile =
    request.evidenceProfile === undefined
      ? {}
      : {
          evidenceProfile: request.evidenceProfile,
          ...(request.candidateBinding
            ? { candidateBinding: structuredClone(request.candidateBinding) }
            : {}),
        };
  const checkpointStages = assertCheckpoint(request, DEFAULT_STAGES);
  const startedAt = request.checkpoint?.startedAt ?? now().toISOString();
  const stages: WorkflowStageReceipt[] = [...checkpointStages];
  const missing = missingCapabilities(
    request.plan.requiredCapabilities,
    request.capabilities.available,
  );

  if (missing.length > 0) {
    const completed = now();
    return {
      schema: 1,
      ...profile,
      runId: request.runId,
      revision: request.revision,
      plan: request.plan,
      capabilities: request.capabilities,
      startedAt,
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

  if (
    request.evidenceProfile === 'candidate-stage-evidence-v1' &&
    !request.checkpoint
  ) {
    await request.onInitialCheckpoint?.({
      schema: 1,
      ...profile,
      runId: request.runId,
      revision: request.revision,
      plan: request.plan,
      capabilities: request.capabilities,
      startedAt,
      stages: [],
    });
  }

  for (const stage of DEFAULT_STAGES.slice(checkpointStages.length)) {
    const stageStarted = now();
    let result: StageReceiptResult;
    try {
      result = await request.handler(stage, request.plan);
      assertStageEvidence(request.evidenceProfile, result);
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
        ...profile,
        runId: request.runId,
        revision: request.revision,
        plan: request.plan,
        capabilities: request.capabilities,
        startedAt,
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

    const stageCompleted = now();
    const receipt = stageReceipt(stage, stageStarted, stageCompleted, result);
    stages.push(receipt);

    if (result.status !== 'PASS') {
      const completed = now();
      return {
        schema: 1,
        ...profile,
        runId: request.runId,
        revision: request.revision,
        plan: request.plan,
        capabilities: request.capabilities,
        startedAt,
        completedAt: completed.toISOString(),
        status: result.status,
        stages,
        failure: null,
      };
    }

    await request.onStageCheckpoint?.({
      schema: 1,
      ...profile,
      runId: request.runId,
      revision: request.revision,
      plan: request.plan,
      capabilities: request.capabilities,
      startedAt,
      stages: [...stages],
    });
  }

  const completed = now();
  return {
    schema: 1,
    ...profile,
    runId: request.runId,
    revision: request.revision,
    plan: request.plan,
    capabilities: request.capabilities,
    startedAt,
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

export function preflightParallelWorkers(
  assignments: readonly WorkerAssignment[],
): ParallelWorkerPreflight {
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
    assertWorkerAssignment(assignment);
  });

  return { assignmentIds: assignments.map((assignment) => assignment.id) };
}

function aggregateWorkerStatus(
  outcomes: readonly ParallelWorkerOutcome[],
): WorkflowReceiptStatus {
  const required = outcomes.filter((outcome) => outcome.assignment.required);
  if (required.some((outcome) => outcome.error !== null)) return 'BLOCKED';
  if (required.some((outcome) => outcome.result?.status === 'BLOCKED')) {
    return 'BLOCKED';
  }
  if (required.some((outcome) => outcome.result?.status === 'ISSUES')) {
    return 'ISSUES';
  }
  if (required.some((outcome) => outcome.result?.status === 'DROPPED')) {
    return 'DROPPED';
  }
  return 'PASS';
}

function parallelWorkerDegradations(
  outcomes: readonly ParallelWorkerOutcome[],
): readonly ParallelWorkerDegradation[] {
  return outcomes.flatMap((outcome): ParallelWorkerDegradation[] => {
    if (outcome.assignment.required) return [];
    if (outcome.error !== null) {
      return [
        {
          workerId: outcome.assignment.id,
          status: 'ERROR' as const,
          message: outcome.error,
        },
      ];
    }
    if (!outcome.result || outcome.result.status === 'PASS') return [];
    return [
      {
        workerId: outcome.assignment.id,
        status: outcome.result.status,
        message: outcome.result.summary,
      },
    ];
  });
}

function firstWorkerFailure(
  outcomes: readonly ParallelWorkerOutcome[],
): ParallelWorkerFailure | null {
  const required = outcomes.filter((outcome) => outcome.assignment.required);
  const errored = required.find((outcome) => outcome.error !== null);
  if (errored) {
    return {
      kind: 'worker-error',
      message: errored.error ?? 'Worker failed without an error message.',
      workerId: errored.assignment.id,
      missingCapabilities: [],
    };
  }

  const nonPass = required.find(
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
 * Join worker outcomes only when they describe the exact declared membership.
 * Arrival order is irrelevant; the returned outcomes always follow the
 * assignment declaration order.
 */
export function joinParallelWorkers(
  assignments: readonly WorkerAssignment[],
  outcomes: readonly ParallelWorkerOutcome[],
): ParallelWorkerJoin {
  const preflight = preflightParallelWorkers(assignments);
  if (outcomes.length !== preflight.assignmentIds.length) {
    throw new Error(
      `Parallel worker outcome count ${outcomes.length} does not match assignment count ${preflight.assignmentIds.length}.`,
    );
  }

  const expected = new Set(preflight.assignmentIds);
  const byId = new Map<string, ParallelWorkerOutcome>();
  for (const outcome of outcomes) {
    const workerId = outcome.assignment.id;
    if (!expected.has(workerId)) {
      throw new Error(`Parallel worker outcome is not declared: ${workerId}.`);
    }
    if (byId.has(workerId)) {
      throw new Error(`Parallel worker outcome is duplicated: ${workerId}.`);
    }
    if (outcome.error === null) {
      if (outcome.result === null) {
        throw new Error(
          `Parallel worker ${workerId} has neither a result nor an error.`,
        );
      }
      assertWorkerResult(outcome.result);
    } else if (outcome.result !== null) {
      throw new Error(
        `Parallel worker ${workerId} cannot retain a result with an error.`,
      );
    }
    byId.set(workerId, outcome);
  }

  const stableOutcomes = preflight.assignmentIds.map((workerId) => {
    const outcome = byId.get(workerId);
    if (!outcome) {
      throw new Error(`Parallel worker outcome is missing: ${workerId}.`);
    }
    return outcome;
  });

  return {
    outcomes: stableOutcomes,
    status: aggregateWorkerStatus(stableOutcomes),
    degradations: parallelWorkerDegradations(stableOutcomes),
    failure: firstWorkerFailure(stableOutcomes),
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
      executionEvidence: executionEvidence(request.assignments, 0, 0),
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
      executionEvidence: executionEvidence(
        request.assignments,
        maxConcurrency,
        0,
      ),
      outcomes: [],
      failure: {
        kind: 'capability-gap',
        message: `Host is missing required capabilities: ${missing.join(', ')}`,
        workerId: null,
        missingCapabilities: missing,
      },
    };
  }

  preflightParallelWorkers(request.assignments);
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
  const joined = joinParallelWorkers(request.assignments, stableOutcomes);
  return {
    schema: 1,
    runId: request.runId,
    revision: request.revision,
    startedAt: started.toISOString(),
    completedAt: completed.toISOString(),
    status: joined.status,
    maxConcurrency,
    peakConcurrency: peak,
    executionEvidence: executionEvidence(
      request.assignments,
      maxConcurrency,
      peak,
    ),
    outcomes: joined.outcomes,
    degradations: joined.degradations,
    failure: joined.failure,
  };
}
