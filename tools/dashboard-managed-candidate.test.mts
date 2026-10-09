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
  type ManagedCandidateHost,
  type DashboardManagedCandidateProfile,
} from './dashboard-managed-candidate.mjs';
import { createDashboardTalkTaskBridge } from './task-continuity.mjs';
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
    concurrent = false;
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
        id: externalRunId,
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

test('aliased future child-store ancestor is refused before source effects',async t=>{
  const f=await fixture(t),{task,projection}=await f.intake();
  const snapshot=((await f.controller.describe())as any).controls[task.taskId].planning;
  const runId=`run-goal-${taskDigest([snapshot.taskId,snapshot.requestId,snapshot.proposalSha256,snapshot.policySha256,snapshot.candidate]).slice(0,48)}`;
  await symlink(f.config.workspaceRoot,join(f.profile.evidenceRoot,runId));
  await assert.rejects(f.controller.action(task.taskId,{action:'prepare-plan',requestId:'prepare',expectedVersion:task.version,proposalSha256:projection.action!.proposalSha256}),/ancestor alias refused/);
  await assert.rejects(readFile(join(f.config.workspaceRoot,'children')),(e:any)=>e.code==='ENOENT');
  assert.equal(f.launches,0);
});

test('concurrent task change before dispatch launches zero native work and preserves metadata',async t=>{
  const f=await fixture(t),task=await f.prepare(),admit=f.host.admit;
  f.host.admit=async paths=>{
    await admit(paths);
    await f.store.updateTask({taskId:task.taskId,actor:'fixture',idempotencyKey:'changed-before-start',expectedVersion:task.version,nextAction:'Concurrent edit'});
  };
  await assert.rejects(f.controller.action(task.taskId,{action:'implementation-start',requestId:'start',expectedVersion:task.version}),/version conflict/);
  const current=await f.runtime.snapshot(task.taskId);
  assert.equal(f.launches,0);assert.equal(current.nextAction,'Concurrent edit');assert.equal(current.blocker,null);
});
