import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { FileEvidenceStore } from '../libs/runtime/src/index.ts';
import { QA_REVIEW_AREAS } from '../libs/temari-core/src/index.ts';

const execFileAsync = promisify(execFile);
const expectation = 'The selected category returns only its matching fixtures.';

function draft(reference, result = 'Passed') {
  return {
    schemaVersion: 1,
    reviewRevision: 'qa-review-r1',
    parentRevision: null,
    authorId: 'qa-author',
    intentSources: [{
      requirementRef: 'REQ-1', revision: 'requirement-r1',
      authorityRef: 'synthetic-approved-rule', expectedOutcome: expectation,
    }],
    assignment: {
      assignmentId: 'qa-assignment',
      requestKind: 'full',
      tier: 'standard',
      requestedScope: 'verify category filtering',
      excludedScope: ['external writes'],
      ticketRef: 'QA-1',
      ticketRevision: 'ticket-r1',
      requirementRefs: ['REQ-1'],
      requirementRevisions: ['requirement-r1'],
      candidateRef: 'candidate-r1',
      environmentRef: 'local-fixture',
      authority: {
        allowedActions: ['read-candidate'],
        deniedActions: ['qa:mutate'],
      },
      knownConstraints: ['local synthetic fixture'],
    },
    plan: { tier: 'standard', objectives: ['verify the selected category'] },
    areaDecisions: QA_REVIEW_AREAS.map((area) => ({
      area,
      status: 'NotApplicable',
      basis: 'synthetic category-filter pilot exercises one required outcome',
    })),
    scenarios: [
      {
        scenarioId: 'category-filter',
        requirementRefs: ['REQ-1'],
        conditions: 'two matching fixtures exist in separate categories',
        expectedBehavior: expectation,
        sourceRevision: 'requirement-r1',
        behavioralReason:
          'the product decision requires the selected category only',
        areaMappings: ['happy-paths'],
        obligation: 'Required',
        obligationRationale: 'the ticket requires category filtering',
        coverageBindings: [
          {
            bindingId: 'category-filter-procedure',
            kind: 'ManualProcedure',
            canonicalRef: 'procedure://category-filter',
            repositoryRevision: 'candidate-r1',
            assertionSummary: 'the request returned HTTP 200',
            designState: 'Selected',
            implementationState: 'Existing',
            writeReceiptRef: null,
          },
        ],
        executions: [
          {
            attemptId: 'attempt-1',
            candidateRef: 'candidate-r1',
            environmentRef: 'local-fixture',
            fixtureRefs: ['fixture-a1', 'fixture-b1'],
            correlationRef: 'QA-1',
            boundedObservation: 'Only fixture-a1 was returned for category-a.',
            assertions: ['the request returned HTTP 200'],
            observations: ['fixture-a1 returned', 'fixture-b1 excluded'],
            evidenceRefs: [reference],
            state: 'Executed',
          },
        ],
        result,
        nextAction:
          result === 'Passed' ? 'none' : 'investigate the missing check',
      },
    ],
    residualRisks: [],
  };
}

test('a fresh procedural evaluator cannot approve a weak product assertion', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'temari-qa-evaluator-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidenceRoot = join(root, 'evidence');
  const evidence = await FileEvidenceStore.create(evidenceRoot);
  const reference = await evidence.put({
    runId: 'qa-assignment',
    revision: 'candidate-r1',
    kind: 'verification',
    content: 'fixture-a1 only',
  });
  const draftPath = join(root, 'draft.json');
  await writeFile(draftPath, JSON.stringify(draft(reference)));
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      '--import',
      '@swc-node/register/esm-register',
      'tools/run-qa-evaluator-local.mjs',
      '--draft',
      draftPath,
      '--evidence-root',
      evidenceRoot,
    ],
    { cwd: new URL('..', import.meta.url) },
  );
  const result = JSON.parse(stdout);
  assert.equal(result.evaluator.id, 'local-fresh-qa-evaluator-v1');
  assert.notEqual(result.evaluator.pid, process.pid);
  assert.equal(result.decision.verdict, 'BLOCKED');
  assert.equal(result.decision.reason, 'product-intent-assessment-unavailable');
  assert.equal(result.qaDisposition.disposition, 'BlockedOrIncomplete');
  assert.equal(result.record.evaluationRounds.length, 1);
  assert.equal(result.record.evaluationAttempts, undefined);
  await evidence.loadPortable(
    result.record.evaluationRounds[0].evidenceRefs[0],
  );
});

test('local evaluator prevents an incomplete required scenario from passing', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'temari-qa-evaluator-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidenceRoot = join(root, 'evidence');
  const evidence = await FileEvidenceStore.create(evidenceRoot);
  const reference = await evidence.put({
    runId: 'qa-assignment',
    revision: 'candidate-r1',
    kind: 'verification',
    content: 'fixture-a1 only',
  });
  const draftPath = join(root, 'draft.json');
  await writeFile(
    draftPath,
    JSON.stringify(draft(reference, 'BlockedOrIncomplete')),
  );
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      '--import',
      '@swc-node/register/esm-register',
      'tools/run-qa-evaluator-local.mjs',
      '--draft',
      draftPath,
      '--evidence-root',
      evidenceRoot,
    ],
    { cwd: new URL('..', import.meta.url) },
  );
  const result = JSON.parse(stdout);
  assert.equal(result.decision.verdict, 'REVISE');
  assert.equal(result.qaDisposition.disposition, 'BlockedOrIncomplete');
  assert(
    result.decision.unresolvedFindingIds.includes(
      'scenario-category-filter-blockedorincomplete',
    ),
  );
});
