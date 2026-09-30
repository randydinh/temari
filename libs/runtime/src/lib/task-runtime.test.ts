import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
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
