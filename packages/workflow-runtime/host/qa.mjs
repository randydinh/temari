import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { exactFields, readBoundedFile, readBoundedJson } from './stdio.mjs';
import { invocationScope } from './invocation.mjs';
import { prepareTaskTracking } from './task-tracking.mjs';
import { produceQaPolicyCapability, verifyQaPolicyCapability } from './qa-capability.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const PROFILE = 'temari-public-policy-v1';
const MAX_BYTES = 256 * 1024;
const IDS = ['qa-owner', 'read-only-contract', 'capability-admission'];

async function directory(path) {
  assert(isAbsolute(path ?? '') && !/[\x00-\x1f\x7f]/.test(path), 'QA paths must be absolute.');
  const stat = await lstat(path);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), 'QA requires real directories.');
  return realpath(path);
}
function disjoint(...roots) {
  const contains = (a, b) => { const p = relative(a, b); return p === '' || (!isAbsolute(p) && p !== '..' && !p.startsWith(`..${sep}`)); };
  roots.forEach((a, i) => roots.slice(i + 1).forEach((b) => assert(!contains(a, b) && !contains(b, a), 'QA control roots must be disjoint.')));
}
async function writeJson(path, value) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  assert(bytes.length <= MAX_BYTES, 'QA retained input exceeds its bound.');
  await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
}
function portable(ref) { return Object.fromEntries(['schema', 'runId', 'revision', 'kind', 'sha256', 'bytes'].map((key) => [key, ref[key]])); }
function layout(root, stages) {
  const config = join(root, 'config');
  const workspaces = join(root, 'workspaces');
  const stores = ['receipts', 'checkpoints', 'evidence', 'manifests'].map((name) => join(root, name));
  return { config, stores, directories: [config, workspaces, ...stages.map((stage) => join(workspaces, stage)), ...stores],
    knownWriteRoots: [config, ...stores], workspaceForStage: (stage) => ({ workspaceId: stage, root: join(workspaces, stage) }) };
}
async function invokeSemantic(path, bytes, cwd) {
  const command = [process.execPath, path];
  const startedAt = new Date().toISOString();
  const runtimeSha256 = sha(await readBoundedFile(process.execPath, 256 * 1024 * 1024));
  const implementationSha256 = sha(await readBoundedFile(path, 16 * 1024 * 1024));
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: dirname(process.execPath), LANG: 'C.UTF-8', TZ: 'UTC', NODE_OPTIONS: '', NODE_PATH: '' } });
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), fault = null;
    const timer = setTimeout(() => { fault = 'Semantic process timed out.'; child.kill('SIGKILL'); }, 30_000);
    const collect = (kind, chunk) => {
      const current = kind === 'stdout' ? stdout : stderr;
      const over = current.length + chunk.length > MAX_BYTES;
      const next = Buffer.concat([current, chunk.subarray(0, Math.max(0, MAX_BYTES - current.length))]);
      if (kind === 'stdout') stdout = next; else stderr = next;
      if (over) { fault = 'Semantic output exceeded its bound.'; child.kill('SIGKILL'); }
    };
    child.stdout.on('data', (chunk) => collect('stdout', chunk));
    child.stderr.on('data', (chunk) => collect('stderr', chunk));
    child.stdin.on('error', (error) => { fault ??= error.message; });
    child.once('error', (error) => { fault = error.message; });
    child.once('close', (exitCode, signal) => { clearTimeout(timer); resolve({ command, processId: child.pid ?? null, runtimeSha256, implementationSha256,
      startedAt, endedAt: new Date().toISOString(), completion: !fault && !signal && exitCode === 0 ? 'completed' : 'unavailable',
      exitCode, rawStdout: stdout.subarray(0, MAX_BYTES).toString('utf8'), rawStderr: stderr.subarray(0, MAX_BYTES).toString('utf8'), failure: fault }); });
    child.stdin.end(bytes);
  });
}

/** A fixed local policy adapter. Other QA domains retain the unavailable path. */
export async function runAdmittedQa({ mode = 'start', artifactRoot, request, requestSha256, manifestSha256,
  policy, route, guidance, trackingSelection, executionSelection, verifyArtifact }) {
  const hostStartedAt = new Date().toISOString();
  assert(['start', 'resume', 'read-result'].includes(mode), 'Unknown QA execution mode.');
  assert(trackingSelection?.sidecarPath && executionSelection?.path, 'Executed QA requires explicit current-task and host-profile selections.');
  assert(isAbsolute(executionSelection.path) && isAbsolute(trackingSelection.sidecarPath),
    'QA selection files must be absolute.');
  artifactRoot = await directory(artifactRoot);
  const runtimeRoot = await directory(join(artifactRoot, 'runtime'));
  const candidate = { ...request.invocation.candidate, root: await directory(request.invocation.candidate.root) };
  const parent = await directory(dirname(request.invocation.runDirectory));
  const runDirectory = join(parent, basename(request.invocation.runDirectory));
  assert.equal(runDirectory, request.invocation.runDirectory, 'QA run directory must be canonical.');
  disjoint(candidate.root, artifactRoot, runDirectory);
  assert.equal(request.invocation.evidenceRoot, join(runDirectory, 'evidence'), 'Executed QA uses its canonical runtime evidence store.');
  const selectionBytes = await readBoundedFile(executionSelection.path, 32 * 1024);
  assert.equal(sha(selectionBytes), executionSelection.expectedSha256, 'QA host selection digest mismatch.');
  const selection = JSON.parse(selectionBytes.toString('utf8'));
  exactFields(selection, ['schemaVersion', 'profileId', 'taskId', 'candidateManifestSha256', 'environmentRef']);
  assert.equal(selection.schemaVersion, 1);
  assert.equal(selection.profileId, PROFILE, 'Product/semantic profile is unavailable for this QA scope.');
  assert.match(selection.candidateManifestSha256 ?? '', /^[a-f0-9]{64}$/);
  const sidecarBytes = await readBoundedFile(trackingSelection.sidecarPath, 128 * 1024);
  assert.equal(sha(sidecarBytes), trackingSelection.expectedSha256, 'QA task selection digest mismatch.');
  const sidecar = JSON.parse(sidecarBytes.toString('utf8'));
  assert.equal(sidecar.taskId, selection.taskId, 'QA task and host selection differ.');
  assert.equal(request.assignment.environmentRef, selection.environmentRef, 'QA environment differs from host selection.');
  assert(!request.assignment.missingEnvironmentBlocker, 'QA environment is unavailable.');
  assert(request.assignment.authority.allowedActions.includes('run-local-check'), 'Actual QA product checks require admitted run-local-check authority.');
  await verifyArtifact(selection.candidateManifestSha256, candidate.root);
  const require = createRequire(pathToFileURL(join(runtimeRoot, 'consumer.mjs')));
  const load = async (name) => { const entry = await realpath(require.resolve(name)); assert(relative(runtimeRoot, entry).split(sep)[0] !== '..' && entry.endsWith('.js'), 'QA runtime package escaped the artifact.'); return import(pathToFileURL(entry).href); };
  const [core, runtime, contracts] = await Promise.all([load('@temari/temari-core'), load('@temari/runtime'), load('@temari/contracts')]);
  const { runPolicyControl } = await import(pathToFileURL(join(artifactRoot, 'bin/qa-product-policy-control.mjs')).href);
  const { POLICY_APPROVED_OUTCOMES } = await import(pathToFileURL(join(artifactRoot, 'bin/qa-temari-policy-semantic.mjs')).href);
  const hostPolicyBytes = await readBoundedFile(join(artifactRoot, 'policy.json'), 64 * 1024);
  assert.equal(policy.qa.owner, POLICY_APPROVED_OUTCOMES['qa-owner'].owner);
  assert.deepEqual(policy.qa.allowedActions, POLICY_APPROVED_OUTCOMES['read-only-contract'].allowedActions);
  assert.equal(policy.qa.externalWrites, POLICY_APPROVED_OUTCOMES['read-only-contract'].externalWrites);
  assert.equal(policy.admission.callerDeclaredCapabilitiesAreNotProof, true);
  const intents = IDS.map((intentId) => ({ intentId, requirementRef: `temari-public-policy#${intentId}`, revision: 'temari-public-feature-v2', authorityRef: 'temari-public-policy-v2-approved', sourceSha256: sha(hostPolicyBytes), expectedOutcome: JSON.stringify(POLICY_APPROVED_OUTCOMES[intentId]) }));
  assert.deepEqual(request.assignment.requirementRefs, intents.map((intent) => intent.requirementRef), 'Named QA profile must include every approved outcome.');
  assert.deepEqual(request.assignment.requirementRevisions, intents.map((intent) => intent.revision));
  assert.deepEqual(request.review.intentSources, intents.map(({ intentId, sourceSha256, ...intent }) => intent), 'QA intent differs from the admitted source baseline.');
  assert(request.review.scenarios.every((scenario) => scenario.executions.length === 0 && scenario.result === 'NotRun'), 'Executed QA cannot adopt caller-supplied execution or outcome proof.');
  assert(request.review.projectVerifierId === undefined,
    'Text-only workspace verifier selection is separate from the admitted policy execution profile.');
  assert(request.review.scenarios.every((scenario) => scenario.requirementRefs.length === 1 && intents.some((intent) => intent.requirementRef === scenario.requirementRefs[0])), 'QA profile does not support this authored scenario scope.');
  const authoredDraft = { schemaVersion: 1, ...request.review,
    parentRevision: null, assignment: request.assignment };
  const admissionRecord = core.createQaReviewRecord({ ...authoredDraft,
    evaluationRounds: [], qaDisposition: 'BlockedOrIncomplete',
    dispositionBasis: 'Structural admission before product execution.',
    externalWriteReceipts: [] });
  assert.deepEqual(core.validateQaReviewRecord(admissionRecord).filter((issue) =>
    issue !== 'full reviews require an independent evaluation round or a blocked attempt.'),
    [], 'Authored QA draft is malformed.');
  const paths = layout(runDirectory, contracts.DEFAULT_STAGES);
  const descriptor = { schemaVersion: 1, runId: request.invocation.runId, revision: request.invocation.revision, candidate, runDirectory,
    plan: route.plan,
    runtimeManifestSha256: sha(await readBoundedFile(join(runtimeRoot, 'canonical-manifest.json'), 1024 * 1024)),
    qa: { profileId: PROFILE, taskId: selection.taskId, requestSha256, manifestSha256, hostSelectionSha256: sha(selectionBytes), intentSha256: core.qaProofDigest(intents) } };
  const capabilityBinding = { taskId: selection.taskId, runId: descriptor.runId, revision: descriptor.revision, requestSha256, manifestSha256,
    hostSelectionSha256: sha(selectionBytes), candidate: { ...candidate, revision: descriptor.revision, artifactManifestSha256: selection.candidateManifestSha256 },
    environmentRef: selection.environmentRef, intentSha256: core.qaProofDigest(intents), frozenReviewSha256: core.qaProofDigest(authoredDraft) };
  const capabilityPath = join(paths.config, 'qa-capability-proof.json');
  let input, tracking, capability;
  if (mode === 'start') {
    try { await lstat(runDirectory); throw new Error('QA run directory already exists.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const expectedInitial = await runtime.observeCandidate(candidate);
    // Eligibility is read-only and precedes even the fixed capability process.
    const projected = { ...descriptor, expectedInitial };
    tracking = await prepareTaskTracking({ runtime, runtimeRoot, artifactRoot, input: projected, paths, requiredSchemaVersion: 1, ...trackingSelection });
    assert(tracking, 'Current task binding is mandatory for executed QA.');
    capability = await produceQaPolicyCapability({ artifactRoot, core, binding: capabilityBinding, review: authoredDraft, intents });
    await verifyArtifact(manifestSha256, artifactRoot);
    await verifyArtifact(selection.candidateManifestSha256, candidate.root);
    assert.deepEqual(await runtime.observeCandidate(candidate), expectedInitial, 'Candidate changed during capability admission.');
    input = { ...descriptor, capabilities: capability.capabilities,
      qa: { ...descriptor.qa, capabilityProofSha256: capability.proofSha256 }, expectedInitial };
    await mkdir(runDirectory, { mode: 0o700 });
    await mkdir(paths.config, { mode: 0o700 });
    await writeJson(capabilityPath, capability.proof);
    for (const stream of ['stdin', 'stdout', 'stderr'])
      await writeFile(join(paths.config, `qa-capability-${stream}.log`), capability.proof[stream].raw, { flag: 'wx', mode: 0o600 });
    await writeJson(join(paths.config, 'input.json'), input);
    await writeJson(join(paths.config, 'qa-request.json'), request);
    assert(capability.capabilities.available.includes('subagents'), 'The fixed QA worker capability is unavailable; retained probe is not product proof. Select a new run after repair.');
    for (const path of paths.directories.filter((path) => path !== paths.config)) await mkdir(path, { mode: 0o700 });
  } else {
    await directory(runDirectory);
    input = await readBoundedJson(join(paths.config, 'input.json'), 32 * 1024);
    exactFields(input, [...Object.keys(descriptor), 'capabilities', 'expectedInitial']);
    capability = await verifyQaPolicyCapability(await readBoundedJson(capabilityPath, MAX_BYTES), { artifactRoot, core, binding: capabilityBinding, review: authoredDraft, intents });
    const { expectedInitial, capabilities, ...retained } = input;
    assert.deepEqual(retained, { ...descriptor, qa: { ...descriptor.qa, capabilityProofSha256: capability.proofSha256 } }, 'Retained QA request, plan, task, host selection or artifact changed.');
    assert.deepEqual(capabilities, capability.capabilities, 'Retained QA capabilities differ from the actual scoped probe.');
    assert(capabilities.available.includes('subagents'), 'Retained QA worker capability was unavailable.');
    for (const stream of ['stdin', 'stdout', 'stderr'])
      assert.equal((await readBoundedFile(join(paths.config, `qa-capability-${stream}.log`), MAX_BYTES)).toString('utf8'), capability.proof[stream].raw, 'Retained capability stream differs from its capture.');
    contracts.assertCandidateIdentity(expectedInitial);
    for (const path of paths.directories) assert.equal(await directory(path), path);
    assert.equal(core.qaProofDigest(await readBoundedJson(join(paths.config, 'qa-request.json'), 64 * 1024)), core.qaProofDigest(request), 'Retained QA domain input changed.');
    tracking = await prepareTaskTracking({ runtime, runtimeRoot, artifactRoot, input, paths, requiredSchemaVersion: 1, ...trackingSelection });
    assert(tracking, 'Current task binding is mandatory for executed QA.');
  }
  const [receipts, checkpoints, evidence, manifests] = await Promise.all([
    runtime.FileWorkflowReceiptStore.create(paths.stores[0]), runtime.FileWorkflowCheckpointStore.create(paths.stores[1]),
    runtime.FileEvidenceStore.create(paths.stores[2]), runtime.FileWorkspaceManifestStore.create(paths.stores[3])]);
  const retainedReceipt = await receipts.load(input.runId);
  if (mode !== 'read-result') assert.equal(retainedReceipt, null, 'Terminal QA receipt already exists; use qa-result for a canonical delivered PASS or select a new run.');
  else assert(retainedReceipt?.status === 'PASS', 'QA result recovery supports only a completed canonical PASS with delivered domain evidence. Non-deliver terminal outcomes require inspection and a new run.');
  let retainedDeliveredRecord;
  let state = { review: authoredDraft, observations: [], launches: [],
    admittedLaunchRefs: [], semanticInputRef: null,
    attempts: [], canonicalEvidenceRefs: [], proof: null,
    proofValidation: { status: 'unavailable', issues: ['Execution proof is unavailable.'], productResult: 'blocked', qaDisposition: 'BlockedOrIncomplete' } };
  const put = async (kind, content) => portable(await evidence.put({ runId: input.runId, revision: input.revision, kind, content }));
  const addRef = (ref) => { if (!state.canonicalEvidenceRefs.some((item) => core.qaProofDigest(item) === core.qaProofDigest(ref))) state.canonicalEvidenceRefs.push(ref); };
  if (mode !== 'start') {
    const checkpoint = await checkpoints.load(input.runId);
    assert(checkpoint, 'QA resume requires an original checkpoint.');
    const binding = { scopeId: invocationScope(input).scopeId, initial: input.expectedInitial };
    await runtime.verifyCandidateEvidenceRecord(checkpoint, input.runId, input.revision, evidence, false, binding);
    if (mode === 'read-result') {
      assert.deepEqual(checkpoint.stages, retainedReceipt.stages, 'Terminal receipt and checkpoint stages differ.');
      assert.deepEqual(retainedReceipt.plan, input.plan, 'Terminal QA plan differs from the admitted plan.');
      assert.deepEqual(retainedReceipt.capabilities, input.capabilities, 'Terminal QA capability report differs from the retained scoped proof.');
      await runtime.verifyCandidateCloseout({ runId: input.runId, revision: input.revision, store: receipts, evidenceStore: evidence, workspaceManifestStore: manifests, workspaceForStage: paths.workspaceForStage, scope: invocationScope(input), knownWriteRoots: paths.knownWriteRoots, expectedCurrent: await runtime.observeCandidate(candidate) });
      assert.deepEqual(await runtime.observeCandidate(candidate), input.expectedInitial, 'QA candidate changed after its completed read-only execution.');
    }
    const latest = checkpoint.stages.at(-1);
    if (mode === 'read-result') assert(latest?.stage === 'deliver' && latest.status === 'PASS', 'QA result requires canonical PASS delivery evidence.');
    if (latest) {
      const record = JSON.parse(Buffer.from(await evidence.loadPortable({ schema: 1, runId: input.runId, revision: input.revision, kind: 'other', ...latest.stageEvidence })).toString('utf8'));
      const payload = record.payloads.find((item) => item.name === 'qa-state');
      assert(payload, 'Retained QA stage lacks its canonical domain state.');
      state = JSON.parse(Buffer.from(await evidence.loadPortable(payload.reference)).toString('utf8'));
      if (mode === 'read-result') {
        const delivered = record.payloads.find((item) => item.name === 'qa-record');
        assert(delivered, 'Completed QA lacks its canonical delivered record.');
        retainedDeliveredRecord = JSON.parse(Buffer.from(await evidence.loadPortable(delivered.reference)).toString('utf8'));
        assert.deepEqual(retainedDeliveredRecord, state.finalRecord, 'Canonical delivery record and state disagree.');
      }
    }
  }
  const proofBinding = () => ({ taskId: selection.taskId, runId: input.runId, revision: input.revision, requestSha256, manifestSha256,
    hostSelectionSha256: sha(selectionBytes), candidate: { ...candidate, revision: input.revision, artifactManifestSha256: selection.candidateManifestSha256 },
    environmentRef: selection.environmentRef, intentSha256: core.qaProofDigest(intents), frozenReviewSha256: core.qaProofDigest(state.review) });
  const validate = async () => {
    try {
    await verifyArtifact(manifestSha256, artifactRoot);
    await verifyArtifact(selection.candidateManifestSha256, candidate.root);
    for (const ref of state.canonicalEvidenceRefs) await evidence.loadPortable(ref);
    const runtimeSha256 = sha(await readBoundedFile(process.execPath, 256 * 1024 * 1024));
    const admittedLaunches = [];
    for (const ref of state.admittedLaunchRefs) {
      const captured = JSON.parse(Buffer.from(await evidence.loadPortable(ref)).toString('utf8'));
      const { launch, capture } = captured;
      const helper = launch.role === 'product-control'
        ? 'qa-product-policy-control.mjs' : 'qa-temari-policy-semantic.mjs';
      assert.equal(launch.implementationSha256,
        sha(await readBoundedFile(join(artifactRoot, 'bin', helper), 16 * 1024 * 1024)),
        'Retained QA launch implementation differs from selected host artifact.');
      assert.equal(launch.runtimeSha256, runtimeSha256, 'QA launch runtime changed.');
      assert.equal(launch.artifactManifestSha256, selection.candidateManifestSha256);
      const rawStdout = Buffer.from(await evidence.loadPortable(launch.stdoutRef));
      const rawStderr = Buffer.from(await evidence.loadPortable(launch.stderrRef));
      assert.equal(rawStdout.toString('utf8'), capture.rawStdout);
      assert.equal(rawStderr.toString('utf8'), capture.rawStderr);
      assert.equal(launch.processId, capture.processId);
      assert.equal(launch.startedAt, capture.startedAt);
      assert.equal(launch.endedAt, capture.endedAt);
      assert.equal(launch.exitCode, capture.exitCode);
      assert.equal(launch.completion, capture.completion);
      if (launch.role === 'product-control') {
        assert.deepEqual(capture.command, [process.execPath, join(candidate.root, 'bin/temari.mjs'), 'policy']);
        assert.equal(capture.cwd, candidate.root);
        assert.equal(launch.invocationSha256, core.qaProofDigest({ command: capture.command, cwd: capture.cwd, inputSha256: sha(Buffer.alloc(0)) }));
        assert.equal(launch.inputSha256, sha(Buffer.alloc(0)));
        if (launch.completion === 'completed' && launch.exitCode === 0)
          assert.equal(launch.outputSha256, core.qaProofDigest(JSON.parse(rawStdout)));
        assert.equal(capture.stdoutSha256, sha(rawStdout));
        assert.equal(capture.stderrSha256, sha(rawStderr));
      } else {
        assert.deepEqual(capture.command, [process.execPath, join(artifactRoot, 'bin/qa-temari-policy-semantic.mjs')]);
        assert.equal(launch.invocationSha256, core.qaProofDigest(capture.command));
        if (launch.completion === 'completed' && launch.exitCode === 0 && state.proof)
          assert.equal(launch.outputSha256, core.qaProofDigest(JSON.parse(rawStdout)));
      }
      admittedLaunches.push({ launchId: launch.launchId, launchSha256: core.qaProofDigest(launch) });
    }
    const inputBytes = state.semanticInputRef
      ? Buffer.from(await evidence.loadPortable(state.semanticInputRef)) : null;
    if (inputBytes) {
      assert.equal(sha(inputBytes), state.semanticInputSha256);
      const sent = JSON.parse(inputBytes);
      assert.deepEqual(sent.binding, proofBinding());
      assert.deepEqual(sent.review, state.review);
      assert.deepEqual(sent.intents, intents);
      assert.deepEqual(sent.observations, state.observations);
      const evaluator = state.launches.find((launch) => launch.role === 'semantic-evaluator');
      assert.equal(evaluator?.inputSha256, sha(inputBytes));
      assert.equal(sent.evaluatorLaunchId, evaluator?.launchId);
    }
    state.proofValidation = core.validateQaExecutionProof(state.proof, {
      binding: proofBinding(), review: state.review, intents,
      canonicalEvidenceRefs: state.canonicalEvidenceRefs, admittedLaunches,
      semanticInputSha256: inputBytes ? sha(inputBytes) : state.semanticInputSha256,
    });
    return state.proofValidation;
    } catch (error) {
      state.proofValidation = { status: 'invalid',
        issues: [`QA captured proof could not be revalidated: ${error.message.slice(0, 1024)}`],
        productResult: 'blocked', qaDisposition: 'BlockedOrIncomplete' };
      return state.proofValidation;
    }
  };
  const makeRecord = (disposition, validation) => {
    const semanticLaunch = state.launches.find((launch) => launch.role === 'semantic-evaluator');
  const admittedAssessment = semanticLaunch &&
    semanticLaunch.completion === 'completed' && semanticLaunch.exitCode === 0 &&
    Number.isSafeInteger(semanticLaunch.processId) && state.proof &&
    validation.status === 'valid';
  const record = core.createQaReviewRecord({ ...state.review,
    evaluationRounds: admittedAssessment ? [{ round: 1, evaluatorId: semanticLaunch.actorId, freshContextAttestation: `Actual separately launched policy semantic process ${semanticLaunch.processId}; frozen input ${state.semanticInputSha256}.`,
      verdict: validation.status === 'valid' && validation.productResult !== 'blocked' ? 'PASS' : validation.status === 'valid' ? 'REVISE' : 'BLOCKED', findingIds: state.proof?.semantic.findings.map((finding) => finding.findingId) ?? [], evidenceRefs: [semanticLaunch.stdoutRef, semanticLaunch.stderrRef] }] : [],
    ...(admittedAssessment ? {} : { evaluationAttempts: [{
      status: 'BLOCKED', reason: semanticLaunch ? 'separate-evaluator-unavailable' : 'environment-unavailable',
      host: 'local-qa-policy-host', tool: PROFILE,
      invocationId: semanticLaunch?.launchId ?? state.launches[0]?.launchId ?? input.runId,
      startedAt: semanticLaunch?.startedAt ?? state.controlCapture?.startedAt ?? hostStartedAt,
      endedAt: semanticLaunch?.endedAt ?? state.controlCapture?.endedAt ?? new Date().toISOString(),
      inputSha256: state.semanticInputSha256 ?? core.qaProofDigest(state.review),
      allowedInputSha256: state.semanticInputSha256 ?? core.qaProofDigest(state.review),
      outputSha256: null, findings: [],
    }] }),
    qaDisposition: disposition, dispositionBasis: `Named ${PROFILE} scope: ${validation.status}; product ${validation.productResult}.`, externalWriteReceipts: [] });
    core.assertQaReviewRecord(record);
    return { record, semanticLaunch, admittedAssessment };
  };
  if (mode !== 'read-result') await tracking.reserve({ exclusive: mode === 'start' });
  let trackingFailure;
  const store = { load: (id) => receipts.load(id), save: (receipt) => { if (trackingFailure) throw trackingFailure; return receipts.save(receipt); } };
  let receipt = retainedReceipt;
  try {
    if (mode !== 'read-result') receipt = await runtime.executeAndPersist({ runId: input.runId, revision: input.revision, plan: input.plan, capabilities: input.capabilities,
      store, checkpointStore: { load: (id) => checkpoints.load(id),
        save: (checkpoint) => { if (trackingFailure) throw trackingFailure; return checkpoints.save(checkpoint); } },
      stageEvidence: { store: evidence }, workspaceManifestStore: manifests,
      workspaceForStage: paths.workspaceForStage, candidate: { scope: invocationScope(input), expectedInitial: input.expectedInitial, knownWriteRoots: paths.knownWriteRoots },
      handler: async (stage) => {
        try { await tracking.start(); } catch (error) { trackingFailure = error; throw error; }
        const before = await runtime.observeCandidate(candidate);
        assert.deepEqual(before, input.expectedInitial, 'QA candidate changed before its stage.');
        let status = 'PASS', summary;
        if (stage === 'investigate') summary = 'Admitted exact task, source policy intent and immutable product artifact.';
        else if (stage === 'plan') summary = 'Frozen required outcomes, authored scenarios, scope exclusions and read-only actions.';
        else if (stage === 'build') {
          const capture = await runPolicyControl({ candidateRoot: candidate.root, expectedManifestSha256: selection.candidateManifestSha256 });
          const stdoutRef = await put('stdout', capture.rawStdout), stderrRef = await put('stderr', capture.rawStderr);
          addRef(stdoutRef); addRef(stderrRef);
          const launchId = randomUUID();
          const launch = { launchId, role: 'product-control', profileId: PROFILE, implementationSha256: capture.implementationSha256,
            runtimeSha256: capture.runtimeSha256, artifactManifestSha256: selection.candidateManifestSha256, actorId: 'local-policy-product-control', contextId: randomUUID(),
            processId: capture.processId, invocationSha256: capture.invocationSha256, inputSha256: capture.inputSha256, outputSha256: core.qaProofDigest(capture.output),
            startedAt: capture.startedAt, endedAt: capture.endedAt, completion: capture.completion, exitCode: capture.exitCode, stdoutRef, stderrRef };
          state.launches = [launch];
          const launchRef = await put('verification', JSON.stringify({ launch, capture }));
          state.admittedLaunchRefs = [launchRef]; addRef(launchRef);
          state.controlCapture = capture;
          state.review.scenarios = state.review.scenarios.map((scenario, index) => {
            const intent = intents.find((item) => item.requirementRef === scenario.requirementRefs[0]);
            const expected = POLICY_APPROVED_OUTCOMES[intent.intentId];
            const observed = capture.output?.qaContract;
            const supported = capture.completion === 'completed' && capture.exitCode === 0 && observed;
            const passed = supported && Object.entries(expected).every(([key, value]) => core.qaProofDigest(observed[key] ?? null) === core.qaProofDigest(value));
            const execution = { attemptId: `${input.runId}-attempt-${index + 1}`, candidateRef: input.revision, environmentRef: selection.environmentRef, fixtureRefs: [],
              correlationRef: launchId, boundedObservation: `Temari CLI control attempt: process ${capture.processId ?? 'unavailable'}, completion ${capture.completion}, exit ${capture.exitCode}.`,
              assertions: scenario.coverageBindings.map((item) => item.assertionSummary).filter((item) => typeof item === 'string'),
              observations: [capture.rawStdout.slice(0, 8192)], evidenceRefs: [stdoutRef, stderrRef], state: supported ? 'Executed' : 'Blocked' };
            state.observations.push({ scenarioId: scenario.scenarioId, attemptId: execution.attemptId, launchId, rawStdout: capture.rawStdout, rawStderr: capture.rawStderr,
              exitCode: capture.exitCode, completion: capture.completion, stdoutRef, stderrRef });
            state.attempts.push({ scenarioId: scenario.scenarioId, attemptId: execution.attemptId, executionSha256: core.qaProofDigest(execution), launchId: supported ? launchId : null });
            return { ...scenario, executions: [execution], result: supported ? passed ? 'Passed' : 'Failed' : 'BlockedOrIncomplete', nextAction: passed ? 'none' : 'Inspect the observed contract against approved intent.' };
          });
          if (capture.completion !== 'completed' || capture.exitCode !== 0 || !capture.output) status = 'BLOCKED';
          summary = 'Captured actual fixed CLI product command, raw logs and candidate-bound attempts.';
        } else if (stage === 'review') {
          const binding = proofBinding(), evaluatorLaunchId = randomUUID();
          const semanticInput = { binding, intents, review: state.review, observations: state.observations, canonicalEvidenceRefs: state.canonicalEvidenceRefs, evaluatorLaunchId };
          const bytes = Buffer.from(JSON.stringify(semanticInput));
          state.semanticInputSha256 = sha(bytes);
          state.semanticInputRef = await put('other', bytes);
          addRef(state.semanticInputRef);
          const capture = await invokeSemantic(join(artifactRoot, 'bin/qa-temari-policy-semantic.mjs'), bytes, paths.workspaceForStage(stage).root);
          const stdoutRef = await put('stdout', capture.rawStdout), stderrRef = await put('stderr', capture.rawStderr);
          addRef(stdoutRef); addRef(stderrRef);
          let semantic = null;
          try { semantic = JSON.parse(capture.rawStdout); } catch { /* unavailable, never invent a semantic assessment */ }
          const launch = { launchId: evaluatorLaunchId, role: 'semantic-evaluator', profileId: PROFILE, implementationSha256: capture.implementationSha256,
            runtimeSha256: capture.runtimeSha256, artifactManifestSha256: selection.candidateManifestSha256, actorId: 'independent-policy-semantic-evaluator', contextId: randomUUID(),
            processId: capture.processId, invocationSha256: core.qaProofDigest(capture.command), inputSha256: sha(bytes), outputSha256: core.qaProofDigest(semantic),
            startedAt: capture.startedAt, endedAt: capture.endedAt, completion: capture.completion, exitCode: capture.exitCode, stdoutRef, stderrRef };
          state.launches.push(launch); state.semanticCapture = capture;
          const launchRef = await put('verification', JSON.stringify({ launch, capture }));
          state.admittedLaunchRefs.push(launchRef); addRef(launchRef);
          state.proof = semantic ? { schemaVersion: 1, binding, launches: state.launches, attempts: state.attempts, semantic } : null;
          if ((await validate()).status !== 'valid') status = 'BLOCKED';
          summary = status === 'PASS'
            ? 'Separately launched evaluator assessed all approved outcomes and actual observations.'
            : 'Independent semantic assessment was unavailable or failed proof validation; retained the actual attempt.';
        } else if (stage === 'verify') {
          if ((await validate()).status !== 'valid') status = 'BLOCKED';
          summary = 'Reverified canonical raw evidence, complete proof joins and honest QA disposition.';
        } else {
          const validation = await validate();
          assert.equal(validation.status, 'valid', 'Delivery requires valid actual QA execution proof.');
          const { record } = makeRecord(validation.qaDisposition, validation);
          state.finalRecord = record; state.finalRecordSha256 = core.qaProofDigest(record);
          summary = 'Canonical QA record and proof retained before terminal receipt; task acceptance remains separate.';
        }
        assert.deepEqual(await runtime.observeCandidate(candidate), before, 'QA stages cannot mutate the candidate, including build.');
        return { status, summary, evidence: [{ name: 'qa-state', kind: 'other', content: JSON.stringify(state) },
          ...(stage === 'deliver' ? [{ name: 'qa-record', kind: 'other', content: JSON.stringify(state.finalRecord) }] : [])] };
      } });
  } catch (error) { if (tracking.started && !trackingFailure) await tracking.finish(await receipts.load(input.runId), error); throw error; }
  const validation = state.proof ? await validate() : state.proofValidation;
  const disposition = receipt.status === 'PASS' ? validation.qaDisposition : 'BlockedOrIncomplete';
  const { record, semanticLaunch, admittedAssessment } = makeRecord(disposition, validation);
  if (receipt.status === 'PASS') {
    assert.deepEqual(state.finalRecord, record, 'Canonical delivered QA record differs from its verified proof.');
    assert.equal(state.finalRecordSha256, core.qaProofDigest(record));
    if (mode === 'read-result') assert.deepEqual(retainedDeliveredRecord, record);
  }
  const result = { schemaVersion: 1, route: route.route, plan: route.plan, guidance,
    execution: { profileId: PROFILE, receiptStatus: receipt.status, proofValidation: validation, proof: state.proof, launches: state.launches },
    qaDisposition: { disposition, productResult: validation.productResult, scope: 'named-temari-policy-contract-only' }, record,
    delivery: { mode: 'local', externalWrites: 'denied', requestSha256,
      evaluatorLaunch: admittedAssessment ? 'admitted-independent-policy-process'
        : semanticLaunch ? 'independent-process-unavailable' : 'not-launched',
      receiptPath: join(paths.stores[0], `${input.runId}.receipt.json`) } };
  const resultPath = join(paths.config, 'qa-result.json');
  try {
    await writeJson(resultPath, result);
  } catch (error) {
    if (error.code === 'EEXIST' && mode === 'read-result') {
      assert.deepEqual(await readBoundedJson(resultPath, MAX_BYTES), result, 'Existing QA result differs from canonical delivered evidence.');
    } else {
      if (tracking.started) await tracking.finish(receipt, error, {
        summary: `QA run ${input.runId} retained its canonical ${receipt.status} receipt but local domain result publication failed. No task acceptance is asserted.`,
        nextAction: receipt.status === 'PASS' ? 'Use qa-result with the same pinned request/artifact/profile and a fresh task tracking key/current version to verify and materialize canonical delivered evidence.' : 'Inspect the non-deliver terminal evidence and select a new run; qa-result does not reconstruct unsupported terminal outcomes.',
        blocker: 'Local QA result publication is incomplete.', contextRefs: [],
      });
      throw new Error(`QA result publication failed after canonical receipt; use guarded qa-result only for delivered PASS: ${error.message}`, { cause: error });
    }
  }
  const resultSha256 = sha(await readBoundedFile(resultPath, MAX_BYTES));
  await tracking.finish(receipt, undefined, {
    summary: `QA run ${input.runId} returned ${disposition} for ${PROFILE}; mechanical receipt ${receipt.status}. The task remains unaccepted.`,
    nextAction: disposition === 'Passed'
      ? 'Independently review this named QA scope and its exact record/proof/receipt. Apply trusted candidate closeout and existing task-run controls before acceptance.'
      : 'Keep the QA obligation open. Review the retained failure or missing proof, repair through Poteto if appropriate, and recheck a new candidate/run.',
    blocker: disposition === 'Passed' ? null : `QA disposition ${disposition} requires attention even if the mechanical receipt passed.`,
    contextRefs: [{ kind: 'qa-record-and-execution-proof', location: resultPath, sha256: resultSha256 }],
  });
  return { result, code: receipt.status === 'PASS' && disposition === 'Passed' ? 0 : 1 };
}
