import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  WORKFLOW_STAGES,
  type WorkerEvidenceReference,
  type WorkflowStageId,
} from '@temari/contracts';
import {
  createRequestPlan,
  type CloseoutDecision,
  type TemariPlanRequest,
} from '@temari/temari-core';
import {
  FileEvidenceStore,
  FileWorkflowCheckpointStore,
  FileWorkflowReceiptStore,
  FileWorkspaceManifestStore,
} from '../index.js';

const workerPath = fileURLToPath(
  new URL('./fixtures/migration-acceptance-worker.ts', import.meta.url),
);
const workspaceRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const source = ' pear \napple\n';
const request: TemariPlanRequest = {
  workType: 'feature',
  lightweight: {
    resultIsClearLocalAndReversible: true,
    changesSharedBoundary: false,
    isReportedDefect: false,
    hasUnexplainedSymptom: false,
    makesPerformanceClaim: false,
    isDesignChoice: false,
    isMigration: false,
    affectedCallersAreKnown: true,
    crossesArchitecturalBoundary: false,
    directCheckAvailable: true,
  },
  obligations: { evidence: 'revision-bound' },
};

async function fixture(t: TestContext, qa = false) {
  // The parent alone owns creation and removal; spaces exercise argv handling.
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'temari migration acceptance-')),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const runId = randomUUID();
  const revision = `fixture-${createHash('sha256').update(source).digest('hex')}`;
  const planRequest: TemariPlanRequest = qa
    ? { ...request, workType: 'qa', qaResponsibility: 'ticket-coverage' }
    : request;
  await writeFile(join(root, 'source.txt'), source);
  await writeFile(join(root, 'events.jsonl'), '');
  await writeFile(
    join(root, 'request.json'),
    JSON.stringify({ runId, revision, request: planRequest }),
  );
  return { root, runId, revision, requestPlan: createRequestPlan(planRequest) };
}

async function child(
  root: string,
  mode: string,
  expectedCode = 0,
  revision?: string,
) {
  const result = await new Promise<{
    code: number;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    execFile(
      process.execPath,
      [
        '--import',
        '@swc-node/register/esm-register',
        workerPath,
        root,
        mode,
        ...(revision ? [revision] : []),
      ],
      {
        cwd: workspaceRoot,
        timeout: 20_000,
        killSignal: 'SIGKILL',
        maxBuffer: 1024 * 1024,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (error && (error.killed || typeof error.code !== 'number')) {
          reject(error);
        } else {
          resolve({ code: error ? Number(error.code) : 0, stdout, stderr });
        }
      },
    );
  });
  assert.equal(
    result.code,
    expectedCode,
    `${mode}: ${result.stderr}\n${result.stdout}`,
  );
  return result;
}

interface Event {
  kind: string;
  stage?: WorkflowStageId;
  runId?: string;
  revision?: string;
  sha256?: string;
}

async function events(root: string): Promise<Event[]> {
  const lines = (await readFile(join(root, 'events.jsonl'), 'utf8')).trim();
  return lines ? lines.split('\n').map((line) => JSON.parse(line)) : [];
}

test('migration acceptance: a fresh process resumes the persisted build prefix and verifies closeout bytes', async (t) => {
  const f = await fixture(t);
  assert.equal(f.requestPlan.route.route, 'lightweight-engineering');
  await child(f.root, 'interrupt', 73);

  const checkpoints = await FileWorkflowCheckpointStore.create(
    join(f.root, 'checkpoints'),
  );
  const receipts = await FileWorkflowReceiptStore.create(
    join(f.root, 'receipts'),
  );
  const checkpoint = await checkpoints.load(f.runId);
  assert(checkpoint);
  assert.equal(checkpoint.revision, f.revision);
  assert.deepEqual(checkpoint.plan, f.requestPlan.plan);
  assert.deepEqual(
    checkpoint.stages.map((stage) => stage.stage),
    ['investigate', 'plan', 'build'],
  );
  assert(checkpoint.stages.every((stage) => stage.status === 'PASS'));
  assert.equal(await receipts.load(f.runId), null);
  assert.deepEqual(
    (await events(f.root)).map(({ kind, stage }) => ({ kind, stage })),
    [
      { kind: 'handler', stage: 'investigate' },
      { kind: 'handler', stage: 'plan' },
      { kind: 'handler', stage: 'build' },
      { kind: 'checkpoint-persisted', stage: 'build' },
    ],
  );

  await child(f.root, 'resume');

  assert.equal(
    await readFile(join(f.root, 'workspaces', 'deliver', 'result.txt'), 'utf8'),
    'APPLE\nPEAR\n',
  );
  const receipt = await (
    await FileWorkflowReceiptStore.create(join(f.root, 'receipts'))
  ).load(f.runId);
  assert(receipt);
  assert.equal(receipt.runId, f.runId);
  assert.equal(receipt.revision, f.revision);
  assert.equal(receipt.status, 'PASS');
  assert.equal(receipt.failure, null);
  assert.deepEqual(receipt.plan, f.requestPlan.plan);
  assert.deepEqual(receipt.stages.slice(0, 3), checkpoint.stages);
  assert.equal(receipt.startedAt, checkpoint.startedAt);
  assert.deepEqual(
    receipt.stages.map((stage) => stage.stage),
    WORKFLOW_STAGES,
  );
  assert.deepEqual((await checkpoints.load(f.runId))?.stages, receipt.stages);

  const journal = await events(f.root);
  assert.deepEqual(
    journal.filter((event) => event.kind === 'handler'),
    WORKFLOW_STAGES.map((stage) => ({
      kind: 'handler',
      stage,
      runId: f.runId,
      revision: f.revision,
    })),
  );
  assert.deepEqual(
    journal.slice(-7).map(({ kind, stage }) => ({ kind, stage })),
    [
      ...WORKFLOW_STAGES.map((stage) => ({ kind: 'evidence-verified', stage })),
      { kind: 'closeout-evaluated', stage: undefined },
    ],
  );
  assert.equal(
    journal.filter((event) => event.kind === 'closeout-evaluated').length,
    1,
  );

  const decision: CloseoutDecision = JSON.parse(
    await readFile(join(f.root, 'closeout.json'), 'utf8'),
  );
  assert.equal(decision.status, 'ready');
  assert(decision.status === 'ready');
  assert.equal(decision.runId, f.runId);
  assert.equal(decision.revision, f.revision);
  assert.equal(decision.evidence.length, WORKFLOW_STAGES.length);
  const evidence = await FileEvidenceStore.create(join(f.root, 'evidence'));
  const manifests = await FileWorkspaceManifestStore.create(
    join(f.root, 'manifests'),
  );
  for (const [index, stage] of receipt.stages.entries()) {
    assert.equal(stage.status, 'PASS');
    assert.equal(stage.workspaceManifestId, stage.stage);
    const manifest = await manifests.load(f.runId, stage.stage);
    assert(manifest);
    assert.equal(manifest.revision, f.revision);
    await manifests.verify(manifest, join(f.root, 'workspaces', stage.stage));
    const reference: WorkerEvidenceReference = decision.evidence[index];
    assert.equal(reference.runId, f.runId);
    assert.equal(reference.revision, f.revision);
    assert.deepEqual(
      reference,
      JSON.parse(await readFile(stage.evidencePaths[1], 'utf8')),
    );
    assert.deepEqual(
      Buffer.from(await evidence.loadPortable(reference)),
      await readFile(stage.evidencePaths[0]),
    );
  }
});

test('migration acceptance: QA without subagents is blocked before any handler writes', async (t) => {
  const f = await fixture(t, true);
  assert.equal(f.requestPlan.route.route, 'qa-review');
  assert.equal(f.requestPlan.plan.review, 'independent');
  assert.deepEqual(f.requestPlan.plan.requiredCapabilities, ['subagents']);
  await child(f.root, 'run');
  const receipt = await (
    await FileWorkflowReceiptStore.create(join(f.root, 'receipts'))
  ).load(f.runId);
  assert(receipt);
  assert.equal(receipt.status, 'BLOCKED');
  assert.equal(receipt.failure?.kind, 'capability-gap');
  assert.deepEqual(receipt.failure?.missingCapabilities, ['subagents']);
  assert.deepEqual(receipt.stages, []);
  assert.deepEqual(await events(f.root), []);
  await assert.rejects(readdir(join(f.root, 'workspaces')), { code: 'ENOENT' });
  assert.deepEqual(await readdir(join(f.root, 'checkpoints')), []);
  assert.deepEqual(await readdir(join(f.root, 'evidence')), []);
  await assert.rejects(readFile(join(f.root, 'closeout.json')), {
    code: 'ENOENT',
  });
});

test('migration acceptance: resume rejects altered acknowledged workspace bytes before more handlers run', async (t) => {
  const f = await fixture(t);
  await child(f.root, 'interrupt', 73);
  const before = await events(f.root);
  // Equal byte length ensures the manifest hash, not only its size, is checked.
  await writeFile(
    join(f.root, 'workspaces', 'build', 'result.txt'),
    'APPLE\nPLUM\n',
  );
  const result = await child(f.root, 'resume', 1);
  assert.match(result.stderr, /Workspace manifest changed/);
  assert.deepEqual(await events(f.root), before);
  assert.equal(
    await (
      await FileWorkflowReceiptStore.create(join(f.root, 'receipts'))
    ).load(f.runId),
    null,
  );
});

test('migration acceptance: resume rejects a mismatched revision before more handlers run', async (t) => {
  const f = await fixture(t);
  await child(f.root, 'interrupt', 73);
  const before = await events(f.root);
  const result = await child(f.root, 'resume', 1, 'different-fixture-revision');
  // Workspace binding validation can reject the revision before the engine does.
  assert.match(result.stderr, /different-fixture-revision/);
  assert.match(
    result.stderr,
    /AssertionError|checkpoint revision does not match/,
  );
  assert.deepEqual(await events(f.root), before);
  assert.equal(
    await (
      await FileWorkflowReceiptStore.create(join(f.root, 'receipts'))
    ).load(f.runId),
    null,
  );
});

for (const damage of ['missing', 'tampered'] as const) {
  test(`migration acceptance: ${damage} evidence bytes reject closeout before readiness is evaluated`, async (t) => {
    const f = await fixture(t);
    await child(f.root, 'run');
    const reference: WorkerEvidenceReference = JSON.parse(
      await readFile(
        join(f.root, 'workspaces', 'verify', 'evidence.json'),
        'utf8',
      ),
    );
    assert.equal(reference.runId, f.runId);
    assert.equal(reference.revision, f.revision);
    const evidencePath = join(
      f.root,
      'evidence',
      `${reference.sha256}.artifact`,
    );
    const original = await readFile(evidencePath);
    const before = await events(f.root);
    await unlink(join(f.root, 'closeout.json'));
    if (damage === 'missing') {
      await unlink(evidencePath);
    } else {
      const altered = Buffer.from(original);
      altered[0] ^= 1;
      await writeFile(evidencePath, altered);
    }
    const result = await child(f.root, 'closeout', 1);
    assert.match(
      result.stderr,
      damage === 'missing' ? /ENOENT/ : /Evidence hash changed/,
    );
    const after = await events(f.root);
    assert.deepEqual(after.slice(0, before.length), before);
    assert.deepEqual(
      after.slice(before.length).map(({ kind, stage }) => ({ kind, stage })),
      WORKFLOW_STAGES.slice(0, 4).map((stage) => ({
        kind: 'evidence-verified',
        stage,
      })),
      'earlier bytes may verify, but readiness must wait for every artifact',
    );
    await assert.rejects(readFile(join(f.root, 'closeout.json')), {
      code: 'ENOENT',
    });
    // Restoring the exact bytes proves that the rejection was caused by damage.
    await writeFile(evidencePath, original);
    await child(f.root, 'closeout');
    assert.equal(
      (await events(f.root)).filter(
        (event) => event.kind === 'closeout-evaluated',
      ).length,
      2,
    );
  });
}
