import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { actualFixture } from '../support/fixtures.js';
import { prepareRegistrar } from '../support/prepare.js';
import { captureArchive, loadArchivePublication } from './archive-intake.js';
import {
  createArchiveGraphReader,
  retractArchiveGraph,
} from './archive-graph.js';
import { planArchiveGraphImpact } from './archive-graph-impact.js';
import { proposeArchiveGraphRepins } from './archive-graph-repin.js';
import { canonical, hash } from './codec.js';

const exec = promisify(execFile);

test('ACTUAL ARCHIVE CLI: v2 graph repin proposal verifies unchanged anchors and preserves review queues', async () => {
  const f = await actualFixture();
  const workspace = join(f.base, 'state');
  const task = {
    id: 'repin-test',
    directory: join(f.base, 'task'),
    authorityRef: 'synthetic-admission',
  };
  const options = {
    task,
    source: f.source,
    readScope: 'source-root' as const,
    transport: {
      python: f.config.python,
      registrarSource: f.config.registrarSource,
      workspace,
    },
    requestKey: 'before',
  };
  await writeFile(join(f.base, 'sources/long.txt'), 'L'.repeat(2300));
  const cli = async (args: string[]) => {
    const { stdout } = await exec(
      f.config.python,
      [
        '-B',
        '-m',
        'knowledge_agent.cli',
        'archive',
        '--workspace',
        workspace,
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
  const before = await captureArchive(options);
  assert(before.publicationPath);
  const pub = await loadArchivePublication(before.publicationPath);
  const anchor = async (path: string, maxChars = 8) => {
    const read = await cli([
      'read',
      f.source.id,
      pub.generation,
      path,
      '--manifest-sha256',
      pub.manifestSha256,
      '--max-chars',
      String(maxChars),
    ]);
    const citation = read.record.citations[0];
    return {
      source_id: f.source.id,
      generation: pub.generation,
      manifest_sha256: pub.manifestSha256,
      path,
      original_sha256: citation.original_sha256,
      representation_sha256: citation.representation_sha256,
      text_start: citation.text_start,
      text_end: citation.text_end,
      quote: citation.quote,
      quote_sha256: hash(citation.quote),
    };
  };
  const [plan, update, dependency, long] = await Promise.all([
    anchor('plan.txt'),
    anchor('update.txt'),
    anchor('dependency.txt'),
    anchor('long.txt', 2300),
  ]);
  const id = (digit: string) => digit.repeat(32);
  const batch = join(f.base, 'repin-before-graph.json');
  await writeFile(
    batch,
    JSON.stringify({
      schema: 1,
      revision_set: {
        schema: 1,
        selections: [
          {
            source_id: f.source.id,
            generation: pub.generation,
            manifest_sha256: pub.manifestSha256,
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
        {
          id: id('3'),
          kind: 'mention',
          label: 'dependency',
          provenance: 'extracted',
          anchors: [dependency],
        },
        {
          id: id('6'),
          kind: 'mention',
          label: 'long',
          provenance: 'extracted',
          anchors: [long],
        },
      ],
      assertions: [
        {
          id: id('4'),
          kind: 'relationship',
          subject: id('2'),
          predicate: 'links-to',
          object: id('3'),
          support: [update],
          contrary: [dependency],
          provenance: 'inferred',
          lifecycle: 'active',
          supersedes: [],
        },
        {
          id: id('5'),
          kind: 'relationship',
          subject: id('1'),
          predicate: 'links-to',
          object: id('2'),
          support: [plan],
          contrary: [],
          provenance: 'inferred',
          lifecycle: 'active',
          supersedes: [],
        },
        {
          id: id('7'),
          kind: 'relationship',
          subject: id('2'),
          predicate: 'links-to',
          object: id('6'),
          support: [update],
          contrary: [],
          provenance: 'inferred',
          lifecycle: 'active',
          supersedes: [],
        },
      ],
    }),
  );
  const graph = await cli(['graph-publish', batch]);
  assert.equal(graph.status, 'complete');
  const retired = await retractArchiveGraph({
    publications: [before.publicationPath],
    graphId: graph.graph_id,
    assertionIds: [id('5')],
    reviewerRef: 'synthetic-operator',
    reason: 'Historical assertion',
  });
  await writeFile(
    join(f.base, 'sources/plan.txt'),
    'Changed plan after v1 capture.',
  );
  const after = await captureArchive({ ...options, requestKey: 'after' });
  assert(after.publicationPath);
  const impact = await planArchiveGraphImpact({
    beforePublicationPath: before.publicationPath,
    afterPublicationPath: after.publicationPath,
    beforeGraphId: retired.graphId,
  });
  assert.deepEqual(impact.receipt.needRepin, [
    id('2'),
    id('3'),
    id('4'),
    id('6'),
    id('7'),
  ]);
  // The impact receipt names IDs; the proposal adds independently read v2 anchors.
  assert.equal(JSON.stringify(impact.receipt).includes('quoteSha256'), false);
  const { receiptPath, receipt } = await proposeArchiveGraphRepins({
    impactReceiptPath: impact.receiptPath,
  });
  assert.deepEqual(
    receipt.eligible.map((item) => item.recordId),
    [id('2'), id('3'), id('4')],
  );
  assert.deepEqual(receipt.deferred, [
    { recordId: id('6'), reason: 'anchor-span-exceeds-budget' },
    { recordId: id('7'), reason: 'endpoint-not-eligible' },
  ]);
  assert.deepEqual(receipt.needsReview, impact.receipt.needsReview);
  assert.deepEqual(receipt.historicalOnly, [id('5')]);
  assert.deepEqual(receipt.needDiscovery, impact.receipt.needDiscovery);
  assert.equal(receipt.graphMutation, 'none');
  assert.equal(receipt.afterGraphId, null);
  assert.equal(receipt.currentOriginal, 'not-checked');
  assert.equal(receipt.eligible[2].anchors.length, 2);
  assert.deepEqual(
    receipt.eligible[2].anchors.map((item) => item.role),
    ['support', 'contrary'],
  );
  assert.deepEqual(
    receipt.eligible[2].anchors.map((item) => item.index),
    [0, 0],
  );
  assert.equal(receipt.eligible[0].anchors[0].quoteSha256, update.quote_sha256);
  const saved = await readFile(receiptPath, 'utf8');
  assert(!saved.includes(update.quote) && !saved.includes(dependency.quote));
  assert.equal(
    (await proposeArchiveGraphRepins({ impactReceiptPath: impact.receiptPath }))
      .receiptPath,
    receiptPath,
  );
  const v2Graph = await createArchiveGraphReader({
    publications: [after.publicationPath],
    readScope: 'source-root',
  });
  assert.equal(
    (
      await v2Graph.read({
        graphId: retired.graphId,
        scope: [f.source],
        limit: 1,
        maxBytes: 65536,
        cursor: null,
      })
    ).ok,
    false,
  );

  const originalImpact = await readFile(impact.receiptPath, 'utf8');
  await writeFile(
    impact.receiptPath,
    originalImpact.replace('plan-only', 'changed'),
  );
  await assert.rejects(
    proposeArchiveGraphRepins({ impactReceiptPath: impact.receiptPath }),
  );
  await writeFile(impact.receiptPath, originalImpact);
  const originalAfter = await readFile(after.publicationPath, 'utf8');
  const changedAfter = JSON.parse(originalAfter);
  changedAfter.manifestSha256 = '0'.repeat(64);
  await writeFile(after.publicationPath, canonical(changedAfter));
  assert.equal(
    await readFile(after.publicationPath, 'utf8'),
    canonical(changedAfter),
  );
  await assert.rejects(
    proposeArchiveGraphRepins({ impactReceiptPath: impact.receiptPath }),
  );
  await writeFile(after.publicationPath, originalAfter);
  const afterPub = await loadArchivePublication(after.publicationPath);
  const bindingPath = join(
    task.directory,
    `archive-binding-${afterPub.binding}.json`,
  );
  const binding = await readFile(bindingPath);
  await rm(bindingPath);
  await assert.rejects(
    proposeArchiveGraphRepins({ impactReceiptPath: impact.receiptPath }),
  );
  await writeFile(bindingPath, binding);
  await exec(
    f.config.python,
    [
      '-B',
      '-c',
      "import sqlite3,sys,json; db=sqlite3.connect(sys.argv[1]); row=json.loads(db.execute('SELECT data FROM sources WHERE id=?',(sys.argv[2],)).fetchone()[0]); row['enabled']=False; db.execute('UPDATE sources SET data=? WHERE id=?',(json.dumps(row),sys.argv[2])); db.commit()",
      join(workspace, 'registry.sqlite3'),
      f.source.id,
    ],
    { timeout: 60000 },
  );
  await assert.rejects(
    proposeArchiveGraphRepins({ impactReceiptPath: impact.receiptPath }),
  );
});

test('ACTUAL ARCHIVE CLI: shortened pinned v2 read defers graph repin anchor', async () => {
  const registrarSource = process.env['TEMARI_REGISTRAR_SOURCE'];
  const python = process.env['TEMARI_REGISTRAR_PYTHON'];
  assert(registrarSource && python);
  const f = await prepareRegistrar({
    registrarSource,
    python,
    documents: [{ path: 'long.txt', bytes: Buffer.from('Q'.repeat(1800)) }],
  });
  const workspace = join(f.base, 'state');
  const options = {
    task: {
      id: 'short-read-test',
      directory: join(f.base, 'task'),
      authorityRef: 'synthetic-admission',
    },
    source: f.source,
    readScope: 'source-root' as const,
    transport: { python, registrarSource, workspace, maxStdoutBytes: 4096 },
    requestKey: 'before',
  };
  const cli = async (args: string[]) => {
    const { stdout } = await exec(
      python,
      [
        '-B',
        '-m',
        'knowledge_agent.cli',
        'archive',
        '--workspace',
        workspace,
        ...args,
      ],
      {
        cwd: registrarSource,
        env: {
          PATH: '/usr/bin:/bin',
          PYTHONPATH: join(registrarSource, 'src'),
          PYTHONNOUSERSITE: '1',
          PYTHONDONTWRITEBYTECODE: '1',
        },
        timeout: 60000,
        maxBuffer: 1_048_576,
      },
    );
    return JSON.parse(stdout);
  };
  const before = await captureArchive(options);
  assert(before.publicationPath);
  const pub = await loadArchivePublication(before.publicationPath);
  const full = await cli([
    'read',
    f.source.id,
    pub.generation,
    'long.txt',
    '--manifest-sha256',
    pub.manifestSha256,
    '--max-chars',
    '1800',
    '--max-bytes',
    '16000',
  ]);
  const citation = full.record.citations[0];
  assert.equal(citation.text_end - citation.text_start, 1800);
  const anchor = {
    source_id: f.source.id,
    generation: pub.generation,
    manifest_sha256: pub.manifestSha256,
    path: 'long.txt',
    original_sha256: citation.original_sha256,
    representation_sha256: citation.representation_sha256,
    text_start: citation.text_start,
    text_end: citation.text_end,
    quote: citation.quote,
    quote_sha256: hash(citation.quote),
  };
  const recordId = 'a'.repeat(32);
  const batch = join(f.base, 'short-read-graph.json');
  await writeFile(
    batch,
    JSON.stringify({
      schema: 1,
      revision_set: {
        schema: 1,
        selections: [
          {
            source_id: f.source.id,
            generation: pub.generation,
            manifest_sha256: pub.manifestSha256,
          },
        ],
      },
      parent: null,
      nodes: [
        {
          id: recordId,
          kind: 'mention',
          label: 'long',
          provenance: 'extracted',
          anchors: [anchor],
        },
      ],
      assertions: [],
    }),
  );
  const graph = await cli(['graph-publish', batch]);
  assert.equal(graph.status, 'complete');
  const after = await captureArchive({ ...options, requestKey: 'after' });
  assert(after.publicationPath);
  const afterPub = await loadArchivePublication(after.publicationPath);
  const bounded = await cli([
    'read',
    f.source.id,
    afterPub.generation,
    'long.txt',
    '--manifest-sha256',
    afterPub.manifestSha256,
    '--max-chars',
    '1800',
    '--max-bytes',
    '4096',
  ]);
  assert.equal(bounded.total_chars, 1800);
  assert(bounded.record.body.length > 0 && bounded.record.body.length < 1800);
  assert.equal(
    bounded.record.citations[0].text_end,
    bounded.record.body.length,
  );
  const impact = await planArchiveGraphImpact({
    beforePublicationPath: before.publicationPath,
    afterPublicationPath: after.publicationPath,
    beforeGraphId: graph.graph_id,
  });
  assert.deepEqual(impact.receipt.needRepin, [recordId]);
  const proposal = await proposeArchiveGraphRepins({
    impactReceiptPath: impact.receiptPath,
  });
  assert.deepEqual(proposal.receipt.eligible, []);
  assert.deepEqual(proposal.receipt.deferred, [
    { recordId, reason: 'v2-evidence-unavailable-or-mismatch' },
  ]);
  assert.equal(proposal.receipt.graphMutation, 'none');
  assert.equal(proposal.receipt.afterGraphId, null);
});
