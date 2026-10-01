import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { actualFixture } from '../support/fixtures.js';
import { captureArchive, loadArchivePublication } from './archive-intake.js';
import {
  createArchiveGraphReader,
  retractArchiveGraph,
} from './archive-graph.js';
import { planArchiveGraphImpact } from './archive-graph-impact.js';
import { hash } from './codec.js';

const exec = promisify(execFile);

test('ACTUAL ARCHIVE CLI: graph impact distinguishes review, repin, and discovery without mutating history', async () => {
  const f = await actualFixture();
  const options = {
    task: {
      id: 'graph-impact-test',
      directory: join(f.base, 'task'),
      authorityRef: 'synthetic-explicit-admission',
    },
    source: f.source,
    readScope: 'source-root' as const,
    transport: {
      python: f.config.python,
      registrarSource: f.config.registrarSource,
      workspace: join(f.base, 'state'),
    },
    requestKey: 'before',
  };
  const before = await captureArchive(options);
  assert(before.publicationPath, await readFile(before.resultPath, 'utf8'));
  const publishedBefore = await loadArchivePublication(before.publicationPath);
  const cli = async (args: string[]) => {
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
        timeout: 60000,
        maxBuffer: 1_048_576,
      },
    );
    return JSON.parse(stdout);
  };
  const anchor = async (path: string) => {
    const read = await cli([
      'read',
      f.source.id,
      publishedBefore.generation,
      path,
      '--manifest-sha256',
      publishedBefore.manifestSha256,
      '--max-chars',
      '8',
    ]);
    const citation = read.record.citations[0];
    return {
      source_id: f.source.id,
      generation: publishedBefore.generation,
      manifest_sha256: publishedBefore.manifestSha256,
      path,
      original_sha256: citation.original_sha256,
      representation_sha256: citation.representation_sha256,
      text_start: citation.text_start,
      text_end: citation.text_end,
      quote: citation.quote,
      quote_sha256: hash(citation.quote),
    };
  };
  const [plan, update, owner, dependency] = await Promise.all([
    anchor('plan.txt'),
    anchor('update.txt'),
    anchor('owner.txt'),
    anchor('dependency.txt'),
  ]);
  const id = (n: number) => String(n).repeat(32);
  const retiredChangedId = 'a'.repeat(32);
  const graph = {
    schema: 1,
    revision_set: {
      schema: 1,
      selections: [
        {
          source_id: f.source.id,
          generation: publishedBefore.generation,
          manifest_sha256: publishedBefore.manifestSha256,
        },
      ],
    },
    parent: null,
    nodes: [
      {
        id: id(1),
        kind: 'mention',
        label: 'plan',
        provenance: 'extracted',
        anchors: [plan],
      },
      {
        id: id(2),
        kind: 'mention',
        label: 'update',
        provenance: 'extracted',
        anchors: [update],
      },
      {
        id: id(3),
        kind: 'mention',
        label: 'owner',
        provenance: 'extracted',
        anchors: [owner],
      },
      {
        id: id(4),
        kind: 'mention',
        label: 'dependency',
        provenance: 'extracted',
        anchors: [dependency],
      },
    ],
    assertions: [
      {
        id: id(5),
        kind: 'relationship',
        subject: id(1),
        predicate: 'links-to',
        object: id(2),
        support: [update],
        contrary: [],
        provenance: 'inferred',
        lifecycle: 'active',
        supersedes: [],
      },
      {
        id: id(6),
        kind: 'relationship',
        subject: id(2),
        predicate: 'contradicts',
        object: id(4),
        support: [update],
        contrary: [owner],
        provenance: 'inferred',
        lifecycle: 'active',
        supersedes: [],
      },
      {
        id: id(7),
        kind: 'relationship',
        subject: id(2),
        predicate: 'links-to',
        object: id(4),
        support: [update],
        contrary: [],
        provenance: 'inferred',
        lifecycle: 'active',
        supersedes: [],
      },
      {
        id: id(8),
        kind: 'relationship',
        subject: id(3),
        predicate: 'depends-on',
        object: id(4),
        support: [owner],
        contrary: [],
        provenance: 'inferred',
        lifecycle: 'active',
        supersedes: [],
      },
      {
        id: id(9),
        kind: 'relationship',
        subject: id(2),
        predicate: 'references',
        object: id(4),
        support: [update],
        contrary: [],
        provenance: 'inferred',
        lifecycle: 'active',
        supersedes: [],
      },
      {
        id: retiredChangedId,
        kind: 'relationship',
        subject: id(1),
        predicate: 'related-to',
        object: id(2),
        support: [plan],
        contrary: [],
        provenance: 'inferred',
        lifecycle: 'active',
        supersedes: [],
      },
    ],
  };
  const batch = join(f.base, 'graph-impact-before.json');
  await writeFile(batch, JSON.stringify(graph));
  const publishedGraph = await cli(['graph-publish', batch]);
  assert.equal(publishedGraph.status, 'complete');
  const retired = await retractArchiveGraph({
    publications: [before.publicationPath],
    graphId: publishedGraph.graph_id as string,
    assertionIds: [id(9), retiredChangedId],
    reviewerRef: 'synthetic-operator',
    reason: 'Retired before source recapture',
  });
  const beforeGraphId = retired.graphId;

  await writeFile(
    join(f.base, 'sources/plan.txt'),
    'New plan text after capture.',
  );
  await rm(join(f.base, 'sources/owner.txt'));
  await writeFile(join(f.base, 'sources/new.txt'), 'New document to discover.');
  const after = await captureArchive({ ...options, requestKey: 'after' });
  assert(after.publicationPath, await readFile(after.resultPath, 'utf8'));
  const input = {
    beforePublicationPath: before.publicationPath,
    afterPublicationPath: after.publicationPath,
    beforeGraphId,
  };
  const { receiptPath, receipt } = await planArchiveGraphImpact(input);
  assert.equal(receipt.status, 'plan-only');
  assert.equal(receipt.currentOriginal, 'not-checked');
  assert.equal(receipt.beforeGraphId, beforeGraphId);
  assert.deepEqual(
    receipt.needsReview.map((r) => r.recordId),
    [id(1), id(3), id(5), id(6), id(8)],
  );
  assert.deepEqual(receipt.needRepin, [id(2), id(4), id(7)]);
  assert.deepEqual(receipt.historicalOnly, [id(9), retiredChangedId]);
  assert.deepEqual(receipt.needDiscovery, [
    { path: 'new.txt', reason: 'added' },
    { path: 'plan.txt', reason: 'changed' },
  ]);
  assert.equal(
    receipt.needsReview.find((r) => r.recordId === id(5))?.reason,
    'dependent-endpoint',
  );
  assert.equal(
    receipt.needsReview.find((r) => r.recordId === id(6))?.reason,
    'changed-or-removed-anchor',
  );
  const saved = await readFile(receiptPath, 'utf8');
  assert(!saved.includes('New plan text') && !saved.includes('Proposal plan'));
  assert.equal((await planArchiveGraphImpact(input)).receiptPath, receiptPath);

  const oldReader = await createArchiveGraphReader({
    publications: [before.publicationPath],
    readScope: 'source-root',
  });
  const query = {
    graphId: beforeGraphId,
    scope: [f.source],
    limit: 20,
    maxBytes: 65536,
    cursor: null,
  };
  assert((await oldReader.read(query)).ok);
  const newReader = await createArchiveGraphReader({
    publications: [after.publicationPath],
    readScope: 'source-root',
  });
  assert(!(await newReader.read(query)).ok);

  const otherRoot = join(f.base, 'other-source');
  await mkdir(otherRoot);
  await writeFile(
    join(otherRoot, 'other.txt'),
    'Independent registered source.',
  );
  const { stdout: registered } = await exec(
    f.config.python,
    [
      '-B',
      '-m',
      'knowledge_agent.cli',
      'sources',
      '--workspace',
      join(f.base, 'state'),
      'add',
      otherRoot,
    ],
    {
      cwd: f.config.registrarSource,
      env: {
        PATH: '/usr/bin:/bin',
        PYTHONPATH: join(f.config.registrarSource, 'src'),
        PYTHONNOUSERSITE: '1',
        PYTHONDONTWRITEBYTECODE: '1',
      },
      timeout: 60000,
    },
  );
  const otherId = JSON.parse(registered).id as string;
  const otherTask = join(f.base, 'other-task');
  await mkdir(otherTask);
  const other = await captureArchive({
    ...options,
    task: { ...options.task, directory: otherTask },
    source: {
      provider: `temari-isolated-${otherId}`,
      id: otherId,
      locator: pathToFileURL(otherRoot).href,
    },
    requestKey: 'other',
  });
  assert(other.publicationPath);
  const otherPublication = await loadArchivePublication(other.publicationPath);
  const multiGraph = {
    ...graph,
    assertions: graph.assertions.filter(
      (assertion) =>
        assertion.id !== id(9) && assertion.id !== retiredChangedId,
    ),
    revision_set: {
      schema: 1,
      selections: [
        graph.revision_set.selections[0],
        {
          source_id: otherId,
          generation: otherPublication.generation,
          manifest_sha256: otherPublication.manifestSha256,
        },
      ].sort((a, b) => a.source_id.localeCompare(b.source_id)),
    },
  };
  const multiBatch = join(f.base, 'graph-impact-multi-source.json');
  await writeFile(multiBatch, JSON.stringify(multiGraph));
  const publishedMulti = await cli(['graph-publish', multiBatch]);
  assert.equal(publishedMulti.status, 'complete');
  await assert.rejects(
    planArchiveGraphImpact({
      ...input,
      beforeGraphId: publishedMulti.graph_id as string,
    }),
  );

  const originalAfter = await readFile(after.publicationPath, 'utf8');
  const tampered = JSON.parse(originalAfter);
  tampered.manifestSha256 = '0'.repeat(64);
  await writeFile(after.publicationPath, JSON.stringify(tampered));
  await assert.rejects(planArchiveGraphImpact(input));
  await writeFile(after.publicationPath, originalAfter);
  await exec(
    f.config.python,
    [
      '-B',
      '-c',
      "import sqlite3,sys,json; db=sqlite3.connect(sys.argv[1]); row=json.loads(db.execute('SELECT data FROM sources WHERE id=?',(sys.argv[2],)).fetchone()[0]); row['enabled']=False; db.execute('UPDATE sources SET data=? WHERE id=?',(json.dumps(row),sys.argv[2])); db.commit()",
      join(f.base, 'state/registry.sqlite3'),
      f.source.id,
    ],
    { timeout: 60000 },
  );
  await assert.rejects(planArchiveGraphImpact(input));
});
