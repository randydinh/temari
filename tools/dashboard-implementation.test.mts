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
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
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
  console.log(JSON.stringify({type:'fixture.complete',goal}));
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
