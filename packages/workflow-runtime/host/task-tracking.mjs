import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, open, realpath, unlink } from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  sep,
} from 'node:path';
import { exactFields, readBoundedFile, readBoundedJson } from './stdio.mjs';

const SIDECAR_BYTES = 128 * 1024;
const BINDING_BYTES = 64 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });

function text(value, label, limit) {
  assert(
    typeof value === 'string' &&
      value.trim().length > 0 &&
      value.length <= limit &&
      !value.includes('\0'),
    `Invalid task tracking ${label}.`,
  );
}

function absolute(value) {
  text(value, 'path', 4096);
  assert(
    isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value),
    'Task tracking paths must be absolute and contain no control characters.',
  );
  return normalize(value);
}

async function directory(path) {
  const selected = absolute(path);
  const stat = await lstat(selected);
  assert(
    stat.isDirectory() && !stat.isSymbolicLink(),
    'Task tracking requires a real directory.',
  );
  return realpath(selected);
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function taskRoot(path) {
  const selected = absolute(path);
  if (await exists(selected)) return directory(selected);
  // A new ledger may be created only directly inside an existing real parent.
  return join(await directory(dirname(selected)), basename(selected));
}

function contains(parent, child) {
  const part = relative(parent, child);
  return (
    part === '' ||
    (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`))
  );
}

function isolated(root, roots) {
  assert(
    roots.every((other) => !contains(root, other) && !contains(other, root)),
    'Task root must be isolated from candidate, runtime and run directories.',
  );
}

function phaseKey(sidecar, phase) {
  return `host-tracking:${createHash('sha256')
    .update(
      JSON.stringify([
        sidecar.expected.runId,
        sidecar.expected.revision,
        sidecar.expected.runDirectory,
        sidecar.expected.candidateRoot,
        sidecar.idempotencyKey,
        phase,
      ]),
    )
    .digest('hex')}`;
}

function command(sidecar, phase, offset) {
  return {
    taskId: sidecar.taskId,
    actor: sidecar.actor,
    expectedVersion: sidecar.expectedVersion + offset,
    idempotencyKey: phaseKey(sidecar, phase),
  };
}

function priorEvent(task, request, change) {
  const prior = task?.events.find(
    (event) => event.idempotencyKey === request.idempotencyKey,
  );
  if (prior) {
    assert.equal(
      prior.actor,
      request.actor,
      'Task tracking idempotency actor conflict.',
    );
    assert.equal(
      prior.taskVersion,
      request.expectedVersion + 1,
      'Task tracking idempotency version conflict.',
    );
    assert.deepEqual(
      prior.change,
      change,
      'Task tracking idempotency payload conflict.',
    );
  }
  return prior;
}

function validateSidecar(value, runtime) {
  exactFields(
    value,
    [
      'schemaVersion',
      'taskRoot',
      'taskId',
      'actor',
      'session',
      'expectedVersion',
      'idempotencyKey',
      'expected',
    ],
    ['create'],
  );
  assert.equal(value.schemaVersion, 1, 'Unsupported task tracking schema.');
  absolute(value.taskRoot);
  runtime.assertTaskId(value.taskId);
  text(value.actor, 'actor', 512);
  text(value.idempotencyKey, 'idempotency key', 512);
  runtime.assertTaskSessionIdentity(value.session);
  assert(
    Number.isSafeInteger(value.expectedVersion) &&
      value.expectedVersion >= 0 &&
      value.expectedVersion <= Number.MAX_SAFE_INTEGER - 3,
    'Invalid task tracking expected version.',
  );
  exactFields(value.expected, [
    'runId',
    'revision',
    'runDirectory',
    'candidateRoot',
  ]);
  runtime.assertTaskId(value.expected.runId);
  text(value.expected.revision, 'revision', 512);
  absolute(value.expected.runDirectory);
  absolute(value.expected.candidateRoot);
  if (value.create !== undefined) {
    exactFields(value.create, ['title', 'goal', 'workspaceRoot']);
    text(value.create.title, 'title', 256);
    text(value.create.goal, 'goal', 16384);
    absolute(value.create.workspaceRoot);
    assert.equal(
      value.expectedVersion,
      0,
      'Creating a tracked task requires version zero.',
    );
  }
}

async function writeBinding(path, binding) {
  const bytes = Buffer.from(`${JSON.stringify(binding)}\n`);
  assert(bytes.length <= BINDING_BYTES, 'Task binding exceeds the byte limit.');
  const temporary = join(dirname(path), `.task-binding-${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    // Publish complete bytes without replacing a concurrent task selection.
    try {
      await link(temporary, path);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      assert.deepEqual(
        await readBoundedJson(path, BINDING_BYTES),
        binding,
        'Host run task binding changed during publication.',
      );
    }
    const parent = await open(dirname(path), 'r');
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

/** Read-only admission. Bookkeeping never changes the invocation or accepts a run. */
export async function prepareTaskTracking({
  runtime,
  runtimeRoot,
  input,
  paths,
  sidecarPath,
  expectedSha256,
}) {
  const bindingPath = join(input.runDirectory, 'task-binding.json');
  const retained = (await exists(bindingPath))
    ? await readBoundedJson(bindingPath, BINDING_BYTES)
    : null;
  if (sidecarPath === undefined) {
    assert(
      expectedSha256 === undefined,
      'Task tracking requires both sidecar and expected digest.',
    );
    assert(
      retained === null,
      'This host run is task-tracked; resume requires its explicit task tracking sidecar and digest.',
    );
    return null;
  }
  assert(
    typeof expectedSha256 === 'string' && /^[a-f0-9]{64}$/.test(expectedSha256),
    'Task tracking requires a lowercase SHA-256 digest.',
  );
  const bytes = await readBoundedFile(absolute(sidecarPath), SIDECAR_BYTES);
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    expectedSha256,
    'Task tracking sidecar digest mismatch.',
  );
  const sidecar = JSON.parse(utf8.decode(bytes));
  validateSidecar(sidecar, runtime);
  assert.deepEqual(
    sidecar.expected,
    {
      runId: input.runId,
      revision: input.revision,
      runDirectory: input.runDirectory,
      candidateRoot: input.candidate.root,
    },
    'Task tracking expected host identity mismatch.',
  );
  const root = await taskRoot(sidecar.taskRoot);
  isolated(root, [input.candidate.root, runtimeRoot, input.runDirectory]);
  const binding = {
    schemaVersion: 1,
    taskRoot: root,
    taskId: sidecar.taskId,
    ...sidecar.expected,
  };
  if (retained !== null)
    assert.deepEqual(
      retained,
      binding,
      'Host run task binding differs from the retained logical task.',
    );
  const contextRefs = [
    { kind: 'host-input', location: join(paths.config, 'input.json') },
    {
      kind: 'host-receipt-pending-closeout',
      location: join(paths.stores[0], `${input.runId}.receipt.json`),
    },
    {
      kind: 'host-checkpoint',
      location: join(paths.stores[1], `${input.runId}.checkpoint.json`),
    },
    { kind: 'host-evidence', location: paths.stores[2] },
  ];
  for (const ref of contextRefs) absolute(ref.location);
  const enter = {
    ...command(sidecar, 'enter', 0),
    session: sidecar.session,
    ...(sidecar.create === undefined ? {} : { create: sidecar.create }),
  };
  const startHandoff = {
    summary: `Starting or resuming host run ${input.runId} at revision ${input.revision}. Receipt and checkpoint references may still be pending.`,
    decisions: [
      'Task tracking records execution context only. Candidate-profile evidence requires trusted closeout; no task completion is asserted.',
    ],
    nextAction:
      'Continue the host run. If interrupted, inspect the exact retained checkpoint and resume this run with explicit task tracking.',
    blocker: null,
    contextRefs,
  };
  let store = (await exists(root))
    ? await runtime.FileTaskStore.openExisting(root)
    : null;
  let started = false;

  async function validateTask() {
    const task = store ? await store.load(sidecar.taskId) : null;
    if (task) {
      assert(
        task.runs.length === 0 && task.acceptance === null,
        'Source host tracking cannot replace or reopen a task with canonical runs or acceptance. Use its existing task-run controls and closeout.',
      );
      assert.equal(
        await directory(task.workspaceRoot),
        input.candidate.root,
        'Tracked task workspace differs from the canonical candidate scope.',
      );
    } else {
      assert(
        sidecar.create,
        'Tracked task is missing and no creation metadata was supplied.',
      );
      assert.equal(
        sidecar.expectedVersion,
        0,
        'Missing tracked task requires version zero.',
      );
    }
    if (sidecar.create)
      assert.equal(
        await directory(sidecar.create.workspaceRoot),
        input.candidate.root,
        'Task creation workspace differs from the canonical candidate scope.',
      );
    const prior = priorEvent(task, enter, {
      type: 'task-entered',
      session: enter.session,
      ...(enter.create === undefined ? {} : { create: enter.create }),
    });
    if (!prior) {
      assert.equal(
        task?.version ?? 0,
        sidecar.expectedVersion,
        'Task tracking version conflict; reload before entering.',
      );
      assert(
        !task || sidecar.create === undefined,
        'Existing task entry cannot create or replace task metadata.',
      );
    } else {
      const start = priorEvent(task, command(sidecar, 'starting', 1), {
        type: 'handoff-recorded',
        handoff: startHandoff,
      });
      assert.equal(
        task.version,
        start ? sidecar.expectedVersion + 2 : sidecar.expectedVersion + 1,
        'Tracked attempt has finished or task progress changed; use a fresh key and current version.',
      );
    }
  }
  await validateTask();

  return {
    get started() {
      return started;
    },
    async reserve() {
      assert.equal(
        await taskRoot(sidecar.taskRoot),
        root,
        'Task root resolution changed.',
      );
      if (await exists(bindingPath))
        assert.deepEqual(
          await readBoundedJson(bindingPath, BINDING_BYTES),
          binding,
          'Host run task binding changed.',
        );
      else await writeBinding(bindingPath, binding);
    },
    async start() {
      if (started) return;
      // Recheck after the runtime validates the invocation, before any worker.
      await validateTask();
      await this.reserve();
      store ??= await runtime.FileTaskStore.create(root);
      await store.enterTask(enter);
      await store.handoffTask({
        ...command(sidecar, 'starting', 1),
        handoff: startHandoff,
      });
      started = true;
    },
    async finish(receipt, error) {
      try {
        if (!started) await this.start();
        const status = receipt?.status;
        const summary = receipt
          ? `Host run ${input.runId} returned ${status}. ${status === 'PASS' ? 'Trusted candidate closeout is still pending.' : 'Inspect the retained outcome before continuing.'}`
          : `Host run ${input.runId} was interrupted before a completed host outcome. Inspect the retained checkpoint before recovery.`;
        const handoff = {
          summary,
          decisions: [
            'This host result is context, not coordinator acceptance or task completion.',
          ],
          nextAction:
            status === 'PASS'
              ? 'Verify this exact candidate and receipt through trusted closeout before accepting the task.'
              : 'Inspect the exact receipt and checkpoint. Resume only when supported, using a fresh tracking key and current task version; otherwise plan a new run.',
          blocker:
            status === 'PASS'
              ? null
              : receipt
                ? `Host outcome ${status} requires attention.`
                : `Host execution interrupted${error instanceof Error ? `: ${error.message.slice(0, 1024)}` : '.'}`,
          contextRefs,
        };
        await store.handoffTask({ ...command(sidecar, 'outcome', 2), handoff });
      } catch (failure) {
        throw new Error(
          `Task outcome handoff failed: ${failure instanceof Error ? failure.message : String(failure)}. ${receipt ? 'Canonical receipt retained at' : 'Recovery checkpoint location:'} ${receipt ? contextRefs[1].location : contextRefs[2].location}`,
          { cause: failure },
        );
      }
    },
  };
}
