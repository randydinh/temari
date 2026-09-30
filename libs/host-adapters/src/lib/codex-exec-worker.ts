import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access,
  chmod,
  mkdir,
  stat,
  writeFile,
  readFile,
} from 'node:fs/promises';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import {
  assertWorkerResult,
  type WorkerAssignment,
  type WorkerResult,
} from '@temari/contracts';

const GIT_ROUTING_VARIABLES = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_GRAFT_FILE',
  'GIT_SHALLOW_FILE',
  'GIT_PREFIX',
]);

function writeWorkerEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !GIT_ROUTING_VARIABLES.has(name) && !name.startsWith('GIT_CONFIG_'),
    ),
  );
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'summary'],
  properties: {
    status: { type: 'string', enum: ['PASS', 'ISSUES', 'BLOCKED', 'DROPPED'] },
    summary: { type: 'string', minLength: 1 },
  },
} as const;

export interface CodexExecWorkerOptions {
  readonly executable: string;
  readonly workspaceRoot: string;
  readonly evidenceDirectory: string;
  readonly timeoutMs: number;
  readonly outputLimitBytes?: number;
  readonly signal?: AbortSignal;
  /** For isolated synthetic read-only probes outside a Git checkout. */
  readonly skipGitRepoCheck?: boolean;
}

interface ProcessEvidence {
  readonly schema: 1;
  readonly pid: number | null;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly outputLimitExceeded: boolean;
  readonly error: string | null;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
}

export async function resolveCodexExecutable(
  executable: string,
): Promise<string> {
  if (!executable || executable.includes('\0')) {
    throw new Error('executable must be a non-empty path or command name.');
  }
  const paths =
    executable.includes('/') || executable.includes('\\')
      ? [executable]
      : (process.env.PATH ?? '')
          .split(delimiter)
          .map((entry) => join(entry || '.', executable));
  for (const candidate of paths) {
    try {
      const info = await stat(candidate);
      if (!info.isFile()) continue;
      await access(candidate, constants.X_OK);
      return resolve(candidate);
    } catch {}
  }
  throw new Error(
    `Codex executable is missing or not executable: ${executable}`,
  );
}

function readOnlyPromptFor(assignment: WorkerAssignment): string {
  const { brief } = assignment;
  return [
    'You are a read-only Temari worker. Inspect the workspace and report findings. Do not edit files, run mutating commands, or send messages.',
    `Role: ${assignment.role}`,
    `Goal: ${brief.goal}`,
    `Context: ${brief.context}`,
    `Scope: ${brief.scope}`,
    `Acceptance criteria:\n${brief.acceptanceCriteria.map((criterion) => `- ${criterion}`).join('\n')}`,
    `Verification command: ${brief.verificationCommand ?? 'none'}`,
    `Forbidden actions:\n${brief.forbiddenActions.map((action) => `- ${action}`).join('\n')}`,
    'Return only the JSON object specified by the output schema. PASS means your own investigation found no issues; the controller will verify independently.',
  ].join('\n\n');
}

function terminateProcess(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform !== 'win32') process.kill(-pid, 'SIGKILL');
    else process.kill(pid, 'SIGKILL');
  } catch {
    // It may have exited already.
  }
}

async function executeCodexExecWorker(
  assignment: WorkerAssignment,
  options: CodexExecWorkerOptions,
  sandbox: 'read-only' | 'workspace-write',
  prompt: string,
): Promise<WorkerResult> {
  if (
    !isAbsolute(options.workspaceRoot) ||
    !isAbsolute(options.evidenceDirectory)
  ) {
    throw new Error(
      'workspaceRoot and evidenceDirectory must be absolute paths.',
    );
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new Error('timeoutMs must be a positive integer.');
  }
  const limit = options.outputLimitBytes ?? 4 * 1024 * 1024;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('outputLimitBytes must be a positive integer.');
  }
  await mkdir(options.evidenceDirectory, { recursive: true, mode: 0o700 });
  const schemaPath = join(options.evidenceDirectory, 'output-schema.json');
  const finalPath = join(options.evidenceDirectory, 'final.json');
  const stdoutPath = join(options.evidenceDirectory, 'stdout.jsonl');
  const stderrPath = join(options.evidenceDirectory, 'stderr.log');
  const processPath = join(options.evidenceDirectory, 'process.json');
  await writeFile(schemaPath, `${JSON.stringify(OUTPUT_SCHEMA, null, 2)}\n`, {
    mode: 0o600,
  });
  const args = [
    'exec',
    '--ignore-user-config',
    '--ephemeral',
    '--sandbox',
    sandbox,
    ...(options.skipGitRepoCheck ? ['--skip-git-repo-check'] : []),
    '--cd',
    options.workspaceRoot,
    '--output-schema',
    schemaPath,
    '--output-last-message',
    finalPath,
    '--json',
    '-',
  ];
  const startedAt = new Date().toISOString();
  if (options.signal?.aborted) {
    const evidence: ProcessEvidence = {
      schema: 1,
      pid: null,
      startedAt,
      endedAt: new Date().toISOString(),
      exitCode: null,
      signal: null,
      timedOut: false,
      cancelled: true,
      outputLimitExceeded: false,
      error: null,
      stdoutBytes: 0,
      stderrBytes: 0,
    };
    await Promise.all([
      writeFile(stdoutPath, '', { mode: 0o600 }),
      writeFile(stderrPath, '', { mode: 0o600 }),
      writeFile(processPath, `${JSON.stringify(evidence, null, 2)}\n`, {
        mode: 0o600,
      }),
    ]);
    const result: WorkerResult = {
      status: 'BLOCKED',
      summary: 'Codex worker cancelled before start.',
      evidencePaths: [stdoutPath, stderrPath, processPath, schemaPath],
      rawLogPath: stdoutPath,
    };
    assertWorkerResult(result);
    return result;
  }
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let retainedBytes = 0;
  let timedOut = false;
  let cancelled = false;
  let outputLimitExceeded = false;
  let spawnError: string | null = null;
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const child = spawn(options.executable, args, {
    cwd: options.workspaceRoot,
    shell: false,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: sandbox === 'workspace-write' ? writeWorkerEnvironment() : process.env,
  });
  const pid = child.pid ?? null;
  const onAbort = (): void => {
    cancelled = true;
    terminateProcess(pid ?? undefined);
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const timeout = setTimeout(() => {
    timedOut = true;
    terminateProcess(pid ?? undefined);
  }, options.timeoutMs);
  const collect = (chunk: Buffer, stream: 'stdout' | 'stderr'): void => {
    const length = chunk.length;
    if (stream === 'stdout') stdoutBytes += length;
    else stderrBytes += length;
    if (retainedBytes < limit) {
      const slice = chunk.subarray(0, Math.min(length, limit - retainedBytes));
      retainedBytes += slice.length;
      if (stream === 'stdout') stdoutChunks.push(slice);
      else stderrChunks.push(slice);
    }
    if (stdoutBytes + stderrBytes > limit && !outputLimitExceeded) {
      outputLimitExceeded = true;
      terminateProcess(pid ?? undefined);
    }
  };
  child.stdout.on('data', (chunk: Buffer) => collect(chunk, 'stdout'));
  child.stderr.on('data', (chunk: Buffer) => collect(chunk, 'stderr'));
  child.on('error', (error) => {
    spawnError = error.message;
  });
  child.stdin.on('error', () => {
    /* Process may exit before consuming input. */
  });
  child.stdin.end(prompt);
  const exit = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timeout);
  options.signal?.removeEventListener('abort', onAbort);
  const evidence: ProcessEvidence = {
    schema: 1,
    pid,
    startedAt,
    endedAt: new Date().toISOString(),
    exitCode: exit.code,
    signal: exit.signal,
    timedOut,
    cancelled,
    outputLimitExceeded,
    error: spawnError,
    stdoutBytes,
    stderrBytes,
  };
  await Promise.all([
    writeFile(stdoutPath, Buffer.concat(stdoutChunks), { mode: 0o600 }),
    writeFile(stderrPath, Buffer.concat(stderrChunks), { mode: 0o600 }),
    writeFile(processPath, `${JSON.stringify(evidence, null, 2)}\n`, {
      mode: 0o600,
    }),
  ]);

  let status: WorkerResult['status'] = 'BLOCKED';
  let summary: string;
  if (cancelled) summary = 'Codex worker cancelled by interrupt.';
  else if (spawnError) summary = `Codex process failed to start: ${spawnError}`;
  else if (timedOut)
    summary = `Codex process exceeded ${options.timeoutMs} ms.`;
  else if (outputLimitExceeded)
    summary = `Codex process exceeded ${limit} output bytes.`;
  else if (exit.code !== 0)
    summary = `Codex process exited with code ${exit.code}, signal ${exit.signal ?? 'none'}.`;
  else {
    try {
      const finalInfo = await stat(finalPath);
      if (!finalInfo.isFile()) throw new Error('final response is not a file');
      if (finalInfo.size > limit)
        throw new Error(`final response exceeds ${limit} bytes`);
      const parsed: unknown = JSON.parse(await readFile(finalPath, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('final response is not an object');
      }
      const value = parsed as Record<string, unknown>;
      if (
        Object.keys(value).sort().join(',') !== 'status,summary' ||
        !['PASS', 'ISSUES', 'BLOCKED', 'DROPPED'].includes(
          String(value.status),
        ) ||
        typeof value.summary !== 'string' ||
        !value.summary.trim()
      ) {
        throw new Error('final response does not match the output schema');
      }
      status = value.status as WorkerResult['status'];
      summary = value.summary;
    } catch (error) {
      summary = `Codex final response is invalid: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  let finalExists = false;
  try {
    finalExists = (await stat(finalPath)).isFile();
    if (finalExists) await chmod(finalPath, 0o600);
  } catch {}
  const result: WorkerResult = {
    status,
    summary,
    evidencePaths: [
      stdoutPath,
      stderrPath,
      processPath,
      schemaPath,
      ...(finalExists ? [finalPath] : []),
    ],
    rawLogPath: stdoutPath,
  };
  assertWorkerResult(result);
  return result;
}

export interface CodexWriteOwnedPath {
  readonly kind: 'file' | 'directory';
  readonly path: string;
}

export interface CodexExecWriteWorkerOptions extends CodexExecWorkerOptions {
  readonly baseCommit: string;
  readonly owns: readonly CodexWriteOwnedPath[];
}

export function runCodexExecWorker(
  assignment: WorkerAssignment,
  options: CodexExecWorkerOptions,
): Promise<WorkerResult> {
  return executeCodexExecWorker(
    assignment,
    options,
    'read-only',
    readOnlyPromptFor(assignment),
  );
}

export function runCodexExecWriteWorker(
  assignment: WorkerAssignment,
  options: CodexExecWriteWorkerOptions,
): Promise<WorkerResult> {
  const { brief } = assignment;
  const ownership = options.owns
    .map((entry) => `${entry.kind}: ${entry.path}`)
    .join('\n');
  const prompt = [
    'You are a Temari implementer working in an isolated Git clone. Edit only your owned paths. Do not commit, switch branches, modify Git metadata, or send messages.',
    `Pinned base commit: ${options.baseCommit}`,
    `Owned paths:\n${ownership}`,
    `Goal: ${brief.goal}`,
    `Context: ${brief.context}`,
    `Scope: ${brief.scope}`,
    `Acceptance criteria:\n${brief.acceptanceCriteria.map((item) => `- ${item}`).join('\n')}`,
    `Forbidden actions:\n${brief.forbiddenActions.map((item) => `- ${item}`).join('\n')}`,
    'Return only JSON matching the output schema. The controller will validate your Git changes and verify the integrated result before accepting them.',
  ].join('\n\n');
  return executeCodexExecWorker(assignment, options, 'workspace-write', prompt);
}
