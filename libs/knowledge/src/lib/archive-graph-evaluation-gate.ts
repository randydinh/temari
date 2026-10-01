/** Sealed local BM25/graph comparison. It cannot promote a ranking policy. */
import assert from 'node:assert/strict';
import { basename, isAbsolute, join } from 'node:path';
import { archiveTransport } from './archive-transport.js';
import { loadArchivePublication, registrationFor, snapshot } from './archive-intake.js';
import {
  evaluateArchiveSearch, loadArchiveHandoff,
  type ArchiveCaseResult, type ArchiveEvaluationCase,
} from './archive-journey.js';
import { discoveryCompleteAtK, representationCoverage } from './archive-evaluation-gate.js';
import { canonical, digest, hash, integer, list, object, text } from './codec.js';
import { publishJson, readJsonWithBytes } from './durable.js';
import type { JevShadowOptions } from './jev.js';
import { loadRetrieval } from './retrieval.js';

export interface GraphGateQuestion {
  readonly id: string;
  readonly query: string;
  readonly sourceIds: readonly string[];
  readonly expected: ArchiveEvaluationCase['expected'];
}
export interface GraphGatePlan {
  readonly schema: 1;
  readonly handoffPath: string;
  readonly graphId: string;
  readonly topK: number;
  readonly cohorts: {
    readonly development: readonly GraphGateQuestion[];
    readonly holdout: readonly GraphGateQuestion[];
  };
}
export interface GraphGateCohort {
  readonly questions: number;
  readonly indexedGold: number;
  readonly totalGold: number;
  readonly coverageGapCaseIds: readonly string[];
  readonly coverageReasons: Readonly<Record<string, number>>;
  readonly bm25Hits: number;
  readonly graphHits: number;
  readonly bm25RecallAtK: number | null;
  readonly graphRecallAtK: number | null;
  readonly improvedCaseIds: readonly string[];
  readonly regressedCaseIds: readonly string[];
  readonly negativeExpansionCaseIds: readonly string[];
  readonly unverifiedCaseIds: readonly string[];
  /** Final selected excerpts, not total discovery or graph traversal work. */
  readonly bm25SelectedExcerptBytes: number;
  readonly graphSelectedExcerptBytes: number;
  readonly bm25SelectedExcerptCodePoints: number;
  readonly graphSelectedExcerptCodePoints: number;
  /** Extra graph physical work is recorded independently from selected context. */
  readonly graphTargetReadAttempts: number;
  readonly graphProjectionNodes: number;
  readonly reportPath: string;
}
export interface GraphGateReceipt {
  readonly schema: 1;
  readonly kind: 'temari-graph-retrieval-gate';
  readonly policy: 'bm25-vs-one-hop-graph-diagnostic-v1';
  readonly status: 'coverage-blocked' | 'insufficient-sample' | 'rejected' | 'diagnostic-improvement';
  readonly promotionEligible: false;
  readonly questionSetSha256: string;
  readonly handoffSha256: string;
  readonly graphId: string;
  readonly topK: number;
  readonly cohorts: { readonly development: GraphGateCohort; readonly holdout: GraphGateCohort };
  readonly conclusion: string;
}

type Coverage = { indexed: boolean; reason: string };
const key = (sourceId: string, path: string) => canonical([sourceId, path]);
const identity = (item: { sourceId: string; path: string; sha256: string }) =>
  canonical([item.sourceId, item.path, item.sha256]);

export function graphCaseGoldChange(
  baseline: readonly { sourceId: string; path: string }[],
  graph: readonly { sourceId: string; path: string }[],
  expected: readonly { sourceId: string; path: string }[],
): { before: number; after: number; displacedGold: boolean } {
  const gold = new Set(expected.map((item) => key(item.sourceId, item.path)));
  const beforeSet = new Set(baseline.map((item) => key(item.sourceId, item.path))
    .filter((item) => gold.has(item)));
  const afterSet = new Set(graph.map((item) => key(item.sourceId, item.path))
    .filter((item) => gold.has(item)));
  return {
    before: beforeSet.size,
    after: afterSet.size,
    displacedGold: [...beforeSet].some((item) => !afterSet.has(item)),
  };
}
export const nonHostedSharing = (value: ArchiveCaseResult['jevSharing']): boolean =>
  value === 'case-opt-out' || value === 'local-only';

function validatePlan(value: unknown): GraphGatePlan {
  const plan = object(value);
  assert.deepEqual(Object.keys(plan).sort(), ['cohorts', 'graphId', 'handoffPath', 'schema', 'topK']);
  assert.equal(plan['schema'], 1);
  assert(isAbsolute(text(plan['handoffPath'])));
  digest(plan['graphId']);
  integer(plan['topK'], 2, 8);
  const cohorts = object(plan['cohorts']);
  assert.deepEqual(Object.keys(cohorts).sort(), ['development', 'holdout']);
  const ids = new Set<string>(), queries = new Set<string>(), goldAcross = new Set<string>();
  for (const name of ['development', 'holdout']) {
    const questions = list(cohorts[name]);
    assert(questions.length >= 1 && questions.length <= 16);
    for (const raw of questions) {
      const question = object(raw);
      assert.deepEqual(Object.keys(question).sort(), ['expected', 'id', 'query', 'sourceIds']);
      const id = text(question['id']), query = text(question['query']);
      assert(id.length <= 128 && query.length <= 512 && !ids.has(id));
      ids.add(id);
      const sourceIds = list(question['sourceIds']).map(text);
      assert(sourceIds.length >= 1 && sourceIds.length <= 8);
      assert.equal(new Set(sourceIds).size, sourceIds.length);
      const queryKey = hash(canonical([
        query.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase(),
        [...sourceIds].sort(),
      ]));
      assert(!queries.has(queryKey), 'Question repeated across cohorts');
      queries.add(queryKey);
      const expected = list(question['expected']);
      assert(expected.length >= 1 && expected.length <= 16);
      const gold = new Set<string>();
      for (const rawGold of expected) {
        const item = object(rawGold);
        assert.deepEqual(Object.keys(item).sort(), ['path', 'sourceId']);
        const sourceId = text(item['sourceId']), path = text(item['path']);
        assert(sourceIds.includes(sourceId));
        assert(path.length <= 4096 && !isAbsolute(path) && !path.includes('\\') &&
          !path.includes('\0') && !path.startsWith('-') &&
          !path.split('/').some((part) => ['', '.', '..'].includes(part)));
        gold.add(key(sourceId, path));
      }
      assert.equal(gold.size, expected.length);
      for (const target of gold) {
        assert(!goldAcross.has(target), 'Gold target repeated across questions');
        goldAcross.add(target);
      }
    }
  }
  return JSON.parse(canonical(value)) as GraphGatePlan;
}

async function inspectCoverage(handoffPath: string): Promise<Map<string, Coverage>> {
  const handoff = await loadArchiveHandoff(handoffPath);
  const coverage = new Map<string, Coverage>();
  for (const path of handoff.publications) {
    const publication = await loadArchivePublication(path);
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
        coverage.set(key(publication.source.id, text(item['path'])), representationCoverage(item));
      }
      if (page['next_offset'] === null) break;
      offset = integer(page['next_offset'], offset + 1, 1000);
    } while (true);
  }
  return coverage;
}

interface Excerpt { readonly sourceId: string; readonly path: string; readonly sha256: string; readonly excerpt: string }
async function checkpoint(path: string, prefix: string): Promise<Record<string, unknown>> {
  assert(isAbsolute(path));
  const { value } = await readJsonWithBytes(path);
  const saved = object(value);
  assert.equal(basename(path), `${prefix}-${hash(canonical(saved))}.json`, 'Checkpoint identity changed');
  return saved;
}
function excerpts(value: Record<string, unknown>): Excerpt[] {
  return list(value['evidence']).map((raw) => {
    const e = object(raw), document = object(e['document']), source = object(document['source']);
    return {
      sourceId: text(source['id']), path: text(document['path']),
      sha256: digest(e['sha256']), excerpt: text(e['excerpt']),
    };
  });
}
function selectedSize(
  ranked: readonly { sourceId: string; path: string; sha256: string }[],
  evidence: readonly Excerpt[],
): { bytes: number; codePoints: number } | null {
  const byIdentity = new Map(evidence.map((e) => [identity(e), e.excerpt]));
  const chosen = ranked.map((item) => byIdentity.get(identity(item)));
  if (chosen.some((item) => item === undefined)) return null;
  const strings = chosen as string[];
  return {
    bytes: strings.reduce((sum, item) => sum + Buffer.byteLength(item, 'utf8'), 0),
    codePoints: strings.reduce((sum, item) => sum + Array.from(item).length, 0),
  };
}

export function graphGateStatus(cohorts: Readonly<Record<'development' | 'holdout',
  Pick<GraphGateCohort, 'questions' | 'indexedGold' | 'totalGold' | 'bm25Hits' |
    'graphHits' | 'regressedCaseIds' | 'negativeExpansionCaseIds' |
    'unverifiedCaseIds'>>>): GraphGateReceipt['status'] {
  if (Object.values(cohorts).some((c) => c.indexedGold !== c.totalGold)) return 'coverage-blocked';
  if (Object.values(cohorts).some((c) => c.questions < 5)) return 'insufficient-sample';
  if (Object.values(cohorts).every((c) => c.graphHits > c.bm25Hits &&
    c.regressedCaseIds.length === 0 && c.unverifiedCaseIds.length === 0 &&
    c.negativeExpansionCaseIds.length >= 1))
    return 'diagnostic-improvement';
  return 'rejected';
}

async function scoreCohort(
  questions: readonly GraphGateQuestion[], coverage: ReadonlyMap<string, Coverage>,
  results: readonly ArchiveCaseResult[], topK: number, graphId: string, reportPath: string,
): Promise<GraphGateCohort> {
  assert.equal(results.length, questions.length);
  let indexedGold = 0, totalGold = 0, eligibleGold = 0, bm25Hits = 0, graphHits = 0;
  let bm25Bytes = 0, graphBytes = 0, bm25Points = 0, graphPoints = 0;
  let graphTargetReadAttempts = 0, graphProjectionNodes = 0;
  const coverageGapCaseIds: string[] = [], improvedCaseIds: string[] = [];
  const regressedCaseIds: string[] = [], unverifiedCaseIds: string[] = [];
  const negativeExpansionCaseIds: string[] = [];
  const coverageReasons: Record<string, number> = {};
  for (let i = 0; i < questions.length; i++) {
    const question = questions[i], result = results[i];
    assert.equal(result.id, question.id);
    assert.equal(result.querySha256, hash(question.query));
    assert.equal(result.discoveryMode, 'bm25');
    assert(nonHostedSharing(result.jevSharing), 'Graph gate case allowed hosted text');
    assert.equal(canonical(result.expected), canonical(question.expected));
    assert.equal(canonical(result.sourceIds), canonical(question.sourceIds));
    assert(result.ranked.length <= topK);
    assert.equal(result.graph?.graphId, graphId);
    assert((result.graph?.ranked.length ?? 0) <= topK);
    assert(Number.isInteger(result.graph?.targetReadAttempts) &&
      result.graph!.targetReadAttempts >= 0 && result.graph!.targetReadAttempts <= topK - 1);
    assert(Number.isInteger(result.graph?.projectionNodeCount) &&
      result.graph!.projectionNodeCount >= 0);
    graphTargetReadAttempts += result.graph!.targetReadAttempts;
    graphProjectionNodes += result.graph!.projectionNodeCount;
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
    const discovery = await loadRetrieval(result.discoveryCheckpointPath);
    assert(discoveryCompleteAtK(discovery, result, topK), `BM25 discovery incomplete: ${question.id}`);
    eligibleGold += question.expected.length;
    const graph = result.graph!;
    const { before, after, displacedGold } = graphCaseGoldChange(
      result.ranked, graph.ranked, question.expected);
    bm25Hits += before; graphHits += after;
    if (after > before) improvedCaseIds.push(question.id);
    if (after < before || displacedGold) regressedCaseIds.push(question.id);
    if (graph.added.length > 0 && after <= before)
      negativeExpansionCaseIds.push(question.id);
    let verified = result.ranked.length === 0 || result.shortlistVerified;
    let baselineExcerpts: Excerpt[] = [];
    let baselineProvider: unknown = null;
    if (result.retrievalCheckpointPath) {
      const saved = await checkpoint(result.retrievalCheckpointPath, 'archive-shortlist');
      assert.equal(saved['kind'], 'temari-archive-shortlist');
      assert.equal(saved['querySha256'], hash(question.query));
      assert.equal(canonical(saved['ranked']), canonical(result.ranked));
      baselineProvider = saved['provider'];
      const evidence = excerpts(saved);
      const checks = list(saved['checks']).map(object);
      const evidenceIds = new Set(list(saved['evidence']).map((item) => text(object(item)['id'])));
      verified &&= checks.length === result.ranked.length &&
        checks.every((check) => check['state'] === 'unchanged' &&
          evidenceIds.has(text(check['evidenceId'])));
      baselineExcerpts = evidence;
    } else verified &&= result.ranked.length === 0;
    if (graph.checkpointPath) {
      const saved = await checkpoint(graph.checkpointPath, 'archive-graph-trial');
      assert.equal(saved['kind'], 'temari-archive-graph-trial');
      assert.equal(saved['graphId'], graphId);
      assert.equal(canonical(saved['added']), canonical(graph.added));
      verified &&= canonical(saved['provider']) === canonical(baselineProvider) &&
        saved['targetReadAttempts'] === graph.targetReadAttempts &&
        saved['projectionNodeCount'] === graph.projectionNodeCount;
      const addedEvidence = excerpts(saved);
      verified &&= graph.verifiedEvidenceCount === graph.added.length &&
        addedEvidence.length === graph.added.length &&
        graph.added.every((item) => addedEvidence.some((e) => identity(e) === identity(item)));
      baselineExcerpts = [...baselineExcerpts, ...addedEvidence];
    } else verified &&= graph.added.length === 0;
    verified &&= graph.status === 'complete' && graph.gaps.length === 0 &&
      result.gaps.every((gap) => gap.subject !== 'provider' && gap.subject !== 'response-budget');
    verified &&= Number.isInteger(graph.targetReadAttempts) &&
      graph.targetReadAttempts >= 0 && graph.targetReadAttempts <= topK - 1 &&
      Number.isInteger(graph.projectionNodeCount) && graph.projectionNodeCount >= 0;
    const baseline = selectedSize(result.ranked, baselineExcerpts);
    const withGraph = selectedSize(graph.ranked, baselineExcerpts);
    verified &&= baseline !== null && withGraph !== null;
    if (baseline && withGraph) verified &&=
      baseline.codePoints <= topK * 1000 && withGraph.codePoints <= topK * 1000 &&
      baseline.bytes <= topK * 4000 && withGraph.bytes <= topK * 4000;
    if (!verified) unverifiedCaseIds.push(question.id);
    if (baseline) { bm25Bytes += baseline.bytes; bm25Points += baseline.codePoints; }
    if (withGraph) { graphBytes += withGraph.bytes; graphPoints += withGraph.codePoints; }
  }
  return {
    questions: questions.length, indexedGold, totalGold, coverageGapCaseIds, coverageReasons,
    bm25Hits, graphHits,
    bm25RecallAtK: eligibleGold ? bm25Hits / eligibleGold : null,
    graphRecallAtK: eligibleGold ? graphHits / eligibleGold : null,
    improvedCaseIds, regressedCaseIds, negativeExpansionCaseIds, unverifiedCaseIds,
    bm25SelectedExcerptBytes: bm25Bytes, graphSelectedExcerptBytes: graphBytes,
    bm25SelectedExcerptCodePoints: bm25Points, graphSelectedExcerptCodePoints: graphPoints,
    graphTargetReadAttempts, graphProjectionNodes, reportPath,
  };
}

/** A diagnostic result never authorizes graph ranking as a default. */
export async function runGraphRetrievalGate(
  planPath: string, expectedPlanSha256: string, expectedHandoffSha256: string,
  jevOptions: JevShadowOptions = {},
): Promise<{ receipt: GraphGateReceipt; receiptPath: string }> {
  assert(isAbsolute(planPath));
  digest(expectedPlanSha256); digest(expectedHandoffSha256);
  const { bytes: planBytes, value } = await readJsonWithBytes(planPath);
  assert(planBytes.length <= 65536, 'Question set exceeds byte bound');
  assert.equal(hash(planBytes), expectedPlanSha256, 'Question set pin changed');
  const plan = validatePlan(value);
  const { bytes: handoffBytes } = await readJsonWithBytes(plan.handoffPath);
  assert.equal(hash(handoffBytes), expectedHandoffSha256, 'Archive handoff pin changed');
  const handoff = await loadArchiveHandoff(plan.handoffPath);
  const sourceIds = new Set(handoff.sources.map((source) => source.id));
  for (const cohort of Object.values(plan.cohorts))
    for (const question of cohort)
      for (const id of question.sourceIds)
        assert(sourceIds.has(id), 'Question source outside handoff');
  const coverage = await inspectCoverage(plan.handoffPath);
  const outputs = {} as Record<'development' | 'holdout', GraphGateCohort>;
  for (const name of ['development', 'holdout'] as const) {
    const questions = plan.cohorts[name];
    const { report, reportPath } = await evaluateArchiveSearch({
      handoffPath: plan.handoffPath,
      cases: questions.map((q) => ({
        ...q, topK: plan.topK, discoveryMode: 'bm25' as const,
        hostedTextApproved: false, graphId: plan.graphId,
      })),
    }, jevOptions);
    outputs[name] = await scoreCohort(questions, coverage, report.cases,
      plan.topK, plan.graphId, reportPath);
  }
  assert.equal(hash((await readJsonWithBytes(planPath)).bytes), expectedPlanSha256,
    'Question set changed during evaluation');
  assert.equal(hash((await readJsonWithBytes(plan.handoffPath)).bytes), expectedHandoffSha256,
    'Archive handoff changed during evaluation');
  const cohorts = { development: outputs.development, holdout: outputs.holdout };
  const status = graphGateStatus(cohorts);
  const conclusion = status === 'coverage-blocked'
    ? 'Gold archive text coverage is incomplete; graph ranking cannot be assessed.'
    : status === 'insufficient-sample'
      ? 'At least five independent questions per cohort are required.'
      : status === 'rejected'
        ? 'The graph did not improve both cohorts without regression or verification gaps.'
        : 'The graph improved this diagnostic sample; separate work is required before default ranking review.';
  const receipt: GraphGateReceipt = {
    schema: 1, kind: 'temari-graph-retrieval-gate',
    policy: 'bm25-vs-one-hop-graph-diagnostic-v1', status, promotionEligible: false,
    questionSetSha256: expectedPlanSha256, handoffSha256: expectedHandoffSha256,
    graphId: plan.graphId, topK: plan.topK, cohorts, conclusion,
  };
  const receiptPath = join(handoff.task.directory,
    `graph-retrieval-gate-${hash(canonical(receipt))}.json`);
  await publishJson(receiptPath, receipt);
  return { receipt, receiptPath };
}
