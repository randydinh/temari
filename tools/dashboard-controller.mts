import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  unlink,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import {
  DEFAULT_STAGES,
  minimalPlan,
  type HarnessRunRef,
} from '../libs/contracts/src/index.js';
import {
  FileTaskStore,
  FileEvidenceStore,
  FileWorkflowReceiptStore,
  verifyPersistedStageEvidence,
  TaskRuntime,
  taskDigest,
  type TaskSnapshot,
} from '../libs/runtime/src/index.js';
import type { TaskViewController } from './task-view.mjs';
import {
  prepareDashboardSwarm,
  startDashboardSwarm,
  inspectDashboardSwarm,
  cancelDashboardSwarm,
  type DashboardSwarmHandle,
} from './dashboard-swarm.mjs';

const runFile = promisify(execFile);
const sha = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');
const actor = 'dashboard-operator';
const plan = {
  ...minimalPlan('investigation'),
  evidence: 'revision-bound' as const,
  review: 'coordinator' as const,
};
type Command = {
  executable: string;
  args: string[];
  timeoutMs: number;
  summary: string;
};
export interface DashboardRecipe {
  id: string;
  title: string;
  goal: string;
  stages: Record<string, Command>;
}
export interface DashboardConfig {
  schema: 1;
  workspaceRoot: string;
  preparationRoot: string;
  recipes: DashboardRecipe[];
  swarm?: {
    executable: string;
    maxConcurrency: number;
    maxWorkers: number;
    timeoutMs: number;
  };
}
type Candidate = { head: string; fingerprint: string };
interface Preparation {
  schema: 1;
  taskId: string;
  runId: string;
  workspaceRoot: string;
  candidate: Candidate;
  recipe: DashboardRecipe;
  specPath: string;
  specSha256: string;
  bridgePath: string;
  bridgeSha256: string;
  finalizerPath: string;
  finalizerSha256: string;
}
interface SwarmPreparation {
  schema: 1;
  taskId: string;
  candidate: Candidate;
  handle: DashboardSwarmHandle;
}
export interface DashboardControllerOptions {
  config: DashboardConfig;
  store: FileTaskStore;
  runtime: TaskRuntime;
  bridgePath: string;
  finalizerPath: string;
  archonHome: string;
  readNative(reference: HarnessRunRef): Promise<Record<string, any>>;
}
function object(value: unknown): Record<string, any> {
  assert(
    value && typeof value === 'object' && !Array.isArray(value),
    'Expected a JSON object.',
  );
  return value as Record<string, any>;
}
function fields(
  value: Record<string, any>,
  required: string[],
  optional: string[] = [],
): void {
  assert(
    required.every((key) => Object.hasOwn(value, key)) &&
      Object.keys(value).every((key) =>
        [...required, ...optional].includes(key),
      ),
    'Unexpected or missing fields.',
  );
}
function text(value: unknown, max = 4096): asserts value is string {
  assert(
    typeof value === 'string' &&
      value.trim() &&
      value.length <= max &&
      !value.includes('\0'),
    'Expected bounded non-empty text.',
  );
}
function id(value: unknown, max = 96): asserts value is string {
  assert(
    typeof value === 'string' &&
      value.length <= max &&
      /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value),
    'Invalid request identity.',
  );
}
function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return (
    path === '' ||
    (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
  );
}
async function bytes(path: string, limit = 1024 * 1024): Promise<Buffer> {
  const info = await lstat(path);
  assert(
    info.isFile() && !info.isSymbolicLink() && info.size <= limit,
    'Expected a bounded regular file.',
  );
  const result = await readFile(path);
  assert(result.length <= limit, 'File exceeds the read limit.');
  return result;
}
async function json(path: string): Promise<any> {
  return JSON.parse((await bytes(path)).toString());
}
async function publish(path: string, content: string): Promise<void> {
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
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
      assert.equal(
        (await bytes(path)).toString(),
        content,
        'Prepared execution already exists with different content.',
      );
    }
    const directory = await open(dirname(path), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await unlink(temporary);
  }
}
async function cleanCandidate(root: string): Promise<Candidate> {
  const { stdout: top } = await runFile(
    'git',
    ['rev-parse', '--show-toplevel'],
    { cwd: root },
  );
  assert.equal(
    await realpath(top.trim()),
    root,
    'Select the Git workspace root.',
  );
  const { stdout: status } = await runFile(
    'git',
    ['status', '--porcelain', '--untracked-files=all'],
    { cwd: root },
  );
  assert.equal(
    status.trim(),
    '',
    'Workspace has uncommitted changes. Save a clean candidate before preparing or running verification.',
  );
  const { stdout: head } = await runFile('git', ['rev-parse', 'HEAD'], {
    cwd: root,
  });
  // The native canonical bridge fingerprints the tracked diff and untracked files.
  // Requiring both to be empty gives its exact clean-worktree fingerprint.
  return { head: head.trim(), fingerprint: sha('') };
}
export async function loadDashboardConfig(
  path: string,
): Promise<DashboardConfig> {
  assert(isAbsolute(path), 'Control configuration requires an absolute path.');
  return validateDashboardConfig(await json(path));
}
export async function validateDashboardConfig(
  value: unknown,
): Promise<DashboardConfig> {
  const config = object(value);
  fields(
    config,
    ['schema', 'workspaceRoot', 'preparationRoot', 'recipes'],
    ['swarm'],
  );
  assert.equal(config.schema, 1);
  for (const key of ['workspaceRoot', 'preparationRoot']) {
    text(config[key]);
    assert(isAbsolute(config[key]), `${key} must be absolute.`);
    assert((await lstat(config[key])).isDirectory(), `${key} must exist.`);
  }
  const workspaceRoot = await realpath(config.workspaceRoot);
  const preparationRoot = await realpath(config.preparationRoot);
  assert(
    !within(workspaceRoot, preparationRoot) &&
      !within(preparationRoot, workspaceRoot),
    'Workspace and preparations must be disjoint.',
  );
  assert(
    Array.isArray(config.recipes) && config.recipes.length <= 20,
    'At most 20 recipes are supported.',
  );
  const seen = new Set();
  if (config.swarm !== undefined) {
    const swarm = object(config.swarm);
    fields(swarm, ['executable', 'maxConcurrency', 'maxWorkers', 'timeoutMs']);
    assert(
      isAbsolute(swarm.executable) && (await lstat(swarm.executable)).isFile(),
      'Swarm requires the installed Codex executable.',
    );
    assert(
      Number.isSafeInteger(swarm.maxWorkers) &&
        swarm.maxWorkers >= 2 &&
        swarm.maxWorkers <= 4,
      'Swarm is limited to 2–4 workers.',
    );
    assert(
      Number.isSafeInteger(swarm.maxConcurrency) &&
        swarm.maxConcurrency >= 1 &&
        swarm.maxConcurrency <= swarm.maxWorkers,
      'Invalid swarm concurrency bound.',
    );
    assert(
      Number.isSafeInteger(swarm.timeoutMs) &&
        swarm.timeoutMs >= 1000 &&
        swarm.timeoutMs <= 30 * 60 * 1000,
      'Invalid swarm time bound.',
    );
  }
  for (const raw of config.recipes) {
    const recipe = object(raw);
    fields(recipe, ['id', 'title', 'goal', 'stages']);
    id(recipe.id);
    text(recipe.title, 256);
    text(recipe.goal, 8192);
    assert(!seen.has(recipe.id), 'Duplicate recipe.');
    seen.add(recipe.id);
    fields(object(recipe.stages), [...DEFAULT_STAGES]);
    for (const stage of DEFAULT_STAGES) {
      const command = object(recipe.stages[stage]);
      fields(command, ['executable', 'args', 'timeoutMs', 'summary']);
      text(command.executable);
      text(command.summary, 2048);
      assert(
        isAbsolute(command.executable) &&
          (await lstat(command.executable)).isFile(),
        'Recipe executable must be an existing absolute file.',
      );
      assert(
        Array.isArray(command.args) &&
          command.args.length <= 100 &&
          command.args.every(
            (arg: unknown) =>
              typeof arg === 'string' &&
              arg.length <= 8192 &&
              !arg.includes('\0'),
          ),
        'Invalid recipe arguments.',
      );
      assert(
        Number.isSafeInteger(command.timeoutMs) &&
          command.timeoutMs >= 1 &&
          command.timeoutMs <= 60_000,
        'Native verification stages have a 60 second bound.',
      );
    }
  }
  return structuredClone({
    ...config,
    workspaceRoot,
    preparationRoot,
  }) as DashboardConfig;
}

/** Goal intake and bounded, host-configured verification. Archon remains the
 * sole executor; TaskRuntime remains the only run-control/acceptance writer. */
export class DashboardController implements TaskViewController {
  constructor(private readonly options: DashboardControllerOptions) {}

  private async preparation(task: TaskSnapshot): Promise<Preparation | null> {
    const run = task.runs.find((item) => item.runId === task.currentRunId);
    const ref = run?.sourceRefs?.find(
      (item) => item.sourceId === 'dashboard-preparation',
    );
    if (!run || !ref) return null;
    assert(
      within(this.options.config.preparationRoot, ref.location),
      'Preparation lies outside configured storage.',
    );
    const content = await bytes(ref.location);
    assert.equal(
      sha(content),
      ref.publicationId,
      'Prepared execution changed.',
    );
    const prepared = JSON.parse(content.toString()) as Preparation;
    assert.equal(prepared.taskId, task.taskId);
    assert.equal(prepared.runId, run.runId);
    assert.equal(prepared.workspaceRoot, task.workspaceRoot);
    assert.equal(prepared.candidate.head, run.revision);
    assert.equal(taskDigest(run.plan), taskDigest(plan));
    assert.equal(
      sha(await bytes(prepared.specPath)),
      prepared.specSha256,
      'Prepared stage commands changed.',
    );
    assert.equal(
      sha(await bytes(prepared.bridgePath)),
      prepared.bridgeSha256,
      'Native evidence bridge changed.',
    );
    assert.equal(
      sha(await bytes(prepared.finalizerPath)),
      prepared.finalizerSha256,
      'Native finalizer changed.',
    );
    return prepared;
  }

  private async task(taskId: string): Promise<TaskSnapshot> {
    id(taskId, 128);
    const task = await this.options.runtime.snapshot(taskId);
    assert.equal(
      task.workspaceRoot,
      this.options.config.workspaceRoot,
      'Task is outside this dashboard workspace.',
    );
    return task;
  }

  private async swarmPreparation(
    task: TaskSnapshot,
  ): Promise<SwarmPreparation | null> {
    const run = task.runs.find((item) => item.runId === task.currentRunId);
    const ref = run?.sourceRefs?.find(
      (item) => item.sourceId === 'dashboard-swarm',
    );
    if (!run || !ref) return null;
    assert(
      within(this.options.config.preparationRoot, ref.location),
      'Swarm preparation lies outside configured storage.',
    );
    const content = await bytes(ref.location);
    assert.equal(sha(content), ref.publicationId, 'Swarm preparation changed.');
    const prepared = JSON.parse(content.toString()) as SwarmPreparation;
    assert.equal(prepared.taskId, task.taskId);
    const manifestBytes = await bytes(prepared.handle.requestPath);
    assert.equal(
      sha(manifestBytes),
      prepared.handle.manifestSha256,
      'Swarm manifest changed.',
    );
    const manifest = JSON.parse(manifestBytes.toString());
    assert.equal(manifest.taskId, task.taskId);
    assert.equal(manifest.request.runId, run.runId);
    assert.equal(manifest.request.revision, run.revision);
    assert.equal(manifest.request.workspaceRoot, task.workspaceRoot);
    assert.equal(prepared.candidate.head, run.revision);
    assert.equal(taskDigest(prepared.handle.plan), run.planSha256);
    assert.deepEqual(run.childRefs, [
      {
        storeRoot: prepared.handle.childStoreRoot,
        groupId: prepared.handle.groupId,
      },
    ]);
    return prepared;
  }

  async create(input: unknown): Promise<TaskSnapshot> {
    return this.checked(async () => {
      const request = object(input);
      fields(
        request,
        ['requestId'],
        ['recipeId', 'title', 'goal', 'mode', 'workerCount', 'maxConcurrency'],
      );
      id(request.requestId);
      assert(
        request.mode === undefined || request.mode === 'swarm',
        'Unknown goal mode.',
      );
      if (request.mode === 'swarm') return this.createSwarm(request);
      assert(
        request.workerCount === undefined &&
          request.maxConcurrency === undefined,
        'Worker limits require an investigation swarm.',
      );
      const recipe =
        request.recipeId === undefined
          ? null
          : this.options.config.recipes.find(
              (item) => item.id === request.recipeId,
            );
      assert(
        request.recipeId === undefined || recipe,
        'Unknown verification recipe.',
      );
      if (recipe)
        assert(
          request.title === undefined && request.goal === undefined,
          'A recipe has a fixed goal; general goals need their own plan.',
        );
      const title = recipe?.title ?? request.title;
      const goal = recipe?.goal ?? request.goal;
      text(title, 256);
      text(goal, 8192);
      const taskId = `task-${request.requestId}`;
      const runId = `run-${request.requestId}`;
      await this.options.store.createTask({
        taskId,
        title,
        goal,
        workspaceRoot: this.options.config.workspaceRoot,
        actor,
        idempotencyKey: `intake-${request.requestId}`,
      });
      if (!recipe) return this.options.runtime.snapshot(taskId);
      const task = await this.task(taskId);
      if (task.runs.some((run) => run.runId === runId)) return task;
      const directory = join(this.options.config.preparationRoot, taskId);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      assert.equal(
        await realpath(directory),
        directory,
        'Preparation directory resolution changed.',
      );
      const preparationPath = join(directory, 'preparation.json');
      let prepared: Preparation;
      try {
        prepared = await json(preparationPath);
        assert.equal(prepared.taskId, taskId);
        assert.equal(
          taskDigest(prepared.recipe),
          taskDigest(recipe),
          'Retry must use the original prepared recipe.',
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const candidate = await cleanCandidate(
          this.options.config.workspaceRoot,
        );
        const specPath = join(directory, 'spec.json');
        const spec = JSON.stringify({
          schema: 1,
          runId,
          revision: candidate.head,
          repositoryRoot: this.options.config.workspaceRoot,
          plan,
          stages: recipe.stages,
        });
        await publish(specPath, spec);
        prepared = {
          schema: 1,
          taskId,
          runId,
          workspaceRoot: this.options.config.workspaceRoot,
          candidate,
          recipe,
          specPath,
          specSha256: sha(spec),
          bridgePath: this.options.bridgePath,
          bridgeSha256: sha(await bytes(this.options.bridgePath)),
          finalizerPath: this.options.finalizerPath,
          finalizerSha256: sha(await bytes(this.options.finalizerPath)),
        };
        await publish(preparationPath, JSON.stringify(prepared));
      }
      await this.options.store.bindRun({
        taskId,
        runId,
        actor,
        idempotencyKey: `prepare-${request.requestId}`,
        expectedVersion: 1,
        run: {
          runId,
          revision: prepared.candidate.head,
          plan,
          sourceRefs: [
            {
              sourceId: 'dashboard-preparation',
              publicationId: sha(await bytes(preparationPath)),
              location: preparationPath,
            },
          ],
        },
      } as Parameters<FileTaskStore['bindRun']>[0]);
      return this.options.runtime.snapshot(taskId);
    });
  }

  private async createSwarm(
    request: Record<string, any>,
  ): Promise<TaskSnapshot> {
    fields(request, [
      'requestId',
      'mode',
      'title',
      'goal',
      'workerCount',
      'maxConcurrency',
    ]);
    const config = this.options.config.swarm;
    assert(config, 'This dashboard has no configured agent transport.');
    text(request.title, 256);
    text(request.goal, 8192);
    assert(
      Number.isSafeInteger(request.workerCount) &&
        request.workerCount >= 2 &&
        request.workerCount <= config.maxWorkers,
      'Worker count exceeds the configured bound.',
    );
    assert(
      Number.isSafeInteger(request.maxConcurrency) &&
        request.maxConcurrency >= 1 &&
        request.maxConcurrency <=
          Math.min(config.maxConcurrency, request.workerCount),
      'Concurrency exceeds the configured bound.',
    );
    const taskId = `task-${request.requestId}`;
    const runId = `run-${request.requestId}`;
    const goal = `Perform a read-only investigation of this request and return source-backed findings for Temari to review: ${request.goal}`;
    await this.options.store.createTask({
      taskId,
      title: request.title,
      goal,
      workspaceRoot: this.options.config.workspaceRoot,
      actor,
      idempotencyKey: `intake-${request.requestId}`,
    });
    const task = await this.task(taskId);
    if (task.runs.some((run) => run.runId === runId)) {
      const prior = await this.swarmPreparation(task);
      assert(prior);
      const manifest = await json(prior.handle.requestPath);
      assert.equal(
        manifest.request.assignments.length,
        request.workerCount,
        'Retry worker count changed.',
      );
      assert.equal(
        manifest.request.maxConcurrency,
        request.maxConcurrency,
        'Retry concurrency changed.',
      );
      return task;
    }
    const directory = join(this.options.config.preparationRoot, taskId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    assert.equal(
      await realpath(directory),
      directory,
      'Preparation directory resolution changed.',
    );
    const path = join(directory, 'swarm.json');
    let prepared: SwarmPreparation;
    try {
      prepared = await json(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const candidate = await cleanCandidate(task.workspaceRoot);
      const perspectives = [
        'Trace the relevant implementation and cite entry points, invariants, and current behavior.',
        'Independently challenge assumptions and identify concrete gaps, failure modes, and contrary evidence.',
        'Inspect verification coverage and identify the smallest meaningful checks for the requested behavior.',
        'Inspect integration boundaries and explain dependencies, compatibility risks, and unresolved questions.',
      ];
      const assignments = Array.from(
        { length: request.workerCount },
        (_, index) => ({
          id: `agent-${index + 1}`,
          role: index === 1 ? ('reviewer' as const) : ('investigator' as const),
          required: true,
          brief: {
            goal: request.goal,
            context: `Read-only investigation at revision ${candidate.head}. ${perspectives[index]}`,
            scope: task.workspaceRoot,
            acceptanceCriteria: [
              'Provide concrete source citations and separate observations from inference.',
              'Report unresolved gaps; do not claim the engineering request was implemented.',
            ],
            verificationCommand: null,
            reportFormat: 'json' as const,
            forbiddenActions: [
              'Do not edit files or run mutating commands.',
              'Do not publish, send messages, change permissions, spawn additional agents, or inspect sources outside the selected workspace.',
            ],
          },
        }),
      );
      const handle = await prepareDashboardSwarm({
        root: join(directory, 'workers'),
        taskId,
        runId,
        revision: candidate.head,
        workspaceRoot: task.workspaceRoot,
        assignments,
        maxConcurrency: request.maxConcurrency,
        executable: config.executable,
        timeoutMs: config.timeoutMs,
      });
      prepared = { schema: 1, taskId, candidate, handle };
      await publish(path, JSON.stringify(prepared));
    }
    assert.equal(prepared.taskId, taskId);
    const manifest = await json(prepared.handle.requestPath);
    assert.equal(manifest.request.runId, runId);
    assert.equal(
      manifest.request.assignments.length,
      request.workerCount,
      'Retry worker count changed.',
    );
    assert.equal(
      manifest.request.maxConcurrency,
      request.maxConcurrency,
      'Retry concurrency changed.',
    );
    await this.options.store.bindRun({
      taskId,
      actor,
      expectedVersion: 1,
      idempotencyKey: `prepare-${request.requestId}`,
      run: {
        runId,
        revision: prepared.candidate.head,
        plan: prepared.handle.plan,
        childRefs: [
          {
            storeRoot: prepared.handle.childStoreRoot,
            groupId: prepared.handle.groupId,
          },
        ],
        sourceRefs: [
          {
            sourceId: 'dashboard-swarm',
            publicationId: sha(await bytes(path)),
            location: path,
          },
        ],
      },
    });
    return this.options.runtime.snapshot(taskId);
  }

  private async native(
    task: TaskSnapshot,
    prepared: Preparation,
  ): Promise<{ record: Record<string, any>; directory: string | null }> {
    const run = task.runs.find((item) => item.runId === task.currentRunId)!;
    assert(run.nativeRef, 'No native run is bound.');
    const ref = run.nativeRef;
    const record = await this.nativeIdentity(task);
    if (typeof record.output_root !== 'string')
      return { record, directory: null };
    const root = await realpath(record.output_root);
    assert(
      within(await realpath(this.options.archonHome), root),
      'Native output lies outside the configured Archon home.',
    );
    return {
      record,
      directory: join(
        root,
        'artifacts',
        'runs',
        ref.externalRunId,
        'temari-nx-canonical',
      ),
    };
  }

  private async nativeIdentity(
    task: TaskSnapshot,
  ): Promise<Record<string, any>> {
    const run = task.runs.find((item) => item.runId === task.currentRunId)!;
    assert(run?.nativeRef, 'No native run is bound.');
    const ref = run.nativeRef;
    const record = await this.options.readNative(ref);
    assert.equal(record.id, ref.externalRunId, 'Native identity changed.');
    const { externalRunId: _external, startedAt: _started, ...binding } = ref;
    assert.equal(
      taskDigest(JSON.parse(record.metadata?.inputs?.temari_binding)),
      taskDigest(binding),
      'Native Temari binding changed.',
    );
    assert.equal(record.workflow_name, ref.entrypoint);
    assert.equal(await realpath(record.working_path), task.workspaceRoot);
    return record;
  }

  private async nativeEvidence(task: TaskSnapshot, prepared: Preparation) {
    const native = await this.native(task, prepared);
    assert(native.directory, 'Native evidence has not been published.');
    const binding = await json(join(native.directory, 'binding.json'));
    const run = task.runs.find((item) => item.runId === task.currentRunId)!;
    assert.equal(binding.nativeRunId, run.nativeRef!.externalRunId);
    assert.equal(binding.runId, run.runId);
    assert.equal(binding.revision, run.revision);
    assert.equal(binding.specSha256, prepared.specSha256);
    assert.equal(binding.planSha256, run.planSha256);
    assert.equal(binding.repositoryRoot, prepared.workspaceRoot);
    assert.deepEqual(
      binding.candidate,
      prepared.candidate,
      'Executed candidate differs from the prepared candidate.',
    );
    return { ...native, directory: native.directory, binding, run };
  }

  private async attach(
    task: TaskSnapshot,
    prepared: Preparation,
  ): Promise<TaskSnapshot> {
    const run = task.runs.find((item) => item.runId === task.currentRunId)!;
    if (run.receiptRoot || run.nativeSnapshot?.status !== 'SUCCEEDED')
      return task;
    const native = await this.completion(task, prepared);
    const receiptRoot = join(native.directory, 'receipts');
    await this.options.store.attachEvidenceRoots({
      taskId: task.taskId,
      runId: run.runId,
      actor,
      expectedVersion: task.version,
      idempotencyKey: `native-evidence-${run.runId}`,
      receiptRoot,
      evidenceRoot: join(native.directory, 'evidence'),
    });
    return this.options.runtime.snapshot(task.taskId);
  }

  private async completion(task: TaskSnapshot, prepared: Preparation) {
    const native = await this.nativeEvidence(task, prepared);
    const run = native.run;
    const marker = await json(join(native.directory, 'completion.json'));
    assert.equal(marker.nativeRunId, run.nativeRef!.externalRunId);
    assert.equal(marker.runId, run.runId);
    assert.equal(marker.revision, run.revision);
    const receiptRoot = join(native.directory, 'receipts');
    const receiptStore =
      await FileWorkflowReceiptStore.openExisting(receiptRoot);
    const receipt = await receiptStore.load(run.runId);
    assert(receipt, 'Native canonical receipt is missing.');
    assert.equal(
      marker.receiptSha256,
      taskDigest(receipt),
      'Native completion marker does not match the receipt.',
    );
    const verified = await verifyPersistedStageEvidence({
      runId: run.runId,
      revision: run.revision,
      store: receiptStore,
      evidenceStore: await FileEvidenceStore.openExisting(
        join(native.directory, 'evidence'),
      ),
    });
    for (const stage of DEFAULT_STAGES) {
      const pointer = await json(
        join(native.directory, 'stages', `${stage}.json`),
      );
      assert(
        typeof pointer.attempt === 'string' &&
          /^[a-f0-9-]{36}$/.test(pointer.attempt),
        'Invalid native stage pointer.',
      );
      const directory = join(native.directory, 'attempts', pointer.attempt);
      const capture = await json(join(directory, 'capture.json'));
      assert.equal(capture.attempt, pointer.attempt);
      assert.equal(capture.stage, stage);
      assert.equal(capture.summary, prepared.recipe.stages[stage].summary);
      assert.equal(capture.bindingSha256, taskDigest(native.binding));
      assert.deepEqual(capture.candidate, prepared.candidate);
      const stdout = await bytes(join(directory, 'stdout.bin'), 64 * 1024);
      const stderr = await bytes(join(directory, 'stderr.bin'), 64 * 1024);
      assert.equal(
        sha(stdout),
        capture.stdoutSha256,
        'Native stdout capture changed.',
      );
      assert.equal(
        sha(stderr),
        capture.stderrSha256,
        'Native stderr capture changed.',
      );
      const retained = verified.stages.find((item) => item.stage === stage)!;
      assert.deepEqual(
        retained.payloads.map(({ name, kind }) => [name, kind]),
        [
          ['stdout', 'stdout'],
          ['stderr', 'stderr'],
        ],
      );
      assert.deepEqual(
        Buffer.from(retained.payloads[0]!.content),
        stdout,
        'Canonical stdout differs from the native capture.',
      );
      assert.deepEqual(
        Buffer.from(retained.payloads[1]!.content),
        stderr,
        'Canonical stderr differs from the native capture.',
      );
    }
    return native;
  }

  async action(taskId: string, input: unknown): Promise<TaskSnapshot> {
    return this.checked(async () => {
      const request = object(input);
      fields(
        request,
        ['action', 'requestId', 'expectedVersion'],
        ['reason', 'nextAction', 'blocker'],
      );
      id(request.requestId);
      assert(
        Number.isSafeInteger(request.expectedVersion) &&
          request.expectedVersion >= 1,
        'Expected task version is required.',
      );
      let task = await this.task(taskId);
      const command = {
        taskId,
        actor,
        expectedVersion: request.expectedVersion,
        idempotencyKey: `ui-${request.requestId}`,
      };
      const prior = task.events.find(
        (event) => event.idempotencyKey === command.idempotencyKey,
      );
      if (!prior)
        assert.equal(
          task.version,
          request.expectedVersion,
          'Task version conflict; refresh before changing this task.',
        );
      if (request.action === 'update') {
        fields(
          request,
          ['action', 'requestId', 'expectedVersion'],
          ['nextAction', 'blocker'],
        );
        assert(
          Object.hasOwn(request, 'nextAction') ||
            Object.hasOwn(request, 'blocker'),
          'Select a field to update.',
        );
        assert(
          request.nextAction === undefined ||
            request.nextAction === null ||
            typeof request.nextAction === 'string',
        );
        assert(
          request.blocker === undefined ||
            request.blocker === null ||
            typeof request.blocker === 'string',
        );
        await this.options.store.updateTask({
          ...command,
          ...(Object.hasOwn(request, 'nextAction')
            ? { nextAction: request.nextAction }
            : {}),
          ...(Object.hasOwn(request, 'blocker')
            ? { blocker: request.blocker }
            : {}),
        });
        return this.options.runtime.snapshot(taskId);
      }
      fields(
        request,
        ['action', 'requestId', 'expectedVersion'],
        request.action === 'accept' ? ['reason'] : [],
      );
      const swarm = await this.swarmPreparation(task);
      if (swarm) {
        const before = await inspectDashboardSwarm(swarm.handle);
        if (request.action === 'swarm-start') {
          assert(
            !before.integrityIssue,
            'Retained worker evidence needs recovery before launch.',
          );
          assert.deepEqual(
            await cleanCandidate(task.workspaceRoot),
            swarm.candidate,
            'Workspace changed since preparation; prepare a new investigation.',
          );
          await this.options.store.handoffTask({
            ...command,
            handoff: {
              summary: 'Read-only investigation agents requested.',
              decisions: [
                `Bounded worker plan ${task.runs.at(-1)!.planSha256}; findings require coordinator review.`,
              ],
              nextAction:
                'Follow the agent results and review findings when the investigation completes.',
              blocker: null,
              contextRefs: [
                {
                  kind: 'swarm-request',
                  location: swarm.handle.requestPath,
                  sha256: swarm.handle.manifestSha256,
                },
              ],
            },
          });
          await startDashboardSwarm(swarm.handle);
        } else if (request.action === 'swarm-cancel') {
          assert(before.canCancel, 'Investigation is already terminal.');
          await this.options.store.handoffTask({
            ...command,
            handoff: {
              summary: 'Cancellation of the investigation agents requested.',
              decisions: [
                'Cancellation is complete only after worker process exits are observed.',
              ],
              nextAction:
                'Observe worker termination and retain partial findings.',
              blocker: null,
              contextRefs: [
                {
                  kind: 'swarm-request',
                  location: swarm.handle.requestPath,
                  sha256: swarm.handle.manifestSha256,
                },
              ],
            },
          });
          await cancelDashboardSwarm(swarm.handle);
        } else
          throw new Error(
            'Investigation results require coordinator review; serial evidence acceptance is unavailable for this route.',
          );
        return this.options.runtime.snapshot(taskId);
      }
      if (request.action === 'cancel' || request.action === 'observe') {
        const record = await this.nativeIdentity(task);
        const run = task.runs.find((item) => item.runId === task.currentRunId)!;
        const runCommand = { ...command, runId: run.runId };
        if (request.action === 'cancel')
          return this.options.runtime.cancel(runCommand);
        const statuses: Record<string, string> = {
          completed: 'SUCCEEDED',
          succeeded: 'SUCCEEDED',
          running: 'RUNNING',
          in_progress: 'RUNNING',
          pending: 'QUEUED',
          queued: 'QUEUED',
          cancelled: 'CANCELLED',
          canceled: 'CANCELLED',
          failed: 'FAILED',
          blocked: 'BLOCKED',
        };
        if (
          run.nativeSnapshot?.status !==
            statuses[String(record.status).toLowerCase()] ||
          run.operations.some((operation) => operation.state !== 'CONFIRMED')
        )
          task = await this.options.runtime.observeNative(runCommand);
        // A broken preparation must never remove exact-native recovery controls.
        // The read projection reports its integrity issue and refuses closeout.
        let prepared;
        try {
          prepared = await this.preparation(task);
        } catch {
          return task;
        }
        return prepared ? this.attach(task, prepared) : task;
      }
      const prepared = await this.preparation(task);
      assert(
        prepared,
        'Temari must prepare a supported execution plan for this goal.',
      );
      const runCommand = { ...command, runId: prepared.runId };
      if (['start', 'resume', 'verify', 'accept'].includes(request.action))
        assert.deepEqual(
          await cleanCandidate(task.workspaceRoot),
          prepared.candidate,
          'Workspace changed since preparation; create a new verification task for the current candidate.',
        );
      switch (request.action) {
        case 'start':
          return this.options.runtime.dispatch({
            ...runCommand,
            entrypoint: 'temari-nx-canonical',
            inputs: {
              bridge: prepared.bridgePath,
              finalizer: prepared.finalizerPath,
              spec: prepared.specPath,
            },
          });
        case 'resume':
          await this.nativeIdentity(task);
          return this.options.runtime.resume(runCommand);
        case 'verify':
          await this.completion(task, prepared);
          return this.options.runtime.verifyEvidence(runCommand);
        case 'accept':
          text(request.reason, 4096);
          await this.completion(task, prepared);
          return this.options.runtime.accept({
            ...runCommand,
            reason: request.reason,
          });
        default:
          throw new Error('Unknown dashboard action.');
      }
    });
  }

  async describe(): Promise<unknown> {
    const tasks = await this.options.runtime.listSnapshots();
    const controls: Record<string, unknown> = {};
    for (const task of tasks.filter(
      (item) => item.workspaceRoot === this.options.config.workspaceRoot,
    )) {
      try {
        const swarm = await this.swarmPreparation(task);
        if (swarm) {
          const snapshot = await inspectDashboardSwarm(swarm.handle);
          const actions = ['update'];
          let candidateCurrent = false;
          try {
            candidateCurrent =
              taskDigest(await cleanCandidate(task.workspaceRoot)) ===
              taskDigest(swarm.candidate);
          } catch {}
          if (
            snapshot.state === 'PREPARED' &&
            candidateCurrent &&
            !snapshot.integrityIssue
          )
            actions.push('swarm-start');
          if (snapshot.canCancel) actions.push('swarm-cancel');
          const manifest = await json(swarm.handle.requestPath);
          controls[task.taskId] = {
            actions,
            swarm: snapshot,
            limits: {
              maxConcurrency: manifest.request.maxConcurrency,
              timeoutMs: manifest.request.timeoutMs,
              totalWorkers: manifest.request.assignments.length,
            },
            candidateCurrent,
            progress: [],
            verifiedRevision: swarm.candidate.head,
            message: snapshot.statusNote,
          };
          continue;
        }
        const prepared = await this.preparation(task);
        if (!prepared) {
          controls[task.taskId] = {
            actions: ['update'],
            message: 'Goal saved. Temari needs to prepare an execution plan.',
            progress: [],
          };
          continue;
        }
        const run = task.runs.find((item) => item.runId === prepared.runId)!;
        const actions = ['update'];
        let candidateCurrent = false;
        try {
          candidateCurrent =
            taskDigest(await cleanCandidate(task.workspaceRoot)) ===
            taskDigest(prepared.candidate);
        } catch {}
        const pending = run.operations.some(
          (operation) => operation.state !== 'CONFIRMED',
        );
        if (!run.nativeRef && !run.operations.length && candidateCurrent)
          actions.push('start');
        if (run.nativeRef) {
          actions.push('observe');
          if (
            !pending &&
            ['RUNNING', 'QUEUED'].includes(run.nativeSnapshot?.status ?? '')
          )
            actions.push('cancel');
          if (
            !pending &&
            ['FAILED', 'BLOCKED'].includes(run.nativeSnapshot?.status ?? '') &&
            candidateCurrent
          )
            actions.push('resume');
          if (run.receiptRoot && candidateCurrent) actions.push('verify');
          if (
            !pending &&
            task.evidence.verified &&
            run.nativeSnapshot?.status === 'SUCCEEDED' &&
            !task.blocker &&
            task.status !== 'DONE' &&
            candidateCurrent
          )
            actions.push('accept');
        }
        const progress: Record<string, unknown>[] = [];
        let issue: string | null = null;
        if (run.nativeRef) {
          try {
            const native = await this.nativeEvidence(task, prepared);
            for (const stage of DEFAULT_STAGES) {
              let pointer;
              try {
                pointer = await json(
                  join(native.directory, 'stages', `${stage}.json`),
                );
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                  continue;
                throw error;
              }
              assert(
                typeof pointer.attempt === 'string' &&
                  /^[a-f0-9-]{36}$/.test(pointer.attempt),
                'Invalid native stage pointer.',
              );
              const directory = join(
                native.directory,
                'attempts',
                pointer.attempt,
              );
              const capture = await json(join(directory, 'capture.json'));
              assert.equal(capture.bindingSha256, taskDigest(native.binding));
              assert.equal(capture.stage, stage);
              const stdout = await bytes(
                join(directory, 'stdout.bin'),
                64 * 1024,
              );
              const stderr = await bytes(
                join(directory, 'stderr.bin'),
                64 * 1024,
              );
              assert.equal(sha(stdout), capture.stdoutSha256);
              assert.equal(sha(stderr), capture.stderrSha256);
              progress.push({
                stage,
                summary: capture.summary,
                completedAt: capture.completedAt,
                stdout: stdout.toString().slice(0, 12_000),
                stderr: stderr.toString().slice(0, 4000),
                outputTruncated: stdout.length > 12_000 || stderr.length > 4000,
              });
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
              issue = (error as Error).message;
          }
          if (run.nativeSnapshot?.status === 'SUCCEEDED') {
            try {
              await this.completion(task, prepared);
            } catch (error) {
              issue = (error as Error).message;
            }
          }
        }
        if (issue)
          for (const action of ['accept', 'verify', 'resume']) {
            const index = actions.indexOf(action);
            if (index !== -1) actions.splice(index, 1);
          }
        controls[task.taskId] = {
          actions,
          candidateCurrent,
          recipe: prepared.recipe.title,
          verifiedRevision: run.revision,
          progress,
          issue,
          message:
            pending && !run.nativeRef
              ? 'Dispatch needs recovery. Ask Temari to reconcile the exact native run using its retained identity. Starting another run is blocked.'
              : candidateCurrent
                ? 'Prepared local verification. Completion requires evidence verification and an explicit review.'
                : 'This execution belongs to an earlier or changed workspace. Create a new task to verify the current candidate.',
        };
      } catch (error) {
        const run = task.runs.find((item) => item.runId === task.currentRunId);
        const actions = run?.nativeRef ? ['observe'] : [];
        if (
          run?.nativeRef &&
          !run.operations.some(
            (operation) => operation.state !== 'CONFIRMED',
          ) &&
          ['RUNNING', 'QUEUED'].includes(run.nativeSnapshot?.status ?? '')
        )
          actions.push('cancel');
        controls[task.taskId] = {
          actions,
          issue: (error as Error).message,
          progress: [],
        };
      }
    }
    return {
      workspaceRoot: this.options.config.workspaceRoot,
      recipes: this.options.config.recipes.map(({ id, title, goal }) => ({
        id,
        title,
        goal,
      })),
      swarm: this.options.config.swarm
        ? {
            maxWorkers: this.options.config.swarm.maxWorkers,
            maxConcurrency: this.options.config.swarm.maxConcurrency,
            timeoutMs: this.options.config.swarm.timeoutMs,
          }
        : null,
      controls,
    };
  }

  private async checked<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failure = new Error(message) as Error & { status: number };
      failure.status =
        /conflict|changed|already|unresolved|pending|uncertain/i.test(message)
          ? 409
          : 400;
      throw failure;
    }
  }
}
