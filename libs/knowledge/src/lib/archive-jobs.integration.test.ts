import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { FileChildTaskStore } from '@temari/runtime';
import { actualFixture, documents } from '../support/fixtures.js';
import {
  createArchiveJobSpec,
  tickArchiveJobs,
  type ArchiveJobPlan,
} from './archive-jobs.js';
import { runArchiveIntake, runArchiveQuery } from './archive-journey.js';
import { canonical, hash } from './codec.js';
import { publishJson, readJson } from './durable.js';

async function fixture(localOnly = false): Promise<ArchiveJobPlan> {
  const f = await actualFixture();
  const task = {
    id: 'two-job-fixture',
    directory: join(f.base, 'task'),
    authorityRef: 'synthetic-two-job-admission',
  };
  return {
    intake: {
      task,
      ...(localOnly ? { localOnlySourceIds: [f.source.id] } : {}),
      intakes: [
        {
          task,
          source: f.source,
          readScope: 'source-root',
          requestKey: 'two-job-v1',
          transport: {
            python: f.config.python,
            registrarSource: f.config.registrarSource,
            workspace: join(f.base, 'state'),
          },
        },
      ],
    },
    query: {
      id: 'find-proposal',
      query: 'Proposal',
      sourceIds: [f.source.id],
      topK: 2,
      discoveryMode: 'bm25',
      hostedTextApproved: false,
    },
  };
}

test('ACTUAL CLI: one tick per child resumes from durable handoff and keeps query unlabelled', async () => {
  const plan = await fixture();
  const specPath = await createArchiveJobSpec(plan);
  assert.equal(await createArchiveJobSpec(plan), specPath);
  const first = await tickArchiveJobs(specPath);
  assert.equal(first.action, 'intake');
  assert.equal(first.intake, 'SUCCEEDED');
  assert.equal(first.search, 'QUEUED');
  assert(first.handoffPath);
  assert.equal(first.reportPath, null);
  const second = await tickArchiveJobs(specPath);
  assert.equal(second.action, 'search');
  assert.equal(second.intake, 'SUCCEEDED');
  assert.equal(second.search, 'SUCCEEDED');
  assert(second.reportPath);
  const report = JSON.stringify(await readJson(second.reportPath));
  assert(!report.includes('expected'));
  assert(!report.includes('required'));
  assert(!report.includes(documents['update.txt']));
  assert.equal((await tickArchiveJobs(specPath)).action, 'none');
  const store = await FileChildTaskStore.create(
    join(plan.intake.task.directory, 'archive-child-tasks'),
  );
  const intake = await store.load(second.intakeTaskId);
  const search = await store.load(second.searchTaskId);
  assert.deepEqual(search?.dependsOn, [second.intakeTaskId]);
  assert.equal(search?.attempt, 1);
  assert.equal(search?.result?.evidencePaths[0], second.reportPath);
  assert.equal(intake?.result?.evidencePaths[0], second.handoffPath);
  assert.deepEqual(
    (await store.events(second.searchTaskId)).map((event) => event.type),
    ['task-created', 'task-claimed', 'task-completed'],
  );
});

test('ACTUAL CLI: local-only intake prevents hosted query despite explicit approval', async () => {
  const base = await fixture(true);
  const plan = { ...base, query: { ...base.query, hostedTextApproved: true } };
  const specPath = await createArchiveJobSpec(plan);
  await tickArchiveJobs(specPath);
  const result = await tickArchiveJobs(specPath);
  assert(result.reportPath);
  const report = (await readJson(result.reportPath)) as Record<string, any>;
  assert.equal(report.query.jevSharing, 'local-only');
  assert(
    report.query.jev.judgments.every(
      (item: Record<string, unknown>) => item['gap'] === 'local-only',
    ),
  );
  assert(!JSON.stringify(report).includes('required'));
});

test('job spec rejects privacy typos before any intake or TypeSafe call', async () => {
  const plan = await fixture();
  await assert.rejects(
    () =>
      createArchiveJobSpec({
        ...plan,
        query: { ...plan.query, hostedTextApproval: false },
      } as unknown as ArchiveJobPlan),
    /Unknown query field/,
  );
  await assert.rejects(
    () =>
      createArchiveJobSpec({
        ...plan,
        intake: {
          ...plan.intake,
          localOnlySourceId: [plan.query.sourceIds[0]],
        },
      } as unknown as ArchiveJobPlan),
    /Unknown intake field/,
  );
  await assert.rejects(
    () =>
      createArchiveJobSpec({
        ...plan,
        intake: {
          ...plan.intake,
          intakes: [
            {
              ...plan.intake.intakes[0],
              localOnlySourceIds: [plan.query.sourceIds[0]],
            },
          ],
        },
      } as unknown as ArchiveJobPlan),
    /Unknown intake source field/,
  );
  const specPath = await createArchiveJobSpec(plan);
  assert(!String(await readFile(specPath)).includes('TYPESAFE_API_KEY'));
});

test('expired intake lease finishes from a durable stage receipt after restart', async () => {
  const plan = await fixture();
  const specPath = await createArchiveJobSpec(plan);
  const spec = await readJson(specPath);
  const digest = hash(canonical(spec));
  const intakeTaskId = `archive-intake-${digest.slice(0, 32)}`;
  const store = await FileChildTaskStore.create(
    join(plan.intake.task.directory, 'archive-child-tasks'),
  );
  const past = new Date(Date.now() - 300_000);
  await store.create({
    taskId: intakeTaskId,
    runId: `archive-${digest.slice(0, 32)}`,
    revision: digest,
    dependsOn: [],
    actor: 'old-worker',
    now: past,
  });
  const old = await store.claim({
    taskId: intakeTaskId,
    owner: 'old-worker',
    leaseMs: 120_000,
    now: new Date(past.getTime() + 1000),
  });
  assert(old.claimed);
  const captured = await runArchiveIntake(plan.intake);
  assert(captured.handoffPath);
  await publishJson(
    join(plan.intake.task.directory, `archive-job-intake-${digest}.json`),
    {
      schema: 1,
      kind: 'temari-archive-job-stage',
      specSha256: digest,
      stage: 'intake',
      status: 'SUCCEEDED',
      evidencePaths: [captured.handoffPath],
      summary: 'Pinned intake handoff published.',
    },
  );
  const resumed = await tickArchiveJobs(specPath, { owner: 'new-worker' });
  assert.equal(resumed.intake, 'SUCCEEDED');
  assert.equal(resumed.search, 'QUEUED');
  assert.equal(resumed.handoffPath, captured.handoffPath);
  assert.equal((await store.load(intakeTaskId))?.attempt, 2);
  assert.deepEqual(
    (await store.events(intakeTaskId)).map((event) => event.type),
    ['task-created', 'task-claimed', 'task-claimed', 'task-completed'],
  );
});

test('mechanical retry is bounded and BLOCKED is never retried', async () => {
  const plan = await fixture();
  const specPath = await createArchiveJobSpec(plan);
  const digest = hash(canonical(await readJson(specPath)));
  const intakeTaskId = `archive-intake-${digest.slice(0, 32)}`;
  const store = await FileChildTaskStore.create(
    join(plan.intake.task.directory, 'archive-child-tasks'),
  );
  await store.create({
    taskId: intakeTaskId,
    runId: `archive-${digest.slice(0, 32)}`,
    revision: digest,
    dependsOn: [],
    actor: 'test-worker',
  });
  for (let attempt = 1; attempt <= 2; attempt++) {
    const claimed = await store.claim({
      taskId: intakeTaskId,
      owner: 'test-worker',
      leaseMs: 120_000,
    });
    assert(claimed.record.lease);
    await store.complete({
      taskId: intakeTaskId,
      owner: 'test-worker',
      leaseToken: claimed.record.lease.token,
      fencingEpoch: claimed.record.lease.fencingEpoch,
      status: 'FAILED',
      idempotencyKey: `failed:${attempt}`,
      error: 'synthetic mechanical failure',
    });
    const tick = await tickArchiveJobs(specPath);
    if (attempt === 1) {
      assert.equal(tick.action, 'retry-queued');
      assert.equal(tick.intake, 'QUEUED');
    } else {
      assert.equal(tick.action, 'none');
      assert.equal(tick.status, 'FAILED');
    }
  }
  assert.equal((await store.load(intakeTaskId))?.attempt, 2);
});

test('uncertain hosted search lease blocks re-execution instead of repeating TypeSafe', async () => {
  const base = await fixture();
  const plan = { ...base, query: { ...base.query, hostedTextApproved: true } };
  const specPath = await createArchiveJobSpec(plan);
  const first = await tickArchiveJobs(specPath);
  assert.equal(first.intake, 'SUCCEEDED');
  const store = await FileChildTaskStore.create(
    join(plan.intake.task.directory, 'archive-child-tasks'),
  );
  const past = new Date(Date.now() - 300_000);
  const old = await store.claim({
    taskId: first.searchTaskId,
    owner: 'old-search-worker',
    leaseMs: 120_000,
    now: new Date(past.getTime() + 1000),
  });
  assert(old.claimed);
  const blocked = await tickArchiveJobs(specPath, {
    owner: 'replacement-worker',
  });
  assert.equal(blocked.action, 'search');
  assert.equal(blocked.search, 'BLOCKED');
  assert.equal(blocked.status, 'BLOCKED');
  assert.equal(blocked.reportPath, null);
  assert.equal((await tickArchiveJobs(specPath)).action, 'none');
});

test('resumed intake refuses another valid capture under the same source ID', async () => {
  const plan = await fixture();
  const specPath = await createArchiveJobSpec(plan);
  const digest = hash(canonical(await readJson(specPath)));
  const intakeTaskId = `archive-intake-${digest.slice(0, 32)}`;
  const alternate = await runArchiveIntake({
    ...plan.intake,
    intakes: [{ ...plan.intake.intakes[0], requestKey: 'different-capture' }],
  });
  assert(alternate.handoffPath);
  const store = await FileChildTaskStore.create(
    join(plan.intake.task.directory, 'archive-child-tasks'),
  );
  const past = new Date(Date.now() - 300_000);
  await store.create({
    taskId: intakeTaskId,
    runId: `archive-${digest.slice(0, 32)}`,
    revision: digest,
    dependsOn: [],
    actor: 'old-worker',
    now: past,
  });
  await store.claim({
    taskId: intakeTaskId,
    owner: 'old-worker',
    leaseMs: 120_000,
    now: new Date(past.getTime() + 1000),
  });
  await publishJson(
    join(plan.intake.task.directory, `archive-job-intake-${digest}.json`),
    {
      schema: 1,
      kind: 'temari-archive-job-stage',
      specSha256: digest,
      stage: 'intake',
      status: 'SUCCEEDED',
      evidencePaths: [alternate.handoffPath],
      summary: 'Pinned intake handoff published.',
    },
  );
  const refused = await tickArchiveJobs(specPath);
  assert.equal(refused.intake, 'FAILED');
  assert.equal(refused.search, 'QUEUED');
  assert.equal(refused.handoffPath, null);
});

test('resumed search refuses a forged pass over a gapful query report', async () => {
  const base = await fixture();
  const plan = {
    ...base,
    query: { ...base.query, query: 'no-such-search-token-777' },
  };
  const specPath = await createArchiveJobSpec(plan);
  const first = await tickArchiveJobs(specPath);
  assert(first.handoffPath);
  const search = await runArchiveQuery({
    ...plan.query,
    handoffPath: first.handoffPath,
  });
  assert.equal(search.report.query.ranked.length, 0);
  const digest = hash(canonical(await readJson(specPath)));
  await publishJson(
    join(plan.intake.task.directory, `archive-job-search-${digest}.json`),
    {
      schema: 1,
      kind: 'temari-archive-job-stage',
      specSha256: digest,
      stage: 'search',
      status: 'SUCCEEDED',
      evidencePaths: [search.reportPath],
      summary: 'Pinned lexical shortlist verified.',
    },
  );
  const store = await FileChildTaskStore.create(
    join(plan.intake.task.directory, 'archive-child-tasks'),
  );
  const past = new Date(Date.now() - 300_000);
  await store.claim({
    taskId: first.searchTaskId,
    owner: 'old-search-worker',
    leaseMs: 120_000,
    now: new Date(past.getTime() + 1000),
  });
  const refused = await tickArchiveJobs(specPath);
  assert.equal(refused.search, 'FAILED');
  assert.equal(refused.reportPath, null);
});

test('resumed BLOCKED receipt rejects unverified evidence path', async () => {
  const plan = await fixture();
  const specPath = await createArchiveJobSpec(plan);
  const digest = hash(canonical(await readJson(specPath)));
  const intakeTaskId = `archive-intake-${digest.slice(0, 32)}`;
  const store = await FileChildTaskStore.create(
    join(plan.intake.task.directory, 'archive-child-tasks'),
  );
  const past = new Date(Date.now() - 300_000);
  await store.create({
    taskId: intakeTaskId,
    runId: `archive-${digest.slice(0, 32)}`,
    revision: digest,
    dependsOn: [],
    actor: 'old-worker',
    now: past,
  });
  await store.claim({
    taskId: intakeTaskId,
    owner: 'old-worker',
    leaseMs: 120_000,
    now: new Date(past.getTime() + 1000),
  });
  await publishJson(
    join(plan.intake.task.directory, `archive-job-intake-${digest}.json`),
    {
      schema: 1,
      kind: 'temari-archive-job-stage',
      specSha256: digest,
      stage: 'intake',
      status: 'BLOCKED',
      evidencePaths: [specPath],
      summary: 'Archive intake blocked; no search grant was created.',
    },
  );
  const refused = await tickArchiveJobs(specPath);
  assert.equal(refused.intake, 'FAILED');
  assert.equal(refused.search, 'QUEUED');
});

test('precreated attempt-limit BLOCKED receipt cannot stop the first intake claim', async () => {
  const plan = await fixture();
  const specPath = await createArchiveJobSpec(plan);
  const digest = hash(canonical(await readJson(specPath)));
  await publishJson(
    join(plan.intake.task.directory, `archive-job-intake-${digest}.json`),
    {
      schema: 1,
      kind: 'temari-archive-job-stage',
      specSha256: digest,
      stage: 'intake',
      status: 'BLOCKED',
      evidencePaths: [specPath],
      summary:
        'Attempt limit reached without a durable stage result; manual review required.',
    },
  );
  const result = await tickArchiveJobs(specPath);
  assert.equal(result.intake, 'FAILED');
  assert.equal(result.status, 'FAILED');
  const store = await FileChildTaskStore.create(
    join(plan.intake.task.directory, 'archive-child-tasks'),
  );
  assert.equal((await store.load(result.intakeTaskId))?.attempt, 1);
});
