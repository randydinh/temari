/** Source-aware, read-only anchor proposal for a multi-source impact plan. */
import assert from 'node:assert/strict';
import { isAbsolute, join } from 'node:path';
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
import { readAllGraphRecords } from './archive-graph-impact.js';
import {
  planArchiveMultisourceGraphImpact,
  type ArchiveMultisourceGraphImpactReceipt,
} from './archive-graph-multisource-impact.js';
import { ArchiveFailure, archiveTransport } from './archive-transport.js';
import { publishJson, readJsonWithBytes } from './durable.js';

export interface ArchiveMultisourceGraphRepinInput {
  readonly impactReceiptPath: string;
}

export interface ArchiveMultisourceGraphRepinAnchor {
  readonly role: 'node' | 'support' | 'contrary';
  readonly index: number;
  readonly sourceId: string;
  readonly path: string;
  readonly originalSha256: string;
  readonly beforeGeneration: string;
  readonly beforeManifestSha256: string;
  readonly beforeRepresentationSha256: string;
  readonly afterGeneration: string;
  readonly afterManifestSha256: string;
  readonly afterRepresentationSha256: string;
  readonly beforeStart: number;
  readonly beforeEnd: number;
  readonly afterStart: number;
  readonly afterEnd: number;
  readonly quoteSha256: string;
}

export interface ArchiveMultisourceGraphRepinReceipt {
  readonly schema: 1;
  readonly kind: 'temari-archive-multisource-graph-repin-proposal';
  readonly status: 'proposal-only';
  readonly policy: 'bounded-source-aware-unchanged-evidence-v1';
  readonly impactReceiptPath: string;
  readonly impactReceiptSha256: string;
  readonly changedSourceId: string;
  readonly before: ArchiveMultisourceGraphImpactReceipt['before'];
  readonly after: ArchiveMultisourceGraphImpactReceipt['after'];
  readonly beforeGraphId: string;
  readonly beforeRevisionSetId: string;
  readonly expectedAfterRevisionSetId: string;
  readonly eligible: readonly {
    readonly recordId: string;
    readonly kind: ArchiveGraphRecord['kind'];
    readonly anchors: readonly ArchiveMultisourceGraphRepinAnchor[];
  }[];
  readonly deferred: readonly {
    readonly recordId: string;
    readonly reason:
      | 'supersedes-requires-review'
      | 'path-or-original-changed'
      | 'anchor-span-exceeds-budget'
      | 'text-unavailable-or-mismatch'
      | 'endpoint-not-eligible';
  }[];
  readonly needsReview: ArchiveMultisourceGraphImpactReceipt['needsReview'];
  readonly historicalOnly: ArchiveMultisourceGraphImpactReceipt['historicalOnly'];
  readonly needDiscovery: ArchiveMultisourceGraphImpactReceipt['needDiscovery'];
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

type PublicationPin = ArchiveMultisourceGraphImpactReceipt['after'];

async function pinnedPublication(
  pin: PublicationPin,
): Promise<ArchivePublication> {
  assert(isAbsolute(pin.publicationPath));
  const { bytes } = await readJsonWithBytes(pin.publicationPath);
  const publication = await loadArchivePublication(pin.publicationPath);
  assert.equal(
    bytes.toString('utf8'),
    canonical(publication),
    'Publication bytes changed',
  );
  assert.equal(hash(bytes), pin.publicationSha256, 'Publication pin changed');
  assert.equal(publication.generation, pin.generation);
  assert.equal(publication.manifestSha256, pin.manifestSha256);
  assert.equal(publication.preservation, 'complete-admitted');
  return publication;
}

function anchorsOf(record: ArchiveGraphRecord): readonly {
  readonly role: ArchiveMultisourceGraphRepinAnchor['role'];
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

async function verifiedAnchor(
  anchor: ArchiveGraphAnchor,
  target: ArchivePublication,
  transport: Awaited<ReturnType<typeof archiveTransport>>,
): Promise<Omit<ArchiveMultisourceGraphRepinAnchor, 'role' | 'index'> | null> {
  const span = anchor.text_end - anchor.text_start;
  assert(span >= 1 && span <= 2048);
  const maxBytes = Math.min(transport.config.maxStdoutBytes, 65536);
  let r: Record<string, unknown>;
  try {
    r = await transport.invoke(
      'read',
      [
        target.source.id,
        target.generation,
        anchor.path,
        '--manifest-sha256',
        target.manifestSha256,
        '--offset',
        String(anchor.text_start),
        '--max-chars',
        String(span),
        '--max-bytes',
        String(maxBytes),
      ],
      maxBytes,
    );
  } catch (error) {
    // A captured file may have no supported text representation. Admission,
    // transport and integrity failures are not ordinary content deferrals.
    if (
      error instanceof ArchiveFailure &&
      error.kind === 'unsupported' &&
      error.message.includes('Archived text representation unavailable')
    )
      return null;
    throw error;
  }
  snapshot(r, target);
  assert.equal(r['path'], anchor.path);
  assert.equal(r['offset'], anchor.text_start);
  const representation = object(r['representation']);
  assert.equal(representation['coordinate_space'], 'unicode-codepoints');
  assert.equal(
    representation['original_sha256'],
    anchor.original_sha256,
    'Retained original changed under a pinned archive',
  );
  const representationSha256 = digest(representation['sha256']);
  const record = object(r['record']);
  const citations = list(record['citations']);
  assert.equal(citations.length, 1);
  const citation = object(citations[0]);
  assert.equal(citation['source_id'], target.source.id);
  assert.equal(citation['snapshot_generation'], target.generation);
  assert.equal(citation['manifest_sha256'], target.manifestSha256);
  assert.equal(citation['path'], anchor.path);
  assert.equal(citation['evidence'], 'archived-snapshot');
  assert.equal(citation['current_original'], 'not-checked');
  assert.equal(citation['coordinate_space'], 'unicode-codepoints');
  assert.equal(citation['original_sha256'], anchor.original_sha256);
  assert.equal(citation['representation_sha256'], representationSha256);
  assert.equal(citation['text_start'], anchor.text_start);
  const end = citation['text_end'];
  assert.equal(typeof end, 'number');
  const quote = text(citation['quote']);
  assert.equal(record['body'], quote);
  assert.equal(Array.from(quote).length, (end as number) - anchor.text_start);
  if (
    end !== anchor.text_end ||
    quote !== anchor.quote ||
    hash(quote) !== anchor.quote_sha256
  )
    return null;
  if (target.generation === anchor.generation)
    assert.equal(
      representationSha256,
      anchor.representation_sha256,
      'Unchanged-source representation changed under the same generation',
    );
  return {
    sourceId: anchor.source_id,
    path: anchor.path,
    originalSha256: anchor.original_sha256,
    beforeGeneration: anchor.generation,
    beforeManifestSha256: anchor.manifest_sha256,
    beforeRepresentationSha256: anchor.representation_sha256,
    afterGeneration: target.generation,
    afterManifestSha256: target.manifestSha256,
    afterRepresentationSha256: representationSha256,
    beforeStart: anchor.text_start,
    beforeEnd: anchor.text_end,
    afterStart: anchor.text_start,
    afterEnd: anchor.text_end,
    quoteSha256: anchor.quote_sha256,
  };
}

/** Verify candidate anchors without publishing or changing any graph record. */
export async function proposeArchiveMultisourceGraphRepins(
  input: ArchiveMultisourceGraphRepinInput,
): Promise<{
  readonly receiptPath: string;
  readonly receipt: ArchiveMultisourceGraphRepinReceipt;
}> {
  assert.deepEqual(Object.keys(input), ['impactReceiptPath']);
  assert(isAbsolute(input.impactReceiptPath));
  const saved = await readJsonWithBytes(input.impactReceiptPath);
  const impact = saved.value as ArchiveMultisourceGraphImpactReceipt;
  assert.equal(saved.bytes.toString('utf8'), canonical(impact));
  assert.equal(impact.kind, 'temari-archive-multisource-graph-impact-plan');
  assert.equal(impact.status, 'plan-only');
  assert.equal(impact.policy, 'pinned-multisource-one-change-v1');
  const recalculated = await planArchiveMultisourceGraphImpact({
    beforePublicationPaths: impact.before.map((pin) => pin.publicationPath),
    afterPublicationPath: impact.after.publicationPath,
    changedSourceId: impact.changedSourceId,
    beforeGraphId: impact.beforeGraphId,
  });
  assert.equal(
    recalculated.receiptPath,
    input.impactReceiptPath,
    'Impact receipt is not the recomputed content-addressed artifact',
  );
  assert.equal(
    canonical(recalculated.receipt),
    canonical(impact),
    'Impact changed',
  );
  assert(impact.before.length >= 2 && impact.before.length <= 8);
  assert(impact.needRepin.length <= 64, 'Repin candidate budget exceeded');
  assert.equal(new Set(impact.needRepin).size, impact.needRepin.length);
  const before = await Promise.all(impact.before.map(pinnedPublication));
  const after = await pinnedPublication(impact.after);
  for (let i = 0; i < before.length; i++)
    assert.equal(before[i].source.id, impact.before[i].sourceId);
  assert.equal(after.source.id, impact.changedSourceId);
  const oldBySource = new Map(before.map((p) => [p.source.id, p]));
  assert.equal(oldBySource.size, before.length);
  const nextBySource = new Map(oldBySource);
  nextBySource.set(after.source.id, after);
  const reader = await createArchiveGraphReader({
    publications: impact.before.map((pin) => pin.publicationPath),
    readScope: 'source-root',
  });
  const { records, revisionSetId } = await readAllGraphRecords(
    reader,
    impact.beforeGraphId,
    before.map((p) => p.source),
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
    Omit<ArchiveMultisourceGraphRepinAnchor, 'role' | 'index'> | null
  >();
  async function proposalFor(record: ArchiveGraphRecord) {
    const proposals: ArchiveMultisourceGraphRepinAnchor[] = [];
    for (const { anchor, role, index } of anchorsOf(record)) {
      const old = oldBySource.get(anchor.source_id);
      const target = nextBySource.get(anchor.source_id);
      assert(old && target, 'Candidate anchor outside pinned RevisionSet');
      assert.equal(anchor.generation, old.generation);
      assert.equal(anchor.manifest_sha256, old.manifestSha256);
      if (
        anchor.source_id === impact.changedSourceId &&
        unchangedPaths.get(anchor.path) !== anchor.original_sha256
      )
        return { reason: 'path-or-original-changed' as const };
      const span = anchor.text_end - anchor.text_start;
      if (span < 1 || span > 2048)
        return { reason: 'anchor-span-exceeds-budget' as const };
      const key = canonical(anchor);
      if (!checked.has(key))
        checked.set(key, await verifiedAnchor(anchor, target, transport));
      const next = checked.get(key);
      if (!next) return { reason: 'text-unavailable-or-mismatch' as const };
      proposals.push({ ...next, role, index });
    }
    return { anchors: proposals };
  }
  const eligible: ArchiveMultisourceGraphRepinReceipt['eligible'][number][] =
    [];
  const deferred: ArchiveMultisourceGraphRepinReceipt['deferred'][number][] =
    [];
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
  const expectedAfterRevisionSetId = hash(
    canonical({
      schema: 1,
      selections: [...nextBySource.values()]
        .map((p) => ({
          source_id: p.source.id,
          generation: p.generation,
          manifest_sha256: p.manifestSha256,
        }))
        .sort((a, b) => a.source_id.localeCompare(b.source_id)),
    }),
  );
  const receipt: ArchiveMultisourceGraphRepinReceipt = {
    schema: 1,
    kind: 'temari-archive-multisource-graph-repin-proposal',
    status: 'proposal-only',
    policy: 'bounded-source-aware-unchanged-evidence-v1',
    impactReceiptPath: input.impactReceiptPath,
    impactReceiptSha256: hash(saved.bytes),
    changedSourceId: impact.changedSourceId,
    before: impact.before,
    after: impact.after,
    beforeGraphId: impact.beforeGraphId,
    beforeRevisionSetId: impact.beforeRevisionSetId,
    expectedAfterRevisionSetId,
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
  await Promise.all([...impact.before, impact.after].map(pinnedPublication));
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
    scope: before.map((p) => p.source),
    limit: 1,
    maxBytes: 1_048_576,
    cursor: null,
  });
  assert(
    finalGraph.ok &&
      finalGraph.value.revisionSetId === impact.beforeRevisionSetId,
    'Old graph became unavailable during proposal',
  );
  for (const publication of before)
    assert.equal(
      await registrationFor(transport, publication.source),
      publication.registration,
      'Current source admission changed during proposal',
    );
  assert.equal(
    await registrationFor(transport, after.source),
    after.registration,
    'Changed source admission changed during proposal',
  );
  const receiptPath = join(
    after.task.directory,
    `archive-graph-multisource-repin-${hash(canonical(receipt))}.json`,
  );
  await publishJson(receiptPath, receipt);
  return { receiptPath, receipt };
}
