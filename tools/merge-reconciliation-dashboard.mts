import {
  assertInitialReconciliationPlan,
  assertMergeObservation,
  assertReconciliationBinding,
  assertReconciliationConfirmation,
  type MergeObservation,
  type ReconciliationConfirmation,
  type ReconciliationPlan,
  type ReconciliationScope,
  type ReconciliationStatus,
} from '../libs/contracts/src/index.js';
import {
  reconciliationStoreDigest,
  type CreateReconciliationAttemptRequest,
  type ReconciliationAttempt,
  type ReconciliationAttemptBinding,
} from '../libs/runtime/src/index.js';
import {
  observeGitReconciliation,
  type GitReconciliationObservation,
} from '../libs/host-adapters/src/lib/git-reconciliation-observer.js';

/** Dashboard-only view state. None of these states closes a Temari task. */
export type MergeReconciliationDashboardState = ReconciliationStatus;

export interface MergeReconciliationDashboardView {
  readonly attemptId: string;
  readonly state: MergeReconciliationDashboardState;
  readonly blockedReason: string | null;
  readonly taskId: string;
  readonly taskVersion: string;
  readonly runId: string;
  readonly revision: string;
  readonly observationId: string;
  readonly candidate: {
    readonly id: string;
    readonly sha256: string;
    /** Ready candidates still require human review; this is never terminal. */
    readonly readiness: 'not-ready';
  };
  readonly requiresConfirmation: boolean;
  readonly canConfirm: boolean;
  /** Always false: reconciliation readiness is not task completion. */
  readonly terminal: false;
}

export interface ReconciliationIntentStore {
  get(id: string): Promise<ReconciliationAttempt | null>;
  createAttempt(request: CreateReconciliationAttemptRequest): Promise<ReconciliationAttempt>;
  invalidateStaleBinding(
    id: string,
    current: ReconciliationAttemptBinding,
    reason?: string,
  ): Promise<ReconciliationAttempt>;
  confirm(
    id: string,
    confirmation: ReconciliationConfirmation,
    current: ReconciliationAttemptBinding,
  ): Promise<ReconciliationAttempt>;
}

/**
 * Reads the binding from trusted task/run/candidate and Git observation
 * sources. It intentionally receives only retained attempt identity, never
 * HTTP request data, so a caller cannot select the binding it wants to
 * confirm.
 */
export interface CurrentReconciliationBindingReader {
  readCurrentBinding(input: {
    readonly attemptId: string;
    readonly expected: ReconciliationAttemptBinding;
  }): Promise<ReconciliationAttemptBinding>;
}

export interface ReconciliationConfirmationIntent {
  readonly attemptId: string;
  readonly confirmation: ReconciliationConfirmation;
}

export interface ReconciliationInvalidationIntent {
  readonly attemptId: string;
}

/**
 * Task/run/candidate information deliberately comes from an injected trusted
 * reader. Git observation alone cannot establish those non-Git identities.
 */
export interface TrustedReconciliationScopeSnapshot {
  readonly taskId: string;
  readonly taskVersion: string;
  readonly runId: string;
  readonly revision: string;
  readonly observationId: string;
  readonly candidateId: string;
  readonly candidateSha256: string;
  readonly candidateRoot: ReconciliationScope['candidateRoot'];
  readonly resolutionIntent: ReconciliationScope['resolutionIntent'];
  readonly requiredChecks: ReconciliationScope['requiredChecks'];
  readonly expectedComparison: ReconciliationScope['expectedComparison'];
}

export interface TrustedReconciliationScopeSnapshotReader {
  readCurrentSnapshot(input: {
    readonly attemptId: string;
    readonly expected: ReconciliationAttemptBinding;
  }): Promise<TrustedReconciliationScopeSnapshot>;
}

export function observedGitReconciliationScope(
  git: GitReconciliationObservation,
  snapshot: TrustedReconciliationScopeSnapshot,
): ReconciliationScope {
  if (git.paths.length === 0) {
    throw new Error('No affected Git paths; no reconciliation attempt prepared.');
  }
  return observedGitReconciliationScopeIdentity(git, snapshot);
}

/**
 * The same canonical projection is used for preparation and live comparison.
 * An empty live projection can invalidate a retained attempt, but is never
 * admitted by observedGitReconciliationScope as a new reconciliation scope.
 * Raw Git object IDs remain unchanged in the observer evidence.
 */
function observedGitReconciliationScopeIdentity(
  git: GitReconciliationObservation,
  snapshot: TrustedReconciliationScopeSnapshot,
): ReconciliationScope {
  const unmerged = new Map(git.unmerged.map((entry) => [entry.path, entry.stages]));
  const untracked = new Set(git.untrackedPaths);
  const head = reconciliationStoreDigest({ headObjectId: git.source.headObjectId });
  return {
    schema: 1,
    sourceRoot: {
      id: 'git-source-root-v1',
      sha256: reconciliationStoreDigest({
        headObjectId: git.source.headObjectId,
        headReference: git.source.headReference,
      }),
    },
    candidateRoot: snapshot.candidateRoot,
    baseHead: { id: 'git-base-head-v1', sha256: head },
    operationHead: { id: `git-${git.operation}`, sha256: git.porcelainSha256 },
    affectedPaths: [...git.paths].sort((left, right) => left.path.localeCompare(right.path)).map((entry) => ({
      path: entry.path,
      pathSha256: entry.pathSha256,
      indexBlobs: [...entry.indexBlobs]
        .sort((left, right) => left.stage - right.stage)
        .map(({ stage, mode, objectId }) => ({ stage, mode, objectId })),
      unmergedStages: [...(unmerged.get(entry.path) ?? [])]
        .sort((left, right) => left.stage - right.stage)
        .map(({ stage, mode, objectId }) => ({ stage, mode, objectId })),
      worktreeKind: entry.worktreeKind,
      worktreeSha256: entry.worktreeSha256,
      diffSha256: entry.diffSha256,
      classification: unmerged.has(entry.path)
        ? 'unmerged' as const
        : untracked.has(entry.path)
          ? 'untracked' as const
          : 'tracked' as const,
    })),
    resolutionIntent: snapshot.resolutionIntent,
    requiredChecks: snapshot.requiredChecks,
    expectedComparison: snapshot.expectedComparison,
  };
}

/**
 * Compose the read-only Git observer with explicit trusted task/run/candidate
 * sources. To use this in production, create the original observation scope
 * with the same composition; a changed Git or non-Git snapshot then produces
 * a different binding and the store blocks confirmation.
 */
export function createObservedGitReconciliationBindingReader(options: {
  readonly repositoryRoot: string;
  readonly snapshotReader: TrustedReconciliationScopeSnapshotReader;
  readonly observe?: (repositoryRoot: string) => Promise<GitReconciliationObservation>;
}): CurrentReconciliationBindingReader {
  const observe = options.observe ?? observeGitReconciliation;
  return {
    async readCurrentBinding(input) {
      const [snapshot, git] = await Promise.all([
        options.snapshotReader.readCurrentSnapshot(input),
        observe(options.repositoryRoot),
      ]);
      return {
        taskId: snapshot.taskId,
        taskVersion: snapshot.taskVersion,
        runId: snapshot.runId,
        revision: snapshot.revision,
        observationId: snapshot.observationId,
        candidateId: snapshot.candidateId,
        candidateSha256: snapshot.candidateSha256,
        scopeSha256: reconciliationStoreDigest(observedGitReconciliationScopeIdentity(git, snapshot)),
      };
    },
  };
}

/**
 * A pure projection from durable attempt records. Human confirmation is only
 * retained evidence: it never claims executor integration, verification, or
 * candidate comparison. Stale bindings take precedence and stay visibly
 * blocked with their retained invalidation reason.
 */
export function projectMergeReconciliationAttempt(
  attempt: ReconciliationAttempt,
): MergeReconciliationDashboardView {
  const state: MergeReconciliationDashboardState = attempt.status === 'BLOCKED'
    ? 'blocked'
    : attempt.status === 'CONFIRMED'
      ? 'observed'
      : attempt.plan.status;
  const requiresConfirmation = attempt.plan.classification === 'requires-confirmation';
  return {
    attemptId: attempt.id,
    state,
    blockedReason: state === 'blocked'
      ? attempt.blockedReason ?? attempt.plan.blockedReason ?? 'Reconciliation is blocked.'
      : null,
    taskId: attempt.binding.taskId,
    taskVersion: attempt.binding.taskVersion,
    runId: attempt.binding.runId,
    revision: attempt.binding.revision,
    observationId: attempt.binding.observationId,
    candidate: {
      id: attempt.binding.candidateId,
      sha256: attempt.binding.candidateSha256,
      readiness: 'not-ready',
    },
    requiresConfirmation,
    canConfirm: attempt.status === 'PENDING' && requiresConfirmation && state === 'awaiting-confirmation',
    terminal: false,
  };
}

function assertAttemptId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error('Invalid reconciliation attempt ID.');
  }
}

function assertBinding(value: ReconciliationAttemptBinding): void {
  const fields: (keyof ReconciliationAttemptBinding)[] = [
    'taskId', 'taskVersion', 'runId', 'revision', 'observationId', 'candidateId', 'candidateSha256', 'scopeSha256',
  ];
  if (!value || typeof value !== 'object' || Object.keys(value).length !== fields.length
    || fields.some((field) => typeof value[field] !== 'string' || value[field].length === 0)) {
    throw new Error('Invalid current reconciliation binding.');
  }
}

/**
 * Validation/control facade for the final dashboard integration. It has no
 * task-runtime or Git authority: every durable change is delegated to the
 * supplied reconciliation store and is constrained by that store's replay
 * and immutable-evidence checks.
 */
export class MergeReconciliationDashboard {
  constructor(
    private readonly store: ReconciliationIntentStore,
    private readonly currentBindingReader?: CurrentReconciliationBindingReader,
  ) {}

  async view(attemptId: string): Promise<MergeReconciliationDashboardView | null> {
    assertAttemptId(attemptId);
    const attempt = await this.store.get(attemptId);
    return attempt ? this.project(attempt) : null;
  }

  async submitIntent(
    request: CreateReconciliationAttemptRequest,
  ): Promise<MergeReconciliationDashboardView> {
    assertIntent(request);
    return this.project(await this.store.createAttempt(request));
  }

  async invalidateIntent(
    intent: ReconciliationInvalidationIntent,
  ): Promise<MergeReconciliationDashboardView> {
    assertAttemptId(intent.attemptId);
    const current = await this.readCurrentBinding(intent.attemptId);
    return this.project(await this.store.invalidateStaleBinding(intent.attemptId, current));
  }

  async confirmIntent(
    intent: ReconciliationConfirmationIntent,
  ): Promise<MergeReconciliationDashboardView> {
    assertAttemptId(intent.attemptId);
    assertReconciliationConfirmation(intent.confirmation);
    const current = await this.readCurrentBinding(intent.attemptId);
    return this.project(await this.store.confirm(intent.attemptId, intent.confirmation, current));
  }

  private async readCurrentBinding(attemptId: string): Promise<ReconciliationAttemptBinding> {
    if (!this.currentBindingReader) {
      throw new Error('Current reconciliation binding reader is not configured; confirmation is blocked.');
    }
    const attempt = await this.store.get(attemptId);
    if (!attempt) throw new Error('Reconciliation attempt does not exist.');
    const current = await this.currentBindingReader.readCurrentBinding({
      attemptId,
      expected: attempt.binding,
    });
    assertBinding(current);
    return current;
  }

  private project(attempt: ReconciliationAttempt): MergeReconciliationDashboardView {
    const view = projectMergeReconciliationAttempt(attempt);
    return {
      ...view,
      canConfirm: view.canConfirm && Boolean(this.currentBindingReader),
    };
  }
}

function assertIntent(request: CreateReconciliationAttemptRequest): void {
  if (!request || typeof request !== 'object') throw new Error('Invalid reconciliation intent.');
  assertAttemptId(request.idempotencyKey);
  assertMergeObservation(request.observation as MergeObservation);
  assertInitialReconciliationPlan(request.plan as ReconciliationPlan);
  assertReconciliationBinding(request.plan, request.observation);
  if (request.idempotencyKey !== request.plan.request.idempotencyKey) {
    throw new Error('Reconciliation intent idempotency key differs from its plan request.');
  }
}
