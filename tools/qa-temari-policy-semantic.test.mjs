import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { qaProofDigest } from '../libs/temari-core/src/lib/qa-execution-proof.ts';
import { runPolicyControl } from './qa-product-policy-control.mjs';
import { assessTemariPolicy, POLICY_APPROVED_OUTCOMES, POLICY_AUTHORITY_REF,
  POLICY_INTENT_REVISION, policyProofDigest, sha256 } from './qa-temari-policy-semantic.mjs';

// Pure adapter-unit data only: not host-admitted captures, authority or receipts.
// Actual child-control tests below emit only negative outputs; no mock CLI
// produces a positive product observation or canonical completion.
function unitInput() {
  const revision = 'unit-candidate';
  const runId = 'unit-run';
  const rawStdout = JSON.stringify({ schemaVersion: 1, entry: 'temari',
    status: 'described', policyId: 'unit-only-policy', qaContract: {
      ...POLICY_APPROVED_OUTCOMES['qa-owner'],
      ...POLICY_APPROVED_OUTCOMES['read-only-contract'],
      ...POLICY_APPROVED_OUTCOMES['capability-admission'],
    } });
  const evidenceRef = (kind, bytes) => ({ schema: 1, runId, revision, kind,
    sha256: sha256(bytes), bytes: Buffer.byteLength(bytes) });
  const stdoutRef = evidenceRef('stdout', rawStdout);
  const stderrRef = evidenceRef('stderr', '');
  const intents = Object.entries(POLICY_APPROVED_OUTCOMES).map(([intentId, outcome]) => ({
    intentId, requirementRef: `temari-public-policy#${intentId}`,
    revision: POLICY_INTENT_REVISION, authorityRef: POLICY_AUTHORITY_REF,
    sourceSha256: 'a'.repeat(64), expectedOutcome: JSON.stringify(outcome),
  }));
  const review = {
    schemaVersion: 1, reviewRevision: 'unit-review', parentRevision: null,
    authorId: 'unit-author', assignment: { assignmentId: 'unit-assignment',
      requestKind: 'full', tier: 'standard', requestedScope: 'advertised policy only',
      excludedScope: ['arbitrary product control'], ticketRef: 'unit-policy',
      ticketRevision: POLICY_INTENT_REVISION, requirementRefs: intents.map((intent) => intent.requirementRef),
      requirementRevisions: intents.map((intent) => intent.revision),
      candidateRef: revision, environmentRef: 'unit-environment',
      authority: { allowedActions: ['read-evidence'], deniedActions: ['external-write'] },
      knownConstraints: ['unit data cannot admit authority or execution'],
    },
    intentSources: intents.map(({ sourceSha256: _sha, intentId: _id, ...source }) => source),
    plan: { tier: 'standard', objectives: ['unit-check three fixed predicates'] },
    areaDecisions: [], residualRisks: ['unit fixture is not actual product proof'],
    scenarios: intents.map((intent) => ({
      scenarioId: `scenario-${intent.intentId}`, requirementRefs: [intent.requirementRef],
      conditions: 'bounded policy command', expectedBehavior: intent.expectedOutcome,
      sourceRevision: intent.revision, behavioralReason: 'approved advertised contract',
      areaMappings: ['data-verification'], obligation: 'Required', obligationRationale: 'fixed approved predicate',
      coverageBindings: [{ bindingId: `coverage-${intent.intentId}`, kind: 'AutomatedTest',
        canonicalRef: 'unit://not-real-control', repositoryRevision: revision,
        assertionSummary: `policy:${intent.intentId}`, designState: 'Selected',
        implementationState: 'Existing', writeReceiptRef: null }],
      executions: [{ attemptId: `attempt-${intent.intentId}`, candidateRef: revision,
        environmentRef: 'unit-environment', fixtureRefs: ['unit://synthetic'], correlationRef: null,
        boundedObservation: 'unit JSON only', assertions: [`policy:${intent.intentId}`],
        observations: ['unit observation is not admitted'], evidenceRefs: [stdoutRef, stderrRef], state: 'Executed' }],
      result: 'Passed', nextAction: 'requires actual host proof',
    })),
  };
  const binding = { taskId: 'unit-task', runId, revision, requestSha256: 'b'.repeat(64),
    manifestSha256: 'c'.repeat(64), hostSelectionSha256: 'd'.repeat(64),
    candidate: { scopeId: 'unit-scope', root: '/unit/not-real', revision,
      artifactManifestSha256: 'e'.repeat(64) }, environmentRef: 'unit-environment',
    intentSha256: policyProofDigest(intents), frozenReviewSha256: policyProofDigest(review) };
  return { binding, intents, review, observations: review.scenarios.map((scenario) => ({
    scenarioId: scenario.scenarioId, attemptId: scenario.executions[0].attemptId,
    launchId: 'unit-control', rawStdout, rawStderr: '', exitCode: 0, completion: 'completed', stdoutRef, stderrRef,
  })), canonicalEvidenceRefs: [stdoutRef, stderrRef], evaluatorLaunchId: 'unit-evaluator' };
}

function refreeze(input) {
  input.binding.intentSha256 = policyProofDigest(input.intents);
  input.binding.frozenReviewSha256 = policyProofDigest(input.review);
}

function replaceRaw(input, mutate) {
  const output = JSON.parse(input.observations[0].rawStdout);
  mutate(output);
  const raw = JSON.stringify(output);
  const old = input.observations[0].stdoutRef;
  const ref = { ...old, sha256: sha256(raw), bytes: Buffer.byteLength(raw) };
  input.canonicalEvidenceRefs = input.canonicalEvidenceRefs.map((item) => item.kind === 'stdout' ? ref : item);
  input.observations.forEach((observation) => { observation.rawStdout = raw; observation.stdoutRef = ref; });
  input.review.scenarios.forEach((scenario) => scenario.executions.forEach((execution) => {
    execution.evidenceRefs = execution.evidenceRefs.map((item) => item.kind === 'stdout' ? ref : item);
  }));
  refreeze(input);
}

test('canonical hashes match the new core API and reject non-finite or non-plain values', () => {
  const samples = [null, [], { z: 1, a: [{ nested: true, x: null }] }, unitInput()];
  for (const value of samples) assert.equal(policyProofDigest(value), qaProofDigest(value));
  for (const value of [undefined, Infinity, NaN, { invalid: undefined }, new Date(), new Map()]) {
    assert.throws(() => policyProofDigest(value));
    assert.throws(() => qaProofDigest(value));
  }
});

test('unit predicate classification exactly covers all scenarios, attempts and approved outcomes', () => {
  const input = unitInput();
  const result = assessTemariPolicy(input);
  assert.equal(result.bindingSha256, qaProofDigest(input.binding));
  assert.deepEqual(result.scenarios.map((scenario) => scenario.scenarioId), input.review.scenarios.map((scenario) => scenario.scenarioId));
  for (const scenario of result.scenarios) {
    assert.equal(scenario.assessment, 'outcome-supported');
    assert.equal(scenario.assertionAssessment, 'sufficient');
    assert.equal(scenario.attemptIds.length, 1);
    assert.deepEqual(scenario.evidenceRefs, input.canonicalEvidenceRefs);
  }
  assert.equal(result.outcomes.length, 3);
  assert(result.outcomes.every((outcome) => outcome.coverage === 'covered'));
  assert.deepEqual(result.findings, []);
  // This tests a pure finite comparator, never host admission or a receipt.
});

test('missing authored scenario is challenged against the complete approved baseline', () => {
  const input = unitInput();
  input.review.scenarios.pop();
  input.observations.pop();
  refreeze(input);
  const result = assessTemariPolicy(input);
  const missing = result.outcomes.find((outcome) => outcome.intentId === 'capability-admission');
  assert.equal(missing.coverage, 'missing');
  assert.deepEqual(missing.scenarioIds, []);
  assert(result.findings.some((finding) => finding.kind === 'missing-outcome' && finding.intentIds.includes(missing.intentId)));
});

test('weak shared assertion cannot support an outcome despite matching policy JSON', () => {
  const input = unitInput();
  input.review.scenarios[0].executions[0].assertions = ['status is described'];
  refreeze(input);
  const result = assessTemariPolicy(input);
  assert.equal(result.scenarios[0].assessment, 'unresolved');
  assert.equal(result.scenarios[0].assertionAssessment, 'weak');
  assert(result.findings.some((finding) => finding.kind === 'weak-assertion' && finding.attemptIds[0] === 'attempt-qa-owner'));
  assert.equal(result.outcomes[0].coverage, 'unresolved');
});

test('unimplemented coverage cannot support an outcome', () => {
  const input = unitInput();
  input.review.scenarios[0].coverageBindings[0].implementationState = 'Missing';
  refreeze(input);
  assert.equal(assessTemariPolicy(input).scenarios[0].assertionAssessment, 'weak');
});

test('actual bytes in the semantic input can support a named violation with exact evidence', () => {
  const input = unitInput();
  replaceRaw(input, (output) => { output.qaContract.owner = './wrong-owner'; });
  input.review.scenarios[0].result = 'Failed';
  refreeze(input);
  const result = assessTemariPolicy(input);
  assert.equal(result.scenarios[0].assessment, 'violation-supported');
  const violation = result.findings.find((finding) => finding.kind === 'product-violation');
  assert.deepEqual(violation.intentIds, ['qa-owner']);
  assert.deepEqual(violation.scenarioIds, ['scenario-qa-owner']);
  assert.deepEqual(violation.attemptIds, ['attempt-qa-owner']);
  assert.deepEqual(violation.evidenceRefs, input.canonicalEvidenceRefs);
});

test('known bad write and capability advertisements violate their respective predicates', () => {
  const input = unitInput();
  replaceRaw(input, (output) => {
    output.qaContract.externalWrites = 'allowed';
    output.qaContract.callerDeclaredCapabilitiesAreNotProof = false;
  });
  input.review.scenarios[1].result = 'Failed';
  input.review.scenarios[2].result = 'Failed';
  refreeze(input);
  const result = assessTemariPolicy(input);
  assert.deepEqual(result.scenarios.map((scenario) => scenario.assessment),
    ['outcome-supported', 'violation-supported', 'violation-supported']);
  assert.equal(result.findings.filter((finding) => finding.kind === 'product-violation').length, 2);
});

test('a frozen Passed claim contradicting observation becomes unresolved', () => {
  const input = unitInput();
  replaceRaw(input, (output) => { delete output.qaContract.owner; });
  const result = assessTemariPolicy(input);
  assert.equal(result.scenarios[0].assessment, 'unresolved');
  assert(result.findings.some((finding) => finding.kind === 'intent-conflict'));
});

test('authority, expected values, revision and source pin disagreement remain blocked', () => {
  for (const mutate of [
    (input) => { input.intents[0].authorityRef = 'caller-approved'; },
    (input) => { input.intents[0].expectedOutcome = '{"owner":"./wrong-owner"}'; },
    (input) => { input.intents[0].revision = 'different-revision'; },
    (input) => { input.intents[0].sourceSha256 = 'f'.repeat(64); },
    (input) => { input.intents[0].intentId = 'unknown-predicate'; },
  ]) {
    const input = unitInput();
    mutate(input);
    refreeze(input);
    const result = assessTemariPolicy(input);
    assert(result.scenarios.every((scenario) => scenario.assessment === 'unresolved'));
    assert(result.findings.some((finding) => finding.kind === 'intent-conflict'));
  }
});

test('changed raw bytes cannot reuse a prior evidence reference', () => {
  const input = unitInput();
  input.observations[0].rawStdout += '\n';
  const result = assessTemariPolicy(input);
  assert(result.scenarios.every((scenario) => scenario.assessment === 'unresolved'));
  assert(result.findings.some((finding) => /Raw control bytes/.test(finding.reason)));
});

test('unknown attempt and duplicate observation are not silently accepted', () => {
  const input = unitInput();
  input.observations[0].attemptId = 'unknown';
  assert(assessTemariPolicy(input).scenarios.every((scenario) => scenario.assessment === 'unresolved'));
  const duplicate = unitInput();
  duplicate.observations.push(duplicate.observations[0]);
  assert.throws(() => assessTemariPolicy(duplicate), /Duplicate observed/);
});

test('unavailable or nonzero control cannot support a policy outcome', () => {
  for (const mutate of [
    (input) => { input.observations[0].completion = 'unavailable'; },
    (input) => { input.observations[0].exitCode = 9; },
    (input) => { input.review.scenarios[0].executions[0].state = 'NotRun'; },
  ]) {
    const input = unitInput(); mutate(input); refreeze(input);
    assert.equal(assessTemariPolicy(input).scenarios[0].assessment, 'unresolved');
  }
});

async function negativeArtifact(source) {
  const root = await mkdtemp(join(tmpdir(), 'temari-policy-negative-unit-'));
  await mkdir(join(root, 'bin'));
  await writeFile(join(root, 'bin', 'temari.mjs'), source);
  const manifest = { schemaVersion: 1, files: [{ path: 'bin/temari.mjs', sha256: sha256(source), bytes: Buffer.byteLength(source) }] };
  const raw = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(join(root, 'public-entry-manifest.json'), raw);
  return { candidateRoot: await realpath(root), expectedManifestSha256: sha256(raw) };
}

test('fixed control actually launches a relocated negative CLI and retains PID/bytes/status/log hashes', async () => {
  const artifact = await negativeArtifact('process.stderr.write("negative-only control\\n"); process.exitCode = 7;\n');
  const capture = await runPolicyControl(artifact);
  assert.equal(capture.exitCode, 7);
  assert.equal(capture.completion, 'completed');
  assert(Number.isSafeInteger(capture.processId) && capture.processId > 0 && capture.processId !== process.pid);
  assert.deepEqual(capture.command.slice(1), [join(artifact.candidateRoot, 'bin/temari.mjs'), 'policy']);
  assert.equal(capture.rawStderr, 'negative-only control\n');
  assert.equal(capture.stderrSha256, sha256(capture.rawStderr));
  assert.equal(capture.stdoutSha256, sha256(''));
  assert.equal(capture.output, null);
  assert(Date.parse(capture.endedAt) >= Date.parse(capture.startedAt));
  for (const key of ['runtimeSha256', 'implementationSha256', 'invocationSha256', 'inputSha256'])
    assert.match(capture[key], /^[a-f0-9]{64}$/);
});

test('control refuses tampered manifest or CLI before launch', async () => {
  const artifact = await negativeArtifact('process.exitCode = 8;\n');
  await assert.rejects(runPolicyControl({ ...artifact, expectedManifestSha256: '0'.repeat(64) }), /manifest differs/);
  await writeFile(join(artifact.candidateRoot, 'bin/temari.mjs'), 'process.exitCode = 9;\n');
  await assert.rejects(runPolicyControl(artifact), /entry differs/);
});

test('control timeout and output overflow retain unavailable bounded captures', async () => {
  const hanging = await negativeArtifact('setInterval(() => {}, 1000);\n');
  const timeout = await runPolicyControl({ ...hanging, timeoutMs: 50 });
  assert.equal(timeout.completion, 'unavailable');
  assert.equal(timeout.failure, 'timeout');
  assert.equal(timeout.signal, 'SIGKILL');
  const overflowing = await negativeArtifact('process.stdout.write("x".repeat(10000));\n');
  const overflow = await runPolicyControl({ ...overflowing, maxStreamBytes: 128 });
  assert.equal(overflow.completion, 'unavailable');
  assert.equal(overflow.failure, 'stdout-overflow');
  assert.equal(Buffer.byteLength(overflow.rawStdout), 128);
  assert.equal(overflow.output, null);
});

test('separate stdin worker executes the comparator and refuses extra or oversized input', async () => {
  const path = fileURLToPath(new URL('./qa-temari-policy-semantic.mjs', import.meta.url));
  const invoke = (raw) => new Promise((done, reject) => {
    const child = spawn(process.execPath, [path], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.stdin.on('error', () => {});
    child.once('close', (code) => done({ code, stdout, stderr, pid: child.pid }));
    child.stdin.end(raw);
  });
  const input = unitInput(); input.review.scenarios[0].executions[0].assertions = [];
  refreeze(input);
  const observed = await invoke(JSON.stringify(input));
  assert.equal(observed.code, 0, observed.stderr);
  assert.notEqual(observed.pid, process.pid);
  assert.equal(JSON.parse(observed.stdout).scenarios[0].assessment, 'unresolved');
  const extra = await invoke(JSON.stringify({ ...input, proven: true }));
  assert.equal(extra.code, 1);
  assert.equal(extra.stdout, '');
  assert.match(extra.stderr, /unknown fields/);
  const oversized = await invoke(' '.repeat(256 * 1024 + 1));
  assert.equal(oversized.code, 1);
  assert.match(oversized.stderr, /exceeds/);
});
