import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mkdtemp,
  mkdir,
  realpath,
  readFile,
  writeFile,
  rm,
  symlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  HOST_CAPABILITIES,
  type HarnessRunRef,
  type HarnessRunStatus,
} from '../libs/contracts/src/index.js';
import {
  createReviewedLocalCandidatePlan,
  REVIEWED_LOCAL_CANDIDATE_POLICY,
} from '../libs/temari-core/src/index.js';
import {
  FileTaskStore,
  FileChildTaskStore,
  TaskRuntime,
  taskDigest,
  FileWorkflowReceiptStore,
  FileEvidenceStore,
  executeAndPersist,
  type ReviewedLocalCandidateHarness,
  type ReviewedLocalCandidateCompletion,
} from '../libs/runtime/src/index.js';
import {
  DashboardController,
  validateDashboardConfig,
  type DashboardConfig,
} from './dashboard-controller.mjs';
import {
  parsePlannerPolicy,
  parseManagedCandidatePlannerPolicy,
} from './dashboard-planner.mjs';
import {
  validateManagedCandidateProfile,
  readManagedCandidatePreparation,
  createManagedCandidateHost,
  type ManagedCandidateHost,
  type DashboardManagedCandidateProfile,
} from './dashboard-managed-candidate.mjs';
import { createDashboardTalkTaskBridge } from './task-continuity.mjs';
import { createDashboardManagedObserver } from './dashboard-managed-observer.mjs';
const exec = promisify(execFile);
const sha = (b: Uint8Array | string) =>
  createHash('sha256').update(b).digest('hex');

async function fixture(t: TestContext) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'dashboard-managed-')),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = join(root, 'source'),
    preparationRoot = join(root, 'preparation'),
    evidenceRoot = join(root, 'evidence'),
    archonHome = join(root, 'archon');
  for (const p of [workspaceRoot, preparationRoot, evidenceRoot, archonHome])
    await mkdir(p);
  await writeFile(join(workspaceRoot, 'value.txt'), 'base');
  await exec('git', ['init', '-q'], { cwd: workspaceRoot });
  await exec('git', ['add', '.'], { cwd: workspaceRoot });
  await exec(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@localhost',
      'commit',
      '-qm',
      'base',
    ],
    { cwd: workspaceRoot },
  );
  const head = (
    await exec('git', ['rev-parse', 'HEAD'], { cwd: workspaceRoot })
  ).stdout.trim();
  const executable = join(root, 'planner'),
    bridgePath = join(root, 'bridge.mjs'),
    configPath = join(root, 'config.toml'),
    catalogPath = join(root, 'catalog.json');
  await writeFile(
    executable,
    `#!${process.execPath}
const fs=require('node:fs'),args=process.argv.slice(2);let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{if(args[args.indexOf('--model')+1]!=='fixture-model'||!args.includes('model_provider="openai"'))process.exit(8);fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({schema:1,title:'Literal feature',summary:'One coupled builder',assignments:[{slotId:'builder',goal:'Change value',acceptanceCriteria:['Changed value'],dependsOn:[]}],blockers:[]}));console.log('{}');});`,
    { mode: 0o700 },
  );
  for (const p of [bridgePath, configPath, catalogPath])
    await writeFile(p, 'fixture');
  const node = await realpath(process.execPath);
  const check = { program: node, args: ['--version'], timeoutMs: 1000 };
  const worker = (id: string, role: 'investigator' | 'reviewer') => ({
    id,
    role,
    required: true,
    brief: {
      goal: 'Read exact candidate',
      context: 'Fixture host brief',
      scope: 'value.txt',
      acceptanceCriteria: ['Literal result'],
      verificationCommand: null,
      reportFormat: 'json' as const,
      forbiddenActions: ['No publication'],
    },
  });
  const store = await FileTaskStore.create(join(root, 'tasks'));
  const protectedInputs = await Promise.all(
    [node, executable, configPath, catalogPath].map(async (path) => ({
      path,
      sha256: sha(await readFile(path)),
    })),
  );
  const profile: DashboardManagedCandidateProfile = {
    profile: 'reviewed-local-candidate-v1',
    policyId: 'coupled',
    taskStoreRoot: store.root,
    evidenceRoot,
    bridgePath,
    bridgeSha256: sha(await readFile(bridgePath)),
    bridgeRuntimeExecutable: node,
    bridgeRuntimeSha256: sha(await readFile(node)),
    executable,
    timeoutMs: 1000,
    providerSelection: {
      provider: 'codex',
      executableSha256: sha(await readFile(executable)),
      executableVersion: 'fixture-cli',
      model: 'fixture-model',
      reasoning: 'high',
    },
    modelAdmission: {
      configPath,
      configSha256: sha(await readFile(configPath)),
      catalogPath,
      catalogSha256: sha(await readFile(catalogPath)),
      parserExecutable: node,
      parserSha256: sha(await readFile(node)),
    },
    architect: worker('architect', 'investigator'),
    protectedInputs,
    baselineChecks: [check],
    acceptanceChecks: [check],
  };
  const policy = {
    profile: 'reviewed-local-candidate-v1' as const,
    id: 'coupled',
    title: 'Coupled builder',
    description: 'Bounded local candidate',
    slots: [
      {
        id: 'builder',
        title: 'Builder',
        description: 'Own literal file',
        owns: [{ kind: 'file' as const, path: 'value.txt' }],
        mandatoryCriteria: ['Literal value'],
      },
    ],
    prepare: [check],
    verify: [check],
    reviewer: worker('reviewer', 'reviewer'),
  };
  const config = await validateDashboardConfig({
    schema: 1,
    workspaceRoot,
    preparationRoot,
    recipes: [],
    planning: { executable, timeoutMs: 5000, policies: [policy] },
    managedCandidate: profile,
  });
  let launches = 0,
    generic = 0,
    readiness = 0,
    status: HarnessRunStatus = 'RUNNING',
    nativeRef: HarnessRunRef | undefined;
  let admissionRefusal = false,
    loseResponse = false,
    readinessMode: 'ready' | 'timeout' | 'pending-ready' = 'ready',
    verifyDrift = false,
    concurrent = false,
    identityDrift = false;
  let onStatus: (() => Promise<void>) | undefined;
  const harness: ReviewedLocalCandidateHarness = {
    id: 'fixture',
    version: '1',
    async start() {
      generic++;
      throw new Error('Generic start forbidden');
    },
    async startReviewedLocalCandidate(request, paths) {
      assert.equal(
        sha(await readFile(paths.specPath)),
        paths.expectedRequestSha256,
      );
      const task = (await store.list())[0]!;
      assert(
        task.runs[0]!.operations.some((op) => op.state === 'PENDING'),
        'Intent must precede native dispatch',
      );
      launches++;
      nativeRef = {
        schema: 1,
        harnessId: 'fixture',
        harnessVersion: '1',
        runId: request.runId,
        revision: request.revision,
        planSha256: taskDigest(request.plan),
        workspaceRoot: request.workspaceRoot,
        entrypoint: 'temari-reviewed-local-candidate',
        externalRunId: 'native-fixture',
        startedAt: new Date().toISOString(),
      };
      if (loseResponse) throw new Error('Lost managed response');
      return nativeRef;
    },
    async verifyRunIdentity(ref) {
      assert.deepEqual(ref, nativeRef);
    },
    async status(ref) {
      assert.deepEqual(ref, nativeRef);
      if (onStatus) {
        const callback = onStatus;
        onStatus = undefined;
        await callback();
      }
      return {
        status,
        summary: status,
        observedAt: new Date().toISOString(),
        rawLogPath: null,
      };
    },
    async resume() {
      throw new Error('No resume');
    },
    async cancel() {
      status = 'CANCELLED';
      return {
        status,
        summary: status,
        observedAt: new Date().toISOString(),
        rawLogPath: null,
      };
    },
  };
  const selection = {
    hostHarness: harness,
    configuredHarness: null,
    managedDefault: null,
  };
  const runtime = new TaskRuntime({ store, selection });
  const outputRoot = join(archonHome, 'output'),
    artifacts = join(outputRoot, 'artifacts', 'runs', 'native-fixture');
  await mkdir(artifacts, { recursive: true });
  let completion: ReviewedLocalCandidateCompletion | undefined;
  const host: ManagedCandidateHost = {
    selection,
    async admit(paths) {
      if (admissionRefusal) throw new Error('Fixture admission refusal');
      assert.equal(
        sha(await readFile(paths.specPath)),
        paths.expectedRequestSha256,
      );
    },
    async readiness(ref, options) {
      readiness++;
      assert.deepEqual(ref, nativeRef);
      assert.deepEqual(
        (await store.list())[0]!.runs[0]!.nativeRef,
        ref,
        'Publish native reference before readiness',
      );
      if (readinessMode === 'pending-ready')
        await options.onObservation({ attempt: 1, state: 'PENDING' });
      if (readinessMode === 'timeout') {
        await options.onObservation({ attempt: 1, state: 'PENDING' });
        throw new Error('Readiness timeout');
      }
      await options.onObservation({
        attempt: readinessMode === 'pending-ready' ? 2 : 1,
        state: 'READY',
      });
    },
    async verify() {
      assert(completion);
      if (verifyDrift) throw new Error('Completion drift');
      if (concurrent) {
        const task = (await store.list())[0]!;
        await store.updateTask({
          taskId: task.taskId,
          actor: 'fixture',
          idempotencyKey: 'concurrent',
          expectedVersion: task.version,
          nextAction: 'Changed concurrently',
        });
      }
      return completion;
    },
  };
  const controller = new DashboardController({
    config,
    store,
    runtime,
    bridgePath,
    finalizerPath: bridgePath,
    archonHome,
    managedCandidateHost: host,
    readNative: async (ref) => {
      const { externalRunId, startedAt, ...binding } = ref;
      return {
        id: identityDrift ? 'wrong-native' : externalRunId,
        workflow_name: ref.entrypoint,
        working_path: workspaceRoot,
        status,
        output_root: outputRoot,
        metadata: { inputs: { temari_binding: JSON.stringify(binding) } },
      };
    },
  });
  const bridge = await createDashboardTalkTaskBridge({
    talkConfig: { schema: 1, workspaceRoot } as any,
    dashboardConfig: config,
    controller,
    runtime,
  });
  assert(bridge);
  const intake = async () => {
    const { taskId } = await bridge.intake({
      requestId: 'accepted-goal',
      title: 'Literal change',
      goal: 'Change the literal file',
    });
    const deadline = Date.now() + 10000;
    do {
      const task = await runtime.snapshot(taskId),
        projection = await bridge.project({
          taskId,
          expectedVersion: task.version,
        });
      if (projection?.action?.action === 'prepare-plan')
        return { task, projection };
      await new Promise((r) => setTimeout(r, 25));
    } while (Date.now() < deadline);
    throw new Error('Fixture planner did not settle');
  };
  const prepare = async () => {
    const { task, projection } = await intake();
    return controller.action(task.taskId, {
      action: 'prepare-plan',
      requestId: 'prepare',
      expectedVersion: task.version,
      proposalSha256: projection.action!.proposalSha256,
    });
  };
  const publish = async () => {
    const task = (await runtime.listSnapshots())[0]!,
      run = task.runs[0]!;
    assert(run.nativeRef);
    const receipts = await FileWorkflowReceiptStore.create(
      join(artifacts, 'reviewed-local-candidate', 'receipts'),
    );
    const evidence = await FileEvidenceStore.create(
      join(artifacts, 'reviewed-local-candidate', 'evidence'),
    );
    const receipt = await executeAndPersist({
      runId: run.runId,
      revision: run.revision,
      plan: run.plan,
      capabilities: {
        host: 'fixture',
        available: ['subagents'],
        missing: HOST_CAPABILITIES.filter((x) => x !== 'subagents'),
        notes: { subagents: 'fixture' },
        provenance: {
          subagents: {
            status: 'proven',
            source: 'fixture',
            observedAt: new Date().toISOString(),
          },
        },
      },
      store: receipts,
      stageEvidence: { store: evidence },
      handler: async (stage) => ({
        status: 'PASS',
        summary: `Fixture ${stage}`,
        evidence: [
          { name: 'fixture', kind: 'verification', content: 'Fixture proof' },
        ],
      }),
    });
    const prepared = await readManagedCandidatePreparation({
      task,
      profile,
      preparationRoot,
    });
    assert(prepared);
    completion = {
      schema: 1,
      profile: 'reviewed-local-candidate-v1',
      status: 'PASS',
      taskId: task.taskId,
      binding: {
        runId: run.runId,
        nativeRunId: 'native-fixture',
        baseCommit: head,
        planSha256: run.planSha256,
        requestSha256: prepared.paths.expectedRequestSha256,
        policySha256: taskDigest(REVIEWED_LOCAL_CANDIDATE_POLICY),
      },
      candidate: {
        root: join(evidenceRoot, 'candidate'),
        commit: 'c'.repeat(40),
      },
      receiptSha256: taskDigest(receipt),
      scope: 'reviewed-local-candidate-only',
      publication: 'denied',
    };
    await writeFile(
      join(artifacts, 'reviewed-local-candidate', 'completion.json'),
      JSON.stringify(completion),
    );
    status = 'SUCCEEDED';
  };
  return {
    root,
    store,
    runtime,
    controller,
    bridge,
    config,
    profile,
    prepare,
    intake,
    publish,
    artifacts,
    host,
    setStatus(value: HarnessRunStatus) {
      status = value;
    },
    identityDrift() {
      identityDrift = true;
    },
    onStatus(callback: () => Promise<void>) {
      onStatus = callback;
    },
    restart() {
      return new DashboardController({
        config,
        store,
        runtime,
        bridgePath,
        finalizerPath: bridgePath,
        archonHome,
        managedCandidateHost: host,
        readNative: async (ref) => {
          const { externalRunId, startedAt, ...binding } = ref;
          return {
            id: externalRunId,
            workflow_name: ref.entrypoint,
            working_path: workspaceRoot,
            output_root: outputRoot,
            metadata: { inputs: { temari_binding: JSON.stringify(binding) } },
          };
        },
      });
    },
    get launches() {
      return launches;
    },
    get generic() {
      return generic;
    },
    get readiness() {
      return readiness;
    },
    get nativeRef() {
      return nativeRef!;
    },
    refuse() {
      admissionRefusal = true;
    },
    lost() {
      loseResponse = true;
    },
    pendingReady() {
      readinessMode = 'pending-ready';
    },
    timeout() {
      readinessMode = 'timeout';
    },
    drift() {
      verifyDrift = true;
    },
    concurrent() {
      concurrent = true;
    },
  };
}
test('one-builder profile does not weaken ordinary planner admission', async (t) => {
  const f = await fixture(t),
    p = f.config.planning!.policies[0]!;
  assert.equal(parseManagedCandidatePlannerPolicy(p).slots.length, 1);
  assert.throws(() => parsePlannerPolicy(p), /Unknown or missing/);
  const ordinary = { ...p };
  delete ordinary.profile;
  assert.throws(() => parsePlannerPolicy(ordinary), /two to four/);
  assert.throws(
    () =>
      parseManagedCandidatePlannerPolicy({
        ...p,
        slots: [...p.slots, ...p.slots],
      }),
    /exactly one/,
  );
});
test('Talk accepted goal prepares, launches once and retains exact reviewed result on same task', async (t) => {
  const f = await fixture(t);
  f.pendingReady();
  const task = await f.prepare();
  const projection = await f.bridge.project({
    taskId: task.taskId,
    expectedVersion: task.version,
  });
  assert.equal(projection!.state, 'PREPARED');
  assert.equal(projection!.action!.action, 'implementation-start');
  const request = {
    action: 'implementation-start',
    requestId: 'start',
    expectedVersion: task.version,
  };
  const running = await f.controller.action(task.taskId, request);
  assert.equal(running.status, 'RUNNING');
  assert.equal(f.launches, 1);
  assert.equal(f.generic, 0);
  assert.equal(f.readiness, 1);
  assert.deepEqual(await f.controller.action(task.taskId, request), running);
  assert.equal(f.launches, 1);
  await f.publish();
  const done = await f.controller.action(task.taskId, {
    action: 'observe',
    requestId: 'observe',
    expectedVersion: running.version,
  });
  assert.equal(done.status, 'NEEDS_REVIEW');
  assert.equal(done.semanticAcceptance, false);
  assert.match(done.handoff!.summary, /cccc/);
  assert.equal(done.handoff!.contextRefs[0]!.sha256!.length, 64);
  assert.equal((await f.runtime.listSnapshots()).length, 1);
  const finalProjection = await f.bridge.project({
    taskId: done.taskId,
    expectedVersion: done.version,
  });
  assert.match(finalProjection!.message!, /cccc/);
  assert.equal(finalProjection!.action, null);
  await assert.rejects(
    f.controller.action(task.taskId, {
      action: 'accept',
      requestId: 'accept',
      expectedVersion: done.version,
      reason: 'fixture',
    }),
    /generic acceptance is unavailable/,
  );
});
test('admission refusal launches zero native work and freezes preparation', async (t) => {
  const f = await fixture(t);
  const task = await f.prepare();
  f.refuse();
  await assert.rejects(
    f.controller.action(task.taskId, {
      action: 'implementation-start',
      requestId: 'start',
      expectedVersion: task.version,
    }),
    /admission refusal/,
  );
  assert.equal(f.launches, 0);
  assert.equal(
    (await f.runtime.snapshot(task.taskId)).runs[0]!.operations.length,
    0,
  );
  const prepared = await readManagedCandidatePreparation({
    task,
    profile: f.profile,
    preparationRoot: f.config.preparationRoot,
  });
  assert(prepared);
  await writeFile(prepared.paths.specPath, '{}');
  await assert.rejects(
    readManagedCandidatePreparation({
      task,
      profile: f.profile,
      preparationRoot: f.config.preparationRoot,
    }),
    /pin changed/,
  );
});
test('lost managed launch response is fenced and cannot relaunch', async (t) => {
  const f = await fixture(t),
    task = await f.prepare();
  f.lost();
  const request = {
    action: 'implementation-start',
    requestId: 'start',
    expectedVersion: task.version,
  };
  await assert.rejects(
    f.controller.action(task.taskId, request),
    /Lost managed response/,
  );
  await f.controller.action(task.taskId, request);
  assert.equal(f.launches, 1);
  const blocked = await f.runtime.snapshot(task.taskId);
  assert.equal(blocked.status, 'BLOCKED');
  assert.equal(blocked.runs[0]!.nativeRef, null);
  assert.equal(f.readiness, 0);
});
test('readiness timeout retains exact reference, diagnostics and blocker without relaunch', async (t) => {
  const f = await fixture(t),
    task = await f.prepare();
  f.timeout();
  const request = {
    action: 'implementation-start',
    requestId: 'start',
    expectedVersion: task.version,
  };
  await assert.rejects(
    f.controller.action(task.taskId, request),
    /Readiness timeout/,
  );
  const blocked = await f.runtime.snapshot(task.taskId);
  assert.equal(blocked.status, 'BLOCKED');
  assert.deepEqual(blocked.runs[0]!.nativeRef, f.nativeRef);
  await f.controller.action(task.taskId, request);
  assert.equal(f.launches, 1);
  assert.equal(f.readiness, 1);
});
for (const mode of ['drift', 'concurrent'] as const)
  test(`candidate ${mode} refuses result attachment`, async (t) => {
    const f = await fixture(t),
      task = await f.prepare();
    const running = await f.controller.action(task.taskId, {
      action: 'implementation-start',
      requestId: 'start',
      expectedVersion: task.version,
    });
    await f.publish();
    f[mode]();
    await assert.rejects(
      f.controller.action(task.taskId, {
        action: 'observe',
        requestId: 'observe',
        expectedVersion: running.version,
      }),
      mode === 'drift'
        ? /Completion drift/
        : /changed during candidate closeout/,
    );
    assert(
      !(await f.runtime.snapshot(task.taskId)).handoff?.contextRefs.some(
        (x) => x.kind === 'reviewed-local-candidate-completion',
      ),
    );
  });
test('root overlap and root aliases refuse preparation before effects', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    validateManagedCandidateProfile(
      { ...f.profile, evidenceRoot: f.config.workspaceRoot },
      f.config.workspaceRoot,
      f.config.preparationRoot,
    ),
    /roots overlap/,
  );
  const alias = join(f.root, 'alias');
  await symlink(f.profile.evidenceRoot, alias);
  await assert.rejects(
    validateManagedCandidateProfile(
      { ...f.profile, evidenceRoot: alias },
      f.config.workspaceRoot,
      f.config.preparationRoot,
    ),
    /alias refused/,
  );
});
test('generic dispatch cannot bypass managed admission', async (t) => {
  const f = await fixture(t),
    task = await f.prepare();
  await assert.rejects(
    f.runtime.dispatch({
      taskId: task.taskId,
      runId: task.currentRunId!,
      actor: 'fixture',
      expectedVersion: task.version,
      idempotencyKey: 'bypass',
      entrypoint: 'temari-reviewed-local-candidate',
      inputs: {},
    }),
    /route-specific admission/,
  );
  assert.equal(f.launches, 0);
  assert.equal(f.generic, 0);
});

test('concurrent duplicate start shares one native launch and one readiness gate', async (t) => {
  const f = await fixture(t),
    task = await f.prepare();
  const request = {
    action: 'implementation-start',
    requestId: 'start',
    expectedVersion: task.version,
  };
  await Promise.all([
    f.controller.action(task.taskId, request),
    f.controller.action(task.taskId, request),
  ]);
  assert.equal(f.launches, 1);
  assert.equal(f.readiness, 1);
  assert.equal((await f.runtime.snapshot(task.taskId)).status, 'RUNNING');
});

test('aliased future child-store ancestor is refused before source effects', async (t) => {
  const f = await fixture(t),
    { task, projection } = await f.intake();
  const snapshot = ((await f.controller.describe()) as any).controls[
    task.taskId
  ].planning;
  const runId = `run-goal-${taskDigest([snapshot.taskId, snapshot.requestId, snapshot.proposalSha256, snapshot.policySha256, snapshot.candidate]).slice(0, 48)}`;
  await symlink(f.config.workspaceRoot, join(f.profile.evidenceRoot, runId));
  await assert.rejects(
    f.controller.action(task.taskId, {
      action: 'prepare-plan',
      requestId: 'prepare',
      expectedVersion: task.version,
      proposalSha256: projection.action!.proposalSha256,
    }),
    /ancestor alias refused/,
  );
  await assert.rejects(
    readFile(join(f.config.workspaceRoot, 'children')),
    (e: any) => e.code === 'ENOENT',
  );
  assert.equal(f.launches, 0);
});

test('controller materialization and result verification ignore a shadow bun on PATH', async (t) => {
  const f = await fixture(t),
    marker = join(f.root, 'bridge-invocations'),
    shadowMarker = join(f.root, 'shadow-invocations');
  const bridge = `import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';const args=process.argv.slice(2),command=args[0];fs.appendFileSync(${JSON.stringify(marker)},command+'\\n');if(command==='admit'){const spec=fs.readFileSync(args[args.indexOf('--spec')+1]);console.log(JSON.stringify({requestSha256:crypto.createHash('sha256').update(spec).digest('hex')}));}else{const artifacts=args[args.indexOf('--artifacts')+1],completion=JSON.parse(fs.readFileSync(path.join(artifacts,'reviewed-local-candidate','completion.json')));console.log(JSON.stringify({status:'evidence-verified',candidate:completion.candidate,workers:completion.workers}));}\n`;
  await writeFile(f.profile.bridgePath, bridge);
  f.profile.bridgeSha256 = sha(bridge);
  f.config.managedCandidate!.bridgeSha256 = sha(bridge);
  const shadowRoot = join(f.root, 'shadow');
  await mkdir(shadowRoot);
  await writeFile(
    join(shadowRoot, 'bun'),
    `#!${f.profile.bridgeRuntimeExecutable}\nrequire('node:fs').writeFileSync(${JSON.stringify(shadowMarker)},'spoofed');console.log('{}');\n`,
    { mode: 0o700 },
  );
  const previousPath = process.env.PATH;
  process.env.PATH = `${shadowRoot}:${previousPath ?? ''}`;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });
  const host = createManagedCandidateHost(f.profile, f.host.selection);
  f.host.admit = host.admit;
  f.host.verify = host.verify;
  const task = await f.prepare();
  const prepared = await readManagedCandidatePreparation({
    task,
    profile: f.profile,
    preparationRoot: f.config.preparationRoot,
  });
  assert(prepared);
  const spec = JSON.parse(await readFile(prepared.paths.specPath, 'utf8'));
  assert.deepEqual(spec.bridgeRuntime, {
    executable: f.profile.bridgeRuntimeExecutable,
    sha256: f.profile.bridgeRuntimeSha256,
  });
  const running = await f.controller.action(task.taskId, {
    action: 'implementation-start',
    requestId: 'start',
    expectedVersion: task.version,
  });
  await f.publish();
  const reviewed = await f.controller.action(task.taskId, {
    action: 'observe',
    requestId: 'observe',
    expectedVersion: running.version,
  });
  assert.equal(reviewed.status, 'NEEDS_REVIEW');
  assert.equal(await readFile(marker, 'utf8'), 'admit\nadmit\nverify\n');
  await assert.rejects(
    readFile(shadowMarker),
    (error: any) => error.code === 'ENOENT',
  );
  await assert.rejects(
    host.admit({ ...prepared.paths, bridgeRuntimeExecutable: 'bun' }),
    /strictly equal/,
  );
  await assert.rejects(
    host.admit({ ...prepared.paths, bridgeRuntimeSha256: '0'.repeat(64) }),
    /strictly equal/,
  );
  const alias = join(f.root, 'runtime-alias');
  await symlink(f.profile.bridgeRuntimeExecutable, alias);
  await assert.rejects(
    validateManagedCandidateProfile(
      { ...f.profile, bridgeRuntimeExecutable: alias },
      f.config.workspaceRoot,
      f.config.preparationRoot,
    ),
    /alias refused/,
  );
  await assert.rejects(
    validateManagedCandidateProfile(
      { ...f.profile, bridgeRuntimeSha256: '0'.repeat(64) },
      f.config.workspaceRoot,
      f.config.preparationRoot,
    ),
    /pin changed/,
  );
  assert.equal(await readFile(marker, 'utf8'), 'admit\nadmit\nverify\n');
});

test('concurrent task change before dispatch launches zero native work and preserves metadata', async (t) => {
  const f = await fixture(t),
    task = await f.prepare(),
    admit = f.host.admit;
  f.host.admit = async (paths) => {
    await admit(paths);
    await f.store.updateTask({
      taskId: task.taskId,
      actor: 'fixture',
      idempotencyKey: 'changed-before-start',
      expectedVersion: task.version,
      nextAction: 'Concurrent edit',
    });
  };
  await assert.rejects(
    f.controller.action(task.taskId, {
      action: 'implementation-start',
      requestId: 'start',
      expectedVersion: task.version,
    }),
    /version conflict/,
  );
  const current = await f.runtime.snapshot(task.taskId);
  assert.equal(f.launches, 0);
  assert.equal(current.nextAction, 'Concurrent edit');
  assert.equal(current.blocker, null);
});

async function startManaged(f: Awaited<ReturnType<typeof fixture>>) {
  const task = await f.prepare();
  return f.controller.action(task.taskId, {
    action: 'implementation-start',
    requestId: 'start',
    expectedVersion: task.version,
  });
}

test('automatic host ticks settle a single launch and unchanged/replayed ticks do not append', async (t) => {
  const f = await fixture(t),
    running = await startManaged(f);
  for (let i = 0; i < 3; i++)
    assert.deepEqual(await f.controller.observeManagedCandidates(), {
      scanned: 1,
      issues: [],
    });
  assert.equal(
    (await f.runtime.snapshot(running.taskId)).version,
    running.version,
  );
  assert.equal(
    (await f.runtime.snapshot(running.taskId)).events.length,
    running.events.length,
  );
  await f.publish();
  const observer = createDashboardManagedObserver(f.controller);
  observer.start();
  await observer.stop();
  assert.deepEqual(observer.health().issues, []);
  const done = await f.runtime.snapshot(running.taskId);
  assert.equal(done.status, 'NEEDS_REVIEW');
  assert.equal(done.semanticAcceptance, false);
  assert.match(done.handoff!.summary, /cccc/);
  assert.deepEqual(await f.controller.observeManagedCandidates(), {
    scanned: 1,
    issues: [],
  });
  assert.equal(
    (await f.runtime.snapshot(running.taskId)).version,
    done.version,
  );
  assert.equal(f.launches, 1);
});

test('observer restart uses the exact retained reference and never relaunches', async (t) => {
  const f = await fixture(t),
    running = await startManaged(f);
  const restarted = f.restart();
  await f.publish();
  assert.deepEqual(await restarted.observeManagedCandidates(), {
    scanned: 1,
    issues: [],
  });
  assert.equal(
    (await f.runtime.snapshot(running.taskId)).status,
    'NEEDS_REVIEW',
  );
  assert.equal(f.launches, 1);
});

test('uncertain dispatch without a reference stays explicit recovery', async (t) => {
  const f = await fixture(t),
    task = await f.prepare();
  f.lost();
  await assert.rejects(
    f.controller.action(task.taskId, {
      action: 'implementation-start',
      requestId: 'start',
      expectedVersion: task.version,
    }),
    /Lost managed response/,
  );
  const before = await f.runtime.snapshot(task.taskId);
  assert.equal(before.runs[0]!.nativeRef, null);
  assert.deepEqual(await f.controller.observeManagedCandidates(), {
    scanned: 1,
    issues: [],
  });
  const after = await f.runtime.snapshot(task.taskId);
  assert.equal(after.version, before.version);
  assert.equal(after.blocker, before.blocker);
  assert.equal(f.launches, 1);
});

test('identity drift is an observation issue without task mutation', async (t) => {
  const f = await fixture(t),
    running = await startManaged(f);
  f.identityDrift();
  const tick = await f.controller.observeManagedCandidates();
  assert.match(tick.issues[0]!, /Native identity changed/);
  assert.equal(
    (await f.runtime.snapshot(running.taskId)).version,
    running.version,
  );
});

test('concurrent metadata edit defers an observation and converges next tick', async (t) => {
  const f = await fixture(t),
    running = await startManaged(f);
  f.setStatus('FAILED');
  f.onStatus(async () => {
    await f.store.updateTask({
      taskId: running.taskId,
      actor: 'fixture',
      expectedVersion: running.version,
      idempotencyKey: 'tick-edit',
      nextAction: 'Concurrent edit',
    });
  });
  assert.deepEqual(await f.controller.observeManagedCandidates(), {
    scanned: 1,
    issues: [],
  });
  assert.equal(
    (await f.runtime.snapshot(running.taskId)).runs[0]!.nativeSnapshot!.status,
    'RUNNING',
  );
  assert.deepEqual(await f.controller.observeManagedCandidates(), {
    scanned: 1,
    issues: [],
  });
  const failed = await f.runtime.snapshot(running.taskId);
  assert.equal(failed.runs[0]!.nativeSnapshot!.status, 'FAILED');
  assert.equal(failed.nextAction, 'Concurrent edit');
});

for (const terminal of ['FAILED', 'CANCELLED'] as const)
  test(`automatic ${terminal} writes once without result verification`, async (t) => {
    const f = await fixture(t),
      running = await startManaged(f);
    f.setStatus(terminal);
    let verifies = 0;
    f.host.verify = async () => {
      verifies++;
      throw new Error('must not verify');
    };
    await f.controller.observeManagedCandidates();
    const after = await f.runtime.snapshot(running.taskId);
    await f.controller.observeManagedCandidates();
    assert.equal(
      (await f.runtime.snapshot(running.taskId)).version,
      after.version,
    );
    assert.equal(after.runs[0]!.nativeSnapshot!.status, terminal);
    assert.equal(verifies, 0);
  });

test('automatic progress projects compact child counts without native output', async (t) => {
  const f = await fixture(t),
    running = await startManaged(f),
    run = running.runs[0]!;
  const children = await FileChildTaskStore.create(run.executionStoreRoot!);
  await children.create({
    taskId: 'child-progress',
    runId: run.runId,
    revision: run.revision,
    dependsOn: [],
    actor: 'fixture',
  });
  await children.ensureGroup({
    groupId: 'progress',
    runId: run.runId,
    revision: run.revision,
    taskIds: ['child-progress'],
    assignmentIds: ['builder'],
  });
  await children.claim({
    taskId: 'child-progress',
    owner: 'worker',
    leaseMs: 60000,
  });
  await f.controller.observeManagedCandidates();
  const described = (await f.controller.describe()) as any;
  assert.deepEqual(
    described.controls[running.taskId].managedCandidate.progress,
    [{ status: 'RUNNING', count: 1 }],
  );
  assert.match(
    described.controls[running.taskId].message,
    /Children: 1 running/,
  );
  assert.equal(
    (await f.runtime.snapshot(running.taskId)).version,
    running.version,
  );
});

test('host lifecycle starts immediately, avoids overlap, and stop awaits read without cancellation', async () => {
  let release!: () => void,
    calls = 0;
  const read = new Promise<void>((resolve) => {
    release = resolve;
  });
  const observer = createDashboardManagedObserver({
    async observeManagedCandidates() {
      calls++;
      await read;
      return { scanned: 2, issues: [] };
    },
  });
  observer.start();
  observer.start();
  assert.equal(calls, 1);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(calls, 1);
  let stopped = false;
  const stopping = observer.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  assert.equal(stopped, false);
  release();
  await stopping;
  assert.equal(calls, 1);
  assert.equal(observer.health().scanned, 2);
});

test('readiness refusal remains a blocker even when native work later succeeds', async (t) => {
  const f = await fixture(t),
    task = await f.prepare();
  f.timeout();
  await assert.rejects(
    f.controller.action(task.taskId, {
      action: 'implementation-start',
      requestId: 'start',
      expectedVersion: task.version,
    }),
    /Readiness timeout/,
  );
  const before = await f.runtime.snapshot(task.taskId);
  await f.publish();
  const tick = await f.controller.observeManagedCandidates();
  assert.deepEqual(tick.issues, []);
  const after = await f.runtime.snapshot(task.taskId);
  assert.equal(after.blocker, before.blocker);
  assert.equal(
    after.handoff?.contextRefs.some(
      (ref) => ref.kind === 'reviewed-local-candidate-completion',
    ) ?? false,
    false,
  );
  await f.store.updateTask({
    taskId: task.taskId,
    actor: 'fixture',
    expectedVersion: after.version,
    idempotencyKey: 'clear-readiness-text',
    blocker: null,
  });
  await f.controller.observeManagedCandidates();
  assert.equal(
    (await f.runtime.snapshot(task.taskId)).handoff?.contextRefs.some(
      (ref) => ref.kind === 'reviewed-local-candidate-completion',
    ) ?? false,
    false,
  );
});

test('result verification version conflict defers then converges idempotently', async (t) => {
  const f = await fixture(t),
    running = await startManaged(f);
  await f.publish();
  f.concurrent();
  const tick = await f.controller.observeManagedCandidates();
  assert.deepEqual(tick.issues, []);
  assert.equal(
    (await f.runtime.snapshot(running.taskId)).handoff?.contextRefs.some(
      (ref) => ref.kind === 'reviewed-local-candidate-completion',
    ) ?? false,
    false,
  );
  await f.controller.observeManagedCandidates();
  const after = await f.runtime.snapshot(running.taskId);
  assert.equal(after.status, 'NEEDS_REVIEW');
  assert.match(after.handoff!.summary, /cccc/);
  await f.controller.observeManagedCandidates();
  assert.equal(
    (await f.runtime.snapshot(running.taskId)).version,
    after.version,
  );
});

test('automatic observer does not finalize while launch readiness is in flight', async (t) => {
  const f = await fixture(t),
    task = await f.prepare();
  let entered!: () => void, release!: () => void;
  const readinessEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const readinessRelease = new Promise<void>((resolve) => {
    release = resolve;
  });
  const readiness = f.host.readiness;
  f.host.readiness = async (ref, options) => {
    entered();
    await readinessRelease;
    await readiness(ref, options);
  };
  const launching = f.controller.action(task.taskId, {
    action: 'implementation-start',
    requestId: 'start',
    expectedVersion: task.version,
  });
  await readinessEntered;
  await f.publish();
  const before = await f.runtime.snapshot(task.taskId);
  await f.controller.observeManagedCandidates();
  assert.equal((await f.runtime.snapshot(task.taskId)).version, before.version);
  release();
  await launching;
  await f.controller.observeManagedCandidates();
  assert.equal((await f.runtime.snapshot(task.taskId)).status, 'NEEDS_REVIEW');
  assert.equal(f.launches, 1);
});
