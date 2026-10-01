/** An operator-triggered handoff between two complete captures of one source. */
import assert from 'node:assert/strict';
import { lstat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { canonical, digest, hash } from './codec.js';
import {
  captureArchive,
  loadArchivePublication,
  registrationFor,
  snapshot,
  type ArchiveIntakeOptions,
  type ArchiveIntakeOutcome,
  type ArchivePublication,
} from './archive-intake.js';
import {
  diffArchiveGenerations,
  type ArchiveGenerationDiffPin,
  type ArchiveGenerationDiffReceipt,
} from './archive-generation-diff.js';
import { createArchiveGraphReader } from './archive-graph.js';
import {
  planArchiveGraphImpact,
  type ArchiveGraphImpactReceipt,
} from './archive-graph-impact.js';
import { archiveTransport } from './archive-transport.js';
import { publishJson, readJson, readJsonWithBytes } from './durable.js';

export interface ArchiveSourceRecaptureInput {
  readonly beforePublicationPath: string;
  readonly after: ArchiveIntakeOptions;
  readonly beforeGraphId?: string;
}

type DiffCounts = ArchiveGenerationDiffReceipt['counts'];
type ImpactCounts = ArchiveGraphImpactReceipt['counts'];

export interface ArchiveSourceRecaptureReceipt {
  readonly schema: 1;
  readonly kind: 'temari-archive-source-recapture';
  readonly status: 'handoff';
  readonly sourceId: string;
  readonly before: ArchiveGenerationDiffPin;
  readonly after: ArchiveGenerationDiffPin;
  readonly captureAttemptPath: string;
  readonly captureResultPath: string;
  readonly diff: {
    readonly receiptPath: string;
    readonly receiptSha256: string;
    readonly counts: DiffCounts;
  };
  readonly graphImpact: null | {
    readonly beforeGraphId: string;
    readonly receiptPath: string;
    readonly receiptSha256: string;
    readonly counts: ImpactCounts;
  };
  readonly currentOriginal: 'not-checked';
  readonly graphMutation: 'none';
}

export type ArchiveSourceRecaptureOutcome =
  | {
      readonly status: 'blocked';
      readonly capture: ArchiveIntakeOutcome;
      readonly reason: 'capture-blocked' | 'incomplete-preservation';
    }
  | {
      readonly status: 'handoff';
      readonly capture: ArchiveIntakeOutcome;
      readonly receiptPath: string;
      readonly receipt: ArchiveSourceRecaptureReceipt;
    };

/** A later step failed after capture; the persisted attempt and publication remain. */
export class ArchiveRecaptureHandoffError extends Error {
  constructor(
    readonly stage: 'after-validation' | 'diff' | 'graph-impact' | 'handoff',
    readonly capture: ArchiveIntakeOutcome,
    cause: unknown,
  ) {
    super(
      `Archive recapture ${stage} failed after capture; inspect persisted attempt and publication paths.`,
      { cause },
    );
  }
}

async function exactPublication(path: string): Promise<{
  publication: ArchivePublication;
  pin: ArchiveGenerationDiffPin;
}> {
  assert(isAbsolute(path), 'Absolute publication path required');
  const { bytes } = await readJsonWithBytes(path);
  const publication = await loadArchivePublication(path);
  assert.equal(
    bytes.toString('utf8'),
    canonical(publication),
    'Publication is not exact canonical v1 bytes',
  );
  return {
    publication,
    pin: {
      publicationPath: path,
      publicationSha256: hash(bytes),
      generation: publication.generation,
      manifestSha256: publication.manifestSha256,
    },
  };
}

async function exactReceipt(path: string, receipt: unknown): Promise<string> {
  const { bytes } = await readJsonWithBytes(path);
  assert.equal(
    bytes.toString('utf8'),
    canonical(receipt),
    'Receipt changed after publication',
  );
  return hash(bytes);
}

async function verifyOriginalBinding(
  publication: ArchivePublication,
): Promise<void> {
  let current = publication;
  const seen = new Set<string>();
  while (current.rebind) {
    const path = current.rebind.priorPublicationPath;
    assert(seen.size < 16 && !seen.has(path), 'Invalid publication ancestry');
    seen.add(path);
    const prior = await exactPublication(path);
    assert.equal(
      prior.pin.publicationSha256,
      current.rebind.priorPublicationSha256,
      'Prior publication pin changed',
    );
    assert.equal(
      prior.publication.binding,
      current.rebind.priorBinding,
      'Prior publication binding changed',
    );
    current = prior.publication;
  }
  assert.equal(
    hash(current.captureRequestKey),
    current.binding,
    'Original capture binding ID changed',
  );
  const binding = (await readJson(
    join(current.task.directory, `archive-binding-${current.binding}.json`),
  )) as Record<string, unknown>;
  assert.equal(binding['schema'], 1);
  for (const key of [
    'task',
    'source',
    'readScope',
    'transport',
    'implementation',
    'protocolSha256',
    'registration',
    'captureRequestKey',
  ]) {
    const fields = current as unknown as Record<string, unknown>;
    assert.equal(
      canonical(binding[key]),
      canonical(fields[key]),
      `Original capture binding ${key} changed`,
    );
  }
}

async function unusedBinding(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  assert.fail('Fresh archive request key required');
}

/**
 * Capture v2, then produce a pinned diff and optional read-only graph review.
 * This sequence is not atomic: a later refusal leaves the capture artifacts.
 * The request key identifies one logical idempotent capture. A prior binding
 * refuses sequential reuse, but concurrent calls with the same fresh key may
 * converge on that capture; this API makes no per-invocation freshness claim.
 */
export async function recaptureArchiveSource(
  input: ArchiveSourceRecaptureInput,
): Promise<ArchiveSourceRecaptureOutcome> {
  assert.deepEqual(
    Object.keys(input).sort(),
    (input.beforeGraphId === undefined
      ? ['after', 'beforePublicationPath']
      : ['after', 'beforeGraphId', 'beforePublicationPath']
    ).sort(),
  );
  if (input.beforeGraphId !== undefined) digest(input.beforeGraphId);
  const after = JSON.parse(canonical(input.after)) as ArchiveIntakeOptions;
  const { publication: before, pin: beforePin } = await exactPublication(
    input.beforePublicationPath,
  );
  await verifyOriginalBinding(before);
  assert.equal(
    before.preservation,
    'complete-admitted',
    'Complete prior preservation required',
  );
  assert.equal(
    canonical(after.task),
    canonical(before.task),
    'Recapture task changed',
  );
  assert.equal(
    canonical(after.source),
    canonical(before.source),
    'Recapture source changed',
  );
  assert.equal(
    after.readScope,
    before.readScope,
    'Recapture read scope changed',
  );
  assert(
    /^[A-Za-z0-9_.:-]{1,128}$/.test(after.requestKey),
    'Invalid recapture request key',
  );
  const captureRequestKey = `temari-archive-v1:${hash(canonical({ task: after.task, key: after.requestKey }))}`;
  assert.notEqual(
    captureRequestKey,
    before.captureRequestKey,
    'Fresh archive request key required',
  );
  const binding = hash(captureRequestKey);
  await unusedBinding(
    join(after.task.directory, `archive-binding-${binding}.json`),
  );
  const transport = await archiveTransport(after.transport);
  assert.equal(
    canonical(transport.config),
    canonical(before.transport),
    'Recapture transport scope changed',
  );
  assert.equal(
    transport.implementation,
    before.implementation,
    'Recapture implementation changed',
  );
  assert.equal(
    transport.protocolSha256,
    before.protocolSha256,
    'Recapture protocol changed',
  );
  assert.equal(
    await registrationFor(transport, before.source),
    before.registration,
    'Current source admission changed',
  );
  const priorInspect = await transport.invoke('inspect', [
    before.source.id,
    before.generation,
    '--manifest-sha256',
    before.manifestSha256,
    '--offset',
    '0',
    '--limit',
    '1',
    '--max-bytes',
    String(transport.config.maxStdoutBytes),
  ]);
  snapshot(priorInspect, before);
  assert.equal(
    priorInspect['status'],
    'complete',
    'Prior generation is not complete',
  );
  assert.equal(priorInspect['request_key'], before.captureRequestKey);
  assert.equal(priorInspect['request_fingerprint'], before.captureFingerprint);
  assert.equal(priorInspect['preservation'], 'complete-admitted');
  assert.equal(canonical(priorInspect['counts']), canonical(before.counts));
  assert.equal(
    (await exactPublication(input.beforePublicationPath)).pin.publicationSha256,
    beforePin.publicationSha256,
    'Prior publication changed before capture',
  );
  if (input.beforeGraphId !== undefined) {
    const reader = await createArchiveGraphReader({
      publications: [input.beforePublicationPath],
      readScope: 'source-root',
    });
    const graph = await reader.read({
      graphId: input.beforeGraphId,
      scope: [before.source],
      limit: 1,
      maxBytes: transport.config.maxStdoutBytes,
      cursor: null,
    });
    assert(
      graph.ok,
      'Prior graph unavailable under exact admitted source scope',
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
      graph.value.revisionSetId,
      expectedRevisionSetId,
      'Prior graph is not pinned to the complete before generation',
    );
  }
  await unusedBinding(
    join(after.task.directory, `archive-binding-${binding}.json`),
  );

  const capture = await captureArchive(after);
  if (capture.status === 'blocked')
    return { status: 'blocked', capture, reason: 'capture-blocked' };
  if (capture.preservation !== 'complete-admitted')
    return { status: 'blocked', capture, reason: 'incomplete-preservation' };
  assert(capture.publicationPath);

  let stage: ArchiveRecaptureHandoffError['stage'] = 'after-validation';
  try {
    const { publication: publishedAfter, pin: afterPin } =
      await exactPublication(capture.publicationPath);
    assert.equal(publishedAfter.captureRequestKey, captureRequestKey);
    assert.equal(publishedAfter.preservation, 'complete-admitted');
    assert.equal(canonical(publishedAfter.task), canonical(before.task));
    assert.equal(canonical(publishedAfter.source), canonical(before.source));
    assert.equal(
      canonical(publishedAfter.transport),
      canonical(before.transport),
    );
    assert.equal(publishedAfter.registration, before.registration);
    assert.notEqual(
      afterPin.generation,
      beforePin.generation,
      'Recapture reused prior generation',
    );

    stage = 'diff';
    const diff = await diffArchiveGenerations({
      beforePublicationPath: input.beforePublicationPath,
      afterPublicationPath: capture.publicationPath,
    });
    const diffReceiptSha256 = await exactReceipt(
      diff.receiptPath,
      diff.receipt,
    );
    assert.deepEqual(diff.receipt.before, beforePin);
    assert.deepEqual(diff.receipt.after, afterPin);
    let graphImpact: ArchiveSourceRecaptureReceipt['graphImpact'] = null;
    let impactReceipt: ArchiveGraphImpactReceipt | null = null;
    if (input.beforeGraphId !== undefined) {
      stage = 'graph-impact';
      const impact = await planArchiveGraphImpact({
        beforePublicationPath: input.beforePublicationPath,
        afterPublicationPath: capture.publicationPath,
        beforeGraphId: input.beforeGraphId,
      });
      const receiptSha256 = await exactReceipt(
        impact.receiptPath,
        impact.receipt,
      );
      assert.deepEqual(impact.receipt.before, beforePin);
      assert.deepEqual(impact.receipt.after, afterPin);
      assert.equal(impact.receipt.diffReceiptSha256, diffReceiptSha256);
      graphImpact = {
        beforeGraphId: input.beforeGraphId,
        receiptPath: impact.receiptPath,
        receiptSha256,
        counts: impact.receipt.counts,
      };
      impactReceipt = impact.receipt;
    }
    stage = 'handoff';
    assert.equal(
      (await exactPublication(input.beforePublicationPath)).pin
        .publicationSha256,
      beforePin.publicationSha256,
      'Prior publication changed during recapture',
    );
    assert.equal(
      (await exactPublication(capture.publicationPath)).pin.publicationSha256,
      afterPin.publicationSha256,
      'New publication changed during recapture',
    );
    assert.equal(
      await registrationFor(transport, before.source),
      before.registration,
      'Current source admission changed during recapture',
    );
    assert.equal(
      await exactReceipt(diff.receiptPath, diff.receipt),
      diffReceiptSha256,
    );
    if (graphImpact !== null && impactReceipt !== null)
      assert.equal(
        await exactReceipt(graphImpact.receiptPath, impactReceipt),
        graphImpact.receiptSha256,
        'Graph impact receipt changed during recapture',
      );
    const receipt: ArchiveSourceRecaptureReceipt = {
      schema: 1,
      kind: 'temari-archive-source-recapture',
      status: 'handoff',
      sourceId: before.source.id,
      before: beforePin,
      after: afterPin,
      captureAttemptPath: capture.attemptPath,
      captureResultPath: capture.resultPath,
      diff: {
        receiptPath: diff.receiptPath,
        receiptSha256: diffReceiptSha256,
        counts: diff.receipt.counts,
      },
      graphImpact,
      currentOriginal: 'not-checked',
      graphMutation: 'none',
    };
    assert(
      Buffer.byteLength(canonical(receipt)) <= 65536,
      'Recapture receipt exceeds bound',
    );
    const receiptPath = join(
      after.task.directory,
      `archive-source-recapture-${hash(canonical(receipt))}.json`,
    );
    await publishJson(receiptPath, receipt, 65536);
    return { status: 'handoff', capture, receiptPath, receipt };
  } catch (error) {
    throw new ArchiveRecaptureHandoffError(stage, capture, error);
  }
}
