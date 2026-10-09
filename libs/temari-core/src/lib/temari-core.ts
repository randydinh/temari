import type {
  EvidenceKind,
  ExecutionPlan,
  PlanObligations,
  WorkerEvidenceReference,
  WorkType,
  WorkflowReceipt,
} from '@temari/contracts';
import { reconcilePlan, WORKFLOW_STAGES } from '@temari/contracts';

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

export type TemariRequestScope =
  'full' | 'explicitly-narrow' | 'bounded-subtask';

export type TemariProgramKind =
  | 'autonomous-run'
  | 'orchestrate'
  | 'autopilot-full'
  | 'autopilot-stack'
  | 'multi-phase-plan';

export type QaResponsibility =
  | 'ticket-coverage'
  | 'test-plan-review'
  | 'validation-disposition'
  | 'ticket-readiness';

export type QaRouteExclusion =
  | 'test-implementation'
  | 'known-defect-repair'
  | 'code-review'
  | 'agent-evaluation'
  | 'ambiguous-review';

export interface TemariRouteInput extends PotetoRouteInput {
  /** Structured intent; route selection never infers QA from keywords. */
  readonly qaResponsibility?: QaResponsibility;
  /** Program intent is explicit; a large work type alone does not infer it. */
  readonly programKind?: TemariProgramKind;
  /** An explicit exclusion keeps a superficially similar request on a playbook. */
  readonly qaExclusion?: QaRouteExclusion;
  readonly requestScope?: TemariRequestScope;
  /** Required when a QA-owned bounded subtask calls back into Poteto. */
  readonly parentReviewId?: string;
}

export type TemariPlaybookRoute = 'lightweight-engineering' | 'full-playbook';

export interface TemariPlaybookRouteEntry {
  readonly profileKind: 'playbook';
  readonly route: TemariPlaybookRoute;
  readonly owner: 'poteto-mode';
}

export interface TemariDomainRouteEntry {
  readonly profileKind: 'domain';
  readonly route: 'qa-review';
  /** Package-relative owner reserved for the internal QA domain implementation. */
  readonly owner: './qa-review';
}

export interface TemariProgramRouteEntry {
  readonly profileKind: 'program';
  readonly route: 'program';
  readonly owner: 'temari';
}

export type TemariRouteEntry =
  | TemariPlaybookRouteEntry
  | TemariDomainRouteEntry
  | TemariProgramRouteEntry;

/**
 * The first closed route table. It is deliberately data, not a plugin registry:
 * adding a route requires changing this reviewed package and its tests.
 */
export const TEMARI_ROUTE_TABLE: readonly TemariRouteEntry[] = Object.freeze([
  {
    profileKind: 'playbook',
    route: 'lightweight-engineering',
    owner: 'poteto-mode',
  },
  { profileKind: 'playbook', route: 'full-playbook', owner: 'poteto-mode' },
  { profileKind: 'domain', route: 'qa-review', owner: './qa-review' },
  { profileKind: 'program', route: 'program', owner: 'temari' },
]);

export interface TemariPlaybookRouteDecision {
  readonly profileKind: 'playbook';
  readonly route: TemariPlaybookRoute;
  readonly owner: 'poteto-mode';
  readonly requestScope: TemariRequestScope;
  readonly parentReviewId?: string;
  readonly playbook: 'lightweight-engineering' | null;
  readonly reason: PotetoRouteReason | 'qa-exclusion' | 'bounded-subtask';
}

export interface TemariQaRouteDecision {
  readonly profileKind: 'domain';
  readonly route: 'qa-review';
  readonly owner: './qa-review';
  readonly requestScope: Exclude<TemariRequestScope, 'bounded-subtask'>;
  readonly responsibility: QaResponsibility;
}

export interface TemariProgramRouteDecision extends TemariProgramRouteEntry {
  readonly requestScope: Exclude<TemariRequestScope, 'bounded-subtask'>;
  readonly programKind: TemariProgramKind;
  /** The current serial engine cannot certify a standing program. */
  readonly admission: 'planning-only';
}

export type TemariRouteDecision =
  | TemariPlaybookRouteDecision
  | TemariQaRouteDecision
  | TemariProgramRouteDecision;

export interface TemariPlanRequest extends TemariRouteInput {
  /** Optional policy refinements supplied by the coordinator, never by a host. */
  readonly obligations?: Omit<PlanObligations, 'workType'>;
}

export interface TemariRequestPlan {
  readonly route: TemariRouteDecision;
  readonly obligations: PlanObligations;
  readonly plan: ExecutionPlan;
}

export type CloseoutBlockReason =
  | 'receipt-not-pass'
  | 'stages-incomplete'
  | 'stage-evidence-missing'
  | 'evidence-missing'
  | 'evidence-identity-invalid'
  | 'evidence-run-mismatch'
  | 'evidence-revision-mismatch'
  | 'evidence-hash-invalid'
  | 'evidence-size-invalid';

export interface ReadyCloseoutDecision {
  readonly status: 'ready';
  readonly runId: string;
  readonly revision: string;
  readonly evidence: readonly WorkerEvidenceReference[];
}

export interface BlockedCloseoutDecision {
  readonly status: 'blocked';
  readonly runId: string;
  readonly revision: string;
  readonly reasons: readonly CloseoutBlockReason[];
  readonly resumable: true;
}

export type CloseoutDecision = ReadyCloseoutDecision | BlockedCloseoutDecision;

function routeEntry<T extends TemariRouteEntry>(
  profileKind: T['profileKind'],
  route: T['route'],
): T {
  const entry = TEMARI_ROUTE_TABLE.find(
    (candidate) =>
      candidate.profileKind === profileKind && candidate.route === route,
  );
  if (!entry || entry.profileKind !== profileKind || entry.route !== route) {
    throw new Error(`Temari route table is missing ${profileKind}:${route}.`);
  }
  return entry as T;
}

/**
 * Validate the closed table at the package boundary. This keeps a missing QA
 * or program owner, or a duplicate route, from degrading to a playbook.
 */
export function validateTemariRouteTable(
  entries: readonly TemariRouteEntry[] = TEMARI_ROUTE_TABLE,
): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = `${entry.profileKind}:${entry.route}`;
    if (seen.has(key)) {
      throw new Error(`Temari route table contains duplicate ${key}.`);
    }
    seen.add(key);
    if (!entry.owner) {
      throw new Error(`Temari route table entry ${key} has no owner.`);
    }
  }

  const qa = entries.find(
    (entry): entry is TemariDomainRouteEntry =>
      entry.profileKind === 'domain' && entry.route === 'qa-review',
  );
  if (!qa?.owner) {
    throw new Error('Temari route table has no qa-review domain owner.');
  }
  const program = entries.find(
    (entry): entry is TemariProgramRouteEntry =>
      entry.profileKind === 'program' && entry.route === 'program',
  );
  if (!program?.owner) {
    throw new Error('Temari route table has no program owner.');
  }
}

validateTemariRouteTable();

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
 * Classify the public Temari request boundary. QA responsibility is explicit
 * and wins over playbook similarity, except for a bounded callback from an
 * existing QA review, which is required to stay out of qa-review.
 */
export function classifyTemariRoute(
  input: TemariRouteInput,
): TemariRouteDecision {
  const requestScope = input.requestScope ?? 'full';

  if (input.programKind && (input.qaResponsibility || input.qaExclusion)) {
    throw new Error(
      'A Temari program route cannot also declare QA responsibility or exclusion.',
    );
  }

  if (input.programKind && requestScope === 'bounded-subtask') {
    throw new Error('A bounded subtask cannot start a Temari program.');
  }

  if (input.qaResponsibility && input.qaExclusion) {
    throw new Error(
      'A Temari route cannot declare both QA responsibility and a QA exclusion.',
    );
  }

  if (requestScope === 'bounded-subtask' && !input.parentReviewId) {
    throw new Error(
      'A bounded QA subtask must carry its parentReviewId recursion guard.',
    );
  }

  if (requestScope !== 'bounded-subtask' && input.parentReviewId) {
    throw new Error(
      'parentReviewId is only valid for a bounded-subtask request.',
    );
  }

  if (input.programKind) {
    const programRoute = routeEntry<TemariProgramRouteEntry>(
      'program',
      'program',
    );
    return {
      ...programRoute,
      requestScope:
        requestScope === 'explicitly-narrow' ? 'explicitly-narrow' : 'full',
      programKind: input.programKind,
      admission: 'planning-only',
    };
  }

  if (input.qaResponsibility && requestScope !== 'bounded-subtask') {
    const qaRoute = routeEntry<TemariDomainRouteEntry>('domain', 'qa-review');
    return {
      ...qaRoute,
      requestScope,
      responsibility: input.qaResponsibility,
    };
  }

  const playbook = classifyEngineeringRoute(input);
  const playbookRoute = routeEntry<TemariPlaybookRouteEntry>(
    'playbook',
    playbook.route,
  );

  return {
    ...playbookRoute,
    requestScope,
    ...(requestScope === 'bounded-subtask'
      ? { parentReviewId: input.parentReviewId }
      : {}),
    playbook: playbook.playbook,
    reason:
      requestScope === 'bounded-subtask'
        ? 'bounded-subtask'
        : input.qaExclusion
          ? 'qa-exclusion'
          : playbook.reason,
  };
}

function qaPlanObligations(
  obligations: Omit<PlanObligations, 'workType'> | undefined,
): Omit<PlanObligations, 'workType'> {
  if (obligations?.review && obligations.review !== 'independent') {
    throw new Error(
      'QA domain routes require independent review; the policy cannot be weakened.',
    );
  }
  if (obligations?.evidence && obligations.evidence !== 'revision-bound') {
    throw new Error(
      'QA domain routes require revision-bound evidence; the policy cannot be weakened.',
    );
  }

  return {
    ...obligations,
    review: 'independent',
    evidence: 'revision-bound',
  };
}

/**
 * Convert one classified public request into the single canonical plan shape.
 * This is the coordinator boundary; execution and host capability handling
 * remain owned by workflow-engine and host adapters.
 */
export function createRequestPlan(input: TemariPlanRequest): TemariRequestPlan {
  const route = classifyTemariRoute(input);
  const routeObligations =
    route.profileKind === 'domain'
      ? qaPlanObligations(input.obligations)
      : (input.obligations ?? {});
  const obligations: PlanObligations = {
    ...routeObligations,
    workType: input.workType,
  };

  return {
    route,
    obligations,
    plan: createExecutionPlan(obligations),
  };
}

const EVIDENCE_KINDS: ReadonlySet<EvidenceKind> = new Set([
  'stdout',
  'stderr',
  'worker-result',
  'verification',
  'other',
]);

/**
 * Derive a guarded closeout from immutable receipt facts and portable evidence
 * identities. This function does not load artifacts or judge product behavior;
 * the configured runtime/evidence store owns those observations.
 */
export function deriveCloseout(
  receipt: WorkflowReceipt,
  evidence: readonly WorkerEvidenceReference[],
): CloseoutDecision {
  const reasons = new Set<CloseoutBlockReason>();
  const add = (reason: CloseoutBlockReason): void => {
    reasons.add(reason);
  };

  if (receipt.status !== 'PASS') add('receipt-not-pass');

  const canonicalPlan =
    receipt.plan.stages.length === WORKFLOW_STAGES.length &&
    receipt.plan.stages.every(
      (stage, index) => stage === WORKFLOW_STAGES[index],
    );
  const completeStages =
    receipt.stages.length === WORKFLOW_STAGES.length &&
    receipt.stages.every(
      (stage, index) =>
        stage.stage === WORKFLOW_STAGES[index] && stage.status === 'PASS',
    );
  if (!canonicalPlan || !completeStages) add('stages-incomplete');
  if (receipt.stages.some((stage) => stage.evidencePaths.length === 0)) {
    add('stage-evidence-missing');
  }
  if (evidence.length === 0) add('evidence-missing');

  for (const reference of evidence) {
    if (
      reference.schema !== 1 ||
      !EVIDENCE_KINDS.has(reference.kind) ||
      !reference.runId ||
      !reference.revision
    ) {
      add('evidence-identity-invalid');
    }
    if (reference.runId !== receipt.runId) add('evidence-run-mismatch');
    if (reference.revision !== receipt.revision) {
      add('evidence-revision-mismatch');
    }
    if (!/^[0-9a-f]{64}$/.test(reference.sha256)) {
      add('evidence-hash-invalid');
    }
    if (!Number.isSafeInteger(reference.bytes) || reference.bytes < 0) {
      add('evidence-size-invalid');
    }
  }

  if (reasons.size > 0) {
    return {
      status: 'blocked',
      runId: receipt.runId,
      revision: receipt.revision,
      reasons: [...reasons],
      resumable: true,
    };
  }

  return {
    status: 'ready',
    runId: receipt.runId,
    revision: receipt.revision,
    evidence: [...evidence],
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

/** Explicit local engineering operation; never a fallback for feature-v1. */
export const REVIEWED_LOCAL_CANDIDATE_POLICY = Object.freeze({
  schema: 1,
  profile: 'reviewed-local-candidate-v1',
  owner: 'temari',
  method: 'poteto-mode',
  harness: 'archon',
  provider: 'codex',
  builders: 1,
  architect: 'read-only',
  reviewer: 'independent-exact-candidate',
  protectedChecks: 'required',
  publication: 'denied',
  maxAttempts: 1,
} as const);

export function createReviewedLocalCandidatePlan(): ExecutionPlan {
  return createExecutionPlan({
    workType: 'feature',
    delegation: 'required',
    review: 'independent',
    evidence: 'revision-bound',
    delivery: 'local',
    parallelism: { maxConcurrency: 1 },
  });
}
