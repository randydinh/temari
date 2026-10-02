/** Internal verification shared by pre-trial and post-trial child admission. */
import assert from 'node:assert/strict';
import { lstat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { ArchivePublication } from './archive-intake.js';
import { createArchiveGraphReader, type ArchiveGraphRecord } from './archive-graph.js';
import { readAllGraphRecords } from './archive-graph-impact.js';
import { extractReviewedArchiveDocumentLink } from './archive-document-links.js';
import type { ArchiveReviewedGraphChangeReceipt } from './archive-graph-reviewed-change.js';
import { canonical, digest, hash, object, text } from './codec.js';
import { readJsonWithBytes } from './durable.js';

export async function verifyReviewedArchiveGraphChild(input: {
  receiptPath: string;
  rootGraphId: string;
  revisionSetId: string;
  publication: ArchivePublication;
  pin: { publicationPath: string; publicationSha256: string };
  parentRecords: readonly ArchiveGraphRecord[];
}) {
  const { publication, pin, parentRecords } = input;
  const saved = await readJsonWithBytes(input.receiptPath);
  const review = saved.value as ArchiveReviewedGraphChangeReceipt;
  const sha256 = hash(saved.bytes);
  assert.equal(saved.bytes.toString('utf8'), canonical(review));
  assert.equal(basename(input.receiptPath), `archive-graph-reviewed-change-${sha256}.json`);
  assert.equal(dirname(input.receiptPath), publication.task.directory);
  assert.deepEqual(Object.keys(review).sort(), [
    'schema', 'kind', 'policy', 'parentGraphId', 'graphId', 'revisionSetId',
    'reviewerRef', 'reason', 'retractedAssertionIds', 'addedAssertionId',
    'draftSha256', 'publicationPins', 'currentOriginal', 'reviewerAuthenticated',
  ].sort());
  assert.equal(review.schema, 1);
  assert.equal(review.kind, 'temari-archive-reviewed-graph-change');
  assert.equal(review.policy, 'operator-selected-exact-archived-markdown-link-v1');
  assert.equal(review.currentOriginal, 'not-checked');
  assert.equal(review.reviewerAuthenticated, false);
  assert(text(review.reviewerRef).trim() && review.reviewerRef.length <= 256);
  assert(text(review.reason).trim() && review.reason.length <= 1024);
  assert.equal(review.parentGraphId, input.rootGraphId, 'Child parent must be the reviewed fresh root');
  assert.equal(review.revisionSetId, input.revisionSetId, 'Child RevisionSet must match fresh root');
  digest(review.graphId);
  digest(review.draftSha256);
  assert.notEqual(review.graphId, input.rootGraphId);
  assert.equal(review.graphId, review.draftSha256, 'Child graph must bind exact draft');
  assert.equal(canonical(review.publicationPins), canonical([{
    path: pin.publicationPath, sha256: pin.publicationSha256,
    sourceId: publication.source.id, generation: publication.generation,
    manifestSha256: publication.manifestSha256,
  }]), 'Child requires exactly the fresh root publication pin');
  const draftPath = join(publication.task.directory,
    `archive-graph-reviewed-draft-${review.draftSha256}.json`);
  const draftSaved = await readJsonWithBytes(draftPath, 524_288);
  assert.equal(draftSaved.bytes.toString('utf8'), canonical(draftSaved.value));
  assert.equal(hash(draftSaved.bytes), review.draftSha256, 'Child draft pin changed');
  assert.equal((await lstat(draftPath)).mode & 0o077, 0, 'Child draft must remain private');
  const draft = object(draftSaved.value);
  assert.deepEqual(Object.keys(draft).sort(), ['assertions', 'nodes', 'parent', 'revision_set', 'schema']);
  assert.equal(draft['schema'], 1);
  assert.equal(draft['parent'], input.rootGraphId);
  assert.equal(canonical(draft['revision_set']), canonical({ schema: 1, selections: [{
    source_id: publication.source.id, generation: publication.generation,
    manifest_sha256: publication.manifestSha256,
  }] }));
  assert(Array.isArray(draft['nodes']) && Array.isArray(draft['assertions']));
  const draftRecords = [...draft['nodes'], ...draft['assertions']] as ArchiveGraphRecord[];
  const retract = review.retractedAssertionIds;
  assert(Array.isArray(retract) && retract.length <= 100);
  assert.deepEqual(retract, [...new Set(retract)].sort());
  for (const id of retract) {
    assert(/^[a-f0-9]{32}$/.test(id));
    const prior = parentRecords.find((r) => r.id === id);
    assert(prior && (prior.kind === 'relationship' || prior.kind === 'identity-link') &&
      prior.lifecycle !== 'retracted', 'Retraction requires an active parent assertion');
  }
  const expected = parentRecords.map((r) => retract.includes(r.id)
    ? { ...r, lifecycle: 'retracted' as const } : r);
  assert(retract.length > 0 || review.addedAssertionId !== null, 'No-op child refused');
  if (review.addedAssertionId !== null) {
    assert(/^[a-f0-9]{32}$/.test(review.addedAssertionId));
    assert(!parentRecords.some((r) => r.id === review.addedAssertionId));
    const added = draftRecords.find((r) => r.id === review.addedAssertionId);
    assert(added && added.kind === 'relationship' && added.support?.length === 2,
      'Declared link must be present with exact evidence');
    // Draft evidence is only a selector. The producer's deterministic extractor
    // independently opens both endpoints in the exact archived publication.
    const [source, target] = added.support;
    const link = await extractReviewedArchiveDocumentLink({
      publicationPath: pin.publicationPath,
      sourcePath: source.path, targetPath: target.path,
      codePointOffset: source.text_start, allowedPaths: [source.path, target.path],
    });
    assert.equal(canonical(added), canonical(link.assertion), 'Added assertion differs from archived Markdown link');
    for (const node of link.nodes) {
      const prior = expected.find((r) => r.id === node.id);
      if (prior) assert.equal(canonical(prior), canonical(node), 'Link node collision');
      else expected.push(node);
    }
    expected.push(link.assertion);
  }
  const sort = (records: readonly ArchiveGraphRecord[]) => [...records].sort((a, b) => a.id.localeCompare(b.id));
  const nodes = sort(expected.filter((r) => r.kind === 'entity' || r.kind === 'mention'));
  const assertions = sort(expected.filter((r) => r.kind === 'relationship' || r.kind === 'identity-link'));
  assert.equal(canonical(draft['nodes']), canonical(nodes), 'Unexpected child node delta');
  assert.equal(canonical(draft['assertions']), canonical(assertions), 'Unexpected child assertion delta');
  const reader = await createArchiveGraphReader({ publications: [pin.publicationPath], readScope: 'source-root' });
  const child = await readAllGraphRecords(reader, review.graphId, publication.source);
  assert.equal(child.revisionSetId, input.revisionSetId);
  assert.equal(canonical(child.records), canonical([...nodes, ...assertions]), 'Registrar child differs from reviewed draft');
  return { review, sha256 };
}
