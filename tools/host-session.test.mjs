import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { packageCanonicalRuntime } from './canonical-runtime.mjs';

const stages = ['investigate', 'plan', 'build', 'review', 'verify', 'deliver'];
const initial = 'pear\napple\n';
const expected = 'APPLE\nPEAR\n';
let build;

before(async () => {
  build = await realpath(await mkdtemp(join(tmpdir(), 'temari-host-build-')));
  await packageCanonicalRuntime(join(build, 'runtime'));
  for (const file of ['entry.mjs', 'stdio.mjs'])
    await copyFile(
      new URL(`../packages/workflow-runtime/host/${file}`, import.meta.url),
      join(build, file),
    );
});
after(async () => {
  if (build) await rm(build, { recursive: true, force: true });
});

async function fixture(t, changes = {}) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'temari host café-')),
  );
  const cleanups = [];
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup();
    await rm(root, { recursive: true, force: true });
  });
  const artifact = join(root, 'runtime');
  await cp(join(build, 'runtime'), artifact, { recursive: true });
  for (const file of ['entry.mjs', 'stdio.mjs'])
    await copyFile(join(build, file), join(root, file));
  const candidate = join(root, 'candidate');
  await mkdir(candidate);
  await writeFile(join(candidate, 'product.txt'), initial);
  const request = {
    schemaVersion: 1,
    runId: 'native-dialogue',
    revision: 'literal-pear-apple-v1',
    candidate: { scopeId: 'bounded-product', root: candidate },
    runDirectory: join(root, 'run'),
    obligations: {
      workType: 'feature',
      delegation: 'none',
      review: 'self',
      evidence: 'revision-bound',
      delivery: 'local',
    },
    ...changes,
  };
  const path = join(root, 'request.json');
  await writeFile(path, JSON.stringify(request));
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  const launch = (resume = false) => {
    const child = spawn(
      process.execPath,
      [
        join(root, 'entry.mjs'),
        resume ? 'resume' : 'start',
        '--runtime',
        artifact,
        resume ? '--run-directory' : '--request',
        resume ? request.runDirectory : path,
      ],
      { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stderr = '';
    let tail = '';
    let closed = false;
    let timedOut = false;
    let spawnError;
    let pending;
    const messages = [];
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 30_000);
    const deliver = (message) => {
      if (pending) {
        const resolve = pending.resolve;
        clearTimeout(pending.timer);
        pending = undefined;
        resolve(message);
      } else messages.push(message);
    };
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk;
    });
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      tail += chunk;
      let boundary;
      while ((boundary = tail.indexOf('\n')) !== -1) {
        const line = tail.slice(0, boundary);
        tail = tail.slice(boundary + 1);
        try {
          deliver(JSON.parse(line));
        } catch {
          deliver({ type: 'invalid-json', line });
        }
      }
    });
    child.stdin.on('error', () => undefined);
    const done = new Promise((resolve) => {
      child.once('error', (error) => {
        spawnError = error;
        stderr += error.message;
      });
      child.once('close', (code, signal) => {
        clearTimeout(deadline);
        closed = true;
        if (pending) {
          clearTimeout(pending.timer);
          pending.reject(
            new Error(`Bridge closed: ${code}/${signal}: ${stderr}`),
          );
          pending = undefined;
        }
        resolve({ code, signal, stderr, tail, messages });
      });
    });
    cleanups.push(async () => {
      if (!closed) child.kill('SIGKILL');
      await done;
    });
    const checkedDone = done.then((result) => {
      assert.equal(timedOut, false, `Bridge process timed out: ${stderr}`);
      assert.equal(spawnError, undefined);
      return result;
    });
    void checkedDone.catch(() => undefined);
    return {
      child,
      done: checkedDone,
      next() {
        if (messages.length) return Promise.resolve(messages.shift());
        if (closed)
          return Promise.reject(new Error(`Bridge closed: ${stderr}`));
        assert.equal(pending, undefined);
        return new Promise((resolve, reject) => {
          pending = {
            resolve,
            reject,
            timer: setTimeout(() => {
              pending = undefined;
              reject(new Error(`Bridge message timeout: ${stderr}`));
            }, 10_000),
          };
        });
      },
      reply(message, ending = '\n') {
        child.stdin.write(
          JSON.stringify({
            type: 'result',
            sessionId: message.sessionId,
            requestId: message.requestId,
            stage: message.stage,
          }) + ending,
        );
      },
    };
  };
  const require = createRequire(pathToFileURL(join(artifact, 'consumer.mjs')));
  const api = await import(
    pathToFileURL(require.resolve('@temari/runtime')).href
  );
  const checkpoint = async () =>
    JSON.parse(
      await readFile(
        join(
          request.runDirectory,
          'checkpoints',
          `${request.runId}.checkpoint.json`,
        ),
        'utf8',
      ),
    ).checkpoint;
  const receipt = async () =>
    JSON.parse(
      await readFile(
        join(request.runDirectory, 'receipts', `${request.runId}.receipt.json`),
        'utf8',
      ),
    ).receipt;
  const absentReceipt = () => assert.rejects(receipt(), { code: 'ENOENT' });
  return {
    root,
    artifact,
    candidate,
    request,
    path,
    launch,
    api,
    checkpoint,
    receipt,
    absentReceipt,
  };
}

async function resultFile(message, patch = {}) {
  await writeFile(
    join(message.workspace, 'observation.txt'),
    `observed ${message.stage}\n`,
  );
  const result = {
    schemaVersion: 1,
    sessionId: message.sessionId,
    requestId: message.requestId,
    stage: message.stage,
    status: 'PASS',
    summary: `${message.stage} checked`,
    evidence: [
      { name: 'observation', kind: 'verification', path: 'observation.txt' },
    ],
    ...patch,
  };
  await writeFile(
    join(message.workspace, 'host-result.json'),
    JSON.stringify(result),
  );
}

async function respond(f, session, message) {
  assert.equal(message.type, 'stage');
  assert.equal(message.candidate.root, f.candidate);
  if (message.stage === 'build') {
    assert.equal(
      await readFile(join(f.candidate, 'product.txt'), 'utf8'),
      initial,
    );
    await writeFile(join(f.candidate, 'product.txt'), expected);
  }
  await resultFile(message);
  session.reply(message, '\r\n');
}

async function drive(f, session) {
  const requested = [];
  while (true) {
    const message = await session.next();
    if (message.type === 'complete') {
      assert.equal(message.status, 'PASS');
      break;
    }
    if (message.type === 'checkpoint') continue;
    requested.push(message.stage);
    await respond(f, session, message);
  }
  const final = await session.done;
  assert.equal(final.code, 0, final.stderr);
  return requested;
}

test('relocated experimental bridge runs actual candidate changes and runtime evidence', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await drive(f, f.launch()), stages);
  assert.equal(
    await readFile(join(f.candidate, 'product.txt'), 'utf8'),
    expected,
  );
  const receipt = await f.receipt();
  assert.equal(receipt.evidenceProfile, 'candidate-stage-evidence-v1');
  assert.equal(receipt.status, 'PASS');
  assert.deepEqual(receipt.capabilities.available, []);
  const api = f.api;
  const run = f.request.runDirectory;
  const mode = (await stat(join(f.candidate, 'product.txt'))).mode & 0o777;
  const expectedCurrent = {
    scope: 'local-regular-files-v1',
    sha256: createHash('sha256')
      .update(
        JSON.stringify([
          'local-regular-files-v1',
          [
            [
              'product.txt',
              mode,
              Buffer.byteLength(expected),
              createHash('sha256').update(expected).digest('hex'),
            ],
          ],
        ]),
      )
      .digest('hex'),
  };
  const verify = () =>
    api.verifyCandidateCloseout({
      runId: f.request.runId,
      revision: f.request.revision,
      scope: {
        ...f.request.candidate,
        scopeId: receipt.candidateBinding.scopeId,
      },
      expectedCurrent,
      store: apiStore,
      evidenceStore,
      workspaceManifestStore,
      workspaceForStage: (stage) => ({
        workspaceId: stage,
        root: join(run, 'workspaces', stage),
      }),
      knownWriteRoots: [
        'config',
        'receipts',
        'checkpoints',
        'evidence',
        'manifests',
      ].map((name) => join(run, name)),
    });
  const apiStore = await api.FileWorkflowReceiptStore.create(
    join(run, 'receipts'),
  );
  const evidenceStore = await api.FileEvidenceStore.create(
    join(run, 'evidence'),
  );
  const workspaceManifestStore = await api.FileWorkspaceManifestStore.create(
    join(run, 'manifests'),
  );
  assert.equal((await verify()).status, 'candidate-verified');
  await writeFile(join(f.candidate, 'product.txt'), 'changed after review\n');
  await assert.rejects(verify());
  await writeFile(join(f.candidate, 'product.txt'), expected);
  assert.equal((await verify()).status, 'candidate-verified');
  const second = await f.launch(true).done;
  assert.notEqual(second.code, 0);
  assert.deepEqual(await f.receipt(), receipt);
});

test('EOF after acknowledged build resumes exact runtime prefix in a fresh session', async (t) => {
  const f = await fixture(t);
  const session = f.launch();
  let firstNonce;
  while (true) {
    const message = await session.next();
    if (message.type === 'checkpoint' && message.stage === 'build') break;
    if (message.type === 'checkpoint') continue;
    firstNonce ??= message.sessionId;
    await respond(f, session, message);
  }
  session.child.stdin.end();
  assert.notEqual((await session.done).code, 0);
  const prefix = await f.checkpoint();
  assert.deepEqual(
    prefix.stages.map((s) => s.stage),
    stages.slice(0, 3),
  );
  await f.absentReceipt();
  const resumed = f.launch(true);
  const first = await resumed.next();
  assert.equal(first.stage, 'review');
  assert.notEqual(first.sessionId, firstNonce);
  await respond(f, resumed, first);
  assert.deepEqual(await drive(f, resumed), ['verify', 'deliver']);
  assert.deepEqual((await f.checkpoint()).stages.slice(0, 3), prefix.stages);
  assert.equal((await f.receipt()).startedAt, prefix.startedAt);
});

test('EOF before work retains empty intent and permits an unchanged restart', async (t) => {
  const f = await fixture(t);
  const session = f.launch();
  const first = await session.next();
  assert.equal(first.stage, 'investigate');
  session.child.stdin.end();
  assert.notEqual((await session.done).code, 0);
  assert.deepEqual((await f.checkpoint()).stages, []);
  await f.absentReceipt();
  assert.deepEqual(await drive(f, f.launch(true)), stages);
});

test('unacknowledged build mutation cannot become a new initial candidate on resume', async (t) => {
  const f = await fixture(t);
  const session = f.launch();
  while (true) {
    const message = await session.next();
    if (message.type === 'checkpoint') continue;
    if (message.stage === 'build') break;
    await respond(f, session, message);
  }
  await writeFile(join(f.candidate, 'product.txt'), expected);
  session.child.stdin.end();
  assert.notEqual((await session.done).code, 0);
  await f.absentReceipt();
  const resumed = await f.launch(true).done;
  assert.notEqual(resumed.code, 0);
  assert(!resumed.messages.some((message) => message.type === 'stage'));
});

test('required capabilities remain unavailable rather than accepting caller declarations', async (t) => {
  const f = await fixture(t, {
    obligations: {
      workType: 'feature',
      delegation: 'required',
      review: 'independent',
      evidence: 'revision-bound',
      delivery: 'local',
    },
  });
  const result = await f.launch().done;
  assert(!result.messages.some((message) => message.type === 'stage'));
  assert.equal((await f.receipt()).status, 'BLOCKED');
  assert.deepEqual((await f.receipt()).failure.missingCapabilities, [
    'subagents',
  ]);
});

test('malformed, stale, duplicated and oversized connected replies never yield PASS', async (t) => {
  for (const mode of [
    'json',
    'nonce',
    'stage',
    'duplicate',
    'oversize',
    'command',
  ]) {
    await t.test(mode, async (t) => {
      const f = await fixture(t);
      const session = f.launch();
      const message = await session.next();
      await resultFile(message);
      const reply = {
        type: 'result',
        sessionId: message.sessionId,
        requestId: message.requestId,
        stage: message.stage,
      };
      if (mode === 'nonce') reply.sessionId = 'old-session';
      if (mode === 'stage') reply.stage = 'build';
      if (mode === 'command')
        reply.command = `touch ${join(f.root, 'must-not-exist')}`;
      session.child.stdin.write(
        mode === 'json'
          ? '{no\n'
          : mode === 'oversize'
            ? 'x'.repeat(2049)
            : `${JSON.stringify(reply)}\n`.repeat(mode === 'duplicate' ? 2 : 1),
      );
      const result = await session.done;
      assert.notEqual(result.code, 0, JSON.stringify(result));
      const receipt = await f.receipt().catch(() => null);
      assert.notEqual(receipt?.status, 'PASS');
      assert(
        !result.messages.some(
          (item) => item.type === 'complete' && item.status === 'PASS',
        ),
      );
      await assert.rejects(access(join(f.root, 'must-not-exist')), {
        code: 'ENOENT',
      });
    });
  }
});

test('result bytes reject escaping paths, symlinks, oversized files and forged runtime records', async (t) => {
  for (const mode of [
    'escape',
    'symlink',
    'oversize',
    'metadata',
    'binding',
    'unknown',
    'nonce',
  ]) {
    await t.test(mode, async (t) => {
      const f = await fixture(t);
      const session = f.launch();
      const message = await session.next();
      await resultFile(
        message,
        mode === 'binding'
          ? { stageEvidence: { schema: 1 } }
          : mode === 'unknown'
            ? { command: 'never execute' }
            : mode === 'nonce'
              ? { sessionId: 'other-session' }
              : mode === 'escape'
                ? {
                    evidence: [
                      { name: 'outside', kind: 'stdout', path: '../outside' },
                    ],
                  }
                : {},
      );
      if (mode === 'oversize')
        await writeFile(
          join(message.workspace, 'observation.txt'),
          'x'.repeat(1024 * 1024 + 1),
        );
      if (mode === 'metadata')
        await writeFile(
          join(message.workspace, 'host-result.json'),
          'x'.repeat(32 * 1024 + 1),
        );
      if (mode === 'symlink') {
        await rm(join(message.workspace, 'observation.txt'));
        await symlink(
          join(f.candidate, 'product.txt'),
          join(message.workspace, 'observation.txt'),
        );
      }
      session.reply(message);
      const result = await session.done;
      assert.notEqual(result.code, 0);
      assert.equal((await f.receipt()).status, 'BLOCKED');
      assert.equal((await f.checkpoint()).stages.length, 0);
    });
  }
});

test('a genuine nonpass is terminal, not an interruption or retry instruction', async (t) => {
  const f = await fixture(t);
  const session = f.launch();
  const message = await session.next();
  await resultFile(message, {
    status: 'ISSUES',
    summary: 'independent defect retained',
  });
  session.reply(message);
  assert.notEqual((await session.done).code, 0);
  const receipt = await f.receipt();
  assert.equal(receipt.status, 'ISSUES');
  assert.equal(receipt.stages[0].summary, 'independent defect retained');
  const retry = await f.launch(true).done;
  assert.notEqual(retry.code, 0);
  assert(!retry.messages.some((item) => item.type === 'stage'));
});

test('fresh run destination is exclusive and candidate-overlapping writes are refused', async (t) => {
  const f = await fixture(t);
  await mkdir(f.request.runDirectory);
  await writeFile(join(f.request.runDirectory, 'preserve.txt'), 'keep me');
  assert.notEqual((await f.launch().done).code, 0);
  assert.equal(
    await readFile(join(f.request.runDirectory, 'preserve.txt'), 'utf8'),
    'keep me',
  );
  f.request.runDirectory = join(f.candidate, 'must-not-create');
  await writeFile(f.path, JSON.stringify(f.request));
  assert.notEqual((await f.launch().done).code, 0);
  await assert.rejects(access(f.request.runDirectory), { code: 'ENOENT' });
});

test('SIGINT leaves pending work unacknowledged and no manufactured terminal receipt', async (t) => {
  const f = await fixture(t);
  const session = f.launch();
  await session.next();
  session.child.kill('SIGINT');
  assert.notEqual((await session.done).code, 0);
  await f.absentReceipt();
  assert.equal((await f.checkpoint()).stages.length, 0);
});

test('an orphan manifest remains a runtime refusal rather than transport recovery', async (t) => {
  const f = await fixture(t);
  const session = f.launch();
  const message = await session.next();
  await resultFile(message);
  const store = await f.api.FileWorkspaceManifestStore.create(
    join(f.request.runDirectory, 'manifests'),
  );
  await store.save(
    await store.capture({
      runId: f.request.runId,
      revision: f.request.revision,
      subjectId: 'investigate',
      workspaceId: 'investigate',
      workspaceRoot: message.workspace,
      now: new Date(),
    }),
  );
  session.child.stdin.end();
  assert.notEqual((await session.done).code, 0);
  const resumed = await f.launch(true).done;
  assert.notEqual(resumed.code, 0);
  assert(!resumed.messages.some((item) => item.type === 'stage'));
  await f.absentReceipt();
});

test('leftover result files cannot answer a new session without matching identities', async (t) => {
  const f = await fixture(t);
  const first = f.launch();
  const old = await first.next();
  await resultFile(old);
  first.child.stdin.end();
  assert.notEqual((await first.done).code, 0);
  const resumed = f.launch(true);
  const current = await resumed.next();
  assert.notEqual(current.sessionId, old.sessionId);
  resumed.reply(current);
  assert.notEqual((await resumed.done).code, 0);
  assert.equal((await f.receipt()).status, 'BLOCKED');
  assert.deepEqual((await f.checkpoint()).stages, []);
});

test('caller-authored capabilities and unknown obligations refuse before reserving a run', async (t) => {
  for (const mode of ['capabilities', 'route', 'workType', 'obligation']) {
    await t.test(mode, async (t) => {
      const f = await fixture(t);
      if (mode === 'capabilities')
        f.request.capabilities = { available: ['subagents'] };
      if (mode === 'route') f.request.route = 'full-playbook';
      if (mode === 'workType') f.request.obligations.workType = 'invented-work';
      if (mode === 'obligation') f.request.obligations.noReviewNeeded = true;
      await writeFile(f.path, JSON.stringify(f.request));
      const result = await f.launch().done;
      assert.notEqual(result.code, 0);
      assert(!result.messages.some((item) => item.type === 'stage'));
      await assert.rejects(access(f.request.runDirectory), { code: 'ENOENT' });
    });
  }
});

test('resume refuses changed retained intent and runtime manifest before dispatch', async (t) => {
  for (const mode of ['manifest', 'initial', 'plan', 'missing-checkpoint']) {
    await t.test(mode, async (t) => {
      const f = await fixture(t);
      const session = f.launch();
      await session.next();
      session.child.stdin.end();
      assert.notEqual((await session.done).code, 0);
      if (mode === 'manifest') {
        const path = join(f.artifact, 'canonical-manifest.json');
        await writeFile(path, (await readFile(path, 'utf8')) + '\n');
      } else if (mode === 'missing-checkpoint') {
        await rm(
          join(
            f.request.runDirectory,
            'checkpoints',
            `${f.request.runId}.checkpoint.json`,
          ),
        );
      } else {
        const path = join(f.request.runDirectory, 'config', 'input.json');
        const descriptor = JSON.parse(await readFile(path, 'utf8'));
        if (mode === 'initial')
          descriptor.expectedInitial.sha256 = '0'.repeat(64);
        else descriptor.plan.evidence = 'minimal';
        await writeFile(path, JSON.stringify(descriptor));
      }
      const result = await f.launch(true).done;
      assert.notEqual(result.code, 0);
      assert(!result.messages.some((item) => item.type === 'stage'));
      await f.absentReceipt();
    });
  }
});

test('retained stage mutation refuses before requesting new work', async (t) => {
  const f = await fixture(t);
  const session = f.launch();
  const first = await session.next();
  await respond(f, session, first);
  const checkpoint = await session.next();
  assert.equal(checkpoint.type, 'checkpoint');
  session.child.stdin.end();
  assert.notEqual((await session.done).code, 0);
  await writeFile(join(first.workspace, 'observation.txt'), 'tampered');
  const result = await f.launch(true).done;
  assert.notEqual(result.code, 0);
  assert(!result.messages.some((item) => item.type === 'stage'));
});

test('closed output terminates the session without manufacturing completion', async (t) => {
  const f = await fixture(t);
  const session = f.launch();
  const first = await session.next();
  session.child.stdout.destroy();
  await resultFile(first);
  session.reply(first);
  assert.notEqual((await session.done).code, 0);
  await f.absentReceipt();
});

test('identical bytes at a substituted candidate root do not redirect retained work', async (t) => {
  const f = await fixture(t);
  const session = f.launch();
  await session.next();
  session.child.stdin.end();
  assert.notEqual((await session.done).code, 0);
  const substitute = join(f.root, 'substituted-product');
  await cp(f.candidate, substitute, { recursive: true });
  const path = join(f.request.runDirectory, 'config', 'input.json');
  const descriptor = JSON.parse(await readFile(path, 'utf8'));
  descriptor.candidate.root = substitute;
  await writeFile(path, JSON.stringify(descriptor));
  const resumed = f.launch(true);
  const outcome = await Promise.race([
    resumed.next().then(
      (message) => ({ message }),
      () => ({ message: null }),
    ),
    resumed.done.then((result) => ({ result })),
  ]);
  assert(
    !outcome.message,
    'Changed candidate root must refuse before dispatch.',
  );
  assert.notEqual((await resumed.done).code, 0);
  await f.absentReceipt();
  assert.equal(
    await readFile(join(f.candidate, 'product.txt'), 'utf8'),
    initial,
  );
  assert.equal(
    await readFile(join(substitute, 'product.txt'), 'utf8'),
    initial,
  );
});

test('a control byte in a pipe is malformed input, not a keyboard interruption', async (t) => {
  const f = await fixture(t);
  const session = f.launch();
  await session.next();
  session.child.stdin.write(Buffer.from([123, 3, 10]));
  const result = await session.done;
  assert.equal(result.code, 1);
  assert.equal((await f.receipt()).status, 'BLOCKED');
});
