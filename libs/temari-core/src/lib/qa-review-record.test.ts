import assert from 'node:assert/strict';
import test from 'node:test';

import type { WorkerEvidenceReference } from '@temari/contracts';

import type { QaFullAssignment } from './qa-assignment.js';
import {
  QA_REVIEW_AREAS,
  assertQaReviewRecord,
  createQaReviewRecord,
  validateQaReviewRecord,
  type QaReviewRecord,
  type QaReviewRecordInput,
} from './qa-review-record.js';

const FULL_ASSIGNMENT: QaFullAssignment = {
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

const EVIDENCE: WorkerEvidenceReference = {
  schema: 1,
  runId: 'qa-run-1',
  revision: 'commit-abc123',
  kind: 'verification',
  sha256: 'a'.repeat(64),
  bytes: 12,
};

const SCENARIO = {
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
  executions: [
    {
      attemptId: 'attempt-1',
      candidateRef: 'commit-abc123',
      environmentRef: 'staging-build-7',
      fixtureRefs: ['fixture-1'],
      correlationRef: 'request-1',
      boundedObservation: 'waited 2 seconds for readback',
      assertions: ['saved record exists'],
      observations: ['readback matched the submitted value'],
      evidenceRefs: [EVIDENCE],
      state: 'Executed',
    },
  ],
  result: 'Passed',
  nextAction: 'retain the evidence with the review revision',
} as const;

const BASE_INPUT: QaReviewRecordInput = {
  schemaVersion: 1,
  reviewRevision: 'review-revision-1',
  parentRevision: null,
  authorId: 'qa-author-1',
  assignment: FULL_ASSIGNMENT,
  plan: {
    tier: 'standard',
    objectives: ['verify the persisted outcome'],
  },
  areaDecisions: QA_REVIEW_AREAS.map((area) => ({
    area,
    status: 'Applicable',
    basis: `${area} applies to this ticket`,
  })),
  scenarios: [SCENARIO],
  evaluationRounds: [
    {
      round: 1,
      evaluatorId: 'qa-evaluator-1',
      freshContextAttestation: 'isolated evaluator with no author context',
      verdict: 'PASS',
      findingIds: [],
      evidenceRefs: [EVIDENCE],
    },
  ],
  qaDisposition: 'Passed',
  dispositionBasis: 'required scenario passed with independent PASS',
  externalWriteReceipts: [],
  residualRisks: [],
};

function validRecord(): QaReviewRecord {
  return createQaReviewRecord(BASE_INPUT);
}

test('creates and validates a digest-bound full review record', () => {
  const record = validRecord();

  assert.deepEqual(validateQaReviewRecord(record), []);
  assert.doesNotThrow(() => assertQaReviewRecord(record));
});

test('retains a blocked host attempt without inventing an evaluator round', () => {
  const record = createQaReviewRecord({
    ...BASE_INPUT,
    evaluationRounds: [],
    evaluationAttempts: [
      {
        status: 'BLOCKED',
        reason: 'separate-evaluator-unavailable',
        host: 'synthetic-host',
        tool: 'synthetic-adapter',
        invocationId: 'invocation-1',
        startedAt: '2026-09-28T00:00:00.000Z',
        endedAt: '2026-09-28T00:00:01.000Z',
        inputSha256: 'a'.repeat(64),
        allowedInputSha256: 'b'.repeat(64),
        findings: [],
      },
    ],
    qaDisposition: 'BlockedOrIncomplete',
    dispositionBasis: 'separate evaluator unavailable',
  });
  assert.deepEqual(validateQaReviewRecord(record), []);
  const { digest: _digest, ...recordInput } = record;
  const fakePass = createQaReviewRecord({
    ...recordInput,
    qaDisposition: 'Passed',
  });
  assert.match(validateQaReviewRecord(fakePass).join(' '), /blocked attempt/);
});

test('requires a first revision to have no parent', () => {
  const record = createQaReviewRecord({
    ...BASE_INPUT,
    parentRevision: 'older-review',
  });

  assert.match(
    validateQaReviewRecord(record).join(' '),
    /first review revision must have parentRevision=null/,
  );
});

test('accepts an immutable follow-up revision with the immediate parent', () => {
  const previous = validRecord();
  const next = createQaReviewRecord({
    ...BASE_INPUT,
    reviewRevision: 'review-revision-2',
    parentRevision: previous.reviewRevision,
    dispositionBasis: 'rechecked the required scenario',
  });

  assert.deepEqual(validateQaReviewRecord(next, previous), []);
});

test('rejects a tampered digest and a broken revision link', () => {
  const previous = validRecord();
  const tampered = {
    ...previous,
    dispositionBasis: 'changed after creation',
  };
  const broken = createQaReviewRecord({
    ...BASE_INPUT,
    reviewRevision: 'review-revision-2',
    parentRevision: 'not-the-immediate-parent',
  });

  assert.match(
    validateQaReviewRecord(tampered).join(' '),
    /digest does not match the canonical review snapshot/,
  );
  assert.match(
    validateQaReviewRecord(broken, previous).join(' '),
    /immediate parent revision/,
  );
});

test('rejects a passed scenario without executable coverage and evidence', () => {
  const record = createQaReviewRecord({
    ...BASE_INPUT,
    scenarios: [
      {
        ...SCENARIO,
        coverageBindings: [
          {
            ...SCENARIO.coverageBindings[0],
            designState: 'Proposed',
            implementationState: 'Missing',
          },
        ],
        executions: [],
      },
    ],
  });

  assert.match(
    validateQaReviewRecord(record).join(' '),
    /cannot be Passed without selected implemented coverage and Executed evidence/,
  );
});

test('rejects duplicate operation receipts and author self-evaluation', () => {
  const record = createQaReviewRecord({
    ...BASE_INPUT,
    evaluationRounds: [
      {
        ...BASE_INPUT.evaluationRounds[0],
        evaluatorId: 'qa-author-1',
      },
    ],
    externalWriteReceipts: [
      {
        operationKey: 'publish-1',
        systemRef: 'testmo',
        recordRef: 'case-1',
        beforeImageRef: 'before-1',
        intendedChange: 'publish result',
        savedStateRef: 'after-1',
        readbackStatus: 'Verified',
      },
      {
        operationKey: 'publish-1',
        systemRef: 'tracker',
        recordRef: 'ticket-1',
        beforeImageRef: 'before-2',
        intendedChange: 'publish disposition',
        savedStateRef: 'after-2',
        readbackStatus: 'Verified',
      },
    ],
  });

  const issues = validateQaReviewRecord(record).join(' ');
  assert.match(issues, /evaluatorId must differ from the review author/);
  assert.match(issues, /duplicate operation keys/);
});

test('requires all eleven area decisions for a standard review', () => {
  const record = createQaReviewRecord({
    ...BASE_INPUT,
    areaDecisions: BASE_INPUT.areaDecisions.slice(0, -1),
  });

  assert.match(
    validateQaReviewRecord(record).join(' '),
    /require all 11 area decisions/,
  );
});
