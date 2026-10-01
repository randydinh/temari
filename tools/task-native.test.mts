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
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  DEFAULT_STAGES,
  minimalPlan,
  type ExecutionHarness,
  type HarnessRunRef,
} from '../libs/contracts/src/index.js';
import {
  ArchonHarness,
  installArchonRuntime,
} from '../libs/archon-harness/src/index.js';
import { FileTaskStore, TaskRuntime } from '../libs/runtime/src/index.js';
import { platformInfo } from '../packages/initializer/src/lib/platform.js';
import { runTaskCommand } from './task-continuity.mjs';
import type { TaskSnapshot } from '../libs/runtime/src/index.js';

const runFile = promisify(execFile);
const nativeOptions = { timeout: 120_000, skip: process.platform === 'win32' };

async function nativeFixturePath(): Promise<string> {
  const inheritedPath = process.env.PATH ?? '';
  const candidates = [
    ...inheritedPath
      .split(delimiter)
      .filter(Boolean)
      .map((directory) => join(directory, 'bun')),
    join(homedir(), '.bun', 'bin', 'bun'),
    '/opt/homebrew/bin/bun',
    '/usr/local/bin/bun',
  ];
  for (const candidate of new Set(candidates)) {
    try {
      const executable = await realpath(candidate);
      const { stdout } = await runFile(executable, ['--version']);
      if (!/^\d+\.\d+\.\d+/.test(stdout.trim())) continue;
      return [
        dirname(process.execPath),
        dirname(executable),
        inheritedPath,
      ].join(delimiter);
    } catch {
      // Desktop Node launchers can omit a locally installed Bun from PATH.
    }
  }
  throw new Error(
    'Native task evidence fixture requires Bun on PATH or in a standard installation location.',
  );
}

test(
  'native Archon evidence joins a logical task and survives a fresh session',
  nativeOptions,
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'temari-task-native-evidence-'));
    let passed = false;
    t.after(async () => {
      if (passed) await rm(root, { recursive: true, force: true });
      else console.error(`Native task evidence retained: ${root}`);
    });
    const native = await installArchonRuntime({
      cacheDirectory: platformInfo().cacheDirectory,
      platform: process.platform,
      arch: process.arch,
    });
    const workspaceRoot = resolve('.');
    const bridgePath = resolve(
      'packages/workflow-runtime/assets/v4.1/integrations/archon/canonical-bridge.ts',
    );
    const finalizerPath = resolve(
      'libs/archon-harness/src/lib/canonical-finalize.ts',
    );
    const archonHome = join(root, 'archon');
    const plan = minimalPlan('investigation');
    const runId = 'evidence-run';
    const revision = (
      await runFile('git', ['rev-parse', 'HEAD'], { cwd: workspaceRoot })
    ).stdout.trim();
    const specPath = join(root, 'spec.json');
    await writeFile(
      specPath,
      JSON.stringify({
        schema: 1,
        runId,
        revision,
        repositoryRoot: workspaceRoot,
        plan,
        stages: Object.fromEntries(
          DEFAULT_STAGES.map((stage) => [
            stage,
            {
              executable: process.execPath,
              args: [
                '-e',
                'process.stdout.write(process.env.TEMARI_STAGE + "\\n")',
              ],
              timeoutMs: 3000,
              summary: `${stage} fixture complete`,
            },
          ]),
        ),
      }),
    );
    const harness = new ArchonHarness({
      runtime: native,
      workflowSource: dirname(bridgePath),
      environment: {
        ARCHON_HOME: archonHome,
        LOG_LEVEL: 'error',
        DO_NOT_TRACK: '1',
        CLAUDE_BIN_PATH: '/usr/bin/false',
        PATH: await nativeFixturePath(),
      },
    });
    const selected: ExecutionHarness = {
      id: harness.id,
      version: harness.version,
      start: (request) =>
        harness.startCanonical(request, {
          specPath,
          bridgePath,
          finalizerPath,
        }),
      status: (ref) => harness.status(ref),
      resume: (ref) => harness.resume(ref),
      cancel: (ref) => harness.cancel(ref),
      verifyRunIdentity: (ref) => harness.verifyRunIdentity(ref),
    };
    const storeRoot = join(root, 'tasks');
    const store = await FileTaskStore.create(storeRoot);
    await store.createTask({
      taskId: 'native-proof',
      title: 'Native task proof',
      goal: 'Retain one goal through native execution and acceptance',
      workspaceRoot,
      actor: 'temari',
      idempotencyKey: 'create',
    });
    await store.bindRun({
      taskId: 'native-proof',
      actor: 'temari',
      idempotencyKey: 'bind',
      expectedVersion: 1,
      run: {
        runId,
        revision,
        plan,
        sourceRefs: [
          {
            sourceId: 'synthetic-source',
            publicationId: 'fixture-v1',
            location: 'fixture://native-task-proof',
          },
        ],
      },
    });
    const runtime = new TaskRuntime({
      store,
      selection: {
        hostHarness: selected,
        configuredHarness: null,
        managedDefault: null,
      },
    });
    let snapshot = await runtime.dispatch({
      taskId: 'native-proof',
      runId,
      actor: 'temari',
      idempotencyKey: 'start',
      expectedVersion: 2,
      entrypoint: 'temari-nx-canonical',
      inputs: {},
    });
    const reference = snapshot.runs[0]!.nativeRef!;
    t.after(async () => {
      if (!passed) {
        const status = await harness.status(reference);
        if (['RUNNING', 'QUEUED'].includes(status.status))
          await harness.cancel(reference);
      }
    });
    let status = await harness.status(reference);
    for (
      let count = 0;
      count < 100 && ['RUNNING', 'QUEUED'].includes(status.status);
      count++
    ) {
      await new Promise((done) => setTimeout(done, 400));
      status = await harness.status(reference);
    }
    assert.equal(status.status, 'SUCCEEDED', status.summary);
    snapshot = await runtime.observeNative({
      taskId: 'native-proof',
      runId,
      actor: 'temari',
      idempotencyKey: 'observe',
      expectedVersion: snapshot.version,
    });
    assert.notEqual(snapshot.status, 'DONE');
    assert.equal(snapshot.evidence.verified, false);
    const nativeRecord = JSON.parse(
      (
        await runFile(
          native.executablePath,
          ['workflow', 'get', reference.externalRunId, '--json'],
          {
            cwd: workspaceRoot,
            env: { ...process.env, ARCHON_HOME: archonHome },
          },
        )
      ).stdout,
    );
    const canonical = join(
      nativeRecord.output_root,
      'artifacts',
      'runs',
      reference.externalRunId,
      'temari-nx-canonical',
    );
    const marker = JSON.parse(
      await readFile(join(canonical, 'completion.json'), 'utf8'),
    );
    assert.equal(marker.nativeRunId, reference.externalRunId);
    await store.attachEvidenceRoots({
      taskId: 'native-proof',
      runId,
      actor: 'temari',
      idempotencyKey: 'evidence-location',
      expectedVersion: snapshot.version,
      receiptRoot: join(canonical, 'receipts'),
      evidenceRoot: join(canonical, 'evidence'),
    });
    snapshot = await runtime.snapshot('native-proof');
    assert.equal(snapshot.status, 'NEEDS_REVIEW');
    assert.equal(snapshot.evidence.verified, true);
    const acceptPath = join(root, 'accept.json');
    await writeFile(
      acceptPath,
      JSON.stringify({
        taskId: 'native-proof',
        runId,
        actor: 'temari',
        idempotencyKey: 'accept',
        expectedVersion: snapshot.version,
        reason:
          'Coordinator accepts only the deterministic six-stage fixture result.',
      }),
    );
    snapshot = (await runTaskCommand([
      'accept',
      '--root',
      storeRoot,
      '--input',
      acceptPath,
      '--archon-home',
      archonHome,
    ])) as TaskSnapshot;
    assert.equal(snapshot.status, 'DONE');
    const reopened = await new TaskRuntime({
      store: await FileTaskStore.openExisting(storeRoot),
    }).snapshot('native-proof');
    assert.equal(reopened.status, 'DONE');
    assert.equal(
      reopened.runs[0]!.nativeRef!.externalRunId,
      reference.externalRunId,
    );
    assert.equal(reopened.runSnapshots[0]!.stages.length, 6);
    assert.equal(reopened.runs[0]!.sourceRefs![0]!.publicationId, 'fixture-v1');
    console.log(`Native task evidence verified: ${reference.externalRunId}`);
    passed = true;
  },
);

test(
  'native exact-run resume and cancellation retain task control history',
  nativeOptions,
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'temari-task-native-controls-'));
    let passed = false;
    const native = await installArchonRuntime({
      cacheDirectory: platformInfo().cacheDirectory,
      platform: process.platform,
      arch: process.arch,
    });
    const archonHome = join(root, 'archon');
    const workflowSource = join(root, 'source');
    await mkdir(join(workflowSource, '.archon', 'workflows'), {
      recursive: true,
    });
    const markerPath = join(root, 'first-attempt');
    const script = join(root, 'fail-once.cjs');
    await writeFile(
      script,
      `const fs=require('node:fs');if(!fs.existsSync(${JSON.stringify(markerPath)})){fs.writeFileSync(${JSON.stringify(markerPath)},'seen');process.exit(1)}process.stdout.write('resumed exact fixture');`,
    );
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const prepareScript = `require('node:fs').writeFileSync(${JSON.stringify(join(root, 'completed-prepare'))}, 'retained', {flag:'wx'});process.stdout.write('prepare complete');`;
    await writeFile(
      join(workflowSource, '.archon', 'workflows', 'task-controls.yaml'),
      `name: task-controls\ndescription: Deterministic task control fixture\ninputs:\n  temari_binding:\n    required: false\nnodes:\n  - id: prepare\n    bash: ${JSON.stringify(`${quote(process.execPath)} -e ${quote(prepareScript)}`)}\n  - id: once\n    depends_on: [prepare]\n    bash: ${JSON.stringify(`${quote(process.execPath)} ${quote(script)}`)}\n`,
    );
    await writeFile(
      join(workflowSource, '.archon', 'workflows', 'task-cancel.yaml'),
      `name: task-cancel\ndescription: Cancellable deterministic task fixture\ninputs:\n  temari_binding:\n    required: false\nnodes:\n  - id: wait\n    bash: ${JSON.stringify(`${quote(process.execPath)} -e ${quote('setTimeout(()=>{},60000)')}`)}\n`,
    );
    const harness = new ArchonHarness({
      runtime: native,
      workflowSource,
      environment: {
        ARCHON_HOME: archonHome,
        LOG_LEVEL: 'error',
        DO_NOT_TRACK: '1',
      },
    });
    const refs: HarnessRunRef[] = [];
    t.after(async () => {
      for (const ref of refs) {
        const status = await harness.status(ref);
        if (['RUNNING', 'QUEUED'].includes(status.status))
          await harness.cancel(ref);
      }
      if (passed) await rm(root, { recursive: true, force: true });
      else console.error(`Native controls evidence retained: ${root}`);
    });
    const store = await FileTaskStore.create(join(root, 'tasks'));
    let lostReference: HarnessRunRef | undefined;
    const recoverableHarness: ExecutionHarness = {
      id: harness.id,
      version: harness.version,
      async start(request) {
        const reference = await harness.start(request);
        if (request.runId === 'cancel-proof') {
          lostReference = reference;
          refs.push(reference);
          throw new Error('Simulated response loss after native launch');
        }
        return reference;
      },
      status: (ref) => harness.status(ref),
      verifyRunIdentity: (ref) => harness.verifyRunIdentity(ref),
      resume: (ref) => harness.resume(ref),
      cancel: (ref) => harness.cancel(ref),
    };
    const runtime = new TaskRuntime({
      store,
      selection: {
        hostHarness: recoverableHarness,
        configuredHarness: null,
        managedDefault: null,
      },
    });
    for (const [taskId, entrypoint] of [
      ['resume-proof', 'task-controls'],
      ['cancel-proof', 'task-cancel'],
    ] as const) {
      await store.createTask({
        taskId,
        title: taskId,
        goal: 'Observe exact native control',
        workspaceRoot: resolve('.'),
        actor: 'temari',
        idempotencyKey: 'create',
      });
      await store.bindRun({
        taskId,
        actor: 'temari',
        idempotencyKey: 'bind',
        expectedVersion: 1,
        run: {
          runId: taskId,
          revision: 'fixture-v1',
          plan: minimalPlan('investigation'),
        },
      });
      const dispatch = {
        taskId,
        runId: taskId,
        actor: 'temari',
        idempotencyKey: 'start',
        expectedVersion: 2,
        entrypoint,
        inputs: {},
      };
      let snapshot: TaskSnapshot;
      if (taskId === 'cancel-proof') {
        await assert.rejects(
          runtime.dispatch(dispatch),
          /Simulated response loss/,
        );
        snapshot = await runtime.snapshot(taskId);
        assert.equal(snapshot.status, 'BLOCKED');
        assert(lostReference);
        const recovery = {
          taskId,
          runId: taskId,
          actor: 'temari',
          expectedVersion: snapshot.version,
          idempotencyKey: 'recover-exact-run',
          reference: lostReference,
        };
        await assert.rejects(
          runtime.reconcileNative({
            ...recovery,
            reference: {
              ...lostReference,
              externalRunId: refs[0]!.externalRunId,
            },
          }),
          /binding|identity|provenance/i,
        );
        assert.equal((await runtime.snapshot(taskId)).runs[0]!.nativeRef, null);
        snapshot = await runtime.reconcileNative(recovery);
      } else {
        snapshot = await runtime.dispatch(dispatch);
      }
      const reference = snapshot.runs[0]!.nativeRef!;
      if (!refs.some((ref) => ref.externalRunId === reference.externalRunId))
        refs.push(reference);
      let status = await harness.status(reference);
      if (taskId === 'resume-proof') {
        for (
          let count = 0;
          count < 100 && ['RUNNING', 'QUEUED'].includes(status.status);
          count++
        ) {
          await new Promise((done) => setTimeout(done, 200));
          status = await harness.status(reference);
        }
        assert.equal(status.status, 'FAILED', status.summary);
        snapshot = await runtime.observeNative({
          taskId,
          runId: taskId,
          actor: 'temari',
          idempotencyKey: 'failed',
          expectedVersion: snapshot.version,
        });
        snapshot = await runtime.resume({
          taskId,
          runId: taskId,
          actor: 'temari',
          idempotencyKey: 'resume',
          expectedVersion: snapshot.version,
        });
        assert.equal(
          snapshot.runs[0]!.nativeRef!.externalRunId,
          reference.externalRunId,
        );
        assert.equal(snapshot.runs[0]!.nativeSnapshot!.status, 'SUCCEEDED');
        assert.notEqual(snapshot.status, 'DONE');
      } else {
        for (
          let count = 0;
          count < 100 && status.status === 'QUEUED';
          count++
        ) {
          await new Promise((done) => setTimeout(done, 200));
          status = await harness.status(reference);
        }
        assert.equal(status.status, 'RUNNING', status.summary);
        snapshot = await runtime.cancel({
          taskId,
          runId: taskId,
          actor: 'temari',
          idempotencyKey: 'cancel',
          expectedVersion: snapshot.version,
        });
        assert.equal(snapshot.runs[0]!.nativeSnapshot!.status, 'CANCELLED');
        assert.equal(snapshot.status, 'CANCELLED');
      }
      assert.equal(snapshot.runs[0]!.operations.length, 2);
    }
    console.log(
      `Native exact-run control verified: ${refs.map((ref) => ref.externalRunId).join(', ')}`,
    );
    passed = true;
  },
);
