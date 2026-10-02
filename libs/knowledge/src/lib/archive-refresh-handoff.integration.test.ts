import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { FileChildTaskStore } from '@temari/runtime';
import { actualFixture } from '../support/fixtures.js';
import { captureArchive, loadArchivePublication } from './archive-intake.js';
import {
  createArchiveFreshnessJobSpec,
  tickArchiveFreshnessJob,
} from './archive-freshness-job.js';
import {
  createArchiveRefreshHandoffSpec,
  loadArchiveRefreshHandoffSpec,
  tickArchiveRefreshHandoff,
} from './archive-refresh-handoff.js';
import { canonical, hash } from './codec.js';
import { publishJson } from './durable.js';

const exec = promisify(execFile);
const policy = 'one-shot-pinned-local-currentness-v1' as const;

async function setup() {
  const f = await actualFixture();
  const captured = await captureArchive({
    task: {
      id: 'refresh-test',
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
    requestKey: 'refresh-before',
  });
  assert(captured.publicationPath);
  return { f, before: captured.publicationPath };
}

async function generations(
  f: Awaited<ReturnType<typeof actualFixture>>,
): Promise<number> {
  const { stdout } = await exec(f.config.python, [
    '-B',
    '-c',
    "import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); print(db.execute('SELECT COUNT(*) FROM archive_generations').fetchone()[0])",
    join(f.base, 'state/registry.sqlite3'),
  ]);
  return Number(stdout.trim());
}

async function due(before: string) {
  const path = await createArchiveFreshnessJobSpec({
    publicationPath: before,
    notBefore: new Date(Date.now() - 60_000).toISOString(),
    policy,
  });
  return { path, result: await tickArchiveFreshnessJob(path) };
}

async function graphFor(
  f: Awaited<ReturnType<typeof actualFixture>>,
  beforePath: string,
): Promise<string> {
  const before = await loadArchivePublication(beforePath);
  async function cli(args: string[]) {
    const { stdout } = await exec(
      f.config.python,
      [
        '-B',
        '-m',
        'knowledge_agent.cli',
        'archive',
        '--workspace',
        join(f.base, 'state'),
        ...args,
      ],
      {
        cwd: f.config.registrarSource,
        env: {
          PATH: '/usr/bin:/bin',
          PYTHONPATH: join(f.config.registrarSource, 'src'),
          PYTHONNOUSERSITE: '1',
          PYTHONDONTWRITEBYTECODE: '1',
        },
        maxBuffer: 1_048_576,
      },
    );
    return JSON.parse(stdout) as Record<string, unknown>;
  }
  async function anchor(path: string) {
    const read = await cli([
      'read',
      f.source.id,
      before.generation,
      path,
      '--manifest-sha256',
      before.manifestSha256,
      '--max-chars',
      '8',
    ]);
    const citation = (
      read['record'] as { citations: Array<Record<string, unknown>> }
    ).citations[0];
    return {
      source_id: f.source.id,
      generation: before.generation,
      manifest_sha256: before.manifestSha256,
      path,
      original_sha256: citation['original_sha256'],
      representation_sha256: citation['representation_sha256'],
      text_start: citation['text_start'],
      text_end: citation['text_end'],
      quote: citation['quote'],
      quote_sha256: hash(citation['quote'] as string),
    };
  }
  const plan = await anchor('plan.txt'),
    update = await anchor('update.txt');
  const id = (digit: string) => digit.repeat(32);
  const batchPath = join(f.base, 'refresh-graph.json');
  await writeFile(
    batchPath,
    JSON.stringify({
      schema: 1,
      revision_set: {
        schema: 1,
        selections: [
          {
            source_id: f.source.id,
            generation: before.generation,
            manifest_sha256: before.manifestSha256,
          },
        ],
      },
      parent: null,
      nodes: [
        {
          id: id('1'),
          kind: 'mention',
          label: 'plan',
          provenance: 'extracted',
          anchors: [plan],
        },
        {
          id: id('2'),
          kind: 'mention',
          label: 'update',
          provenance: 'extracted',
          anchors: [update],
        },
      ],
      assertions: [
        {
          id: id('3'),
          kind: 'relationship',
          subject: id('1'),
          predicate: 'links-to',
          object: id('2'),
          support: [update],
          contrary: [],
          provenance: 'inferred',
          lifecycle: 'active',
          supersedes: [],
        },
      ],
    }),
  );
  const published = await cli(['graph-publish', batchPath]);
  assert.equal(published['status'], 'complete');
  return published['graph_id'] as string;
}

test('ACTUAL Registrar refresh handoff: concurrent ticks capture one generation and preserve pinned review', async () => {
  const { f, before } = await setup();
  const beforeGraphId = await graphFor(f, before);
  await writeFile(
    join(f.base, 'sources/plan.txt'),
    'Changed plan private text.',
  );
  await writeFile(join(f.base, 'sources/new.txt'), 'Added private text.');
  await rm(join(f.base, 'sources/owner.txt'));
  const audit = await due(before);
  assert.equal(audit.result.decision, 'recapture-needed');
  const specPath = await createArchiveRefreshHandoffSpec({
    freshnessSpecPath: audit.path,
    beforeGraphId,
  });
  const pair = await Promise.all([
    tickArchiveRefreshHandoff(specPath, { owner: 'refresh-a' }),
    tickArchiveRefreshHandoff(specPath, { owner: 'refresh-b' }),
  ]);
  assert.equal(pair.filter((result) => result.action === 'capture').length, 1);
  const finished = await tickArchiveRefreshHandoff(specPath);
  assert.equal(finished.status, 'ISSUES');
  assert.equal(finished.action, 'none');
  assert(finished.stagePath && finished.handoffReceiptPath);
  const stage = JSON.parse(await readFile(finished.stagePath, 'utf8'));
  const handoff = JSON.parse(
    await readFile(finished.handoffReceiptPath, 'utf8'),
  );
  assert.equal(stage.graphMutation, 'none');
  assert.equal(handoff.graphMutation, 'none');
  assert.equal(handoff.graphImpact.beforeGraphId, beforeGraphId);
  assert.equal(stage.graphImpactReceiptPath, handoff.graphImpact.receiptPath);
  assert.deepEqual(handoff.graphImpact.counts, {
    needsReview: 2,
    needRepin: 1,
    historicalOnly: 0,
    needDiscovery: 2,
  });
  assert.deepEqual(handoff.diff.counts, {
    added: 1,
    removed: 1,
    changed: 1,
    unchanged: 2,
  });
  assert.notEqual(handoff.before.generation, handoff.after.generation);
  assert.equal(await generations(f), 2);
  assert.equal(
    (await readdir(join(f.base, 'task'))).filter((name) =>
      name.startsWith('archive-attempt-'),
    ).length,
    2,
  );
  assert.equal(
    (await loadArchivePublication(before)).generation,
    handoff.before.generation,
  );
  assert(
    !(await readFile(finished.stagePath, 'utf8')).includes(
      'Changed plan private text',
    ),
  );
  const conflicting = await createArchiveRefreshHandoffSpec({
    freshnessSpecPath: audit.path,
  });
  await assert.rejects(tickArchiveRefreshHandoff(conflicting));
  assert.equal(await generations(f), 2);
  await writeFile(
    finished.stagePath,
    canonical({ ...stage, handoffReceiptSha256: '0'.repeat(64) }),
  );
  await assert.rejects(tickArchiveRefreshHandoff(specPath));
  await writeFile(finished.stagePath, canonical(stage));
  const diff = JSON.parse(await readFile(handoff.diff.receiptPath, 'utf8'));
  await writeFile(
    handoff.diff.receiptPath,
    canonical({ ...diff, sourceId: 'tampered-source' }),
  );
  await assert.rejects(tickArchiveRefreshHandoff(specPath));
});

test('ACTUAL Registrar refresh handoff: unchanged, partial and revoked admission refuse recapture', async () => {
  const unchanged = await setup();
  const unchangedAudit = await due(unchanged.before);
  assert.equal(unchangedAudit.result.decision, 'unchanged');
  await assert.rejects(
    createArchiveRefreshHandoffSpec({ freshnessSpecPath: unchangedAudit.path }),
    /recapture-needed/,
  );
  assert.equal(await generations(unchanged.f), 1);

  const partial = await setup();
  await writeFile(
    join(partial.f.base, 'sources/oversized.txt'),
    Buffer.alloc(8 * 1024 * 1024 + 1),
  );
  const partialAudit = await due(partial.before);
  assert.equal(partialAudit.result.decision, 'unknown-needs-review');
  await assert.rejects(
    createArchiveRefreshHandoffSpec({ freshnessSpecPath: partialAudit.path }),
    /recapture-needed/,
  );
  assert.equal(await generations(partial.f), 1);

  const revoked = await setup();
  await writeFile(
    join(revoked.f.base, 'sources/plan.txt'),
    'Changed before revoked audit.',
  );
  const revokedAudit = await due(revoked.before);
  assert.equal(revokedAudit.result.decision, 'recapture-needed');
  const spec = await createArchiveRefreshHandoffSpec({
    freshnessSpecPath: revokedAudit.path,
  });
  await exec(
    revoked.f.config.python,
    [
      '-B',
      '-m',
      'knowledge_agent.cli',
      'sources',
      '--workspace',
      join(revoked.f.base, 'state'),
      'disable',
      revoked.f.source.id,
    ],
    {
      env: {
        PATH: '/usr/bin:/bin',
        PYTHONPATH: join(revoked.f.config.registrarSource, 'src'),
        PYTHONNOUSERSITE: '1',
        PYTHONDONTWRITEBYTECODE: '1',
      },
    },
  );
  await assert.rejects(tickArchiveRefreshHandoff(spec));
  assert.equal(await generations(revoked.f), 1);
  const original = await readFile(spec, 'utf8');
  await writeFile(
    spec,
    canonical({ ...JSON.parse(original), sourceId: 'tampered-source' }),
  );
  await assert.rejects(tickArchiveRefreshHandoff(spec));
});

test('ACTUAL Registrar refresh handoff: saved result resumes, missing result blocks without another capture', async () => {
  const resumable = await setup();
  await writeFile(
    join(resumable.f.base, 'sources/plan.txt'),
    'Changed before saved result.',
  );
  const resumableAudit = await due(resumable.before);
  const resumableSpecPath = await createArchiveRefreshHandoffSpec({
    freshnessSpecPath: resumableAudit.path,
  });
  const resumableSpec = await loadArchiveRefreshHandoffSpec(resumableSpecPath);
  const savedCapture = await captureArchive(resumableSpec.after);
  assert.equal(savedCapture.status, 'published');
  const resumed = await tickArchiveRefreshHandoff(resumableSpecPath);
  assert.equal(resumed.action, 'resume-result');
  assert.equal(resumed.status, 'ISSUES');
  assert.equal(await generations(resumable.f), 2);
  assert.equal(
    (await tickArchiveRefreshHandoff(resumableSpecPath)).action,
    'none',
  );

  const unknown = await setup();
  await writeFile(
    join(unknown.f.base, 'sources/plan.txt'),
    'Changed before missing result.',
  );
  const unknownAudit = await due(unknown.before);
  const unknownSpecPath = await createArchiveRefreshHandoffSpec({
    freshnessSpecPath: unknownAudit.path,
  });
  const unknownSpec = await loadArchiveRefreshHandoffSpec(unknownSpecPath);
  const committed = await captureArchive(unknownSpec.after);
  assert.equal(committed.status, 'published');
  await rm(committed.resultPath);
  await assert.rejects(
    tickArchiveRefreshHandoff(unknownSpecPath),
    /trusted publication pin/,
  );
  assert.equal(await generations(unknown.f), 2);
  assert.equal(
    (await readdir(join(unknown.f.base, 'task'))).filter((name) =>
      name.startsWith('archive-attempt-'),
    ).length,
    2,
  );
});

test('ACTUAL Registrar refresh handoff: expired capture-start lease cannot initiate a second capture', async () => {
  const { f, before } = await setup();
  await writeFile(
    join(f.base, 'sources/plan.txt'),
    'Changed before expired lease.',
  );
  const audit = await due(before);
  const specPath = await createArchiveRefreshHandoffSpec({
    freshnessSpecPath: audit.path,
  });
  const spec = await loadArchiveRefreshHandoffSpec(specPath);
  const revision = hash(canonical(spec));
  const taskId = `archive-refresh-${hash(canonical({ sourceId: spec.sourceId, beforePublicationSha256: spec.beforePublicationSha256 })).slice(0, 32)}`;
  const store = await FileChildTaskStore.create(
    join(f.base, 'task/archive-refresh-child-tasks'),
  );
  const oldTime = new Date(Date.now() - 3 * 60_000);
  await store.create({
    taskId,
    runId: taskId,
    revision,
    dependsOn: [],
    actor: 'expired-worker',
    now: oldTime,
  });
  const claim = await store.claim({
    taskId,
    owner: 'expired-worker',
    leaseMs: 120_000,
    now: oldTime,
  });
  assert(claim.claimed);
  await publishJson(
    join(f.base, 'task', `archive-refresh-start-${revision}.json`),
    {
      schema: 1,
      kind: 'temari-archive-refresh-capture-start',
      specSha256: revision,
      requestKey: spec.after.requestKey,
      owner: 'expired-worker',
      leaseToken: claim.record.lease?.token,
      fencingEpoch: claim.record.lease?.fencingEpoch,
      nonce: 'expired-marker-nonce',
    },
  );
  await assert.rejects(tickArchiveRefreshHandoff(specPath));
  assert.equal(await generations(f), 1);
  assert.equal(
    (await readdir(join(f.base, 'task'))).filter((name) =>
      name.startsWith('archive-attempt-'),
    ).length,
    1,
  );
});
