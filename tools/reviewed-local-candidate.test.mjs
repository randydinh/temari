import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  realpath,
  cp,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import {
  admitReviewedLocalCandidate,
  captureReviewedLocalCandidate,
  finalizeReviewedLocalCandidate,
  verifyReviewedLocalCandidate,
  digest,
  objectDigest,
  NATIVE_STAGE_TIMEOUTS_MS,
  nativeStageBudgetCoverage,
  managedOperationCommand,
  assertManagedBridgeRuntime,
} from '../packages/workflow-runtime/host/reviewed-local-candidate.mjs';
import {
  REVIEWED_LOCAL_CANDIDATE_POLICY,
  createReviewedLocalCandidatePlan,
} from '../libs/temari-core/src/index.ts';
import {
  FileTaskStore,
  TaskRuntime,
  readReviewedLocalCandidateResult,
  FileChildTaskStore,
  FileParallelWorkerReceiptStore,
  FileEvidenceStore,
} from '../libs/runtime/src/index.ts';

async function fixture(t, mode = 'pass', options = {}) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'managed-candidate-')),
  );
  t.after(async () => {
    const destination = process.env.WORKER_SHUTDOWN_FIXTURE_EVIDENCE_ROOT;
    if (destination) {
      await mkdir(destination, { recursive: true });
      const target = join(
        destination,
        `managed-${digest(t.name + root).slice(0, 16)}`,
      );
      await cp(root, target, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      await writeFile(
        join(target, 'archive-origin.json'),
        JSON.stringify(
          {
            test: t.name,
            sourceRoot: root,
            archivedAt: new Date().toISOString(),
            scope: 'Synthetic evidence only; no PID signalling authority.',
          },
          null,
          2,
        ) + '\n',
      );
    }
    await rm(root, { recursive: true, force: true });
  });
  let parserExecutable;
  for (const command of ['python3', 'python3.11', 'python3.12']) {
    try {
      parserExecutable = await realpath(
        execFileSync(
          command,
          ['-c', 'import sys,tomllib;print(sys.executable)'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
        ).trim(),
      );
      break;
    } catch {}
  }
  assert(
    parserExecutable,
    'A Python TOML parser is required by the managed model admission fixture.',
  );
  const previousCodexHome = process.env.CODEX_HOME;
  const codexHome = join(root, 'codex-home');
  await mkdir(codexHome);
  process.env.CODEX_HOME = codexHome;
  t.after(() => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  });
  const configPath = join(codexHome, 'config.toml');
  await writeFile(
    configPath,
    'model = "fixture-model"\nmodel_reasoning_effort = "high"\n',
  );
  const catalogPath = join(root, 'catalog.json');
  await writeFile(
    catalogPath,
    JSON.stringify({
      client_version: '0.162.0',
      fetched_at: new Date().toISOString(),
      models: [
        {
          slug: 'fixture-model',
          supported_reasoning_levels: [{ effort: 'high' }],
        },
      ],
    }),
  );
  const candidate = join(root, 'candidate');
  const evidence = join(root, 'evidence');
  const artifacts = join(root, 'native');
  await Promise.all([candidate, evidence, artifacts].map((x) => mkdir(x)));
  const git = (...args) =>
    execFileSync('git', ['-C', candidate, ...args], {
      encoding: 'utf8',
    }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@localhost');
  await writeFile(join(candidate, 'value.txt'), 'base\n');
  await writeFile(join(candidate, 'protected.txt'), 'keep\n');
  git('add', '.');
  git('commit', '-qm', 'baseline');
  const base = git('rev-parse', 'HEAD');
  const executable = join(root, 'codex');
  const control = join(root, 'control.json');
  const counter = join(root, 'counter.log');
  await writeFile(control, JSON.stringify({ mode }));
  const script = `#!${process.execPath}
const fs=require('node:fs');const path=require('node:path');const a=process.argv.slice(2);
if(a[0]==='--version'){console.log('codex-cli 0.162.0');process.exit(0);}
if(a.includes('--help')){console.log('--sandbox --output-schema --json --ignore-user-config --model --config');process.exit(0);}
if(a[0]==='login'){console.log('Logged in using fixture');process.exit(0);}
let p='';process.stdin.on('data',x=>p+=x);process.stdin.on('end',()=>{
 if(!a.includes('--ignore-user-config')||a[a.indexOf('--model')+1]!=='fixture-model'||!a.includes('model_provider="openai"')||!a.includes('model_reasoning_effort="high"'))process.exit(9);
 const role=p.includes('isolated Git clone')?'builder':p.includes('Role: reviewer')?'reviewer':'architect';
 fs.appendFileSync(${JSON.stringify(counter)},role+'\\n');
 const mode=JSON.parse(fs.readFileSync(${JSON.stringify(control)},'utf8')).mode;
 if(mode===role+'-crash')process.exit(7);
 if(mode==='builder-wait' && role==='builder'){setInterval(()=>{},1000);return;}
 const cwd=a[a.indexOf('--cd')+1];
 if(role==='builder'){fs.writeFileSync(path.join(cwd,'value.txt'),'implemented\\n');if(mode==='unowned')fs.writeFileSync(path.join(cwd,'protected.txt'),'bad\\n');}
 if(mode==='config-critical-during-worker')fs.writeFileSync(${JSON.stringify(configPath)},'model = "other-model"\\nmodel_reasoning_effort = "high"\\n');
 if(mode==='config-irrelevant-during-worker')fs.writeFileSync(${JSON.stringify(configPath)},'model = "fixture-model"\\nmodel_reasoning_effort = "high"\\nnotify = ["changed-during-worker"]\\n');
 const status=mode===role+'-fail'?'ISSUES':'PASS';
 fs.writeFileSync(a[a.indexOf('--output-last-message')+1],JSON.stringify({status,summary:role+' inspected literal requirements'}));
 console.log(JSON.stringify({type:'thread.started',thread_id:role+'-fixture'}));
});`;
  await writeFile(executable, script, { mode: 0o700 });
  const check = join(root, 'check.mjs');
  await writeFile(
    check,
    `import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {join} from 'node:path';const [mode,root]=process.argv.slice(2);assert.equal(readFileSync(join(root,'value.txt'),'utf8'),mode==='baseline'?'base\\n':'implemented\\n');assert.equal(readFileSync(join(root,'protected.txt'),'utf8'),'keep\\n');`,
  );
  const protectedInputs = await Promise.all(
    [
      process.execPath,
      check,
      executable,
      configPath,
      catalogPath,
      parserExecutable,
    ].map(async (path) => ({
      path,
      sha256: digest(await readFile(path)),
    })),
  );
  const bridgeRuntimeExecutable = await realpath(process.execPath);
  const bridgeRuntimeSha256 = digest(await readFile(bridgeRuntimeExecutable));
  if (!protectedInputs.some((ref) => ref.path === bridgeRuntimeExecutable))
    protectedInputs.push({
      path: bridgeRuntimeExecutable,
      sha256: bridgeRuntimeSha256,
    });
  const assignment = (id, role) => ({
    id,
    role,
    required: true,
    brief: {
      goal: 'Implement a literal local candidate',
      context: 'Read value.txt and preserve protected.txt',
      scope: 'value.txt',
      acceptanceCriteria: ['value.txt equals implemented'],
      verificationCommand: null,
      reportFormat: 'json',
      forbiddenActions: ['No publication'],
    },
  });
  const spec = {
    schema: 1,
    profile: 'reviewed-local-candidate-v1',
    bridgeRuntime: {
      executable: bridgeRuntimeExecutable,
      sha256: bridgeRuntimeSha256,
    },
    runId: 'fixture-managed',
    taskId: 'fixture-task',
    taskStoreRoot: join(root, 'managed-tasks'),
    repositoryRoot: candidate,
    evidenceRoot: evidence,
    baseCommit: base,
    plan: createReviewedLocalCandidatePlan(),
    policySha256: objectDigest(REVIEWED_LOCAL_CANDIDATE_POLICY),
    timeoutMs: 10000,
    executable,
    providerSelection: {
      provider: 'codex',
      executableSha256: digest(await readFile(executable)),
      executableVersion: 'codex-cli 0.162.0',
      model: 'fixture-model',
      reasoning: 'high',
    },
    modelAdmission: {
      configPath,
      configSha256: digest(await readFile(configPath)),
      catalogPath,
      catalogSha256: digest(await readFile(catalogPath)),
      parserExecutable,
      parserSha256: digest(await readFile(parserExecutable)),
    },
    workers: {
      architect: assignment('architect', 'investigator'),
      builder: assignment('builder', 'implementer'),
      reviewer: assignment('reviewer', 'reviewer'),
    },
    owns: [{ kind: 'file', path: 'value.txt' }],
    acceptance: [
      'Literal baseline becomes implemented; protected bytes preserved',
    ],
    protectedInputs,
    baselineChecks: [
      {
        program: process.execPath,
        args: [check, 'baseline', '{candidate}'],
        timeoutMs: 10000,
      },
    ],
    acceptanceChecks: [
      {
        program: process.execPath,
        args: [
          check,
          mode === 'check-fail' ? 'baseline' : 'acceptance',
          '{candidate}',
        ],
        timeoutMs: 10000,
      },
    ],
  };
  const specPath = join(root, 'spec.json');
  const save = async () => {
    await writeFile(specPath, JSON.stringify(spec));
    return digest(await readFile(specPath));
  };
  const tasks = await FileTaskStore.create(spec.taskStoreRoot);
  const task = await tasks.createTask({
    taskId: spec.taskId,
    title: 'Managed fixture',
    goal: 'fixture',
    workspaceRoot: candidate,
    actor: 'fixture',
    idempotencyKey: 'create',
  });
  let boundTask = await tasks.bindRun({
    taskId: spec.taskId,
    actor: 'fixture',
    idempotencyKey: 'bind',
    expectedVersion: task.version,
    run: {
      runId: spec.runId,
      revision: spec.baseCommit,
      plan: spec.plan,
      executionStoreRoot: join(evidence, spec.runId, 'children'),
    },
  });
  boundTask = (
    await tasks.append(
      {
        taskId: spec.taskId,
        actor: 'fixture',
        idempotencyKey: 'native-launch',
        expectedVersion: boundTask.version,
      },
      {
        type: 'dispatch-requested',
        runId: spec.runId,
        entrypoint: 'temari-reviewed-local-candidate',
        inputs: {},
        harnessId: 'archon',
        harnessVersion: '0.10.1',
      },
    )
  ).task;
  const publishNative = async () =>
    tasks.append(
      {
        taskId: spec.taskId,
        actor: 'fixture',
        idempotencyKey: 'native-link',
        expectedVersion: (await tasks.load(spec.taskId)).version,
      },
      {
        type: 'native-bound',
        runId: spec.runId,
        operationId: 'native-launch',
        reference: {
          schema: 1,
          harnessId: 'archon',
          harnessVersion: '0.10.1',
          runId: spec.runId,
          revision: spec.baseCommit,
          planSha256: objectDigest(spec.plan),
          externalRunId: 'native-fixture',
          workspaceRoot: candidate,
          entrypoint: 'temari-reviewed-local-candidate',
          startedAt: new Date().toISOString(),
        },
      },
    );
  if (!options.deferNativePublication) await publishNative();
  const expectedSha256 = await save();
  return {
    root,
    publishNative,
    spec,
    save,
    control,
    counter,
    git,
    input: {
      specPath,
      expectedSha256,
      artifacts,
      nativeRunId: 'native-fixture',
      observeSupervisor: async () => true,
    },
    run: (stage) =>
      captureReviewedLocalCandidate({
        specPath,
        expectedSha256,
        artifacts,
        nativeRunId: 'native-fixture',
        observeSupervisor: async () => true,
        stage,
      }),
  };
}
const stages = ['investigate', 'plan', 'build', 'review', 'verify', 'deliver'];
test('Bun and Node operation argument shapes always invoke the admitted current process despite PATH shadowing', async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'managed-operation-runtime-')),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = join(root, 'owned-invocations'),
    shadowMarker = join(root, 'shadow-invocations'),
    tool = join(root, 'owned-tool.mjs'),
    shadow = join(root, 'shadow');
  const executable = process.execPath,
    sha256 = digest(await readFile(executable));
  const spec = {
    repositoryRoot: join(root, 'candidate'),
    bridgeRuntime: { executable, sha256 },
    protectedInputs: [{ path: executable, sha256 }],
  };
  await assertManagedBridgeRuntime(spec);
  await mkdir(shadow);
  await writeFile(
    tool,
    `import fs from 'node:fs';fs.appendFileSync(${JSON.stringify(marker)},JSON.stringify(process.argv.slice(2))+'\\n');\n`,
  );
  await writeFile(
    join(shadow, 'bun'),
    `#!${executable}\nrequire('node:fs').writeFileSync(${JSON.stringify(shadowMarker)},'spoofed');\n`,
    { mode: 0o700 },
  );
  const env = { ...process.env, PATH: shadow + ':' + process.env.PATH };
  for (const isBun of [true, false]) {
    const command = managedOperationCommand(
      tool,
      'fixture-request',
      'fixture-result',
      isBun,
    );
    assert.equal(command.program, process.execPath);
    assert.deepEqual(
      command.args,
      isBun || tool.endsWith('.mjs')
        ? [tool, 'fixture-request', 'fixture-result']
        : [
            '--import',
            '@swc-node/register/esm-register',
            tool,
            'fixture-request',
            'fixture-result',
          ],
    );
    execFileSync(command.program, command.args, {
      env,
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  assert.deepEqual(managedOperationCommand(join(root,'owned-tool.mts'),'fixture-request','fixture-result',false).args,[
    '--import','@swc-node/register/esm-register',join(root,'owned-tool.mts'),'fixture-request','fixture-result',
  ]);
  assert.deepEqual(
    (await readFile(marker, 'utf8')).trim().split('\n').map(JSON.parse),
    [
      ['fixture-request', 'fixture-result'],
      ['fixture-request', 'fixture-result'],
    ],
  );
  await assert.rejects(
    readFile(shadowMarker),
    (error) => error.code === 'ENOENT',
  );
  await assert.rejects(
    assertManagedBridgeRuntime({ ...spec, bridgeRuntime: undefined }),
    /Pinned bridge runtime required/,
  );
  const badDigest = {
    ...spec,
    bridgeRuntime: { executable, sha256: '0'.repeat(64) },
    protectedInputs: [{ path: executable, sha256: '0'.repeat(64) }],
  };
  await assert.rejects(
    assertManagedBridgeRuntime(badDigest),
    /Executing bridge runtime digest changed/,
  );
});
test('a different protected runtime cannot admit stages executed by the current process', async (t) => {
  const f = await fixture(t);
  f.spec.bridgeRuntime = {
    executable: f.spec.executable,
    sha256: f.spec.providerSelection.executableSha256,
  };
  await assert.rejects(
    admitReviewedLocalCandidate({ ...f.input, expectedSha256: await f.save() }),
    /Executing bridge runtime differs/,
  );
  await assert.rejects(readFile(f.counter), (error) => error.code === 'ENOENT');
});
test('new launcher request retains the bridge runtime as a protected canonical input', async (t) => {
  const f = await fixture(t);
  const input = { ...f.input, expectedSha256: await f.save() };
  await admitReviewedLocalCandidate(input);
  f.spec.bridgeRuntime.sha256 = '0'.repeat(64);
  await assert.rejects(
    admitReviewedLocalCandidate({ ...input, expectedSha256: await f.save() }),
    /Bridge runtime protected input changed/,
  );
  f.spec.bridgeRuntime.sha256 = digest(await readFile(process.execPath));
  f.spec.protectedInputs = f.spec.protectedInputs.filter(
    (ref) => ref.path !== f.spec.bridgeRuntime.executable,
  );
  await assert.rejects(
    admitReviewedLocalCandidate({ ...input, expectedSha256: await f.save() }),
    /Bridge runtime protected input changed/,
  );
  await assert.rejects(readFile(f.counter), (error) => error.code === 'ENOENT');
});
test('native source nodes use the protected absolute bridge runtime and refuse runtime drift',async t=>{
  const {parse}=createRequire(import.meta.resolve('nx/package.json'))('yaml');
  const workflow=parse(await readFile(new URL('../packages/workflow-runtime/host/.archon/workflows/temari-reviewed-local-candidate.yaml',import.meta.url),'utf8'));
  assert.equal(workflow.inputs.bridge_runtime.required,true);
  assert.equal(workflow.inputs.bridge_runtime_sha256.required,true);
  const root=await realpath(await mkdtemp(join(tmpdir(),'managed-native-runtime-')));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const node=await realpath(process.execPath),marker=join(root,'invocations'),shadowMarker=join(root,'shadow-invocations');
  const runtime=join(root,'bridge runtime'),bridge=join(root,'bridge.mjs'),shadow=join(root,'shadow');
  await mkdir(shadow);await writeFile(bridge,'fixture');
  await writeFile(runtime,`#!${node}\nrequire('node:fs').appendFileSync(${JSON.stringify(marker)},JSON.stringify(process.argv.slice(2))+'\\n');\n`,{mode:0o700});
  await writeFile(join(shadow,'bun'),`#!${node}\nrequire('node:fs').writeFileSync(${JSON.stringify(shadowMarker)},'spoofed');\n`,{mode:0o700});
  const env={...process.env,PATH:shadow+':'+process.env.PATH,INPUTS_BRIDGE:bridge,INPUTS_BRIDGE_SHA256:digest(await readFile(bridge)),INPUTS_BRIDGE_RUNTIME:runtime,INPUTS_BRIDGE_RUNTIME_SHA256:digest(await readFile(runtime)),INPUTS_SPEC:join(root,'spec.json'),INPUTS_REQUEST_SHA256:'a'.repeat(64),ARTIFACTS_DIR:join(root,'artifacts'),WORKFLOW_ID:'fixture-native'};
  for(const entry of workflow.nodes)execFileSync('/bin/bash',['-c',entry.bash],{env,timeout:5000});
  const calls=(await readFile(marker,'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.length,7);assert(calls.every(args=>args[0]===bridge));
  assert.deepEqual(calls.map(args=>args[1]),[...stages.map(()=>'capture'),'finalize']);
  await assert.rejects(readFile(shadowMarker),error=>error.code==='ENOENT');
  assert.throws(()=>execFileSync('/bin/bash',['-c',workflow.nodes[0].bash],{env:{...env,INPUTS_BRIDGE_RUNTIME_SHA256:'0'.repeat(64)},timeout:5000}));
  assert.equal((await readFile(marker,'utf8')).trim().split('\n').length,7);
});
test('native YAML budgets cover admitted stage composition instead of the 120-second default', async (t) => {
  const { parse } = createRequire(import.meta.resolve('nx/package.json'))(
    'yaml',
  );
  const workflow = parse(
    await readFile(
      new URL(
        '../packages/workflow-runtime/host/.archon/workflows/temari-reviewed-local-candidate.yaml',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  assert.deepEqual(
    workflow.nodes.map((node) => node.id),
    [...stages, 'finalize'],
  );
  assert.deepEqual(
    Object.fromEntries(workflow.nodes.map((node) => [node.id, node.timeout])),
    NATIVE_STAGE_TIMEOUTS_MS,
  );
  for (const node of workflow.nodes) {
    assert(
      Number.isSafeInteger(node.timeout) &&
        node.timeout > 120000 &&
        node.timeout <= 1800000,
    );
    assert(node.bash && !node.retry);
  }
  const f = await fixture(t);
  f.spec.timeoutMs = 900000;
  f.spec.baselineChecks[0].timeoutMs = 600000;
  f.spec.acceptanceChecks[0].timeoutMs = 600000;
  const expectedSha256 = await f.save();
  const admitted = await admitReviewedLocalCandidate({
    ...f.input,
    expectedSha256,
  });
  assert.deepEqual(
    admitted.nativeBudgetCoverage,
    nativeStageBudgetCoverage(f.spec),
  );
  for (const [stage, required] of Object.entries(
    admitted.nativeBudgetCoverage.requiredMs,
  ))
    assert(
      workflow.nodes.find((node) => node.id === stage).timeout >= required,
    );
  assert(
    admitted.nativeBudgetCoverage.requiredMs.investigate >= 600000 + 900000,
  );
  assert(NATIVE_STAGE_TIMEOUTS_MS.investigate > 58000 + 202849);
  await assert.rejects(readFile(f.counter), { code: 'ENOENT' });
});

test('initial investigate waits for caller native publication before authority or useful work', async (t) => {
  const f = await fixture(t, 'pass', { deferNativePublication: true });
  let observed;
  const firstNativeRead = new Promise((resolve) => {
    observed = resolve;
  });
  const capture = captureReviewedLocalCandidate({
    ...f.input,
    stage: 'investigate',
    observeSupervisor: async () => {
      observed();
      return true;
    },
  });
  await Promise.race([
    firstNativeRead,
    capture.then(() => {
      throw new Error('Capture completed before native publication.');
    }),
  ]);
  await assert.rejects(readFile(f.counter), { code: 'ENOENT' });
  const children = await FileChildTaskStore.create(
    join(f.spec.evidenceRoot, f.spec.runId, 'children'),
  );
  assert.deepEqual(await children.executionRecords(f.spec.runId), []);
  await f.publishNative();
  const result = await capture;
  assert.equal(result.status, 'PASS');
  assert.equal((await readFile(f.counter, 'utf8')).trim(), 'architect');
});

test('summed protected-check limits exceeding native envelopes refuse before worker dispatch', async (t) => {
  const f = await fixture(t);
  f.spec.timeoutMs = 900000;
  f.spec.baselineChecks[0].timeoutMs = 600000;
  f.spec.acceptanceChecks[0].timeoutMs = 600000;
  const baseline = structuredClone(f.spec.baselineChecks);
  f.spec.baselineChecks.push(...baseline);
  let expectedSha256 = await f.save();
  await assert.rejects(
    admitReviewedLocalCandidate({ ...f.input, expectedSha256 }),
    /investigate native timeout does not cover composed work/,
  );
  f.spec.baselineChecks = baseline;
  f.spec.acceptanceChecks.push(...structuredClone(f.spec.acceptanceChecks));
  expectedSha256 = await f.save();
  await assert.rejects(
    admitReviewedLocalCandidate({ ...f.input, expectedSha256 }),
    /verify native timeout does not cover composed work/,
  );
  await assert.rejects(readFile(f.counter), { code: 'ENOENT' });
});

test('unrelated live user-config drift is retained as a diagnostic and does not stop the next stage', async (t) => {
  const f = await fixture(t);
  await f.run('investigate');
  const config = f.spec.modelAdmission.configPath;
  await writeFile(
    config,
    'model = "fixture-model"\nmodel_reasoning_effort = "high"\nnotify = ["changed-after-admission"]\n',
  );
  const admitted = await admitReviewedLocalCandidate(f.input);
  assert.equal(admitted.modelSelection.config.drifted, true);
  assert.equal(
    admitted.modelSelection.config.initialSha256,
    f.spec.modelAdmission.configSha256,
  );
  assert.notEqual(
    admitted.modelSelection.config.currentSha256,
    f.spec.modelAdmission.configSha256,
  );
  assert.equal((await f.run('plan')).status, 'PASS');
});

test('raw drift before the first admission cannot create the immutable baseline', async (t) => {
  const f = await fixture(t);
  await writeFile(
    f.spec.modelAdmission.configPath,
    'model = "fixture-model"\nmodel_reasoning_effort = "high"\nnotify = ["changed-too-early"]\n',
  );
  await assert.rejects(
    admitReviewedLocalCandidate(f.input),
    /was not proven before raw drift/,
  );
  await assert.rejects(
    readFile(
      join(f.spec.evidenceRoot, f.spec.runId, 'model-admission-baseline.json'),
    ),
    { code: 'ENOENT' },
  );
});

test('execution-critical live user-config drift refuses the next stage', async (t) => {
  const f = await fixture(t);
  await f.run('investigate');
  await writeFile(
    f.spec.modelAdmission.configPath,
    'model = "other-model"\nmodel_reasoning_effort = "high"\n',
  );
  await assert.rejects(f.run('plan'), /differs from inherited user settings/);
  assert.equal((await readFile(f.counter, 'utf8')).trim(), 'architect');
});

test('completion observation accepts irrelevant drift introduced by a worker and records both observations', async (t) => {
  const f = await fixture(t, 'config-irrelevant-during-worker');
  const stage = await f.run('investigate');
  assert.equal(stage.modelSelection.admission.config.drifted, false);
  assert.equal(stage.modelSelection.completion.config.drifted, true);
  assert.equal(
    stage.modelSelection.admission.baseline.sha256,
    stage.modelSelection.completion.baseline.sha256,
  );
});

test('completion observation refuses critical drift introduced by a worker', async (t) => {
  const f = await fixture(t, 'config-critical-during-worker');
  await assert.rejects(
    f.run('investigate'),
    /differs from inherited user settings/,
  );
  await assert.rejects(readFile(join(f.input.artifacts, 'investigate.json')), {
    code: 'ENOENT',
  });
});
async function acceptedChild(f, stage = 'build') {
  const root = join(f.spec.evidenceRoot, f.spec.runId);
  const runId = `${f.spec.runId}-${stage}`;
  const receiptRoot = join(root, 'child-receipts');
  const receipts = await FileParallelWorkerReceiptStore.create(receiptRoot);
  const accepted = await receipts.load(runId);
  const children = await FileChildTaskStore.create(join(root, 'children'));
  const group = await children.loadGroup(accepted.binding.groupId);
  assert.equal(group.taskIds.length, 1);
  const task = await children.load(group.taskIds[0]);
  const evidenceRoot = join(root, 'child-evidence');
  return {
    accepted,
    task,
    evidenceRoot,
    receiptPath: join(receiptRoot, `${runId}.parallel.receipt.json`),
    operationPath: join(root, stage, 'operation-result.json'),
  };
}

async function replacementReceipt(f, bytes, change) {
  const record = JSON.parse(bytes);
  change(record.receipt);
  const store = await FileParallelWorkerReceiptStore.create(
    await mkdtemp(join(f.root, 'replacement-receipt-')),
  );
  const path = await store.save(record.receipt, {
    groupId: record.groupId,
    fingerprint: record.fingerprint,
  });
  assert.deepEqual(
    (await store.load(record.receipt.runId)).receipt,
    record.receipt,
  );
  return readFile(path);
}

test('accepted child freezes exact operation bytes, candidate identity and external evidence hashes', async (t) => {
  const f = await fixture(t);
  for (const stage of stages.slice(0, 3)) await f.run(stage);
  const retained = await acceptedChild(f);
  const store = await FileEvidenceStore.openExisting(retained.evidenceRoot);
  const refs = retained.task.result.evidenceReferences;
  assert.equal(refs.length, 2);
  const operationRef = refs.find((x) => x.kind === 'worker-result');
  const manifestRef = refs.find((x) => x.kind === 'verification');
  const bytes = Buffer.from(await store.loadPortable(operationRef));
  assert.deepEqual(bytes, await readFile(retained.operationPath));
  const manifest = JSON.parse(
    Buffer.from(await store.loadPortable(manifestRef)),
  );
  assert.equal(manifest.operation.sha256, digest(bytes));
  const operation = JSON.parse(bytes);
  assert.deepEqual(manifest.outputCandidate, {
    root: operation.integrationPath,
    commit: operation.integratedCommit,
  });
  assert(manifest.refs.some((x) => x.path === operation.receiptPath));
  assert.deepEqual(
    retained.accepted.receipt.outcomes[0].result,
    retained.task.result,
  );
  for (const ref of manifest.refs)
    assert.equal(digest(await readFile(ref.path)), ref.sha256);
});

test('accepted-build recovery refuses missing or inconsistent frozen proof without builder replay', async (t) => {
  const f = await fixture(t);
  for (const stage of stages.slice(0, 3)) await f.run(stage);
  const retained = await acceptedChild(f);
  const buildPath = join(f.input.artifacts, 'build.json');
  await rm(buildPath);
  const intent = await readFile(join(f.input.artifacts, 'build.intent.json'));
  const count = await readFile(f.counter, 'utf8');
  const operationBytes = await readFile(retained.operationPath);
  const operation = JSON.parse(operationBytes);
  const receiptBytes = await readFile(retained.receiptPath);
  const wrongAssignment = await replacementReceipt(
    f,
    receiptBytes,
    (receipt) => {
      receipt.outcomes[0].assignment.brief.context += 'Different assignment';
    },
  );
  const wrongResult = await replacementReceipt(f, receiptBytes, (receipt) => {
    receipt.outcomes[0].result.summary = 'Different accepted child result';
  });
  const writeReceipt = JSON.parse(await readFile(operation.receiptPath));
  const cases = [
    [
      'operation bytes changed',
      retained.operationPath,
      Buffer.from(JSON.stringify(operation)),
    ],
    [
      'operation receipt identity changed',
      retained.operationPath,
      Buffer.from(
        JSON.stringify({
          ...operation,
          receiptPath: join(f.root, 'unaccepted.json'),
        }),
      ),
    ],
    ['operation missing', retained.operationPath, null],
    ['write receipt missing', operation.receiptPath, null],
    [
      'write receipt integration identity changed',
      operation.receiptPath,
      Buffer.from(
        JSON.stringify({
          ...writeReceipt,
          integratedCommit: f.spec.baseCommit,
        }),
      ),
    ],
    [
      'checksummed receipt has different assignment',
      retained.receiptPath,
      wrongAssignment,
    ],
    [
      'checksummed receipt has different child result',
      retained.receiptPath,
      wrongResult,
    ],
    [
      'external evidence changed',
      retained.task.result.evidencePaths.find((x) =>
        x.endsWith('/process.json'),
      ),
      Buffer.from('{}'),
    ],
    ['accepted receipt missing', retained.receiptPath, null],
    [
      'accepted portable evidence missing',
      join(
        retained.evidenceRoot,
        `${retained.task.result.evidenceReferences[0].sha256}.artifact`,
      ),
      null,
    ],
  ];
  for (const [name, path, replacement] of cases) {
    await t.test(name, async (t) => {
      const original = await readFile(path);
      t.after(async () => {
        await writeFile(path, original);
        await rm(buildPath, { force: true });
      });
      if (replacement === null) await rm(path);
      else await writeFile(path, replacement);
      await assert.rejects(
        captureReviewedLocalCandidate({
          ...f.input,
          stage: 'build',
          reconcileIntentSha256: digest(intent),
        }),
      );
      assert.equal(await readFile(f.counter, 'utf8'), count);
      await assert.rejects(readFile(buildPath), { code: 'ENOENT' });
    });
  }
});

test('final readback reopens accepted receipts and portable evidence for every worker', async (t) => {
  const f = await fixture(t);
  for (const stage of stages) await f.run(stage);
  await finalizeReviewedLocalCandidate(f.input);
  const count = await readFile(f.counter, 'utf8');
  for (const stage of ['investigate', 'build', 'review']) {
    const retained = await acceptedChild(f, stage);
    const paths = [
      retained.receiptPath,
      ...retained.task.result.evidenceReferences.map((ref) =>
        join(retained.evidenceRoot, `${ref.sha256}.artifact`),
      ),
    ];
    for (const path of paths) {
      await t.test(`${stage}: missing ${path.split('/').at(-1)}`, async (t) => {
        const original = await readFile(path);
        t.after(() => writeFile(path, original));
        await rm(path);
        await assert.rejects(verifyReviewedLocalCandidate(f.input));
        await assert.rejects(finalizeReviewedLocalCandidate(f.input));
        assert.equal(await readFile(f.counter, 'utf8'), count);
      });
    }
  }
  const retained = await acceptedChild(f);
  const receiptBytes = await readFile(retained.receiptPath);
  const captures = await Promise.all(
    stages.map(async (stage) => {
      const path = join(f.input.artifacts, `${stage}.json`);
      return { path, bytes: await readFile(path) };
    }),
  );
  for (const property of ['assignment', 'result']) {
    await t.test(
      `checksummed receipt differs from accepted ${property}, with matching stage refs`,
      async (t) => {
        t.after(async () => {
          await writeFile(retained.receiptPath, receiptBytes);
          for (const capture of captures)
            await writeFile(capture.path, capture.bytes);
        });
        const bytes = await replacementReceipt(f, receiptBytes, (receipt) => {
          const outcome = receipt.outcomes[0];
          if (property === 'assignment')
            outcome.assignment.brief.context += 'Different assignment';
          else outcome.result.summary = 'Different accepted child result';
        });
        await writeFile(retained.receiptPath, bytes);
        for (const capture of captures) {
          const record = JSON.parse(capture.bytes);
          for (const ref of record.body.refs)
            if (ref.path === retained.receiptPath) {
              ref.sha256 = digest(bytes);
              ref.bytes = bytes.length;
            }
          record.sha256 = objectDigest(record.body);
          await writeFile(capture.path, JSON.stringify(record));
        }
        await assert.rejects(
          verifyReviewedLocalCandidate(f.input),
          /Expected values to be strictly deep-equal/,
        );
        await assert.rejects(finalizeReviewedLocalCandidate(f.input));
        assert.equal(await readFile(f.counter, 'utf8'), count);
      },
    );
  }
});

test('one coupled builder, exact independent review, protected checks and fresh-process replay', async (t) => {
  const f = await fixture(t);
  for (const stage of stages) await f.run(stage);
  const completion = await finalizeReviewedLocalCandidate(f.input);
  assert.equal(completion.status, 'PASS');
  assert.equal(completion.workers.length, 3);
  assert.equal(f.git('rev-parse', 'HEAD'), f.spec.baseCommit);
  const before = await readFile(f.counter, 'utf8');
  assert.equal(before, 'architect\nbuilder\nreviewer\n');
  await f.run('build');
  await finalizeReviewedLocalCandidate(f.input);
  assert.equal(await readFile(f.counter, 'utf8'), before);
  const result = execFileSync(
    process.execPath,
    [
      '--import',
      '@swc-node/register/esm-register',
      'packages/workflow-runtime/host/reviewed-local-candidate.mjs',
      'verify',
      '--spec',
      f.input.specPath,
      '--sha256',
      f.input.expectedSha256,
      '--artifacts',
      f.input.artifacts,
      '--workflow-id',
      f.input.nativeRunId,
    ],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  );
  assert(JSON.parse(result).candidate.commit);
  assert.equal(await readFile(f.counter, 'utf8'), before);
  const store = await FileTaskStore.create(join(f.root, 'tasks'));
  await store.createTask({
    taskId: 'fixture-task',
    title: 'Fixture',
    goal: 'Fixture',
    workspaceRoot: f.spec.repositoryRoot,
    actor: 'fixture',
    idempotencyKey: 'create',
  });
  await store.bindRun({
    taskId: 'fixture-task',
    actor: 'fixture',
    idempotencyKey: 'bind',
    expectedVersion: 1,
    run: {
      runId: f.spec.runId,
      revision: f.spec.baseCommit,
      plan: f.spec.plan,
    },
  });
  await assert.rejects(
    new TaskRuntime({ store }).accept({
      taskId: 'fixture-task',
      runId: f.spec.runId,
      actor: 'fixture',
      idempotencyKey: 'accept',
      expectedVersion: 2,
      reason: 'cannot weaken generic guard',
    }),
    /route-specific verifier/,
  );
});
test('policy/request/provider/ownership admission refuses before worker dispatch', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    admitReviewedLocalCandidate({ ...f.input, expectedSha256: '0'.repeat(64) }),
    /digest/,
  );
  for (const mutate of [
    () => {
      f.spec.policySha256 = '0'.repeat(64);
    },
    () => {
      f.spec.plan.delivery = 'pull-request';
    },
    () => {
      f.spec.providerSelection.provider = 'other';
    },
    () => {
      f.spec.owns = [{ kind: 'file', path: '../outside' }];
    },
    () => {
      f.spec.workers.reviewer.id = 'builder';
    },
  ]) {
    const original = structuredClone(f.spec);
    mutate();
    const expectedSha256 = await f.save();
    await assert.rejects(
      admitReviewedLocalCandidate({ ...f.input, expectedSha256 }),
    );
    Object.assign(f.spec, original);
  }
  await assert.rejects(readFile(f.counter), { code: 'ENOENT' });
});
test('missing execution capabilities and binary drift refuse pre-dispatch', async (t) => {
  const f = await fixture(t);
  await writeFile(
    f.spec.executable,
    `#!${process.execPath}
const a=process.argv.slice(2);
if(a.includes('--version'))console.log('codex-cli 0.162.0');
else if(a.includes('--help'))console.log('--sandbox --output-schema --json');
else if(a[0]==='login')console.log('Logged in using fixture');
`,
    { mode: 0o700 },
  );
  await assert.rejects(admitReviewedLocalCandidate(f.input), /Evidence drift/);
  f.spec.protectedInputs.find((x) => x.path === f.spec.executable).sha256 =
    digest(await readFile(f.spec.executable));
  f.spec.providerSelection.executableSha256 = digest(
    await readFile(f.spec.executable),
  );
  const expectedSha256 = await f.save();
  await assert.rejects(
    admitReviewedLocalCandidate({ ...f.input, expectedSha256 }),
    /Missing Codex/,
  );
  await assert.rejects(readFile(f.counter), { code: 'ENOENT' });
});
for (const mode of [
  'builder-crash',
  'builder-fail',
  'reviewer-fail',
  'unowned',
])
  test(`${mode} blocks later native stages and retains failure`, async (t) => {
    const f = await fixture(t, mode);
    await f.run('investigate');
    await f.run('plan');
    if (mode === 'reviewer-fail') {
      await f.run('build');
      await assert.rejects(f.run('review'));
      await assert.rejects(f.run('verify'));
    } else {
      await assert.rejects(f.run('build'));
      await assert.rejects(f.run('review'));
    }
    await assert.rejects(finalizeReviewedLocalCandidate(f.input));
    const count = await readFile(f.counter, 'utf8');
    await assert.rejects(
      f.run(mode === 'reviewer-fail' ? 'review' : 'build'),
      /Uncertain stage/,
    );
    assert.equal(await readFile(f.counter, 'utf8'), count);
  });
test('failed acceptance check blocks delivery; literal checks are protected', async (t) => {
  const f = await fixture(t);
  for (const s of stages.slice(0, 4)) await f.run(s);
  const build = JSON.parse(
    await readFile(join(f.input.artifacts, 'build.json')),
  ).body;
  execFileSync('git', [
    '-C',
    build.result.integrationPath,
    'reset',
    '--hard',
    f.spec.baseCommit,
  ]);
  await assert.rejects(f.run('verify'), /Evidence drift|revision drifted/);
  await assert.rejects(f.run('deliver'));
});
test('candidate, evidence, policy and native drift invalidate closeout', async (t) => {
  const f = await fixture(t);
  for (const s of stages) await f.run(s);
  await finalizeReviewedLocalCandidate(f.input);
  await assert.rejects(
    verifyReviewedLocalCandidate({ ...f.input, nativeRunId: 'wrong-native' }),
    /binding drift/,
  );
  const record = JSON.parse(
    await readFile(join(f.input.artifacts, 'review.json')),
  );
  const ref = record.body.refs.find((x) => x.path.endsWith('/final.json'));
  const bytes = await readFile(ref.path);
  await writeFile(ref.path, 'changed');
  await assert.rejects(verifyReviewedLocalCandidate(f.input), /Evidence drift/);
  await writeFile(ref.path, bytes);
  f.spec.policySha256 = '0'.repeat(64);
  await f.save();
  await assert.rejects(verifyReviewedLocalCandidate(f.input), /request digest/);
});
test('uncertain dispatch never triggers a replacement worker', async (t) => {
  const f = await fixture(t);
  await f.run('investigate');
  await f.run('plan');
  await writeFile(join(f.input.artifacts, 'build.intent.json'), '{}');
  await assert.rejects(f.run('build'), /Uncertain stage/);
  assert.equal(await readFile(f.counter, 'utf8'), 'architect\n');
});
test('cancellation terminates owned worker and cannot publish successful build', async (t) => {
  const f = await fixture(t, 'builder-wait');
  await f.run('investigate');
  await f.run('plan');
  const controller = new AbortController();
  const promise = captureReviewedLocalCandidate({
    ...f.input,
    stage: 'build',
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 1000);
  await assert.rejects(promise);
  await assert.rejects(f.run('review'));
  await assert.rejects(finalizeReviewedLocalCandidate(f.input));
});

test('accepted builder capture reconciliation in a fresh process reuses the exact child without rebuilding', async (t) => {
  const f = await fixture(t);
  for (const stage of stages.slice(0, 3)) await f.run(stage);
  const bytes = await readFile(join(f.input.artifacts, 'build.json'));
  await rm(join(f.input.artifacts, 'build.json'));
  await assert.rejects(f.run('build'), /Uncertain stage/);
  const count = await readFile(f.counter, 'utf8');
  const intent = await readFile(join(f.input.artifacts, 'build.intent.json'));
  const nativeExecutable = join(f.root, 'native-supervisor');
  const nativeRecord = join(f.root, 'native-supervision.json');
  await writeFile(
    nativeExecutable,
    `#!${process.execPath}\nconsole.log(require('node:fs').readFileSync(${JSON.stringify(nativeRecord)},'utf8'))\n`,
    { mode: 0o700 },
  );
  const nativeSha = digest(await readFile(nativeExecutable));
  await writeFile(
    nativeRecord,
    JSON.stringify({
      id: f.input.nativeRunId,
      status: 'running',
      workflow_name: 'temari-reviewed-local-candidate',
      working_path: f.spec.repositoryRoot,
      metadata: {
        inputs: {
          temari_binding: JSON.stringify({
            schema: 1,
            harnessId: 'archon',
            harnessVersion: '0.10.1',
            workspaceRoot: f.spec.repositoryRoot,
            runId: f.spec.runId,
            revision: f.spec.baseCommit,
            planSha256: objectDigest(f.spec.plan),
            entrypoint: 'temari-reviewed-local-candidate',
          }),
          request_sha256: f.input.expectedSha256,
          native_home: f.root,
          native_executable: nativeExecutable,
          native_executable_sha256: nativeSha,
        },
      },
    }),
  );
  const output = execFileSync(
    process.execPath,
    [
      '--import',
      '@swc-node/register/esm-register',
      'packages/workflow-runtime/host/reviewed-local-candidate.mjs',
      'capture',
      '--spec',
      f.input.specPath,
      '--sha256',
      f.input.expectedSha256,
      '--artifacts',
      f.input.artifacts,
      '--workflow-id',
      f.input.nativeRunId,
      '--stage',
      'build',
      '--intent-sha256',
      digest(intent),
    ],
    {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env,
        INPUTS_NATIVE_EXECUTABLE: nativeExecutable,
        INPUTS_NATIVE_EXECUTABLE_SHA256: nativeSha,
        INPUTS_NATIVE_HOME: f.root,
      },
    },
  );
  assert.equal(JSON.parse(output).status, 'PASS');
  assert.equal(await readFile(f.counter, 'utf8'), count);
  assert.equal(
    count.split('\n').filter((role) => role === 'builder').length,
    1,
  );
  const recovered = JSON.parse(
    await readFile(join(f.input.artifacts, 'build.json')),
  ).body;
  const original = JSON.parse(bytes).body;
  assert.deepEqual(recovered.result, original.result);
  assert.deepEqual(recovered.refs, original.refs);
});
test('a cancellation arriving after completed build cannot relaunch it', async (t) => {
  const f = await fixture(t);
  for (const stage of stages.slice(0, 3)) await f.run(stage);
  const count = await readFile(f.counter, 'utf8');
  const controller = new AbortController();
  controller.abort();
  await captureReviewedLocalCandidate({
    ...f.input,
    stage: 'build',
    signal: controller.signal,
  });
  assert.equal(await readFile(f.counter, 'utf8'), count);
});

test('route-specific task closeout checks native identity, canonical evidence and concurrent control', async (t) => {
  const f = await fixture(t);
  for (const stage of stages) await f.run(stage);
  const completion = await finalizeReviewedLocalCandidate(f.input);
  const store = await FileTaskStore.create(join(f.root, 'tasks'));
  await store.createTask({
    taskId: f.spec.taskId,
    title: 'Fixture',
    goal: 'Fixture',
    workspaceRoot: f.spec.repositoryRoot,
    actor: 'fixture',
    idempotencyKey: 'create',
  });
  await store.bindRun({
    taskId: f.spec.taskId,
    actor: 'fixture',
    idempotencyKey: 'bind',
    expectedVersion: 1,
    run: {
      runId: f.spec.runId,
      revision: f.spec.baseCommit,
      plan: f.spec.plan,
    },
  });
  let status = 'SUCCEEDED';
  const bridgePath=await realpath(new URL('../packages/workflow-runtime/host/reviewed-local-candidate.mjs',import.meta.url));
  const bridgeRuntimeExecutable=await realpath(process.execPath);
  const paths={specPath:f.input.specPath,bridgePath,expectedRequestSha256:f.input.expectedSha256,expectedBridgeSha256:digest(await readFile(bridgePath)),bridgeRuntimeExecutable,bridgeRuntimeSha256:digest(await readFile(bridgeRuntimeExecutable))};
  const harness = {
    id: 'fixture',
    version: '1',
    start:async()=>{throw new Error('Generic start cannot admit a managed candidate.');},
    startReviewedLocalCandidate: async (req,selected) => {
      assert.deepEqual(selected,paths);
      assert.equal(digest(await readFile(selected.specPath)),selected.expectedRequestSha256);
      assert.equal(digest(await readFile(selected.bridgePath)),selected.expectedBridgeSha256);
      assert.equal(digest(await readFile(selected.bridgeRuntimeExecutable)),selected.bridgeRuntimeSha256);
      return {
      schema: 1,
      harnessId: 'fixture',
      harnessVersion: '1',
      runId: req.runId,
      revision: req.revision,
      planSha256: objectDigest(req.plan),
      workspaceRoot: req.workspaceRoot,
      entrypoint: 'temari-reviewed-local-candidate',
      externalRunId: f.input.nativeRunId,
      startedAt: new Date().toISOString(),
    };},
    verifyRunIdentity: async (ref) =>
      assert.equal(ref.externalRunId, f.input.nativeRunId),
    status: async () => ({
      status,
      observedAt: new Date().toISOString(),
      summary: 'fixture status',
      rawLogPath: null,
    }),
  };
  const selection = {
    hostHarness: harness,
    configuredHarness: null,
    managedDefault: null,
  };
  const runtime = new TaskRuntime({ store, selection });
  let snapshot = (await runtime.dispatchReviewedLocalCandidate({
    taskId: f.spec.taskId,
    runId: f.spec.runId,
    actor: 'fixture',
    idempotencyKey: 'dispatch',
    expectedVersion: 2,
    paths,
  })).task;
  snapshot = await runtime.observeNative({
    taskId: f.spec.taskId,
    runId: f.spec.runId,
    actor: 'fixture',
    idempotencyKey: 'observe',
    expectedVersion: snapshot.version,
  });
  await store.attachEvidenceRoots({
    taskId: f.spec.taskId,
    runId: f.spec.runId,
    actor: 'fixture',
    idempotencyKey: 'evidence',
    expectedVersion: snapshot.version,
    receiptRoot: join(
      f.input.artifacts,
      'reviewed-local-candidate',
      'receipts',
    ),
    evidenceRoot: join(
      f.input.artifacts,
      'reviewed-local-candidate',
      'evidence',
    ),
  });
  const options = {
    store,
    selection,
    taskId: f.spec.taskId,
    runId: f.spec.runId,
    requestSha256: f.input.expectedSha256,
    policySha256: f.spec.policySha256,
    verifyCandidate: async () => {
      await verifyReviewedLocalCandidate(f.input);
      return completion;
    },
  };
  assert.equal(
    (await readReviewedLocalCandidateResult(options)).candidate.commit,
    completion.candidate.commit,
  );
  status = 'CANCELLED';
  await assert.rejects(
    readReviewedLocalCandidateResult(options),
    /has not succeeded/,
  );
  status = 'SUCCEEDED';
  await assert.rejects(
    readReviewedLocalCandidateResult({
      ...options,
      verifyCandidate: async () => {
        const task = await store.load(f.spec.taskId);
        await store.updateTask({
          taskId: f.spec.taskId,
          actor: 'fixture',
          idempotencyKey: 'concurrent',
          expectedVersion: task.version,
          nextAction: 'Reconcile cancellation race',
        });
        return completion;
      },
    }),
    /Task changed/,
  );
});

test('unsupported inherited model is refused without native/worker dispatch or settings substitution', async (t) => {
  const f = await fixture(t);
  const config = f.spec.modelAdmission.configPath;
  await writeFile(
    config,
    'model = "unsupported-host-alias"\nmodel_reasoning_effort = "high"\n',
  );
  f.spec.providerSelection.model = 'unsupported-host-alias';
  f.spec.modelAdmission.configSha256 = digest(await readFile(config));
  f.spec.protectedInputs.find((x) => x.path === config).sha256 =
    f.spec.modelAdmission.configSha256;
  const expectedSha256 = await f.save();
  await assert.rejects(
    admitReviewedLocalCandidate({ ...f.input, expectedSha256 }),
    /Unsupported selected Codex CLI model/,
  );
  await assert.rejects(readFile(f.counter), { code: 'ENOENT' });
  assert.match(await readFile(config, 'utf8'), /unsupported-host-alias/);
});

test('a failing protected check process blocks delivery on an otherwise clean candidate', async (t) => {
  const f = await fixture(t, 'check-fail');
  for (const stage of stages.slice(0, 4)) await f.run(stage);
  await assert.rejects(f.run('verify'), /Protected check failed/);
  await assert.rejects(f.run('deliver'));
  const processEvidence = JSON.parse(
    await readFile(
      join(f.spec.evidenceRoot, f.spec.runId, 'checks-acceptance/0.json'),
      'utf8',
    ),
  );
  assert.equal(processEvidence.code, 1);
  assert.equal(processEvidence.cancelled, false);
  await assert.rejects(finalizeReviewedLocalCandidate(f.input));
});

test('parent cancel intent revokes builder authority before native cancellation is observed', async (t) => {
  const f = await fixture(t, 'builder-wait');
  await f.run('investigate');
  await f.run('plan');
  const tasks = await FileTaskStore.create(f.spec.taskStoreRoot);
  let task = await tasks.load(f.spec.taskId);
  const builder = f.run('build');
  const stopped = assert.rejects(builder);
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    if ((await readFile(f.counter, 'utf8')).includes('builder')) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert((await readFile(f.counter, 'utf8')).includes('builder'));
  await tasks.append(
    {
      taskId: f.spec.taskId,
      actor: 'fixture',
      expectedVersion: task.version,
      idempotencyKey: 'cancel-intent',
    },
    { type: 'control-requested', runId: f.spec.runId, kind: 'cancel' },
  );
  await stopped;
  assert.equal(
    (await tasks.load(f.spec.taskId)).runs[0].operations.at(-1).state,
    'PENDING',
  );
  await assert.rejects(readFile(join(f.input.artifacts, 'build.json')), {
    code: 'ENOENT',
  });
  const children = await FileChildTaskStore.create(
    join(f.spec.evidenceRoot, f.spec.runId, 'children'),
  );
  const records = await children.executionRecords(f.spec.runId);
  const build = records.filter(
    (record) => record.execution && record.taskId.includes('-build-control-'),
  );
  assert.equal(build.length, 1);
  assert.equal(build[0].execution.state, 'CLEANED');
  assert.equal(build[0].result, null);
});

test('worker lease loss propagates into the owned operation rather than leaving it running', async (t) => {
  const f = await fixture(t, 'builder-wait');
  await f.run('investigate');
  await f.run('plan');
  const original = FileChildTaskStore.prototype.renew;
  let lost = false;
  FileChildTaskStore.prototype.renew = async function (request) {
    if (request.owner === 'archon:build') {
      lost = true;
      throw new Error('Fixture worker lease lost.');
    }
    return original.call(this, request);
  };
  t.after(() => {
    FileChildTaskStore.prototype.renew = original;
  });
  const started = Date.now();
  await assert.rejects(f.run('build'));
  assert(lost);
  assert(
    Date.now() - started < 9500,
    'Lease loss must stop before the synthetic worker timeout.',
  );
  const store = await FileChildTaskStore.create(
    join(f.spec.evidenceRoot, f.spec.runId, 'children'),
  );
  const records = await store.executionRecords(f.spec.runId);
  const worker = records.find(
    (record) => record.execution && record.taskId.includes('-build-control-'),
  );
  assert.equal(worker.execution.state, 'CLEANED');
  assert.equal(worker.result, null);
  await assert.rejects(readFile(join(f.input.artifacts, 'build.json')), {
    code: 'ENOENT',
  });
});
