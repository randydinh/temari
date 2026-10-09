import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  reconcilePlan,
  type ExecutionPlan,
  type HostCapabilityReport,
  type WorkerAssignment,
} from '../libs/contracts/src/index.js';
import {
  resolveCodexExecutable,
  runCodexExecWorker,
} from '../libs/host-adapters/src/index.js';
import {
  executeRestartableParallelWorkers,
  prepareRestartableParallelWorkers,
  FileChildTaskStore,
  FileEvidenceStore,
  streamEvidenceFile,
  verifyEvidenceFile,
  verifyChildTaskEvidence,
  WorkerExecutionFailure,
  FileParallelWorkerReceiptStore,
  type ChildTaskRecord,
  type ChildTaskEvent,
} from '../libs/runtime/src/index.js';
import type { ParallelWorkerReceipt } from '../libs/workflow-engine/src/index.js';
import {
  parseCodexWorkersRequest,
  type CodexWorkersRequest,
} from './run-codex-workers.mjs';

import {
  retainDashboardDiagnostic,
  verifyDashboardDiagnostics,
  type DashboardDiagnostic,
} from './dashboard-diagnostics.mjs';

const runFile = promisify(execFile);
const script = fileURLToPath(import.meta.url);
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
      'Bounded local read-only Codex processes; worker findings require coordinator review.',
  },
  provenance: {
    parallelism: {
      status: 'unproven',
      source: 'Use retained process evidence to verify actual overlap.',
    },
  },
};

export interface DashboardSwarmRequest {
  readonly root: string;
  readonly taskId: string;
  readonly runId: string;
  readonly revision: string;
  readonly workspaceRoot: string;
  readonly assignments: readonly WorkerAssignment[];
  readonly maxConcurrency: number;
  readonly executable: string;
  readonly timeoutMs: number;
  readonly maxAttempts?: 1 | 2;
}
export interface DashboardSwarmHandle {
  readonly requestPath: string;
  readonly manifestSha256: string;
  readonly plan: ExecutionPlan;
  readonly childStoreRoot: string;
  readonly groupId: string;
}
interface Manifest {
  readonly schema: 1;
  readonly taskId: string;
  readonly request: CodexWorkersRequest;
  readonly plan: ExecutionPlan;
  readonly childStoreRoot: string;
  readonly groupId: string;
  readonly workspaceHead: string;
  readonly maxAttempts: 1 | 2;
}
export interface DashboardSwarmSnapshot {
  readonly runId: string;
  readonly revision: string;
  readonly groupId: string;
  readonly state:
    | 'PREPARED'
    | 'STARTING'
    | 'RUNNING'
    | 'COMPLETE'
    | 'CANCELLED'
    | 'RECOVERY_REQUIRED'
    | 'FAILED';
  readonly workers: readonly {
    readonly assignment: WorkerAssignment;
    readonly task: ChildTaskRecord;
    readonly events: readonly ChildTaskEvent[];
  }[];
  readonly receipt: ParallelWorkerReceipt | null;
  /** Evidence validity is independent of worker/process lifecycle. */
  readonly integrityIssue: string | null;
  /** Whether queued work or unconfirmed process ownership can still be cancelled. */
  readonly canCancel: boolean;
  readonly statusNote: string;
  readonly diagnostics?: readonly DashboardDiagnostic[];
}
function sha(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
function safeId(value: string): void {
  assert(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value),
    'Task ID must be a safe identifier.',
  );
}
function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return (
    path === '' ||
    (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}
async function canonicalTarget(path: string): Promise<string> {
  assert(
    isAbsolute(path) && !path.includes('\0'),
    'Swarm paths must be absolute.',
  );
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return join(
      await canonicalTarget(dirname(path)),
      relative(dirname(path), path),
    );
  }
}
async function readBoundedRecord(path: string): Promise<Buffer> {
  const info = await lstat(path);
  assert(
    info.isFile() && !info.isSymbolicLink() && info.size <= 4 * 1024 * 1024,
    'Swarm record must be a bounded regular file.',
  );
  return readFile(path);
}
async function optional<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse((await readBoundedRecord(path)).toString('utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
async function publish(
  path: string,
  value: unknown,
  exclusive = false,
): Promise<boolean> {
  const content = serialize(value);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(content);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    try {
      await link(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (exclusive) return false;
      assert.equal(
        (await readBoundedRecord(path)).toString(),
        content,
        'Swarm record binding changed.',
      );
    }
    const directory = await open(dirname(path), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return true;
  } finally {
    await unlink(temporary);
  }
}
async function heartbeat(root: string, nonce: string): Promise<void> {
  const temporary = join(root, `.heartbeat-${randomUUID()}`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(serialize({ nonce, at: Date.now() }));
  } finally {
    await file.close();
  }
  await rename(temporary, join(root, 'heartbeat.json'));
}
async function cleanHead(workspace: string): Promise<string> {
  const options = {
    cwd: workspace,
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    env: Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
    ),
  };
  const top = (
    await runFile('git', ['rev-parse', '--show-toplevel'], options)
  ).stdout.trim();
  assert.equal(
    await realpath(top),
    workspace,
    'Select the canonical Git workspace root.',
  );
  const status = (
    await runFile(
      'git',
      ['status', '--porcelain', '--untracked-files=all'],
      options,
    )
  ).stdout;
  assert.equal(
    status.trim(),
    '',
    'Read-only swarm requires a clean workspace candidate.',
  );
  return (await runFile('git', ['rev-parse', 'HEAD'], options)).stdout.trim();
}
function handleFor(
  path: string,
  manifest: Manifest,
  digest: string,
): DashboardSwarmHandle {
  return {
    requestPath: path,
    manifestSha256: digest,
    plan: manifest.plan,
    childStoreRoot: manifest.childStoreRoot,
    groupId: manifest.groupId,
  };
}
async function load(handle: DashboardSwarmHandle): Promise<Manifest> {
  assert(
    isAbsolute(handle.requestPath),
    'Swarm request path must be absolute.',
  );
  const content = await readBoundedRecord(handle.requestPath);
  assert.equal(
    sha(content),
    handle.manifestSha256,
    'Swarm manifest digest changed.',
  );
  const manifest = JSON.parse(content.toString()) as Manifest;
  assert.equal(manifest.schema, 1);
  assert.deepEqual(
    handleFor(handle.requestPath, manifest, sha(content)),
    handle,
    'Swarm handle changed.',
  );
  const request = parseCodexWorkersRequest(manifest.request);
  assert.equal(request.evidenceRoot, dirname(handle.requestPath));
  assert.equal(manifest.childStoreRoot, join(request.evidenceRoot, 'children'));
  assert(request.assignments.length >= 2 && request.assignments.length <= 4);
  assert(request.maxConcurrency <= 4);
  assert(manifest.maxAttempts === 1 || manifest.maxAttempts === 2);
  assert.deepEqual(
    manifest.plan,
    reconcilePlan({
      workType: 'investigation',
      parallelism: { maxConcurrency: request.maxConcurrency },
    }),
  );
  return manifest;
}

/** Called before the service binds the returned child reference to its TaskRun. */
export async function prepareDashboardSwarm(
  input: DashboardSwarmRequest,
): Promise<DashboardSwarmHandle> {
  safeId(input.taskId);
  assert(
    input.assignments.length >= 2 && input.assignments.length <= 4,
    'A swarm needs two to four read-only assignments.',
  );
  assert(
    Number.isInteger(input.maxConcurrency) &&
      input.maxConcurrency >= 1 &&
      input.maxConcurrency <= 4,
    'Swarm concurrency must be from one to four.',
  );
  assert(
    input.maxAttempts === undefined ||
      input.maxAttempts === 1 ||
      input.maxAttempts === 2,
    'At most two mechanical attempts are allowed.',
  );
  for (const assignment of input.assignments)
    assert.equal(
      assignment.brief.verificationCommand,
      null,
      'Swarm assignments cannot supply executable commands.',
    );
  const workspaceRoot = await realpath(input.workspaceRoot);
  const root = await canonicalTarget(input.root);
  assert(
    !inside(workspaceRoot, root) && !inside(root, workspaceRoot),
    'Swarm storage must be outside the workspace.',
  );
  const workspaceHead = await cleanHead(workspaceRoot);
  const request = parseCodexWorkersRequest({
    ...input,
    workspaceRoot,
    evidenceRoot: join(root, input.runId, input.revision),
    executable: await resolveCodexExecutable(input.executable),
  });
  const plan = reconcilePlan({
    workType: 'investigation',
    parallelism: { maxConcurrency: request.maxConcurrency },
  });
  await mkdir(request.evidenceRoot, { recursive: true, mode: 0o700 });
  const childStoreRoot = join(request.evidenceRoot, 'children');
  const childStore = await FileChildTaskStore.create(childStoreRoot);
  const prepared = await prepareRestartableParallelWorkers({
    ...request,
    plan,
    capabilities,
    childStore,
    owner: `dashboard:${input.taskId}`,
  });
  const manifest: Manifest = {
    schema: 1,
    taskId: input.taskId,
    request,
    plan,
    childStoreRoot,
    groupId: prepared.group.groupId,
    workspaceHead,
    maxAttempts: input.maxAttempts ?? 2,
  };
  const requestPath = join(request.evidenceRoot, 'request.json');
  await publish(requestPath, manifest);
  return handleFor(requestPath, manifest, sha(serialize(manifest)));
}

export async function inspectDashboardSwarm(
  handle: DashboardSwarmHandle,
): Promise<DashboardSwarmSnapshot> {
  const manifest = await load(handle);
  const { request } = manifest;
  const intent = await optional<{ nonce: string; at: number }>(
    join(request.evidenceRoot, 'intent.json'),
  );
  const ended = await optional<{
    nonce: string;
    error: string | null;
    workersDrained?: boolean;
    diagnostics?: readonly DashboardDiagnostic[];
  }>(join(request.evidenceRoot, 'ended.json'));
  const receiptStore = await FileParallelWorkerReceiptStore.create(
    join(request.evidenceRoot, 'receipts'),
  );
  const retained = await receiptStore.load(request.runId);
  if (retained) {
    assert.equal(retained.binding.groupId, manifest.groupId);
    assert.equal(retained.receipt.revision, request.revision);
  }
  const childStore = await FileChildTaskStore.create(manifest.childStoreRoot);
  const group = await childStore.loadGroup(manifest.groupId);
  assert(
    group &&
      group.runId === request.runId &&
      group.revision === request.revision,
    'Swarm child group binding is missing or changed.',
  );
  assert.deepEqual(
    group.assignmentIds,
    request.assignments.map((item) => item.id),
  );
  const workers = await Promise.all(
    group.taskIds.map(async (taskId, index) => {
      const task = await childStore.load(taskId);
      assert(
        task &&
          task.runId === request.runId &&
          task.revision === request.revision,
        'Swarm child is missing or changed.',
      );
      return {
        assignment: request.assignments[index]!,
        task,
        events: await childStore.events(taskId),
      };
    }),
  );
  const integrityIssues: string[] = [];
  if (ended?.diagnostics?.length) {
    try {
      await verifyDashboardDiagnostics(
        await FileEvidenceStore.openExisting(
          join(request.evidenceRoot, 'evidence'),
        ),
        request.runId,
        request.revision,
        ended.diagnostics,
        request.evidenceRoot,
      );
    } catch {
      integrityIssues.push('Supervisor diagnostic evidence did not verify.');
    }
  }
  // A child result is advisory, but the findings we present must still match
  // their retained bytes. Check both the portable store and the linked files.
  for (const { assignment, task, events } of workers) {
    if (
      !task.result &&
      !task.failureDiagnostics &&
      !events.some(
        (event) =>
          event.payload.failureDiagnostics ||
          event.payload.requestFailureDiagnostics,
      )
    )
      continue;
    try {
      const diagnosticStore = await FileEvidenceStore.openExisting(
        join(request.evidenceRoot, 'evidence'),
      );
      await verifyChildTaskEvidence(
        {
          runId: request.runId,
          revision: request.revision,
          childStore,
          evidenceStore: diagnosticStore,
        },
        task,
      );
      if (!task.result) continue;
      const references = task.result.evidenceReferences ?? [];
      assert(
        references.length > 0,
        'Retained child result has no portable evidence.',
      );
      assert.equal(
        references.length,
        task.result.evidencePaths.length,
        'Worker evidence membership changed.',
      );
      const evidenceStore = await FileEvidenceStore.openExisting(
        join(request.evidenceRoot, 'evidence'),
      );
      for (const [index, reference] of references.entries()) {
        assert.equal(
          reference.runId,
          request.runId,
          'Worker evidence run changed.',
        );
        assert.equal(
          reference.revision,
          request.revision,
          'Worker evidence revision changed.',
        );
        await evidenceStore.verifyPortable(reference);
        const path: string = task.result.evidencePaths[index]!;
        await verifyEvidenceFile(
          path,
          join(request.evidenceRoot, 'workers', assignment.id),
          reference,
        );
      }
    } catch (error) {
      integrityIssues.push(
        `${assignment.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const pulse = await optional<{ nonce: string; at: number }>(
    join(request.evidenceRoot, 'heartbeat.json'),
  );
  const observed = await optional<{ nonce: string; pid: number }>(
    join(request.evidenceRoot, 'observed.json'),
  );
  const cancelled = workers.some(
    (worker) => worker.task.status === 'CANCELLED',
  );
  const settled = workers.every(
    (worker) => !['QUEUED', 'RUNNING'].includes(worker.task.status),
  );
  const drained =
    ended?.nonce === intent?.nonce && ended?.workersDrained === true;
  let state: DashboardSwarmSnapshot['state'] = 'PREPARED';
  let statusNote = 'Prepared workers must be bound to the task before launch.';
  if (retained) {
    state = 'COMPLETE';
    statusNote =
      'Worker findings are retained and require independent review; this is not task acceptance.';
  } else if (cancelled && settled && (!intent || drained)) {
    state = 'CANCELLED';
    statusNote =
      'Cancellation is confirmed and no owned worker process remains active; completed siblings remain retained.';
  } else if (drained) {
    state = 'FAILED';
    statusNote =
      ended?.error ??
      'Supervisor stopped with incomplete work. Inspect retained evidence before creating a new batch.';
  } else if (intent) {
    const fresh =
      pulse?.nonce === intent.nonce &&
      Date.now() - pulse.at < 5_000 &&
      pulse.at <= Date.now() + 5_000;
    if (fresh && observed?.nonce === intent.nonce && !ended) {
      state = 'RUNNING';
      statusNote = cancelled
        ? 'Cancellation is requested; waiting for the supervisor to confirm worker termination.'
        : 'The independent supervisor owns bounded worker execution.';
    } else if (
      (!observed || (observed.nonce === intent.nonce && !pulse)) &&
      Date.now() - intent.at < 5_000 &&
      intent.at <= Date.now() + 5_000
    ) {
      state = 'STARTING';
      statusNote =
        'Launch is reserved; awaiting the supervisor’s first heartbeat.';
    } else {
      state = 'RECOVERY_REQUIRED';
      statusNote =
        'Supervisor ownership is uncertain. Do not relaunch until prior worker absence is independently confirmed.';
    }
  }
  const integrityIssue =
    integrityIssues.length > 0
      ? `Retained worker evidence did not verify: ${integrityIssues.join('; ')}`.slice(
          0,
          4096,
        )
      : null;
  // Invalid findings cannot disable control of a healthy sibling. A lost
  // supervisor remains cancellable, but cancellation intent proves no absence.
  const canCancel = !settled || Boolean(intent && !drained && !retained);
  if (integrityIssue)
    statusNote = `${statusNote} ${integrityIssue}`.slice(0, 4096);
  return {
    runId: request.runId,
    revision: request.revision,
    groupId: manifest.groupId,
    state,
    workers,
    receipt: retained?.receipt ?? null,
    ...(ended?.diagnostics === undefined
      ? {}
      : { diagnostics: ended.diagnostics }),
    integrityIssue,
    canCancel,
    statusNote,
  };
}

/** The service must persist its TaskRun binding before calling this function. */
export async function startDashboardSwarm(
  handle: DashboardSwarmHandle,
): Promise<DashboardSwarmSnapshot> {
  const manifest = await load(handle);
  const root = manifest.request.evidenceRoot;
  // A retained launch intent is never automatically reclaimed: worker processes
  // can outlive a crashed supervisor and a PID by itself proves no ownership.
  if (await optional(join(root, 'intent.json')))
    return inspectDashboardSwarm(handle);
  assert.equal(
    await cleanHead(manifest.request.workspaceRoot),
    manifest.workspaceHead,
    'Swarm candidate revision changed.',
  );
  if (await optional(join(root, 'cancel.json')))
    return inspectDashboardSwarm(handle);
  const nonce = randomUUID();
  if (
    !(await publish(
      join(root, 'intent.json'),
      { nonce, at: Date.now(), manifestSha256: handle.manifestSha256 },
      true,
    ))
  )
    return inspectDashboardSwarm(handle);
  const log = await open(join(root, 'supervisor.log'), 'a', 0o600);
  try {
    const child = spawn(
      process.execPath,
      [
        '--import',
        '@swc-node/register/esm-register',
        script,
        '--supervise-swarm',
        handle.requestPath,
        handle.manifestSha256,
        nonce,
      ],
      {
        cwd: resolve(dirname(script), '..'),
        detached: process.platform !== 'win32',
        stdio: ['ignore', log.fd, log.fd],
        shell: false,
      },
    );
    await new Promise<void>((resolveSpawn, reject) => {
      child.once('spawn', resolveSpawn);
      child.once('error', reject);
    });
    child.unref();
  } catch (error) {
    await publish(join(root, 'ended.json'), {
      nonce,
      workersDrained: true,
      error: `Supervisor launch failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    throw error;
  } finally {
    await log.close();
  }
  return inspectDashboardSwarm(handle);
}

export async function cancelDashboardSwarm(
  handle: DashboardSwarmHandle,
): Promise<DashboardSwarmSnapshot> {
  const manifest = await load(handle);
  const store = await FileChildTaskStore.create(manifest.childStoreRoot);
  const group = await store.loadGroup(manifest.groupId);
  assert(group, 'Swarm group is missing.');
  // Persist cancellation of every member before notifying the supervisor.
  for (const taskId of group.taskIds)
    await store.cancel({
      taskId,
      actor: `dashboard:${manifest.taskId}`,
      idempotencyKey: `dashboard-cancel:${manifest.groupId}`,
    });
  await publish(join(manifest.request.evidenceRoot, 'cancel.json'), {
    groupId: manifest.groupId,
  });
  return inspectDashboardSwarm(handle);
}

async function supervise(
  handle: DashboardSwarmHandle,
  nonce: string,
): Promise<void> {
  const manifest = await load(handle);
  const { request } = manifest;
  const root = request.evidenceRoot;
  const intent = await optional<{ nonce: string; manifestSha256: string }>(
    join(root, 'intent.json'),
  );
  assert.equal(intent?.nonce, nonce, 'Supervisor launch nonce changed.');
  assert.equal(intent?.manifestSha256, handle.manifestSha256);
  assert(
    await publish(
      join(root, 'observed.json'),
      { nonce, pid: process.pid },
      true,
    ),
    'This launch already has an observed supervisor.',
  );
  const controller = new AbortController();
  const childStore = await FileChildTaskStore.create(manifest.childStoreRoot);
  const receiptStore = await FileParallelWorkerReceiptStore.create(
    join(root, 'receipts'),
  );
  const evidenceStore = await FileEvidenceStore.create(join(root, 'evidence'));
  const activeHandlers = new Set<Promise<unknown>>();
  const diagnostics: DashboardDiagnostic[] = [];
  let pollInFlight: Promise<void> | null = null;
  let pollFailure: unknown;
  const poll = async (): Promise<void> => {
    await heartbeat(root, nonce);
    if (await optional(join(root, 'cancel.json')))
      controller.abort('Swarm cancelled.');
  };
  await poll();
  const timer = setInterval(() => {
    if (pollInFlight) return;
    pollInFlight = poll()
      .catch((error) => {
        pollFailure = error;
        controller.abort(error);
      })
      .finally(() => {
        pollInFlight = null;
      });
  }, 250);
  const onInterrupt = (): void => {
    void cancelDashboardSwarm(handle).then(
      () => controller.abort('Supervisor interrupted.'),
      (error) => {
        pollFailure = error;
        controller.abort(error);
      },
    );
  };
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onInterrupt);
  let failure: string | null = null;
  try {
    assert.equal(
      await cleanHead(request.workspaceRoot),
      manifest.workspaceHead,
      'Swarm candidate revision changed.',
    );
    for (;;) {
      const result = await executeRestartableParallelWorkers({
        ...request,
        plan: manifest.plan,
        capabilities,
        childStore,
        receiptStore,
        evidenceStore,
        owner: `dashboard-supervisor:${nonce}`,
        leaseMs: 30_000,
        leaseRenewal: { intervalMs: 5_000 },
        retryPolicy: { maxAttempts: manifest.maxAttempts },
        handler: (assignment) => {
          const operation = (async () => {
            assert.equal(
              await cleanHead(request.workspaceRoot),
              manifest.workspaceHead,
              'Swarm candidate revision changed.',
            );
            const evidenceDirectory = join(
              root,
              'workers',
              assignment.id,
              randomUUID(),
            );
            const result = await runCodexExecWorker(assignment, {
              executable: request.executable,
              workspaceRoot: request.workspaceRoot,
              evidenceDirectory,
              timeoutMs: request.timeoutMs,
              outputLimitBytes: request.outputLimitBytes,
              finalResponseLimitBytes: request.finalResponseLimitBytes,
              signal: controller.signal,
            });
            let observed: {
              cancelled: boolean;
              timedOut: boolean;
              outputLimitExceeded: boolean;
              captureComplete?: boolean;
              error: string | null;
              exitCode: number | null;
            } | null = null;
            try {
              observed = JSON.parse(
                (
                  await readBoundedRecord(
                    join(evidenceDirectory, 'process.json'),
                  )
                ).toString(),
              );
            } catch {}
            if (
              !controller.signal.aborted &&
              (!observed ||
                observed.timedOut ||
                observed.outputLimitExceeded ||
                observed.captureComplete === false ||
                observed.error ||
                observed.exitCode !== 0)
            )
              throw new WorkerExecutionFailure(
                `Worker transport failed (exit=${observed?.exitCode ?? null}, timeout=${observed?.timedOut ?? false}, capture=${Boolean(observed && observed.captureComplete !== false)}).`,
                {
                  complete: Boolean(
                    observed && observed.captureComplete !== false,
                  ),
                  reason:
                    !observed || observed.captureComplete === false
                      ? 'Worker process diagnostic capture failed.'
                      : undefined,
                  evidence: result.evidencePaths.map((path) => ({
                    source: 'stream',
                    kind: 'other',
                    content: streamEvidenceFile(path, evidenceDirectory),
                  })),
                },
              );
            assert.equal(
              await cleanHead(request.workspaceRoot),
              manifest.workspaceHead,
              'Swarm candidate revision changed during investigation.',
            );
            return result;
          })();
          const tracked = operation.finally(() => {
            activeHandlers.delete(tracked);
          });
          activeHandlers.add(tracked);
          return tracked;
        },
        failureDiagnostics: { mode: 'required' },
        evidenceForAssignment: (_assignment, result) =>
          result.evidencePaths.map((path) => ({
            source: 'stream' as const,
            kind: 'other' as const,
            content: streamEvidenceFile(
              path,
              join(root, 'workers', _assignment.id),
            ),
          })),
      });
      if (pollFailure) throw pollFailure;
      if (
        result.receipt ||
        result.state === 'BLOCKED' ||
        controller.signal.aborted
      )
        break;
      // The runtime claims the next bounded wave; it alone owns child lifecycle.
      if (!result.pending.some((item) => item.reason === 'queued')) break;
    }
  } catch (error) {
    const diagnostic = await retainDashboardDiagnostic(
      evidenceStore,
      request.runId,
      request.revision,
      join(root, 'supervisor-failure.log'),
      'supervisor',
      error,
    );
    diagnostics.push(diagnostic);
    failure = diagnostic.summary;
    controller.abort(error);
  } finally {
    // A failed runtime Promise.all can leave sibling handlers active. Abort and
    // drain those owned adapters before recording process absence. An expired
    // child lease alone is never evidence that its process has stopped.
    if (activeHandlers.size > 0) controller.abort('Supervisor is stopping.');
    await Promise.allSettled([...activeHandlers]);
    clearInterval(timer);
    if (pollInFlight) await pollInFlight;
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onInterrupt);
    await publish(join(root, 'ended.json'), {
      nonce,
      error: failure,
      workersDrained: true,
      ...(diagnostics.length ? { diagnostics } : {}),
    });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === script &&
  process.argv[2] === '--supervise-swarm'
) {
  (async () => {
    assert(
      process.argv.length === 6,
      'This module is an internal dashboard supervisor.',
    );
    const requestPath = process.argv[3]!;
    const content = await readBoundedRecord(requestPath);
    const manifest = JSON.parse(content.toString()) as Manifest;
    const handle = handleFor(requestPath, manifest, process.argv[4]!);
    await supervise(handle, process.argv[5]!);
  })().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
