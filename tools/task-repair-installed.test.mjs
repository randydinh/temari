import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspect } from 'node:util';
import { after, before, test } from 'node:test';
import {
  packagePublicEntries,
  manifestSha256,
} from './public-entry-runtime.mjs';
import {
  FileTaskStore,
  TaskRuntime,
  taskDigest,
  executeAndPersist,
  FileWorkflowReceiptStore,
  FileWorkflowCheckpointStore,
  FileEvidenceStore,
  FileChildTaskStore,
} from '../libs/runtime/src/index.ts';
import { minimalPlan, HOST_CAPABILITIES } from '../libs/contracts/src/index.ts';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const encoded = (value) => `${JSON.stringify(value, null, 2)}\n`;
let buildRoot, artifact, artifactDigest;
before(async () => {
  buildRoot = await realpath(
    await mkdtemp(join(tmpdir(), 'repair-installed-build-')),
  );
  artifact = join(buildRoot, 'installed');
  artifactDigest = manifestSha256(await packagePublicEntries(artifact));
});
after(async () => {
  if (buildRoot && !process.env.TEMARI_REPAIR_EXPORT_PATH)
    await rm(buildRoot, { recursive: true, force: true });
});
const brokenProduct = `import fs from 'node:fs';
const [statePath, correction] = process.argv.slice(2);
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { seen: [], launches: 0 };
state.launches++; state.seen.push(correction);
fs.writeFileSync(statePath, JSON.stringify(state)); console.log(JSON.stringify(state));
`;
const fixedProduct = brokenProduct.replace(
  'state.launches++; state.seen.push(correction);',
  'if (!state.seen.includes(correction)) { state.launches++; state.seen.push(correction); }',
);
const buildProductScript = `import fs from 'node:fs'; import {join} from 'node:path'; import {execFileSync} from 'node:child_process'; import {createHash} from 'node:crypto';
const [candidate, artifact] = process.argv.slice(2); fs.mkdirSync(artifact);
const hash = b => createHash('sha256').update(b).digest('hex');
for (const name of ['product.mjs', 'policy.json']) fs.copyFileSync(join(candidate,name),join(artifact,name));
const files = ['product.mjs','policy.json'].map(path=>{const b=fs.readFileSync(join(artifact,path));return {path,bytes:b.length,sha256:hash(b)}});
const revision=execFileSync('git',['-C',candidate,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
fs.writeFileSync(join(artifact,'public-entry-manifest.json'),JSON.stringify({schemaVersion:1,source:{revision,dirty:false,files},files},null,2)+'\\n');
`;
const regressionScript = `import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os'; import {join} from 'node:path'; import {execFileSync} from 'node:child_process';
const artifact=process.argv[2], root=fs.mkdtempSync(join(os.tmpdir(),'repair-product-check-')), state=join(root,'state.json');
try {
  const invoke=id=>JSON.parse(execFileSync(process.execPath,[join(artifact,'product.mjs'),state,id],{encoding:'utf8'}));
  invoke('same'); const repeated=invoke('same');
  fs.writeFileSync(1,'x'.repeat(1024*1024+123));
  assert.equal(repeated.launches,1,'repeated corrections must not dispatch a second repair');
  assert.equal(invoke('different').launches,2,'different corrections remain independent');
} finally {fs.rmSync(root,{recursive:true,force:true});}
`;

async function fixture(
  t,
  {
    active = false,
    canonical = false,
    acceptParent = true,
    authority = true,
    retain = false,
  } = {},
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'repair-installed-')),
  );
  if (!retain) t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'source');
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@localhost']);
  await writeFile(join(repo, 'product.mjs'), brokenProduct);
  await writeFile(
    join(repo, 'policy.json'),
    '{"fixture":"installed correction handling"}\n',
  );
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-qm', 'broken durable product']);
  const revision = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  const buildScript = join(root, 'build-product.mjs'),
    assertion = join(root, 'regression.mjs');
  await writeFile(buildScript, buildProductScript);
  await writeFile(assertion, regressionScript);
  const baseline = join(root, 'baseline');
  execFileSync(process.execPath, [buildScript, repo, baseline]);
  const executable = join(root, 'codex'),
    countPath = join(root, 'workers.jsonl');
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs=require('node:fs');const args=process.argv.slice(2), final=args[args.indexOf('--output-last-message')+1], writing=args[args.indexOf('--sandbox')+1]==='workspace-write';
fs.appendFileSync(${JSON.stringify(countPath)},JSON.stringify({pid:process.pid,writing})+'\\n');
process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>{if(writing)fs.writeFileSync('product.mjs',${JSON.stringify(fixedProduct)}); else if(!fs.readFileSync('product.mjs','utf8').includes('!state.seen.includes(correction)'))process.exit(4);fs.writeFileSync(final,JSON.stringify({status:'PASS',summary:writing?'fixed durable behavior':'independently reviewed exact candidate'}));},writing?1200:150));
`,
  );
  await chmod(executable, 0o755);
  const evidenceRoot = join(root, 'evidence');
  await mkdir(evidenceRoot);
  const brief = (goal) => ({
    goal,
    context: 'Actual installed product regression',
    scope: 'product.mjs',
    acceptanceCriteria: ['Retain correction idempotency'],
    verificationCommand: null,
    reportFormat: 'json',
    forbiddenActions: ['Only edit product.mjs', 'Do not publish'],
  });
  const profile = {
    schemaVersion: 1,
    id: 'fixture-repair',
    taskId: 'parent',
    workspaceRoot: repo,
    candidateRoot: repo,
    baseCommit: revision,
    evidenceRoot,
    scopes: ['product'],
    regressionContract: 'fresh-installed-correction-v1',
    executable,
    executableSha256: hash(await readFile(executable)),
    timeoutMs: 20000,
    builder: {
      id: 'builder',
      role: 'implementer',
      required: true,
      brief: brief('repair'),
    },
    reviewer: {
      id: 'reviewer',
      role: 'reviewer',
      required: true,
      brief: brief('review'),
    },
    owns: [{ kind: 'file', path: 'product.mjs' }],
    verify: [{ program: process.execPath, args: ['--check', 'product.mjs'] }],
    prepare: [],
    baselineArtifact: {
      root: baseline,
      manifestSha256: hash(
        await readFile(join(baseline, 'public-entry-manifest.json')),
      ),
    },
    buildArtifact: {
      program: process.execPath,
      args: [buildScript, '$CANDIDATE', '$ARTIFACT'],
    },
    regression: [{ program: process.execPath, args: [assertion, '$ARTIFACT'] }],
    commandInputs: await Promise.all(
      [process.execPath, buildScript, assertion].map(async (path) => ({
        path,
        sha256: hash(await readFile(path)),
      })),
    ),
  };
  const profilePath = join(root, 'authority.json');
  await writeFile(profilePath, encoded(profile));
  const taskRoot = join(root, 'tasks'),
    store = await FileTaskStore.create(taskRoot);
  let parent = await store.createTask({
    taskId: 'parent',
    actor: 'coordinator',
    idempotencyKey: 'create',
    title: 'Original work',
    goal: 'Continue original authorized work',
    workspaceRoot: repo,
  });
  if (active || canonical) {
    const receiptRoot = join(root, 'receipts'),
      stageEvidenceRoot = join(root, 'stage-evidence');
    parent = await store.bindRun({
      taskId: 'parent',
      actor: 'coordinator',
      idempotencyKey: 'bind',
      expectedVersion: parent.version,
      run: {
        runId: 'parent-run',
        revision: 'parent-revision',
        plan: minimalPlan(),
        ...(canonical ? { receiptRoot, evidenceRoot: stageEvidenceRoot } : {}),
      },
    });
    if (active)
      parent = (
        await store.append(
          {
            taskId: 'parent',
            actor: 'coordinator',
            idempotencyKey: 'dispatch',
            expectedVersion: parent.version,
          },
          {
            type: 'dispatch-requested',
            runId: 'parent-run',
            entrypoint: 'work',
            inputs: {},
            harnessId: 'fixture',
            harnessVersion: '1',
          },
        )
      ).task;
    if (canonical) {
      await executeAndPersist({
        runId: 'parent-run',
        revision: 'parent-revision',
        plan: minimalPlan(),
        capabilities: {
          host: 'fixture',
          available: [],
          missing: HOST_CAPABILITIES,
          notes: {},
        },
        store: await FileWorkflowReceiptStore.create(receiptRoot),
        checkpointStore: await FileWorkflowCheckpointStore.create(
          join(root, 'checkpoints'),
        ),
        stageEvidence: {
          store: await FileEvidenceStore.create(stageEvidenceRoot),
        },
        handler: (stage) => ({
          status: 'PASS',
          summary: `${stage} passed`,
          evidence: [
            {
              name: 'check',
              kind: 'verification',
              content: 'Observed canonical parent evidence',
            },
          ],
        }),
      });
      if (acceptParent) {
        const done = await new TaskRuntime({ store }).accept({
          taskId: 'parent',
          runId: 'parent-run',
          actor: 'coordinator',
          idempotencyKey: 'accept-parent',
          expectedVersion: parent.version,
          reason: 'Reviewed verified canonical parent work.',
        });
        assert.equal(done.status, 'DONE');
        parent = done;
      }
    }
  }
  parent = await store.handoffTask({
    taskId: 'parent',
    actor: 'coordinator',
    idempotencyKey: 'authority',
    expectedVersion: parent.version,
    handoff: {
      summary: 'Original task authority retained independently.',
      decisions: [],
      nextAction: 'Continue original authorized work',
      blocker: null,
      contextRefs: authority
        ? [
            {
              kind: 'repair-authority',
              location: profilePath,
              sha256: hash(encoded(profile)),
            },
          ]
        : [],
    },
  });
  const owningPolicy = JSON.parse(
    await readFile(join(artifact, 'policy.json'), 'utf8'),
  );
  const owningRequest = {
    schemaVersion: 1,
    entry: 'temari',
    route: 'lightweight-engineering',
    profile: 'lightweight-engineering-v1',
    obligations: owningPolicy.lightweight.obligations,
    routeInput: {
      workType: 'feature',
      lightweight: {
        resultIsClearLocalAndReversible: true,
        changesSharedBoundary: false,
        isReportedDefect: false,
        hasUnexplainedSymptom: false,
        makesPerformanceClaim: false,
        isDesignChoice: false,
        isMigration: false,
        affectedCallersAreKnown: true,
        crossesArchitecturalBoundary: false,
        directCheckAvailable: true,
      },
    },
    invocation: {
      runId: 'owning-public-task',
      revision,
      candidate: { scopeId: 'product', root: repo },
      runDirectory: join(root, 'owning-run'),
    },
  };
  const owningRequestPath = join(root, 'owning-request.json');
  await writeFile(owningRequestPath, encoded(owningRequest));
  const selection = {
    schemaVersion: 1,
    taskRoot,
    taskId: 'parent',
    workspaceRoot: repo,
    authority: { path: profilePath, sha256: hash(encoded(profile)) },
    owningInvocation: {
      artifactRoot: artifact,
      manifestSha256: artifactDigest,
      requestPath: owningRequestPath,
      requestSha256: hash(encoded(owningRequest)),
      hostProofSha256: null,
    },
  };
  const selectionPath = join(root, 'selection.json');
  await writeFile(selectionPath, encoded(selection));
  const counterexample = join(root, 'counterexample.txt');
  await writeFile(
    counterexample,
    'Two invocations of the same installed correction create two repair launches.\n',
  );
  const report = {
    repairId: 'repeat-correction',
    counterexample: 'The same correction launches twice after a fresh process.',
    affectedSurface: 'installed product CLI',
    expectedInvariant:
      'Repeated correction retains one launch and distinct corrections retain distinct launches.',
    evidenceRefs: [
      {
        kind: 'counterexample',
        location: counterexample,
        sha256: hash(await readFile(counterexample)),
      },
    ],
    requestedScopes: ['product'],
    regressionContract: profile.regressionContract,
    requiredRoute: 'lightweight-engineering',
  };
  const launchId = `repair-${taskDigest(['parent', report.repairId, report]).slice(0, 48)}`;
  const launchRoot = join(evidenceRoot, launchId);
  const args = async (mode, payload) => {
    const requestPath = join(root, `request-${mode}-${Math.random()}.json`);
    await writeFile(requestPath, encoded(payload));
    return [
      join(artifact, 'bin/temari.mjs'),
      'repair',
      mode,
      '--request',
      requestPath,
      '--expected-request-sha256',
      hash(encoded(payload)),
      '--expected-manifest-sha256',
      artifactDigest,
      '--task-selection',
      selectionPath,
      '--expected-task-selection-sha256',
      hash(encoded(selection)),
    ];
  };
  const invoke = async (mode, payload, expected = 0) => {
    const argv = await args(mode, payload);
    const result = await new Promise((done) =>
      execFile(
        process.execPath,
        argv,
        {
          encoding: 'utf8',
          timeout: 30000,
          maxBuffer: 4 * 1024 * 1024,
          env: {
            ...process.env,
            PATH: `${root}:${process.env.PATH}`,
            NODE_OPTIONS: '',
            NODE_PATH: '',
          },
        },
        (error, stdout, stderr) =>
          done({ code: error?.code ?? 0, stdout, stderr }),
      ),
    );
    assert.equal(result.code, expected, `${result.stderr}\n${result.stdout}`);
    return expected ? result : JSON.parse(result.stdout);
  };
  const command = (version, key = 'signal') => ({
    taskId: 'parent',
    actor: 'coordinator',
    idempotencyKey: key,
    expectedVersion: version,
    report,
  });
  return {
    root,
    store,
    parent,
    report,
    command,
    args,
    invoke,
    launchRoot,
    countPath,
    selection,
    selectionPath,
    profile,
    profilePath,
    owningRequest,
    owningRequestPath,
  };
}
async function until(action, predicate, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const value = await action();
      if (predicate(value)) return value;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error('Timed out waiting for observed repair process.');
}

test('installed controller retention preserves an early nested cause and raw log beyond 16 MiB', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'repair-controller-capture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { retainRepairControllerFailure } = await import(
    pathToFileURL(join(artifact, 'host/task-repair.mjs')).href
  );
  const raw = 'RAW-CONTROLLER-' + 'r'.repeat(16 * 1024 * 1024 + 123);
  await writeFile(join(root, 'supervisor.log'), raw);
  const error = new Error('Launch controller failed before child handler', {
    cause: new Error('NESTED-CONTROLLER-' + 'c'.repeat(16 * 1024 * 1024 + 123)),
  });
  const expected = inspect(error, {
    depth: null,
    maxStringLength: null,
    maxArrayLength: null,
    customInspect: false,
    getters: false,
  });
  const repair = {
    admission: {
      executionId: 'repair-controller',
      revision: 'pinned',
      selectionSha256: 'a'.repeat(64),
    },
    launch: { launchId: 'repair-controller' },
    reportSha256: 'b'.repeat(64),
  };
  const retained = await retainRepairControllerFailure(
    { FileEvidenceStore },
    root,
    repair,
    error,
  );
  assert.equal(retained.evidence.bytes, Buffer.byteLength(expected));
  assert.equal(retained.evidence.sha256, hash(expected));
  const observationBytes = await readFile(retained.reference.location);
  assert.equal(hash(observationBytes), retained.reference.sha256);
  const observation = JSON.parse(observationBytes);
  assert.equal(observation.sources[0].bytes, Buffer.byteLength(raw));
  assert.equal(observation.sources[0].sha256, hash(raw));
  const evidence = await FileEvidenceStore.openExisting(
    join(root, 'failure-evidence'),
  );
  for (const ref of [observation.evidence, ...observation.sources])
    await evidence.verifyPortable(ref);
  await rm(
    join(root, 'failure-evidence', `${retained.evidence.sha256}.artifact`),
  );
  await assert.rejects(evidence.verifyPortable(retained.evidence), /ENOENT/);
});

async function finishAndAccept(f) {
  const complete = await until(
    () => f.invoke('status', { taskId: 'parent', repairId: f.report.repairId }),
    (value) => value.repairSnapshots[0].state === 'NEEDS_REVIEW',
  );
  const path = join(f.launchRoot, 'regression.json'),
    proof = JSON.parse(await readFile(path, 'utf8'));
  const selection = {
    candidateRoot: proof.candidateRoot,
    revision: proof.revision,
    artifactRoot: proof.artifactRoot,
    manifestSha256: proof.manifestSha256,
    evidencePath: path,
    evidenceSha256: hash(await readFile(path)),
  };
  const accepted = await f.invoke('accept', {
    taskId: 'parent',
    actor: 'coordinator',
    idempotencyKey: 'accept-reviewed-repair',
    expectedVersion: complete.version,
    repairId: f.report.repairId,
    selection,
    reason:
      'Coordinator reviewed the pinned counterexample, exact candidate, independent process review and fresh installed assertion.',
  });
  return { accepted, selection, proof };
}

test('resolution reopens counterexample and regression helper byte identities', async (t) => {
  for (const mode of [
    'counterexample-deleted',
    'counterexample-tampered',
    'assertion-tampered',
  ])
    await t.test(mode, async (t) => {
      const f = await fixture(t, { canonical: true });
      await f.invoke('start', f.command(f.parent.version));
      const { accepted } = await finishAndAccept(f);
      assert.equal(accepted.status, 'DONE');
      if (mode === 'counterexample-deleted')
        await rm(f.report.evidenceRefs[0].location);
      if (mode === 'counterexample-tampered')
        await writeFile(
          f.report.evidenceRefs[0].location,
          'Different alleged failure',
        );
      if (mode === 'assertion-tampered')
        await writeFile(f.profile.regression[0].args[0], 'process.exit(0);\n');
      const invalid = await f.invoke('status', {
        taskId: 'parent',
        repairId: f.report.repairId,
      });
      assert.equal(invalid.repairSnapshots[0].state, 'BLOCKED');
      assert.equal(invalid.status, 'BLOCKED');
      assert.equal(invalid.semanticAcceptance, false);
    });
});

test('changing the same regression helper between baseline and fresh execution cannot produce repair PASS', async (t) => {
  const f = await fixture(t);
  const started = await f.invoke('start', f.command(f.parent.version));
  assert.equal(started.repairSnapshots[0].state, 'RUNNING');
  await writeFile(f.profile.regression[0].args[0], 'process.exit(0);\n');
  const ended = await until(
    () => readFile(join(f.launchRoot, 'ended.json'), 'utf8'),
    Boolean,
  );
  assert.equal(JSON.parse(ended).completed, false);
  const terminal = JSON.parse(ended);
  assert.equal(terminal.failureRef.kind, 'repair-controller-failure');
  assert.equal(
    hash(await readFile(terminal.failureRef.location)),
    terminal.failureRef.sha256,
  );
  const childStore = await FileChildTaskStore.create(
    started.repairs[0].admission.childRef.storeRoot,
  );
  const group = await childStore.loadGroup(
    started.repairs[0].admission.childRef.groupId,
  );
  const child = await childStore.load(group.taskIds[0]);
  assert.equal(child.failureDiagnostics.status, 'retained');
  assert(
    child.failureDiagnostics.references.some(
      (ref) => ref.kind === 'stdout' && ref.bytes === 1024 * 1024 + 123,
    ),
    'Required diagnostics retain the complete owned baseline output.',
  );
  const diagnostics = await FileEvidenceStore.openExisting(
    join(f.launchRoot, 'failure-evidence'),
  );
  for (const ref of child.failureDiagnostics.references)
    await diagnostics.verifyPortable(ref);
  const status = await f.invoke('status', {
    taskId: 'parent',
    repairId: f.report.repairId,
  });
  assert.notEqual(status.repairSnapshots[0].state, 'RESOLVED');
  assert.notEqual(status.repairSnapshots[0].state, 'NEEDS_REVIEW');
  assert.match(
    status.repairSnapshots[0].issues[0],
    /command\/helper\/input bytes changed/,
  );
  const refusal = await f.invoke(
    'readmit',
    f.command(status.version, 'forbidden-uncertain-retry'),
    1,
  );
  assert.match(refusal.stderr, /never-launched BLOCKED/);
  assert.equal(
    (await readFile(f.countPath, 'utf8')).trim().split('\n').length,
    2,
  );
  await writeFile(f.profile.regression[0].args[0], regressionScript);
  const restoredHelper = await f.invoke('status', {
    taskId: 'parent',
    repairId: f.report.repairId,
  });
  assert.equal(restoredHelper.repairSnapshots[0].state, 'FAILED');
  await rm(terminal.failureRef.location);
  const missingController = await f.invoke('status', {
    taskId: 'parent',
    repairId: f.report.repairId,
  });
  assert.equal(missingController.repairSnapshots[0].state, 'RECOVERY_REQUIRED');
  assert.match(missingController.repairSnapshots[0].issues[0], /ENOENT/);
  assert(
    missingController.repairSnapshots[0].issues[0].includes(
      terminal.failureRef.location,
    ),
  );
});

test('explicit fresh-authority re-admission replaces one never-launched BLOCKED obligation and preserves its history', async (t) => {
  const f = await fixture(t, { canonical: true });
  f.owningRequest.routeInput.lightweight.changesSharedBoundary = true;
  await writeFile(f.owningRequestPath, encoded(f.owningRequest));
  f.selection.owningInvocation.requestSha256 = hash(encoded(f.owningRequest));
  await writeFile(f.selectionPath, encoded(f.selection));
  const blocked = await f.invoke('start', f.command(f.parent.version));
  assert.equal(blocked.repairSnapshots[0].state, 'BLOCKED');
  assert.equal(blocked.repairs[0].launch, null);
  f.owningRequest.routeInput.lightweight.changesSharedBoundary = false;
  await writeFile(f.owningRequestPath, encoded(f.owningRequest));
  f.selection.owningInvocation.requestSha256 = hash(encoded(f.owningRequest));
  await writeFile(f.selectionPath, encoded(f.selection));
  const repeat = await f.invoke(
    'start',
    f.command(blocked.version, 'ordinary-repeat'),
  );
  assert.equal(repeat.repairSnapshots[0].state, 'BLOCKED');
  await assert.rejects(readFile(f.countPath), /ENOENT/);
  await f.invoke(
    'readmit',
    f.command(f.parent.version, 'stale-readmission'),
    1,
  );
  const admitted = await f.invoke(
    'readmit',
    f.command(blocked.version, 'explicit-readmission'),
  );
  assert.equal(admitted.repairSnapshots[0].state, 'RUNNING');
  assert.equal(admitted.repairs.length, 1);
  assert.deepEqual(admitted.repairs[0].report, blocked.repairs[0].report);
  assert.equal(
    admitted.events.find((event) => event.change.type === 'repair-bound').change
      .repair.admission.status,
    'BLOCKED',
  );
  assert.equal(
    admitted.events.filter((event) => event.change.type === 'repair-admitted')
      .length,
    1,
  );
  await f.invoke('readmit', f.command(blocked.version, 'explicit-readmission'));
  const refusal = await f.invoke(
    'readmit',
    f.command(admitted.version, 'second-readmission'),
    1,
  );
  assert.match(refusal.stderr, /never-launched BLOCKED/);
  const { accepted } = await finishAndAccept(f);
  assert.equal(accepted.status, 'DONE');
  assert.equal(
    (await readFile(f.countPath, 'utf8')).trim().split('\n').length,
    2,
  );
});

test('rebuilt installed entry dispatches one actual repair, preserves parent progress and recovers in a second process', async (t) => {
  for (const active of [false, true])
    await t.test(
      active ? 'active canonical parent' : 'parent without canonical run',
      async (t) => {
        const f = await fixture(t, { active });
        const initialRuns = structuredClone(f.parent.runs);
        const first = await f.invoke('start', f.command(f.parent.version));
        assert.equal(first.repairSnapshots[0].state, 'RUNNING');
        assert.equal(first.repairs[0].launch.reference.pid > 0, true);
        assert.equal(first.repairSnapshots[0].child.attempt, 1);
        assert.deepEqual(first.runs, initialRuns);
        const observed = JSON.parse(
          await readFile(join(f.launchRoot, 'worker-start.json'), 'utf8'),
        );
        assert.notEqual(
          observed.process.pid,
          first.repairs[0].launch.reference.pid,
        );
        await writeFile(
          join(f.root, 'source', 'unrelated.txt'),
          'Compatible parent progress outside repair ownership.\n',
        );
        execFileSync('git', [
          '-C',
          join(f.root, 'source'),
          'add',
          'unrelated.txt',
        ]);
        execFileSync('git', [
          '-C',
          join(f.root, 'source'),
          'commit',
          '-qm',
          'parent progresses independently',
        ]);
        await writeFile(
          join(f.root, 'source', 'another-unrelated.txt'),
          'Further compatible uncommitted progress.\n',
        );
        await f.store.updateTask({
          taskId: 'parent',
          actor: 'coordinator',
          idempotencyKey: 'parent-progress',
          expectedVersion: first.version,
          nextAction: 'Original task progressed while repair was active.',
        });
        const repeated = await f.invoke(
          'start',
          f.command(first.version, 'another-client-key'),
        );
        assert.equal(repeated.repairs.length, 1);
        assert.deepEqual(repeated.repairs[0].launch, first.repairs[0].launch);
        assert.equal(
          repeated.nextAction,
          'Original task progressed while repair was active.',
        );
        await f.invoke(
          'start',
          {
            ...f.command(repeated.version, 'changed'),
            report: { ...f.report, requestedScopes: ['widened'] },
          },
          1,
        );
        await f.invoke(
          'start',
          {
            ...f.command(1, 'stale'),
            report: { ...f.report, repairId: 'second-repair' },
          },
          1,
        );
        const complete = await until(
          () =>
            f.invoke('status', {
              taskId: 'parent',
              repairId: f.report.repairId,
            }),
          (value) => value.repairSnapshots[0].state === 'NEEDS_REVIEW',
        );
        assert.deepEqual(complete.runs, initialRuns);
        assert.equal(complete.currentRunId, f.parent.currentRunId);
        assert.equal(
          (await readFile(f.countPath, 'utf8')).trim().split('\n').length,
          2,
          'Exactly one builder and one reviewer should run.',
        );
        const proof = JSON.parse(
          await readFile(join(f.launchRoot, 'regression.json'), 'utf8'),
        );
        assert.equal(proof.baseline[0].exitCode, 1);
        assert.equal(proof.fresh[0].exitCode, 0);
        assert.equal(proof.fresh[0].stdout.bytes, 1024 * 1024 + 123);
        const selected = {
          candidateRoot: proof.candidateRoot,
          revision: proof.revision,
          artifactRoot: proof.artifactRoot,
          manifestSha256: proof.manifestSha256,
          evidencePath: join(f.launchRoot, 'regression.json'),
          evidenceSha256: hash(
            await readFile(join(f.launchRoot, 'regression.json')),
          ),
        };
        const accepted = await f.invoke('accept', {
          taskId: 'parent',
          actor: 'coordinator',
          idempotencyKey: 'accept-repair',
          expectedVersion: complete.version,
          repairId: f.report.repairId,
          selection: selected,
          reason:
            'Reviewed the exact independent candidate and preserved installed counterexample.',
        });
        assert.equal(accepted.repairSnapshots[0].state, 'RESOLVED');
        assert.notEqual(
          accepted.status,
          'DONE',
          'Repair acceptance does not accept the original task.',
        );
        await writeFile(proof.fresh[0].stdout.path, 'tampered logs');
        const invalid = await f.invoke('status', {
          taskId: 'parent',
          repairId: f.report.repairId,
        });
        assert.equal(invalid.repairSnapshots[0].state, 'BLOCKED');
        assert.notEqual(invalid.status, 'DONE');
        assert.match(
          invalid.repairSnapshots[0].issues[0],
          /diagnostics changed/,
        );
      },
    );
});

test('a killed initiating client leaves the original launch inspectable and never starts another worker', async (t) => {
  const f = await fixture(t);
  const args = await f.args('start', f.command(f.parent.version));
  const code = `await import(${JSON.stringify(pathToFileURL(join(artifact, 'bin/public-entry.mjs')).href)}).then(m=>m.run('temari',${JSON.stringify(args.slice(1))}));`;
  const client = spawn(
    process.execPath,
    ['--input-type=module', '--eval', code],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: `${f.root}:${process.env.PATH}`,
        NODE_OPTIONS: '',
        NODE_PATH: '',
      },
    },
  );
  t.after(() => {
    if (client.exitCode === null) client.kill('SIGKILL');
  });
  await until(
    () => readFile(join(f.launchRoot, 'observed.json'), 'utf8'),
    Boolean,
  );
  client.kill('SIGKILL');
  await new Promise((done) => client.once('close', done));
  assert.equal(
    (await f.store.load('parent')).repairs[0].launch.reference,
    null,
    'Initiating client died before persisting launch acknowledgment.',
  );
  const recovering = await f.invoke('status', {
    taskId: 'parent',
    repairId: f.report.repairId,
  });
  assert.equal(recovering.repairs.length, 1);
  assert.equal(recovering.repairSnapshots[0].child.attempt, 1);
  await f.invoke('start', f.command(recovering.version, 'recovery-client'));
  await until(
    () => f.invoke('status', { taskId: 'parent', repairId: f.report.repairId }),
    (value) => value.repairSnapshots[0].state === 'NEEDS_REVIEW',
  );
  assert.equal(
    (await readFile(f.countPath, 'utf8')).trim().split('\n').length,
    2,
  );
});

test('stale supervision and expired child lease never authorize another write process', async (t) => {
  if (process.platform === 'win32')
    return t.skip('POSIX supervisor suspension is required.');
  const f = await fixture(t);
  const started = await f.invoke('start', f.command(f.parent.version));
  const reference = started.repairs[0].launch.reference;
  const initialChild = started.repairSnapshots[0].child;
  const originalWorkerCount = (await readFile(f.countPath, 'utf8'))
    .trim()
    .split('\n').length;
  process.kill(reference.pid, 'SIGSTOP');
  t.after(() => {
    try {
      process.kill(reference.pid, 'SIGCONT');
    } catch {}
  });
  await writeFile(
    join(f.launchRoot, 'heartbeat.json'),
    encoded({ nonce: reference.supervisorId, at: 0 }),
  );
  const stale = await f.invoke('status', {
    taskId: 'parent',
    repairId: f.report.repairId,
  });
  assert.equal(stale.repairSnapshots[0].state, 'RECOVERY_REQUIRED');
  const expiry = Date.parse(initialChild.lease.expiresAt);
  await new Promise((done) =>
    setTimeout(done, Math.max(0, expiry - Date.now()) + 2000),
  );
  const expired = await f.invoke(
    'start',
    f.command(stale.version, 'expired-client'),
  );
  assert.equal(expired.repairSnapshots[0].state, 'RECOVERY_REQUIRED');
  if (expired.repairSnapshots[0].child)
    assert.equal(expired.repairSnapshots[0].child.attempt, 1);
  assert.deepEqual(expired.repairs[0].launch, started.repairs[0].launch);
  assert.equal(
    (await readFile(f.countPath, 'utf8')).trim().split('\n').length,
    originalWorkerCount,
    'No additional worker ran while supervisor ownership was uncertain.',
  );
  process.kill(reference.pid, 'SIGCONT');
  await until(
    () => readFile(join(f.launchRoot, 'ended.json'), 'utf8'),
    Boolean,
  );
  const childStore = await FileChildTaskStore.create(
    started.repairs[0].admission.childRef.storeRoot,
  );
  const group = await childStore.loadGroup(
    started.repairs[0].admission.childRef.groupId,
  );
  const child = await childStore.load(group.taskIds[0]);
  assert.equal(child.attempt, 1);
});

test('missing authority stays explicitly blocked and report controls cannot grant execution', async (t) => {
  const f = await fixture(t, { authority: false });
  const blocked = await f.invoke('start', f.command(f.parent.version));
  assert.equal(blocked.repairSnapshots[0].state, 'BLOCKED');
  assert.equal(blocked.repairs[0].launch, null);
  await assert.rejects(readFile(f.countPath), /ENOENT/);
  const widened = await fixture(t);
  const refused = await widened.invoke(
    'start',
    {
      ...widened.command(widened.parent.version),
      report: { ...widened.report, requestedScopes: ['other'] },
    },
    1,
  );
  assert.match(refused.stderr, /scopes exceed/);
  for (const control of [{ executable: '/bin/sh' }, { verify: [] }]) {
    const result = await widened.invoke(
      'start',
      {
        ...widened.command(widened.parent.version),
        report: { ...widened.report, ...control },
      },
      1,
    );
    assert.match(result.stderr, /unknown or missing/);
  }
  await assert.rejects(readFile(widened.countPath), /ENOENT/);
});

test('resolved repair evidence disappearance reopens an accepted canonical parent', async (t) => {
  const f = await fixture(t, { canonical: true, acceptParent: false });
  const started = await f.invoke('start', f.command(f.parent.version));
  assert.notEqual(started.status, 'DONE');
  const complete = await until(
    () => f.invoke('status', { taskId: 'parent', repairId: f.report.repairId }),
    (value) => value.repairSnapshots[0].state === 'NEEDS_REVIEW',
  );
  const proofPath = join(f.launchRoot, 'regression.json'),
    proof = JSON.parse(await readFile(proofPath, 'utf8'));
  const selection = {
    candidateRoot: proof.candidateRoot,
    revision: proof.revision,
    artifactRoot: proof.artifactRoot,
    manifestSha256: proof.manifestSha256,
    evidencePath: proofPath,
    evidenceSha256: hash(await readFile(proofPath)),
  };
  const accepted = await f.invoke('accept', {
    taskId: 'parent',
    actor: 'coordinator',
    idempotencyKey: 'accept',
    expectedVersion: complete.version,
    repairId: f.report.repairId,
    selection,
    reason:
      'Coordinator reviewed actual candidate, reviewer and fresh installed regression.',
  });
  assert.equal(accepted.status, 'NEEDS_REVIEW');
  const ordinary = new TaskRuntime({ store: f.store });
  const ordinaryAccepted = await ordinary.accept({
    taskId: 'parent',
    runId: 'parent-run',
    actor: 'coordinator',
    idempotencyKey: 'accept-parent-after-repair',
    expectedVersion: accepted.version,
    reason: 'Reviewed all six canonical parent stage artifacts.',
  });
  assert.notEqual(ordinaryAccepted.status, 'DONE');
  const pickup = await ordinary.pickup({ taskId: 'parent' });
  assert.equal(pickup.selected.repairs[0].state, 'RECOVERY_REQUIRED');
  assert.equal(
    pickup.selected.repairs[0].selectionContext.location,
    f.selectionPath,
  );
  const selectedStatus = await f.invoke('status', {
    taskId: 'parent',
    repairId: f.report.repairId,
  });
  assert.equal(selectedStatus.status, 'DONE');
  await rm(proof.fresh[0].stderr.path);
  const invalid = await f.invoke('status', {
    taskId: 'parent',
    repairId: f.report.repairId,
  });
  assert.equal(invalid.repairSnapshots[0].state, 'BLOCKED');
  assert.equal(invalid.status, 'BLOCKED');
  assert.equal(invalid.semanticAcceptance, false);
});

test('exports a retained positive synthetic fixture for a separate fresh-agent recognition journey', async (t) => {
  if (!process.env.TEMARI_REPAIR_EXPORT_PATH)
    return t.skip('Manual fixture retention is opt-in.');
  const f = await fixture(t, { retain: true });
  const request = f.command(f.parent.version, 'live-agent-correction');
  const requestPath = join(f.root, 'live-repair-request.json');
  await writeFile(requestPath, encoded(request));
  await writeFile(
    process.env.TEMARI_REPAIR_EXPORT_PATH,
    encoded({
      kind: 'synthetic-installed-repair-fixture',
      nativeFeatureOrForgeProof: false,
      workers:
        'deterministic fixture executables; recognition must be evaluated separately with a real fresh agent',
      root: f.root,
      artifactRoot: artifact,
      manifestSha256: artifactDigest,
      taskRoot: f.selection.taskRoot,
      taskId: 'parent',
      selectionPath: f.selectionPath,
      selectionSha256: hash(encoded(f.selection)),
      profilePath: f.profilePath,
      profileSha256: f.selection.authority.sha256,
      owningInvocation: f.selection.owningInvocation,
      requestPath,
      requestSha256: hash(encoded(request)),
      launchRoot: f.launchRoot,
      commandArgv: await f.args('start', request),
      requiredEnvironment: {
        PATH: `${f.root}:${process.env.PATH}`,
        NODE_OPTIONS: '',
        NODE_PATH: '',
      },
    }),
  );
});

test('handoff/profile assertions cannot bypass owning public admission or widen its scope', async (t) => {
  for (const mode of [
    'no-owner',
    'unqualified-lightweight',
    'pending-feature',
    'needs-full-route',
    'widened-profile',
    'missing-main-helper-pin',
    'relative-main-helper',
    'symlink-main-helper',
  ])
    await t.test(mode, async (t) => {
      const f = await fixture(t);
      let report = f.report;
      if (mode === 'no-owner') {
        f.selection.owningInvocation.requestPath = join(
          f.root,
          'missing-owner.json',
        );
      }
      if (mode === 'unqualified-lightweight') {
        f.owningRequest.routeInput.lightweight.changesSharedBoundary = true;
      }
      if (mode === 'pending-feature') {
        const policy = JSON.parse(
          await readFile(join(artifact, 'policy.json'), 'utf8'),
        );
        f.owningRequest.route = 'full-playbook';
        f.owningRequest.profile = 'feature-v1';
        f.owningRequest.obligations = policy.feature.obligations;
        delete f.owningRequest.routeInput;
        f.owningRequest.featureWorkers = {
          evidenceRoot: join(f.root, 'owning-feature-evidence'),
          baseCommit: f.profile.baseCommit,
          timeoutMs: 1000,
          architect: {
            ...f.profile.reviewer,
            id: 'architect',
            role: 'investigator',
          },
          builder: f.profile.builder,
          owns: f.profile.owns,
          verify: f.profile.verify,
          reviewer: f.profile.reviewer,
        };
      }
      if (mode === 'needs-full-route')
        report = { ...report, requiredRoute: 'full-playbook' };
      if (mode === 'missing-main-helper-pin')
        f.profile.commandInputs = f.profile.commandInputs.filter(
          (ref) => ref.path !== f.profile.regression[0].args[0],
        );
      if (mode === 'relative-main-helper')
        f.profile.regression[0].args[0] = 'relative-check.mjs';
      if (mode === 'symlink-main-helper') {
        const linkedHelper = join(f.root, 'linked-regression.mjs');
        await symlink(f.profile.regression[0].args[0], linkedHelper);
        f.profile.regression[0].args[0] = linkedHelper;
      }
      if (
        [
          'missing-main-helper-pin',
          'relative-main-helper',
          'symlink-main-helper',
        ].includes(mode)
      ) {
        await writeFile(f.profilePath, encoded(f.profile));
        f.selection.authority.sha256 = hash(encoded(f.profile));
        const current = await f.store.load('parent');
        await f.store.handoffTask({
          taskId: 'parent',
          actor: 'coordinator',
          idempotencyKey: 'modified-profile-context',
          expectedVersion: current.version,
          handoff: {
            summary: 'Retain selected profile as continuity context',
            decisions: [],
            nextAction: 'Check independently selected helper admission',
            blocker: null,
            contextRefs: [
              {
                kind: 'repair-authority',
                location: f.profilePath,
                sha256: f.selection.authority.sha256,
              },
            ],
          },
        });
      }
      if (mode === 'widened-profile') {
        f.profile.scopes = ['whole-workspace'];
        f.profile.owns = [{ kind: 'directory', path: 'src' }];
        await writeFile(f.profilePath, encoded(f.profile));
        f.selection.authority.sha256 = hash(encoded(f.profile));
        const current = await f.store.load('parent');
        await f.store.handoffTask({
          taskId: 'parent',
          actor: 'caller',
          idempotencyKey: 'self-grant',
          expectedVersion: current.version,
          handoff: {
            summary: 'Caller asserted broad repair authority',
            decisions: [],
            nextAction: 'Continue',
            blocker: null,
            contextRefs: [
              {
                kind: 'repair-authority',
                location: f.profilePath,
                sha256: f.selection.authority.sha256,
              },
            ],
          },
        });
      }
      await writeFile(f.owningRequestPath, encoded(f.owningRequest));
      f.selection.owningInvocation.requestSha256 = hash(
        encoded(f.owningRequest),
      );
      await writeFile(f.selectionPath, encoded(f.selection));
      const current = await f.store.load('parent');
      const blocked = await f.invoke('start', {
        ...f.command(current.version),
        report,
      });
      assert.equal(blocked.repairSnapshots[0].state, 'BLOCKED');
      assert.equal(blocked.repairs[0].launch, null);
      if (mode === 'missing-main-helper-pin')
        assert.match(
          blocked.repairs[0].admission.missingAuthority,
          /helper\/input bytes must be independently pinned/,
        );
      if (mode === 'relative-main-helper')
        assert.match(
          blocked.repairs[0].admission.missingAuthority,
          /absolute independently pinned path/,
        );
      if (mode === 'symlink-main-helper')
        assert.match(
          blocked.repairs[0].admission.missingAuthority,
          /Symlink direct helper\/input arguments/,
        );
      await assert.rejects(readFile(f.countPath), /ENOENT/);
    });
});
