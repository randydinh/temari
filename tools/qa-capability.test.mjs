import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { qaProofDigest } from '../libs/temari-core/src/lib/qa-execution-proof.ts';
import { createQaReviewRecord, validateQaReviewRecord, QA_REVIEW_AREAS }
  from '../libs/temari-core/src/lib/qa-review-record.ts';
import { produceQaPolicyCapability, verifyQaPolicyCapability }
  from '../packages/workflow-runtime/host/qa-capability.mjs';
import { POLICY_APPROVED_OUTCOMES } from './qa-temari-policy-semantic.mjs';

const core = { qaProofDigest, createQaReviewRecord, validateQaReviewRecord };
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const clone = (value) => JSON.parse(JSON.stringify(value));
let context, observed, workerBytes;

// The one real launch below uses a copy of the actual source-linked worker.
// This fixture does not admit production artifact/source authority, task/store,
// product execution, models, native Codex, receipts or business completion.
// All subsequent negative tests mutate copies; they never launch replacements.
before(async () => {
  const artifactRoot = await realpath(await mkdtemp(join(tmpdir(), 'temari-qa-capability-unit-')));
  await mkdir(join(artifactRoot, 'bin'));
  workerBytes = await readFile(fileURLToPath(new URL('./qa-temari-policy-semantic.mjs', import.meta.url)));
  await writeFile(join(artifactRoot, 'bin/qa-temari-policy-semantic.mjs'), workerBytes, { flag: 'wx' });
  const revision = 'unit-candidate';
  const intents = Object.entries(POLICY_APPROVED_OUTCOMES).map(([intentId, outcome]) => ({
    intentId, requirementRef: `temari-public-policy#${intentId}`,
    revision: 'temari-public-feature-v2', authorityRef: 'temari-public-policy-v2-approved',
    sourceSha256: 'a'.repeat(64), expectedOutcome: JSON.stringify(outcome),
  }));
  const review = { schemaVersion: 1, reviewRevision: 'unit-review', parentRevision: null,
    authorId: 'unit-author', assignment: { assignmentId: 'unit-assignment',
      requestKind: 'full', tier: 'standard', requestedScope: 'advertised policy only',
      excludedScope: ['arbitrary product control'], ticketRef: 'unit-policy',
      ticketRevision: 'temari-public-feature-v2', requirementRefs: intents.map((intent) => intent.requirementRef),
      requirementRevisions: intents.map((intent) => intent.revision), candidateRef: revision,
      environmentRef: 'unit-environment', authority: { allowedActions: ['read-evidence', 'run-local-check'],
        deniedActions: ['external-write'] }, knownConstraints: ['unit fixture has no admitted source/task authority'] },
    intentSources: intents.map(({ intentId: _id, sourceSha256: _sha, ...source }) => source),
    plan: { tier: 'standard', objectives: ['exercise only capability transport and unresolved findings'] },
    areaDecisions: QA_REVIEW_AREAS.map((area) => ({ area, status: 'Applicable', basis: 'Unit fixture disposition remains blocked.' })),
    residualRisks: ['Capability observation is never positive product QA proof.'],
    // Deliberately omit one authored outcome: worker must challenge both NotRun
    // scenarios and the missing approved outcome without claiming success.
    scenarios: intents.slice(0, 2).map((intent) => ({ scenarioId: `scenario-${intent.intentId}`,
      requirementRefs: [intent.requirementRef], conditions: 'bounded advertised-policy scope',
      expectedBehavior: intent.expectedOutcome, sourceRevision: intent.revision,
      behavioralReason: 'fixed approved predicate', areaMappings: ['data-verification'],
      obligation: 'Required', obligationRationale: 'approved policy outcome',
      coverageBindings: [{ bindingId: `coverage-${intent.intentId}`, kind: 'AutomatedTest',
        canonicalRef: 'unit://not-product-proof', repositoryRevision: revision,
        assertionSummary: `policy:${intent.intentId}`, designState: 'Selected',
        implementationState: 'Existing', writeReceiptRef: null }],
      executions: [], result: 'NotRun', nextAction: 'requires actual product control after independent admission' })) };
  const binding = { taskId: 'unit-task', runId: 'unit-run', revision,
    requestSha256: 'b'.repeat(64), manifestSha256: 'c'.repeat(64), hostSelectionSha256: 'd'.repeat(64),
    candidate: { scopeId: 'unit-scope', root: '/unit/not-real', revision, artifactManifestSha256: 'e'.repeat(64) },
    environmentRef: 'unit-environment', intentSha256: qaProofDigest(intents), frozenReviewSha256: qaProofDigest(review) };
  context = { artifactRoot, core, binding, review, intents };
  observed = await produceQaPolicyCapability(context);
});

function changed(mutator) {
  const proof = clone(observed.proof); mutator(proof); return proof;
}
function stream(raw) { return { raw, bytes: Buffer.byteLength(raw), sha256: sha(raw) }; }
function replaceSemantic(proof, mutator) {
  mutator(proof.semantic);
  proof.semanticSha256 = qaProofDigest(proof.semantic);
  proof.stdout = stream(`${JSON.stringify(proof.semantic)}\n`);
}

test('one actual fixed worker process proves only scoped QA subagent transport', () => {
  const { proof, capabilities, proofSha256 } = observed;
  assert.equal(proof.status, 'observed'); assert.equal(proof.purpose, 'qa-capability-probe');
  assert.equal(proof.host, 'local-qa-policy-host'); assert.equal(proof.profileId, 'temari-public-policy-v1');
  assert(Number.isSafeInteger(proof.processId)); assert.notEqual(proof.processId, process.pid);
  assert.equal(proof.parentProcessId, process.pid); assert.notEqual(proof.contextId, proof.evaluatorLaunchId);
  assert.equal(proof.helper.sha256, sha(workerBytes)); assert.equal(proof.runtime.path, process.execPath);
  assert.deepEqual(proof.argv, [process.execPath, join(context.artifactRoot, 'bin/qa-temari-policy-semantic.mjs')]);
  const input = JSON.parse(proof.stdin.raw);
  assert.deepEqual(input.observations, []); assert.deepEqual(input.canonicalEvidenceRefs, []);
  assert(input.review.scenarios.every((scenario) => scenario.result === 'NotRun' && scenario.executions.length === 0));
  assert(proof.semantic.scenarios.every((scenario) => scenario.assessment === 'unresolved' && scenario.attemptIds.length === 0 && scenario.evidenceRefs.length === 0));
  assert.equal(proof.semantic.outcomes.length, 3);
  assert(proof.semantic.outcomes.some((outcome) => outcome.coverage === 'missing'));
  assert(proof.semantic.outcomes.every((outcome) => ['missing', 'unresolved'].includes(outcome.coverage)));
  assert(proof.semantic.findings.length >= 3);
  assert.equal(proofSha256, qaProofDigest(proof));
  assert.deepEqual(capabilities.available, ['subagents']);
  assert.deepEqual(capabilities.missing, ['parallelism', 'model_diversity', 'worktree_isolation', 'durable_delivery', 'forge']);
  assert.equal(capabilities.provenance.subagents.status, 'proven');
  assert(capabilities.notes.subagents.includes(proofSha256));
  assert.match(capabilities.notes.subagents, /No product attempt, passing QA, model\/native Codex, forge, parallelism/);
  assert.deepEqual(Object.keys(proof.env).sort(), ['LANG', 'NODE_OPTIONS', 'NODE_PATH', 'PATH', 'TZ']);
});

test('resume verifies the identical retained capture and never produces a new PID/context', async () => {
  const verified = await verifyQaPolicyCapability(clone(observed.proof), context);
  assert.deepEqual(verified, observed);
});

test('caller capability flags, enum-only proof and unknown fields are rejected', async () => {
  await assert.rejects(verifyQaPolicyCapability({ status: 'proven', available: ['subagents'] }, context));
  await assert.rejects(verifyQaPolicyCapability(changed((proof) => { proof.capabilities = { available: ['forge'] }; }), context));
});

test('every current task/request/manifest/candidate/intent/environment binding must remain exact', async () => {
  for (const mutate of [
    (proof) => { proof.binding.taskId = 'foreign-task'; },
    (proof) => { proof.binding.runId = 'foreign-run'; },
    (proof) => { proof.binding.requestSha256 = 'f'.repeat(64); },
    (proof) => { proof.binding.manifestSha256 = 'f'.repeat(64); },
    (proof) => { proof.binding.hostSelectionSha256 = 'f'.repeat(64); },
    (proof) => { proof.binding.candidate.artifactManifestSha256 = 'f'.repeat(64); },
    (proof) => { proof.binding.candidate.root = '/another/candidate'; },
    (proof) => { proof.binding.environmentRef = 'different-environment'; },
    (proof) => { proof.binding.intentSha256 = 'f'.repeat(64); },
    (proof) => { proof.binding.frozenReviewSha256 = 'f'.repeat(64); },
  ]) await assert.rejects(verifyQaPolicyCapability(changed(mutate), context));
});

test('fixed helper/runtime/argv/cwd/env and profile cannot be caller-selected', async () => {
  for (const mutate of [
    (proof) => { proof.helper.path = '/another/helper.mjs'; },
    (proof) => { proof.helper.sha256 = 'f'.repeat(64); },
    (proof) => { proof.runtime.sha256 = 'f'.repeat(64); },
    (proof) => { proof.argv.push('--user-script'); },
    (proof) => { proof.cwd = '/private/tmp'; },
    (proof) => { proof.env.NODE_OPTIONS = '--import caller.mjs'; },
    (proof) => { proof.profileId = 'general-product'; },
    (proof) => { proof.purpose = 'product-attempt'; },
  ]) await assert.rejects(verifyQaPolicyCapability(changed(mutate), context));
});

test('changed helper bytes are refused on resume without replacement execution', async () => {
  const path = join(context.artifactRoot, 'bin/qa-temari-policy-semantic.mjs');
  await writeFile(path, Buffer.concat([workerBytes, Buffer.from('\n// unit drift\n')]));
  try { await assert.rejects(verifyQaPolicyCapability(observed.proof, context), /helper\/runtime\/invocation changed/); }
  finally { await writeFile(path, workerBytes); }
});

test('raw stream length/hash, frozen stdin, and semantic raw/canonical outputs cannot drift', async () => {
  for (const mutate of [
    (proof) => { proof.stdout.bytes += 1; },
    (proof) => { proof.stdin.sha256 = 'f'.repeat(64); },
    (proof) => { proof.semanticSha256 = 'f'.repeat(64); },
    (proof) => { proof.semantic.bindingSha256 = 'f'.repeat(64); proof.semanticSha256 = qaProofDigest(proof.semantic); },
    (proof) => { const input = JSON.parse(proof.stdin.raw); input.observations.push({ adopted: true }); proof.stdin = stream(JSON.stringify(input)); },
    (proof) => { const input = JSON.parse(proof.stdin.raw); input.review.scenarios[0].result = 'Passed'; proof.stdin = stream(JSON.stringify(input)); },
    (proof) => { proof.stderr.raw = 'x'.repeat(256 * 1024 + 1); proof.stderr.bytes = Buffer.byteLength(proof.stderr.raw); proof.stderr.sha256 = sha(proof.stderr.raw); },
  ]) await assert.rejects(verifyQaPolicyCapability(changed(mutate), context));
});

test('positive, violation, attempt or evidence claims are rejected even with coherent new output hashes', async () => {
  for (const mutate of [
    (semantic) => { semantic.scenarios[0].assessment = 'outcome-supported'; },
    (semantic) => { semantic.scenarios[0].assessment = 'violation-supported'; },
    (semantic) => { semantic.outcomes[0].coverage = 'covered'; },
    (semantic) => { semantic.scenarios[0].attemptIds.push('invented-attempt'); },
    (semantic) => { semantic.scenarios[0].evidenceRefs.push({ invented: true }); },
    (semantic) => { semantic.findings[0].kind = 'product-violation'; },
  ]) await assert.rejects(verifyQaPolicyCapability(changed((proof) => replaceSemantic(proof, mutate)), context));
});

test('complete unique scenario/outcome assessment and challenge joins are required', async () => {
  for (const mutate of [
    (semantic) => { semantic.scenarios.pop(); },
    (semantic) => { semantic.scenarios.push(clone(semantic.scenarios[0])); },
    (semantic) => { semantic.outcomes.pop(); },
    (semantic) => { semantic.outcomes[0].intentId = 'unknown-intent'; },
    (semantic) => { semantic.findings = []; },
    (semantic) => { semantic.outcomes[0].findingIds = ['unknown-finding']; },
    (semantic) => { semantic.findings[0].scenarioIds = ['unknown-scenario']; },
    (semantic) => { semantic.findings[0].severity = 'Minor'; },
    (semantic) => { semantic.outcomes.find((outcome) => outcome.coverage === 'missing').scenarioIds = [semantic.scenarios[0].scenarioId]; },
  ]) await assert.rejects(verifyQaPolicyCapability(changed((proof) => replaceSemantic(proof, mutate)), context));
});

test('fresh separate PID/context and bounded honest process completion are mandatory', async () => {
  for (const mutate of [
    (proof) => { proof.processId = proof.parentProcessId; },
    (proof) => { proof.processId = null; },
    (proof) => { proof.contextId = proof.evaluatorLaunchId; },
    (proof) => { proof.exitCode = 1; },
    (proof) => { proof.signal = 'SIGTERM'; },
    (proof) => { proof.completion = 'unavailable'; },
    (proof) => { proof.endedAt = new Date(Date.parse(proof.startedAt) + 41_000).toISOString(); },
    (proof) => { proof.endedAt = new Date(Date.parse(proof.startedAt) - 1).toISOString(); },
  ]) await assert.rejects(verifyQaPolicyCapability(changed(mutate), context));
});

test('synthetic negative transport states remain unavailable; they are not observed host failures', async () => {
  const proof = changed((item) => { item.status = 'unavailable'; item.completion = 'unavailable'; item.exitCode = 1;
    item.failure = 'Synthetic negative unit state only.'; item.stderr = stream('synthetic unit refusal\n'); });
  const verified = await verifyQaPolicyCapability(proof, context);
  assert.deepEqual(verified.capabilities.available, []);
  assert.equal(verified.capabilities.provenance.subagents.status, 'unproven');
  assert.equal(verified.capabilities.missing.length, 6);
  await assert.rejects(verifyQaPolicyCapability(changed((item) => {
    item.status = 'unavailable'; item.failure = 'Cannot relabel a valid observation.';
  }), context));
});

test('expected values or prior executed input cannot be adopted into probe admission', async () => {
  const altered = { ...context, intents: clone(context.intents), review: clone(context.review), binding: clone(context.binding) };
  altered.intents[0].expectedOutcome = JSON.stringify({ owner: './arbitrary-qa' });
  altered.binding.intentSha256 = qaProofDigest(altered.intents);
  await assert.rejects(verifyQaPolicyCapability(observed.proof, altered), /substitute approved outcomes/);
  const executed = { ...context, review: clone(context.review), binding: clone(context.binding) };
  executed.review.scenarios[0].result = 'Passed';
  executed.binding.frozenReviewSha256 = qaProofDigest(executed.review);
  await assert.rejects(verifyQaPolicyCapability(observed.proof, executed), /NotRun scenarios/);
});
