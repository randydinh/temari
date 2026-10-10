import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
  readdir,
  symlink,
  rename,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { promisify } from 'node:util';
import test, { type TestContext } from 'node:test';
import {
  DEFAULT_STAGES,
  type ExecutionHarness,
  type HarnessRunRef,
  type HarnessRunStatus,
} from '../libs/contracts/src/index.js';
import {
  FileTaskStore,
  FileMergeReconciliationStore,
  TaskRuntime,
  taskDigest,
} from '../libs/runtime/src/index.js';
import {
  DashboardController,
  validateDashboardConfig,
  createDashboardReconciliationInteractionWriter,
  type DashboardImplementationPlan,
} from './dashboard-controller.mjs';
import { startTaskViewServer } from './task-view.mjs';
import { MergeReconciliationDashboard, projectRetainedReconciliationReview, reconciliationInteractionIdentity, type ReconciliationInteractionEvent } from './merge-reconciliation-dashboard.mjs';

const run = promisify(execFile);
function implementationPlan(): DashboardImplementationPlan {
  const assignment = (id: string, role: 'implementer' | 'reviewer') => ({
    id,
    role,
    required: true,
    brief: {
      goal:
        role === 'reviewer'
          ? 'Independently review the combined candidate.'
          : `Implement the ${id} portion.`,
      context: 'Use the prepared plan and retain concrete evidence.',
      scope: `${id}.txt`,
      acceptanceCriteria: ['Retain a source-backed result.'],
      verificationCommand: null,
      reportFormat: 'json' as const,
      forbiddenActions: ['Do not publish or edit unowned paths.'],
    },
  });
  return {
    id: 'two-parts',
    title: 'Implement two isolated parts',
    description: 'Combine disjoint edits and verify the exact candidate.',
    assignments: ['first', 'second'].map((id) => ({
      worker: assignment(id, 'implementer'),
      owns: [{ kind: 'file' as const, path: `${id}.txt` }],
    })),
    prepare: [],
    verify: [
      { program: process.execPath, args: ['--version'], timeoutMs: 3000 },
    ],
    reviewer: assignment('independent-review', 'reviewer'),
  };
}

async function fixture(t: TestContext, coding = false, planning = false) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'temari-dashboard-controller-')),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = join(root, 'workspace');
  const preparationRoot = join(root, 'preparations');
  const archonHome = join(root, 'archon');
  for (const directory of [workspaceRoot, preparationRoot, archonHome])
    await mkdir(directory);
  await writeFile(
    join(workspaceRoot, 'README.md'),
    'Retained local verification.\n',
  );
  for (const args of [
    ['init', '-q'],
    ['add', '.'],
    [
      '-c',
      'user.name=Dashboard Test',
      '-c',
      'user.email=dashboard@example.invalid',
      'commit',
      '-qm',
      'fixture',
    ],
  ])
    await run('git', args, { cwd: workspaceRoot });
  const bridgePath = join(root, 'bridge.ts');
  const finalizerPath = join(root, 'finalizer.ts');
  await writeFile(bridgePath, 'bridge fixture');
  await writeFile(finalizerPath, 'finalizer fixture');
  const plannerExecutable = join(root, 'planner-fixture');
  if (planning)
    await writeFile(
      plannerExecutable,
      `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
process.stdin.resume();
process.stdin.on('end', () => {
 fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify({schema:1,title:'Two requested parts',summary:'Independent changes within configured scopes.',assignments:['first','second'].map(slotId=>({slotId,goal:'Implement '+slotId,acceptanceCriteria:['Requested behavior is present.'],dependsOn:[]})),blockers:[]}));
 console.log(JSON.stringify({event:'fixture-plan'}));
});
`,
      { mode: 0o700 },
    );
  const config = await validateDashboardConfig({
    schema: 1,
    workspaceRoot,
    preparationRoot,
    recipes: [
      {
        id: 'checks',
        title: 'Check the workspace',
        goal: 'Verify the configured workspace checks at a pinned revision.',
        stages: Object.fromEntries(
          DEFAULT_STAGES.map((stage) => [
            stage,
            {
              executable: process.execPath,
              args: ['--version'],
              timeoutMs: 3000,
              summary: stage,
            },
          ]),
        ),
      },
    ],
    ...(coding
      ? {
          implementation: {
            executable: process.execPath,
            maxConcurrency: 2,
            timeoutMs: 3000,
            plans: [implementationPlan()],
          },
        }
      : {}),
    ...(planning
      ? {
          planning: {
            executable: plannerExecutable,
            timeoutMs: 3000,
            policies: [
              {
                id: 'bounded-parts',
                title: 'Two parts',
                description: 'Configured disjoint parts.',
                slots: ['first', 'second'].map((id) => ({
                  id,
                  title: id,
                  description: `Implement ${id}.`,
                  owns: [{ kind: 'file', path: `${id}.txt` }],
                  mandatoryCriteria: [`Mandatory ${id} criterion.`],
                })),
                prepare: [],
                verify: implementationPlan().verify,
                reviewer: implementationPlan().reviewer,
              },
            ],
          },
        }
      : {}),
  });
  let starts = 0;
  let cancels = 0;
  let observations = 0;
  let nativeStatus: HarnessRunStatus = 'RUNNING';
  let loseResponse = false;
  let changedIdentity = false;
  const refs = new Map<string, HarnessRunRef>();
  const harness: ExecutionHarness = {
    id: 'test-archon',
    version: '1',
    async start(request) {
      starts++;
      const ref = {
        schema: 1 as const,
        harnessId: this.id,
        harnessVersion: this.version,
        runId: request.runId,
        revision: request.revision,
        planSha256: taskDigest(request.plan),
        externalRunId: `native-${starts}`,
        workspaceRoot,
        entrypoint: request.entrypoint,
        startedAt: new Date().toISOString(),
      };
      refs.set(ref.externalRunId, ref);
      if (loseResponse) throw new Error('Lost dispatch response');
      return ref;
    },
    async status() {
      observations++;
      return {
        status: nativeStatus,
        observedAt: new Date().toISOString(),
        summary: nativeStatus,
        rawLogPath: null,
      };
    },
    async cancel(ref) {
      cancels++;
      nativeStatus = 'CANCELLED';
      return this.status(ref);
    },
    async resume(ref) {
      nativeStatus = 'RUNNING';
      return this.status(ref);
    },
    async verifyRunIdentity() {},
  };
  const store = await FileTaskStore.create(join(root, 'tasks'));
  const reconciliationStore = await FileMergeReconciliationStore.create(
    join(root, 'reconciliation'),
  );
  let reconciliationBindingDrift = false;
  const runtime = new TaskRuntime({
    store,
    selection: {
      hostHarness: harness,
      configuredHarness: null,
      managedDefault: null,
    },
  });
  const controller = new DashboardController({
    config,
    store,
    runtime,
    bridgePath,
    finalizerPath,
    archonHome,
    reconciliation: new MergeReconciliationDashboard(reconciliationStore, {
      async readCurrentBinding({ expected }) {
        return reconciliationBindingDrift
          ? { ...expected, revision: 'trusted-reader-observed-drift' }
          : expected;
      },
    }),
    readNative: async (ref) => {
      const saved = refs.get(ref.externalRunId)!;
      const { externalRunId: _id, startedAt: _at, ...binding } = saved;
      return {
        id: changedIdentity ? 'other-native-run' : saved.externalRunId,
        working_path: workspaceRoot,
        workflow_name: saved.entrypoint,
        status: nativeStatus.toLowerCase(),
        metadata: { inputs: { temari_binding: JSON.stringify(binding) } },
      };
    },
  });
  const server = await startTaskViewServer({
    runtime,
    controller,
    archonBaseUrl: 'http://127.0.0.1:3091',
    port: 0,
  });
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const dashboard = (await (await fetch(`${base}/api/dashboard`)).json()) as {
    csrfToken: string;
  };
  const post = async (path: string, body: unknown) => {
    const response = await fetch(base + path, {
      method: 'POST',
      headers: {
        origin: base,
        'content-type': 'application/json',
        'x-temari-token': dashboard.csrfToken,
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  return {
    root,
    workspaceRoot,
    preparationRoot,
    bridgePath,
    store,
    reconciliationStore,
    runtime,
    controller,
    post,
    base,
    config,
    harness,
    archonHome,
    counts: () => ({ starts, cancels, observations }),
    loseResponse: () => {
      loseResponse = true;
    },
    changeIdentity: () => {
      changedIdentity = true;
    },
    setStatus: (status: HarnessRunStatus) => {
      nativeStatus = status;
    },
    driftReconciliationBinding: () => {
      reconciliationBindingDrift = true;
    },
  };
}

const reconciliationSha = 'a'.repeat(64);
const reconciliationDigest = 'b'.repeat(64);
function reconciliationEvidence(id: string) {
  return [
    {
      schema: 1 as const,
      id,
      sha256: reconciliationSha,
      bytes: 3,
      mediaType: 'application/json',
    },
  ];
}
function reconciliationScope(version: string) {
  return {
    schema: 1 as const,
    sourceRoot: { id: 'source-root', sha256: 'c'.repeat(64) },
    candidateRoot: { id: `candidate-root-${version}`, sha256: 'd'.repeat(64) },
    baseHead: { id: 'base-head', sha256: 'e'.repeat(64) },
    operationHead: { id: 'operation-head', sha256: 'f'.repeat(64) },
    affectedPaths: [{
      path: 'tools/dashboard-controller.mts', classification: 'unmerged' as const,
      pathSha256: '1'.repeat(64),
      indexBlobs: [{ stage: 1 as const, mode: '100644', objectId: '2'.repeat(64) }],
      unmergedStages: [{ stage: 1 as const, mode: '100644', objectId: '2'.repeat(64) }],
      worktreeKind: 'file' as const, worktreeSha256: '3'.repeat(64), diffSha256: '4'.repeat(64),
    }],
    resolutionIntent: 'preserve' as const,
    requiredChecks: [{ id: 'dashboard-check', definitionSha256: '0'.repeat(64) }],
    expectedComparison: {
      candidateEvidence: reconciliationEvidence(`candidate-comparison-${version}`)[0]!,
      verificationEvidence: reconciliationEvidence(`verification-comparison-${version}`)[0]!,
    },
  };
}
function reconciliationRequest(version: string, key: string) {
  const observation = {
    schema: 1 as const,
    observationId: `observation-${version}`,
    taskId: 'reconciliation-task',
    taskVersion: version,
    runId: 'reconciliation-run',
    revision: 'reconciliation-revision',
    candidate: {
      schema: 'reconciliation-candidate-v1' as const,
      id: 'reconciliation-candidate',
      sha256: reconciliationSha,
    },
    scope: reconciliationScope(version),
    observedAt: '2026-10-01T12:00:00.000Z',
    kind: 'mixed' as const,
    evidence: reconciliationEvidence(`observation-evidence-${version}`),
  };
  const plan = {
    schema: 1 as const,
    id: `plan-${version}`,
    taskId: observation.taskId,
    taskVersion: observation.taskVersion,
    runId: observation.runId,
    revision: observation.revision,
    observationId: observation.observationId,
    candidate: observation.candidate,
    scope: observation.scope,
    classification: 'requires-confirmation' as const,
    status: 'awaiting-confirmation' as const,
    request: {
      idempotencyKey: key,
      canonicalRequestDigestAlgorithm: 'canonical-json-sha256-v1' as const,
      canonicalRequestSha256: reconciliationDigest,
    },
    summary: 'Retain observed reconciliation evidence.',
    actions: [
      {
        id: 'preserve-observation',
        kind: 'preserve' as const,
        targetId: observation.taskId,
      },
    ],
    evidence: reconciliationEvidence(`plan-evidence-${version}`),
  };
  const confirmation = {
    schema: 1 as const,
    confirmationId: `confirmation-${version}`,
    planId: plan.id,
    observationId: observation.observationId,
    canonicalRequestSha256: reconciliationDigest,
    confirmedAt: '2026-10-01T12:01:00.000Z',
    confirmedBy: 'dashboard-operator',
    evidence: reconciliationEvidence(`confirmation-evidence-${version}`),
  };
  return { observation, plan, confirmation };
}

test('dashboard reconciliation routes retain intent state without task completion', async (t) => {
  const f = await fixture(t);
  const first = reconciliationRequest('v1', 'reconcile-v1');
  const created = await f.post('/api/reconciliation', {
    idempotencyKey: 'reconcile-v1',
    observation: first.observation,
    plan: first.plan,
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.state, 'awaiting-confirmation');
  assert.equal(created.body.canConfirm, true);
  const attemptId = created.body.attemptId as string;
  const read = await fetch(`${f.base}/api/reconciliation/${attemptId}`);
  assert.equal(read.status, 200);
  assert.equal((await read.json() as any).state, 'awaiting-confirmation');
  const wrongConfirmation = await f.post(
    `/api/reconciliation/${attemptId}/confirm`,
    {
      confirmation: {
        ...first.confirmation,
        canonicalRequestSha256: 'c'.repeat(64),
      },
    },
  );
  assert.equal(wrongConfirmation.status, 400);
  const ready = await f.post(`/api/reconciliation/${attemptId}/confirm`, {
    confirmation: first.confirmation,
  });
  assert.equal(ready.status, 200);
  assert.deepEqual(
    {
      state: ready.body.state,
      readiness: ready.body.candidate.readiness,
      terminal: ready.body.terminal,
    },
    { state: 'observed', readiness: 'not-ready', terminal: false },
  );
  assert.equal((await f.runtime.listSnapshots()).length, 0);

  const stale = reconciliationRequest('v2', 'reconcile-v2');
  const second = await f.post('/api/reconciliation', {
    idempotencyKey: 'reconcile-v2',
    observation: stale.observation,
    plan: stale.plan,
  });
  const clientBindingRejected = await f.post(`/api/reconciliation/${attemptId}/confirm`, {
    confirmation: first.confirmation,
    current: {},
  });
  assert.equal(clientBindingRejected.status, 400);
  f.driftReconciliationBinding();
  const staleResult = await f.post(`/api/reconciliation/${second.body.attemptId}/invalidate`, {});
  assert.equal(staleResult.status, 200);
  assert.equal(staleResult.body.state, 'blocked');
  assert.match(staleResult.body.blockedReason, /task, run, revision, candidate, or observation binding changed/i);
  const rejected = await f.post('/api/reconciliation', {
    idempotencyKey: 'reconcile-v3',
    observation: first.observation,
    plan: first.plan,
    unexpected: true,
  });
  assert.equal(rejected.status, 400);
});

test('HTTP goal intake and prepared start preserve identity and reject arbitrary-goal completion', async (t) => {
  const f = await fixture(t);
  const general = await f.post('/api/tasks', {
    requestId: 'general',
    title: 'Implement a feature',
    goal: 'Implement a new arbitrary feature.',
  });
  assert.equal(general.status, 200);
  assert.equal(general.body.status, 'OPEN');
  assert.equal(general.body.runs.length, 0);
  const refuse = await f.post('/api/tasks/task-general/actions', {
    action: 'accept',
    requestId: 'accept',
    expectedVersion: 1,
    reason: 'I say it passed',
  });
  assert.equal(refuse.status, 400);
  assert.match(refuse.body.error, /prepare/);
  assert.equal(
    (
      await f.post('/api/tasks', {
        requestId: 'bad',
        recipeId: 'checks',
        goal: 'Implement a feature',
      })
    ).status,
    400,
  );
  const prepared = await f.post('/api/tasks', {
    requestId: 'one',
    recipeId: 'checks',
  });
  assert.equal(prepared.status, 200);
  assert.equal(prepared.body.version, 2);
  assert.equal(
    prepared.body.goal,
    'Verify the configured workspace checks at a pinned revision.',
  );
  assert.equal(
    (await f.post('/api/tasks', { requestId: 'one', recipeId: 'checks' })).body
      .version,
    2,
  );
  const start = { action: 'start', requestId: 'start', expectedVersion: 2 };
  assert.equal(
    (await f.post('/api/tasks/task-one/actions', start)).status,
    200,
  );
  assert.equal(
    (await f.post('/api/tasks/task-one/actions', start)).status,
    200,
  );
  assert.equal(f.counts().starts, 1);
  assert.equal(
    (
      await f.post('/api/tasks/task-one/actions', {
        ...start,
        requestId: 'stale-start',
      })
    ).status,
    409,
  );
  const current = await f.runtime.snapshot('task-one');
  assert.equal(
    (
      await f.post('/api/tasks/task-one/actions', {
        action: 'accept',
        requestId: 'no-proof',
        expectedVersion: current.version,
        reason: 'Native work finished',
      })
    ).status,
    400,
  );
  assert.notEqual((await f.runtime.snapshot('task-one')).status, 'DONE');
});

test('prepared candidate drift blocks execution without launching', async (t) => {
  const f = await fixture(t);
  await f.controller.create({ requestId: 'one', recipeId: 'checks' });
  await writeFile(
    join(f.workspaceRoot, 'README.md'),
    'Changed after preparation.',
  );
  await assert.rejects(
    f.controller.action('task-one', {
      action: 'start',
      requestId: 'drift',
      expectedVersion: 2,
    }),
    /uncommitted|changed/,
  );
  assert.equal(f.counts().starts, 0);
});

test('uncertain dispatch remains blocked and cannot launch a replacement', async (t) => {
  const f = await fixture(t);
  await f.controller.create({ requestId: 'one', recipeId: 'checks' });
  f.loseResponse();
  await assert.rejects(
    f.controller.action('task-one', {
      action: 'start',
      requestId: 'start',
      expectedVersion: 2,
    }),
    /Lost dispatch/,
  );
  const task = await f.runtime.snapshot('task-one');
  assert.equal(task.status, 'BLOCKED');
  const state = (await f.controller.describe()) as any;
  assert.match(
    state.controls['task-one'].message,
    /reconcile the exact native/,
  );
  assert(!state.controls['task-one'].actions.includes('start'));
  await assert.rejects(
    f.controller.action('task-one', {
      action: 'start',
      requestId: 'start-again',
      expectedVersion: task.version,
    }),
  );
  assert.equal(f.counts().starts, 1);
});

test('corrupt preparation retains exact-native observe and cancellation', async (t) => {
  const f = await fixture(t);
  await f.controller.create({ requestId: 'one', recipeId: 'checks' });
  let task = await f.controller.action('task-one', {
    action: 'start',
    requestId: 'start',
    expectedVersion: 2,
  });
  await writeFile(f.bridgePath, 'changed');
  task = await f.controller.action('task-one', {
    action: 'observe',
    requestId: 'observe',
    expectedVersion: task.version,
  });
  assert.equal(task.status, 'RUNNING');
  const state = (await f.controller.describe()) as any;
  assert.deepEqual(state.controls['task-one'].actions, ['observe', 'cancel']);
  assert.match(state.controls['task-one'].issue, /changed/);
  task = await f.controller.action('task-one', {
    action: 'cancel',
    requestId: 'cancel',
    expectedVersion: task.version,
  });
  assert.equal(task.status, 'CANCELLED');
  assert.equal(f.counts().cancels, 1);
});

test('accepted maximum request identities remain controllable after task prefixing', async (t) => {
  const f = await fixture(t);
  const requestId = 'a'.repeat(96);
  const task = await f.controller.create({
    requestId,
    title: 'Long identity',
    goal: 'Retain a controllable task.',
  });
  const updated = await f.controller.action(task.taskId, {
    action: 'update',
    requestId: 'update',
    expectedVersion: task.version,
    nextAction: 'Continue here.',
  });
  assert.equal(updated.nextAction, 'Continue here.');
  await assert.rejects(
    f.controller.create({
      requestId: 'b'.repeat(97),
      title: 'Too long',
      goal: 'Invalid identity.',
    }),
    /identity/,
  );
});

test('resume refuses a changed exact-native identity and is hidden from controls', async (t) => {
  const f = await fixture(t);
  await f.controller.create({ requestId: 'one', recipeId: 'checks' });
  let task = await f.controller.action('task-one', {
    action: 'start',
    requestId: 'start',
    expectedVersion: 2,
  });
  f.setStatus('FAILED');
  task = await f.controller.action('task-one', {
    action: 'observe',
    requestId: 'failed',
    expectedVersion: task.version,
  });
  f.changeIdentity();
  await assert.rejects(
    f.controller.action('task-one', {
      action: 'resume',
      requestId: 'resume',
      expectedVersion: task.version,
    }),
    /identity changed/,
  );
  const config = (await f.controller.describe()) as any;
  assert(!config.controls['task-one'].actions.includes('resume'));
});

test('swarm intake binds prepared child records, preserves limits, and refuses serial acceptance', async (t) => {
  const f = await fixture(t);
  const binaryAlias = join(f.root, 'bin-alias');
  await symlink(dirname(process.execPath), binaryAlias, 'dir');
  const config = await validateDashboardConfig({
    ...f.config,
    swarm: {
      executable: join(binaryAlias, basename(process.execPath)),
      maxWorkers: 4,
      maxConcurrency: 2,
      timeoutMs: 3000,
    },
  });
  const controller = new DashboardController({
    config,
    store: f.store,
    runtime: f.runtime,
    bridgePath: f.bridgePath,
    finalizerPath: f.bridgePath,
    archonHome: f.archonHome,
    readNative: async () => ({}),
  });
  const request = {
    requestId: 'swarm',
    mode: 'swarm',
    title: 'Investigate',
    goal: 'Explain source boundaries.',
    workerCount: 2,
    maxConcurrency: 2,
  };
  const task = await controller.create(request);
  assert.equal(task.version, 2);
  assert.equal(task.runSnapshots[0]!.children.length, 2);
  assert.equal((await controller.create(request)).version, task.version);
  await assert.rejects(
    controller.create({ ...request, maxConcurrency: 1 }),
    /concurrency changed/,
  );
  const projected = (await controller.describe()) as any;
  assert.equal(projected.controls[task.taskId].swarm.state, 'PREPARED');
  assert.equal(projected.controls[task.taskId].limits.totalWorkers, 2);
  await assert.rejects(
    controller.action(task.taskId, {
      action: 'accept',
      requestId: 'accept',
      expectedVersion: task.version,
      reason: 'Finished',
    }),
    /coordinator review/,
  );
  const cancelled = await controller.action(task.taskId, {
    action: 'swarm-cancel',
    requestId: 'cancel',
    expectedVersion: task.version,
  });
  assert.equal(cancelled.status, 'CANCELLED');
  assert.equal(
    ((await controller.describe()) as any).controls[task.taskId].swarm.state,
    'CANCELLED',
  );
});

test('coding intake freezes the host plan, binds both durable groups, and refuses command injection and serial acceptance', async (t) => {
  const f = await fixture(t, true);
  const request = {
    requestId: 'coding',
    mode: 'implementation',
    planId: 'two-parts',
    title: 'Build two parts',
    goal: 'Implement both parts for the saved goal.',
  };
  assert.equal(
    (await f.post('/api/tasks', { ...request, executable: '/bin/sh' })).status,
    400,
  );
  assert.equal(
    (await f.post('/api/tasks', { ...request, assignments: [] })).status,
    400,
  );
  assert.equal(
    (await f.post('/api/tasks', { ...request, planId: 'unknown' })).status,
    400,
  );
  const prepared = await f.post('/api/tasks', request);
  assert.equal(prepared.status, 200);
  const task = prepared.body;
  assert.equal(task.version, 2);
  assert.equal(task.goal, request.goal);
  assert.equal(task.runs[0].childRefs.length, 2);
  assert.equal(task.runSnapshots[0].children.length, 3);
  assert.equal(task.semanticAcceptance, false);
  assert.equal((await f.post('/api/tasks', request)).body.version, 2);
  const definition = (await f.controller.describe()) as any;
  assert.equal(definition.implementation.plans[0].assignments.length, 2);
  assert.deepEqual(definition.implementation.plans[0].assignments[0].owns, [
    { kind: 'file', path: 'first.txt' },
  ]);
  assert.equal(
    definition.controls[task.taskId].implementation.state,
    'PREPARED',
  );
  assert(
    definition.controls[task.taskId].actions.includes('implementation-start'),
  );
  assert(!definition.controls[task.taskId].actions.includes('accept'));
  const reference = task.runs[0].sourceRefs[0];
  const preparation = JSON.parse(await readFile(reference.location, 'utf8'));
  const manifest = JSON.parse(
    await readFile(preparation.handle.requestPath, 'utf8'),
  );
  assert.equal(manifest.request.workspaceRoot, f.workspaceRoot);
  assert(
    manifest.request.assignments[0].worker.brief.context.includes(
      JSON.stringify(request.goal),
    ),
  );
  assert.equal(
    manifest.request.assignments[0].worker.brief.verificationCommand,
    null,
  );
  assert.notEqual(preparation.handle.groupId, preparation.handle.reviewGroupId);
  const refuse = await f.post(`/api/tasks/${task.taskId}/actions`, {
    action: 'accept',
    requestId: 'coding-accept',
    expectedVersion: task.version,
    reason: 'All workers passed',
  });
  assert.equal(refuse.status, 400);
  assert.match(refuse.body.error, /coordinator review/);
  const cancelled = await f.post(`/api/tasks/${task.taskId}/actions`, {
    action: 'implementation-cancel',
    requestId: 'coding-cancel',
    expectedVersion: task.version,
  });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.status, 'CANCELLED');
  const after = (await f.controller.describe()) as any;
  assert.equal(after.controls[task.taskId].implementation.state, 'CANCELLED');
  assert(!after.controls[task.taskId].actions.includes('implementation-start'));
});

test('coding configuration rejects overlapping ownership, optional workers, duplicate reviewer identity and arbitrary commands', async (t) => {
  const f = await fixture(t, true);
  for (const [alter, pattern] of [
    [
      (config: any) => {
        config.implementation.plans[0].assignments[1].owns = [
          { kind: 'file', path: 'FIRST.txt' },
        ];
      },
      /overlap/,
    ],
    [
      (config: any) => {
        config.implementation.plans[0].assignments[1].worker.required = false;
      },
      /required/,
    ],
    [
      (config: any) => {
        config.implementation.plans[0].reviewer.id = 'first';
      },
      /distinct/,
    ],
    [
      (config: any) => {
        config.implementation.plans[0].reviewer.role = 'implementer';
      },
      /reviewer/,
    ],
    [
      (config: any) => {
        config.implementation.plans[0].verify[0].program = 'node';
      },
      /absolute/,
    ],
    [
      (config: any) => {
        config.implementation.plans[0].assignments[0].worker.brief.verificationCommand =
          'rm -rf .';
      },
      /host configuration/,
    ],
  ] as const) {
    const changed = structuredClone(f.config);
    alter(changed);
    await assert.rejects(validateDashboardConfig(changed), pattern);
  }
});

test('coding plan and candidate changes refuse new execution while retaining cancellation and metadata controls', async (t) => {
  const f = await fixture(t, true);
  const request = {
    requestId: 'pinned-coding',
    mode: 'implementation',
    planId: 'two-parts',
    title: 'Pinned coding',
    goal: 'Retain the chosen plan and revision.',
  };
  const task = await f.controller.create(request);
  (f.config.implementation!.plans[0]!.verify[0] as any).args = ['--help'];
  await assert.rejects(f.controller.create(request), /plan changed/);
  await writeFile(
    join(f.workspaceRoot, 'untracked.txt'),
    'another operator changed the candidate\n',
  );
  const controls = ((await f.controller.describe()) as any).controls[
    task.taskId
  ];
  assert.equal(controls.candidateCurrent, false);
  assert(!controls.actions.includes('implementation-start'));
  assert(controls.actions.includes('implementation-cancel'));
  await assert.rejects(
    f.controller.action(task.taskId, {
      action: 'implementation-start',
      requestId: 'stale-candidate',
      expectedVersion: task.version,
    }),
    /uncommitted/,
  );
  const updated = await f.controller.action(task.taskId, {
    action: 'update',
    requestId: 'retain-next',
    expectedVersion: task.version,
    nextAction: 'Inspect the changed source before preparing a fresh task.',
  });
  assert.equal(
    updated.nextAction,
    'Inspect the changed source before preparing a fresh task.',
  );
  assert.equal(updated.runs[0]!.revision, task.runs[0]!.revision);
  const cancelled = await f.controller.action(task.taskId, {
    action: 'implementation-cancel',
    requestId: 'cancel-changed',
    expectedVersion: updated.version,
  });
  assert.equal(cancelled.status, 'CANCELLED');
});

async function readyGoalPlan(
  f: Awaited<ReturnType<typeof fixture>>,
  taskId: string,
) {
  const deadline = Date.now() + 10000;
  do {
    const control = ((await f.controller.describe()) as any).controls[taskId];
    if (control.planning?.state === 'READY') return control;
    if (['BLOCKED', 'RECOVERY_REQUIRED'].includes(control.planning?.state))
      throw new Error(JSON.stringify(control));
    await new Promise((resolve) => setTimeout(resolve, 30));
  } while (Date.now() < deadline);
  throw new Error('Goal planner did not become ready.');
}

test('natural goal retains a validated plan and prepares parallel execution on the same task with exact replay', async (t) => {
  const f = await fixture(t, true, true);
  const request = {
    requestId: 'natural-goal',
    mode: 'planning',
    policyId: 'bounded-parts',
    title: 'Requested change',
    goal: 'Implement first and second independent parts.',
  };
  const task = await f.controller.create(request);
  assert.equal(task.currentRunId, null);
  const control = await readyGoalPlan(f, task.taskId);
  assert(control.actions.includes('prepare-plan'));
  assert.equal(control.planning.goalSha256, taskDigest(task.goal));
  const input = {
    action: 'prepare-plan',
    requestId: 'admit-natural-goal',
    expectedVersion: task.version,
    proposalSha256: control.planning.proposalSha256,
  };
  const prepared = await f.controller.action(task.taskId, input);
  assert.equal(prepared.taskId, task.taskId);
  assert.equal(prepared.runs.length, 1);
  assert.equal(prepared.runs[0]!.childRefs!.length, 2);
  assert.notEqual(prepared.status, 'DONE');
  assert.deepEqual(await f.controller.action(task.taskId, input), prepared);
  assert.equal((await f.runtime.listSnapshots()).length, 1);
  const finalControl = ((await f.controller.describe()) as any).controls[
    task.taskId
  ];
  assert.equal(finalControl.planning.state, 'READY');
  assert.equal(finalControl.implementation.state, 'PREPARED');
  assert(finalControl.actions.includes('implementation-start'));
  assert.deepEqual(
    await f.controller.action(task.taskId, {
      ...input,
      requestId: 'another-admission',
    }),
    prepared,
  );
});

test('goal plan admission rejects changed policy, candidate and proposal identity', async (t) => {
  const f = await fixture(t, true, true);
  const task = await f.controller.create({
    requestId: 'bound-goal',
    mode: 'planning',
    policyId: 'bounded-parts',
    title: 'Bound goal',
    goal: 'Implement both parts.',
  });
  const control = await readyGoalPlan(f, task.taskId);
  const input = {
    action: 'prepare-plan',
    requestId: 'admit-bound-goal',
    expectedVersion: task.version,
    proposalSha256: control.planning.proposalSha256,
  };
  await assert.rejects(
    f.controller.action(task.taskId, {
      ...input,
      proposalSha256: '0'.repeat(64),
    }),
    /proposal changed/i,
  );
  (f.config.planning!.policies[0]!.slots[0]! as any).mandatoryCriteria = [
    'Changed policy',
  ] as any;
  await assert.rejects(
    f.controller.action(task.taskId, input),
    /policy changed/i,
  );
  (f.config.planning!.policies[0]!.slots[0]! as any).mandatoryCriteria = [
    'Mandatory first criterion.',
  ] as any;
  await writeFile(join(f.workspaceRoot, 'changed.txt'), 'changed');
  await assert.rejects(f.controller.action(task.taskId, input), /uncommitted/);
  assert.equal((await f.runtime.snapshot(task.taskId)).runs.length, 0);
});

test('scheduled inspection confirms only exact start intent and execution termination without accepting evidence', async (t) => {
  const f = await fixture(t);
  const task = await f.controller.create({
    requestId: 'scheduled-check',
    recipeId: 'checks',
  });
  const before = await f.controller.inspectScheduledTask(
    task.taskId,
    'exact-schedule-start',
  );
  assert.equal(before.state, 'prepared');
  assert.equal(before.intent, 'absent');
  assert.equal(before.startAllowed, true);
  await f.controller.action(task.taskId, {
    action: 'start',
    requestId: 'exact-schedule-start',
    expectedVersion: task.version,
  });
  const active = await f.controller.inspectScheduledTask(
    task.taskId,
    'exact-schedule-start',
  );
  assert.equal(active.state, 'active');
  assert.equal(active.intent, 'confirmed');
  assert.equal(
    (await f.controller.inspectScheduledTask(task.taskId, 'another-start'))
      .intent,
    'absent',
  );
  f.setStatus('SUCCEEDED');
  const ended = await f.controller.inspectScheduledTask(
    task.taskId,
    'exact-schedule-start',
  );
  assert.equal(ended.state, 'terminal');
  assert.equal(ended.intent, 'confirmed');
  assert.notEqual((await f.runtime.snapshot(task.taskId)).status, 'DONE');
});

test('goal admission recovers a published preparation after bind crash with a fresh browser request ID', async (t) => {
  const f = await fixture(t, true, true);
  const task = await f.controller.create({
    requestId: 'admission-crash',
    mode: 'planning',
    policyId: 'bounded-parts',
    title: 'Recover planning',
    goal: 'Implement both requested parts.',
  });
  const control = await readyGoalPlan(f, task.taskId);
  const bind = f.store.bindRun.bind(f.store);
  let failOnce = true;
  f.store.bindRun = async (input) => {
    if (failOnce) {
      failOnce = false;
      throw new Error('Simulated crash before run binding');
    }
    return bind(input);
  };
  const input = {
    action: 'prepare-plan',
    requestId: 'browser-before-crash',
    expectedVersion: task.version,
    proposalSha256: control.planning.proposalSha256,
  };
  await assert.rejects(
    f.controller.action(task.taskId, input),
    /Simulated crash/,
  );
  const retained = JSON.parse(
    await readFile(
      join(f.preparationRoot, task.taskId, 'implementation.json'),
      'utf8',
    ),
  );
  const recovered = await f.controller.action(task.taskId, {
    ...input,
    requestId: 'browser-after-restart',
  });
  assert.equal(recovered.runs.length, 1);
  assert.equal(
    recovered.currentRunId,
    retained.handle.runId ??
      JSON.parse(await readFile(retained.handle.requestPath, 'utf8')).request
        .runId,
  );
  assert.equal(recovered.runs[0]!.childRefs!.length, 2);
  assert.notEqual(recovered.status, 'DONE');
});


async function browserReconciliationConfig(f: Awaited<ReturnType<typeof fixture>>, selectedAttempts: { attemptId: string; reviewSha256: string }[] = []) {
  return validateDashboardConfig({
    ...f.config,
    reconciliation: {
      storeRoot: join(f.root, 'reconciliation'), sourceRoot: f.workspaceRoot,
      candidate: { id: 'reconciliation-candidate', sha256: reconciliationSha, root: reconciliationScope('v1').candidateRoot },
      resolutionIntent: 'preserve', requiredChecks: reconciliationScope('v1').requiredChecks,
      expectedComparison: reconciliationScope('v1').expectedComparison,
      browserReview: { selectedAttempts },
    },
  });
}

test('reconciliation host selection rejects caller-shaped, duplicate and oversized admission pins', async (t) => {
  const f = await fixture(t);
  const config = await browserReconciliationConfig(f, [{ attemptId: 'attempt:portable', reviewSha256: 'a'.repeat(64) }]);
  assert.deepEqual(config.reconciliation!.browserReview!.selectedAttempts, [{ attemptId: 'attempt:portable', reviewSha256: 'a'.repeat(64) }]);
  for (const selectedAttempts of [
    [{ attemptId: 'attempt', reviewSha256: 'a'.repeat(64), selectedByBrowser: true }],
    [{ attemptId: 'attempt', reviewSha256: 'A'.repeat(64) }],
    [{ attemptId: 'attempt', reviewSha256: 'a'.repeat(64) }, { attemptId: 'attempt', reviewSha256: 'b'.repeat(64) }],
    Array.from({ length: 129 }, (_, i) => ({ attemptId: `attempt-${i}`, reviewSha256: 'a'.repeat(64) })),
  ]) await assert.rejects(validateDashboardConfig({ ...config, reconciliation: { ...config.reconciliation, browserReview: { selectedAttempts } } }));
  await assert.rejects(validateDashboardConfig({ ...config, reconciliation: { ...config.reconciliation, storeRoot: join(f.workspaceRoot, 'private-store') } }), /disjoint from source/);
  for (const storeRoot of [f.preparationRoot, join(f.preparationRoot, 'reconciliation-browser-interactions'), join(f.preparationRoot, 'reconciliation-browser-interactions', 'nested-ledger')])
    await assert.rejects(validateDashboardConfig({ ...config, reconciliation: { ...config.reconciliation, storeRoot } }), /ledger and interaction stores must be disjoint/);
  assert.deepEqual(await readdir(f.preparationRoot), []);
  assert.deepEqual((await readdir(f.workspaceRoot)).sort(), ['.git', 'README.md']);
});

test('host interaction publication pins actual bytes and refuses replacement or symlink storage', async (t) => {
  const f = await fixture(t); const config = await browserReconciliationConfig(f);
  const writer = await createDashboardReconciliationInteractionWriter(config);
  const input = { attemptId: 'attempt:writer', requestId: 'request:writer' };
  assert.equal(await writer.read(input), null);
  const event: ReconciliationInteractionEvent = {
    schema: 1, kind: 'temari-reconciliation-dashboard-interaction', ...input,
    planId: 'plan', observationId: 'observation', reviewSha256: 'a'.repeat(64), canonicalRequestSha256: 'b'.repeat(64), expectedBindingSha256: 'c'.repeat(64),
    bindingCheck: { state: 'matched', beganAt: '2026-10-03T12:00:00.000Z', endedAt: '2026-10-03T12:00:01.000Z', changedFields: [], reasonCode: null },
    actorKind: 'local-dashboard-interaction', receivedAt: '2026-10-03T12:00:02.000Z',
  };
  await writer.publish(event);
  const retained = (await writer.read(input))!;
  assert.deepEqual(Buffer.from(retained.bytes), Buffer.from(JSON.stringify(event) + '\n'));
  assert.equal(retained.evidence.sha256, createHash('sha256').update(retained.bytes).digest('hex'));
  assert.equal(retained.evidence.bytes, retained.bytes.length);
  assert.equal(retained.evidence.id, reconciliationInteractionIdentity(input.attemptId, input.requestId).eventId);
  assert.deepEqual(await writer.readRecorded({ attemptId: input.attemptId, evidenceId: retained.evidence.id }), retained);
  await writer.publish(event); assert.deepEqual(await writer.read(input), retained);
  await assert.rejects(writer.publish({ ...event, receivedAt: '2026-10-03T12:00:03.000Z' }), /different content/);
  assert.deepEqual(await writer.read(input), retained);
  await assert.rejects(writer.readRecorded({ attemptId: input.attemptId, evidenceId: '/unselected/local/path' }), /identity/);
  const other = { attemptId: 'attempt:other', requestId: 'request:other' };
  const linkId = reconciliationInteractionIdentity(other.attemptId, other.requestId).eventId;
  await symlink(join(f.workspaceRoot, 'README.md'), join(f.preparationRoot, 'reconciliation-browser-interactions', linkId + '.json'));
  await assert.rejects(writer.read(other));
  assert.equal(await readFile(join(f.workspaceRoot, 'README.md'), 'utf8'), 'Retained local verification.\n');
  const interactions = join(f.preparationRoot, 'reconciliation-browser-interactions');
  await rename(interactions, join(f.preparationRoot, 'preserved-original-interactions'));
  await mkdir(interactions);
  await assert.rejects(writer.read(input), /storage changed/);
  assert.deepEqual(await readdir(interactions), []);
});

test('browser confirmation records exact retained local intent and replay without task or source effects', async (t) => {
  const f = await fixture(t); const original = reconciliationRequest('v1', 'browser-actual-record');
  const attempt = await f.reconciliationStore.createAttempt({ idempotencyKey: 'browser-actual-record', observation: original.observation, plan: original.plan });
  const projection = projectRetainedReconciliationReview(attempt); assert.equal(projection.complete, true);
  const config = await browserReconciliationConfig(f, [{ attemptId: attempt.id, reviewSha256: projection.sha256! }]);
  const writer = await createDashboardReconciliationInteractionWriter(config);
  let drift = false; let bindingReads = 0;
  const facade = new MergeReconciliationDashboard(f.reconciliationStore, { async readCurrentBinding({ expected }) { bindingReads++; return drift ? { ...expected, revision: 'drift' } : expected; } }, { browserReview: config.reconciliation!.browserReview, interactionWriter: writer });
  const controller = new DashboardController({ config, store: f.store, runtime: f.runtime, bridgePath: f.bridgePath, finalizerPath: join(f.root, 'finalizer.ts'), archonHome: f.archonHome, reconciliation: facade, readNative: async () => { throw new Error('No native launch selected.'); } });
  const server = await startTaskViewServer({ runtime: f.runtime, controller, archonBaseUrl: 'http://127.0.0.1:3091', port: 0 });
  t.after(() => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const dashboard = await (await fetch(base + '/api/dashboard')).json() as { csrfToken: string };
  const headers = { origin: base, 'content-type': 'application/json', 'x-temari-token': dashboard.csrfToken };
  const encoded = encodeURIComponent(attempt.id); const post = async (action: string, input: unknown) => {
    const response = await fetch(`${base}/api/reconciliation/${encoded}/${action}`, { method: 'POST', headers, body: JSON.stringify(input) });
    return { status: response.status, body: await response.json() as any };
  };
  const beforeTask = await f.runtime.listSnapshots(); const beforeSource = await readFile(join(f.workspaceRoot, 'README.md'));
  const review = await (await fetch(`${base}/api/reconciliation/${encoded}/review`)).json() as any;
  assert.equal(review.review.sha256, projection.sha256); assert.equal(review.currentBinding.state, 'not-checked');
  const request = { requestId: 'actual-local-request', reviewSha256: projection.sha256 };
  const bad = await post('confirm-reviewed', { ...request, confirmedBy: 'browser-human', confirmedAt: 'invented', evidence: [] }); assert.equal(bad.status, 400);
  assert.equal(await writer.read({ attemptId: attempt.id, requestId: request.requestId }), null);
  const mismatch = await post('confirm-reviewed', { ...request, reviewSha256: '0'.repeat(64) }); assert.equal(mismatch.body.outcome, 'refused');
  const recorded = await post('confirm-reviewed', request); assert.equal(recorded.status, 200); assert.equal(recorded.body.outcome, 'recorded');
  assert.equal(recorded.body.review.confirmation.actorKind, 'local-dashboard-interaction'); assert.equal(recorded.body.review.confirmation.requestId, request.requestId);
  assert.equal(recorded.body.review.attempt.candidate.readiness, 'not-ready'); assert.equal(recorded.body.review.effects.terminal, false);
  const retained = (await writer.read({ attemptId: attempt.id, requestId: request.requestId }))!;
  const event = JSON.parse(Buffer.from(retained.bytes).toString()); assert.equal(event.receivedAt, recorded.body.review.confirmation.confirmedAt); assert.equal(event.actorKind, 'local-dashboard-interaction');
  assert.equal(recorded.body.review.confirmation.evidence[0].sha256, createHash('sha256').update(retained.bytes).digest('hex'));
  assert.equal(bindingReads, 2);
  const replay = await post('confirm-reviewed', request); assert.equal(replay.body.outcome, 'replayed'); assert.deepEqual(replay.body.review.confirmation, recorded.body.review.confirmation);
  assert.deepEqual(await writer.read({ attemptId: attempt.id, requestId: request.requestId }), retained);
  const readback = await (await fetch(`${base}/api/reconciliation/${encoded}/review`)).json() as any; assert.equal(readback.confirmation.requestId, request.requestId);
  drift = true;
  const checked = await post('check-current-binding', {}); assert.equal(checked.status, 200); assert.equal(checked.body.currentBinding.state, 'drift'); assert.equal(checked.body.attempt.retainedStatus, 'BLOCKED'); assert.equal(Object.hasOwn(checked.body, 'state'), false); assert.equal(checked.body.confirmation.requestId, request.requestId);
  assert.deepEqual(await f.runtime.listSnapshots(), beforeTask); assert.deepEqual(await readFile(join(f.workspaceRoot, 'README.md')), beforeSource); assert.equal(f.counts().starts, 0);
});


test('new browser binding check excludes unselected legacy text while invalidate retains its old DTO', async (t) => {
  const f = await fixture(t); const request = reconciliationRequest('safe-check', 'safe-check');
  request.observation.revision = 'private-revision-do-not-project'; request.plan.revision = request.observation.revision;
  const attempt = await f.reconciliationStore.createAttempt({ idempotencyKey: 'safe-check', observation: request.observation, plan: request.plan });
  const body = await f.controller.reconciliationCheckCurrentBinding(attempt.id, {}) as any;
  assert.equal(body.review.payload, null); assert.equal(body.review.sha256, null); assert.equal(body.currentBinding.state, 'matched');
  for (const legacyField of ['revision', 'taskVersion', 'observationId', 'blockedReason', 'state']) assert.equal(Object.hasOwn(body, legacyField), false);
  assert.equal(JSON.stringify(body).includes('private-revision-do-not-project'), false);
  const legacy = await f.controller.reconciliationInvalidate(attempt.id, {}) as any;
  assert.equal(legacy.revision, request.observation.revision); assert.equal(legacy.state, 'awaiting-confirmation');
  assert.equal(Object.hasOwn(legacy, 'currentBinding'), false);
  const token = (await (await fetch(f.base + '/api/dashboard')).json() as { csrfToken: string }).csrfToken;
  const headers = { origin: f.base, 'content-type': 'application/json', 'x-temari-token': token };
  const current = await fetch(`${f.base}/api/reconciliation/${encodeURIComponent(attempt.id)}/check-current-binding`, { method: 'POST', headers, body: '{}' });
  assert.equal(current.status, 200); assert.equal(JSON.stringify(await current.json()).includes('private-revision-do-not-project'), false);
  const refused = await fetch(`${f.base}/api/reconciliation/${encodeURIComponent(attempt.id)}/check-current-binding`, { method: 'POST', headers, body: JSON.stringify({ current: {}, revision: '/caller/path' }) });
  assert.equal(refused.status, 400);
});


test('worker configuration validates provider identity, requires Claude server pin, and refuses transport changes on retry', async (t) => {
  const f = await fixture(t, true);
  const selection = { provider: 'claude-code', executableSha256: '1'.repeat(64), executableVersion: '2.1.296 (Claude Code)', model: 'qwen3-coder:30b', policy: 'temari-scoped-tools-v1' };
  const pin = { path: join(f.workspaceRoot, 'server.mjs'), sha256: '2'.repeat(64) };
  const changed: any = structuredClone(f.config);
  changed.implementation.providerSelection = { ...selection, provider: 'unknown' };
  await assert.rejects(validateDashboardConfig(changed), /Unsupported worker provider/);
  changed.implementation.providerSelection = selection;
  await assert.rejects(validateDashboardConfig(changed), /pinned scoped worker tool server/);
  changed.implementation.scopedToolServer = pin;
  const validated = await validateDashboardConfig(changed);
  assert.deepEqual(validated.implementation?.providerSelection, selection);
  assert.deepEqual(validated.implementation?.scopedToolServer, pin);
  const request = { requestId: 'transport-pins', mode: 'implementation', planId: 'two-parts', title: 'Pinned host', goal: 'Retain the admitted provider.' };
  await f.controller.create(request);
  f.config.implementation!.providerSelection = selection as any;
  f.config.implementation!.scopedToolServer = pin;
  await assert.rejects(f.controller.create(request), /plan changed/);
});
