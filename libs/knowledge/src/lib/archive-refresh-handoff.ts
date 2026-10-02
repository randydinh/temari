/** One pinned audit-to-recapture handoff. Scheduling and graph publication are separate. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { FileChildTaskStore, type ChildTaskStatus } from '@temari/runtime';
import {
  loadArchivePublication,
  type ArchiveIntakeOptions,
} from './archive-intake.js';
import { canonical, digest, hash, object, text } from './codec.js';
import { publishJson, readJsonWithBytes } from './durable.js';
import { loadCompletedArchiveFreshnessDecision } from './archive-freshness-job.js';
import {
  ArchiveRecaptureHandoffError,
  recaptureArchiveSource,
  resumeArchiveSourceHandoff,
  type ArchiveSourceRecaptureReceipt,
  type ArchiveSourceResumeReceipt,
} from './archive-source-lifecycle.js';

const LEASE_MS = 120_000;
const POLICY = 'one-pinned-audit-recapture-handoff-v1';
type HandoffReceipt =
  ArchiveSourceRecaptureReceipt | ArchiveSourceResumeReceipt;

export interface ArchiveRefreshHandoffPlan {
  readonly freshnessSpecPath: string;
  readonly beforeGraphId?: string;
}
export interface ArchiveRefreshHandoffSpec {
  readonly schema: 1;
  readonly kind: 'temari-archive-refresh-handoff-spec';
  readonly policy: typeof POLICY;
  readonly freshnessSpecPath: string;
  readonly freshnessSpecSha256: string;
  readonly freshnessStagePath: string;
  readonly freshnessStageSha256: string;
  readonly auditReceiptPath: string;
  readonly auditReceiptSha256: string;
  readonly beforePublicationPath: string;
  readonly beforePublicationSha256: string;
  readonly sourceId: string;
  readonly beforeGraphId: string | null;
  readonly after: ArchiveIntakeOptions;
}
interface Intent {
  readonly schema: 1;
  readonly kind: 'temari-archive-refresh-handoff-intent';
  readonly specSha256: string;
  readonly requestKey: string;
}
interface CaptureStart {
  readonly schema: 1;
  readonly kind: 'temari-archive-refresh-capture-start';
  readonly specSha256: string;
  readonly requestKey: string;
  readonly owner: string;
  readonly leaseToken: string;
  readonly fencingEpoch: number;
  readonly nonce: string;
}
interface Stage {
  readonly schema: 1;
  readonly kind: 'temari-archive-refresh-handoff-stage';
  readonly specSha256: string;
  readonly handoffReceiptPath: string;
  readonly handoffReceiptSha256: string;
  readonly captureAttemptPath: string;
  readonly captureResultPath: string;
  readonly afterPublicationPath: string;
  readonly afterPublicationSha256: string;
  readonly graphImpactReceiptPath: string | null;
  readonly graphMutation: 'none';
}
export interface ArchiveRefreshHandoffTickResult {
  readonly specPath: string;
  readonly taskId: string;
  readonly status: ChildTaskStatus;
  readonly action:
    'none' | 'capture' | 'resume-result' | 'recover-stage' | 'review-blocked';
  readonly stagePath: string | null;
  readonly handoffReceiptPath: string | null;
  readonly graphImpactReceiptPath: string | null;
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
function specSha(spec: ArchiveRefreshHandoffSpec): string {
  return hash(canonical(spec));
}
function requestKey(
  sourceId: string,
  priorSha: string,
  stageSha: string,
  graphId: string | null,
): string {
  return `refresh:${hash(canonical({ sourceId, priorSha, stageSha, graphId }))}`;
}
function taskId(spec: ArchiveRefreshHandoffSpec): string {
  return `archive-refresh-${hash(canonical({ sourceId: spec.sourceId, beforePublicationSha256: spec.beforePublicationSha256 })).slice(0, 32)}`;
}
function stagePath(spec: ArchiveRefreshHandoffSpec): string {
  return join(
    spec.after.task.directory,
    `archive-refresh-stage-${specSha(spec)}.json`,
  );
}
function intentPath(spec: ArchiveRefreshHandoffSpec): string {
  return join(
    spec.after.task.directory,
    `archive-refresh-intent-${specSha(spec)}.json`,
  );
}
function captureStartPath(spec: ArchiveRefreshHandoffSpec): string {
  return join(
    spec.after.task.directory,
    `archive-refresh-start-${specSha(spec)}.json`,
  );
}
async function exact(path: string) {
  assert(isAbsolute(path));
  const artifact = await readJsonWithBytes(path);
  assert.equal(artifact.bytes.toString('utf8'), canonical(artifact.value));
  return { value: artifact.value, sha256: hash(artifact.bytes) };
}
function afterOptions(
  spec: Pick<
    ArchiveRefreshHandoffSpec,
    | 'sourceId'
    | 'beforePublicationSha256'
    | 'freshnessStageSha256'
    | 'beforeGraphId'
  >,
  publication: Awaited<ReturnType<typeof loadArchivePublication>>,
): ArchiveIntakeOptions {
  return {
    task: publication.task,
    source: publication.source,
    readScope: publication.readScope,
    transport: publication.transport,
    requestKey: requestKey(
      spec.sourceId,
      spec.beforePublicationSha256,
      spec.freshnessStageSha256,
      spec.beforeGraphId,
    ),
  };
}
async function checkedSpec(value: unknown): Promise<ArchiveRefreshHandoffSpec> {
  fields(
    value,
    [
      'schema',
      'kind',
      'policy',
      'freshnessSpecPath',
      'freshnessSpecSha256',
      'freshnessStagePath',
      'freshnessStageSha256',
      'auditReceiptPath',
      'auditReceiptSha256',
      'beforePublicationPath',
      'beforePublicationSha256',
      'sourceId',
      'beforeGraphId',
      'after',
    ],
    'refresh spec',
  );
  const spec = value as ArchiveRefreshHandoffSpec;
  assert.equal(spec.schema, 1);
  assert.equal(spec.kind, 'temari-archive-refresh-handoff-spec');
  assert.equal(spec.policy, POLICY);
  for (const path of [
    spec.freshnessSpecPath,
    spec.freshnessStagePath,
    spec.auditReceiptPath,
    spec.beforePublicationPath,
  ])
    assert(isAbsolute(text(path)));
  for (const sha of [
    spec.freshnessSpecSha256,
    spec.freshnessStageSha256,
    spec.auditReceiptSha256,
    spec.beforePublicationSha256,
  ])
    digest(sha);
  text(spec.sourceId);
  if (spec.beforeGraphId !== null) digest(spec.beforeGraphId);
  const decision = await loadCompletedArchiveFreshnessDecision(
    spec.freshnessSpecPath,
  );
  assert.equal(
    decision.decision,
    'recapture-needed',
    'Completed recapture-needed audit required',
  );
  for (const [key, expected] of Object.entries({
    freshnessSpecSha256: decision.specSha256,
    freshnessStagePath: decision.stagePath,
    freshnessStageSha256: decision.stageSha256,
    auditReceiptPath: decision.auditReceiptPath,
    auditReceiptSha256: decision.auditReceiptSha256,
    beforePublicationPath: decision.publicationPath,
    beforePublicationSha256: decision.publicationSha256,
    sourceId: decision.sourceId,
  }))
    assert.equal(
      spec[key as keyof ArchiveRefreshHandoffSpec],
      expected,
      `Pinned refresh ${key} changed`,
    );
  const before = await loadArchivePublication(spec.beforePublicationPath);
  assert.equal(
    hash((await readJsonWithBytes(spec.beforePublicationPath)).bytes),
    spec.beforePublicationSha256,
  );
  assert.equal(before.source.id, spec.sourceId);
  assert.equal(
    canonical(spec.after),
    canonical(afterOptions(spec, before)),
    'Recapture options changed',
  );
  return spec;
}

/** Persist one immutable request for a completed recapture-needed audit. */
export async function createArchiveRefreshHandoffSpec(
  plan: ArchiveRefreshHandoffPlan,
): Promise<string> {
  fields(
    plan,
    plan.beforeGraphId === undefined
      ? ['freshnessSpecPath']
      : ['freshnessSpecPath', 'beforeGraphId'],
    'refresh plan',
  );
  if (plan.beforeGraphId !== undefined) digest(plan.beforeGraphId);
  const decision = await loadCompletedArchiveFreshnessDecision(
    plan.freshnessSpecPath,
  );
  assert.equal(
    decision.decision,
    'recapture-needed',
    'Completed recapture-needed audit required',
  );
  const before = await loadArchivePublication(decision.publicationPath);
  const base = {
    schema: 1 as const,
    kind: 'temari-archive-refresh-handoff-spec' as const,
    policy: POLICY,
    freshnessSpecPath: plan.freshnessSpecPath,
    freshnessSpecSha256: decision.specSha256,
    freshnessStagePath: decision.stagePath,
    freshnessStageSha256: decision.stageSha256,
    auditReceiptPath: decision.auditReceiptPath,
    auditReceiptSha256: decision.auditReceiptSha256,
    beforePublicationPath: decision.publicationPath,
    beforePublicationSha256: decision.publicationSha256,
    sourceId: decision.sourceId,
    beforeGraphId: plan.beforeGraphId ?? null,
  };
  const spec = await checkedSpec({
    ...base,
    after: afterOptions(base, before),
  });
  const path = join(
    before.task.directory,
    `archive-refresh-spec-${specSha(spec)}.json`,
  );
  await publishJson(path, spec);
  return path;
}

export async function loadArchiveRefreshHandoffSpec(
  path: string,
): Promise<ArchiveRefreshHandoffSpec> {
  const artifact = await exact(path);
  const spec = await checkedSpec(artifact.value);
  assert.equal(dirname(path), spec.after.task.directory);
  assert.equal(basename(path), `archive-refresh-spec-${specSha(spec)}.json`);
  return spec;
}

async function loadStage(
  spec: ArchiveRefreshHandoffSpec,
): Promise<Stage | null> {
  let artifact: Awaited<ReturnType<typeof exact>>;
  try {
    artifact = await exact(stagePath(spec));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  fields(
    artifact.value,
    [
      'schema',
      'kind',
      'specSha256',
      'handoffReceiptPath',
      'handoffReceiptSha256',
      'captureAttemptPath',
      'captureResultPath',
      'afterPublicationPath',
      'afterPublicationSha256',
      'graphImpactReceiptPath',
      'graphMutation',
    ],
    'refresh stage',
  );
  const stage = artifact.value as Stage;
  assert.equal(stage.schema, 1);
  assert.equal(stage.kind, 'temari-archive-refresh-handoff-stage');
  assert.equal(stage.specSha256, specSha(spec));
  assert.equal(stage.graphMutation, 'none');
  assert.equal(dirname(stage.handoffReceiptPath), spec.after.task.directory);
  const handoffArtifact = await exact(stage.handoffReceiptPath);
  assert.equal(handoffArtifact.sha256, stage.handoffReceiptSha256);
  const handoff = object(handoffArtifact.value) as unknown as HandoffReceipt;
  assert.equal(handoff.schema, 1);
  assert(
    [
      'temari-archive-source-recapture',
      'temari-archive-source-resume',
    ].includes(handoff.kind),
  );
  assert.equal(handoff.status, 'handoff');
  assert.equal(handoff.sourceId, spec.sourceId);
  assert.equal(handoff.graphMutation, 'none');
  assert.equal(handoff.currentOriginal, 'not-checked');
  assert.equal(handoff.before.publicationPath, spec.beforePublicationPath);
  assert.equal(handoff.before.publicationSha256, spec.beforePublicationSha256);
  for (const path of [
    stage.captureAttemptPath,
    stage.captureResultPath,
    stage.afterPublicationPath,
    handoff.diff.receiptPath,
  ])
    assert.equal(dirname(path), spec.after.task.directory);
  assert.equal(handoff.captureAttemptPath, stage.captureAttemptPath);
  assert.equal(handoff.captureResultPath, stage.captureResultPath);
  assert.equal(handoff.after.publicationPath, stage.afterPublicationPath);
  const afterArtifact = await exact(stage.afterPublicationPath);
  assert.equal(afterArtifact.sha256, stage.afterPublicationSha256);
  assert.equal(handoff.after.publicationSha256, stage.afterPublicationSha256);
  const after = await loadArchivePublication(stage.afterPublicationPath);
  assert.equal(after.source.id, spec.sourceId);
  assert.equal(after.generation, handoff.after.generation);
  assert.equal(after.manifestSha256, handoff.after.manifestSha256);
  assert.equal(
    after.captureRequestKey,
    `temari-archive-v1:${hash(canonical({ task: spec.after.task, key: spec.after.requestKey }))}`,
  );
  const attempt = object((await exact(stage.captureAttemptPath)).value);
  assert.equal(canonical(attempt['options']), canonical(spec.after));
  const result = object((await exact(stage.captureResultPath)).value);
  assert.equal(result['status'], 'published');
  assert.equal(result['publicationPath'], stage.afterPublicationPath);
  const diffArtifact = await exact(handoff.diff.receiptPath);
  assert.equal(diffArtifact.sha256, handoff.diff.receiptSha256);
  const diff = object(diffArtifact.value);
  assert.equal(diff['schema'], 1);
  assert.equal(diff['kind'], 'temari-archive-generation-diff');
  assert.equal(diff['sourceId'], spec.sourceId);
  assert.equal(canonical(diff['before']), canonical(handoff.before));
  assert.equal(canonical(diff['after']), canonical(handoff.after));
  assert.equal(canonical(diff['counts']), canonical(handoff.diff.counts));
  assert.equal(handoff.graphImpact?.beforeGraphId ?? null, spec.beforeGraphId);
  if (handoff.graphImpact) {
    assert.equal(
      dirname(handoff.graphImpact.receiptPath),
      spec.after.task.directory,
    );
    const impactArtifact = await exact(handoff.graphImpact.receiptPath);
    assert.equal(impactArtifact.sha256, handoff.graphImpact.receiptSha256);
    const impact = object(impactArtifact.value);
    assert.equal(impact['schema'], 1);
    assert.equal(impact['kind'], 'temari-archive-graph-impact-plan');
    assert.equal(impact['status'], 'plan-only');
    assert.equal(impact['sourceId'], spec.sourceId);
    assert.equal(impact['beforeGraphId'], spec.beforeGraphId);
    assert.equal(impact['diffReceiptPath'], handoff.diff.receiptPath);
    assert.equal(impact['diffReceiptSha256'], handoff.diff.receiptSha256);
    assert.equal(canonical(impact['before']), canonical(handoff.before));
    assert.equal(canonical(impact['after']), canonical(handoff.after));
    assert.equal(
      canonical(impact['counts']),
      canonical(handoff.graphImpact.counts),
    );
  }
  assert.equal(
    handoff.graphImpact?.receiptPath ?? null,
    stage.graphImpactReceiptPath,
  );
  return stage;
}
function tickResult(
  specPath: string,
  spec: ArchiveRefreshHandoffSpec,
  status: ChildTaskStatus,
  action: ArchiveRefreshHandoffTickResult['action'],
  stage: Stage | null,
): ArchiveRefreshHandoffTickResult {
  return {
    specPath,
    taskId: taskId(spec),
    status,
    action,
    stagePath: stage ? stagePathForResult(spec) : null,
    handoffReceiptPath: stage?.handoffReceiptPath ?? null,
    graphImpactReceiptPath: stage?.graphImpactReceiptPath ?? null,
  };
}
function stagePathForResult(spec: ArchiveRefreshHandoffSpec): string {
  return stagePath(spec);
}

async function matchingAttempts(
  spec: ArchiveRefreshHandoffSpec,
): Promise<string[]> {
  const names = await readdir(spec.after.task.directory);
  assert(
    names.length <= 2048,
    'Refresh task directory exceeds attempt scan bound',
  );
  const matching: string[] = [];
  for (const name of names) {
    if (!/^archive-attempt-[0-9a-f-]{36}\.json$/.test(name)) continue;
    const path = join(spec.after.task.directory, name);
    const attempt = object((await exact(path)).value);
    fields(attempt, ['schema', 'kind', 'options', 'state'], 'archive attempt');
    assert.equal(attempt['schema'], 1);
    assert.equal(attempt['kind'], 'temari-archive-attempt');
    assert.equal(attempt['state'], 'started');
    const options = object(attempt['options']);
    if (options['requestKey'] !== spec.after.requestKey) continue;
    assert.equal(
      canonical(options),
      canonical(spec.after),
      'Conflicting same-key attempt',
    );
    matching.push(path);
  }
  assert(
    matching.length <= 1,
    'Multiple matching refresh attempts require review',
  );
  return matching;
}

async function handoffFromAttempt(
  spec: ArchiveRefreshHandoffSpec,
  attemptPath: string,
) {
  const resultPath = join(
    dirname(attemptPath),
    basename(attemptPath).replace(/^archive-attempt-/, 'archive-result-'),
  );
  try {
    await exact(resultPath);
    return {
      outcome: await resumeArchiveSourceHandoff({
        beforePublicationPath: spec.beforePublicationPath,
        resultPath,
        ...(spec.beforeGraphId ? { beforeGraphId: spec.beforeGraphId } : {}),
      }),
      action: 'resume-result' as const,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  throw new Error(
    'Refresh attempt lacks a complete saved result; operator review requires an independently trusted publication pin',
  );
}

/** One leased tick. A caller supplies a scheduler; this job never publishes graph changes. */
export async function tickArchiveRefreshHandoff(
  specPath: string,
  options: { readonly owner?: string } = {},
): Promise<ArchiveRefreshHandoffTickResult> {
  const spec = await loadArchiveRefreshHandoffSpec(specPath);
  const owner = options.owner ?? `knowledge-${randomUUID()}`;
  text(owner);
  const store = await FileChildTaskStore.create(
    join(spec.after.task.directory, 'archive-refresh-child-tasks'),
  );
  const id = taskId(spec),
    revision = specSha(spec);
  await store.create({
    taskId: id,
    runId: id,
    revision,
    dependsOn: [],
    actor: owner,
  });
  const record = (await store.load(id))!;
  let stage = await loadStage(spec);
  if (record.status === 'SUCCEEDED' || record.status === 'ISSUES') {
    assert(stage, 'Completed refresh lacks durable stage');
    assert.deepEqual(record.result?.evidencePaths, [stagePath(spec)]);
    return tickResult(specPath, spec, record.status, 'none', stage);
  }
  if (record.status === 'BLOCKED')
    return tickResult(specPath, spec, 'BLOCKED', 'none', null);
  assert(
    record.status === 'QUEUED' || record.status === 'RUNNING',
    'Refresh requires operator review',
  );
  const claim = await store.claim({ taskId: id, owner, leaseMs: LEASE_MS });
  if (!claim.claimed) {
    if (
      claim.record.status === 'SUCCEEDED' ||
      claim.record.status === 'ISSUES'
    ) {
      stage = await loadStage(spec);
      assert(stage, 'Completed refresh lacks durable stage');
      assert.deepEqual(claim.record.result?.evidencePaths, [stagePath(spec)]);
    }
    return tickResult(specPath, spec, claim.record.status, 'none', stage);
  }
  const lease = claim.record.lease!;
  let renewal: Promise<unknown> | null = null,
    renewalError: unknown = null,
    renewalIndex = 0;
  const timer = setInterval(() => {
    if (renewal || renewalError) return;
    renewal = store
      .renew({
        taskId: id,
        owner,
        leaseToken: lease.token,
        fencingEpoch: lease.fencingEpoch,
        leaseMs: LEASE_MS,
        idempotencyKey: `renew:${id}:${lease.fencingEpoch}:${++renewalIndex}`,
      })
      .catch((error: unknown) => {
        renewalError = error;
      })
      .finally(() => {
        renewal = null;
      });
  }, LEASE_MS / 3);
  let action: ArchiveRefreshHandoffTickResult['action'] = 'capture';
  try {
    stage = await loadStage(spec);
    if (stage) action = 'recover-stage';
    else {
      const intent: Intent = {
        schema: 1,
        kind: 'temari-archive-refresh-handoff-intent',
        specSha256: revision,
        requestKey: spec.after.requestKey,
      };
      await publishJson(intentPath(spec), intent);
      assert.equal(
        canonical((await exact(intentPath(spec))).value),
        canonical(intent),
      );
      const attempts = await matchingAttempts(spec);
      let handoff: {
        receiptPath: string;
        receipt: HandoffReceipt;
        capture: {
          attemptPath: string;
          resultPath: string;
          publicationPath: string | null;
        };
      };
      if (attempts.length) {
        const recovered = await handoffFromAttempt(spec, attempts[0]);
        handoff = recovered.outcome;
        action = recovered.action;
      } else {
        // The immutable nonce marker excludes capture initiation by a later
        // lease epoch if the first worker has not yet written an attempt.
        const heldBeforeStart = await store.load(id);
        assert.equal(heldBeforeStart?.status, 'RUNNING');
        assert.equal(
          heldBeforeStart.lease?.token,
          lease.token,
          'Refresh lease fenced before capture',
        );
        assert.equal(heldBeforeStart.lease?.fencingEpoch, lease.fencingEpoch);
        assert(
          Date.parse(heldBeforeStart.lease.expiresAt) > Date.now(),
          'Refresh lease expired before capture',
        );
        const start: CaptureStart = {
          schema: 1,
          kind: 'temari-archive-refresh-capture-start',
          specSha256: revision,
          requestKey: spec.after.requestKey,
          owner,
          leaseToken: lease.token,
          fencingEpoch: lease.fencingEpoch,
          nonce: randomUUID(),
        };
        await publishJson(captureStartPath(spec), start);
        assert.equal(
          canonical((await exact(captureStartPath(spec))).value),
          canonical(start),
        );
        const heldAfterStart = await store.load(id);
        assert.equal(heldAfterStart?.status, 'RUNNING');
        assert.equal(
          heldAfterStart.lease?.token,
          lease.token,
          'Refresh lease fenced after capture-start marker',
        );
        assert.equal(heldAfterStart.lease?.fencingEpoch, lease.fencingEpoch);
        assert(
          Date.parse(heldAfterStart.lease.expiresAt) > Date.now(),
          'Refresh lease expired after capture-start marker',
        );
        const result = await recaptureArchiveSource({
          beforePublicationPath: spec.beforePublicationPath,
          after: spec.after,
          ...(spec.beforeGraphId ? { beforeGraphId: spec.beforeGraphId } : {}),
        });
        assert.equal(
          result.status,
          'handoff',
          'Refresh capture did not produce a complete handoff',
        );
        handoff = result;
      }
      const receipt = handoff.receipt;
      assert.equal(
        receipt.before.publicationSha256,
        spec.beforePublicationSha256,
      );
      assert.equal(receipt.before.publicationPath, spec.beforePublicationPath);
      assert.equal(receipt.sourceId, spec.sourceId);
      assert.equal(receipt.graphMutation, 'none');
      const afterPublicationPath = handoff.capture.publicationPath;
      assert(afterPublicationPath);
      const next: Stage = {
        schema: 1,
        kind: 'temari-archive-refresh-handoff-stage',
        specSha256: revision,
        handoffReceiptPath: handoff.receiptPath,
        handoffReceiptSha256: (await exact(handoff.receiptPath)).sha256,
        captureAttemptPath: handoff.capture.attemptPath,
        captureResultPath: handoff.capture.resultPath,
        afterPublicationPath,
        afterPublicationSha256: (await exact(afterPublicationPath)).sha256,
        graphImpactReceiptPath: receipt.graphImpact?.receiptPath ?? null,
        graphMutation: 'none',
      };
      if (renewal) await renewal;
      if (renewalError) throw renewalError;
      const held = await store.load(id);
      assert.equal(held?.status, 'RUNNING');
      assert.equal(held.lease?.token, lease.token, 'Refresh lease fenced');
      assert.equal(held.lease?.fencingEpoch, lease.fencingEpoch);
      assert(
        Date.parse(held.lease.expiresAt) > Date.now(),
        'Refresh lease expired',
      );
      await loadArchiveRefreshHandoffSpec(specPath);
      await publishJson(stagePath(spec), next);
      stage = await loadStage(spec);
    }
    assert(stage);
    if (renewal) await renewal;
    if (renewalError) throw renewalError;
    await store.complete({
      taskId: id,
      owner,
      leaseToken: lease.token,
      fencingEpoch: lease.fencingEpoch,
      status: 'ISSUES',
      idempotencyKey: `complete:${id}:${lease.fencingEpoch}`,
      result: {
        status: 'ISSUES',
        summary: stage.graphImpactReceiptPath
          ? 'Pinned recapture and source diff completed; graph impact requires review.'
          : 'Pinned recapture and source diff completed; graph review was not requested.',
        evidencePaths: [stagePath(spec)],
        rawLogPath: null,
      },
    });
    return tickResult(specPath, spec, 'ISSUES', action, stage);
  } catch (error) {
    const current = await store.load(id);
    if (
      current?.status === 'RUNNING' &&
      current.lease?.token === lease.token &&
      Date.parse(current.lease.expiresAt) > Date.now()
    ) {
      await store.complete({
        taskId: id,
        owner,
        leaseToken: lease.token,
        fencingEpoch: lease.fencingEpoch,
        status: 'BLOCKED',
        idempotencyKey: `blocked:${id}:${lease.fencingEpoch}`,
        result: {
          status: 'BLOCKED',
          summary:
            error instanceof ArchiveRecaptureHandoffError
              ? 'Recapture result needs operator review.'
              : 'Refresh handoff needs operator review.',
          evidencePaths: [specPath],
          rawLogPath: null,
        },
      });
    }
    throw error;
  } finally {
    clearInterval(timer);
    if (renewal) await renewal;
  }
}
