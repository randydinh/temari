import { createHash } from 'node:crypto';

import type { WorkerEvidenceReference } from '@temari/contracts';

import {
  type NonEmptyReadonlyArray,
  type QaAssignment,
  type QaReviewTier,
  validateQaAssignment,
} from './qa-assignment.js';
import {
  type QaEvaluatorVerdict,
  type QaReviewDisposition,
} from './qa-review.js';

export const QA_REVIEW_AREAS = [
  'happy-paths',
  'negative-cases',
  'boundaries',
  'state-transitions',
  'integration',
  'data-verification',
  'security-and-isolation',
  'concurrency-and-retries',
  'failure-and-recovery',
  'compatibility-and-regression',
  'other-applicable-checks',
] as const;

export type QaReviewArea = (typeof QA_REVIEW_AREAS)[number];

export type QaAreaDecisionStatus =
  'Applicable' | 'NotApplicable' | 'NeedsInvestigation';

export interface QaAreaDecision {
  readonly area: QaReviewArea;
  readonly status: QaAreaDecisionStatus;
  readonly basis: string;
}

export type QaCoverageKind =
  'TestmoCase' | 'AutomatedTest' | 'ManualProcedure' | 'Gap';

export type QaCoverageDesignState =
  'Proposed' | 'Selected' | 'Rejected' | 'NotApplicable';

export type QaCoverageImplementationState =
  'Missing' | 'Existing' | 'Added' | 'Updated' | 'Deferred' | 'NotApplicable';

export interface QaCoverageBinding {
  readonly bindingId: string;
  readonly kind: QaCoverageKind;
  readonly canonicalRef: string | null;
  readonly repositoryRevision: string | null;
  readonly assertionSummary: string | null;
  readonly designState: QaCoverageDesignState;
  readonly implementationState: QaCoverageImplementationState;
  readonly writeReceiptRef: string | null;
}

export type QaExecutionState = 'Executed' | 'Blocked' | 'NotRun';

export interface QaExecutionEvidence {
  readonly attemptId: string;
  readonly candidateRef: string;
  readonly environmentRef: string;
  readonly fixtureRefs: readonly string[];
  readonly correlationRef: string | null;
  readonly boundedObservation: string;
  readonly assertions: readonly string[];
  readonly observations: readonly string[];
  readonly evidenceRefs: readonly WorkerEvidenceReference[];
  readonly state: QaExecutionState;
}

export type QaScenarioObligation = 'Required' | 'Optional';

export type QaScenarioResult =
  'Passed' | 'Failed' | 'BlockedOrIncomplete' | 'NotRun';

export interface QaScenarioRecord {
  readonly scenarioId: string;
  readonly requirementRefs: NonEmptyReadonlyArray<string>;
  readonly conditions: string;
  readonly expectedBehavior: string;
  readonly sourceRevision: string;
  readonly behavioralReason: string;
  readonly areaMappings: NonEmptyReadonlyArray<QaReviewArea>;
  readonly obligation: QaScenarioObligation;
  readonly obligationRationale: string;
  readonly coverageBindings: readonly QaCoverageBinding[];
  readonly executions: readonly QaExecutionEvidence[];
  readonly result: QaScenarioResult;
  readonly nextAction: string;
}

export interface QaReviewPlan {
  readonly tier: QaReviewTier;
  readonly objectives: NonEmptyReadonlyArray<string>;
}

export interface QaEvaluationRound {
  readonly round: number;
  readonly evaluatorId: string;
  readonly freshContextAttestation: string;
  readonly verdict: QaEvaluatorVerdict;
  readonly findingIds: readonly string[];
  readonly evidenceRefs: readonly WorkerEvidenceReference[];
}

export interface QaEvaluationAttempt {
  readonly status: 'BLOCKED';
  readonly reason: 'separate-evaluator-unavailable' | 'environment-unavailable';
  readonly host: string;
  readonly tool: string;
  readonly invocationId: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly inputSha256: string;
  readonly allowedInputSha256: string;
  readonly outputSha256: null;
  readonly findings: readonly [];
}

export type QaReadbackStatus = 'Verified' | 'Failed' | 'Unavailable';

export interface QaExternalWriteReceipt {
  readonly operationKey: string;
  readonly systemRef: string;
  readonly recordRef: string;
  readonly beforeImageRef: string;
  readonly intendedChange: string;
  readonly savedStateRef: string;
  readonly readbackStatus: QaReadbackStatus;
}

export interface QaReviewRecord {
  readonly schemaVersion: 1;
  readonly reviewRevision: string;
  readonly parentRevision: string | null;
  readonly digest: string;
  readonly authorId: string;
  readonly assignment: QaAssignment;
  readonly plan: QaReviewPlan;
  readonly areaDecisions: readonly QaAreaDecision[];
  readonly scenarios: readonly QaScenarioRecord[];
  readonly evaluationRounds: readonly QaEvaluationRound[];
  readonly evaluationAttempts?: readonly QaEvaluationAttempt[];
  readonly qaDisposition: QaReviewDisposition;
  readonly dispositionBasis: string;
  readonly externalWriteReceipts: readonly QaExternalWriteReceipt[];
  readonly residualRisks: readonly string[];
}

export type QaReviewRecordInput = Omit<QaReviewRecord, 'digest'>;

function nonEmpty(
  value: string | null | undefined,
  field: string,
  issues: string[],
): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    issues.push(`${field} must not be empty.`);
  }
}

function textList(
  values: readonly string[],
  field: string,
  issues: string[],
  required = false,
): void {
  if (required && values.length === 0) {
    issues.push(`${field} must contain at least one entry.`);
  }
  values.forEach((value, index) =>
    nonEmpty(value, `${field}[${index}]`, issues),
  );
}

function enumValue<T extends string>(
  value: string,
  allowed: readonly T[],
  field: string,
  issues: string[],
): void {
  if (!allowed.includes(value as T)) {
    issues.push(`${field} has an unsupported value.`);
  }
}

function evidenceReference(
  reference: WorkerEvidenceReference,
  field: string,
  issues: string[],
): void {
  if (reference.schema !== 1) issues.push(`${field}.schema must be 1.`);
  nonEmpty(reference.runId, `${field}.runId`, issues);
  nonEmpty(reference.revision, `${field}.revision`, issues);
  enumValue(
    reference.kind,
    ['stdout', 'stderr', 'worker-result', 'verification', 'other'],
    `${field}.kind`,
    issues,
  );
  if (!/^[0-9a-f]{64}$/.test(reference.sha256)) {
    issues.push(`${field}.sha256 must be a lowercase SHA-256 digest.`);
  }
  if (!Number.isSafeInteger(reference.bytes) || reference.bytes < 0) {
    issues.push(`${field}.bytes must be a non-negative safe integer.`);
  }
}

function validateAreaDecisions(record: QaReviewRecord, issues: string[]): void {
  const seen = new Set<string>();
  for (const decision of record.areaDecisions) {
    enumValue(decision.area, QA_REVIEW_AREAS, 'areaDecisions.area', issues);
    enumValue(
      decision.status,
      ['Applicable', 'NotApplicable', 'NeedsInvestigation'],
      'areaDecisions.status',
      issues,
    );
    nonEmpty(decision.basis, 'areaDecisions.basis', issues);
    if (seen.has(decision.area)) {
      issues.push(`areaDecisions contains duplicate ${decision.area}.`);
    }
    seen.add(decision.area);
  }

  if (record.assignment.tier === 'focused') {
    if (record.areaDecisions.length > 0) {
      issues.push('focused reviews must not claim full area assessment.');
    }
    return;
  }

  if (record.areaDecisions.length !== QA_REVIEW_AREAS.length) {
    issues.push(
      `${record.assignment.tier} reviews require all ${QA_REVIEW_AREAS.length} area decisions.`,
    );
  }
  for (const area of QA_REVIEW_AREAS) {
    if (!seen.has(area)) issues.push(`areaDecisions is missing ${area}.`);
  }
}

function validateCoverageBinding(
  binding: QaCoverageBinding,
  field: string,
  issues: string[],
): void {
  nonEmpty(binding.bindingId, `${field}.bindingId`, issues);
  enumValue(
    binding.kind,
    ['TestmoCase', 'AutomatedTest', 'ManualProcedure', 'Gap'],
    `${field}.kind`,
    issues,
  );
  enumValue(
    binding.designState,
    ['Proposed', 'Selected', 'Rejected', 'NotApplicable'],
    `${field}.designState`,
    issues,
  );
  enumValue(
    binding.implementationState,
    ['Missing', 'Existing', 'Added', 'Updated', 'Deferred', 'NotApplicable'],
    `${field}.implementationState`,
    issues,
  );

  if (binding.designState === 'NotApplicable') {
    if (binding.implementationState !== 'NotApplicable') {
      issues.push(
        `${field} must use NotApplicable implementation state when design is NotApplicable.`,
      );
    }
    if (
      binding.canonicalRef !== null ||
      binding.repositoryRevision !== null ||
      binding.assertionSummary !== null ||
      binding.writeReceiptRef !== null
    ) {
      issues.push(`${field} cannot carry references when it is NotApplicable.`);
    }
  }
  if (
    binding.implementationState === 'NotApplicable' &&
    binding.designState !== 'NotApplicable'
  ) {
    issues.push(
      `${field} cannot use NotApplicable implementation without NotApplicable design.`,
    );
  }
  if (
    binding.designState === 'Proposed' &&
    ['Existing', 'Added', 'Updated'].includes(binding.implementationState)
  ) {
    issues.push(
      `${field} cannot be implemented before its design is selected.`,
    );
  }
  if (binding.canonicalRef !== null) {
    nonEmpty(binding.canonicalRef, `${field}.canonicalRef`, issues);
  }
  if (binding.repositoryRevision !== null) {
    nonEmpty(binding.repositoryRevision, `${field}.repositoryRevision`, issues);
  }
  if (binding.assertionSummary !== null) {
    nonEmpty(binding.assertionSummary, `${field}.assertionSummary`, issues);
  }
  if (binding.writeReceiptRef !== null) {
    nonEmpty(binding.writeReceiptRef, `${field}.writeReceiptRef`, issues);
  }
}

function validateExecution(
  execution: QaExecutionEvidence,
  field: string,
  issues: string[],
): void {
  nonEmpty(execution.attemptId, `${field}.attemptId`, issues);
  nonEmpty(execution.candidateRef, `${field}.candidateRef`, issues);
  nonEmpty(execution.environmentRef, `${field}.environmentRef`, issues);
  textList(execution.fixtureRefs, `${field}.fixtureRefs`, issues);
  if (execution.correlationRef !== null) {
    nonEmpty(execution.correlationRef, `${field}.correlationRef`, issues);
  }
  enumValue(
    execution.state,
    ['Executed', 'Blocked', 'NotRun'],
    `${field}.state`,
    issues,
  );
  if (execution.state === 'Executed') {
    nonEmpty(
      execution.boundedObservation,
      `${field}.boundedObservation`,
      issues,
    );
    textList(execution.assertions, `${field}.assertions`, issues, true);
    textList(execution.observations, `${field}.observations`, issues, true);
    if (execution.evidenceRefs.length === 0) {
      issues.push(
        `${field}.evidenceRefs must contain evidence for Executed work.`,
      );
    }
  }
  execution.evidenceRefs.forEach((reference, index) =>
    evidenceReference(reference, `${field}.evidenceRefs[${index}]`, issues),
  );
}

function validateScenario(
  record: QaReviewRecord,
  scenario: QaScenarioRecord,
  field: string,
  issues: string[],
): void {
  nonEmpty(scenario.scenarioId, `${field}.scenarioId`, issues);
  textList(scenario.requirementRefs, `${field}.requirementRefs`, issues, true);
  nonEmpty(scenario.conditions, `${field}.conditions`, issues);
  nonEmpty(scenario.expectedBehavior, `${field}.expectedBehavior`, issues);
  nonEmpty(scenario.sourceRevision, `${field}.sourceRevision`, issues);
  nonEmpty(scenario.behavioralReason, `${field}.behavioralReason`, issues);
  textList(scenario.areaMappings, `${field}.areaMappings`, issues, true);
  scenario.areaMappings.forEach((area, index) =>
    enumValue(area, QA_REVIEW_AREAS, `${field}.areaMappings[${index}]`, issues),
  );
  enumValue(
    scenario.obligation,
    ['Required', 'Optional'],
    `${field}.obligation`,
    issues,
  );
  nonEmpty(
    scenario.obligationRationale,
    `${field}.obligationRationale`,
    issues,
  );
  enumValue(
    scenario.result,
    ['Passed', 'Failed', 'BlockedOrIncomplete', 'NotRun'],
    `${field}.result`,
    issues,
  );
  nonEmpty(scenario.nextAction, `${field}.nextAction`, issues);

  const bindingIds = new Set<string>();
  let executableBinding = false;
  scenario.coverageBindings.forEach((binding, index) => {
    validateCoverageBinding(
      binding,
      `${field}.coverageBindings[${index}]`,
      issues,
    );
    if (bindingIds.has(binding.bindingId)) {
      issues.push(`${field} contains duplicate coverage binding IDs.`);
    }
    bindingIds.add(binding.bindingId);
    if (
      binding.designState === 'Selected' &&
      ['Existing', 'Added', 'Updated'].includes(binding.implementationState)
    ) {
      executableBinding = true;
    }
  });
  if (scenario.coverageBindings.length === 0) {
    issues.push(`${field}.coverageBindings must contain at least one binding.`);
  }

  const attemptIds = new Set<string>();
  let executed = false;
  scenario.executions.forEach((execution, index) => {
    validateExecution(execution, `${field}.executions[${index}]`, issues);
    if (
      record.assignment.requestKind === 'full' &&
      execution.candidateRef !== record.assignment.candidateRef
    ) {
      issues.push(
        `${field}.executions[${index}] must target the assigned candidate.`,
      );
    }
    if (
      record.assignment.requestKind === 'full' &&
      record.assignment.environmentRef !== undefined &&
      execution.environmentRef !== record.assignment.environmentRef
    ) {
      issues.push(
        `${field}.executions[${index}] must target the assigned environment.`,
      );
    }
    if (
      record.assignment.requestKind === 'full' &&
      record.assignment.missingEnvironmentBlocker !== undefined &&
      execution.state === 'Executed'
    ) {
      issues.push(
        `${field}.executions[${index}] cannot execute while the assignment is blocked on environment access.`,
      );
    }
    if (attemptIds.has(execution.attemptId)) {
      issues.push(`${field} contains duplicate execution attempt IDs.`);
    }
    attemptIds.add(execution.attemptId);
    executed ||= execution.state === 'Executed';
  });
  if (scenario.result === 'Passed' && (!executed || !executableBinding)) {
    issues.push(
      `${field} cannot be Passed without selected implemented coverage and Executed evidence.`,
    );
  }
}

function validateEvaluationRounds(
  record: QaReviewRecord,
  issues: string[],
): void {
  if (
    record.assignment.requestKind === 'full' &&
    record.evaluationRounds.length === 0
  ) {
    if (
      !record.evaluationAttempts?.length ||
      record.qaDisposition !== 'BlockedOrIncomplete'
    ) {
      issues.push(
        'full reviews require an independent evaluation round or a blocked attempt.',
      );
    }
  }
  if (record.evaluationRounds.length > 3) {
    issues.push('evaluationRounds must contain at most three rounds.');
  }

  record.evaluationRounds.forEach((round, index) => {
    const field = `evaluationRounds[${index}]`;
    if (round.round !== index + 1) {
      issues.push(`${field}.round must be the next sequential round number.`);
    }
    nonEmpty(round.evaluatorId, `${field}.evaluatorId`, issues);
    if (round.evaluatorId === record.authorId) {
      issues.push(`${field}.evaluatorId must differ from the review author.`);
    }
    nonEmpty(
      round.freshContextAttestation,
      `${field}.freshContextAttestation`,
      issues,
    );
    enumValue(
      round.verdict,
      ['PASS', 'REVISE', 'BLOCKED'],
      `${field}.verdict`,
      issues,
    );
    textList(round.findingIds, `${field}.findingIds`, issues);
    round.evidenceRefs.forEach((reference, evidenceIndex) =>
      evidenceReference(
        reference,
        `${field}.evidenceRefs[${evidenceIndex}]`,
        issues,
      ),
    );
  });
  record.evaluationAttempts?.forEach((attempt, index) => {
    const field = `evaluationAttempts[${index}]`;
    if (attempt.status !== 'BLOCKED')
      issues.push(`${field}.status must be BLOCKED.`);
    enumValue(
      attempt.reason,
      ['separate-evaluator-unavailable', 'environment-unavailable'],
      `${field}.reason`,
      issues,
    );
    for (const key of [
      'host',
      'tool',
      'invocationId',
      'startedAt',
      'endedAt',
    ] as const)
      nonEmpty(attempt[key], `${field}.${key}`, issues);
    for (const key of ['inputSha256', 'allowedInputSha256'] as const) {
      if (!/^[0-9a-f]{64}$/.test(attempt[key]))
        issues.push(`${field}.${key} must be SHA-256.`);
    }
    if (attempt.outputSha256 !== null) {
      issues.push(`${field}.outputSha256 must be null without an evaluator.`);
    }
    if (attempt.findings.length !== 0)
      issues.push(`${field}.findings must be empty without an evaluator.`);
  });
  if (record.evaluationAttempts?.length && record.qaDisposition === 'Passed') {
    issues.push('a blocked attempt cannot support a Passed disposition.');
  }
}

function validateExternalWrites(
  record: QaReviewRecord,
  issues: string[],
): void {
  const operationKeys = new Set<string>();
  record.externalWriteReceipts.forEach((receipt, index) => {
    const field = `externalWriteReceipts[${index}]`;
    nonEmpty(receipt.operationKey, `${field}.operationKey`, issues);
    nonEmpty(receipt.systemRef, `${field}.systemRef`, issues);
    nonEmpty(receipt.recordRef, `${field}.recordRef`, issues);
    nonEmpty(receipt.beforeImageRef, `${field}.beforeImageRef`, issues);
    nonEmpty(receipt.intendedChange, `${field}.intendedChange`, issues);
    nonEmpty(receipt.savedStateRef, `${field}.savedStateRef`, issues);
    enumValue(
      receipt.readbackStatus,
      ['Verified', 'Failed', 'Unavailable'],
      `${field}.readbackStatus`,
      issues,
    );
    if (operationKeys.has(receipt.operationKey)) {
      issues.push(`externalWriteReceipts contains duplicate operation keys.`);
    }
    operationKeys.add(receipt.operationKey);
  });
}

function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
      .join(',')}}`;
  }
  throw new Error('Unsupported value in QA review canonicalization.');
}

export function digestQaReviewRecord(input: QaReviewRecordInput): string {
  return createHash('sha256').update(canonicalize(input), 'utf8').digest('hex');
}

export function createQaReviewRecord(
  input: QaReviewRecordInput,
): QaReviewRecord {
  return { ...input, digest: digestQaReviewRecord(input) };
}

/** Validate structure and lineage without judging whether product behavior passed. */
export function validateQaReviewRecord(
  record: QaReviewRecord,
  previous?: QaReviewRecord,
): readonly string[] {
  const issues: string[] = [];
  if (record.schemaVersion !== 1) issues.push('schemaVersion must be 1.');
  nonEmpty(record.reviewRevision, 'reviewRevision', issues);
  nonEmpty(record.authorId, 'authorId', issues);
  nonEmpty(record.dispositionBasis, 'dispositionBasis', issues);
  textList(record.residualRisks, 'residualRisks', issues);

  if (previous === undefined) {
    if (record.parentRevision !== null) {
      issues.push('the first review revision must have parentRevision=null.');
    }
  } else {
    if (record.parentRevision !== previous.reviewRevision) {
      issues.push(
        'a follow-up review revision must name its immediate parent revision.',
      );
    }
    if (record.reviewRevision === previous.reviewRevision) {
      issues.push('a follow-up review revision must have a new identifier.');
    }
  }

  if (!/^[0-9a-f]{64}$/.test(record.digest)) {
    issues.push('digest must be a lowercase SHA-256 digest.');
  } else {
    const { digest: _digest, ...input } = record;
    if (record.digest !== digestQaReviewRecord(input)) {
      issues.push('digest does not match the canonical review snapshot.');
    }
  }

  issues.push(...validateQaAssignment(record.assignment));
  if (record.plan.tier !== record.assignment.tier) {
    issues.push('plan.tier must match assignment.tier.');
  }
  textList(record.plan.objectives, 'plan.objectives', issues, true);
  validateAreaDecisions(record, issues);

  const scenarioIds = new Set<string>();
  record.scenarios.forEach((scenario, index) => {
    validateScenario(record, scenario, `scenarios[${index}]`, issues);
    if (scenarioIds.has(scenario.scenarioId)) {
      issues.push('scenarios contains duplicate scenario IDs.');
    }
    scenarioIds.add(scenario.scenarioId);
  });
  if (
    record.assignment.requestKind === 'full' &&
    record.scenarios.length === 0
  ) {
    issues.push('full reviews require at least one scenario.');
  }

  enumValue(
    record.qaDisposition,
    ['Passed', 'Failed', 'BlockedOrIncomplete', 'NarrowReviewOnly'],
    'qaDisposition',
    issues,
  );
  validateEvaluationRounds(record, issues);
  validateExternalWrites(record, issues);
  return issues;
}

export function assertQaReviewRecord(
  record: QaReviewRecord,
  previous?: QaReviewRecord,
): void {
  const issues = validateQaReviewRecord(record, previous);
  if (issues.length > 0) {
    throw new Error(`Invalid QaReviewRecord: ${issues.join(' ')}`);
  }
}
