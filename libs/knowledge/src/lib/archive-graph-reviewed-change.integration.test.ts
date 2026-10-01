import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareRegistrar } from '../support/prepare.js';
import { publishArchiveDocumentLinks } from './archive-document-links.js';
import { publishReviewedArchiveGraphChange } from './archive-graph-reviewed-change.js';
import { createArchiveGraphReader } from './archive-graph.js';
import { runArchiveIntake } from './archive-journey.js';

async function fixture() {
  const python = process.env['TEMARI_REGISTRAR_PYTHON'];
  const registrarSource = process.env['TEMARI_REGISTRAR_SOURCE'];
  assert(python && registrarSource);
  const sourceText = '🔌 [first](b.md) and [second](c.md).\n' +
    '<div>\n\n[html-hidden](b.md)\n</div>\n' +
    '<div>intro\n[html-inline-open-hidden](b.md)\n</div>\n' +
    '<br>\n[valid-after-br](b.md)\n' +
    '>     [blockquote-code](b.md)\n';
  const f = await prepareRegistrar({ python, registrarSource, documents: [
    { path: 'a.md', bytes: Buffer.from(sourceText) },
    { path: 'b.md', bytes: Buffer.from('Original target.\n') },
    { path: 'c.md', bytes: Buffer.from('Reviewed target.\n') },
  ] });
  const task = { id: 'reviewed-graph', directory: join(f.base, 'task'),
    authorityRef: 'synthetic-operator-task' };
  const intake = await runArchiveIntake({ task, intakes: [{
    task, source: f.source, readScope: 'source-root', requestKey: 'v1',
    transport: { python, registrarSource, workspace: join(f.base, 'state') },
  }] });
  assert.equal(intake.status, 'published');
  const publicationPath = intake.outcomes[0].publicationPath;
  assert(publicationPath);
  const initial = await publishArchiveDocumentLinks({ publicationPath,
    paths: ['a.md', 'b.md'], maxEdges: 2 });
  assert(initial.graphId);
  assert.equal(initial.relationshipCount, 2);
  const reader = await createArchiveGraphReader({
    publications: [publicationPath], readScope: 'source-root',
  });
  const parent = await reader.read({ graphId: initial.graphId,
    scope: [f.source], limit: 200, maxBytes: 1_048_576, cursor: null });
  assert(parent.ok);
  const priorAssertion = parent.value.records.find((r) => r.kind === 'relationship');
  assert(priorAssertion);
  return { ...f, publicationPath, initial, reader, priorAssertion, sourceText };
}

function offset(body: string, phrase: string) {
  const start = body.indexOf(phrase);
  assert(start >= 0);
  return Array.from(body.slice(0, start)).length;
}

test('ACTUAL Registrar: reviewed child retains parent, retracts one assertion, and adds exact archived Markdown link', async () => {
  const f = await fixture();
  const review = { publications: [f.publicationPath], parentGraphId: f.initial.graphId!,
    reviewerRef: 'operator:fixture', reason: 'Reviewed relationship correction',
    retractAssertionIds: [f.priorAssertion.id], addLink: {
      publicationPath: f.publicationPath, sourcePath: 'a.md', targetPath: 'c.md',
      codePointOffset: offset(f.sourceText, '[second]'), allowedPaths: ['a.md', 'c.md'],
    } };
  const result = await publishReviewedArchiveGraphChange(review);
  assert(result.addedAssertionId);
  const parent = await f.reader.read({ graphId: f.initial.graphId!, scope: [f.source],
    limit: 200, maxBytes: 1_048_576, cursor: null });
  const child = await f.reader.read({ graphId: result.graphId, scope: [f.source],
    limit: 200, maxBytes: 1_048_576, cursor: null });
  assert(parent.ok && child.ok);
  assert.equal(parent.value.records.find((r) => r.id === f.priorAssertion.id)?.lifecycle, 'active');
  assert.equal(child.value.records.find((r) => r.id === f.priorAssertion.id)?.lifecycle, 'retracted');
  const added = child.value.records.find((r) => r.id === result.addedAssertionId);
  assert.equal(added?.predicate, 'links-to');
  assert.equal(added?.lifecycle, 'active');
  assert.equal(added.support?.length, 2);
  assert.equal(added.support?.[0].quote, '[second](c.md)');
  assert.equal(child.value.revisionSetId, parent.value.revisionSetId);
  const draftText = await readFile(result.draftPath, 'utf8');
  const draft = JSON.parse(draftText);
  assert.equal(draft.parent, f.initial.graphId);
  const receipt = JSON.parse(await readFile(result.receiptPath, 'utf8'));
  assert.equal(receipt.reviewerAuthenticated, false);
  assert.equal(receipt.addedAssertionId, result.addedAssertionId);
  assert.deepEqual(receipt.publicationPins.map((pin: {path: string}) => pin.path),
    [f.publicationPath]);
  assert.match(receipt.publicationPins[0].sha256, /^[0-9a-f]{64}$/);
  const replay = await publishReviewedArchiveGraphChange(review);
  assert.equal(replay.graphId, result.graphId);
  assert.equal(replay.receiptPath, result.receiptPath);
  await assert.rejects(() => publishReviewedArchiveGraphChange({ ...review,
    parentGraphId: result.graphId }), /already exists|active parent/i);
  await assert.rejects(() => publishReviewedArchiveGraphChange({
    publications: [f.publicationPath], parentGraphId: result.graphId,
    reviewerRef: 'operator:fixture', reason: 'Duplicate link', addLink: review.addLink,
  }), /already exists/i);
  const retractionOnly = await publishReviewedArchiveGraphChange({
    publications: [f.publicationPath], parentGraphId: f.initial.graphId!,
    reviewerRef: 'operator:fixture', reason: 'Retraction without addition',
    retractAssertionIds: [f.priorAssertion.id],
  });
  const retractPage = await f.reader.read({ graphId: retractionOnly.graphId,
    scope: [f.source], limit: 200, maxBytes: 1_048_576, cursor: null });
  assert(retractPage.ok);
  assert.equal(retractPage.value.records.find((r) => r.id === f.priorAssertion.id)?.lifecycle,
    'retracted');
  assert.equal(retractPage.value.records.filter((r) => r.kind === 'relationship').length, 2);
  await writeFile(result.draftPath, '{}');
  await assert.rejects(() => publishReviewedArchiveGraphChange(review));
  await writeFile(result.draftPath, draftText);
  await writeFile(result.receiptPath, '{}');
  await assert.rejects(() => publishReviewedArchiveGraphChange(review));
});

test('ACTUAL Registrar: rejected review cannot invent a link or expand selected source scope', async () => {
  const f = await fixture();
  const base = { publications: [f.publicationPath], parentGraphId: f.initial.graphId!,
    reviewerRef: 'operator:fixture', reason: 'Review', addLink: {
      publicationPath: f.publicationPath, sourcePath: 'a.md', targetPath: 'c.md',
      codePointOffset: offset(f.sourceText, '[second]'), allowedPaths: ['a.md', 'c.md'],
    } };
  await assert.rejects(() => publishReviewedArchiveGraphChange({ ...base,
    addLink: { ...base.addLink, codePointOffset: 21 } }), /exact visible inline Markdown link/i);
  for (const phrase of ['[html-hidden]', '[html-inline-open-hidden]', '[blockquote-code]']) {
    await assert.rejects(() => publishReviewedArchiveGraphChange({ ...base,
      addLink: { ...base.addLink, codePointOffset: offset(f.sourceText, phrase),
        targetPath: 'b.md', allowedPaths: ['a.md', 'b.md'] },
    }), /exact visible inline Markdown link/i);
  }
  await assert.rejects(() => publishReviewedArchiveGraphChange({ ...base,
    addLink: { ...base.addLink, targetPath: 'b.md', allowedPaths: ['a.md', 'b.md'] } }),
  /exact visible inline Markdown link/i);
  await assert.rejects(() => publishReviewedArchiveGraphChange({ ...base,
    addLink: { ...base.addLink, allowedPaths: ['a.md', 'b.md'] } }),
  /outside allowed paths/i);
  await assert.rejects(() => publishReviewedArchiveGraphChange({ ...base,
    addLink: { ...base.addLink, publicationPath: join(f.base, 'foreign.json') } }),
  /outside reviewed scope/i);
  await assert.rejects(() => publishReviewedArchiveGraphChange({
    publications: [f.publicationPath], parentGraphId: f.initial.graphId!,
    reviewerRef: 'operator:fixture', reason: 'No change',
  }), /No-op/i);
  await assert.rejects(() => publishReviewedArchiveGraphChange({
    publications: [f.publicationPath], parentGraphId: f.initial.graphId!,
    reviewerRef: 'operator:fixture', reason: 'Invalid retraction',
    retractAssertionIds: ['a'.repeat(32)],
  }), /active parent assertion/i);
  const publicationBytes = await readFile(f.publicationPath);
  await writeFile(f.publicationPath, '{}');
  await assert.rejects(() => publishReviewedArchiveGraphChange(base));
  await writeFile(f.publicationPath, publicationBytes);
});
