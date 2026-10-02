/** Operator feedback is a pinned regression candidate, never retrieval authority. */
import assert from 'node:assert/strict';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type { KnowledgeCheck, KnowledgeEvidence } from '@temari/contracts';
import {
  loadArchivePublication,
  registrationFor,
  type ArchivePublication,
} from './archive-intake.js';
import {
  loadArchiveHandoff,
  type ArchiveEvaluationCase,
  type ArchiveQueryReport,
} from './archive-journey.js';
import { createArchiveRegistrar } from './archive-registrar.js';
import { archiveTransport } from './archive-transport.js';
import {
  canonical,
  checkBasis,
  digest,
  hash,
  integer,
  object,
  text,
} from './codec.js';
import { publishJson, readJsonWithBytes } from './durable.js';
import { loadRetrieval } from './retrieval.js';

export interface ArchiveFeedbackDocument {
  readonly sourceId: string;
  readonly path: string;
  readonly sha256: string;
}
export interface ArchiveQueryFeedbackInput {
  readonly reportPath: string;
  readonly query: string;
  readonly reviewerRef: string;
  readonly reason: string;
  readonly relevant: readonly ArchiveFeedbackDocument[];
  readonly missed: readonly ArchiveFeedbackDocument[];
}
/** A reviewer observed the operational shortlist, without labeling any gold document. */
export interface ArchiveNegativeQueryFeedbackInput {
  readonly reportPath: string;
  readonly query: string;
  readonly reviewerRef: string;
  readonly reason: string;
  readonly assessment:
    'shortlist-excerpts-unanswered' | 'empty-shortlist-observed';
}
export interface ArchiveNegativeQueryFeedbackReceipt {
  readonly schema: 1;
  readonly kind: 'temari-archive-query-negative-feedback';
  readonly effect: 'regression-candidate-only';
  readonly assessment: ArchiveNegativeQueryFeedbackInput['assessment'];
  readonly reviewerRef: string;
  readonly reason: string;
  readonly query: string;
  readonly querySha256: string;
  readonly reportPath: string;
  readonly reportSha256: string;
  readonly handoffPath: string;
  readonly handoffSha256: string;
  readonly discoveryCheckpointPath: string;
  readonly discoveryCheckpointSha256: string;
  readonly shortlistCheckpointPath: string | null;
  readonly shortlistCheckpointSha256: string | null;
  readonly sourceRevisions: ArchiveQueryFeedbackReceipt['sourceRevisions'];
  /** Every ranked pin, derived from the report; no reviewer-selected subset. */
  readonly ranked: readonly (ArchiveFeedbackDocument & {
    evidenceId: string;
  })[];
  readonly scope: {
    readonly topK: number;
    readonly readMode: 'first-1000-codepoints';
    readonly fullDocumentRead: false;
    readonly corpusAbsenceClaim: false;
  };
}
export interface ArchiveQueryFeedbackReceipt {
  readonly schema: 1;
  readonly kind: 'temari-archive-query-feedback';
  readonly effect: 'regression-candidate-only';
  readonly reviewerRef: string;
  readonly reason: string;
  readonly querySha256: string;
  readonly reportPath: string;
  readonly reportSha256: string;
  readonly handoffPath: string;
  readonly handoffSha256: string;
  readonly sourceRevisions: readonly {
    sourceId: string;
    generation: string;
    manifestSha256: string;
    publicationPath: string;
    publicationSha256: string;
  }[];
  readonly relevant: readonly (ArchiveFeedbackDocument & {
    evidenceId: string;
  })[];
  readonly missed: readonly (ArchiveFeedbackDocument & {
    evidenceId: string;
  })[];
  /** Private, operator-labeled candidate. Never auto-run or treat as graph authority. */
  readonly candidate: ArchiveEvaluationCase;
}

function exact(value: unknown, keys: readonly string[], label: string): void {
  const fields = Object.keys(object(value));
  assert.deepEqual(fields.sort(), [...keys].sort(), `Invalid ${label} fields`);
}
function identity(item: ArchiveFeedbackDocument): string {
  return canonical([item.sourceId, item.path]);
}
function validateDocument(
  item: unknown,
): asserts item is ArchiveFeedbackDocument {
  exact(item, ['sourceId', 'path', 'sha256'], 'feedback document');
  const selected = item as ArchiveFeedbackDocument;
  assert(text(selected.sourceId).length <= 256);
  const path = text(selected.path);
  assert(
    path.length <= 4096 &&
      !isAbsolute(path) &&
      !path.startsWith('-') &&
      !path.includes('\\') &&
      !path.includes('\0') &&
      !path.split('/').some((part) => ['', '.', '..'].includes(part)),
    'Canonical source-relative path required',
  );
  digest(selected.sha256);
}

/**
 * Verify a prior operational query and selected archived documents, then publish
 * an immutable annotation. This does not alter a graph or authorize Jev output.
 */
export function recordArchiveQueryFeedback(
  input: ArchiveQueryFeedbackInput,
): Promise<{ receipt: ArchiveQueryFeedbackReceipt; receiptPath: string }>;
export function recordArchiveQueryFeedback(
  input: ArchiveNegativeQueryFeedbackInput,
): Promise<{
  receipt: ArchiveNegativeQueryFeedbackReceipt;
  receiptPath: string;
}>;
export async function recordArchiveQueryFeedback(
  input: ArchiveQueryFeedbackInput | ArchiveNegativeQueryFeedbackInput,
): Promise<{
  receipt: ArchiveQueryFeedbackReceipt | ArchiveNegativeQueryFeedbackReceipt;
  receiptPath: string;
}> {
  if ('assessment' in input) return recordNegativeArchiveQueryFeedback(input);
  exact(
    input,
    ['reportPath', 'query', 'reviewerRef', 'reason', 'relevant', 'missed'],
    'feedback input',
  );
  const selected = JSON.parse(canonical(input)) as ArchiveQueryFeedbackInput;
  assert(isAbsolute(text(selected.reportPath)));
  assert(text(selected.query).length <= 512);
  assert(text(selected.reviewerRef).length <= 256);
  assert(text(selected.reason).length <= 1024);
  assert(Array.isArray(selected.relevant) && Array.isArray(selected.missed));
  const all = [...selected.relevant, ...selected.missed];
  assert(
    all.length >= 1 && all.length <= 16,
    'One to sixteen feedback documents required',
  );
  all.forEach(validateDocument);
  assert.equal(
    new Set(all.map(identity)).size,
    all.length,
    'Duplicate feedback document',
  );

  const reportArtifact = await readJsonWithBytes(selected.reportPath);
  const report = object(reportArtifact.value) as unknown as ArchiveQueryReport;
  assert.equal(report.schema, 1);
  assert.equal(report.kind, 'temari-archive-query');
  assert.equal(
    basename(selected.reportPath),
    `archive-query-${hash(canonical(report))}.json`,
  );
  assert.equal(dirname(selected.reportPath), report.task.directory);
  assert.equal(
    report.query.querySha256,
    hash(selected.query),
    'Query differs from report',
  );
  assert(
    Array.isArray(report.query.sourceIds) && report.query.sourceIds.length >= 1,
  );
  assert.equal(
    new Set(report.query.sourceIds).size,
    report.query.sourceIds.length,
  );
  assert(Array.isArray(report.query.ranked));
  assert(report.query.ranked.length <= report.query.topK);

  const handoffArtifact = await readJsonWithBytes(report.handoffPath);
  const handoff = await loadArchiveHandoff(report.handoffPath);
  assert.equal(
    canonical(report.task),
    canonical(handoff.task),
    'Report task differs from handoff',
  );
  assert.equal(dirname(report.handoffPath), report.task.directory);
  for (const sourceId of report.query.sourceIds)
    assert(
      handoff.sources.some((source) => source.id === sourceId),
      'Query source outside handoff',
    );
  const expectedSharing = report.query.sourceIds.some((id) =>
    handoff.jevPolicy?.localOnlySourceIds.includes(id),
  )
    ? 'local-only'
    : report.query.jevSharing === 'case-opt-out'
      ? 'case-opt-out'
      : 'allowed';
  assert.equal(
    report.query.jevSharing,
    expectedSharing,
    'Report sharing differs from handoff',
  );

  const ranked = new Map<string, string>();
  for (const item of report.query.ranked) {
    validateDocument(item);
    assert(
      report.query.sourceIds.includes(item.sourceId),
      'Ranked source outside query scope',
    );
    assert(!ranked.has(identity(item)), 'Duplicate ranked document');
    ranked.set(identity(item), item.sha256);
  }
  for (const item of all)
    assert(
      report.query.sourceIds.includes(item.sourceId),
      'Feedback source outside query scope',
    );
  for (const item of selected.relevant)
    assert.equal(
      ranked.get(identity(item)),
      item.sha256,
      'Relevant document must match ranked pin',
    );
  for (const item of selected.missed)
    assert(!ranked.has(identity(item)), 'Missed document was already ranked');

  const publicationArtifacts = await Promise.all(
    handoff.publications.map((path) => readJsonWithBytes(path)),
  );
  const publications = await Promise.all(
    handoff.publications.map(loadArchivePublication),
  );
  for (let index = 0; index < publications.length; index++)
    assert.equal(
      canonical(publicationArtifacts[index].value),
      canonical(publications[index]),
      'Source publication changed before feedback reads',
    );
  const scoped = report.query.sourceIds.map((id) => {
    const index = publications.findIndex(
      (publication) => publication.source.id === id,
    );
    assert(index >= 0, 'Query source publication missing');
    return {
      publication: publications[index],
      path: handoff.publications[index],
      publicationSha256: hash(publicationArtifacts[index].bytes),
    };
  });
  const transport = await archiveTransport(scoped[0].publication.transport);
  for (const { publication } of scoped) {
    assert.equal(transport.implementation, publication.implementation);
    assert.equal(transport.protocolSha256, publication.protocolSha256);
    assert.equal(
      await registrationFor(transport, publication.source),
      publication.registration,
      'Current source admission changed',
    );
  }
  const provider = await createArchiveRegistrar({
    publications: scoped.map((item) => item.path),
    readScope: 'source-root',
    discoveryMode: report.query.discoveryMode,
  });
  const verified = new Map<
    string,
    ArchiveFeedbackDocument & { evidenceId: string }
  >();
  for (const item of all) {
    const publication: ArchivePublication = scoped.find(
      (entry) => entry.publication.source.id === item.sourceId,
    )!.publication;
    const result = await provider.read({
      document: { source: publication.source, path: item.path },
      expectedSha256: item.sha256,
      continuation: null,
      maxCodePoints: 1000,
      maxBytes: 65536,
    });
    assert(result.ok, `Selected archived document unavailable: ${item.path}`);
    const evidence = result.value.evidence;
    assert.equal(evidence.sha256, item.sha256);
    assert.equal(evidence.document.source.id, item.sourceId);
    assert.equal(evidence.document.path, item.path);
    assert.equal(evidence.archive?.generation, publication.generation);
    assert.equal(evidence.archive?.manifestSha256, publication.manifestSha256);
    const check = await provider.revalidate(evidence);
    assert.equal(check.evidenceId, evidence.id);
    checkBasis(check, evidence);
    assert.equal(
      check.state,
      'unchanged',
      'Selected archived document changed',
    );
    verified.set(identity(item), { ...item, evidenceId: evidence.id });
  }
  const sourceRevisions = scoped.map(
    ({ publication, path, publicationSha256 }) => ({
      sourceId: publication.source.id,
      generation: publication.generation,
      manifestSha256: publication.manifestSha256,
      publicationPath: path,
      publicationSha256,
    }),
  );
  assert.equal(
    hash((await readJsonWithBytes(selected.reportPath)).bytes),
    hash(reportArtifact.bytes),
    'Query report changed during feedback',
  );
  assert.equal(
    hash((await readJsonWithBytes(report.handoffPath)).bytes),
    hash(handoffArtifact.bytes),
    'Intake handoff changed during feedback',
  );
  for (const revision of sourceRevisions)
    assert.equal(
      hash((await readJsonWithBytes(revision.publicationPath)).bytes),
      revision.publicationSha256,
      'Source publication changed during feedback',
    );
  const receipt: ArchiveQueryFeedbackReceipt = {
    schema: 1,
    kind: 'temari-archive-query-feedback',
    effect: 'regression-candidate-only',
    reviewerRef: selected.reviewerRef,
    reason: selected.reason,
    querySha256: hash(selected.query),
    reportPath: selected.reportPath,
    reportSha256: hash(reportArtifact.bytes),
    handoffPath: report.handoffPath,
    handoffSha256: hash(handoffArtifact.bytes),
    sourceRevisions,
    relevant: selected.relevant.map((item) => verified.get(identity(item))!),
    missed: selected.missed.map((item) => verified.get(identity(item))!),
    candidate: {
      id: report.query.id,
      query: selected.query,
      sourceIds: [...report.query.sourceIds],
      expected: all.map(({ sourceId, path }) => ({ sourceId, path })),
      topK: report.query.topK,
      discoveryMode: report.query.discoveryMode,
      hostedTextApproved: false,
    },
  };
  const receiptPath = join(
    report.task.directory,
    `archive-query-feedback-${hash(canonical(receipt))}.json`,
  );
  await publishJson(receiptPath, receipt);
  return { receipt, receiptPath };
}

/** A local observation about the displayed first excerpts, never proof of absence. */
async function recordNegativeArchiveQueryFeedback(
  input: ArchiveNegativeQueryFeedbackInput,
): Promise<{
  receipt: ArchiveNegativeQueryFeedbackReceipt;
  receiptPath: string;
}> {
  exact(
    input,
    ['reportPath', 'query', 'reviewerRef', 'reason', 'assessment'],
    'negative feedback input',
  );
  const selected = JSON.parse(
    canonical(input),
  ) as ArchiveNegativeQueryFeedbackInput;
  assert(isAbsolute(text(selected.reportPath)));
  assert(text(selected.query).length <= 512);
  assert(text(selected.reviewerRef).length <= 256);
  assert(text(selected.reason).length <= 1024);
  assert(
    ['shortlist-excerpts-unanswered', 'empty-shortlist-observed'].includes(
      selected.assessment,
    ),
    'Invalid negative assessment',
  );

  const reportArtifact = await readJsonWithBytes(selected.reportPath);
  const report = object(reportArtifact.value) as unknown as ArchiveQueryReport;
  assert.equal(report.schema, 1);
  assert.equal(report.kind, 'temari-archive-query');
  assert.equal(reportArtifact.bytes.toString('utf8'), canonical(report));
  assert.equal(
    basename(selected.reportPath),
    `archive-query-${hash(canonical(report))}.json`,
  );
  assert.equal(dirname(selected.reportPath), report.task.directory);
  assert.equal(
    report.query.querySha256,
    hash(selected.query),
    'Query differs from report',
  );
  assert(
    Array.isArray(report.query.sourceIds) &&
      report.query.sourceIds.length >= 1 &&
      report.query.sourceIds.length <= 8,
  );
  assert.equal(
    new Set(report.query.sourceIds).size,
    report.query.sourceIds.length,
  );
  integer(report.query.topK, 1, 8);
  assert(['exact', 'bm25'].includes(report.query.discoveryMode));
  assert(Array.isArray(report.query.ranked));
  assert(report.query.ranked.length <= report.query.topK);
  for (const item of report.query.ranked) {
    validateDocument(item);
    assert(
      report.query.sourceIds.includes(item.sourceId),
      'Ranked source outside query scope',
    );
  }
  assert.equal(
    new Set(report.query.ranked.map(identity)).size,
    report.query.ranked.length,
    'Duplicate ranked document',
  );
  if (selected.assessment === 'empty-shortlist-observed') {
    assert.equal(report.query.ranked.length, 0, 'Shortlist is not empty');
    assert.equal(report.query.retrievalCheckpointPath, null);
    assert.equal(report.query.evidenceCount, 0);
    assert.equal(report.query.verifiedEvidenceCount, 0);
    assert.equal(report.query.shortlistVerified, false);
  } else {
    assert(report.query.ranked.length > 0, 'No excerpts to assess');
    assert.equal(
      report.query.shortlistVerified,
      true,
      'Every ranked excerpt must have been verified',
    );
    assert.equal(report.query.evidenceCount, report.query.ranked.length);
    assert.equal(
      report.query.verifiedEvidenceCount,
      report.query.ranked.length,
    );
  }

  const handoffArtifact = await readJsonWithBytes(report.handoffPath);
  const handoff = await loadArchiveHandoff(report.handoffPath);
  assert.equal(
    canonical(report.task),
    canonical(handoff.task),
    'Report task differs from handoff',
  );
  assert.equal(dirname(report.handoffPath), report.task.directory);
  for (const sourceId of report.query.sourceIds)
    assert(
      handoff.sources.some((source) => source.id === sourceId),
      'Query source outside handoff',
    );
  const expectedSharing = report.query.sourceIds.some((id) =>
    handoff.jevPolicy?.localOnlySourceIds.includes(id),
  )
    ? 'local-only'
    : report.query.jevSharing === 'case-opt-out'
      ? 'case-opt-out'
      : 'allowed';
  if (
    report.query.jevSharing === 'current-local-only' ||
    report.query.jevSharing === 'policy-unavailable'
  ) {
    // A query that began allowed can finish with a stricter current policy.
    // Feedback is local and still checks present source admission below.
    assert.equal(
      expectedSharing,
      'allowed',
      'Report sharing differs from handoff',
    );
    assert(
      report.query.gaps.some(
        (gap) =>
          gap.subject === 'jev-shadow' &&
          gap.kind ===
            (report.query.jevSharing === 'current-local-only'
              ? 'scope-refused'
              : 'unavailable'),
      ),
      'Changed sharing lacks its operational gap',
    );
  } else {
    assert.equal(
      report.query.jevSharing,
      expectedSharing,
      'Report sharing differs from handoff',
    );
  }

  const publicationArtifacts = await Promise.all(
    handoff.publications.map((path) => readJsonWithBytes(path)),
  );
  const publications = await Promise.all(
    handoff.publications.map(loadArchivePublication),
  );
  for (let index = 0; index < publications.length; index++)
    assert.equal(
      canonical(publicationArtifacts[index].value),
      canonical(publications[index]),
      'Source publication changed before feedback reads',
    );
  const scoped = publications.flatMap((publication, index) =>
    report.query.sourceIds.includes(publication.source.id)
      ? [
          {
            publication,
            path: handoff.publications[index],
            publicationSha256: hash(publicationArtifacts[index].bytes),
          },
        ]
      : [],
  );
  assert.equal(
    scoped.length,
    report.query.sourceIds.length,
    'Query source publication missing',
  );
  const transport = await archiveTransport(scoped[0].publication.transport);
  for (const { publication } of scoped) {
    assert.equal(transport.implementation, publication.implementation);
    assert.equal(transport.protocolSha256, publication.protocolSha256);
    assert.equal(
      await registrationFor(transport, publication.source),
      publication.registration,
      'Current source admission changed',
    );
  }
  const provider = await createArchiveRegistrar({
    publications: scoped.map((item) => item.path),
    readScope: 'source-root',
    discoveryMode: report.query.discoveryMode,
  });

  assert(isAbsolute(report.query.discoveryCheckpointPath));
  assert.equal(
    dirname(report.query.discoveryCheckpointPath),
    report.task.directory,
  );
  const discovery = await loadRetrieval(report.query.discoveryCheckpointPath);
  const discoveryArtifact = await readJsonWithBytes(
    report.query.discoveryCheckpointPath,
    4 * 1024 * 1024,
  );
  assert.equal(
    canonical(discoveryArtifact.value),
    canonical(discovery),
    'Discovery checkpoint changed',
  );
  assert.equal(canonical(discovery.task), canonical(report.task));
  assert.equal(
    canonical(discovery.provider),
    canonical(provider.identity),
    'Discovery provider differs from report',
  );
  assert.equal(discovery.request.query, selected.query);
  assert.equal(discovery.budget.documentsPerPage, report.query.topK);
  assert.equal(discovery.discoveryStarted, true);
  assert.equal(
    discovery.discoveryNext === null,
    report.query.discoveryExhausted,
  );
  assert.equal(
    canonical(discovery.request.scope.map((source) => source.id).sort()),
    canonical([...report.query.sourceIds].sort()),
  );
  for (const source of discovery.request.scope) {
    const pinned = scoped.find(
      (item) => item.publication.source.id === source.id,
    );
    assert(pinned);
    assert.equal(canonical(source), canonical(pinned.publication.source));
  }
  const discoveredRanked = discovery.discovery
    .flatMap((page) => page.documents)
    .slice(0, report.query.topK)
    .map((item) => ({
      sourceId: item.document.source.id,
      path: item.document.path,
      sha256: item.sha256,
    }));
  assert.equal(
    canonical(report.query.ranked),
    canonical(discoveredRanked),
    'Report ranking differs from discovery checkpoint',
  );

  let shortlistArtifact: Awaited<ReturnType<typeof readJsonWithBytes>> | null =
    null;
  let shortlistPath: string | null = null;
  const verified: (ArchiveFeedbackDocument & { evidenceId: string })[] = [];
  if (report.query.ranked.length) {
    shortlistPath = text(report.query.retrievalCheckpointPath);
    assert(isAbsolute(shortlistPath));
    assert.equal(dirname(shortlistPath), report.task.directory);
    shortlistArtifact = await readJsonWithBytes(shortlistPath);
    const checkpoint = object(shortlistArtifact.value);
    assert.equal(
      shortlistArtifact.bytes.toString('utf8'),
      canonical(checkpoint),
    );
    assert.equal(
      basename(shortlistPath),
      `archive-shortlist-${hash(canonical(checkpoint))}.json`,
      'Shortlist content address changed',
    );
    assert.equal(checkpoint['schema'], 1);
    assert.equal(checkpoint['kind'], 'temari-archive-shortlist');
    assert.equal(canonical(checkpoint['task']), canonical(report.task));
    assert.equal(
      canonical(checkpoint['provider']),
      canonical(provider.identity),
    );
    assert.equal(checkpoint['querySha256'], hash(selected.query));
    assert.equal(
      canonical(checkpoint['ranked']),
      canonical(report.query.ranked),
    );
    assert.equal(checkpoint['readMode'], 'first-1000-codepoints');
    assert.equal(checkpoint['fullDocumentRead'], false);
    const evidence = checkpoint['evidence'] as KnowledgeEvidence[];
    const checks = checkpoint['checks'] as KnowledgeCheck[];
    assert(
      Array.isArray(evidence) && evidence.length === report.query.ranked.length,
    );
    assert(
      Array.isArray(checks) && checks.length === report.query.ranked.length,
    );
    assert.equal(
      new Set(evidence.map((item) => item.id)).size,
      evidence.length,
    );
    assert.equal(
      new Set(checks.map((item) => item.evidenceId)).size,
      checks.length,
    );
    for (const item of report.query.ranked) {
      const publication: ArchivePublication = scoped.find(
        (entry) => entry.publication.source.id === item.sourceId,
      )!.publication;
      const prior = evidence.find(
        (entry) =>
          entry.document.source.id === item.sourceId &&
          entry.document.path === item.path &&
          entry.sha256 === item.sha256,
      );
      assert(prior, 'Ranked excerpt missing from shortlist checkpoint');
      assert(
        prior.excerpt.length > 0 &&
          [...prior.excerpt].length <= 1000 &&
          prior.span.start === 0,
        'Ranked first excerpt missing or outside scope',
      );
      const priorCheck = checks.find((entry) => entry.evidenceId === prior.id);
      assert(
        priorCheck,
        'Ranked revalidation missing from shortlist checkpoint',
      );
      checkBasis(priorCheck, prior);
      assert.equal(
        priorCheck.state,
        'unchanged',
        'Ranked excerpt was not verified',
      );
      const read = await provider.read({
        document: { source: publication.source, path: item.path },
        expectedSha256: item.sha256,
        continuation: null,
        maxCodePoints: 1000,
        maxBytes: 65536,
      });
      assert(read.ok, `Ranked archived document unavailable: ${item.path}`);
      assert.equal(
        canonical(read.value.evidence),
        canonical(prior),
        'Ranked archived excerpt differs from checkpoint',
      );
      assert.equal(
        read.value.evidence.archive?.generation,
        publication.generation,
      );
      assert.equal(
        read.value.evidence.archive?.manifestSha256,
        publication.manifestSha256,
      );
      const current = await provider.revalidate(read.value.evidence);
      assert.equal(current.evidenceId, prior.id);
      checkBasis(current, read.value.evidence);
      assert.equal(
        current.state,
        'unchanged',
        'Ranked archived excerpt changed',
      );
      verified.push({ ...item, evidenceId: prior.id });
    }
  }

  const sourceRevisions = scoped.map(
    ({ publication, path, publicationSha256 }) => ({
      sourceId: publication.source.id,
      generation: publication.generation,
      manifestSha256: publication.manifestSha256,
      publicationPath: path,
      publicationSha256,
    }),
  );
  assert.equal(
    hash((await readJsonWithBytes(selected.reportPath)).bytes),
    hash(reportArtifact.bytes),
    'Query report changed during feedback',
  );
  assert.equal(
    hash((await readJsonWithBytes(report.handoffPath)).bytes),
    hash(handoffArtifact.bytes),
    'Intake handoff changed during feedback',
  );
  assert.equal(
    hash(
      (
        await readJsonWithBytes(
          report.query.discoveryCheckpointPath,
          4 * 1024 * 1024,
        )
      ).bytes,
    ),
    hash(discoveryArtifact.bytes),
    'Discovery checkpoint changed during feedback',
  );
  if (shortlistPath && shortlistArtifact)
    assert.equal(
      hash((await readJsonWithBytes(shortlistPath)).bytes),
      hash(shortlistArtifact.bytes),
      'Shortlist checkpoint changed during feedback',
    );
  for (const revision of sourceRevisions) {
    assert.equal(
      await registrationFor(
        transport,
        scoped.find((item) => item.publication.source.id === revision.sourceId)!
          .publication.source,
      ),
      scoped.find((item) => item.publication.source.id === revision.sourceId)!
        .publication.registration,
      'Current source admission changed',
    );
    assert.equal(
      hash((await readJsonWithBytes(revision.publicationPath)).bytes),
      revision.publicationSha256,
      'Source publication changed during feedback',
    );
  }
  const receipt: ArchiveNegativeQueryFeedbackReceipt = {
    schema: 1,
    kind: 'temari-archive-query-negative-feedback',
    effect: 'regression-candidate-only',
    assessment: selected.assessment,
    reviewerRef: selected.reviewerRef,
    reason: selected.reason,
    query: selected.query,
    querySha256: hash(selected.query),
    reportPath: selected.reportPath,
    reportSha256: hash(reportArtifact.bytes),
    handoffPath: report.handoffPath,
    handoffSha256: hash(handoffArtifact.bytes),
    discoveryCheckpointPath: report.query.discoveryCheckpointPath,
    discoveryCheckpointSha256: hash(discoveryArtifact.bytes),
    shortlistCheckpointPath: shortlistPath,
    shortlistCheckpointSha256: shortlistArtifact
      ? hash(shortlistArtifact.bytes)
      : null,
    sourceRevisions,
    ranked: verified,
    scope: {
      topK: report.query.topK,
      readMode: 'first-1000-codepoints',
      fullDocumentRead: false,
      corpusAbsenceClaim: false,
    },
  };
  const receiptPath = join(
    report.task.directory,
    `archive-query-negative-feedback-${hash(canonical(receipt))}.json`,
  );
  await publishJson(receiptPath, receipt);
  return { receipt, receiptPath };
}
