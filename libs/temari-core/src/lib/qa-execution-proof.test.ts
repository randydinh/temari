import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkerEvidenceReference } from '@temari/contracts';

import { QA_REVIEW_AREAS } from './qa-review-record.js';
import type { QaReviewDraft } from './qa-evaluator.js';
import {
  qaProofDigest,
  validateQaExecutionProof,
  type QaExecutionProof,
  type QaExecutionProofContext,
  type QaObservedLaunch,
} from './qa-execution-proof.js';

type Mutable<T> = T extends object
  ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
  : T;
interface Fixture {
  readonly proof: QaExecutionProof;
  readonly context: QaExecutionProofContext;
}

function edited<T>(value: T, edit: (copy: Mutable<T>) => void): T {
  // JSON input has independent occurrences, not shared object aliases between
  // author proof and host pins. Keep mutation tests from changing both at once.
  const copy = JSON.parse(JSON.stringify(value)) as Mutable<T>;
  edit(copy);
  return copy as T;
}

/**
 * Relationship fixtures only. These hashes/selections/PIDs are not actual
 * launch evidence, a model invocation, authority admission or runtime receipt.
 */
function fixture(): Fixture {
  const reference = (kind: 'stdout' | 'stderr', label: string): WorkerEvidenceReference => ({
    schema: 1, runId: 'qa-run-1', revision: 'candidate-1', kind,
    sha256: qaProofDigest(label), bytes: label.length,
  });
  const controlOut = reference('stdout', 'actual observation fixture');
  const controlErr = reference('stderr', 'control diagnostic fixture');
  const semanticOut = reference('stdout', 'semantic observation fixture');
  const semanticErr = reference('stderr', 'semantic diagnostic fixture');
  const intents = [{ intentId: 'intent-1', requirementRef: 'requirement-1',
    revision: 'intent-revision-1', authorityRef: 'decision://approved',
    sourceSha256: qaProofDigest('approved source fixture'), expectedOutcome: 'return the requested policy contract' }];
  const review: QaReviewDraft = {
    schemaVersion: 1, reviewRevision: 'review-1', parentRevision: null, authorId: 'qa-author',
    assignment: {
      assignmentId: 'assignment-1', requestKind: 'full', tier: 'standard',
      requestedScope: 'the selected public CLI policy boundary', excludedScope: [],
      ticketRef: 'ticket-1', ticketRevision: 'ticket-revision-1',
      requirementRefs: ['requirement-1'], requirementRevisions: ['intent-revision-1'],
      candidateRef: 'candidate-1', environmentRef: 'local-readonly-1',
      authority: { allowedActions: ['read-source', 'run-local-check'], deniedActions: ['publish'] },
      knownConstraints: ['no external writes'],
    },
    intentSources: [{ requirementRef: intents[0].requirementRef, revision: intents[0].revision,
      authorityRef: intents[0].authorityRef, expectedOutcome: intents[0].expectedOutcome }],
    plan: { tier: 'standard', objectives: ['observe the promised policy values'] },
    areaDecisions: QA_REVIEW_AREAS.map((area) => ({ area,
      status: area === 'boundaries' ? 'Applicable' : 'NotApplicable',
      basis: area === 'boundaries' ? 'selected public command contract' : 'excluded by this bounded CLI assignment' })),
    scenarios: [{ scenarioId: 'scenario-1', requirementRefs: ['requirement-1'],
      conditions: 'read the actual selected candidate policy', expectedBehavior: intents[0].expectedOutcome,
      sourceRevision: 'intent-revision-1', behavioralReason: 'the public contract promises this policy',
      areaMappings: ['boundaries'], obligation: 'Required', obligationRationale: 'this is the selected acceptance claim',
      coverageBindings: [{ bindingId: 'coverage-1', kind: 'ManualProcedure', canonicalRef: 'profile://temari-policy',
        repositoryRevision: 'candidate-1', assertionSummary: 'compare declared policy fields with the approved values',
        designState: 'Selected', implementationState: 'Existing', writeReceiptRef: null }],
      executions: [{ attemptId: 'attempt-1', candidateRef: 'candidate-1', environmentRef: 'local-readonly-1',
        fixtureRefs: ['fixture://policy'], correlationRef: null,
        boundedObservation: 'the observed policy fields matched the independent expectation',
        assertions: ['route and allowed actions equal the pinned policy'], observations: ['observed route and actions'],
        evidenceRefs: [controlOut], state: 'Executed' }], result: 'Passed', nextAction: 'retain the bounded conclusion' }],
    residualRisks: ['does not cover arbitrary products or hosts'],
  };
  const binding = {
    taskId: 'task-1', runId: 'qa-run-1', revision: 'candidate-1',
    requestSha256: qaProofDigest('public request fixture'), manifestSha256: qaProofDigest('host artifact fixture'),
    hostSelectionSha256: qaProofDigest('independent host selection fixture'),
    candidate: { scopeId: 'candidate-scope-1', root: '/fixture/candidate', revision: 'candidate-1',
      artifactManifestSha256: qaProofDigest('product artifact fixture') },
    environmentRef: 'local-readonly-1', intentSha256: qaProofDigest(intents), frozenReviewSha256: qaProofDigest(review),
  };
  const launch = (role: QaObservedLaunch['role'], stdoutRef: WorkerEvidenceReference,
    stderrRef: WorkerEvidenceReference): QaObservedLaunch => ({
    launchId: role, role, profileId: `${role}-profile-v1`,
    implementationSha256: qaProofDigest(`${role} implementation fixture`), runtimeSha256: qaProofDigest('runtime fixture'),
    artifactManifestSha256: binding.candidate.artifactManifestSha256,
    actorId: role === 'semantic-evaluator' ? 'independent-evaluator' : 'qa-author',
    contextId: `${role}-fresh-context`, processId: role === 'semantic-evaluator' ? 102 : 101,
    invocationSha256: qaProofDigest(`${role} command fixture`), inputSha256: qaProofDigest(`${role} input fixture`),
    outputSha256: qaProofDigest(`${role} result fixture`), startedAt: '2026-10-02T04:00:00Z',
    endedAt: '2026-10-02T04:00:01Z', completion: 'completed', exitCode: 0, stdoutRef, stderrRef,
  });
  const semantic = {
    schemaVersion: 1 as const, bindingSha256: qaProofDigest(binding), frozenReviewSha256: binding.frozenReviewSha256,
    evaluatorLaunchId: 'semantic-evaluator', scenarios: [{ scenarioId: 'scenario-1',
      assessment: 'outcome-supported' as const, assertionAssessment: 'sufficient' as const,
      rationale: 'the observation asserts the requested contract rather than just an exit code',
      intentIds: ['intent-1'], attemptIds: ['attempt-1'], evidenceRefs: [controlOut] }],
    outcomes: [{ intentId: 'intent-1', coverage: 'covered' as const, scenarioIds: ['scenario-1'],
      rationale: 'the selected outcome has a candidate-bound observation', findingIds: [] }], findings: [],
  };
  const evaluator = { ...launch('semantic-evaluator', semanticOut, semanticErr), outputSha256: qaProofDigest(semantic) };
  const launches = [launch('product-control', controlOut, controlErr), evaluator];
  return {
    proof: { schemaVersion: 1, binding, launches,
      attempts: [{ scenarioId: 'scenario-1', attemptId: 'attempt-1',
        executionSha256: qaProofDigest(review.scenarios[0].executions[0]), launchId: 'product-control' }], semantic },
    context: { binding, review, intents, canonicalEvidenceRefs: [controlOut, controlErr, semanticOut, semanticErr],
      admittedLaunches: launches.map((item) => ({ launchId: item.launchId, launchSha256: qaProofDigest(item) })),
      semanticInputSha256: evaluator.inputSha256 },
  };
}

/** Rebind changed mechanical fixtures; never an admission or receipt producer. */
function rebound(input: Fixture): Fixture {
  return edited(input, (copy) => {
    copy.context.binding.frozenReviewSha256 = qaProofDigest(copy.context.review);
    copy.context.binding.intentSha256 = qaProofDigest(copy.context.intents);
    copy.proof.binding = copy.context.binding;
    copy.proof.semantic.bindingSha256 = qaProofDigest(copy.context.binding);
    copy.proof.semantic.frozenReviewSha256 = copy.context.binding.frozenReviewSha256;
    for (const attempt of copy.proof.attempts) {
      const execution = copy.context.review.scenarios.find((scenario) => scenario.scenarioId === attempt.scenarioId)
        ?.executions.find((item) => item.attemptId === attempt.attemptId);
      if (execution) attempt.executionSha256 = qaProofDigest(execution);
    }
    const evaluator = copy.proof.launches.find((item) => item.launchId === copy.proof.semantic.evaluatorLaunchId);
    if (evaluator) evaluator.outputSha256 = qaProofDigest(copy.proof.semantic);
    copy.context.admittedLaunches = copy.proof.launches.map((item) => ({
      launchId: item.launchId, launchSha256: qaProofDigest(item),
    }));
  });
}

function result(input: Fixture) {
  return validateQaExecutionProof(input.proof, input.context);
}

test('canonical hashes ignore object key ordering and reject non-JSON values', () => {
  assert.equal(qaProofDigest({ b: 2, a: [1] }), qaProofDigest({ a: [1], b: 2 }));
  assert.throws(() => qaProofDigest({ value: undefined }), /finite JSON/);
  assert.throws(() => qaProofDigest(Number.NaN), /finite JSON/);
});

test('coherent host-selected relationship fixture qualifies only as pure validation', () => {
  assert.deepEqual(result(fixture()), { status: 'valid', issues: [], productResult: 'passed', qaDisposition: 'Passed' });
});

test('missing proof and missing admitted launch capture cannot qualify', () => {
  const input = fixture();
  assert.equal(validateQaExecutionProof(null, input.context).status, 'unavailable');
  assert.equal(result(edited(input, (copy) => { copy.context.admittedLaunches = []; })).status, 'unavailable');
});

test('standalone flags, partial objects and extra final receipt fields are malformed proof', () => {
  const input = fixture();
  for (const value of [{ productAssessment: 'proven' }, {}, [], 'proven', { ...input.proof, finalRecordSha256: 'a'.repeat(64) }]) {
    assert.equal(validateQaExecutionProof(value, input.context).status, 'invalid');
  }
});

test('every current invocation identity is pinned rather than selected from proof', () => {
  for (const key of ['taskId', 'runId', 'revision', 'requestSha256', 'manifestSha256', 'hostSelectionSha256',
    'environmentRef', 'intentSha256', 'frozenReviewSha256'] as const) {
    const input = edited(fixture(), (copy) => { copy.proof.binding = { ...copy.proof.binding,
      [key]: key.endsWith('Sha256') ? qaProofDigest('wrong binding') : 'wrong-binding' }; });
    assert.equal(result(input).qaDisposition, 'BlockedOrIncomplete', key);
  }
  for (const key of ['scopeId', 'root', 'revision', 'artifactManifestSha256'] as const) {
    const input = edited(fixture(), (copy) => {
      copy.proof.binding = { ...copy.proof.binding, candidate: { ...copy.proof.binding.candidate,
        [key]: key.endsWith('Sha256') ? qaProofDigest('wrong candidate') : 'wrong-candidate' } };
    });
    assert.equal(result(input).status, 'invalid', key);
  }
});

test('changing frozen assertions or approved intent invalidates retained binding', () => {
  const changedReview = edited(fixture(), (copy) => { copy.context.review.scenarios[0].executions[0].assertions = ['only exit zero']; });
  assert.equal(result(changedReview).status, 'invalid');
  const changedIntent = edited(fixture(), (copy) => { copy.context.intents[0].expectedOutcome = 'a different approved outcome'; });
  assert.equal(result(changedIntent).status, 'invalid');
});

test('unknown, missing and duplicate scenario assessments do not qualify', () => {
  for (const change of [
    (copy: Mutable<Fixture>) => { copy.proof.semantic.scenarios = []; },
    (copy: Mutable<Fixture>) => { copy.proof.semantic.scenarios.push(copy.proof.semantic.scenarios[0]); },
    (copy: Mutable<Fixture>) => { copy.proof.semantic.scenarios[0].scenarioId = 'unknown-scenario'; },
  ]) assert.equal(result(rebound(edited(fixture(), change))).status, 'invalid');
});

test('unknown, omitted and duplicate frozen attempt joins do not qualify', () => {
  for (const change of [
    (copy: Mutable<Fixture>) => { copy.proof.attempts = []; },
    (copy: Mutable<Fixture>) => { copy.proof.attempts.push(copy.proof.attempts[0]); },
    (copy: Mutable<Fixture>) => { copy.proof.attempts[0].attemptId = 'unknown-attempt'; },
    (copy: Mutable<Fixture>) => { copy.proof.attempts[0].scenarioId = 'unknown-scenario'; },
    (copy: Mutable<Fixture>) => { copy.proof.semantic.scenarios[0].attemptIds = []; },
  ]) assert.equal(result(rebound(edited(fixture(), change))).status, 'invalid');
});

test('attempt digest and actual control launch are required', () => {
  const wrongDigest = edited(fixture(), (copy) => { copy.proof.attempts[0].executionSha256 = 'a'.repeat(64); });
  assert.equal(result(wrongDigest).status, 'invalid');
  const noControl = edited(fixture(), (copy) => { copy.proof.attempts[0].launchId = null; });
  assert.equal(result(noControl).status, 'invalid');
});

test('every approved outcome requires one known unique coverage assessment', () => {
  for (const change of [
    (copy: Mutable<Fixture>) => { copy.proof.semantic.outcomes = []; },
    (copy: Mutable<Fixture>) => { copy.proof.semantic.outcomes.push(copy.proof.semantic.outcomes[0]); },
    (copy: Mutable<Fixture>) => { copy.proof.semantic.outcomes[0].intentId = 'unknown-intent'; },
    (copy: Mutable<Fixture>) => { copy.proof.semantic.scenarios[0].intentIds = ['unknown-intent']; },
  ]) assert.equal(result(rebound(edited(fixture(), change))).status, 'invalid');
});

test('unknown and omitted observation evidence cannot qualify', () => {
  const omitted = edited(fixture(), (copy) => { copy.proof.semantic.scenarios[0].evidenceRefs = []; });
  assert.equal(result(rebound(omitted)).status, 'invalid');
  const unknown = edited(fixture(), (copy) => { copy.proof.semantic.scenarios[0].evidenceRefs[0].sha256 = 'a'.repeat(64); });
  assert.equal(result(rebound(unknown)).status, 'invalid');
  const duplicate = edited(fixture(), (copy) => { copy.proof.semantic.scenarios[0].evidenceRefs.push(copy.proof.semantic.scenarios[0].evidenceRefs[0]); });
  assert.equal(result(rebound(duplicate)).status, 'invalid');
});

test('host capture pins raw launch/runtime/command metadata', () => {
  for (const key of ['implementationSha256', 'runtimeSha256', 'invocationSha256', 'outputSha256'] as const) {
    assert.equal(result(edited(fixture(), (copy) => { copy.proof.launches[0][key] = 'a'.repeat(64); })).status, 'invalid', key);
  }
  const unjoined = edited(fixture(), (copy) => { copy.context.review.scenarios[0].executions[0].evidenceRefs = [copy.proof.launches[1].stdoutRef]; });
  assert.equal(result(rebound(unjoined)).status, 'invalid');
});

test('author, process and context reuse cannot claim independent evaluation', () => {
  for (const change of [
    (copy: Mutable<Fixture>) => { copy.proof.launches[1].actorId = copy.context.review.authorId; },
    (copy: Mutable<Fixture>) => { copy.proof.launches[1].contextId = copy.proof.launches[0].contextId; },
    (copy: Mutable<Fixture>) => { copy.proof.launches[1].processId = copy.proof.launches[0].processId; },
  ]) assert.equal(result(rebound(edited(fixture(), change))).status, 'invalid');
});

test('unavailable control or incomplete semantic transport blocks', () => {
  for (const change of [
    (copy: Mutable<Fixture>) => { copy.proof.launches[0].completion = 'unavailable'; },
    (copy: Mutable<Fixture>) => { copy.proof.launches[1].completion = 'unavailable'; },
    (copy: Mutable<Fixture>) => { copy.proof.launches[1].exitCode = 1; },
  ]) assert.equal(result(rebound(edited(fixture(), change))).status, 'unavailable');
});

test('captured semantic input and output must match exact selected evaluation', () => {
  const input = edited(fixture(), (copy) => { copy.context.semanticInputSha256 = 'a'.repeat(64); });
  assert.equal(result(input).status, 'invalid');
  const output = edited(fixture(), (copy) => { copy.proof.semantic.scenarios[0].rationale = 'changed after captured output'; });
  assert.equal(result(output).status, 'invalid');
});

test('supported product violation is valid evidence with Failed disposition', () => {
  const input = rebound(edited(fixture(), (copy) => {
    copy.context.review.scenarios[0].result = 'Failed';
    copy.proof.semantic.scenarios[0].assessment = 'violation-supported';
    copy.proof.semantic.findings = [{ findingId: 'violation-1', kind: 'product-violation', severity: 'Blocking',
      reason: 'the actual policy contradicts the independently approved value', minimumCorrection: 'repair and recheck a new candidate',
      scenarioIds: ['scenario-1'], intentIds: ['intent-1'], attemptIds: ['attempt-1'],
      evidenceRefs: copy.context.review.scenarios[0].executions[0].evidenceRefs }];
  }));
  assert.deepEqual(result(input), { status: 'valid', issues: [], productResult: 'failed', qaDisposition: 'Failed' });
});

test('violation without a known executed observation cannot become Failed', () => {
  const input = rebound(edited(fixture(), (copy) => {
    copy.context.review.scenarios[0].result = 'Failed';
    copy.proof.semantic.scenarios[0].assessment = 'violation-supported';
    copy.proof.semantic.findings = [{ findingId: 'violation-1', kind: 'product-violation', severity: 'Blocking',
      reason: 'unsupported claim', minimumCorrection: 'observe the selected control',
      scenarioIds: ['scenario-1'], intentIds: ['intent-1'], attemptIds: [], evidenceRefs: [] }];
  }));
  assert.equal(result(input).status, 'invalid');
});

test('weak assertion challenge is valid but cannot pass product QA', () => {
  const input = rebound(edited(fixture(), (copy) => {
    copy.proof.semantic.scenarios[0].assessment = 'unresolved';
    copy.proof.semantic.scenarios[0].assertionAssessment = 'weak';
    copy.proof.semantic.findings = [{ findingId: 'weak-1', kind: 'weak-assertion', severity: 'Important',
      reason: 'exit zero alone does not establish the promised fields', minimumCorrection: 'assert the independent expected values',
      scenarioIds: ['scenario-1'], intentIds: ['intent-1'], attemptIds: ['attempt-1'],
      evidenceRefs: copy.context.review.scenarios[0].executions[0].evidenceRefs }];
  }));
  assert.deepEqual(result(input), { status: 'valid', issues: [], productResult: 'blocked', qaDisposition: 'BlockedOrIncomplete' });
  assert.equal(result(rebound(edited(input, (copy) => { copy.proof.semantic.findings = []; }))).status, 'invalid');
});

test('approved outcome absent from authored scenarios must have explicit challenge', () => {
  const input = rebound(edited(fixture(), (copy) => {
    copy.context.intents.push({ ...copy.context.intents[0], intentId: 'intent-absent', expectedOutcome: 'a second approved outcome absent from this inventory' });
    copy.proof.semantic.outcomes.push({ intentId: 'intent-absent', coverage: 'missing', scenarioIds: [],
      rationale: 'the author omitted an approved outcome', findingIds: ['missing-1'] });
    copy.proof.semantic.findings.push({ findingId: 'missing-1', kind: 'missing-outcome', severity: 'Important',
      reason: 'the required capability is not represented', minimumCorrection: 'add and execute the missing scenario',
      scenarioIds: [], intentIds: ['intent-absent'], attemptIds: [], evidenceRefs: [] });
  }));
  assert.deepEqual(result(input), { status: 'valid', issues: [], productResult: 'blocked', qaDisposition: 'BlockedOrIncomplete' });
  const noChallenge = rebound(edited(input, (copy) => { copy.proof.semantic.findings = []; copy.proof.semantic.outcomes[1].findingIds = []; }));
  assert.equal(result(noChallenge).status, 'invalid');
  assert.equal(result(rebound(edited(input, (copy) => { copy.proof.semantic.outcomes.pop(); }))).status, 'invalid');
});

test('unexecuted required coverage remains a valid unresolved review, never Passed', () => {
  const input = rebound(edited(fixture(), (copy) => {
    copy.context.review.scenarios[0].executions = [];
    copy.context.review.scenarios[0].result = 'NotRun';
    copy.proof.attempts = [];
    copy.proof.launches = [copy.proof.launches[1]];
    copy.proof.semantic.scenarios[0].assessment = 'unresolved';
    copy.proof.semantic.scenarios[0].assertionAssessment = 'unresolved';
    copy.proof.semantic.scenarios[0].attemptIds = [];
    copy.proof.semantic.scenarios[0].evidenceRefs = [];
  }));
  assert.equal(result(input).status, 'valid');
  assert.equal(result(input).qaDisposition, 'BlockedOrIncomplete');
});

test('unknown finding links and product evidence unrelated to cited attempts fail', () => {
  const base = edited(fixture(), (copy) => {
    copy.proof.semantic.findings = [{ findingId: 'finding-1', kind: 'other', severity: 'Minor',
      reason: 'bounded residual risk', minimumCorrection: 'retain the note', scenarioIds: ['scenario-1'],
      intentIds: ['intent-1'], attemptIds: ['attempt-1'], evidenceRefs: copy.context.review.scenarios[0].executions[0].evidenceRefs }];
  });
  for (const change of [
    (copy: Mutable<Fixture>) => { copy.proof.semantic.findings[0].scenarioIds = ['unknown-scenario']; },
    (copy: Mutable<Fixture>) => { copy.proof.semantic.findings[0].intentIds = ['unknown-intent']; },
    (copy: Mutable<Fixture>) => { copy.proof.semantic.findings[0].attemptIds = ['unknown-attempt']; },
    (copy: Mutable<Fixture>) => { copy.proof.semantic.findings[0].evidenceRefs = [copy.proof.launches[1].stdoutRef]; },
  ]) assert.equal(result(rebound(edited(base, change))).status, 'invalid');
});

test('additional or duplicated launches and malformed timestamp fields fail', () => {
  for (const change of [
    (copy: Mutable<Fixture>) => { copy.proof.launches.push(copy.proof.launches[0]); },
    (copy: Mutable<Fixture>) => { copy.proof.launches.push({ ...copy.proof.launches[0], launchId: 'unused-control' }); },
    (copy: Mutable<Fixture>) => { copy.proof.launches[0].endedAt = '2026-10-02T03:00:00Z'; },
    (copy: Mutable<Fixture>) => { copy.proof.launches[0].processId = 0; },
  ]) assert.equal(result(rebound(edited(fixture(), change))).status, 'invalid');
});

test('a finding cannot join a known outcome from an unrelated scenario requirement', () => {
  const input = rebound(edited(fixture(), (copy) => {
    copy.context.review.assignment.requirementRefs.push('requirement-2');
    copy.context.review.assignment.requirementRevisions.push('intent-revision-2');
    copy.context.intents.push({ ...copy.context.intents[0], intentId: 'intent-2',
      requirementRef: 'requirement-2', revision: 'intent-revision-2' });
    copy.context.review.intentSources!.push({ ...copy.context.review.intentSources![0],
      requirementRef: 'requirement-2', revision: 'intent-revision-2' });
    copy.proof.semantic.outcomes.push({ intentId: 'intent-2', coverage: 'missing', scenarioIds: [],
      rationale: 'the second approved requirement is absent', findingIds: ['missing-2'] });
    copy.proof.semantic.findings.push({ findingId: 'missing-2', kind: 'missing-outcome', severity: 'Important',
      reason: 'no scenario for the second requirement', minimumCorrection: 'add its scenario',
      scenarioIds: [], intentIds: ['intent-2'], attemptIds: [], evidenceRefs: [] });
    copy.proof.semantic.findings.push({ findingId: 'unrelated-1', kind: 'other', severity: 'Minor',
      reason: 'an unrelated known outcome citation', minimumCorrection: 'link the correct requirement',
      scenarioIds: ['scenario-1'], intentIds: ['intent-2'], attemptIds: ['attempt-1'],
      evidenceRefs: copy.context.review.scenarios[0].executions[0].evidenceRefs });
  }));
  assert.equal(result(input).status, 'invalid');
  assert.match(result(input).issues.join(' '), /unrelated intent intent-2/);
});

test('valid failure cannot bypass selected implemented coverage', () => {
  const input = rebound(edited(fixture(), (copy) => {
    copy.context.review.scenarios[0].result = 'Failed';
    copy.context.review.scenarios[0].coverageBindings = [];
    copy.proof.semantic.scenarios[0].assessment = 'violation-supported';
    copy.proof.semantic.findings = [{ findingId: 'violation-1', kind: 'product-violation', severity: 'Blocking',
      reason: 'supported failure', minimumCorrection: 'repair and recheck', scenarioIds: ['scenario-1'],
      intentIds: ['intent-1'], attemptIds: ['attempt-1'], evidenceRefs: copy.context.review.scenarios[0].executions[0].evidenceRefs }];
  }));
  assert.equal(result(input).status, 'invalid');
});
