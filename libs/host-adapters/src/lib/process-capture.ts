import { inOwnedProcessGroup } from './owned-execution.js';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, open } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type { Readable } from 'node:stream';

export interface CapturedStream {
  readonly path: string;
  readonly available: boolean;
  readonly status: 'complete' | 'capture-failed';
  readonly receivedBytes: number;
  readonly bytes: number;
  readonly sha256: string;
  readonly error: string | null;
}
export interface CapturedProcessDiagnostic {
  readonly category:
    | 'launch'
    | 'start-observation'
    | 'stdout'
    | 'stderr'
    | 'supervisor'
    | 'review-candidate'
    | 'review-resolution'
    | 'archive'
    | 'stdin'
    | 'verification-transcript'
    | 'schema'
    | 'metadata'
    | 'final-response';
  readonly path: string;
  readonly status: 'complete' | 'capture-failed';
  readonly bytes: number;
  readonly sha256: string;
  readonly error: string | null;
}
export interface CapturedProcessResult {
  readonly pid: number | null;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly error: string | null;
  readonly captureComplete: boolean;
  readonly stdout: CapturedStream;
  readonly stderr: CapturedStream;
  readonly diagnostics: readonly CapturedProcessDiagnostic[];
}
export interface CapturedProcessOptions {
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdin?: string | Uint8Array;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly onStarted?: (identity: {
    readonly pid: number;
    readonly startedAt: string;
  }) => Promise<void>;
}
function terminate(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(process.platform === 'win32' || inOwnedProcessGroup() ? pid : -pid, 'SIGKILL');
  } catch {}
}
function safeErrorCode(error: unknown): string | null {
  try {
    if (error && typeof error === 'object' && 'code' in error) {
      const candidate = error.code;
      if (
        typeof candidate === 'string' &&
        /^[A-Z][A-Z0-9_]{0,63}$/.test(candidate)
      )
        return candidate;
    }
  } catch {}
  return null;
}
function operationalError(error: unknown, label: string): string {
  return `${label} (${safeErrorCode(error) ?? 'operation failed'}).`;
}

function fullOperationalCause(cause: unknown): string {
  if (cause instanceof Error) {
    let message = '',
      stack = '';
    try {
      message =
        typeof cause.message === 'string'
          ? cause.message
          : String(cause.message);
    } catch {}
    try {
      stack = typeof cause.stack === 'string' ? cause.stack : '';
    } catch {}
    if (stack.trim())
      return message.trim() && !stack.includes(message)
        ? `${message}\n${stack}`
        : stack;
    if (message.trim()) return message;
  } else {
    try {
      const text = String(cause);
      if (text.trim()) return text;
    } catch {}
  }
  return 'Process operation failed without a readable diagnostic.';
}
export async function retainProcessDiagnostic(
  path: string,
  category: CapturedProcessDiagnostic['category'],
  cause: unknown,
): Promise<CapturedProcessDiagnostic> {
  const text = fullOperationalCause(cause);
  assert(isAbsolute(path), 'Diagnostic source path must be absolute.');
  let hashing = createHash('sha256');
  let bytes = 0;
  let failure: string | null = null;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(path, 'wx+', 0o600);
    for (let offset = 0; offset < text.length;) {
      let end = Math.min(offset + 16_384, text.length);
      const last = text.charCodeAt(end - 1);
      if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
      const chunk = Buffer.from(text.slice(offset, end));
      await file.writeFile(chunk);
      bytes += chunk.byteLength;
      hashing.update(chunk);
      offset = end;
    }
    await file.sync();
  } catch (error) {
    failure = operationalError(
      error,
      'Operational diagnostic retention failed',
    );
  } finally {
    if (file) {
      if (failure) {
        try {
          hashing = createHash('sha256');
          bytes = 0;
          for await (const chunk of file.createReadStream({
            start: 0,
            autoClose: false,
          })) {
            hashing.update(chunk);
            bytes += chunk.byteLength;
          }
        } catch {}
      }
      try {
        await file.close();
      } catch (error) {
        failure ??= operationalError(
          error,
          'Operational diagnostic close failed',
        );
      }
    }
  }
  return {
    path,
    category,
    status: failure ? 'capture-failed' : 'complete',
    bytes,
    sha256: hashing.digest('hex'),
    error: failure,
  };
}

/** Each pipe has an independent backpressured file sink. Volume never changes
 * process lifetime. Paths must be fresh within the caller's private attempt. */
export async function runProcessToFiles(
  options: CapturedProcessOptions,
): Promise<CapturedProcessResult> {
  assert(
    isAbsolute(options.cwd) &&
      isAbsolute(options.stdoutPath) &&
      isAbsolute(options.stderrPath),
    'Process capture paths must be absolute.',
  );
  assert(
    options.stdoutPath !== options.stderrPath,
    'Process streams require distinct files.',
  );
  assert(
    Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0,
    'Capture timeout must be positive.',
  );
  let stdoutFile: Awaited<ReturnType<typeof open>> | undefined;
  let stderrFile: Awaited<ReturnType<typeof open>> | undefined;
  let startedAt = new Date().toISOString();
  const settleUnstarted = async (
    causes: unknown[],
    label: string,
    cancelled = false,
  ): Promise<CapturedProcessResult> => {
    const settle = async (
      file: Awaited<ReturnType<typeof open>> | undefined,
      path: string,
    ): Promise<CapturedStream> => {
      let failure: string | null = file
        ? null
        : 'Diagnostic stream was not opened.';
      if (file) {
        try {
          await file.sync();
        } catch (cause) {
          causes.push(cause);
          failure = 'Diagnostic stream finalization failed.';
        }
        try {
          await file.close();
        } catch (cause) {
          causes.push(cause);
          failure = 'Diagnostic stream finalization failed.';
        }
      }
      return {
        path,
        available: Boolean(file),
        status: failure ? 'capture-failed' : 'complete',
        receivedBytes: 0,
        bytes: 0,
        sha256: createHash('sha256').digest('hex'),
        error: failure,
      };
    };
    const stdout = await settle(stdoutFile, options.stdoutPath);
    const stderr = await settle(stderrFile, options.stderrPath);
    const diagnostics: CapturedProcessDiagnostic[] = [];
    for (const [index, cause] of causes.entries())
      diagnostics.push(
        await retainProcessDiagnostic(
          join(dirname(options.stdoutPath), `capture-diagnostic-${index}.log`),
          'launch',
          cause,
        ),
      );
    return {
      pid: null,
      startedAt,
      endedAt: new Date().toISOString(),
      code: null,
      signal: null,
      timedOut: false,
      cancelled,
      error: causes.length ? operationalError(causes[0], label) : null,
      captureComplete:
        causes.length === 0 &&
        stdout.status === 'complete' &&
        stderr.status === 'complete',
      stdout,
      stderr,
      diagnostics,
    };
  };
  try {
    for (const directory of new Set([
      dirname(options.stdoutPath),
      dirname(options.stderrPath),
    ])) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
    }
    stdoutFile = await open(options.stdoutPath, 'wx+', 0o600);
    stderrFile = await open(options.stderrPath, 'wx+', 0o600);
  } catch (cause) {
    return settleUnstarted(
      [cause],
      'Process capture setup failed',
      Boolean(options.signal?.aborted),
    );
  }
  startedAt = new Date().toISOString();
  if (options.signal?.aborted)
    return settleUnstarted([], 'Process capture finalization failed', true);
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(options.program, [...options.args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      detached: process.platform !== 'win32' && !inOwnedProcessGroup(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (cause) {
    return settleUnstarted([cause], 'Process launch failed');
  }

  const problems: {
    category: CapturedProcessDiagnostic['category'];
    cause: unknown;
  }[] = [];
  let error: string | null = null;
  let timedOut = false;
  let cancelled = false;
  let hook: Promise<void> = Promise.resolve();
  child.once('spawn', () => {
    if (options.onStarted && child.pid) {
      const pid = child.pid;
      hook = Promise.resolve()
        .then(() => options.onStarted!({ pid, startedAt }))
        .catch((cause) => {
          problems.push({ category: 'start-observation', cause });
          error = operationalError(cause, 'Worker start observation failed');
          terminate(child.pid);
        });
    }
  });
  child.on('error', (cause) => {
    problems.push({ category: 'launch', cause });
    error = operationalError(cause, 'Process launch failed');
  });
  const abort = () => {
    cancelled = true;
    terminate(child.pid);
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const timeout = setTimeout(() => {
    timedOut = true;
    terminate(child.pid);
  }, options.timeoutMs);
  const closed = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((done) =>
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      done({ code, signal });
    }),
  );
  const drain = async (
    stream: Readable,
    file: Awaited<ReturnType<typeof open>>,
    path: string,
    category: 'stdout' | 'stderr',
  ): Promise<CapturedStream> => {
    let hash = createHash('sha256');
    let receivedBytes = 0;
    let bytes = 0;
    let failure: string | null = null;
    const fail = (cause: unknown) => {
      problems.push({ category, cause });
      failure ??= operationalError(cause, 'Diagnostic capture failed');
      terminate(child.pid);
    };
    try {
      try {
        for await (const chunk of stream) {
          receivedBytes += chunk.byteLength;
          if (!Number.isSafeInteger(receivedBytes)) {
            fail(new Error('Unrepresentable byte count'));
            continue;
          }
          if (failure) continue;
          try {
            await file.writeFile(chunk);
            bytes += chunk.byteLength;
            hash.update(chunk);
          } catch (cause) {
            fail(cause);
          }
        }
      } catch (cause) {
        fail(cause);
      }
      if (failure) {
        // A failed write may have committed a prefix of its chunk. Measure the
        // retained descriptor again so partial-byte metadata remains exact.
        try {
          bytes = 0;
          hash = createHash('sha256');
          for await (const chunk of file.createReadStream({
            start: 0,
            autoClose: false,
          })) {
            bytes += chunk.byteLength;
            hash.update(chunk);
          }
        } catch (cause) {
          fail(cause);
        }
      }
      try {
        await file.sync();
      } catch (cause) {
        fail(cause);
      }
    } finally {
      try {
        await file.close();
      } catch (cause) {
        fail(cause);
      }
    }
    return {
      path,
      available: true,
      status: failure ? 'capture-failed' : 'complete',
      receivedBytes,
      bytes,
      sha256: hash.digest('hex'),
      error: failure,
    };
  };
  const stdout = drain(child.stdout, stdoutFile, options.stdoutPath, 'stdout');
  const stderr = drain(child.stderr, stderrFile, options.stderrPath, 'stderr');
  child.stdin.on('error', (cause) => {
    const code = safeErrorCode(cause);
    if (code === 'EPIPE' || code === 'ECONNRESET') return;
    problems.push({ category: 'stdin', cause });
    error ??= operationalError(cause, 'Process input failed');
    terminate(child.pid);
  });
  child.stdin.end(options.stdin);
  try {
    const [exit, capturedStdout, capturedStderr] = await Promise.all([
      closed,
      stdout,
      stderr,
    ]);
    await hook;
    const diagnostics: CapturedProcessDiagnostic[] = [];
    for (const [index, problem] of problems.entries())
      diagnostics.push(
        await retainProcessDiagnostic(
          join(dirname(options.stdoutPath), `capture-diagnostic-${index}.log`),
          problem.category,
          problem.cause,
        ),
      );
    const captureComplete =
      capturedStdout.status === 'complete' &&
      capturedStderr.status === 'complete' &&
      diagnostics.every((item) => item.status === 'complete');
    return {
      pid: child.pid ?? null,
      startedAt,
      endedAt: new Date().toISOString(),
      ...exit,
      timedOut,
      cancelled,
      error,
      captureComplete,
      stdout: capturedStdout,
      stderr: capturedStderr,
      diagnostics,
    };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
  }
}
