import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, lstat, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { actualFixture } from '../support/fixtures.js';
import { captureArchive, loadArchivePublication } from './archive-intake.js';
import { createArchiveGraphReader } from './archive-graph.js';
import { planArchiveGraphImpact } from './archive-graph-impact.js';
import { evaluateReviewedArchiveGraphChild, evaluateReviewedArchiveGraphRoot } from './archive-graph-handoff.js';
import { proposeArchiveGraphRepins } from './archive-graph-repin.js';
import { publishReviewedArchiveGraphRoot } from './archive-graph-republish.js';
import { publishReviewedArchiveGraphChange, type ArchiveReviewedGraphChangeReceipt } from './archive-graph-reviewed-change.js';
import { publishJson } from './durable.js';
import { canonical, hash } from './codec.js';

const exec = promisify(execFile);

test('ACTUAL ARCHIVE CLI: reviewed v2 root and changed-link child have receipt-pinned evaluations', async () => {
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
  await writeFile(join(f.base, 'sources/changed.md'), '# Before\nNo link yet.\n');
  await writeFile(join(f.base, 'sources/new-target.md'), '# New target\nRetained evidence.\n');
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
  const changedMarkdown = '# After 😀\n[New target](new-target.md)\n';
  await writeFile(join(f.base, 'sources/changed.md'), changedMarkdown);
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

  const child = await publishReviewedArchiveGraphChange({
    publications: [after.publicationPath], parentGraphId: reviewed.graphId,
    reviewerRef: 'synthetic-operator', reason: 'Review the new archived Markdown link.',
    retractAssertionIds: [reviewed.receipt.recordMapping.find((r) => r.beforeRecordId === id('4'))!.afterRecordId],
    addLink: {
      publicationPath: after.publicationPath, sourcePath: 'changed.md',
      targetPath: 'new-target.md',
      codePointOffset: Array.from(changedMarkdown.split('[')[0]).length,
      allowedPaths: ['changed.md', 'new-target.md'],
    },
  });
  const childInput = {
    ...input, childReviewReceiptPath: child.receiptPath,
    lexical: [{ sourceId: f.source.id, path: 'changed.md', sha256: hash(changedMarkdown) }],
    expected: [{ sourceId: f.source.id, path: 'new-target.md' }],
  };
  const { childReviewReceiptPath: _, ...rootInput } = childInput;
  const rootTrial = await evaluateReviewedArchiveGraphRoot(rootInput);
  const childResult = await evaluateReviewedArchiveGraphChild(childInput);
  assert.equal(rootTrial.trial.expectedRecallAtK, 0);
  assert.equal(rootTrial.trial.status, 'complete');
  assert.deepEqual(rootTrial.trial.added, []);
  assert.equal(childResult.trial.expectedRecallAtK, 1);
  assert.equal(childResult.trial.status, 'complete');
  assert.equal(childResult.trial.verifiedEvidenceCount, 1);
  assert.deepEqual(childResult.trial.added.map((r) => r.path), ['new-target.md']);
  assert.equal(childResult.receipt.topK, rootTrial.receipt.topK);
  assert.equal(childResult.receipt.lexicalSha256, rootTrial.receipt.lexicalSha256);
  assert.equal(childResult.receipt.graphId, child.graphId);
  assert.equal(childResult.receipt.rootGraphId, reviewed.graphId);
  assert.equal(childResult.receipt.retractedAssertionCount, 1);
  assert.equal(childResult.receipt.addedAssertionCount, 1);
  assert.equal(childResult.receipt.bm25Lift, 'not-measured');
  assert.equal(childResult.receipt.semanticCorrectness, 'not-verified');
  assert.equal(childResult.receipt.reviewerAuthenticated, false);
  assert.equal(childResult.receipt.operationalQueryChanged, false);
  assert.equal((await lstat(child.draftPath)).mode & 0o077, 0);
  const childSummary = await readFile(childResult.receiptPath, 'utf8');
  for (const privateText of [input.query, changedMarkdown, '[New target](new-target.md)',
    'Retained evidence.', 'Review the new archived Markdown link.']) {
    assert(!childSummary.includes(privateText));
  }
  const childReview = JSON.parse(await readFile(child.receiptPath, 'utf8')) as ArchiveReviewedGraphChangeReceipt;
  const alteredReceipt = async (change: Record<string, unknown>) => {
    const receipt = { ...childReview, ...change };
    const path = join(options.task.directory, `archive-graph-reviewed-change-${hash(canonical(receipt))}.json`);
    await publishJson(path, receipt);
    return { ...childInput, childReviewReceiptPath: path };
  };
  for (const change of [
    { kind: 'arbitrary-child-review' },
    { policy: 'unverified-link' },
    { reviewerAuthenticated: true },
    { parentGraphId: v1.graph_id },
    { revisionSetId: '0'.repeat(64) },
    { graphId: reviewed.graphId },
    { publicationPins: [] },
    { publicationPins: [...childReview.publicationPins, ...childReview.publicationPins] },
    { publicationPins: [{ ...childReview.publicationPins[0], generation: old.generation }] },
    { publicationPins: [{ ...childReview.publicationPins[0], sha256: '0'.repeat(64) }] },
    { retractedAssertionIds: [] },
    { addedAssertionId: null },
  ]) await assert.rejects(evaluateReviewedArchiveGraphChild(await alteredReceipt(change)));
  await assert.rejects(evaluateReviewedArchiveGraphChild({ ...childInput,
    lexical: [{ ...childInput.lexical[0], sha256: '0'.repeat(64) }] }));
  const originalChildReceipt = await readFile(child.receiptPath, 'utf8');
  await writeFile(child.receiptPath, originalChildReceipt + ' ');
  await assert.rejects(evaluateReviewedArchiveGraphChild(childInput));
  await writeFile(child.receiptPath, originalChildReceipt);
  const originalRootDraft = await readFile(reviewed.receipt.draftPath, 'utf8');
  await writeFile(reviewed.receipt.draftPath, originalRootDraft + ' ');
  await assert.rejects(evaluateReviewedArchiveGraphChild(childInput));
  await writeFile(reviewed.receipt.draftPath, originalRootDraft);
  const originalDraft = await readFile(child.draftPath, 'utf8');
  await writeFile(child.draftPath, originalDraft + ' ');
  await assert.rejects(evaluateReviewedArchiveGraphChild(childInput));
  await writeFile(child.draftPath, originalDraft);
  await chmod(child.draftPath, 0o644);
  await assert.rejects(evaluateReviewedArchiveGraphChild(childInput), /private/);
  await chmod(child.draftPath, 0o600);
  await writeFile(reviewed.receiptPath, savedReview + ' ');
  await assert.rejects(evaluateReviewedArchiveGraphChild(childInput));
  await writeFile(reviewed.receiptPath, savedReview);

  // Valid Registrar graphs and recomputed receipt/draft filenames are not enough:
  // the entire delta must equal the declared retractions and re-extracted link.
  const forgedDraft = JSON.parse(originalDraft);
  forgedDraft.nodes.push({ ...forgedDraft.nodes[0], id: 'f'.repeat(32) });
  forgedDraft.nodes.sort((a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id));
  const forgedPath = join(options.task.directory,
    `archive-graph-reviewed-draft-${hash(canonical(forgedDraft))}.json`);
  await publishJson(forgedPath, forgedDraft);
  const forgedGraph = await cli(['graph-publish', forgedPath]);
  assert.equal(forgedGraph.status, 'complete');
  await assert.rejects(evaluateReviewedArchiveGraphChild(await alteredReceipt({
    graphId: forgedGraph.graph_id, draftSha256: hash(canonical(forgedDraft)),
  })), /Unexpected child node delta/);
  const falseLinkDraft = JSON.parse(originalDraft);
  const falseLink = falseLinkDraft.assertions.find((r: { id: string }) => r.id === child.addedAssertionId);
  falseLink.predicate = 'depends-on';
  falseLink.id = 'e'.repeat(32);
  falseLinkDraft.assertions.sort((a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id));
  const falseLinkPath = join(options.task.directory,
    `archive-graph-reviewed-draft-${hash(canonical(falseLinkDraft))}.json`);
  await publishJson(falseLinkPath, falseLinkDraft);
  const falseLinkGraph = await cli(['graph-publish', falseLinkPath]);
  assert.equal(falseLinkGraph.status, 'complete');
  assert.equal(falseLinkGraph.graph_id, hash(canonical(falseLinkDraft)));
  await assert.rejects(evaluateReviewedArchiveGraphChild(await alteredReceipt({
    graphId: falseLinkGraph.graph_id, draftSha256: hash(canonical(falseLinkDraft)),
    addedAssertionId: falseLink.id,
  })), /differs from archived Markdown link/);

  await exec(f.config.python, [
    '-B', '-c',
    "import sqlite3,sys,json; db=sqlite3.connect(sys.argv[1]); row=json.loads(db.execute('SELECT data FROM sources WHERE id=?',(sys.argv[2],)).fetchone()[0]); row['enabled']=False; db.execute('UPDATE sources SET data=? WHERE id=?',(json.dumps(row),sys.argv[2])); db.commit()",
    join(workspace, 'registry.sqlite3'),
    f.source.id,
  ]);
  await assert.rejects(evaluateReviewedArchiveGraphRoot(input));
  await assert.rejects(evaluateReviewedArchiveGraphChild(childInput));
});
