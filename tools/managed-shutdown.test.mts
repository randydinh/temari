import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { fork, spawn } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  access,
  realpath,
  cp,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { FileChildTaskStore } from '../libs/runtime/src/lib/child-task-store.js';
import {
  ManagedExecutionControl,
  recoverManagedExecution,
  recoverManagedExecutionGroup,
} from '../libs/runtime/src/lib/managed-execution.js';
import { createOwnedExecutionAdapter } from '../libs/host-adapters/src/lib/owned-execution.js';
import { createManagedArchonSupervisor } from '../libs/archon-harness/src/lib/managed-supervision.js';
import { createHash } from 'node:crypto';
async function archiveFixture(t: TestContext, root: string): Promise<void> {
  const destination = process.env.WORKER_SHUTDOWN_FIXTURE_EVIDENCE_ROOT;
  if (!destination) return;
  const name = createHash('sha256')
    .update(t.name + root)
    .digest('hex')
    .slice(0, 16);
  const target = join(destination, name);
  await mkdir(destination, { recursive: true });
  await cp(root, target, { recursive: true, errorOnExist: true, force: false });
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
async function removeFixture(t: TestContext, root: string): Promise<void> {
  await archiveFixture(t, root);
  await rm(root, { recursive: true, force: true });
}
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(predicate: () => Promise<boolean>, max = 8000) {
  const end = Date.now() + max;
  while (Date.now() < end) {
    if (await predicate()) return;
    await wait(20);
  }
  throw new Error('Synthetic witness deadline exceeded.');
}
async function present(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function fixture(t: TestContext, ids = ['work']) {
  const root = await mkdtemp(join(tmpdir(), 'owned-execution-'));
  const store = await FileChildTaskStore.create(join(root, 'children'));
  const adapter = createOwnedExecutionAdapter();
  let live = true;
  const external = new AbortController();
  const control = new ManagedExecutionControl({
    store,
    adapter,
    runId: 'run',
    revision: 'revision',
    root,
    binding: JSON.stringify({
      invocation: 'fixture',
      run: 'native-1',
      stage: 'investigate',
      attempt: 1,
    }),
    authorityId: 'control',
    processIds: ids,
    observeSupervisor: async () => live,
    signal: external.signal,
    intervalMs: 40,
  });
  t.after(async () => {
    await control.stop('fixture teardown');
    await control.drain();
    await removeFixture(t, root);
  });
  await control.start();
  const marker = join(root, 'started');
  const command = (code: string, timeoutMs = 4000) => ({
    program: process.execPath,
    args: ['-e', code, marker],
    cwd: root,
    timeoutMs,
  });
  return {
    root,
    store,
    adapter,
    control,
    marker,
    command,
    external,
    lose: () => {
      live = false;
    },
  };
}
const longWorker =
  "require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)";

test('normal command: durable exact launch, clean owned group, and next legitimate dispatch', async (t) => {
  const f = await fixture(t, ['one', 'two']);
  const result = await f.control.run(
    'one',
    f.command(
      "require('node:fs').writeFileSync(process.argv[1],'work');console.log('PASS')",
    ),
  );
  assert.equal(result.cleanup, 'CONFIRMED');
  assert.equal(result.code, 0);
  assert.match(result.stdout, /PASS/);
  assert(!alive(result.witness.anchorPid));
  const stored = await f.store.load('one');
  assert.equal(stored?.status, 'SUCCEEDED');
  assert.equal(stored?.execution?.state, 'CLEANED');
  assert.equal(stored?.attempt, 1);
  assert(
    (await f.store.events('one')).some(
      (x) =>
        x.type === 'task-execution-updated' &&
        String(x.payload.execution).includes('LIVE'),
    ),
  );
  await f.control.run('two', f.command('console.log("second")'));
  await f.control.finish();
  assert.equal((await f.store.load('control'))?.status, 'SUCCEEDED');
});

for (const cause of [
  'explicit-cancel',
  'native-failure',
  'native-timeout',
] as const)
  test(`${cause}: stop active group, deny late PASS/new dispatch/renewal, preserve unrelated sentinel`, async (t) => {
    const f = await fixture(t, ['work', 'queued']);
    const sentinel = spawn(process.execPath, [
      '-e',
      'setInterval(()=>{},1000)',
    ]);
    t.after(() => sentinel.kill('SIGKILL'));
    const p = f.control.run('work', f.command(longWorker));
    const rejected = assert.rejects(p);
    await eventually(() => present(f.marker));
    const workerPid = Number(await readFile(f.marker, 'utf8'));
    if (cause === 'explicit-cancel') f.external.abort();
    else f.lose();
    await rejected;
    assert(!alive(workerPid));
    assert(alive(sentinel.pid!));
    const r = (await f.store.load('work'))!;
    assert.equal(r.execution?.state, 'CLEANED');
    assert.equal(r.status, 'CANCELLED');
    assert.equal(r.result, null);
    await assert.rejects(
      f.control.run('queued', f.command('console.log("late PASS")')),
    );
    assert.equal((await f.store.load('queued'))?.attempt, 0);
    assert.equal(
      (
        await f.store.claim({
          taskId: 'work',
          owner: 'replacement',
          leaseMs: 1000,
        })
      ).claimed,
      false,
    );
  });

test('TERM-resistant worker and inherited child/grandchild pipes are force stopped with leader-exit cleanup', async (t) => {
  const f = await fixture(t);
  const descendant = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
  const leader = `const {spawn}=require('node:child_process');process.on('SIGTERM',()=>{});const c=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'inherit'});require('node:fs').writeFileSync(process.argv[1],JSON.stringify([process.pid,c.pid]));setTimeout(()=>process.exit(0),80)`;
  const result = await f.control.run('work', f.command(leader));
  assert.equal(result.cleanup, 'CONFIRMED');
  const pids = JSON.parse(await readFile(f.marker, 'utf8'));
  for (const pid of pids)
    assert(!alive(pid), `Owned descendant ${pid} survived`);
  assert(!alive(result.witness.anchorPid));
});

test('launch publication/cancel barrier: gated command never performs useful work', async (t) => {
  const f = await fixture(t);
  const identity = {
    nonce: randomUUID(),
    binding: 'exact-attempt',
    receiptPath: join(f.root, 'gated.json'),
  };
  const ac = new AbortController();
  let published = false;
  const outcome = await f.adapter.launch(
    f.command(longWorker),
    identity,
    ac.signal,
    async () => {
      published = true;
      ac.abort();
    },
  );
  assert(published);
  assert.equal(outcome.cleanup, 'CONFIRMED');
  assert.equal(outcome.reason, 'cancelled');
  assert(!(await present(f.marker)));
});

test('ownership registration failure leaves gated group clean without useful work', async (t) => {
  const f = await fixture(t);
  const outcome = await f.adapter.launch(
    f.command(longWorker),
    {
      nonce: randomUUID(),
      binding: 'refused',
      receiptPath: join(f.root, 'refused.json'),
    },
    new AbortController().signal,
    async () => {
      throw new Error('publisher failed');
    },
  );
  assert.equal(outcome.cleanup, 'CONFIRMED');
  assert.equal(outcome.reason, 'registration-refused');
  assert(!(await present(f.marker)));
});

test('controller SIGKILL: guardian cleans its group, restart imports exact cleanup and fences replay', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'owned-crash-'));
  t.after(() => removeFixture(t, root));
  const helper = fileURLToPath(
    new URL('./fixtures/managed-execution-controller.mts', import.meta.url),
  );
  const parent = fork(helper, [root], {
    execArgv: ['--import', '@swc-node/register/esm-register'],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  parent.stderr!.on('data', (c) => {
    stderr += c;
  });
  t.after(() => {
    if (parent.exitCode === null && parent.signalCode === null)
      parent.kill('SIGKILL');
  });
  await eventually(() => present(join(root, 'started'))).catch((error) => {
    throw new Error(`${error}: ${stderr}`);
  });
  const workerPid = Number(await readFile(join(root, 'started'), 'utf8'));
  const store = await FileChildTaskStore.create(join(root, 'children'));
  const before = (await store.load('work'))!;
  assert.equal(before.execution?.state, 'LIVE');
  parent.kill('SIGKILL');
  await eventually(() => present(before.execution!.receiptPath));
  const adapter = createOwnedExecutionAdapter();
  assert.equal(
    await recoverManagedExecutionGroup(store, adapter, 'control'),
    'CONFIRMED',
  );
  assert(!alive(workerPid));
  assert.equal((await store.load('work'))?.status, 'CANCELLED');
  assert.equal(
    (await store.claim({ taskId: 'work', owner: 'restart', leaseMs: 1000 }))
      .claimed,
    false,
  );
  // Positive readback imports confirmed cleanup; it does not grant old PID control.
  assert.equal((await store.load('work'))?.execution?.state, 'CLEANED');
});

test('missing/mismatched cleanup: durable uncertainty blocks reclaim and late result', async (t) => {
  const f = await fixture(t);
  const claim = await f.store.claim({
    taskId: 'work',
    owner: 'broken',
    leaseMs: 1000,
  });
  const e = {
    nonce: randomUUID(),
    binding: 'broken-native-attempt',
    receiptPath: join(f.root, 'missing'),
    attempt: claim.record.attempt,
    fencingEpoch: claim.record.lease!.fencingEpoch,
    guardianPid: null,
    anchorPid: null,
    state: 'PREPARED' as const,
  };
  await f.store.updateExecution({
    taskId: 'work',
    actor: 'broken',
    leaseToken: claim.record.lease!.token,
    execution: e,
  });
  assert.equal(
    await recoverManagedExecution(f.store, f.adapter, 'work'),
    'UNCERTAIN',
  );
  assert.equal(
    (
      await f.store.claim({
        taskId: 'work',
        owner: 'restart',
        leaseMs: 1000,
        now: new Date(Date.now() + 2000),
      })
    ).claimed,
    false,
  );
  await assert.rejects(
    f.store.complete({
      taskId: 'work',
      owner: 'broken',
      leaseToken: claim.record.lease!.token,
      fencingEpoch: e.fencingEpoch,
      status: 'SUCCEEDED',
      idempotencyKey: 'late',
      result: {
        status: 'PASS',
        summary: 'late',
        evidencePaths: [],
        rawLogPath: null,
      },
    }),
  );
  await writeFile(
    e.receiptPath,
    JSON.stringify({
      identity: {
        nonce: randomUUID(),
        binding: e.binding,
        receiptPath: e.receiptPath,
      },
      witness: { guardianPid: process.pid, anchorPid: process.pid },
      cleanup: 'CONFIRMED',
    }),
  );
  await assert.rejects(
    recoverManagedExecution(f.store, f.adapter, 'work'),
    /another invocation/,
  );
  assert.equal((await f.store.load('work'))?.execution?.state, 'UNCERTAIN');
});

test('native observer verifies exact binding and fails closed on terminal, stale, corrupt and missing records', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'owned-native-'));
  t.after(() => removeFixture(t, root));
  const executable = join(root, 'native');
  const path = join(root, 'record.json');
  await writeFile(
    executable,
    '#!/usr/bin/env node\nconsole.log(require("node:fs").readFileSync(process.env.ARCHON_HOME+"/record.json","utf8"))\n',
    { mode: 0o700 },
  );
  const inputs = {
    temari_binding: JSON.stringify({
      schema: 1,
      harnessId: 'archon',
      harnessVersion: '0.10.1',
      workspaceRoot: await realpath(root),
      runId: 'run',
      revision: 'revision',
      planSha256: 'plan',
      entrypoint: 'temari-reviewed-local-candidate',
    }),
    request_sha256: 'request',
    native_home: root,
    native_executable: executable,
    native_executable_sha256: createHash('sha256')
      .update(await readFile(executable))
      .digest('hex'),
  };
  const record = {
    id: 'native',
    status: 'running',
    workflow_name: 'temari-reviewed-local-candidate',
    working_path: await import('node:fs/promises').then((m) =>
      m.realpath(root),
    ),
    metadata: { inputs },
  };
  const observe = await createManagedArchonSupervisor({
    executable,
    executableSha256: inputs.native_executable_sha256,
    home: root,
    nativeRunId: 'native',
    runId: 'run',
    revision: 'revision',
    planSha256: 'plan',
    requestSha256: 'request',
    workspaceRoot: record.working_path,
  });
  await writeFile(path, JSON.stringify(record));
  assert(await observe());
  for (const status of ['failed', 'cancelled', 'succeeded', 'unknown']) {
    await writeFile(path, JSON.stringify({ ...record, status }));
    assert(!(await observe()));
  }
  await writeFile(path, JSON.stringify({ ...record, id: 'another' }));
  assert(!(await observe()));
  await writeFile(path, '{');
  assert(!(await observe()));
  await rm(path);
  assert(!(await observe()));
});

test('supervisor SIGKILL with surviving bridge: parent loss cancels authority without its own lease sustaining it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'owned-supervisor-'));
  t.after(() => removeFixture(t, root));
  const helper = fileURLToPath(
    new URL('./fixtures/managed-execution-controller.mts', import.meta.url),
  );
  const code = `const {fork}=require('node:child_process');fork(${JSON.stringify(helper)},[${JSON.stringify(root)},'watch-parent'],{execArgv:['--import','@swc-node/register/esm-register'],stdio:'ignore'});setInterval(()=>{},1000);`;
  const supervisor = spawn(process.execPath, ['-e', code]);
  t.after(() => {
    if (supervisor.exitCode === null && supervisor.signalCode === null)
      supervisor.kill('SIGKILL');
  });
  await eventually(() => present(join(root, 'started')));
  const worker = Number(await readFile(join(root, 'started'), 'utf8'));
  supervisor.kill('SIGKILL');
  const store = await FileChildTaskStore.create(join(root, 'children'));
  await eventually(
    async () => (await store.load('control'))?.status === 'CANCELLED',
  );
  assert(!alive(worker));
  assert.equal((await store.load('work'))?.execution?.state, 'CLEANED');
});

test('owned process timeout is bounded for a TERM-resistant worker', async (t) => {
  const f = await fixture(t);
  const start = Date.now();
  const rejected = assert.rejects(
    f.control.run(
      'work',
      f.command("process.on('SIGTERM',()=>{});" + longWorker, 300),
    ),
    /timeout/,
  );
  await rejected;
  assert(Date.now() - start < 3000);
  const record = await f.store.load('work');
  assert.equal(record?.execution?.state, 'CLEANED');
  const receipt = JSON.parse(
    await readFile(record!.execution!.receiptPath, 'utf8'),
  );
  assert.equal(receipt.reason, 'timeout');
  assert.equal(receipt.cleanup, 'CONFIRMED');
});

test('cancelled before spawn never opens the useful-work gate', async (t) => {
  const f = await fixture(t);
  f.external.abort();
  await assert.rejects(f.control.run('work', f.command(longWorker)));
  assert(!(await present(f.marker)));
  assert.equal((await f.store.load('work'))?.attempt, 0);
});

test('missing cleanup cannot be made successful by semantic failure or a replacement parent binding', async (t) => {
  const f = await fixture(t);
  const { FileTaskStore } =
    await import('../libs/runtime/src/lib/task-store.js');
  const { createReviewedLocalCandidatePlan } =
    await import('../libs/temari-core/src/index.js');
  const tasks = await FileTaskStore.create(join(f.root, 'parent-tasks'));
  const task = await tasks.createTask({
    taskId: 'parent',
    title: 'fixture',
    goal: 'fixture',
    workspaceRoot: f.root,
    actor: 'fixture',
    idempotencyKey: 'create',
  });
  const bound = await tasks.bindRun({
    taskId: 'parent',
    actor: 'fixture',
    expectedVersion: task.version,
    idempotencyKey: 'bind',
    run: {
      runId: 'run',
      revision: 'revision',
      plan: createReviewedLocalCandidatePlan(),
      executionStoreRoot: join(f.root, 'children'),
    },
  });
  await assert.rejects(
    tasks.append(
      {
        taskId: 'parent',
        actor: 'fixture',
        expectedVersion: bound.version,
        idempotencyKey: 'replacement',
      },
      {
        type: 'run-bound',
        run: {
          runId: 'replacement',
          revision: 'revision',
          plan: createReviewedLocalCandidatePlan(),
        },
      },
    ),
    /cleanup.*unresolved/,
  );
  await f.control.stop('explicit');
  await f.control.drain();
  const replaced = await tasks.bindRun({
    taskId: 'parent',
    actor: 'fixture',
    expectedVersion: bound.version,
    idempotencyKey: 'confirmed-replacement',
    run: {
      runId: 'confirmed-replacement',
      revision: 'revision',
      plan: createReviewedLocalCandidatePlan(),
    },
  });
  assert.equal(replaced.currentRunId, 'confirmed-replacement');
});

test('Bun source bridge transport preserves the ownership gate and group cleanup', async (t) => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const root = await mkdtemp(join(tmpdir(), 'owned-bun-'));
  t.after(() => removeFixture(t, root));
  const helper = fileURLToPath(
    new URL('./fixtures/owned-execution-bun.mts', import.meta.url),
  );
  const result = await promisify(execFile)('bun', [helper, root], {
    timeout: 10000,
    killSignal: 'SIGKILL',
  });
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.cleanup, 'CONFIRMED');
  assert.equal(receipt.code, 0);
  assert.match(receipt.stdout, /bun-worker/);
});

test('publisher SIGKILL during ownership publication: prepared launch is cleaned before useful work', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'owned-publisher-'));
  t.after(() => removeFixture(t, root));
  const helper = fileURLToPath(
    new URL('./fixtures/managed-execution-controller.mts', import.meta.url),
  );
  const publisher = fork(helper, [root, 'publish-barrier'], {
    execArgv: ['--import', '@swc-node/register/esm-register'],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  t.after(() => {
    if (publisher.exitCode === null && publisher.signalCode === null)
      publisher.kill('SIGKILL');
  });
  await eventually(() => present(join(root, 'published')));
  const store = await FileChildTaskStore.create(join(root, 'children'));
  const before = (await store.load('work'))!;
  assert.equal(before.execution?.state, 'PREPARED');
  assert(!(await present(join(root, 'started'))));
  publisher.kill('SIGKILL');
  await eventually(() => present(before.execution!.receiptPath));
  assert.equal(
    await recoverManagedExecutionGroup(
      store,
      createOwnedExecutionAdapter(),
      'control',
    ),
    'CONFIRMED',
  );
  assert(!(await present(join(root, 'started'))));
  assert.equal((await store.load('work'))?.status, 'CANCELLED');
});

test('uncertain adapter observation persists a barrier; descriptor PIDs confer no signalling authority', async (t) => {
  const f = await fixture(t);
  const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  t.after(() => sentinel.kill('SIGKILL'));
  f.control.options.adapter.launch = async (
    _command,
    identity,
    _signal,
    register,
  ) => {
    const witness = { guardianPid: sentinel.pid!, anchorPid: sentinel.pid! };
    await register(witness);
    return {
      identity,
      witness,
      code: 0,
      signal: null,
      reason: 'normal-exit',
      cleanup: 'UNCERTAIN',
      stdout: 'late PASS',
      stderr: '',
    };
  };
  await assert.rejects(
    f.control.run('work', f.command('console.log("must not run")')),
    /cleanup.*unresolved/,
  );
  const r = (await f.store.load('work'))!;
  assert.equal(r.execution?.state, 'UNCERTAIN');
  assert.equal(r.result, null);
  assert(alive(sentinel.pid!));
  assert.equal(
    (
      await f.store.claim({
        taskId: 'work',
        owner: 'replacement',
        leaseMs: 1000,
        now: new Date(Date.now() + 30000),
      })
    ).claimed,
    false,
  );
  await assert.rejects(
    f.store.retry({
      taskId: 'work',
      actor: 'replacement',
      idempotencyKey: 'retry',
    }),
    /cleanup/,
  );
});

test('parallel runtime external abort cancels a held PASS and prevents subsequent lease renewal', async (t) => {
  const f = await fixture(t);
  const { executeRestartableParallelWorkers, FileParallelWorkerReceiptStore } =
    await import('../libs/runtime/src/lib/parallel-runtime.js');
  const { parallelPlan, HOST_CAPABILITIES } =
    await import('../libs/contracts/src/index.js');
  const external = new AbortController();
  let entered!: () => void, release!: () => void;
  const began = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let childId = '',
    observedAbort = false;
  const execution = executeRestartableParallelWorkers({
    runId: 'held-run',
    revision: 'revision',
    plan: parallelPlan('investigation', 1),
    capabilities: {
      host: 'codex',
      available: HOST_CAPABILITIES,
      missing: [],
      notes: {},
    },
    assignments: [
      {
        id: 'held',
        role: 'investigator',
        required: true,
        brief: {
          goal: 'fixture',
          context: 'fixture',
          scope: 'fixture',
          acceptanceCriteria: ['fixture'],
          verificationCommand: null,
          reportFormat: 'json',
          forbiddenActions: ['No product access'],
        },
      },
    ],
    childStore: f.store,
    receiptStore: await FileParallelWorkerReceiptStore.create(
      join(f.root, 'receipts'),
    ),
    owner: 'outer',
    leaseMs: 1000,
    leaseRenewal: { intervalMs: 20 },
    signal: external.signal,
    handler: async (_assignment, context) => {
      childId = context.child.taskId;
      entered();
      await held;
      observedAbort = context.signal.aborted;
      return {
        status: 'PASS',
        summary: 'late',
        evidencePaths: ['fixture'],
        rawLogPath: null,
      };
    },
  });
  await began;
  external.abort();
  await eventually(() => f.store.cancellationRequested(childId));
  release();
  await execution;
  assert(observedAbort);
  const record = await f.store.load(childId);
  assert.equal(record?.status, 'CANCELLED');
  assert.equal(record?.result, null);
  const events = await f.store.events(childId);
  const cancellation = events.findIndex(
    (event) => event.type === 'task-cancellation-requested',
  );
  assert(
    !events
      .slice(cancellation + 1)
      .some((event) => event.type === 'task-lease-renewed'),
  );
});

for (const cause of ['native terminal failure', 'native timeout'] as const)
  test(`${cause} through the pinned native observer stops a live check and preserves native FAILED`, async (t) => {
    const f = await fixture(t);
    const executable = join(f.root, 'native-reader');
    const recordPath = join(f.root, 'record.json');
    await writeFile(
      executable,
      `#!${process.execPath}\nconsole.log(require('node:fs').readFileSync(process.env.ARCHON_HOME+'/record.json','utf8'))\n`,
      { mode: 0o700 },
    );
    const sha = createHash('sha256')
      .update(await readFile(executable))
      .digest('hex');
    const workspaceRoot = await realpath(f.root);
    const record = {
      id: 'native',
      status: 'running',
      workflow_name: 'temari-reviewed-local-candidate',
      working_path: workspaceRoot,
      metadata: {
        inputs: {
          temari_binding: JSON.stringify({
            schema: 1,
            harnessId: 'archon',
            harnessVersion: '0.10.1',
            runId: 'run',
            revision: 'revision',
            workspaceRoot,
            planSha256: 'plan',
            entrypoint: 'temari-reviewed-local-candidate',
          }),
          request_sha256: 'request',
          native_home: f.root,
          native_executable: executable,
          native_executable_sha256: sha,
        },
      },
    };
    await writeFile(recordPath, JSON.stringify(record));
    f.control.options.observeSupervisor = await createManagedArchonSupervisor({
      executable,
      executableSha256: sha,
      home: f.root,
      nativeRunId: 'native',
      runId: 'run',
      revision: 'revision',
      planSha256: 'plan',
      requestSha256: 'request',
      workspaceRoot,
    });
    const stopped = assert.rejects(
      f.control.run('work', f.command(longWorker)),
    );
    await eventually(() => present(f.marker));
    const pid = Number(await readFile(f.marker, 'utf8'));
    await writeFile(
      recordPath,
      JSON.stringify({ ...record, status: 'failed', error: cause }),
    );
    await stopped;
    assert(!alive(pid));
    assert.equal((await f.store.load('work'))?.result, null);
    assert.equal((await f.store.load('work'))?.execution?.state, 'CLEANED');
    assert.equal(
      JSON.parse(await readFile(recordPath, 'utf8')).status,
      'failed',
    );
    assert.equal(JSON.parse(await readFile(recordPath, 'utf8')).error, cause);
  });
