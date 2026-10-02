/** One managed, completed-audit-to-recapture cycle. No scheduler or graph writes. */
import assert from 'node:assert/strict';
import { lstat, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  FileSourceHeadStore,
  FileChildTaskStore,
  sourceHeadDigest,
  type SourceHeadCompletionProof,
  type SourceHeadPin,
} from '@temari/runtime';
import {
  loadArchivePublication,
  registrationFor,
  snapshot,
  type ArchivePublication,
} from './archive-intake.js';
import { archiveTransport } from './archive-transport.js';
import { canonical, hash, object, text } from './codec.js';
import { publishJson, readJsonWithBytes } from './durable.js';
import {
  loadArchiveFreshnessJobSpec,
  loadCompletedArchiveFreshnessDecision,
} from './archive-freshness-job.js';
import {
  createArchiveRefreshHandoffSpec,
  loadArchiveRefreshHandoffSpec,
  tickArchiveRefreshHandoff,
} from './archive-refresh-handoff.js';

const LEDGER = 'archive-source-head-ledger';
const MAX_TASK_ENTRIES = 4096;
const MAX_ATTEMPTS = 256;
const DEFAULT_LIMITS = {
  entries: 1000,
  file_bytes: 8 * 1024 * 1024,
  total_bytes: 64 * 1024 * 1024,
  text_bytes: 8 * 1024 * 1024,
};

export interface ArchiveSourceCyclePlan {
  readonly freshnessSpecPath: string;
  readonly beforeGraphId?: string;
}
export type ArchiveSourceCycleResult =
  | { readonly status: 'observed-unchanged'; readonly ledgerTouched: false }
  | { readonly status: 'audit-needs-review'; readonly ledgerTouched: false }
  | {
      readonly status: 'reserved' | 'held';
      readonly ledgerTouched: true;
      readonly reservationId: string;
      readonly refreshSpecPath: string | null;
    }
  | {
      readonly status: 'advanced';
      readonly ledgerTouched: true;
      readonly reservationId: string;
      readonly refreshSpecPath: string;
      readonly afterPublicationPath: string;
      readonly proofPath: string;
      readonly graphImpactReceiptPath: string | null;
    };

async function exactPublication(path: string) {
  const publication = await loadArchivePublication(path);
  const artifact = await readJsonWithBytes(path, 65536);
  assert.equal(
    artifact.bytes.toString('utf8'),
    canonical(publication),
    'Noncanonical selected publication',
  );
  return { publication, sha256: hash(artifact.bytes) };
}
function pinFor(
  path: string,
  publication: ArchivePublication,
  sha256: string,
): SourceHeadPin {
  return {
    sourceId: publication.source.id,
    sourceLocator: publication.source.locator,
    taskId: publication.task.id,
    taskDirectory: publication.task.directory,
    publicationPath: path,
    publicationSha256: sha256,
    generation: publication.generation,
    manifestSha256: publication.manifestSha256,
    registrationSha256: sourceHeadDigest(publication.registration),
    captureRequestKey: publication.captureRequestKey,
  };
}
async function assertCurrentAdmission(publication: ArchivePublication) {
  const transport = await archiveTransport(publication.transport);
  assert.equal(transport.implementation, publication.implementation);
  assert.equal(transport.protocolSha256, publication.protocolSha256);
  assert.equal(
    await registrationFor(transport, publication.source),
    publication.registration,
    'Current registration changed',
  );
  const inspected = await transport.invoke('inspect', [
    publication.source.id,
    publication.generation,
    '--manifest-sha256',
    publication.manifestSha256,
    '--offset',
    '0',
    '--limit',
    '1',
  ]);
  snapshot(inspected, publication);
  assert.equal(inspected['request_key'], publication.captureRequestKey);
  assert.equal(inspected['preservation'], 'complete-admitted');
}
async function assertDefaultCapturePolicy(
  path: string,
  publication: ArchivePublication,
) {
  assert.equal(
    publication.rebind,
    undefined,
    'Rebound prior capture needs review',
  );
  assert.equal(
    publication.pdfWorkerProfileSha256,
    undefined,
    'PDF worker profile cannot be silently dropped',
  );
  assert.equal(
    publication.capabilities['ocr'],
    'unsupported',
    'OCR policy cannot be silently dropped',
  );
  const bindingPath = join(
    publication.task.directory,
    `archive-binding-${hash(publication.captureRequestKey)}.json`,
  );
  const bindingArtifact = await readJsonWithBytes(bindingPath, 65536);
  assert.equal(
    bindingArtifact.bytes.toString('utf8'),
    canonical(bindingArtifact.value),
  );
  const binding = object(bindingArtifact.value);
  assert.equal(binding['ocrMode'], undefined);
  assert.equal(binding['pdfWorkerProfile'], undefined);
  assert.equal(
    canonical(binding['limits']),
    canonical(DEFAULT_LIMITS),
    'Custom capture limits cannot be silently dropped',
  );

  let entries = 0,
    attempts = 0;
  const matches: string[] = [];
  for await (const item of await opendir(publication.task.directory)) {
    assert(++entries <= MAX_TASK_ENTRIES, 'Task directory scan bound exceeded');
    if (!/^archive-attempt-[a-f0-9-]{36}\.json$/.test(item.name)) continue;
    assert(++attempts <= MAX_ATTEMPTS, 'Archive attempt scan bound exceeded');
    const attemptPath = join(publication.task.directory, item.name);
    const artifact = await readJsonWithBytes(attemptPath, 65536);
    assert.equal(artifact.bytes.toString('utf8'), canonical(artifact.value));
    const attempt = object(artifact.value);
    assert.equal(attempt['schema'], 1);
    assert.equal(attempt['kind'], 'temari-archive-attempt');
    assert.equal(attempt['state'], 'started');
    const options = object(attempt['options']);
    const requestKey = text(options['requestKey']);
    const candidate = `temari-archive-v1:${hash(canonical({ task: options['task'], key: requestKey }))}`;
    if (candidate !== publication.captureRequestKey) continue;
    assert.deepEqual(
      Object.keys(options).sort(),
      ['task', 'source', 'readScope', 'transport', 'requestKey'].sort(),
      'Prior capture settings cannot be silently dropped',
    );
    assert.equal(canonical(options['task']), canonical(publication.task));
    assert.equal(canonical(options['source']), canonical(publication.source));
    assert.equal(options['readScope'], publication.readScope);
    const transport = await archiveTransport(
      options['transport'] as ArchivePublication['transport'],
    );
    assert.equal(canonical(transport.config), canonical(publication.transport));
    const resultPath = join(
      publication.task.directory,
      `archive-result-${item.name.slice('archive-attempt-'.length, -'.json'.length)}.json`,
    );
    const resultArtifact = await readJsonWithBytes(resultPath, 65536);
    assert.equal(
      resultArtifact.bytes.toString('utf8'),
      canonical(resultArtifact.value),
    );
    const result = object(resultArtifact.value);
    assert.equal(result['status'], 'published');
    assert.equal(result['attemptPath'], attemptPath);
    assert.equal(result['resultPath'], resultPath);
    assert.equal(result['publicationPath'], path);
    matches.push(attemptPath);
  }
  assert.equal(matches.length, 1, 'One original completed attempt required');
}

function cycleKey(input: {
  readonly freshnessSpecPath: string;
  readonly freshnessSpecSha256: string;
  readonly freshnessStagePath: string;
  readonly freshnessStageSha256: string;
  readonly prior: SourceHeadPin;
  readonly beforeGraphId: string | null;
}): string {
  return sourceHeadDigest({
    schema: 1,
    kind: 'temari-managed-source-cycle',
    ...input,
  });
}

async function holdReserved(
  store: FileSourceHeadStore,
  before: SourceHeadPin,
  key: string,
  reason: 'unknown-outcome' | 'admission-changed',
): Promise<void> {
  const current = await store.load(before.sourceId);
  if (
    current?.status === 'RESERVED' &&
    current.reservation.id === sourceHeadDigest({ before, cycleKey: key })
  )
    await store.hold(before, key, reason);
}

async function holdEarlierReservationOnAdmissionChange(specPath: string) {
  const spec = await loadArchiveFreshnessJobSpec(specPath);
  const prior = await exactPublication(spec.publicationPath);
  try {
    await assertCurrentAdmission(prior.publication);
  } catch {
    const root = join(prior.publication.task.directory, LEDGER);
    try {
      await lstat(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const store = await FileSourceHeadStore.create(root);
    const before = pinFor(
      spec.publicationPath,
      prior.publication,
      prior.sha256,
    );
    const current = await store.load(before.sourceId);
    if (
      current?.status === 'RESERVED' &&
      canonical(current.head) === canonical(before)
    )
      await store.hold(
        before,
        current.reservation.cycleKey,
        'admission-changed',
      );
  }
}

async function linkedRefreshBlocked(
  refreshSpec: Awaited<ReturnType<typeof loadArchiveRefreshHandoffSpec>>,
): Promise<boolean> {
  const id = `archive-refresh-${hash(canonical({ sourceId: refreshSpec.sourceId, beforePublicationSha256: refreshSpec.beforePublicationSha256 })).slice(0, 32)}`;
  const tasks = await FileChildTaskStore.create(
    join(refreshSpec.after.task.directory, 'archive-refresh-child-tasks'),
  );
  return (await tasks.load(id))?.status === 'BLOCKED';
}

/** The completed read-only audit precedes reservation. Only one winning
 * reservation for this prior publication may start the linked refresh.
 */
export async function tickArchiveSourceCycle(
  plan: ArchiveSourceCyclePlan,
): Promise<ArchiveSourceCycleResult> {
  assert.deepEqual(
    Object.keys(plan).sort(),
    (plan.beforeGraphId === undefined
      ? ['freshnessSpecPath']
      : ['freshnessSpecPath', 'beforeGraphId']
    ).sort(),
    'Invalid source cycle plan',
  );
  if (plan.beforeGraphId !== undefined)
    assert(/^[a-f0-9]{64}$/.test(plan.beforeGraphId), 'Invalid graph pin');
  let decision: Awaited<
    ReturnType<typeof loadCompletedArchiveFreshnessDecision>
  >;
  try {
    decision = await loadCompletedArchiveFreshnessDecision(
      plan.freshnessSpecPath,
    );
  } catch (error) {
    await holdEarlierReservationOnAdmissionChange(plan.freshnessSpecPath);
    throw error;
  }
  if (decision.decision === 'unchanged')
    return { status: 'observed-unchanged', ledgerTouched: false };
  if (decision.decision === 'unknown-needs-review')
    return { status: 'audit-needs-review', ledgerTouched: false };
  const prior = await exactPublication(decision.publicationPath);
  assert.equal(prior.sha256, decision.publicationSha256);
  assert.equal(prior.publication.preservation, 'complete-admitted');
  await assertDefaultCapturePolicy(decision.publicationPath, prior.publication);
  await assertCurrentAdmission(prior.publication);
  const before = pinFor(
    decision.publicationPath,
    prior.publication,
    prior.sha256,
  );
  const key = cycleKey({
    freshnessSpecPath: decision.specPath,
    freshnessSpecSha256: decision.specSha256,
    freshnessStagePath: decision.stagePath,
    freshnessStageSha256: decision.stageSha256,
    prior: before,
    beforeGraphId: plan.beforeGraphId ?? null,
  });
  const reservationId = sourceHeadDigest({ before, cycleKey: key });
  const ledgerRoot = join(prior.publication.task.directory, LEDGER);
  const store = await FileSourceHeadStore.create(ledgerRoot);
  const initialized =
    (await store.load(before.sourceId)) ?? (await store.initialize(before));
  const replayAfterAdvance =
    initialized.status === 'READY' &&
    initialized.head.publicationSha256 !== before.publicationSha256;
  if (replayAfterAdvance) {
    const terminalPath = join(
      ledgerRoot,
      sourceHeadDigest(before.sourceId),
      `terminal-${before.publicationSha256}.json`,
    );
    const terminalArtifact = await readJsonWithBytes(terminalPath, 65536);
    assert.equal(
      terminalArtifact.bytes.toString('utf8'),
      canonical(terminalArtifact.value),
    );
    const terminal = object(terminalArtifact.value);
    assert.equal(terminal['kind'], 'temari-source-head-advance');
    assert.equal(terminal['reservationId'], reservationId);
    assert.equal(canonical(terminal['before']), canonical(before));
    assert.equal(
      canonical(terminal['after']),
      canonical(initialized.head),
      'Historical cycle is no longer the managed head',
    );
  }
  if (initialized.status === 'HELD') {
    assert.equal(
      initialized.hold.requestKey,
      key,
      'Source head held by another cycle',
    );
    return {
      status: 'held',
      ledgerTouched: true,
      reservationId,
      refreshSpecPath: null,
    };
  }
  if (!replayAfterAdvance) {
    const reserved = await store.reserve(before, key);
    assert.equal(reserved.status, 'RESERVED');
    assert.equal(reserved.reservation.id, reservationId);
  }
  let refreshSpecPath: string;
  try {
    refreshSpecPath = await createArchiveRefreshHandoffSpec({
      freshnessSpecPath: plan.freshnessSpecPath,
      ...(plan.beforeGraphId ? { beforeGraphId: plan.beforeGraphId } : {}),
    });
  } catch (error) {
    if (!replayAfterAdvance) {
      try {
        await assertCurrentAdmission(prior.publication);
      } catch {
        await holdReserved(store, before, key, 'admission-changed');
      }
    }
    throw error;
  }
  const refreshSpec = await loadArchiveRefreshHandoffSpec(refreshSpecPath);
  const refreshStagePath = join(
    refreshSpec.after.task.directory,
    `archive-refresh-stage-${hash(canonical(refreshSpec))}.json`,
  );
  if (replayAfterAdvance) {
    // A completed source-head transition may be replayed, but must never
    // initiate a second linked capture from the older publication.
    await readJsonWithBytes(refreshStagePath, 65536);
  } else {
    const current = await store.load(before.sourceId);
    assert.equal(current?.status, 'RESERVED');
    assert.equal(current.reservation.id, reservationId);
    const rechecked = await loadCompletedArchiveFreshnessDecision(
      plan.freshnessSpecPath,
    );
    assert.equal(rechecked.stageSha256, decision.stageSha256);
    const repinned = await exactPublication(decision.publicationPath);
    assert.equal(repinned.sha256, prior.sha256);
    await assertCurrentAdmission(repinned.publication);
  }
  let refresh: Awaited<ReturnType<typeof tickArchiveRefreshHandoff>>;
  try {
    refresh = await tickArchiveRefreshHandoff(refreshSpecPath);
  } catch (error) {
    if (!replayAfterAdvance && (await linkedRefreshBlocked(refreshSpec)))
      await holdReserved(store, before, key, 'unknown-outcome');
    throw error;
  }
  if (refresh.status === 'BLOCKED') {
    assert(!replayAfterAdvance);
    await holdReserved(store, before, key, 'unknown-outcome');
    const held = await store.load(before.sourceId);
    assert.equal(held?.status, 'HELD', 'Blocked cycle was not held');
    assert.equal(held.hold.requestKey, key);
    return {
      status: 'held',
      ledgerTouched: true,
      reservationId,
      refreshSpecPath,
    };
  }
  if (refresh.status !== 'ISSUES') {
    assert(!replayAfterAdvance);
    const pending = await store.load(before.sourceId);
    assert.equal(pending?.status, 'RESERVED', 'Pending cycle lost reservation');
    assert.equal(pending.reservation.id, reservationId);
    return {
      status: 'reserved',
      ledgerTouched: true,
      reservationId,
      refreshSpecPath,
    };
  }
  assert.equal(refresh.stagePath, refreshStagePath);
  assert(refresh.handoffReceiptPath);
  const stageArtifact = await readJsonWithBytes(refreshStagePath, 65536);
  assert.equal(
    stageArtifact.bytes.toString('utf8'),
    canonical(stageArtifact.value),
  );
  const stage = object(stageArtifact.value);
  assert.equal(stage['kind'], 'temari-archive-refresh-handoff-stage');
  assert.equal(stage['handoffReceiptPath'], refresh.handoffReceiptPath);
  assert.equal(stage['graphMutation'], 'none');
  if (plan.beforeGraphId !== undefined)
    assert(
      typeof stage['graphImpactReceiptPath'] === 'string',
      'Pinned graph impact required',
    );
  else assert.equal(stage['graphImpactReceiptPath'], null);
  const afterPath = text(stage['afterPublicationPath']);
  const after = await exactPublication(afterPath);
  assert.equal(after.sha256, stage['afterPublicationSha256']);
  assert.equal(after.publication.source.id, before.sourceId);
  assert.notEqual(after.publication.generation, before.generation);
  await assertCurrentAdmission(after.publication);
  const afterPin = pinFor(afterPath, after.publication, after.sha256);
  assert.equal(afterPin.registrationSha256, before.registrationSha256);
  const refreshedDecision = await loadCompletedArchiveFreshnessDecision(
    plan.freshnessSpecPath,
  );
  assert.equal(refreshedDecision.stageSha256, decision.stageSha256);
  await loadArchiveRefreshHandoffSpec(refreshSpecPath);
  const handoffArtifact = await readJsonWithBytes(
    refresh.handoffReceiptPath,
    65536,
  );
  assert.equal(
    handoffArtifact.bytes.toString('utf8'),
    canonical(handoffArtifact.value),
  );
  assert.equal(hash(handoffArtifact.bytes), stage['handoffReceiptSha256']);
  const proof: SourceHeadCompletionProof = {
    schema: 1,
    kind: 'temari-source-cycle-completion',
    reservationId,
    before,
    after: afterPin,
    freshnessStagePath: decision.stagePath,
    freshnessStageSha256: decision.stageSha256,
    refreshStagePath,
    refreshStageSha256: hash(stageArtifact.bytes),
    handoffReceiptPath: refresh.handoffReceiptPath,
    handoffReceiptSha256: hash(handoffArtifact.bytes),
  };
  const proofPath = join(
    before.taskDirectory,
    `archive-source-cycle-proof-${reservationId}.json`,
  );
  if (!replayAfterAdvance) {
    const current = await store.load(before.sourceId);
    assert.equal(
      current?.status,
      'RESERVED',
      'Completed cycle lost reservation',
    );
    assert.equal(current.reservation.id, reservationId);
  }
  await publishJson(proofPath, proof, 65536);
  const proofArtifact = await readJsonWithBytes(proofPath, 65536);
  assert.equal(proofArtifact.bytes.toString('utf8'), canonical(proof));
  const updated = await store.advance({
    reservationId,
    before,
    after: afterPin,
    proofPath,
    proofSha256: hash(proofArtifact.bytes),
  });
  assert.equal(updated.status, 'READY');
  assert.equal(updated.head.publicationSha256, afterPin.publicationSha256);
  return {
    status: 'advanced',
    ledgerTouched: true,
    reservationId,
    refreshSpecPath,
    afterPublicationPath: afterPath,
    proofPath,
    graphImpactReceiptPath: stage['graphImpactReceiptPath'] as string | null,
  };
}
