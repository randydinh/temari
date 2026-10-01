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
  type WorkerAssignment,
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
import {
  prepareDashboardImplementation,
  startDashboardImplementation,
  inspectDashboardImplementation,
  cancelDashboardImplementation,
  type DashboardImplementationHandle,
} from './dashboard-implementation.mjs';
import {
  parseWriteRunRequest,
  type WriteAssignment,
  type CommandSpec,
} from './run-codex-write-workers.mjs';
import { parseCodexWorkersRequest } from './run-codex-workers.mjs';
import {
  parsePlannerPolicy,
  prepareGoalPlan,
  startGoalPlan,
  inspectGoalPlan,
  materializeGoalPlan,
  type PlannerPolicy,
  type GoalPlanHandle,
  type GoalPlanSnapshot,
} from './dashboard-planner.mjs';
import {
  parseDashboardKnowledgeOptions,
  type DashboardKnowledgeOptions,
} from './dashboard-knowledge.mjs';
import type { ScheduledTaskInspection } from './dashboard-scheduler.mjs';

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
export interface DashboardImplementationPlan {
  id: string;
  title: string;
  description: string;
  assignments: WriteAssignment[];
  prepare: CommandSpec[];
  verify: CommandSpec[];
  reviewer: WorkerAssignment;
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
  implementation?: {
    executable: string;
    maxConcurrency: number;
    timeoutMs: number;
    plans: DashboardImplementationPlan[];
  };
  planning?: {
    executable: string;
    timeoutMs: number;
    policies: PlannerPolicy[];
  };
  scheduling?: { tickMs: number };
  knowledge?: DashboardKnowledgeOptions;
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
interface ImplementationPreparation {
  schema: 1;
  taskId: string;
  candidate: Candidate;
  planId: string;
  planTitle: string;
  planSha256: string;
  goal: string;
  handle: DashboardImplementationHandle;
  planning?: {
    handle: GoalPlanHandle;
    policySha256: string;
    proposalSha256: string;
  };
}
interface PlanningPreparation {
  schema: 1;
  taskId: string;
  handle: GoalPlanHandle;
}
function planningAdmissionId(snapshot: GoalPlanSnapshot): string {
  return `goal-${taskDigest([snapshot.taskId, snapshot.requestId, snapshot.proposalSha256, snapshot.policySha256, snapshot.candidate]).slice(0, 48)}`;
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

function boundedAssignment(
  value: unknown,
  role: 'implementer' | 'reviewer',
): void {
  const assignment = object(value);
  fields(assignment, ['id', 'role', 'required', 'brief']);
  id(assignment.id);
  assert.equal(assignment.role, role, `Expected a required ${role}.`);
  assert.equal(
    assignment.required,
    true,
    'Every coding and review assignment is required.',
  );
  const brief = object(assignment.brief);
  fields(brief, [
    'goal',
    'context',
    'scope',
    'acceptanceCriteria',
    'verificationCommand',
    'reportFormat',
    'forbiddenActions',
  ]);
  for (const key of ['goal', 'context', 'scope']) text(brief[key], 8192);
  for (const key of ['acceptanceCriteria', 'forbiddenActions']) {
    assert(
      Array.isArray(brief[key]) &&
        brief[key].length >= 1 &&
        brief[key].length <= 20,
      'Assignment criteria and boundaries must be bounded lists.',
    );
    for (const item of brief[key]) text(item, 2048);
  }
  assert.equal(
    brief.verificationCommand,
    null,
    'Coding plans select verification commands through the host configuration.',
  );
  assert.equal(brief.reportFormat, 'json');
}

async function validateImplementationConfig(
  value: unknown,
  workspaceRoot: string,
  preparationRoot: string,
): Promise<void> {
  const config = object(value);
  fields(config, ['executable', 'maxConcurrency', 'timeoutMs', 'plans']);
  text(config.executable);
  assert(
    isAbsolute(config.executable) && (await lstat(config.executable)).isFile(),
    'Implementation requires the installed Codex executable.',
  );
  assert(
    Number.isSafeInteger(config.maxConcurrency) &&
      config.maxConcurrency >= 1 &&
      config.maxConcurrency <= 4,
    'Coding concurrency must be from one to four.',
  );
  assert(
    Number.isSafeInteger(config.timeoutMs) &&
      config.timeoutMs >= 1000 &&
      config.timeoutMs <= 30 * 60 * 1000,
    'Invalid coding time bound.',
  );
  assert(
    Array.isArray(config.plans) && config.plans.length <= 20,
    'Configure at most twenty implementation plans.',
  );
  const seen = new Set<string>();
  for (const raw of config.plans) {
    const item = object(raw);
    fields(item, [
      'id',
      'title',
      'description',
      'assignments',
      'prepare',
      'verify',
      'reviewer',
    ]);
    id(item.id);
    text(item.title, 256);
    text(item.description, 4096);
    assert(!seen.has(item.id), 'Duplicate implementation plan.');
    seen.add(item.id);
    assert(
      Array.isArray(item.assignments) &&
        item.assignments.length >= 2 &&
        item.assignments.length <= 4,
      'Implementation plans require two to four implementers.',
    );
    for (const rawAssignment of item.assignments) {
      const assignment = object(rawAssignment);
      fields(assignment, ['worker', 'owns']);
      boundedAssignment(assignment.worker, 'implementer');
      assert(
        Array.isArray(assignment.owns) &&
          assignment.owns.length >= 1 &&
          assignment.owns.length <= 20,
        'Each implementer needs bounded ownership scopes.',
      );
      for (const rawScope of assignment.owns)
        fields(object(rawScope), ['kind', 'path']);
    }
    boundedAssignment(item.reviewer, 'reviewer');
    assert(
      !item.assignments.some(
        (assignment: WriteAssignment) =>
          assignment.worker.id === item.reviewer.id,
      ),
      'The independent reviewer needs a distinct identity.',
    );
    for (const key of ['prepare', 'verify']) {
      assert(
        Array.isArray(item[key]) &&
          item[key].length <= 10 &&
          (key !== 'verify' || item[key].length >= 1),
        'Implementation plans require bounded preparation and nonempty verification.',
      );
      for (const rawCommand of item[key]) {
        const command = object(rawCommand);
        fields(command, ['program', 'args', 'timeoutMs']);
        text(command.program);
        assert(
          isAbsolute(command.program) &&
            (await lstat(command.program)).isFile(),
          'Implementation commands require existing absolute executable paths.',
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
          'Invalid implementation command arguments.',
        );
        assert(
          Number.isSafeInteger(command.timeoutMs) &&
            command.timeoutMs >= 1 &&
            command.timeoutMs <= 30 * 60 * 1000,
          'Implementation commands require bounded timeouts.',
        );
      }
    }
    parseWriteRunRequest({
      runId: 'validate-coding-plan',
      sourceRepo: workspaceRoot,
      baseCommit: '0'.repeat(40),
      evidenceRoot: preparationRoot,
      maxConcurrency: Math.min(config.maxConcurrency, item.assignments.length),
      executable: config.executable,
      timeoutMs: config.timeoutMs,
      assignments: item.assignments,
      prepare: item.prepare,
      verify: item.verify,
    });
    parseCodexWorkersRequest({
      runId: 'validate-coding-review',
      revision: '0'.repeat(40),
      workspaceRoot,
      evidenceRoot: preparationRoot,
      maxConcurrency: 1,
      executable: config.executable,
      timeoutMs: config.timeoutMs,
      assignments: [item.reviewer],
    });
  }
}

export async function validateDashboardConfig(
  value: unknown,
): Promise<DashboardConfig> {
  const config = object(value);
  fields(
    config,
    ['schema', 'workspaceRoot', 'preparationRoot', 'recipes'],
    ['swarm', 'implementation', 'planning', 'scheduling', 'knowledge'],
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
  if (config.implementation !== undefined)
    await validateImplementationConfig(
      config.implementation,
      workspaceRoot,
      preparationRoot,
    );
  if (config.planning !== undefined) {
    assert(
      config.implementation,
      'Goal planning requires configured implementation limits.',
    );
    const planning = object(config.planning);
    fields(planning, ['executable', 'timeoutMs', 'policies']);
    assert(
      isAbsolute(planning.executable) &&
        (await lstat(planning.executable)).isFile(),
      'Planning requires an installed Codex executable.',
    );
    assert(
      Number.isSafeInteger(planning.timeoutMs) &&
        planning.timeoutMs >= 1000 &&
        planning.timeoutMs <= 300000,
      'Invalid planning time bound.',
    );
    assert(
      Array.isArray(planning.policies) &&
        planning.policies.length >= 1 &&
        planning.policies.length <= 20,
      'Configure one to twenty planning policies.',
    );
    planning.policies = planning.policies.map(parsePlannerPolicy);
    assert.equal(
      new Set(planning.policies.map((item: PlannerPolicy) => item.id)).size,
      planning.policies.length,
      'Duplicate planning policy.',
    );
  }
  if (config.scheduling !== undefined) {
    fields(object(config.scheduling), ['tickMs']);
    assert(
      Number.isSafeInteger(config.scheduling.tickMs) &&
        config.scheduling.tickMs >= 1000 &&
        config.scheduling.tickMs <= 60000,
      'Schedule ticks must be bounded from 1 to 60 seconds.',
    );
  }
  if (config.knowledge !== undefined)
    config.knowledge = parseDashboardKnowledgeOptions(config.knowledge);
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

/** Host-prepared local work. Native execution uses Archon; worker groups and
 * canonical acceptance remain owned by the existing runtime stores. */
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

  private async implementationPreparation(
    task: TaskSnapshot,
  ): Promise<ImplementationPreparation | null> {
    const run = task.runs.find((item) => item.runId === task.currentRunId);
    const ref = run?.sourceRefs?.find(
      (item) => item.sourceId === 'dashboard-implementation',
    );
    if (!run || !ref) return null;
    assert(
      within(this.options.config.preparationRoot, ref.location),
      'Implementation preparation lies outside configured storage.',
    );
    assert.equal(
      await realpath(ref.location),
      ref.location,
      'Implementation preparation resolution changed.',
    );
    const content = await bytes(ref.location);
    assert.equal(
      sha(content),
      ref.publicationId,
      'Implementation preparation changed.',
    );
    const prepared = JSON.parse(
      content.toString(),
    ) as ImplementationPreparation;
    assert.equal(prepared.schema, 1);
    assert.equal(prepared.taskId, task.taskId);
    assert.equal(prepared.goal, task.goal);
    assert(
      within(this.options.config.preparationRoot, prepared.handle.requestPath),
      'Implementation manifest lies outside configured storage.',
    );
    assert.equal(
      await realpath(prepared.handle.requestPath),
      prepared.handle.requestPath,
      'Implementation manifest resolution changed.',
    );
    const manifestBytes = await bytes(prepared.handle.requestPath);
    assert.equal(
      sha(manifestBytes),
      prepared.handle.manifestSha256,
      'Implementation manifest changed.',
    );
    const manifest = JSON.parse(manifestBytes.toString());
    assert.equal(manifest.taskId, task.taskId);
    assert.equal(manifest.request.runId, run.runId);
    assert.equal(manifest.request.revision, run.revision);
    assert.equal(manifest.request.workspaceRoot, task.workspaceRoot);
    assert.equal(prepared.candidate.head, run.revision);
    assert.equal(
      manifest.write.baseCommit,
      prepared.candidate.head,
      'Implementation source commit differs from the prepared candidate.',
    );
    assert.equal(manifest.write.sourceRepo, task.workspaceRoot);
    assert.equal(taskDigest(prepared.handle.plan), run.planSha256);
    assert.deepEqual(run.childRefs, [
      {
        storeRoot: prepared.handle.childStoreRoot,
        groupId: prepared.handle.groupId,
      },
      {
        storeRoot: prepared.handle.childStoreRoot,
        groupId: prepared.handle.reviewGroupId,
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
        [
          'recipeId',
          'title',
          'goal',
          'mode',
          'workerCount',
          'maxConcurrency',
          'planId',
          'policyId',
        ],
      );
      id(request.requestId);
      assert(
        request.mode === undefined ||
          request.mode === 'swarm' ||
          request.mode === 'implementation' ||
          request.mode === 'planning',
        'Unknown goal mode.',
      );
      if (request.mode === 'planning') return this.createPlanning(request);
      assert(
        request.policyId === undefined,
        'Planning policies require the planning route.',
      );
      if (request.mode === 'swarm') return this.createSwarm(request);
      if (request.mode === 'implementation')
        return this.createImplementation(request);
      assert(
        request.planId === undefined,
        'Implementation plans require the implementation route.',
      );
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

  private async planningPreparation(
    task: TaskSnapshot,
  ): Promise<PlanningPreparation | null> {
    const refs = task.events.flatMap((event) =>
      event.change.type === 'handoff-recorded'
        ? event.change.handoff.contextRefs.filter(
            (ref) => ref.kind === 'dashboard-goal-plan',
          )
        : [],
    );
    if (!refs.length) return null;
    const ref = refs[0]!;
    const path = join(
      this.options.config.preparationRoot,
      task.taskId,
      'planning.json',
    );
    assert.equal(
      ref.location,
      path,
      'Planner reference lies outside its task preparation.',
    );
    assert.equal(
      await realpath(path),
      path,
      'Planner reference resolution changed.',
    );
    const content = await bytes(path);
    assert.equal(sha(content), ref.sha256, 'Planner reference changed.');
    const prepared = JSON.parse(content.toString()) as PlanningPreparation;
    assert.equal(prepared.schema, 1);
    assert.equal(prepared.taskId, task.taskId);
    assert.equal(
      prepared.handle.requestPath,
      join(dirname(path), 'planning', 'request.json'),
    );
    const snapshot = await inspectGoalPlan(prepared.handle);
    assert.equal(snapshot.taskId, task.taskId);
    assert.equal(
      snapshot.goalSha256,
      taskDigest(task.goal),
      'Task goal changed since planning.',
    );
    return prepared;
  }

  private async createPlanning(
    request: Record<string, any>,
  ): Promise<TaskSnapshot> {
    fields(request, ['requestId', 'mode', 'policyId', 'title', 'goal']);
    id(request.policyId);
    text(request.title, 256);
    text(request.goal, 8192);
    const config = this.options.config.planning;
    assert(config, 'Goal planning is not configured.');
    const policy = config.policies.find(
      (entry) => entry.id === request.policyId,
    );
    assert(policy, 'Unknown planning policy.');
    const taskId = `task-${request.requestId}`;
    await this.options.store.createTask({
      taskId,
      title: request.title,
      goal: request.goal,
      workspaceRoot: this.options.config.workspaceRoot,
      actor,
      idempotencyKey: `intake-${request.requestId}`,
    });
    let task = await this.task(taskId);
    const prior = await this.planningPreparation(task);
    if (prior) {
      const snapshot = await inspectGoalPlan(prior.handle);
      assert.equal(
        snapshot.policySha256,
        taskDigest(policy),
        'Configured planning policy changed.',
      );
      // Exact retry may start a prepared draft, but never relaunch an uncertain call.
      if (snapshot.canStart) await startGoalPlan(prior.handle);
      return this.options.runtime.snapshot(taskId);
    }
    const directory = join(this.options.config.preparationRoot, taskId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    assert.equal(
      await realpath(directory),
      directory,
      'Planning storage resolution changed.',
    );
    const candidate = await cleanCandidate(task.workspaceRoot);
    const handle = await prepareGoalPlan({
      root: join(directory, 'planning'),
      taskId,
      requestId: request.requestId,
      goal: request.goal,
      workspaceRoot: task.workspaceRoot,
      candidate,
      policy,
      executable: config.executable,
      timeoutMs: config.timeoutMs,
    });
    const path = join(directory, 'planning.json');
    await publish(
      path,
      JSON.stringify({
        schema: 1,
        taskId,
        handle,
      } satisfies PlanningPreparation),
    );
    await this.options.store.handoffTask({
      taskId,
      actor,
      expectedVersion: task.version,
      idempotencyKey: `planning-${request.requestId}`,
      handoff: {
        summary:
          'Temari goal planning requested against a clean pinned candidate.',
        decisions: [
          `Host policy ${policy.id} bounds ownership, checks and independent review.`,
          'Planning is a read-only model call; proposal readiness is not execution or completion.',
        ],
        nextAction:
          'Review the validated proposal and prepare its parallel implementation.',
        blocker: null,
        contextRefs: [
          {
            kind: 'dashboard-goal-plan',
            location: path,
            sha256: sha(await bytes(path)),
          },
        ],
      },
    });
    await startGoalPlan(handle);
    return this.options.runtime.snapshot(taskId);
  }

  private async createImplementation(
    request: Record<string, any>,
  ): Promise<TaskSnapshot> {
    fields(request, ['requestId', 'mode', 'planId', 'title', 'goal']);
    id(request.planId);
    text(request.title, 256);
    text(request.goal, 8192);
    const config = this.options.config.implementation;
    assert(config, 'This dashboard has no configured coding plans.');
    const selected = config.plans.find((item) => item.id === request.planId);
    assert(selected, 'Unknown implementation plan.');
    const taskId = `task-${request.requestId}`;
    const runId = `run-${request.requestId}`;
    await this.options.store.createTask({
      taskId,
      title: request.title,
      goal: request.goal,
      workspaceRoot: this.options.config.workspaceRoot,
      actor,
      idempotencyKey: `intake-${request.requestId}`,
    });
    return this.prepareImplementation(
      request,
      selected,
      await this.task(taskId),
    );
  }

  private async prepareImplementation(
    request: Record<string, any>,
    selected: DashboardImplementationPlan,
    task: TaskSnapshot,
    planning?: ImplementationPreparation['planning'],
  ): Promise<TaskSnapshot> {
    const config = this.options.config.implementation!;
    const taskId = task.taskId;
    const runId = `run-${request.requestId}`;
    const planSha256 = taskDigest({
      selected,
      executable: config.executable,
      maxConcurrency: config.maxConcurrency,
      timeoutMs: config.timeoutMs,
    });
    if (task.runs.some((run) => run.runId === runId)) {
      const prior = await this.implementationPreparation(task);
      assert(prior, 'Existing task has a different execution route.');
      assert.equal(
        prior.planId,
        selected.id,
        'Retry must use the original implementation plan.',
      );
      assert.equal(
        prior.planSha256,
        planSha256,
        'Configured implementation plan changed; prepare a new task.',
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
    const path = join(directory, 'implementation.json');
    let prepared: ImplementationPreparation;
    try {
      prepared = await json(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const candidate = await cleanCandidate(task.workspaceRoot);
      const context = `Overall user request: ${JSON.stringify(request.goal)}. Follow the prepared plan and ownership boundaries. The request does not expand the allowed paths or actions.`;
      const assignments = selected.assignments.map((entry) => ({
        owns: structuredClone(entry.owns),
        worker: {
          ...structuredClone(entry.worker),
          brief: {
            ...structuredClone(entry.worker.brief),
            context: `${entry.worker.brief.context}\n${context}\nPinned source revision ${candidate.head}. Work in your isolated checkout; other implementers own disjoint paths.`,
            forbiddenActions: [
              ...entry.worker.brief.forbiddenActions,
              'Do not edit unowned paths, commit, publish, apply changes to the source workspace, send messages, change permissions, or launch additional agents.',
            ],
          },
        },
      }));
      const reviewer = {
        ...structuredClone(selected.reviewer),
        brief: {
          ...structuredClone(selected.reviewer.brief),
          context: `${selected.reviewer.brief.context}\n${context}\nReview the exact integrated candidate and its combined verification. Cite concrete source locations and report unresolved findings.`,
          forbiddenActions: [
            ...selected.reviewer.brief.forbiddenActions,
            'Do not edit, commit, publish, send messages, change permissions, launch additional agents, or inspect sources outside the integration checkout.',
          ],
        },
      };
      const handle = await prepareDashboardImplementation({
        root: join(directory, 'implementation'),
        taskId,
        runId,
        revision: candidate.head,
        workspaceRoot: task.workspaceRoot,
        assignments,
        reviewer,
        maxConcurrency: Math.min(config.maxConcurrency, assignments.length),
        executable: config.executable,
        timeoutMs: config.timeoutMs,
        prepare: structuredClone(selected.prepare),
        verify: structuredClone(selected.verify),
      });
      prepared = {
        schema: 1,
        taskId,
        candidate,
        planId: selected.id,
        planTitle: selected.title,
        planSha256,
        goal: request.goal,
        handle,
        ...(planning ? { planning } : {}),
      };
      await publish(path, JSON.stringify(prepared));
    }
    assert.equal(prepared.taskId, taskId);
    assert.equal(prepared.goal, request.goal, 'Retry request goal changed.');
    assert.equal(
      prepared.planSha256,
      planSha256,
      'Configured implementation plan changed; prepare a new task.',
    );
    const manifest = await json(prepared.handle.requestPath);
    assert.equal(
      sha(await bytes(prepared.handle.requestPath)),
      prepared.handle.manifestSha256,
      'Implementation manifest changed.',
    );
    assert.equal(manifest.request.runId, runId);
    assert.equal(manifest.request.revision, prepared.candidate.head);
    assert.equal(manifest.request.workspaceRoot, task.workspaceRoot);
    assert.equal(
      manifest.write.baseCommit,
      prepared.candidate.head,
      'Implementation source commit changed during preparation.',
    );
    await this.options.store.bindRun({
      taskId,
      actor,
      expectedVersion: task.version,
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
          {
            storeRoot: prepared.handle.childStoreRoot,
            groupId: prepared.handle.reviewGroupId,
          },
        ],
        sourceRefs: [
          {
            sourceId: 'dashboard-implementation',
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
        ['reason', 'nextAction', 'blocker', 'proposalSha256'],
      );
      id(request.requestId);
      assert(
        Number.isSafeInteger(request.expectedVersion) &&
          request.expectedVersion >= 1,
        'Expected task version is required.',
      );
      let task = await this.task(taskId);
      const goalPreparation =
        request.action === 'prepare-plan'
          ? await this.planningPreparation(task)
          : null;
      const goalSnapshot = goalPreparation
        ? await inspectGoalPlan(goalPreparation.handle)
        : null;
      const admissionId = goalSnapshot
        ? planningAdmissionId(goalSnapshot)
        : null;
      const command = {
        taskId,
        actor,
        expectedVersion: request.expectedVersion,
        idempotencyKey: `ui-${request.requestId}`,
      };
      const prior = task.events.find(
        (event) =>
          event.idempotencyKey === command.idempotencyKey ||
          (admissionId && event.idempotencyKey === `prepare-${admissionId}`),
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
        request.action === 'accept'
          ? ['reason']
          : request.action === 'prepare-plan'
            ? ['proposalSha256']
            : [],
      );
      if (
        request.action === 'planner-start' ||
        request.action === 'prepare-plan'
      ) {
        const prepared = await this.planningPreparation(task);
        assert(prepared, 'This task has no retained goal planner.');
        const snapshot = await inspectGoalPlan(prepared.handle);
        const policy = this.options.config.planning?.policies.find(
          (entry) => entry.id === snapshot.policyId,
        );
        assert(
          policy && taskDigest(policy) === snapshot.policySha256,
          'Configured planning policy changed; prepare a new goal.',
        );
        assert.equal(
          snapshot.goalSha256,
          taskDigest(task.goal),
          'Task goal changed since planning.',
        );
        if (request.action === 'planner-start') {
          assert(
            snapshot.canStart,
            'Planner call is already started or needs recovery.',
          );
          assert.deepEqual(
            await cleanCandidate(task.workspaceRoot),
            snapshot.candidate,
            'Workspace changed since planning.',
          );
          await startGoalPlan(prepared.handle);
          return this.options.runtime.snapshot(taskId);
        }
        assert.equal(
          request.proposalSha256,
          snapshot.proposalSha256,
          'Selected proposal changed; refresh before preparing it.',
        );
        const stableId = planningAdmissionId(snapshot);
        if (task.runs.some((entry) => entry.runId === `run-${stableId}`))
          return task;
        assert(
          !task.currentRunId,
          'A proposal implementation is already prepared on this task.',
        );
        const material = await materializeGoalPlan(
          policy,
          snapshot,
          await cleanCandidate(task.workspaceRoot),
        );
        return this.prepareImplementation(
          { requestId: stableId, title: task.title, goal: task.goal },
          {
            id: `goal-${policy.id}`,
            title: snapshot.proposal!.title,
            description: snapshot.proposal!.summary,
            assignments: structuredClone([...material.assignments]),
            prepare: structuredClone([...material.prepare]),
            verify: structuredClone([...material.verify]),
            reviewer: structuredClone(material.reviewer),
          },
          task,
          {
            handle: prepared.handle,
            policySha256: material.policySha256,
            proposalSha256: material.proposalSha256,
          },
        );
      }
      const implementation = await this.implementationPreparation(task);
      if (implementation) {
        const before = await inspectDashboardImplementation(
          implementation.handle,
        );
        const starting = request.action === 'implementation-start';
        assert(
          starting || request.action === 'implementation-cancel',
          'Coding results require coordinator review of the integrated candidate; serial evidence acceptance is unavailable for this route.',
        );
        if (starting) {
          assert(
            !before.integrityIssue,
            'Retained implementation evidence needs recovery before launch.',
          );
          assert.deepEqual(
            await cleanCandidate(task.workspaceRoot),
            implementation.candidate,
            'Workspace changed since preparation; prepare a new implementation.',
          );
          if (implementation.planning) {
            const snapshot = await inspectGoalPlan(
              implementation.planning.handle,
            );
            const policy = this.options.config.planning?.policies.find(
              (entry) => entry.id === snapshot.policyId,
            );
            assert(policy, 'Prepared goal policy is unavailable.');
            assert.equal(
              snapshot.goalSha256,
              taskDigest(task.goal),
              'Task goal changed since planning.',
            );
            const material = await materializeGoalPlan(
              policy,
              snapshot,
              implementation.candidate,
            );
            assert.equal(
              material.policySha256,
              implementation.planning.policySha256,
              'Prepared policy changed.',
            );
            assert.equal(
              material.proposalSha256,
              implementation.planning.proposalSha256,
              'Prepared proposal changed.',
            );
          }
        } else assert(before.canCancel, 'Implementation is already terminal.');
        await this.options.store.handoffTask({
          ...command,
          handoff: {
            summary: starting
              ? 'Isolated coding agents requested.'
              : 'Cancellation of the coding agents requested.',
            decisions: starting
              ? [
                  `Prepared plan ${implementation.planId} at ${implementation.candidate.head}; each implementer owns disjoint paths.`,
                  'Combined verification and an independent exact-commit review precede coordinator review. The integration candidate is retained separately.',
                ]
              : [
                  'Cancellation is complete only after all owned processes are observed to terminate.',
                ],
            nextAction: starting
              ? 'Follow the coding, integration and independent review; inspect the retained integration candidate before deciding the next engineering step.'
              : 'Observe termination and retain partial patches, verification and review evidence.',
            blocker: null,
            contextRefs: [
              {
                kind: 'implementation-request',
                location: implementation.handle.requestPath,
                sha256: implementation.handle.manifestSha256,
              },
            ],
          },
        });
        if (starting) await startDashboardImplementation(implementation.handle);
        else await cancelDashboardImplementation(implementation.handle);
        return this.options.runtime.snapshot(taskId);
      }
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

  /** Refresh only the exact scheduled execution; leave evidence acceptance to review. */
  async inspectScheduledTask(
    taskId: string,
    startRequestId?: string,
  ): Promise<ScheduledTaskInspection> {
    let task = await this.task(taskId);
    let run = task.runs.find((entry) => entry.runId === task.currentRunId);
    assert(run, 'Scheduled task has no prepared run.');
    let issue: string | null = null;
    if (
      run.nativeRef &&
      !run.operations.some((entry) => entry.state !== 'CONFIRMED') &&
      (!run.nativeSnapshot ||
        ['RUNNING', 'QUEUED', 'UNKNOWN'].includes(run.nativeSnapshot.status))
    ) {
      try {
        task = await this.action(taskId, {
          action: 'observe',
          requestId: `scheduled-observe-${task.version}`,
          expectedVersion: task.version,
        });
        run = task.runs.find((entry) => entry.runId === task.currentRunId)!;
      } catch (error) {
        issue = (error as Error).message;
        // Observation may be durable even when subsequent evidence projection fails.
        task = await this.task(taskId);
        run = task.runs.find((entry) => entry.runId === task.currentRunId)!;
      }
    }
    const exact = startRequestId
      ? run.operations.find(
          (entry) => entry.commandId === `ui-${startRequestId}`,
        )
      : null;
    const intent = exact
      ? exact.state === 'CONFIRMED'
        ? ('confirmed' as const)
        : ('pending' as const)
      : ('absent' as const);
    const unresolved = run.operations.some(
      (entry) => entry.state !== 'CONFIRMED',
    );
    let state: ScheduledTaskInspection['state'] = 'uncertain';
    let startAllowed = false;
    if (!unresolved) {
      if (run.nativeRef) {
        if (
          ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(
            run.nativeSnapshot?.status ?? '',
          )
        )
          state = 'terminal';
        else if (
          !issue &&
          ['RUNNING', 'QUEUED'].includes(run.nativeSnapshot?.status ?? '')
        )
          state = 'active';
      } else if (!run.operations.length) {
        state = 'prepared';
        try {
          const prepared = await this.preparation(task);
          startAllowed = Boolean(
            prepared &&
            taskDigest(await cleanCandidate(task.workspaceRoot)) ===
              taskDigest(prepared.candidate),
          );
        } catch (error) {
          issue = (error as Error).message;
        }
      }
    }
    return {
      taskId,
      version: task.version,
      state,
      startAllowed,
      intent,
      issue,
    };
  }

  async describe(): Promise<unknown> {
    const tasks = await this.options.runtime.listSnapshots();
    const controls: Record<string, unknown> = {};
    for (const task of tasks.filter(
      (item) => item.workspaceRoot === this.options.config.workspaceRoot,
    )) {
      try {
        const planned = await this.planningPreparation(task);
        const planning = planned ? await inspectGoalPlan(planned.handle) : null;
        const planningPolicy = planning
          ? this.options.config.planning?.policies.find(
              (entry) => entry.id === planning.policyId,
            )
          : null;
        const policyCurrent =
          !planning ||
          Boolean(
            planningPolicy &&
            taskDigest(planningPolicy) === planning.policySha256,
          );
        const implementation = await this.implementationPreparation(task);
        if (implementation) {
          const snapshot = await inspectDashboardImplementation(
            implementation.handle,
          );
          const actions = ['update'];
          let candidateCurrent = false;
          try {
            candidateCurrent =
              taskDigest(await cleanCandidate(task.workspaceRoot)) ===
              taskDigest(implementation.candidate);
          } catch {}
          if (
            snapshot.state === 'PREPARED' &&
            candidateCurrent &&
            !snapshot.integrityIssue &&
            policyCurrent
          )
            actions.push('implementation-start');
          if (snapshot.canCancel) actions.push('implementation-cancel');
          const manifest = await json(implementation.handle.requestPath);
          controls[task.taskId] = {
            actions,
            implementation: snapshot,
            ...(planning ? { planning, policyCurrent } : {}),
            planTitle: implementation.planTitle,
            limits: {
              maxConcurrency: manifest.request.maxConcurrency,
              timeoutMs: manifest.request.timeoutMs,
              totalWorkers: manifest.request.assignments.length,
            },
            candidateCurrent,
            progress: [],
            verifiedRevision: implementation.candidate.head,
            message: snapshot.statusNote,
          };
          continue;
        }
        if (planning) {
          let candidateCurrent = false;
          try {
            candidateCurrent =
              taskDigest(await cleanCandidate(task.workspaceRoot)) ===
              taskDigest(planning.candidate);
          } catch {}
          const actions = ['update'];
          if (candidateCurrent && policyCurrent && !planning.integrityIssue) {
            if (planning.canStart) actions.push('planner-start');
            if (planning.canPrepare && !task.currentRunId)
              actions.push('prepare-plan');
          }
          controls[task.taskId] = {
            actions,
            planning,
            policyCurrent,
            candidateCurrent,
            progress: [],
            verifiedRevision: planning.candidate.head,
            message: !policyCurrent
              ? 'Planning policy changed; create a new goal.'
              : !candidateCurrent
                ? 'Workspace changed since planning; create a new goal for the current candidate.'
                : planning.statusNote,
          };
          continue;
        }
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
      implementation: this.options.config.implementation
        ? {
            maxConcurrency: this.options.config.implementation.maxConcurrency,
            timeoutMs: this.options.config.implementation.timeoutMs,
            plans: this.options.config.implementation.plans.map((item) => ({
              id: item.id,
              title: item.title,
              description: item.description,
              assignments: item.assignments.map(({ worker, owns }) => ({
                id: worker.id,
                goal: worker.brief.goal,
                owns,
              })),
              verification: item.verify.map(({ program, args }) => ({
                program,
                args,
              })),
              reviewer: {
                id: item.reviewer.id,
                goal: item.reviewer.brief.goal,
              },
            })),
          }
        : null,
      planning: this.options.config.planning
        ? {
            timeoutMs: this.options.config.planning.timeoutMs,
            policies: this.options.config.planning.policies.map((entry) => ({
              id: entry.id,
              title: entry.title,
              description: entry.description,
              slots: entry.slots.map(
                ({ id, title, description, owns, mandatoryCriteria }) => ({
                  id,
                  title,
                  description,
                  owns,
                  mandatoryCriteria,
                }),
              ),
              verification: entry.verify.map(({ program, args }) => ({
                program,
                args,
              })),
              reviewer: {
                id: entry.reviewer.id,
                goal: entry.reviewer.brief.goal,
              },
            })),
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
