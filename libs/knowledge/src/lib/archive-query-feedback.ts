/** Operator feedback is a pinned regression candidate, never retrieval authority. */
import assert from 'node:assert/strict';
import { basename, dirname, isAbsolute, join } from 'node:path';
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
import { canonical, checkBasis, digest, hash, object, text } from './codec.js';
import { publishJson, readJsonWithBytes } from './durable.js';

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
export async function recordArchiveQueryFeedback(
  input: ArchiveQueryFeedbackInput,
): Promise<{ receipt: ArchiveQueryFeedbackReceipt; receiptPath: string }> {
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
