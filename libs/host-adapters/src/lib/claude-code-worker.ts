import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import {
  assertWorkerResult,
  workerEfficiencyPolicy,
  type WorkerAssignment,
  type WorkerResult,
} from '@temari/contracts';
import { resolveCodexExecutable } from './codex-exec-worker.js';
import {
  runProcessToFiles,
  retainProcessDiagnostic,
} from './process-capture.js';
import {
  createScopedWorkerToolConfig,
  SCOPED_WORKER_POLICY,
  SCOPED_WORKER_TOOL_NAMES,
} from './scoped-worker-tools.js';
import {
  assertWorkerToolServerPin,
  observeWorkerToolServer,
  type WorkerExecutionOptions,
} from './worker-execution.js';

export interface ClaudeCodeProviderSelection {
  readonly provider: 'claude-code';
  readonly executableSha256: string;
  readonly executableVersion: string;
  readonly model: string;
  readonly policy: typeof SCOPED_WORKER_POLICY;
  readonly maxTurns?: number;
  readonly maxBudgetUsd?: number;
}
export function assertClaudeCodeProviderSelection(
  value: unknown,
): asserts value is ClaudeCodeProviderSelection {
  assert(
    value && typeof value === 'object' && !Array.isArray(value),
    'Select a pinned Claude Code provider.',
  );
  const item = value as Record<string, unknown>;
  assert(
    Object.keys(item).every((key) =>
      [
        'provider',
        'executableSha256',
        'executableVersion',
        'model',
        'policy',
        'maxTurns',
        'maxBudgetUsd',
      ].includes(key),
    ),
  );
  assert(
    item.provider === 'claude-code' && item.policy === SCOPED_WORKER_POLICY,
    'Unsupported Claude worker tool policy.',
  );
  assert(
    typeof item.executableSha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(item.executableSha256),
  );
  assert(typeof item.executableVersion === 'string');
  const version = /^(\d+)\.(\d+)\.(\d+) \(Claude Code\)$/.exec(
    item.executableVersion,
  );
  assert(
    version &&
      (Number(version[1]) > 2 ||
        (Number(version[1]) === 2 &&
          (Number(version[2]) > 1 ||
            (Number(version[2]) === 1 && Number(version[3]) >= 286)))),
    'Claude worker requires bare-mode admission at version 2.1.286 or later.',
  );
  assert(
    typeof item.model === 'string' &&
      /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(item.model),
  );
  if (item.maxTurns !== undefined)
    assert(
      Number.isSafeInteger(item.maxTurns) &&
        Number(item.maxTurns) >= 1 &&
        Number(item.maxTurns) <= 128,
    );
  if (item.maxBudgetUsd !== undefined)
    assert(
      typeof item.maxBudgetUsd === 'number' &&
        Number.isFinite(item.maxBudgetUsd) &&
        item.maxBudgetUsd > 0 &&
        item.maxBudgetUsd <= 1000,
    );
}
const digest = (bytes: Uint8Array | string) =>
  createHash('sha256').update(bytes).digest('hex');
export async function observeClaudeCodeProvider(
  executable: string,
  selection: ClaudeCodeProviderSelection,
) {
  assertClaudeCodeProviderSelection(selection);
  const path = await resolveCodexExecutable(executable),
    sha256 = digest(await readFile(path));
  assert.equal(
    sha256,
    selection.executableSha256,
    'Worker provider executable identity drifted.',
  );
  const version = (
    await promisify(execFile)(path, ['--version'], {
      timeout: 10000,
      maxBuffer: 65536,
      env: environment(),
    })
  ).stdout.trim();
  assert.equal(
    version,
    selection.executableVersion,
    'Worker provider version identity drifted.',
  );
  return {
    provider: 'claude-code' as const,
    executable: path,
    sha256,
    version,
    model: null,
    reasoning: null,
    observation:
      'CLI executable bytes/version and explicit model request; provider endpoint and model service remain host configured',
  };
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
function environment(home?: string): NodeJS.ProcessEnv {
  const allowed = new Set([
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LC_ALL',
    'SYSTEMROOT',
    'SystemRoot',
    'COMSPEC',
    'PATHEXT',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'NODE_EXTRA_CA_CERTS',
    'SSL_CERT_FILE',
  ]);
  const selected = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => allowed.has(key)),
  );
  return {
    ...selected,
    ...(home ? { CLAUDE_CONFIG_DIR: home } : {}),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_SIMPLE: '1',
  };
}
export async function runClaudeCodeWorker(
  assignment: WorkerAssignment,
  options: WorkerExecutionOptions & {
    providerSelection: ClaudeCodeProviderSelection;
  },
): Promise<WorkerResult> {
  assert(
    isAbsolute(options.workspaceRoot) && isAbsolute(options.evidenceDirectory),
  );
  assert(Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0);
  assert(
    options.outputLimitBytes === undefined ||
      options.finalResponseLimitBytes === undefined ||
      options.outputLimitBytes === options.finalResponseLimitBytes,
    'Final response byte limits conflict.',
  );
  const limit =
    options.finalResponseLimitBytes ??
    options.outputLimitBytes ??
    4 * 1024 * 1024;
  assert(Number.isSafeInteger(limit) && limit > 0 && limit <= 16 * 1024 * 1024);
  const provider = await observeClaudeCodeProvider(
    options.executable,
    options.providerSelection,
  );
  assertWorkerToolServerPin(options.scopedToolServer);
  const server = options.scopedToolServer;
  const observedTools = await observeWorkerToolServer(server);
  const node = observedTools.nodeExecutable,
    nodeSha256 = observedTools.nodeSha256;
  assert.equal(await realpath(options.workspaceRoot), options.workspaceRoot);
  if (options.access === 'workspace-write')
    assert(
      options.baseCommit &&
        /^[a-f0-9]{40,64}$/.test(options.baseCommit) &&
        options.owns?.length,
      'Write workers require a pinned base and typed ownership.',
    );
  const toolAuditPath = join(options.evidenceDirectory, 'tool-calls.jsonl');
  const tools = await createScopedWorkerToolConfig(
    options.workspaceRoot,
    options.access,
    options.access === 'workspace-write' ? options.owns : [],
    toolAuditPath,
  );
  await mkdir(options.evidenceDirectory, { recursive: true, mode: 0o700 });
  await writeFile(toolAuditPath, '', { flag: 'wx', mode: 0o600 });
  const home = join(options.evidenceDirectory, 'claude-home');
  await mkdir(home, { mode: 0o700 });
  const toolConfigPath = join(options.evidenceDirectory, 'tool-policy.json'),
    toolConfigBytes = JSON.stringify(tools) + '\n',
    toolConfigSha256 = digest(toolConfigBytes);
  await writeFile(toolConfigPath, toolConfigBytes, { flag: 'wx', mode: 0o600 });
  const toolNames = [
    ...SCOPED_WORKER_TOOL_NAMES,
    ...(options.access === 'workspace-write' ? ['write_file'] : []),
  ].map((name) => 'mcp__temari_worker__' + name);
  const mcpConfig = {
    mcpServers: {
      temari_worker: {
        type: 'stdio',
        command: node,
        args: [server.path, '--config', toolConfigPath, toolConfigSha256],
        env: {},
      },
    },
  };
  const mcpConfigPath = join(options.evidenceDirectory, 'mcp-config.json'),
    mcpBytes = JSON.stringify(mcpConfig) + '\n';
  await writeFile(mcpConfigPath, mcpBytes, { flag: 'wx', mode: 0o600 });
  const schemaPath = join(options.evidenceDirectory, 'output-schema.json');
  await writeFile(schemaPath, JSON.stringify(OUTPUT_SCHEMA) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  const args = [
    '--bare',
    '--print',
    '--input-format',
    'text',
    '--output-format',
    'json',
    '--model',
    options.providerSelection.model,
    '--tools',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    mcpConfigPath,
    '--permission-mode',
    'dontAsk',
    '--allowedTools',
    toolNames.join(','),
    '--setting-sources',
    '',
    '--settings',
    '{}',
    '--max-turns',
    String(options.providerSelection.maxTurns ?? 32),
    '--max-budget-usd',
    String(options.providerSelection.maxBudgetUsd ?? 5),
    '--json-schema',
    JSON.stringify(OUTPUT_SCHEMA),
    '--no-session-persistence',
  ];
  const prompt = [
    'You are a scoped Temari worker. Use only the admitted MCP tools. No shell, execution, network, plugins, subagents, metadata edits, commits, or publication.',
    workerEfficiencyPolicy.instructions,
    `Role: ${assignment.role}`,
    JSON.stringify(assignment.brief),
    `Access: ${options.access}; pinned base: ${options.baseCommit ?? 'read-only'}; typed ownership: ${JSON.stringify(options.owns ?? [])}`,
    'Use read_file hashes before write_file. Return only the requested status/summary JSON. PASS describes your work; the runtime verifies independently.',
  ].join('\n\n');
  const stdoutPath = join(options.evidenceDirectory, 'stdout.json'),
    stderrPath = join(options.evidenceDirectory, 'stderr.log'),
    processPath = join(options.evidenceDirectory, 'process.json'),
    finalPath = join(options.evidenceDirectory, 'final.json'),
    startPath = join(options.evidenceDirectory, 'process-start.json');
  const capture = await runProcessToFiles({
    program: provider.executable,
    args,
    cwd: options.workspaceRoot,
    env: environment(home),
    stdin: prompt,
    stdoutPath,
    stderrPath,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    onStarted: async ({ pid, startedAt }) => {
      await writeFile(
        startPath,
        JSON.stringify({
          schema: 1,
          pid,
          startedAt,
          executable: provider.executable,
          workspaceRoot: options.workspaceRoot,
          assignmentId: assignment.id,
          access: options.access,
        }) + '\n',
        { flag: 'wx', mode: 0o600 },
      );
    },
  });
  let status: WorkerResult['status'] = 'BLOCKED',
    summary =
      'Claude Code worker did not produce a verified structured result.',
    nativeSessionId: string | null = null;
  const diagnostics = [...capture.diagnostics];
  let finalExists = false;
  if (capture.cancelled) summary = 'Claude Code worker cancelled.';
  else if (capture.timedOut)
    summary = `Claude Code worker exceeded ${options.timeoutMs} ms.`;
  else if (capture.error || !capture.captureComplete || capture.code !== 0)
    summary =
      'Claude Code process or capture failed; available evidence retained.';
  else
    try {
      assert(
        (await stat(stdoutPath)).size <= limit,
        'Structured result exceeds its byte limit.',
      );
      const envelope = JSON.parse(await readFile(stdoutPath, 'utf8')) as Record<
        string,
        unknown
      >;
      assert(
        envelope.type === 'result' &&
          envelope.subtype === 'success' &&
          envelope.is_error === false,
        'Claude Code returned an unsuccessful native result.',
      );
      assert(
        typeof envelope.session_id === 'string' &&
          /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
            envelope.session_id,
          ),
      );
      nativeSessionId = envelope.session_id;
      const final = envelope.structured_output as Record<string, unknown>;
      assert(final && typeof final === 'object' && !Array.isArray(final));
      assert.deepEqual(Object.keys(final).sort(), ['status', 'summary']);
      assert(
        ['PASS', 'ISSUES', 'BLOCKED', 'DROPPED'].includes(
          String(final.status),
        ) &&
          typeof final.summary === 'string' &&
          final.summary.trim(),
      );
      await writeFile(finalPath, JSON.stringify(final) + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
      finalExists = true;
      status = final.status as WorkerResult['status'];
      summary = final.summary as string;
    } catch (error) {
      status = 'BLOCKED';
      summary =
        'Claude Code structured result could not be validated and retained.';
      diagnostics.push(
        await retainProcessDiagnostic(
          join(options.evidenceDirectory, 'adapter-final-response.log'),
          'final-response',
          error,
        ),
      );
    }
  const metadata = {
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
    diagnostics,
    provider: {
      requested: options.providerSelection,
      observed: provider,
      tools: toolNames,
    },
    workerProvider: 'claude-code',
    argv: args,
    nativeSessionId,
    toolPolicy: {
      policy: SCOPED_WORKER_POLICY,
      configPath: toolConfigPath,
      configSha256: toolConfigSha256,
      mcpConfigPath,
      mcpConfigSha256: digest(mcpBytes),
      serverPath: server.path,
      serverSha256: server.sha256,
      nodeExecutable: node,
      nodeSha256,
    },
  };
  await writeFile(processPath, JSON.stringify(metadata, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  const result = {
    status,
    summary,
    evidencePaths: [
      ...(capture.stdout.available ? [stdoutPath] : []),
      ...(capture.stderr.available ? [stderrPath] : []),
      processPath,
      schemaPath,
      toolConfigPath,
      mcpConfigPath,
      toolAuditPath,
      ...diagnostics.map((item) => item.path),
      ...(finalExists ? [finalPath] : []),
      ...(capture.pid !== null ? [startPath] : []),
    ],
    rawLogPath: capture.stdout.available ? stdoutPath : null,
  };
  assertWorkerResult(result);
  return result;
}
