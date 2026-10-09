import {
  runProcessToFiles,
  retainProcessDiagnostic,
  type CapturedProcessDiagnostic,
} from './process-capture.js';
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
  /** @deprecated Alias for finalResponseLimitBytes; raw capture is uncapped. */
  readonly outputLimitBytes?: number;
  readonly finalResponseLimitBytes?: number;
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
  readonly stdoutAvailable: boolean;
  readonly stderrAvailable: boolean;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly captureComplete: boolean;
  readonly stdoutWrittenBytes: number;
  readonly stderrWrittenBytes: number;
  readonly stdoutSha256: string;
  readonly stderrSha256: string;
  readonly captureError: string | null;
  readonly finalResponseLimitBytes: number;
  readonly diagnostics: readonly CapturedProcessDiagnostic[];
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
  if (
    options.outputLimitBytes !== undefined &&
    options.finalResponseLimitBytes !== undefined &&
    options.outputLimitBytes !== options.finalResponseLimitBytes
  )
    throw new Error('outputLimitBytes and finalResponseLimitBytes conflict.');
  const limit =
    options.finalResponseLimitBytes ??
    options.outputLimitBytes ??
    4 * 1024 * 1024;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('finalResponseLimitBytes must be a positive integer.');
  }
  await mkdir(options.evidenceDirectory, { recursive: true, mode: 0o700 });
  const schemaPath = join(options.evidenceDirectory, 'output-schema.json');
  const finalPath = join(options.evidenceDirectory, 'final.json');
  const stdoutPath = join(options.evidenceDirectory, 'stdout.jsonl');
  const stderrPath = join(options.evidenceDirectory, 'stderr.log');
  const processPath = join(options.evidenceDirectory, 'process.json');
  const startPath = join(options.evidenceDirectory, 'process-start.json');
  const adapterDiagnostics: CapturedProcessDiagnostic[] = [];
  const retainAdapterCause = async (
    category: CapturedProcessDiagnostic['category'],
    cause: unknown,
  ): Promise<void> => {
    adapterDiagnostics.push(
      await retainProcessDiagnostic(
        join(
          options.evidenceDirectory,
          `adapter-${category}-${adapterDiagnostics.length}.log`,
        ),
        category,
        cause,
      ),
    );
  };
  const failedAdapterResult = async (
    summary: string,
    category: CapturedProcessDiagnostic['category'],
    cause: unknown,
    capturedDiagnostics: readonly CapturedProcessDiagnostic[] = [],
  ): Promise<WorkerResult> => {
    await retainAdapterCause(category, cause);
    const paths: string[] = [];
    for (const path of [
      stdoutPath,
      stderrPath,
      processPath,
      schemaPath,
      finalPath,
      startPath,
      ...capturedDiagnostics.map((item) => item.path),
      ...adapterDiagnostics.map((item) => item.path),
    ]) {
      try {
        if ((await stat(path)).isFile()) paths.push(path);
      } catch {}
    }
    return {
      status: 'BLOCKED',
      summary,
      evidencePaths: paths,
      rawLogPath: paths.includes(stdoutPath) ? stdoutPath : null,
    };
  };
  try {
    await writeFile(schemaPath, `${JSON.stringify(OUTPUT_SCHEMA, null, 2)}\n`, {
      mode: 0o600,
    });
  } catch (cause) {
    return failedAdapterResult(
      'Codex output schema publication failed; available evidence retained.',
      'schema',
      cause,
    );
  }
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
  let capture: Awaited<ReturnType<typeof runProcessToFiles>>;
  try {
    capture = await runProcessToFiles({
      program: options.executable,
      args,
      cwd: options.workspaceRoot,
      env:
        sandbox === 'workspace-write' ? writeWorkerEnvironment() : process.env,
      stdin: prompt,
      stdoutPath,
      stderrPath,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      onStarted: async ({ pid, startedAt }) => {
        await writeFile(
          startPath,
          `${JSON.stringify({ schema: 1, pid, startedAt, executable: options.executable, workspaceRoot: options.workspaceRoot, assignmentId: assignment.id, sandbox })}\n`,
          { flag: 'wx', mode: 0o600 },
        );
      },
    });
  } catch (cause) {
    return failedAdapterResult(
      'Codex diagnostic capture setup failed; available evidence retained.',
      'launch',
      cause,
    );
  }
  const evidence: ProcessEvidence = {
    schema: 1,
    pid: capture.pid,
    startedAt: capture.startedAt,
    endedAt: capture.endedAt,
    exitCode: capture.code,
    signal: capture.signal,
    timedOut: capture.timedOut,
    cancelled: capture.cancelled,
    outputLimitExceeded: false,
    error: capture.error,
    stdoutAvailable: capture.stdout.available,
    stderrAvailable: capture.stderr.available,
    stdoutBytes: capture.stdout.receivedBytes,
    stderrBytes: capture.stderr.receivedBytes,
    captureComplete: capture.captureComplete,
    stdoutWrittenBytes: capture.stdout.bytes,
    stderrWrittenBytes: capture.stderr.bytes,
    stdoutSha256: capture.stdout.sha256,
    stderrSha256: capture.stderr.sha256,
    captureError: capture.stdout.error ?? capture.stderr.error,
    finalResponseLimitBytes: limit,
    diagnostics: capture.diagnostics,
  };
  try {
    await writeFile(processPath, `${JSON.stringify(evidence, null, 2)}\n`, {
      mode: 0o600,
    });
  } catch (cause) {
    return failedAdapterResult(
      'Codex process metadata publication failed; available capture retained.',
      'metadata',
      cause,
      capture.diagnostics,
    );
  }
  const { cancelled, timedOut } = capture;
  const spawnError = capture.error;
  const exit = { code: capture.code, signal: capture.signal };
  let status: WorkerResult['status'] = 'BLOCKED';
  let summary: string;
  if (cancelled)
    summary =
      capture.pid === null
        ? 'Codex worker cancelled before start.'
        : 'Codex worker cancelled by interrupt.';
  else if (!capture.captureComplete)
    summary = 'Codex diagnostic capture failed; available bytes retained.';
  else if (spawnError) summary = `Codex process failed to start: ${spawnError}`;
  else if (timedOut)
    summary = `Codex process exceeded ${options.timeoutMs} ms.`;
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
      await retainAdapterCause('final-response', error);
      summary =
        'Codex final response is invalid or exceeds its semantic byte limit.';
    }
  }
  let finalExists = false;
  try {
    finalExists = (await stat(finalPath)).isFile();
    if (finalExists) await chmod(finalPath, 0o600);
  } catch (cause) {
    let missing = false;
    try {
      missing = Boolean(
        cause &&
        typeof cause === 'object' &&
        'code' in cause &&
        cause.code === 'ENOENT',
      );
    } catch {}
    if (!missing) {
      await retainAdapterCause('final-response', cause);
      status = 'BLOCKED';
      summary =
        'Codex final response publication failed; available evidence retained.';
    }
  }
  const diagnosticPaths: string[] = [];
  for (const diagnostic of [...capture.diagnostics, ...adapterDiagnostics]) {
    try {
      if ((await stat(diagnostic.path)).isFile())
        diagnosticPaths.push(diagnostic.path);
    } catch {}
  }
  const result: WorkerResult = {
    status,
    summary,
    evidencePaths: [
      ...(capture.stdout.available ? [stdoutPath] : []),
      ...(capture.stderr.available ? [stderrPath] : []),
      processPath,
      schemaPath,
      ...diagnosticPaths,
      ...(finalExists ? [finalPath] : []),
    ],
    rawLogPath: capture.stdout.available ? stdoutPath : null,
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
