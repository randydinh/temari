import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { actualFixture } from '../support/fixtures.js';
import { captureArchive, loadArchivePublication } from './archive-intake.js';
import {
  createArchiveGraphReader,
  retractArchiveGraph,
} from './archive-graph.js';
import { planArchiveGraphImpact } from './archive-graph-impact.js';
import { proposeArchiveGraphRepins } from './archive-graph-repin.js';
import {
  ArchiveGraphRepublishError,
  publishReviewedArchiveGraphRoot,
} from './archive-graph-republish.js';
import { canonical, hash } from './codec.js';

const exec = promisify(execFile);

test('ACTUAL ARCHIVE CLI: republish explicit review creates a bounded fresh v2 root with external mapping', async () => {
  const f = await actualFixture();
  const workspace = join(f.base, 'state');
  const options = {
    task: {
      id: 'fresh-root-test',
      directory: join(f.base, 'task'),
      authorityRef: 'synthetic-admission',
    },
    source: f.source,
    readScope: 'source-root' as const,
    transport: {
      python: f.config.python,
      registrarSource: f.config.registrarSource,
      workspace,
    },
    requestKey: 'before',
  };
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
  const oldPublication = await loadArchivePublication(before.publicationPath);
  const anchor = async (path: string) => {
    const response = await cli([
      'read',
      f.source.id,
      oldPublication.generation,
      path,
      '--manifest-sha256',
      oldPublication.manifestSha256,
      '--max-chars',
      '8',
    ]);
    const citation = response.record.citations[0];
    return {
      source_id: f.source.id,
      generation: oldPublication.generation,
      manifest_sha256: oldPublication.manifestSha256,
      path,
      original_sha256: citation.original_sha256,
      representation_sha256: citation.representation_sha256,
      text_start: citation.text_start,
      text_end: citation.text_end,
      quote: citation.quote,
      quote_sha256: hash(citation.quote),
    };
  };
  const [plan, update, dependency] = await Promise.all([
    anchor('plan.txt'),
    anchor('update.txt'),
    anchor('dependency.txt'),
  ]);
  const id = (digit: string) => digit.repeat(32);
  const batch = join(f.base, 'before-root.json');
  await writeFile(
    batch,
    JSON.stringify({
      schema: 1,
      revision_set: {
        schema: 1,
        selections: [
          {
            source_id: f.source.id,
            generation: oldPublication.generation,
            manifest_sha256: oldPublication.manifestSha256,
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
          id: id('6'),
          kind: 'relationship',
          subject: id('2'),
          predicate: 'references',
          object: id('3'),
          support: [update],
          contrary: [],
          provenance: 'inferred',
          lifecycle: 'active',
          supersedes: [],
        },
        {
          id: id('7'),
          kind: 'relationship',
          subject: id('2'),
          predicate: 'references',
          object: id('3'),
          support: [update],
          contrary: [],
          provenance: 'inferred',
          lifecycle: 'supersedes',
          supersedes: [id('6')],
        },
      ],
    }),
  );
  const graph = await cli(['graph-publish', batch]);
  assert.equal(graph.status, 'complete');
  const retired = await retractArchiveGraph({
    publications: [before.publicationPath],
    graphId: graph.graph_id,
    assertionIds: [id('6')],
    reviewerRef: 'synthetic-operator',
    reason: 'Retired before v2',
  });
  await writeFile(join(f.base, 'sources/plan.txt'), 'Changed plan in v2.');
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
    id('7'),
  ]);
  assert(impact.receipt.needsReview.some((item) => item.recordId === id('1')));
  assert(impact.receipt.needsReview.some((item) => item.recordId === id('5')));
  assert.deepEqual(impact.receipt.historicalOnly, [id('6')]);
  const proposal = await proposeArchiveGraphRepins({
    impactReceiptPath: impact.receiptPath,
  });
  assert.deepEqual(
    proposal.receipt.eligible.map((item) => item.recordId),
    [id('2'), id('3'), id('4')],
  );
  assert.deepEqual(proposal.receipt.deferred, [
    { recordId: id('7'), reason: 'supersedes-requires-review' },
  ]);
  const review = {
    proposalReceiptPath: proposal.receiptPath,
    acceptedRecordIds: [id('4'), id('3'), id('2')],
    reviewerRef: 'synthetic-reviewer',
    reason:
      'I inspected exact retained v2 excerpts and accept this selected subset.',
  };
  await assert.rejects(
    publishReviewedArchiveGraphRoot({
      ...review,
      acceptedRecordIds: [id('4'), id('2')],
    }),
    /selected endpoint/,
  );
  await assert.rejects(
    publishReviewedArchiveGraphRoot({
      ...review,
      acceptedRecordIds: [id('1'), id('2')],
    }),
    /eligible repin/,
  );
  await assert.rejects(
    publishReviewedArchiveGraphRoot({
      ...review,
      acceptedRecordIds: [id('6'), id('2')],
    }),
    /eligible repin/,
  );
  await assert.rejects(
    publishReviewedArchiveGraphRoot({
      ...review,
      acceptedRecordIds: [id('2'), id('3'), id('7')],
    }),
    /eligible repin/,
  );
  await assert.rejects(
    publishReviewedArchiveGraphRoot({
      ...review,
      acceptedRecordIds: [id('2'), id('2')],
    }),
    /Duplicate review selection/,
  );

  const subset = await publishReviewedArchiveGraphRoot({
    ...review,
    acceptedRecordIds: [id('2')],
  });
  assert.deepEqual(subset.receipt.selectedRecordIds, [id('2')]);
  assert.deepEqual(subset.receipt.excluded.eligibleNotSelected, [
    id('3'),
    id('4'),
  ]);
  const subsetDraft = JSON.parse(
    await readFile(subset.receipt.draftPath, 'utf8'),
  );
  assert.equal(subsetDraft.nodes.length, 1);
  assert.equal(subsetDraft.assertions.length, 0);

  const result = await publishReviewedArchiveGraphRoot(review);
  assert.notEqual(result.graphId, retired.graphId);
  assert.equal(result.receipt.parent, null);
  assert.equal(result.receipt.currentOriginal, 'not-checked');
  assert.equal(result.receipt.semanticCorrectness, 'not-verified');
  assert.equal(result.receipt.reviewerAuthenticated, false);
  assert.equal(result.receipt.nativeLineage, 'none-external-mapping-only');
  assert.deepEqual(result.receipt.selectedRecordIds, [
    id('2'),
    id('3'),
    id('4'),
  ]);
  assert.deepEqual(
    result.receipt.excluded.needsReview,
    impact.receipt.needsReview,
  );
  assert.deepEqual(result.receipt.excluded.historicalOnly, [id('6')]);
  assert.equal(
    new Set(result.receipt.recordMapping.map((item) => item.afterRecordId))
      .size,
    3,
  );
  assert(
    result.receipt.recordMapping.every(
      (item) => item.beforeRecordId !== item.afterRecordId,
    ),
  );
  const receiptText = await readFile(result.receiptPath, 'utf8');
  assert(
    !receiptText.includes(update.quote) &&
      !receiptText.includes(dependency.quote),
  );
  const draftText = await readFile(result.receipt.draftPath, 'utf8');
  assert(draftText.includes(update.quote));
  const draft = JSON.parse(draftText);
  assert.equal(draft.parent, null);
  assert.equal(hash(canonical(draft)), result.graphId);
  assert.equal(draft.nodes.length, 2);
  assert.equal(draft.assertions.length, 1);
  assert.equal(draft.assertions[0].contrary.length, 1);
  const v2Reader = await createArchiveGraphReader({
    publications: [after.publicationPath],
    readScope: 'source-root',
  });
  const fresh = await v2Reader.read({
    graphId: result.graphId,
    scope: [f.source],
    limit: 10,
    maxBytes: 65536,
    cursor: null,
  });
  assert(fresh.ok);
  assert.equal(fresh.value.revisionSetId, result.receipt.afterRevisionSetId);
  assert.deepEqual(
    fresh.value.records.map((record) => record.id).sort(),
    result.receipt.recordMapping.map((item) => item.afterRecordId).sort(),
  );
  assert(
    !(
      await v2Reader.read({
        graphId: retired.graphId,
        scope: [f.source],
        limit: 1,
        maxBytes: 65536,
        cursor: null,
      })
    ).ok,
  );
  const v1Reader = await createArchiveGraphReader({
    publications: [before.publicationPath],
    readScope: 'source-root',
  });
  assert(
    (
      await v1Reader.read({
        graphId: retired.graphId,
        scope: [f.source],
        limit: 10,
        maxBytes: 65536,
        cursor: null,
      })
    ).ok,
  );
  const countGraphs = async () =>
    Number(
      (
        await exec(f.config.python, [
          '-B',
          '-c',
          "import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute('SELECT count(*) FROM graph_generations').fetchone()[0])",
          join(workspace, 'registry.sqlite3'),
        ])
      ).stdout.trim(),
    );
  const graphCount = await countGraphs();
  assert.equal(
    (await publishReviewedArchiveGraphRoot(review)).graphId,
    result.graphId,
  );
  assert.equal(await countGraphs(), graphCount);

  // A failed final receipt write must expose the already committed graph and be replayable.
  await writeFile(result.receiptPath, '{}');
  await assert.rejects(
    publishReviewedArchiveGraphRoot(review),
    (error: unknown) => {
      assert(error instanceof ArchiveGraphRepublishError);
      assert.equal(error.plannedGraphId, result.graphId);
      assert.match(error.message, /may already be committed/);
      return true;
    },
  );
  assert.equal(await countGraphs(), graphCount);
  await writeFile(result.receiptPath, receiptText);
  assert.equal(
    (await publishReviewedArchiveGraphRoot(review)).graphId,
    result.graphId,
  );

  const proposalText = await readFile(proposal.receiptPath, 'utf8');
  await writeFile(
    proposal.receiptPath,
    proposalText.replace('proposal-only', 'changed'),
  );
  await assert.rejects(publishReviewedArchiveGraphRoot(review));
  await writeFile(proposal.receiptPath, proposalText);
  const afterText = await readFile(after.publicationPath, 'utf8');
  const changedAfter = JSON.parse(afterText);
  changedAfter.manifestSha256 = '0'.repeat(64);
  await writeFile(after.publicationPath, canonical(changedAfter));
  await assert.rejects(publishReviewedArchiveGraphRoot(review));
  await writeFile(after.publicationPath, afterText);
  await exec(f.config.python, [
    '-B',
    '-c',
    "import sqlite3,sys,json; db=sqlite3.connect(sys.argv[1]); row=json.loads(db.execute('SELECT data FROM sources WHERE id=?',(sys.argv[2],)).fetchone()[0]); row['enabled']=False; db.execute('UPDATE sources SET data=? WHERE id=?',(json.dumps(row),sys.argv[2])); db.commit()",
    join(workspace, 'registry.sqlite3'),
    f.source.id,
  ]);
  await assert.rejects(publishReviewedArchiveGraphRoot(review));
});
