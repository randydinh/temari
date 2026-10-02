import type { WorkerEvidenceReference } from '@temari/contracts';

import {
  assertQaReviewRecord,
  createQaReviewRecord,
  type QaAreaDecision,
  type QaEvaluationRound,
  type QaIntentSource,
  type QaReviewPlan,
  type QaReviewRecord,
  type QaScenarioRecord,
} from './qa-review-record.js';
import type { QaAssignment } from './qa-assignment.js';
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
  readonly intentSources: readonly QaIntentSource[];
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

/** A complete review before the independent evaluator has supplied a round. */
export interface QaReviewDraft {
  readonly schemaVersion: 1;
  readonly reviewRevision: string;
  readonly parentRevision: string | null;
  readonly authorId: string;
  readonly assignment: QaAssignment;
  readonly intentSources?: readonly QaIntentSource[];
  readonly plan: QaReviewPlan;
  readonly areaDecisions: readonly QaAreaDecision[];
  readonly scenarios: readonly QaScenarioRecord[];
  readonly residualRisks: readonly string[];
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
    | 'product-intent-assessment-unavailable'
    | 'no-open-important-findings';
  readonly unresolvedFindingIds: readonly string[];
}

/**
 * Semantic review must be supplied by a separately launched, trusted agent
 * that received the pinned intent and actual observations. A procedural
 * evidence scan cannot set this status to proven. This legacy enum alone is
 * never admitted proof; positive host routes validate QaExecutionProof instead.
 */
export type QaProductAssessmentStatus = 'proven' | 'unavailable';

/**
 * Review the frozen QA evidence independently of the author. This is deliberately
 * narrower than a product oracle: it identifies missing execution, unresolved
 * review areas, and unfinished required scenarios. A project control adapter is
 * still responsible for supplying the actual product observation.
 */
export function deriveQaEvidenceFindings(
  input: QaEvaluationInput,
): readonly QaEvaluationFinding[] {
  const findings: QaEvaluationFinding[] = [];
  const evidenceRefs = input.canonicalEvidenceRefs;
  for (const decision of input.frozenReview.areaDecisions) {
    if (decision.status === 'NeedsInvestigation') {
      findings.push({
        findingId: `area-${decision.area}-unresolved`,
        severity: 'Important',
        evidenceRefs,
        reason: `The ${decision.area} review area still needs investigation: ${decision.basis}`,
        minimumCorrection:
          'Resolve the area decision or record a supported scope exclusion.',
        status: 'Open',
      });
    }
  }
  for (const scenario of input.frozenReview.scenarios) {
    if (scenario.obligation !== 'Required') continue;
    if (
      scenario.result === 'Passed' &&
      !scenario.requirementRefs.every((ref) =>
        input.frozenReview.intentSources.some(
          (source) =>
            source.requirementRef === ref &&
            source.revision === scenario.sourceRevision,
        ),
      )
    ) {
      findings.push({
        findingId: `scenario-${scenario.scenarioId}-intent-source-missing`,
        severity: 'Important',
        evidenceRefs: scenario.executions.flatMap(
          (execution) => execution.evidenceRefs,
        ),
        reason: `Required scenario ${scenario.scenarioId} lacks a pinned product-intent source for its passed conclusion.`,
        minimumCorrection:
          'Pin the authoritative outcome and revision, then reassess the assertion.',
        status: 'Open',
      });
    }
    if (scenario.result === 'Passed') continue;
    const severity = scenario.result === 'Failed' ? 'Blocking' : 'Important';
    findings.push({
      findingId: `scenario-${scenario.scenarioId}-${scenario.result.toLowerCase()}`,
      severity,
      evidenceRefs: scenario.executions.flatMap(
        (execution) => execution.evidenceRefs,
      ),
      reason:
        scenario.result === 'Failed'
          ? `Required scenario ${scenario.scenarioId} failed its expected behavior.`
          : `Required scenario ${scenario.scenarioId} has no passing candidate-bound result.`,
      minimumCorrection:
        scenario.result === 'Failed'
          ? 'Repair the candidate or document a supported product decision, then recheck the scenario.'
          : 'Execute the selected coverage on the assigned candidate and retain the observation.',
      status: 'Open',
    });
  }
  return findings;
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
      intentSources: record.intentSources ?? [],
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

/**
 * Validate a review draft by constructing an internal blocked snapshot, then
 * expose only the evaluator's read-only input. The temporary round is never
 * returned or retained as a real evaluator attempt.
 */
export function createQaEvaluationInputFromDraft(
  draft: QaReviewDraft,
): QaEvaluationInput {
  const temporary = createQaReviewRecord({
    ...draft,
    evaluationRounds: [
      {
        round: 1,
        evaluatorId: 'qa-draft-validation',
        freshContextAttestation: 'draft validation only; no evaluator was run',
        verdict: 'BLOCKED',
        findingIds: [],
        evidenceRefs: [],
      },
    ],
    qaDisposition: 'BlockedOrIncomplete',
    dispositionBasis: 'independent evaluation pending',
    externalWriteReceipts: [],
  });
  const input = createQaEvaluationInput(temporary);
  return { ...input, priorRounds: [] };
}

/** Mechanical evaluator gate. It does not inspect product behavior. */
export function deriveQaEvaluatorDecision(input: {
  readonly authorId: string;
  readonly evaluatorId: string;
  readonly freshContext: QaFreshContextStatus;
  readonly productAssessment?: QaProductAssessmentStatus;
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

  // This legacy structural path has no trusted host launch/capture context.
  // A caller's enum cannot turn it into the admitted proof-aware QA route.
  return {
    verdict: 'BLOCKED',
    reason: 'product-intent-assessment-unavailable',
    unresolvedFindingIds: [],
  };
}
