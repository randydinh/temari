/** A bounded, read-only proposal to repin unchanged graph evidence to v2. */
import assert from 'node:assert/strict';
import { dirname, isAbsolute, join } from 'node:path';
import { canonical, digest, hash, list, object, text } from './codec.js';
import {
  loadArchivePublication,
  registrationFor,
  snapshot,
  type ArchivePublication,
} from './archive-intake.js';
import {
  createArchiveGraphReader,
  type ArchiveGraphAnchor,
  type ArchiveGraphRecord,
} from './archive-graph.js';
import {
  planArchiveGraphImpact,
  readAllGraphRecords,
  type ArchiveGraphImpactReceipt,
} from './archive-graph-impact.js';
import { archiveTransport } from './archive-transport.js';
import { publishJson, readJsonWithBytes } from './durable.js';

export interface ArchiveGraphRepinInput {
  readonly impactReceiptPath: string;
}

export interface ArchiveGraphRepinAnchor {
  readonly role: 'node' | 'support' | 'contrary';
  readonly index: number;
  readonly path: string;
  readonly originalSha256: string;
  readonly beforeRepresentationSha256: string;
  readonly afterRepresentationSha256: string;
  readonly beforeStart: number;
  readonly beforeEnd: number;
  readonly afterStart: number;
  readonly afterEnd: number;
  readonly quoteSha256: string;
}

export interface ArchiveGraphRepinReceipt {
  readonly schema: 1;
  readonly kind: 'temari-archive-graph-repin-proposal';
  readonly status: 'proposal-only';
  readonly policy: 'bounded-unchanged-v2-evidence-v1';
  readonly impactReceiptPath: string;
  readonly impactReceiptSha256: string;
  readonly sourceId: string;
  readonly before: ArchiveGraphImpactReceipt['before'];
  readonly after: ArchiveGraphImpactReceipt['after'];
  readonly beforeGraphId: string;
  readonly beforeRevisionSetId: string;
  readonly expectedAfterRevisionSetId: string;
  readonly eligible: readonly {
    readonly recordId: string;
    readonly kind: ArchiveGraphRecord['kind'];
    readonly anchors: readonly ArchiveGraphRepinAnchor[];
  }[];
  readonly deferred: readonly {
    readonly recordId: string;
    readonly reason:
      | 'supersedes-requires-review'
      | 'path-or-original-changed'
      | 'anchor-span-exceeds-budget'
      | 'v2-evidence-unavailable-or-mismatch'
      | 'endpoint-not-eligible';
  }[];
  readonly needsReview: ArchiveGraphImpactReceipt['needsReview'];
  readonly historicalOnly: ArchiveGraphImpactReceipt['historicalOnly'];
  readonly needDiscovery: ArchiveGraphImpactReceipt['needDiscovery'];
  readonly counts: {
    readonly needRepin: number;
    readonly eligible: number;
    readonly deferred: number;
    readonly needsReview: number;
    readonly historicalOnly: number;
    readonly needDiscovery: number;
  };
  readonly currentOriginal: 'not-checked';
  readonly graphMutation: 'none';
  readonly afterGraphId: null;
}

async function pinnedPublication(pin: ArchiveGraphImpactReceipt['before']) {
  const { bytes } = await readJsonWithBytes(pin.publicationPath);
  const publication = await loadArchivePublication(pin.publicationPath);
  assert.equal(bytes.toString('utf8'), canonical(publication));
  assert.equal(hash(bytes), pin.publicationSha256, 'Publication pin changed');
  assert.equal(publication.generation, pin.generation);
  assert.equal(publication.manifestSha256, pin.manifestSha256);
  assert.equal(publication.preservation, 'complete-admitted');
  return publication;
}

function anchorsOf(record: ArchiveGraphRecord): readonly {
  readonly role: ArchiveGraphRepinAnchor['role'];
  readonly index: number;
  readonly anchor: ArchiveGraphAnchor;
}[] {
  return record.kind === 'entity' || record.kind === 'mention'
    ? (record.anchors ?? []).map((anchor, index) => ({
        role: 'node',
        index,
        anchor,
      }))
    : [
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

async function verifyV2Anchor(
  anchor: ArchiveGraphAnchor,
  after: ArchivePublication,
  transport: Awaited<ReturnType<typeof archiveTransport>>,
): Promise<Omit<ArchiveGraphRepinAnchor, 'role' | 'index'> | null> {
  const span = anchor.text_end - anchor.text_start;
  if (span < 1 || span > 2048) return null;
  try {
    const maxBytes = Math.min(transport.config.maxStdoutBytes, 65536);
    const r = await transport.invoke(
      'read',
      [
        after.source.id,
        after.generation,
        anchor.path,
        '--manifest-sha256',
        after.manifestSha256,
        '--offset',
        String(anchor.text_start),
        '--max-chars',
        String(span),
        '--max-bytes',
        String(maxBytes),
      ],
      maxBytes,
    );
    snapshot(r, after);
    assert.equal(r['path'], anchor.path);
    assert.equal(r['offset'], anchor.text_start);
    const representation = object(r['representation']);
    assert.equal(representation['coordinate_space'], 'unicode-codepoints');
    assert.equal(representation['original_sha256'], anchor.original_sha256);
    const representationSha256 = digest(representation['sha256']);
    const record = object(r['record']);
    const citations = list(record['citations']);
    assert.equal(citations.length, 1);
    const citation = object(citations[0]);
    assert.equal(citation['source_id'], after.source.id);
    assert.equal(citation['snapshot_generation'], after.generation);
    assert.equal(citation['manifest_sha256'], after.manifestSha256);
    assert.equal(citation['path'], anchor.path);
    assert.equal(citation['evidence'], 'archived-snapshot');
    assert.equal(citation['current_original'], 'not-checked');
    assert.equal(citation['coordinate_space'], 'unicode-codepoints');
    assert.equal(citation['original_sha256'], anchor.original_sha256);
    assert.equal(citation['representation_sha256'], representationSha256);
    assert.equal(citation['text_start'], anchor.text_start);
    assert.equal(citation['text_end'], anchor.text_end);
    const quote = text(citation['quote']);
    assert.equal(record['body'], quote);
    assert.equal(
      Array.from(quote).length,
      span,
      'Read shortened the anchor span',
    );
    assert.equal(quote, anchor.quote, 'V2 quote differs from v1');
    assert.equal(hash(quote), anchor.quote_sha256);
    return {
      path: anchor.path,
      originalSha256: anchor.original_sha256,
      beforeRepresentationSha256: anchor.representation_sha256,
      afterRepresentationSha256: representationSha256,
      beforeStart: anchor.text_start,
      beforeEnd: anchor.text_end,
      afterStart: anchor.text_start,
      afterEnd: anchor.text_end,
      quoteSha256: anchor.quote_sha256,
    };
  } catch {
    return null;
  }
}

/**
 * Revalidates the impact and exact old graph, then checks proposed v2 anchors
 * against retained Registrar bytes. It never publishes an active graph.
 */
export async function proposeArchiveGraphRepins(
  input: ArchiveGraphRepinInput,
): Promise<{
  readonly receiptPath: string;
  readonly receipt: ArchiveGraphRepinReceipt;
}> {
  assert.deepEqual(Object.keys(input), ['impactReceiptPath']);
  assert(isAbsolute(input.impactReceiptPath));
  const saved = await readJsonWithBytes(input.impactReceiptPath);
  const impact = saved.value as ArchiveGraphImpactReceipt;
  assert.equal(saved.bytes.toString('utf8'), canonical(impact));
  assert.equal(impact.kind, 'temari-archive-graph-impact-plan');
  assert.equal(impact.status, 'plan-only');
  assert.equal(
    input.impactReceiptPath,
    join(
      dirname(impact.after.publicationPath),
      `archive-graph-impact-${hash(saved.bytes)}.json`,
    ),
    'Impact receipt path is not content addressed beside v2 publication',
  );
  const recalculated = await planArchiveGraphImpact({
    beforePublicationPath: impact.before.publicationPath,
    afterPublicationPath: impact.after.publicationPath,
    beforeGraphId: impact.beforeGraphId,
  });
  assert.equal(recalculated.receiptPath, input.impactReceiptPath);
  assert.equal(
    canonical(recalculated.receipt),
    canonical(impact),
    'Impact changed',
  );
  const [before, after] = await Promise.all([
    pinnedPublication(impact.before),
    pinnedPublication(impact.after),
  ]);
  assert.equal(before.source.id, impact.sourceId);
  assert.equal(after.source.id, impact.sourceId);
  assert(impact.needRepin.length <= 64, 'Repin candidate budget exceeded');
  assert.equal(new Set(impact.needRepin).size, impact.needRepin.length);
  const reader = await createArchiveGraphReader({
    publications: [impact.before.publicationPath],
    readScope: 'source-root',
  });
  const { records, revisionSetId } = await readAllGraphRecords(
    reader,
    impact.beforeGraphId,
    before.source,
  );
  assert.equal(revisionSetId, impact.beforeRevisionSetId);
  const recordById = new Map(records.map((record) => [record.id, record]));
  const queued = new Set([
    ...impact.needRepin,
    ...impact.needsReview.map((item) => item.recordId),
    ...impact.historicalOnly,
  ]);
  assert.equal(
    queued.size,
    records.length,
    'Impact queues overlap or omit a record',
  );
  for (const id of queued)
    assert(recordById.has(id), 'Impact contains unknown record');
  const candidates = impact.needRepin.map((id) => recordById.get(id)!);
  const uniqueAnchors = new Set(
    candidates.flatMap((record) =>
      anchorsOf(record).map((ref) => canonical(ref.anchor)),
    ),
  );
  assert(uniqueAnchors.size <= 128, 'Unique anchor budget exceeded');
  const diff = await readJsonWithBytes(impact.diffReceiptPath);
  assert.equal(hash(diff.bytes), impact.diffReceiptSha256);
  const unchangedPaths = new Map(
    (object(diff.value)['unchanged'] as { path: string; sha256: string }[]).map(
      (item) => [item.path, item.sha256],
    ),
  );
  const transport = await archiveTransport(after.transport);
  const checked = new Map<
    string,
    Omit<ArchiveGraphRepinAnchor, 'role' | 'index'> | null
  >();
  async function proposalFor(record: ArchiveGraphRecord) {
    const proposals: ArchiveGraphRepinAnchor[] = [];
    for (const { anchor, role, index } of anchorsOf(record)) {
      if (unchangedPaths.get(anchor.path) !== anchor.original_sha256)
        return { reason: 'path-or-original-changed' as const };
      if (anchor.text_end - anchor.text_start > 2048)
        return { reason: 'anchor-span-exceeds-budget' as const };
      const key = canonical(anchor);
      if (!checked.has(key))
        checked.set(key, await verifyV2Anchor(anchor, after, transport));
      const next = checked.get(key);
      if (!next)
        return { reason: 'v2-evidence-unavailable-or-mismatch' as const };
      proposals.push({ ...next, role, index });
    }
    return { anchors: proposals };
  }
  const eligible: ArchiveGraphRepinReceipt['eligible'][number][] = [];
  const deferred: ArchiveGraphRepinReceipt['deferred'][number][] = [];
  const eligibleIds = new Set<string>();
  for (const record of candidates.filter(
    (item) => item.kind === 'entity' || item.kind === 'mention',
  )) {
    const result = await proposalFor(record);
    if (result.reason !== undefined)
      deferred.push({ recordId: record.id, reason: result.reason });
    else {
      eligible.push({
        recordId: record.id,
        kind: record.kind,
        anchors: result.anchors,
      });
      eligibleIds.add(record.id);
    }
  }
  for (const record of candidates.filter(
    (item) => item.kind === 'relationship' || item.kind === 'identity-link',
  )) {
    if (record.lifecycle === 'supersedes') {
      deferred.push({
        recordId: record.id,
        reason: 'supersedes-requires-review',
      });
      continue;
    }
    if (!eligibleIds.has(record.subject!) || !eligibleIds.has(record.object!)) {
      deferred.push({ recordId: record.id, reason: 'endpoint-not-eligible' });
      continue;
    }
    const result = await proposalFor(record);
    if (result.reason !== undefined)
      deferred.push({ recordId: record.id, reason: result.reason });
    else
      eligible.push({
        recordId: record.id,
        kind: record.kind,
        anchors: result.anchors,
      });
  }
  eligible.sort((a, b) => a.recordId.localeCompare(b.recordId));
  deferred.sort((a, b) => a.recordId.localeCompare(b.recordId));
  assert.equal(eligible.length + deferred.length, impact.needRepin.length);
  const receipt: ArchiveGraphRepinReceipt = {
    schema: 1,
    kind: 'temari-archive-graph-repin-proposal',
    status: 'proposal-only',
    policy: 'bounded-unchanged-v2-evidence-v1',
    impactReceiptPath: input.impactReceiptPath,
    impactReceiptSha256: hash(saved.bytes),
    sourceId: impact.sourceId,
    before: impact.before,
    after: impact.after,
    beforeGraphId: impact.beforeGraphId,
    beforeRevisionSetId: impact.beforeRevisionSetId,
    expectedAfterRevisionSetId: hash(
      canonical({
        schema: 1,
        selections: [
          {
            source_id: after.source.id,
            generation: after.generation,
            manifest_sha256: after.manifestSha256,
          },
        ],
      }),
    ),
    eligible,
    deferred,
    needsReview: impact.needsReview,
    historicalOnly: impact.historicalOnly,
    needDiscovery: impact.needDiscovery,
    counts: {
      needRepin: impact.needRepin.length,
      eligible: eligible.length,
      deferred: deferred.length,
      needsReview: impact.needsReview.length,
      historicalOnly: impact.historicalOnly.length,
      needDiscovery: impact.needDiscovery.length,
    },
    currentOriginal: 'not-checked',
    graphMutation: 'none',
    afterGraphId: null,
  };
  assert(
    Buffer.byteLength(canonical(receipt)) <= 1_048_576,
    'Repin proposal exceeds artifact budget',
  );
  await Promise.all([
    pinnedPublication(impact.before),
    pinnedPublication(impact.after),
  ]);
  assert.equal(
    hash((await readJsonWithBytes(input.impactReceiptPath)).bytes),
    hash(saved.bytes),
    'Impact receipt changed during proposal',
  );
  assert.equal(
    hash((await readJsonWithBytes(impact.diffReceiptPath)).bytes),
    impact.diffReceiptSha256,
    'Generation diff changed during proposal',
  );
  const finalGraph = await reader.read({
    graphId: impact.beforeGraphId,
    scope: [before.source],
    limit: 1,
    maxBytes: 1_048_576,
    cursor: null,
  });
  assert(finalGraph.ok, 'Old graph became unavailable during proposal');
  assert.equal(finalGraph.value.revisionSetId, impact.beforeRevisionSetId);
  assert.equal(
    await registrationFor(transport, after.source),
    after.registration,
    'Current source admission changed during proposal',
  );
  const receiptPath = join(
    after.task.directory,
    `archive-graph-repin-${hash(canonical(receipt))}.json`,
  );
  await publishJson(receiptPath, receipt);
  return { receiptPath, receipt };
}
