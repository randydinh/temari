import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, mkdir, realpath, readdir, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { validateDashboardConfig,type DashboardConfig } from './dashboard-controller.mjs';
import { FileMergeReconciliationStore,FileTaskStore,TaskRuntime } from '../libs/runtime/src/index.js';
import { projectRetainedReconciliationReview } from './merge-reconciliation-dashboard.mjs';
import {
  createTaskContinuityReconciliationDashboard,
  createDashboardTalkTaskBridge,
  runTaskCommand,
} from './task-continuity.mjs';

const run = promisify(execFile);

test('Talk planning bridge requires the same canonical workspace and one host-selected policy',async(t)=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'temari-talk-bridge-')));t.after(()=>rm(root,{recursive:true,force:true}));
  const workspace=join(root,'workspace'),other=join(root,'other');await mkdir(workspace);await mkdir(other);
  const store=await FileTaskStore.create(join(root,'tasks')),runtime=new TaskRuntime({store});
  const policy={id:'default-plan'} as any;
  const dashboard={schema:1,workspaceRoot:workspace,preparationRoot:join(root,'prepare'),recipes:[],planning:{executable:'/host/codex',timeoutMs:1000,policies:[policy]}} as DashboardConfig;
  let createCalls=0,describeCalls=0;
  let projectedControl:any={actions:['prepare-plan','update'],planning:{state:'READY',proposalSha256:'b'.repeat(64)},message:'Validated proposal is ready.'};
  const controller={async create(input:unknown){createCalls++;const request=input as {requestId:string;title:string;goal:string;policyId:string};assert.equal(request.policyId,'default-plan');return store.createTask({taskId:'task-'+request.requestId,actor:'controller',idempotencyKey:'intake-'+request.requestId,title:request.title,goal:request.goal,workspaceRoot:workspace});},async describe(){describeCalls++;return {controls:{'task-talk-one':projectedControl}};}};
  const talk={schema:1 as const,root:join(root,'talk'),workspaceRoot:workspace,hostId:'host',workspaceId:'workspace',taskStoreId:'tasks'};
  const bridge=await createDashboardTalkTaskBridge({talkConfig:talk,dashboardConfig:dashboard,controller:controller as never,runtime});assert(bridge);
  assert.deepEqual(await bridge.intake({requestId:'talk-one',title:'One',goal:'Goal'}),{taskId:'task-talk-one'});assert.equal(createCalls,1);
  assert.deepEqual(await bridge.project({taskId:'task-talk-one',expectedVersion:1}),{phase:'planning',state:'READY',message:'Validated proposal is ready.',action:{action:'prepare-plan',label:'Prepare implementation plan',proposalSha256:'b'.repeat(64)}});assert.equal(describeCalls,1);
  projectedControl={actions:['update'],planning:{state:'BLOCKED',proposalSha256:null},message:'Planner rejected the retained response.'};
  assert.deepEqual(await bridge.project({taskId:'task-talk-one',expectedVersion:1}),{phase:'planning',state:'BLOCKED',message:'Planner rejected the retained response.',action:null});
  projectedControl={actions:['update'],planning:{state:'RECOVERY_REQUIRED',proposalSha256:null},message:'Planner evidence needs recovery.'};
  assert.deepEqual(await bridge.project({taskId:'task-talk-one',expectedVersion:1}),{phase:'planning',state:'RECOVERY_REQUIRED',message:'Planner evidence needs recovery.',action:null});
  assert.equal(await createDashboardTalkTaskBridge({talkConfig:{...talk,workspaceRoot:other},dashboardConfig:dashboard,controller:controller as never,runtime}),undefined);
  assert.equal(await createDashboardTalkTaskBridge({talkConfig:talk,dashboardConfig:{...dashboard,planning:{...dashboard.planning!,policies:[policy,policy]}},controller:controller as never,runtime}),undefined);
});

test('task-continuity leaves reconciliation controls unavailable without explicit host configuration', async () => {
  const dashboard = await createTaskContinuityReconciliationDashboard(
    {
      schema: 1 as const,
      workspaceRoot: '/configured-workspace',
      preparationRoot: '/configured-preparations',
      recipes: [],
    },
    {} as never,
  );
  assert.equal(dashboard, undefined);
});

test('fresh CLI processes recover the same task, next action and version', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'temari-task-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const create = join(root, 'create.json');
  const store = join(root, 'tasks');
  await writeFile(
    create,
    JSON.stringify({
      taskId: 'continued-task',
      title: 'Continue work',
      goal: 'Return without searching a chat',
      workspaceRoot: resolve('.'),
      actor: 'temari',
      idempotencyKey: 'create-1',
    }),
  );
  const cli = resolve('tools/task-continuity.mts');
  const first = await run(process.execPath, [
    '--import',
    '@swc-node/register/esm-register',
    cli,
    'create',
    '--root',
    store,
    '--input',
    create,
  ]);
  assert.equal(JSON.parse(first.stdout).version, 1);
  const update = join(root, 'update.json');
  await writeFile(
    update,
    JSON.stringify({
      taskId: 'continued-task',
      actor: 'temari',
      idempotencyKey: 'next-1',
      expectedVersion: 1,
      nextAction: 'Review the retained candidate',
      blocker: null,
    }),
  );
  await run(process.execPath, [
    '--import',
    '@swc-node/register/esm-register',
    cli,
    'update',
    '--root',
    store,
    '--input',
    update,
  ]);
  const reopened = JSON.parse(
    (
      await run(process.execPath, [
        '--import',
        '@swc-node/register/esm-register',
        cli,
        'show',
        '--root',
        store,
        '--task',
        'continued-task',
      ])
    ).stdout,
  );
  assert.equal(reopened.nextAction, 'Review the retained candidate');
  assert.equal(reopened.version, 2);
  assert.equal(reopened.events.length, 2);
  assert.equal(reopened.status, 'OPEN');
  const listed = (await runTaskCommand(['list', '--root', store])) as {
    taskId: string;
  }[];
  assert.equal(listed[0]?.taskId, 'continued-task');
});

test('CLI rejects unknown commands and relative storage roots', async () => {
  await assert.rejects(
    runTaskCommand(['unknown', '--root', '/tmp']),
    /Unknown task command/,
  );
  await assert.rejects(
    runTaskCommand(['list', '--root', './tasks']),
    /absolute path/,
  );
  assert.match(
    ((await runTaskCommand(['--help'])) as { help: string }).help,
    /idempotencyKey/,
  );
});

test('host entry, handoff and scoped pickup survive separate CLI processes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'temari-host-entry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = join(root, 'tasks');
  const cli = resolve('tools/task-continuity.mts');
  const invoke = async (...args: string[]) =>
    JSON.parse(
      (
        await run(process.execPath, [
          '--import',
          '@swc-node/register/esm-register',
          cli,
          ...args,
          '--root',
          store,
        ])
      ).stdout,
    );
  const command = async (name: string, input: Record<string, unknown>) => {
    const path = join(root, `${name}.json`);
    await writeFile(path, JSON.stringify(input));
    return invoke(name, '--input', path);
  };
  const session = { host: 'codex', sessionId: 'conversation-one' };
  const entry = {
    taskId: 'first',
    actor: 'temari',
    idempotencyKey: 'entry-first',
    expectedVersion: 0,
    session,
    create: {
      title: 'First goal',
      goal: 'Keep the actual next step',
      workspaceRoot: root,
    },
  };
  const entered = await command('enter', entry);
  assert.equal(entered.version, 1);
  assert.equal((await command('enter', entry)).version, 1);
  assert.equal(entered.sessions[0].sessionId, session.sessionId);
  const handoff = await command('handoff', {
    taskId: 'first',
    actor: 'temari',
    idempotencyKey: 'handoff-first',
    expectedVersion: 1,
    handoff: {
      summary: 'The candidate is ready for review.',
      decisions: ['Keep Archon replaceable.'],
      nextAction: 'Review the retained candidate.',
      blocker: null,
      contextRefs: [{ kind: 'design', location: '/local/design.md' }],
    },
  });
  assert.equal(handoff.version, 2);
  const scoped = await invoke(
    'pickup',
    '--workspace',
    root,
    '--host',
    session.host,
    '--session',
    session.sessionId,
  );
  assert.equal(scoped.status, 'selected');
  assert.equal(scoped.selected.taskId, 'first');
  assert.equal(scoped.selected.nextAction, 'Review the retained candidate.');
  assert.equal(scoped.selected.handoff.contextOnly, true);
  assert.equal(scoped.selected.currentRun, null);
  assert.equal(scoped.selected.status, 'OPEN');
  assert.equal(JSON.stringify(scoped).includes('dispatchInputs'), false);
  await command('enter', {
    ...entry,
    taskId: 'second',
    idempotencyKey: 'entry-second',
    create: { ...entry.create, title: 'Second goal' },
  });
  const ambiguous = await invoke(
    'pickup',
    '--workspace',
    root,
    '--host',
    session.host,
    '--session',
    session.sessionId,
    '--limit',
    '1',
  );
  assert.equal(ambiguous.status, 'choices');
  assert.equal(ambiguous.hasMore, true);
  assert.equal(ambiguous.selected, null);
  assert.equal(ambiguous.choices.length, 1);
  assert.equal(
    (await invoke('pickup', '--task', 'first')).selected.taskId,
    'first',
  );
  assert.equal(
    (await invoke('pickup', '--task', 'first', '--workspace', resolve('.')))
      .status,
    'empty',
  );
  assert.equal(
    (
      await invoke(
        'pickup',
        '--workspace',
        root,
        '--host',
        'codex',
        '--session',
        'different',
      )
    ).status,
    'empty',
  );
  await assert.rejects(
    invoke('pickup'),
    /exact task ID or an absolute workspace root/,
  );
  await assert.rejects(
    invoke('pickup', '--task', 'first', '--host', 'codex'),
    /--host and --session together/,
  );
  await assert.rejects(
    invoke('pickup', '--task', 'first', '--limit', '0'),
    /Pickup limit/,
  );
});

test('open-work CLI flags are paired, serve-only and validated before store access', async () => {
  const pin = 'a'.repeat(64);
  await assert.rejects(
    runTaskCommand([
      'list',
      '--open-work-manifest',
      '/capture',
      '--open-work-sha256',
      pin,
    ]),
    /only supported by serve/,
  );
  await assert.rejects(
    runTaskCommand(['serve', '--open-work-manifest', '/capture']),
    /must be paired/,
  );
  await assert.rejects(
    runTaskCommand(['serve', '--open-work-sha256', pin]),
    /must be paired/,
  );
  await assert.rejects(
    runTaskCommand([
      'serve',
      '--open-work-manifest',
      'relative',
      '--open-work-sha256',
      pin,
    ]),
    /absolute path/,
  );
  await assert.rejects(
    runTaskCommand([
      'serve',
      '--open-work-manifest',
      '/capture',
      '--open-work-sha256',
      'bad',
    ]),
    /64hex/,
  );
});

test('Talk config is optional, serve-only and validated before task-store access', async () => {
  await assert.rejects(runTaskCommand(['list', '--root', '/not-a-selected-task-store', '--talk-config', '/not-a-config']), /only supported by serve/);
  await assert.rejects(runTaskCommand(['serve', '--root', '/not-a-selected-task-store', '--talk-config', 'relative.json']), /--talk-config requires an absolute path/);
  const help = (await runTaskCommand(['--help'])) as { help: string };
  assert.match(help.help, /--talk-config/);
  assert.match(help.help, /does not install or launch Archon/);
});

test('Talk CLI rejects in-source storage before creating task or conversation data', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'temari-talk-storage-admission-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  await writeFile(join(workspace, 'sentinel.txt'), 'Existing source stays intact.');
  const config = join(root, 'talk.json');
  const outsideTasks = join(root, 'tasks');
  const selected = { schema: 1, workspaceRoot: workspace, hostId: 'fixture-host', workspaceId: 'fixture-workspace', taskStoreId: 'fixture-tasks' };
  await writeFile(config, JSON.stringify({ ...selected, root: join(workspace, '..talk') }));
  await assert.rejects(runTaskCommand(['serve', '--root', outsideTasks, '--talk-config', config, '--port', '0']), /outside the selected source workspace/);
  await assert.rejects(readdir(outsideTasks), { code: 'ENOENT' });
  await writeFile(config, JSON.stringify({ ...selected, root: join(root, 'conversations') }));
  await assert.rejects(runTaskCommand(['serve', '--root', join(workspace, 'tasks'), '--talk-config', config, '--port', '0']), /outside the selected source workspace/);
  assert.deepEqual(await readdir(workspace), ['sentinel.txt']);
  assert.equal(await readFile(join(workspace, 'sentinel.txt'), 'utf8'), 'Existing source stays intact.');
  await assert.rejects(readdir(join(root, 'conversations')), { code: 'ENOENT' });
});

test('multiworkspace Talk CLI validates every selected source before creating either store', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'temari-talk-registry-cli-admission-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaces = [join(root, 'source-a'), join(root, 'source-b')];
  for (const workspace of workspaces) {
    await mkdir(workspace);
    await writeFile(join(workspace, 'sentinel.txt'), 'Existing source remains intact.');
  }
  const tasks = join(root, 'tasks'), conversations = join(root, 'registry'), configPath = join(root, 'talk.json');
  const config = { schema: 2, root: conversations, registryId: 'fixture-registry', hostId: 'fixture-host', taskStoreId: 'fixture-tasks',
    workspaces: workspaces.map((workspaceRoot, index) => ({ key: 'w' + index, workspaceId: 'workspace-' + index, label: 'Workspace ' + index, workspaceRoot })) };
  await writeFile(configPath, JSON.stringify({ ...config, root: join(workspaces[1]!, 'registry') }));
  await assert.rejects(runTaskCommand(['serve', '--root', tasks, '--talk-config', configPath, '--port', '0']), /outside|disjoint/);
  await assert.rejects(readdir(tasks), { code: 'ENOENT' });
  await writeFile(configPath, JSON.stringify(config));
  await assert.rejects(runTaskCommand(['serve', '--root', join(workspaces[1]!, 'tasks'), '--talk-config', configPath, '--port', '0']), /outside|disjoint/);
  await assert.rejects(readdir(conversations), { code: 'ENOENT' });
  for (const workspace of workspaces) {
    assert.deepEqual(await readdir(workspace), ['sentinel.txt']);
    assert.equal(await readFile(join(workspace, 'sentinel.txt'), 'utf8'), 'Existing source remains intact.');
  }
});

test('Talk CLI refuses symlink-parent storage traversal before any source write', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'temari-talk-symlink-parent-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const outside = join(root, 'outside');
  await mkdir(join(workspace, 'nested'), { recursive: true });
  await mkdir(outside);
  await writeFile(join(workspace, 'sentinel.txt'), 'Original source.');
  await symlink(join(workspace, 'nested'), join(outside, 'alias'));
  const conversations = join(root, 'conversations');
  const config = join(root, 'talk.json');
  await writeFile(config, JSON.stringify({ schema: 1, root: conversations, workspaceRoot: workspace, hostId: 'fixture-host', workspaceId: 'fixture-workspace', taskStoreId: 'fixture-tasks' }));
  // Keep the raw parent segment: join() would collapse it before the CLI sees it.
  const rawTaskRoot = `${outside}/alias/../tasks`;
  await assert.rejects(runTaskCommand(['serve', '--root', rawTaskRoot, '--talk-config', config, '--port', '0']), /storage.*segments|parent|dot|canonical/i);
  assert.deepEqual((await readdir(workspace)).sort(), ['nested', 'sentinel.txt']);
  assert.equal(await readFile(join(workspace, 'sentinel.txt'), 'utf8'), 'Original source.');
  await assert.rejects(readdir(join(outside, 'tasks')), { code: 'ENOENT' });
  await assert.rejects(readdir(conversations), { code: 'ENOENT' });
});

test('advice-only Talk CLI serves topic organization with no Archon admission or model launch', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'temari-talk-cli-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const conversations = join(root, 'conversations');
  await mkdir(workspace);
  await mkdir(conversations);
  const config = join(root, 'talk-config.json');
  const tasks = join(root, 'tasks');
  await writeFile(config, JSON.stringify({ schema: 1, root: conversations, workspaceRoot: workspace, hostId: 'fixture-host', workspaceId: 'fixture-workspace', taskStoreId: 'fixture-tasks' }));
  const child = spawn(process.execPath, [
    '--import', '@swc-node/register/esm-register', resolve('tools/task-continuity.mts'),
    'serve', '--root', tasks, '--talk-config', config, '--port', '0',
    // These unselected native paths would fail before any installation if the
    // Talk-only branch accidentally tried to initialize Archon.
    '--archon-home', 'unselected-relative-home', '--archon-cache', 'unselected-relative-cache',
  ], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = new Promise<void>((done) => child.once('close', () => done()));
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 2_000);
    force.unref();
    await closed;
    clearTimeout(force);
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const started = await new Promise<{ url: string; mode: string }>((done, reject) => {
    let stdout = '';
    const timer = setTimeout(() => reject(new Error(`Talk CLI readiness timed out: ${stderr}`)), 10_000);
    const finish = (error?: Error, value?: { url: string; mode: string }) => {
      clearTimeout(timer);
      if (error) reject(error); else done(value!);
    };
    child.once('error', (error) => finish(error));
    child.once('exit', (code) => finish(new Error(`Talk CLI exited before readiness (${code}): ${stderr}`)));
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      let parsed: { url?: string; mode?: string };
      try { parsed = JSON.parse(stdout); } catch { return; }
      if (typeof parsed.url === 'string' && typeof parsed.mode === 'string') finish(undefined, parsed as { url: string; mode: string });
    });
  });
  assert.equal(started.mode, 'read-only');
  const dashboard = await (await fetch(`${started.url}/api/dashboard`)).json();
  assert.equal(dashboard.mode, 'read-only');
  assert.equal(dashboard.talkAvailable, true);
  const before = await (await fetch(`${started.url}/api/topics`)).json();
  assert.equal(before.configured, true);
  assert.equal(before.capabilities.canSendTurn, false);
  assert.deepEqual(before.topics, []);
  const headers = { origin: started.url, 'content-type': 'application/json', 'x-temari-token': dashboard.csrfToken as string };
  const created = await fetch(`${started.url}/api/topics`, { method: 'POST', headers, body: JSON.stringify({ requestId: 'advice-topic', title: 'Keep advice separate' }) });
  assert.equal(created.status, 200);
  const topic = (await created.json()).topic;
  assert.match(topic.topicId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
  const turn = await fetch(`${started.url}/api/topics/${topic.topicId}/turns`, { method: 'POST', headers, body: JSON.stringify({ requestId: 'unavailable-turn', expectedVersion: topic.version, text: 'No model is selected.' }) });
  assert.equal(turn.status, 503);
  assert.deepEqual((await (await fetch(`${started.url}/api/tasks`)).json()).tasks, []);
  assert.equal((await fetch(`${started.url}/api/tasks`, { method: 'POST', headers, body: '{}' })).status, 405);
});


function reconciliationCliConfig(root: string, workspace: string, preparation: string) {
  const evidence = { schema: 1 as const, id: 'evidence', sha256: 'a'.repeat(64), bytes: 0, mediaType: 'application/json' };
  return { schema: 1 as const, workspaceRoot: workspace, preparationRoot: preparation, recipes: [], reconciliation: {
    storeRoot: join(root, 'reconciliation'), sourceRoot: workspace,
    candidate: { id: 'candidate', sha256: 'b'.repeat(64), root: { id: 'candidate-root', sha256: 'c'.repeat(64) } },
    resolutionIntent: 'preserve' as const, requiredChecks: [{ id: 'check', definitionSha256: 'd'.repeat(64) }],
    expectedComparison: { candidateEvidence: evidence, verificationEvidence: evidence },
    browserReview: { selectedAttempts: [] as { attemptId: string; reviewSha256: string }[] },
  } };
}

test('reconciliation CLI rejects in-source and parent-traversal task storage before creating any store or native admission', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'temari-reconciliation-cli-root-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace'); const preparation = join(root, 'preparation'); const outside = join(root, 'outside');
  for (const path of [workspace, preparation, outside]) await mkdir(path);
  await mkdir(join(workspace, 'nested')); await symlink(join(workspace, 'nested'), join(outside, 'alias'));
  await writeFile(join(workspace, 'sentinel.txt'), 'Selected source.');
  const configPath = join(root, 'control.json'); const config = reconciliationCliConfig(root, workspace, preparation);
  await writeFile(configPath, JSON.stringify(config));
  for (const selected of [join(workspace, 'tasks'), `${outside}/alias/../tasks`, join(preparation, 'reconciliation-browser-interactions')])
    await assert.rejects(runTaskCommand(['serve', '--root', selected, '--control-config', configPath, '--port', '0']), /disjoint|canonical segments/);
  assert.deepEqual((await readdir(workspace)).sort(), ['nested', 'sentinel.txt']);
  assert.equal(await readFile(join(workspace, 'sentinel.txt'), 'utf8'), 'Selected source.');
  assert.deepEqual(await readdir(preparation), []); assert.deepEqual(await readdir(outside), ['alias']);
  await assert.rejects(readdir(config.reconciliation.storeRoot), { code: 'ENOENT' });
  const tasks = join(root, 'tasks');
  await writeFile(configPath, JSON.stringify({ ...config, reconciliation: { ...config.reconciliation, browserReview: { selectedAttempts: [{ attemptId: 'browser-selected', reviewSha256: 'invalid' }] } } }));
  await assert.rejects(runTaskCommand(['serve', '--root', tasks, '--control-config', configPath, '--port', '0']), /review digest/);
  await assert.rejects(readdir(tasks), { code: 'ENOENT' });
  for (const storeRoot of [preparation, join(preparation, 'reconciliation-browser-interactions'), join(preparation, 'reconciliation-browser-interactions', 'nested-ledger')]) {
    await writeFile(configPath, JSON.stringify({ ...config, reconciliation: { ...config.reconciliation, storeRoot } }));
    await assert.rejects(runTaskCommand(['serve', '--root', tasks, '--control-config', configPath, '--port', '0']), /ledger and interaction stores must be disjoint/);
    await assert.rejects(readdir(tasks), { code: 'ENOENT' });
    assert.deepEqual(await readdir(preparation), []);
  }
});

test('CLI reconciliation factory keeps host review pins and refuses absent current task/run without interaction evidence', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'temari-reconciliation-cli-factory-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace'); const preparation = join(root, 'preparation'); await mkdir(workspace); await mkdir(preparation);
  const raw = reconciliationCliConfig(root, workspace, preparation);
  const store = await FileMergeReconciliationStore.create(raw.reconciliation.storeRoot);
  const scope = { schema: 1 as const, sourceRoot: { id: 'source', sha256: '0'.repeat(64) }, candidateRoot: raw.reconciliation.candidate.root, baseHead: { id: 'base', sha256: '1'.repeat(64) }, operationHead: { id: 'operation', sha256: '2'.repeat(64) }, affectedPaths: [{ path: 'selected.txt', pathSha256: '3'.repeat(64), classification: 'untracked' as const, indexBlobs: [], unmergedStages: [], worktreeKind: 'file' as const, worktreeSha256: '4'.repeat(64), diffSha256: '5'.repeat(64) }], resolutionIntent: raw.reconciliation.resolutionIntent, requiredChecks: raw.reconciliation.requiredChecks, expectedComparison: raw.reconciliation.expectedComparison };
  const evidence = raw.reconciliation.expectedComparison.candidateEvidence;
  const candidate = { schema: 'reconciliation-candidate-v1' as const, id: raw.reconciliation.candidate.id, sha256: raw.reconciliation.candidate.sha256 };
  const observation = { schema: 1 as const, observationId: 'observation', taskId: 'task', taskVersion: '1', runId: 'run', revision: 'revision', candidate, scope, observedAt: '2026-10-03T12:00:00.000Z', kind: 'untracked' as const, evidence: [evidence] };
  const plan = { schema: 1 as const, id: 'plan', taskId: observation.taskId, taskVersion: observation.taskVersion, runId: observation.runId, revision: observation.revision, observationId: observation.observationId, candidate, scope, classification: 'requires-confirmation' as const, status: 'awaiting-confirmation' as const, request: { idempotencyKey: 'cli-prepared', canonicalRequestDigestAlgorithm: 'canonical-json-sha256-v1' as const, canonicalRequestSha256: '6'.repeat(64) }, summary: 'Review only selected source metadata.', actions: [{ id: 'preserve', kind: 'preserve' as const, targetId: 'task' }], evidence: [evidence] };
  const attempt = await store.createAttempt({ idempotencyKey: 'cli-prepared', observation, plan });
  const projection = projectRetainedReconciliationReview(attempt); assert.equal(projection.complete, true);
  raw.reconciliation.browserReview.selectedAttempts = [{ attemptId: attempt.id, reviewSha256: projection.sha256! }];
  const config = await validateDashboardConfig(raw); let taskReads = 0;
  const facade = (await createTaskContinuityReconciliationDashboard(config, { async snapshot() { taskReads++; throw new Error('No selected current task.'); } } as never))!;
  const list = await facade.list(); assert.equal(list.attempts[0]!.hostSelectedForReview, true);
  const review = (await facade.review(attempt.id))!; assert.equal(review.review.sha256, projection.sha256); assert.equal(review.currentBinding.state, 'not-checked');
  const refused = await facade.confirmReviewed(attempt.id, { requestId: 'local-cli-request', reviewSha256: projection.sha256! });
  assert.equal(refused.outcome, 'refused'); assert.equal(refused.reasonCode, 'current-binding-unavailable'); assert.equal(refused.review.currentBinding.state, 'unavailable'); assert.equal(taskReads, 1);
  assert.equal((await store.get(attempt.id))!.confirmation, null); assert.deepEqual(await readdir(preparation), []);
});
