/** Operator-attributed, archive-verified edits to an immutable graph generation. */
import assert from 'node:assert/strict';
import { isAbsolute, join } from 'node:path';
import { canonical, digest, hash, integer, text } from './codec.js';
import { loadArchivePublication, type ArchivePublication } from './archive-intake.js';
import { archiveTransport } from './archive-transport.js';
import { createArchiveGraphReader, type ArchiveGraphRecord } from './archive-graph.js';
import { extractReviewedArchiveDocumentLink } from './archive-document-links.js';
import { publishJson, readJsonWithBytes } from './durable.js';

export interface ArchiveReviewedGraphChange {
  readonly publications: readonly string[];
  readonly parentGraphId: string;
  /** Operator attribution; this field does not authenticate the reviewer. */
  readonly reviewerRef: string;
  readonly reason: string;
  readonly retractAssertionIds?: readonly string[];
  readonly addLink?: {
    readonly publicationPath: string;
    readonly sourcePath: string;
    readonly targetPath: string;
    /** Unicode code-point position of '[' in the retained source text. */
    readonly codePointOffset: number;
    readonly allowedPaths: readonly string[];
  };
}

export interface ArchiveReviewedGraphChangeReceipt {
  readonly schema: 1;
  readonly kind: 'temari-archive-reviewed-graph-change';
  readonly policy: 'operator-selected-exact-archived-markdown-link-v1';
  readonly parentGraphId: string;
  readonly graphId: string;
  readonly revisionSetId: string;
  readonly reviewerRef: string;
  readonly reason: string;
  readonly retractedAssertionIds: readonly string[];
  readonly addedAssertionId: string | null;
  readonly draftSha256: string;
  readonly publicationPins: readonly {
    readonly path: string;
    readonly sha256: string;
    readonly sourceId: string;
    readonly generation: string;
    readonly manifestSha256: string;
  }[];
  readonly currentOriginal: 'not-checked';
  readonly reviewerAuthenticated: false;
}

function fields(value: object, allowed: readonly string[]) {
  assert.deepEqual(Object.keys(value).sort(), [...allowed].sort(), 'Unexpected review fields');
}
function id(value: unknown): string {
  const result = text(value);
  assert(/^[0-9a-f]{32}$/.test(result), 'Invalid assertion ID');
  return result;
}
function selections(publications: readonly ArchivePublication[]) {
  return publications.map((p) => ({
    source_id: p.source.id,
    generation: p.generation,
    manifest_sha256: p.manifestSha256,
  })).sort((a, b) => a.source_id.localeCompare(b.source_id));
}

async function pinnedPublication(path: string) {
  const bytes = await readJsonWithBytes(path);
  const publication = await loadArchivePublication(path);
  assert.equal(bytes.bytes.toString('utf8'), canonical(publication),
    'Publication bytes changed during validation');
  return { path, sha256: hash(bytes.bytes), publication };
}

async function allRecords(reader: Awaited<ReturnType<typeof createArchiveGraphReader>>,
  graphId: string, scope: readonly ArchivePublication[]) {
  const records: ArchiveGraphRecord[] = [];
  let cursor: string | null = null;
  let revisionSetId: string | null = null;
  do {
    const page = await reader.read({ graphId, scope: scope.map((p) => p.source),
      limit: 200, maxBytes: 1_048_576, cursor });
    assert(page.ok, 'Graph is outside selected admitted archive scope or failed integrity validation');
    revisionSetId ??= page.value.revisionSetId;
    assert.equal(page.value.revisionSetId, revisionSetId);
    assert.equal(page.value.offset, records.length, 'Graph page made discontinuous progress');
    records.push(...page.value.records);
    assert(records.length <= 1500, 'Graph record budget exceeded');
    cursor = page.value.next;
    if (cursor === null) assert.equal(records.length, page.value.totalRecords);
  } while (cursor !== null);
  assert(revisionSetId);
  assert.equal(new Set(records.map((r) => r.id)).size, records.length);
  return { records, revisionSetId };
}

/** Publish exactly one reviewed child. Parent remains an immutable readable snapshot. */
export async function publishReviewedArchiveGraphChange(review: ArchiveReviewedGraphChange) {
  const expected = ['publications', 'parentGraphId', 'reviewerRef', 'reason'];
  if (review.retractAssertionIds !== undefined) expected.push('retractAssertionIds');
  if (review.addLink !== undefined) expected.push('addLink');
  fields(review, expected);
  digest(review.parentGraphId);
  assert(Array.isArray(review.publications) && review.publications.length >= 1 &&
    review.publications.length <= 8, 'One to eight admitted publications required');
  assert(review.publications.every((path) => typeof path === 'string' && isAbsolute(path)));
  assert.equal(new Set(review.publications).size, review.publications.length);
  assert(review.reviewerRef.trim() && review.reviewerRef.length <= 256);
  assert(review.reason.trim() && review.reason.length <= 1024);
  const retractIds = (review.retractAssertionIds ?? []).map(id).sort();
  assert(retractIds.length <= 100 && new Set(retractIds).size === retractIds.length);
  assert(retractIds.length > 0 || review.addLink, 'No-op graph review refused');
  if (review.addLink) {
    fields(review.addLink, ['publicationPath', 'sourcePath', 'targetPath',
      'codePointOffset', 'allowedPaths']);
    integer(review.addLink.codePointOffset, 0, 65536);
    assert(review.publications.includes(review.addLink.publicationPath),
      'Link source publication outside reviewed scope');
  }
  const initialPins = await Promise.all(review.publications.map(pinnedPublication));
  const publications = initialPins.map((pin) => pin.publication);
  assert.equal(new Set(publications.map((p) => p.source.id)).size, publications.length);
  assert(publications.every((p) => canonical(p.transport) === canonical(publications[0].transport)),
    'One Registrar workspace required');
  assert(publications.every((p) => canonical(p.task) === canonical(publications[0].task)),
    'One durable review task required');
  const reader = await createArchiveGraphReader({
    publications: review.publications, readScope: 'source-root',
  });
  const parent = await allRecords(reader, review.parentGraphId, publications);
  const revisionSet = { schema: 1, selections: selections(publications) };
  assert.equal(parent.revisionSetId, hash(canonical(revisionSet)),
    'Parent graph has a stale or mismatched RevisionSet');
  const nodes = parent.records.filter((r) => r.kind === 'entity' || r.kind === 'mention');
  const assertions = parent.records.filter((r) => r.kind === 'relationship' || r.kind === 'identity-link')
    .map((r) => retractIds.includes(r.id) ? { ...r, lifecycle: 'retracted' as const } : r);
  for (const retractedId of retractIds) {
    const prior = parent.records.find((r) => r.id === retractedId);
    assert(prior && (prior.kind === 'relationship' || prior.kind === 'identity-link') &&
      prior.lifecycle !== 'retracted', 'Retraction requires an active parent assertion');
  }
  let addedAssertionId: string | null = null;
  if (review.addLink) {
    const link = await extractReviewedArchiveDocumentLink(review.addLink);
    const selected = publications.find((p) => p.source.id === link.source.id);
    assert(selected && selected.source.id === link.source.id &&
      selected.generation === link.nodes[0].anchors[0].generation &&
      selected.manifestSha256 === link.nodes[0].anchors[0].manifest_sha256,
    'Link source revision differs from selected graph RevisionSet');
    for (const node of link.nodes) {
      const prior = parent.records.find((r) => r.id === node.id);
      if (prior) assert.equal(canonical(prior), canonical(node),
        'Stable link node identity collision');
      else nodes.push(node);
    }
    assert(!parent.records.some((r) => r.id === link.assertion.id),
      'Link assertion already exists in parent; inactive IDs cannot be reused');
    assertions.push(link.assertion);
    addedAssertionId = link.assertion.id;
  }
  assert(nodes.length <= 500 && assertions.length <= 1000,
    'Registrar graph record budget exceeded');
  const draft = { schema: 1, revision_set: revisionSet, parent: review.parentGraphId,
    nodes: nodes.sort((a, b) => a.id.localeCompare(b.id)),
    assertions: assertions.sort((a, b) => a.id.localeCompare(b.id)) };
  const draftPath = join(publications[0].task.directory,
    `archive-graph-reviewed-draft-${hash(canonical(draft))}.json`);
  await publishJson(draftPath, draft);
  const transport = await archiveTransport(publications[0].transport);
  const published = await transport.invoke('graph-publish', [draftPath]);
  assert.equal(published['status'], 'complete');
  const graphId = digest(published['graph_id']);
  assert.equal(digest(published['revision_set_id']), parent.revisionSetId);
  assert.notEqual(graphId, review.parentGraphId);
  const child = await allRecords(reader, graphId, publications);
  assert.equal(child.revisionSetId, parent.revisionSetId);
  assert.equal(canonical(child.records), canonical([...draft.nodes, ...draft.assertions]),
    'Child records differ from reviewed draft');
  const finalPins = await Promise.all(review.publications.map(pinnedPublication));
  for (let index = 0; index < initialPins.length; index++) {
    assert.equal(finalPins[index].sha256, initialPins[index].sha256,
      'Publication bytes changed during graph review');
    assert.equal(canonical(finalPins[index].publication), canonical(publications[index]),
      'Publication changed during graph review');
  }
  const receipt: ArchiveReviewedGraphChangeReceipt = {
    schema: 1, kind: 'temari-archive-reviewed-graph-change',
    policy: 'operator-selected-exact-archived-markdown-link-v1',
    parentGraphId: review.parentGraphId, graphId,
    revisionSetId: child.revisionSetId, reviewerRef: review.reviewerRef,
    reason: review.reason, retractedAssertionIds: retractIds,
    addedAssertionId, draftSha256: hash(canonical(draft)),
    publicationPins: initialPins.map((pin) => ({ path: pin.path,
      sha256: pin.sha256, sourceId: pin.publication.source.id,
      generation: pin.publication.generation,
      manifestSha256: pin.publication.manifestSha256 })),
    currentOriginal: 'not-checked', reviewerAuthenticated: false,
  };
  const receiptPath = join(publications[0].task.directory,
    `archive-graph-reviewed-change-${hash(canonical(receipt))}.json`);
  await publishJson(receiptPath, receipt);
  return { graphId, draftPath, receiptPath, retractedAssertionIds: retractIds,
    addedAssertionId, revisionSetId: child.revisionSetId };
}
