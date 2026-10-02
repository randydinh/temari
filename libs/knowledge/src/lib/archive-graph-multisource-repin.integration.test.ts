import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { actualFixture } from '../support/fixtures.js';
import { captureArchive, loadArchivePublication } from './archive-intake.js';
import {
  createArchiveGraphReader,
  retractArchiveGraph,
} from './archive-graph.js';
import { planArchiveMultisourceGraphImpact } from './archive-graph-multisource-impact.js';
import { proposeArchiveMultisourceGraphRepins } from './archive-graph-multisource-repin.js';
import { canonical, hash } from './codec.js';

const exec = promisify(execFile);

test('ACTUAL ARCHIVE CLI: source-aware A v2/B v1 proposal partitions candidates without graph mutation', async () => {
  const f = await actualFixture();
  const workspace = join(f.base, 'state');
  const cli = async (domain: string, args: string[]) => {
    const { stdout } = await exec(
      f.config.python,
      [
        '-B',
        '-m',
        'knowledge_agent.cli',
        domain,
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
  const task = {
    id: 'multisource-repin-test',
    directory: join(f.base, 'task'),
    authorityRef: 'synthetic-local-only-admission',
  };
  const transport = {
    python: f.config.python,
    registrarSource: f.config.registrarSource,
    workspace,
  };
  assert.equal(
    (await cli('sources', ['set-sharing', f.source.id, 'local-only'])).sharing,
    'local-only',
  );
  const capture = async (source: typeof f.source, requestKey: string) => {
    const result = await captureArchive({
      task,
      source,
      readScope: 'source-root',
      transport,
      requestKey,
    });
    assert(result.publicationPath, await readFile(result.resultPath, 'utf8'));
    return {
      path: result.publicationPath,
      publication: await loadArchivePublication(result.publicationPath),
    };
  };
  const a1 = await capture(f.source, 'a-before');
  const bRoot = join(f.base, 'other-source');
  await mkdir(bRoot);
  await writeFile(join(bRoot, 'stable.txt'), 'B source stable evidence.');
  await writeFile(join(bRoot, 'long.txt'), 'Q'.repeat(2300));
  const registered = await cli('sources', ['add', bRoot]);
  assert.equal(
    (
      await cli('sources', [
        'set-sharing',
        registered.id as string,
        'local-only',
      ])
    ).sharing,
    'local-only',
  );
  const sourceB = {
    provider: `temari-isolated-${registered.id as string}`,
    id: registered.id as string,
    locator: pathToFileURL(bRoot).href,
  };
  const b1 = await capture(sourceB, 'b-before');
  const anchor = async (p: typeof a1, path: string, maxChars = 8) => {
    const read = await cli('archive', [
      'read',
      p.publication.source.id,
      p.publication.generation,
      path,
      '--manifest-sha256',
      p.publication.manifestSha256,
      '--max-chars',
      String(maxChars),
      '--max-bytes',
      '16000',
    ]);
    const citation = read.record.citations[0];
    return {
      source_id: p.publication.source.id,
      generation: p.publication.generation,
      manifest_sha256: p.publication.manifestSha256,
      path,
      original_sha256: citation.original_sha256,
      representation_sha256: citation.representation_sha256,
      text_start: citation.text_start,
      text_end: citation.text_end,
      quote: citation.quote,
      quote_sha256: hash(citation.quote),
    };
  };
  const [aChanged, aStable, bStable, bLong] = await Promise.all([
    anchor(a1, 'plan.txt'),
    anchor(a1, 'update.txt'),
    anchor(b1, 'stable.txt'),
    anchor(b1, 'long.txt', 2300),
  ]);
  const id = (digit: string) => digit.repeat(32);
  const selections = [a1.publication, b1.publication]
    .map((p) => ({
      source_id: p.source.id,
      generation: p.generation,
      manifest_sha256: p.manifestSha256,
    }))
    .sort((a, b) => a.source_id.localeCompare(b.source_id));
  const assertion = (
    recordId: string,
    subject: string,
    object: string,
    support: (typeof aChanged)[],
    lifecycle: 'active' | 'supersedes' = 'active',
    supersedes: string[] = [],
  ) => ({
    id: recordId,
    kind: 'relationship',
    subject,
    predicate: 'links-to',
    object,
    support,
    contrary: [],
    provenance: 'inferred',
    lifecycle,
    supersedes,
  });
  const graph = {
    schema: 1,
    revision_set: { schema: 1, selections },
    parent: null,
    nodes: [
      {
        id: id('1'),
        kind: 'mention',
        label: 'A changed',
        provenance: 'extracted',
        anchors: [aChanged],
      },
      {
        id: id('2'),
        kind: 'mention',
        label: 'A stable',
        provenance: 'extracted',
        anchors: [aStable],
      },
      {
        id: id('3'),
        kind: 'mention',
        label: 'B stable',
        provenance: 'extracted',
        anchors: [bStable],
      },
      {
        id: id('4'),
        kind: 'mention',
        label: 'B long',
        provenance: 'extracted',
        anchors: [bLong],
      },
    ],
    assertions: [
      assertion(id('5'), id('2'), id('3'), [aStable, bStable]),
      assertion(id('6'), id('3'), id('4'), [bStable]),
      assertion(id('7'), id('2'), id('3'), [bStable], 'supersedes', [id('8')]),
      assertion(id('8'), id('1'), id('3'), [aChanged]),
      assertion(id('9'), id('1'), id('3'), [aChanged]),
    ],
  };
  const batch = join(f.base, 'multisource-repin-before.json');
  await writeFile(batch, JSON.stringify(graph));
  const published = await cli('archive', ['graph-publish', batch]);
  assert.equal(published.status, 'complete');
  const retired = await retractArchiveGraph({
    publications: [a1.path, b1.path],
    graphId: published.graph_id as string,
    assertionIds: [id('9')],
    reviewerRef: 'synthetic-operator',
    reason: 'Retired before A recapture',
  });
  await writeFile(
    join(f.base, 'sources/plan.txt'),
    'Changed A plan after capture.',
  );
  const a2 = await capture(f.source, 'a-after');
  const impact = await planArchiveMultisourceGraphImpact({
    beforePublicationPaths: [b1.path, a1.path],
    afterPublicationPath: a2.path,
    changedSourceId: f.source.id,
    beforeGraphId: retired.graphId,
  });
  assert.deepEqual(impact.receipt.needRepin, [
    id('2'),
    id('3'),
    id('4'),
    id('5'),
    id('6'),
    id('7'),
  ]);
  const { receipt, receiptPath } = await proposeArchiveMultisourceGraphRepins({
    impactReceiptPath: impact.receiptPath,
  });
  assert.equal(receipt.status, 'proposal-only');
  assert.equal(receipt.graphMutation, 'none');
  assert.equal(receipt.afterGraphId, null);
  assert.equal(receipt.currentOriginal, 'not-checked');
  assert.deepEqual(
    receipt.eligible.map((item) => item.recordId),
    [id('2'), id('3'), id('5')],
  );
  assert.deepEqual(receipt.deferred, [
    { recordId: id('4'), reason: 'anchor-span-exceeds-budget' },
    { recordId: id('6'), reason: 'endpoint-not-eligible' },
    { recordId: id('7'), reason: 'supersedes-requires-review' },
  ]);
  assert.deepEqual(receipt.needsReview, impact.receipt.needsReview);
  assert.deepEqual(receipt.historicalOnly, [id('9')]);
  assert.deepEqual(receipt.needDiscovery, impact.receipt.needDiscovery);
  assert.equal(receipt.eligible[0].anchors[0].sourceId, f.source.id);
  assert.equal(
    receipt.eligible[0].anchors[0].afterGeneration,
    a2.publication.generation,
  );
  assert.equal(receipt.eligible[1].anchors[0].sourceId, sourceB.id);
  assert.equal(
    receipt.eligible[1].anchors[0].afterGeneration,
    b1.publication.generation,
  );
  assert.deepEqual(
    receipt.eligible[2].anchors.map((item) => item.sourceId),
    [f.source.id, sourceB.id],
  );
  const expectedNew = hash(
    canonical({
      schema: 1,
      selections: [a2.publication, b1.publication]
        .map((p) => ({
          source_id: p.source.id,
          generation: p.generation,
          manifest_sha256: p.manifestSha256,
        }))
        .sort((a, b) => a.source_id.localeCompare(b.source_id)),
    }),
  );
  assert.equal(receipt.expectedAfterRevisionSetId, expectedNew);
  const saved = await readFile(receiptPath, 'utf8');
  assert(!saved.includes(aStable.quote) && !saved.includes(bStable.quote));
  assert.equal(
    (
      await proposeArchiveMultisourceGraphRepins({
        impactReceiptPath: impact.receiptPath,
      })
    ).receiptPath,
    receiptPath,
  );
  const oldReader = await createArchiveGraphReader({
    publications: [a1.path, b1.path],
    readScope: 'source-root',
  });
  assert(
    (
      await oldReader.read({
        graphId: retired.graphId,
        scope: [f.source, sourceB],
        limit: 20,
        maxBytes: 65536,
        cursor: null,
      })
    ).ok,
  );
  const newReader = await createArchiveGraphReader({
    publications: [a2.path, b1.path],
    readScope: 'source-root',
  });
  assert(
    !(
      await newReader.read({
        graphId: retired.graphId,
        scope: [f.source, sourceB],
        limit: 20,
        maxBytes: 65536,
        cursor: null,
      })
    ).ok,
  );

  const originalImpact = await readFile(impact.receiptPath, 'utf8');
  await writeFile(
    impact.receiptPath,
    originalImpact.replace('plan-only', 'changed'),
  );
  await assert.rejects(
    proposeArchiveMultisourceGraphRepins({
      impactReceiptPath: impact.receiptPath,
    }),
  );
  await writeFile(impact.receiptPath, originalImpact);
  const originalB = await readFile(b1.path, 'utf8');
  await writeFile(
    b1.path,
    originalB.replace(b1.publication.manifestSha256, '0'.repeat(64)),
  );
  await assert.rejects(
    proposeArchiveMultisourceGraphRepins({
      impactReceiptPath: impact.receiptPath,
    }),
  );
  await writeFile(b1.path, originalB);
  await exec(
    f.config.python,
    [
      '-B',
      '-c',
      "import sqlite3,sys,json; db=sqlite3.connect(sys.argv[1]); row=json.loads(db.execute('SELECT data FROM sources WHERE id=?',(sys.argv[2],)).fetchone()[0]); row['enabled']=False; db.execute('UPDATE sources SET data=? WHERE id=?',(json.dumps(row),sys.argv[2])); db.commit()",
      join(workspace, 'registry.sqlite3'),
      sourceB.id,
    ],
    { timeout: 60000 },
  );
  await assert.rejects(
    proposeArchiveMultisourceGraphRepins({
      impactReceiptPath: impact.receiptPath,
    }),
  );
  await exec(
    f.config.python,
    [
      '-B',
      '-c',
      "import sqlite3,sys,json; db=sqlite3.connect(sys.argv[1]); row=json.loads(db.execute('SELECT data FROM sources WHERE id=?',(sys.argv[2],)).fetchone()[0]); row['enabled']=True; db.execute('UPDATE sources SET data=? WHERE id=?',(json.dumps(row),sys.argv[2])); db.commit()",
      join(workspace, 'registry.sqlite3'),
      sourceB.id,
    ],
    { timeout: 60000 },
  );
  await exec(
    f.config.python,
    [
      '-B',
      '-c',
      "import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute('UPDATE archive_blobs SET data=? WHERE sha256=?',(b'corrupt',sys.argv[2])); db.commit()",
      join(workspace, 'registry.sqlite3'),
      bStable.representation_sha256,
    ],
    { timeout: 60000 },
  );
  await assert.rejects(
    proposeArchiveMultisourceGraphRepins({
      impactReceiptPath: impact.receiptPath,
    }),
  );
});
