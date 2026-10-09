import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { loadDashboardConfig } from '../../../tools/dashboard-controller.mjs';

interface InstalledProfile {
  readonly schema: 1;
  readonly id: string;
  readonly archonHome: string;
  readonly port: number;
  readonly archonUrl?: string;
  readonly control: unknown;
}
interface RuntimeState {
  readonly schema: 1;
  readonly pid: number;
  readonly url: string;
  readonly profileId: string;
  readonly profileSha256: string;
  readonly startedAt: string;
}
interface LifecycleHost {
  readonly executablePath: string;
  readonly managedWorkflowSource: string;
  readonly runTaskCommand: (args: readonly string[]) => Promise<unknown>;
}

const commands = new Set([
  'configure',
  'start',
  'status',
  'stop',
  'doctor',
  'apply',
  'closeout',
  '_serve',
]);
const lifecycleHelp = `Temari dashboard

  configure --profile ABSOLUTE_JSON [--home ABSOLUTE_DIRECTORY]
  start [--home ABSOLUTE_DIRECTORY]
  status [--home ABSOLUTE_DIRECTORY]
  stop [--home ABSOLUTE_DIRECTORY]
  doctor [--home ABSOLUTE_DIRECTORY]
  apply --task ID [--home ABSOLUTE_DIRECTORY]
  closeout --task ID [--home ABSOLUTE_DIRECTORY]

Other commands use the durable task CLI. Run a task command with --help for its
input contract. Candidate application and closeout require a stopped dashboard.
`;
const runFile = promisify(execFile);
const digest = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');
const safeId = (value: string) =>
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
const home = () =>
  resolve(
    process.env.TEMARI_DASHBOARD_HOME ??
      join(homedir(), 'Library', 'Application Support', 'Temari', 'dashboard'),
  );
const profilePath = (root: string) => join(root, 'active-profile.json');
const runtimePath = (root: string) => join(root, 'runtime.json');
const controlPath = (root: string) => join(root, 'control.json');

async function atomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  await rename(temporary, path);
}
async function immutable(path: string, value: unknown): Promise<void> {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  try {
    await writeFile(path, bytes, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    assert.equal(
      await readFile(path, 'utf8'),
      bytes,
      `${path} changed after it was retained.`,
    );
  }
}
function exact(
  value: unknown,
  required: string[],
  optional: string[] = [],
): asserts value is Record<string, unknown> {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(
    Object.keys(value).sort(),
    [...required, ...optional].filter((key) => key in value).sort(),
  );
  for (const key of required)
    assert(key in value, `Missing profile field ${key}.`);
}
async function readProfile(
  root: string,
): Promise<{ profile: InstalledProfile; bytes: string }> {
  const bytes = await readFile(profilePath(root), 'utf8');
  const value: unknown = JSON.parse(bytes);
  validateProfile(value);
  return { profile: value as unknown as InstalledProfile, bytes };
}
function validateProfile(value: unknown): asserts value is InstalledProfile {
  exact(
    value,
    ['schema', 'id', 'archonHome', 'port', 'control'],
    ['archonUrl'],
  );
  assert.equal(value.schema, 1);
  assert(typeof value.id === 'string' && safeId(value.id));
  assert(typeof value.archonHome === 'string' && isAbsolute(value.archonHome));
  assert(
    Number.isInteger(value.port) &&
      Number(value.port) >= 0 &&
      Number(value.port) <= 65535,
  );
  if ('archonUrl' in value) assert(typeof value.archonUrl === 'string');
}
async function alive(pid: number): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function readRuntime(root: string): Promise<RuntimeState | null> {
  try {
    return JSON.parse(
      await readFile(runtimePath(root), 'utf8'),
    ) as RuntimeState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
async function health(state: RuntimeState): Promise<boolean> {
  try {
    const response = await fetch(new URL('/api/dashboard', state.url), {
      signal: AbortSignal.timeout(1000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
async function materializeControl(
  source: Record<string, unknown>,
  host: LifecycleHost,
): Promise<Record<string, unknown>> {
  const control = structuredClone(source.control) as Record<string, any>;
  const managed = control.managedCandidate as Record<string, any> | undefined;
  if (!managed || managed.bridge !== 'packaged') return control;
  assert(!('bridgePath' in managed) && !('bridgeSha256' in managed));
  const bridgePath = join(
    host.managedWorkflowSource,
    'reviewed-local-candidate.mjs',
  );
  const bridgeSha256 = digest(await readFile(bridgePath));
  assert(Array.isArray(managed.protectedInputs));
  delete managed.bridge;
  managed.bridgePath = bridgePath;
  managed.bridgeSha256 = bridgeSha256;
  managed.protectedInputs = [
    ...managed.protectedInputs.filter((item: any) => item?.path !== bridgePath),
    { path: bridgePath, sha256: bridgeSha256 },
  ];
  return control;
}
async function configure(
  path: string,
  root: string,
  host: LifecycleHost,
): Promise<unknown> {
  assert(isAbsolute(path), '--profile requires an absolute path.');
  const source = JSON.parse(await readFile(path, 'utf8')) as unknown;
  exact(
    source,
    ['schema', 'id', 'archonHome', 'port', 'control'],
    ['archonUrl'],
  );
  const control = await materializeControl(source, host);
  const installedSource = { ...source, control };
  validateProfile(installedSource);
  await mkdir(root, { recursive: true });
  await mkdir(join(root, 'tasks'), { recursive: true });
  await mkdir(join(root, 'logs'), { recursive: true });
  await mkdir(join(root, 'cache'), { recursive: true });
  const validationPath = `${controlPath(root)}.${process.pid}.validate`;
  try {
    await writeFile(validationPath, `${JSON.stringify(control, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    await loadDashboardConfig(validationPath);
  } finally {
    await rm(validationPath, { force: true });
  }
  await realpath(installedSource.archonHome);
  await atomic(controlPath(root), control);
  await atomic(profilePath(root), installedSource);
  return { status: 'configured', profileId: installedSource.id, home: root };
}
async function status(root: string): Promise<unknown> {
  const state = await readRuntime(root);
  if (!state) return { status: 'stopped', home: root };
  const processAlive = await alive(state.pid);
  const healthy = processAlive && (await health(state));
  return {
    status: healthy ? 'running' : processAlive ? 'starting' : 'stale',
    healthy,
    ...state,
  };
}
async function start(root: string, host: LifecycleHost): Promise<unknown> {
  const current = await readRuntime(root);
  if (current && (await alive(current.pid))) {
    if (await health(current))
      return { status: 'running', reused: true, ...current };
    throw new Error(
      'Dashboard process exists but is not healthy. Run stop before retrying.',
    );
  }
  if (current) await rm(runtimePath(root), { force: true });
  await readProfile(root);
  await access(host.executablePath, constants.R_OK);
  const log = await open(join(root, 'logs', 'dashboard.log'), 'a', 0o600);
  const child = spawn(
    process.execPath,
    [host.executablePath, '_serve', '--home', root],
    {
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
      env: { ...process.env, TEMARI_DASHBOARD_HOME: root },
    },
  );
  child.unref();
  await log.close();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const state = await readRuntime(root);
    if (state && state.pid === child.pid && (await health(state)))
      return { status: 'running', reused: false, ...state };
    if (!(await alive(child.pid!))) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (await alive(child.pid!)) child.kill('SIGTERM');
  const state = await readRuntime(root);
  if (state?.pid === child.pid) await rm(runtimePath(root), { force: true });
  throw new Error(
    `Dashboard did not become healthy. Inspect ${join(root, 'logs', 'dashboard.log')}.`,
  );
}
async function stop(root: string): Promise<unknown> {
  const state = await readRuntime(root);
  if (!state) return { status: 'stopped', changed: false };
  if (await alive(state.pid)) process.kill(state.pid, 'SIGTERM');
  const deadline = Date.now() + 10_000;
  while ((await alive(state.pid)) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 100));
  if (await alive(state.pid))
    throw new Error('Dashboard did not stop within 10 seconds.');
  await rm(runtimePath(root), { force: true });
  return { status: 'stopped', changed: true };
}
async function doctor(root: string, host: LifecycleHost): Promise<unknown> {
  const checks: { id: string; status: 'PASS' | 'FAIL'; detail: string }[] = [];
  const check = async (id: string, action: () => Promise<string>) => {
    try {
      checks.push({ id, status: 'PASS', detail: await action() });
    } catch (error) {
      checks.push({ id, status: 'FAIL', detail: (error as Error).message });
    }
  };
  await check('profile', async () => (await readProfile(root)).profile.id);
  await check('control', async () => {
    await loadDashboardConfig(controlPath(root));
    return 'valid';
  });
  await check('managed-workflow', async () => {
    const paths = [
      join(host.managedWorkflowSource, 'reviewed-local-candidate.mjs'),
      join(host.managedWorkflowSource, 'managed-candidate-operation.mjs'),
      join(host.managedWorkflowSource, 'dashboard-planner.mjs'),
      join(host.managedWorkflowSource, 'owned-process', 'guardian.mjs'),
      join(host.managedWorkflowSource, 'owned-process', 'anchor.mjs'),
      join(
        host.managedWorkflowSource,
        '.archon',
        'workflows',
        'temari-reviewed-local-candidate.yaml',
      ),
    ];
    for (const path of paths) await access(path, constants.R_OK);
    return host.managedWorkflowSource;
  });
  await check('archon-home', async () =>
    realpath((await readProfile(root)).profile.archonHome),
  );
  const current = (await status(root)) as { status: string };
  return {
    status: checks.every((item) => item.status === 'PASS') ? 'PASS' : 'FAIL',
    checks,
    runtime: current.status,
  };
}
async function git(root: string, args: readonly string[]): Promise<string> {
  return (
    await runFile('git', ['-C', root, ...args], { maxBuffer: 2 * 1024 * 1024 })
  ).stdout.trim();
}
async function selectCompletion(
  root: string,
  taskId: string,
  host: LifecycleHost,
): Promise<{ path: string; sha256: string }> {
  assert(safeId(taskId), 'Invalid task ID.');
  const task = (await host.runTaskCommand([
    'show',
    '--root',
    join(root, 'tasks'),
    '--task',
    taskId,
  ])) as Record<string, any>;
  assert.equal(task.taskId, taskId);
  const refs = task.handoff?.contextRefs;
  assert(Array.isArray(refs), 'Task has no retained candidate handoff.');
  const matches = refs.filter(
    (ref: any) => ref?.kind === 'reviewed-local-candidate-completion',
  );
  assert.equal(
    matches.length,
    1,
    'Task must select exactly one candidate completion.',
  );
  const selected = matches[0];
  assert(
    typeof selected.location === 'string' && isAbsolute(selected.location),
  );
  assert(
    typeof selected.sha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(selected.sha256),
  );
  return { path: selected.location, sha256: selected.sha256 };
}
async function applyCandidate(
  root: string,
  taskId: string,
  host: LifecycleHost,
): Promise<unknown> {
  const lifecycle = (await status(root)) as { status: string };
  assert(
    lifecycle.status === 'stopped' || lifecycle.status === 'stale',
    'Stop the dashboard before applying a candidate.',
  );
  const selected = await selectCompletion(root, taskId, host);
  const completionPath = selected.path;
  assert(
    isAbsolute(completionPath),
    'The retained candidate completion path must be absolute.',
  );
  const completionBytes = await readFile(completionPath);
  assert.equal(
    digest(completionBytes),
    selected.sha256,
    'Retained candidate completion changed.',
  );
  const completion = JSON.parse(completionBytes.toString()) as Record<
    string,
    any
  >;
  assert.equal(completion.schema, 1);
  assert.equal(completion.profile, 'reviewed-local-candidate-v1');
  assert.equal(completion.status, 'PASS');
  assert.equal(completion.scope, 'reviewed-local-candidate-only');
  assert.equal(completion.publication, 'denied');
  assert(typeof completion.taskId === 'string' && safeId(completion.taskId));
  assert.equal(completion.taskId, taskId);
  exact(completion.binding, [
    'runId',
    'nativeRunId',
    'baseCommit',
    'planSha256',
    'requestSha256',
    'policySha256',
  ]);
  assert(
    typeof completion.binding.baseCommit === 'string' &&
      /^[a-f0-9]{40,64}$/.test(completion.binding.baseCommit),
  );
  for (const key of ['planSha256', 'requestSha256', 'policySha256']) {
    const value = completion.binding[key];
    assert(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value));
  }
  assert(
    typeof completion.binding.runId === 'string' &&
      safeId(completion.binding.runId),
  );
  assert(
    typeof completion.binding.nativeRunId === 'string' &&
      completion.binding.nativeRunId.length > 0,
  );
  assert(completion.candidate && isAbsolute(completion.candidate.root));
  assert(/^[a-f0-9]{40,64}$/.test(completion.candidate.commit));
  assert(/^[a-f0-9]{64}$/.test(completion.receiptSha256));
  const { profile } = await readProfile(root);
  const control = profile.control as Record<string, unknown>;
  assert(
    typeof control.workspaceRoot === 'string' &&
      isAbsolute(control.workspaceRoot),
  );
  const workspace = await realpath(control.workspaceRoot);
  const candidate = await realpath(completion.candidate.root);
  const retainedPath = join(
    root,
    'applications',
    taskId,
    `${completion.candidate.commit}.json`,
  );
  await mkdir(dirname(retainedPath), { recursive: true });
  try {
    const retained = JSON.parse(await readFile(retainedPath, 'utf8')) as Record<
      string,
      any
    >;
    assert.equal(retained.taskId, completion.taskId);
    assert.equal(retained.workspaceRoot, workspace);
    assert.equal(retained.baseCommit, completion.binding.baseCommit);
    assert.equal(retained.candidateCommit, completion.candidate.commit);
    assert.equal(retained.completionSha256, digest(completionBytes));
    assert.equal(
      await git(workspace, ['rev-parse', 'HEAD']),
      retained.candidateCommit,
    );
    assert.equal(await git(workspace, ['status', '--porcelain']), '');
    return retained;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  assert.equal(
    await git(workspace, ['rev-parse', '--show-toplevel']),
    workspace,
  );
  assert.equal(
    await git(candidate, ['rev-parse', '--show-toplevel']),
    candidate,
  );
  assert.equal(
    await git(workspace, ['status', '--porcelain']),
    '',
    'Source checkout must be clean.',
  );
  assert.equal(
    await git(workspace, ['rev-parse', 'HEAD']),
    completion.binding.baseCommit,
    'Source checkout is not at the reviewed base.',
  );
  assert.equal(
    await git(candidate, ['rev-parse', 'HEAD']),
    completion.candidate.commit,
    'Candidate checkout changed.',
  );
  await git(candidate, [
    'merge-base',
    '--is-ancestor',
    completion.binding.baseCommit,
    completion.candidate.commit,
  ]);
  await git(workspace, [
    'fetch',
    '--no-tags',
    candidate,
    completion.candidate.commit,
  ]);
  await git(workspace, ['merge', '--ff-only', completion.candidate.commit]);
  assert.equal(
    await git(workspace, ['rev-parse', 'HEAD']),
    completion.candidate.commit,
  );
  const receipt = {
    schema: 1,
    kind: 'temari-dashboard-candidate-application',
    taskId: completion.taskId,
    workspaceRoot: workspace,
    baseCommit: completion.binding.baseCommit,
    candidateCommit: completion.candidate.commit,
    completionSha256: digest(completionBytes),
    publication: 'denied',
    appliedAt: new Date().toISOString(),
  };
  await immutable(retainedPath, receipt);
  return receipt;
}
async function closeout(
  root: string,
  taskId: string,
  host: LifecycleHost,
): Promise<unknown> {
  const lifecycle = (await status(root)) as { status: string };
  assert(
    lifecycle.status === 'stopped' || lifecycle.status === 'stale',
    'Stop the dashboard before closing out a candidate.',
  );
  const selected = await selectCompletion(root, taskId, host);
  const completionBytes = await readFile(selected.path);
  assert.equal(digest(completionBytes), selected.sha256);
  const completion = JSON.parse(completionBytes.toString()) as Record<
    string,
    any
  >;
  assert.equal(completion.taskId, taskId);
  assert(/^[a-f0-9]{40,64}$/.test(completion.candidate?.commit));
  const applicationPath = join(
    root,
    'applications',
    taskId,
    `${completion.candidate.commit}.json`,
  );
  const applicationBytes = await readFile(applicationPath);
  const application = JSON.parse(applicationBytes.toString()) as Record<
    string,
    any
  >;
  assert.equal(application.schema, 1);
  assert.equal(application.kind, 'temari-dashboard-candidate-application');
  assert.equal(application.publication, 'denied');
  assert.equal(application.taskId, taskId);
  assert.equal(application.completionSha256, selected.sha256);
  const workspace = await realpath(application.workspaceRoot);
  assert.equal(
    await git(workspace, ['rev-parse', 'HEAD']),
    application.candidateCommit,
    'Applied candidate is no longer current.',
  );
  assert.equal(
    await git(workspace, ['status', '--porcelain']),
    '',
    'Applied checkout has uncommitted changes.',
  );
  const closeoutPath = join(
    root,
    'closeouts',
    taskId,
    `${application.candidateCommit}.json`,
  );
  await mkdir(dirname(closeoutPath), { recursive: true });
  try {
    const retained = JSON.parse(await readFile(closeoutPath, 'utf8')) as Record<
      string,
      any
    >;
    assert.equal(retained.taskId, application.taskId);
    assert.equal(retained.candidateCommit, application.candidateCommit);
    assert.equal(retained.applicationSha256, digest(applicationBytes));
    return retained;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const receipt = {
    schema: 1,
    kind: 'temari-dashboard-local-closeout',
    taskId: application.taskId,
    candidateCommit: application.candidateCommit,
    applicationSha256: digest(applicationBytes),
    publication: 'denied',
    closedAt: new Date().toISOString(),
  };
  await immutable(closeoutPath, receipt);
  return receipt;
}
async function serve(root: string, host: LifecycleHost): Promise<unknown> {
  const { profile, bytes } = await readProfile(root);
  const args = [
    'serve',
    '--root',
    join(root, 'tasks'),
    '--archon-home',
    profile.archonHome,
    '--archon-cache',
    join(root, 'cache'),
    '--control-config',
    controlPath(root),
    '--port',
    String(profile.port),
  ];
  if (profile.archonUrl) args.push('--archon-url', profile.archonUrl);
  const result = (await host.runTaskCommand(args)) as { url: string };
  await atomic(runtimePath(root), {
    schema: 1,
    pid: process.pid,
    url: result.url,
    profileId: profile.id,
    profileSha256: digest(bytes),
    startedAt: new Date().toISOString(),
  } satisfies RuntimeState);
  return result;
}

export async function runDashboardLifecycleCommand(
  args: readonly string[],
  host: LifecycleHost,
): Promise<unknown> {
  const command = args[0];
  if (!command || command === '--help' || command === '-h')
    return { help: lifecycleHelp };
  if (!commands.has(command)) return host.runTaskCommand(args);
  const parsed = parseArgs({
    args: [...args.slice(1)],
    options: {
      profile: { type: 'string' },
      home: { type: 'string' },
      task: { type: 'string' },
    },
    strict: true,
  });
  const root = parsed.values.home ? resolve(parsed.values.home) : home();
  if (command === 'configure') {
    assert(
      parsed.values.profile,
      'configure requires --profile ABSOLUTE_JSON.',
    );
    return configure(parsed.values.profile, root, host);
  }
  if (command === 'start') return start(root, host);
  if (command === 'status') return status(root);
  if (command === 'stop') return stop(root);
  if (command === 'doctor') return doctor(root, host);
  if (command === 'apply') {
    assert(parsed.values.task, 'apply requires --task ID.');
    return applyCandidate(root, parsed.values.task, host);
  }
  if (command === 'closeout') {
    assert(parsed.values.task, 'closeout requires --task ID.');
    return closeout(root, parsed.values.task, host);
  }
  return serve(root, host);
}
