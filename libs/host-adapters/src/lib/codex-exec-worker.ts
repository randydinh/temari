import {
  runProcessToFiles,
  retainProcessDiagnostic,
  type CapturedProcessDiagnostic,
} from './process-capture.js';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { constants } from 'node:fs';
import {
  access,
  chmod,
  mkdir,
  stat,
  writeFile,
  readFile,
} from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
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
  /** Explicit managed execution preserves the user's model settings. */
  readonly providerSelection?: CodexProviderSelection;
}

export interface CodexProviderSelection {
  readonly provider: 'codex';
  readonly executableSha256: string;
  readonly executableVersion: string;
  readonly model?: string;
  readonly reasoning?: string | null;
}

export function assertCodexProviderSelection(
  value: unknown,
): asserts value is CodexProviderSelection {
  const item = value as Partial<CodexProviderSelection> | null;
  if (
    !item ||
    item.provider !== 'codex' ||
    !/^[0-9a-f]{64}$/.test(item.executableSha256 ?? '') ||
    !item.executableVersion?.startsWith('codex-cli ') ||
    Object.keys(item).some(
      (key) =>
        ![
          'provider',
          'executableSha256',
          'executableVersion',
          'model',
          'reasoning',
        ].includes(key),
    ) ||
    (item.model !== undefined &&
      (typeof item.model !== 'string' || !item.model.trim())) ||
    (item.reasoning !== undefined &&
      item.reasoning !== null &&
      typeof item.reasoning !== 'string')
  )
    throw new Error('Unsupported or unpinned coding provider selection.');
}

export async function observeCodexProvider(
  executable: string,
  selection: CodexProviderSelection,
) {
  assertCodexProviderSelection(selection);
  const path = await resolveCodexExecutable(executable);
  const sha256 = createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
  const version = (
    await promisify(execFile)(path, ['--version'], {
      timeout: 10000,
      maxBuffer: 65536,
    })
  ).stdout.trim();
  if (
    sha256 !== selection.executableSha256 ||
    version !== selection.executableVersion
  )
    throw new Error('Coding provider executable identity drifted.');
  return {
    provider: 'codex' as const,
    executable: path,
    sha256,
    version,
    model: null,
    reasoning: null,
    observation:
      'CLI version and executable bytes; model/reasoning unavailable from this transport',
  };
}

export interface CodexModelAdmission {
  readonly configPath: string;
  readonly configSha256: string;
  readonly catalogPath: string;
  readonly catalogSha256: string;
  readonly parserExecutable: string;
  readonly parserSha256: string;
}

/** A pinned account catalog can refuse unsupported selections without inference.
 * It is an admission prerequisite, not evidence that a model served a request.
 * Only the simple inherited user configuration is admitted in this increment. */
export async function observeCodexModelSelection(
  selection: CodexProviderSelection,
  input: CodexModelAdmission,
  workspaceRoot: string,
) {
  assertCodexProviderSelection(selection);
  if (
    !input ||
    !isAbsolute(input.configPath) ||
    !isAbsolute(input.catalogPath) ||
    !selection.model ||
    selection.reasoning === undefined
  )
    throw new Error(
      'Managed coding requires explicit pinned model/config/catalog admission.',
    );
  const expectedConfig = resolve(
    process.env.CODEX_HOME ?? join(homedir(), '.codex'),
    'config.toml',
  );
  if (input.configPath !== expectedConfig)
    throw new Error(
      'Model configuration is not the actual inherited Codex user configuration.',
    );
  for (let root = resolve(workspaceRoot); ; root = dirname(root)) {
    const path = join(root, '.codex', 'config.toml');
    if (path !== expectedConfig) {
      try {
        await stat(path);
        throw new Error(
          'Project model configuration is not supported by this bounded adapter.',
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    if (dirname(root) === root) break;
  }
  if (!isAbsolute(input.parserExecutable))
    throw new Error('TOML parser executable must be explicitly pinned.');
  const configBytes = await readFile(input.configPath);
  const catalogBytes = await readFile(input.catalogPath);
  const sha = (bytes: Uint8Array) =>
    createHash('sha256').update(bytes).digest('hex');
  if (sha(await readFile(input.parserExecutable)) !== input.parserSha256)
    throw new Error('TOML parser executable identity drifted.');
  if (
    sha(configBytes) !== input.configSha256 ||
    sha(catalogBytes) !== input.catalogSha256
  )
    throw new Error('Model configuration/catalog identity drifted.');
  const parse = `import json,sys,tomllib
c=tomllib.load(open(sys.argv[1],'rb'))
print(json.dumps({k:c.get(k) for k in ['model','model_reasoning_effort','model_provider','profile','model_catalog_json']}))`;
  const parsed = JSON.parse(
    (
      await promisify(execFile)(
        input.parserExecutable,
        ['-c', parse, input.configPath],
        { timeout: 10000, maxBuffer: 65536 },
      )
    ).stdout,
  );
  if (
    parsed.profile ||
    parsed.model_catalog_json ||
    ![null, 'openai'].includes(parsed.model_provider)
  )
    throw new Error(
      'Unsupported model profile/provider/catalog override; explicit adapter support is required.',
    );
  if (
    parsed.model !== selection.model ||
    parsed.model_reasoning_effort !== selection.reasoning
  )
    throw new Error(
      'Requested model/reasoning differs from inherited user settings; refusing silent override.',
    );
  const catalog = JSON.parse(catalogBytes.toString());
  if (
    catalog.client_version !==
    selection.executableVersion.slice('codex-cli '.length)
  )
    throw new Error('Model catalog belongs to a different CLI version.');
  const age = Date.now() - Date.parse(catalog.fetched_at);
  if (!Number.isFinite(age) || age < -60000 || age > 24 * 60 * 60 * 1000)
    throw new Error('Account model catalog is missing or stale.');
  const model = catalog.models?.find(
    (item: { slug?: string }) => item.slug === selection.model,
  );
  if (!model)
    throw new Error(`Unsupported selected Codex CLI model: ${selection.model}`);
  if (
    selection.reasoning &&
    !model.supported_reasoning_levels?.some(
      (item: { effort?: string }) => item.effort === selection.reasoning,
    )
  )
    throw new Error('Unsupported reasoning selection for this model.');
  return {
    requested: { model: selection.model, reasoning: selection.reasoning },
    observed: { model: null, reasoning: null },
    config: { path: input.configPath, sha256: input.configSha256 },
    catalog: {
      path: input.catalogPath,
      sha256: input.catalogSha256,
      fetchedAt: catalog.fetched_at,
      clientVersion: catalog.client_version,
    },
    scope: 'pinned-inherited-selection-and-cached-account-admission-only',
  };
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
  readonly provider?: {
    readonly requested: CodexProviderSelection;
    readonly observed: Awaited<ReturnType<typeof observeCodexProvider>>;
    readonly tools: readonly string[];
  };
  readonly argv?: readonly string[];
  readonly nativeThreadId?: string | null;
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
  const provider = options.providerSelection
    ? await observeCodexProvider(options.executable, options.providerSelection)
    : null;
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
    ...(options.providerSelection ? [] : ['--ignore-user-config']),
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
  const nativeThreadIds = new Set<string>();
  let nativeIdentityError: string | null = null;
  if (provider && capture.stdout.available) {
    const lines = createInterface({ input: createReadStream(stdoutPath), crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.type === 'thread.started' && typeof event.thread_id === 'string') nativeThreadIds.add(event.thread_id);
        } catch { /* Retain non-event output in the raw log. */ }
      }
      if (nativeThreadIds.size > 1) nativeIdentityError = 'Worker transport returned conflicting native thread identities.';
    } catch (cause) {
      nativeIdentityError = 'Worker native thread identity capture failed.';
      await retainAdapterCause('metadata', cause);
    } finally { lines.close(); }
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
    error: nativeIdentityError ?? capture.error,
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
    ...(provider && options.providerSelection
      ? {
          provider: {
            requested: options.providerSelection,
            observed: provider,
            tools: [sandbox],
          },
          argv: args,
          nativeThreadId: nativeThreadIds.values().next().value ?? null,
        }
      : {}),
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
  const spawnError = nativeIdentityError ?? capture.error;
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
