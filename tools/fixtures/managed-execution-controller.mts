import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FileChildTaskStore } from '../../libs/runtime/src/lib/child-task-store.js';
import { ManagedExecutionControl } from '../../libs/runtime/src/lib/managed-execution.js';
import { createOwnedExecutionAdapter } from '../../libs/host-adapters/src/lib/owned-execution.js';
const root = process.argv[2]!;
const parent = process.ppid;
await mkdir(root, { recursive: true });
const store = await FileChildTaskStore.create(join(root, 'children'));
if (process.argv[3] === 'publish-barrier') {
  const update = store.updateExecution.bind(store);
  store.updateExecution = async (request) => {
    if (request.execution.state === 'LIVE') {
      await writeFile(join(root, 'published'), 'prepared-not-released');
      await new Promise<void>(() => {});
    }
    return update(request);
  };
}
const control = new ManagedExecutionControl({
  store,
  adapter: createOwnedExecutionAdapter(),
  root,
  runId: 'run',
  revision: 'revision',
  binding: 'crash-fixture-native-1-stage-1',
  authorityId: 'control',
  processIds: ['work'],
  observeSupervisor: async () =>
    process.argv[3] !== 'watch-parent' || process.ppid === parent,
  intervalMs: process.argv[3] === 'publish-barrier' ? 5000 : 50,
});
await control.start();
try {
  await control.run('work', {
    program: process.execPath,
    args: [
      '-e',
      "process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)",
      join(root, 'started'),
    ],
    cwd: root,
    timeoutMs: 5000,
  });
} catch {
} finally {
  await control.drain();
}
