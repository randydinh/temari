import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
// The public packager sets this constant; source development stays compatible.
declare const TEMARI_PACKAGED_MANAGED_RESOURCES: boolean;
const packagedManagedResources =
  typeof TEMARI_PACKAGED_MANAGED_RESOURCES !== 'undefined' &&
  TEMARI_PACKAGED_MANAGED_RESOURCES === true;
import type {
  HarnessRunRef,
  WorkerAssignment,
} from '../libs/contracts/src/index.js';
import {
  createReviewedLocalCandidatePlan,
  REVIEWED_LOCAL_CANDIDATE_POLICY,
} from '../libs/temari-core/src/index.js';
import {
  FileChildTaskStore,
  FileTaskStore,
  TaskRuntime,
  taskDigest,
  readReviewedLocalCandidateResult,
  selectExecutionHarness,
  type TaskSnapshot,
  type HarnessSelection,
  type ReviewedLocalCandidatePaths,
  type ReviewedLocalCandidateCompletion,
} from '../libs/runtime/src/index.js';
import type { CommandSpec } from './run-codex-write-workers.mjs';
import {
  materializeGoalPlan,
  parseManagedCandidatePlannerPolicy,
  type PlannerPolicy,
  type GoalPlanSnapshot,
} from './dashboard-planner.mjs';

/** Trusted host configuration only. None of these fields are browser inputs. */
export interface DashboardManagedCandidateProfile {
  profile: 'reviewed-local-candidate-v1';
  policyId: string;
  taskStoreRoot: string;
  evidenceRoot: string;
  bridgePath: string;
  bridgeSha256: string;
  bridgeRuntimeExecutable: string;
  bridgeRuntimeSha256: string;
  executable: string;
  timeoutMs: number;
  providerSelection: {
    provider: 'codex';
    executableSha256: string;
    executableVersion: string;
    model: string;
    reasoning: string;
  };
  modelAdmission: {
    configPath: string;
    configSha256: string;
    catalogPath: string;
    catalogSha256: string;
    parserExecutable: string;
    parserSha256: string;
  };
  architect: WorkerAssignment;
  protectedInputs: { path: string; sha256: string }[];
  baselineChecks: CommandSpec[];
  acceptanceChecks: CommandSpec[];
}
export interface ManagedCandidatePreparation {
  schema: 1;
  taskId: string;
  runId: string;
  goalSha256: string;
  candidate: { head: string; fingerprint: string };
  profileSha256: string;
  policySha256: string;
  proposalSha256: string;
  paths: ReviewedLocalCandidatePaths;
  childStoreRoot: string;
}
export interface ManagedCandidateHost {
  selection: HarnessSelection;
  admit(paths: ReviewedLocalCandidatePaths): Promise<void>;
  readiness(
    reference: HarnessRunRef,
    options: {
      timeoutMs: number;
      deadlineAtMs: number;
      signal: AbortSignal;
      onObservation(event: unknown): Promise<void>;
    },
  ): Promise<void>;
  verify(
    paths: ReviewedLocalCandidatePaths,
    artifacts: string,
    reference: HarnessRunRef,
  ): Promise<ReviewedLocalCandidateCompletion>;
}
const sha = (bytes: Uint8Array | string) =>
  createHash('sha256').update(bytes).digest('hex');
const inside = (parent: string, path: string) => {
  const rel = relative(parent, path);
  return (
    rel === '' ||
    (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
  );
};
function exact(value: any, keys: string[]) {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(
    Object.keys(value).sort(),
    keys.sort(),
    'Unknown or missing managed host fields.',
  );
}
async function canonicalDirectory(path: string) {
  assert(isAbsolute(path), 'Managed roots must be absolute.');
  assert.equal(await realpath(path), path, 'Managed root alias refused.');
  assert((await lstat(path)).isDirectory());
}
async function canonicalTarget(path: string): Promise<void> {
  assert(isAbsolute(path));
  try {
    assert.equal(
      await realpath(path),
      path,
      'Managed preparation ancestor alias refused.',
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await canonicalTarget(dirname(path));
  }
}
async function pinnedFile(path: string, digest: string) {
  assert(isAbsolute(path));
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(await realpath(path), path, 'Managed input alias refused.');
  assert((await lstat(path)).isFile());
  assert.equal(sha(await readFile(path)), digest, 'Managed input pin changed.');
}
/** Refuse ambiguous roots and external executable aliases before any preparation effect. */
export async function validateManagedCandidateProfile(
  value: unknown,
  workspaceRoot: string,
  preparationRoot: string,
): Promise<DashboardManagedCandidateProfile> {
  const p = structuredClone(value) as DashboardManagedCandidateProfile;
  exact(p, [
    'profile',
    'policyId',
    'taskStoreRoot',
    'evidenceRoot',
    'bridgePath',
    'bridgeSha256',
    'bridgeRuntimeExecutable',
    'bridgeRuntimeSha256',
    'executable',
    'timeoutMs',
    'providerSelection',
    'modelAdmission',
    'architect',
    'protectedInputs',
    'baselineChecks',
    'acceptanceChecks',
  ]);
  assert.equal(p.profile, 'reviewed-local-candidate-v1');
  assert.match(p.policyId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
  const roots = [
    workspaceRoot,
    preparationRoot,
    p.taskStoreRoot,
    p.evidenceRoot,
  ];
  for (const root of roots) await canonicalDirectory(root);
  for (let i = 0; i < roots.length; i++)
    for (let j = i + 1; j < roots.length; j++)
      assert(
        !inside(roots[i]!, roots[j]!) && !inside(roots[j]!, roots[i]!),
        'Managed roots overlap.',
      );
  assert(
    Number.isSafeInteger(p.timeoutMs) &&
      p.timeoutMs >= 1000 &&
      p.timeoutMs <= 900000,
  );
  exact(p.providerSelection, [
    'provider',
    'executableSha256',
    'executableVersion',
    'model',
    'reasoning',
  ]);
  assert.equal(p.providerSelection.provider, 'codex');
  exact(p.modelAdmission, [
    'configPath',
    'configSha256',
    'catalogPath',
    'catalogSha256',
    'parserExecutable',
    'parserSha256',
  ]);
  assert(Array.isArray(p.protectedInputs) && p.protectedInputs.length > 0);
  for (const ref of p.protectedInputs) {
    exact(ref, ['path', 'sha256']);
    assert(
      !inside(workspaceRoot, ref.path),
      'Protected inputs must be external.',
    );
    await pinnedFile(ref.path, ref.sha256);
  }
  assert.equal(
    new Set(p.protectedInputs.map((x) => x.path)).size,
    p.protectedInputs.length,
  );
  if (packagedManagedResources) {
    for (const path of [
      p.bridgePath,
      join(dirname(p.bridgePath), 'managed-candidate-operation.mjs'),
      join(
        dirname(p.bridgePath),
        '.archon/workflows/temari-reviewed-local-candidate.yaml',
      ),
      join(dirname(p.bridgePath), 'owned-process/guardian.mjs'),
      join(dirname(p.bridgePath), 'owned-process/anchor.mjs'),
      fileURLToPath(import.meta.url),
      fileURLToPath(new URL('./dashboard-planner.mjs', import.meta.url)),
    ]) {
      assert(
        p.protectedInputs.some((ref) => ref.path === path),
        'Packaged managed resource must be a protected external input.',
      );
    }
  }
  for (const [path, digest] of [
    [p.bridgePath, p.bridgeSha256],
    [p.bridgeRuntimeExecutable, p.bridgeRuntimeSha256],
    [p.executable, p.providerSelection.executableSha256],
    [p.modelAdmission.configPath, p.modelAdmission.configSha256],
    [p.modelAdmission.catalogPath, p.modelAdmission.catalogSha256],
    [p.modelAdmission.parserExecutable, p.modelAdmission.parserSha256],
  ]) {
    assert(
      !inside(workspaceRoot, path!),
      'Managed executable/catalog/config must be external.',
    );
    await pinnedFile(path!, digest!);
  }
  await access(p.bridgeRuntimeExecutable, constants.X_OK);
  assert(
    p.protectedInputs.some(
      (ref) =>
        ref.path === p.bridgeRuntimeExecutable &&
        ref.sha256 === p.bridgeRuntimeSha256,
    ),
    'Bridge runtime must be a protected external input.',
  );
  assert(p.architect.role === 'investigator' && p.architect.required === true);
  for (const commands of [p.baselineChecks, p.acceptanceChecks]) {
    assert(
      Array.isArray(commands) && commands.length > 0 && commands.length <= 10,
    );
    for (const command of commands) {
      assert(
        p.protectedInputs.some((ref) => ref.path === command.program),
        'Check executable must be protected.',
      );
      assert(
        Array.isArray(command.args) &&
          command.args.every(
            (arg) => typeof arg === 'string' && !arg.includes('\0'),
          ),
      );
      assert(
        Number.isSafeInteger(command.timeoutMs) &&
          command.timeoutMs! > 0 &&
          command.timeoutMs! <= 600000,
      );
    }
  }
  return p;
}
async function immutable(path: string, value: unknown) {
  const bytes = JSON.stringify(value);
  try {
    const f = await open(path, 'wx', 0o600);
    try {
      await f.writeFile(bytes);
      await f.sync();
    } finally {
      await f.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    assert.equal(
      await readFile(path, 'utf8'),
      bytes,
      'Immutable managed preparation changed.',
    );
  }
  return sha(bytes);
}
export async function prepareManagedCandidate(options: {
  profile: DashboardManagedCandidateProfile;
  preparationRoot: string;
  store: FileTaskStore;
  runtime: TaskRuntime;
  task: TaskSnapshot;
  policy: PlannerPolicy;
  snapshot: GoalPlanSnapshot;
  runId: string;
  host: ManagedCandidateHost;
}): Promise<TaskSnapshot> {
  const { task, store, runtime, snapshot, runId, host } = options;
  const profile = await validateManagedCandidateProfile(
    options.profile,
    task.workspaceRoot,
    options.preparationRoot,
  );
  assert.equal(
    profile.taskStoreRoot,
    store.root,
    'Managed task store must be the dashboard store.',
  );
  const policy = parseManagedCandidatePlannerPolicy(options.policy);
  assert.equal(policy.id, profile.policyId);
  assert.deepEqual(
    policy.prepare,
    profile.baselineChecks,
    'Planner baseline checks differ from protected host checks.',
  );
  assert.deepEqual(
    policy.verify,
    profile.acceptanceChecks,
    'Planner acceptance checks differ from protected host checks.',
  );
  assert.match(runId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
  const material = await materializeGoalPlan(
    policy,
    snapshot,
    snapshot.candidate,
  );
  assert.equal(material.assignments.length, 1);
  assert.equal(snapshot.taskId, task.taskId);
  assert.equal(material.goalSha256, taskDigest(task.goal));
  assert(!task.currentRunId, 'Task already has a prepared run.');
  assert.equal(
    (await store.load(task.taskId))?.version,
    task.version,
    'Task changed before preparation.',
  );
  const directory = join(options.preparationRoot, task.taskId, runId);
  const childStoreRoot = join(profile.evidenceRoot, runId, 'children');
  await canonicalTarget(directory);
  await canonicalTarget(childStoreRoot);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await canonicalDirectory(directory);
  await FileChildTaskStore.create(childStoreRoot);
  await canonicalDirectory(childStoreRoot);
  const specPath = join(directory, 'managed-spec.json');
  const spec = {
    schema: 1,
    profile: profile.profile,
    taskId: task.taskId,
    runId,
    taskStoreRoot: store.root,
    repositoryRoot: task.workspaceRoot,
    evidenceRoot: profile.evidenceRoot,
    baseCommit: snapshot.candidate.head,
    plan: createReviewedLocalCandidatePlan(),
    policySha256: taskDigest(REVIEWED_LOCAL_CANDIDATE_POLICY),
    timeoutMs: profile.timeoutMs,
    executable: profile.executable,
    providerSelection: profile.providerSelection,
    bridgeRuntime: {
      executable: profile.bridgeRuntimeExecutable,
      sha256: profile.bridgeRuntimeSha256,
    },
    modelAdmission: profile.modelAdmission,
    workers: {
      architect: profile.architect,
      builder: material.assignments[0]!.worker,
      reviewer: material.reviewer,
    },
    owns: material.assignments[0]!.owns,
    acceptance: material.assignments[0]!.worker.brief.acceptanceCriteria,
    protectedInputs: profile.protectedInputs,
    baselineChecks: profile.baselineChecks,
    acceptanceChecks: profile.acceptanceChecks,
    planner: {
      goalSha256: material.goalSha256,
      policySha256: material.policySha256,
      proposalSha256: material.proposalSha256,
    },
  };
  const expectedRequestSha256 = await immutable(specPath, spec);
  const prepared: ManagedCandidatePreparation = {
    schema: 1,
    taskId: task.taskId,
    runId,
    goalSha256: material.goalSha256,
    candidate: snapshot.candidate,
    profileSha256: taskDigest(profile),
    policySha256: material.policySha256,
    proposalSha256: material.proposalSha256,
    paths: {
      specPath,
      bridgePath: profile.bridgePath,
      expectedRequestSha256,
      expectedBridgeSha256: profile.bridgeSha256,
      bridgeRuntimeExecutable: profile.bridgeRuntimeExecutable,
      bridgeRuntimeSha256: profile.bridgeRuntimeSha256,
    },
    childStoreRoot,
  };
  await host.admit(prepared.paths);
  const path = join(directory, 'managed-preparation.json');
  const digest = await immutable(path, prepared);
  await store.bindRun({
    taskId: task.taskId,
    actor: 'dashboard-operator',
    expectedVersion: task.version,
    idempotencyKey: `managed-prepare-${runId}`,
    run: {
      runId,
      revision: snapshot.candidate.head,
      plan: createReviewedLocalCandidatePlan(),
      executionStoreRoot: childStoreRoot,
      sourceRefs: [
        {
          sourceId: 'dashboard-managed-candidate',
          publicationId: digest,
          location: path,
        },
      ],
    },
  });
  return runtime.snapshot(task.taskId);
}
export async function readManagedCandidatePreparation(options: {
  task: TaskSnapshot;
  profile: DashboardManagedCandidateProfile;
  preparationRoot: string;
}): Promise<ManagedCandidatePreparation | null> {
  const { task, profile } = options;
  const run = task.runs.find((r) => r.runId === task.currentRunId);
  const ref = run?.sourceRefs?.find(
    (r) => r.sourceId === 'dashboard-managed-candidate',
  );
  if (!run || !ref) return null;
  assert(inside(options.preparationRoot, ref.location));
  await pinnedFile(ref.location, ref.publicationId);
  const prepared = JSON.parse(
    await readFile(ref.location, 'utf8'),
  ) as ManagedCandidatePreparation;
  assert.equal(prepared.schema, 1);
  assert.equal(prepared.taskId, task.taskId);
  assert.equal(prepared.runId, run.runId);
  assert.equal(prepared.goalSha256, taskDigest(task.goal));
  assert.equal(
    prepared.profileSha256,
    taskDigest(profile),
    'Managed host profile changed.',
  );
  assert.deepEqual(run.plan, createReviewedLocalCandidatePlan());
  assert.equal(run.revision, prepared.candidate.head);
  assert.equal(
    prepared.childStoreRoot,
    join(profile.evidenceRoot, run.runId, 'children'),
  );
  assert.equal(run.executionStoreRoot, prepared.childStoreRoot);
  assert.equal(
    prepared.paths.specPath,
    join(options.preparationRoot, task.taskId, run.runId, 'managed-spec.json'),
  );
  assert.equal(prepared.paths.bridgePath, profile.bridgePath);
  assert.equal(prepared.paths.expectedBridgeSha256, profile.bridgeSha256);
  assert.equal(
    prepared.paths.bridgeRuntimeExecutable,
    profile.bridgeRuntimeExecutable,
  );
  assert.equal(prepared.paths.bridgeRuntimeSha256, profile.bridgeRuntimeSha256);
  await pinnedFile(
    prepared.paths.bridgeRuntimeExecutable,
    prepared.paths.bridgeRuntimeSha256,
  );
  await pinnedFile(
    prepared.paths.specPath,
    prepared.paths.expectedRequestSha256,
  );
  await pinnedFile(
    prepared.paths.bridgePath,
    prepared.paths.expectedBridgeSha256,
  );
  return prepared;
}
/** Production ports use only the selected source bridge and exact harness. */
export function createManagedCandidateHost(
  profile: DashboardManagedCandidateProfile,
  selection: HarnessSelection,
): ManagedCandidateHost {
  const command = promisify(execFile);
  const harness = selectExecutionHarness(selection) as ReturnType<
    typeof selectExecutionHarness
  > & {
    waitForRunIdentityInitialization(
      reference: HarnessRunRef,
      options: any,
    ): Promise<unknown>;
  };
  const invoke = async (paths: ReviewedLocalCandidatePaths, args: string[]) => {
    assert.equal(paths.bridgePath, profile.bridgePath);
    assert.equal(
      paths.bridgeRuntimeExecutable,
      profile.bridgeRuntimeExecutable,
    );
    assert.equal(paths.bridgeRuntimeSha256, profile.bridgeRuntimeSha256);
    await pinnedFile(
      profile.bridgeRuntimeExecutable,
      profile.bridgeRuntimeSha256,
    );
    await access(profile.bridgeRuntimeExecutable, constants.X_OK);
    await pinnedFile(profile.bridgePath, profile.bridgeSha256);
    await pinnedFile(paths.specPath, paths.expectedRequestSha256);
    const output = await command(
      profile.bridgeRuntimeExecutable,
      [
        paths.bridgePath,
        ...args,
        '--spec',
        paths.specPath,
        '--sha256',
        paths.expectedRequestSha256,
      ],
      { timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
    return JSON.parse(output.stdout);
  };
  return {
    selection,
    async admit(paths) {
      const admitted = await invoke(paths, ['admit']);
      assert.equal(admitted.requestSha256, paths.expectedRequestSha256);
    },
    async readiness(reference, options) {
      assert(
        harness.waitForRunIdentityInitialization,
        'Selected harness has no managed readiness gate.',
      );
      await harness.waitForRunIdentityInitialization(reference, options);
    },
    async verify(paths, artifacts, reference) {
      const verified = await invoke(paths, [
        'verify',
        '--artifacts',
        artifacts,
        '--workflow-id',
        reference.externalRunId,
      ]);
      assert.equal(verified.status, 'evidence-verified');
      const completion = JSON.parse(
        await readFile(
          join(artifacts, 'reviewed-local-candidate', 'completion.json'),
          'utf8',
        ),
      );
      assert.deepEqual(completion.candidate, verified.candidate);
      assert.deepEqual(completion.workers, verified.workers);
      return completion;
    },
  };
}
export async function readManagedCandidateResult(options: {
  store: FileTaskStore;
  runtime: TaskRuntime;
  host: ManagedCandidateHost;
  task: TaskSnapshot;
  prepared: ManagedCandidatePreparation;
  artifacts: string;
}) {
  const { store, runtime, host, prepared, artifacts } = options;
  let task = options.task;
  const run = task.runs.find((r) => r.runId === prepared.runId)!;
  if (!run.receiptRoot) {
    await store.attachEvidenceRoots({
      taskId: task.taskId,
      runId: prepared.runId,
      actor: 'dashboard-operator',
      expectedVersion: task.version,
      idempotencyKey: `managed-evidence-${prepared.runId}`,
      receiptRoot: join(artifacts, 'reviewed-local-candidate', 'receipts'),
      evidenceRoot: join(artifacts, 'reviewed-local-candidate', 'evidence'),
    });
    task = await runtime.snapshot(task.taskId);
  }
  const result = await readReviewedLocalCandidateResult({
    store,
    selection: host.selection,
    taskId: task.taskId,
    runId: prepared.runId,
    requestSha256: prepared.paths.expectedRequestSha256,
    policySha256: taskDigest(REVIEWED_LOCAL_CANDIDATE_POLICY),
    verifyCandidate: (reference) =>
      host.verify(prepared.paths, artifacts, reference),
  });
  const path = join(artifacts, 'reviewed-local-candidate', 'completion.json');
  const completionBytes = await readFile(path);
  assert.deepEqual(
    JSON.parse(completionBytes.toString()),
    result,
    'Managed completion changed after verification.',
  );
  const completionSha256 = sha(completionBytes);
  await store.handoffTask({
    taskId: task.taskId,
    actor: 'dashboard-operator',
    expectedVersion: task.version,
    idempotencyKey: `managed-result-${prepared.runId}`,
    handoff: {
      summary: `Reviewed local candidate retained at ${result.candidate.root}, commit ${result.candidate.commit}; coordinator review remains required.`,
      decisions: [
        'Local candidate only; canonical feature closeout remains separate.',
      ],
      nextAction: 'Review the exact managed candidate.',
      blocker: null,
      contextRefs: [
        {
          kind: 'reviewed-local-candidate-completion',
          sha256: completionSha256,
          location: path,
        },
      ],
    },
  });
  return runtime.snapshot(task.taskId);
}

export const retainManagedDiagnostic = immutable;

/** Read-only projection reopens the route result instead of trusting handoff prose. */
export async function inspectManagedCandidateCompletion(options: {
  store: FileTaskStore;
  host: ManagedCandidateHost;
  task: TaskSnapshot;
  prepared: ManagedCandidatePreparation;
  artifacts: string;
}): Promise<{ root: string; commit: string; completionSha256: string } | null> {
  const { task, prepared, store, host, artifacts } = options;
  const ref = task.handoff?.contextRefs.find(
    (r) => r.kind === 'reviewed-local-candidate-completion',
  );
  if (!ref) return null;
  assert.equal(
    task.handoff?.runId,
    prepared.runId,
    'Completion context belongs to another run.',
  );
  assert(ref.sha256);
  await pinnedFile(ref.location, ref.sha256);
  assert.equal(
    ref.location,
    join(artifacts, 'reviewed-local-candidate', 'completion.json'),
  );
  const result = await readReviewedLocalCandidateResult({
    store,
    selection: host.selection,
    taskId: task.taskId,
    runId: prepared.runId,
    requestSha256: prepared.paths.expectedRequestSha256,
    policySha256: taskDigest(REVIEWED_LOCAL_CANDIDATE_POLICY),
    verifyCandidate: (reference) =>
      host.verify(prepared.paths, artifacts, reference),
  });
  const bytes = await readFile(ref.location);
  assert.equal(
    sha(bytes),
    ref.sha256,
    'Completion context changed during projection.',
  );
  assert.deepEqual(JSON.parse(bytes.toString()), result);
  return { ...result.candidate, completionSha256: ref.sha256 };
}
