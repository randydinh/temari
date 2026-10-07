import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  open,
  stat,
  readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';
import { FileChildTaskStore } from '../libs/runtime/src/index.js';
import {
  prepareDashboardImplementation,
  startDashboardImplementation,
  inspectDashboardImplementation,
  cancelDashboardImplementation,
  type DashboardImplementationHandle,
  type DashboardImplementationRequest,
  type DashboardImplementationSnapshot,
} from './dashboard-implementation.mjs';
const exec = promisify(execFile);
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'temari-implementation-'));
  const workspaceRoot = join(root, 'source');
  await mkdir(workspaceRoot);
  await exec('git', ['init', '-q', workspaceRoot]);
  await writeFile(join(workspaceRoot, 'README'), 'base\n');
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
      'initial',
    ],
    { cwd: workspaceRoot },
  );
  const executable = join(root, 'codex');
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const args=process.argv.slice(2),sandbox=args[args.indexOf('--sandbox')+1],final=args[args.indexOf('--output-last-message')+1];
let prompt='';process.stdin.on('data',d=>prompt+=d);process.stdin.on('end',()=>{
 const goal=prompt.match(/Goal: ([^\\n]+)/)[1];
 const head=cp.execFileSync('git',['rev-parse','HEAD']).toString().trim();
 fs.appendFileSync(${JSON.stringify(join(root, 'calls'))},JSON.stringify({goal,pid:process.pid,at:Date.now(),cwd:process.cwd(),head,sandbox,prompt})+'\\n');
 if(goal==='hang'||goal==='review-hang') {setTimeout(()=>{},30000);return;}
 if(goal==='review-mutate') fs.writeFileSync('README','changed by reviewer');
 if(sandbox==='workspace-write') {
  fs.writeFileSync(goal==='rogue'?'README':goal+'.txt',goal+' change\\n');
 }
 setTimeout(()=>{
  fs.writeFileSync(final,JSON.stringify({status:goal==='review-issues'?'ISSUES':'PASS',summary:goal+' result'}));
  if(goal.startsWith('large-')){ const emit=async(stream,value,prefix)=>{await new Promise((d,r)=>stream.write(prefix,e=>e?r(e):d()));const chunk=Buffer.alloc(65536,value);for(let n=0;n<256;n++)await new Promise((d,r)=>stream.write(chunk,e=>e?r(e):d()));await new Promise((d,r)=>stream.write('!',e=>e?r(e):d()));}; Promise.all([emit(process.stdout,97,['PRIVATE','STDOUT','SENTINEL'].join('_')+':'),emit(process.stderr,122,['PRIVATE','STDERR','SENTINEL'].join('_')+':')]).then(()=>process.exit(goal==='large-exit'?7:0)); }else console.log(JSON.stringify({type:'fixture.complete',goal}));
 },goal==='alpha'?400:100);
});
`,
  );
  await chmod(executable, 0o755);
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return { root, workspaceRoot, executable };
}
function request(
  f: Awaited<ReturnType<typeof fixture>>,
  goals = ['alpha', 'beta'],
  review = 'review',
): DashboardImplementationRequest {
  const brief = (goal: string) => ({
    goal,
    context: 'Fixture',
    scope: 'Owned files only',
    acceptanceCriteria: ['Make the requested change'],
    verificationCommand: null,
    reportFormat: 'json' as const,
    forbiddenActions: ['No commit, push, network, or publication.'],
  });
  return {
    root: join(f.root, 'storage'),
    taskId: 'task-1',
    runId: 'implementation-1',
    revision: 'revision-1',
    workspaceRoot: f.workspaceRoot,
    executable: f.executable,
    maxConcurrency: 2,
    timeoutMs: 5000,
    prepare: [],
    verify: [
      {
        program: process.execPath,
        args: [
          '-e',
          "const fs=require('fs');if(!fs.existsSync('alpha.txt')||!fs.existsSync('beta.txt'))process.exit(1)",
        ],
      },
    ],
    assignments: goals.map((goal, i) => ({
      worker: {
        id: `worker-${i + 1}`,
        role: 'implementer',
        required: true,
        brief: brief(goal),
      },
      owns: [{ kind: 'file', path: goal + '.txt' }],
    })),
    reviewer: {
      id: 'independent-reviewer',
      role: 'reviewer',
      required: true,
      brief: brief(review),
    },
  };
}
async function until(
  handle: DashboardImplementationHandle,
  predicate: (s: DashboardImplementationSnapshot) => boolean,
  timeout = 20_000,
): Promise<DashboardImplementationSnapshot> {
  const end = Date.now() + timeout;
  let s: DashboardImplementationSnapshot;
  do {
    s = await inspectDashboardImplementation(handle);
    if (predicate(s)) return s;
    await new Promise((done) => setTimeout(done, 50));
  } while (Date.now() < end);
  throw new Error(
    `Timed out ${JSON.stringify(s)}\n${await readFile(join(dirname(handle.requestPath), 'supervisor.log'), 'utf8').catch(() => '(no log)')}`,
  );
}
async function calls(root: string): Promise<
  {
    goal: string;
    pid: number;
    at: number;
    cwd: string;
    head: string;
    sandbox: string;
    prompt: string;
  }[]
> {
  return (await readFile(join(root, 'calls'), 'utf8').catch(() => ''))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
async function finish(handle: DashboardImplementationHandle) {
  return until(handle, (s) =>
    ['COMPLETE', 'FAILED', 'CANCELLED', 'RECOVERY_REQUIRED'].includes(s.state),
  );
}

test('isolated real implementers integrate exact patches then independent reviewer binds exact commit; duplicate start and fresh client retain one execution', async (t) => {
  const f = await fixture(t);
  const initialRequest = request(f);
  const input = {
    ...initialRequest,
    verify: [
      {
        ...initialRequest.verify[0]!,
        args: [
          '-e',
          `${initialRequest.verify[0]!.args[1]};console.log(['host','raw','log'].join('-'))`,
        ],
      },
    ],
  };
  const handle = await prepareDashboardImplementation(input);
  assert.deepEqual(await prepareDashboardImplementation(input), handle);
  const initial = await inspectDashboardImplementation(handle);
  assert.equal(initial.state, 'PREPARED');
  assert.equal(initial.review?.task.status, 'QUEUED');
  assert.notEqual(handle.reviewGroupId, handle.groupId);
  assert.equal((await calls(f.root)).length, 0);
  await Promise.all([
    startDashboardImplementation(handle),
    startDashboardImplementation(handle),
  ]);
  const recovered = JSON.parse(
    JSON.stringify(handle),
  ) as DashboardImplementationHandle;
  const result = await finish(recovered);
  assert.equal(result.state, 'COMPLETE', JSON.stringify(result));
  assert.equal(result.integrityIssue, null);
  assert.equal(result.canCancel, false);
  assert.equal(result.receipt?.status, 'PASS');
  assert.equal(result.receipt?.peakConcurrency, 2);
  assert.equal(result.integration?.status, 'PASS');
  assert.equal(result.integration?.patches.length, 2);
  assert.equal(result.review?.result?.status, 'PASS');
  assert.equal(result.review?.task.status, 'SUCCEEDED');
  const invoked = await calls(f.root);
  assert.equal(invoked.length, 3);
  assert.equal(new Set(invoked.map((call) => call.pid)).size, 3);
  const builders = invoked.filter((c) => c.sandbox === 'workspace-write'),
    reviewer = invoked.find((c) => c.sandbox === 'read-only')!;
  assert.equal(new Set(builders.map((c) => c.cwd)).size, 2);
  assert.equal(reviewer.head, result.integration?.integratedCommit);
  assert.match(reviewer.prompt, new RegExp(reviewer.head));
  assert.equal(result.review?.revision, reviewer.head);
  const resolvedPath = result.review!.result!.evidencePaths.find((path) =>
    path.endsWith('/review-request.json'),
  )!;
  const resolved = JSON.parse(await readFile(resolvedPath, 'utf8'));
  const summaryMatch = resolved.assignment.brief.context.match(
    /Host-observed verification summary \(JSON; no raw logs\):\n([\s\S]*?)\nEnd host verification summary\./,
  );
  assert(
    summaryMatch,
    'Resolved reviewer input must contain inline host verification results.',
  );
  const verification = result.integration!.verification[0]!;
  const log = await readFile(verification.logPath);
  const digest = createHash('sha256').update(log).digest('hex');
  assert.deepEqual(JSON.parse(summaryMatch[1]), {
    status: 'PASS',
    commands: [
      {
        program: input.verify[0]!.program,
        args: input.verify[0]!.args,
        exitCode: 0,
        retainedLogPath: verification.logPath,
        logSha256: digest,
      },
    ],
  });
  assert.equal(
    resolved.integration.files.find(
      (file: { path: string }) => file.path === verification.logPath,
    ).reference.sha256,
    digest,
  );
  assert(reviewer.prompt.includes(summaryMatch[1]));
  assert.match(
    reviewer.prompt,
    /independent source assessment.*coordinator's semantic acceptance remain separate/,
  );
  assert(log.toString().includes('host-raw-log'));
  assert(
    !reviewer.prompt.includes('host-raw-log'),
    'Raw log contents must not be injected into the reviewer prompt.',
  );

  const head = (
    await exec('git', ['rev-parse', 'HEAD'], { cwd: f.workspaceRoot })
  ).stdout.trim();
  assert(builders.every((b) => b.head === head));
  assert.notEqual(reviewer.head, head);
  assert.equal(
    (
      await exec('git', ['status', '--porcelain', '--untracked-files=all'], {
        cwd: f.workspaceRoot,
      })
    ).stdout,
    '',
  );
  await assert.rejects(readFile(join(f.workspaceRoot, 'alpha.txt')), /ENOENT/);
  const processes = await Promise.all(
    result.workers.map(async (w) =>
      JSON.parse(
        await readFile(
          w.task.result!.evidencePaths.find((p) =>
            p.endsWith('/process.json'),
          )!,
          'utf8',
        ),
      ),
    ),
  );
  assert(
    Math.max(...processes.map((p) => Date.parse(p.startedAt))) <
      Math.min(...processes.map((p) => Date.parse(p.endedAt))),
  );
  await startDashboardImplementation(recovered);
  assert.equal((await calls(f.root)).length, 3);
});
test('preflight rejects overlapping scopes and dirty candidate before any launch', async (t) => {
  const f = await fixture(t),
    input = request(f);
  await assert.rejects(
    prepareDashboardImplementation({
      ...input,
      assignments: [
        input.assignments[0]!,
        { ...input.assignments[1]!, owns: input.assignments[0]!.owns },
      ],
    }),
    /overlap/,
  );
  await writeFile(join(f.workspaceRoot, 'README'), 'dirty');
  await assert.rejects(prepareDashboardImplementation(input), /clean/);
  assert.equal((await calls(f.root)).length, 0);
});
test('out of scope worker cannot integrate; successful sibling and blocked durable reviewer remain visible', async (t) => {
  const f = await fixture(t),
    handle = await prepareDashboardImplementation(
      request(f, ['alpha', 'rogue']),
    );
  await startDashboardImplementation(handle);
  const result = await finish(handle);
  assert.equal(result.state, 'FAILED');
  assert.equal(result.integration?.integratedCommit, null);
  assert.equal(result.integration?.patches.length, 1);
  assert(result.workers.some((w) => w.task.status === 'SUCCEEDED'));
  assert.equal(result.review?.result?.status, 'BLOCKED');
  assert.equal(result.review?.task.status, 'BLOCKED');
  assert.equal((await calls(f.root)).length, 2);
  assert.equal(
    await readFile(join(f.workspaceRoot, 'README'), 'utf8'),
    'base\n',
  );
});
test('verification mutation prevents commit and resolves reviewer without invoking it', async (t) => {
  const f = await fixture(t),
    input = request(f);
  const handle = await prepareDashboardImplementation({
    ...input,
    verify: [
      {
        program: process.execPath,
        args: [
          '-e',
          "require('fs').writeFileSync('alpha.txt','verification mutation')",
        ],
      },
    ],
  });
  await startDashboardImplementation(handle);
  const result = await finish(handle);
  assert.equal(result.state, 'FAILED');
  assert.equal(result.integration?.status, 'BLOCKED');
  assert.equal(result.integration?.integratedCommit, null);
  assert.equal(result.review?.result?.status, 'BLOCKED');
  assert.equal((await calls(f.root)).length, 2);
});
test('tampered successful sibling retains lifecycle and cancellation drains a hanging implementer', async (t) => {
  const f = await fixture(t),
    handle = await prepareDashboardImplementation({
      ...request(f, ['alpha', 'hang']),
      timeoutMs: 30_000,
    });
  await startDashboardImplementation(handle);
  const progress = await until(
    handle,
    (s) =>
      s.workers.some((w) => w.task.status === 'SUCCEEDED') &&
      s.workers.some((w) => w.task.status === 'RUNNING'),
  );
  const first = progress.workers.find((w) => w.task.status === 'SUCCEEDED')!;
  await writeFile(
    first.task.result!.evidencePaths.find((p) => p.endsWith('/patch.diff'))!,
    'tampered',
  );
  const tainted = await inspectDashboardImplementation(handle);
  assert.equal(tainted.state, 'RUNNING');
  assert(tainted.integrityIssue);
  assert(tainted.canCancel);
  await cancelDashboardImplementation(handle);
  const result = await until(handle, (s) => s.state === 'CANCELLED');
  assert.equal(result.canCancel, false);
  assert.equal(result.review?.task.status, 'CANCELLED');
  assert(result.workers.some((w) => w.task.status === 'SUCCEEDED'));
  const hung = result.workers.find((w) => w.task.status === 'CANCELLED')!;
  if (hung.task.result) {
    const proc = JSON.parse(
      await readFile(
        hung.task.result.evidencePaths.find((p) =>
          p.endsWith('/process.json'),
        )!,
        'utf8',
      ),
    );
    assert(proc.cancelled);
  }
});
test('cancellation drains an in-progress fixed verification command without starting reviewer', async (t) => {
  const f = await fixture(t),
    handle = await prepareDashboardImplementation({
      ...request(f),
      verify: [
        {
          program: process.execPath,
          args: ['-e', 'setTimeout(()=>{},30000)'],
          timeoutMs: 30_000,
        },
      ],
    });
  await startDashboardImplementation(handle);
  await until(handle, (s) => s.phase === 'verifying');
  await cancelDashboardImplementation(handle);
  const result = await until(handle, (s) => s.state === 'CANCELLED');
  assert.equal(result.canCancel, false);
  assert.equal(result.review?.task.status, 'CANCELLED');
  assert.equal((await calls(f.root)).length, 2);
});
test('review cancellation is durable and drains the independently owned read-only process', async (t) => {
  const f = await fixture(t),
    handle = await prepareDashboardImplementation({
      ...request(f, undefined, 'review-hang'),
      timeoutMs: 30_000,
    });
  await startDashboardImplementation(handle);
  await until(handle, (s) => s.review?.task.status === 'RUNNING');
  await cancelDashboardImplementation(handle);
  const result = await until(handle, (s) => s.state === 'CANCELLED');
  assert.equal(result.review?.task.status, 'CANCELLED');
  assert.equal(result.canCancel, false);
  assert.equal(result.integration?.status, 'PASS');
});
test('completed candidate tamper produces integrity issue without changing observed completion or relaunching', async (t) => {
  const f = await fixture(t),
    handle = await prepareDashboardImplementation(request(f));
  await startDashboardImplementation(handle);
  const complete = await finish(handle);
  assert.equal(complete.state, 'COMPLETE');
  await writeFile(
    join(complete.integration!.integrationPath, 'alpha.txt'),
    'tamper',
  );
  const result = await inspectDashboardImplementation(handle);
  assert.equal(result.state, 'COMPLETE');
  assert.match(result.integrityIssue!, /Candidate working tree changed/);
  assert.equal(result.canCancel, false);
  await startDashboardImplementation(handle);
  assert.equal((await calls(f.root)).length, 3);
});
test('reviewer changing its candidate cannot produce a usable reviewed integration', async (t) => {
  const f = await fixture(t),
    handle = await prepareDashboardImplementation(
      request(f, undefined, 'review-mutate'),
    );
  await startDashboardImplementation(handle);
  const result = await finish(handle);
  assert.equal(result.state, 'FAILED');
  assert(result.integrityIssue);
  assert.notEqual(result.review?.task.status, 'SUCCEEDED');
  assert.equal((await calls(f.root)).length, 3);
});
test('unobserved old launch is recovery required; cancellation never proves old process absence', async (t) => {
  const f = await fixture(t),
    handle = await prepareDashboardImplementation(request(f));
  const root = dirname(handle.requestPath);
  await writeFile(
    join(root, 'intent.json'),
    JSON.stringify({
      nonce: 'lost',
      at: Date.now() - 10000,
      manifestSha256: handle.manifestSha256,
    }),
  );
  assert.equal(
    (await startDashboardImplementation(handle)).state,
    'RECOVERY_REQUIRED',
  );
  const cancelled = await cancelDashboardImplementation(handle);
  assert.equal(cancelled.state, 'RECOVERY_REQUIRED');
  assert.equal(cancelled.canCancel, true);
  assert.equal((await calls(f.root)).length, 0);
});
test('manifest or handle tamper fails before launch and prepared cancellation launches nothing', async (t) => {
  const f = await fixture(t),
    handle = await prepareDashboardImplementation(request(f));
  await assert.rejects(
    startDashboardImplementation({ ...handle, reviewGroupId: 'other' }),
    /handle changed/,
  );
  const result = await cancelDashboardImplementation(handle);
  assert.equal(result.state, 'CANCELLED');
  assert.equal(result.canCancel, false);
  await startDashboardImplementation(handle);
  assert.equal((await calls(f.root)).length, 0);
});

test('portable evidence and reviewer binding tamper are detected; late cancellation preserves completed observations', async (t) => {
  const f = await fixture(t),
    handle = await prepareDashboardImplementation(request(f));
  await startDashboardImplementation(handle);
  const complete = await finish(handle);
  assert.equal(complete.state, 'COMPLETE');
  const cancelled = await cancelDashboardImplementation(handle);
  assert.equal(cancelled.state, 'COMPLETE');
  assert.equal(cancelled.review?.task.status, 'SUCCEEDED');
  const ref = complete.workers[0]!.task.result!.evidenceReferences![0]!;
  await writeFile(
    join(dirname(handle.requestPath), 'evidence', `${ref.sha256}.artifact`),
    'tampered portable artifact',
  );
  const result = await inspectDashboardImplementation(handle);
  assert.equal(result.state, 'COMPLETE');
  assert(result.integrityIssue);
  assert.equal(result.canCancel, false);
  const reviewInput = complete.review!.task.result!.evidencePaths.find((path) =>
    path.endsWith('/review-request.json'),
  )!;
  const original = JSON.parse(await readFile(reviewInput, 'utf8'));
  await writeFile(
    reviewInput,
    JSON.stringify({ ...original, revision: 'f'.repeat(40) }),
  );
  const rebound = await inspectDashboardImplementation(handle);
  assert.match(rebound.integrityIssue!, /Reviewer candidate revision changed/);
});

test('completed lifecycle remains observed while missing required artifacts block use of its results', async (t) => {
  const f = await fixture(t),
    input = request(f),
    handle = await prepareDashboardImplementation(input);
  await startDashboardImplementation(handle);
  const complete = await finish(handle);
  assert.equal(complete.state, 'COMPLETE');
  assert.equal(complete.integrityIssue, null);
  const root = dirname(handle.requestPath);
  const reviewBinding = complete.review!.task.result!.evidencePaths.find(
    (path) => path.endsWith('/review-request.json'),
  )!;
  const cases = [
    {
      path: join(root, 'integration.json'),
      issue: /missing verified integration evidence/,
    },
    {
      path: join(root, 'receipts', `${input.runId}.parallel.receipt.json`),
      issue: /missing its implementer receipt/,
    },
    {
      path: join(
        root,
        'review-receipts',
        `${input.runId}.parallel.receipt.json`,
      ),
      issue: /missing its independent review receipt/,
    },
    {
      path: reviewBinding,
      issue: /missing its verified reviewer candidate binding/,
    },
  ];
  for (const item of cases) {
    const original = await readFile(item.path);
    await rm(item.path);
    const incomplete = await inspectDashboardImplementation(handle);
    assert.equal(incomplete.state, 'COMPLETE');
    assert.equal(incomplete.canCancel, false);
    assert.match(incomplete.integrityIssue!, item.issue);
    assert.equal(incomplete.review?.task.status, 'SUCCEEDED');
    // Inspecting or repeating start must not attempt to regenerate missing evidence.
    assert.equal(
      (await startDashboardImplementation(handle)).state,
      'COMPLETE',
    );
    assert.equal((await calls(f.root)).length, 3);
    await writeFile(item.path, original, { mode: 0o600 });
    assert.equal(
      (await inspectDashboardImplementation(handle)).integrityIssue,
      null,
    );
  }
});

test('oversized inline verification metadata blocks reviewer launch without dropping sealed host results', async (t) => {
  const f = await fixture(t),
    input = request(f);
  const handle = await prepareDashboardImplementation({
    ...input,
    verify: [
      {
        program: process.execPath,
        args: ['-e', input.verify[0]!.args[1]!, 'x'.repeat(16 * 1024)],
      },
    ],
  });
  await startDashboardImplementation(handle);
  const result = await finish(handle);
  assert.equal(result.state, 'FAILED');
  assert.equal(result.integration?.status, 'PASS');
  assert.equal(result.review?.result?.status, 'BLOCKED');
  assert.match(
    result.review!.result!.summary,
    /supervisor failed; diagnostic retained; sha256=/,
  );
  assert.match(
    await readFile(
      join(dirname(handle.requestPath), 'supervisor-failure.log'),
      'utf8',
    ),
    /verification summary exceeds 16 KiB/,
  );
  assert.equal((await calls(f.root)).length, 2);
});

test('observed supervisor awaiting its first heartbeat stays starting only within the launch window', async (t) => {
  const f = await fixture(t),
    handle = await prepareDashboardImplementation(request(f));
  const root = dirname(handle.requestPath),
    intent = {
      nonce: 'initial-heartbeat',
      at: Date.now(),
      manifestSha256: handle.manifestSha256,
    };
  await writeFile(join(root, 'intent.json'), JSON.stringify(intent));
  await writeFile(
    join(root, 'observed.json'),
    JSON.stringify({ nonce: intent.nonce, pid: process.pid }),
  );
  const starting = await inspectDashboardImplementation(handle);
  assert.equal(starting.state, 'STARTING');
  assert.equal(starting.canCancel, true);
  await writeFile(
    join(root, 'intent.json'),
    JSON.stringify({ ...intent, at: Date.now() - 10_000 }),
  );
  assert.equal(
    (await inspectDashboardImplementation(handle)).state,
    'RECOVERY_REQUIRED',
  );
  assert.equal(
    (await startDashboardImplementation(handle)).state,
    'RECOVERY_REQUIRED',
  );
  assert.equal((await calls(f.root)).length, 0);
});

test('a terminal marker published during a child read cannot produce an earlier reviewer snapshot', async (t) => {
  const f = await fixture(t),
    input = request(f);
  const handle = await prepareDashboardImplementation({
    ...input,
    verify: [
      {
        program: process.execPath,
        args: ['-e', input.verify[0]!.args[1]!, 'x'.repeat(16 * 1024)],
      },
    ],
  });
  const prepared = await inspectDashboardImplementation(handle);
  await startDashboardImplementation(handle);
  const complete = await until(
    handle,
    (s) => s.state === 'FAILED' && s.review?.result?.status === 'BLOCKED',
  );
  assert.equal(complete.integration?.status, 'PASS');
  assert.equal((await calls(f.root)).length, 2);
  const root = dirname(handle.requestPath);
  const markerPath = join(root, 'ended.json');
  const marker = await readFile(markerPath);
  await rm(markerPath);
  const pulse = JSON.parse(
    await readFile(join(root, 'heartbeat.json'), 'utf8'),
  );
  t.mock.method(Date, 'now', () => pulse.at);
  const originalLoad = FileChildTaskStore.prototype.load;
  let published = false;
  const load = t.mock.method(
    FileChildTaskStore.prototype,
    'load',
    async function (this: FileChildTaskStore, taskId: string) {
      if (!published && taskId === prepared.review!.task.taskId) {
        published = true;
        await writeFile(markerPath, marker);
        return structuredClone(prepared.review!.task);
      }
      return originalLoad.call(this, taskId);
    },
  );
  const duringPublication = await inspectDashboardImplementation(handle);
  assert(published);
  assert.equal(duringPublication.state, 'RUNNING');
  assert.equal(duringPublication.review?.result, null);
  assert.equal(duringPublication.canCancel, true);
  load.mock.restore();
  const terminal = await inspectDashboardImplementation(handle);
  assert.equal(terminal.state, 'FAILED');
  assert.equal(terminal.integration?.status, 'PASS');
  assert.equal(terminal.review?.result?.status, 'BLOCKED');
  assert.match(
    terminal.review!.result!.summary,
    /supervisor failed; diagnostic retained; sha256=/,
  );
  assert.match(
    await readFile(
      join(dirname(handle.requestPath), 'supervisor-failure.log'),
      'utf8',
    ),
    /verification summary exceeds 16 KiB/,
  );
  assert.equal(terminal.integrityIssue, null);
  const log = await readFile(join(root, 'supervisor.log'));
  assert.equal((await startDashboardImplementation(handle)).state, 'FAILED');
  assert.deepEqual(await readFile(join(root, 'supervisor.log')), log);
  assert.equal((await calls(f.root)).length, 2);
});

const diagnosticStdoutPrefix = 'PRIVATE_STDOUT_SENTINEL:';
const diagnosticStderrPrefix = 'PRIVATE_STDERR_SENTINEL:';
function diagnosticHash(prefix: string, value: number): string {
  const hashing = createHash('sha256').update(prefix);
  const chunk = Buffer.alloc(65_536, value);
  for (let index = 0; index < 256; index++) hashing.update(chunk);
  return hashing.update('!').digest('hex');
}
async function actualDiagnosticHash(path: string): Promise<string> {
  const hashing = createHash('sha256');
  const file = await open(path, 'r');
  try {
    for await (const chunk of file.createReadStream({ autoClose: false }))
      hashing.update(chunk);
  } finally {
    await file.close();
  }
  return hashing.digest('hex');
}
async function assertLargeDiagnostic(
  path: string,
  stderr = false,
): Promise<void> {
  const prefix = stderr ? diagnosticStderrPrefix : diagnosticStdoutPrefix;
  assert.equal((await stat(path)).size, 16_777_217 + Buffer.byteLength(prefix));
  assert.equal(
    await actualDiagnosticHash(path),
    diagnosticHash(prefix, stderr ? 122 : 97),
  );
}

test('implementation dashboard streams large worker, reviewer and sealed verification evidence and rejects changed artifacts', async (t) => {
  for (const failed of [false, true])
    await t.test(
      failed ? 'nonzero worker' : 'normal worker and verification',
      async (sub) => {
        const f = await fixture(sub);
        const emitter =
          "const emit=async(stream,value,prefix)=>{await new Promise((d,r)=>stream.write(prefix,e=>e?r(e):d()));const chunk=Buffer.alloc(65536,value);for(let n=0;n<256;n++)await new Promise((d,r)=>stream.write(chunk,e=>e?r(e):d()));await new Promise((d,r)=>stream.write('!',e=>e?r(e):d()));};";
        const input = {
          ...request(
            f,
            [failed ? 'large-exit' : 'large-pass', 'beta'],
            'large-review',
          ),
          verify: [
            {
              program: process.execPath,
              args: [
                '-e',
                emitter +
                  "Promise.all([emit(process.stdout,97,['PRIVATE','STDOUT','SENTINEL'].join('_')+':'),emit(process.stderr,122,['PRIVATE','STDERR','SENTINEL'].join('_')+':')]).then(()=>process.exit(0));",
              ],
            },
          ],
        };
        const handle = await prepareDashboardImplementation(input);
        await startDashboardImplementation(handle);
        const snapshot = await finish(handle);
        assert.equal(
          snapshot.state,
          failed ? 'FAILED' : 'COMPLETE',
          JSON.stringify(snapshot),
        );
        const worker = snapshot.workers[0]!;
        assert.equal(worker.task.status, failed ? 'FAILED' : 'SUCCEEDED');
        const directory = dirname(handle.requestPath),
          attempts = await readdir(
            join(directory, 'workers', worker.assignment.id),
          ),
          attempt = join(
            directory,
            'workers',
            worker.assignment.id,
            attempts[0]!,
          );
        await assertLargeDiagnostic(join(attempt, 'stdout.jsonl'));
        await assertLargeDiagnostic(join(attempt, 'stderr.log'), true);
        assert(!JSON.stringify(snapshot).includes('PRIVATE_STD'));
        assert(
          (await calls(f.root)).every(
            (call) => !call.prompt.includes('PRIVATE_STD'),
          ),
        );
        const references = failed
          ? worker.task.failureDiagnostics!.references
          : worker.task.result!.evidenceReferences!;
        const reference = references.find(
          (ref) => ref.sha256 === diagnosticHash(diagnosticStdoutPrefix, 97),
        )!;
        assert(reference);
        const initialCalls = (await calls(f.root)).length;
        assert.equal(
          (await inspectDashboardImplementation(handle)).state,
          snapshot.state,
        );
        assert.equal((await calls(f.root)).length, initialCalls);
        if (!failed) {
          const verification = snapshot.integration!.verification[0]!;
          assert((await stat(verification.logPath)).size > 32 * 1024 * 1024);
          const reviewer = snapshot.review!;
          const reviewStdout = reviewer.task.result!.evidencePaths.find(
            (path) => path.endsWith('stdout.jsonl'),
          )!;
          await assertLargeDiagnostic(reviewStdout);
          const log = await open(verification.logPath, 'r+');
          await log.write(Buffer.from('X'), 0, 1, 0);
          await log.close();
          const changed = await inspectDashboardImplementation(handle);
          assert.equal(changed.state, snapshot.state);
          assert(changed.integrityIssue);
          assert.equal((await calls(f.root)).length, initialCalls);
        } else {
          const artifact = join(
            directory,
            'evidence',
            `${reference.sha256}.artifact`,
          );
          const file = await open(artifact, 'r+');
          await file.write(Buffer.from('X'), 0, 1, 0);
          await file.close();
          assert((await inspectDashboardImplementation(handle)).integrityIssue);
          await rm(artifact);
          assert((await inspectDashboardImplementation(handle)).integrityIssue);
          assert.equal((await calls(f.root)).length, initialCalls);
        }
      },
    );
});

test('failed large verification is sealed in full and its raw bytes never enter the dashboard summary', async (t) => {
  const f = await fixture(t),
    emitter =
      "const emit=async(stream,value,prefix)=>{await new Promise((d,r)=>stream.write(prefix,e=>e?r(e):d()));const chunk=Buffer.alloc(65536,value);for(let n=0;n<256;n++)await new Promise((d,r)=>stream.write(chunk,e=>e?r(e):d()));await new Promise((d,r)=>stream.write('!',e=>e?r(e):d()));};";
  const handle = await prepareDashboardImplementation({
    ...request(f),
    verify: [
      {
        program: process.execPath,
        args: [
          '-e',
          emitter +
            "Promise.all([emit(process.stdout,97,['PRIVATE','STDOUT','SENTINEL'].join('_')+':'),emit(process.stderr,122,['PRIVATE','STDERR','SENTINEL'].join('_')+':')]).then(()=>process.exit(7));",
        ],
      },
    ],
  });
  await startDashboardImplementation(handle);
  const snapshot = await finish(handle);
  assert.equal(snapshot.state, 'FAILED', JSON.stringify(snapshot));
  const verification = snapshot.integration!.verification[0]!;
  assert.equal(verification.code, 7);
  assert((await stat(verification.logPath)).size > 32 * 1024 * 1024);
  assert(!JSON.stringify(snapshot).includes('PRIVATE_STD'));
  assert.equal((await inspectDashboardImplementation(handle)).state, 'FAILED');
});

test('verification launch causes are typed, sealed, and reverified without starting the reviewer or rerunning workers', async (t) => {
  const f = await fixture(t),
    program = join(f.root, 'unlaunchable-verifier');
  await writeFile(program, '#!/no/such/interpreter\n');
  await chmod(program, 0o755);
  const handle = await prepareDashboardImplementation({
    ...request(f),
    verify: [{ program, args: [] }],
  });
  await startDashboardImplementation(handle);
  const snapshot = await finish(handle);
  assert.equal(snapshot.state, 'FAILED', JSON.stringify(snapshot));
  assert.equal((await calls(f.root)).length, 2);
  const capture = snapshot.integration!.verification[0]!.capture!;
  assert(capture);
  assert(capture.error);
  const cause = capture.diagnostics.find((item) => item.category === 'launch')!;
  assert(cause);
  assert(capture.evidencePaths.includes(cause.path));
  assert.equal(await actualDiagnosticHash(cause.path), cause.sha256);
  assert.equal(
    (await inspectDashboardImplementation(handle)).integrityIssue,
    null,
  );
  await rm(
    join(dirname(handle.requestPath), 'evidence', `${cause.sha256}.artifact`),
  );
  const changed = await inspectDashboardImplementation(handle);
  assert(changed.integrityIssue);
  assert.equal(changed.integration, null);
  assert.equal((await calls(f.root)).length, 2);
});

test('dashboard seals captured originals and full assembly cause after transcript write failure and refuses replay tamper', async (t) => {
  const f = await fixture(t),
    preload = join(f.root, 'transcript-fault.mjs');
  await writeFile(
    preload,
    `import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
const open=fs.open;
fs.open=async(...args)=>{const file=await open(...args);if(String(args[0]).endsWith('/verify-0.log'))file.writeFile=async()=>{throw ['PRIVATE','TRANSCRIPT','ASSEMBLY','SENTINEL'].join('_')+':'+ 'q'.repeat(16*1024*1024+1);};return file;};
syncBuiltinESMExports();
`,
  );
  const handle = await prepareDashboardImplementation({
    ...request(f),
    verify: [
      {
        program: process.execPath,
        args: [
          '-e',
          "process.stdout.write('original stdout');process.stderr.write('original stderr');",
        ],
      },
    ],
  });
  const before = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS =
    `${before ?? ''} --import=${pathToFileURL(preload).href}`.trim();
  try {
    await startDashboardImplementation(handle);
  } finally {
    if (before === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = before;
  }
  const snapshot = await finish(handle);
  assert.equal(snapshot.state, 'FAILED', JSON.stringify(snapshot));
  assert.equal(snapshot.integrityIssue, null);
  assert.equal((await calls(f.root)).length, 2);
  const capture = snapshot.integration!.verification[0]!.capture!;
  assert.equal(capture.complete, false);
  assert.equal(capture.transcript!.status, 'capture-failed');
  const cause = capture.diagnostics.find(
    (d) => d.category === 'verification-transcript',
  )!;
  assert(cause);
  const privateCause = await readFile(cause.path, 'utf8');
  assert.equal(
    privateCause,
    'PRIVATE_TRANSCRIPT_ASSEMBLY_SENTINEL:' + 'q'.repeat(16 * 1024 * 1024 + 1),
  );
  assert.equal(cause.bytes, Buffer.byteLength(privateCause));
  assert.equal(await readFile(capture.stdout.path, 'utf8'), 'original stdout');
  assert.equal(await readFile(capture.stderr.path, 'utf8'), 'original stderr');
  assert(
    !JSON.stringify(snapshot).includes('PRIVATE_TRANSCRIPT_ASSEMBLY_SENTINEL'),
  );
  const root = dirname(handle.requestPath),
    sealed = JSON.parse(await readFile(join(root, 'integration.json'), 'utf8'));
  for (const path of [capture.stdout.path, capture.stderr.path, cause.path])
    assert(sealed.files.some((file: { path: string }) => file.path === path));
  assert.equal(
    (await inspectDashboardImplementation(handle)).integrityIssue,
    null,
  );
  await writeFile(capture.stdout.path, 'tampered source');
  assert((await inspectDashboardImplementation(handle)).integrityIssue);
  await writeFile(capture.stdout.path, 'original stdout');
  assert.equal(
    (await inspectDashboardImplementation(handle)).integrityIssue,
    null,
  );
  await rm(join(root, 'evidence', `${cause.sha256}.artifact`));
  assert((await inspectDashboardImplementation(handle)).integrityIssue);
  assert.equal((await calls(f.root)).length, 2);
});

test('dashboard retains current and historical private captures when terminal worker metadata publication fails', async (t) => {
  const f = await fixture(t),
    preload = join(f.root, 'metadata-fault.mjs');
  await writeFile(
    preload,
    `import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';
const write=fs.writeFile;fs.writeFile=async(...args)=>{if(String(args[0]).endsWith('/process.json'))throw ['PRIVATE','METADATA','CAUSE','SENTINEL'].join('_')+':'+ 'm'.repeat(16*1024*1024+1);return write(...args);};syncBuiltinESMExports();`,
  );
  const handle = await prepareDashboardImplementation(request(f));
  const before = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS =
    `${before ?? ''} --import=${pathToFileURL(preload).href}`.trim();
  try {
    await startDashboardImplementation(handle);
  } finally {
    if (before === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = before;
  }
  const snapshot = await finish(handle);
  assert.equal(snapshot.state, 'FAILED', JSON.stringify(snapshot));
  assert.equal(snapshot.integrityIssue, null);
  assert(!JSON.stringify(snapshot).includes('PRIVATE_METADATA_CAUSE_SENTINEL'));
  const count = (await calls(f.root)).length;
  const root = dirname(handle.requestPath),
    hash = createHash('sha256')
      .update(
        'PRIVATE_METADATA_CAUSE_SENTINEL:' + 'm'.repeat(16 * 1024 * 1024 + 1),
      )
      .digest('hex');
  const refs = snapshot.workers.flatMap(
    (w) => w.task.failureDiagnostics?.references ?? [],
  );
  assert(refs.some((ref) => ref.sha256 === hash));
  const privateArtifact = join(root, 'evidence', `${hash}.artifact`);
  assert.equal(
    (await stat(privateArtifact)).size,
    16 * 1024 * 1024 +
      1 +
      Buffer.byteLength('PRIVATE_METADATA_CAUSE_SENTINEL:'),
  );
  assert.equal(
    (await inspectDashboardImplementation(handle)).integrityIssue,
    null,
  );
  await rm(privateArtifact);
  assert((await inspectDashboardImplementation(handle)).integrityIssue);
  assert.equal((await calls(f.root)).length, count);
});

test('detached dashboard seals available verification bootstrap spools and full cause, refusing source and portable replay tamper without rerun', async (t) => {
  const f = await fixture(t),
    preload = join(f.root, 'verification-bootstrap-fault.mjs');
  await writeFile(
    preload,
    `import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';const open=fs.open;
fs.open=async(...args)=>{if(String(args[0]).endsWith('/verify-0.stderr.log'))throw ['PRIVATE','VERIFICATION','SETUP'].join('_')+':'+ 'x'.repeat(16_777_217);return open(...args);};syncBuiltinESMExports();`,
  );
  const handle = await prepareDashboardImplementation({
    ...request(f),
    verify: [
      {
        program: process.execPath,
        args: [
          '-e',
          "process.stdout.write('retained stdout');process.stderr.write('retained stderr');",
        ],
      },
    ],
  });
  const before = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS =
    `${before ?? ''} --import=${pathToFileURL(preload).href}`.trim();
  try {
    await startDashboardImplementation(handle);
  } finally {
    if (before === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = before;
  }
  const snapshot = await finish(handle);
  assert.equal(snapshot.state, 'FAILED', JSON.stringify(snapshot));
  assert.equal(snapshot.integrityIssue, null);
  assert.equal((await calls(f.root)).length, 2);
  const entry = snapshot.integration!.verification[0]!,
    capture = entry.capture!;
  assert.equal(capture.complete, false);
  assert.equal(capture.transcript, null);
  assert.equal(capture.stdout.available, true);
  assert.equal(capture.stderr.available, false);
  assert.equal(await readFile(capture.stdout.path, 'utf8'), '');
  assert.equal(await stat(capture.stderr.path).catch(() => null), null);
  const cause = capture.diagnostics.find((d) => d.category === 'launch')!;
  assert(cause);
  assert.equal(
    await readFile(cause.path, 'utf8'),
    'PRIVATE_VERIFICATION_SETUP:' + 'x'.repeat(16_777_217),
  );
  assert.equal(await actualDiagnosticHash(cause.path), cause.sha256);
  assert(!JSON.stringify(snapshot).includes('PRIVATE_VERIFICATION_SETUP'));
  const root = dirname(handle.requestPath),
    sealed = JSON.parse(await readFile(join(root, 'integration.json'), 'utf8'));
  assert.deepEqual(
    sealed.files.map((f: { path: string }) => f.path),
    [join(root, 'execution', 'receipt.json'), capture.stdout.path, cause.path],
  );
  assert.equal(
    (await inspectDashboardImplementation(handle)).integrityIssue,
    null,
  );
  await writeFile(capture.stdout.path, 'changed source');
  assert((await inspectDashboardImplementation(handle)).integrityIssue);
  await writeFile(capture.stdout.path, '');
  assert.equal(
    (await inspectDashboardImplementation(handle)).integrityIssue,
    null,
  );
  await rm(join(root, 'evidence', `${cause.sha256}.artifact`));
  assert((await inspectDashboardImplementation(handle)).integrityIssue);
  assert.equal((await calls(f.root)).length, 2);
});
