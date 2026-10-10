import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import {
  HOST_CAPABILITIES,
  type HostCapabilityReport,
  type WorkerAssignment,
  type WorkerResult,
} from '@temari/contracts';
import {
  assertCodexProviderSelection,
  observeCodexProvider,
  resolveCodexExecutable,
  runCodexExecWorker,
  runCodexExecWriteWorker,
  type CodexExecWorkerOptions,
  type CodexProviderSelection,
  type CodexWriteOwnedPath,
} from './codex-exec-worker.js';
import {
  assertClaudeCodeProviderSelection,
  observeClaudeCodeProvider,
  runClaudeCodeWorker,
  type ClaudeCodeProviderSelection,
} from './claude-code-worker.js';
export type WorkerProviderSelection =
  CodexProviderSelection | ClaudeCodeProviderSelection;
export type WorkerOwnedPath = CodexWriteOwnedPath;
export interface WorkerToolServerPin {
  readonly path: string;
  readonly sha256: string;
  readonly nodeExecutable?: string;
  readonly nodeSha256?: string;
}
export interface WorkerExecutionOptions extends Omit<
  CodexExecWorkerOptions,
  'providerSelection'
> {
  readonly providerSelection?: WorkerProviderSelection;
  readonly access: 'read-only' | 'workspace-write';
  readonly baseCommit?: string;
  readonly owns?: readonly WorkerOwnedPath[];
  readonly scopedToolServer?: WorkerToolServerPin;
}
export function assertWorkerToolServerPin(
  value: unknown,
): asserts value is WorkerToolServerPin {
  assert(
    value && typeof value === 'object' && !Array.isArray(value),
    'Select a pinned worker tool server.',
  );
  const item = value as Record<string, unknown>;
  assert(
    Object.keys(item).every((key) =>
      ['path', 'sha256', 'nodeExecutable', 'nodeSha256'].includes(key),
    ),
  );
  assert(
    typeof item.path === 'string' &&
      isAbsolute(item.path) &&
      !item.path.includes('\0'),
  );
  assert(typeof item.sha256 === 'string' && /^[a-f0-9]{64}$/.test(item.sha256));
  assert(
    'nodeExecutable' in item === 'nodeSha256' in item,
    'Worker tool interpreter path and hash must be paired.',
  );
  if ('nodeExecutable' in item) {
    assert(
      typeof item.nodeExecutable === 'string' &&
        isAbsolute(item.nodeExecutable) &&
        !item.nodeExecutable.includes('\0'),
    );
    assert(
      typeof item.nodeSha256 === 'string' &&
        /^[a-f0-9]{64}$/.test(item.nodeSha256),
    );
  }
}
export function assertWorkerProviderSelection(
  value: unknown,
): asserts value is WorkerProviderSelection {
  assert(
    value && typeof value === 'object' && !Array.isArray(value),
    'Unsupported worker provider.',
  );
  const provider = (value as Record<string, unknown>).provider;
  if (provider === 'codex') assertCodexProviderSelection(value);
  else if (provider === 'claude-code') assertClaudeCodeProviderSelection(value);
  else throw new Error('Unsupported worker provider.');
}
export const resolveWorkerExecutable = resolveCodexExecutable;
export async function observeWorkerProvider(
  executable: string,
  selection: WorkerProviderSelection,
) {
  assertWorkerProviderSelection(selection);
  return selection.provider === 'codex'
    ? observeCodexProvider(executable, selection)
    : observeClaudeCodeProvider(executable, selection);
}
export async function observeWorkerToolServer(pin: WorkerToolServerPin) {
  assertWorkerToolServerPin(pin);
  const digest = (bytes: Uint8Array) =>
    createHash('sha256').update(bytes).digest('hex');
  const sha256 = digest(await readFile(await realpath(pin.path)));
  assert.equal(sha256, pin.sha256, 'Worker tool server identity drifted.');
  const nodeExecutable = pin.nodeExecutable ?? process.execPath;
  const nodeSha256 = digest(await readFile(await realpath(nodeExecutable)));
  if (pin.nodeSha256)
    assert.equal(
      nodeSha256,
      pin.nodeSha256,
      'Worker tool interpreter identity drifted.',
    );
  return { path: pin.path, sha256, nodeExecutable, nodeSha256 };
}
export async function preflightWorkerExecution(
  executable: string,
  providerSelection?: WorkerProviderSelection,
  scopedToolServer?: WorkerToolServerPin,
) {
  if (providerSelection) {
    assertWorkerProviderSelection(providerSelection);
    if (providerSelection.provider === 'codex')
      assert(
        providerSelection.model &&
          typeof providerSelection.reasoning === 'string' &&
          providerSelection.reasoning.trim(),
        'Managed Codex execution requires explicit model and reasoning selection.',
      );
    else
      assert(
        scopedToolServer,
        'Claude workers require a pinned scoped tool server.',
      );
  }
  const provider = providerSelection
    ? await observeWorkerProvider(executable, providerSelection)
    : null;
  const selectedExecutable =
    provider?.executable ?? (await resolveWorkerExecutable(executable));
  const toolServer = scopedToolServer
    ? await observeWorkerToolServer(scopedToolServer)
    : null;
  return {
    executable: selectedExecutable,
    provider,
    scopedToolServer: toolServer,
  };
}
export async function runWorkerExecution(
  assignment: WorkerAssignment,
  options: WorkerExecutionOptions,
  signal?: AbortSignal,
): Promise<WorkerResult> {
  assert(
    options.access === 'read-only' || options.access === 'workspace-write',
    'Unsupported worker access.',
  );
  if (options.providerSelection)
    assertWorkerProviderSelection(options.providerSelection);
  const selected = { ...options, signal: signal ?? options.signal };
  if (selected.providerSelection?.provider === 'claude-code')
    return runClaudeCodeWorker(assignment, {
      ...selected,
      providerSelection: selected.providerSelection,
    });
  const codex = {
    ...selected,
    providerSelection: selected.providerSelection as
      CodexProviderSelection | undefined,
  };
  let result: WorkerResult;
  if (options.access === 'workspace-write') {
    assert(
      options.baseCommit && options.owns?.length,
      'Write workers require a pinned base and typed ownership.',
    );
    result = await runCodexExecWriteWorker(assignment, {
      ...codex,
      baseCommit: options.baseCommit,
      owns: options.owns,
    });
  } else result = await runCodexExecWorker(assignment, codex);
  // Preserve native Codex fields for existing evidence readers while exposing
  // the equivalent portable session identity to provider-neutral consumers.
  const path = result.evidencePaths.find((path) =>
    path.endsWith('/process.json'),
  );
  if (path) {
    const evidence = JSON.parse(await readFile(path, 'utf8')) as Record<
      string,
      unknown
    >;
    await writeFile(
      path,
      JSON.stringify({
        ...evidence,
        nativeSessionId: evidence.nativeThreadId ?? null,
        workerProvider: 'codex',
      }) + '\n',
      { mode: 0o600 },
    );
  }
  return result;
}
export type { ClaudeCodeProviderSelection };

export function workerExecutionCapabilities(
  selection?: WorkerProviderSelection,
  access: 'read-only' | 'workspace-write' = 'read-only',
): HostCapabilityReport {
  if (selection) assertWorkerProviderSelection(selection);
  const host =
    selection?.provider === 'claude-code'
      ? access === 'workspace-write'
        ? 'claude-code-scoped-mcp-write-local'
        : 'claude-code-scoped-mcp-local'
      : access === 'workspace-write'
        ? 'codex-exec-write-local'
        : 'codex-exec-local';
  return {
    host,
    available: ['parallelism'],
    missing: HOST_CAPABILITIES.filter(
      (capability) => capability !== 'parallelism',
    ),
    notes: {
      parallelism:
        'Bounded local worker processes; actual overlap requires execution evidence.',
      subagents: 'Independent CLI workers do not prove host subagent APIs.',
      worktree_isolation:
        'Isolation is provided and verified by the runtime, not this process adapter.',
      forge: 'Publication and completion are runtime-owned and unproven here.',
    },
    provenance: {
      parallelism: {
        status: 'unproven',
        source: host + ' bounded process adapter declaration',
      },
    },
  };
}
