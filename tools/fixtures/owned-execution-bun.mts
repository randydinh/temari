import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { FileChildTaskStore } from '../../libs/runtime/src/lib/child-task-store.ts';
import { ManagedExecutionControl } from '../../libs/runtime/src/lib/managed-execution.ts';
import { createOwnedExecutionAdapter } from '../../libs/host-adapters/src/lib/owned-execution.ts';
const root = process.argv[2]!;
await mkdir(root, { recursive: true });
const control = new ManagedExecutionControl({
  store: await FileChildTaskStore.create(join(root, 'children')),
  adapter: createOwnedExecutionAdapter(),
  root,
  runId: 'bun-run',
  revision: 'revision',
  binding: 'bun-fixture',
  authorityId: 'bun-control',
  processIds: ['bun-worker'],
  observeSupervisor: async () => true,
});
await control.start();
try {
  const result = await control.run('bun-worker', {
    program: process.execPath,
    args: ['-e', 'console.log("bun-worker")'],
    cwd: root,
    timeoutMs: 1000,
  });
  await control.finish();
  console.log(
    JSON.stringify({
      cleanup: result.cleanup,
      code: result.code,
      stdout: result.stdout,
    }),
  );
} finally {
  await control.drain();
}
