/** One-shot, due-gated local source audit. No recapture or hosted work. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { FileChildTaskStore, type ChildTaskStatus } from '@temari/runtime';
import { loadArchivePublication, registrationFor } from './archive-intake.js';
import { ArchiveFailure, archiveTransport } from './archive-transport.js';
import {
  auditArchiveCurrentnessPaged,
  type ArchiveCurrentnessPagedReceipt,
} from './archive-currentness.js';
import { canonical, digest, hash, integer, object, text } from './codec.js';
import { publishJson, readJsonWithBytes } from './durable.js';

const LEASE_MS = 120_000;
const MAX_ATTEMPTS = 2;
const POLICY = 'one-shot-pinned-local-currentness-v1';
type Decision = 'unchanged' | 'recapture-needed' | 'unknown-needs-review';

export interface ArchiveFreshnessJobPlan {
  readonly publicationPath: string;
  readonly notBefore: string;
  readonly policy: typeof POLICY;
}
export interface ArchiveFreshnessJobSpec extends ArchiveFreshnessJobPlan {
  readonly schema: 1;
  readonly kind: 'temari-archive-freshness-job-spec';
  readonly publicationSha256: string;
}
interface FreshnessStage {
  readonly schema: 1;
  readonly kind: 'temari-archive-freshness-job-stage';
  readonly specSha256: string;
  readonly auditReceiptPath: string;
  readonly auditReceiptSha256: string;
  readonly auditObservedAt: string;
  readonly decision: Decision;
}
export interface ArchiveFreshnessJobTickResult {
  readonly specPath: string;
  readonly taskId: string;
  readonly status: ChildTaskStatus | 'PENDING';
  readonly action:
    'none' | 'audit' | 'recover-stage' | 'retry-queued' | 'admission-refused';
  readonly decision: Decision | null;
  readonly auditObservedAt: string | null;
  readonly currentOriginal: 'not-rechecked';
  readonly stagePath: string | null;
  readonly auditReceiptPath: string | null;
}

function fields(
  value: unknown,
  expected: readonly string[],
  label: string,
): void {
  assert.deepEqual(
    Object.keys(object(value)).sort(),
    [...expected].sort(),
    `Invalid ${label} fields`,
  );
}
function dueTime(value: unknown): string {
  const date = text(value);
  assert(
    date.length === 24 &&
      Number.isFinite(Date.parse(date)) &&
      new Date(date).toISOString() === date,
    'Canonical UTC notBefore required',
  );
  return date;
}
function checkedSpec(value: unknown): ArchiveFreshnessJobSpec {
  fields(
    value,
    [
      'schema',
      'kind',
      'publicationPath',
      'publicationSha256',
      'notBefore',
      'policy',
    ],
    'freshness spec',
  );
  const spec = value as ArchiveFreshnessJobSpec;
  assert.equal(spec.schema, 1);
  assert.equal(spec.kind, 'temari-archive-freshness-job-spec');
  assert(isAbsolute(text(spec.publicationPath)));
  digest(spec.publicationSha256);
  dueTime(spec.notBefore);
  assert.equal(spec.policy, POLICY);
  return spec;
}
function specSha(spec: ArchiveFreshnessJobSpec): string {
  return hash(canonical(spec));
}
function stagePath(spec: ArchiveFreshnessJobSpec, directory: string): string {
  return join(directory, `archive-freshness-stage-${specSha(spec)}.json`);
}
function identifiers(spec: ArchiveFreshnessJobSpec) {
  const sha = specSha(spec);
  return {
    taskId: `archive-freshness-${sha.slice(0, 32)}`,
    runId: `archive-freshness-${sha.slice(0, 32)}`,
    revision: sha,
  };
}

async function publicationFor(spec: ArchiveFreshnessJobSpec) {
  const artifact = await readJsonWithBytes(spec.publicationPath);
  const publication = await loadArchivePublication(spec.publicationPath);
  assert.equal(
    artifact.bytes.toString('utf8'),
    canonical(publication),
    'Publication bytes changed',
  );
  assert.equal(
    hash(artifact.bytes),
    spec.publicationSha256,
    'Pinned publication changed',
  );
  assert.equal(
    publication.preservation,
    'complete-admitted',
    'Complete admitted archive required',
  );
  return publication;
}

/** Save a one-source, one-shot plan; this performs no source scan. */
export async function createArchiveFreshnessJobSpec(
  plan: ArchiveFreshnessJobPlan,
): Promise<string> {
  fields(plan, ['publicationPath', 'notBefore', 'policy'], 'freshness plan');
  assert(isAbsolute(text(plan.publicationPath)));
  dueTime(plan.notBefore);
  assert.equal(plan.policy, POLICY);
  const artifact = await readJsonWithBytes(plan.publicationPath);
  const publication = await loadArchivePublication(plan.publicationPath);
  assert.equal(artifact.bytes.toString('utf8'), canonical(publication));
  assert.equal(publication.preservation, 'complete-admitted');
  const spec = checkedSpec({
    schema: 1,
    kind: 'temari-archive-freshness-job-spec',
    ...plan,
    publicationSha256: hash(artifact.bytes),
  });
  const path = join(
    publication.task.directory,
    `archive-freshness-spec-${specSha(spec)}.json`,
  );
  await publishJson(path, spec);
  return path;
}

export async function loadArchiveFreshnessJobSpec(
  path: string,
): Promise<ArchiveFreshnessJobSpec> {
  assert(isAbsolute(path));
  const artifact = await readJsonWithBytes(path);
  const spec = checkedSpec(artifact.value);
  assert.equal(artifact.bytes.toString('utf8'), canonical(spec));
  const publication = await publicationFor(spec);
  assert.equal(dirname(path), publication.task.directory);
  assert.equal(basename(path), `archive-freshness-spec-${specSha(spec)}.json`);
  return spec;
}

function decide(receipt: ArchiveCurrentnessPagedReceipt): Decision {
  if (receipt.status === 'partial' || receipt.counts.unavailable > 0)
    return 'unknown-needs-review';
  if (
    receipt.counts.added + receipt.counts.removed + receipt.counts.changed >
    0
  )
    return 'recapture-needed';
  return 'unchanged';
}
function completion(decision: Decision): 'SUCCEEDED' | 'ISSUES' {
  return decision === 'unchanged' ? 'SUCCEEDED' : 'ISSUES';
}

class AdmissionBlocked extends Error {
  constructor() {
    super('Current source admission does not authorize a freshness result.');
  }
}
function isAdmissionRefusal(error: unknown): boolean {
  return (
    error instanceof AdmissionBlocked ||
    (error instanceof ArchiveFailure && error.kind === 'scope-refused') ||
    (error instanceof Error &&
      /Admitted (registration unavailable|source disabled|source locator mismatch)|Current source admission changed/.test(
        error.message,
      ))
  );
}
async function assertCurrentAdmission(
  publication: Awaited<ReturnType<typeof loadArchivePublication>>,
): Promise<void> {
  const transport = await archiveTransport(publication.transport);
  assert.equal(transport.implementation, publication.implementation);
  assert.equal(transport.protocolSha256, publication.protocolSha256);
  try {
    if (
      (await registrationFor(transport, publication.source)) !==
      publication.registration
    )
      throw new AdmissionBlocked();
  } catch (error) {
    if (isAdmissionRefusal(error)) throw new AdmissionBlocked();
    throw error;
  }
}
function summary(decision: Decision, observedAt: string): string {
  switch (decision) {
    case 'unchanged':
      return `No original changes were observed at ${observedAt}.`;
    case 'recapture-needed':
      return `Original changes observed at ${observedAt} need a separate recapture decision.`;
    case 'unknown-needs-review':
      return `Currentness gaps observed at ${observedAt} need human review.`;
  }
}

async function validateAudit(
  path: string,
  spec: ArchiveFreshnessJobSpec,
  publication: Awaited<ReturnType<typeof loadArchivePublication>>,
): Promise<{ receipt: ArchiveCurrentnessPagedReceipt; sha256: string }> {
  assert(isAbsolute(path) && dirname(path) === publication.task.directory);
  const artifact = await readJsonWithBytes(path, 8 * 1_048_576);
  const receipt = artifact.value as ArchiveCurrentnessPagedReceipt;
  assert.equal(artifact.bytes.toString('utf8'), canonical(receipt));
  const sha256 = hash(artifact.bytes);
  assert.equal(basename(path), `archive-currentness-paged-${sha256}.json`);
  assert.equal(receipt.schema, 1);
  assert.equal(receipt.kind, 'temari-archive-currentness-audit');
  assert.equal(receipt.policy, 'pinned-point-in-time-local-originals-paged-v1');
  assert.equal(receipt.publicationPath, spec.publicationPath);
  assert.equal(receipt.publicationSha256, spec.publicationSha256);
  assert.equal(receipt.sourceId, publication.source.id);
  assert.equal(receipt.generation, publication.generation);
  assert.equal(receipt.manifestSha256, publication.manifestSha256);
  assert.equal(receipt.currentOriginal, 'observed-point-in-time');
  assert.equal(receipt.consistency, 'declared-selection-not-atomic');
  assert.equal(receipt.evidence, 'point-in-time-local-observation');
  assert(
    Number.isFinite(Date.parse(text(receipt.observedAt))) &&
      receipt.observedAt.length <= 64,
    'Invalid audit observation time',
  );
  assert(receipt.status === 'complete' || receipt.status === 'partial');
  const counts = object(receipt.counts);
  fields(
    counts,
    ['added', 'removed', 'changed', 'unchanged', 'unavailable'],
    'audit counts',
  );
  for (const name of [
    'added',
    'removed',
    'changed',
    'unchanged',
    'unavailable',
  ] as const) {
    const rows = receipt[name];
    assert(Array.isArray(rows));
    assert.equal(integer(counts[name], 0, 1000), rows.length);
  }
  assert.equal(receipt.status === 'partial', receipt.counts.unavailable > 0);
  assert(Object.values(receipt.counts).reduce((sum, n) => sum + n, 0) <= 2000);
  return { receipt, sha256 };
}

async function loadStage(
  spec: ArchiveFreshnessJobSpec,
  publication: Awaited<ReturnType<typeof loadArchivePublication>>,
): Promise<FreshnessStage | null> {
  const path = stagePath(spec, publication.task.directory);
  let artifact: Awaited<ReturnType<typeof readJsonWithBytes>>;
  try {
    artifact = await readJsonWithBytes(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const stage = artifact.value as FreshnessStage;
  fields(
    stage,
    [
      'schema',
      'kind',
      'specSha256',
      'auditReceiptPath',
      'auditReceiptSha256',
      'auditObservedAt',
      'decision',
    ],
    'freshness stage',
  );
  assert.equal(artifact.bytes.toString('utf8'), canonical(stage));
  assert.equal(stage.schema, 1);
  assert.equal(stage.kind, 'temari-archive-freshness-job-stage');
  assert.equal(stage.specSha256, specSha(spec));
  const audit = await validateAudit(stage.auditReceiptPath, spec, publication);
  assert.equal(stage.auditReceiptSha256, audit.sha256);
  assert.equal(stage.auditObservedAt, audit.receipt.observedAt);
  assert.equal(stage.decision, decide(audit.receipt));
  return stage;
}

function result(
  specPath: string,
  spec: ArchiveFreshnessJobSpec,
  status: ArchiveFreshnessJobTickResult['status'],
  action: ArchiveFreshnessJobTickResult['action'],
  stage: FreshnessStage | null,
  directory: string,
): ArchiveFreshnessJobTickResult {
  return {
    specPath,
    taskId: identifiers(spec).taskId,
    status,
    action,
    decision: stage?.decision ?? null,
    auditObservedAt: stage?.auditObservedAt ?? null,
    currentOriginal: 'not-rechecked',
    stagePath: stage ? stagePath(spec, directory) : null,
    auditReceiptPath: stage?.auditReceiptPath ?? null,
  };
}

/** A tick performs at most one claimed audit; callers schedule the due tick. */
export async function tickArchiveFreshnessJob(
  specPath: string,
  options: { readonly owner?: string } = {},
): Promise<ArchiveFreshnessJobTickResult> {
  const spec = await loadArchiveFreshnessJobSpec(specPath);
  const publication = await publicationFor(spec);
  const directory = publication.task.directory;
  if (Date.now() < Date.parse(spec.notBefore))
    return result(specPath, spec, 'PENDING', 'none', null, directory);
  const owner = options.owner ?? `knowledge-${randomUUID()}`;
  text(owner);
  const ids = identifiers(spec);
  const store = await FileChildTaskStore.create(
    join(directory, 'archive-freshness-child-tasks'),
  );
  await store.create({
    taskId: ids.taskId,
    runId: ids.runId,
    revision: ids.revision,
    dependsOn: [],
    actor: owner,
  });
  let record = (await store.load(ids.taskId))!;
  let stage = await loadStage(spec, publication);
  if (record.status === 'SUCCEEDED' || record.status === 'ISSUES') {
    await assertCurrentAdmission(publication);
    assert(stage, 'Completed freshness job lacks durable stage');
    assert.equal(record.status, completion(stage.decision));
    assert.deepEqual(record.result?.evidencePaths, [
      stagePath(spec, directory),
    ]);
    return result(specPath, spec, record.status, 'none', stage, directory);
  }
  if (record.status === 'FAILED') {
    try {
      await assertCurrentAdmission(publication);
    } catch (error) {
      if (!isAdmissionRefusal(error)) throw error;
      // A failed mechanical attempt cannot complete directly. Reclaim solely
      // to record terminal admission refusal; this performs no source scan.
      await store.retry({
        taskId: ids.taskId,
        actor: owner,
        idempotencyKey: `retry-for-admission:${ids.taskId}:${record.attempt}`,
      });
      const refusal = await store.claim({
        taskId: ids.taskId,
        owner,
        leaseMs: LEASE_MS,
      });
      if (!refusal.claimed)
        return result(
          specPath,
          spec,
          refusal.record.status,
          'none',
          null,
          directory,
        );
      const held = refusal.record.lease!;
      await store.complete({
        taskId: ids.taskId,
        owner,
        leaseToken: held.token,
        fencingEpoch: held.fencingEpoch,
        status: 'BLOCKED',
        idempotencyKey: `admission-block:${ids.taskId}:${held.fencingEpoch}`,
        result: {
          status: 'BLOCKED',
          summary: 'Current source admission refused the one-shot audit.',
          evidencePaths: [specPath],
          rawLogPath: null,
        },
      });
      return result(
        specPath,
        spec,
        'BLOCKED',
        'admission-refused',
        null,
        directory,
      );
    }
    if (record.attempt >= MAX_ATTEMPTS && !stage)
      return result(specPath, spec, 'FAILED', 'none', stage, directory);
    await store.retry({
      taskId: ids.taskId,
      actor: owner,
      idempotencyKey: `retry:${ids.taskId}:${record.attempt}`,
    });
    return result(specPath, spec, 'QUEUED', 'retry-queued', stage, directory);
  }
  if (record.status === 'BLOCKED')
    return result(specPath, spec, 'BLOCKED', 'none', null, directory);
  if (record.status !== 'QUEUED' && record.status !== 'RUNNING')
    return result(specPath, spec, record.status, 'none', null, directory);
  const claim = await store.claim({
    taskId: ids.taskId,
    owner,
    leaseMs: LEASE_MS,
  });
  if (!claim.claimed) {
    if (
      claim.record.status === 'SUCCEEDED' ||
      claim.record.status === 'ISSUES'
    ) {
      stage = await loadStage(spec, publication);
      assert(stage, 'Completed freshness job lacks durable stage');
      await assertCurrentAdmission(publication);
      assert.equal(claim.record.status, completion(stage.decision));
      assert.deepEqual(claim.record.result?.evidencePaths, [
        stagePath(spec, directory),
      ]);
      return result(
        specPath,
        spec,
        claim.record.status,
        'none',
        stage,
        directory,
      );
    }
    return result(specPath, spec, claim.record.status, 'none', null, directory);
  }
  const lease = claim.record.lease!;
  let renewal: Promise<unknown> | null = null;
  let renewalError: unknown = null;
  let renewalIndex = 0;
  const timer = setInterval(() => {
    if (renewal || renewalError) return;
    renewal = store
      .renew({
        taskId: ids.taskId,
        owner,
        leaseToken: lease.token,
        fencingEpoch: lease.fencingEpoch,
        leaseMs: LEASE_MS,
        idempotencyKey: `renew:${ids.taskId}:${lease.fencingEpoch}:${++renewalIndex}`,
      })
      .catch((error: unknown) => {
        renewalError = error;
      })
      .finally(() => {
        renewal = null;
      });
  }, LEASE_MS / 3);
  let action: ArchiveFreshnessJobTickResult['action'] = 'audit';
  try {
    // Another worker may have published a stage between our first read and
    // this claim. Re-read under the lease before deciding to scan.
    stage = await loadStage(spec, publication);
    action = stage ? 'recover-stage' : 'audit';
    // Reclaiming an expired second lease may be needed to record the limit,
    // but must never start a third source scan. A saved stage can still finish.
    if (!stage && claim.record.attempt > MAX_ATTEMPTS) {
      await store.complete({
        taskId: ids.taskId,
        owner,
        leaseToken: lease.token,
        fencingEpoch: lease.fencingEpoch,
        status: 'BLOCKED',
        idempotencyKey: `attempt-limit:${ids.taskId}:${lease.fencingEpoch}`,
        result: {
          status: 'BLOCKED',
          summary:
            'Two mechanical audit attempts ended without a durable stage.',
          evidencePaths: [specPath],
          rawLogPath: null,
        },
      });
      return result(specPath, spec, 'BLOCKED', 'none', null, directory);
    }
    await assertCurrentAdmission(publication);
    if (!stage) {
      const audit = await auditArchiveCurrentnessPaged({
        publicationPath: spec.publicationPath,
      });
      const validated = await validateAudit(
        audit.receiptPath,
        spec,
        publication,
      );
      await assertCurrentAdmission(publication);
      const observed = await store.load(ids.taskId);
      assert.equal(observed?.status, 'RUNNING');
      assert.equal(
        observed.lease?.token,
        lease.token,
        'Freshness lease fenced',
      );
      assert.equal(observed.lease?.fencingEpoch, lease.fencingEpoch);
      assert(
        Date.parse(observed.lease.expiresAt) > Date.now(),
        'Freshness lease expired',
      );
      stage = {
        schema: 1,
        kind: 'temari-archive-freshness-job-stage',
        specSha256: ids.revision,
        auditReceiptPath: audit.receiptPath,
        auditReceiptSha256: validated.sha256,
        auditObservedAt: validated.receipt.observedAt,
        decision: decide(validated.receipt),
      };
      await publishJson(stagePath(spec, directory), stage);
    }
    if (renewal) await renewal;
    if (renewalError) throw renewalError;
    await store.complete({
      taskId: ids.taskId,
      owner,
      leaseToken: lease.token,
      fencingEpoch: lease.fencingEpoch,
      status: completion(stage.decision),
      idempotencyKey: `complete:${ids.taskId}:${lease.fencingEpoch}`,
      result: {
        status: stage.decision === 'unchanged' ? 'PASS' : 'ISSUES',
        summary: summary(stage.decision, stage.auditObservedAt),
        evidencePaths: [stagePath(spec, directory)],
        rawLogPath: null,
      },
    });
  } catch (error) {
    const observed = await store.load(ids.taskId);
    const admissionRefused = isAdmissionRefusal(error);
    let blocked = false;
    if (
      observed?.status === 'RUNNING' &&
      observed.lease?.token === lease.token &&
      Date.parse(observed.lease.expiresAt) > Date.now()
    ) {
      await store.complete({
        taskId: ids.taskId,
        owner,
        leaseToken: lease.token,
        fencingEpoch: lease.fencingEpoch,
        status: admissionRefused ? 'BLOCKED' : 'FAILED',
        idempotencyKey: `complete-failed:${ids.taskId}:${lease.fencingEpoch}`,
        ...(admissionRefused
          ? {
              result: {
                status: 'BLOCKED' as const,
                summary: 'Current source admission refused the one-shot audit.',
                evidencePaths: [specPath],
                rawLogPath: null,
              },
            }
          : { error: 'Freshness audit failed mechanically.' }),
      });
      blocked = admissionRefused;
    }
    if (blocked)
      return result(
        specPath,
        spec,
        'BLOCKED',
        'admission-refused',
        null,
        directory,
      );
    throw error;
  } finally {
    clearInterval(timer);
    if (renewal) await renewal;
  }
  record = (await store.load(ids.taskId))!;
  return result(specPath, spec, record.status, action, stage, directory);
}
