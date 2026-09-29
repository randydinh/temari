import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import type { WorkerAssignment } from '@temari/contracts';
import { nx05AssignmentSha256, type Nx05ParentCommit } from '@temari/runtime';

import { SqliteImmutableArtifactProvider } from './sqlite-artifact-provider.js';
import { SqliteNx05ControlTestProvider } from './sqlite-control-test-provider.js';

const runProcess = promisify(execFile);

const assignment: WorkerAssignment = {
  id: 'worker-one',
  role: 'implementer',
  required: true,
  brief: {
    goal: 'Build a fixture',
    context: 'NX05 local service test',
    scope: 'fixture.txt',
    acceptanceCriteria: ['The fixture passes'],
    verificationCommand: 'node check.mjs',
    reportFormat: 'json',
    forbiddenActions: ['Do not edit another workspace'],
  },
};

function dispatch(
  token: string,
  epoch: number,
  groupId = 'group-one',
): Nx05ParentCommit {
  return {
    runId: 'run-one',
    lease: { owner: 'parent-one', token, fencingEpoch: epoch },
    idempotencyKey: `commit-${groupId}`,
    status: 'RUNNING',
    event: { type: 'run-event', payload: { dispatch: groupId } },
    dispatch: [
      {
        groupId,
        maxConcurrency: 1,
        tasks: [
          {
            taskId: groupId === 'group-one' ? 'task-one' : 'task-two',
            idempotencyKey: `task-${groupId}`,
            assignment:
              groupId === 'group-one'
                ? assignment
                : { ...assignment, id: 'worker-two' },
            assignmentSha256: nx05AssignmentSha256(
              groupId === 'group-one'
                ? assignment
                : { ...assignment, id: 'worker-two' },
            ),
            dependsOn: [],
          },
        ],
      },
    ],
  };
}

test('local SQLite control commits state, event, and dispatch across two connections', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-nx05-control-'));
  const path = join(root, 'service.sqlite');
  let time = Date.parse('2026-09-29T00:00:00.000Z');
  const clock = () => new Date(time);
  const first = await SqliteNx05ControlTestProvider.open(path, clock);
  const second = await SqliteNx05ControlTestProvider.open(path, clock);
  try {
    await first.createParent({
      runId: 'run-one',
      revision: 'rev-one',
      actor: 'creator',
    });
    const claim = await first.claimParent({
      runId: 'run-one',
      owner: 'parent-one',
      leaseMs: 1000,
    });
    assert(claim.claimed && claim.record.lease);
    const request = dispatch(claim.record.lease.token, claim.record.attempt);
    const committed = await first.commitParentAndDispatch(request);
    assert.equal(committed.status, 'RUNNING');
    assert.equal((await second.loadParent('run-one'))?.status, 'RUNNING');
    assert.equal((await second.loadChild('task-one'))?.status, 'QUEUED');
    assert.equal(
      (await second.events('run-one')).at(-1)?.payload.dispatch,
      'group-one',
    );
    assert.deepEqual(await second.commitParentAndDispatch(request), committed);
    await assert.rejects(
      second.commitParentAndDispatch({
        ...request,
        event: { ...request.event, payload: { dispatch: 'changed' } },
      }),
      /Idempotency key/i,
    );

    time += 1001;
    const takeover = await second.claimParent({
      runId: 'run-one',
      owner: 'parent-two',
      leaseMs: 1000,
    });
    assert(takeover.claimed && takeover.record.lease);
    await assert.rejects(
      first.commitParentAndDispatch({
        ...request,
        idempotencyKey: 'stale-commit',
      }),
      /owner changed/i,
    );
    const secondRequest = {
      ...dispatch(
        takeover.record.lease.token,
        takeover.record.attempt,
        'group-two',
      ),
      lease: {
        owner: 'parent-two',
        token: takeover.record.lease.token,
        fencingEpoch: takeover.record.attempt,
      },
    };
    await second.commitParentAndDispatch(secondRequest);
    assert.equal((await first.loadChild('task-two'))?.status, 'QUEUED');
  } finally {
    first.close();
    second.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a separate process claims committed dispatch from the same local database', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-nx05-process-'));
  const path = join(root, 'service.sqlite');
  const provider = await SqliteNx05ControlTestProvider.open(path);
  try {
    await provider.createParent({
      runId: 'run-one',
      revision: 'rev-one',
      actor: 'creator',
    });
    const parent = await provider.claimParent({
      runId: 'run-one',
      owner: 'parent-one',
      leaseMs: 30_000,
    });
    assert(parent.record.lease);
    await provider.commitParentAndDispatch(
      dispatch(parent.record.lease.token, parent.record.attempt),
    );
    const { stdout } = await runProcess(process.execPath, [
      '--import',
      '@swc-node/register/esm-register',
      'libs/shared-control/src/lib/fixtures/sqlite-control-worker.ts',
      path,
      'claim',
    ]);
    const claimed = JSON.parse(stdout.trim());
    assert.equal(claimed.taskId, 'task-one');
    assert.equal(claimed.lease.owner, 'separate-process');
    assert.equal(
      (await provider.loadChild('task-one'))?.lease?.token,
      claimed.lease.token,
    );
  } finally {
    provider.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('local SQLite publication requires durable artifact bytes and current child fence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-nx05-publication-'));
  const path = join(root, 'service.sqlite');
  let time = Date.parse('2026-09-29T00:00:00.000Z');
  const clock = () => new Date(time);
  const control = await SqliteNx05ControlTestProvider.open(path, clock);
  const artifacts = await SqliteImmutableArtifactProvider.open(path);
  try {
    await control.createParent({
      runId: 'run-one',
      revision: 'rev-one',
      actor: 'creator',
    });
    const parent = await control.claimParent({
      runId: 'run-one',
      owner: 'parent-one',
      leaseMs: 10_000,
    });
    assert(parent.record.lease);
    await control.commitParentAndDispatch(
      dispatch(parent.record.lease.token, parent.record.attempt),
    );
    const groupRequest = {
      groupId: 'group-one',
      runId: 'run-one',
      revision: 'rev-one',
      taskIds: ['task-one'],
      maxConcurrency: 1,
      owner: 'child-one',
      leaseMs: 1000,
    };
    await assert.rejects(
      control.claimChildGroup({ ...groupRequest, maxConcurrency: 2 }),
      /concurrency changed/i,
    );
    const first = await control.claimChildGroup(groupRequest);
    assert.equal(first.claimed.length, 1);
    assert.deepEqual(first.dispatch.tasks[0]?.assignment, assignment);
    const oldLease = first.claimed[0]!.lease!;
    const missing = {
      schema: 1 as const,
      runId: 'run-one',
      revision: 'rev-one',
      kind: 'verification' as const,
      sha256: 'a'.repeat(64),
      bytes: 8,
    };
    const publication = {
      taskId: 'task-one',
      lease: {
        owner: oldLease.owner,
        token: oldLease.token,
        fencingEpoch: oldLease.fencingEpoch,
      },
      idempotencyKey: 'publish-one',
      status: 'SUCCEEDED' as const,
      result: {
        status: 'PASS' as const,
        summary: 'Verified',
        evidencePaths: [],
        rawLogPath: null,
        evidenceReferences: [missing] as const,
      },
      error: null,
    };
    await assert.rejects(
      control.publishChild(publication),
      /Artifact reference is absent/i,
    );
    assert.equal((await control.loadChild('task-one'))?.status, 'RUNNING');
    time += 1001;
    const reclaimed = await control.claimChildGroup({
      ...groupRequest,
      owner: 'child-two',
    });
    assert.equal(reclaimed.claimed.length, 1);
    const currentLease = reclaimed.claimed[0]!.lease!;
    await assert.rejects(control.publishChild(publication), /owner changed/i);
    const reference = await artifacts.put({
      runId: 'run-one',
      revision: 'rev-one',
      kind: 'verification',
      content: 'verified bytes',
    });
    const final = {
      ...publication,
      lease: {
        owner: currentLease.owner,
        token: currentLease.token,
        fencingEpoch: currentLease.fencingEpoch,
      },
      result: {
        ...publication.result,
        evidenceReferences: [reference] as const,
      },
    };
    assert.equal((await control.publishChild(final)).status, 'SUCCEEDED');
    assert.equal((await control.publishChild(final)).status, 'SUCCEEDED');
    await assert.rejects(
      control.publishChild({
        ...final,
        result: { ...final.result, summary: 'changed' },
      }),
      /Idempotency key/i,
    );
  } finally {
    control.close();
    artifacts.close();
    await rm(root, { recursive: true, force: true });
  }
});
