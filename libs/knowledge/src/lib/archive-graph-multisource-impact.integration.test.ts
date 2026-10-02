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
import { planArchiveMultisourceGraphImpact } from './archive-graph-multisource-impact.js';
import { hash } from './codec.js';

const exec = promisify(execFile);

test('ACTUAL ARCHIVE CLI: one changed source in exact two-source graph yields bounded review candidates', async () => {
  const f = await actualFixture();
  const state = join(f.base, 'state');
  const cli = async (domain: string, args: string[]) => {
    const { stdout } = await exec(
      f.config.python,
      [
        '-B',
        '-m',
        'knowledge_agent.cli',
        domain,
        '--workspace',
        state,
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
  const transport = {
    python: f.config.python,
    registrarSource: f.config.registrarSource,
    workspace: state,
  };
  const task = {
    id: 'graph-multisource-impact-test',
    directory: join(f.base, 'task'),
    authorityRef: 'synthetic-explicit-admission',
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
  const otherRoot = join(f.base, 'other-source');
  await mkdir(otherRoot);
  await writeFile(
    join(otherRoot, 'stable.txt'),
    'Independent stable evidence.',
  );
  const registered = await cli('sources', ['add', otherRoot]);
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
    locator: pathToFileURL(otherRoot).href,
  };
  const b1 = await capture(sourceB, 'b-before');
  const anchor = async (p: typeof a1, path: string) => {
    const read = await cli('archive', [
      'read',
      p.publication.source.id,
      p.publication.generation,
      path,
      '--manifest-sha256',
      p.publication.manifestSha256,
      '--max-chars',
      '8',
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
  const [aChanged, aStable, bStable, aRemoved] = await Promise.all([
    anchor(a1, 'plan.txt'),
    anchor(a1, 'update.txt'),
    anchor(b1, 'stable.txt'),
    anchor(a1, 'owner.txt'),
  ]);
  const id = (char: string) => char.repeat(32);
  const selections = [a1.publication, b1.publication]
    .map((p) => ({
      source_id: p.source.id,
      generation: p.generation,
      manifest_sha256: p.manifestSha256,
    }))
    .sort((a, b) => a.source_id.localeCompare(b.source_id));
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
        id: id('8'),
        kind: 'mention',
        label: 'A removed',
        provenance: 'extracted',
        anchors: [aRemoved],
      },
    ],
    assertions: [
      {
        id: id('4'),
        kind: 'relationship',
        subject: id('1'),
        predicate: 'links-to',
        object: id('3'),
        support: [bStable],
        contrary: [],
        provenance: 'inferred',
        lifecycle: 'active',
        supersedes: [],
      },
      {
        id: id('5'),
        kind: 'relationship',
        subject: id('2'),
        predicate: 'links-to',
        object: id('3'),
        support: [aStable],
        contrary: [],
        provenance: 'inferred',
        lifecycle: 'active',
        supersedes: [],
      },
      {
        id: id('6'),
        kind: 'relationship',
        subject: id('1'),
        predicate: 'supports',
        object: id('3'),
        support: [aChanged],
        contrary: [],
        provenance: 'inferred',
        lifecycle: 'active',
        supersedes: [],
      },
      {
        id: id('7'),
        kind: 'relationship',
        subject: id('1'),
        predicate: 'contradicts',
        object: id('3'),
        support: [aChanged],
        contrary: [],
        provenance: 'inferred',
        lifecycle: 'active',
        supersedes: [],
      },
      {
        id: id('9'),
        kind: 'relationship',
        subject: id('8'),
        predicate: 'links-to',
        object: id('3'),
        support: [bStable],
        contrary: [],
        provenance: 'inferred',
        lifecycle: 'active',
        supersedes: [],
      },
    ],
  };
  const batchPath = join(f.base, 'graph-multisource.json');
  await writeFile(batchPath, JSON.stringify(graph));
  const published = await cli('archive', ['graph-publish', batchPath]);
  assert.equal(published.status, 'complete');
  const retired = await retractArchiveGraph({
    publications: [a1.path, b1.path],
    graphId: published.graph_id as string,
    assertionIds: [id('7')],
    reviewerRef: 'synthetic-operator',
    reason: 'Retired before recapture',
  });

  await writeFile(
    join(f.base, 'sources/plan.txt'),
    'Changed plan after capture.',
  );
  await writeFile(join(f.base, 'sources/new.txt'), 'New discovery path.');
  await rm(join(f.base, 'sources/owner.txt'));
  const a2 = await capture(f.source, 'a-after');
  const input = {
    beforePublicationPaths: [b1.path, a1.path],
    afterPublicationPath: a2.path,
    changedSourceId: f.source.id,
    beforeGraphId: retired.graphId,
  };
  const { receipt, receiptPath } =
    await planArchiveMultisourceGraphImpact(input);
  assert.equal(receipt.status, 'plan-only');
  assert.equal(receipt.graphMutation, 'none');
  assert.equal(receipt.currentOriginal, 'not-checked');
  assert.equal(receipt.before.length, 2);
  assert.deepEqual(receipt.needsReview, [
    { recordId: id('1'), reason: 'changed-or-removed-anchor' },
    { recordId: id('4'), reason: 'dependent-endpoint' },
    { recordId: id('6'), reason: 'changed-or-removed-anchor' },
    { recordId: id('8'), reason: 'changed-or-removed-anchor' },
    { recordId: id('9'), reason: 'dependent-endpoint' },
  ]);
  assert.deepEqual(receipt.needRepin, [id('2'), id('3'), id('5')]);
  assert.deepEqual(receipt.historicalOnly, [id('7')]);
  assert.deepEqual(receipt.needDiscovery, [
    { path: 'new.txt', reason: 'added' },
    { path: 'plan.txt', reason: 'changed' },
  ]);
  const saved = await readFile(receiptPath, 'utf8');
  assert(
    !saved.includes('Changed plan after capture.') &&
      !saved.includes('Independent stable evidence.'),
  );
  assert.equal(
    (await planArchiveMultisourceGraphImpact(input)).receiptPath,
    receiptPath,
  );
  const oldReader = await createArchiveGraphReader({
    publications: [a1.path, b1.path],
    readScope: 'source-root',
  });
  const oldRead = await oldReader.read({
    graphId: retired.graphId,
    scope: [f.source, sourceB],
    limit: 20,
    maxBytes: 65536,
    cursor: null,
  });
  assert(oldRead.ok);
  const wrongReader = await createArchiveGraphReader({
    publications: [a2.path, b1.path],
    readScope: 'source-root',
  });
  assert(
    !(
      await wrongReader.read({
        graphId: retired.graphId,
        scope: [f.source, sourceB],
        limit: 20,
        maxBytes: 65536,
        cursor: null,
      })
    ).ok,
  );
  await assert.rejects(
    planArchiveMultisourceGraphImpact({
      ...input,
      beforePublicationPaths: [a1.path],
    }),
  );
  await assert.rejects(
    planArchiveMultisourceGraphImpact({
      ...input,
      beforePublicationPaths: [a1.path, a1.path],
    }),
  );
  await assert.rejects(
    planArchiveMultisourceGraphImpact({
      ...input,
      beforePublicationPaths: Array(9).fill(a1.path),
    }),
  );
  await assert.rejects(
    planArchiveMultisourceGraphImpact({
      ...input,
      beforePublicationPaths: [a1.path, b1.path],
      changedSourceId: '0'.repeat(32),
    }),
  );
  const singleGraphPath = join(f.base, 'graph-single-source.json');
  await writeFile(
    singleGraphPath,
    JSON.stringify({
      ...graph,
      revision_set: {
        schema: 1,
        selections: [selections.find((s) => s.source_id === f.source.id)],
      },
      nodes: graph.nodes.slice(0, 2),
      assertions: [],
    }),
  );
  const singleGraph = await cli('archive', ['graph-publish', singleGraphPath]);
  assert.equal(singleGraph.status, 'complete');
  await assert.rejects(
    planArchiveMultisourceGraphImpact({
      ...input,
      beforeGraphId: singleGraph.graph_id as string,
    }),
  );
  await writeFile(join(otherRoot, 'stable.txt'), 'Later B generation.');
  const b2 = await capture(sourceB, 'b-after');
  await assert.rejects(
    planArchiveMultisourceGraphImpact({
      ...input,
      beforePublicationPaths: [a1.path, b2.path],
    }),
  );
  const originalB = await readFile(b1.path, 'utf8');
  await writeFile(
    b1.path,
    originalB.replace(b1.publication.manifestSha256, '0'.repeat(64)),
  );
  await assert.rejects(planArchiveMultisourceGraphImpact(input));
  await writeFile(b1.path, originalB);
  await exec(
    f.config.python,
    [
      '-B',
      '-c',
      "import sqlite3,sys,json; db=sqlite3.connect(sys.argv[1]); row=json.loads(db.execute('SELECT data FROM sources WHERE id=?',(sys.argv[2],)).fetchone()[0]); row['enabled']=False; db.execute('UPDATE sources SET data=? WHERE id=?',(json.dumps(row),sys.argv[2])); db.commit()",
      join(state, 'registry.sqlite3'),
      sourceB.id,
    ],
    { timeout: 60000 },
  );
  await assert.rejects(planArchiveMultisourceGraphImpact(input));
});
