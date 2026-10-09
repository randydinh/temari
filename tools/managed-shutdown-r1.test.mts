import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
  cp,
  realpath,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  FileTaskStore,
  taskDigest,
} from '../libs/runtime/src/lib/task-store.js';
import { FileChildTaskStore } from '../libs/runtime/src/lib/child-task-store.js';
import { createManagedTaskSupervisor } from '../libs/runtime/src/lib/managed-native-publication.js';
import { ManagedExecutionControl } from '../libs/runtime/src/lib/managed-execution.js';
import { createOwnedExecutionAdapter } from '../libs/host-adapters/src/lib/owned-execution.js';
import { createReviewedLocalCandidatePlan } from '../libs/temari-core/src/index.js';
import type { HarnessRunRef } from '../libs/contracts/src/index.js';

async function rootFixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'shutdown-r1-')));
  t.after(async () => {
    const destination = process.env.WORKER_SHUTDOWN_R1_EVIDENCE_ROOT;
    if (destination) {
      await mkdir(destination, { recursive: true });
      const target = join(
        destination,
        createHash('sha256')
          .update(t.name + root)
          .digest('hex')
          .slice(0, 16),
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
            scope: 'Synthetic evidence; no recovered PID authority.',
          },
          null,
          2,
        ) + '\n',
      );
    }
    await rm(root, { recursive: true, force: true });
  });
  return root;
}
async function publicationFixture(t: TestContext) {
  const root = await rootFixture(t),
    childRoot = join(root, 'children');
  const children = await FileChildTaskStore.create(childRoot);
  const tasks = await FileTaskStore.create(join(root, 'parent'));
  const plan = createReviewedLocalCandidatePlan();
  let parent = await tasks.createTask({
    taskId: 'parent',
    title: 'fixture',
    goal: 'fixture',
    workspaceRoot: root,
    actor: 'fixture',
    idempotencyKey: 'create',
  });
  parent = await tasks.bindRun({
    taskId: 'parent',
    actor: 'fixture',
    expectedVersion: parent.version,
    idempotencyKey: 'bind',
    run: {
      runId: 'run',
      revision: 'revision',
      plan,
      executionStoreRoot: childRoot,
    },
  });
  parent = (
    await tasks.append(
      {
        taskId: 'parent',
        actor: 'fixture',
        expectedVersion: parent.version,
        idempotencyKey: 'dispatch',
      },
      {
        type: 'dispatch-requested',
        runId: 'run',
        entrypoint: 'temari-reviewed-local-candidate',
        inputs: {},
        harnessId: 'archon',
        harnessVersion: '0.10.1',
      },
    )
  ).task;
  const reference: Omit<HarnessRunRef, 'startedAt'> = {
    schema: 1,
    harnessId: 'archon',
    harnessVersion: '0.10.1',
    runId: 'run',
    revision: 'revision',
    planSha256: taskDigest(plan),
    externalRunId: 'native',
    workspaceRoot: root,
    entrypoint: 'temari-reviewed-local-candidate',
  };
  let firstRead!: () => void;
  const reading = new Promise<void>((resolve) => {
    firstRead = resolve;
  });
  let nativeLive = true;
  const options = {
    tasks,
    taskId: 'parent',
    executionStoreRoot: childRoot,
    reference,
    observeNative: async () => {
      firstRead();
      return nativeLive;
    },
    allowInitialPublication: true,
    publicationWaitMs: 1000,
  };
  const publish = async () => {
    const current = (await tasks.load('parent'))!;
    return (
      await tasks.append(
        {
          taskId: 'parent',
          actor: 'fixture',
          expectedVersion: current.version,
          idempotencyKey: 'publish',
        },
        {
          type: 'native-bound',
          runId: 'run',
          operationId: 'dispatch',
          reference: { ...reference, startedAt: new Date().toISOString() },
        },
      )
    ).task;
  };
  return {
    root,
    children,
    tasks,
    options,
    reading,
    publish,
    lose: () => {
      nativeLive = false;
    },
  };
}

test('R1 delayed exact native publication admits owned work only after the existing caller binds it', async (t) => {
  const f = await publicationFixture(t);
  let launches = 0;
  const running = (async () => {
    const observe = await createManagedTaskSupervisor(f.options);
    const control = new ManagedExecutionControl({
      store: f.children,
      adapter: createOwnedExecutionAdapter(),
      root: f.root,
      runId: 'run',
      revision: 'revision',
      binding: 'delayed-native',
      authorityId: 'authority',
      processIds: ['work'],
      observeSupervisor: observe,
    });
    await control.start();
    launches++;
    try {
      await control.run('work', {
        program: process.execPath,
        args: ['-e', 'console.log("permitted")'],
        cwd: f.root,
        timeoutMs: 1000,
      });
      await control.finish();
    } finally {
      await control.drain();
    }
  })();
  await f.reading;
  assert.equal(launches, 0);
  assert.equal(await f.children.load('authority'), null);
  const published = await f.publish();
  await running;
  assert.equal(launches, 1);
  assert.equal(published.runs[0]!.nativeRef!.externalRunId, 'native');
  assert.equal((await f.children.load('work'))?.execution?.state, 'CLEANED');
});

test('R1 no native publication expires within its finite bound without useful work or invented reference', async (t) => {
  const f = await publicationFixture(t);
  const started = performance.now();
  await assert.rejects(
    createManagedTaskSupervisor({ ...f.options, publicationWaitMs: 180 }),
    /publication deadline expired/,
  );
  assert(performance.now() - started < 1500);
  assert.equal((await f.tasks.load('parent'))!.runs[0]!.nativeRef, null);
  assert.equal(await f.children.load('authority'), null);
});

test('R1 cancel during initial publication wait refuses before authority/dispatch', async (t) => {
  const f = await publicationFixture(t),
    controller = new AbortController();
  const waiting = assert.rejects(
    createManagedTaskSupervisor({ ...f.options, signal: controller.signal }),
    /publication cancelled/,
  );
  await f.reading;
  controller.abort();
  await waiting;
  assert.equal(await f.children.load('authority'), null);
  assert.equal((await f.tasks.load('parent'))!.runs[0]!.nativeRef, null);
});

test('R1 native terminal/lost supervision during publication wait does not await or grant a reference', async (t) => {
  const f = await publicationFixture(t);
  const waiting = assert.rejects(
    createManagedTaskSupervisor(f.options),
    /supervision ended/,
  );
  await f.reading;
  f.lose();
  await waiting;
  assert.equal(await f.children.load('authority'), null);
});

test('R1 published reference loss is immediately refused by live observation and cannot restart a publication wait', async (t) => {
  const f = await publicationFixture(t);
  await f.publish();
  const observe = await createManagedTaskSupervisor(f.options);
  assert(await observe());
  const original = f.tasks.load.bind(f.tasks);
  f.tasks.load = async (id) => {
    const task = await original(id);
    return task
      ? { ...task, runs: task.runs.map((run) => ({ ...run, nativeRef: null })) }
      : null;
  };
  assert.equal(await observe(), false);
  await assert.rejects(
    createManagedTaskSupervisor(f.options),
    /Previously bound native reference was lost/,
  );
});

test('R1 foreign published native reference and changed pending dispatch are refused', async (t) => {
  const f = await publicationFixture(t);
  await f.publish();
  await assert.rejects(
    createManagedTaskSupervisor({
      ...f.options,
      reference: { ...f.options.reference, externalRunId: 'foreign' },
    }),
    /does not match/,
  );
  const original = f.tasks.load.bind(f.tasks);
  f.tasks.load = async (id) => {
    const task = await original(id);
    return task
      ? {
          ...task,
          events: task.events.filter(
            (event) => event.change.type !== 'native-bound',
          ),
          runs: task.runs.map((run) => ({
            ...run,
            nativeRef: null,
            operations: run.operations.map((op) => ({
              ...op,
              state: 'PENDING' as const,
              harnessId: 'foreign',
            })),
          })),
        }
      : null;
  };
  await assert.rejects(
    createManagedTaskSupervisor(f.options),
    /exact existing pending dispatch/,
  );
});

async function memberFixture(t: TestContext) {
  const f = await publicationFixture(t);
  for (const taskId of ['authority', 'work'])
    await f.children.create({
      taskId,
      runId: 'run',
      revision: 'revision',
      dependsOn: [],
      actor: 'fixture',
    });
  await f.children.ensureGroup({
    groupId: 'authority',
    runId: 'run',
    revision: 'revision',
    taskIds: ['authority', 'work'],
    assignmentIds: ['authority', 'work'],
  });
  for (const taskId of ['authority', 'work'])
    await f.children.cancel({
      taskId,
      actor: 'fixture',
      idempotencyKey: `cancel-${taskId}`,
    });
  const replace = async () => {
    const current = (await f.tasks.load('parent'))!;
    // Keep the fixture's initial pending dispatch separate from cleanup: clear it
    // via its normal native publication and terminal observation, never by deletion.
    if (!current.runs[0]!.nativeRef) await f.publish();
    const linked = (await f.tasks.load('parent'))!;
    if (!linked.runs[0]!.nativeSnapshot)
      await f.tasks.append(
        {
          taskId: 'parent',
          actor: 'fixture',
          expectedVersion: linked.version,
          idempotencyKey: 'terminal',
        },
        {
          type: 'native-observed',
          runId: 'run',
          snapshot: {
            status: 'FAILED',
            observedAt: new Date().toISOString(),
            summary: 'synthetic terminal',
            rawLogPath: null,
          },
        },
      );
    const selected = (await f.tasks.load('parent'))!;
    return f.tasks.bindRun({
      taskId: 'parent',
      actor: 'fixture',
      expectedVersion: selected.version,
      idempotencyKey: 'replacement',
      run: {
        runId: 'replacement',
        revision: 'revision',
        plan: createReviewedLocalCandidatePlan(),
      },
    });
  };
  return { ...f, replace };
}
for (const damage of [
  'state',
  'state-and-log',
  'log',
  'group',
  'corrupt-state',
  'corrupt-group',
  'corrupt-log',
  'foreign-group-revision',
  'corrupt-orphan-transaction',
] as const)
  test(`R1 incomplete retained ${damage} cannot hide a member from parent replacement`, async (t) => {
    const f = await memberFixture(t);
    const state = join(f.root, 'children', 'work.task.json'),
      log = join(f.root, 'children', 'work.events.jsonl'),
      group = join(f.root, 'children', 'authority.group.json');
    const before = (await f.tasks.load('parent'))!.version;
    if (damage === 'state' || damage === 'state-and-log')
      await rename(state, join(f.root, 'saved-state.json'));
    if (damage === 'state-and-log' || damage === 'log')
      await rename(log, join(f.root, 'saved-log.jsonl'));
    if (damage === 'group')
      await rename(group, join(f.root, 'saved-group.json'));
    if (damage === 'corrupt-state') await writeFile(state, '{');
    if (damage === 'corrupt-group') await writeFile(group, '{');
    if (damage === 'corrupt-log') await writeFile(log, '{');
    if (damage === 'foreign-group-revision') {
      const record = JSON.parse(await readFile(group, 'utf8'));
      record.revision = 'foreign';
      await writeFile(group, JSON.stringify(record));
    }
    if (damage === 'corrupt-orphan-transaction')
      await writeFile(
        join(f.root, 'children', '.orphan.transaction.json'),
        '{',
      );
    await assert.rejects(f.replace());
    assert.equal((await f.tasks.load('parent'))!.currentRunId, 'run');
    await writeFile(
      join(f.root, 'refusal.json'),
      JSON.stringify(
        {
          damage,
          replacement: 'refused',
          beforeVersion: before,
          retainedParent: (await f.tasks.load('parent'))!.currentRunId,
        },
        null,
        2,
      ) + '\n',
    );
  });

test('R1 complete reconciled membership remains a positive replacement control', async (t) => {
  const f = await memberFixture(t);
  assert.deepEqual(
    (await f.children.executionRecords('run')).map((record) => record.taskId),
    ['authority', 'work'],
  );
  assert.equal((await f.replace()).currentRunId, 'replacement');
});
