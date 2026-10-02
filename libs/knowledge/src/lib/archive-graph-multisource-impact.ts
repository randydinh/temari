/** Read-only review work for one recaptured source in an exact multi-source graph. */
import assert from 'node:assert/strict';
import { isAbsolute, join } from 'node:path';
import { canonical, digest, hash } from './codec.js';
import { loadArchivePublication, registrationFor } from './archive-intake.js';
import { createArchiveGraphReader } from './archive-graph.js';
import { readAllGraphRecords } from './archive-graph-impact.js';
import {
  diffArchiveGenerations,
  type ArchiveGenerationDiffPin,
} from './archive-generation-diff.js';
import { archiveTransport } from './archive-transport.js';
import { publishJson, readJsonWithBytes } from './durable.js';

export interface ArchiveMultisourceGraphImpactInput {
  readonly beforePublicationPaths: readonly string[];
  readonly afterPublicationPath: string;
  readonly changedSourceId: string;
  readonly beforeGraphId: string;
}

export interface ArchiveMultisourceGraphImpactReceipt {
  readonly schema: 1;
  readonly kind: 'temari-archive-multisource-graph-impact-plan';
  readonly status: 'plan-only';
  readonly policy: 'pinned-multisource-one-change-v1';
  readonly changedSourceId: string;
  readonly before: readonly (ArchiveGenerationDiffPin & {
    readonly sourceId: string;
  })[];
  readonly after: ArchiveGenerationDiffPin;
  readonly diffReceiptPath: string;
  readonly diffReceiptSha256: string;
  readonly beforeGraphId: string;
  readonly beforeRevisionSetId: string;
  readonly needsReview: readonly {
    readonly recordId: string;
    readonly reason: 'changed-or-removed-anchor' | 'dependent-endpoint';
  }[];
  /** These are candidates only; no graph record or archive pin is changed. */
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
  readonly graphMutation: 'none';
}

async function pinnedPublication(path: string) {
  assert(isAbsolute(path), 'Absolute publication path required');
  const { bytes } = await readJsonWithBytes(path);
  const publication = await loadArchivePublication(path);
  assert.equal(
    bytes.toString('utf8'),
    canonical(publication),
    'Publication changed during planning',
  );
  assert.equal(publication.preservation, 'complete-admitted');
  return { path, sha256: hash(bytes), publication };
}

function pin(value: Awaited<ReturnType<typeof pinnedPublication>>) {
  return {
    sourceId: value.publication.source.id,
    publicationPath: value.path,
    publicationSha256: value.sha256,
    generation: value.publication.generation,
    manifestSha256: value.publication.manifestSha256,
  };
}

/** Plan review without publishing, rebasing, or reading any live source bytes. */
export async function planArchiveMultisourceGraphImpact(
  input: ArchiveMultisourceGraphImpactInput,
): Promise<{
  readonly receiptPath: string;
  readonly receipt: ArchiveMultisourceGraphImpactReceipt;
}> {
  assert.deepEqual(Object.keys(input).sort(), [
    'afterPublicationPath',
    'beforeGraphId',
    'beforePublicationPaths',
    'changedSourceId',
  ]);
  assert(
    input.beforePublicationPaths.length >= 2 &&
      input.beforePublicationPaths.length <= 8,
    'Two to eight complete before sources required',
  );
  assert(isAbsolute(input.afterPublicationPath));
  digest(input.beforeGraphId);
  const beforePins = await Promise.all(
    input.beforePublicationPaths.map(pinnedPublication),
  );
  const before = beforePins.map((item) => item.publication);
  assert.equal(
    new Set(before.map((item) => item.source.id)).size,
    before.length,
    'Duplicate source in before RevisionSet',
  );
  const changed = beforePins.find(
    (item) => item.publication.source.id === input.changedSourceId,
  );
  assert(
    changed,
    'Changed source must occur exactly once in before RevisionSet',
  );
  assert(!input.beforePublicationPaths.includes(input.afterPublicationPath));
  const transportConfig = canonical(changed.publication.transport);
  for (const item of before) {
    assert.equal(
      canonical(item.transport),
      transportConfig,
      'Registrar transport differs',
    );
    assert.equal(item.implementation, changed.publication.implementation);
    assert.equal(item.protocolSha256, changed.publication.protocolSha256);
  }
  const { receiptPath: diffReceiptPath, receipt: diff } =
    await diffArchiveGenerations({
      beforePublicationPath: changed.path,
      afterPublicationPath: input.afterPublicationPath,
    });
  assert.equal(diff.sourceId, input.changedSourceId);
  const { bytes: diffBytes } = await readJsonWithBytes(diffReceiptPath);
  assert.equal(
    diffBytes.toString('utf8'),
    canonical(diff),
    'Generation diff changed',
  );
  const diffReceiptSha256 = hash(diffBytes);
  assert.equal(diff.before.publicationSha256, changed.sha256);
  const afterPin = await pinnedPublication(input.afterPublicationPath);
  assert.equal(afterPin.sha256, diff.after.publicationSha256);
  const after = afterPin.publication;
  assert.equal(canonical(after.transport), transportConfig);
  assert.equal(after.implementation, changed.publication.implementation);
  assert.equal(after.protocolSha256, changed.publication.protocolSha256);
  assert.equal(after.registration, changed.publication.registration);
  assert.equal(canonical(after.source), canonical(changed.publication.source));

  const reader = await createArchiveGraphReader({
    publications: input.beforePublicationPaths,
    readScope: 'source-root',
  });
  const { records, revisionSetId } = await readAllGraphRecords(
    reader,
    input.beforeGraphId,
    before.map((item) => item.source),
  );
  const expectedRevisionSetId = hash(
    canonical({
      schema: 1,
      selections: before
        .map((item) => ({
          source_id: item.source.id,
          generation: item.generation,
          manifest_sha256: item.manifestSha256,
        }))
        .sort((a, b) => a.source_id.localeCompare(b.source_id)),
    }),
  );
  assert.equal(
    revisionSetId,
    expectedRevisionSetId,
    'Graph has a different RevisionSet',
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
  const retired = new Set(historicalOnly);
  const live = records.filter((record) => !retired.has(record.id));
  const reviewReasons = new Map<
    string,
    'changed-or-removed-anchor' | 'dependent-endpoint'
  >();
  for (const record of live) {
    const anchors =
      record.kind === 'entity' || record.kind === 'mention'
        ? (record.anchors ?? [])
        : [...(record.support ?? []), ...(record.contrary ?? [])];
    if (
      anchors.some(
        (anchor) =>
          anchor.source_id === input.changedSourceId &&
          changedPaths.has(anchor.path),
      )
    )
      reviewReasons.set(record.id, 'changed-or-removed-anchor');
  }
  for (const record of live) {
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
  const needRepin = live
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
  const receipt: ArchiveMultisourceGraphImpactReceipt = {
    schema: 1,
    kind: 'temari-archive-multisource-graph-impact-plan',
    status: 'plan-only',
    policy: 'pinned-multisource-one-change-v1',
    changedSourceId: input.changedSourceId,
    before: beforePins
      .map(pin)
      .sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
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
    graphMutation: 'none',
  };
  assert(
    Buffer.byteLength(canonical(receipt)) <= 1_048_576,
    'Graph impact receipt exceeds durable artifact budget',
  );

  // Refuse if either the retained inputs or current local admission changed
  // while the review queue was assembled.
  const finalPins = await Promise.all(
    [...input.beforePublicationPaths, input.afterPublicationPath].map(
      pinnedPublication,
    ),
  );
  for (let i = 0; i < beforePins.length; i++)
    assert.equal(
      finalPins[i].sha256,
      beforePins[i].sha256,
      'Before publication changed',
    );
  assert.equal(
    finalPins.at(-1)?.sha256,
    afterPin.sha256,
    'After publication changed',
  );
  const finalDiff = await readJsonWithBytes(diffReceiptPath);
  assert.equal(
    hash(finalDiff.bytes),
    diffReceiptSha256,
    'Generation diff changed',
  );
  const transport = await archiveTransport(changed.publication.transport);
  for (const publication of before) {
    assert.equal(
      await registrationFor(transport, publication.source),
      publication.registration,
      'Current source admission changed',
    );
  }
  const finalGraph = await reader.read({
    graphId: input.beforeGraphId,
    scope: before.map((item) => item.source),
    limit: 1,
    maxBytes: 1_048_576,
    cursor: null,
  });
  assert(
    finalGraph.ok && finalGraph.value.revisionSetId === revisionSetId,
    'Old graph changed or became unavailable during planning',
  );
  const receiptPath = join(
    after.task.directory,
    `archive-graph-multisource-impact-${hash(canonical(receipt))}.json`,
  );
  await publishJson(receiptPath, receipt);
  return { receiptPath, receipt };
}
