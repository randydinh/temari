import { main } from './run-codex-parallel.mjs';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export { classifyWorkerParallelRequest, runWorkerParallelRequest } from './run-codex-parallel.mjs';
if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
