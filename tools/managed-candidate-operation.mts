import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { withOwnedProcessGroup } from '../libs/host-adapters/src/lib/owned-execution.js';
import { runCodexWorkersRequest } from './run-codex-workers.mts';
import { runCodexWriteWorkersRequest } from './run-codex-write-workers.mts';
const [path, output] = process.argv.slice(2);
assert(path && output);
const operation = JSON.parse(await readFile(path, 'utf8'));
const controller = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.once(signal, () => controller.abort(signal));
const result = await withOwnedProcessGroup(() =>
  operation.stage === 'build'
    ? runCodexWriteWorkersRequest(operation.request, controller.signal)
    : runCodexWorkersRequest(operation.request, controller.signal),
);
await writeFile(output, JSON.stringify(result) + '\n', {
  flag: 'wx',
  mode: 0o600,
});
