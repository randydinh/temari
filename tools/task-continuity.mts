import { readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { isAbsolute, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import {
  ArchonHarness,
  installArchonRuntime,
} from '../libs/archon-harness/src/index.js';
import {
  FileTaskStore,
  FileMergeReconciliationStore,
  TaskRuntime,
  taskDigest,
  type HarnessSelection,
} from '../libs/runtime/src/index.js';
import { platformInfo } from '../packages/initializer/src/lib/platform.js';
import { startTaskViewServer } from './task-view.mjs';
import {
  DashboardController,
  loadDashboardConfig,
} from './dashboard-controller.mjs';
import {
  MergeReconciliationDashboard,
  createObservedGitReconciliationBindingReader,
} from './merge-reconciliation-dashboard.mjs';
import { FileScheduleStore } from '../libs/runtime/src/lib/schedule-store.js';
import {
  createDashboardScheduler,
  type DashboardSchedulerTick,
} from './dashboard-scheduler.mjs';
import {
  inspectKnowledgeMap,
  selectKnowledgeMapNode,
  expandKnowledgeMap,
} from './dashboard-knowledge.mjs';

export const taskHelp = `Temari tasks — keep a goal and its evidence across runs

Usage: pnpm exec nx run runtime:tasks -- COMMAND [--root ABSOLUTE_DIRECTORY] [options]

Storage defaults to TEMARI_TASK_ROOT or the platform's Temari data directory
under tasks, so a fresh session can find the same work.

Commands:
  create      Create a logical task from --input JSON
  enter       Explicitly create/attach a task to a host conversation
  pickup      Read a bounded continuation brief or return task choices
  handoff     Save progress and the next action from --input JSON
  update      Record nextAction/blocker metadata from --input JSON
  bind        Attach an immutable plan and run binding from --input JSON
  link-evidence Attach receipt/evidence locations once the executor publishes them
  list        Show all retained task snapshots (JSON)
  show        Show one task with --task ID (JSON)
  start       Persist intent, then dispatch the bound run through Archon
  observe     Record the exact bound native run's current status
  reconcile   Bind an exact native reference after interrupted dispatch
  resume      Resume the exact bound run; requires --input command JSON
  cancel      Request cancellation of the exact bound native run
  verify      Verify the bound canonical receipt and stage evidence
  accept      Record explicit coordinator acceptance of eligible local work
  serve       Open the local task dashboard (read-only without --control-config)

Mutation commands require --input ABSOLUTE_JSON with taskId, actor and
idempotencyKey. All except create also require expectedVersion from show.
enter requires expectedVersion (0 for new), session:{host,sessionId}, and
create:{title,goal,workspaceRoot} only when creating a task.
pickup takes --task ID or --workspace ABSOLUTE_PATH, optionally paired
--host HOST --session ID and --limit 1..50 (default 20). It never resumes execution.
handoff carries handoff:{summary,decisions,nextAction,blocker,contextRefs}.
Context references are {kind,location,sha256?}; they do not verify source content.
Run commands require runId. create also requires title, goal, workspaceRoot.
bind carries run:{runId,revision,plan,receiptRoot?,evidenceRoot?,...}.
link-evidence carries runId, receiptRoot and evidenceRoot; those locations become
immutable once attached. Native output locations can be discovered after start.
start additionally carries entrypoint and inputs. reconcile carries reference.
accept carries reason; independent-review/forge routes need their own verifier.

Native controls and native-backed accept require --archon-home ABSOLUTE_DIRECTORY. This must name the
same Archon installation that owns the run. --workflow-source selects workflow
definitions for start; --archon-cache optionally selects the pinned binary cache.
serve accepts --port 3092 and --archon-url http://127.0.0.1:3091; configure the
console URL for that same installation. --control-config ABSOLUTE_JSON enables
goal intake and configured local verification controls; it requires --archon-home.
The trusted config fixes the workspace, preparation directory, and verification
recipes. Browser requests cannot supply executable commands or evidence paths.
Reconciliation controls are unavailable unless that config also supplies its
explicit reconciliation store, source, candidate, check, and comparison inputs.
See docs/task-continuity.md for full examples and recovery rules.
`;

function absolute(value: string | undefined, flag: string): string {
  if (!value || !isAbsolute(value))
    throw new Error(`${flag} requires an absolute path.`);
  return value;
}
async function inputFile(
  value: string | undefined,
): Promise<Record<string, unknown>> {
  const path = absolute(value, '--input');
  const info = await stat(path);
  if (!info.isFile() || info.size > 1024 * 1024)
    throw new Error(
      'Task command input must be a regular JSON file no larger than 1 MiB.',
    );
  const data: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new Error('Task command must be a JSON object.');
  return data as Record<string, unknown>;
}

/**
 * Reconciliation is deliberately opt-in: the dashboard receives no facade
 * until its host config supplies each trusted source. Browser payloads never
 * participate in the current binding.
 */
export async function createTaskContinuityReconciliationDashboard(
  config: Awaited<ReturnType<typeof loadDashboardConfig>>,
  runtime: TaskRuntime,
): Promise<MergeReconciliationDashboard | undefined> {
  const reconciliation = config.reconciliation;
  if (!reconciliation) return undefined;
  return new MergeReconciliationDashboard(
    await FileMergeReconciliationStore.create(reconciliation.storeRoot),
    createObservedGitReconciliationBindingReader({
      repositoryRoot: reconciliation.sourceRoot,
      snapshotReader: {
        async readCurrentSnapshot({ expected }) {
          const task = await runtime.snapshot(expected.taskId);
          if (task.workspaceRoot !== config.workspaceRoot) {
            throw new Error('Current reconciliation task is outside the configured workspace.');
          }
          const run = task.runs.find((item) => item.runId === task.currentRunId);
          if (!run) throw new Error('Current reconciliation task has no bound current run.');
          return {
            taskId: task.taskId,
            taskVersion: String(task.version),
            runId: run.runId,
            revision: run.revision,
            // This retained immutable ID has no mutable host equivalent.
            observationId: expected.observationId,
            candidateId: reconciliation.candidate.id,
            candidateSha256: reconciliation.candidate.sha256,
            candidateRoot: reconciliation.candidate.root,
            resolutionIntent: reconciliation.resolutionIntent,
            requiredChecks: reconciliation.requiredChecks,
            expectedComparison: reconciliation.expectedComparison,
          };
        },
      },
    }),
  );
}

/** CLI and optional local dashboard share the same runtime mutation boundary. */
export async function runTaskCommand(
  args: readonly string[],
): Promise<unknown> {
  const { positionals, values } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      root: { type: 'string' },
      input: { type: 'string' },
      task: { type: 'string' },
      workspace: { type: 'string' },
      host: { type: 'string' },
      session: { type: 'string' },
      limit: { type: 'string' },
      'archon-home': { type: 'string' },
      'archon-cache': { type: 'string' },
      'workflow-source': { type: 'string' },
      'archon-url': { type: 'string' },
      port: { type: 'string' },
      'control-config': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help || !positionals.length) return { help: taskHelp };
  const [command] = positionals;
  const supported = [
    'create',
    'enter',
    'pickup',
    'handoff',
    'update',
    'bind',
    'link-evidence',
    'list',
    'show',
    'start',
    'observe',
    'reconcile',
    'resume',
    'cancel',
    'verify',
    'accept',
    'serve',
  ];
  if (positionals.length !== 1 || !supported.includes(command!))
    throw new Error('Unknown task command. Use --help.');
  if (values['control-config'] && command !== 'serve')
    throw new Error('--control-config is only supported by serve.');
  const dashboardConfig = values['control-config']
    ? await loadDashboardConfig(
        absolute(values['control-config'], '--control-config'),
      )
    : null;
  const root = absolute(
    values.root ??
      process.env.TEMARI_TASK_ROOT ??
      resolve(platformInfo().dataDirectory, 'tasks'),
    '--root',
  );
  const store =
    command === 'create' ||
    command === 'enter' ||
    (command === 'serve' && dashboardConfig !== null)
      ? await FileTaskStore.create(root)
      : await FileTaskStore.openExisting(root);
  let selection: HarnessSelection | undefined;
  let nativeExecutable: string | undefined;
  if (
    ['start', 'observe', 'reconcile', 'resume', 'cancel'].includes(command!) ||
    (command === 'accept' && values['archon-home'] !== undefined) ||
    dashboardConfig !== null
  ) {
    const archonHome = absolute(values['archon-home'], '--archon-home');
    const cacheDirectory = values['archon-cache']
      ? absolute(values['archon-cache'], '--archon-cache')
      : platformInfo().cacheDirectory;
    const runtime = await installArchonRuntime({
      cacheDirectory,
      platform: process.platform,
      arch: process.arch,
    });
    nativeExecutable = runtime.executablePath;
    const harness = new ArchonHarness({
      runtime,
      environment: { ARCHON_HOME: archonHome },
      ...(values['workflow-source'] || dashboardConfig
        ? {
            workflowSource: values['workflow-source']
              ? absolute(values['workflow-source'], '--workflow-source')
              : resolve(
                  'packages/workflow-runtime/assets/v4.1/integrations/archon',
                ),
          }
        : {}),
    });
    await harness.verifyRuntime();
    selection = {
      hostHarness: null,
      configuredHarness: null,
      managedDefault: harness,
    };
  }
  const runtime = new TaskRuntime({
    store,
    ...(selection ? { selection } : {}),
  });
  if (command === 'pickup') {
    if ((values.host === undefined) !== (values.session === undefined))
      throw new Error('pickup requires --host and --session together.');
    return runtime.pickup({
      ...(values.task ? { taskId: values.task } : {}),
      ...(values.workspace
        ? { workspaceRoot: absolute(values.workspace, '--workspace') }
        : {}),
      ...(values.host !== undefined
        ? { session: { host: values.host, sessionId: values.session! } }
        : {}),
      ...(values.limit !== undefined ? { limit: Number(values.limit) } : {}),
    });
  }
  if (command === 'list') return runtime.listSnapshots();
  if (command === 'show') {
    if (!values.task) throw new Error('show requires --task ID.');
    return runtime.snapshot(values.task);
  }
  if (command === 'serve') {
    const reconciliation = dashboardConfig
      ? await createTaskContinuityReconciliationDashboard(dashboardConfig, runtime)
      : undefined;
    const controller = dashboardConfig
      ? new DashboardController({
          config: dashboardConfig,
          store,
          runtime,
          archonHome: absolute(values['archon-home'], '--archon-home'),
          bridgePath: resolve(
            'packages/workflow-runtime/assets/v4.1/integrations/archon/canonical-bridge.ts',
          ),
          finalizerPath: resolve(
            'libs/archon-harness/src/lib/canonical-finalize.ts',
          ),
          ...(reconciliation ? { reconciliation } : {}),
          readNative: async (reference) => {
            const result = await promisify(execFile)(
              nativeExecutable!,
              ['workflow', 'get', reference.externalRunId, '--json'],
              {
                cwd: reference.workspaceRoot,
                env: { ...process.env, ARCHON_HOME: values['archon-home'] },
                timeout: 15_000,
                maxBuffer: 2 * 1024 * 1024,
              },
            );
            return JSON.parse(result.stdout);
          },
        })
      : undefined;
    const scheduler =
      controller && dashboardConfig?.scheduling
        ? createDashboardScheduler({
            store: await FileScheduleStore.create(
              join(dashboardConfig.preparationRoot, 'schedules'),
              dashboardConfig.workspaceRoot,
            ),
            dispatcher: {
              describeTargets: async () =>
                dashboardConfig.recipes.map((recipe) => ({
                  id: recipe.id,
                  title: recipe.title,
                  goal: recipe.goal,
                  pin: taskDigest(recipe),
                })),
              create: (input) => controller.create(input),
              inspect: (taskId, startRequestId) =>
                controller.inspectScheduledTask(taskId, startRequestId),
              start: (taskId, input) =>
                controller.action(taskId, { action: 'start', ...input }),
            },
          })
        : undefined;
    let lastTick: DashboardSchedulerTick | null = null;
    let clockIssue: string | null = null;
    const tick = async () => {
      try {
        lastTick = await scheduler!.tick();
        clockIssue = null;
      } catch (error) {
        clockIssue = error instanceof Error ? error.message : String(error);
      }
    };
    if (scheduler) await tick();
    let clock: ReturnType<typeof setInterval> | null = null;
    const server = await startTaskViewServer({
      runtime,
      ...(controller ? { controller } : {}),
      ...(scheduler
        ? {
            schedules: {
              describe: async () => ({
                ...((await scheduler.describe()) as Record<string, unknown>),
                configured: true,
                lastTickAt: lastTick?.at ?? null,
                issues: lastTick?.issues ?? [],
                issue: clockIssue,
                tickMs: dashboardConfig!.scheduling!.tickMs,
              }),
              create: (input: unknown) => scheduler.create(input),
              update: (id: string, input: unknown) =>
                scheduler.update(id, input),
            },
          }
        : {}),
      ...(dashboardConfig?.knowledge
        ? {
            knowledge: {
              inspect: () => inspectKnowledgeMap(dashboardConfig.knowledge!),
              select: (nodeId: string) =>
                selectKnowledgeMapNode(dashboardConfig.knowledge!, nodeId),
              expand: (nodeId: string) =>
                expandKnowledgeMap(dashboardConfig.knowledge!, nodeId),
            },
          }
        : {}),
      archonBaseUrl: values['archon-url'] ?? 'http://127.0.0.1:3091',
      port: values.port ? Number(values.port) : 3092,
    });
    if (scheduler)
      clock = setInterval(() => {
        void tick();
      }, dashboardConfig!.scheduling!.tickMs);
    for (const signal of ['SIGINT', 'SIGTERM'] as const)
      process.once(signal, () => {
        if (clock) clearInterval(clock);
        server.closeAllConnections();
        server.close();
      });
    server.once('close', () => {
      if (clock) clearInterval(clock);
    });
    const port = (server.address() as { port: number }).port;
    return {
      url: `http://127.0.0.1:${port}`,
      root,
      mode: controller ? 'writable' : 'read-only',
    };
  }
  const input = await inputFile(values.input);
  // Runtime validators own payload shape and durable invariants; the CLI adds
  // neither status shortcuts nor implicit actor/version/idempotency values.
  switch (command) {
    case 'enter':
      return store.enterTask(
        input as unknown as Parameters<FileTaskStore['enterTask']>[0],
      );
    case 'handoff':
      return store.handoffTask(
        input as unknown as Parameters<FileTaskStore['handoffTask']>[0],
      );
    case 'create':
      return store.createTask(
        input as unknown as Parameters<FileTaskStore['createTask']>[0],
      );
    case 'update':
      return store.updateTask(
        input as unknown as Parameters<FileTaskStore['updateTask']>[0],
      );
    case 'bind':
      return store.bindRun(
        input as unknown as Parameters<FileTaskStore['bindRun']>[0],
      );
    case 'link-evidence':
      return store.attachEvidenceRoots(
        input as unknown as Parameters<FileTaskStore['attachEvidenceRoots']>[0],
      );
    case 'start':
      return runtime.dispatch(
        input as unknown as Parameters<TaskRuntime['dispatch']>[0],
      );
    case 'observe':
      return runtime.observeNative(
        input as unknown as Parameters<TaskRuntime['observeNative']>[0],
      );
    case 'reconcile':
      return runtime.reconcileNative(
        input as unknown as Parameters<TaskRuntime['reconcileNative']>[0],
      );
    case 'resume':
      return runtime.resume(
        input as unknown as Parameters<TaskRuntime['resume']>[0],
      );
    case 'cancel':
      return runtime.cancel(
        input as unknown as Parameters<TaskRuntime['cancel']>[0],
      );
    case 'verify':
      return runtime.verifyEvidence(
        input as unknown as Parameters<TaskRuntime['verifyEvidence']>[0],
      );
    case 'accept':
      return runtime.accept(
        input as unknown as Parameters<TaskRuntime['accept']>[0],
      );
    default:
      throw new Error('Unhandled task command.');
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const result = await runTaskCommand(process.argv.slice(2));
    console.log(
      result && typeof result === 'object' && 'help' in result
        ? result.help
        : JSON.stringify(result, null, 2),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
