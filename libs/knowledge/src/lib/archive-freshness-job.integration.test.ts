import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { FileChildTaskStore } from '@temari/runtime';
import { actualFixture } from '../support/fixtures.js';
import { captureArchive } from './archive-intake.js';
import { auditArchiveCurrentnessPaged } from './archive-currentness.js';
import {
  createArchiveFreshnessJobSpec,
  loadArchiveFreshnessJobSpec,
  tickArchiveFreshnessJob,
} from './archive-freshness-job.js';
import { canonical, hash } from './codec.js';
import { publishJson } from './durable.js';

const exec = promisify(execFile);
const policy = 'one-shot-pinned-local-currentness-v1' as const;

async function fixture() {
  const f = await actualFixture();
  const captured = await captureArchive({
    task: {
      id: 'freshness-test',
      directory: join(f.base, 'task'),
      authorityRef: 'synthetic-explicit-admission',
    },
    source: f.source,
    readScope: 'source-root',
    transport: {
      python: f.config.python,
      registrarSource: f.config.registrarSource,
      workspace: join(f.base, 'state'),
    },
    requestKey: 'freshness-before',
  });
  assert(captured.publicationPath);
  return { f, publicationPath: captured.publicationPath };
}

function pastDue(): string {
  return new Date(Date.now() - 60_000).toISOString();
}
async function disable(
  f: Awaited<ReturnType<typeof actualFixture>>,
): Promise<void> {
  await exec(
    f.config.python,
    [
      '-B',
      '-m',
      'knowledge_agent.cli',
      'sources',
      '--workspace',
      join(f.base, 'state'),
      'disable',
      f.source.id,
    ],
    {
      env: {
        PATH: '/usr/bin:/bin',
        PYTHONPATH: join(f.config.registrarSource, 'src'),
        PYTHONNOUSERSITE: '1',
        PYTHONDONTWRITEBYTECODE: '1',
      },
      timeout: 60000,
      maxBuffer: 1_048_576,
    },
  );
}

test('ACTUAL Registrar freshness job: future due is inert; one-shot unchanged audit is leased', async () => {
  const { f, publicationPath } = await fixture();
  const future = await createArchiveFreshnessJobSpec({
    publicationPath,
    notBefore: new Date(Date.now() + 3_600_000).toISOString(),
    policy,
  });
  const pending = await tickArchiveFreshnessJob(future);
  assert.equal(pending.status, 'PENDING');
  assert.equal(pending.action, 'none');
  await assert.rejects(
    stat(join(f.base, 'task/archive-freshness-child-tasks')),
    { code: 'ENOENT' },
  );

  const due = await createArchiveFreshnessJobSpec({
    publicationPath,
    notBefore: pastDue(),
    policy,
  });
  const first = await tickArchiveFreshnessJob(due);
  assert.equal(first.status, 'SUCCEEDED');
  assert.equal(first.action, 'audit');
  assert.equal(first.decision, 'unchanged');
  assert.equal(first.currentOriginal, 'not-rechecked');
  assert(Number.isFinite(Date.parse(first.auditObservedAt ?? '')));
  assert(first.stagePath && first.auditReceiptPath);
  await writeFile(
    join(f.base, 'sources/plan.txt'),
    'Changed after the one-shot audit.',
  );
  const repeated = await tickArchiveFreshnessJob(due);
  assert.equal(repeated.status, 'SUCCEEDED');
  assert.equal(repeated.action, 'none');
  assert.equal(repeated.decision, 'unchanged');
  assert.equal(repeated.auditReceiptPath, first.auditReceiptPath);
  const stageBytes = await readFile(first.stagePath, 'utf8');
  assert(!stageBytes.includes('Proposal plan'));
  assert(!stageBytes.includes('Changed after'));
  await disable(f);
  await assert.rejects(tickArchiveFreshnessJob(due));
});

test('ACTUAL Registrar freshness job: concurrent ticks detect edit, add and delete once', async () => {
  const { f, publicationPath } = await fixture();
  await writeFile(join(f.base, 'sources/plan.txt'), 'Edited original.');
  await writeFile(join(f.base, 'sources/added.txt'), 'New source.');
  await rm(join(f.base, 'sources/owner.txt'));
  const specPath = await createArchiveFreshnessJobSpec({
    publicationPath,
    notBefore: pastDue(),
    policy,
  });
  const pair = await Promise.all([
    tickArchiveFreshnessJob(specPath, { owner: 'freshness-worker-a' }),
    tickArchiveFreshnessJob(specPath, { owner: 'freshness-worker-b' }),
  ]);
  assert.equal(pair.filter((item) => item.action === 'audit').length, 1);
  for (const item of pair)
    if (item.status === 'SUCCEEDED' || item.status === 'ISSUES') {
      assert.equal(item.decision, 'recapture-needed');
      assert(item.auditReceiptPath && item.auditObservedAt);
    }
  const final = await tickArchiveFreshnessJob(specPath);
  assert.equal(final.status, 'ISSUES');
  assert.equal(final.decision, 'recapture-needed');
  assert(final.auditReceiptPath);
  const audit = JSON.parse(await readFile(final.auditReceiptPath, 'utf8'));
  assert.deepEqual(audit.counts, {
    added: 1,
    removed: 1,
    changed: 1,
    unchanged: 2,
    unavailable: 0,
  });
  assert.deepEqual(
    audit.added.map((row: { path: string }) => row.path),
    ['added.txt'],
  );
  assert.deepEqual(
    audit.removed.map((row: { path: string }) => row.path),
    ['owner.txt'],
  );
  assert.deepEqual(
    audit.changed.map((row: { path: string }) => row.path),
    ['plan.txt'],
  );
  const store = await FileChildTaskStore.create(
    join(f.base, 'task/archive-freshness-child-tasks'),
  );
  const record = await store.load(final.taskId);
  assert.equal(record?.attempt, 1);
  assert.equal(record?.status, 'ISSUES');
});

test('ACTUAL Registrar freshness job: partial audit is unknown and tampered artifacts refuse', async () => {
  const { f, publicationPath } = await fixture();
  await writeFile(
    join(f.base, 'sources/oversized.txt'),
    Buffer.alloc(8 * 1024 * 1024 + 1),
  );
  const specPath = await createArchiveFreshnessJobSpec({
    publicationPath,
    notBefore: pastDue(),
    policy,
  });
  const result = await tickArchiveFreshnessJob(specPath);
  assert.equal(result.status, 'ISSUES');
  assert.equal(result.decision, 'unknown-needs-review');
  assert(result.stagePath && result.auditReceiptPath);
  const audit = JSON.parse(await readFile(result.auditReceiptPath, 'utf8'));
  assert.equal(audit.status, 'partial');
  assert.equal(audit.counts.unavailable, 1);
  const originalStage = await readFile(result.stagePath, 'utf8');
  await writeFile(
    result.stagePath,
    canonical({ ...JSON.parse(originalStage), decision: 'unchanged' }),
  );
  await assert.rejects(tickArchiveFreshnessJob(specPath));
  await writeFile(result.stagePath, originalStage);
  const originalSpec = await readFile(specPath, 'utf8');
  await writeFile(
    specPath,
    canonical({
      ...JSON.parse(originalSpec),
      publicationSha256: '0'.repeat(64),
    }),
  );
  await assert.rejects(tickArchiveFreshnessJob(specPath));
});

test('ACTUAL Registrar freshness job: expired lease recovers durable stage without rescanning', async () => {
  const { f, publicationPath } = await fixture();
  const specPath = await createArchiveFreshnessJobSpec({
    publicationPath,
    notBefore: pastDue(),
    policy,
  });
  const spec = await loadArchiveFreshnessJobSpec(specPath);
  const audit = await auditArchiveCurrentnessPaged({ publicationPath });
  assert.equal(audit.receipt.counts.changed, 0);
  const sha = hash(canonical(spec));
  const taskId = `archive-freshness-${sha.slice(0, 32)}`;
  const stagePath = join(f.base, 'task', `archive-freshness-stage-${sha}.json`);
  const store = await FileChildTaskStore.create(
    join(f.base, 'task/archive-freshness-child-tasks'),
  );
  const oldTime = new Date(Date.now() - 3 * 60_000);
  await store.create({
    taskId,
    runId: taskId,
    revision: sha,
    dependsOn: [],
    actor: 'crashed-worker',
    now: oldTime,
  });
  const claimed = await store.claim({
    taskId,
    owner: 'crashed-worker',
    leaseMs: 120_000,
    now: oldTime,
  });
  assert(claimed.claimed);
  await publishJson(stagePath, {
    schema: 1,
    kind: 'temari-archive-freshness-job-stage',
    specSha256: sha,
    auditReceiptPath: audit.receiptPath,
    auditReceiptSha256: hash(await readFile(audit.receiptPath)),
    auditObservedAt: audit.receipt.observedAt,
    decision: 'unchanged',
  });
  await writeFile(
    join(f.base, 'sources/plan.txt'),
    'Changed after staged audit.',
  );
  const resumed = await tickArchiveFreshnessJob(specPath);
  assert.equal(resumed.action, 'recover-stage');
  assert.equal(resumed.status, 'SUCCEEDED');
  assert.equal(resumed.auditReceiptPath, audit.receiptPath);
  assert.equal((await store.load(taskId))?.attempt, 2);
});

test('ACTUAL Registrar freshness job: crash before stage permits one retry, then caps source scans', async () => {
  const first = await fixture();
  const specPath = await createArchiveFreshnessJobSpec({
    publicationPath: first.publicationPath,
    notBefore: pastDue(),
    policy,
  });
  const sha = hash(canonical(await loadArchiveFreshnessJobSpec(specPath)));
  const taskId = `archive-freshness-${sha.slice(0, 32)}`;
  const store = await FileChildTaskStore.create(
    join(first.f.base, 'task/archive-freshness-child-tasks'),
  );
  const oldTime = new Date(Date.now() - 3 * 60_000);
  await store.create({
    taskId,
    runId: taskId,
    revision: sha,
    dependsOn: [],
    actor: 'crashed-before-stage',
    now: oldTime,
  });
  assert(
    (
      await store.claim({
        taskId,
        owner: 'crashed-before-stage',
        leaseMs: 120_000,
        now: oldTime,
      })
    ).claimed,
  );
  const retried = await tickArchiveFreshnessJob(specPath);
  assert.equal(retried.action, 'audit');
  assert.equal(retried.decision, 'unchanged');
  assert.equal((await store.load(taskId))?.attempt, 2);

  const second = await fixture();
  const cappedPath = await createArchiveFreshnessJobSpec({
    publicationPath: second.publicationPath,
    notBefore: pastDue(),
    policy,
  });
  const cappedSha = hash(
    canonical(await loadArchiveFreshnessJobSpec(cappedPath)),
  );
  const cappedId = `archive-freshness-${cappedSha.slice(0, 32)}`;
  const cappedStore = await FileChildTaskStore.create(
    join(second.f.base, 'task/archive-freshness-child-tasks'),
  );
  const firstTime = new Date(Date.now() - 6 * 60_000);
  const secondTime = new Date(Date.now() - 3 * 60_000);
  await cappedStore.create({
    taskId: cappedId,
    runId: cappedId,
    revision: cappedSha,
    dependsOn: [],
    actor: 'crashed-twice',
    now: firstTime,
  });
  assert(
    (
      await cappedStore.claim({
        taskId: cappedId,
        owner: 'crashed-twice',
        leaseMs: 120_000,
        now: firstTime,
      })
    ).claimed,
  );
  assert(
    (
      await cappedStore.claim({
        taskId: cappedId,
        owner: 'crashed-twice',
        leaseMs: 120_000,
        now: secondTime,
      })
    ).claimed,
  );
  const stopped = await tickArchiveFreshnessJob(cappedPath);
  assert.equal(stopped.status, 'BLOCKED');
  assert.equal(stopped.action, 'none');
  assert.equal(stopped.auditReceiptPath, null);
  assert.equal((await cappedStore.load(cappedId))?.status, 'BLOCKED');
});

test('ACTUAL Registrar freshness job: failed second attempt recovers a valid stage without another scan', async () => {
  const { f, publicationPath } = await fixture();
  const specPath = await createArchiveFreshnessJobSpec({
    publicationPath,
    notBefore: pastDue(),
    policy,
  });
  const spec = await loadArchiveFreshnessJobSpec(specPath);
  const audit = await auditArchiveCurrentnessPaged({ publicationPath });
  const sha = hash(canonical(spec));
  const taskId = `archive-freshness-${sha.slice(0, 32)}`;
  const stagePath = join(f.base, 'task', `archive-freshness-stage-${sha}.json`);
  const store = await FileChildTaskStore.create(
    join(f.base, 'task/archive-freshness-child-tasks'),
  );
  const firstTime = new Date(Date.now() - 6 * 60_000);
  const secondTime = new Date(Date.now() - 3 * 60_000);
  await store.create({
    taskId,
    runId: taskId,
    revision: sha,
    dependsOn: [],
    actor: 'interrupted-worker',
    now: firstTime,
  });
  assert(
    (
      await store.claim({
        taskId,
        owner: 'interrupted-worker',
        leaseMs: 120_000,
        now: firstTime,
      })
    ).claimed,
  );
  const secondClaim = await store.claim({
    taskId,
    owner: 'interrupted-worker',
    leaseMs: 120_000,
    now: secondTime,
  });
  assert(secondClaim.claimed && secondClaim.record.lease);
  await publishJson(stagePath, {
    schema: 1,
    kind: 'temari-archive-freshness-job-stage',
    specSha256: sha,
    auditReceiptPath: audit.receiptPath,
    auditReceiptSha256: hash(await readFile(audit.receiptPath)),
    auditObservedAt: audit.receipt.observedAt,
    decision: 'unchanged',
  });
  await store.complete({
    taskId,
    owner: 'interrupted-worker',
    leaseToken: secondClaim.record.lease.token,
    fencingEpoch: secondClaim.record.lease.fencingEpoch,
    status: 'FAILED',
    idempotencyKey: 'simulated-completion-failure',
    error: 'Synthetic mechanical failure after stage publication.',
    now: new Date(secondTime.getTime() + 30_000),
  });
  await writeFile(
    join(f.base, 'sources/plan.txt'),
    'Changed after staged audit.',
  );
  const retry = await tickArchiveFreshnessJob(specPath);
  assert.equal(retry.action, 'retry-queued');
  const resumed = await tickArchiveFreshnessJob(specPath);
  assert.equal(resumed.action, 'recover-stage');
  assert.equal(resumed.status, 'SUCCEEDED');
  assert.equal(resumed.auditReceiptPath, audit.receiptPath);
  assert.equal((await store.load(taskId))?.attempt, 3);
});

test('ACTUAL Registrar freshness job: disabled source is terminal without a retry', async () => {
  const { f, publicationPath } = await fixture();
  const specPath = await createArchiveFreshnessJobSpec({
    publicationPath,
    notBefore: pastDue(),
    policy,
  });
  await disable(f);
  const final = await tickArchiveFreshnessJob(specPath);
  assert.equal(final.status, 'BLOCKED');
  assert.equal(final.action, 'admission-refused');
  assert.equal(final.stagePath, null);
  const repeated = await tickArchiveFreshnessJob(specPath);
  assert.equal(repeated.status, 'BLOCKED');
  assert.equal(repeated.action, 'none');
  const store = await FileChildTaskStore.create(
    join(f.base, 'task/archive-freshness-child-tasks'),
  );
  assert.equal((await store.load(final.taskId))?.attempt, 1);
});

test('ACTUAL Registrar freshness job: admission revocation after mechanical failure blocks retry', async () => {
  const { f, publicationPath } = await fixture();
  const specPath = await createArchiveFreshnessJobSpec({
    publicationPath,
    notBefore: pastDue(),
    policy,
  });
  const database = join(f.base, 'state/registry.sqlite3');
  const held = join(f.base, 'state/registry.held');
  await rename(database, held);
  await assert.rejects(tickArchiveFreshnessJob(specPath));
  await rename(held, database);
  await disable(f);
  const blocked = await tickArchiveFreshnessJob(specPath);
  assert.equal(blocked.status, 'BLOCKED');
  assert.equal(blocked.action, 'admission-refused');
  assert.equal(blocked.decision, null);
  const store = await FileChildTaskStore.create(
    join(f.base, 'task/archive-freshness-child-tasks'),
  );
  assert.equal((await store.load(blocked.taskId))?.status, 'BLOCKED');
  assert.equal(
    await tickArchiveFreshnessJob(specPath).then((next) => next.action),
    'none',
  );
});
