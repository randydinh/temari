import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import {
  FileSourceHeadStore,
  sourceHeadDigest,
  type SourceHeadPin,
} from '@temari/runtime';
import { actualFixture } from '../support/fixtures.js';
import { captureArchive, loadArchivePublication } from './archive-intake.js';
import {
  createArchiveFreshnessJobSpec,
  loadCompletedArchiveFreshnessDecision,
  tickArchiveFreshnessJob,
} from './archive-freshness-job.js';
import { tickArchiveSourceCycle } from './archive-source-cycle.js';
import { hash } from './codec.js';
import { readJsonWithBytes } from './durable.js';

const exec = promisify(execFile);
const policy = 'one-shot-pinned-local-currentness-v1' as const;
const ledgerName = 'archive-source-head-ledger';

async function setup(limits?: { readonly entries: number }) {
  const f = await actualFixture();
  const captured = await captureArchive({
    task: {
      id: 'managed-cycle-test',
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
    requestKey: 'managed-before',
    ...(limits ? { limits } : {}),
  });
  assert(captured.publicationPath);
  return { f, before: captured.publicationPath };
}
async function due(publicationPath: string, offsetMs: number) {
  const path = await createArchiveFreshnessJobSpec({
    publicationPath,
    notBefore: new Date(Date.now() - offsetMs).toISOString(),
    policy,
  });
  const result = await tickArchiveFreshnessJob(path);
  assert(result.status === 'ISSUES' || result.status === 'SUCCEEDED');
  return { path, result };
}
async function generationCount(f: Awaited<ReturnType<typeof actualFixture>>) {
  const { stdout } = await exec(f.config.python, [
    '-B',
    '-c',
    "import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); print(db.execute('SELECT COUNT(*) FROM archive_generations').fetchone()[0])",
    join(f.base, 'state/registry.sqlite3'),
  ]);
  return Number(stdout.trim());
}
async function disable(f: Awaited<ReturnType<typeof actualFixture>>) {
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

async function graphFor(
  f: Awaited<ReturnType<typeof actualFixture>>,
  beforePath: string,
) {
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
  const plan = await anchor('plan.txt');
  const update = await anchor('update.txt');
  const id = (digit: string) => digit.repeat(32);
  const batchPath = join(f.base, 'managed-cycle-graph.json');
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

test('ACTUAL Registrar managed cycle: competing completed audits choose one capture, replay, then next head', async () => {
  const { f, before } = await setup();
  await writeFile(join(f.base, 'sources/plan.txt'), 'First managed edit.');
  const first = await due(before, 60_000);
  const competing = await due(before, 61_000);
  assert.equal(first.result.decision, 'recapture-needed');
  assert.equal(competing.result.decision, 'recapture-needed');
  const pair = await Promise.allSettled([
    tickArchiveSourceCycle({ freshnessSpecPath: first.path }),
    tickArchiveSourceCycle({ freshnessSpecPath: competing.path }),
  ]);
  assert.equal(pair.filter((item) => item.status === 'fulfilled').length, 1);
  const selected = pair[0].status === 'fulfilled' ? first.path : competing.path;
  let cycle = await tickArchiveSourceCycle({ freshnessSpecPath: selected });
  assert.equal(cycle.status, 'advanced');
  assert(cycle.status === 'advanced');
  assert.equal(cycle.graphImpactReceiptPath, null);
  assert.equal(await generationCount(f), 2);
  assert.equal(
    (await readdir(join(f.base, 'task'))).filter((name) =>
      name.startsWith('archive-attempt-'),
    ).length,
    2,
  );
  const v2 = cycle.afterPublicationPath;
  cycle = await tickArchiveSourceCycle({ freshnessSpecPath: selected });
  assert.equal(cycle.status, 'advanced');
  assert(cycle.status === 'advanced');
  assert.equal(cycle.afterPublicationPath, v2);
  assert.equal(await generationCount(f), 2);
  const rejected = selected === first.path ? competing.path : first.path;
  await assert.rejects(tickArchiveSourceCycle({ freshnessSpecPath: rejected }));
  assert.equal(await generationCount(f), 2);

  await writeFile(join(f.base, 'sources/plan.txt'), 'Second managed edit.');
  const second = await due(v2, 62_000);
  assert.equal(second.result.decision, 'recapture-needed');
  const v3 = await tickArchiveSourceCycle({ freshnessSpecPath: second.path });
  assert.equal(v3.status, 'advanced');
  assert.equal(await generationCount(f), 3);
  await assert.rejects(tickArchiveSourceCycle({ freshnessSpecPath: selected }));
  assert.equal(await generationCount(f), 3);
});

test('ACTUAL Registrar managed cycle: same-spec ticks retain one capture and pinned graph review', async () => {
  const { f, before } = await setup();
  const beforeGraphId = await graphFor(f, before);
  await writeFile(join(f.base, 'sources/plan.txt'), 'Changed linked plan.');
  const audit = await due(before, 60_000);
  assert.equal(audit.result.decision, 'recapture-needed');
  const request = { freshnessSpecPath: audit.path, beforeGraphId };
  const pair = await Promise.allSettled([
    tickArchiveSourceCycle(request),
    tickArchiveSourceCycle(request),
  ]);
  assert(
    pair.some((item) => item.status === 'fulfilled'),
    'One same-spec tick must make progress',
  );
  for (const item of pair)
    if (item.status === 'fulfilled')
      assert.notEqual(
        item.value.status,
        'held',
        'Active peer must not hold head',
      );
  const finished = await tickArchiveSourceCycle(request);
  assert.equal(finished.status, 'advanced');
  assert(finished.status === 'advanced');
  assert(finished.graphImpactReceiptPath);
  const impact = JSON.parse(
    (await readJsonWithBytes(finished.graphImpactReceiptPath)).bytes.toString(
      'utf8',
    ),
  ) as Record<string, unknown>;
  assert.equal(impact['kind'], 'temari-archive-graph-impact-plan');
  assert.equal(impact['status'], 'plan-only');
  assert.equal(impact['beforeGraphId'], beforeGraphId);
  assert.equal(await generationCount(f), 2);
  assert.equal(
    (await readdir(join(f.base, 'task'))).filter((name) =>
      name.startsWith('archive-attempt-'),
    ).length,
    2,
  );
  const head = await (
    await FileSourceHeadStore.create(join(f.base, 'task', ledgerName))
  ).load(f.source.id);
  assert.equal(head?.status, 'READY');
  assert.equal(
    head.head.publicationSha256,
    hash((await readJsonWithBytes(finished.afterPublicationPath)).bytes),
  );
  const replayed = await tickArchiveSourceCycle(request);
  assert.equal(replayed.status, 'advanced');
  assert.equal(await generationCount(f), 2);
});

test('ACTUAL Registrar managed cycle: unchanged, partial and custom policy do not reserve or capture', async () => {
  const unchanged = await setup();
  const unchangedAudit = await due(unchanged.before, 60_000);
  assert.equal(unchangedAudit.result.decision, 'unchanged');
  assert.deepEqual(
    await tickArchiveSourceCycle({ freshnessSpecPath: unchangedAudit.path }),
    { status: 'observed-unchanged', ledgerTouched: false },
  );
  await assert.rejects(stat(join(unchanged.f.base, 'task', ledgerName)), {
    code: 'ENOENT',
  });

  const partial = await setup();
  await writeFile(
    join(partial.f.base, 'sources/oversized.txt'),
    Buffer.alloc(8 * 1024 * 1024 + 1),
  );
  const partialAudit = await due(partial.before, 60_000);
  assert.equal(partialAudit.result.decision, 'unknown-needs-review');
  assert.deepEqual(
    await tickArchiveSourceCycle({ freshnessSpecPath: partialAudit.path }),
    { status: 'audit-needs-review', ledgerTouched: false },
  );
  await assert.rejects(stat(join(partial.f.base, 'task', ledgerName)), {
    code: 'ENOENT',
  });

  const custom = await setup({ entries: 10 });
  await writeFile(join(custom.f.base, 'sources/plan.txt'), 'Changed custom.');
  const customAudit = await due(custom.before, 60_000);
  assert.equal(customAudit.result.decision, 'recapture-needed');
  await assert.rejects(
    tickArchiveSourceCycle({ freshnessSpecPath: customAudit.path }),
    /Custom capture limits|settings cannot be silently dropped/,
  );
  assert.equal(await generationCount(custom.f), 1);
  await assert.rejects(stat(join(custom.f.base, 'task', ledgerName)), {
    code: 'ENOENT',
  });
});

test('ACTUAL Registrar managed cycle: revoked admission holds an existing reservation', async () => {
  const { f, before } = await setup();
  await writeFile(
    join(f.base, 'sources/plan.txt'),
    'Changed before revocation.',
  );
  const audit = await due(before, 60_000);
  assert.equal(audit.result.decision, 'recapture-needed');
  const decision = await loadCompletedArchiveFreshnessDecision(audit.path);
  const publication = await loadArchivePublication(before);
  const original = await readJsonWithBytes(before, 65536);
  const pin: SourceHeadPin = {
    sourceId: publication.source.id,
    sourceLocator: publication.source.locator,
    taskId: publication.task.id,
    taskDirectory: publication.task.directory,
    publicationPath: before,
    publicationSha256: hash(original.bytes),
    generation: publication.generation,
    manifestSha256: publication.manifestSha256,
    registrationSha256: sourceHeadDigest(publication.registration),
    captureRequestKey: publication.captureRequestKey,
  };
  const key = sourceHeadDigest({
    schema: 1,
    kind: 'temari-managed-source-cycle',
    freshnessSpecPath: decision.specPath,
    freshnessSpecSha256: decision.specSha256,
    freshnessStagePath: decision.stagePath,
    freshnessStageSha256: decision.stageSha256,
    prior: pin,
    beforeGraphId: null,
  });
  const store = await FileSourceHeadStore.create(
    join(f.base, 'task', ledgerName),
  );
  await store.initialize(pin);
  assert.equal((await store.reserve(pin, key)).status, 'RESERVED');
  await disable(f);
  await assert.rejects(
    tickArchiveSourceCycle({ freshnessSpecPath: audit.path }),
  );
  const held = await store.load(f.source.id);
  assert.equal(held?.status, 'HELD');
  assert(held.status === 'HELD');
  assert.equal(held.hold.reason, 'admission-changed');
  assert.equal(await generationCount(f), 1);
});
