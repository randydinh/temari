import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

import {
  HOST_CAPABILITIES,
  type HostCapability,
  type WorkerAssignment,
} from '@temari/contracts';

import {
  resolveCodexExecutable,
  runCodexExecWorker,
} from './codex-exec-worker.js';

export type LiveDoctorHost = 'codex' | 'claude-code' | 'cursor';

export interface LiveHostDoctorOptions {
  readonly host: LiveDoctorHost;
  readonly dataDirectory: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Test seam. The public CLI always resolves the selected host command. */
  readonly executable?: string;
}

export interface LiveHostDoctorReport {
  readonly schema: 1;
  readonly scope: 'installation-preflight-only';
  readonly host: LiveDoctorHost;
  readonly status: 'OBSERVED' | 'BLOCKED';
  readonly observedCapabilities: readonly HostCapability[];
  readonly unprovenCapabilities: readonly HostCapability[];
  readonly checkedAt: string;
  readonly executable: string | null;
  readonly executableVersion: string | null;
  readonly executableSha256: string | null;
  readonly processEvidencePath: string | null;
  readonly processEvidenceSha256: string | null;
  readonly runDirectory: string;
  readonly reason: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 128 * 1024;
const execFileAsync = promisify(execFile);
const CLAUDE_SCHEMA = JSON.stringify({
  type: 'object',
  properties: { token: { type: 'string' } },
  required: ['token'],
  additionalProperties: false,
});

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function digestFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function identifyHost(
  host: 'codex' | 'claude-code',
  executable: string,
): Promise<string> {
  const { stdout } = await execFileAsync(executable, ['--version'], {
    timeout: 5000,
    maxBuffer: 8192,
  });
  const version = stdout.trim();
  const valid =
    host === 'codex'
      ? /^codex-cli [0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(
          version,
        )
      : /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)? \(Claude Code\)$/.test(
          version,
        );
  if (!valid)
    throw new Error(
      'Selected executable did not identify as the requested host.',
    );
  return version;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function processPassed(value: unknown): boolean {
  return (
    record(value) &&
    value.schema === 1 &&
    Number.isSafeInteger(value.pid) &&
    Number(value.pid) > 0 &&
    value.exitCode === 0 &&
    value.signal === null &&
    value.timedOut === false &&
    value.cancelled === false &&
    value.outputLimitExceeded === false &&
    value.error === null
  );
}

function assignment(): WorkerAssignment {
  return {
    id: 'doctor-read',
    role: 'investigator',
    required: true,
    brief: {
      goal: 'Read challenge.txt in the current directory and return only its token as the JSON summary.',
      context: 'This is an isolated Temari host capability probe.',
      scope: 'challenge.txt only',
      acceptanceCriteria: ['The summary equals the token in challenge.txt.'],
      verificationCommand: null,
      reportFormat: 'json',
      forbiddenActions: ['Do not edit files or use network tools.'],
    },
  };
}

async function codexProbe(
  executable: string,
  workspace: string,
  evidence: string,
  token: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ observed: boolean; reason: string; processPath: string }> {
  const result = await runCodexExecWorker(assignment(), {
    executable,
    workspaceRoot: workspace,
    evidenceDirectory: evidence,
    timeoutMs,
    outputLimitBytes: MAX_OUTPUT_BYTES,
    skipGitRepoCheck: true,
    ...(signal ? { signal } : {}),
  });
  const processPath = join(evidence, 'process.json');
  const processEvidence: unknown = JSON.parse(
    await readFile(processPath, 'utf8'),
  );
  const observed =
    processPassed(processEvidence) &&
    result.status === 'PASS' &&
    result.summary.trim() === token;
  return {
    observed,
    reason: observed
      ? 'Independent read-only Codex process returned the private challenge token.'
      : 'Codex did not return a verified read-only challenge result.',
    processPath,
  };
}

async function claudeProbe(
  executable: string,
  workspace: string,
  evidence: string,
  token: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ observed: boolean; reason: string; processPath: string }> {
  const startedAt = new Date().toISOString();
  const args = [
    '--print',
    '--safe-mode',
    '--no-session-persistence',
    '--permission-mode',
    'plan',
    '--tools',
    'Read',
    '--output-format',
    'json',
    '--json-schema',
    CLAUDE_SCHEMA,
    'Read challenge.txt in the current directory. Return its token in the token field. Do not edit files or use network tools.',
  ];
  const child = spawn(executable, args, {
    cwd: workspace,
    shell: false,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let bytes = 0;
  let timedOut = false;
  let cancelled = false;
  let outputLimitExceeded = false;
  let error: string | null = null;
  const stop = (): void => {
    if (!child.pid) return;
    try {
      if (process.platform === 'win32') child.kill('SIGKILL');
      else process.kill(-child.pid, 'SIGKILL');
    } catch {
      // The child may have exited.
    }
  };
  const collect = (chunk: Buffer, target: Buffer[]): void => {
    bytes += chunk.byteLength;
    const retained =
      stdout.reduce((sum, item) => sum + item.length, 0) +
      stderr.reduce((sum, item) => sum + item.length, 0);
    if (retained < MAX_OUTPUT_BYTES)
      target.push(chunk.subarray(0, MAX_OUTPUT_BYTES - retained));
    if (bytes > MAX_OUTPUT_BYTES && !outputLimitExceeded) {
      outputLimitExceeded = true;
      stop();
    }
  };
  child.stdout.on('data', (chunk: Buffer) => collect(chunk, stdout));
  child.stderr.on('data', (chunk: Buffer) => collect(chunk, stderr));
  child.on('error', (cause: Error) => {
    error = cause.message;
  });
  const onAbort = (): void => {
    cancelled = true;
    stop();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, timeoutMs);
  const exit = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.on('close', (code, exitSignal) =>
      resolve({ code, signal: exitSignal }),
    );
  });
  clearTimeout(timer);
  signal?.removeEventListener('abort', onAbort);
  const processPath = join(evidence, 'process.json');
  const processEvidence = {
    schema: 1,
    pid: child.pid ?? null,
    startedAt,
    endedAt: new Date().toISOString(),
    exitCode: exit.code,
    signal: exit.signal,
    timedOut,
    cancelled,
    outputLimitExceeded,
    error,
    stdoutBytes: Buffer.concat(stdout).length,
    stderrBytes: Buffer.concat(stderr).length,
  };
  const output = Buffer.concat(stdout);
  await Promise.all([
    writeFile(join(evidence, 'stdout.json'), output, { mode: 0o600 }),
    writeFile(join(evidence, 'stderr.log'), Buffer.concat(stderr), {
      mode: 0o600,
    }),
    writeFile(processPath, `${JSON.stringify(processEvidence, null, 2)}\n`, {
      mode: 0o600,
    }),
  ]);
  let structured: unknown;
  let authUnavailable = false;
  if (processPassed(processEvidence)) {
    try {
      const parsed: unknown = JSON.parse(output.toString('utf8'));
      structured = record(parsed) ? parsed.structured_output : undefined;
    } catch {
      // Malformed output is a blocked probe.
    }
  } else {
    try {
      const parsed: unknown = JSON.parse(output.toString('utf8'));
      authUnavailable =
        record(parsed) &&
        parsed.is_error === true &&
        typeof parsed.result === 'string' &&
        /not logged in/i.test(parsed.result);
    } catch {
      // Other process failures retain a generic reason.
    }
  }
  const observed =
    processPassed(processEvidence) &&
    record(structured) &&
    Object.keys(structured).length === 1 &&
    structured.token === token;
  return {
    observed,
    reason: observed
      ? 'Independent read-only Claude Code process returned the private challenge token.'
      : authUnavailable
        ? 'Claude Code is not authenticated; log in before repeating live doctor.'
        : 'Claude Code did not return a verified read-only challenge result.',
    processPath,
  };
}

/** This is preflight evidence only; feature admission revalidates host proof per run. */
export async function runLiveHostDoctor(
  options: LiveHostDoctorOptions,
): Promise<LiveHostDoctorReport> {
  if (!['codex', 'claude-code', 'cursor'].includes(options.host))
    throw new Error('Unsupported live doctor host.');
  if (!isAbsolute(options.dataDirectory))
    throw new Error('Live doctor dataDirectory must be absolute.');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000)
    throw new Error('Live doctor timeout must be between 1 and 300000 ms.');
  const root = join(options.dataDirectory, 'state', 'host-doctor');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const runDirectory = await mkdtemp(join(root, `${options.host}-`));
  const workspace = join(runDirectory, 'workspace');
  const evidence = join(runDirectory, 'evidence');
  await Promise.all([
    mkdir(workspace, { mode: 0o700 }),
    mkdir(evidence, { mode: 0o700 }),
  ]);
  const token = randomBytes(16).toString('hex');
  await writeFile(join(workspace, 'challenge.txt'), `${token}\n`, {
    mode: 0o600,
  });
  let executable: string | null = null;
  let executableVersion: string | null = null;
  let executableSha256: string | null = null;
  let processPath: string | null = null;
  let observed = false;
  let reason = 'No bounded live Cursor process probe is installed.';
  if (options.host !== 'cursor') {
    try {
      executable = await resolveCodexExecutable(
        options.executable ?? (options.host === 'codex' ? 'codex' : 'claude'),
      );
      executableVersion = await identifyHost(options.host, executable);
      executableSha256 = await digestFile(executable);
      const probe =
        options.host === 'codex'
          ? await codexProbe(
              executable,
              workspace,
              evidence,
              token,
              timeoutMs,
              options.signal,
            )
          : await claudeProbe(
              executable,
              workspace,
              evidence,
              token,
              timeoutMs,
              options.signal,
            );
      observed = probe.observed;
      reason = probe.reason;
      processPath = probe.processPath;
    } catch (cause) {
      reason = `Host probe could not complete: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
  }
  const processEvidenceSha256 = processPath
    ? digest(await readFile(processPath))
    : null;
  const report: LiveHostDoctorReport = {
    schema: 1,
    scope: 'installation-preflight-only',
    host: options.host,
    status: observed ? 'OBSERVED' : 'BLOCKED',
    observedCapabilities: observed ? ['subagents'] : [],
    unprovenCapabilities: HOST_CAPABILITIES.filter(
      (capability) => !observed || capability !== 'subagents',
    ),
    checkedAt: new Date().toISOString(),
    executable,
    executableVersion,
    executableSha256,
    processEvidencePath: processPath,
    processEvidenceSha256,
    runDirectory,
    reason,
  };
  const reportPath = join(runDirectory, 'doctor-report.json');
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  await chmod(reportPath, 0o600);
  return report;
}
