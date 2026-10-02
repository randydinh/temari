import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { exactFields, readBoundedFile } from './stdio.mjs';

const HOST = 'local-qa-policy-host';
const PROFILE = 'temari-public-policy-v1';
const PURPOSE = 'qa-capability-probe';
const CAPABILITIES = ['subagents', 'parallelism', 'model_diversity',
  'worktree_isolation', 'durable_delivery', 'forge'];
const OUTCOMES = {
  'qa-owner': { owner: './qa-review' },
  'read-only-contract': { allowedActions: ['read-source', 'read-candidate',
    'read-evidence', 'run-local-check'], externalWrites: 'denied' },
  'capability-admission': { callerDeclaredCapabilitiesAreNotProof: true },
};
const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 30_000;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const utf8 = new TextDecoder('utf-8', { fatal: true });
const same = (core, a, b) => core.qaProofDigest(a) === core.qaProofDigest(b);
const uuid = (value) => typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);

function boundedText(value, label) {
  assert(typeof value === 'string' && value.trim() && value.length <= 4096,
    `${label} must be bounded nonempty text.`);
}
function pin(value) { assert(/^[a-f0-9]{64}$/.test(value ?? ''), 'Expected a SHA256 pin.'); }
function array(value) { assert(Array.isArray(value) && value.length <= 4096, 'Expected a bounded array.'); }
function unique(values) { return values.length === new Set(values).size; }
function setEqual(a, b) { return unique(a) && unique(b) && a.length === b.length && a.every((value) => b.includes(value)); }

async function selectedFiles(artifactRoot) {
  assert(isAbsolute(artifactRoot ?? '') && !/[\x00-\x1f\x7f]/.test(artifactRoot), 'Artifact root must be absolute.');
  const rootStat = await lstat(artifactRoot);
  assert(rootStat.isDirectory() && !rootStat.isSymbolicLink() &&
    await realpath(artifactRoot) === artifactRoot, 'Artifact root must be a canonical real directory.');
  const bin = join(artifactRoot, 'bin');
  const binStat = await lstat(bin);
  assert(binStat.isDirectory() && !binStat.isSymbolicLink() && await realpath(bin) === bin,
    'Fixed worker directory must be canonical.');
  const helperPath = join(bin, 'qa-temari-policy-semantic.mjs');
  assert(await realpath(helperPath) === helperPath, 'Fixed worker cannot be redirected.');
  const runtimePath = process.execPath;
  assert(await realpath(runtimePath) === runtimePath, 'Current runtime must be canonical.');
  const [helperBytes, runtimeBytes] = await Promise.all([
    readBoundedFile(helperPath, 16 * 1024 * 1024),
    readBoundedFile(runtimePath, 256 * 1024 * 1024),
  ]);
  return { helper: { path: helperPath, sha256: sha(helperBytes), bytes: helperBytes.length },
    runtime: { path: runtimePath, sha256: sha(runtimeBytes), bytes: runtimeBytes.length } };
}

function checkContext(core, binding, review, intents) {
  assert(typeof core?.qaProofDigest === 'function' &&
    typeof core.createQaReviewRecord === 'function' && typeof core.validateQaReviewRecord === 'function',
    'The admitted core QA contract is required.');
  exactFields(binding, ['taskId', 'runId', 'revision', 'requestSha256', 'manifestSha256',
    'hostSelectionSha256', 'candidate', 'environmentRef', 'intentSha256', 'frozenReviewSha256']);
  exactFields(binding.candidate, ['scopeId', 'root', 'revision', 'artifactManifestSha256']);
  for (const key of ['taskId', 'runId', 'revision', 'environmentRef']) boundedText(binding[key], key);
  for (const key of ['requestSha256', 'manifestSha256', 'hostSelectionSha256',
    'intentSha256', 'frozenReviewSha256']) pin(binding[key]);
  for (const key of ['scopeId', 'root', 'revision']) boundedText(binding.candidate[key], key);
  pin(binding.candidate.artifactManifestSha256);
  assert(isAbsolute(binding.candidate.root), 'Candidate binding root must be absolute.');
  assert(binding.candidate.revision === binding.revision &&
    review?.assignment?.candidateRef === binding.revision &&
    review.assignment.environmentRef === binding.environmentRef &&
    !review.assignment.missingEnvironmentBlocker, 'Frozen candidate/environment binding differs.');
  array(intents); array(review.scenarios);
  assert(intents.length === 3 && unique(intents.map((intent) => intent.intentId)),
    'Exactly three unique approved policy outcomes are required.');
  const sourcePins = new Set();
  for (const intent of intents) {
    exactFields(intent, ['intentId', 'requirementRef', 'revision', 'authorityRef', 'sourceSha256', 'expectedOutcome']);
    assert(Object.hasOwn(OUTCOMES, intent.intentId) &&
      intent.requirementRef === `temari-public-policy#${intent.intentId}` &&
      intent.revision === 'temari-public-feature-v2' &&
      intent.authorityRef === 'temari-public-policy-v2-approved', 'Unsupported QA probe intent/profile.');
    pin(intent.sourceSha256); sourcePins.add(intent.sourceSha256);
    assert(same(core, JSON.parse(intent.expectedOutcome), OUTCOMES[intent.intentId]),
      'QA probe cannot substitute approved outcomes.');
    assert(review.intentSources?.some((source) => source.requirementRef === intent.requirementRef &&
      source.revision === intent.revision && source.authorityRef === intent.authorityRef &&
      same(core, JSON.parse(source.expectedOutcome), OUTCOMES[intent.intentId])),
    'Approved outcome differs from the frozen review source.');
  }
  assert(sourcePins.size === 1, 'Policy source pins differ.');
  assert(same(core, review.assignment.requirementRefs, intents.map((intent) => intent.requirementRef)) &&
    same(core, review.assignment.requirementRevisions, intents.map((intent) => intent.revision)),
  'Frozen assignment must retain every approved policy outcome.');
  assert(unique(review.scenarios.map((scenario) => scenario.scenarioId)), 'Duplicate frozen scenario ID.');
  assert(review.scenarios.every((scenario) => scenario.result === 'NotRun' &&
    Array.isArray(scenario.executions) && scenario.executions.length === 0),
  'Capability probe requires NotRun scenarios without product execution.');
  assert(binding.intentSha256 === core.qaProofDigest(intents) &&
    binding.frozenReviewSha256 === core.qaProofDigest(review), 'Probe input binding digest differs.');
  const record = core.createQaReviewRecord({ ...review, evaluationRounds: [],
    qaDisposition: 'BlockedOrIncomplete', dispositionBasis: 'Capability-only transport probe; no product attempt.',
    externalWriteReceipts: [] });
  assert.deepEqual(core.validateQaReviewRecord(record).filter((issue) =>
    issue !== 'full reviews require an independent evaluation round or a blocked attempt.'), [],
  'Frozen QA probe review is malformed.');
}

function checkAssessment(core, semantic, input) {
  exactFields(semantic, ['schemaVersion', 'bindingSha256', 'frozenReviewSha256',
    'evaluatorLaunchId', 'scenarios', 'outcomes', 'findings']);
  assert(semantic.schemaVersion === 1 && semantic.bindingSha256 === core.qaProofDigest(input.binding) &&
    semantic.frozenReviewSha256 === input.binding.frozenReviewSha256 &&
    semantic.evaluatorLaunchId === input.evaluatorLaunchId, 'Probe assessment identity differs.');
  array(semantic.scenarios); array(semantic.outcomes); array(semantic.findings);
  const scenarioIds = input.review.scenarios.map((scenario) => scenario.scenarioId);
  const intentIds = input.intents.map((intent) => intent.intentId);
  assert(setEqual(semantic.scenarios.map((scenario) => scenario.scenarioId), scenarioIds),
    'Probe requires exactly one assessment per frozen scenario.');
  assert(setEqual(semantic.outcomes.map((outcome) => outcome.intentId), intentIds),
    'Probe requires exactly all three approved outcome assessments.');
  assert(semantic.findings.length > 0 && unique(semantic.findings.map((finding) => finding.findingId)),
    'Probe must produce actual unresolved/missing findings.');
  for (const finding of semantic.findings) {
    exactFields(finding, ['findingId', 'kind', 'severity', 'reason', 'minimumCorrection',
      'scenarioIds', 'intentIds', 'attemptIds', 'evidenceRefs']);
    for (const key of ['findingId', 'reason', 'minimumCorrection']) boundedText(finding[key], key);
    assert(['scope-gap', 'missing-outcome', 'weak-assertion', 'intent-conflict'].includes(finding.kind) &&
      ['Blocking', 'Important'].includes(finding.severity), 'Probe cannot claim product violation or success.');
    for (const key of ['scenarioIds', 'intentIds', 'attemptIds', 'evidenceRefs']) array(finding[key]);
    assert(unique(finding.scenarioIds) && unique(finding.intentIds) &&
      finding.scenarioIds.every((id) => scenarioIds.includes(id)) &&
      finding.intentIds.every((id) => intentIds.includes(id)) &&
      (finding.scenarioIds.length > 0 || finding.intentIds.length > 0) &&
      finding.attemptIds.length === 0 && finding.evidenceRefs.length === 0,
    'Probe findings contain unknown joins or invented product evidence.');
  }
  for (const scenario of semantic.scenarios) {
    exactFields(scenario, ['scenarioId', 'assessment', 'assertionAssessment', 'rationale',
      'intentIds', 'attemptIds', 'evidenceRefs']);
    boundedText(scenario.rationale, 'Scenario rationale');
    array(scenario.intentIds); array(scenario.attemptIds); array(scenario.evidenceRefs);
    const frozen = input.review.scenarios.find((item) => item.scenarioId === scenario.scenarioId);
    const linked = input.intents.filter((intent) => frozen.requirementRefs.includes(intent.requirementRef)).map((intent) => intent.intentId);
    assert(scenario.assessment === 'unresolved' &&
      ['sufficient', 'weak', 'unresolved'].includes(scenario.assertionAssessment) &&
      setEqual(scenario.intentIds, linked) && scenario.attemptIds.length === 0 && scenario.evidenceRefs.length === 0,
    'Capability probe cannot emit supported outcomes, attempts or product evidence.');
    assert(semantic.findings.some((finding) => finding.scenarioIds.includes(scenario.scenarioId)),
      'Every unresolved probe scenario requires an actual challenge.');
  }
  for (const outcome of semantic.outcomes) {
    exactFields(outcome, ['intentId', 'coverage', 'scenarioIds', 'rationale', 'findingIds']);
    boundedText(outcome.rationale, 'Outcome rationale'); array(outcome.scenarioIds); array(outcome.findingIds);
    const linked = semantic.scenarios.filter((scenario) => scenario.intentIds.includes(outcome.intentId)).map((scenario) => scenario.scenarioId);
    assert(setEqual(outcome.scenarioIds, linked) &&
      outcome.coverage === (linked.length ? 'unresolved' : 'missing') &&
      unique(outcome.findingIds) && outcome.findingIds.length > 0,
    'Capability probe cannot emit covered/positive outcome proof.');
    const related = semantic.findings.filter((finding) => finding.intentIds.includes(outcome.intentId));
    assert(setEqual(outcome.findingIds, related.map((finding) => finding.findingId)) &&
      (outcome.coverage !== 'missing' || related.some((finding) => finding.kind === 'missing-outcome')),
    'Outcome challenge joins are incomplete.');
  }
}

function stream(bytes) { return { raw: utf8.decode(bytes), bytes: bytes.length, sha256: sha(bytes) }; }
function checkStream(value) {
  exactFields(value, ['raw', 'bytes', 'sha256']); pin(value.sha256);
  assert(typeof value.raw === 'string' && Buffer.byteLength(value.raw) <= MAX_BYTES &&
    value.bytes === Buffer.byteLength(value.raw) && value.sha256 === sha(value.raw), 'Probe stream hash/length differs.');
}
function commandEnvironment() {
  return { PATH: dirname(process.execPath), LANG: 'C.UTF-8', TZ: 'UTC', NODE_OPTIONS: '', NODE_PATH: '' };
}

function derive(core, proof) {
  const proofSha256 = core.qaProofDigest(proof);
  const source = `fixed QA capability probe ${PROFILE}; ${proofSha256}`;
  const observed = proof.status === 'observed';
  return { proof, proofSha256, capabilities: { host: HOST,
    available: observed ? ['subagents'] : [], missing: CAPABILITIES.filter((capability) => !observed || capability !== 'subagents'),
    notes: { subagents: `${source}. Only the separately launched finite policy evaluator is admitted. No product attempt, passing QA, model/native Codex, forge, parallelism or general product capability is proved.` },
    provenance: { subagents: observed ? { status: 'proven', source, observedAt: proof.endedAt }
      : { status: 'unproven', source: `${source}; ${proof.failure}` } } } };
}

/** Fixed QA-only capability observation. The caller first admits artifact,
 * current task, request and profile authority; then persists/pins these actual
 * bytes before engine admission. This is never product execution or QA PASS. */
export async function produceQaPolicyCapability({ artifactRoot, core, binding, review, intents }) {
  checkContext(core, binding, review, intents);
  // Freeze caller values across awaits; no mutable author input is adopted.
  const frozen = JSON.parse(JSON.stringify({ binding, review, intents }));
  const files = await selectedFiles(artifactRoot);
  const evaluatorLaunchId = randomUUID(), contextId = randomUUID();
  const input = { ...frozen, observations: [], canonicalEvidenceRefs: [], evaluatorLaunchId };
  const bytes = Buffer.from(JSON.stringify(input));
  assert(bytes.length <= MAX_BYTES, 'Probe stdin exceeds its bound.');
  const argv = [process.execPath, files.helper.path], env = commandEnvironment();
  const startedAt = new Date().toISOString();
  const captured = await new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { cwd: artifactRoot, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), failure = null;
    const timer = setTimeout(() => { failure = 'Probe process timed out.'; child.kill('SIGKILL'); }, TIMEOUT_MS);
    const collect = (kind, chunk) => {
      const current = kind === 'stdout' ? stdout : stderr;
      if (current.length + chunk.length > MAX_BYTES) { failure = 'Probe output exceeds its bound.'; child.kill('SIGKILL'); }
      const next = Buffer.concat([current, chunk.subarray(0, Math.max(0, MAX_BYTES - current.length))]);
      if (kind === 'stdout') stdout = next; else stderr = next;
    };
    child.stdout.on('data', (chunk) => collect('stdout', chunk));
    child.stderr.on('data', (chunk) => collect('stderr', chunk));
    child.stdin.on('error', (error) => { failure ??= error.message; });
    child.once('error', (error) => { failure = error.message; });
    child.once('close', (exitCode, signal) => { clearTimeout(timer); resolve({ processId: child.pid ?? null,
      exitCode, signal, failure, stdout, stderr, endedAt: new Date().toISOString() }); });
    child.stdin.end(bytes);
  });
  const currentFiles = await selectedFiles(artifactRoot);
  assert(same(core, currentFiles, files), 'Probe helper/runtime changed during actual observation.');
  let semantic = null, failure = captured.failure;
  let stdout, stderr;
  try { stdout = stream(captured.stdout); stderr = stream(captured.stderr); }
  catch { throw new Error('Probe raw output is not valid bounded UTF-8.'); }
  try { semantic = JSON.parse(stdout.raw); } catch { /* retain the original malformed/refusal stream */ }
  try {
    assert(Number.isSafeInteger(captured.processId) && captured.processId > 0 && captured.processId !== process.pid,
      'Probe did not observe a fresh separate PID.');
    assert(!failure && captured.exitCode === 0 && captured.signal === null && stderr.bytes === 0,
      'Probe transport did not complete successfully.');
    checkAssessment(core, semantic, input);
  } catch (error) { failure ??= error.message; }
  const proof = { schemaVersion: 1, purpose: PURPOSE, host: HOST, profileId: PROFILE,
    status: failure ? 'unavailable' : 'observed', binding: frozen.binding, bindingSha256: core.qaProofDigest(frozen.binding),
    artifactRoot, contextId, evaluatorLaunchId, helper: files.helper, runtime: files.runtime,
    argv, cwd: artifactRoot, env, parentProcessId: process.pid, processId: captured.processId,
    startedAt, endedAt: captured.endedAt, completion: !captured.failure && captured.exitCode === 0 && captured.signal === null ? 'completed' : 'unavailable',
    exitCode: captured.exitCode, signal: captured.signal, failure,
    stdin: stream(bytes), stdout, stderr, semantic, semanticSha256: core.qaProofDigest(semantic) };
  return verifyQaPolicyCapability(proof, { artifactRoot, core, ...frozen });
}

/** Revalidate the original host-pinned probe without launching a replacement.
 * This validates retained integrity, not producer authentication. The outer
 * host must independently pin this exact proof in canonical stores and must
 * not accept a caller-created/adopted probe or capability report on resume. */
export async function verifyQaPolicyCapability(proof, { artifactRoot, core, binding, review, intents }) {
  checkContext(core, binding, review, intents);
  exactFields(proof, ['schemaVersion', 'purpose', 'host', 'profileId', 'status', 'binding', 'bindingSha256',
    'artifactRoot', 'contextId', 'evaluatorLaunchId', 'helper', 'runtime', 'argv', 'cwd', 'env',
    'parentProcessId', 'processId', 'startedAt', 'endedAt', 'completion', 'exitCode', 'signal', 'failure',
    'stdin', 'stdout', 'stderr', 'semantic', 'semanticSha256']);
  assert(proof.schemaVersion === 1 && proof.purpose === PURPOSE && proof.host === HOST && proof.profileId === PROFILE &&
    ['observed', 'unavailable'].includes(proof.status), 'Unknown QA capability proof/profile.');
  assert(same(core, proof.binding, binding) && proof.bindingSha256 === core.qaProofDigest(binding), 'Probe current-task/input binding changed.');
  assert(proof.artifactRoot === artifactRoot && proof.cwd === artifactRoot &&
    uuid(proof.contextId) && uuid(proof.evaluatorLaunchId) && proof.contextId !== proof.evaluatorLaunchId,
  'Probe root/context identities differ.');
  const files = await selectedFiles(artifactRoot);
  assert(same(core, proof.helper, files.helper) && same(core, proof.runtime, files.runtime) &&
    same(core, proof.argv, [process.execPath, files.helper.path]) && same(core, proof.env, commandEnvironment()),
  'Probe current helper/runtime/invocation changed.');
  assert(Number.isSafeInteger(proof.parentProcessId) && proof.parentProcessId > 0 &&
    (proof.processId === null || Number.isSafeInteger(proof.processId) && proof.processId > 0 && proof.processId !== proof.parentProcessId),
  'Probe did not retain separate parent/child process identities.');
  const start = Date.parse(proof.startedAt), end = Date.parse(proof.endedAt);
  assert(typeof proof.startedAt === 'string' && typeof proof.endedAt === 'string' && Number.isFinite(start) && Number.isFinite(end) &&
    end >= start && end - start <= TIMEOUT_MS + 10_000, 'Probe capture timing is invalid or unbounded.');
  assert(['completed', 'unavailable'].includes(proof.completion) &&
    (proof.exitCode === null || Number.isInteger(proof.exitCode)) &&
    (proof.signal === null || typeof proof.signal === 'string' && proof.signal.length <= 128), 'Probe transport state is malformed.');
  for (const key of ['stdin', 'stdout', 'stderr']) checkStream(proof[key]);
  const input = JSON.parse(proof.stdin.raw);
  exactFields(input, ['binding', 'review', 'intents', 'observations', 'canonicalEvidenceRefs', 'evaluatorLaunchId']);
  assert(same(core, input.binding, binding) && same(core, input.review, review) && same(core, input.intents, intents) &&
    Array.isArray(input.observations) && input.observations.length === 0 &&
    Array.isArray(input.canonicalEvidenceRefs) && input.canonicalEvidenceRefs.length === 0 &&
    input.evaluatorLaunchId === proof.evaluatorLaunchId, 'Probe original stdin differs or contains product/evidence adoption.');
  assert(proof.semanticSha256 === core.qaProofDigest(proof.semantic), 'Probe semantic hash differs.');
  let parsed = null;
  try { parsed = JSON.parse(proof.stdout.raw); } catch { /* captured refusal is not replaced */ }
  assert(same(core, parsed, proof.semantic), 'Probe parsed output differs from original raw capture.');
  if (proof.status === 'observed') {
    assert(proof.failure === null && proof.completion === 'completed' && proof.exitCode === 0 && proof.signal === null &&
      Number.isSafeInteger(proof.processId) && proof.stderr.bytes === 0, 'Probe successful admission requires actual successful capture.');
    checkAssessment(core, proof.semantic, input);
  } else {
    boundedText(proof.failure, 'Probe failure');
    let unavailable = proof.completion !== 'completed' || proof.exitCode !== 0 || proof.signal !== null ||
      proof.processId === null || proof.stderr.bytes > 0;
    try { checkAssessment(core, proof.semantic, input); } catch { unavailable = true; }
    assert(unavailable, 'Valid successful probe cannot be relabeled unavailable.');
  }
  return derive(core, proof);
}
