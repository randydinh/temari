/**
 * Portable boundaries for a reconciliation attempt. These values describe
 * observed state and approved intent; adapters remain responsible for Git,
 * task stores, and hashing the actual request payload.
 */

export const MERGE_OBSERVATION_KINDS = [
  'clean',
  'untracked',
  'unmerged',
  'mixed',
] as const;

export type MergeObservationKind = (typeof MERGE_OBSERVATION_KINDS)[number];

export const RECONCILIATION_PLAN_CLASSIFICATIONS = [
  'no-op',
  'automatic',
  'requires-confirmation',
  'manual-review',
] as const;

export type ReconciliationPlanClassification =
  (typeof RECONCILIATION_PLAN_CLASSIFICATIONS)[number];

export const RECONCILIATION_STATUSES = [
  'observed',
  'blocked',
  'awaiting-confirmation',
  'integrating',
  'verifying',
] as const;

export type ReconciliationStatus = (typeof RECONCILIATION_STATUSES)[number];

/** States a client may provide while creating a retained proposal. */
export const RECONCILIATION_INITIAL_STATUSES = [
  'observed',
  'blocked',
  'awaiting-confirmation',
] as const;

export const RECONCILIATION_BLOCKED_REASONS = [
  'invalidated',
  'observation-drift',
  'candidate-drift',
  'confirmation-mismatch',
  'evidence-unavailable',
  'manual-intervention-required',
] as const;

export type ReconciliationBlockedReason =
  (typeof RECONCILIATION_BLOCKED_REASONS)[number];

export const RECONCILIATION_ACTIONS = [
  'preserve',
  'integrate',
] as const;

export type ReconciliationActionKind =
  (typeof RECONCILIATION_ACTIONS)[number];

/**
 * An evidence identity has no local path or mutable URI. Resolution belongs to
 * a store; its digest and size make content substitution detectable.
 */
export interface ImmutableEvidenceReference {
  readonly schema: 1;
  readonly id: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly mediaType: string;
}

/** A stable candidate identity supplied by an adapter, not a Git revision. */
export interface ReconciliationCandidate {
  readonly schema: 'reconciliation-candidate-v1';
  readonly id: string;
  readonly sha256: string;
}

/** Immutable identities for the two deliberately separate filesystem roots. */
export interface ReconciliationRootIdentity {
  readonly id: string;
  readonly sha256: string;
}

export type ReconciliationAffectedPathClassification =
  | 'tracked'
  | 'untracked'
  | 'unmerged';
export interface ReconciliationIndexBlobIdentity {
  readonly stage: 0 | 1 | 2 | 3;
  readonly mode: string;
  readonly objectId: string;
}
export interface ReconciliationUnmergedStageIdentity {
  readonly stage: 1 | 2 | 3;
  readonly mode: string;
  readonly objectId: string;
}
export interface ReconciliationAffectedPath {
  readonly path: string;
  readonly classification: ReconciliationAffectedPathClassification;
  /** SHA-256 of the exact repository-relative path bytes. */
  readonly pathSha256: string;
  /** Exact index entries, sorted by Git stage. */
  readonly indexBlobs: readonly ReconciliationIndexBlobIdentity[];
  /** Exact unmerged entries, sorted by stage; empty unless unmerged. */
  readonly unmergedStages: readonly ReconciliationUnmergedStageIdentity[];
  readonly worktreeKind: 'file' | 'symlink' | 'directory' | 'missing';
  readonly worktreeSha256: string | null;
  /** SHA-256 of Git's binary no-external-diff output. */
  readonly diffSha256: string;
}
export interface ReconciliationRequiredCheck {
  readonly id: string;
  /** Digest of the configured check recipe, never an executable command. */
  readonly definitionSha256: string;
}
export interface ReconciliationExpectedComparison {
  readonly candidateEvidence: ImmutableEvidenceReference;
  readonly verificationEvidence: ImmutableEvidenceReference;
}

/**
 * The exact scope an adapter observed and an operator may review. These are
 * identities and declared intent only; they never authorize a filesystem or
 * Git operation.
 */
export interface ReconciliationScope {
  readonly schema: 1;
  readonly sourceRoot: ReconciliationRootIdentity;
  readonly candidateRoot: ReconciliationRootIdentity;
  readonly baseHead: ReconciliationRootIdentity;
  readonly operationHead: ReconciliationRootIdentity;
  readonly affectedPaths: readonly ReconciliationAffectedPath[];
  readonly resolutionIntent: 'preserve' | 'integrate';
  readonly requiredChecks: readonly ReconciliationRequiredCheck[];
  readonly expectedComparison: ReconciliationExpectedComparison;
}

/** A point-in-time, evidence-backed observation of merge-relevant state. */
export interface MergeObservation {
  readonly schema: 1;
  readonly observationId: string;
  readonly taskId: string;
  readonly taskVersion: string;
  readonly runId: string;
  readonly revision: string;
  readonly candidate: ReconciliationCandidate;
  readonly scope: ReconciliationScope;
  readonly observedAt: string;
  readonly kind: MergeObservationKind;
  readonly evidence: readonly ImmutableEvidenceReference[];
}

export interface ReconciliationRequestIdentity {
  readonly idempotencyKey: string;
  /** The fixed canonicalization used before calculating canonicalRequestSha256. */
  readonly canonicalRequestDigestAlgorithm: 'canonical-json-sha256-v1';
  /** Lowercase SHA-256 of the complete canonical request payload. */
  readonly canonicalRequestSha256: string;
}

export interface ReconciliationAction {
  readonly id: string;
  readonly kind: ReconciliationActionKind;
  readonly targetId: string;
}

/**
 * A classified, reviewable proposal. It does not perform any action and is
 * deliberately independent from a particular Git or task-runtime adapter.
 */
export interface ReconciliationPlan {
  readonly schema: 1;
  readonly id: string;
  readonly taskId: string;
  readonly taskVersion: string;
  readonly runId: string;
  readonly revision: string;
  readonly observationId: string;
  readonly candidate: ReconciliationCandidate;
  readonly scope: ReconciliationScope;
  readonly classification: ReconciliationPlanClassification;
  readonly status: ReconciliationStatus;
  readonly request: ReconciliationRequestIdentity;
  readonly summary: string;
  readonly actions: readonly ReconciliationAction[];
  readonly evidence: readonly ImmutableEvidenceReference[];
  readonly blockedReason?: ReconciliationBlockedReason;
}

/**
 * A durable confirmation binds a plan, its observed state, and the exact
 * request digest. It cannot authorize a later observation or altered request.
 */
export interface ReconciliationConfirmation {
  readonly schema: 1;
  readonly confirmationId: string;
  readonly planId: string;
  readonly observationId: string;
  readonly canonicalRequestSha256: string;
  readonly confirmedAt: string;
  readonly confirmedBy: string;
  readonly evidence: readonly ImmutableEvidenceReference[];
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MEDIA_TYPE = /^[^\s/]+\/[^\s/]+(?:;[^\s]+)?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyText(value: unknown, field: string, issues: string[]): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    issues.push(`${field} must be a non-empty string.`);
  } else if (value.includes('\0')) {
    issues.push(`${field} must not contain a NUL byte.`);
  }
}

function identity(value: unknown, field: string, issues: string[]): void {
  nonEmptyText(value, field, issues);
  if (typeof value === 'string' && !ID.test(value)) {
    issues.push(`${field} must use the portable identifier syntax.`);
  }
}

function sha256(value: unknown, field: string, issues: string[]): void {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    issues.push(`${field} must be a lowercase SHA-256 digest.`);
  }
}

function timestamp(value: unknown, field: string, issues: string[]): void {
  if (
    typeof value !== 'string' ||
    Number.isNaN(Date.parse(value)) ||
    !/^\d{4}-\d{2}-\d{2}T/.test(value)
  ) {
    issues.push(`${field} must be an ISO-8601 timestamp.`);
  }
}

function immutableEvidence(
  value: unknown,
  field: string,
  issues: string[],
): void {
  if (!isRecord(value)) {
    issues.push(`${field} must be an immutable evidence reference.`);
    return;
  }
  if (value.schema !== 1) issues.push(`${field}.schema must be 1.`);
  identity(value.id, `${field}.id`, issues);
  sha256(value.sha256, `${field}.sha256`, issues);
  if (!Number.isSafeInteger(value.bytes) || (value.bytes as number) < 0) {
    issues.push(`${field}.bytes must be a non-negative safe integer.`);
  }
  if (typeof value.mediaType !== 'string' || !MEDIA_TYPE.test(value.mediaType)) {
    issues.push(`${field}.mediaType must be a media type.`);
  }
}

function evidenceList(value: unknown, field: string, issues: string[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(`${field} must contain at least one immutable evidence reference.`);
    return;
  }
  value.forEach((reference, index) => {
    immutableEvidence(reference, `${field}[${index}]`, issues);
  });
}

function candidate(value: unknown, field: string, issues: string[]): void {
  if (!isRecord(value)) {
    issues.push(`${field} must be a reconciliation candidate.`);
    return;
  }
  if (value.schema !== 'reconciliation-candidate-v1') {
    issues.push(`${field}.schema must be reconciliation-candidate-v1.`);
  }
  identity(value.id, `${field}.id`, issues);
  sha256(value.sha256, `${field}.sha256`, issues);
}

function rootIdentity(value: unknown, field: string, issues: string[]): void {
  if (!isRecord(value)) {
    issues.push(`${field} must be a root or head identity.`);
    return;
  }
  identity(value.id, `${field}.id`, issues);
  sha256(value.sha256, `${field}.sha256`, issues);
}

function gitObjectId(value: unknown, field: string, issues: string[]): void {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value)) {
    issues.push(`${field} must be a lowercase Git object ID.`);
  }
}

function gitMode(value: unknown, field: string, issues: string[]): void {
  if (typeof value !== 'string' || !/^[0-7]{6}$/.test(value)) {
    issues.push(`${field} must be a six-digit Git mode.`);
  }
}

function pathStages(
  value: unknown,
  field: string,
  allowed: readonly number[],
  issues: string[],
): void {
  if (!Array.isArray(value)) {
    issues.push(`${field} must be an array.`);
    return;
  }
  let previous = -1;
  const seen = new Set<number>();
  value.forEach((entry, index) => {
    const entryField = `${field}[${index}]`;
    if (!isRecord(entry)) {
      issues.push(`${entryField} must be a Git stage identity.`);
      return;
    }
    if (!allowed.includes(entry.stage as number)) {
      issues.push(`${entryField}.stage is not supported.`);
    } else if (typeof entry.stage === 'number') {
      if (seen.has(entry.stage)) issues.push(`${entryField}.stage must be unique.`);
      if (entry.stage <= previous) issues.push(`${field} must be sorted by stage.`);
      seen.add(entry.stage);
      previous = entry.stage;
    }
    gitMode(entry.mode, `${entryField}.mode`, issues);
    gitObjectId(entry.objectId, `${entryField}.objectId`, issues);
  });
}

function scope(value: unknown, field: string, issues: string[]): void {
  if (!isRecord(value)) {
    issues.push(`${field} must be a reconciliation scope.`);
    return;
  }
  if (value.schema !== 1) issues.push(`${field}.schema must be 1.`);
  rootIdentity(value.sourceRoot, `${field}.sourceRoot`, issues);
  rootIdentity(value.candidateRoot, `${field}.candidateRoot`, issues);
  rootIdentity(value.baseHead, `${field}.baseHead`, issues);
  rootIdentity(value.operationHead, `${field}.operationHead`, issues);
  if (!Array.isArray(value.affectedPaths) || value.affectedPaths.length === 0) {
    issues.push(`${field}.affectedPaths must declare at least one affected path.`);
  } else {
    const paths = new Set<string>();
    let previousPath = '';
    value.affectedPaths.forEach((entry, index) => {
      const pathField = `${field}.affectedPaths[${index}]`;
      if (!isRecord(entry)) {
        issues.push(`${pathField} must be an affected path.`);
        return;
      }
      nonEmptyText(entry.path, `${pathField}.path`, issues);
      if (typeof entry.path === 'string') {
        if (entry.path.startsWith('/') || entry.path.split('/').includes('..'))
          issues.push(`${pathField}.path must be a relative, non-traversing path.`);
        if (paths.has(entry.path)) issues.push(`${pathField}.path must be unique.`);
        if (previousPath && entry.path.localeCompare(previousPath) <= 0)
          issues.push(`${field}.affectedPaths must be sorted by path.`);
        paths.add(entry.path);
        previousPath = entry.path;
      }
      if (!['tracked', 'untracked', 'unmerged'].includes(entry.classification as string))
        issues.push(`${pathField}.classification is not supported.`);
      sha256(entry.pathSha256, `${pathField}.pathSha256`, issues);
      pathStages(entry.indexBlobs, `${pathField}.indexBlobs`, [0, 1, 2, 3], issues);
      pathStages(entry.unmergedStages, `${pathField}.unmergedStages`, [1, 2, 3], issues);
      if (entry.classification === 'unmerged') {
        if (!Array.isArray(entry.unmergedStages) || entry.unmergedStages.length === 0)
          issues.push(`${pathField}.unmergedStages must retain unmerged index stages.`);
      } else if (Array.isArray(entry.unmergedStages) && entry.unmergedStages.length !== 0) {
        issues.push(`${pathField}.unmergedStages must be empty unless classification is unmerged.`);
      }
      if (!['file', 'symlink', 'directory', 'missing'].includes(entry.worktreeKind as string)) {
        issues.push(`${pathField}.worktreeKind is not supported.`);
      }
      if (entry.worktreeKind === 'file' || entry.worktreeKind === 'symlink') {
        sha256(entry.worktreeSha256, `${pathField}.worktreeSha256`, issues);
      } else if (entry.worktreeSha256 !== null) {
        issues.push(`${pathField}.worktreeSha256 must be null for a directory or missing path.`);
      }
      sha256(entry.diffSha256, `${pathField}.diffSha256`, issues);
    });
  }
  if (value.resolutionIntent !== 'preserve' && value.resolutionIntent !== 'integrate')
    issues.push(`${field}.resolutionIntent must be preserve or integrate.`);
  if (!Array.isArray(value.requiredChecks) || value.requiredChecks.length === 0) {
    issues.push(`${field}.requiredChecks must declare at least one required check.`);
  } else {
    const ids = new Set<string>();
    value.requiredChecks.forEach((check, index) => {
      const checkField = `${field}.requiredChecks[${index}]`;
      if (!isRecord(check)) {
        issues.push(`${checkField} must be a required check.`);
        return;
      }
      identity(check.id, `${checkField}.id`, issues);
      sha256(check.definitionSha256, `${checkField}.definitionSha256`, issues);
      if (typeof check.id === 'string') {
        if (ids.has(check.id)) issues.push(`${checkField}.id must be unique.`);
        ids.add(check.id);
      }
    });
  }
  if (!isRecord(value.expectedComparison)) {
    issues.push(`${field}.expectedComparison must declare candidate and verification evidence.`);
  } else {
    immutableEvidence(value.expectedComparison.candidateEvidence, `${field}.expectedComparison.candidateEvidence`, issues);
    immutableEvidence(value.expectedComparison.verificationEvidence, `${field}.expectedComparison.verificationEvidence`, issues);
  }
}

function requestIdentity(value: unknown, field: string, issues: string[]): void {
  if (!isRecord(value)) {
    issues.push(`${field} must be a request identity.`);
    return;
  }
  identity(value.idempotencyKey, `${field}.idempotencyKey`, issues);
  if (value.canonicalRequestDigestAlgorithm !== 'canonical-json-sha256-v1') {
    issues.push(
      `${field}.canonicalRequestDigestAlgorithm must be canonical-json-sha256-v1.`,
    );
  }
  sha256(value.canonicalRequestSha256, `${field}.canonicalRequestSha256`, issues);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value))
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

export function validateImmutableEvidenceReference(
  value: unknown,
): readonly string[] {
  const issues: string[] = [];
  immutableEvidence(value, 'evidence', issues);
  return issues;
}

export function assertImmutableEvidenceReference(
  value: unknown,
): asserts value is ImmutableEvidenceReference {
  const issues = validateImmutableEvidenceReference(value);
  if (issues.length > 0) {
    throw new Error(`Invalid immutable evidence reference: ${issues.join(' ')}`);
  }
}

export function validateMergeObservation(value: unknown): readonly string[] {
  const issues: string[] = [];
  if (!isRecord(value)) return ['MergeObservation must be an object.'];
  if (value.schema !== 1) issues.push('schema must be 1.');
  identity(value.observationId, 'observationId', issues);
  identity(value.taskId, 'taskId', issues);
  identity(value.taskVersion, 'taskVersion', issues);
  identity(value.runId, 'runId', issues);
  identity(value.revision, 'revision', issues);
  candidate(value.candidate, 'candidate', issues);
  scope(value.scope, 'scope', issues);
  timestamp(value.observedAt, 'observedAt', issues);
  if (!MERGE_OBSERVATION_KINDS.includes(value.kind as MergeObservationKind)) {
    issues.push('kind is not a supported merge observation kind.');
  }
  evidenceList(value.evidence, 'evidence', issues);
  return issues;
}

export function assertMergeObservation(
  value: unknown,
): asserts value is MergeObservation {
  const issues = validateMergeObservation(value);
  if (issues.length > 0) {
    throw new Error(`Invalid MergeObservation: ${issues.join(' ')}`);
  }
}

export function validateReconciliationPlan(value: unknown): readonly string[] {
  const issues: string[] = [];
  if (!isRecord(value)) return ['ReconciliationPlan must be an object.'];
  if (value.schema !== 1) issues.push('schema must be 1.');
  identity(value.id, 'id', issues);
  identity(value.taskId, 'taskId', issues);
  identity(value.taskVersion, 'taskVersion', issues);
  identity(value.runId, 'runId', issues);
  identity(value.revision, 'revision', issues);
  identity(value.observationId, 'observationId', issues);
  candidate(value.candidate, 'candidate', issues);
  scope(value.scope, 'scope', issues);
  if (
    !RECONCILIATION_PLAN_CLASSIFICATIONS.includes(
      value.classification as ReconciliationPlanClassification,
    )
  ) {
    issues.push('classification is not supported.');
  }
  if (!RECONCILIATION_STATUSES.includes(value.status as ReconciliationStatus)) {
    issues.push('status is not supported.');
  }
  requestIdentity(value.request, 'request', issues);
  nonEmptyText(value.summary, 'summary', issues);
  if (!Array.isArray(value.actions)) {
    issues.push('actions must be an array.');
  } else {
    const actionIds = new Set<string>();
    value.actions.forEach((action, index) => {
      const field = `actions[${index}]`;
      if (!isRecord(action)) {
        issues.push(`${field} must be a reconciliation action.`);
        return;
      }
      identity(action.id, `${field}.id`, issues);
      if (typeof action.id === 'string') {
        if (actionIds.has(action.id)) issues.push(`${field}.id must be unique.`);
        actionIds.add(action.id);
      }
      if (!RECONCILIATION_ACTIONS.includes(action.kind as ReconciliationActionKind)) {
        issues.push(`${field}.kind is not supported.`);
      }
      identity(action.targetId, `${field}.targetId`, issues);
    });
  }
  if (isRecord(value.scope) && Array.isArray(value.actions)) {
    for (const action of value.actions) {
      if (isRecord(action) && action.kind !== value.scope.resolutionIntent)
        issues.push('actions must match scope.resolutionIntent.');
    }
  }
  evidenceList(value.evidence, 'evidence', issues);

  if (value.status === 'blocked') {
    if (
      !RECONCILIATION_BLOCKED_REASONS.includes(
        value.blockedReason as ReconciliationBlockedReason,
      )
    ) {
      issues.push('blockedReason must be set to a supported reason when status is blocked.');
    }
  } else if (value.blockedReason !== undefined) {
    issues.push('blockedReason is only allowed when status is blocked.');
  }
  if (
    value.status === 'awaiting-confirmation' &&
    value.classification !== 'requires-confirmation' &&
    value.classification !== 'manual-review'
  ) {
    issues.push(
      'awaiting-confirmation status requires a confirmation-gated classification.',
    );
  }
  return issues;
}

export function assertReconciliationPlan(
  value: unknown,
): asserts value is ReconciliationPlan {
  const issues = validateReconciliationPlan(value);
  if (issues.length > 0) {
    throw new Error(`Invalid ReconciliationPlan: ${issues.join(' ')}`);
  }
}

/**
 * Integration and verification are executor observations. A client can only
 * create an evidence-backed observation, block, or confirmation-gated plan.
 */
export function validateInitialReconciliationPlan(
  value: unknown,
): readonly string[] {
  const issues = [...validateReconciliationPlan(value)];
  if (
    isRecord(value) &&
    !RECONCILIATION_INITIAL_STATUSES.includes(
      value.status as (typeof RECONCILIATION_INITIAL_STATUSES)[number],
    )
  ) {
    issues.push('initial plan status must be observed, blocked, or awaiting-confirmation.');
  }
  return issues;
}

export function assertInitialReconciliationPlan(
  value: unknown,
): asserts value is ReconciliationPlan {
  const issues = validateInitialReconciliationPlan(value);
  if (issues.length > 0) {
    throw new Error(`Invalid initial ReconciliationPlan: ${issues.join(' ')}`);
  }
}

export function validateReconciliationConfirmation(
  value: unknown,
): readonly string[] {
  const issues: string[] = [];
  if (!isRecord(value)) return ['ReconciliationConfirmation must be an object.'];
  if (value.schema !== 1) issues.push('schema must be 1.');
  identity(value.confirmationId, 'confirmationId', issues);
  identity(value.planId, 'planId', issues);
  identity(value.observationId, 'observationId', issues);
  sha256(value.canonicalRequestSha256, 'canonicalRequestSha256', issues);
  timestamp(value.confirmedAt, 'confirmedAt', issues);
  identity(value.confirmedBy, 'confirmedBy', issues);
  evidenceList(value.evidence, 'evidence', issues);
  return issues;
}

export function assertReconciliationConfirmation(
  value: unknown,
): asserts value is ReconciliationConfirmation {
  const issues = validateReconciliationConfirmation(value);
  if (issues.length > 0) {
    throw new Error(`Invalid ReconciliationConfirmation: ${issues.join(' ')}`);
  }
}

/** Validate cross-record bindings before an adapter starts integration. */
export function validateReconciliationBinding(
  plan: unknown,
  observation: unknown,
  confirmation?: unknown,
): readonly string[] {
  const issues = [
    ...validateReconciliationPlan(plan),
    ...validateMergeObservation(observation),
  ];
  if (issues.length > 0) return issues;
  const selectedPlan = plan as ReconciliationPlan;
  const selectedObservation = observation as MergeObservation;
  if (selectedPlan.observationId !== selectedObservation.observationId) {
    issues.push('plan.observationId must bind the supplied observation.');
  }
  if (
    selectedPlan.taskId !== selectedObservation.taskId ||
    selectedPlan.taskVersion !== selectedObservation.taskVersion ||
    selectedPlan.runId !== selectedObservation.runId ||
    selectedPlan.revision !== selectedObservation.revision ||
    selectedPlan.candidate.id !== selectedObservation.candidate.id ||
    selectedPlan.candidate.sha256 !== selectedObservation.candidate.sha256
  ) {
    issues.push('plan must bind the observation task, run, revision, and candidate.');
  }
  if (canonical(selectedPlan.scope) !== canonical(selectedObservation.scope)) {
    issues.push('plan.scope must exactly bind the supplied observation scope.');
  }
  if (confirmation !== undefined) {
    issues.push(...validateReconciliationConfirmation(confirmation));
    if (issues.length > 0) return issues;
    const selectedConfirmation = confirmation as ReconciliationConfirmation;
    if (selectedConfirmation.planId !== selectedPlan.id) {
      issues.push('confirmation.planId must bind the supplied plan.');
    }
    if (selectedConfirmation.observationId !== selectedObservation.observationId) {
      issues.push('confirmation.observationId must bind the supplied observation.');
    }
    if (
      selectedConfirmation.canonicalRequestSha256 !==
      selectedPlan.request.canonicalRequestSha256
    ) {
      issues.push('confirmation must bind the plan canonical request digest.');
    }
  }
  return issues;
}

export function assertReconciliationBinding(
  plan: unknown,
  observation: unknown,
  confirmation?: unknown,
): void {
  const issues = validateReconciliationBinding(plan, observation, confirmation);
  if (issues.length > 0) {
    throw new Error(`Invalid reconciliation binding: ${issues.join(' ')}`);
  }
}

/**
 * Reusing a key is safe only when it names the exact same canonical request.
 * Storage is responsible for looking up the prior identity before this check.
 */
export function validateReconciliationIdempotencyReuse(
  prior: unknown,
  next: unknown,
): readonly string[] {
  const issues: string[] = [];
  requestIdentity(prior, 'prior', issues);
  requestIdentity(next, 'next', issues);
  if (issues.length > 0) return issues;
  const previous = prior as ReconciliationRequestIdentity;
  const proposed = next as ReconciliationRequestIdentity;
  if (
    previous.idempotencyKey === proposed.idempotencyKey &&
    previous.canonicalRequestSha256 !== proposed.canonicalRequestSha256
  ) {
    issues.push(
      'idempotencyKey must not be reused for a different canonical request digest.',
    );
  }
  return issues;
}

export function assertReconciliationIdempotencyReuse(
  prior: unknown,
  next: unknown,
): void {
  const issues = validateReconciliationIdempotencyReuse(prior, next);
  if (issues.length > 0) {
    throw new Error(`Invalid reconciliation idempotency reuse: ${issues.join(' ')}`);
  }
}
