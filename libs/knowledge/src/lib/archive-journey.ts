/** Local, revision-pinned intake and retrieval evaluation. No source text enters reports. */
import assert from 'node:assert/strict';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type {
  InvestigationTask,
  KnowledgeCheck,
  KnowledgeEvidence,
  KnowledgeGap,
} from '@temari/contracts';
import {
  captureArchive,
  loadArchivePublication,
  type ArchiveIntakeOptions,
  type ArchiveIntakeOutcome,
} from './archive-intake.js';
import { createArchiveRegistrar } from './archive-registrar.js';
import {
  evaluateArchiveGraphTrial,
  type ArchiveGraphTrial,
} from './archive-graph-trial.js';
import {
  publishArchiveStructure,
  type ArchiveStructurePlan,
} from './archive-structure.js';
import { canonical, checkBasis, hash, integer, object, text } from './codec.js';
import { publishJson, readJson } from './durable.js';
import {
  judgeJevShadow,
  type JevShadowOptions,
  type JevShadowResult,
} from './jev.js';
import { collectKnowledge, loadRetrieval } from './retrieval.js';

export interface ArchiveIntakePlan {
  readonly task: InvestigationTask;
  readonly intakes: readonly ArchiveIntakeOptions[];
  /** Sources retained locally for Jev; all other admitted sources use Jev by default. */
  readonly localOnlySourceIds?: readonly string[];
  readonly structures?: readonly (Omit<
    ArchiveStructurePlan,
    'publicationPath'
  > & { sourceId: string })[];
}
export interface ArchiveIntakeHandoff {
  readonly schema: 1;
  readonly kind: 'temari-archive-intake-handoff';
  readonly task: InvestigationTask;
  readonly publications: readonly string[];
  /** Absent only on legacy handoffs, which retain per-case approval semantics. */
  readonly jevPolicy?: {
    readonly mode: 'registered-sources';
    readonly localOnlySourceIds: readonly string[];
  };
  readonly sources: readonly {
    id: string;
    generation: string;
    manifestSha256: string;
    preservation: string;
    gapCount: number;
  }[];
  readonly structures?: readonly {
    sourceId: string;
    graphId: string;
    receiptPath: string;
  }[];
}
export interface ArchiveIntakeBatchResult {
  readonly status: 'published' | 'blocked';
  readonly handoffPath: string | null;
  readonly outcomes: readonly ArchiveIntakeOutcome[];
  readonly structures?: ArchiveIntakeHandoff['structures'];
}
export interface ArchiveEvaluationCase {
  readonly id: string;
  readonly query: string;
  readonly sourceIds: readonly string[];
  readonly expected: readonly { sourceId: string; path: string }[];
  readonly topK: number;
  readonly discoveryMode: 'exact' | 'bm25';
  /** Optional per-case opt-out; true cannot override a local-only source. */
  readonly hostedTextApproved?: boolean;
  /** Optional one-hop graph ablation; lexical ranking remains the baseline. */
  readonly graphId?: string;
}
export interface ArchiveSearchPlan {
  readonly handoffPath: string;
  readonly cases: readonly ArchiveEvaluationCase[];
}
export interface ArchiveCaseResult {
  readonly id: string;
  readonly querySha256: string;
  readonly discoveryMode: 'exact' | 'bm25';
  readonly sourceIds: readonly string[];
  readonly jevSharing: 'allowed' | 'local-only' | 'case-opt-out';
  readonly expected: ArchiveEvaluationCase['expected'];
  readonly sourceCapabilityGaps: readonly KnowledgeGap[];
  readonly discoveryCheckpointPath: string;
  readonly retrievalCheckpointPath: string | null;
  readonly discoveryExhausted: boolean;
  readonly ranked: readonly {
    sourceId: string;
    path: string;
    sha256: string;
  }[];
  readonly expectedRecallAtK: number;
  readonly verifiedEvidenceCount: number;
  readonly evidenceCount: number;
  /** True only when every selected document yielded a verified first excerpt. */
  readonly shortlistVerified: boolean;
  readonly timingMs: {
    readonly discovery: number;
    readonly excerptReads: number;
    readonly jev: number;
    readonly total: number;
  };
  readonly gaps: readonly KnowledgeGap[];
  readonly jev: JevShadowResult | null;
  readonly graph?: ArchiveGraphTrial;
}
export interface ArchiveSearchReport {
  readonly schema: 1;
  readonly kind: 'temari-archive-search-evaluation';
  readonly handoffPath: string;
  readonly task: InvestigationTask;
  readonly cases: readonly ArchiveCaseResult[];
}

const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
const key = (sourceId: string, path: string): string =>
  canonical([sourceId, path]);

/** Intake authority ends at an immutable handoff. A blocked capture has no search grant. */
export async function runArchiveIntake(
  plan: ArchiveIntakePlan,
): Promise<ArchiveIntakeBatchResult> {
  const selected = JSON.parse(canonical(plan)) as ArchiveIntakePlan;
  assert(selected.intakes.length >= 1 && selected.intakes.length <= 8);
  assert(
    new Set(selected.intakes.map((item) => item.source.id)).size ===
      selected.intakes.length,
  );
  assert(
    new Set(selected.intakes.map((item) => item.requestKey)).size ===
      selected.intakes.length,
  );
  const localOnlySourceIds = selected.localOnlySourceIds ?? [];
  assert(Array.isArray(localOnlySourceIds));
  assert.equal(new Set(localOnlySourceIds).size, localOnlySourceIds.length);
  for (const sourceId of localOnlySourceIds)
    assert(
      selected.intakes.some((item) => item.source.id === sourceId),
      'Local-only source outside intake',
    );
  for (const item of selected.intakes) {
    assert(same(item.task, selected.task), 'Intake task mismatch');
    assert(
      same(item.transport, selected.intakes[0].transport),
      'One Registrar workspace required',
    );
  }
  const outcomes: ArchiveIntakeOutcome[] = [];
  for (const item of selected.intakes)
    outcomes.push(await captureArchive(item));
  if (
    outcomes.some(
      (item) => item.status !== 'published' || !item.publicationPath,
    )
  )
    return { status: 'blocked', handoffPath: null, outcomes };
  const publications = outcomes.map((item) => item.publicationPath!);
  const loaded = await Promise.all(publications.map(loadArchivePublication));
  const structures: {
    sourceId: string;
    graphId: string;
    receiptPath: string;
  }[] = [];
  assert((selected.structures?.length ?? 0) <= 8);
  for (const structure of selected.structures ?? []) {
    const index = loaded.findIndex(
      (item) => item.source.id === structure.sourceId,
    );
    assert(index >= 0, 'Structure source outside intake');
    assert(
      !structures.some((item) => item.sourceId === structure.sourceId),
      'One structural graph per source',
    );
    const published = await publishArchiveStructure({
      publicationPath: publications[index],
      artifactPath: structure.artifactPath,
      kind: structure.kind,
      paths: structure.paths,
      maxEdges: structure.maxEdges,
    });
    structures.push({
      sourceId: structure.sourceId,
      graphId: published.graphId,
      receiptPath: published.receiptPath,
    });
  }
  const handoff: ArchiveIntakeHandoff = {
    schema: 1,
    kind: 'temari-archive-intake-handoff',
    task: selected.task,
    publications,
    jevPolicy: {
      mode: 'registered-sources',
      localOnlySourceIds: [...localOnlySourceIds].sort(),
    },
    sources: loaded.map((item) => ({
      id: item.source.id,
      generation: item.generation,
      manifestSha256: item.manifestSha256,
      preservation: item.preservation,
      gapCount: item.gaps.length,
    })),
    ...(structures.length ? { structures } : {}),
  };
  const handoffPath = join(
    selected.task.directory,
    `archive-handoff-${hash(canonical(handoff))}.json`,
  );
  await publishJson(handoffPath, handoff);
  return {
    status: 'published',
    handoffPath,
    outcomes,
    ...(structures.length ? { structures } : {}),
  };
}

async function loadHandoff(path: string): Promise<ArchiveIntakeHandoff> {
  assert(isAbsolute(path));
  const value = object(await readJson(path)) as unknown as ArchiveIntakeHandoff;
  assert.equal(value.schema, 1);
  assert.equal(value.kind, 'temari-archive-intake-handoff');
  assert.equal(
    basename(path),
    `archive-handoff-${hash(canonical(value))}.json`,
  );
  assert.equal(dirname(path), value.task.directory);
  assert(
    Array.isArray(value.publications) &&
      value.publications.length >= 1 &&
      value.publications.length <= 8,
  );
  assert.equal(value.sources.length, value.publications.length);
  if (value.jevPolicy !== undefined) {
    assert.equal(value.jevPolicy.mode, 'registered-sources');
    const ids = value.jevPolicy.localOnlySourceIds;
    assert(Array.isArray(ids) && ids.length <= value.sources.length);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids)
      assert(
        value.sources.some((source) => source.id === id),
        'Local-only source outside handoff',
      );
  }
  if (value.structures !== undefined) {
    assert(
      Array.isArray(value.structures) &&
        value.structures.length <= value.sources.length,
    );
    assert.equal(
      new Set(value.structures.map((item) => item.sourceId)).size,
      value.structures.length,
    );
    for (const item of value.structures) {
      assert(value.sources.some((source) => source.id === item.sourceId));
      assert(/^[a-f0-9]{64}$/.test(item.graphId));
      assert(
        isAbsolute(item.receiptPath) &&
          dirname(item.receiptPath) === value.task.directory,
      );
      const receipt = object(await readJson(item.receiptPath));
      assert.equal(
        basename(item.receiptPath),
        `archive-structure-${hash(canonical(receipt))}.json`,
      );
      assert.equal(receipt['graphId'], item.graphId);
      assert.equal(receipt['sourceId'], item.sourceId);
      const pin = value.sources.find((source) => source.id === item.sourceId)!;
      assert.equal(receipt['generation'], pin.generation);
      assert.equal(receipt['manifestSha256'], pin.manifestSha256);
    }
  }
  const loaded = await Promise.all(
    value.publications.map(loadArchivePublication),
  );
  for (let i = 0; i < loaded.length; i++) {
    const item = loaded[i],
      pin = value.sources[i];
    assert(same(item.task, value.task));
    assert.equal(item.source.id, pin.id);
    assert.equal(item.generation, pin.generation);
    assert.equal(item.manifestSha256, pin.manifestSha256);
    assert.equal(item.preservation, pin.preservation);
    assert.equal(item.gaps.length, pin.gapCount);
  }
  return value;
}

/** Search authority accepts only a verified handoff and writes evidence-free metrics. */
export async function evaluateArchiveSearch(
  plan: ArchiveSearchPlan,
  jevOptions: JevShadowOptions = {},
): Promise<{ report: ArchiveSearchReport; reportPath: string }> {
  const selected = JSON.parse(canonical(plan)) as ArchiveSearchPlan;
  assert(
    Array.isArray(selected.cases) &&
      selected.cases.length >= 1 &&
      selected.cases.length <= 32,
  );
  const handoff = await loadHandoff(selected.handoffPath);
  assert(
    new Set(selected.cases.map((item) => item.id)).size ===
      selected.cases.length,
  );
  const publications = await Promise.all(
    handoff.publications.map(loadArchivePublication),
  );
  const sourceById = new Map(
    publications.map((item) => [item.source.id, item.source]),
  );
  const results: ArchiveCaseResult[] = [];
  for (const c of selected.cases) {
    const caseStarted = performance.now();
    assert(text(c.id).length <= 128 && text(c.query).length <= 512);
    integer(c.topK, 1, 8);
    assert(['exact', 'bm25'].includes(c.discoveryMode));
    assert(
      c.hostedTextApproved === undefined ||
        typeof c.hostedTextApproved === 'boolean',
    );
    if (!handoff.jevPolicy)
      assert(
        typeof c.hostedTextApproved === 'boolean',
        'Legacy handoff requires per-case Jev approval',
      );
    assert(
      Array.isArray(c.sourceIds) &&
        c.sourceIds.length >= 1 &&
        c.sourceIds.length <= 8,
    );
    assert.equal(new Set(c.sourceIds).size, c.sourceIds.length);
    for (const sourceId of c.sourceIds)
      assert(sourceById.has(sourceId), 'Case source outside handoff');
    const jevSharing: ArchiveCaseResult['jevSharing'] = c.sourceIds.some(
      (id: string) => handoff.jevPolicy?.localOnlySourceIds.includes(id),
    )
      ? 'local-only'
      : c.hostedTextApproved === false
        ? 'case-opt-out'
        : 'allowed';
    assert(
      Array.isArray(c.expected) &&
        c.expected.length >= 1 &&
        c.expected.length <= 16,
    );
    const expected = new Set<string>();
    for (const item of c.expected) {
      assert(
        c.sourceIds.includes(item.sourceId),
        'Expected source outside case scope',
      );
      assert(
        text(item.path).length <= 4096 &&
          !isAbsolute(item.path) &&
          !item.path.includes('\\') &&
          !item.path.includes('\0') &&
          !item.path.startsWith('-') &&
          !item.path
            .split('/')
            .some((part: string) => ['', '.', '..'].includes(part)),
      );
      expected.add(key(item.sourceId, item.path));
    }
    assert.equal(expected.size, c.expected.length);
    const selectedPublications = handoff.publications.filter((_path, index) =>
      c.sourceIds.includes(publications[index].source.id),
    );
    const provider = await createArchiveRegistrar({
      publications: selectedPublications,
      readScope: 'source-root',
      discoveryMode: c.discoveryMode,
    });
    const scope = publications
      .filter((item) => c.sourceIds.includes(item.source.id))
      .map((item) => item.source);
    const limits = {
      evidenceCodePoints: 64000,
      contextCodePoints: 65536,
      stateBytes: 4 * 1024 * 1024,
    };
    const discovery = await collectKnowledge({
      task: handoff.task,
      provider,
      request: { scope, query: c.query, selections: [], limits },
      budget: {
        calls: 1,
        responseBytes: 131072,
        codePoints: 1,
        codePointsPerRead: 1,
        documentsPerPage: c.topK,
      },
    });
    const discovered = await loadRetrieval(discovery.checkpointPath);
    const discoveryMs = Math.max(
      0,
      Math.round(performance.now() - caseStarted),
    );
    const candidates = discovered.discovery
      .flatMap((page) => page.documents)
      .slice(0, c.topK);
    const ranked = candidates.map((item) => ({
      sourceId: item.document.source.id,
      path: item.document.path,
      sha256: item.sha256,
    }));
    let retrievalCheckpointPath: string | null = null;
    let shortlistVerified = false;
    let verifiedEvidenceCount = 0;
    let evidenceCount = 0;
    let excerptReadsMs = 0;
    let jevMs = 0;
    let gaps: KnowledgeGap[] = [
      ...discovered.gaps,
      ...discovered.discovery.flatMap((page) => page.gaps),
    ];
    let jev: JevShadowResult | null = null;
    if (candidates.length) {
      const readStarted = performance.now();
      const evidence: KnowledgeEvidence[] = [];
      const checks: KnowledgeCheck[] = [];
      for (const candidate of candidates) {
        try {
          const result = await provider.read({
            document: candidate.document,
            expectedSha256: candidate.sha256,
            continuation: null,
            maxCodePoints: 1000,
            maxBytes: 65536,
          });
          if (!result.ok) {
            gaps.push(result.gap);
            continue;
          }
          const item = result.value.evidence;
          assert(
            same(item.document, candidate.document) &&
              item.sha256 === candidate.sha256,
            'Shortlist evidence changed',
          );
          evidence.push(item);
          const check = await provider.revalidate(item);
          assert.equal(check.evidenceId, item.id);
          checkBasis(check, item);
          checks.push(check);
          if (check.state !== 'unchanged')
            gaps.push({
              kind: check.state,
              subject: item.id,
              detail: check.detail,
            });
        } catch {
          gaps.push({
            kind: 'unknown',
            subject: candidate.document.path,
            detail: 'Archive excerpt read or revalidation failed',
          });
        }
      }
      evidenceCount = evidence.length;
      verifiedEvidenceCount = checks.filter(
        (item) => item.state === 'unchanged',
      ).length;
      shortlistVerified = verifiedEvidenceCount === candidates.length;
      const checkpoint = {
        schema: 1,
        kind: 'temari-archive-shortlist',
        task: handoff.task,
        provider: provider.identity,
        querySha256: hash(c.query),
        ranked,
        evidence,
        checks,
        gaps,
        readMode: 'first-1000-codepoints',
        fullDocumentRead: false,
      };
      retrievalCheckpointPath = join(
        handoff.task.directory,
        `archive-shortlist-${hash(canonical(checkpoint))}.json`,
      );
      await publishJson(retrievalCheckpointPath, checkpoint);
      excerptReadsMs = Math.max(0, Math.round(performance.now() - readStarted));
      const shortlist = candidates.flatMap((item) => {
        const piece = evidence.find(
          (e) =>
            same(e.document, item.document) &&
            checks.some(
              (check) =>
                check.evidenceId === e.id && check.state === 'unchanged',
            ),
        );
        if (!piece || !piece.excerpt) return [];
        return [
          {
            id: hash(canonical(item.document)),
            evidenceIds: [piece.id],
            excerpt: piece.excerpt,
            required: expected.has(
              key(item.document.source.id, item.document.path),
            ),
            contrary: false,
          },
        ];
      });
      if (
        shortlist.length &&
        shortlist.reduce((total, item) => total + item.excerpt.length, 0) >
          16000
      ) {
        gaps.push({
          kind: 'pending',
          subject: 'jev-shadow',
          detail:
            'Verified excerpts exceed the Jev shortlist text limit; local retrieval remains available.',
        });
      } else if (shortlist.length) {
        const jevStarted = performance.now();
        jev = await judgeJevShadow(
          {
            query: c.query,
            hostedTextApproved: jevSharing === 'allowed',
            ...(jevSharing === 'allowed' ? {} : { denialReason: jevSharing }),
            candidates: shortlist,
          },
          jevOptions,
        );
        jevMs = Math.max(0, Math.round(performance.now() - jevStarted));
      }
    }
    const selectedGraphId =
      c.graphId ??
      (c.sourceIds.length === 1
        ? handoff.structures?.find((item) => item.sourceId === c.sourceIds[0])
            ?.graphId
        : undefined);
    const graph =
      selectedGraphId === undefined
        ? undefined
        : await evaluateArchiveGraphTrial({
            graphId: selectedGraphId,
            publications: selectedPublications,
            scope,
            provider,
            lexical: ranked,
            expected: c.expected,
            topK: c.topK,
            taskDirectory: handoff.task.directory,
          });
    const hitCount = ranked.filter((item) =>
      expected.has(key(item.sourceId, item.path)),
    ).length;
    results.push({
      id: c.id,
      querySha256: hash(c.query),
      discoveryMode: c.discoveryMode,
      sourceIds: [...c.sourceIds],
      jevSharing,
      expected: [...c.expected],
      sourceCapabilityGaps: publications
        .filter((item) => c.sourceIds.includes(item.source.id))
        .flatMap((item) => item.gaps),
      discoveryCheckpointPath: discovery.checkpointPath,
      retrievalCheckpointPath,
      discoveryExhausted:
        discovered.discoveryNext === null && discovered.discoveryStarted,
      ranked,
      expectedRecallAtK: hitCount / expected.size,
      verifiedEvidenceCount,
      evidenceCount,
      shortlistVerified,
      gaps,
      jev,
      ...(graph === undefined ? {} : { graph }),
      timingMs: {
        discovery: discoveryMs,
        excerptReads: excerptReadsMs,
        jev: jevMs,
        total: Math.max(0, Math.round(performance.now() - caseStarted)),
      },
    });
  }
  const report: ArchiveSearchReport = {
    schema: 1,
    kind: 'temari-archive-search-evaluation',
    handoffPath: selected.handoffPath,
    task: handoff.task,
    cases: results,
  };
  const reportPath = join(
    handoff.task.directory,
    `archive-evaluation-${hash(canonical(report))}.json`,
  );
  await publishJson(reportPath, report);
  return { report, reportPath };
}
