/** Operator-attributed publication of a fresh v2 graph root from reviewed repins. */
import assert from 'node:assert/strict';
import { lstat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { canonical, digest, hash, list, object, text } from './codec.js';
import {
  loadArchivePublication,
  registrationFor,
  snapshot,
} from './archive-intake.js';
import {
  createArchiveGraphReader,
  type ArchiveGraphAnchor,
  type ArchiveGraphRecord,
} from './archive-graph.js';
import { readAllGraphRecords } from './archive-graph-impact.js';
import {
  proposeArchiveGraphRepins,
  type ArchiveGraphRepinAnchor,
  type ArchiveGraphRepinReceipt,
} from './archive-graph-repin.js';
import { archiveTransport } from './archive-transport.js';
import { publishJson, readJsonWithBytes } from './durable.js';

export interface ArchiveGraphRepublishReview {
  readonly proposalReceiptPath: string;
  readonly acceptedRecordIds: readonly string[];
  /** An operator-supplied attribution; this does not authenticate an identity. */
  readonly reviewerRef: string;
  readonly reason: string;
}

export interface ArchiveGraphRepublishReceipt {
  readonly schema: 1;
  readonly kind: 'temari-archive-graph-fresh-root-review';
  readonly policy: 'explicit-reviewed-v2-root-v1';
  readonly proposalReceiptPath: string;
  readonly proposalReceiptSha256: string;
  readonly beforeGraphId: string;
  readonly beforeRevisionSetId: string;
  readonly afterGraphId: string;
  readonly afterRevisionSetId: string;
  readonly before: ArchiveGraphRepinReceipt['before'];
  readonly after: ArchiveGraphRepinReceipt['after'];
  readonly parent: null;
  readonly selectedRecordIds: readonly string[];
  readonly recordMapping: readonly {
    readonly beforeRecordId: string;
    readonly afterRecordId: string;
  }[];
  readonly excluded: {
    readonly eligibleNotSelected: readonly string[];
    readonly deferred: ArchiveGraphRepinReceipt['deferred'];
    readonly needsReview: ArchiveGraphRepinReceipt['needsReview'];
    readonly historicalOnly: ArchiveGraphRepinReceipt['historicalOnly'];
    readonly needDiscovery: ArchiveGraphRepinReceipt['needDiscovery'];
  };
  readonly draftPath: string;
  readonly draftSha256: string;
  readonly reviewerRef: string;
  readonly reason: string;
  readonly reviewerAuthenticated: false;
  readonly currentOriginal: 'not-checked';
  readonly semanticCorrectness: 'not-verified';
  readonly nativeLineage: 'none-external-mapping-only';
}

export class ArchiveGraphRepublishError extends Error {
  constructor(
    readonly plannedGraphId: string,
    readonly draftPath: string,
    cause: unknown,
  ) {
    super(
      'Fresh v2 root may already be committed; replay the same deterministic review input to finalize.',
      { cause },
    );
  }
}

function recordId(value: unknown): string {
  const id = text(value);
  assert(/^[0-9a-f]{32}$/.test(id), 'Invalid graph record ID');
  return id;
}

function newRecordId(
  beforeGraphId: string,
  afterRevisionSetId: string,
  oldId: string,
): string {
  return hash(
    canonical({
      schema: 1,
      kind: 'temari-reviewed-v2-root-record-id',
      beforeGraphId,
      afterRevisionSetId,
      oldId,
    }),
  ).slice(0, 32);
}

function oldAnchorRefs(record: ArchiveGraphRecord): readonly {
  readonly role: ArchiveGraphRepinAnchor['role'];
  readonly index: number;
  readonly anchor: ArchiveGraphAnchor;
}[] {
  if (record.kind === 'entity' || record.kind === 'mention')
    return (record.anchors ?? []).map((anchor, index) => ({
      role: 'node',
      index,
      anchor,
    }));
  return [
    ...(record.support ?? []).map((anchor, index) => ({
      role: 'support' as const,
      index,
      anchor,
    })),
    ...(record.contrary ?? []).map((anchor, index) => ({
      role: 'contrary' as const,
      index,
      anchor,
    })),
  ];
}

async function exactPublication(pin: ArchiveGraphRepinReceipt['before']) {
  const { bytes } = await readJsonWithBytes(pin.publicationPath);
  const publication = await loadArchivePublication(pin.publicationPath);
  assert.equal(bytes.toString('utf8'), canonical(publication));
  assert.equal(hash(bytes), pin.publicationSha256, 'Publication pin changed');
  assert.equal(publication.generation, pin.generation);
  assert.equal(publication.manifestSha256, pin.manifestSha256);
  assert.equal(publication.preservation, 'complete-admitted');
  return publication;
}

async function readV2Anchor(
  old: ArchiveGraphAnchor,
  proposed: ArchiveGraphRepinAnchor,
  after: Awaited<ReturnType<typeof loadArchivePublication>>,
  transport: Awaited<ReturnType<typeof archiveTransport>>,
): Promise<ArchiveGraphAnchor> {
  assert.equal(proposed.path, old.path);
  assert.equal(proposed.originalSha256, old.original_sha256);
  assert.equal(proposed.beforeRepresentationSha256, old.representation_sha256);
  assert.equal(proposed.beforeStart, old.text_start);
  assert.equal(proposed.beforeEnd, old.text_end);
  assert.equal(proposed.afterStart, old.text_start);
  assert.equal(proposed.afterEnd, old.text_end);
  assert.equal(proposed.quoteSha256, old.quote_sha256);
  const span = old.text_end - old.text_start;
  assert(span >= 1 && span <= 2048, 'Selected anchor exceeds repin budget');
  const maxBytes = Math.min(transport.config.maxStdoutBytes, 65536);
  const r = await transport.invoke(
    'read',
    [
      after.source.id,
      after.generation,
      old.path,
      '--manifest-sha256',
      after.manifestSha256,
      '--offset',
      String(old.text_start),
      '--max-chars',
      String(span),
      '--max-bytes',
      String(maxBytes),
    ],
    maxBytes,
  );
  snapshot(r, after);
  assert.equal(r['path'], old.path);
  assert.equal(r['offset'], old.text_start);
  const representation = object(r['representation']);
  assert.equal(representation['coordinate_space'], 'unicode-codepoints');
  assert.equal(representation['original_sha256'], old.original_sha256);
  assert.equal(
    digest(representation['sha256']),
    proposed.afterRepresentationSha256,
  );
  const record = object(r['record']);
  const citations = list(record['citations']);
  assert.equal(citations.length, 1);
  const citation = object(citations[0]);
  assert.equal(citation['source_id'], after.source.id);
  assert.equal(citation['snapshot_generation'], after.generation);
  assert.equal(citation['manifest_sha256'], after.manifestSha256);
  assert.equal(citation['path'], old.path);
  assert.equal(citation['evidence'], 'archived-snapshot');
  assert.equal(citation['current_original'], 'not-checked');
  assert.equal(citation['coordinate_space'], 'unicode-codepoints');
  assert.equal(citation['original_sha256'], old.original_sha256);
  assert.equal(citation['sha256'], old.original_sha256);
  assert.equal(
    citation['representation_sha256'],
    proposed.afterRepresentationSha256,
  );
  assert.equal(citation['text_start'], old.text_start);
  assert.equal(citation['text_end'], old.text_end);
  const quote = text(citation['quote']);
  assert.equal(record['body'], quote);
  assert.equal(Array.from(quote).length, span, 'Selected v2 read shortened');
  assert.equal(quote, old.quote, 'Selected v2 quote changed');
  assert.equal(hash(quote), proposed.quoteSha256);
  return {
    source_id: after.source.id,
    generation: after.generation,
    manifest_sha256: after.manifestSha256,
    path: old.path,
    original_sha256: old.original_sha256,
    representation_sha256: proposed.afterRepresentationSha256,
    text_start: old.text_start,
    text_end: old.text_end,
    quote,
    quote_sha256: proposed.quoteSha256,
  };
}

/** Publish only explicitly reviewed eligible records as a new v2 root. */
export async function publishReviewedArchiveGraphRoot(
  review: ArchiveGraphRepublishReview,
): Promise<{
  readonly graphId: string;
  readonly receiptPath: string;
  readonly receipt: ArchiveGraphRepublishReceipt;
}> {
  assert.deepEqual(Object.keys(review).sort(), [
    'acceptedRecordIds',
    'proposalReceiptPath',
    'reason',
    'reviewerRef',
  ]);
  assert(isAbsolute(review.proposalReceiptPath));
  assert(Array.isArray(review.acceptedRecordIds));
  assert(
    review.acceptedRecordIds.length >= 1 &&
      review.acceptedRecordIds.length <= 64,
  );
  const accepted = review.acceptedRecordIds.map(recordId).sort();
  assert.equal(
    new Set(accepted).size,
    accepted.length,
    'Duplicate review selection',
  );
  assert(text(review.reviewerRef).trim() && review.reviewerRef.length <= 256);
  assert(text(review.reason).trim() && review.reason.length <= 1024);

  const saved = await readJsonWithBytes(review.proposalReceiptPath);
  const proposal = saved.value as ArchiveGraphRepinReceipt;
  assert.equal(saved.bytes.toString('utf8'), canonical(proposal));
  assert.equal(proposal.kind, 'temari-archive-graph-repin-proposal');
  assert.equal(proposal.status, 'proposal-only');
  const recalculated = await proposeArchiveGraphRepins({
    impactReceiptPath: proposal.impactReceiptPath,
  });
  assert.equal(recalculated.receiptPath, review.proposalReceiptPath);
  assert.equal(
    canonical(recalculated.receipt),
    canonical(proposal),
    'Repin proposal changed',
  );
  const [before, after] = await Promise.all([
    exactPublication(proposal.before),
    exactPublication(proposal.after),
  ]);
  assert.equal(before.source.id, proposal.sourceId);
  assert.equal(after.source.id, proposal.sourceId);
  const eligible = new Map(
    proposal.eligible.map((item) => [item.recordId, item]),
  );
  for (const id of accepted)
    assert(eligible.has(id), 'Selection is not an eligible repin record');
  const oldReader = await createArchiveGraphReader({
    publications: [proposal.before.publicationPath],
    readScope: 'source-root',
  });
  const old = await readAllGraphRecords(
    oldReader,
    proposal.beforeGraphId,
    before.source,
  );
  assert.equal(old.revisionSetId, proposal.beforeRevisionSetId);
  const prior = new Map(old.records.map((record) => [record.id, record]));
  const acceptedSet = new Set(accepted);
  const nodes = accepted
    .map((id) => prior.get(id)!)
    .filter((record) => record.kind === 'entity' || record.kind === 'mention');
  assert(nodes.length >= 1, 'A fresh graph root requires an accepted node');
  const assertions = accepted
    .map((id) => prior.get(id)!)
    .filter(
      (record) =>
        record.kind === 'relationship' || record.kind === 'identity-link',
    );
  assert(
    [...nodes, ...assertions].reduce(
      (count, record) => count + oldAnchorRefs(record).length,
      0,
    ) <= 128,
    'Selected anchor-read budget exceeded',
  );
  for (const record of assertions) {
    assert.equal(
      record.lifecycle,
      'active',
      'Only active assertions may be carried forward',
    );
    assert(
      acceptedSet.has(record.subject!) && acceptedSet.has(record.object!),
      'Selected relationship lacks a selected endpoint',
    );
    assert.equal(
      (record.supersedes ?? []).length,
      0,
      'Supersession requires separate review',
    );
  }
  const mapping = accepted.map((id) => ({
    beforeRecordId: id,
    afterRecordId: newRecordId(
      proposal.beforeGraphId,
      proposal.expectedAfterRevisionSetId,
      id,
    ),
  }));
  const mapped = new Map(
    mapping.map((item) => [item.beforeRecordId, item.afterRecordId]),
  );
  assert.equal(
    new Set(mapping.map((item) => item.afterRecordId)).size,
    mapping.length,
  );
  assert(
    mapping.every((item) => !prior.has(item.afterRecordId)),
    'New record ID collides with v1 graph',
  );
  const transport = await archiveTransport(after.transport);
  const reconstructed = new Map<
    string,
    {
      node: ArchiveGraphAnchor[];
      support: ArchiveGraphAnchor[];
      contrary: ArchiveGraphAnchor[];
    }
  >();
  for (const id of accepted) {
    const record = prior.get(id);
    assert(record, 'Selected old record disappeared');
    const proposed = eligible.get(id)!;
    assert.equal(proposed.kind, record.kind);
    const refs = oldAnchorRefs(record);
    assert.equal(
      proposed.anchors.length,
      refs.length,
      'Incomplete proposed anchor set',
    );
    const used = new Set<string>();
    const groups = {
      node: [] as ArchiveGraphAnchor[],
      support: [] as ArchiveGraphAnchor[],
      contrary: [] as ArchiveGraphAnchor[],
    };
    for (const ref of refs) {
      const matches = proposed.anchors.filter(
        (item) => item.role === ref.role && item.index === ref.index,
      );
      assert.equal(
        matches.length,
        1,
        'Duplicate or missing proposed anchor role',
      );
      const key = `${ref.role}:${ref.index}`;
      assert(!used.has(key));
      used.add(key);
      groups[ref.role].push(
        await readV2Anchor(ref.anchor, matches[0], after, transport),
      );
    }
    reconstructed.set(id, groups);
  }
  const draftNodes = nodes
    .map((record) => ({
      id: mapped.get(record.id)!,
      kind: record.kind,
      label: record.label!,
      provenance: record.provenance,
      anchors: reconstructed.get(record.id)!.node,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const draftAssertions = assertions
    .map((record) => ({
      id: mapped.get(record.id)!,
      kind: record.kind,
      subject: mapped.get(record.subject!)!,
      predicate: record.predicate!,
      object: mapped.get(record.object!)!,
      support: reconstructed.get(record.id)!.support,
      contrary: reconstructed.get(record.id)!.contrary,
      provenance: record.provenance,
      lifecycle: 'active' as const,
      supersedes: [] as string[],
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const revisionSet = {
    schema: 1,
    selections: [
      {
        source_id: after.source.id,
        generation: after.generation,
        manifest_sha256: after.manifestSha256,
      },
    ],
  };
  assert.equal(
    hash(canonical(revisionSet)),
    proposal.expectedAfterRevisionSetId,
  );
  const draft = {
    schema: 1,
    revision_set: revisionSet,
    parent: null,
    nodes: draftNodes,
    assertions: draftAssertions,
  };
  const draftBytes = canonical(draft);
  assert(
    Buffer.byteLength(draftBytes) <= 524_288,
    'Fresh-root draft exceeds bound',
  );
  const plannedGraphId = hash(draftBytes);
  const draftPath = join(
    after.task.directory,
    `archive-graph-v2-root-draft-${plannedGraphId}.json`,
  );

  // Repeat every admission and pin check immediately before the first write.
  const finalProposal = await readJsonWithBytes(review.proposalReceiptPath);
  assert.equal(
    hash(finalProposal.bytes),
    hash(saved.bytes),
    'Proposal changed during review',
  );
  await Promise.all([
    exactPublication(proposal.before),
    exactPublication(proposal.after),
  ]);
  assert.equal(
    await registrationFor(transport, after.source),
    after.registration,
    'Current source admission changed during review',
  );
  const finalOld = await oldReader.read({
    graphId: proposal.beforeGraphId,
    scope: [before.source],
    limit: 1,
    maxBytes: 1_048_576,
    cursor: null,
  });
  assert(finalOld.ok);
  assert.equal(finalOld.value.revisionSetId, proposal.beforeRevisionSetId);
  // The Registrar accepts a file input. Retain this private 0600 draft so an
  // uncertain publish or failed receipt can replay exactly the same graph.
  // It contains quoted source text; only the final mapping receipt is metadata-only.
  await publishJson(draftPath, draft, 524_288);
  assert.equal(
    (await lstat(draftPath)).mode & 0o077,
    0,
    'Private graph draft permissions required',
  );
  try {
    const published = await transport.invoke('graph-publish', [draftPath]);
    assert.equal(published['status'], 'complete');
    const graphId = digest(published['graph_id']);
    assert.equal(graphId, plannedGraphId);
    assert.equal(
      digest(published['revision_set_id']),
      proposal.expectedAfterRevisionSetId,
    );
    const newReader = await createArchiveGraphReader({
      publications: [proposal.after.publicationPath],
      readScope: 'source-root',
    });
    const fresh = await readAllGraphRecords(newReader, graphId, after.source);
    assert.equal(fresh.revisionSetId, proposal.expectedAfterRevisionSetId);
    assert.equal(
      canonical(fresh.records),
      canonical([...draftNodes, ...draftAssertions]),
      'Published fresh root differs from reviewed draft',
    );
    await Promise.all([
      exactPublication(proposal.before),
      exactPublication(proposal.after),
    ]);
    assert.equal(
      hash((await readJsonWithBytes(review.proposalReceiptPath)).bytes),
      hash(saved.bytes),
    );
    assert.equal(
      await registrationFor(transport, after.source),
      after.registration,
    );
    const receipt: ArchiveGraphRepublishReceipt = {
      schema: 1,
      kind: 'temari-archive-graph-fresh-root-review',
      policy: 'explicit-reviewed-v2-root-v1',
      proposalReceiptPath: review.proposalReceiptPath,
      proposalReceiptSha256: hash(saved.bytes),
      beforeGraphId: proposal.beforeGraphId,
      beforeRevisionSetId: proposal.beforeRevisionSetId,
      afterGraphId: graphId,
      afterRevisionSetId: fresh.revisionSetId,
      before: proposal.before,
      after: proposal.after,
      parent: null,
      selectedRecordIds: accepted,
      recordMapping: mapping,
      excluded: {
        eligibleNotSelected: [...eligible.keys()]
          .filter((id) => !acceptedSet.has(id))
          .sort(),
        deferred: proposal.deferred,
        needsReview: proposal.needsReview,
        historicalOnly: proposal.historicalOnly,
        needDiscovery: proposal.needDiscovery,
      },
      draftPath,
      draftSha256: plannedGraphId,
      reviewerRef: review.reviewerRef,
      reason: review.reason,
      reviewerAuthenticated: false,
      currentOriginal: 'not-checked',
      semanticCorrectness: 'not-verified',
      nativeLineage: 'none-external-mapping-only',
    };
    assert(
      Buffer.byteLength(canonical(receipt)) <= 1_048_576,
      'Review receipt exceeds bound',
    );
    const receiptPath = join(
      after.task.directory,
      `archive-graph-v2-root-review-${hash(canonical(receipt))}.json`,
    );
    await publishJson(receiptPath, receipt);
    return { graphId, receiptPath, receipt };
  } catch (error) {
    throw new ArchiveGraphRepublishError(plannedGraphId, draftPath, error);
  }
}
