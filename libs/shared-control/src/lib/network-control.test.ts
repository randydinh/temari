import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type { WorkerAssignment } from '@temari/contracts';
import { nx05AssignmentSha256 } from '@temari/runtime';

import {
  Nx05NetworkClient,
  startNx05LoopbackService,
} from './network-control.js';
import { SqliteImmutableArtifactProvider } from './sqlite-artifact-provider.js';
import { SqliteNx05ControlTestProvider } from './sqlite-control-test-provider.js';

const runProcess = promisify(execFile);
const fixture = fileURLToPath(
  new URL('./fixtures/network-control-worker.ts', import.meta.url),
);
const swcRegister = import.meta.resolve('@swc-node/register/esm-register');
const assignment: WorkerAssignment = {
  id: 'worker-one',
  role: 'implementer',
  required: true,
  brief: {
    goal: 'Verify synthetic bytes',
    context: 'NX05 network recovery proof',
    scope: 'fixture.txt',
    acceptanceCriteria: ['Bytes match'],
    verificationCommand: 'node check.mjs',
    reportFormat: 'json',
    forbiddenActions: ['Do not read the service database'],
  },
};

test('network clients recover a committed task through a restarted service without database access', async () => {
  const serviceRoot = await mkdtemp(join(tmpdir(), 'temari-nx05-service-'));
  const clientRoot = await mkdtemp(join(tmpdir(), 'temari-nx05-client-'));
  const path = join(serviceRoot, 'service.sqlite');
  const token = randomBytes(32).toString('hex');
  let control = await SqliteNx05ControlTestProvider.open(path);
  let artifacts = await SqliteImmutableArtifactProvider.open(path);
  let service = await startNx05LoopbackService({ control, artifacts, token });
  try {
    let client = new Nx05NetworkClient(service.url, token);
    await assert.rejects(
      new Nx05NetworkClient(service.url, 'x'.repeat(32)).loadParent('run-one'),
      /Unauthorized/,
    );
    await client.createParent({
      runId: 'run-one',
      revision: 'rev-one',
      actor: 'creator',
    });
    const parent = await client.claimParent({
      runId: 'run-one',
      owner: 'coordinator',
      leaseMs: 30_000,
    });
    assert(parent.claimed && parent.record.lease);
    await client.commitParentAndDispatch({
      runId: 'run-one',
      lease: {
        owner: 'coordinator',
        token: parent.record.lease.token,
        fencingEpoch: parent.record.attempt,
      },
      idempotencyKey: 'dispatch-one',
      status: 'RUNNING',
      event: { type: 'run-event', payload: { dispatch: 'group-one' } },
      dispatch: [
        {
          groupId: 'group-one',
          maxConcurrency: 1,
          tasks: [
            {
              taskId: 'task-one',
              idempotencyKey: 'task-one',
              assignment,
              assignmentSha256: nx05AssignmentSha256(assignment),
              dependsOn: [],
            },
          ],
        },
      ],
    });
    const first = await runProcess(
      process.execPath,
      ['--import', swcRegister, fixture, service.url, 'claim'],
      {
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH,
          HOME: clientRoot,
          NX05_SERVICE_TOKEN: token,
        },
        timeout: 10_000,
      },
    );
    const firstClaim = JSON.parse(first.stdout) as {
      claimed: Array<{
        lease: { owner: string; token: string; fencingEpoch: number };
      }>;
      dispatch: { tasks: unknown[] };
    };
    assert.equal(firstClaim.claimed.length, 1);
    assert.equal(firstClaim.dispatch.tasks.length, 1);
    const reference = await client.put({
      runId: 'run-one',
      revision: 'rev-one',
      kind: 'verification',
      content: 'verified network bytes',
    });
    assert.equal(
      Buffer.from(await client.load(reference)).toString(),
      'verified network bytes',
    );

    await service.close();
    control.close();
    artifacts.close();
    await new Promise((resolve) => setTimeout(resolve, 250));
    control = await SqliteNx05ControlTestProvider.open(path);
    artifacts = await SqliteImmutableArtifactProvider.open(path);
    service = await startNx05LoopbackService({ control, artifacts, token });
    client = new Nx05NetworkClient(service.url, token);
    const second = await runProcess(
      process.execPath,
      [
        '--import',
        swcRegister,
        fixture,
        service.url,
        'publish',
        JSON.stringify(reference),
      ],
      {
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH,
          HOME: clientRoot,
          NX05_SERVICE_TOKEN: token,
        },
        timeout: 10_000,
      },
    );
    assert.equal(
      (JSON.parse(second.stdout) as { status: string }).status,
      'SUCCEEDED',
    );
    const staleLease = firstClaim.claimed[0]!.lease;
    await assert.rejects(
      client.publishChild({
        taskId: 'task-one',
        lease: {
          owner: staleLease.owner,
          token: staleLease.token,
          fencingEpoch: staleLease.fencingEpoch,
        },
        idempotencyKey: 'stale-publication',
        status: 'FAILED',
        result: null,
        error: 'stale',
      }),
      /Command rejected/,
    );
    assert.equal((await client.loadChild('task-one'))?.status, 'SUCCEEDED');
    assert.equal(
      Buffer.from(await client.load(reference)).toString(),
      'verified network bytes',
    );
    assert.equal((await client.loadParent('run-one'))?.status, 'RUNNING');
  } finally {
    await service.close();
    control.close();
    artifacts.close();
    await rm(serviceRoot, { recursive: true, force: true });
    await rm(clientRoot, { recursive: true, force: true });
  }
});
