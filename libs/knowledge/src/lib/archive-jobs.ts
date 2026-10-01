/** Explicit, resumable intake then query jobs. Runtime owns leases and transitions. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type { WorkerResult } from '@temari/contracts';
import {
  FileChildTaskStore,
  type ChildTaskRecord,
  type ChildTaskStatus,
} from '@temari/runtime';
import {
  loadArchiveHandoff,
  runArchiveIntake,
  runArchiveQuery,
  type ArchiveIntakePlan,
  type ArchiveQueryInput,
  type ArchiveQueryReport,
} from './archive-journey.js';
import { loadArchivePublication } from './archive-intake.js';
import { canonical, hash, integer, object, text } from './codec.js';
import { publishJson, readJson } from './durable.js';

const LEASE_MS = 120_000;
const MAX_ATTEMPTS = 2;
type Stage = 'intake' | 'search';
type CompletionStatus = Extract<
  ChildTaskStatus,
  'SUCCEEDED' | 'ISSUES' | 'BLOCKED'
>;

export interface ArchiveJobPlan {
  readonly intake: ArchiveIntakePlan;
  readonly query: Omit<ArchiveQueryInput, 'handoffPath'>;
}
export interface ArchiveJobSpec extends ArchiveJobPlan {
  readonly schema: 1;
  readonly kind: 'temari-archive-two-job-spec';
}
interface StageReceipt {
  readonly schema: 1;
  readonly kind: 'temari-archive-job-stage';
  readonly specSha256: string;
  readonly stage: Stage;
  readonly status: CompletionStatus;
  readonly evidencePaths: readonly string[];
  readonly summary: string;
}
export interface ArchiveJobTickResult {
  readonly specPath: string;
  readonly intakeTaskId: string;
  readonly searchTaskId: string;
  readonly intake: ChildTaskStatus;
  readonly search: ChildTaskStatus;
  readonly status:
    | 'PENDING'
    | 'RUNNING'
    | 'SUCCEEDED'
    | 'ISSUES'
    | 'BLOCKED'
    | 'FAILED'
    | 'CANCELLED';
  readonly action: 'intake' | 'search' | 'retry-queued' | 'none';
  readonly handoffPath: string | null;
  readonly reportPath: string | null;
}

function exactFields(
  value: unknown,
  fields: readonly string[],
  label: string,
): void {
  const record = object(value);
  assert(
    Object.keys(record).every((field) => fields.includes(field)),
    `Unknown ${label} field`,
  );
}
function checkedSpec(value: unknown): ArchiveJobSpec {
  exactFields(value, ['schema', 'kind', 'intake', 'query'], 'job spec');
  const spec = value as ArchiveJobSpec;
  assert.equal(spec.schema, 1);
  assert.equal(spec.kind, 'temari-archive-two-job-spec');
  exactFields(
    spec.intake,
    ['task', 'intakes', 'localOnlySourceIds', 'structures'],
    'intake',
  );
  exactFields(
    spec.query,
    ['id', 'query', 'sourceIds', 'topK', 'discoveryMode', 'hostedTextApproved'],
    'query',
  );
  assert(
    isAbsolute(text(spec.intake.task.directory)),
    'Absolute task directory required',
  );
  assert(
    Array.isArray(spec.intake.intakes) &&
      spec.intake.intakes.length >= 1 &&
      spec.intake.intakes.length <= 8,
  );
  assert(
    Array.isArray(spec.query.sourceIds) &&
      spec.query.sourceIds.length >= 1 &&
      spec.query.sourceIds.length <= 8,
  );
  assert.equal(new Set(spec.query.sourceIds).size, spec.query.sourceIds.length);
  const admitted = new Set(spec.intake.intakes.map((entry) => entry.source.id));
  for (const entry of spec.intake.intakes) {
    exactFields(
      entry,
      [
        'task',
        'source',
        'readScope',
        'transport',
        'requestKey',
        'ocrMode',
        'limits',
      ],
      'intake source',
    );
    assert.equal(
      canonical(entry.task),
      canonical(spec.intake.task),
      'Intake task mismatch',
    );
  }
  for (const sourceId of spec.query.sourceIds)
    assert(admitted.has(sourceId), 'Query source outside intake');
  const localOnly = spec.intake.localOnlySourceIds ?? [];
  assert(
    Array.isArray(localOnly) && new Set(localOnly).size === localOnly.length,
  );
  for (const id of localOnly)
    assert(admitted.has(id), 'Local-only source outside intake');
  assert(
    text(spec.query.id).length <= 128 && text(spec.query.query).length <= 512,
  );
  integer(spec.query.topK, 1, 8);
  assert(['exact', 'bm25'].includes(spec.query.discoveryMode));
  assert(
    spec.query.hostedTextApproved === undefined ||
      typeof spec.query.hostedTextApproved === 'boolean',
  );
  return spec;
}
function specDigest(spec: ArchiveJobSpec): string {
  return hash(canonical(spec));
}
function identities(spec: ArchiveJobSpec) {
  const digest = specDigest(spec);
  return {
    digest,
    runId: `archive-${digest.slice(0, 32)}`,
    intakeTaskId: `archive-intake-${digest.slice(0, 32)}`,
    searchTaskId: `archive-search-${digest.slice(0, 32)}`,
  };
}
function stagePath(spec: ArchiveJobSpec, stage: Stage): string {
  return join(
    spec.intake.task.directory,
    `archive-job-${stage}-${specDigest(spec)}.json`,
  );
}

const SUMMARIES = {
  intakePass: 'Pinned intake handoff published.',
  intakeBlocked: 'Archive intake blocked; no search grant was created.',
  searchPass: 'Pinned lexical shortlist verified.',
  searchIssues: 'Query completed with search or excerpt gaps; inspect report.',
  hostedUncertain:
    'Prior hosted query attempt is uncertain; manual review required before retry.',
  attemptLimit:
    'Attempt limit reached without a durable stage result; manual review required.',
} as const;
function searchStatus(report: ArchiveQueryReport): 'SUCCEEDED' | 'ISSUES' {
  return report.query.ranked.length > 0 &&
    report.query.shortlistVerified &&
    report.query.gaps.length === 0
    ? 'SUCCEEDED'
    : 'ISSUES';
}

/** Publish only a content-addressed plan. No intake or hosted call occurs here. */
export async function createArchiveJobSpec(
  plan: ArchiveJobPlan,
): Promise<string> {
  exactFields(plan, ['intake', 'query'], 'job plan');
  const spec = checkedSpec(
    JSON.parse(
      canonical({
        schema: 1,
        kind: 'temari-archive-two-job-spec',
        ...plan,
      }),
    ),
  );
  await mkdir(spec.intake.task.directory, { recursive: true, mode: 0o700 });
  assert.equal(
    await realpath(spec.intake.task.directory),
    spec.intake.task.directory,
    'Canonical task directory required',
  );
  const path = join(
    spec.intake.task.directory,
    `archive-job-spec-${specDigest(spec)}.json`,
  );
  await publishJson(path, spec);
  return path;
}
export async function loadArchiveJobSpec(
  path: string,
): Promise<ArchiveJobSpec> {
  assert(isAbsolute(path));
  const spec = checkedSpec(await readJson(path));
  assert.equal(dirname(path), spec.intake.task.directory);
  assert.equal(basename(path), `archive-job-spec-${specDigest(spec)}.json`);
  return spec;
}

async function durableHandoff(
  path: string,
  spec: ArchiveJobSpec,
): Promise<void> {
  const handoff = await loadArchiveHandoff(path);
  assert.equal(handoff.jevPolicy?.mode, 'registered-sources');
  assert.equal(canonical(handoff.task), canonical(spec.intake.task));
  assert.deepEqual(
    new Set(handoff.sources.map((source) => source.id)),
    new Set(spec.intake.intakes.map((entry) => entry.source.id)),
  );
  assert.deepEqual(
    [...(handoff.jevPolicy?.localOnlySourceIds ?? [])].sort(),
    [...(spec.intake.localOnlySourceIds ?? [])].sort(),
    'Pinned sharing policy changed',
  );
  const publications = await Promise.all(
    handoff.publications.map(loadArchivePublication),
  );
  for (const entry of spec.intake.intakes) {
    const publication = publications.find(
      (item) => item.source.id === entry.source.id,
    );
    assert(publication, 'Pinned intake source missing');
    assert(
      !publication.rebind,
      'Job handoff must use its captured publication',
    );
    const captureRequestKey = `temari-archive-v1:${hash(
      canonical({
        task: spec.intake.task,
        key: entry.requestKey,
      }),
    )}`;
    const bindingId = hash(captureRequestKey);
    const transport = {
      python: entry.transport.python,
      registrarSource: entry.transport.registrarSource,
      workspace: entry.transport.workspace,
      timeoutMs: entry.transport.timeoutMs ?? 30_000,
      maxStdoutBytes: entry.transport.maxStdoutBytes ?? 1_048_576,
    };
    const limits = {
      entries: 1000,
      file_bytes: 8 * 1024 * 1024,
      total_bytes: 64 * 1024 * 1024,
      text_bytes: 8 * 1024 * 1024,
      ...entry.limits,
    };
    assert.equal(canonical(publication.source), canonical(entry.source));
    assert.equal(canonical(publication.task), canonical(spec.intake.task));
    assert.equal(publication.readScope, entry.readScope);
    assert.equal(publication.captureRequestKey, captureRequestKey);
    assert.equal(publication.binding, bindingId);
    assert.equal(canonical(publication.transport), canonical(transport));
    const binding = await readJson(
      join(spec.intake.task.directory, `archive-binding-${bindingId}.json`),
    );
    assert.equal(
      canonical(binding),
      canonical({
        schema: 1,
        task: spec.intake.task,
        source: entry.source,
        readScope: entry.readScope,
        limits,
        captureRequestKey,
        transport,
        implementation: publication.implementation,
        protocolSha256: publication.protocolSha256,
        registration: publication.registration,
        ...(entry.ocrMode ? { ocrMode: entry.ocrMode } : {}),
      }),
      'Capture binding differs from job spec',
    );
  }
}
async function durableReport(
  path: string,
  spec: ArchiveJobSpec,
  handoffPath: string,
): Promise<ArchiveQueryReport> {
  assert(isAbsolute(path));
  const report = object(await readJson(path)) as unknown as ArchiveQueryReport;
  assert.equal(report.schema, 1);
  assert.equal(report.kind, 'temari-archive-query');
  assert.equal(dirname(path), spec.intake.task.directory);
  assert.equal(basename(path), `archive-query-${hash(canonical(report))}.json`);
  assert.equal(report.handoffPath, handoffPath);
  assert.equal(report.query.querySha256, hash(spec.query.query));
  assert.equal(report.query.id, spec.query.id);
  assert.deepEqual(report.query.sourceIds, spec.query.sourceIds);
  assert.equal(report.query.discoveryMode, spec.query.discoveryMode);
  assert.equal(report.query.topK, spec.query.topK);
  const expectedSharing = hostedPossible(spec)
    ? 'allowed'
    : spec.query.sourceIds.some((id) =>
          spec.intake.localOnlySourceIds?.includes(id),
        )
      ? 'local-only'
      : 'case-opt-out';
  if (expectedSharing === 'allowed') {
    assert(
      report.query.jevSharing === 'allowed' ||
        report.query.jevSharing === 'current-local-only' ||
        report.query.jevSharing === 'policy-unavailable',
      'Current sharing result differs from allowed job policy',
    );
  } else {
    assert.equal(report.query.jevSharing, expectedSharing);
  }
  assert.equal(canonical(report.task), canonical(spec.intake.task));
  return report;
}
async function loadStage(
  spec: ArchiveJobSpec,
  stage: Stage,
  attempt: number,
  handoffPath?: string,
): Promise<StageReceipt | null> {
  let receipt: StageReceipt;
  try {
    receipt = object(
      await readJson(stagePath(spec, stage)),
    ) as unknown as StageReceipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  assert.equal(receipt.schema, 1);
  assert.equal(receipt.kind, 'temari-archive-job-stage');
  assert.equal(receipt.specSha256, specDigest(spec));
  assert.equal(receipt.stage, stage);
  assert(['SUCCEEDED', 'ISSUES', 'BLOCKED'].includes(receipt.status));
  assert(stage !== 'intake' || receipt.status !== 'ISSUES');
  assert(
    Array.isArray(receipt.evidencePaths) && receipt.evidencePaths.length >= 1,
  );
  const specPath = join(
    spec.intake.task.directory,
    `archive-job-spec-${specDigest(spec)}.json`,
  );
  if (receipt.status === 'BLOCKED') {
    if (
      receipt.evidencePaths.length === 1 &&
      receipt.evidencePaths[0] === specPath
    ) {
      assert(
        attempt > safeAttemptLimit(spec, stage),
        'Attempt-limit block lacks a qualifying runtime claim',
      );
      assert.equal(
        receipt.summary,
        stage === 'search' && hostedPossible(spec)
          ? SUMMARIES.hostedUncertain
          : SUMMARIES.attemptLimit,
      );
    } else {
      assert.equal(
        stage,
        'intake',
        'Only intake can block from capture attempts',
      );
      assert.equal(receipt.summary, SUMMARIES.intakeBlocked);
      assert.equal(receipt.evidencePaths.length, spec.intake.intakes.length);
      let blocked = false;
      for (let index = 0; index < receipt.evidencePaths.length; index++) {
        const attemptPath: string = receipt.evidencePaths[index];
        assert.equal(dirname(attemptPath), spec.intake.task.directory);
        assert(
          /^archive-attempt-[0-9a-f-]{36}\.json$/.test(basename(attemptPath)),
        );
        const attempt = object(await readJson(attemptPath));
        assert.equal(attempt['schema'], 1);
        assert.equal(attempt['kind'], 'temari-archive-attempt');
        assert.equal(
          canonical(attempt['options']),
          canonical(spec.intake.intakes[index]),
        );
        const resultPath = join(
          spec.intake.task.directory,
          basename(attemptPath).replace('archive-attempt-', 'archive-result-'),
        );
        const outcome = object(await readJson(resultPath));
        assert.equal(outcome['attemptPath'], attemptPath);
        assert(['published', 'blocked'].includes(String(outcome['status'])));
        blocked ||= outcome['status'] === 'blocked';
      }
      assert(blocked, 'Blocked intake receipt has no blocked capture');
    }
  } else {
    assert.equal(receipt.evidencePaths.length, 1);
    if (stage === 'intake') {
      assert.equal(receipt.summary, SUMMARIES.intakePass);
      await durableHandoff(receipt.evidencePaths[0], spec);
    } else {
      const report = await durableReport(
        receipt.evidencePaths[0],
        spec,
        text(handoffPath),
      );
      assert.equal(
        receipt.status,
        searchStatus(report),
        'Query stage status differs from validated report',
      );
      assert.equal(
        receipt.summary,
        receipt.status === 'SUCCEEDED'
          ? SUMMARIES.searchPass
          : SUMMARIES.searchIssues,
      );
    }
  }
  return receipt;
}
function workerResult(receipt: StageReceipt): WorkerResult {
  return {
    status: receipt.status === 'SUCCEEDED' ? 'PASS' : receipt.status,
    summary: receipt.summary,
    evidencePaths: [...receipt.evidencePaths],
    rawLogPath: null,
  };
}
function errorText(stage: Stage): string {
  return stage === 'intake'
    ? 'Archive intake failed mechanically; inspect retained attempt artifacts.'
    : 'Archive query failed mechanically; external model work may already have occurred.';
}
function hostedPossible(spec: ArchiveJobSpec): boolean {
  return (
    spec.query.hostedTextApproved !== false &&
    !spec.query.sourceIds.some((id) =>
      spec.intake.localOnlySourceIds?.includes(id),
    )
  );
}

function safeAttemptLimit(spec: ArchiveJobSpec, stage: Stage): number {
  return stage === 'search' && hostedPossible(spec) ? 1 : MAX_ATTEMPTS;
}

async function executeStage(
  spec: ArchiveJobSpec,
  stage: Stage,
  attempt: number,
  handoffPath: string | null,
): Promise<StageReceipt> {
  const prior = await loadStage(spec, stage, attempt, handoffPath ?? undefined);
  if (prior) return prior;
  let receipt: StageReceipt;
  if (stage === 'intake') {
    const outcome = await runArchiveIntake(spec.intake);
    if (outcome.status === 'published') {
      assert(outcome.handoffPath);
      await durableHandoff(outcome.handoffPath, spec);
      receipt = {
        schema: 1,
        kind: 'temari-archive-job-stage',
        specSha256: specDigest(spec),
        stage,
        status: 'SUCCEEDED',
        evidencePaths: [outcome.handoffPath],
        summary: SUMMARIES.intakePass,
      };
    } else {
      receipt = {
        schema: 1,
        kind: 'temari-archive-job-stage',
        specSha256: specDigest(spec),
        stage,
        status: 'BLOCKED',
        evidencePaths: outcome.outcomes.map((item) => item.attemptPath),
        summary: SUMMARIES.intakeBlocked,
      };
    }
  } else {
    assert(handoffPath, 'Search requires a durable intake handoff');
    await durableHandoff(handoffPath, spec);
    const outcome = await runArchiveQuery({ ...spec.query, handoffPath });
    await durableReport(outcome.reportPath, spec, handoffPath);
    const status = searchStatus(outcome.report);
    receipt = {
      schema: 1,
      kind: 'temari-archive-job-stage',
      specSha256: specDigest(spec),
      stage,
      status,
      evidencePaths: [outcome.reportPath],
      summary:
        status === 'SUCCEEDED' ? SUMMARIES.searchPass : SUMMARIES.searchIssues,
    };
  }
  await publishJson(stagePath(spec, stage), receipt);
  return receipt;
}

function overall(
  intake: ChildTaskRecord,
  search: ChildTaskRecord,
): ArchiveJobTickResult['status'] {
  if (intake.status === 'FAILED' || search.status === 'FAILED') return 'FAILED';
  if (intake.status === 'BLOCKED' || search.status === 'BLOCKED')
    return 'BLOCKED';
  if (intake.status === 'CANCELLED' || search.status === 'CANCELLED')
    return 'CANCELLED';
  if (search.status === 'SUCCEEDED') return 'SUCCEEDED';
  if (search.status === 'ISSUES') return 'ISSUES';
  if (intake.status === 'RUNNING' || search.status === 'RUNNING')
    return 'RUNNING';
  return 'PENDING';
}

/** One tick runs at most one claimed child. Repeating the same spec resumes it. */
export async function tickArchiveJobs(
  specPath: string,
  options: { readonly owner?: string } = {},
): Promise<ArchiveJobTickResult> {
  const spec = await loadArchiveJobSpec(specPath);
  const ids = identities(spec);
  const owner = options.owner ?? `knowledge-${randomUUID()}`;
  text(owner);
  const store = await FileChildTaskStore.create(
    join(spec.intake.task.directory, 'archive-child-tasks'),
  );
  await store.create({
    taskId: ids.intakeTaskId,
    runId: ids.runId,
    revision: ids.digest,
    dependsOn: [],
    actor: owner,
  });
  await store.create({
    taskId: ids.searchTaskId,
    runId: ids.runId,
    revision: ids.digest,
    dependsOn: [ids.intakeTaskId],
    actor: owner,
  });
  let action: ArchiveJobTickResult['action'] = 'none';
  let handoffPath: string | null = null;
  let reportPath: string | null = null;
  let intake = (await store.load(ids.intakeTaskId))!;
  let search = (await store.load(ids.searchTaskId))!;
  const stage: Stage | null =
    intake.status === 'SUCCEEDED'
      ? 'search'
      : ['QUEUED', 'RUNNING', 'FAILED'].includes(intake.status)
        ? 'intake'
        : null;
  if (intake.status === 'SUCCEEDED') {
    handoffPath = text(intake.result?.evidencePaths[0]);
    await durableHandoff(handoffPath, spec);
  }
  if (stage !== null) {
    const taskId = stage === 'intake' ? ids.intakeTaskId : ids.searchTaskId;
    const current = stage === 'intake' ? intake : search;
    if (current.status === 'FAILED') {
      const canRetry =
        current.attempt < MAX_ATTEMPTS &&
        (stage === 'intake' || !hostedPossible(spec));
      if (canRetry) {
        await store.retry({
          taskId,
          actor: owner,
          idempotencyKey: `retry:${taskId}:${current.attempt}`,
        });
        action = 'retry-queued';
      }
    } else if (current.status === 'QUEUED' || current.status === 'RUNNING') {
      const claim = await store.claim({ taskId, owner, leaseMs: LEASE_MS });
      if (claim.claimed) {
        action = stage;
        const lease = claim.record.lease!;
        let renewal: Promise<unknown> | null = null;
        let renewalError: unknown = null;
        let renewalIndex = 0;
        const timer = setInterval(() => {
          if (renewal || renewalError) return;
          renewal = store
            .renew({
              taskId,
              owner,
              leaseToken: lease.token,
              fencingEpoch: lease.fencingEpoch,
              leaseMs: LEASE_MS,
              idempotencyKey: `renew:${taskId}:${lease.fencingEpoch}:${++renewalIndex}`,
            })
            .catch((error: unknown) => {
              renewalError = error;
            })
            .finally(() => {
              renewal = null;
            });
        }, LEASE_MS / 3);
        let receipt: StageReceipt | null = null;
        try {
          const safeAttempts = safeAttemptLimit(spec, stage);
          if (
            claim.record.attempt > safeAttempts &&
            !(await loadStage(
              spec,
              stage,
              claim.record.attempt,
              handoffPath ?? undefined,
            ))
          ) {
            const blocked: StageReceipt = {
              schema: 1,
              kind: 'temari-archive-job-stage',
              specSha256: ids.digest,
              stage,
              status: 'BLOCKED',
              evidencePaths: [specPath],
              summary:
                stage === 'search' && hostedPossible(spec)
                  ? SUMMARIES.hostedUncertain
                  : SUMMARIES.attemptLimit,
            };
            await publishJson(stagePath(spec, stage), blocked);
          }
          receipt = await executeStage(
            spec,
            stage,
            claim.record.attempt,
            handoffPath,
          );
        } catch {
          const observed = await store.load(taskId);
          if (
            observed?.status === 'RUNNING' &&
            observed.lease?.token === lease.token &&
            Date.parse(observed.lease.expiresAt) > Date.now()
          ) {
            await store.complete({
              taskId,
              owner,
              leaseToken: lease.token,
              fencingEpoch: lease.fencingEpoch,
              status: 'FAILED',
              idempotencyKey: `complete-failed:${taskId}:${lease.fencingEpoch}`,
              error: errorText(stage),
            });
          }
        } finally {
          clearInterval(timer);
          if (renewal) await renewal;
        }
        if (receipt) {
          if (renewalError) throw renewalError;
          // Completion is outside the execution catch: a store interruption can
          // be reconciled on a later claim using the durable stage receipt.
          await store.complete({
            taskId,
            owner,
            leaseToken: lease.token,
            fencingEpoch: lease.fencingEpoch,
            status: receipt.status,
            idempotencyKey: `complete:${taskId}:${lease.fencingEpoch}`,
            result: workerResult(receipt),
          });
        }
      }
    }
  }
  intake = (await store.load(ids.intakeTaskId))!;
  search = (await store.load(ids.searchTaskId))!;
  if (intake.status === 'SUCCEEDED') {
    handoffPath = text(intake.result?.evidencePaths[0]);
    await durableHandoff(handoffPath, spec);
  }
  if (search.status === 'SUCCEEDED' || search.status === 'ISSUES') {
    reportPath = text(search.result?.evidencePaths[0]);
    await durableReport(reportPath, spec, text(handoffPath));
  }
  return {
    specPath,
    intakeTaskId: ids.intakeTaskId,
    searchTaskId: ids.searchTaskId,
    intake: intake.status,
    search: search.status,
    status: overall(intake, search),
    action,
    handoffPath,
    reportPath,
  };
}
