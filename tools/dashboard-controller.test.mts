import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  TaskRuntime,
  taskDigest,
} from '../libs/runtime/src/index.js';
import {
  DashboardController,
  validateDashboardConfig,
} from './dashboard-controller.mjs';
import { startTaskViewServer } from './task-view.mjs';

const run = promisify(execFile);
async function fixture(t: TestContext) {
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
    runtime,
    controller,
    post,
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
  };
}

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
  const config = await validateDashboardConfig({
    ...f.config,
    swarm: {
      executable: process.execPath,
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
