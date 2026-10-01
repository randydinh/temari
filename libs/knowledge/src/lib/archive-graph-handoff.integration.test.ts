import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { actualFixture } from '../support/fixtures.js';
import { captureArchive, loadArchivePublication } from './archive-intake.js';
import { createArchiveGraphReader } from './archive-graph.js';
import { planArchiveGraphImpact } from './archive-graph-impact.js';
import { evaluateReviewedArchiveGraphRoot } from './archive-graph-handoff.js';
import { proposeArchiveGraphRepins } from './archive-graph-repin.js';
import { publishReviewedArchiveGraphRoot } from './archive-graph-republish.js';
import { canonical, hash } from './codec.js';

const exec = promisify(execFile);

test('ACTUAL ARCHIVE CLI: reviewed v2 root has an explicit pinned one-hop evaluation path', async () => {
  const f = await actualFixture();
  const workspace = join(f.base, 'state');
  const options = {
    task: {
      id: 'reviewed-v2-trial',
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
      ['-B', '-m', 'knowledge_agent.cli', 'archive', '--workspace', workspace, ...args],
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
  const old = await loadArchivePublication(before.publicationPath);
  const anchor = async (path: string) => {
    const r = await cli([
      'read', f.source.id, old.generation, path,
      '--manifest-sha256', old.manifestSha256,
      '--max-chars', '8',
    ]);
    const c = r.record.citations[0];
    return {
      source_id: f.source.id,
      generation: old.generation,
      manifest_sha256: old.manifestSha256,
      path,
      original_sha256: c.original_sha256,
      representation_sha256: c.representation_sha256,
      text_start: c.text_start,
      text_end: c.text_end,
      quote: c.quote,
      quote_sha256: hash(c.quote),
    };
  };
  const [plan, update, target] = await Promise.all([
    anchor('plan.txt'),
    anchor('update.txt'),
    anchor('dependency.txt'),
  ]);
  const id = (digit: string) => digit.repeat(32);
  const graphDraftPath = join(f.base, 'old-graph.json');
  await writeFile(graphDraftPath, JSON.stringify({
    schema: 1,
    revision_set: {
      schema: 1,
      selections: [{
        source_id: f.source.id,
        generation: old.generation,
        manifest_sha256: old.manifestSha256,
      }],
    },
    parent: null,
    nodes: [
      { id: id('1'), kind: 'mention', label: 'changed-plan', provenance: 'extracted', anchors: [plan] },
      { id: id('2'), kind: 'mention', label: 'lexical-seed', provenance: 'extracted', anchors: [update] },
      { id: id('3'), kind: 'mention', label: 'related-target', provenance: 'extracted', anchors: [target] },
    ],
    assertions: [
      {
        id: id('4'), kind: 'relationship', subject: id('2'),
        predicate: 'links-to', object: id('3'), support: [update],
        contrary: [], provenance: 'extracted', lifecycle: 'active', supersedes: [],
      },
      {
        id: id('5'), kind: 'relationship', subject: id('2'),
        predicate: 'links-to', object: id('1'), support: [update, plan],
        contrary: [], provenance: 'extracted', lifecycle: 'active', supersedes: [],
      },
    ],
  }));
  const v1 = await cli(['graph-publish', graphDraftPath]);
  assert.equal(v1.status, 'complete');
  await writeFile(join(f.base, 'sources/plan.txt'), 'Changed plan in v2.');
  const after = await captureArchive({ ...options, requestKey: 'after' });
  assert(after.publicationPath);
  const impact = await planArchiveGraphImpact({
    beforePublicationPath: before.publicationPath,
    afterPublicationPath: after.publicationPath,
    beforeGraphId: v1.graph_id,
  });
  assert(impact.receipt.needsReview.some((item) => item.recordId === id('1')));
  assert(impact.receipt.needsReview.some((item) => item.recordId === id('5')));
  const proposal = await proposeArchiveGraphRepins({ impactReceiptPath: impact.receiptPath });
  assert.deepEqual(proposal.receipt.eligible.map((item) => item.recordId), [
    id('2'), id('3'), id('4'),
  ]);
  const reviewed = await publishReviewedArchiveGraphRoot({
    proposalReceiptPath: proposal.receiptPath,
    acceptedRecordIds: [id('2'), id('3'), id('4')],
    reviewerRef: 'synthetic-operator',
    reason: 'Retain only the unchanged anchored path for this diagnostic.',
  });
  const afterReader = await createArchiveGraphReader({
    publications: [after.publicationPath],
    readScope: 'source-root',
  });
  const red = await afterReader.read({
    graphId: v1.graph_id,
    scope: [f.source],
    limit: 1,
    maxBytes: 65536,
    cursor: null,
  });
  assert.equal(red.ok, false, 'Old v1 graph must gap in the exact v2 context');
  const input = {
    reviewReceiptPath: reviewed.receiptPath,
    caseId: 'one-hop-after-recapture',
    query: 'Proposal update',
    lexical: [{
      sourceId: f.source.id,
      path: 'update.txt',
      sha256: update.original_sha256,
    }],
    expected: [{ sourceId: f.source.id, path: 'dependency.txt' }],
    topK: 2,
  };
  const result = await evaluateReviewedArchiveGraphRoot(input);
  assert.equal(result.trial.status, 'complete');
  assert.equal(result.trial.expectedRecallAtK, 1);
  assert.equal(result.trial.verifiedEvidenceCount, 1);
  assert.equal(result.trial.gaps.length, 0);
  assert.deepEqual(result.trial.added.map((item) => item.path), ['dependency.txt']);
  assert.deepEqual(result.trial.added.map((item) => item.provenance), ['extracted']);
  assert(!result.trial.ranked.some((item) => item.path === 'plan.txt'));
  assert.equal(result.receipt.graphId, reviewed.graphId);
  assert.equal(result.receipt.revisionSetId, reviewed.receipt.afterRevisionSetId);
  assert.equal(result.receipt.graphMutation, 'none');
  assert.equal(result.receipt.bm25Lift, 'not-measured');
  assert.equal(result.receipt.goldCoverage, 'not-checked');
  assert.equal(result.receipt.trialGapCount, 0);
  assert.equal(result.receipt.targetReadAttempts, 1);
  assert.equal(result.receipt.semanticCorrectness, 'not-verified');
  assert.equal(result.receipt.lexicalBasis, 'operator-supplied-v2-verified');
  assert.equal(result.receipt.trialCheckpointSha256?.length, 64);
  const receiptText = await readFile(result.receiptPath, 'utf8');
  assert(!receiptText.includes(update.quote));
  assert(!receiptText.includes(target.quote));
  assert(!receiptText.includes(input.query));
  assert.equal(result.receipt.lexicalSha256, hash(canonical(input.lexical)));

  await assert.rejects(
    evaluateReviewedArchiveGraphRoot({
      ...input,
      lexical: [{ ...input.lexical[0], sha256: '0'.repeat(64) }],
    }),
    /Lexical candidate is unavailable|Expected|SHA|sha256/i,
  );
  const savedReview = await readFile(reviewed.receiptPath, 'utf8');
  await writeFile(
    reviewed.receiptPath,
    savedReview.replace('not-verified', 'verified'),
  );
  await assert.rejects(evaluateReviewedArchiveGraphRoot(input));
  await writeFile(reviewed.receiptPath, savedReview);

  await exec(f.config.python, [
    '-B', '-c',
    "import sqlite3,sys,json; db=sqlite3.connect(sys.argv[1]); row=json.loads(db.execute('SELECT data FROM sources WHERE id=?',(sys.argv[2],)).fetchone()[0]); row['enabled']=False; db.execute('UPDATE sources SET data=? WHERE id=?',(json.dumps(row),sys.argv[2])); db.commit()",
    join(workspace, 'registry.sqlite3'),
    f.source.id,
  ]);
  await assert.rejects(evaluateReviewedArchiveGraphRoot(input));
});
