import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  inspectGoalPlan,
  materializeGoalPlan,
  parsePlannerPolicy,
  prepareGoalPlan,
  startGoalPlan,
  type GoalPlanHandle,
  type GoalPlanInput,
  type GoalPlanSnapshot,
  type PlannerPolicy,
} from './dashboard-planner.mjs';
const exec = promisify(execFile);
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
async function fixture(
  t: { after(fn: () => Promise<void>): void },
  mode = 'good',
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'temari-planner-')));
  const workspaceRoot = join(root, 'source');
  await mkdir(workspaceRoot);
  await exec('git', ['init', '-q', workspaceRoot]);
  await writeFile(join(workspaceRoot, 'README'), 'original\n');
  await exec('git', ['add', '.'], { cwd: workspaceRoot });
  await exec(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@localhost',
      'commit',
      '-qm',
      'base',
    ],
    { cwd: workspaceRoot },
  );
  const head = (
    await exec('git', ['rev-parse', 'HEAD'], { cwd: workspaceRoot })
  ).stdout.trim();
  const executable = join(root, 'codex');
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs=require('node:fs'),cp=require('node:child_process');
const args=process.argv.slice(2),final=args[args.indexOf('--output-last-message')+1],schema=args[args.indexOf('--output-schema')+1];
let prompt='';process.stdin.on('data',d=>prompt+=d);process.stdin.on('end',()=>{
 fs.appendFileSync(${JSON.stringify(join(root, 'calls'))},JSON.stringify({pid:process.pid,args,prompt,schema:JSON.parse(fs.readFileSync(schema)),cwd:process.cwd()})+'\\n');
 const mode=${JSON.stringify(mode)};
 if(mode==='hang'){setTimeout(()=>{},10000);return;}
 if(mode==='exit'){process.exit(7);return;}
 if(mode==='output-limit'){process.stdout.write('x'.repeat(1100000));return;}
 if(mode==='mutate')fs.writeFileSync('README','changed');
 if(mode==='orphan'){
  const child=cp.spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:'ignore'});child.unref();
  fs.writeFileSync(${JSON.stringify(join(root, 'orphan'))},String(child.pid));
 }
 let p={schema:1,title:'Requested feature',summary:'Two independent changes',assignments:[{slotId:'alpha',goal:'Implement alpha',acceptanceCriteria:['Requested alpha behavior'],dependsOn:[]},{slotId:'beta',goal:'Implement beta',acceptanceCriteria:['Requested beta behavior'],dependsOn:[]}],blockers:[]};
 if(mode==='unknown-fields')p.assignments[0].owns=[{kind:'directory',path:'.'}];
 if(mode==='injection')p.assignments[0].slotId='../../outside';
 if(mode==='unknown-slot')p.assignments[0].slotId='not-allowed';
 if(mode==='dependencies')p.assignments[1].dependsOn=['alpha'];
 if(mode==='blockers')p.blockers=['Needs source access outside host scope'];
 if(mode==='duplicate')p.assignments[1].slotId='alpha';
 if(mode==='missing')delete p.assignments[0].acceptanceCriteria;
 const finish=()=>{fs.writeFileSync(final,mode==='malformed'?'not json':mode==='oversize'?'x'.repeat(70000):JSON.stringify(p));console.log(JSON.stringify({event:'finished'}));};
 setTimeout(finish,mode==='slow'?600:15);
});
`,
  );
  await chmod(executable, 0o755);
  const policy: PlannerPolicy = {
    id: 'bounded-feature',
    title: 'Bounded feature',
    description: 'Independent owned files',
    slots: ['alpha', 'beta'].map((id) => ({
      id,
      title: id,
      description: `Own ${id}`,
      owns: [{ kind: 'file', path: `${id}.mjs` }],
      mandatoryCriteria: [`Host mandatory ${id}`],
    })),
    prepare: [],
    verify: [
      {
        program: await realpath(process.execPath),
        args: ['-e', 'process.exit(0)'],
        timeoutMs: 1000,
      },
    ],
    reviewer: {
      id: 'reviewer',
      role: 'reviewer',
      required: true,
      brief: {
        goal: 'Review exact candidate',
        context: 'Independent review',
        scope: 'Integrated candidate',
        acceptanceCriteria: ['Report unresolved issues'],
        verificationCommand: null,
        reportFormat: 'json',
        forbiddenActions: ['No edits'],
      },
    },
  };
  const input: GoalPlanInput = {
    root: join(root, 'preparations', 'task-1', 'planning'),
    taskId: 'task-1',
    requestId: 'request-1',
    goal: 'Implement alpha and beta',
    workspaceRoot,
    candidate: { head, fingerprint: hash('') },
    policy,
    executable,
    timeoutMs: mode === 'hang' ? 1000 : 5000,
  };
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return { root, input };
}
async function settled(handle: GoalPlanHandle): Promise<GoalPlanSnapshot> {
  const until = Date.now() + 12_000;
  let last: GoalPlanSnapshot;
  do {
    last = await inspectGoalPlan(handle);
    if (!['STARTING', 'RUNNING', 'PREPARED'].includes(last.state)) return last;
    await new Promise((r) => setTimeout(r, 40));
  } while (Date.now() < until);
  throw new Error(`Planner did not settle: ${JSON.stringify(last!)}`);
}
async function calls(root: string): Promise<any[]> {
  try {
    return (await readFile(join(root, 'calls'), 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

test('host policy rejects overlap, unknown fields, dangerous paths and missing fixed verification', async (t) => {
  const { input } = await fixture(t);
  for (const edit of [
    (p: any) => {
      p.slots[1].owns[0].path = 'ALPHA.mjs';
    },
    (p: any) => {
      p.slots[0].owns = [{ kind: 'directory', path: 'src' }];
      p.slots[1].owns = [{ kind: 'file', path: 'src/a.mjs' }];
    },
    (p: any) => {
      p.slots[0].owns[0].path = '../escape';
    },
    (p: any) => {
      p.slots[0].owns[0].path = '.git/config';
    },
    (p: any) => {
      p.slots[0].owns[0].extra = true;
    },
    (p: any) => {
      p.verify = [];
    },
    (p: any) => {
      p.verify[0].program = 'node';
    },
    (p: any) => {
      p.verify[0].timeoutMs = 1_800_001;
    },
    (p: any) => {
      p.reviewer.id = 'alpha';
    },
    (p: any) => {
      p.slots.push(p.slots[0]);
    },
    (p: any) => {
      p.slots = [p.slots[0]];
    },
  ]) {
    const p = structuredClone(input.policy);
    edit(p);
    assert.throws(() => parsePlannerPolicy(p));
  }
  assert.deepEqual(parsePlannerPolicy(input.policy), input.policy);
});

test('preparation is inert, replay is stable, and goal/policy request changes conflict', async (t) => {
  const { root, input } = await fixture(t);
  const handle = await prepareGoalPlan(input);
  assert.equal(handle.requestPath, join(input.root, 'request.json'));
  assert.deepEqual(await prepareGoalPlan(input), handle);
  assert.equal((await inspectGoalPlan(handle)).canStart, true);
  assert.deepEqual(await calls(root), []);
  await assert.rejects(
    prepareGoalPlan({ ...input, goal: 'Different goal' }),
    /binding/,
  );
  await assert.rejects(
    prepareGoalPlan({
      ...input,
      policy: { ...input.policy, description: 'Different policy' },
    }),
    /binding/,
  );
});

test('structured planner retains exact process evidence and materializes only host-owned authority', async (t) => {
  const { root, input } = await fixture(t);
  const handle = await prepareGoalPlan(input);
  await startGoalPlan(handle);
  const snapshot = await settled(handle);
  assert.equal(snapshot.state, 'READY', snapshot.statusNote);
  assert(snapshot.canPrepare && !snapshot.canStart);
  assert.equal(snapshot.policyId, input.policy.id);
  assert.equal(snapshot.evidenceRefs.length, 8);
  const seen = await calls(root);
  assert.equal(seen.length, 1);
  assert(seen[0].args.includes('--ignore-user-config'));
  assert.equal(
    seen[0].args[seen[0].args.indexOf('--sandbox') + 1],
    'read-only',
  );
  assert.equal(
    seen[0].schema.properties.assignments.items.properties.slotId.enum.join(
      ',',
    ),
    'alpha,beta',
  );
  assert(!('status' in seen[0].schema.properties));
  const plan = await materializeGoalPlan(
    input.policy,
    snapshot,
    input.candidate,
  );
  assert.deepEqual(
    plan.assignments.map((a) => a.owns),
    input.policy.slots.map((s) => s.owns),
  );
  assert.deepEqual(plan.verify, input.policy.verify);
  assert.deepEqual(plan.prepare, []);
  assert(
    plan.assignments.every(
      (a) => a.worker.required && a.worker.brief.verificationCommand === null,
    ),
  );
  assert(
    plan.assignments[0].worker.brief.acceptanceCriteria.includes(
      'Host mandatory alpha',
    ),
  );
  assert.equal(plan.reviewer.id, 'reviewer');
  assert.equal(plan.proposalSha256, snapshot.proposalSha256);
  assert.deepEqual((await startGoalPlan(handle)).proposal, snapshot.proposal);
  assert.equal((await calls(root)).length, 1);
});

for (const mode of [
  'malformed',
  'unknown-fields',
  'injection',
  'unknown-slot',
  'dependencies',
  'blockers',
  'duplicate',
  'missing',
  'oversize',
  'exit',
  'output-limit',
  'hang',
]) {
  test(`planner ${mode} result blocks preparation without automatic repair or retry`, async (t) => {
    const { root, input } = await fixture(t, mode);
    const handle = await prepareGoalPlan(input);
    await startGoalPlan(handle);
    const snapshot = await settled(handle);
    assert.equal(snapshot.state, 'BLOCKED', snapshot.statusNote);
    assert(!snapshot.canPrepare && !snapshot.canStart);
    assert.equal(snapshot.proposal, null);
    await assert.rejects(
      materializeGoalPlan(input.policy, snapshot, input.candidate),
      /not ready/,
    );
    await startGoalPlan(handle);
    assert.equal((await calls(root)).length, 1);
  });
}

test('concurrent start and fresh handle observation retain one paid model call', async (t) => {
  const { root, input } = await fixture(t, 'slow');
  const handle = await prepareGoalPlan(input);
  await Promise.all([
    startGoalPlan(handle),
    startGoalPlan(structuredClone(handle)),
    startGoalPlan(handle),
  ]);
  const fresh = JSON.parse(JSON.stringify(handle));
  assert.equal((await settled(fresh)).state, 'READY');
  assert.equal((await calls(root)).length, 1);
});

test('stale launch intent refuses takeover and never starts a model', async (t) => {
  const { root, input } = await fixture(t);
  const handle = await prepareGoalPlan(input);
  await writeFile(
    join(input.root, 'intent.json'),
    JSON.stringify({
      nonce: 'lost-owner',
      at: Date.now() - 60_000,
      manifestSha256: handle.manifestSha256,
    }),
  );
  const snapshot = await startGoalPlan(handle);
  assert.equal(snapshot.state, 'RECOVERY_REQUIRED');
  assert(!snapshot.canStart && !snapshot.canPrepare);
  assert.deepEqual(await calls(root), []);
});

test('source drift before launch does not reserve a model call and drift after planning refuses materialization', async (t) => {
  const { root, input } = await fixture(t);
  const handle = await prepareGoalPlan(input);
  await writeFile(join(input.workspaceRoot, 'README'), 'dirty');
  await assert.rejects(startGoalPlan(handle), /clean/);
  assert.deepEqual(await calls(root), []);
  await writeFile(join(input.workspaceRoot, 'README'), 'original\n');
  await startGoalPlan(handle);
  const snapshot = await settled(handle);
  assert.equal(snapshot.state, 'READY');
  await assert.rejects(
    materializeGoalPlan(
      { ...input.policy, description: 'changed' },
      snapshot,
      input.candidate,
    ),
    /policy changed/,
  );
  await assert.rejects(
    materializeGoalPlan(
      input.policy,
      { ...snapshot, goal: 'changed' },
      input.candidate,
    ),
    /goal changed/,
  );
  await assert.rejects(
    materializeGoalPlan(input.policy, snapshot, {
      ...input.candidate,
      head: 'a'.repeat(40),
    }),
    /candidate changed/,
  );
  await writeFile(join(input.workspaceRoot, 'README'), 'dirty after planning');
  await assert.rejects(
    materializeGoalPlan(input.policy, snapshot, input.candidate),
    /clean/,
  );
});

test('model source mutation cannot produce an admitted proposal', async (t) => {
  const { input } = await fixture(t, 'mutate');
  const handle = await prepareGoalPlan(input);
  await startGoalPlan(handle);
  const snapshot = await settled(handle);
  assert.equal(snapshot.state, 'BLOCKED');
  assert.match(snapshot.statusNote, /clean/);
});

test('tampered raw model output or snapshot cannot authorize execution', async (t) => {
  const { input } = await fixture(t);
  const handle = await prepareGoalPlan(input);
  await startGoalPlan(handle);
  const snapshot = await settled(handle);
  assert.equal(snapshot.state, 'READY');
  const forged = structuredClone(snapshot);
  (forged.proposal!.assignments[0] as any).goal = 'Other work';
  await assert.rejects(
    materializeGoalPlan(input.policy, forged, input.candidate),
    /proposal changed/,
  );
  await writeFile(join(input.root, 'final.json'), '{}');
  const changed = await inspectGoalPlan(handle);
  assert.equal(changed.state, 'RECOVERY_REQUIRED');
  assert(changed.integrityIssue);
  await assert.rejects(
    materializeGoalPlan(input.policy, snapshot, input.candidate),
    /not ready/,
  );
});

test('symlinked draft storage and evidence inside source are refused', async (t) => {
  const { root, input } = await fixture(t);
  const alias = join(root, 'alias');
  await symlink(root, alias);
  await assert.rejects(
    prepareGoalPlan({ ...input, root: join(alias, 'planning') }),
    /symlink/,
  );
  await assert.rejects(
    prepareGoalPlan({ ...input, root: join(input.workspaceRoot, 'planning') }),
    /outside workspace/,
  );
});

test('normal model exit drains a leftover owned process group before draft readiness', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX process group proof');
  const { root, input } = await fixture(t, 'orphan');
  const handle = await prepareGoalPlan(input);
  await startGoalPlan(handle);
  const snapshot = await settled(handle);
  assert.equal(snapshot.state, 'READY', snapshot.statusNote);
  const record = JSON.parse(
    await readFile(join(input.root, 'process.json'), 'utf8'),
  );
  assert.equal(record.drained, true);
  const pid = Number(await readFile(join(root, 'orphan'), 'utf8'));
  assert.throws(
    () => process.kill(pid, 0),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH',
  );
});

test('policy size is bounded before any model call or preparation write', async (t) => {
  const { root, input } = await fixture(t);
  const policy = structuredClone(input.policy) as any;
  policy.verify[0].args = Array.from({ length: 30 }, () => 'x'.repeat(8192));
  assert.throws(() => parsePlannerPolicy(policy), /128 KiB/);
  await assert.rejects(prepareGoalPlan({ ...input, policy }), /128 KiB/);
  assert.deepEqual(await calls(root), []);
});

test('a killed supervisor leaves uncertain ownership and cannot launch a second paid call', async (t) => {
  if (process.platform === 'win32')
    return t.skip('POSIX supervisor process ownership');
  const { root, input } = await fixture(t, 'hang');
  const handle = await prepareGoalPlan({ ...input, timeoutMs: 5000 });
  await startGoalPlan(handle);
  const deadline = Date.now() + 5000;
  let observedCalls = await calls(root);
  while (observedCalls.length === 0 && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 20));
    observedCalls = await calls(root);
  }
  assert.equal(observedCalls.length, 1);
  const modelPid = observedCalls[0].pid as number;
  t.after(async () => {
    try {
      process.kill(-modelPid, 'SIGKILL');
    } catch {}
  });
  const owner = JSON.parse(
    await readFile(join(input.root, 'observed.json'), 'utf8'),
  );
  process.kill(owner.pid, 'SIGKILL');
  // This read observes the detached process still alive, rather than treating
  // the missing supervisor as proof that its paid child has stopped.
  process.kill(modelPid, 0);
  await new Promise((done) => setTimeout(done, 5200));
  const recovered = await startGoalPlan(JSON.parse(JSON.stringify(handle)));
  assert.equal(recovered.state, 'RECOVERY_REQUIRED');
  assert(!recovered.canStart && !recovered.canPrepare);
  assert.equal((await calls(root)).length, 1);
  process.kill(-modelPid, 'SIGKILL');
});
