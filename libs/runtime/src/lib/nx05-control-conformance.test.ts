import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const fixture = join(import.meta.dirname, 'fixtures/nx05-control-worker.ts');
const base = '2026-09-28T12:00:00.000Z';
const afterLease = '2026-09-28T12:00:03.000Z';

interface Reply {
  readonly pid: number;
  readonly value: any;
}

async function worker(
  root: string,
  operation: string,
  input: object = {},
): Promise<Reply> {
  const { stdout } = await exec(
    process.execPath,
    [
      '--import',
      '@swc-node/register/esm-register',
      fixture,
      root,
      operation,
      JSON.stringify(input),
    ],
    { cwd: process.cwd() },
  );
  return JSON.parse(stdout) as Reply;
}

async function rootForTest(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'temari-nx05-control-'));
}

test('separate processes serialize parent and child claims, then fence stale owners after restart', async () => {
  const root = await rootForTest();
  try {
    await worker(root, 'create-parent', { id: 'parent', now: base });
    await worker(root, 'create-child', { id: 'child', now: base });
    const parentClaims = await Promise.all([
      worker(root, 'claim-parent', { id: 'parent', owner: 'a', now: base }),
      worker(root, 'claim-parent', { id: 'parent', owner: 'b', now: base }),
    ]);
    assert.notEqual(parentClaims[0].pid, parentClaims[1].pid);
    assert.deepEqual(parentClaims.map((reply) => reply.value.claimed).sort(), [
      false,
      true,
    ]);
    const oldParent = parentClaims.find((reply) => reply.value.claimed)?.value
      .record;
    assert(oldParent?.lease);
    const blocked = await worker(root, 'claim-parent', {
      id: 'parent',
      owner: 'c',
      now: base,
    });
    assert.equal(blocked.value.claimed, false);
    const newParent = await worker(root, 'claim-parent', {
      id: 'parent',
      owner: 'c',
      now: afterLease,
    });
    assert.notEqual(
      parentClaims.find((reply) => reply.value.claimed)?.pid,
      newParent.pid,
    );
    assert.equal(newParent.value.record.attempt, 2);
    await assert.rejects(
      worker(root, 'complete-parent', {
        id: 'parent',
        owner: oldParent.lease.owner,
        token: oldParent.lease.token,
        now: afterLease,
        key: 'stale-parent',
      }),
      /lease (owner|token) mismatch/,
    );
    const parentDone = await worker(root, 'complete-parent', {
      id: 'parent',
      owner: 'c',
      token: newParent.value.record.lease.token,
      now: afterLease,
      key: 'parent-done',
    });
    assert.equal(parentDone.value.status, 'SUCCEEDED');
    assert.deepEqual(
      (
        await worker(root, 'complete-parent', {
          id: 'parent',
          owner: 'c',
          token: newParent.value.record.lease.token,
          now: afterLease,
          key: 'parent-done',
        })
      ).value,
      parentDone.value,
    );

    const childClaims = await Promise.all([
      worker(root, 'claim-child', { id: 'child', owner: 'a', now: base }),
      worker(root, 'claim-child', { id: 'child', owner: 'b', now: base }),
    ]);
    assert.notEqual(childClaims[0].pid, childClaims[1].pid);
    assert.deepEqual(childClaims.map((reply) => reply.value.claimed).sort(), [
      false,
      true,
    ]);
    const oldChild = childClaims.find((reply) => reply.value.claimed)?.value
      .record;
    assert(oldChild?.lease);
    const newChild = await worker(root, 'claim-child', {
      id: 'child',
      owner: 'c',
      now: afterLease,
    });
    assert.notEqual(
      childClaims.find((reply) => reply.value.claimed)?.pid,
      newChild.pid,
    );
    assert.equal(newChild.value.record.lease.fencingEpoch, 2);
    await assert.rejects(
      worker(root, 'complete-child', {
        id: 'child',
        owner: oldChild.lease.owner,
        token: oldChild.lease.token,
        epoch: oldChild.lease.fencingEpoch,
        now: afterLease,
        key: 'stale-child',
      }),
      /lease (owner|token) mismatch/,
    );
    const completion = {
      id: 'child',
      owner: 'c',
      token: newChild.value.record.lease.token,
      epoch: 2,
      now: afterLease,
      key: 'child-done',
    };
    const childDone = await worker(root, 'complete-child', completion);
    assert.equal(childDone.value.status, 'FAILED');
    assert.equal(childDone.value.error, 'synthetic failure');
    const replay = await worker(root, 'complete-child', completion);
    assert.deepEqual(replay.value, childDone.value);
    await assert.rejects(
      worker(root, 'complete-child', { ...completion, epoch: 1 }),
      /fencing epoch changed/,
    );
    const events = await worker(root, 'child-events', { id: 'child' });
    assert.deepEqual(
      events.value.map((event: { type: string }) => event.type),
      ['task-created', 'task-claimed', 'task-claimed', 'task-completed'],
    );
    console.log(
      'NX05 process restart',
      JSON.stringify({
        parentClaimPid: parentClaims.find((reply) => reply.value.claimed)?.pid,
        parentRestartPid: newParent.pid,
        parentAttempt: newParent.value.record.attempt,
        childClaimPid: childClaims.find((reply) => reply.value.claimed)?.pid,
        childRestartPid: newChild.pid,
        childEpoch: newChild.value.record.lease.fencingEpoch,
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('separate claimers enforce one child group concurrency limit', async () => {
  const root = await rootForTest();
  try {
    const taskIds = [
      'group-child-a',
      'group-child-b',
      'group-child-c',
      'group-child-d',
    ];
    for (const id of taskIds)
      await worker(root, 'create-child', { id, now: base });
    await worker(root, 'ensure-group', {
      id: 'bounded-group',
      taskIds,
      now: base,
    });
    const claims = await Promise.all([
      worker(root, 'claim-group', {
        id: 'bounded-group',
        taskIds,
        owner: 'a',
        now: base,
      }),
      worker(root, 'claim-group', {
        id: 'bounded-group',
        taskIds,
        owner: 'b',
        now: base,
      }),
    ]);
    assert.notEqual(claims[0].pid, claims[1].pid);
    assert.equal(
      claims.reduce((count, reply) => count + reply.value.claimed.length, 0),
      2,
    );
    assert.deepEqual(
      claims
        .flatMap((reply) =>
          reply.value.claimed.map(
            (record: { taskId: string }) => record.taskId,
          ),
        )
        .sort(),
      taskIds.slice(0, 2),
    );
    const later = await worker(root, 'claim-group', {
      id: 'bounded-group',
      taskIds,
      owner: 'c',
      now: base,
    });
    assert.equal(later.value.claimed.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cancellation and artifact hashes survive a new process', async () => {
  const root = await rootForTest();
  try {
    await worker(root, 'create-parent', { id: 'cancelled', now: base });
    await worker(root, 'create-child', { id: 'cancelled-child', now: base });
    await worker(root, 'cancel-parent', { id: 'cancelled', now: base });
    await worker(root, 'cancel-child', { id: 'cancelled-child', now: base });
    assert.equal(
      (
        await worker(root, 'claim-parent', {
          id: 'cancelled',
          owner: 'a',
          now: base,
        })
      ).value.claimed,
      false,
    );
    assert.equal(
      (
        await worker(root, 'claim-child', {
          id: 'cancelled-child',
          owner: 'a',
          now: base,
        })
      ).value.claimed,
      false,
    );
    await worker(root, 'create-parent', { id: 'active-cancel', now: base });
    await worker(root, 'claim-parent', {
      id: 'active-cancel',
      owner: 'a',
      now: base,
    });
    await worker(root, 'cancel-parent', { id: 'active-cancel', now: base });
    assert.equal(
      (await worker(root, 'cancellation-requested', { id: 'active-cancel' }))
        .value,
      true,
    );

    const content = 'nx05 synthetic evidence';
    const put = await worker(root, 'put-artifact', { content });
    assert.equal(
      put.value.sha256,
      createHash('sha256').update(content).digest('hex'),
    );
    const loaded = await worker(root, 'load-artifact', {
      reference: put.value,
    });
    assert.notEqual(loaded.pid, put.pid);
    assert.equal(loaded.value, content);
    await writeFile(put.value.path, 'corrupt');
    await assert.rejects(
      worker(root, 'load-artifact', { reference: put.value }),
      /hash mismatch|byte count changed/i,
    );
    await rm(put.value.path);
    await assert.rejects(
      worker(root, 'load-artifact', { reference: put.value }),
      /ENOENT/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a new process reconciles each interrupted parent and child commit boundary', async () => {
  const root = await rootForTest();
  try {
    for (const [index, stage] of [
      'after-sidecar-fsync',
      'after-state-publication',
      'after-event-publication',
      'after-sidecar-removal',
    ].entries()) {
      const parent = `crash-parent-${index}`;
      const child = `crash-child-${index}`;
      await worker(root, 'create-parent', { id: parent, now: base });
      await worker(root, 'create-child', { id: child, now: base });
      await assert.rejects(
        worker(root, 'crash-parent-claim', { id: parent, stage, now: base }),
        /Injected run store interruption/,
      );
      await assert.rejects(
        worker(root, 'crash-child-claim', { id: child, stage, now: base }),
        /Injected child task store interruption/,
      );
      const recoveredParent = await worker(root, 'load-parent', { id: parent });
      const recoveredChild = await worker(root, 'load-child', { id: child });
      assert.equal(recoveredParent.value.status, 'RUNNING');
      assert.equal(recoveredChild.value.status, 'RUNNING');
      assert.equal(recoveredParent.value.attempt, 1);
      assert.equal(recoveredChild.value.lease.fencingEpoch, 1);
      assert.equal(
        (
          await worker(root, 'claim-parent', {
            id: parent,
            owner: 'restart',
            now: afterLease,
          })
        ).value.record.attempt,
        2,
      );
      assert.equal(
        (
          await worker(root, 'claim-child', {
            id: child,
            owner: 'restart',
            now: afterLease,
          })
        ).value.record.lease.fencingEpoch,
        2,
      );
    }
    console.log(
      'NX05 crash recovery',
      JSON.stringify({
        stages: 4,
        stores: ['parent', 'child'],
        restartObservations: 8,
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a stale parent cannot append an event after another process takes its lease', async () => {
  const root = await rootForTest();
  try {
    await worker(root, 'create-parent', { id: 'fenced-events', now: base });
    const first = await worker(root, 'claim-parent', {
      id: 'fenced-events',
      owner: 'old',
      now: base,
    });
    const second = await worker(root, 'claim-parent', {
      id: 'fenced-events',
      owner: 'new',
      now: afterLease,
    });
    assert.equal(second.value.record.attempt, 2);
    await assert.rejects(
      worker(root, 'append-parent-event', {
        id: 'fenced-events',
        owner: 'old',
        token: first.value.record.lease.token,
        key: 'stale-dispatch',
        payload: { marker: 'stale' },
        now: afterLease,
      }),
      /lease (owner|token) mismatch/,
    );
    const events = await worker(root, 'parent-events', { id: 'fenced-events' });
    assert.deepEqual(
      events.value.map((event: { type: string }) => event.type),
      ['run-created', 'run-claimed', 'run-claimed'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a parent idempotency key rejects a replay that omits the committed marker', async () => {
  const root = await rootForTest();
  try {
    await worker(root, 'create-parent', { id: 'payload-replay', now: base });
    const claim = await worker(root, 'claim-parent', {
      id: 'payload-replay',
      owner: 'owner',
      now: base,
    });
    const completion = {
      id: 'payload-replay',
      owner: 'owner',
      token: claim.value.record.lease.token,
      key: 'complete-payload',
      now: base,
    };
    const first = await worker(root, 'complete-parent', {
      ...completion,
      payload: { marker: 'original' },
    });
    assert.equal(first.value.status, 'SUCCEEDED');
    await assert.rejects(
      worker(root, 'complete-parent', { ...completion, payload: {} }),
      /Idempotency key payload changed/,
    );
    const events = await worker(root, 'parent-events', {
      id: 'payload-replay',
    });
    assert.equal(events.value.length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('file child completion admits a missing artifact, so shared publication remains blocked', async () => {
  const root = await rootForTest();
  try {
    await worker(root, 'create-child', {
      id: 'missing-publication',
      now: base,
    });
    const claim = await worker(root, 'claim-child', {
      id: 'missing-publication',
      owner: 'owner',
      now: base,
    });
    const reference = {
      schema: 1 as const,
      runId: 'synthetic-parent',
      revision: 'synthetic-revision',
      kind: 'worker-result' as const,
      sha256: createHash('sha256').update('never-written').digest('hex'),
      bytes: Buffer.byteLength('never-written'),
    };
    const publication = await worker(root, 'complete-child-result', {
      id: 'missing-publication',
      owner: 'owner',
      token: claim.value.record.lease.token,
      epoch: claim.value.record.lease.fencingEpoch,
      key: 'missing-artifact',
      now: base,
      result: {
        status: 'PASS',
        summary: 'synthetic result',
        evidencePaths: ['synthetic.txt'],
        rawLogPath: null,
        evidenceReferences: [reference],
      },
    });
    assert.equal(publication.value.status, 'SUCCEEDED');
    assert.deepEqual(publication.value.result.evidenceReferences, [reference]);
    await assert.rejects(
      worker(root, 'load-artifact', { reference }),
      /ENOENT/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
