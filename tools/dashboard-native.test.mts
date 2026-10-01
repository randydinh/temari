import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { DEFAULT_STAGES } from '../libs/contracts/src/index.js';
import {
  ArchonHarness,
  installArchonRuntime,
} from '../libs/archon-harness/src/index.js';
import { FileTaskStore, TaskRuntime } from '../libs/runtime/src/index.js';
import { platformInfo } from '../packages/initializer/src/lib/platform.js';
import {
  DashboardController,
  validateDashboardConfig,
} from './dashboard-controller.mjs';
import { startTaskViewServer } from './task-view.mjs';

const run = promisify(execFile);
test(
  'real HTTP goal survives restart, resumes the exact native run, and verifies evidence before acceptance',
  { timeout: 120_000, skip: process.platform === 'win32' },
  async (t) => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'temari-dashboard-native-')),
    );
    let passed = false;
    t.after(async () => {
      if (passed) await rm(root, { recursive: true, force: true });
      else console.error(`Native dashboard evidence retained: ${root}`);
    });
    const workspaceRoot = join(root, 'workspace');
    const preparationRoot = join(root, 'preparations');
    const archonHome = join(root, 'archon');
    for (const path of [workspaceRoot, preparationRoot, archonHome])
      await mkdir(path);
    await writeFile(
      join(workspaceRoot, 'README.md'),
      'dashboard verification target\n',
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
        'native fixture',
      ],
    ])
      await run('git', args, { cwd: workspaceRoot });
    const native = await installArchonRuntime({
      cacheDirectory: platformInfo().cacheDirectory,
      platform: process.platform,
      arch: process.arch,
    });
    const bridgePath = resolve(
      'packages/workflow-runtime/assets/v4.1/integrations/archon/canonical-bridge.ts',
    );
    const finalizerPath = resolve(
      'libs/archon-harness/src/lib/canonical-finalize.ts',
    );
    const environment = {
      ...process.env,
      ARCHON_HOME: archonHome,
      PATH: `${dirname(process.execPath)}:/opt/homebrew/bin:${process.env.PATH}`,
      DO_NOT_TRACK: '1',
      CLAUDE_BIN_PATH: '/usr/bin/false',
    };
    const harness = new ArchonHarness({
      runtime: native,
      workflowSource: dirname(bridgePath),
      environment,
    });
    await harness.verifyRuntime();
    const store = await FileTaskStore.create(join(root, 'tasks'));
    const runtime = new TaskRuntime({
      store,
      selection: {
        hostHarness: harness,
        configuredHarness: null,
        managedDefault: null,
      },
    });
    const readyPath = join(root, 'dependency-ready');
    const config = await validateDashboardConfig({
      schema: 1,
      workspaceRoot,
      preparationRoot,
      recipes: [
        {
          id: 'native-check',
          title: 'Verify the local target',
          goal: 'Check that the pinned workspace retains the expected README across every canonical stage.',
          stages: Object.fromEntries(
            DEFAULT_STAGES.map((stage) => [
              stage,
              {
                executable: process.execPath,
                args: [
                  '-e',
                  (stage === 'plan'
                    ? `require('node:assert/strict')(require('node:fs').existsSync(${JSON.stringify(readyPath)}), 'External dependency not ready');`
                    : '') +
                    'const fs=require("node:fs");const assert=require("node:assert/strict");assert.equal(fs.readFileSync("README.md","utf8"),"dashboard verification target\\n");console.log("README content verified: "+process.env.TEMARI_STAGE)',
                ],
                timeoutMs: 5000,
                summary: `${stage}: README content verified`,
              },
            ]),
          ),
        },
      ],
    });
    const controllerFor = (store: FileTaskStore, runtime: TaskRuntime) =>
      new DashboardController({
        config,
        store,
        runtime,
        bridgePath,
        finalizerPath,
        archonHome,
        readNative: async (reference) =>
          JSON.parse(
            (
              await run(
                native.executablePath,
                ['workflow', 'get', reference.externalRunId, '--json'],
                {
                  cwd: workspaceRoot,
                  env: environment,
                  maxBuffer: 2 * 1024 * 1024,
                },
              )
            ).stdout,
          ),
      });
    let server = await startTaskViewServer({
      runtime,
      controller: controllerFor(store, runtime),
      archonBaseUrl: 'http://127.0.0.1:3091',
      port: 0,
    });
    const stop = async () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      });
    t.after(stop);
    let base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    let token = (
      (await (await fetch(base + '/api/dashboard')).json()) as {
        csrfToken: string;
      }
    ).csrfToken;
    const post = async (path: string, body: unknown) => {
      const response = await fetch(base + path, {
        method: 'POST',
        headers: {
          origin: base,
          'content-type': 'application/json',
          'x-temari-token': token,
        },
        body: JSON.stringify(body),
      });
      const value: any = await response.json();
      assert.equal(response.status, 200, JSON.stringify(value));
      return value;
    };
    let task = await post('/api/tasks', {
      requestId: 'native',
      recipeId: 'native-check',
    });
    task = await post('/api/tasks/task-native/actions', {
      action: 'start',
      requestId: 'start',
      expectedVersion: task.version,
    });
    const nativeId = task.runs[0].nativeRef.externalRunId;
    await post('/api/tasks/task-native/actions', {
      action: 'start',
      requestId: 'start',
      expectedVersion: 2,
    });
    await stop();
    const reopenedStore = await FileTaskStore.openExisting(join(root, 'tasks'));
    const reopenedRuntime = new TaskRuntime({
      store: reopenedStore,
      selection: {
        hostHarness: harness,
        configuredHarness: null,
        managedDefault: null,
      },
    });
    server = await startTaskViewServer({
      runtime: reopenedRuntime,
      controller: controllerFor(reopenedStore, reopenedRuntime),
      archonBaseUrl: 'http://127.0.0.1:3091',
      port: 0,
    });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    token = (
      (await (await fetch(base + '/api/dashboard')).json()) as {
        csrfToken: string;
      }
    ).csrfToken;
    let resumed = false;
    for (let count = 0; count < 100; count++) {
      task = await post('/api/tasks/task-native/actions', {
        action: 'observe',
        requestId: `observe-${count}`,
        expectedVersion: task.version,
      });
      if (task.runs[0].nativeSnapshot?.status === 'SUCCEEDED') break;
      if (task.runs[0].nativeSnapshot?.status === 'FAILED') {
        assert.equal(resumed, false, 'Resumed native run failed again.');
        await writeFile(readyPath, 'ready');
        task = await post('/api/tasks/task-native/actions', {
          action: 'resume',
          requestId: 'resume',
          expectedVersion: task.version,
        });
        assert.equal(task.runs[0].nativeRef.externalRunId, nativeId);
        resumed = true;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    assert.equal(resumed, true);
    assert.equal(task.runs[0].nativeRef.externalRunId, nativeId);
    assert.equal(task.status, 'NEEDS_REVIEW');
    assert.equal(task.evidence.verified, true);
    assert.equal(task.semanticAcceptance, false);
    task = await post('/api/tasks/task-native/actions', {
      action: 'verify',
      requestId: 'verify',
      expectedVersion: task.version,
    });
    const view: any = await (await fetch(base + '/api/dashboard')).json();
    assert.equal(view.config.controls['task-native'].progress.length, 6);
    task = await post('/api/tasks/task-native/actions', {
      action: 'accept',
      requestId: 'accept',
      expectedVersion: task.version,
      reason:
        'Reviewed the retained output: every stage verified the expected README in the pinned workspace.',
    });
    assert.equal(task.status, 'DONE');
    assert.equal(task.semanticAcceptance, true);
    const fresh = await new TaskRuntime({
      store: await FileTaskStore.openExisting(join(root, 'tasks')),
    }).snapshot('task-native');
    assert.equal(fresh.status, 'DONE');
    console.log(
      JSON.stringify({
        nativeRunId: nativeId,
        stages: task.runSnapshots[0].stages.length,
        status: task.status,
        restartRetained: true,
        resumedExactRun: resumed,
      }),
    );
    passed = true;
  },
);
