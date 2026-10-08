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
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  admitReviewedLocalCandidate,
  captureReviewedLocalCandidate,
  finalizeReviewedLocalCandidate,
  verifyReviewedLocalCandidate,
  digest,
  objectDigest,
} from '../packages/workflow-runtime/host/reviewed-local-candidate.mjs';
import {
  REVIEWED_LOCAL_CANDIDATE_POLICY,
  createReviewedLocalCandidatePlan,
} from '../libs/temari-core/src/index.ts';
import {
  FileTaskStore,
  TaskRuntime,
  readReviewedLocalCandidateResult,
} from '../libs/runtime/src/index.ts';

async function fixture(t, mode = 'pass') {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'managed-candidate-')),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
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
if(a.includes('--help')){console.log('--sandbox --output-schema --json');process.exit(0);}
if(a[0]==='login'){console.log('Logged in using fixture');process.exit(0);}
let p='';process.stdin.on('data',x=>p+=x);process.stdin.on('end',()=>{
 if(a.includes('--ignore-user-config'))process.exit(9);
 const role=p.includes('isolated Git clone')?'builder':p.includes('Role: reviewer')?'reviewer':'architect';
 fs.appendFileSync(${JSON.stringify(counter)},role+'\\n');
 const mode=JSON.parse(fs.readFileSync(${JSON.stringify(control)},'utf8')).mode;
 if(mode===role+'-crash')process.exit(7);
 if(mode==='builder-wait' && role==='builder'){setInterval(()=>{},1000);return;}
 const cwd=a[a.indexOf('--cd')+1];
 if(role==='builder'){fs.writeFileSync(path.join(cwd,'value.txt'),'implemented\\n');if(mode==='unowned')fs.writeFileSync(path.join(cwd,'protected.txt'),'bad\\n');}
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
    runId: 'fixture-managed',
    taskId: 'fixture-task',
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
  const expectedSha256 = await save();
  return {
    root,
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
    },
    run: (stage) =>
      captureReviewedLocalCandidate({
        specPath,
        expectedSha256,
        artifacts,
        nativeRunId: 'native-fixture',
        stage,
      }),
  };
}
const stages = ['investigate', 'plan', 'build', 'review', 'verify', 'deliver'];
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
    `#!${process.execPath}\nconsole.log(process.argv.includes('--version')?'codex-cli 0.162.0':'unsupported');\n`,
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

test('accepted builder capture reconciliation reuses the exact child without rebuilding', async (t) => {
  const f = await fixture(t);
  for (const stage of stages.slice(0, 3)) await f.run(stage);
  const bytes = await readFile(join(f.input.artifacts, 'build.json'));
  await rm(join(f.input.artifacts, 'build.json'));
  await assert.rejects(f.run('build'), /Uncertain stage/);
  const count = await readFile(f.counter, 'utf8');
  const intent = await readFile(join(f.input.artifacts, 'build.intent.json'));
  await captureReviewedLocalCandidate({
    ...f.input,
    stage: 'build',
    reconcileIntentSha256: digest(intent),
  });
  assert.equal(await readFile(f.counter, 'utf8'), count);
  assert.equal(
    JSON.parse(await readFile(join(f.input.artifacts, 'build.json'))).body
      .result.integratedCommit,
    JSON.parse(bytes).body.result.integratedCommit,
  );
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
  const harness = {
    id: 'fixture',
    version: '1',
    start: async (req) => ({
      schema: 1,
      harnessId: 'fixture',
      harnessVersion: '1',
      runId: req.runId,
      revision: req.revision,
      planSha256: objectDigest(req.plan),
      workspaceRoot: req.workspaceRoot,
      entrypoint: req.entrypoint,
      externalRunId: f.input.nativeRunId,
      startedAt: new Date().toISOString(),
    }),
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
  let snapshot = await runtime.dispatch({
    taskId: f.spec.taskId,
    runId: f.spec.runId,
    actor: 'fixture',
    idempotencyKey: 'dispatch',
    expectedVersion: 2,
    entrypoint: 'temari-reviewed-local-candidate',
    inputs: {},
  });
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
