import assert from 'node:assert/strict';
import { createManagedArchonSupervisor } from '../../../libs/archon-harness/src/lib/managed-supervision.ts';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  lstat,
  realpath,
  access,
} from 'node:fs/promises';
import { isAbsolute, join, relative, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_STAGES,
  HOST_CAPABILITIES,
} from '../../../libs/contracts/src/index.ts';
import {
  REVIEWED_LOCAL_CANDIDATE_POLICY,
  createReviewedLocalCandidatePlan,
} from '../../../libs/temari-core/src/index.ts';
import {
  createOwnedExecutionAdapter,
  observeCodexProvider,
  observeCodexModelSelection,
} from '../../../libs/host-adapters/src/index.ts';
import {
  ManagedExecutionControl,
  createManagedTaskSupervisor,
  FileTaskStore,
  FileChildTaskStore,
  FileParallelWorkerReceiptStore,
  FileEvidenceStore,
  FileWorkflowReceiptStore,
  executeRestartableParallelWorkers,
  executeAndPersist,
  verifyPersistedStageEvidence,
} from '../../../libs/runtime/src/index.ts';
import {
  runCodexWorkersRequest,
  parseCodexWorkersRequest,
} from '../../../tools/run-codex-workers.mts';
import {
  runCodexWriteWorkersRequest,
  parseWriteRunRequest,
  assertWriteCandidate,
} from '../../../tools/run-codex-write-workers.mts';

export const digest = (bytes) =>
  createHash('sha256').update(bytes).digest('hex');
export const objectDigest = (value) => digest(canonical(value));
/** The executing bridge is the subprocess runtime authority. Bun only changes
 * argv; PATH never selects another runtime. Call after runtime admission. */
export function managedOperationCommand(
  tool,
  requestPath,
  resultPath,
  isBun = Boolean(process.versions.bun),
) {
  assert(
    isAbsolute(process.execPath),
    'Bridge process runtime must be absolute.',
  );
  return {
    program: process.execPath,
    args: isBun
      ? [tool, requestPath, resultPath]
      : [
          '--import',
          '@swc-node/register/esm-register',
          tool,
          requestPath,
          resultPath,
        ],
  };
}
export async function assertManagedBridgeRuntime(spec) {
  const runtime = spec.bridgeRuntime;
  assert(
    runtime && typeof runtime === 'object',
    'Pinned bridge runtime required.',
  );
  assert(isAbsolute(runtime.executable));
  assert.match(runtime.sha256, /^[a-f0-9]{64}$/);
  assert.equal(
    await realpath(runtime.executable),
    runtime.executable,
    'Bridge runtime alias refused.',
  );
  assert(
    !inside(spec.repositoryRoot, runtime.executable),
    'Bridge runtime must be protected outside candidate.',
  );
  assert(
    spec.protectedInputs.some(
      (ref) => ref.path === runtime.executable && ref.sha256 === runtime.sha256,
    ),
    'Bridge runtime protected input changed.',
  );
  assert(
    isAbsolute(process.execPath),
    'Bridge process runtime must be absolute.',
  );
  assert.equal(
    await realpath(process.execPath),
    process.execPath,
    'Bridge process runtime alias refused.',
  );
  assert.equal(
    process.execPath,
    runtime.executable,
    'Executing bridge runtime differs from the pinned request.',
  );
  assert.equal(
    digest(await readFile(process.execPath)),
    runtime.sha256,
    'Executing bridge runtime digest changed.',
  );
}
// Numeric milliseconds, matched to the pinned native YAML by source regression.
export const NATIVE_STAGE_TIMEOUTS_MS = Object.freeze({
  investigate: 1800000,
  plan: 180000,
  build: 1800000,
  review: 1080000,
  verify: 900000,
  deliver: 180000,
  finalize: 300000,
});
export function nativeStageBudgetCoverage(spec) {
  const sum = (commands) =>
    commands.reduce((total, command) => total + command.timeoutMs, 0);
  const requiredMs = {
    investigate: sum(spec.baselineChecks) + spec.timeoutMs + 180000,
    plan: 180000,
    build: spec.timeoutMs + 900000,
    review: spec.timeoutMs + 180000,
    verify: sum(spec.acceptanceChecks) + 180000,
    deliver: 180000,
    finalize: 300000,
  };
  for (const [stage, required] of Object.entries(requiredMs))
    assert(
      Number.isSafeInteger(required) &&
        required > 0 &&
        required <= NATIVE_STAGE_TIMEOUTS_MS[stage],
      `${stage} native timeout does not cover composed work.`,
    );
  return { nativeTimeoutsMs: NATIVE_STAGE_TIMEOUTS_MS, requiredMs };
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function inside(root, path) {
  const r = relative(root, path);
  return !r || (!r.startsWith(`..${sep}`) && r !== '..' && !isAbsolute(r));
}
function id(value) {
  assert(
    typeof value === 'string' &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(value),
    'Invalid managed identity.',
  );
}
async function json(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}
async function sealed(path, value) {
  try {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    assert.deepEqual(
      await json(path),
      value,
      'Immutable managed record changed.',
    );
  }
}
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 1024 * 1024,
  }).trim();
}
function pinned(root, commit) {
  assert.equal(
    git(root, 'rev-parse', 'HEAD'),
    commit,
    'Candidate revision drifted.',
  );
  assert.equal(
    git(root, 'status', '--porcelain=v1', '--untracked-files=all'),
    '',
    'Candidate is dirty.',
  );
}
async function files(root, checkOutputs = false) {
  const result = [];
  for (const item of await readdir(root, { withFileTypes: true })) {
    const path = join(root, item.name);
    if (item.isDirectory()) {
      if (
        item.name === '.git' ||
        (checkOutputs && /(?:-derived|-ui|-legacy|unit-copy)$/.test(item.name))
      )
        continue;
      result.push(...(await files(path, checkOutputs)));
    } else {
      assert(item.isFile(), 'Managed evidence cannot contain symlinks.');
      const bytes = await readFile(path);
      result.push({ path, sha256: digest(bytes), bytes: bytes.length });
    }
  }
  return result;
}
async function checkRefs(refs) {
  assert(Array.isArray(refs) && refs.length > 0, 'Evidence refs missing.');
  for (const ref of refs) {
    assert(isAbsolute(ref.path));
    assert(
      (await lstat(ref.path)).isFile(),
      'Evidence must be a regular file.',
    );
    const bytes = await readFile(ref.path);
    assert.equal(digest(bytes), ref.sha256, `Evidence drift: ${ref.path}`);
    if (ref.bytes !== undefined) assert.equal(bytes.length, ref.bytes);
  }
}
async function checkProtectedInputs(spec) {
  await assertManagedBridgeRuntime(spec);
  const configRef = spec.protectedInputs.find(
    (ref) => ref.path === spec.modelAdmission.configPath,
  );
  assert(configRef, 'Initial model configuration reference missing.');
  assert.equal(
    configRef.sha256,
    spec.modelAdmission.configSha256,
    'Initial model configuration digest binding changed.',
  );
  await checkRefs(
    spec.protectedInputs.filter(
      (ref) => ref.path !== spec.modelAdmission.configPath,
    ),
  );
}
async function observeManagedModelSelection(spec) {
  const observed = await observeCodexModelSelection(
    spec.providerSelection,
    spec.modelAdmission,
    spec.repositoryRoot,
  );
  const root = join(spec.evidenceRoot, spec.runId);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, 'model-admission-baseline.json');
  const baseline = {
    schema: 1,
    kind: 'codex-model-admission-baseline',
    configSha256: spec.modelAdmission.configSha256,
    critical: observed.config.critical,
    selection: spec.providerSelection,
  };
  if (observed.config.currentSha256 === spec.modelAdmission.configSha256) {
    await sealed(path, baseline);
  } else {
    assert(
      await exists(path),
      'Initial model configuration digest was not proven before raw drift.',
    );
    assert.deepEqual(
      await json(path),
      baseline,
      'Immutable model-admission baseline changed.',
    );
  }
  assert(
    (await lstat(path)).isFile(),
    'Model-admission baseline must be a regular file.',
  );
  const bytes = await readFile(path);
  assert.deepEqual(
    JSON.parse(bytes),
    baseline,
    'Immutable model-admission baseline changed.',
  );
  return {
    ...observed,
    baseline: { path, sha256: digest(bytes) },
  };
}
function capabilities(source, observedAt) {
  return {
    host: 'managed-local-codex',
    available: ['subagents'],
    missing: HOST_CAPABILITIES.filter((x) => x !== 'subagents'),
    notes: { subagents: source },
    provenance: { subagents: { status: 'proven', source, observedAt } },
  };
}

/** Source-only admission. Digest arguments are supplied independently of the request. */
export async function admitReviewedLocalCandidate({
  specPath,
  expectedSha256,
}) {
  assert(isAbsolute(specPath));
  assert.match(expectedSha256, /^[0-9a-f]{64}$/);
  const bytes = await readFile(specPath);
  assert(bytes.length <= 256 * 1024, 'Managed request too large.');
  assert.equal(
    digest(bytes),
    expectedSha256,
    'Managed request digest changed.',
  );
  const spec = JSON.parse(bytes);
  assert.equal(spec.schema, 1);
  assert.equal(spec.profile, 'reviewed-local-candidate-v1');
  id(spec.runId);
  id(spec.taskId);
  assert.deepEqual(
    spec.plan,
    createReviewedLocalCandidatePlan(),
    'Managed plan/policy mismatch.',
  );
  assert.equal(
    spec.policySha256,
    objectDigest(REVIEWED_LOCAL_CANDIDATE_POLICY),
    'Managed policy changed.',
  );
  assert.match(spec.baseCommit, /^[0-9a-f]{40}$/);
  for (const key of ['repositoryRoot', 'evidenceRoot', 'taskStoreRoot']) {
    assert(isAbsolute(spec[key]));
    assert.equal(
      await realpath(spec[key]),
      spec[key],
      'Managed roots must be canonical existing directories.',
    );
  }
  assert(
    !inside(spec.repositoryRoot, spec.evidenceRoot) &&
      !inside(spec.evidenceRoot, spec.repositoryRoot),
    'Candidate/evidence roots overlap.',
  );
  assert(
    !inside(spec.repositoryRoot, specPath),
    'Request must be protected outside candidate.',
  );
  assert(
    spec.timeoutMs >= 1000 &&
      spec.timeoutMs <= 900000 &&
      Number.isSafeInteger(spec.timeoutMs),
    'Managed timeout exceeds bound.',
  );
  assert.equal(spec.workers.architect.role, 'investigator');
  assert.equal(spec.workers.builder.role, 'implementer');
  assert.equal(spec.workers.reviewer.role, 'reviewer');
  const assignments = Object.values(spec.workers);
  assert.equal(
    new Set(assignments.map((a) => a.id)).size,
    3,
    'Worker identities must be distinct.',
  );
  assert(
    assignments.every((a) => a.required === true),
    'Every worker is required.',
  );
  assert(
    Array.isArray(spec.acceptance) &&
      spec.acceptance.length > 0 &&
      spec.acceptance.every((x) => typeof x === 'string' && x.trim()),
    'Frozen acceptance required.',
  );
  const common = {
    runId: spec.runId,
    revision: spec.baseCommit,
    workspaceRoot: spec.repositoryRoot,
    sourceRepo: spec.repositoryRoot,
    baseCommit: spec.baseCommit,
    evidenceRoot: spec.evidenceRoot,
    maxConcurrency: 1,
    executable: spec.executable,
    timeoutMs: spec.timeoutMs,
    providerSelection: spec.providerSelection,
  };
  parseCodexWorkersRequest({
    ...common,
    assignments: [spec.workers.architect],
  });
  parseCodexWorkersRequest({ ...common, assignments: [spec.workers.reviewer] });
  parseWriteRunRequest({
    ...common,
    assignments: [{ worker: spec.workers.builder, owns: spec.owns }],
    verify: [{ program: 'git', args: ['diff', '--check'] }],
  });
  await checkProtectedInputs(spec);
  for (const ref of spec.protectedInputs)
    assert(
      !inside(spec.repositoryRoot, await realpath(ref.path)),
      'Protected input is inside builder candidate.',
    );
  assert(
    spec.baselineChecks.length > 0 && spec.acceptanceChecks.length > 0,
    'Protected baseline and acceptance checks required.',
  );
  for (const command of [...spec.baselineChecks, ...spec.acceptanceChecks]) {
    assert(
      isAbsolute(command.program) &&
        spec.protectedInputs.some((x) => x.path === command.program),
      'Check executable must be protected.',
    );
    assert(
      Array.isArray(command.args) &&
        command.args.every((x) => typeof x === 'string' && !x.includes('\0')),
    );
    assert(
      Number.isSafeInteger(command.timeoutMs) &&
        command.timeoutMs > 0 &&
        command.timeoutMs <= 600000,
      'Check bound invalid.',
    );
  }
  const nativeBudgetCoverage = nativeStageBudgetCoverage(spec);
  pinned(spec.repositoryRoot, spec.baseCommit);
  const modelSelection = await observeManagedModelSelection(spec);
  const provider = await observeCodexProvider(
    spec.executable,
    spec.providerSelection,
  );
  // Establish CLI transport/sandbox/auth support before native dispatch; this is
  // admission evidence, not a claim that planning/build/review have run.
  const help = execFileSync(provider.executable, ['exec', '--help'], {
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 65536,
  });
  for (const flag of [
    '--sandbox',
    '--output-schema',
    '--json',
    '--ignore-user-config',
    '--model',
    '--config',
  ])
    assert(help.includes(flag), 'Missing Codex execution capability.');
  const auth = execFileSync(provider.executable, ['login', 'status'], {
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 65536,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert(
    auth.includes('Logged in') || auth === '',
    'Codex authentication unavailable.',
  );
  return {
    spec,
    provider,
    modelSelection,
    nativeBudgetCoverage,
    requestSha256: expectedSha256,
    policySha256: spec.policySha256,
    planSha256: objectDigest(spec.plan),
  };
}
function binding(admitted, nativeRunId) {
  return {
    runId: admitted.spec.runId,
    nativeRunId,
    requestSha256: admitted.requestSha256,
    policySha256: admitted.policySha256,
    planSha256: admitted.planSha256,
    baseCommit: admitted.spec.baseCommit,
  };
}
async function loadStage(admitted, artifacts, nativeRunId, stage) {
  const record = await json(join(artifacts, `${stage}.json`));
  assert.equal(record.sha256, objectDigest(record.body), 'Stage record drift.');
  assert.deepEqual(
    record.body.binding,
    binding(admitted, nativeRunId),
    'Native/request/policy binding drift.',
  );
  assert.equal(record.body.stage, stage);
  assert.equal(record.body.status, 'PASS');
  await checkRefs(record.body.refs);
  return record.body;
}
async function integration(admitted, artifacts, nativeRunId) {
  const build = await loadStage(admitted, artifacts, nativeRunId, 'build');
  const { integrationPath, integratedCommit } = build.result;
  assert(
    isAbsolute(integrationPath) &&
      inside(admitted.spec.evidenceRoot, integrationPath),
  );
  assert.match(integratedCommit, /^[0-9a-f]{40}$/);
  pinned(integrationPath, integratedCommit);
  return { root: integrationPath, commit: integratedCommit };
}
async function fixedCheck(command, candidate, evidence, control, taskId) {
  const args = command.args.map((x) =>
    x.replaceAll('{candidate}', candidate).replaceAll('{evidence}', evidence),
  );
  const startedAt = new Date().toISOString();
  let result;
  try {
    result = await control.run(taskId, {
      program: command.program,
      args,
      cwd: candidate,
      timeoutMs: command.timeoutMs,
    });
  } catch (error) {
    if (error.outcome) result = error.outcome;
    else
      throw new Error(
        `Protected check failed; later stages blocked: ${error.message}`,
        { cause: error },
      );
  }
  return {
    program: command.program,
    args,
    pid: result.witness.anchorPid,
    startedAt,
    endedAt: new Date().toISOString(),
    code: result.code,
    signal: result.signal,
    timedOut: result.reason === 'timeout',
    cancelled: result.reason === 'cancelled',
    outputLimitExceeded: result.reason === 'output-limit',
    cleanup: result.cleanup,
    ownership: result.identity,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
async function runChecks(
  admitted,
  commands,
  candidate,
  stage,
  signal,
  control,
) {
  const root = join(
    admitted.spec.evidenceRoot,
    admitted.spec.runId,
    `checks-${stage}`,
  );
  await mkdir(root, { recursive: true });
  const results = [];
  for (let i = 0; i < commands.length; i++) {
    await checkProtectedInputs(admitted.spec);
    const path = join(root, `${i}.json`);
    assert(
      !(await exists(path)),
      'Check outcome exists without stage capture; reconcile before continuing.',
    );
    const result = await fixedCheck(
      commands[i],
      candidate,
      root,
      control,
      `${control.options.authorityId}-check-${i}`,
    );
    await sealed(path, result);
    results.push(result);
    assert(
      result.code === 0 &&
        !result.timedOut &&
        !result.cancelled &&
        !result.outputLimitExceeded,
      'Protected check failed; later stages blocked.',
    );
  }
  return { results, refs: await files(root, true) };
}
function workerAssignment(spec, stage, candidate, architectReceipt) {
  if (stage === 'investigate') return spec.workers.architect;
  if (stage === 'build')
    return {
      ...spec.workers.builder,
      brief: {
        ...spec.workers.builder.brief,
        context: `${spec.workers.builder.brief.context}\nIndependent architect proposal: ${architectReceipt}. Read it before editing. Frozen acceptance: ${JSON.stringify(spec.acceptance)}`,
      },
    };
  assert.equal(stage, 'review');
  return {
    ...spec.workers.reviewer,
    brief: {
      ...spec.workers.reviewer.brief,
      context: `${spec.workers.reviewer.brief.context}\nExact baseline ${spec.baseCommit}; review candidate ${candidate.commit}. Frozen acceptance: ${JSON.stringify(spec.acceptance)}. Protected tests: ${JSON.stringify(spec.protectedInputs)}`,
    },
  };
}

function workerSelection(admitted, nativeRunId, stage, candidate, assignment) {
  const root = join(admitted.spec.evidenceRoot, admitted.spec.runId);
  const runId = `${admitted.spec.runId}-${stage}`;
  return {
    root,
    workerRoot: join(root, stage),
    runId,
    candidate,
    assignment,
    stage,
    binding: {
      ...binding(admitted, nativeRunId),
      stage,
      workerRunId: runId,
      inputCandidate: candidate,
      assignment,
    },
    plan: {
      ...admitted.spec.plan,
      workType: stage === 'build' ? 'feature' : 'investigation',
    },
  };
}

function parallelRequest(selection, childStore, receiptStore, evidenceStore) {
  return {
    runId: selection.runId,
    revision: selection.candidate.commit,
    plan: selection.plan,
    capabilities: capabilities(
      'Pinned supported Codex exec transport; actual child evidence required for closeout',
      new Date().toISOString(),
    ),
    assignments: [selection.assignment],
    childStore,
    receiptStore,
    evidenceStore,
    owner: `archon:${selection.stage}`,
    leaseMs: 30000,
    leaseRenewal: { intervalMs: 5000 },
    retryPolicy: { maxAttempts: 1 },
    maxConcurrency: 1,
  };
}

function outputCandidate(selection, operation) {
  return selection.stage === 'build'
    ? { root: operation.integrationPath, commit: operation.integratedCommit }
    : selection.candidate;
}

async function verifyWorkerOperation(selection, operation, refs) {
  assert.equal(operation.status, 'PASS');
  const runPath = join(selection.workerRoot, selection.runId);
  assert.equal(
    operation.receiptPath,
    selection.stage === 'build'
      ? join(runPath, 'receipt.json')
      : join(runPath, selection.candidate.commit, 'receipt.json'),
    'Accepted operation receipt identity changed.',
  );
  const refByPath = new Map(refs.map((ref) => [ref.path, ref]));
  assert(
    refByPath.has(operation.receiptPath),
    'Operation receipt is not frozen.',
  );
  const receipt = await json(operation.receiptPath);
  assert.equal(receipt.schema, 1);
  assert.equal(receipt.runId, selection.runId);
  assert.equal(receipt.status, 'PASS');
  let workerReceipt = receipt;
  if (selection.stage === 'build') {
    assert.equal(receipt.baseCommit, selection.candidate.commit);
    assert.equal(receipt.reason, null);
    assert.equal(receipt.integrationPath, operation.integrationPath);
    assert.equal(receipt.integratedCommit, operation.integratedCommit);
    assert.equal(operation.integrationPath, join(runPath, 'integration'));
    assert.match(operation.integratedCommit, /^[0-9a-f]{40}$/);
    assert.notEqual(operation.integratedCommit, selection.candidate.commit);
    await assertWriteCandidate(
      operation.integrationPath,
      operation.integratedCommit,
    );
    assert.deepEqual(
      git(
        operation.integrationPath,
        'rev-list',
        '--parents',
        '-n',
        '1',
        'HEAD',
      ).split(' '),
      [operation.integratedCommit, selection.candidate.commit],
      'Accepted integration is not the builder baseline child.',
    );
    assert.equal(receipt.patches.length, 1);
    const patch = receipt.patches[0];
    assert.equal(patch.assignmentId, selection.assignment.id);
    assert.equal(patch.baseCommit, selection.candidate.commit);
    const patchRef = refByPath.get(patch.patchPath);
    assert(patchRef, 'Write receipt patch evidence is missing.');
    assert.match(patch.sha256, /^[0-9a-f]{64}$/);
    assert.equal(
      patchRef.sha256,
      patch.sha256,
      'Write receipt patch is not frozen in accepted evidence.',
    );
    assert.equal(receipt.verification.length, 1);
    assert.equal(receipt.verification[0].code, 0);
    assert(refByPath.has(receipt.verification[0].logPath));
    workerReceipt = receipt.workerReceipt;
  }
  assert.equal(workerReceipt.runId, selection.runId);
  assert.equal(workerReceipt.schema, 1);
  assert.equal(workerReceipt.revision, selection.candidate.commit);
  assert.equal(workerReceipt.status, 'PASS');
  assert.equal(workerReceipt.failure, null);
  assert.equal(workerReceipt.maxConcurrency, 1);
  assert.equal(workerReceipt.outcomes.length, 1);
  const outcome = workerReceipt.outcomes[0];
  assert.deepEqual(outcome.assignment, selection.assignment);
  assert.equal(outcome.error, null);
  assert.equal(outcome.result.status, 'PASS');
  assert(outcome.result.evidencePaths.every((path) => refByPath.has(path)));
}

/** Reads only a pre-existing accepted receipt. Missing proof cannot fall into dispatch. */
async function readAcceptedWorker(
  admitted,
  nativeRunId,
  stage,
  candidate,
  assignment,
) {
  const selection = workerSelection(
    admitted,
    nativeRunId,
    stage,
    candidate,
    assignment,
  );
  const { root, runId, workerRoot } = selection;
  for (const name of ['children', 'child-receipts', 'child-evidence'])
    assert(
      (await lstat(join(root, name))).isDirectory(),
      'Accepted child store missing.',
    );
  const childStore = await FileChildTaskStore.create(join(root, 'children'));
  const receipts = await FileParallelWorkerReceiptStore.create(
    join(root, 'child-receipts'),
  );
  const evidenceStore = await FileEvidenceStore.openExisting(
    join(root, 'child-evidence'),
  );
  const receiptPath = join(
    root,
    'child-receipts',
    `${runId}.parallel.receipt.json`,
  );
  const receiptBytes = await readFile(receiptPath);
  const accepted = await receipts.load(runId);
  assert.equal(
    accepted?.receipt.status,
    'PASS',
    'No accepted exact child result; duplicate dispatch denied.',
  );
  assert.equal(accepted.receipt.failure, null);
  assert.equal(accepted.receipt.maxConcurrency, 1);
  assert.deepEqual(JSON.parse(receiptBytes).receipt, accepted.receipt);
  const result = await executeRestartableParallelWorkers({
    ...parallelRequest(
      selection,
      childStore,
      {
        load: async (id) => {
          assert.equal(id, runId);
          return accepted;
        },
        save: async () => {
          throw new Error('Accepted readback cannot publish or dispatch.');
        },
      },
      evidenceStore,
    ),
    handler: async () => {
      throw new Error('Accepted readback cannot dispatch a worker.');
    },
  });
  assert.equal(result.state, 'COMPLETE');
  assert.equal(result.tasks.length, 1);
  assert.equal(result.group.runId, runId);
  assert.equal(result.group.revision, candidate.commit);
  assert.deepEqual(result.group.assignmentIds, [assignment.id]);
  assert.deepEqual(
    result.group.taskIds,
    result.tasks.map((task) => task.taskId),
  );
  const task = result.tasks[0];
  assert.equal(task.status, 'SUCCEEDED');
  assert.equal(task.attempt, 1);
  assert.equal(task.runId, runId);
  assert.equal(task.revision, candidate.commit);
  assert.equal(task.error, null);
  assert.equal(accepted.receipt.outcomes.length, 1);
  assert.deepEqual(accepted.receipt.outcomes[0], {
    assignment,
    result: task.result,
    error: null,
  });
  const references = task.result.evidenceReferences;
  assert.equal(
    references?.length,
    2,
    'Accepted child is missing frozen operation evidence.',
  );
  const operationRef = references.find((ref) => ref.kind === 'worker-result');
  const manifestRef = references.find((ref) => ref.kind === 'verification');
  assert(
    operationRef && manifestRef,
    'Accepted operation/manifest evidence missing.',
  );
  const operationBytes = Buffer.from(
    await evidenceStore.loadPortable(operationRef),
  );
  const manifest = JSON.parse(
    Buffer.from(await evidenceStore.loadPortable(manifestRef)),
  );
  assert.equal(manifest.schema, 1);
  assert.deepEqual(
    manifest.binding,
    selection.binding,
    'Accepted operation binding changed.',
  );
  const { evidenceReferences, ...workerResult } = task.result;
  assert.deepEqual(
    workerResult,
    manifest.result,
    'Accepted child result differs from frozen manifest.',
  );
  assert.deepEqual(manifest.operation, {
    path: join(workerRoot, 'operation-result.json'),
    sha256: operationRef.sha256,
    bytes: operationRef.bytes,
  });
  assert.equal(
    new Set(manifest.refs.map((ref) => ref.path)).size,
    manifest.refs.length,
  );
  assert(manifest.refs.every((ref) => inside(workerRoot, ref.path)));
  assert.deepEqual(
    manifest.refs.find((ref) => ref.path === manifest.operation.path),
    manifest.operation,
  );
  assert.deepEqual(
    manifest.result.evidencePaths,
    manifest.refs.map((ref) => ref.path),
  );
  await checkRefs(manifest.refs);
  const operation = JSON.parse(operationBytes);
  assert.deepEqual(
    manifest.outputCandidate,
    outputCandidate(selection, operation),
  );
  await verifyWorkerOperation(selection, operation, manifest.refs);
  const acceptedReceiptRef = {
    path: receiptPath,
    sha256: digest(receiptBytes),
    bytes: receiptBytes.length,
  };
  await checkRefs([acceptedReceiptRef]);
  return {
    operation,
    child: {
      storeRoot: join(root, 'children'),
      groupId: result.group.groupId,
      runId,
      revision: candidate.commit,
      taskIds: result.group.taskIds,
    },
    refs: [
      ...manifest.refs,
      acceptedReceiptRef,
      ...references.map((ref) => ({
        path: join(root, 'child-evidence', `${ref.sha256}.artifact`),
        sha256: ref.sha256,
        bytes: ref.bytes,
      })),
    ],
  };
}

async function worker(
  admitted,
  nativeRunId,
  stage,
  candidate,
  assignment,
  signal,
  control,
) {
  const spec = admitted.spec;
  const root = join(spec.evidenceRoot, spec.runId);
  await mkdir(root, { recursive: true });
  const childStore = await FileChildTaskStore.create(join(root, 'children'));
  const receiptStore = await FileParallelWorkerReceiptStore.create(
    join(root, 'child-receipts'),
  );
  const evidenceStore = await FileEvidenceStore.create(
    join(root, 'child-evidence'),
  );
  const runId = `${spec.runId}-${stage}`;
  const workerRoot = join(root, stage);
  await mkdir(workerRoot, { recursive: true });
  const common = {
    runId,
    revision: candidate.commit,
    workspaceRoot: candidate.root,
    sourceRepo: candidate.root,
    baseCommit: candidate.commit,
    evidenceRoot: workerRoot,
    maxConcurrency: 1,
    executable: spec.executable,
    timeoutMs: spec.timeoutMs,
    providerSelection: spec.providerSelection,
  };
  const selection = workerSelection(
    admitted,
    nativeRunId,
    stage,
    candidate,
    assignment,
  );
  let publication;
  const result = await executeRestartableParallelWorkers({
    ...parallelRequest(selection, childStore, receiptStore, evidenceStore),
    signal: control.controller.signal,
    handler: async (_assignment, context) => {
      const revoke = () => {
        void control
          .stop('Worker child lease/cancellation lost.')
          .catch(() => {});
      };
      context.signal.addEventListener('abort', revoke, { once: true });
      if (context.signal.aborted) revoke();
      try {
        await control.assertActive();
        const request =
          stage === 'build'
            ? {
                ...common,
                assignments: [{ worker: assignment, owns: spec.owns }],
                verify: [
                  {
                    program: 'git',
                    args: ['diff', '--check'],
                    timeoutMs: 10000,
                  },
                ],
              }
            : { ...common, assignments: [assignment] };
        const requestPath = join(workerRoot, 'owned-operation-input.json');
        const resultPath = join(workerRoot, 'owned-operation-output.json');
        await sealed(requestPath, { stage, request });
        const tool = fileURLToPath(
          new URL(
            '../../../tools/managed-candidate-operation.mts',
            import.meta.url,
          ),
        );
        await assertManagedBridgeRuntime(spec);
        const command = managedOperationCommand(tool, requestPath, resultPath);
        await control.run(
          `${control.options.authorityId}-worker`,
          {
            ...command,
            cwd: fileURLToPath(new URL('../../../', import.meta.url)),
            timeoutMs: spec.timeoutMs + (stage === 'build' ? 900000 : 180000),
          },
          {
            taskId: context.child.taskId,
            runId: context.child.runId,
            attempt: context.child.attempt,
            fencingEpoch: context.child.lease.fencingEpoch,
          },
        );
        await control.assertActive();
        const result = await json(resultPath);
        const path = join(workerRoot, 'operation-result.json');
        await sealed(path, result);
        const bytes = await readFile(path);
        const operation = { path, sha256: digest(bytes), bytes: bytes.length };
        const refs = [...(await files(join(workerRoot, runId))), operation];
        const workerResult = {
          status: result.status,
          summary: `Managed ${stage} ${result.status}`,
          evidencePaths: refs.map((x) => x.path),
          rawLogPath: null,
        };
        publication = {
          bytes,
          manifest: {
            schema: 1,
            binding: selection.binding,
            operation,
            outputCandidate: outputCandidate(selection, result),
            refs,
            result: workerResult,
          },
        };
        return workerResult;
      } finally {
        context.signal.removeEventListener('abort', revoke);
      }
    },
    evidenceForAssignment: async (acceptedAssignment, result) => {
      await control.assertActive();
      assert(
        publication,
        'Operation publication missing before child acceptance.',
      );
      assert.deepEqual(acceptedAssignment, assignment);
      assert.deepEqual(result, publication.manifest.result);
      await checkRefs(publication.manifest.refs);
      if (result.status === 'PASS')
        await verifyWorkerOperation(
          selection,
          JSON.parse(publication.bytes),
          publication.manifest.refs,
        );
      return [
        { kind: 'worker-result', content: publication.bytes },
        { kind: 'verification', content: JSON.stringify(publication.manifest) },
      ];
    },
  });
  assert.equal(
    result.state,
    'COMPLETE',
    'Worker is unresolved; no duplicate dispatch permitted.',
  );
  assert.equal(result.receipt.status, 'PASS', JSON.stringify(result.receipt));
  return readAcceptedWorker(
    admitted,
    nativeRunId,
    stage,
    candidate,
    assignment,
  );
}

/** Each native node calls exactly one operation. Immutable captures prevent replay. */
async function captureOperation({
  specPath,
  expectedSha256,
  artifacts,
  nativeRunId,
  stage,
  signal,
  reconcileIntentSha256,
  control,
}) {
  const admitted = await admitReviewedLocalCandidate({
    specPath,
    expectedSha256,
  });
  id(nativeRunId);
  assert(DEFAULT_STAGES.includes(stage));
  assert(isAbsolute(artifacts));
  await mkdir(artifacts, { recursive: true });
  const path = join(artifacts, `${stage}.json`);
  if (await exists(path))
    return loadStage(admitted, artifacts, nativeRunId, stage);
  const predecessors = [];
  for (const prior of DEFAULT_STAGES.slice(0, DEFAULT_STAGES.indexOf(stage)))
    predecessors.push(await loadStage(admitted, artifacts, nativeRunId, prior));
  const intent = join(artifacts, `${stage}.intent.json`);
  const recoveringBuild = await exists(intent);
  if (recoveringBuild) {
    assert(
      stage === 'build' && reconcileIntentSha256,
      'Uncertain stage dispatch retained; reconcile exact child/native identities before any re-execution.',
    );
    const bytes = await readFile(intent);
    assert.equal(
      digest(bytes),
      reconcileIntentSha256,
      'Retained dispatch intent changed.',
    );
    const retained = JSON.parse(bytes);
    assert.deepEqual(retained.binding, binding(admitted, nativeRunId));
    assert.equal(retained.stage, stage);
  } else {
    assert(!reconcileIntentSha256, 'No retained build intent to reconcile.');
    await sealed(intent, {
      binding: binding(admitted, nativeRunId),
      stage,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });
  }
  const startedAt = new Date().toISOString();
  const spec = admitted.spec;
  let result;
  let refs;
  const baseline = { root: spec.repositoryRoot, commit: spec.baseCommit };
  if (stage === 'investigate') {
    const checks = await runChecks(
      admitted,
      spec.baselineChecks,
      baseline.root,
      'baseline',
      signal,
      control,
    );
    const observed = await worker(
      admitted,
      nativeRunId,
      stage,
      baseline,
      spec.workers.architect,
      signal,
      control,
    );
    result = {
      architect: observed.operation,
      child: observed.child,
      baseline: checks.results,
    };
    refs = [...checks.refs, ...observed.refs];
  } else if (stage === 'plan') {
    // The independent architect's retained proposal is supplied verbatim to the
    // sole builder, while authority, ownership and check expectations stay frozen.
    const proposal = predecessors[0].result.architect;
    result = {
      acceptance: spec.acceptance,
      owns: spec.owns,
      architectReceipt: proposal.receiptPath,
      architectReceiptSha256: digest(await readFile(proposal.receiptPath)),
    };
    refs = [
      { path: proposal.receiptPath, sha256: result.architectReceiptSha256 },
    ];
  } else if (stage === 'build') {
    const assignment = workerAssignment(
      spec,
      stage,
      baseline,
      predecessors[1].result.architectReceipt,
    );
    const observed = await (recoveringBuild ? readAcceptedWorker : worker)(
      admitted,
      nativeRunId,
      stage,
      baseline,
      assignment,
      signal,
      control,
    );
    await assertWriteCandidate(
      observed.operation.integrationPath,
      observed.operation.integratedCommit,
    );
    assert.notEqual(
      observed.operation.integratedCommit,
      spec.baseCommit,
      'Build must produce a changed candidate.',
    );
    result = { ...observed.operation, child: observed.child };
    refs = observed.refs;
  } else if (stage === 'review') {
    const candidate = await integration(admitted, artifacts, nativeRunId);
    const assignment = workerAssignment(spec, stage, candidate);
    const observed = await worker(
      admitted,
      nativeRunId,
      stage,
      candidate,
      assignment,
      signal,
      control,
    );
    pinned(candidate.root, candidate.commit);
    result = { ...observed.operation, candidate, child: observed.child };
    refs = observed.refs;
  } else if (stage === 'verify') {
    const candidate = await integration(admitted, artifacts, nativeRunId);
    const checks = await runChecks(
      admitted,
      spec.acceptanceChecks,
      candidate.root,
      'acceptance',
      signal,
      control,
    );
    pinned(candidate.root, candidate.commit);
    result = { candidate, checks: checks.results };
    refs = checks.refs;
  } else {
    const candidate = await integration(admitted, artifacts, nativeRunId);
    result = {
      profile: spec.profile,
      delivery: 'local',
      candidate,
      acceptance: spec.acceptance,
      publication: 'denied',
    };
    refs = predecessors.flatMap((x) => x.refs);
  }
  await checkProtectedInputs(spec);
  pinned(spec.repositoryRoot, spec.baseCommit);
  const completionModelSelection = await observeManagedModelSelection(spec);
  await control.assertActive();
  assert(!signal?.aborted, 'Cancelled stage cannot publish completion.');
  const body = {
    binding: binding(admitted, nativeRunId),
    stage,
    status: 'PASS',
    startedAt,
    endedAt: new Date().toISOString(),
    modelSelection: {
      admission: admitted.modelSelection,
      completion: completionModelSelection,
    },
    result,
    refs,
  };
  await control.finish();
  const controlRefs = (await files(control.options.root)).filter((ref) =>
    ref.path.split(sep).at(-1).startsWith(control.options.authorityId),
  );
  refs.push(...controlRefs);
  await sealed(path, { body, sha256: objectDigest(body) });
  return body;
}

async function assertStageCleanup(admitted, nativeRunId, stage) {
  const root = join(admitted.spec.evidenceRoot, admitted.spec.runId);
  const store = await FileChildTaskStore.create(join(root, 'children'));
  const authorityId = `${admitted.spec.runId.slice(0, 55)}-${stage}-control-${objectDigest(binding(admitted, nativeRunId)).slice(0, 12)}`;
  const group = await store.loadGroup(authorityId);
  assert(
    group &&
      group.runId === admitted.spec.runId &&
      group.revision === admitted.spec.baseCommit,
    'Managed stage ownership missing.',
  );
  const adapter = createOwnedExecutionAdapter();
  for (const taskId of group.taskIds) {
    const record = await store.load(taskId);
    assert.equal(
      record?.status,
      'SUCCEEDED',
      'Managed stage execution is not complete.',
    );
    if (record.execution) {
      assert.equal(
        record.execution.state,
        'CLEANED',
        'Managed cleanup unresolved; accepted replay refused.',
      );
      const e = record.execution;
      const result = await adapter.recover({
        nonce: e.nonce,
        binding: e.binding,
        receiptPath: e.receiptPath,
      });
      assert.equal(
        result?.cleanup,
        'CONFIRMED',
        'Managed cleanup proof is missing/unresolved.',
      );
      assert.equal(result.witness.anchorPid, e.anchorPid);
      assert.equal(result.witness.guardianPid, e.guardianPid);
    }
  }
}

export async function captureReviewedLocalCandidate(input) {
  assert(
    typeof input.observeSupervisor === 'function',
    'Managed capture needs independently selected supervision.',
  );
  const admitted = await admitReviewedLocalCandidate(input);
  id(input.nativeRunId);
  assert.notEqual(input.nativeRunId.toLowerCase(), 'latest');
  assert(DEFAULT_STAGES.includes(input.stage));
  const root = join(admitted.spec.evidenceRoot, admitted.spec.runId);
  await mkdir(root, { recursive: true });
  const store = await FileChildTaskStore.create(join(root, 'children'));
  const authorityId = `${admitted.spec.runId.slice(0, 55)}-${input.stage}-control-${objectDigest(binding(admitted, input.nativeRunId)).slice(0, 12)}`;
  const controlRoot = join(root, 'execution-control');
  await mkdir(controlRoot, { recursive: true });
  const tasks = await FileTaskStore.create(admitted.spec.taskStoreRoot);
  // Completed capture and accepted-builder reconciliation are read-only. Their
  // prior caller-abort contract permits retrieval while retained authority still
  // validates; external cancellation remains active for every new execution.
  const readOnlyCapture =
    (await exists(join(input.artifacts, `${input.stage}.json`))) ||
    (input.stage === 'build' && !!input.reconcileIntentSha256);
  const observe = await createManagedTaskSupervisor({
    tasks,
    taskId: admitted.spec.taskId,
    executionStoreRoot: join(root, 'children'),
    reference: {
      schema: 1,
      harnessId: 'archon',
      harnessVersion: '0.10.1',
      runId: admitted.spec.runId,
      revision: admitted.spec.baseCommit,
      planSha256: admitted.planSha256,
      externalRunId: input.nativeRunId,
      workspaceRoot: admitted.spec.repositoryRoot,
      entrypoint: 'temari-reviewed-local-candidate',
    },
    observeNative: input.observeSupervisor,
    signal: readOnlyCapture ? undefined : input.signal,
    allowInitialPublication:
      input.stage === 'investigate' &&
      !(await exists(join(input.artifacts, 'investigate.intent.json'))) &&
      !(await exists(join(input.artifacts, 'investigate.json'))),
  });
  if (await exists(join(input.artifacts, `${input.stage}.json`))) {
    assert(await observe(), 'Native supervision ended; stage reuse refused.');
    await assertStageCleanup(admitted, input.nativeRunId, input.stage);
    return loadStage(admitted, input.artifacts, input.nativeRunId, input.stage);
  }
  // R1 reconciliation remains read-only: it cannot dispatch any owned operation.
  if (input.stage === 'build' && input.reconcileIntentSha256) {
    await assertStageCleanup(admitted, input.nativeRunId, input.stage);
    const authority = await store.load(authorityId);
    assert.equal(
      authority?.status,
      'SUCCEEDED',
      'Reconciled build ownership/cleanup is unresolved.',
    );
    const readOnly = {
      assertActive: async () =>
        assert(await observe(), 'Native supervision ended.'),
      options: { root: controlRoot, authorityId },
      finish: async () => {},
      run: async () => {
        throw new Error('Reconciliation cannot dispatch.');
      },
    };
    return captureOperation({ ...input, control: readOnly });
  }
  const checkCount =
    input.stage === 'investigate'
      ? admitted.spec.baselineChecks.length
      : input.stage === 'verify'
        ? admitted.spec.acceptanceChecks.length
        : 0;
  const processIds = Array.from(
    { length: checkCount },
    (_, i) => `${authorityId}-check-${i}`,
  );
  if (['investigate', 'build', 'review'].includes(input.stage))
    processIds.push(`${authorityId}-worker`);
  const control = new ManagedExecutionControl({
    store,
    adapter: createOwnedExecutionAdapter(),
    runId: admitted.spec.runId,
    revision: admitted.spec.baseCommit,
    binding: canonical({
      ...binding(admitted, input.nativeRunId),
      stage: input.stage,
    }),
    root: controlRoot,
    authorityId,
    processIds,
    observeSupervisor: observe,
    signal: input.signal,
  });
  await control.start();
  try {
    return await captureOperation({
      ...input,
      signal: control.controller.signal,
      control,
    });
  } catch (error) {
    await control.stop(String(error));
    throw error;
  } finally {
    await control.drain();
  }
}

/** Independent readback: worker PASS and native success never suffice alone. */
export async function verifyReviewedLocalCandidate({
  specPath,
  expectedSha256,
  artifacts,
  nativeRunId,
}) {
  const admitted = await admitReviewedLocalCandidate({
    specPath,
    expectedSha256,
  });
  id(nativeRunId);
  const stages = [];
  for (const stage of DEFAULT_STAGES) {
    stages.push(await loadStage(admitted, artifacts, nativeRunId, stage));
    await assertStageCleanup(admitted, nativeRunId, stage);
  }
  for (let i = 1; i < stages.length; i++)
    assert(
      Date.parse(stages[i].startedAt) >= Date.parse(stages[i - 1].endedAt),
      'Stage ordering changed.',
    );
  const candidate = await integration(admitted, artifacts, nativeRunId);
  assert.deepEqual(stages[3].result.candidate, candidate);
  assert.deepEqual(stages[4].result.candidate, candidate);
  assert.deepEqual(stages[5].result.candidate, candidate);
  const workers = [];
  assert.equal(
    stages[1].result.architectReceipt,
    stages[0].result.architect.receiptPath,
  );
  for (const index of [0, 2, 3]) {
    const stage = stages[index];
    const inputCandidate =
      index === 3
        ? candidate
        : {
            root: admitted.spec.repositoryRoot,
            commit: admitted.spec.baseCommit,
          };
    const assignment = workerAssignment(
      admitted.spec,
      stage.stage,
      inputCandidate,
      stages[1].result.architectReceipt,
    );
    const observed = await readAcceptedWorker(
      admitted,
      nativeRunId,
      stage.stage,
      inputCandidate,
      assignment,
    );
    const baselineChecksRoot = join(
      admitted.spec.evidenceRoot,
      admitted.spec.runId,
      'checks-baseline',
    );
    const controlRoot = join(
      admitted.spec.evidenceRoot,
      admitted.spec.runId,
      'execution-control',
    );
    const workerRefs = stage.refs.filter(
      (ref) =>
        !inside(controlRoot, ref.path) &&
        (index !== 0 || !inside(baselineChecksRoot, ref.path)),
    );
    assert.deepEqual(
      workerRefs,
      observed.refs,
      'Captured worker evidence differs from accepted child.',
    );
    assert.deepEqual(
      stage.result.child,
      observed.child,
      'Captured child identity changed.',
    );
    if (index === 0)
      assert.deepEqual(stage.result.architect, observed.operation);
    else
      assert.deepEqual(
        stage.result,
        {
          ...observed.operation,
          ...(index === 3 ? { candidate } : {}),
          child: observed.child,
        },
        'Captured operation differs from accepted child.',
      );
    const processes = stage.refs.filter((x) =>
      x.path.endsWith(`/process.json`),
    );
    assert.equal(processes.length, 1, 'Exactly one observed worker required.');
    const processEvidence = await json(processes[0].path);
    assert(processEvidence.pid > 0);
    assert.equal(processEvidence.exitCode, 0);
    assert(
      !processEvidence.timedOut &&
        !processEvidence.cancelled &&
        !processEvidence.outputLimitExceeded &&
        !processEvidence.error,
    );
    assert.deepEqual(
      processEvidence.provider.requested,
      admitted.spec.providerSelection,
    );
    assert.equal(
      processEvidence.provider.observed.sha256,
      admitted.spec.providerSelection.executableSha256,
    );
    assert(
      processEvidence.argv.includes(
        index === 2 ? 'workspace-write' : 'read-only',
      ),
    );
    const child = stage.result.child;
    assert.equal(
      child.revision,
      index === 3 ? candidate.commit : admitted.spec.baseCommit,
    );
    workers.push({
      id: assignment.id,
      role: assignment.role,
      pid: processEvidence.pid,
      nativeThreadId: processEvidence.nativeThreadId ?? null,
      process: processes[0],
      child,
    });
  }
  assert.equal(
    new Set(workers.map((x) => x.pid)).size,
    3,
    'Workers must be distinct processes.',
  );
  assert(stages[0].result.baseline.every((x) => x.code === 0));
  assert.equal(
    stages[4].result.checks.length,
    admitted.spec.acceptanceChecks.length,
  );
  assert(
    stages[4].result.checks.every(
      (x) => x.code === 0 && !x.timedOut && !x.cancelled,
    ),
  );
  return { admitted, stages, candidate, workers };
}

async function finalizeOperation(input) {
  await input.control.assertActive();
  const verified = await verifyReviewedLocalCandidate(input);
  const { admitted, stages, candidate, workers } = verified;
  const root = join(input.artifacts, 'reviewed-local-candidate');
  const receipts = await FileWorkflowReceiptStore.create(
    join(root, 'receipts'),
  );
  const evidence = await FileEvidenceStore.create(join(root, 'evidence'));
  let receipt = await receipts.load(admitted.spec.runId);
  if (!receipt)
    receipt = await executeAndPersist({
      runId: admitted.spec.runId,
      revision: admitted.spec.baseCommit,
      plan: admitted.spec.plan,
      capabilities: capabilities(
        `Three exact pinned worker processes: ${workers.map((x) => x.pid).join(',')}`,
        stages[3].endedAt,
      ),
      store: receipts,
      stageEvidence: { store: evidence },
      handler: async (stage) => {
        await input.control.assertActive();
        return {
          status: 'PASS',
          summary: `Archon-managed ${stage}; ${admitted.spec.profile}`,
          evidence: [
            {
              name: 'managed-capture',
              kind: 'verification',
              content: JSON.stringify(stages[DEFAULT_STAGES.indexOf(stage)]),
            },
          ],
        };
      },
    });
  assert.equal(receipt.status, 'PASS');
  assert.deepEqual(receipt.plan, admitted.spec.plan);
  const readback = await verifyPersistedStageEvidence({
    runId: admitted.spec.runId,
    revision: admitted.spec.baseCommit,
    store: receipts,
    evidenceStore: evidence,
  });
  for (let i = 0; i < stages.length; i++)
    assert.deepEqual(
      JSON.parse(
        Buffer.from(readback.stages[i].payloads[0].content).toString(),
      ),
      stages[i],
      'Canonical capture drift.',
    );
  const completion = {
    schema: 1,
    profile: admitted.spec.profile,
    status: 'PASS',
    binding: binding(admitted, input.nativeRunId),
    taskId: admitted.spec.taskId,
    candidate,
    workers,
    receiptSha256: objectDigest(receipt),
    scope: 'reviewed-local-candidate-only',
    publication: 'denied',
  };
  await input.control.assertActive();
  await input.control.finish();
  assert(!input.signal?.aborted, 'Cancelled closeout.');
  await sealed(join(root, 'completion.json'), completion);
  await sealed(join(input.artifacts, 'evidence.json'), {
    version: 1,
    kind: 'temari-reviewed-local-candidate',
    ...completion,
  });
  return completion;
}

export async function finalizeReviewedLocalCandidate(input) {
  assert(
    typeof input.observeSupervisor === 'function',
    'Managed finalization needs independently selected supervision.',
  );
  const admitted = await admitReviewedLocalCandidate(input);
  const root = join(admitted.spec.evidenceRoot, admitted.spec.runId);
  const store = await FileChildTaskStore.create(join(root, 'children'));
  const tasks = await FileTaskStore.create(admitted.spec.taskStoreRoot);
  const observe = await createManagedTaskSupervisor({
    tasks,
    taskId: admitted.spec.taskId,
    executionStoreRoot: join(root, 'children'),
    reference: {
      schema: 1,
      harnessId: 'archon',
      harnessVersion: '0.10.1',
      runId: admitted.spec.runId,
      revision: admitted.spec.baseCommit,
      planSha256: admitted.planSha256,
      externalRunId: input.nativeRunId,
      workspaceRoot: admitted.spec.repositoryRoot,
      entrypoint: 'temari-reviewed-local-candidate',
    },
    observeNative: input.observeSupervisor,
    signal: input.signal,
    allowInitialPublication: false,
  });
  if (
    await exists(
      join(input.artifacts, 'reviewed-local-candidate', 'completion.json'),
    )
  ) {
    assert(
      await observe(),
      'Native supervision ended; closeout reuse refused.',
    );
    await assertStageCleanup(admitted, input.nativeRunId, 'finalize');
    return finalizeOperation({
      ...input,
      control: {
        assertActive: async () =>
          assert(await observe(), 'Native supervision ended.'),
        finish: async () => {},
      },
    });
  }
  const authorityId = `${admitted.spec.runId.slice(0, 55)}-finalize-control-${objectDigest(binding(admitted, input.nativeRunId)).slice(0, 12)}`;
  const control = new ManagedExecutionControl({
    store,
    adapter: createOwnedExecutionAdapter(),
    runId: admitted.spec.runId,
    revision: admitted.spec.baseCommit,
    root: join(root, 'execution-control'),
    binding: canonical({
      ...binding(admitted, input.nativeRunId),
      stage: 'finalize',
    }),
    authorityId,
    processIds: [],
    observeSupervisor: observe,
    signal: input.signal,
  });
  await control.start();
  try {
    return await finalizeOperation({ ...input, control });
  } catch (error) {
    await control.stop(String(error));
    throw error;
  } finally {
    await control.drain();
  }
}

async function main(args) {
  const command = args.shift();
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    assert(
      [
        '--spec',
        '--sha256',
        '--artifacts',
        '--workflow-id',
        '--stage',
        '--intent-sha256',
      ].includes(args[i]) &&
        args[i + 1] &&
        !options[args[i]],
      'Invalid managed CLI argument.',
    );
    options[args[i]] = args[i + 1];
  }
  const input = {
    specPath: options['--spec'],
    expectedSha256: options['--sha256'],
    artifacts: options['--artifacts'],
    nativeRunId: options['--workflow-id'],
    stage: options['--stage'],
    reconcileIntentSha256: options['--intent-sha256'],
  };
  const controller = new AbortController();
  for (const event of ['SIGINT', 'SIGTERM'])
    process.once(event, () => controller.abort());
  input.signal = controller.signal;
  if (command === 'capture' || command === 'finalize') {
    const admitted = await admitReviewedLocalCandidate(input);
    input.observeSupervisor = await createManagedArchonSupervisor({
      executable: process.env.INPUTS_NATIVE_EXECUTABLE,
      executableSha256: process.env.INPUTS_NATIVE_EXECUTABLE_SHA256,
      home: process.env.INPUTS_NATIVE_HOME,
      nativeRunId: input.nativeRunId,
      runId: admitted.spec.runId,
      revision: admitted.spec.baseCommit,
      planSha256: admitted.planSha256,
      requestSha256: admitted.requestSha256,
      workspaceRoot: admitted.spec.repositoryRoot,
    });
    assert(await input.observeSupervisor(), 'Native supervision is not valid.');
  }

  const result =
    command === 'capture'
      ? await captureReviewedLocalCandidate(input)
      : command === 'finalize'
        ? await finalizeReviewedLocalCandidate(input)
        : command === 'verify'
          ? await verifyReviewedLocalCandidate(input)
          : command === 'admit'
            ? await admitReviewedLocalCandidate(input)
            : null;
  assert(result, 'Unsupported managed CLI command.');
  const report =
    command === 'capture'
      ? { status: result.status, stage: result.stage, binding: result.binding }
      : command === 'admit'
        ? {
            requestSha256: result.requestSha256,
            policySha256: result.policySha256,
            planSha256: result.planSha256,
            provider: result.provider,
            modelSelection: result.modelSelection,
            nativeBudgetCoverage: result.nativeBudgetCoverage,
          }
        : command === 'verify'
          ? {
              status: 'evidence-verified',
              candidate: result.candidate,
              workers: result.workers,
            }
          : result;
  console.log(JSON.stringify(report));
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
