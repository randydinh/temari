/** A pinned, local comparison of exact discovery and BM25 on two question cohorts. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { archiveTransport } from './archive-transport.js';
import {
  loadArchivePublication,
  registrationFor,
  snapshot,
} from './archive-intake.js';
import {
  evaluateArchiveSearch,
  loadArchiveHandoff,
  type ArchiveCaseResult,
  type ArchiveEvaluationCase,
} from './archive-journey.js';
import { canonical, digest, hash, integer, list, object, text } from './codec.js';
import { publishJson } from './durable.js';
import type { JevShadowOptions } from './jev.js';
import { loadRetrieval, type RetrievalCheckpoint } from './retrieval.js';

export interface RetrievalGateQuestion {
  readonly id: string;
  readonly query: string;
  readonly sourceIds: readonly string[];
  readonly expected: ArchiveEvaluationCase['expected'];
}
export interface RetrievalGatePlan {
  readonly schema: 1;
  readonly handoffPath: string;
  readonly topK: number;
  readonly cohorts: {
    readonly development: readonly RetrievalGateQuestion[];
    readonly holdout: readonly RetrievalGateQuestion[];
  };
}
export interface RetrievalGateCohort {
  readonly questions: number;
  readonly indexedGold: number;
  readonly totalGold: number;
  readonly coverageGapCaseIds: readonly string[];
  readonly coverageReasons: Readonly<Record<string, number>>;
  readonly exactHits: number;
  readonly bm25Hits: number;
  readonly exactRecallAtK: number | null;
  readonly bm25RecallAtK: number | null;
  readonly improvedCaseIds: readonly string[];
  readonly regressedCaseIds: readonly string[];
  readonly unverifiedCaseIds: readonly string[];
  readonly exactMeanDiscoveryMs: number;
  readonly bm25MeanDiscoveryMs: number;
  readonly reportPaths: { readonly exact: string; readonly bm25: string };
}
export interface RetrievalGateReceipt {
  readonly schema: 1;
  readonly kind: 'temari-retrieval-gate';
  readonly policy: 'exact-vs-bm25-coverage-gate-v1';
  readonly status: 'coverage-blocked' | 'insufficient-sample' | 'rejected' | 'promotion-eligible';
  readonly questionSetSha256: string;
  readonly handoffSha256: string;
  readonly topK: number;
  readonly cohorts: {
    readonly development: RetrievalGateCohort;
    readonly holdout: RetrievalGateCohort;
  };
  readonly conclusion: string;
}

type Coverage = { readonly indexed: boolean; readonly reason: string };
const key = (sourceId: string, path: string): string => canonical([sourceId, path]);
const reasonPriority = [
  'pdf-memory-boundary-unavailable',
  'extraction-output-limit',
  'extraction-resource-boundary',
  'unsupported-format',
  'ocr-transcription-unreviewed',
  'visual-evidence-unavailable',
  'empty-document',
] as const;

export function representationCoverage(item: Record<string, unknown>): Coverage {
  if (item['representation'] !== null && item['representation'] !== undefined)
    return { indexed: true, reason: 'indexed' };
  const gaps = list(item['gaps']).filter((reason) => typeof reason === 'string') as string[];
  const reason = reasonPriority.find((gap) => gaps.includes(gap)) ??
    (['limited', 'unavailable', 'unsupported'].includes(String(item['status']))
      ? String(item['status']) : 'no-text-representation');
  return { indexed: false, reason };
}

function validatePlan(value: unknown): RetrievalGatePlan {
  const plan = object(value);
  assert.deepEqual(Object.keys(plan).sort(), ['cohorts', 'handoffPath', 'schema', 'topK']);
  assert.equal(plan['schema'], 1);
  assert(isAbsolute(text(plan['handoffPath'])));
  integer(plan['topK'], 1, 8);
  const cohorts = object(plan['cohorts']);
  assert.deepEqual(Object.keys(cohorts).sort(), ['development', 'holdout']);
  const allIds = new Set<string>();
  const allQuestions = new Set<string>();
  const allGold = new Set<string>();
  for (const name of ['development', 'holdout']) {
    const questions = list(cohorts[name]);
    assert(questions.length >= 1 && questions.length <= 16);
    for (const raw of questions) {
      const question = object(raw);
      assert.deepEqual(Object.keys(question).sort(), ['expected', 'id', 'query', 'sourceIds']);
      const id = text(question['id']);
      const query = text(question['query']);
      assert(id.length <= 128 && query.length <= 512 && !allIds.has(id));
      allIds.add(id);
      const sourceIds = list(question['sourceIds']).map(text);
      assert(sourceIds.length >= 1 && sourceIds.length <= 8);
      assert.equal(new Set(sourceIds).size, sourceIds.length);
      const expected = list(question['expected']);
      assert(expected.length >= 1 && expected.length <= 16);
      const gold = new Set<string>();
      for (const rawGold of expected) {
        const item = object(rawGold);
        assert.deepEqual(Object.keys(item).sort(), ['path', 'sourceId']);
        const sourceId = text(item['sourceId']);
        const path = text(item['path']);
        assert(sourceIds.includes(sourceId));
        assert(path.length <= 4096 && !isAbsolute(path) && !path.includes('\\') &&
          !path.includes('\0') && !path.startsWith('-') &&
          !path.split('/').some((part) => ['', '.', '..'].includes(part)));
        gold.add(key(sourceId, path));
      }
      assert.equal(gold.size, expected.length);
      for (const target of gold) {
        assert(!allGold.has(target), 'Gold target repeated across questions');
        allGold.add(target);
      }
      const normalizedQuery = query.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
      const identity = hash(canonical([normalizedQuery, [...sourceIds].sort()]));
      assert(!allQuestions.has(identity), 'Question repeated across cohorts');
      allQuestions.add(identity);
    }
  }
  return JSON.parse(canonical(value)) as RetrievalGatePlan;
}

/** A case is independent only when its question and gold target are unique. */
export function retrievalGateStatus(
  cohorts: Readonly<Record<'development' | 'holdout', Pick<RetrievalGateCohort,
    'questions' | 'indexedGold' | 'totalGold' | 'bm25Hits' | 'exactHits' |
    'regressedCaseIds' | 'unverifiedCaseIds'>>>,
): RetrievalGateReceipt['status'] {
  if (Object.values(cohorts).some((c) => c.indexedGold !== c.totalGold))
    return 'coverage-blocked';
  if (Object.values(cohorts).some((c) => c.questions < 5))
    return 'insufficient-sample';
  if (Object.values(cohorts).every((c) =>
    c.bm25Hits > c.exactHits && c.regressedCaseIds.length === 0 &&
    c.unverifiedCaseIds.length === 0)) return 'promotion-eligible';
  return 'rejected';
}

/** Inspect exact retained gold paths. A preserved original without text is a coverage gap. */
async function inspectCoverage(handoffPath: string): Promise<Map<string, Coverage>> {
  const handoff = await loadArchiveHandoff(handoffPath);
  const coverage = new Map<string, Coverage>();
  for (const publicationPath of handoff.publications) {
    const publication = await loadArchivePublication(publicationPath);
    const transport = await archiveTransport(publication.transport);
    assert.equal(transport.implementation, publication.implementation);
    assert.equal(transport.protocolSha256, publication.protocolSha256);
    assert.equal(await registrationFor(transport, publication.source), publication.registration);
    let offset = 0;
    do {
      const page = await transport.invoke('inspect', [
        publication.source.id, publication.generation,
        '--manifest-sha256', publication.manifestSha256,
        '--offset', String(offset), '--limit', '100', '--max-bytes', '1048576',
      ]);
      snapshot(page, publication);
      for (const raw of list(page['documents'])) {
        const item = object(raw);
        const path = text(item['path']);
        coverage.set(key(publication.source.id, path), representationCoverage(item));
      }
      if (page['next_offset'] === null) break;
      offset = integer(page['next_offset'], offset + 1, 1000);
    } while (true);
  }
  return coverage;
}

/** A verified first page is a complete top-K even when lower-ranked pages remain. */
export function discoveryCompleteAtK(
  checkpoint: Pick<RetrievalCheckpoint,
    'discovery' | 'discoveryStarted' | 'discoveryNext' | 'gaps' | 'omittedGapCount'>,
  result: Pick<ArchiveCaseResult, 'ranked' | 'discoveryExhausted'>,
  topK: number,
): boolean {
  if (!checkpoint.discoveryStarted || checkpoint.discovery.length !== 1 ||
      checkpoint.omittedGapCount !== 0 ||
      checkpoint.gaps.some((gap) =>
        gap.subject === 'provider' || gap.subject === 'response-budget')) return false;
  const page = checkpoint.discovery[0];
  const ranked = page.documents.map((item) => ({
    sourceId: item.document.source.id,
    path: item.document.path,
    sha256: item.sha256,
  }));
  return page.coverage.returned === ranked.length &&
    page.coverage.consumed === ranked.length &&
    (page.coverage.exhausted || ranked.length === topK) &&
    result.discoveryExhausted === (checkpoint.discoveryNext === null) &&
    canonical(result.ranked) === canonical(ranked);
}

async function scoreCohort(
  questions: readonly RetrievalGateQuestion[],
  coverage: ReadonlyMap<string, Coverage>,
  exact: readonly ArchiveCaseResult[],
  bm25: readonly ArchiveCaseResult[],
  topK: number,
  reportPaths: RetrievalGateCohort['reportPaths'],
): Promise<RetrievalGateCohort> {
  assert.equal(exact.length, questions.length);
  assert.equal(bm25.length, questions.length);
  let indexedGold = 0, totalGold = 0, eligibleGold = 0, exactHits = 0, bm25Hits = 0;
  let exactDiscoveryMs = 0, bm25DiscoveryMs = 0;
  const coverageGapCaseIds: string[] = [];
  const improvedCaseIds: string[] = [];
  const regressedCaseIds: string[] = [];
  const unverifiedCaseIds: string[] = [];
  const coverageReasons: Record<string, number> = {};
  for (let i = 0; i < questions.length; i++) {
    const question = questions[i], baseline = exact[i], candidate = bm25[i];
    assert.equal(baseline.id, question.id);
    assert.equal(candidate.id, question.id);
    assert.equal(baseline.querySha256, hash(question.query));
    assert.equal(candidate.querySha256, baseline.querySha256);
    assert.equal(baseline.discoveryMode, 'exact');
    assert.equal(candidate.discoveryMode, 'bm25');
    for (const result of [baseline, candidate]) {
      assert.equal(canonical(result.expected), canonical(question.expected));
      assert.equal(canonical(result.sourceIds), canonical(question.sourceIds));
      assert(result.ranked.length <= topK);
      assert.equal(result.jevSharing, 'case-opt-out');
    }
    exactDiscoveryMs += baseline.timingMs.discovery;
    bm25DiscoveryMs += candidate.timingMs.discovery;
    const unavailable = question.expected.map((item) =>
      coverage.get(key(item.sourceId, item.path)) ?? { indexed: false, reason: 'missing-from-capture' });
    totalGold += unavailable.length;
    indexedGold += unavailable.filter((item) => item.indexed).length;
    for (const item of unavailable.filter((item) => !item.indexed))
      coverageReasons[item.reason] = (coverageReasons[item.reason] ?? 0) + 1;
    if (unavailable.some((item) => !item.indexed)) {
      coverageGapCaseIds.push(question.id);
      continue;
    }
    for (const result of [baseline, candidate]) {
      const checkpoint = await loadRetrieval(result.discoveryCheckpointPath);
      assert(discoveryCompleteAtK(checkpoint, result, topK),
        `Discovery incomplete or failed for ${question.id} (${result.discoveryMode})`);
    }
    eligibleGold += question.expected.length;
    const gold = new Set(question.expected.map((item) => key(item.sourceId, item.path)));
    const hits = (result: ArchiveCaseResult): number =>
      result.ranked.filter((item) => gold.has(key(item.sourceId, item.path))).length;
    const before = hits(baseline), after = hits(candidate);
    exactHits += before;
    bm25Hits += after;
    if (after > before) improvedCaseIds.push(question.id);
    if (after < before) regressedCaseIds.push(question.id);
    if ((baseline.ranked.length > 0 && !baseline.shortlistVerified) ||
        (candidate.ranked.length > 0 && !candidate.shortlistVerified))
      unverifiedCaseIds.push(question.id);
  }
  return {
    questions: questions.length, indexedGold, totalGold,
    coverageGapCaseIds, coverageReasons,
    exactHits, bm25Hits,
    exactRecallAtK: eligibleGold ? exactHits / eligibleGold : null,
    bm25RecallAtK: eligibleGold ? bm25Hits / eligibleGold : null,
    improvedCaseIds, regressedCaseIds, unverifiedCaseIds,
    exactMeanDiscoveryMs: Math.round(exactDiscoveryMs / questions.length),
    bm25MeanDiscoveryMs: Math.round(bm25DiscoveryMs / questions.length),
    reportPaths,
  };
}

/** A passing receipt allows review of BM25; it never changes the production ranker. */
export async function runRetrievalGate(
  planPath: string,
  expectedPlanSha256: string,
  jevOptions: JevShadowOptions = {},
): Promise<{ receipt: RetrievalGateReceipt; receiptPath: string }> {
  assert(isAbsolute(planPath));
  digest(expectedPlanSha256);
  const planBytes = await readFile(planPath);
  assert(planBytes.length <= 65536, 'Question set exceeds byte bound');
  assert.equal(hash(planBytes), expectedPlanSha256, 'Question set pin changed');
  const plan = validatePlan(JSON.parse(planBytes.toString('utf8')));
  const handoff = await loadArchiveHandoff(plan.handoffPath);
  const handoffBytes = await readFile(plan.handoffPath);
  const coverage = await inspectCoverage(plan.handoffPath);
  const outputs = {} as Record<'development' | 'holdout', RetrievalGateCohort>;
  for (const name of ['development', 'holdout'] as const) {
    const questions = plan.cohorts[name];
    const run = async (discoveryMode: 'exact' | 'bm25') =>
      evaluateArchiveSearch({
        handoffPath: plan.handoffPath,
        cases: questions.map((question) => ({
          ...question, topK: plan.topK, discoveryMode, hostedTextApproved: false,
        })),
      }, jevOptions);
    const exact = await run('exact');
    const bm25 = await run('bm25');
    outputs[name] = await scoreCohort(questions, coverage, exact.report.cases,
      bm25.report.cases, plan.topK,
      { exact: exact.reportPath, bm25: bm25.reportPath });
  }
  assert.equal(hash(await readFile(planPath)), expectedPlanSha256,
    'Question set changed during evaluation');
  assert.equal(hash(await readFile(plan.handoffPath)), hash(handoffBytes),
    'Archive handoff changed during evaluation');
  const cohorts = { development: outputs.development, holdout: outputs.holdout };
  const status = retrievalGateStatus(cohorts);
  const conclusion = status === 'coverage-blocked'
    ? 'At least one gold document lacks archived text; repair coverage before ranker promotion.'
    : status === 'insufficient-sample'
      ? 'At least five independent questions per cohort are required for this gate.'
      : status === 'rejected'
        ? 'BM25 did not improve both cohorts without per-case regression and unverified shortlists.'
        : 'BM25 passed the local gate; review separately before changing the default.';
  const receipt: RetrievalGateReceipt = {
    schema: 1, kind: 'temari-retrieval-gate', policy: 'exact-vs-bm25-coverage-gate-v1',
    status, questionSetSha256: expectedPlanSha256,
    handoffSha256: hash(handoffBytes), topK: plan.topK, cohorts, conclusion,
  };
  const receiptPath = join(handoff.task.directory,
    `retrieval-gate-${hash(canonical(receipt))}.json`);
  await publishJson(receiptPath, receipt);
  return { receipt, receiptPath };
}
