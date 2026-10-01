/** A read-only plan for reviewing one archived graph after a source recapture. */
import assert from 'node:assert/strict';
import { isAbsolute, join } from 'node:path';
import { canonical, digest, hash } from './codec.js';
import { loadArchivePublication, registrationFor } from './archive-intake.js';
import {
  createArchiveGraphReader,
  type ArchiveGraphRecord,
} from './archive-graph.js';
import {
  diffArchiveGenerations,
  type ArchiveGenerationDiffPin,
} from './archive-generation-diff.js';
import { archiveTransport } from './archive-transport.js';
import { publishJson, readJsonWithBytes } from './durable.js';

export interface ArchiveGraphImpactInput {
  readonly beforePublicationPath: string;
  readonly afterPublicationPath: string;
  readonly beforeGraphId: string;
}

export interface ArchiveGraphImpactReceipt {
  readonly schema: 1;
  readonly kind: 'temari-archive-graph-impact-plan';
  readonly status: 'plan-only';
  readonly policy: 'pinned-single-source-graph-impact-v1';
  readonly sourceId: string;
  readonly before: ArchiveGenerationDiffPin;
  readonly after: ArchiveGenerationDiffPin;
  readonly diffReceiptPath: string;
  readonly diffReceiptSha256: string;
  readonly beforeGraphId: string;
  readonly beforeRevisionSetId: string;
  readonly needsReview: readonly {
    readonly recordId: string;
    readonly reason: 'changed-or-removed-anchor' | 'dependent-endpoint';
  }[];
  readonly needRepin: readonly string[];
  readonly historicalOnly: readonly string[];
  readonly needDiscovery: readonly {
    readonly path: string;
    readonly reason: 'added' | 'changed';
  }[];
  readonly counts: {
    readonly needsReview: number;
    readonly needRepin: number;
    readonly historicalOnly: number;
    readonly needDiscovery: number;
  };
  readonly currentOriginal: 'not-checked';
}

async function verifyPublicationPin(pin: ArchiveGenerationDiffPin) {
  const { bytes } = await readJsonWithBytes(pin.publicationPath);
  const publication = await loadArchivePublication(pin.publicationPath);
  assert.equal(
    bytes.toString('utf8'),
    canonical(publication),
    'Publication bytes changed during impact planning',
  );
  assert.equal(
    hash(bytes),
    pin.publicationSha256,
    'Publication pin changed during impact planning',
  );
  assert.equal(publication.generation, pin.generation);
  assert.equal(publication.manifestSha256, pin.manifestSha256);
  return publication;
}

/** Bounded, exact-RevisionSet graph read shared with read-only review proposals. */
export async function readAllGraphRecords(
  reader: Awaited<ReturnType<typeof createArchiveGraphReader>>,
  graphId: string,
  source: Awaited<ReturnType<typeof loadArchivePublication>>['source'],
) {
  const records: ArchiveGraphRecord[] = [];
  const recordIds = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  let revisionSetId: string | null = null;
  let totalRecords: number | null = null;
  for (;;) {
    const page = await reader.read({
      graphId,
      scope: [source],
      limit: 200,
      maxBytes: 1_048_576,
      cursor,
    });
    assert(
      page.ok,
      'Graph is outside the exact admitted source scope or failed integrity validation',
    );
    assert.equal(
      page.value.offset,
      records.length,
      'Graph pagination skipped or repeated records',
    );
    revisionSetId ??= page.value.revisionSetId;
    totalRecords ??= page.value.totalRecords;
    assert.equal(
      page.value.revisionSetId,
      revisionSetId,
      'Graph RevisionSet changed during pagination',
    );
    assert.equal(
      page.value.totalRecords,
      totalRecords,
      'Graph record total changed during pagination',
    );
    assert.equal(page.value.consistency, 'declared-selection-not-atomic');
    for (const record of page.value.records) {
      assert(!recordIds.has(record.id), 'Duplicate graph record ID');
      recordIds.add(record.id);
      records.push(record);
    }
    assert(records.length <= 1500, 'Graph record budget exceeded');
    if (page.value.exhausted) {
      assert.equal(page.value.next, null);
      assert.equal(records.length, totalRecords);
      break;
    }
    assert(
      page.value.next && !cursors.has(page.value.next),
      'Graph pagination made no progress',
    );
    cursors.add(page.value.next);
    cursor = page.value.next;
  }
  assert(revisionSetId, 'Graph RevisionSet unavailable');
  const nodes = new Set(
    records
      .filter((record) => record.kind === 'entity' || record.kind === 'mention')
      .map((record) => record.id),
  );
  for (const record of records) {
    if (record.kind === 'relationship' || record.kind === 'identity-link') {
      assert(
        nodes.has(record.subject!) && nodes.has(record.object!),
        'Graph relationship has an unknown endpoint',
      );
    }
  }
  return { records, revisionSetId };
}

/**
 * Produce review work from two retained generations. This never mutates or
 * silently repins graph evidence and never asserts live source currentness.
 */
export async function planArchiveGraphImpact(
  input: ArchiveGraphImpactInput,
): Promise<{
  readonly receiptPath: string;
  readonly receipt: ArchiveGraphImpactReceipt;
}> {
  assert.deepEqual(Object.keys(input).sort(), [
    'afterPublicationPath',
    'beforeGraphId',
    'beforePublicationPath',
  ]);
  assert(
    isAbsolute(input.beforePublicationPath) &&
      isAbsolute(input.afterPublicationPath),
    'Absolute publication paths required',
  );
  digest(input.beforeGraphId);
  const { receiptPath: diffReceiptPath, receipt: diff } =
    await diffArchiveGenerations({
      beforePublicationPath: input.beforePublicationPath,
      afterPublicationPath: input.afterPublicationPath,
    });
  const diffBytes = await readJsonWithBytes(diffReceiptPath);
  assert.equal(
    diffBytes.bytes.toString('utf8'),
    canonical(diff),
    'Generation diff changed during impact planning',
  );
  const diffReceiptSha256 = hash(diffBytes.bytes);
  const before = await verifyPublicationPin(diff.before);
  const after = await verifyPublicationPin(diff.after);
  assert.equal(before.source.id, diff.sourceId);
  assert.equal(after.source.id, diff.sourceId);
  const reader = await createArchiveGraphReader({
    publications: [diff.before.publicationPath],
    readScope: 'source-root',
  });
  // Registrar's graph-read requires the entire RevisionSet source list to
  // match exactly; the reader also checks its generation and manifest pins.
  const { records, revisionSetId } = await readAllGraphRecords(
    reader,
    input.beforeGraphId,
    before.source,
  );
  const expectedRevisionSetId = hash(
    canonical({
      schema: 1,
      selections: [
        {
          source_id: before.source.id,
          generation: before.generation,
          manifest_sha256: before.manifestSha256,
        },
      ],
    }),
  );
  assert.equal(
    revisionSetId,
    expectedRevisionSetId,
    'Graph is not pinned to the complete before generation',
  );
  const changedPaths = new Set([
    ...diff.changed.map((item) => item.path),
    ...diff.removed.map((item) => item.path),
  ]);
  const historicalOnly = records
    .filter(
      (record) =>
        (record.kind === 'relationship' || record.kind === 'identity-link') &&
        record.lifecycle === 'retracted',
    )
    .map((record) => record.id)
    .sort();
  const retiredIds = new Set(historicalOnly);
  const liveRecords = records.filter((record) => !retiredIds.has(record.id));
  const reviewReasons = new Map<
    string,
    'changed-or-removed-anchor' | 'dependent-endpoint'
  >();
  for (const record of liveRecords) {
    const anchors =
      record.kind === 'entity' || record.kind === 'mention'
        ? (record.anchors ?? [])
        : [...(record.support ?? []), ...(record.contrary ?? [])];
    if (anchors.some((anchor) => changedPaths.has(anchor.path)))
      reviewReasons.set(record.id, 'changed-or-removed-anchor');
  }
  // A relationship whose evidence is unchanged can still depend on a node
  // whose evidence changed. Preserve that dependency in the review queue.
  for (const record of liveRecords) {
    if (
      (record.kind === 'relationship' || record.kind === 'identity-link') &&
      !reviewReasons.has(record.id) &&
      (reviewReasons.has(record.subject!) || reviewReasons.has(record.object!))
    )
      reviewReasons.set(record.id, 'dependent-endpoint');
  }
  const needsReview = [...reviewReasons]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([recordId, reason]) => ({ recordId, reason }));
  const needRepin = liveRecords
    .filter((record) => !reviewReasons.has(record.id))
    .map((record) => record.id)
    .sort();
  const needDiscovery = [
    ...diff.added.map((item) => ({
      path: item.path,
      reason: 'added' as const,
    })),
    ...diff.changed.map((item) => ({
      path: item.path,
      reason: 'changed' as const,
    })),
  ].sort((a, b) => a.path.localeCompare(b.path));
  const receipt: ArchiveGraphImpactReceipt = {
    schema: 1,
    kind: 'temari-archive-graph-impact-plan',
    status: 'plan-only',
    policy: 'pinned-single-source-graph-impact-v1',
    sourceId: diff.sourceId,
    before: diff.before,
    after: diff.after,
    diffReceiptPath,
    diffReceiptSha256,
    beforeGraphId: input.beforeGraphId,
    beforeRevisionSetId: revisionSetId,
    needsReview,
    needRepin,
    historicalOnly,
    needDiscovery,
    counts: {
      needsReview: needsReview.length,
      needRepin: needRepin.length,
      historicalOnly: historicalOnly.length,
      needDiscovery: needDiscovery.length,
    },
    currentOriginal: 'not-checked',
  };
  assert(
    Buffer.byteLength(canonical(receipt)) <= 1_048_576,
    'Graph impact receipt exceeds durable artifact budget',
  );
  await Promise.all([
    verifyPublicationPin(diff.before),
    verifyPublicationPin(diff.after),
  ]);
  const finalDiff = await readJsonWithBytes(diffReceiptPath);
  assert.equal(
    hash(finalDiff.bytes),
    diffReceiptSha256,
    'Generation diff changed during impact planning',
  );
  const transport = await archiveTransport(before.transport);
  assert.equal(
    await registrationFor(transport, before.source),
    before.registration,
    'Current source admission changed during impact planning',
  );
  const receiptPath = join(
    after.task.directory,
    `archive-graph-impact-${hash(canonical(receipt))}.json`,
  );
  await publishJson(receiptPath, receipt);
  return { receiptPath, receipt };
}
