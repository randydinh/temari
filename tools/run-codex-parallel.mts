import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  parseCodexWorkersRequest,
  runCodexWorkersRequest,
} from './run-codex-workers.mjs';
import {
  parseWriteRunRequest,
  runCodexWriteWorkersRequest,
} from './run-codex-write-workers.mjs';

export type CodexParallelRoute = 'read-only' | 'write';
export type CodexParallelResult =
  | { route: 'read-only'; status: string; receiptPath: string }
  | {
      route: 'write';
      status: string;
      receiptPath: string;
      integrationPath: string;
      integratedCommit: string | null;
    };

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Choose the runner from assignment shape; caller mode labels are unsupported. */
export function classifyCodexParallelRequest(
  value: unknown,
): CodexParallelRoute {
  const request = object(value);
  if (request && 'mode' in request)
    throw new Error('mode is unsupported; the route derives from assignments.');
  if (
    !request ||
    !Array.isArray(request.assignments) ||
    !request.assignments.length
  )
    throw new Error(
      'A nonempty assignments array is required to select a Codex route.',
    );

  const kinds = request.assignments.map((raw) => {
    const entry = object(raw);
    if (!entry) return 'unknown';
    if ('worker' in entry || 'owns' in entry) {
      const worker = object(entry.worker);
      return worker?.role === 'implementer' && Array.isArray(entry.owns)
        ? 'write'
        : 'unknown';
    }
    return entry.role === 'investigator' || entry.role === 'reviewer'
      ? 'read-only'
      : 'unknown';
  });
  if (kinds.includes('unknown') || new Set(kinds).size !== 1)
    throw new Error('Mixed or ambiguous Codex assignments cannot be routed.');

  const route = kinds[0] as CodexParallelRoute;
  const readFields = ['workspaceRoot', 'revision'];
  const writeFields = ['sourceRepo', 'baseCommit', 'verify', 'prepare'];
  if (
    (route === 'read-only' && writeFields.some((field) => field in request)) ||
    (route === 'write' && readFields.some((field) => field in request))
  )
    throw new Error(
      'Mixed read-only and write request fields cannot be routed.',
    );

  // The existing runner owns full request validation. Do it before any launch.
  if (route === 'read-only') parseCodexWorkersRequest(value);
  else parseWriteRunRequest(value);
  return route;
}

export async function runCodexParallelRequest(
  value: unknown,
  signal?: AbortSignal,
): Promise<CodexParallelResult> {
  const route = classifyCodexParallelRequest(value);
  if (route === 'read-only') {
    const result = await runCodexWorkersRequest(value, signal);
    return { route, ...result };
  }
  const result = await runCodexWriteWorkersRequest(value, signal);
  return { route, ...result };
}

async function main(): Promise<void> {
  if (process.argv.length !== 3)
    throw new Error(
      'Usage: node --import @swc-node/register/esm-register tools/run-codex-parallel.mts <request.json>',
    );
  const value: unknown = JSON.parse(await readFile(process.argv[2]!, 'utf8'));
  const controller = new AbortController();
  let interrupted: 'SIGINT' | 'SIGTERM' | null = null;
  const onInterrupt = (name: 'SIGINT' | 'SIGTERM'): void => {
    if (interrupted) return;
    interrupted = name;
    controller.abort(name);
  };
  const onSigint = (): void => onInterrupt('SIGINT');
  const onSigterm = (): void => onInterrupt('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  try {
    const result = await runCodexParallelRequest(value, controller.signal);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (interrupted === 'SIGINT') process.exitCode = 130;
    else if (interrupted === 'SIGTERM') process.exitCode = 143;
    else if (result.status !== 'PASS') process.exitCode = 1;
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
