/** Explicit, receipt-pinned evaluations of a reviewed v2 root or its reviewed child. */
import assert from 'node:assert/strict';
import { lstat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import {
  loadArchivePublication,
  registrationFor,
} from './archive-intake.js';
import { verifyReviewedArchiveGraphChild } from './archive-graph-child-handoff.js';
import { createArchiveGraphReader } from './archive-graph.js';
import { readAllGraphRecords } from './archive-graph-impact.js';
import type { ArchiveGraphRepinReceipt } from './archive-graph-repin.js';
import type { ArchiveGraphRepublishReceipt } from './archive-graph-republish.js';
import {
  evaluateArchiveGraphTrial,
  type ArchiveGraphTrial,
  type RankedArchiveDocument,
} from './archive-graph-trial.js';
import { createArchiveRegistrar } from './archive-registrar.js';
import { archiveTransport } from './archive-transport.js';
import { canonical, digest, hash, object, text } from './codec.js';
import { publishJson, readJsonWithBytes } from './durable.js';

export interface ReviewedArchiveGraphEvaluationInput {
  /** Content-addressed fresh-root review, also required for child evaluation. */
  readonly reviewReceiptPath: string;
  readonly caseId: string;
  /** Operator case metadata only; this method does not execute search. */
  readonly query: string;
  /** Explicit v2 lexical shortlist; no search or default ranking is changed. */
  readonly lexical: readonly RankedArchiveDocument[];
  /** Independently supplied evaluation labels, never inferred from the graph. */
  readonly expected: readonly { sourceId: string; path: string }[];
  readonly topK: number;
}

export interface ReviewedArchiveGraphEvaluationReceipt {
  readonly schema: 1;
  readonly kind: 'temari-reviewed-v2-graph-evaluation';
  readonly policy: 'explicit-reviewed-root-trial-v1';
  readonly reviewReceiptPath: string;
  readonly reviewReceiptSha256: string;
  readonly afterPublicationPath: string;
  readonly afterPublicationSha256: string;
  readonly sourceId: string;
  readonly generation: string;
  readonly manifestSha256: string;
  readonly graphId: string;
  readonly revisionSetId: string;
  readonly selectedRecordIds: readonly string[];
  readonly mappingSha256: string;
  readonly caseId: string;
  readonly querySha256: string;
  readonly lexicalSha256: string;
  readonly lexicalBasis: 'operator-supplied-v2-verified';
  readonly lexicalCount: number;
  readonly expectedSha256: string;
  readonly expectedCount: number;
  readonly goldCoverage: 'not-checked';
  readonly topK: number;
  readonly trialSha256: string;
  readonly trialCheckpointPath: string | null;
  readonly trialCheckpointSha256: string | null;
  readonly status: ArchiveGraphTrial['status'];
  readonly expectedRecallAtK: number;
  readonly verifiedEvidenceCount: number;
  readonly addedCount: number;
  readonly trialGapCount: number;
  readonly targetReadAttempts: number;
  readonly graphMutation: 'none';
  readonly bm25Lift: 'not-measured';
  readonly operationalQueryChanged: false;
  readonly reviewerAuthenticated: false;
  readonly currentOriginal: 'not-checked';
  readonly semanticCorrectness: 'not-verified';
}

function relativePath(value: unknown): string {
  const path = text(value);
  assert(
    path.length <= 4096 &&
      !isAbsolute(path) &&
      !path.includes('\\') &&
      !path.includes('\0') &&
      path.split('/').every((part) => part && part !== '.' && part !== '..'),
    'Canonical source-relative path required',
  );
  return path;
}

function validateInput(input: ReviewedArchiveGraphEvaluationInput): void {
  assert.deepEqual(Object.keys(input).sort(), [
    'caseId',
    'expected',
    'lexical',
    'query',
    'reviewReceiptPath',
    'topK',
  ]);
  assert(isAbsolute(input.reviewReceiptPath));
  assert(text(input.caseId).trim() && input.caseId.length <= 256);
  assert(text(input.query).trim() && input.query.length <= 4096);
  assert(Number.isSafeInteger(input.topK) && input.topK >= 2 && input.topK <= 8);
  assert(
    Array.isArray(input.lexical) &&
      input.lexical.length >= 1 &&
      input.lexical.length <= input.topK,
  );
  assert(
    Array.isArray(input.expected) &&
      input.expected.length >= 1 &&
      input.expected.length <= 16,
  );
  for (const item of input.lexical) {
    assert.deepEqual(Object.keys(item).sort(), ['path', 'sha256', 'sourceId']);
    text(item.sourceId);
    relativePath(item.path);
    digest(item.sha256);
  }
  for (const item of input.expected) {
    assert.deepEqual(Object.keys(item).sort(), ['path', 'sourceId']);
    text(item.sourceId);
    relativePath(item.path);
  }
  assert.equal(
    new Set(input.lexical.map((item) => canonical([item.sourceId, item.path]))).size,
    input.lexical.length,
    'Duplicate lexical document',
  );
  assert.equal(
    new Set(input.expected.map((item) => canonical([item.sourceId, item.path]))).size,
    input.expected.length,
    'Duplicate gold document',
  );
}

async function canonicalReceipt<T>(path: string, prefix: string): Promise<{
  receipt: T;
  sha256: string;
}> {
  const saved = await readJsonWithBytes(path);
  const receipt = saved.value as T;
  const body = canonical(receipt);
  assert.equal(saved.bytes.toString('utf8'), body, 'Noncanonical receipt bytes');
  const sha256 = hash(saved.bytes);
  assert.equal(basename(path), `${prefix}-${sha256}.json`, 'Receipt name does not bind content');
  return { receipt, sha256 };
}

/** Shared root authority and trial checks; neither route publishes a graph. */
async function evaluateReviewedArchiveGraph(
  input: ReviewedArchiveGraphEvaluationInput,
  childReviewReceiptPath?: string,
) {
  validateInput(input);
  const { receipt: review, sha256: reviewSha256 } =
    await canonicalReceipt<ArchiveGraphRepublishReceipt>(
      input.reviewReceiptPath,
      'archive-graph-v2-root-review',
    );
  assert.equal(review.schema, 1);
  assert.equal(review.kind, 'temari-archive-graph-fresh-root-review');
  assert.equal(review.policy, 'explicit-reviewed-v2-root-v1');
  assert.equal(review.parent, null);
  assert.equal(review.reviewerAuthenticated, false);
  assert.equal(review.currentOriginal, 'not-checked');
  assert.equal(review.semanticCorrectness, 'not-verified');
  assert.equal(review.nativeLineage, 'none-external-mapping-only');
  digest(review.afterGraphId);
  digest(review.afterRevisionSetId);
  assert.equal(review.draftSha256, review.afterGraphId);
  const { receipt: proposal, sha256: proposalSha256 } =
    await canonicalReceipt<ArchiveGraphRepinReceipt>(
      review.proposalReceiptPath,
      'archive-graph-repin',
    );
  assert.equal(proposal.schema, 1);
  assert.equal(proposal.kind, 'temari-archive-graph-repin-proposal');
  assert.equal(proposal.status, 'proposal-only');
  assert.equal(proposal.policy, 'bounded-unchanged-v2-evidence-v1');
  assert.equal(review.proposalReceiptSha256, proposalSha256);
  assert.equal(review.beforeGraphId, proposal.beforeGraphId);
  assert.equal(review.beforeRevisionSetId, proposal.beforeRevisionSetId);
  assert.equal(review.afterRevisionSetId, proposal.expectedAfterRevisionSetId);
  assert.equal(canonical(review.before), canonical(proposal.before));
  assert.equal(canonical(review.after), canonical(proposal.after));
  assert.equal(review.after.publicationPath, proposal.after.publicationPath);

  const selected = review.selectedRecordIds.map(text);
  assert(selected.length >= 1 && selected.length <= 64);
  assert.deepEqual(selected, [...selected].sort());
  assert.equal(new Set(selected).size, selected.length);
  const eligible = new Set(proposal.eligible.map((item) => item.recordId));
  assert(selected.every((id) => eligible.has(id)), 'Reviewed selection is not eligible');
  assert.equal(review.recordMapping.length, selected.length);
  const mapped = review.recordMapping.map((item) => {
    assert(/^[a-f0-9]{32}$/.test(item.beforeRecordId));
    assert(/^[a-f0-9]{32}$/.test(item.afterRecordId));
    assert.equal(
      item.afterRecordId,
      hash(canonical({
        schema: 1,
        kind: 'temari-reviewed-v2-root-record-id',
        beforeGraphId: proposal.beforeGraphId,
        afterRevisionSetId: proposal.expectedAfterRevisionSetId,
        oldId: item.beforeRecordId,
      })).slice(0, 32),
      'Record mapping changed',
    );
    return item.beforeRecordId;
  });
  assert.deepEqual(mapped, selected, 'Mapping must cover exact selected records');
  assert.equal(
    new Set(review.recordMapping.map((item) => item.afterRecordId)).size,
    selected.length,
  );
  assert.deepEqual(
    review.excluded.eligibleNotSelected,
    [...eligible].filter((id) => !selected.includes(id)).sort(),
  );
  assert.equal(canonical(review.excluded.deferred), canonical(proposal.deferred));
  assert.equal(canonical(review.excluded.needsReview), canonical(proposal.needsReview));
  assert.equal(canonical(review.excluded.historicalOnly), canonical(proposal.historicalOnly));
  assert.equal(canonical(review.excluded.needDiscovery), canonical(proposal.needDiscovery));

  const pin = review.after;
  const publicationSaved = await readJsonWithBytes(pin.publicationPath);
  const publication = await loadArchivePublication(pin.publicationPath);
  assert.equal(publicationSaved.bytes.toString('utf8'), canonical(publication));
  assert.equal(hash(publicationSaved.bytes), pin.publicationSha256, 'V2 publication pin changed');
  assert.equal(publication.preservation, 'complete-admitted');
  assert.equal(publication.source.id, proposal.sourceId);
  assert.equal(publication.generation, pin.generation);
  assert.equal(publication.manifestSha256, pin.manifestSha256);
  assert.equal(dirname(input.reviewReceiptPath), publication.task.directory);
  assert.equal(dirname(review.proposalReceiptPath), publication.task.directory);
  assert(input.lexical.every((item) => item.sourceId === publication.source.id));
  assert(input.expected.every((item) => item.sourceId === publication.source.id));
  const revisionSet = {
    schema: 1,
    selections: [{
      source_id: publication.source.id,
      generation: publication.generation,
      manifest_sha256: publication.manifestSha256,
    }],
  };
  assert.equal(hash(canonical(revisionSet)), review.afterRevisionSetId);
  const transport = await archiveTransport(publication.transport);
  assert.equal(
    await registrationFor(transport, publication.source),
    publication.registration,
    'Current source admission changed',
  );

  assert.equal(
    review.draftPath,
    join(publication.task.directory, `archive-graph-v2-root-draft-${review.afterGraphId}.json`),
  );
  const draftSaved = await readJsonWithBytes(review.draftPath, 524_288);
  assert.equal(draftSaved.bytes.toString('utf8'), canonical(draftSaved.value));
  assert.equal(hash(draftSaved.bytes), review.afterGraphId, 'Graph draft pin changed');
  assert.equal((await lstat(review.draftPath)).mode & 0o077, 0);
  const draft = object(draftSaved.value);
  assert.deepEqual(Object.keys(draft).sort(), ['assertions', 'nodes', 'parent', 'revision_set', 'schema']);
  assert.equal(draft['schema'], 1);
  assert.equal(draft['parent'], null);
  assert.equal(canonical(draft['revision_set']), canonical(revisionSet));
  const draftRecords = [
    ...((draft['nodes'] as readonly unknown[]) ?? []),
    ...((draft['assertions'] as readonly unknown[]) ?? []),
  ];
  assert.equal(draftRecords.length, selected.length);
  assert.deepEqual(
    draftRecords.map((item) => object(item)['id']).sort(),
    review.recordMapping.map((item) => item.afterRecordId).sort(),
  );
  const reader = await createArchiveGraphReader({
    publications: [pin.publicationPath],
    readScope: 'source-root',
  });
  const graph = await readAllGraphRecords(reader, review.afterGraphId, publication.source);
  assert.equal(graph.revisionSetId, review.afterRevisionSetId);
  assert.equal(
    canonical(graph.records),
    canonical(draftRecords),
    'Reviewed graph differs from pinned draft',
  );

  const verifyChild = () => verifyReviewedArchiveGraphChild({
    receiptPath: childReviewReceiptPath!, rootGraphId: review.afterGraphId,
    revisionSetId: review.afterRevisionSetId, publication, pin,
    parentRecords: graph.records,
  });
  const child = childReviewReceiptPath === undefined ? null : await verifyChild();
  const graphId = child?.review.graphId ?? review.afterGraphId;
  const provider = await createArchiveRegistrar({
    publications: [pin.publicationPath],
    readScope: 'source-root',
  });
  for (const candidate of input.lexical) {
    const read = await provider.read({
      document: { source: publication.source, path: candidate.path },
      expectedSha256: candidate.sha256,
      continuation: null,
      maxCodePoints: 1,
      maxBytes: 65536,
    });
    assert(read.ok, 'Lexical candidate is unavailable in exact v2 publication');
    assert.equal(read.value.evidence.sha256, candidate.sha256);
    const check = await provider.revalidate(read.value.evidence);
    assert.equal(check.evidenceId, read.value.evidence.id);
    assert.equal(check.state, 'unchanged');
    assert.equal(check.basis, 'archive-snapshot');
  }
  const trial = await evaluateArchiveGraphTrial({
    graphId,
    publications: [pin.publicationPath],
    scope: [publication.source],
    provider,
    lexical: input.lexical,
    expected: input.expected,
    topK: input.topK,
    taskDirectory: publication.task.directory,
  });
  if (child) {
    const afterChild = await verifyChild();
    assert.equal(afterChild.sha256, child.sha256, 'Child review changed during trial');
  }
  assert.equal((await lstat(review.draftPath)).mode & 0o077, 0);
  const finalRoot = await readAllGraphRecords(reader, review.afterGraphId, publication.source);
  assert.equal(canonical(finalRoot), canonical(graph), 'Root graph changed during trial');
  let trialCheckpointSha256: string | null = null;
  assert.equal(trial.checkpointPath === null, trial.status === 'gap');
  if (trial.checkpointPath !== null) {
    assert.equal(dirname(trial.checkpointPath), publication.task.directory);
    const checkpointSaved = await readJsonWithBytes(trial.checkpointPath);
    const checkpoint = object(checkpointSaved.value);
    assert.equal(checkpointSaved.bytes.toString('utf8'), canonical(checkpoint));
    trialCheckpointSha256 = hash(checkpointSaved.bytes);
    assert.equal(
      basename(trial.checkpointPath),
      `archive-graph-trial-${trialCheckpointSha256}.json`,
      'Trial checkpoint name does not bind content',
    );
    assert.equal(checkpoint['schema'], 1);
    assert.equal(checkpoint['kind'], 'temari-archive-graph-trial');
    assert.equal(checkpoint['graphId'], graphId);
    assert(
      input.lexical.some((item) => canonical(item) === canonical(checkpoint['seed'])),
      'Trial seed is outside supplied lexical shortlist',
    );
    assert.equal(canonical(checkpoint['provider']), canonical(provider.identity));
    assert.equal(canonical(checkpoint['added']), canonical(trial.added));
    assert.equal(canonical(checkpoint['gaps']), canonical(trial.gaps));
    assert.equal(checkpoint['targetReadAttempts'], trial.targetReadAttempts);
    assert.equal(checkpoint['projectionNodeCount'], trial.projectionNodeCount);
    assert.equal(checkpoint['policy'], trial.policy);
    assert.equal(checkpoint['fullDocumentRead'], false);
    assert.equal(
      Array.isArray(checkpoint['evidence']) ? checkpoint['evidence'].length : -1,
      trial.verifiedEvidenceCount,
    );
  }
  // A trial can write a checkpoint. Recheck the authority and pins before its
  // summary can be published, so a stale run cannot be reported as current.
  assert.equal(
    hash((await readJsonWithBytes(input.reviewReceiptPath)).bytes),
    reviewSha256,
  );
  assert.equal(
    hash((await readJsonWithBytes(review.proposalReceiptPath)).bytes),
    proposalSha256,
  );
  assert.equal(
    hash((await readJsonWithBytes(pin.publicationPath)).bytes),
    pin.publicationSha256,
  );
  assert.equal(
    hash((await readJsonWithBytes(review.draftPath, 524_288)).bytes),
    review.afterGraphId,
  );
  assert.equal(
    await registrationFor(transport, publication.source),
    publication.registration,
    'Current source admission changed during trial',
  );
  if (child) {
    assert.equal(hash((await readJsonWithBytes(childReviewReceiptPath!)).bytes), child.sha256);
    const childDraftPath = join(publication.task.directory,
      `archive-graph-reviewed-draft-${child.review.draftSha256}.json`);
    assert.equal(hash((await readJsonWithBytes(childDraftPath, 524_288)).bytes), child.review.draftSha256);
    assert.equal((await lstat(childDraftPath)).mode & 0o077, 0);
  }
  const receipt: ReviewedArchiveGraphEvaluationReceipt = {
    schema: 1,
    kind: 'temari-reviewed-v2-graph-evaluation',
    policy: 'explicit-reviewed-root-trial-v1',
    reviewReceiptPath: input.reviewReceiptPath,
    reviewReceiptSha256: reviewSha256,
    afterPublicationPath: pin.publicationPath,
    afterPublicationSha256: pin.publicationSha256,
    sourceId: publication.source.id,
    generation: publication.generation,
    manifestSha256: publication.manifestSha256,
    graphId,
    revisionSetId: review.afterRevisionSetId,
    selectedRecordIds: selected,
    mappingSha256: hash(canonical(review.recordMapping)),
    caseId: input.caseId,
    querySha256: hash(input.query),
    lexicalSha256: hash(canonical(input.lexical)),
    lexicalBasis: 'operator-supplied-v2-verified',
    lexicalCount: input.lexical.length,
    expectedSha256: hash(canonical(input.expected)),
    expectedCount: input.expected.length,
    goldCoverage: 'not-checked',
    topK: input.topK,
    trialSha256: hash(canonical(trial)),
    trialCheckpointPath: trial.checkpointPath,
    trialCheckpointSha256,
    status: trial.status,
    expectedRecallAtK: trial.expectedRecallAtK,
    verifiedEvidenceCount: trial.verifiedEvidenceCount,
    addedCount: trial.added.length,
    trialGapCount: trial.gaps.length,
    targetReadAttempts: trial.targetReadAttempts,
    graphMutation: 'none',
    bm25Lift: 'not-measured',
    operationalQueryChanged: false,
    reviewerAuthenticated: false,
    currentOriginal: 'not-checked',
    semanticCorrectness: 'not-verified',
  };
  if (child) {
    const childReceipt: ReviewedArchiveGraphChildEvaluationReceipt = {
      ...receipt,
      kind: 'temari-reviewed-v2-child-graph-evaluation',
      policy: 'explicit-reviewed-child-trial-v1',
      rootGraphId: review.afterGraphId,
      childReviewReceiptPath: childReviewReceiptPath!,
      childReviewReceiptSha256: child.sha256,
      childDraftSha256: child.review.draftSha256,
      retractedAssertionCount: child.review.retractedAssertionIds.length,
      addedAssertionCount: child.review.addedAssertionId === null ? 0 : 1,
    };
    const receiptPath = join(publication.task.directory,
      `archive-graph-v2-child-evaluation-${hash(canonical(childReceipt))}.json`);
    await publishJson(receiptPath, childReceipt);
    return { trial, receipt: childReceipt, receiptPath };
  }
  const receiptPath = join(
    publication.task.directory,
    `archive-graph-v2-evaluation-${hash(canonical(receipt))}.json`,
  );
  await publishJson(receiptPath, receipt);
  return { trial, receipt, receiptPath };
}

/** Evaluate only the explicitly reviewed fresh root. */
export async function evaluateReviewedArchiveGraphRoot(input: ReviewedArchiveGraphEvaluationInput) {
  const result = await evaluateReviewedArchiveGraph(input);
  assert(result.receipt.kind === 'temari-reviewed-v2-graph-evaluation');
  return { ...result, receipt: result.receipt };
}

export interface ReviewedArchiveGraphChildEvaluationInput extends ReviewedArchiveGraphEvaluationInput {
  readonly childReviewReceiptPath: string;
}

/** Both content-addressed reviews are required; arbitrary child IDs are not accepted. */
export async function evaluateReviewedArchiveGraphChild(input: ReviewedArchiveGraphChildEvaluationInput) {
  const { childReviewReceiptPath, ...rootInput } = input;
  assert(isAbsolute(childReviewReceiptPath));
  const result = await evaluateReviewedArchiveGraph(rootInput, childReviewReceiptPath);
  assert(result.receipt.kind === 'temari-reviewed-v2-child-graph-evaluation');
  return { ...result, receipt: result.receipt };
}

export interface ReviewedArchiveGraphChildEvaluationReceipt extends Omit<
  ReviewedArchiveGraphEvaluationReceipt, 'kind' | 'policy'
> {
  readonly kind: 'temari-reviewed-v2-child-graph-evaluation';
  readonly policy: 'explicit-reviewed-child-trial-v1';
  readonly rootGraphId: string;
  readonly childReviewReceiptPath: string;
  readonly childReviewReceiptSha256: string;
  readonly childDraftSha256: string;
  readonly retractedAssertionCount: number;
  readonly addedAssertionCount: number;
}
