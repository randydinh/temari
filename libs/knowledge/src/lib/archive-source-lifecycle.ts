/** An operator-triggered handoff between two complete captures of one source. */
import assert from 'node:assert/strict';
import { lstat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { canonical, digest, hash, integer, object, text } from './codec.js';
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
import { publishJson, readJsonWithBytes } from './durable.js';

export interface ArchiveSourceRecaptureInput {
  readonly beforePublicationPath: string;
  readonly after: ArchiveIntakeOptions;
  readonly beforeGraphId?: string;
}

export interface ArchiveSourceResumeInput {
  readonly beforePublicationPath: string;
  readonly resultPath: string;
  readonly beforeGraphId?: string;
}

export interface ArchiveSourceAttemptRecoveryInput {
  readonly beforePublicationPath: string;
  readonly beforePublicationSha256: string;
  readonly committedPublicationSha256: string;
  readonly attemptPath: string;
  readonly attemptSha256: string;
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

export interface ArchiveSourceResumeReceipt extends Omit<
  ArchiveSourceRecaptureReceipt,
  'kind'
> {
  readonly kind: 'temari-archive-source-resume';
  /** The persisted capture does not prove the failed caller's original v1. */
  readonly beforeSelection: 'operator-selected-on-resume';
  readonly captureAttemptSha256: string;
  readonly captureResultSha256: string;
  readonly captureBindingSha256: string;
}

export interface ArchiveSourceResumeOutcome {
  readonly status: 'handoff';
  readonly capture: ArchiveIntakeOutcome;
  readonly receiptPath: string;
  readonly receipt: ArchiveSourceResumeReceipt;
}

export interface ArchiveSourceAttemptRecoveryOutcome extends ArchiveSourceResumeOutcome {
  readonly recovery: 'existing-result' | 'reconstructed-result';
  readonly originalAttemptPath: string;
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

async function exactArtifact(path: string): Promise<{
  value: unknown;
  sha256: string;
}> {
  const { value, bytes } = await readJsonWithBytes(path);
  assert.equal(
    bytes.toString('utf8'),
    canonical(value),
    'Persisted artifact is not canonical',
  );
  return { value, sha256: hash(bytes) };
}

function observedMicros(value: unknown): bigint {
  const timestamp = text(value);
  const parts =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.(\d{1,6}))?(?:Z|[+-]\d{2}:\d{2})$/.exec(
      timestamp,
    );
  assert(parts, 'Unsupported archive observation timestamp');
  const millis = Date.parse(timestamp);
  assert(Number.isSafeInteger(millis), 'Invalid archive observation timestamp');
  const fractionMicros = Number((parts[1] ?? '').padEnd(6, '0'));
  // Date keeps milliseconds; restore the remaining Registrar microseconds.
  return BigInt(millis) * 1000n + BigInt(fractionMicros % 1000);
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

async function validateSelection(
  beforePublicationPath: string,
  after: ArchiveIntakeOptions,
  beforeGraphId: string | undefined,
  requireUnusedBinding: boolean,
): Promise<{
  before: ArchivePublication;
  beforePin: ArchiveGenerationDiffPin;
  transport: Awaited<ReturnType<typeof archiveTransport>>;
  captureRequestKey: string;
  binding: string;
  observedAt: string;
}> {
  const { publication: before, pin: beforePin } = await exactPublication(
    beforePublicationPath,
  );
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
  if (requireUnusedBinding)
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
    (await exactPublication(beforePublicationPath)).pin.publicationSha256,
    beforePin.publicationSha256,
    'Prior publication changed before capture',
  );
  if (beforeGraphId !== undefined) {
    const reader = await createArchiveGraphReader({
      publications: [beforePublicationPath],
      readScope: 'source-root',
    });
    const graph = await reader.read({
      graphId: beforeGraphId,
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
  if (requireUnusedBinding)
    await unusedBinding(
      join(after.task.directory, `archive-binding-${binding}.json`),
    );

  return {
    before,
    beforePin,
    transport,
    captureRequestKey,
    binding,
    observedAt: text(priorInspect['observed_at']),
  };
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
  const { before, beforePin, transport, captureRequestKey } =
    await validateSelection(
      input.beforePublicationPath,
      after,
      input.beforeGraphId,
      true,
    );

  const capture = await captureArchive(after);
  if (capture.status === 'blocked')
    return { status: 'blocked', capture, reason: 'capture-blocked' };
  if (capture.preservation !== 'complete-admitted')
    return { status: 'blocked', capture, reason: 'incomplete-preservation' };
  assert(capture.publicationPath);

  return finishHandoff({
    beforePublicationPath: input.beforePublicationPath,
    beforeGraphId: input.beforeGraphId,
    before,
    beforePin,
    after,
    transport,
    captureRequestKey,
    capture,
  });
}

/**
 * Operator-selected v1 handoff from an already complete persisted v2 result.
 * The capture artifacts do not record the v1 selected by a failed caller.
 * This path never calls Registrar capture or creates another attempt.
 */
export async function resumeArchiveSourceHandoff(
  input: ArchiveSourceResumeInput,
): Promise<ArchiveSourceResumeOutcome> {
  assert.deepEqual(
    Object.keys(input).sort(),
    (input.beforeGraphId === undefined
      ? ['beforePublicationPath', 'resultPath']
      : ['beforeGraphId', 'beforePublicationPath', 'resultPath']
    ).sort(),
  );
  if (input.beforeGraphId !== undefined) digest(input.beforeGraphId);
  assert(isAbsolute(input.resultPath), 'Absolute capture result path required');
  const resultId =
    /^archive-result-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/.exec(
      basename(input.resultPath),
    );
  assert(resultId, 'Canonical capture result name required');
  const attemptPath = join(
    dirname(input.resultPath),
    `archive-attempt-${resultId[1]}.json`,
  );
  const resultArtifact = await exactArtifact(input.resultPath);
  const result = object(resultArtifact.value);
  assert.deepEqual(
    Object.keys(result).sort(),
    [
      'status',
      'publicationPath',
      'preservation',
      'gaps',
      'attemptPath',
      'resultPath',
    ].sort(),
    'Unexpected capture result shape',
  );
  assert.equal(
    result['status'],
    'published',
    'Complete published capture result required',
  );
  assert.equal(
    result['preservation'],
    'complete-admitted',
    'Complete v2 preservation required',
  );
  assert.equal(
    result['resultPath'],
    input.resultPath,
    'Capture result path mismatch',
  );
  assert.equal(
    result['attemptPath'],
    attemptPath,
    'Capture attempt path mismatch',
  );
  const attemptArtifact = await exactArtifact(attemptPath);
  const attempt = object(attemptArtifact.value);
  assert.deepEqual(
    Object.keys(attempt).sort(),
    ['schema', 'kind', 'options', 'state'].sort(),
    'Unexpected capture attempt shape',
  );
  assert.equal(attempt['schema'], 1);
  assert.equal(attempt['kind'], 'temari-archive-attempt');
  assert.equal(attempt['state'], 'started');
  const after = object(attempt['options']) as unknown as ArchiveIntakeOptions;
  const permitted = [
    'task',
    'source',
    'readScope',
    'transport',
    'requestKey',
    ...(after.ocrMode === undefined ? [] : ['ocrMode']),
    ...(after.limits === undefined ? [] : ['limits']),
  ];
  assert.deepEqual(
    Object.keys(after).sort(),
    permitted.sort(),
    'Unexpected attempt options',
  );
  assert.equal(
    after.task.directory,
    dirname(input.resultPath),
    'Capture task directory mismatch',
  );
  const selected = await validateSelection(
    input.beforePublicationPath,
    after,
    input.beforeGraphId,
    false,
  );
  const {
    before,
    beforePin,
    transport,
    captureRequestKey,
    binding,
    observedAt,
  } = selected;
  const publicationPath = join(
    after.task.directory,
    `archive-publication-${binding}.json`,
  );
  assert.equal(
    result['publicationPath'],
    publicationPath,
    'Capture publication path mismatch',
  );
  const { publication: publishedAfter, pin: afterPin } =
    await exactPublication(publicationPath);
  assert.equal(
    publishedAfter.rebind,
    undefined,
    'Original capture publication required',
  );
  assert.equal(publishedAfter.preservation, 'complete-admitted');
  assert.equal(publishedAfter.captureRequestKey, captureRequestKey);
  assert.equal(
    canonical(publishedAfter.gaps),
    canonical(result['gaps']),
    'Capture result gaps changed',
  );
  assert.equal(canonical(publishedAfter.task), canonical(after.task));
  assert.equal(canonical(publishedAfter.source), canonical(after.source));
  assert.equal(
    canonical(publishedAfter.transport),
    canonical(transport.config),
  );
  assert.equal(publishedAfter.registration, before.registration);
  assert.notEqual(afterPin.generation, beforePin.generation);

  const limits = {
    entries: 1000,
    file_bytes: 8 * 1024 * 1024,
    total_bytes: 64 * 1024 * 1024,
    text_bytes: 8 * 1024 * 1024,
    ...after.limits,
  };
  assert.deepEqual(
    Object.keys(limits).sort(),
    ['entries', 'file_bytes', 'total_bytes', 'text_bytes'].sort(),
    'Invalid capture limits',
  );
  assert(after.ocrMode === undefined || after.ocrMode === 'macos-vision');
  const expectedBinding = {
    schema: 1,
    task: after.task,
    source: after.source,
    readScope: after.readScope,
    limits,
    captureRequestKey,
    transport: transport.config,
    implementation: transport.implementation,
    protocolSha256: transport.protocolSha256,
    registration: before.registration,
    ...(after.ocrMode ? { ocrMode: after.ocrMode } : {}),
  };
  const bindingArtifact = await exactArtifact(
    join(after.task.directory, `archive-binding-${binding}.json`),
  );
  assert.equal(
    canonical(bindingArtifact.value),
    canonical(expectedBinding),
    'Persisted capture binding settings changed',
  );

  const afterInspect = await transport.invoke('inspect', [
    after.source.id,
    afterPin.generation,
    '--manifest-sha256',
    afterPin.manifestSha256,
    '--offset',
    '0',
    '--limit',
    '1',
    '--max-bytes',
    String(transport.config.maxStdoutBytes),
  ]);
  snapshot(afterInspect, publishedAfter);
  assert.equal(afterInspect['status'], 'complete');
  assert.equal(afterInspect['request_key'], captureRequestKey);
  assert.equal(
    afterInspect['request_fingerprint'],
    publishedAfter.captureFingerprint,
  );
  assert.equal(afterInspect['preservation'], 'complete-admitted');
  assert.equal(
    canonical(afterInspect['counts']),
    canonical(publishedAfter.counts),
  );
  assert(
    observedMicros(observedAt) < observedMicros(afterInspect['observed_at']),
    'Operator-selected v1 does not predate persisted v2 capture',
  );

  const capture = result as unknown as ArchiveIntakeOutcome;
  return finishHandoff({
    beforePublicationPath: input.beforePublicationPath,
    beforeGraphId: input.beforeGraphId,
    before,
    beforePin,
    after,
    transport,
    captureRequestKey,
    capture,
    resumePins: {
      captureAttemptSha256: attemptArtifact.sha256,
      captureResultSha256: resultArtifact.sha256,
      captureBindingSha256: bindingArtifact.sha256,
    },
  });
}

/**
 * Reconcile one caller-pinned original attempt only when its original,
 * complete Temari publication already exists and Registrar verifies its
 * generation, manifest and counts. Gap/capability metadata is caller-pinned
 * local publication metadata, not independently rederived from Registrar.
 * A missing publication is unknown and never triggers a capture probe.
 * This does not cover crashes before publication or make handoff atomic.
 */
export async function recoverArchiveSourceAttempt(
  input: ArchiveSourceAttemptRecoveryInput,
): Promise<ArchiveSourceAttemptRecoveryOutcome> {
  assert.deepEqual(
    Object.keys(input).sort(),
    (input.beforeGraphId === undefined
      ? [
          'beforePublicationPath',
          'beforePublicationSha256',
          'committedPublicationSha256',
          'attemptPath',
          'attemptSha256',
        ]
      : [
          'beforePublicationPath',
          'beforePublicationSha256',
          'committedPublicationSha256',
          'attemptPath',
          'attemptSha256',
          'beforeGraphId',
        ]
    ).sort(),
  );
  digest(input.beforePublicationSha256);
  digest(input.committedPublicationSha256);
  digest(input.attemptSha256);
  if (input.beforeGraphId !== undefined) digest(input.beforeGraphId);
  assert(
    isAbsolute(input.attemptPath),
    'Absolute capture attempt path required',
  );
  const attemptId =
    /^archive-attempt-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/.exec(
      basename(input.attemptPath),
    );
  assert(attemptId, 'Canonical capture attempt name required');
  const attemptArtifact = await exactArtifact(input.attemptPath);
  assert.equal(
    attemptArtifact.sha256,
    input.attemptSha256,
    'Pinned original capture attempt changed',
  );
  const attempt = object(attemptArtifact.value);
  assert.deepEqual(
    Object.keys(attempt).sort(),
    ['schema', 'kind', 'options', 'state'].sort(),
    'Unexpected capture attempt shape',
  );
  assert.equal(attempt['schema'], 1);
  assert.equal(attempt['kind'], 'temari-archive-attempt');
  assert.equal(attempt['state'], 'started');
  const after = object(attempt['options']) as unknown as ArchiveIntakeOptions;
  assert.deepEqual(
    Object.keys(after).sort(),
    [
      'task',
      'source',
      'readScope',
      'transport',
      'requestKey',
      ...(after.ocrMode === undefined ? [] : ['ocrMode']),
      ...(after.limits === undefined ? [] : ['limits']),
    ].sort(),
    'Unsupported recovery attempt options; PDF worker attempts require separate handling',
  );
  assert.equal(after.task.directory, dirname(input.attemptPath));
  const beforeArtifact = await exactPublication(input.beforePublicationPath);
  assert.equal(
    beforeArtifact.pin.publicationSha256,
    input.beforePublicationSha256,
    'Pinned prior publication changed',
  );
  const selected = await validateSelection(
    input.beforePublicationPath,
    after,
    input.beforeGraphId,
    false,
  );
  const { before, transport, captureRequestKey, binding } = selected;
  const limits = {
    entries: 1000,
    file_bytes: 8 * 1024 * 1024,
    total_bytes: 64 * 1024 * 1024,
    text_bytes: 8 * 1024 * 1024,
    ...after.limits,
  };
  assert.deepEqual(
    Object.keys(limits).sort(),
    ['entries', 'file_bytes', 'total_bytes', 'text_bytes'].sort(),
  );
  for (const [key, max] of Object.entries({
    entries: 1000,
    file_bytes: 8 * 1024 * 1024,
    total_bytes: 64 * 1024 * 1024,
    text_bytes: 8 * 1024 * 1024,
  }))
    integer(limits[key as keyof typeof limits], 1, max);
  const expectedBinding = {
    schema: 1,
    task: after.task,
    source: after.source,
    readScope: after.readScope,
    limits,
    captureRequestKey,
    transport: transport.config,
    implementation: transport.implementation,
    protocolSha256: transport.protocolSha256,
    registration: before.registration,
    ...(after.ocrMode ? { ocrMode: after.ocrMode } : {}),
  };
  const bindingArtifact = await exactArtifact(
    join(after.task.directory, `archive-binding-${binding}.json`),
  );
  assert.equal(
    canonical(bindingArtifact.value),
    canonical(expectedBinding),
    'Persisted capture binding settings changed',
  );
  const committedPath = join(
    after.task.directory,
    `archive-publication-${binding}.json`,
  );
  let committedRaw: Awaited<ReturnType<typeof exactArtifact>>;
  try {
    committedRaw = await exactArtifact(committedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error(
        'Original complete publication missing; recovery requires review',
      );
    throw error;
  }
  assert.equal(
    committedRaw.sha256,
    input.committedPublicationSha256,
    'Pinned committed publication changed',
  );
  const siblingResultPath = join(
    after.task.directory,
    `archive-result-${attemptId[1]}.json`,
  );
  let sibling: Awaited<ReturnType<typeof exactArtifact>> | null = null;
  try {
    sibling = await exactArtifact(siblingResultPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (sibling) {
    const status = object(sibling.value)['status'];
    assert.equal(status, 'published', 'Existing capture result needs review');
    const resumed = await resumeArchiveSourceHandoff({
      beforePublicationPath: input.beforePublicationPath,
      resultPath: siblingResultPath,
      ...(input.beforeGraphId ? { beforeGraphId: input.beforeGraphId } : {}),
    });
    assert.equal(
      (await exactArtifact(input.attemptPath)).sha256,
      input.attemptSha256,
    );
    return {
      ...resumed,
      recovery: 'existing-result',
      originalAttemptPath: input.attemptPath,
    };
  }
  let committedArtifact: Awaited<ReturnType<typeof exactPublication>>;
  try {
    committedArtifact = await exactPublication(committedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error(
        'Original complete publication missing; recovery requires review',
      );
    throw error;
  }
  assert.equal(
    committedArtifact.pin.publicationSha256,
    input.committedPublicationSha256,
    'Pinned committed publication changed during validation',
  );
  const committed = committedArtifact.publication;
  assert.equal(
    committed.rebind,
    undefined,
    'Original capture publication required',
  );
  assert.equal(committed.preservation, 'complete-admitted');
  assert.equal(committed.binding, binding);
  assert.equal(committed.captureRequestKey, captureRequestKey);
  assert.equal(canonical(committed.task), canonical(after.task));
  assert.equal(canonical(committed.source), canonical(after.source));
  assert.equal(committed.readScope, after.readScope);
  assert.equal(canonical(committed.transport), canonical(transport.config));
  assert.equal(committed.implementation, transport.implementation);
  assert.equal(committed.protocolSha256, transport.protocolSha256);
  assert.equal(committed.registration, before.registration);
  const committedInspect = await transport.invoke('inspect', [
    after.source.id,
    committed.generation,
    '--manifest-sha256',
    committed.manifestSha256,
    '--offset',
    '0',
    '--limit',
    '1',
    '--max-bytes',
    String(transport.config.maxStdoutBytes),
  ]);
  snapshot(committedInspect, committed);
  assert.equal(committedInspect['status'], 'complete');
  assert.equal(committedInspect['request_key'], captureRequestKey);
  assert.equal(
    committedInspect['request_fingerprint'],
    committed.captureFingerprint,
  );
  assert.equal(committedInspect['preservation'], 'complete-admitted');
  assert.equal(
    canonical(committedInspect['counts']),
    canonical(committed.counts),
  );
  assert(
    observedMicros(selected.observedAt) <
      observedMicros(committedInspect['observed_at']),
    'Prior publication does not predate committed capture',
  );
  const published = await exactPublication(committedPath);
  assert.equal(
    published.pin.publicationSha256,
    input.committedPublicationSha256,
    'Committed publication changed before result reconstruction',
  );
  assert.equal(
    (await exactArtifact(input.attemptPath)).sha256,
    input.attemptSha256,
    'Pinned original capture attempt changed before result reconstruction',
  );
  assert.equal(
    (
      await exactArtifact(
        join(after.task.directory, `archive-binding-${binding}.json`),
      )
    ).sha256,
    bindingArtifact.sha256,
    'Original capture binding changed before result reconstruction',
  );
  assert.equal(
    (await exactPublication(input.beforePublicationPath)).pin.publicationSha256,
    input.beforePublicationSha256,
    'Pinned prior publication changed before result reconstruction',
  );
  assert.equal(
    await registrationFor(transport, before.source),
    before.registration,
    'Current source admission changed before result reconstruction',
  );
  await publishJson(siblingResultPath, {
    status: 'published',
    publicationPath: committedPath,
    preservation: committed.preservation,
    gaps: committed.gaps,
    attemptPath: input.attemptPath,
    resultPath: siblingResultPath,
  } satisfies ArchiveIntakeOutcome);
  const resumed = await resumeArchiveSourceHandoff({
    beforePublicationPath: input.beforePublicationPath,
    resultPath: siblingResultPath,
    ...(input.beforeGraphId ? { beforeGraphId: input.beforeGraphId } : {}),
  });
  return {
    ...resumed,
    recovery: 'reconstructed-result',
    originalAttemptPath: input.attemptPath,
  };
}

interface HandoffParams {
  beforePublicationPath: string;
  beforeGraphId?: string;
  before: ArchivePublication;
  beforePin: ArchiveGenerationDiffPin;
  after: ArchiveIntakeOptions;
  transport: Awaited<ReturnType<typeof archiveTransport>>;
  captureRequestKey: string;
  capture: ArchiveIntakeOutcome;
}
type ResumePins = Pick<
  ArchiveSourceResumeReceipt,
  'captureAttemptSha256' | 'captureResultSha256' | 'captureBindingSha256'
>;
async function finishHandoff(
  params: HandoffParams & { resumePins: ResumePins },
): Promise<ArchiveSourceResumeOutcome>;
async function finishHandoff(
  params: HandoffParams & { resumePins?: undefined },
): Promise<Extract<ArchiveSourceRecaptureOutcome, { status: 'handoff' }>>;
async function finishHandoff(
  params: HandoffParams & { resumePins?: ResumePins },
): Promise<
  | ArchiveSourceResumeOutcome
  | Extract<ArchiveSourceRecaptureOutcome, { status: 'handoff' }>
> {
  const {
    beforePublicationPath,
    beforeGraphId,
    before,
    beforePin,
    after,
    transport,
    captureRequestKey,
    capture,
    resumePins,
  } = params;
  assert(capture.status === 'published' && capture.publicationPath);
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
      beforePublicationPath: beforePublicationPath,
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
    if (beforeGraphId !== undefined) {
      stage = 'graph-impact';
      const impact = await planArchiveGraphImpact({
        beforePublicationPath: beforePublicationPath,
        afterPublicationPath: capture.publicationPath,
        beforeGraphId: beforeGraphId,
      });
      const receiptSha256 = await exactReceipt(
        impact.receiptPath,
        impact.receipt,
      );
      assert.deepEqual(impact.receipt.before, beforePin);
      assert.deepEqual(impact.receipt.after, afterPin);
      assert.equal(impact.receipt.diffReceiptSha256, diffReceiptSha256);
      graphImpact = {
        beforeGraphId: beforeGraphId,
        receiptPath: impact.receiptPath,
        receiptSha256,
        counts: impact.receipt.counts,
      };
      impactReceipt = impact.receipt;
    }
    stage = 'handoff';
    assert.equal(
      (await exactPublication(beforePublicationPath)).pin.publicationSha256,
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
    if (resumePins) {
      assert.equal(
        (await exactArtifact(capture.attemptPath)).sha256,
        resumePins.captureAttemptSha256,
        'Capture attempt changed during handoff',
      );
      assert.equal(
        (await exactArtifact(capture.resultPath)).sha256,
        resumePins.captureResultSha256,
        'Capture result changed during handoff',
      );
      assert.equal(
        (
          await exactArtifact(
            join(
              after.task.directory,
              `archive-binding-${hash(captureRequestKey)}.json`,
            ),
          )
        ).sha256,
        resumePins.captureBindingSha256,
        'Capture binding changed during handoff',
      );
    }
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
    const publishedReceipt:
      ArchiveSourceRecaptureReceipt | ArchiveSourceResumeReceipt = resumePins
      ? {
          ...receipt,
          kind: 'temari-archive-source-resume',
          beforeSelection: 'operator-selected-on-resume',
          ...resumePins,
        }
      : receipt;
    assert(
      Buffer.byteLength(canonical(publishedReceipt)) <= 65536,
      'Recapture receipt exceeds bound',
    );
    const receiptPath = join(
      after.task.directory,
      `${resumePins ? 'archive-source-resume' : 'archive-source-recapture'}-${hash(canonical(publishedReceipt))}.json`,
    );
    await publishJson(receiptPath, publishedReceipt, 65536);
    if (resumePins)
      return {
        status: 'handoff',
        capture,
        receiptPath,
        receipt: publishedReceipt as ArchiveSourceResumeReceipt,
      };
    return {
      status: 'handoff',
      capture,
      receiptPath,
      receipt: publishedReceipt as ArchiveSourceRecaptureReceipt,
    };
  } catch (error) {
    throw new ArchiveRecaptureHandoffError(stage, capture, error);
  }
}
