import { SqliteNx05ControlTestProvider } from '../sqlite-control-test-provider.js';

const [path, action] = process.argv.slice(2);
if (!path || !action) throw new Error('Expected database path and action.');

const provider = await SqliteNx05ControlTestProvider.open(path);
try {
  if (action === 'claim') {
    const group = await provider.claimChildGroup({
      groupId: 'group-one',
      runId: 'run-one',
      revision: 'rev-one',
      taskIds: ['task-one'],
      maxConcurrency: 1,
      owner: 'separate-process',
      leaseMs: 30_000,
    });
    process.stdout.write(`${JSON.stringify(group.claimed[0])}\n`);
  } else {
    throw new Error(`Unknown action: ${action}`);
  }
} finally {
  provider.close();
}
