import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { verifyPolicyArtifactPin } from './qa-product-policy-control.mjs';
import { POLICY_APPROVED_OUTCOMES, POLICY_AUTHORITY_REF, POLICY_INTENT_REVISION,
  POLICY_PROFILE_ID, policyProofDigest, sha256 } from './qa-temari-policy-semantic.mjs';

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_STREAM_BYTES = 2 * 1024 * 1024;
const EXTERNAL_ACTION = 'write-external-system';
export const EXTERNAL_ACTION_REFUSAL = 'Installed QA does not permit external writes.';

async function pinnedJson(path, expectedSha256) {
  if (!isAbsolute(path) || !/^[a-f0-9]{64}$/.test(expectedSha256))
    throw new Error('Journey inputs require absolute paths and exact SHA256 pins.');
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_INPUT_BYTES)
    throw new Error('Journey input must be a bounded regular file.');
  const raw = await readFile(path);
  if (raw.byteLength > MAX_INPUT_BYTES || sha256(raw) !== expectedSha256)
    throw new Error('Journey input differs from its selected pin.');
  JSON.parse(raw);
  return raw;
}

function overlaps(left, right) {
  const inside = (parent, child) => {
    const path = relative(parent, child);
    return path === '' || (!path.startsWith('..') && !isAbsolute(path));
  };
  return inside(left, right) || inside(right, left);
}

function exact(value, keys) {
  return value && Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

async function forbiddenFixture({ inputs, host, candidate, outputParent,
  hostManifestSha256, candidateManifestSha256 }) {
  const request = JSON.parse(inputs.find((input) => input.name === 'request').raw);
  const selection = JSON.parse(inputs.find((input) => input.name === 'selection').raw);
  const tracking = JSON.parse(inputs.find((input) => input.name === 'task-tracking').raw);
  const hostPolicyPath = join(host.root, 'policy.json');
  const stat = await lstat(hostPolicyPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024)
    throw new Error('Forbidden fixture requires a bounded host policy file.');
  const hostPolicyBytes = await readFile(hostPolicyPath);
  const policy = JSON.parse(hostPolicyBytes);
  const policyMembers = host.manifest.files.filter((item) => item.path === 'policy.json');
  if (policyMembers.length !== 1 || policyMembers[0].sha256 !== sha256(hostPolicyBytes) ||
      policyMembers[0].bytes !== hostPolicyBytes.length)
    throw new Error('Forbidden fixture host policy differs from its pinned manifest.');
  const approved = POLICY_APPROVED_OUTCOMES;
  const expectedSources = Object.entries(approved).map(([intentId, value]) => ({
    requirementRef: `temari-public-policy#${intentId}`, revision: POLICY_INTENT_REVISION,
    authorityRef: POLICY_AUTHORITY_REF, expectedOutcome: JSON.stringify(value),
  }));
  const same = (actual, expected) => policyProofDigest(actual) === policyProofDigest(expected);
  const valid = policy.qa?.owner === approved['qa-owner'].owner &&
    same(policy.qa?.allowedActions ?? null, approved['read-only-contract'].allowedActions) &&
    policy.qa?.externalWrites === 'denied' && policy.admission?.callerDeclaredCapabilitiesAreNotProof === true &&
    request.schemaVersion === 1 && request.entry === 'temari' && request.route === 'qa-review' &&
    request.profile === policy.qa.profile && request.assignment?.requestKind === 'full' &&
    request.assignment.tier === 'standard' &&
    same(request.assignment.requirementRefs, expectedSources.map((source) => source.requirementRef)) &&
    same(request.assignment.requirementRevisions, expectedSources.map((source) => source.revision)) &&
    same(request.review?.intentSources, expectedSources) &&
    same(request.assignment.authority?.allowedActions,
      [...approved['read-only-contract'].allowedActions, EXTERNAL_ACTION]) &&
    request.assignment.authority.deniedActions.includes(EXTERNAL_ACTION) &&
    exact(selection, ['schemaVersion', 'profileId', 'taskId', 'candidateManifestSha256', 'environmentRef']) &&
    selection.schemaVersion === 1 && selection.profileId === POLICY_PROFILE_ID &&
    selection.candidateManifestSha256 === candidateManifestSha256 &&
    selection.environmentRef === request.assignment.environmentRef &&
    tracking.schemaVersion === 1 && tracking.expectedVersion === 0 &&
    tracking.taskId === selection.taskId && tracking.actor === 'temari-coordinator' &&
    tracking.session?.host === 'local' && typeof tracking.session.sessionId === 'string' &&
    tracking.session.sessionId.length > 0 && tracking.create?.workspaceRoot === candidate.root &&
    same(tracking.expected, { runId: request.invocation?.runId, revision: request.invocation?.revision,
      runDirectory: request.invocation?.runDirectory, candidateRoot: candidate.root }) &&
    request.invocation.candidate?.root === candidate.root &&
    request.invocation.runDirectory === join(outputParent, 'run') &&
    request.invocation.evidenceRoot === join(outputParent, 'run/evidence') &&
    tracking.taskRoot === join(outputParent, 'tasks') &&
    request.assignment.candidateRef === request.invocation.revision &&
    request.invocation.revision === candidate.manifest.source?.revision &&
    Array.isArray(request.review.scenarios) && request.review.scenarios.length === expectedSources.length &&
    expectedSources.every((source) => request.review.scenarios.filter((scenario) =>
      same(scenario.requirementRefs, [source.requirementRef]) &&
      scenario.sourceRevision === source.revision && scenario.expectedBehavior === source.expectedOutcome &&
      scenario.obligation === 'Required' && scenario.result === 'NotRun' &&
      Array.isArray(scenario.executions) && scenario.executions.length === 0 &&
      scenario.coverageBindings?.some((coverage) => coverage.designState === 'Selected' &&
        ['Existing', 'Added', 'Updated'].includes(coverage.implementationState) &&
        coverage.kind !== 'Gap' && coverage.writeReceiptRef === null &&
        coverage.assertionSummary === `policy:${source.requirementRef.split('#')[1]}`)).length === 1);
  if (!valid) throw new Error('Forbidden-action fixture must be the valid fixed profile with only the external action added.');
  const roots = [host.root, candidate.root, request.invocation.runDirectory, tracking.taskRoot];
  for (let index = 0; index < roots.length; index++)
    if (roots.slice(index + 1).some((root) => overlaps(roots[index], root)))
      throw new Error('Forbidden-action observation roots must be disjoint.');
  return { schemaVersion: 1, addedAction: EXTERNAL_ACTION,
    validation: 'fixed-profile-matching-pinned-inputs', hostManifestSha256,
    candidateManifestSha256, hostPolicySha256: sha256(hostPolicyBytes),
    inputs: inputs.map(({ name, path, sha256: pin }) => ({ name, path, sha256: pin })),
    runDirectory: request.invocation.runDirectory, taskRoot: tracking.taskRoot };
}

function refusalProbeSpecs(fixture) {
  const run = fixture.runDirectory;
  return [['run-root', run], ['lifecycle-receipts', join(run, 'receipts')],
    ['lifecycle-checkpoints', join(run, 'checkpoints')], ['canonical-evidence', join(run, 'evidence')],
    ['workspace-manifests', join(run, 'manifests')], ['qa-config', join(run, 'config')],
    ['product-control-workspace', join(run, 'workspaces/build')],
    ['current-task-binding', join(run, 'task-binding.json')], ['local-task-store', fixture.taskRoot]];
}

async function refusalPaths(fixture) {
  return Promise.all(refusalProbeSpecs(fixture).map(async ([name, path]) => {
    try { const stat = await lstat(path); return { name, path, state: 'present',
      type: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'file' }; }
    catch (error) { return { name, path, state: error.code === 'ENOENT' ? 'absent' : 'unavailable' }; }
  }));
}

/** Pure case oracle; observations are supplied by the actual driver, not admitted proof. */
export function assessForbiddenActionRefusal({ capture, fixture, before, after, result }) {
  const rawStdout = capture.stdout.toString('utf8');
  // Retain raw bytes; strip terminal formatting only for exact diagnostic matching.
  const diagnostic = capture.stderr.toString('utf8').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const header = `AssertionError [ERR_ASSERTION]: ${EXTERNAL_ACTION_REFUSAL}`;
  const exactHeaders = diagnostic.split(/\r?\n/).filter((line) => line === header);
  const expectedPaths = refusalProbeSpecs(fixture);
  const samePaths = Array.isArray(before) && Array.isArray(after) &&
    before.length === expectedPaths.length && after.length === expectedPaths.length &&
    expectedPaths.every(([name, path], index) => before[index].name === name &&
      before[index].path === path && after[index].name === name && after[index].path === path);
  return [{ name: 'exact-external-action-admission-refusal',
    passed: fixture.validation === 'fixed-profile-matching-pinned-inputs' &&
      capture.completion === 'completed' && capture.exitCode === 1 && !capture.failure &&
      !capture.signal && exactHeaders.length === 1 && rawStdout.length === 0 && result === null,
    expectedDiagnostic: header },
  { name: 'no-selected-lifecycle-task-or-product-control-writes',
    passed: samePaths && before.every((item) => item.state === 'absent') &&
      after.every((item) => item.state === 'absent'),
    scope: 'Only the pinned case run/task roots and their listed lifecycle/control paths; collector output is separate.' }];
}

/**
 * Run one selected actual relocated-package QA case. The coordinator prepares
 * independent task/selection/request inputs and admits evidence. This driver
 * neither packages candidates, mutates policy fixtures nor invents receipts.
 * Synthetic negative unit coverage remains in qa-installed-journey.mjs.
 */
export async function runRealPolicyJourney(options) {
  const { hostArtifactRoot, hostManifestSha256, candidateArtifactRoot,
    candidateManifestSha256, requestPath, requestSha256, taskTrackingPath,
    taskTrackingSha256, selectionPath, selectionSha256, outputRoot,
    expectedDisposition = null, caseKind = 'actual-policy' } = options;
  if (!['actual-policy', 'positive', 'known-bad', 'weak', 'missing', 'unavailable', 'forbidden'].includes(caseKind))
    throw new Error('Unknown bounded journey case kind.');
  if (expectedDisposition !== null &&
      !['Passed', 'Failed', 'BlockedOrIncomplete', 'NarrowReviewOnly'].includes(expectedDisposition))
    throw new Error('Unknown expected disposition.');
  if (!isAbsolute(outputRoot)) throw new Error('Journey output root must be absolute and fresh.');
  const host = await verifyPolicyArtifactPin(hostArtifactRoot, hostManifestSha256);
  const candidate = await verifyPolicyArtifactPin(candidateArtifactRoot, candidateManifestSha256);
  if (overlaps(host.root, candidate.root)) throw new Error('Host and product artifacts must be disjoint.');
  const inputs = [];
  for (const [name, path, pin] of [
    ['request', requestPath, requestSha256],
    ['task-tracking', taskTrackingPath, taskTrackingSha256],
    ['selection', selectionPath, selectionSha256],
  ]) inputs.push({ name, path: await realpath(path), sha256: pin, raw: await pinnedJson(path, pin) });
  const outputParent = await realpath(dirname(outputRoot));
  const output = join(outputParent, outputRoot.split('/').at(-1));
  if (overlaps(output, host.root) || overlaps(output, candidate.root))
    throw new Error('Journey evidence must be disjoint from both artifacts.');
  const refusalFixture = caseKind === 'forbidden' ? await forbiddenFixture({
    inputs, host, candidate, outputParent, hostManifestSha256, candidateManifestSha256 }) : null;
  const beforeRefusalPaths = refusalFixture ? await refusalPaths(refusalFixture) : null;
  if (beforeRefusalPaths?.some((item) => item.state !== 'absent'))
    throw new Error('Forbidden-action case requires absent run/task/control stores before launch.');
  await mkdir(output, { recursive: false });
  for (const input of inputs) await writeFile(join(output, `${input.name}.input.json`), input.raw, { flag: 'wx' });
  const command = [process.execPath, host.entryPath, 'qa',
    '--request', requestPath, '--expected-request-sha256', requestSha256,
    '--expected-manifest-sha256', hostManifestSha256,
    '--qa-execution-selection', selectionPath,
    '--expected-qa-execution-selection-sha256', selectionSha256,
    '--task-tracking', taskTrackingPath,
    '--expected-task-tracking-sha256', taskTrackingSha256];
  const invocation = { command, cwd: host.root,
    inputs: inputs.map(({ name, path, sha256: pin }) => ({ name, path, sha256: pin })),
    hostManifestSha256, candidateManifestSha256 };
  const startedAt = new Date().toISOString();
  const capture = await new Promise((done) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: host.root, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
    });
    const chunks = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };
    let failure = null;
    const stop = (reason) => { failure ??= reason; child.kill('SIGKILL'); };
    const timer = setTimeout(() => stop('timeout'), 60_000);
    for (const stream of ['stdout', 'stderr']) child[stream].on('data', (chunk) => {
      const remaining = MAX_STREAM_BYTES - sizes[stream];
      if (remaining > 0) chunks[stream].push(chunk.subarray(0, remaining));
      sizes[stream] += chunk.byteLength;
      if (sizes[stream] > MAX_STREAM_BYTES) stop(`${stream}-overflow`);
    });
    child.once('error', () => { failure ??= 'spawn-unavailable'; });
    child.stdin.on('error', () => { failure ??= 'stdin-unavailable'; });
    child.stdin.end();
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      done({ processId: child.pid ?? null, exitCode, signal, failure,
        completion: failure || signal ? 'unavailable' : 'completed',
        stdout: Buffer.concat(chunks.stdout), stderr: Buffer.concat(chunks.stderr) });
    });
  });
  const endedAt = new Date().toISOString();
  await writeFile(join(output, 'stdout.log'), capture.stdout, { flag: 'wx' });
  await writeFile(join(output, 'stderr.log'), capture.stderr, { flag: 'wx' });
  let result = null;
  try { result = JSON.parse(capture.stdout.toString('utf8')); } catch { /* refusals retain raw evidence */ }
  const observedDisposition = result?.qaDisposition?.disposition ?? null;
  const afterRefusalPaths = refusalFixture ? await refusalPaths(refusalFixture) : null;
  const assertions = [];
  if (expectedDisposition !== null) assertions.push({ name: 'selected-disposition',
    passed: observedDisposition === expectedDisposition });
  if (caseKind === 'forbidden') assertions.push(...assessForbiddenActionRefusal({
    capture, fixture: refusalFixture, before: beforeRefusalPaths, after: afterRefusalPaths, result }));
  if (caseKind === 'positive') assertions.push({ name: 'actual-bound-positive',
    passed: capture.completion === 'completed' && capture.exitCode === 0 &&
      observedDisposition === 'Passed' && result?.execution?.receiptStatus === 'PASS' &&
      result?.execution?.proofValidation?.status === 'valid' &&
      result?.execution?.proofValidation?.productResult === 'passed' &&
      result?.delivery?.requestSha256 === requestSha256 &&
      result?.delivery?.evaluatorLaunch === 'admitted-independent-policy-process' });
  const evidence = { schemaVersion: 1, kind: 'actual-relocated-policy-journey', caseKind,
    limitation: 'Observed advertised Temari CLI contract and selected QA invocation only; no arbitrary-product or external-write enforcement claim.',
    invocation, invocationSha256: policyProofDigest(invocation), startedAt, endedAt,
    processId: capture.processId, completion: capture.completion, exitCode: capture.exitCode,
    signal: capture.signal, failure: capture.failure,
    stdout: { path: join(output, 'stdout.log'), sha256: sha256(capture.stdout), bytes: capture.stdout.byteLength },
    stderr: { path: join(output, 'stderr.log'), sha256: sha256(capture.stderr), bytes: capture.stderr.byteLength },
    resultSha256: result === null ? null : policyProofDigest(result), observedDisposition,
    collection: { scope: 'Actual fixed CLI command, pinned inputs, raw logs, PID and timing only.',
      isCanonicalQaReceipt: false, isBusinessTaskAcceptance: false },
    refusalObservation: refusalFixture ? { fixture: refusalFixture,
      before: beforeRefusalPaths, after: afterRefusalPaths,
      observationSha256: policyProofDigest({ before: beforeRefusalPaths, after: afterRefusalPaths }),
      limitation: 'Absence is bounded to the selected paths at these observations; this is not a global side-effect claim.' } : null,
    acceptance: { scope: caseKind === 'forbidden' ? 'Exact external-action admission refusal and selected-path absence'
      : 'Selected named journey assertions only',
      requiredAssertions: assertions.map((assertion) => assertion.name),
      status: assertions.every((assertion) => assertion.passed) ? 'assertions-passed' : 'assertions-failed',
      currentTaskRunAccepted: false, businessTaskDone: false },
    assertions, assertionsPassed: assertions.every((assertion) => assertion.passed),
    result };
  await writeFile(join(output, 'journey-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
  return evidence;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 3 || !isAbsolute(process.argv[2]))
      throw new Error('Usage: qa-real-policy-journey.mjs ABSOLUTE_SELECTED_CONFIG_JSON');
    const path = process.argv[2];
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_INPUT_BYTES)
      throw new Error('Journey configuration must be a bounded regular JSON file.');
    const evidence = await runRealPolicyJourney(JSON.parse(await readFile(path, 'utf8')));
    process.stdout.write(`${JSON.stringify({ evidenceRoot: dirname(evidence.stdout.path),
      completion: evidence.completion, exitCode: evidence.exitCode,
      observedDisposition: evidence.observedDisposition, assertionsPassed: evidence.assertionsPassed })}\n`);
    if (evidence.completion !== 'completed' || !evidence.assertionsPassed) process.exitCode = 1;
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
