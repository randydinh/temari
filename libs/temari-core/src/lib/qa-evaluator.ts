import type { WorkerEvidenceReference } from '@temari/contracts';

import {
  assertQaReviewRecord,
  type QaAreaDecision,
  type QaEvaluationRound,
  type QaReviewPlan,
  type QaReviewRecord,
  type QaScenarioRecord,
} from './qa-review-record.js';
import type { QaEvaluatorVerdict, QaReviewDisposition } from './qa-review.js';

export interface QaEvaluationAssignment {
  readonly assignmentId: string;
  readonly requestKind: 'full' | 'narrow';
  readonly tier: 'focused' | 'standard' | 'high-risk';
  readonly requestedScope: string;
  readonly excludedScope: readonly string[];
  readonly ticketRef: string | null;
  readonly ticketRevision: string | null;
  readonly requirementRefs: readonly string[];
  readonly requirementRevisions: readonly string[];
  readonly candidateRef: string | null;
  readonly environmentRef: string | null;
  readonly missingEnvironmentBlocker: string | null;
}

export interface QaFrozenReviewSnapshot {
  readonly schemaVersion: 1;
  readonly reviewRevision: string;
  readonly parentRevision: string | null;
  readonly digest: string;
  readonly assignment: QaEvaluationAssignment;
  readonly plan: QaReviewPlan;
  readonly areaDecisions: readonly QaAreaDecision[];
  readonly scenarios: readonly QaScenarioRecord[];
  readonly qaDisposition: QaReviewDisposition;
  readonly dispositionBasis: string;
  readonly residualRisks: readonly string[];
}

export interface QaEvaluationInput {
  readonly frozenReview: QaFrozenReviewSnapshot;
  readonly canonicalEvidenceRefs: readonly WorkerEvidenceReference[];
  readonly declaredConstraints: readonly string[];
  readonly priorRounds: readonly QaEvaluationRound[];
}

export type QaFreshContextStatus = 'proven' | 'unavailable';

export type QaFindingSeverity = 'Blocking' | 'Important' | 'Minor';

export type QaFindingStatus = 'Open' | 'Resolved' | 'AcceptedResidualRisk';

export interface QaEvaluationFinding {
  readonly findingId: string;
  readonly severity: QaFindingSeverity;
  readonly evidenceRefs: readonly WorkerEvidenceReference[];
  readonly reason: string;
  readonly minimumCorrection: string;
  readonly status: QaFindingStatus;
}

export interface QaEvaluatorDecision {
  readonly verdict: QaEvaluatorVerdict;
  readonly reason:
    | 'fresh-context-unavailable'
    | 'evaluator-not-independent'
    | 'round-limit'
    | 'unresolved-important-finding'
    | 'no-open-important-findings';
  readonly unresolvedFindingIds: readonly string[];
}

function evidenceKey(reference: WorkerEvidenceReference): string {
  return [
    reference.runId,
    reference.revision,
    reference.kind,
    reference.sha256,
    reference.bytes,
  ].join(':');
}

function canonicalEvidence(
  record: QaReviewRecord,
): readonly WorkerEvidenceReference[] {
  const references: WorkerEvidenceReference[] = [];
  const seen = new Set<string>();
  const add = (reference: WorkerEvidenceReference): void => {
    const key = evidenceKey(reference);
    if (!seen.has(key)) {
      seen.add(key);
      references.push(reference);
    }
  };

  record.scenarios.forEach((scenario) =>
    scenario.executions.forEach((execution) =>
      execution.evidenceRefs.forEach(add),
    ),
  );
  record.evaluationRounds.forEach((round) => round.evidenceRefs.forEach(add));
  return references;
}

function evaluationAssignment(record: QaReviewRecord): QaEvaluationAssignment {
  const assignment = record.assignment;
  return {
    assignmentId: assignment.assignmentId,
    requestKind: assignment.requestKind,
    tier: assignment.tier,
    requestedScope: assignment.requestedScope,
    excludedScope: [...assignment.excludedScope],
    ticketRef: assignment.ticketRef,
    ticketRevision: assignment.ticketRevision,
    requirementRefs: [...assignment.requirementRefs],
    requirementRevisions: [...assignment.requirementRevisions],
    candidateRef: assignment.candidateRef,
    environmentRef: assignment.environmentRef ?? null,
    missingEnvironmentBlocker: assignment.missingEnvironmentBlocker ?? null,
  };
}

/**
 * Construct the evaluator's read-only allowlist from a validated frozen record.
 * Author identity, authority controls, external write receipts, and mutable
 * tracker state are intentionally not part of the evaluator input.
 */
export function createQaEvaluationInput(
  record: QaReviewRecord,
): QaEvaluationInput {
  assertQaReviewRecord(record);
  return {
    frozenReview: {
      schemaVersion: record.schemaVersion,
      reviewRevision: record.reviewRevision,
      parentRevision: record.parentRevision,
      digest: record.digest,
      assignment: evaluationAssignment(record),
      plan: record.plan,
      areaDecisions: record.areaDecisions,
      scenarios: record.scenarios,
      qaDisposition: record.qaDisposition,
      dispositionBasis: record.dispositionBasis,
      residualRisks: record.residualRisks,
    },
    canonicalEvidenceRefs: canonicalEvidence(record),
    declaredConstraints: [...record.assignment.knownConstraints],
    priorRounds: record.evaluationRounds,
  };
}

/** Mechanical evaluator gate. It does not inspect product behavior. */
export function deriveQaEvaluatorDecision(input: {
  readonly authorId: string;
  readonly evaluatorId: string;
  readonly freshContext: QaFreshContextStatus;
  readonly round: number;
  readonly findings: readonly QaEvaluationFinding[];
}): QaEvaluatorDecision {
  if (input.evaluatorId === input.authorId) {
    return {
      verdict: 'BLOCKED',
      reason: 'evaluator-not-independent',
      unresolvedFindingIds: [],
    };
  }
  if (input.freshContext !== 'proven') {
    return {
      verdict: 'BLOCKED',
      reason: 'fresh-context-unavailable',
      unresolvedFindingIds: [],
    };
  }
  if (input.round < 1 || input.round > 3) {
    return {
      verdict: 'BLOCKED',
      reason: 'round-limit',
      unresolvedFindingIds: [],
    };
  }

  const unresolvedFindingIds = input.findings
    .filter(
      (finding) =>
        finding.status === 'Open' &&
        (finding.severity === 'Blocking' || finding.severity === 'Important'),
    )
    .map((finding) => finding.findingId);
  if (unresolvedFindingIds.length > 0) {
    return {
      verdict: 'REVISE',
      reason: 'unresolved-important-finding',
      unresolvedFindingIds,
    };
  }

  return {
    verdict: 'PASS',
    reason: 'no-open-important-findings',
    unresolvedFindingIds: [],
  };
}
