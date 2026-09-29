import { Nx05NetworkClient } from '../network-control.js';

const [url, mode, referenceJson] = process.argv.slice(2);
const token = process.env.NX05_SERVICE_TOKEN;
if (!url || !token || !mode) throw new Error('Worker arguments are missing.');
const client = new Nx05NetworkClient(url, token);

if (mode === 'claim') {
  const claim = await client.claimChildGroup({
    groupId: 'group-one',
    runId: 'run-one',
    revision: 'rev-one',
    taskIds: ['task-one'],
    maxConcurrency: 1,
    owner: 'remote-worker',
    leaseMs: 200,
  });
  process.stdout.write(
    JSON.stringify({ claimed: claim.claimed, dispatch: claim.dispatch }),
  );
} else if (mode === 'publish') {
  if (!referenceJson) throw new Error('Reference is missing.');
  const reference = JSON.parse(referenceJson);
  const claim = await client.claimChildGroup({
    groupId: 'group-one',
    runId: 'run-one',
    revision: 'rev-one',
    taskIds: ['task-one'],
    maxConcurrency: 1,
    owner: 'replacement-worker',
    leaseMs: 10_000,
  });
  const lease = claim.claimed[0]?.lease;
  if (!lease) throw new Error('Replacement failed to claim task.');
  const record = await client.publishChild({
    taskId: 'task-one',
    lease: {
      owner: lease.owner,
      token: lease.token,
      fencingEpoch: lease.fencingEpoch,
    },
    idempotencyKey: 'remote-publication',
    status: 'SUCCEEDED',
    result: {
      status: 'PASS',
      summary: 'Network worker verified synthetic bytes',
      evidencePaths: [],
      rawLogPath: null,
      evidenceReferences: [reference],
    },
    error: null,
  });
  process.stdout.write(
    JSON.stringify({ status: record.status, lease: record.lease }),
  );
} else {
  throw new Error('Unknown worker action.');
}
