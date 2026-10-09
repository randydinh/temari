/** One explicit Responses shadow trial. Historical jobs and receipts remain independent. */
import assert from 'node:assert/strict';
import { basename, dirname, join } from 'node:path';
import type { KnowledgeCheck, KnowledgeEvidence } from '@temari/contracts';
import {
  loadArchiveHandoff,
  runArchiveQuery,
  type ArchiveQueryInput,
  type ArchiveIntakeHandoff,
} from './archive-journey.js';
import {
  canonical,
  checkBasis,
  evidence as validateEvidence,
  hash,
  object,
} from './codec.js';
import { createArchiveRegistrar } from './archive-registrar.js';
import { loadArchivePublication } from './archive-intake.js';
import { publishJson, readJsonWithBytes } from './durable.js';
import {
  currentJevSharingGuard,
  checkCurrentJevSharing,
} from './current-jev-sharing.js';
import {
  judgeOpenAIResponsesShadow,
  type OpenAIResponsesShadowCandidate,
  type OpenAIResponsesShadowOptions,
  type OpenAIResponsesShadowResult,
} from './openai-responses.js';

export interface OpenAIResponsesTrialInput extends ArchiveQueryInput {
  readonly provider: 'none' | 'openai-responses';
  readonly model: string;
  readonly hostedTextApproved: boolean;
}
export interface OpenAIResponsesTrialReport {
  readonly schema: 1;
  readonly kind: 'temari-openai-responses-trial';
  readonly id: string;
  readonly handoffPath: string;
  readonly task: ArchiveIntakeHandoff['task'];
  readonly baseQueryReportPath: string;
  readonly baseQueryReportSha256: string;
  readonly retrievalCheckpointPath: string | null;
  readonly retrievalCheckpointSha256: string | null;
  readonly result: OpenAIResponsesShadowResult;
  readonly gaps: readonly string[];
}
export async function runOpenAIResponsesTrial(
  input: OpenAIResponsesTrialInput,
  options: OpenAIResponsesShadowOptions = {},
) {
  const selected = JSON.parse(canonical(input)) as OpenAIResponsesTrialInput;
  assert.deepEqual(
    Object.keys(selected).sort(),
    [
      'handoffPath',
      'id',
      'query',
      'sourceIds',
      'topK',
      'discoveryMode',
      'provider',
      'model',
      'hostedTextApproved',
    ].sort(),
    'Unknown or missing trial field',
  );
  assert(['none', 'openai-responses'].includes(selected.provider));
  assert.equal(typeof selected.hostedTextApproved, 'boolean');
  const handoff = await loadArchiveHandoff(selected.handoffPath);
  const { provider: _provider, model: _model, ...baseInput } = selected;
  const base = await runArchiveQuery({
    ...baseInput,
    hostedTextApproved: false,
  });
  const publications = await Promise.all(
    handoff.publications.map(loadArchivePublication),
  );
  const selectedPublications = handoff.publications.filter((_p, i) =>
    selected.sourceIds.includes(publications[i].source.id),
  );
  const archiveProvider = await createArchiveRegistrar({
    publications: selectedPublications,
    readScope: 'source-root',
    discoveryMode: selected.discoveryMode,
  });
  const candidates: OpenAIResponsesShadowCandidate[] = [];
  let checkpointSha256: string | null = null;
  const checkpointPath = base.report.query.retrievalCheckpointPath;
  if (checkpointPath) {
    assert.equal(dirname(checkpointPath), handoff.task.directory);
    const saved = await readJsonWithBytes(checkpointPath);
    const checkpoint = object(saved.value);
    assert.equal(saved.bytes.toString('utf8'), canonical(checkpoint));
    assert.equal(
      basename(checkpointPath),
      `archive-shortlist-${hash(canonical(checkpoint))}.json`,
    );
    assert.equal(checkpoint['schema'], 1);
    assert.equal(checkpoint['kind'], 'temari-archive-shortlist');
    assert.equal(canonical(checkpoint['task']), canonical(base.report.task));
    assert.equal(
      canonical(checkpoint['provider']),
      canonical(archiveProvider.identity),
    );
    assert.equal(checkpoint['querySha256'], hash(selected.query));
    assert.equal(
      canonical(checkpoint['ranked']),
      canonical(base.report.query.ranked),
    );
    assert.equal(checkpoint['readMode'], 'first-1000-codepoints');
    assert.equal(checkpoint['fullDocumentRead'], false);
    const evidence = checkpoint['evidence'] as KnowledgeEvidence[];
    const checks = checkpoint['checks'] as KnowledgeCheck[];
    assert(Array.isArray(evidence) && evidence.length <= 16);
    assert(Array.isArray(checks) && checks.length <= 16);
    assert.equal(new Set(evidence.map((e) => e.id)).size, evidence.length);
    assert.equal(new Set(checks.map((c) => c.evidenceId)).size, checks.length);
    for (const e of evidence) {
      validateEvidence(e);
      assert(
        publications.some(
          (p) =>
            selected.sourceIds.includes(p.source.id) &&
            canonical(p.source) === canonical(e.document.source),
        ),
      );
      assert(checks.filter((c) => c.evidenceId === e.id).length <= 1);
      assert(
        base.report.query.ranked.some(
          (r) =>
            r.sourceId === e.document.source.id &&
            r.path === e.document.path &&
            r.sha256 === e.sha256,
        ),
      );
    }
    for (const r of base.report.query.ranked) {
      const matches = evidence.filter(
        (e) =>
          e.document.source.id === r.sourceId &&
          e.document.path === r.path &&
          e.sha256 === r.sha256,
      );
      assert(matches.length <= 1);
      const e = matches[0];
      if (!e) continue;
      const check = checks.find((c) => c.evidenceId === e.id);
      if (!check) continue;
      checkBasis(check, e);
      if (check.state !== 'unchanged' || !e.excerpt) continue;
      assert(e.span.start === 0 && [...e.excerpt].length <= 1000);
      candidates.push({
        id: hash(canonical(e.document)),
        evidenceIds: [e.id],
        excerpt: e.excerpt,
        required: false,
        contrary: false,
      });
    }
    checkpointSha256 = hash(saved.bytes);
  }
  const baseSaved = await readJsonWithBytes(base.reportPath);
  assert.equal(baseSaved.bytes.toString('utf8'), canonical(base.report));
  const baseQueryReportSha256 = hash(baseSaved.bytes);
  const localOnly = selected.sourceIds.some((id) =>
    handoff.jevPolicy?.localOnlySourceIds.includes(id),
  );
  const currentSharingGuard = currentJevSharingGuard(
    selectedPublications,
    selected.sourceIds,
  );
  let result = await judgeOpenAIResponsesShadow(
    {
      provider: selected.provider,
      model: selected.model,
      query: selected.query,
      hostedTextApproved: selected.hostedTextApproved && !localOnly,
      ...(!selected.hostedTextApproved || localOnly
        ? {
            denialReason: localOnly
              ? ('local-only' as const)
              : ('case-opt-out' as const),
          }
        : {}),
      candidates,
    },
    {
      fetcher: options.fetcher,
      sleep: options.sleep,
      timeoutMs: options.timeoutMs,
      get apiKey() {
        return options.apiKey;
      },
      currentSharingGuard,
    },
  );
  if (checkpointPath)
    assert.equal(
      hash((await readJsonWithBytes(checkpointPath)).bytes),
      checkpointSha256,
      'Shortlist changed during trial',
    );
  assert.equal(
    hash((await readJsonWithBytes(base.reportPath)).bytes),
    baseQueryReportSha256,
    'Base query changed during trial',
  );
  // Recheck immediately before publication, including changes after the last POST.
  if (
    selected.provider === 'openai-responses' &&
    selected.hostedTextApproved &&
    !localOnly
  ) {
    const sharing = await checkCurrentJevSharing(currentSharingGuard);
    if (sharing !== 'allowed')
      result = {
        ...result,
        sharing,
        judgments: result.judgments.map((j) => ({
          ...j,
          relevance: null,
          support: 'unknown',
          supportConfidence: null,
          state: 'unknown',
          gap: sharing,
        })),
      };
  }
  const report: OpenAIResponsesTrialReport = {
    schema: 1,
    kind: 'temari-openai-responses-trial',
    id: selected.id,
    handoffPath: selected.handoffPath,
    task: handoff.task,
    baseQueryReportPath: base.reportPath,
    baseQueryReportSha256,
    retrievalCheckpointPath: checkpointPath,
    retrievalCheckpointSha256: checkpointSha256,
    result,
    gaps: [
      ...new Set(result.judgments.flatMap((j) => (j.gap ? [j.gap] : []))),
      ...(candidates.length ? [] : ['no-verified-excerpts']),
    ],
  };
  const reportPath = join(
    handoff.task.directory,
    `openai-responses-trial-${hash(canonical(report))}.json`,
  );
  await publishJson(reportPath, report);
  return { report, reportPath };
}
