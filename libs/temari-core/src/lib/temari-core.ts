import type {
  ExecutionPlan,
  PlanObligations,
  WorkType,
} from '@temari/contracts';
import { reconcilePlan } from '@temari/contracts';

export const VERIFICATION_MAINTENANCE_SKILL =
  'maintain-verification-skill' as const;

export type VerificationMaintenanceOutcome = 'clean' | 'changed' | 'blocked';

export interface VerificationMaintenanceReceipt {
  readonly runId: string;
  readonly completedAt: string;
  readonly outcome: VerificationMaintenanceOutcome;
}

export interface VerificationMaintenancePolicy {
  readonly cadenceMs: number;
}

export const DAILY_VERIFICATION_MAINTENANCE: VerificationMaintenancePolicy =
  Object.freeze({ cadenceMs: 24 * 60 * 60 * 1000 });

export interface SkillDispatchIntent {
  readonly skillId: string;
  readonly reason: string;
  readonly inputs: readonly string[];
}

export type VerificationMaintenanceDecision =
  | {
      readonly due: true;
      readonly reason:
        | 'missing-receipt'
        | 'stale-receipt'
        | 'blocked-receipt'
        | 'invalid-receipt';
      readonly dispatch: SkillDispatchIntent;
    }
  | {
      readonly due: false;
      readonly reason: 'fresh-receipt';
      readonly nextDueAt: string;
    };

/**
 * Temari's semantic entry point for a classified engineering request.
 * Host adapters execute the resulting plan; they do not classify it.
 */
export function createExecutionPlan(
  obligations: PlanObligations,
): ExecutionPlan {
  return reconcilePlan(obligations);
}

export interface PotetoRouteInput {
  readonly workType: WorkType;
  readonly lightweight: {
    readonly resultIsClearLocalAndReversible: boolean;
    /** Includes public interfaces, shared data, persistence, permissions,
     * security, concurrency, deployment, dependencies, and external effects. */
    readonly changesSharedBoundary: boolean;
    readonly isReportedDefect: boolean;
    readonly hasUnexplainedSymptom: boolean;
    readonly makesPerformanceClaim: boolean;
    readonly isDesignChoice: boolean;
    readonly isMigration: boolean;
    readonly affectedCallersAreKnown: boolean;
    readonly crossesArchitecturalBoundary: boolean;
    readonly directCheckAvailable: boolean;
  };
}

export type PotetoRoute = 'lightweight-engineering' | 'full-playbook';

export type PotetoRouteReason =
  'all-lightweight-conditions-proven' | 'lightweight-condition-not-proven';

export interface PotetoRouteDecision {
  readonly route: PotetoRoute;
  /** A full route still needs the matching playbook selected by the coordinator. */
  readonly playbook: 'lightweight-engineering' | null;
  readonly reason: PotetoRouteReason;
}

/**
 * Apply the packaged Poteto route conditions without selecting a host or
 * inventing a full-playbook choice. A false or uncertain condition always
 * leaves lightweight engineering and requires the coordinator to choose the
 * appropriate full playbook.
 */
export function classifyEngineeringRoute(
  input: PotetoRouteInput,
): PotetoRouteDecision {
  const conditions = input.lightweight;
  const qualifies =
    conditions.resultIsClearLocalAndReversible &&
    !conditions.changesSharedBoundary &&
    !conditions.isReportedDefect &&
    !conditions.hasUnexplainedSymptom &&
    !conditions.makesPerformanceClaim &&
    !conditions.isDesignChoice &&
    !conditions.isMigration &&
    conditions.affectedCallersAreKnown &&
    !conditions.crossesArchitecturalBoundary &&
    conditions.directCheckAvailable;

  if (qualifies) {
    return {
      route: 'lightweight-engineering',
      playbook: 'lightweight-engineering',
      reason: 'all-lightweight-conditions-proven',
    };
  }

  return {
    route: 'full-playbook',
    playbook: null,
    reason: 'lightweight-condition-not-proven',
  };
}

/**
 * Classify the smallest serial engineering route without naming a host.
 * Stronger routes are supplied explicitly as obligations by the coordinator.
 */
export function classifySerialEngineering(
  workType: WorkType = 'bug',
): PlanObligations {
  return { workType };
}

function dispatch(reason: string): SkillDispatchIntent {
  return {
    skillId: VERIFICATION_MAINTENANCE_SKILL,
    reason,
    inputs: ['verification feature map', 'last-success receipt'],
  };
}

function parseReceipt(
  receipt: VerificationMaintenanceReceipt | undefined,
): { completedAtMs: number; outcome: VerificationMaintenanceOutcome } | null {
  if (!receipt || receipt.outcome === 'blocked' || !receipt.runId) {
    return receipt?.outcome === 'blocked'
      ? { completedAtMs: Number.NaN, outcome: 'blocked' }
      : null;
  }

  const completedAtMs = Date.parse(receipt.completedAt);
  if (!Number.isFinite(completedAtMs)) {
    return null;
  }

  return { completedAtMs, outcome: receipt.outcome };
}

/**
 * Decide whether the coordinator should dispatch daily verification
 * maintenance. This function has no host, scheduler, filesystem, or model
 * dependency. A caller supplies persistence and executes the returned intent.
 */
export function verificationMaintenanceDecision(
  receipt: VerificationMaintenanceReceipt | undefined,
  now: Date = new Date(),
  policy: VerificationMaintenancePolicy = DAILY_VERIFICATION_MAINTENANCE,
): VerificationMaintenanceDecision {
  const parsed = parseReceipt(receipt);
  if (!parsed) {
    return {
      due: true,
      reason: receipt ? 'invalid-receipt' : 'missing-receipt',
      dispatch: dispatch(
        receipt
          ? 'Receipt is invalid or cannot be trusted.'
          : 'No successful verification receipt exists.',
      ),
    };
  }

  if (parsed.outcome === 'blocked') {
    return {
      due: true,
      reason: 'blocked-receipt',
      dispatch: dispatch(
        'The previous verification maintenance run was blocked.',
      ),
    };
  }

  const nowMs = now.getTime();
  const nextDueMs = parsed.completedAtMs + policy.cadenceMs;
  if (!Number.isFinite(nowMs) || nowMs < parsed.completedAtMs) {
    return {
      due: true,
      reason: 'invalid-receipt',
      dispatch: dispatch(
        'The receipt timestamp is invalid or ahead of the coordinator clock.',
      ),
    };
  }

  if (nowMs >= nextDueMs) {
    return {
      due: true,
      reason: 'stale-receipt',
      dispatch: dispatch(
        'The last successful verification receipt is older than the cadence.',
      ),
    };
  }

  return {
    due: false,
    reason: 'fresh-receipt',
    nextDueAt: new Date(nextDueMs).toISOString(),
  };
}
