import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
  open,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  FileChildTaskStore,
  FileParallelWorkerReceiptStore,
  FileEvidenceStore,
} from '../libs/runtime/src/index.js';
import {
  prepareDashboardSwarm,
  startDashboardSwarm,
  inspectDashboardSwarm,
  cancelDashboardSwarm,
  type DashboardSwarmHandle,
  type DashboardSwarmRequest,
  type DashboardSwarmSnapshot,
} from './dashboard-swarm.mjs';

import {
  retainDashboardDiagnostic,
  verifyDashboardDiagnostics,
} from './dashboard-diagnostics.mjs';

const exec = promisify(execFile);
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'temari-dashboard-swarm-'));
  const workspaceRoot = join(root, 'workspace');
  await mkdir(workspaceRoot);
  await exec('git', ['init', '-q', workspaceRoot]);
  await exec(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '--allow-empty',
      '-qm',
      'initial',
    ],
    { cwd: workspaceRoot },
  );
  const executable = join(root, 'codex');
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2);
if (args[args.indexOf('--sandbox') + 1] !== 'read-only') process.exit(9);
const final = args[args.indexOf('--output-last-message') + 1];
let prompt = '';
process.stdin.on('data', data => prompt += data);
process.stdin.on('end', () => {
  const goal = prompt.match(/Goal: ([^\\n]+)/)[1];
  const root = ${JSON.stringify(root)};
  fs.appendFileSync(path.join(root, 'calls'), JSON.stringify({goal,pid:process.pid,at:Date.now()})+'\\n');
  if (goal === 'fail-once' && !fs.existsSync(path.join(root,'failed'))) {
    fs.writeFileSync(path.join(root,'failed'), 'yes'); process.exit(7);
  }
  const delay = goal === 'hang' ? 30000 : goal === 'slow' ? 600 : 250;
  setTimeout(() => {
    fs.writeFileSync(final, JSON.stringify({status: goal === 'blocked' ? 'BLOCKED' : 'PASS', summary: goal+' findings'}));
    if(goal.startsWith('large-')) { const emit=async(stream,value,prefix)=>{await new Promise((d,r)=>stream.write(prefix,e=>e?r(e):d()));const chunk=Buffer.alloc(65536,value);for(let n=0;n<256;n++)await new Promise((d,r)=>stream.write(chunk,e=>e?r(e):d()));await new Promise((d,r)=>stream.write('!',e=>e?r(e):d()));}; Promise.all([emit(process.stdout,97,'PRIVATE_STDOUT_SENTINEL:'),emit(process.stderr,122,'PRIVATE_STDERR_SENTINEL:')]).then(()=>process.exit(goal==='large-exit'?7:0)); }else console.log(JSON.stringify({type:'fixture.complete',goal}));
  }, delay);
});
`,
  );
  await chmod(executable, 0o755);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, workspaceRoot, executable };
}
function request(
  f: Awaited<ReturnType<typeof fixture>>,
  goals = ['slow', 'fast'],
  maxConcurrency = 2,
): DashboardSwarmRequest {
  return {
    root: join(f.root, 'storage'),
    taskId: 'task-1',
    runId: 'swarm-1',
    revision: 'revision-1',
    workspaceRoot: f.workspaceRoot,
    executable: f.executable,
    maxConcurrency,
    timeoutMs: 5000,
    assignments: goals.map((goal, index) => ({
      id: `worker-${index + 1}`,
      role: index % 2 ? 'reviewer' : 'investigator',
      required: true,
      brief: {
        goal,
        context: 'Fixture context',
        scope: 'Read the repository',
        acceptanceCriteria: ['Report findings'],
        verificationCommand: null,
        reportFormat: 'json',
        forbiddenActions: ['Do not edit files or publish anything.'],
      },
    })),
  };
}
async function until(
  handle: DashboardSwarmHandle,
  predicate: (value: DashboardSwarmSnapshot) => boolean,
  timeout = 15_000,
): Promise<DashboardSwarmSnapshot> {
  const deadline = Date.now() + timeout;
  let current: DashboardSwarmSnapshot;
  do {
    current = await inspectDashboardSwarm(handle);
    if (predicate(current)) return current;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error(
    `Timed out awaiting swarm: ${JSON.stringify(current)}; supervisor: ${await readFile(join(dirname(handle.requestPath), 'supervisor.log'), 'utf8').catch(() => 'none')}`,
  );
}
async function calls(
  root: string,
): Promise<{ goal: string; pid: number; at: number }[]> {
  return (await readFile(join(root, 'calls'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

test('prepares child references before launch and detached real worker processes survive a fresh dashboard client', async (t) => {
  const f = await fixture(t);
  const handle = await prepareDashboardSwarm(request(f));
  assert.deepEqual(await prepareDashboardSwarm(request(f)), handle);
  const prepared = await inspectDashboardSwarm(handle);
  assert.equal(prepared.state, 'PREPARED');
  assert(
    prepared.workers.every(
      (worker) => worker.task.status === 'QUEUED' && worker.task.attempt === 0,
    ),
  );
  await assert.rejects(() => readFile(join(f.root, 'calls')), /ENOENT/);
  await Promise.all([startDashboardSwarm(handle), startDashboardSwarm(handle)]);
  const recoveredHandle = JSON.parse(
    JSON.stringify(handle),
  ) as DashboardSwarmHandle;
  const result = await until(
    recoveredHandle,
    (value) => value.state === 'COMPLETE',
  );
  assert.equal(result.receipt?.status, 'PASS');
  assert.equal(result.receipt?.peakConcurrency, 2);
  assert.equal(result.workers.length, 2);
  assert(
    result.workers.every(
      (worker) =>
        worker.task.status === 'SUCCEEDED' &&
        worker.task.result?.evidenceReferences?.length,
    ),
  );
  const invoked = await calls(f.root);
  assert.equal(invoked.length, 2);
  assert.notEqual(invoked[0]!.pid, invoked[1]!.pid);
  const processes = await Promise.all(
    result.workers.map(async (worker) => {
      const path = worker.task.result!.evidencePaths.find((item) =>
        item.endsWith('/process.json'),
      )!;
      return JSON.parse(await readFile(path, 'utf8')) as {
        startedAt: string;
        endedAt: string;
      };
    }),
  );
  assert(
    Math.max(...processes.map((item) => Date.parse(item.startedAt))) <
      Math.min(...processes.map((item) => Date.parse(item.endedAt))),
  );
  await startDashboardSwarm(recoveredHandle);
  assert.equal((await calls(f.root)).length, 2);
  assert.match(result.statusNote, /independent review/);
});

test('runtime retries failed transport once and retains successful siblings with unique attempt evidence', async (t) => {
  const f = await fixture(t);
  const handle = await prepareDashboardSwarm(
    request(f, ['fast', 'fail-once', 'third'], 2),
  );
  await startDashboardSwarm(handle);
  const result = await until(handle, (value) => value.state === 'COMPLETE');
  assert.equal(result.receipt?.status, 'PASS');
  assert.deepEqual(
    result.workers.map((worker) => worker.task.attempt),
    [1, 2, 1],
  );
  assert.equal(
    (await calls(f.root)).filter((item) => item.goal === 'fast').length,
    1,
  );
  assert.equal(
    (await readdir(join(dirname(handle.requestPath), 'workers', 'worker-2')))
      .length,
    2,
  );
});

test('durable cancellation stops active workers and prevents queued launches while retaining completed siblings', async (t) => {
  const f = await fixture(t);
  const handle = await prepareDashboardSwarm(
    request(f, ['fast', 'hang', 'third'], 1),
  );
  await startDashboardSwarm(handle);
  await until(
    handle,
    (value) =>
      value.workers[0]!.task.status === 'SUCCEEDED' &&
      value.workers[1]!.task.status === 'RUNNING',
  );
  await cancelDashboardSwarm(handle);
  const result = await until(handle, (value) => value.state === 'CANCELLED');
  assert.deepEqual(
    result.workers.map((worker) => worker.task.status),
    ['SUCCEEDED', 'CANCELLED', 'CANCELLED'],
  );
  assert.equal(result.receipt, null);
  assert.equal(result.canCancel, false);
  assert(!(await calls(f.root)).some((item) => item.goal === 'third'));
  await startDashboardSwarm(handle);
  assert.equal((await inspectDashboardSwarm(handle)).state, 'CANCELLED');
});

test('tampered completed evidence preserves cancellation of an active sibling until it drains', async (t) => {
  const f = await fixture(t);
  const handle = await prepareDashboardSwarm({
    ...request(f, ['fast', 'hang']),
    timeoutMs: 15_000,
  });
  await startDashboardSwarm(handle);
  const running = await until(
    handle,
    (value) =>
      value.workers[0]!.task.status === 'SUCCEEDED' &&
      value.workers[1]!.task.status === 'RUNNING',
  );
  assert((await calls(f.root)).some((call) => call.goal === 'hang'));
  const reference = running.workers[0]!.task.result!.evidenceReferences![0]!;
  await writeFile(
    join(
      dirname(handle.requestPath),
      'evidence',
      `${reference.sha256}.artifact`,
    ),
    'tampered completed worker evidence',
  );

  const damaged = await inspectDashboardSwarm(handle);
  assert.equal(damaged.state, 'RUNNING');
  assert.equal(damaged.canCancel, true);
  assert.match(
    damaged.integrityIssue!,
    /Retained worker evidence did not verify/,
  );
  await cancelDashboardSwarm(handle);
  const stopped = await until(handle, (value) => value.state === 'CANCELLED');
  assert.deepEqual(
    stopped.workers.map((worker) => worker.task.status),
    ['SUCCEEDED', 'CANCELLED'],
  );
  assert.equal(stopped.canCancel, false);
  assert.match(
    stopped.integrityIssue!,
    /Retained worker evidence did not verify/,
  );
  assert.equal(
    JSON.parse(
      await readFile(join(dirname(handle.requestPath), 'ended.json'), 'utf8'),
    ).workersDrained,
    true,
  );
  const attempts = await readdir(
    join(dirname(handle.requestPath), 'workers', 'worker-2'),
  );
  assert.equal(attempts.length, 1);
  const processEvidence = JSON.parse(
    await readFile(
      join(
        dirname(handle.requestPath),
        'workers',
        'worker-2',
        attempts[0]!,
        'process.json',
      ),
      'utf8',
    ),
  );
  assert.equal(processEvidence.cancelled, true);
  assert.equal(typeof processEvidence.pid, 'number');
});

test('timeouts are bounded, semantic blockers are not retried, and terminal receipts are retained', async (t) => {
  const f = await fixture(t);
  const handle = await prepareDashboardSwarm({
    ...request(f, ['hang', 'blocked']),
    timeoutMs: 1000,
    maxAttempts: 1,
  });
  await startDashboardSwarm(handle);
  const result = await until(handle, (value) => value.state === 'COMPLETE');
  assert.equal(result.receipt?.status, 'BLOCKED');
  assert.deepEqual(
    result.workers.map((worker) => worker.task.status),
    ['FAILED', 'BLOCKED'],
  );
  assert(result.workers.every((worker) => worker.task.attempt === 1));
  const receipt = result.receipt;
  await startDashboardSwarm(handle);
  assert.deepEqual((await inspectDashboardSwarm(handle)).receipt, receipt);
  assert.equal((await calls(f.root)).length, 2);
});

test('uncertain supervisor launch is never reclaimed or reported as cancellation', async (t) => {
  const f = await fixture(t);
  const handle = await prepareDashboardSwarm(request(f));
  await writeFile(
    join(dirname(handle.requestPath), 'intent.json'),
    JSON.stringify({
      nonce: 'old',
      at: 0,
      manifestSha256: handle.manifestSha256,
    }),
  );
  const result = await startDashboardSwarm(handle);
  assert.equal(result.state, 'RECOVERY_REQUIRED');
  assert(result.workers.every((worker) => worker.task.status === 'QUEUED'));
  await assert.rejects(() => readFile(join(f.root, 'calls')), /ENOENT/);
});

test('expired child cancellation remains recovery-required without a matching supervisor drain proof', async (t) => {
  const f = await fixture(t);
  const handle = await prepareDashboardSwarm(request(f));
  const root = dirname(handle.requestPath);
  const store = await FileChildTaskStore.create(handle.childStoreRoot);
  const group = await store.loadGroup(handle.groupId);
  assert(group);
  await store.claim({
    taskId: group.taskIds[0]!,
    owner: 'lost-supervisor',
    leaseMs: 1,
    now: new Date(0),
  });
  await writeFile(
    join(root, 'intent.json'),
    JSON.stringify({
      nonce: 'lost',
      at: 0,
      manifestSha256: handle.manifestSha256,
    }),
  );
  await writeFile(
    join(root, 'observed.json'),
    JSON.stringify({ nonce: 'lost', pid: process.pid }),
  );
  await writeFile(
    join(root, 'heartbeat.json'),
    JSON.stringify({ nonce: 'lost', at: 0 }),
  );

  const cancelled = await cancelDashboardSwarm(handle);
  assert(
    cancelled.workers.every((worker) => worker.task.status === 'CANCELLED'),
  );
  assert.equal(cancelled.state, 'RECOVERY_REQUIRED');
  assert.equal(cancelled.canCancel, true);
  assert.match(cancelled.statusNote, /prior worker absence/);
  for (const ended of [
    { nonce: 'lost', error: null },
    { nonce: 'lost', error: null, workersDrained: false },
    { nonce: 'different-launch', error: null, workersDrained: true },
  ]) {
    await writeFile(join(root, 'ended.json'), JSON.stringify(ended));
    assert.equal(
      (await inspectDashboardSwarm(handle)).state,
      'RECOVERY_REQUIRED',
    );
    assert.equal(
      (await startDashboardSwarm(handle)).state,
      'RECOVERY_REQUIRED',
    );
  }
  // A matching trusted supervisor's drain record is separate evidence from
  // lease expiry; the fixture supplies that record without creating a process.
  await writeFile(
    join(root, 'ended.json'),
    JSON.stringify({ nonce: 'lost', error: null, workersDrained: true }),
  );
  assert.equal((await inspectDashboardSwarm(handle)).state, 'CANCELLED');
  assert.equal((await inspectDashboardSwarm(handle)).canCancel, false);
  await assert.rejects(() => readFile(join(f.root, 'calls')), /ENOENT/);
});

test('cancellation before any launch requires no process recovery', async (t) => {
  const f = await fixture(t);
  const handle = await prepareDashboardSwarm(request(f));
  assert.equal((await cancelDashboardSwarm(handle)).state, 'CANCELLED');
  assert.equal((await startDashboardSwarm(handle)).state, 'CANCELLED');
  await assert.rejects(
    () => readFile(join(dirname(handle.requestPath), 'intent.json')),
    /ENOENT/,
  );
  await assert.rejects(() => readFile(join(f.root, 'calls')), /ENOENT/);
});

test('inspection refuses missing or tampered portable evidence and changed linked worker files', async (t) => {
  const f = await fixture(t);
  const handle = await prepareDashboardSwarm(request(f));
  await startDashboardSwarm(handle);
  const result = await until(handle, (value) => value.state === 'COMPLETE');
  const worker = result.workers[0]!.task.result!;
  const reference = worker.evidenceReferences![0]!;
  const artifact = join(
    dirname(handle.requestPath),
    'evidence',
    `${reference.sha256}.artifact`,
  );
  const portableBytes = await readFile(artifact);
  await writeFile(artifact, 'tampered portable evidence');
  let inspected = await inspectDashboardSwarm(handle);
  assert.equal(inspected.state, 'COMPLETE');
  assert.match(
    inspected.integrityIssue!,
    /Retained worker evidence did not verify/,
  );
  await writeFile(artifact, portableBytes);
  assert.equal((await inspectDashboardSwarm(handle)).state, 'COMPLETE');
  assert.equal((await inspectDashboardSwarm(handle)).integrityIssue, null);

  const linkedFile = worker.evidencePaths[0]!;
  const linkedBytes = await readFile(linkedFile);
  await writeFile(linkedFile, 'tampered linked evidence');
  inspected = await inspectDashboardSwarm(handle);
  assert.equal(inspected.state, 'COMPLETE');
  assert.match(inspected.integrityIssue!, /Evidence (byte count|hash) changed/);
  await writeFile(linkedFile, linkedBytes);

  await rm(artifact);
  inspected = await inspectDashboardSwarm(handle);
  assert.equal(inspected.state, 'COMPLETE');
  assert.match(
    inspected.integrityIssue!,
    /Retained worker evidence did not verify/,
  );
  await writeFile(artifact, portableBytes);
  assert.equal((await inspectDashboardSwarm(handle)).state, 'COMPLETE');
});

test('rejects changed bindings, unsafe work, bounds, dirty candidates, and overlapping storage before launch', async (t) => {
  const f = await fixture(t);
  const input = request(f);
  await assert.rejects(
    () => prepareDashboardSwarm({ ...input, maxConcurrency: 5 }),
    /one to four/,
  );
  await assert.rejects(
    () =>
      prepareDashboardSwarm({
        ...input,
        assignments: input.assignments.slice(0, 1),
      }),
    /two to four/,
  );
  await assert.rejects(
    () =>
      prepareDashboardSwarm({
        ...input,
        root: join(f.workspaceRoot, 'evidence'),
      }),
    /outside/,
  );
  await assert.rejects(
    () =>
      prepareDashboardSwarm({
        ...input,
        root: join(f.workspaceRoot, '..evidence'),
      }),
    /outside/,
  );
  await assert.rejects(
    () =>
      readFile(
        join(
          f.workspaceRoot,
          '..evidence',
          'swarm-1',
          'revision-1',
          'request.json',
        ),
      ),
    /ENOENT/,
  );
  await assert.rejects(
    () =>
      prepareDashboardSwarm({
        ...input,
        assignments: input.assignments.map((item) => ({
          ...item,
          role: 'implementer',
        })),
      }),
    /investigator or reviewer/,
  );
  const handle = await prepareDashboardSwarm(input);
  await assert.rejects(
    () => startDashboardSwarm({ ...handle, groupId: 'other' }),
    /handle changed/,
  );
  await assert.rejects(
    () => startDashboardSwarm({ ...handle, manifestSha256: '0'.repeat(64) }),
    /digest changed/,
  );
  await writeFile(join(f.workspaceRoot, 'change'), 'dirty');
  await assert.rejects(() => startDashboardSwarm(handle), /clean workspace/);
  await assert.rejects(
    () => readFile(join(dirname(handle.requestPath), 'intent.json')),
    /ENOENT/,
  );
});

test('a joined receipt published during a child read cannot complete an earlier swarm snapshot', async (t) => {
  const f = await fixture(t),
    handle = await prepareDashboardSwarm(request(f));
  const prepared = await inspectDashboardSwarm(handle);
  await startDashboardSwarm(handle);
  await until(
    handle,
    (s) =>
      s.state === 'COMPLETE' &&
      s.workers.every(
        (w) =>
          w.task.status === 'SUCCEEDED' && w.task.result?.status === 'PASS',
      ),
  );
  const root = dirname(handle.requestPath),
    markerPath = join(root, 'ended.json');
  const markerDeadline = Date.now() + 5_000;
  let marker: Buffer | null = null;
  while (Date.now() < markerDeadline) {
    try {
      marker = await readFile(markerPath);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert(
    marker,
    'Supervisor did not publish its drain marker before setup timed out.',
  );
  const ended = JSON.parse(marker.toString());
  const intent = JSON.parse(await readFile(join(root, 'intent.json'), 'utf8'));
  assert.equal(ended.nonce, intent.nonce);
  assert.equal(ended.workersDrained, true);
  await rm(markerPath);
  const pulse = JSON.parse(
    await readFile(join(root, 'heartbeat.json'), 'utf8'),
  );
  t.mock.method(Date, 'now', () => pulse.at);
  let published = false;
  const originalLoad = FileChildTaskStore.prototype.load;
  const originalReceiptLoad = FileParallelWorkerReceiptStore.prototype.load;
  const receipt = t.mock.method(
    FileParallelWorkerReceiptStore.prototype,
    'load',
    async function (this: FileParallelWorkerReceiptStore, runId: string) {
      return published ? originalReceiptLoad.call(this, runId) : null;
    },
  );
  const load = t.mock.method(
    FileChildTaskStore.prototype,
    'load',
    async function (this: FileChildTaskStore, taskId: string) {
      if (!published && taskId === prepared.workers[0]!.task.taskId) {
        published = true;
        await writeFile(markerPath, marker);
        return structuredClone(prepared.workers[0]!.task);
      }
      return originalLoad.call(this, taskId);
    },
  );
  const duringPublication = await inspectDashboardSwarm(handle);
  assert(published);
  assert.equal(duringPublication.state, 'RUNNING');
  assert.equal(duringPublication.receipt, null);
  assert.equal(duringPublication.canCancel, true);
  load.mock.restore();
  receipt.mock.restore();
  const terminal = await inspectDashboardSwarm(handle);
  assert.equal(terminal.state, 'COMPLETE');
  assert.equal(terminal.receipt?.status, 'PASS');
  assert(
    terminal.workers.every(
      (w) => w.task.status === 'SUCCEEDED' && w.task.result?.status === 'PASS',
    ),
  );
  assert.equal(terminal.integrityIssue, null);
  const log = await readFile(join(root, 'supervisor.log'));
  assert.equal((await startDashboardSwarm(handle)).state, 'COMPLETE');
  assert.deepEqual(await readFile(join(root, 'supervisor.log')), log);
  assert.equal((await calls(f.root)).length, 2);
});

test('initial swarm ownership waits for its first heartbeat without relaunching workers', async (t) => {
  const scenarios = [
    {
      name: 'matching observation before heartbeat',
      intentAge: 0,
      observedNonce: 'owner',
      pulseNonce: null,
      pulseAge: 0,
      state: 'STARTING',
    },
    {
      name: 'fresh matching heartbeat',
      intentAge: 0,
      observedNonce: 'owner',
      pulseNonce: 'owner',
      pulseAge: 0,
      state: 'RUNNING',
    },
    {
      name: 'older intent with active heartbeat',
      intentAge: 60_000,
      observedNonce: 'owner',
      pulseNonce: 'owner',
      pulseAge: 0,
      state: 'RUNNING',
    },
    {
      name: 'expired initial ownership',
      intentAge: 5_000,
      observedNonce: 'owner',
      pulseNonce: null,
      pulseAge: 0,
      state: 'RECOVERY_REQUIRED',
    },
    {
      name: 'excessively future intent',
      intentAge: -5_001,
      observedNonce: 'owner',
      pulseNonce: null,
      pulseAge: 0,
      state: 'RECOVERY_REQUIRED',
    },
    {
      name: 'mismatched observed nonce',
      intentAge: 0,
      observedNonce: 'other',
      pulseNonce: null,
      pulseAge: 0,
      state: 'RECOVERY_REQUIRED',
    },
    {
      name: 'expired heartbeat',
      intentAge: 0,
      observedNonce: 'owner',
      pulseNonce: 'owner',
      pulseAge: 5_000,
      state: 'RECOVERY_REQUIRED',
    },
    {
      name: 'excessively future heartbeat',
      intentAge: 0,
      observedNonce: 'owner',
      pulseNonce: 'owner',
      pulseAge: -5_001,
      state: 'RECOVERY_REQUIRED',
    },
    {
      name: 'mismatched heartbeat nonce',
      intentAge: 0,
      observedNonce: 'owner',
      pulseNonce: 'other',
      pulseAge: 0,
      state: 'RECOVERY_REQUIRED',
    },
  ] as const;
  for (const scenario of scenarios)
    await t.test(scenario.name, async (s) => {
      const f = await fixture(s),
        handle = await prepareDashboardSwarm(request(f));
      const root = dirname(handle.requestPath),
        now = Date.now();
      s.mock.method(Date, 'now', () => now);
      const intent = JSON.stringify({
        nonce: 'owner',
        at: now - scenario.intentAge,
        manifestSha256: handle.manifestSha256,
      });
      await writeFile(join(root, 'intent.json'), intent);
      await writeFile(
        join(root, 'observed.json'),
        JSON.stringify({ nonce: scenario.observedNonce, pid: process.pid }),
      );
      if (scenario.pulseNonce !== null)
        await writeFile(
          join(root, 'heartbeat.json'),
          JSON.stringify({
            nonce: scenario.pulseNonce,
            at: now - scenario.pulseAge,
          }),
        );
      const snapshot = await inspectDashboardSwarm(handle);
      assert.equal(snapshot.state, scenario.state, snapshot.statusNote);
      assert.equal(snapshot.receipt, null);
      assert(
        snapshot.workers.every(
          (w) => w.task.status === 'QUEUED' && w.task.attempt === 0,
        ),
      );
      assert.equal(
        (await startDashboardSwarm(structuredClone(handle))).state,
        scenario.state,
      );
      assert.equal(await readFile(join(root, 'intent.json'), 'utf8'), intent);
      await assert.rejects(readFile(join(f.root, 'calls')), { code: 'ENOENT' });
      await assert.rejects(readFile(join(root, 'supervisor.log')), {
        code: 'ENOENT',
      });
    });
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

test('swarm dashboard retains and reopens large normal and failed diagnostics without rerunning workers', async (t) => {
  for (const failed of [false, true])
    await t.test(failed ? 'nonzero' : 'normal', async (sub) => {
      const f = await fixture(sub);
      const handle = await prepareDashboardSwarm(
        request(f, [failed ? 'large-exit' : 'large-pass', 'fast']),
      );
      await startDashboardSwarm(handle);
      const snapshot = await until(handle, (s) =>
        ['COMPLETE', 'FAILED', 'RECOVERY_REQUIRED'].includes(s.state),
      );
      assert.equal(snapshot.state, 'COMPLETE', JSON.stringify(snapshot));
      const worker = snapshot.workers[0]!;
      assert.equal(worker.task.status, failed ? 'FAILED' : 'SUCCEEDED');
      const directory = dirname(handle.requestPath);
      const attempts = await readdir(
        join(directory, 'workers', worker.assignment.id),
      );
      const attempt = join(
        directory,
        'workers',
        worker.assignment.id,
        attempts[0]!,
      );
      await assertLargeDiagnostic(join(attempt, 'stdout.jsonl'));
      await assertLargeDiagnostic(join(attempt, 'stderr.log'), true);
      assert(!JSON.stringify(snapshot).includes('PRIVATE_STD'));
      const reference = (
        failed
          ? worker.task.failureDiagnostics!.references
          : worker.task.result!.evidenceReferences!
      ).find(
        (ref) => ref.sha256 === diagnosticHash(diagnosticStdoutPrefix, 97),
      )!;
      assert(reference);
      assert.equal(
        reference.bytes,
        16_777_217 + Buffer.byteLength(diagnosticStdoutPrefix),
      );
      const initialCalls = (await calls(f.root)).length;
      assert.equal((await inspectDashboardSwarm(handle)).state, 'COMPLETE');
      assert.equal((await calls(f.root)).length, initialCalls);
      const artifact = join(
        directory,
        'evidence',
        `${reference.sha256}.artifact`,
      );
      const file = await open(artifact, 'r+');
      await file.write(Buffer.from('X'), 0, 1, 0);
      await file.close();
      const changed = await inspectDashboardSwarm(handle);
      assert.equal(changed.state, 'COMPLETE');
      assert.match(changed.integrityIssue!, /hash changed/);
      assert.equal((await calls(f.root)).length, initialCalls);
      await rm(artifact);
      const missing = await inspectDashboardSwarm(handle);
      assert.equal(missing.state, 'COMPLETE');
      assert.match(missing.integrityIssue!, /ENOENT/);
      assert.equal((await calls(f.root)).length, initialCalls);
    });
});

test('supervisor and review-resolution diagnostic capture preserves full private causes through the sole evidence store', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'temari-dashboard-causes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await FileEvidenceStore.create(join(root, 'evidence'));
  for (const category of ['supervisor', 'review-resolution'] as const) {
    const cause = `PRIVATE_${category}_CAUSE:` + 'x'.repeat(16_777_217);
    const diagnostic = await retainDashboardDiagnostic(
      store,
      'dashboard-causes',
      'revision-1',
      join(root, `${category}.log`),
      category,
      cause,
    );
    assert.equal(diagnostic.source.status, 'complete');
    assert.equal(diagnostic.source.bytes, Buffer.byteLength(cause));
    assert.equal(
      diagnostic.source.sha256,
      createHash('sha256').update(cause).digest('hex'),
    );
    assert(diagnostic.reference);
    assert(!JSON.stringify(diagnostic).includes(`PRIVATE_${category}_CAUSE`));
    await verifyDashboardDiagnostics(
      store,
      'dashboard-causes',
      'revision-1',
      [diagnostic],
      root,
    );
    await rm(join(root, 'evidence', `${diagnostic.reference.sha256}.artifact`));
    await assert.rejects(
      verifyDashboardDiagnostics(
        store,
        'dashboard-causes',
        'revision-1',
        [diagnostic],
        root,
      ),
      /ENOENT/,
    );
  }
});

test('supervisor diagnostic inspection rejects linked-source tamper and retains a full archival failure cause without recursion', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'temari-dashboard-archive-cause-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await FileEvidenceStore.create(join(root, 'evidence')),
    original = store.putStream.bind(store);
  const secondary = 'PRIVATE_ARCHIVE_CAUSE:' + 'x'.repeat(16_777_217);
  let calls = 0;
  store.putStream = async (request) => {
    if (++calls === 1) throw secondary;
    return original(request);
  };
  const diagnostic = await retainDashboardDiagnostic(
    store,
    'archive-causes',
    'revision-1',
    join(root, 'primary.log'),
    'supervisor',
    'primary failure',
  );
  assert.equal(diagnostic.archiveStatus, 'archive-failed');
  assert.equal(diagnostic.reference, null);
  assert(diagnostic.archiveFailure?.reference);
  assert.equal(
    diagnostic.archiveFailure!.source.bytes,
    Buffer.byteLength(secondary),
  );
  assert.equal(
    diagnostic.archiveFailure!.source.sha256,
    createHash('sha256').update(secondary).digest('hex'),
  );
  assert.equal(calls, 2);
  assert(!JSON.stringify(diagnostic).includes('PRIVATE_ARCHIVE_CAUSE'));
  await verifyDashboardDiagnostics(
    store,
    'archive-causes',
    'revision-1',
    [diagnostic],
    root,
  );
  const file = await open(diagnostic.source.path, 'r+');
  await file.write(Buffer.from('X'), 0, 1, 0);
  await file.close();
  await assert.rejects(
    verifyDashboardDiagnostics(
      store,
      'archive-causes',
      'revision-1',
      [diagnostic],
      root,
    ),
    /hash changed/,
  );
});

test('dashboard retains current and historical private captures when terminal worker metadata publication fails', async (t) => {
  const f = await fixture(t),
    preload = join(f.root, 'metadata-fault.mjs');
  await writeFile(
    preload,
    `import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';
const write=fs.writeFile;fs.writeFile=async(...args)=>{if(String(args[0]).endsWith('/process.json'))throw ['PRIVATE','METADATA','CAUSE','SENTINEL'].join('_')+':'+ 'm'.repeat(16*1024*1024+1);return write(...args);};syncBuiltinESMExports();`,
  );
  const handle = await prepareDashboardSwarm(request(f, ['alpha', 'beta']));
  const before = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS =
    `${before ?? ''} --import=${pathToFileURL(preload).href}`.trim();
  try {
    await startDashboardSwarm(handle);
  } finally {
    if (before === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = before;
  }
  const snapshot = await until(handle, (s) => s.state === 'COMPLETE');
  assert.equal(snapshot.state, 'COMPLETE', JSON.stringify(snapshot));
  assert.equal(snapshot.receipt?.status, 'BLOCKED');
  assert(
    snapshot.workers.every(
      (worker) => worker.task.status === 'FAILED' && worker.task.attempt === 2,
    ),
  );
  assert(
    snapshot.workers.every((worker) =>
      worker.events.some(
        (event) =>
          event.type === 'task-retried' && event.payload.failureDiagnostics,
      ),
    ),
  );
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
  assert.equal((await inspectDashboardSwarm(handle)).integrityIssue, null);
  await rm(privateArtifact);
  assert((await inspectDashboardSwarm(handle)).integrityIssue);
  assert.equal((await calls(f.root)).length, count);
});
