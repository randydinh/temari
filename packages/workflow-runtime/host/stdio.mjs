import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';

const CONTROL_BYTES = 2048; // Includes LF, or both bytes of CRLF.
const RESULT_BYTES = 32 * 1024;
const FILE_BYTES = 1024 * 1024;
const TOTAL_BYTES = 16 * FILE_BYTES;
const SESSION_MS = 30 * 60 * 1000; // Fixed 30-minute invocation deadline.
const OUTPUT_MS = 5000; // Bounded output flush, including the final record.
const statuses = ['PASS', 'ISSUES', 'BLOCKED', 'DROPPED'];
const kinds = ['stdout', 'stderr', 'worker-result', 'verification', 'other'];
const utf8 = new TextDecoder('utf-8', { fatal: true });

export function exactFields(value, required, optional = []) {
  assert(
    value && typeof value === 'object' && !Array.isArray(value),
    'Expected a JSON object.',
  );
  assert(
    required.every((key) => Object.hasOwn(value, key)) &&
      Object.keys(value).every(
        (key) => required.includes(key) || optional.includes(key),
      ),
    'Unexpected or missing JSON fields.',
  );
}

// Cooperative writers must finish files before replying. These checks bound
// allocation and reject symlinks; they are not hostile-writer race containment.
export async function readBoundedFile(path, limit) {
  const before = await lstat(path);
  assert(
    before.isFile() && !before.isSymbolicLink(),
    'Expected a regular file.',
  );
  assert(before.size <= limit, 'File exceeds the byte limit.');
  const file = await open(
    path,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = await file.stat();
    assert(
      stat.isFile() &&
        stat.dev === before.dev &&
        stat.ino === before.ino &&
        stat.size === before.size &&
        stat.size <= limit,
      'File changed before reading.',
    );
    const bytes = Buffer.alloc(stat.size + 1);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await file.read(
        bytes,
        used,
        bytes.length - used,
        null,
      );
      if (!bytesRead) break;
      used += bytesRead;
    }
    const after = await file.stat();
    assert(
      used === stat.size &&
        after.size === stat.size &&
        after.mtimeMs === stat.mtimeMs,
      'File changed while reading.',
    );
    return bytes.subarray(0, used);
  } finally {
    await file.close();
  }
}

export async function readBoundedJson(path, limit) {
  return JSON.parse(utf8.decode(await readBoundedFile(path, limit)));
}

export function controlLine(record) {
  const line = `${JSON.stringify(record)}\n`;
  assert(
    Buffer.byteLength(line) <= CONTROL_BYTES,
    'Control record exceeds 2048 bytes.',
  );
  return line;
}

async function checkWorkspace(workspace) {
  const stat = await lstat(workspace);
  assert(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      (await realpath(workspace)) === workspace,
    'Stage workspace resolution changed.',
  );
}

async function readResult(request) {
  await checkWorkspace(request.workspace);
  const result = await readBoundedJson(
    join(request.workspace, 'host-result.json'),
    RESULT_BYTES,
  );
  exactFields(result, [
    'schemaVersion',
    'sessionId',
    'requestId',
    'stage',
    'status',
    'summary',
    'evidence',
  ]);
  assert(
    result.schemaVersion === 1 &&
      result.sessionId === request.sessionId &&
      result.requestId === request.requestId &&
      result.stage === request.stage,
    'Host result does not match the pending request.',
  );
  assert(statuses.includes(result.status), 'Unknown host result status.');
  assert(
    typeof result.summary === 'string' &&
      result.summary.trim().length > 0 &&
      Buffer.byteLength(result.summary) <= 4096,
    'Invalid host result summary.',
  );
  assert(
    Array.isArray(result.evidence) && result.evidence.length <= 16,
    'Host result allows at most 16 evidence files.',
  );
  const names = new Set();
  for (const item of result.evidence) {
    exactFields(item, ['name', 'kind', 'path']);
    assert(
      typeof item.name === 'string' &&
        item.name.trim().length > 0 &&
        item.name.length <= 128 &&
        !names.has(item.name),
      'Invalid or duplicate evidence name.',
    );
    names.add(item.name);
    assert(kinds.includes(item.kind), 'Unknown evidence kind.');
    // Deliberately narrow portable direct filenames: no directories or devices.
    assert(
      typeof item.path === 'string' &&
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(item.path) &&
        !item.path.endsWith('.') &&
        !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(item.path),
      'Evidence path must be a safe direct filename.',
    );
  }
  const evidence = [];
  let total = 0;
  for (const item of result.evidence) {
    await checkWorkspace(request.workspace);
    const content = await readBoundedFile(
      join(request.workspace, item.path),
      FILE_BYTES,
    );
    total += content.byteLength;
    assert(total <= TOTAL_BYTES, 'Evidence exceeds 16 MiB total.');
    evidence.push({ name: item.name, kind: item.kind, content });
  }
  await checkWorkspace(request.workspace);
  return { status: result.status, summary: result.summary, evidence };
}

export function diagnostic(error) {
  const message = error instanceof Error ? error.message : String(error);
  // No protocol records or logs are written into stage workspaces.
  process.stderr.write(
    `experimental-local-host: ${message.slice(0, 512).replace(/[\x00-\x1f\x7f]/g, ' ')}\n`,
  );
}

// Private one-slot transport. It neither chooses stages nor records progress.
export function createStdioSession() {
  const sessionId = randomUUID();
  let sequence = 0;
  let pending = null;
  let fault = null;
  let disposed = false;
  let buffer = Buffer.alloc(0);
  const wasRaw = process.stdin.isRaw ?? false;
  const outputTimers = new Set();
  const deadline = setTimeout(
    () => crash('30-minute session timeout.'),
    SESSION_MS,
  );

  function dispose() {
    if (disposed) return;
    disposed = true;
    pending = null;
    buffer = Buffer.alloc(0);
    clearTimeout(deadline);
    for (const timer of outputTimers) clearTimeout(timer);
    outputTimers.clear();
    process.stdin.off('data', onData);
    process.stdin.off('end', onEnd);
    process.stdin.off('close', onEnd);
    process.stdin.off('error', onInputError);
    process.stdout.off('error', onOutputError);
    process.stdout.off('close', onOutputError);
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(wasRaw);
      } catch {
        /* Best effort on a lost TTY. */
      }
    }
    process.stdin.pause();
    process.stdin.unref?.();
  }

  function crash(message, code = 1) {
    // Never reject into the engine for transport loss: preserve crash recovery.
    dispose();
    diagnostic(new Error(message));
    process.exit(code);
  }
  function protocolFault(error) {
    if (fault || disposed) return;
    fault = new Error(
      error instanceof Error ? error.message : 'Invalid host response.',
    );
    diagnostic(fault);
    const slot = pending;
    pending = null;
    buffer = Buffer.alloc(0);
    slot?.reject(fault);
  }
  function assertHealthy() {
    if (fault) throw fault;
    assert(!disposed, 'Host session is closed.');
  }
  function emit(record) {
    const line = controlLine(record);
    return new Promise((resolve) => {
      const timer = setTimeout(() => crash('Output flush timeout.'), OUTPUT_MS);
      outputTimers.add(timer);
      try {
        process.stdout.write(line, (error) => {
          clearTimeout(timer);
          outputTimers.delete(timer);
          if (error) crash('Output channel failed.');
          resolve();
        });
      } catch {
        crash('Output channel failed.');
      }
    });
  }
  function consume(line) {
    const slot = pending;
    assert(slot && !slot.consumed, 'Unexpected or duplicate host reply.');
    const reply = JSON.parse(utf8.decode(line));
    exactFields(reply, ['type', 'sessionId', 'requestId', 'stage']);
    assert(
      reply.type === 'result' &&
        reply.sessionId === sessionId &&
        reply.requestId === slot.request.requestId &&
        reply.stage === slot.request.stage,
      'Host reply does not match the pending request.',
    );
    slot.consumed = true;
    void readResult(slot.request).then(
      (result) => {
        if (pending !== slot || fault || disposed) return;
        pending = null;
        slot.resolve(result);
      },
      (error) => protocolFault(error),
    );
  }
  function onData(chunk) {
    if (disposed) return;
    if (process.stdin.isTTY && chunk.includes(3)) crash('Interrupted.', 130);
    if (fault) return;
    try {
      for (let start = 0; start < chunk.length;) {
        assert(
          pending && !pending.consumed,
          'Input arrived without a pending stage.',
        );
        const newline = chunk.indexOf(10, start);
        const end = newline < 0 ? chunk.length : newline + 1;
        assert(
          buffer.length + end - start <= CONTROL_BYTES,
          'Host reply exceeds 2048 bytes.',
        );
        buffer = Buffer.concat([buffer, chunk.subarray(start, end)]);
        start = end;
        if (newline >= 0) {
          const line = buffer.subarray(
            0,
            buffer.length - (buffer.at(-2) === 13 ? 2 : 1),
          );
          buffer = Buffer.alloc(0);
          consume(line);
        }
      }
    } catch (error) {
      protocolFault(error);
    }
  }
  function onEnd() {
    crash('Input channel closed.');
  }
  function onInputError() {
    crash('Input channel failed.');
  }
  function onOutputError() {
    crash('Output channel failed.');
  }
  function onInterrupt() {
    crash('Interrupted.', 130);
  }
  function onTerminate() {
    crash('Terminated.', 143);
  }

  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  process.stdin.on('end', onEnd);
  process.stdin.on('close', onEnd);
  process.stdin.on('error', onInputError);
  process.stdout.on('error', onOutputError);
  process.stdout.on('close', onOutputError);
  try {
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
  } catch (error) {
    dispose();
    throw error;
  }
  process.stdin.on('data', onData);
  process.stdin.resume();

  return {
    assertHealthy,
    dispose,
    emit,
    get fault() {
      return fault;
    },
    stage(stage, workspace, candidate) {
      assertHealthy();
      assert(!pending, 'A host stage is already pending.');
      const request = {
        type: 'stage',
        sessionId,
        requestId: ++sequence,
        stage,
        workspace,
        candidate,
      };
      controlLine(request);
      return new Promise((resolve, reject) => {
        pending = { request, resolve, reject, consumed: false };
        void emit(request);
      });
    },
  };
}
