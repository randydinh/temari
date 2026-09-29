import assert from 'node:assert/strict';
import test from 'node:test';

import {
  QA_REVIEW_AREAS,
  createQaReviewRecord,
  type QaReviewRecordInput,
} from './qa-review-record.js';
import {
  createQaEvaluationInput,
  createQaEvaluationInputFromDraft,
  deriveQaEvidenceFindings,
  deriveQaEvaluatorDecision,
  type QaEvaluationFinding,
} from './qa-evaluator.js';
import type { QaFullAssignment } from './qa-assignment.js';

const ASSIGNMENT: QaFullAssignment = {
  assignmentId: 'qa-assignment-1',
  requestKind: 'full',
  tier: 'standard',
  requestedScope: 'ticket behavior and required regression coverage',
  excludedScope: ['test implementation'],
  ticketRef: 'ticket-123',
  ticketRevision: 'ticket-revision-4',
  requirementRefs: ['requirement-1'],
  requirementRevisions: ['requirement-revision-2'],
  candidateRef: 'commit-abc123',
  environmentRef: 'staging-build-7',
  authority: {
    allowedActions: ['read ticket', 'run approved checks'],
    deniedActions: ['publish ticket transition'],
  },
  knownConstraints: ['payment writes are out of scope'],
};

const BASE_RECORD: QaReviewRecordInput = {
  schemaVersion: 1,
  reviewRevision: 'review-revision-1',
  parentRevision: null,
  authorId: 'qa-author-1',
  assignment: ASSIGNMENT,
  plan: {
    tier: 'standard',
    objectives: ['verify the persisted outcome'],
  },
  areaDecisions: QA_REVIEW_AREAS.map((area) => ({
    area,
    status: 'Applicable',
    basis: `${area} applies to this ticket`,
  })),
  scenarios: [
    {
      scenarioId: 'scenario-1',
      requirementRefs: ['requirement-1'],
      conditions: 'an authorized user submits a valid request',
      expectedBehavior: 'the request is persisted once',
      sourceRevision: 'requirement-revision-2',
      behavioralReason: 'persistence is the promised outcome',
      areaMappings: ['data-verification'],
      obligation: 'Required',
      obligationRationale: 'the ticket explicitly requires persistence',
      coverageBindings: [
        {
          bindingId: 'coverage-1',
          kind: 'AutomatedTest',
          canonicalRef: 'test://persistence',
          repositoryRevision: 'commit-abc123',
          assertionSummary: 'reads the saved record back',
          designState: 'Selected',
          implementationState: 'Existing',
          writeReceiptRef: null,
        },
      ],
      executions: [],
      result: 'NotRun',
      nextAction: 'execute the mapped check',
    },
  ],
  evaluationRounds: [
    {
      round: 1,
      evaluatorId: 'qa-evaluator-1',
      freshContextAttestation: 'fresh context was unavailable',
      verdict: 'BLOCKED',
      findingIds: [],
      evidenceRefs: [],
    },
  ],
  qaDisposition: 'BlockedOrIncomplete',
  dispositionBasis: 'evaluation has not run',
  externalWriteReceipts: [],
  residualRisks: [],
};

const FINDING: QaEvaluationFinding = {
  findingId: 'finding-1',
  severity: 'Important',
  evidenceRefs: [],
  reason: 'the promised persistence outcome is not observed',
  minimumCorrection: 'add a readback assertion',
  status: 'Open',
};

test('builds an evaluator allowlist without author or write controls', () => {
  const record = createQaReviewRecord(BASE_RECORD);
  const input = createQaEvaluationInput(record);

  assert.equal(input.frozenReview.reviewRevision, 'review-revision-1');
  assert.equal('authorId' in input.frozenReview, false);
  assert.equal('authority' in input.frozenReview.assignment, false);
  assert.equal('externalWriteReceipts' in input, false);
  assert.deepEqual(input.declaredConstraints, [
    'payment writes are out of scope',
  ]);
  assert.equal(input.priorRounds.length, 1);
  assert.equal(input.priorRounds[0]?.verdict, 'BLOCKED');
});

test('validates an unevaluated draft without retaining a made-up round', () => {
  const input = createQaEvaluationInputFromDraft({
    schemaVersion: BASE_RECORD.schemaVersion,
    reviewRevision: BASE_RECORD.reviewRevision,
    parentRevision: BASE_RECORD.parentRevision,
    authorId: BASE_RECORD.authorId,
    assignment: BASE_RECORD.assignment,
    plan: BASE_RECORD.plan,
    areaDecisions: BASE_RECORD.areaDecisions,
    scenarios: BASE_RECORD.scenarios,
    residualRisks: BASE_RECORD.residualRisks,
  });

  assert.deepEqual(input.priorRounds, []);
  assert.equal(input.frozenReview.reviewRevision, 'review-revision-1');
});

test('blocks evaluation without a proven fresh context', () => {
  assert.deepEqual(
    deriveQaEvaluatorDecision({
      authorId: 'author-1',
      evaluatorId: 'evaluator-1',
      freshContext: 'unavailable',
      round: 1,
      findings: [],
    }),
    {
      verdict: 'BLOCKED',
      reason: 'fresh-context-unavailable',
      unresolvedFindingIds: [],
    },
  );
});

test('blocks an evaluator who is the review author', () => {
  assert.equal(
    deriveQaEvaluatorDecision({
      authorId: 'author-1',
      evaluatorId: 'author-1',
      freshContext: 'proven',
      round: 1,
      findings: [],
    }).verdict,
    'BLOCKED',
  );
});

test('returns REVISE for an open Blocking or Important finding', () => {
  assert.deepEqual(
    deriveQaEvaluatorDecision({
      authorId: 'author-1',
      evaluatorId: 'evaluator-1',
      freshContext: 'proven',
      round: 3,
      findings: [FINDING],
    }),
    {
      verdict: 'REVISE',
      reason: 'unresolved-important-finding',
      unresolvedFindingIds: ['finding-1'],
    },
  );
});

test('passes only when no important finding remains open', () => {
  assert.equal(
    deriveQaEvaluatorDecision({
      authorId: 'author-1',
      evaluatorId: 'evaluator-1',
      freshContext: 'proven',
      round: 2,
      findings: [
        { ...FINDING, severity: 'Minor', status: 'Open' },
        { ...FINDING, findingId: 'finding-2', status: 'Resolved' },
      ],
    }).verdict,
    'PASS',
  );
});

test('identifies an incomplete required scenario', () => {
  const record = createQaReviewRecord(BASE_RECORD);
  const findings = deriveQaEvidenceFindings(createQaEvaluationInput(record));

  assert.deepEqual(
    findings.map((finding) => [finding.findingId, finding.severity]),
    [['scenario-scenario-1-notrun', 'Important']],
  );
});

test('identifies an unresolved review area', () => {
  const record = createQaReviewRecord({
    ...BASE_RECORD,
    areaDecisions: BASE_RECORD.areaDecisions.map((decision, index) =>
      index === 0
        ? {
            ...decision,
            status: 'NeedsInvestigation',
            basis: 'the scope boundary has not been established',
          }
        : decision,
    ),
  });
  const findings = deriveQaEvidenceFindings(createQaEvaluationInput(record));

  assert.equal(
    findings.some(
      (finding) =>
        finding.findingId === `area-${QA_REVIEW_AREAS[0]}-unresolved` &&
        finding.severity === 'Important',
    ),
    true,
  );
});

test('identifies a failed required scenario as blocking', () => {
  const record = createQaReviewRecord({
    ...BASE_RECORD,
    scenarios: [
      {
        ...BASE_RECORD.scenarios[0],
        result: 'Failed',
        nextAction: 'repair the product behavior',
      },
    ],
  });
  const findings = deriveQaEvidenceFindings(createQaEvaluationInput(record));

  assert.equal(findings.at(-1)?.findingId, 'scenario-scenario-1-failed');
  assert.equal(findings.at(-1)?.severity, 'Blocking');
});

test('blocks rounds outside the three-round evaluation bound', () => {
  assert.equal(
    deriveQaEvaluatorDecision({
      authorId: 'author-1',
      evaluatorId: 'evaluator-1',
      freshContext: 'proven',
      round: 4,
      findings: [],
    }).reason,
    'round-limit',
  );
});
