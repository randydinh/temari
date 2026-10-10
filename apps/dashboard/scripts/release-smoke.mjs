import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  chmod,
  cp,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const temporary = await realpath(
  await mkdtemp(join(tmpdir(), 'temari-dashboard-release-')),
);
const builtArtifact = fileURLToPath(new URL('../dist', import.meta.url));
const installation = join(temporary, 'installed-dashboard');
const artifact = join(installation, 'main.mjs');
const dashboardHome = join(temporary, 'dashboard');
const workspace = join(temporary, 'product');
const preparation = join(temporary, 'preparation');
const evidence = join(temporary, 'evidence');
const archonHome = join(temporary, 'archon');
const codexHome = join(temporary, 'codex-home');
let started = false;
let passed = false;

const run = async (...args) =>
  JSON.parse(
    (
      await exec(process.execPath, [artifact, ...args], {
        cwd: installation,
        env: {
          ...process.env,
          CODEX_HOME: codexHome,
          TEMARI_DASHBOARD_HOME: dashboardHome,
        },
        maxBuffer: 4 * 1024 * 1024,
      })
    ).stdout,
  );
const git = async (root, ...args) =>
  (await exec('git', ['-C', root, ...args])).stdout.trim();
const post = async (base, token, path, body) => {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: {
      origin: base,
      'content-type': 'application/json',
      'x-temari-token': token,
    },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  assert.equal(response.status, 200, JSON.stringify(value));
  return value;
};
const waitFor = async (action, message, attempts = 600) => {
  for (let index = 0; index < attempts; index++) {
    const value = await action();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(message);
};

try {
  await cp(builtArtifact, installation, { recursive: true });
  const workflow = join(installation, 'workflow-host');
  const packagedBridge = join(workflow, 'reviewed-local-candidate.mjs');
  await Promise.all([
    access(packagedBridge),
    access(join(workflow, 'managed-candidate-operation.mjs')),
    access(join(workflow, 'dashboard-planner.mjs')),
    access(join(workflow, 'owned-process', 'guardian.mjs')),
    access(join(workflow, 'owned-process', 'anchor.mjs')),
    access(
      join(
        workflow,
        '.archon',
        'workflows',
        'temari-reviewed-local-candidate.yaml',
      ),
    ),
  ]);
  await exec(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      "const {pathToFileURL}=await import('node:url');const target=process.argv[1];process.argv[1]='relocation-probe';await import(pathToFileURL(target).href)",
      packagedBridge,
    ],
    { cwd: installation },
  );

  await Promise.all(
    [workspace, preparation, evidence, archonHome, codexHome].map((path) =>
      mkdir(path),
    ),
  );
  await exec('git', ['init', '-q', '-b', 'main', workspace]);
  await git(workspace, 'config', 'user.name', 'Temari Release Proof');
  await git(workspace, 'config', 'user.email', 'temari@example.invalid');
  await writeFile(join(workspace, 'value.txt'), 'before\n');
  await writeFile(join(workspace, 'protected.txt'), 'keep\n');
  await git(workspace, 'add', '.');
  await git(workspace, 'commit', '-q', '-m', 'baseline');
  const baseCommit = await git(workspace, 'rev-parse', 'HEAD');

  const configPath = join(codexHome, 'config.toml');
  const catalogPath = join(temporary, 'catalog.json');
  await writeFile(
    configPath,
    'model = "fixture-model"\nmodel_reasoning_effort = "high"\n',
  );
  await writeFile(
    catalogPath,
    JSON.stringify({
      client_version: '0.162.0',
      fetched_at: new Date().toISOString(),
      models: [
        {
          slug: 'fixture-model',
          supported_reasoning_levels: [{ effort: 'high' }],
        },
      ],
    }),
  );
  const fakeCodex = join(temporary, 'codex');
  await writeFile(
    fakeCodex,
    `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),a=process.argv.slice(2);
if(a[0]==='--version'){console.log('codex-cli 0.162.0');process.exit(0)}
if(a.includes('--help')){console.log('--sandbox --output-schema --json --ignore-user-config --model --config');process.exit(0)}
if(a[0]==='login'){console.log('Logged in using fixture');process.exit(0)}
let p='';process.stdin.on('data',x=>p+=x);process.stdin.on('end',()=>{
 if(!a.includes('--ignore-user-config')||a[a.indexOf('--model')+1]!=='fixture-model'||!a.includes('model_provider="openai"')||!a.includes('model_reasoning_effort="high"'))process.exit(9);
 const output=a[a.indexOf('--output-last-message')+1];
 if(p.includes('Draft one bounded implementation proposal')){fs.writeFileSync(output,JSON.stringify({schema:1,title:'Packaged candidate',summary:'One bounded change',assignments:[{slotId:'builder',goal:'Change value.txt to after',acceptanceCriteria:['value.txt equals after'],dependsOn:[]}],blockers:[]}));console.log('{}');return}
 const role=p.includes('isolated Git clone')?'builder':p.includes('Role: reviewer')?'reviewer':'architect';
 const cwd=a[a.indexOf('--cd')+1];if(role==='builder')fs.writeFileSync(path.join(cwd,'value.txt'),'after\\n');
 fs.writeFileSync(output,JSON.stringify({status:'PASS',summary:role+' verified the packaged route'}));console.log(JSON.stringify({type:'thread.started',thread_id:role+'-fixture'}));
});
`,
    { mode: 0o700 },
  );
  await chmod(fakeCodex, 0o700);
  const check = join(temporary, 'check.mjs');
  await writeFile(
    check,
    `import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {join} from 'node:path';const [mode,root]=process.argv.slice(2);assert.equal(readFileSync(join(root,'value.txt'),'utf8'),mode==='baseline'?'before\\n':'after\\n');assert.equal(readFileSync(join(root,'protected.txt'),'utf8'),'keep\\n');`,
  );
  const parser = await realpath(
    (
      await exec('python3', ['-c', 'import sys,tomllib;print(sys.executable)'])
    ).stdout.trim(),
  );
  const node = await realpath(process.execPath);
  const protectedInputs = await Promise.all(
    [node, fakeCodex, configPath, catalogPath, parser, check].map(
      async (path) => ({ path, sha256: sha(await readFile(path)) }),
    ),
  );
  const command = (mode) => ({
    program: node,
    args: [check, mode, '{candidate}'],
    timeoutMs: 10_000,
  });
  const worker = (id, role) => ({
    id,
    role,
    required: true,
    brief: {
      goal: 'Implement and inspect the literal release proof',
      context: 'Change value.txt and preserve protected.txt',
      scope: 'value.txt',
      acceptanceCriteria: ['value.txt equals after'],
      verificationCommand: null,
      reportFormat: 'json',
      forbiddenActions: ['No publication'],
    },
  });
  const baselineCheck = command('baseline');
  const acceptanceCheck = command('acceptance');
  const policy = {
    profile: 'reviewed-local-candidate-v1',
    id: 'coupled',
    title: 'Coupled builder',
    description: 'Bounded packaged candidate',
    slots: [
      {
        id: 'builder',
        title: 'Builder',
        description: 'Own value.txt',
        owns: [{ kind: 'file', path: 'value.txt' }],
        mandatoryCriteria: ['value.txt equals after'],
      },
    ],
    prepare: [baselineCheck],
    verify: [acceptanceCheck],
    reviewer: worker('reviewer', 'reviewer'),
  };
  const profilePath = join(temporary, 'profile.json');
  await writeFile(
    profilePath,
    JSON.stringify({
      schema: 1,
      id: 'clean-release-proof',
      archonHome,
      port: 0,
      control: {
        schema: 1,
        workspaceRoot: workspace,
        preparationRoot: preparation,
        recipes: [],
        planning: {
          executable: fakeCodex,
          timeoutMs: 10_000,
          policies: [policy],
        },
        managedCandidate: {
          profile: 'reviewed-local-candidate-v1',
          policyId: policy.id,
          taskStoreRoot: join(dashboardHome, 'tasks'),
          evidenceRoot: evidence,
          bridge: 'packaged',
          bridgeRuntimeExecutable: node,
          bridgeRuntimeSha256: sha(await readFile(node)),
          executable: fakeCodex,
          timeoutMs: 10_000,
          providerSelection: {
            provider: 'codex',
            executableSha256: sha(await readFile(fakeCodex)),
            executableVersion: 'codex-cli 0.162.0',
            model: 'fixture-model',
            reasoning: 'high',
          },
          modelAdmission: {
            configPath,
            configSha256: sha(await readFile(configPath)),
            catalogPath,
            catalogSha256: sha(await readFile(catalogPath)),
            parserExecutable: parser,
            parserSha256: sha(await readFile(parser)),
          },
          architect: worker('architect', 'investigator'),
          protectedInputs,
          baselineChecks: [baselineCheck],
          acceptanceChecks: [acceptanceCheck],
        },
      },
    }),
  );

  assert.equal(
    (await run('configure', '--profile', profilePath)).status,
    'configured',
  );
  assert.equal((await run('doctor')).status, 'PASS');
  const first = await run('start');
  started = true;
  assert.equal(first.status, 'running');
  assert.equal((await run('status')).healthy, true);

  const createPath = join(temporary, 'create.json');
  await writeFile(
    createPath,
    JSON.stringify({
      taskId: 'restart-proof',
      title: 'Restart proof',
      goal: 'Persist through restart.',
      workspaceRoot: workspace,
      actor: 'release-proof',
      idempotencyKey: 'create-restart-proof',
    }),
  );
  await run(
    'create',
    '--root',
    join(dashboardHome, 'tasks'),
    '--input',
    createPath,
  );
  await run('stop');
  started = false;
  const second = await run('start');
  started = true;
  assert.notEqual(second.pid, first.pid);
  const tasks = await run('list', '--root', join(dashboardHome, 'tasks'));
  assert(tasks.some((task) => task.taskId === 'restart-proof'));

  let dashboard = await (await fetch(second.url + '/api/dashboard')).json();
  let token = dashboard.csrfToken;
  let task = await post(second.url, token, '/api/tasks', {
    requestId: 'managed-release-proof',
    mode: 'planning',
    policyId: 'coupled',
    title: 'Packaged managed execution',
    goal: 'Change value.txt from before to after and preserve protected.txt.',
  });
  const planning = await waitFor(async () => {
    dashboard = await (await fetch(second.url + '/api/dashboard')).json();
    const control = dashboard.config.controls[task.taskId];
    return control?.actions?.includes('prepare-plan') ? control.planning : null;
  }, 'Packaged planner did not produce a validated proposal.');
  task = await post(second.url, token, `/api/tasks/${task.taskId}/actions`, {
    action: 'prepare-plan',
    requestId: 'prepare-managed-release',
    expectedVersion: task.version,
    proposalSha256: planning.proposalSha256,
  });
  task = await post(second.url, token, `/api/tasks/${task.taskId}/actions`, {
    action: 'implementation-start',
    requestId: 'start-managed-release',
    expectedVersion: task.version,
  });
  assert.equal(task.status, 'RUNNING');

  await run('stop');
  started = false;
  const third = await run('start');
  started = true;
  assert.notEqual(third.pid, second.pid);
  token = (await (await fetch(third.url + '/api/dashboard')).json()).csrfToken;
  task = await waitFor(async () => {
    const body = await (
      await fetch(third.url + `/api/tasks/${task.taskId}`)
    ).json();
    const current = body.task;
    if (current.status === 'FAILED')
      throw new Error(
        `Packaged managed workflow failed: ${JSON.stringify(current)}`,
      );
    return current.status === 'NEEDS_REVIEW' &&
      current.handoff?.contextRefs?.some(
        (ref) => ref.kind === 'reviewed-local-candidate-completion',
      )
      ? current
      : null;
  }, 'Packaged managed workflow did not retain a reviewed candidate.');
  assert(
    task.handoff.contextRefs.some(
      (ref) => ref.kind === 'reviewed-local-candidate-completion',
    ),
  );

  await run('stop');
  started = false;
  await writeFile(join(workspace, 'dirty.txt'), 'must refuse\n');
  await assert.rejects(
    run('apply', '--task', task.taskId),
    /Source checkout must be clean/,
  );
  await rm(join(workspace, 'dirty.txt'));
  const applied = await run('apply', '--task', task.taskId);
  assert.equal(
    await git(workspace, 'rev-parse', 'HEAD'),
    applied.candidateCommit,
  );
  assert.notEqual(applied.candidateCommit, baseCommit);
  assert.equal(await readFile(join(workspace, 'value.txt'), 'utf8'), 'after\n');
  assert.equal(
    (await run('apply', '--task', task.taskId)).candidateCommit,
    applied.candidateCommit,
  );
  const closed = await run('closeout', '--task', task.taskId);
  assert.equal(closed.candidateCommit, applied.candidateCommit);
  assert.equal(
    (await run('closeout', '--task', task.taskId)).applicationSha256,
    closed.applicationSha256,
  );
  console.log(
    `Dashboard clean managed release proof passed at ${applied.candidateCommit}.`,
  );
  passed = true;
} finally {
  if (started) await run('stop').catch(() => undefined);
  if (passed) await rm(temporary, { recursive: true, force: true });
  else console.error(`Dashboard release evidence retained at ${temporary}.`);
}
