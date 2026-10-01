import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test, { type TestContext } from 'node:test';
import {
  HOST_CAPABILITIES,
  expandedPlan,
  minimalPlan,
  type ExecutionHarness,
  type ExecutionPlan,
  type HarnessRunRef,
  type HarnessRunStatus,
} from '@temari/contracts';
import { FileTaskStore, taskDigest, type TaskCommand } from './task-store.js';
import { TaskRuntime } from './task-runtime.js';
import {
  executeAndPersist,
  FileWorkflowCheckpointStore,
  FileWorkflowReceiptStore,
} from './runtime.js';
import { FileEvidenceStore } from './evidence-store.js';
import { FileChildTaskStore } from './child-task-store.js';
import { projectTaskPickupBrief, TASK_PICKUP_LIMITS } from './task-pickup.js';

async function fixture(t: TestContext, plan: ExecutionPlan = minimalPlan()) {
  const root = await mkdtemp(join(tmpdir(), 'temari-task-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await FileTaskStore.create(join(root, 'tasks'));
  const receipts = await FileWorkflowReceiptStore.create(
    join(root, 'receipts'),
  );
  const evidence = await FileEvidenceStore.create(join(root, 'evidence'));
  const task = await store.createTask({
    taskId: 'goal',
    actor: 'temari',
    idempotencyKey: 'create',
    title: 'Deliver one goal',
    goal: 'Keep evidence and recovery attached to one goal.',
    workspaceRoot: root,
  });
  await store.bindRun({
    taskId: 'goal',
    actor: 'temari',
    idempotencyKey: 'bind',
    expectedVersion: task.version,
    run: {
      runId: 'run-1',
      revision: 'rev-1',
      plan,
      receiptRoot: join(root, 'receipts'),
      evidenceRoot: join(root, 'evidence'),
    },
  });
  let status: HarnessRunStatus = 'RUNNING';
  let starts = 0;
  let resumes = 0;
  let cancels = 0;
  let loseStartResponse = false;
  let loseControlResponse = false;
  let cancelStatus: HarnessRunStatus = 'CANCELLED';
  let nativeRef: HarnessRunRef | null = null;
  const observation = () => ({
    status,
    observedAt: new Date().toISOString(),
    summary: `Native ${status}`,
    rawLogPath: join(root, 'native.log'),
  });
  const harness: ExecutionHarness = {
    id: 'fixture',
    version: '1.0.0',
    async start(request) {
      starts++;
      nativeRef = {
        schema: 1,
        harnessId: 'fixture',
        harnessVersion: '1.0.0',
        runId: request.runId,
        revision: request.revision,
        planSha256: taskDigest(request.plan),
        externalRunId: `native-${starts}`,
        workspaceRoot: request.workspaceRoot,
        entrypoint: request.entrypoint,
        startedAt: new Date().toISOString(),
      };
      if (loseStartResponse) throw new Error('Connection lost after dispatch');
      return nativeRef;
    },
    async status(ref) {
      assert.deepEqual(
        ref,
        nativeRef,
        'Executor rejects different native identity',
      );
      return observation();
    },
    async verifyRunIdentity(ref) {
      assert.deepEqual(
        ref,
        nativeRef,
        'Executor rejects different native identity',
      );
    },
    async resume(ref) {
      assert.deepEqual(ref, nativeRef);
      resumes++;
      if (loseControlResponse) throw new Error('Resume response lost');
      status = 'RUNNING';
      return observation();
    },
    async cancel(ref) {
      assert.deepEqual(ref, nativeRef);
      cancels++;
      if (loseControlResponse) throw new Error('Cancel response lost');
      status = cancelStatus;
      return observation();
    },
  };
  const selection = {
    hostHarness: harness,
    configuredHarness: null,
    managedDefault: null,
  };
  const runtime = new TaskRuntime({ store, selection });
  const command = async (
    idempotencyKey: string,
  ): Promise<TaskCommand & { runId: string }> => ({
    taskId: 'goal',
    runId: 'run-1',
    actor: 'temari',
    expectedVersion: (await store.load('goal'))!.version,
    idempotencyKey,
  });
  const publish = async (
    options: { plan?: ExecutionPlan; revision?: string; runId?: string } = {},
  ) =>
    executeAndPersist({
      runId: options.runId ?? 'run-1',
      revision: options.revision ?? 'rev-1',
      plan: options.plan ?? plan,
      capabilities: {
        host: 'fixture',
        available: [],
        missing: HOST_CAPABILITIES,
        notes: {},
      },
      store: receipts,
      checkpointStore: await FileWorkflowCheckpointStore.create(
        join(root, 'checkpoints'),
      ),
      stageEvidence: { store: evidence },
      handler: (stage) => ({
        status: 'PASS',
        summary: `${stage} verified`,
        evidence: [
          {
            name: 'result',
            kind: 'verification',
            content: `${stage} observed result`,
          },
        ],
      }),
    });
  return {
    root,
    store,
    receipts,
    evidence,
    runtime,
    selection,
    command,
    publish,
    harness,
    get nativeRef() {
      assert(nativeRef);
      return nativeRef;
    },
    get starts() {
      return starts;
    },
    get resumes() {
      return resumes;
    },
    get cancels() {
      return cancels;
    },
    setStatus(value: HarnessRunStatus) {
      status = value;
    },
    loseStart() {
      loseStartResponse = true;
    },
    loseControl() {
      loseControlResponse = true;
    },
    setCancelStatus(value: HarnessRunStatus) {
      cancelStatus = value;
    },
  };
}

test('native success remains open until canonical evidence and explicit acceptance', async (t) => {
  const f = await fixture(t);
  await f.runtime.dispatch({
    ...(await f.command('dispatch')),
    entrypoint: 'workflow.yml',
    inputs: { goal: 'retain evidence' },
  });
  f.setStatus('SUCCEEDED');
  const native = await f.runtime.observeNative(
    await f.command('observe-success'),
  );
  assert.equal(native.status, 'OPEN');
  assert.equal(native.evidence.verified, false);
  assert.equal(native.semanticAcceptance, false);
  await assert.rejects(
    f.runtime.accept({
      ...(await f.command('accept-missing')),
      reason: 'Looks complete',
    }),
    /receipt is missing/,
  );
  await f.publish();
  const verified = await f.runtime.verifyEvidence(await f.command('verify'));
  assert.equal(verified.status, 'NEEDS_REVIEW');
  assert.equal(verified.evidence.verified, true);
  assert.equal(verified.semanticAcceptance, false);
  assert.equal(verified.runSnapshots[0]?.stages.length, 6);
  const accept = {
    ...(await f.command('accept')),
    reason: 'I reviewed the goal and all retained local stage evidence.',
  };
  const accepted = await f.runtime.accept(accept);
  assert.equal(accepted.status, 'DONE');
  assert.equal(accepted.semanticAcceptance, true);
  assert.equal((await f.runtime.accept(accept)).status, 'DONE');
  const fresh = new TaskRuntime({
    store: await FileTaskStore.openExisting(join(f.root, 'tasks')),
  });
  const restored = await fresh.snapshot('goal');
  assert.equal(restored.status, 'DONE');
  assert.equal(
    restored.runs[0]?.nativeRef?.externalRunId,
    f.nativeRef.externalRunId,
  );
  assert.equal(restored.events.at(-1)?.change.type, 'task-accepted');
});

test('native output locations may be attached after exact run identity is known', async (t) => {
  const f = await fixture(t);
  await f.store.bindRun({
    ...(await f.command('deferred-run')),
    run: {
      runId: 'native-output',
      revision: 'native-revision',
      plan: minimalPlan(),
    },
  });
  const initial = await f.runtime.snapshot('goal');
  assert.equal(initial.status, 'OPEN');
  assert.match(
    initial.evidence.issues.join(),
    /locations have not been attached/,
  );
  await f.runtime.dispatch({
    ...(await f.command('dispatch-deferred')),
    runId: 'native-output',
    entrypoint: 'workflow.yml',
    inputs: {},
  });
  f.setStatus('SUCCEEDED');
  await f.runtime.observeNative({
    ...(await f.command('observe-deferred')),
    runId: 'native-output',
  });
  await f.publish({ runId: 'native-output', revision: 'native-revision' });
  await f.store.attachEvidenceRoots({
    ...(await f.command('link-native-output')),
    runId: 'native-output',
    receiptRoot: join(f.root, 'receipts'),
    evidenceRoot: join(f.root, 'evidence'),
  });
  const done = await f.runtime.accept({
    ...(await f.command('accept-native-output')),
    runId: 'native-output',
    reason: 'Reviewed the linked exact-run evidence.',
  });
  assert.equal(done.status, 'DONE');
  assert.equal(done.runs.length, 2);
});

test('concurrent duplicate dispatch has one side effect and retains intent first', async (t) => {
  const f = await fixture(t);
  const request = {
    ...(await f.command('dispatch')),
    entrypoint: 'workflow.yml',
    inputs: {},
  };
  const original = f.harness.start;
  f.harness.start = async (request) => {
    assert.equal(
      (await f.store.load('goal'))?.events.at(-1)?.change.type,
      'dispatch-requested',
    );
    return original(request);
  };
  await Promise.all([f.runtime.dispatch(request), f.runtime.dispatch(request)]);
  assert.equal(f.starts, 1);
  await f.runtime.dispatch(request);
  assert.equal(f.starts, 1);
  await assert.rejects(
    f.runtime.dispatch({ ...request, inputs: { changed: 'input' } }),
    /Idempotency payload conflict/,
  );
  await assert.rejects(
    f.runtime.dispatch({
      ...(await f.command('another-dispatch')),
      entrypoint: 'workflow.yml',
      inputs: {},
    }),
    /Dispatch already requested/,
  );
});

test('lost dispatch response survives reopen and requires exact native reconciliation', async (t) => {
  const f = await fixture(t);
  f.loseStart();
  const request = {
    ...(await f.command('dispatch')),
    entrypoint: 'workflow.yml',
    inputs: {},
  };
  await assert.rejects(f.runtime.dispatch(request), /Connection lost/);
  const reopened = new TaskRuntime({
    store: await FileTaskStore.openExisting(join(f.root, 'tasks')),
    selection: f.selection,
  });
  const uncertain = await reopened.snapshot('goal');
  assert.equal(uncertain.status, 'BLOCKED');
  assert.equal(uncertain.runs[0]?.operations[0]?.state, 'UNCERTAIN');
  await reopened.dispatch(request);
  assert.equal(f.starts, 1);
  await assert.rejects(
    reopened.reconcileNative({
      ...(await f.command('wrong-plan')),
      reference: { ...f.nativeRef, planSha256: '0'.repeat(64) },
    }),
    /Native plan mismatch/,
  );
  await assert.rejects(
    reopened.reconcileNative({
      ...(await f.command('wrong-revision')),
      reference: { ...f.nativeRef, revision: 'wrong' },
    }),
    /Native revision mismatch/,
  );
  await assert.rejects(
    reopened.reconcileNative({
      ...(await f.command('wrong-id')),
      reference: { ...f.nativeRef, externalRunId: 'different' },
    }),
    /different native identity/,
  );
  f.setStatus('UNKNOWN');
  await assert.rejects(
    reopened.reconcileNative({
      ...(await f.command('unknown')),
      reference: f.nativeRef,
    }),
    /not verified/,
  );
  f.setStatus('RUNNING');
  const reconcile = {
    ...(await f.command('reconcile')),
    reference: f.nativeRef,
  };
  assert.equal((await reopened.reconcileNative(reconcile)).status, 'RUNNING');
  assert.equal((await reopened.reconcileNative(reconcile)).status, 'RUNNING');
  assert.equal(f.starts, 1);
});

test('crash window before native binding never auto-dispatches a replacement', async (t) => {
  const f = await fixture(t);
  const original = f.store.append.bind(f.store);
  let interrupted = false;
  f.store.append = async (request, change) => {
    if (change.type === 'native-bound' && !interrupted) {
      interrupted = true;
      throw new Error('Simulated crash before binding publication');
    }
    return original(request, change);
  };
  const request = {
    ...(await f.command('dispatch')),
    entrypoint: 'workflow.yml',
    inputs: {},
  };
  await assert.rejects(f.runtime.dispatch(request), /Simulated crash/);
  assert.equal(f.starts, 1);
  const fresh = new TaskRuntime({
    store: await FileTaskStore.openExisting(join(f.root, 'tasks')),
    selection: f.selection,
  });
  await fresh.dispatch(request);
  assert.equal(f.starts, 1);
  assert.equal((await fresh.snapshot('goal')).status, 'BLOCKED');
  await fresh.reconcileNative({
    ...(await f.command('recover')),
    reference: f.nativeRef,
  });
  assert.equal((await fresh.snapshot('goal')).status, 'RUNNING');
});

test('reconciliation fails closed without independent harness identity verification', async (t) => {
  const f = await fixture(t);
  f.loseStart();
  await assert.rejects(
    f.runtime.dispatch({
      ...(await f.command('dispatch')),
      entrypoint: 'workflow.yml',
      inputs: {},
    }),
    /Connection lost/,
  );
  delete f.harness.verifyRunIdentity;
  await assert.rejects(
    f.runtime.reconcileNative({
      ...(await f.command('recover')),
      reference: f.nativeRef,
    }),
    /identity|verif/i,
  );
  assert.equal((await f.runtime.snapshot('goal')).runs[0]!.nativeRef, null);
  assert.equal(f.starts, 1);
});

test('retry/replan keeps one goal, distinct runs and prior native identities', async (t) => {
  const f = await fixture(t);
  await f.runtime.dispatch({
    ...(await f.command('dispatch')),
    entrypoint: 'workflow.yml',
    inputs: {},
  });
  const oldRef = f.nativeRef;
  f.setStatus('BLOCKED');
  await f.runtime.observeNative(await f.command('observe-paused-run'));
  await assert.rejects(
    f.store.bindRun({
      ...(await f.command('premature-replan')),
      run: {
        runId: 'run-2',
        revision: 'rev-2',
        plan: minimalPlan('design'),
        receiptRoot: join(f.root, 'receipts'),
        evidenceRoot: join(f.root, 'evidence'),
      },
    }),
    /Resolve or stop/,
  );
  f.setStatus('FAILED');
  await f.runtime.observeNative(await f.command('observe-failure'));
  const next = await f.store.bindRun({
    ...(await f.command('replan')),
    run: {
      runId: 'run-2',
      revision: 'rev-2',
      plan: minimalPlan('design'),
      receiptRoot: join(f.root, 'receipts'),
      evidenceRoot: join(f.root, 'evidence'),
    },
  });
  assert.equal(next.taskId, 'goal');
  assert.equal(next.runs.length, 2);
  assert.deepEqual(next.runs[0]?.nativeRef, oldRef);
  await f.runtime.dispatch({
    ...(await f.command('dispatch-next')),
    runId: 'run-2',
    entrypoint: 'workflow.yml',
    inputs: {},
  });
  assert.equal(f.starts, 2);
  assert.notEqual(f.nativeRef.externalRunId, oldRef.externalRunId);
  await assert.rejects(
    f.runtime.accept({
      ...(await f.command('accept-old')),
      reason: 'Old work passed',
    }),
    /current run/,
  );
});

test('cancellation awaits actual executor confirmation and does not repeat requests', async (t) => {
  const f = await fixture(t);
  await f.runtime.dispatch({
    ...(await f.command('dispatch')),
    entrypoint: 'workflow.yml',
    inputs: {},
  });
  f.setCancelStatus('RUNNING');
  const cancel = await f.command('cancel');
  assert.equal((await f.runtime.cancel(cancel)).status, 'BLOCKED');
  assert.equal(f.cancels, 1);
  await f.runtime.cancel(cancel);
  assert.equal(f.cancels, 1);
  for (const status of ['QUEUED', 'BLOCKED', 'UNKNOWN', 'RUNNING'] as const) {
    f.setStatus(status);
    const unresolved = await f.runtime.observeNative(
      await f.command(`observe-${status}`),
    );
    assert.equal(unresolved.status, 'BLOCKED');
    assert.equal(unresolved.runs[0]?.operations.at(-1)?.state, 'UNCERTAIN');
    assert.equal(unresolved.runs[0]?.operations.at(-1)?.outcome, undefined);
    await f.runtime.cancel(cancel);
    assert.equal(f.cancels, 1);
  }
  await assert.rejects(
    f.runtime.resume(await f.command('resume-while-cancelling')),
    /Reconcile pending/,
  );
  f.setStatus('CANCELLED');
  const observed = await f.runtime.observeNative(
    await f.command('confirm-cancel'),
  );
  assert.equal(observed.status, 'CANCELLED');
  assert.equal(observed.runs[0]?.operations.at(-1)?.state, 'CONFIRMED');
  assert.equal(observed.runs[0]?.operations.at(-1)?.outcome, 'cancelled');
});

test('native success racing cancellation resolves intent without claiming cancellation', async (t) => {
  const f = await fixture(t);
  await f.runtime.dispatch({
    ...(await f.command('dispatch')),
    entrypoint: 'workflow.yml',
    inputs: {},
  });
  f.setCancelStatus('SUCCEEDED');
  const cancel = await f.command('cancel');
  const completed = await f.runtime.cancel(cancel);
  assert.equal(completed.status, 'OPEN');
  assert.equal(completed.runs[0]?.nativeSnapshot?.status, 'SUCCEEDED');
  assert.equal(completed.runs[0]?.operations.at(-1)?.state, 'CONFIRMED');
  assert.equal(
    completed.runs[0]?.operations.at(-1)?.outcome,
    'finished-before-cancel',
  );
  await f.runtime.cancel(cancel);
  assert.equal(f.cancels, 1);
  const replanned = await f.store.bindRun({
    ...(await f.command('replan-after-finish')),
    run: { runId: 'run-2', revision: 'rev-2', plan: minimalPlan() },
  });
  assert.equal(replanned.currentRunId, 'run-2');
  assert.equal(replanned.runs[0]?.nativeSnapshot?.status, 'SUCCEEDED');
  await f.runtime.cancel(cancel);
  assert.equal(f.cancels, 1);
});

test('failed native run resolves a lost cancellation response and permits replan', async (t) => {
  const f = await fixture(t);
  await f.runtime.dispatch({
    ...(await f.command('dispatch')),
    entrypoint: 'workflow.yml',
    inputs: {},
  });
  f.loseControl();
  const cancel = await f.command('cancel');
  await assert.rejects(f.runtime.cancel(cancel), /Cancel response lost/);
  f.setStatus('FAILED');
  const completed = await f.runtime.observeNative(
    await f.command('observe-failure-after-cancel'),
  );
  assert.equal(completed.status, 'BLOCKED');
  assert.equal(completed.runs[0]?.nativeSnapshot?.status, 'FAILED');
  assert.equal(completed.runs[0]?.operations.at(-1)?.state, 'CONFIRMED');
  assert.equal(
    completed.runs[0]?.operations.at(-1)?.outcome,
    'finished-before-cancel',
  );
  await f.runtime.cancel(cancel);
  assert.equal(f.cancels, 1);
  const replanned = await f.store.bindRun({
    ...(await f.command('replan-after-failure')),
    run: { runId: 'run-2', revision: 'rev-2', plan: minimalPlan() },
  });
  assert.equal(replanned.currentRunId, 'run-2');
  assert.equal(replanned.runs[0]?.nativeSnapshot?.status, 'FAILED');
});

test('resume error retains uncertainty and duplicate control does not repeat side effect', async (t) => {
  const f = await fixture(t);
  await f.runtime.dispatch({
    ...(await f.command('dispatch')),
    entrypoint: 'workflow.yml',
    inputs: {},
  });
  f.loseControl();
  const resume = await f.command('resume');
  await assert.rejects(f.runtime.resume(resume), /Resume response lost/);
  assert.equal((await f.runtime.snapshot('goal')).status, 'BLOCKED');
  await f.runtime.resume(resume);
  assert.equal(f.resumes, 1);
  f.setStatus('RUNNING');
  assert.equal(
    (await f.runtime.observeNative(await f.command('reconcile-resume'))).status,
    'RUNNING',
  );
});

test('stale revision or changed plan cannot supply closeout evidence', async (t) => {
  const f = await fixture(t);
  await f.publish({ revision: 'stale-revision' });
  const snapshot = await f.runtime.snapshot('goal');
  assert.equal(snapshot.status, 'BLOCKED');
  assert.match(snapshot.evidence.issues.join(), /revision is stale/);
  await assert.rejects(
    f.runtime.accept({ ...(await f.command('accept')), reason: 'Close' }),
    /revision is stale/,
  );
  const changed = await fixture(t);
  await changed.publish({ plan: minimalPlan('design') });
  await assert.rejects(
    changed.runtime.accept({
      ...(await changed.command('accept')),
      reason: 'Close',
    }),
    /plan does not match/,
  );
});

test('tampered evidence revokes the DONE projection and acceptance cannot reuse it', async (t) => {
  const f = await fixture(t);
  await f.publish();
  await f.runtime.accept({
    ...(await f.command('accept')),
    reason: 'Goal independently reviewed.',
  });
  const artifacts = await readdir(join(f.root, 'evidence'));
  await writeFile(
    join(
      f.root,
      'evidence',
      artifacts.find((p) => p.endsWith('.artifact'))!,
    ),
    'tampered',
  );
  const reloaded = await f.runtime.snapshot('goal');
  assert.equal(reloaded.status, 'BLOCKED');
  assert.equal(reloaded.evidence.verified, false);
  assert.equal(reloaded.semanticAcceptance, false);
  await assert.rejects(
    f.runtime.accept({
      ...(await f.command('accept-again')),
      reason: 'Accept changed bytes',
    }),
  );
});

test('local stage-only closeout cannot satisfy independent review or forge obligations', async (t) => {
  const f = await fixture(t, expandedPlan());
  await assert.rejects(
    f.runtime.accept({
      ...(await f.command('accept')),
      reason: 'Claimed pass',
    }),
    /route-specific verifier/,
  );
  assert.notEqual((await f.runtime.snapshot('goal')).status, 'DONE');
});

test('child projections retain successful sibling and failed assignment', async (t) => {
  const f = await fixture(t);
  const childRoot = join(f.root, 'children');
  const childStore = await FileChildTaskStore.create(childRoot);
  const childIds = ['child-success', 'child-failed'];
  for (const taskId of childIds)
    await childStore.create({
      taskId,
      runId: 'run-children',
      revision: 'rev-children',
      dependsOn: [],
      actor: 'temari',
    });
  await childStore.ensureGroup({
    groupId: 'batch',
    runId: 'run-children',
    revision: 'rev-children',
    taskIds: childIds,
    assignmentIds: ['first', 'second'],
  });
  for (const taskId of childIds) {
    const claimed = await childStore.claim({
      taskId,
      owner: 'worker',
      leaseMs: 60000,
    });
    assert(claimed.record.lease);
    await childStore.complete({
      taskId,
      owner: 'worker',
      leaseToken: claimed.record.lease.token,
      fencingEpoch: claimed.record.lease.fencingEpoch,
      idempotencyKey: `finish-${taskId}`,
      status: taskId === 'child-success' ? 'SUCCEEDED' : 'FAILED',
      ...(taskId === 'child-success'
        ? {
            result: {
              status: 'PASS',
              summary: 'Sibling completed',
              evidencePaths: ['worker.log'],
              rawLogPath: null,
            },
          }
        : { error: 'Worker failed' }),
    });
  }
  await f.store.bindRun({
    ...(await f.command('bind-children')),
    run: {
      runId: 'run-children',
      revision: 'rev-children',
      plan: minimalPlan(),
      receiptRoot: join(f.root, 'receipts'),
      evidenceRoot: join(f.root, 'evidence'),
      childRefs: [{ storeRoot: childRoot, groupId: 'batch' }],
    },
  });
  const observed = await f.runtime.snapshot('goal');
  assert.equal(observed.status, 'BLOCKED');
  assert.deepEqual(
    observed.runSnapshots.at(-1)?.children.map((c) => c.status),
    ['SUCCEEDED', 'FAILED'],
  );
});

test('pickup keeps two goals in the same session ambiguous even with limit one', async (t) => {
  const f = await fixture(t);
  const session = { host: 'codex', sessionId: 'one-chat-many-goals' };
  await f.store.enterTask({ ...(await f.command('enter')), session });
  await f.store.enterTask({
    taskId: 'goal-2',
    actor: 'temari',
    idempotencyKey: 'enter',
    expectedVersion: 0,
    session,
    create: {
      title: 'Another goal',
      goal: 'Handle this separately.',
      workspaceRoot: f.root,
    },
  });
  const original = FileWorkflowReceiptStore.openExisting;
  let evidenceReads = 0;
  FileWorkflowReceiptStore.openExisting = async () => {
    evidenceReads++;
    throw new Error('Choice discovery must not open evidence.');
  };
  t.after(() => {
    FileWorkflowReceiptStore.openExisting = original;
  });
  const choices = await f.runtime.pickup({
    workspaceRoot: f.root,
    session,
    limit: 1,
  });
  assert.equal(choices.status, 'choices');
  assert.equal(choices.selected, null);
  assert.equal(choices.choices.length, 1);
  assert.equal(choices.hasMore, true);
  assert.equal(evidenceReads, 0);
  const all = await f.runtime.pickup({ workspaceRoot: f.root, session });
  assert.equal(all.status, 'choices');
  assert.equal(all.choices.length, 2);
  assert.equal(all.hasMore, false);
  await assert.rejects(
    f.runtime.pickup({ session }),
    /exact task ID or an absolute workspace/,
  );
});

test('pickup uses exact canonical workspace scope and respects explicit-task filters', async (t) => {
  const f = await fixture(t);
  const nested = join(f.root, 'nested-workspace');
  await mkdir(nested);
  await f.store.enterTask({
    taskId: 'nested-goal',
    actor: 'temari',
    idempotencyKey: 'enter',
    expectedVersion: 0,
    session: { host: 'codex', sessionId: 'nested-chat' },
    create: {
      title: 'Nested workspace',
      goal: 'Do not treat parent paths as membership.',
      workspaceRoot: nested,
    },
  });
  const alias = join(f.root, 'alias');
  await symlink(f.root, alias, 'dir');
  const byCanonicalRoot = await f.runtime.pickup({
    workspaceRoot: await realpath(f.root),
  });
  assert.equal(byCanonicalRoot.status, 'selected');
  assert.equal(byCanonicalRoot.selected?.taskId, 'goal');
  assert.equal(
    (await f.runtime.pickup({ workspaceRoot: alias })).selected?.taskId,
    'goal',
  );
  assert.equal(
    (await f.runtime.pickup({ taskId: 'goal', workspaceRoot: nested })).status,
    'empty',
  );
  assert.equal(
    (
      await f.runtime.pickup({
        taskId: 'goal',
        session: { host: 'codex', sessionId: 'nested-chat' },
      })
    ).status,
    'empty',
  );
  assert.equal(
    (
      await f.runtime.pickup({
        taskId: 'nested-goal',
        workspaceRoot: nested,
        session: { host: 'codex', sessionId: 'nested-chat' },
      })
    ).selected?.taskId,
    'nested-goal',
  );
  await assert.rejects(
    f.runtime.pickup({ workspaceRoot: '.' }),
    /must be absolute/,
  );
  await assert.rejects(
    f.runtime.pickup({ taskId: 'goal', limit: 0 }),
    /Pickup limit/,
  );
});

test('unresolvable unrelated workspaces do not block a healthy pickup scope', async (t) => {
  const f = await fixture(t);
  const file = join(f.root, 'no-longer-a-directory');
  await writeFile(file, 'This path is now a file.');
  const loop = join(f.root, 'symlink-loop');
  await symlink(loop, loop);
  for (const [index, workspaceRoot] of [
    join(f.root, 'missing'),
    join(file, 'child'),
    loop,
  ].entries()) {
    await f.store.createTask({
      taskId: `unavailable-${index}`,
      actor: 'temari',
      idempotencyKey: `unavailable-${index}`,
      title: 'Previously registered workspace',
      goal: 'Retain history after the workspace moves.',
      workspaceRoot,
    });
  }
  const picked = await f.runtime.pickup({ workspaceRoot: f.root });
  assert.equal(picked.status, 'selected');
  assert.equal(picked.selected?.taskId, 'goal');
  assert.equal(
    (await f.runtime.pickup({ taskId: 'unavailable-1' })).selected?.taskId,
    'unavailable-1',
  );
  await assert.rejects(
    f.runtime.pickup({ workspaceRoot: join(file, 'child') }),
    { code: 'ENOTDIR' },
  );
  await assert.rejects(f.runtime.pickup({ workspaceRoot: loop }), {
    code: 'ELOOP',
  });
});

test('fresh-session pickup restores the handoff without executing provider actions', async (t) => {
  const f = await fixture(t);
  const session = { host: 'codex', sessionId: 'previous-chat' };
  await f.store.enterTask({ ...(await f.command('enter')), session });
  await f.store.handoffTask({
    ...(await f.command('handoff')),
    handoff: {
      summary: 'The investigation is retained.',
      decisions: ['Use the current execution harness.'],
      nextAction: 'Inspect the candidate.',
      blocker: 'Awaiting test evidence.',
      contextRefs: [{ kind: 'document', location: 'docs/task-continuity.md' }],
    },
  });
  const runtime = new TaskRuntime({
    store: await FileTaskStore.openExisting(join(f.root, 'tasks')),
  });
  const result = await runtime.pickup({ taskId: 'goal' });
  assert.equal(result.status, 'selected');
  assert.equal(result.selected?.version, (await f.store.load('goal'))?.version);
  assert.equal(result.selected?.handoff?.actor, 'temari');
  assert.equal(result.selected?.handoff?.contextOnly, true);
  assert.equal(result.selected?.handoff?.runId, 'run-1');
  assert.equal(result.selected?.nextAction, 'Inspect the candidate.');
  assert.equal(result.selected?.blocker, 'Awaiting test evidence.');
  assert.equal(result.selected?.currentRun?.runId, 'run-1');
  assert.equal(f.starts + f.resumes + f.cancels, 0);
});

test('positive handoff and prior acceptance cannot hide changed current evidence', async (t) => {
  const f = await fixture(t);
  await f.publish();
  await f.runtime.accept({
    ...(await f.command('accept')),
    reason: 'Reviewed the local evidence.',
  });
  await f.store.handoffTask({
    ...(await f.command('optimistic-handoff')),
    handoff: {
      summary: 'Everything passed and the work is complete.',
      decisions: ['Close this goal.'],
      nextAction: 'No work remains.',
      blocker: null,
      contextRefs: [],
    },
  });
  const original = await f.runtime.pickup({ workspaceRoot: f.root });
  assert.equal(original.status, 'selected');
  assert.equal(original.choices[0]?.statusHint, 'ACCEPTED_UNVERIFIED');
  assert.equal(original.selected?.status, 'DONE');
  const artifact = (await readdir(join(f.root, 'evidence'))).find((name) =>
    name.endsWith('.artifact'),
  )!;
  await writeFile(join(f.root, 'evidence', artifact), 'changed after handoff');
  const refreshed = await f.runtime.pickup({ workspaceRoot: f.root });
  assert.equal(refreshed.status, 'selected');
  assert.equal(refreshed.selected?.status, 'BLOCKED');
  assert.equal(refreshed.selected?.evidence.verified, false);
  assert.equal(refreshed.selected?.semanticAcceptance, false);
  assert.equal(
    refreshed.selected?.handoff?.summary,
    'Everything passed and the work is complete.',
  );
  assert.equal(refreshed.selected?.handoff?.contextOnly, true);
});

test('pickup retains cancelled goals and unresolved native intent without dispatching again', async (t) => {
  const f = await fixture(t);
  f.loseStart();
  await assert.rejects(
    f.runtime.dispatch({
      ...(await f.command('dispatch')),
      entrypoint: 'workflow.yml',
      inputs: { prompt: 'PRIVATE_DISPATCH_INPUT' },
    }),
    /Connection lost/,
  );
  await f.store.handoffTask({
    ...(await f.command('handoff')),
    handoff: {
      summary: 'Continue after the interrupted request.',
      decisions: [],
      nextAction: 'Check the exact native identity.',
      blocker: null,
      contextRefs: [],
    },
  });
  const pending = await f.runtime.pickup({ taskId: 'goal' });
  assert.equal(pending.selected?.status, 'BLOCKED');
  assert.equal(
    pending.selected?.currentRun?.unresolvedOperations[0]?.kind,
    'dispatch',
  );
  assert.equal(f.starts, 1);
  assert(!JSON.stringify(pending).includes('PRIVATE_DISPATCH_INPUT'));
  assert(!JSON.stringify(pending).includes('native.log'));
  await f.runtime.reconcileNative({
    ...(await f.command('reconcile')),
    reference: f.nativeRef,
  });
  await f.runtime.cancel(await f.command('cancel'));
  const cancelled = await f.runtime.pickup({ workspaceRoot: f.root });
  assert.equal(cancelled.status, 'selected');
  assert.equal(cancelled.selected?.status, 'CANCELLED');
  assert.equal(cancelled.choices[0]?.statusHint, 'CANCELLED');
  assert.equal(f.cancels, 1);
  assert.equal(f.starts, 1);
});

test('pickup inspects only the selected current run and skips unrelated artifact stores', async (t) => {
  const f = await fixture(t);
  await f.store.bindRun({
    ...(await f.command('current')),
    run: {
      runId: 'run-current',
      revision: 'rev-current',
      plan: minimalPlan(),
      receiptRoot: join(f.root, 'current-receipts'),
      evidenceRoot: join(f.root, 'current-evidence'),
    },
  });
  const nested = join(f.root, 'different-workspace');
  await mkdir(nested);
  const other = await f.store.createTask({
    taskId: 'other-task',
    actor: 'temari',
    idempotencyKey: 'create',
    title: 'Other project',
    goal: 'Keep unrelated evidence out of this pickup.',
    workspaceRoot: nested,
  });
  await f.store.bindRun({
    taskId: 'other-task',
    actor: 'temari',
    expectedVersion: other.version,
    idempotencyKey: 'bind',
    run: {
      runId: 'other-run',
      revision: 'other-revision',
      plan: minimalPlan(),
      receiptRoot: join(f.root, 'unrelated-poison'),
      evidenceRoot: join(f.root, 'unrelated-evidence'),
    },
  });
  const opened: string[] = [];
  const original = FileWorkflowReceiptStore.openExisting;
  FileWorkflowReceiptStore.openExisting = async (root) => {
    opened.push(root);
    return original(root);
  };
  t.after(() => {
    FileWorkflowReceiptStore.openExisting = original;
  });
  const result = await f.runtime.pickup({ workspaceRoot: f.root });
  assert.equal(result.selected?.currentRun?.runId, 'run-current');
  assert.deepEqual(opened, [join(f.root, 'current-receipts')]);
  assert.equal(result.selected?.history.totalRuns, 2);
  assert.equal(result.selected?.history.omittedRuns, 1);
});

test('pickup bounds handoff text and history while omitting full event and source payloads', async (t) => {
  const f = await fixture(t);
  let task = await f.store.enterTask({
    taskId: 'bounded',
    actor: 'temari',
    idempotencyKey: 'enter',
    expectedVersion: 0,
    session: { host: 'codex', sessionId: 'bounded-session' },
    create: {
      title: 'Bounded pickup',
      goal: '😀'.repeat(8000),
      workspaceRoot: f.root,
    },
  });
  task = await f.store.handoffTask({
    taskId: task.taskId,
    actor: 'temari',
    idempotencyKey: 'handoff',
    expectedVersion: task.version,
    handoff: {
      summary: '日'.repeat(4096),
      decisions: Array(16).fill('日'.repeat(1024)),
      nextAction: '日'.repeat(4096),
      blocker: null,
      contextRefs: Array.from({ length: 16 }, (_, index) => ({
        kind: 'source',
        location: `source-${index}/` + '日'.repeat(4000),
      })),
    },
  });
  for (let i = 0; i < 16; i++)
    task = await f.store.updateTask({
      taskId: task.taskId,
      actor: 'temari',
      idempotencyKey: `metadata-${i}`,
      expectedVersion: task.version,
      title: `Update ${i}`,
    });
  const result = await f.runtime.pickup({ taskId: task.taskId });
  assert(result.selected);
  assert(
    Buffer.byteLength(JSON.stringify(result.selected), 'utf8') <=
      TASK_PICKUP_LIMITS.briefBytes,
  );
  assert.equal(
    result.selected.recentEvents.length,
    TASK_PICKUP_LIMITS.recentEvents,
  );
  assert.equal(
    result.selected.history.omittedEvents,
    task.events.length - TASK_PICKUP_LIMITS.recentEvents,
  );
  assert.equal(result.selected.truncation.omittedDecisions, 8);
  assert.equal(result.selected.truncation.omittedContextRefs, 8);
  assert(result.selected.truncation.fields.includes('goal'));
  assert(result.selected.truncation.fields.includes('handoff.summary'));
  assert.equal('events' in result.selected, false);
  assert.equal('runs' in result.selected, false);
  assert.equal('change' in result.selected.recentEvents[0]!, false);
});

test('pickup preserves maximum-length paths and identities within its encoded byte ceiling', async (t) => {
  const f = await fixture(t);
  const original = await f.runtime.snapshot('goal');
  for (const unit of ['\u0001', '日', '\ud800']) {
    const location = '/' + unit.repeat(4095);
    const runId = 'r'.repeat(128);
    const run = {
      ...original.runs[0]!,
      runId,
      revision: unit.repeat(512),
      receiptRoot: location,
      evidenceRoot: location,
      nativeRef: {
        schema: 1 as const,
        harnessId: unit.repeat(512),
        harnessVersion: unit.repeat(512),
        runId,
        revision: unit.repeat(512),
        planSha256: 'a'.repeat(64),
        externalRunId: 'n'.repeat(128),
        workspaceRoot: location,
        entrypoint: location,
        startedAt: ' '.repeat(10000) + 'Wed, 30 Sep 2026 00:00:00 GMT',
      },
      operations: [
        {
          commandId: unit.repeat(512),
          kind: 'cancel' as const,
          state: 'UNCERTAIN' as const,
          reason: unit.repeat(4096),
        },
      ],
    };
    const snapshot = {
      ...original,
      taskId: 't'.repeat(128),
      title: unit.repeat(256),
      goal: unit.repeat(16384),
      workspaceRoot: location,
      nextAction: unit.repeat(4096),
      blocker: unit.repeat(4096),
      currentRunId: runId,
      runs: [run],
      evidence: {
        ...original.evidence,
        issues: Array(16).fill(unit.repeat(4096)),
      },
      handoff: {
        summary: unit.repeat(4096),
        decisions: Array(16).fill(unit.repeat(1024)),
        nextAction: unit.repeat(4096),
        blocker: unit.repeat(4096),
        contextRefs: Array.from({ length: 16 }, () => ({
          kind: unit.repeat(64),
          location,
          sha256: 'a'.repeat(64),
        })),
        actor: unit.repeat(512),
        at: original.createdAt,
        taskVersion: 2,
        runId,
      },
      events: Array.from({ length: 20 }, (_, index) => ({
        ...original.events[0]!,
        sequence: 49980 + index,
        taskVersion: 49980 + index,
        actor: unit.repeat(512),
        change: { type: 'metadata-updated' as const },
      })),
    };
    const brief = projectTaskPickupBrief(snapshot);
    assert.equal(brief.workspaceRoot, location);
    assert.equal(brief.currentRun?.receiptRoot, location);
    assert.equal(brief.currentRun?.evidenceRoot, location);
    assert.equal(brief.currentRun?.revision, run.revision);
    assert.equal(
      brief.currentRun?.nativeRef?.harnessId,
      run.nativeRef.harnessId,
    );
    assert.equal(
      brief.currentRun?.nativeRef?.startedAt,
      '2026-09-30T00:00:00.000Z',
    );
    assert(
      Buffer.byteLength(JSON.stringify(brief), 'utf8') <=
        TASK_PICKUP_LIMITS.briefBytes,
    );
    assert(brief.truncation.fields.includes('goal'));
    assert(brief.truncation.fields.includes('handoff.summary'));
  }
});
