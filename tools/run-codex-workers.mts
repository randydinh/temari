import { constants } from 'node:fs';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  reconcilePlan,
  type HostCapabilityReport,
  type WorkerAssignment,
} from '../libs/contracts/src/index.js';
import {
  resolveCodexExecutable,
  runCodexExecWorker,
} from '../libs/host-adapters/src/index.js';
import {
  preflightParallelWorkers,
  runParallelWorkers,
} from '../libs/workflow-engine/src/index.js';

export interface CodexWorkersRequest {
  readonly runId: string;
  readonly revision: string;
  readonly workspaceRoot: string;
  readonly evidenceRoot: string;
  readonly assignments: readonly WorkerAssignment[];
  readonly maxConcurrency: number;
  readonly executable: string;
  readonly timeoutMs: number;
  readonly outputLimitBytes?: number;
  readonly finalResponseLimitBytes?: number;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Request must be a JSON object.');
  }
  return value as Record<string, unknown>;
}

function identifier(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
  ) {
    throw new Error(`${field} must be a safe non-empty identifier.`);
  }
  return value;
}

function positiveInteger(value: unknown, field: string, max: number): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > max
  ) {
    throw new Error(`${field} must be an integer from 1 to ${max}.`);
  }
  return value as number;
}

function absolutePath(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
    throw new Error(`${field} must be an absolute path.`);
  }
  return value;
}

function parseAssignment(value: unknown): WorkerAssignment {
  const assignment = record(value);
  const brief = record(assignment.brief);
  if (
    typeof assignment.id !== 'string' ||
    typeof assignment.role !== 'string' ||
    typeof assignment.required !== 'boolean' ||
    !['investigator', 'reviewer'].includes(assignment.role)
  ) {
    throw new Error(
      'Each assignment needs an id, required boolean, and investigator or reviewer role.',
    );
  }
  if (
    typeof brief.goal !== 'string' ||
    typeof brief.context !== 'string' ||
    typeof brief.scope !== 'string' ||
    !Array.isArray(brief.acceptanceCriteria) ||
    !brief.acceptanceCriteria.every((item) => typeof item === 'string') ||
    !(
      brief.verificationCommand === null ||
      typeof brief.verificationCommand === 'string'
    ) ||
    brief.reportFormat !== 'json' ||
    !Array.isArray(brief.forbiddenActions) ||
    !brief.forbiddenActions.every((item) => typeof item === 'string')
  ) {
    throw new Error(
      'Each read-only assignment must have a complete JSON report brief.',
    );
  }
  return value as WorkerAssignment;
}

export function parseCodexWorkersRequest(value: unknown): CodexWorkersRequest {
  const input = record(value);
  const runId = identifier(input.runId, 'runId');
  const revision = identifier(input.revision, 'revision');
  const workspaceRoot = absolutePath(input.workspaceRoot, 'workspaceRoot');
  const evidenceRoot = absolutePath(input.evidenceRoot, 'evidenceRoot');
  const maxConcurrency = positiveInteger(
    input.maxConcurrency,
    'maxConcurrency',
    16,
  );
  const timeoutMs = positiveInteger(
    input.timeoutMs,
    'timeoutMs',
    30 * 60 * 1000,
  );
  const outputLimitBytes =
    input.outputLimitBytes === undefined
      ? undefined
      : positiveInteger(
          input.outputLimitBytes,
          'outputLimitBytes',
          16 * 1024 * 1024,
        );
  const finalResponseLimitBytes =
    input.finalResponseLimitBytes === undefined
      ? undefined
      : positiveInteger(
          input.finalResponseLimitBytes,
          'finalResponseLimitBytes',
          16 * 1024 * 1024,
        );
  if (
    outputLimitBytes !== undefined &&
    finalResponseLimitBytes !== undefined &&
    outputLimitBytes !== finalResponseLimitBytes
  )
    throw new Error('outputLimitBytes and finalResponseLimitBytes conflict.');
  if (
    typeof input.executable !== 'string' ||
    !input.executable.trim() ||
    input.executable.includes('\0')
  ) {
    throw new Error('executable must be a non-empty command name or path.');
  }
  if (!Array.isArray(input.assignments))
    throw new Error('assignments must be an array.');
  const assignments = input.assignments.map(parseAssignment);
  preflightParallelWorkers(assignments);
  return {
    runId,
    revision,
    workspaceRoot,
    evidenceRoot,
    assignments,
    maxConcurrency,
    executable: input.executable,
    timeoutMs,
    outputLimitBytes,
    ...(finalResponseLimitBytes === undefined
      ? {}
      : { finalResponseLimitBytes }),
  };
}

export async function runCodexWorkersRequest(
  value: unknown,
  signal?: AbortSignal,
): Promise<{ receiptPath: string; status: string }> {
  const request = parseCodexWorkersRequest(value);
  const workspace = await stat(request.workspaceRoot);
  if (!workspace.isDirectory())
    throw new Error('workspaceRoot must be a directory.');
  await access(request.workspaceRoot, constants.R_OK | constants.X_OK);
  const executable = await resolveCodexExecutable(request.executable);
  const plan = reconcilePlan({
    workType: 'investigation',
    parallelism: { maxConcurrency: request.maxConcurrency },
  });
  const capabilities: HostCapabilityReport = {
    host: 'codex-exec-local',
    available: ['parallelism'],
    missing: [
      'subagents',
      'model_diversity',
      'worktree_isolation',
      'durable_delivery',
      'forge',
    ],
    notes: {
      parallelism:
        'Independent local codex exec processes launched by this request.',
    },
    provenance: {
      parallelism: {
        status: 'unproven',
        source:
          'local process transport declaration; real Codex overlap is not yet verified',
      },
    },
  };
  await mkdir(join(request.evidenceRoot, request.runId), {
    recursive: true,
    mode: 0o700,
  });
  const runDirectory = join(
    request.evidenceRoot,
    request.runId,
    request.revision,
  );
  await mkdir(runDirectory, { mode: 0o700 });
  const receipt = await runParallelWorkers({
    runId: request.runId,
    revision: request.revision,
    plan,
    capabilities,
    assignments: request.assignments,
    handler: (assignment) =>
      runCodexExecWorker(assignment, {
        executable,
        workspaceRoot: request.workspaceRoot,
        evidenceDirectory: join(runDirectory, assignment.id),
        timeoutMs: request.timeoutMs,
        outputLimitBytes: request.outputLimitBytes,
        finalResponseLimitBytes: request.finalResponseLimitBytes,
        signal,
      }),
  });
  const finished =
    signal?.aborted && receipt.status === 'PASS'
      ? {
          ...receipt,
          status: 'BLOCKED' as const,
          failure: {
            kind: 'worker-error' as const,
            message: 'Runner interrupted.',
            workerId: null,
            missingCapabilities: [],
          },
        }
      : receipt;
  const receiptPath = join(runDirectory, 'receipt.json');
  await writeFile(receiptPath, `${JSON.stringify(finished, null, 2)}\n`, {
    mode: 0o600,
  });
  return { receiptPath, status: finished.status };
}

async function main(): Promise<void> {
  if (process.argv.length !== 3) {
    throw new Error(
      'Usage: node --import @swc-node/register/esm-register tools/run-codex-workers.mts <request.json>',
    );
  }
  const requestPath = process.argv[2]!;
  const value: unknown = JSON.parse(await readFile(requestPath, 'utf8'));
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
    const result = await runCodexWorkersRequest(value, controller.signal);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (interrupted === 'SIGINT') process.exitCode = 130;
    else if (interrupted === 'SIGTERM') process.exitCode = 143;
    else if (result.status !== 'PASS') process.exitCode = 1;
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  }
}

if (
  process.argv[1] &&
  basename(process.argv[1]) === 'run-codex-workers.mts' &&
  fileURLToPath(import.meta.url) === process.argv[1]
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
