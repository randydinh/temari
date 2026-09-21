import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { InvestigationCheckpoint } from '@temari/contracts';
import type { DraftIssue, DraftReview, Proposal } from './types.js';

export const sha256 = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  const result = JSON.stringify(value);
  assert(result !== undefined, 'Non-JSON input');
  assert(
    typeof value !== 'number' || Number.isFinite(value),
    'Non-finite input',
  );
  return result;
}

export function bounded(value: unknown, bytes: number, label: string): string {
  const body = canonical(value);
  assert(Buffer.byteLength(body) <= bytes, `${label} exceeds ${bytes} bytes`);
  return body;
}

export function frozenCopy<T>(value: T): T {
  function freeze(v: unknown): void {
    if (v !== null && typeof v === 'object') {
      Object.values(v).forEach(freeze);
      Object.freeze(v);
    }
  }
  const copy: T = JSON.parse(canonical(value));
  freeze(copy);
  return copy;
}

export function text(value: unknown): asserts value is string {
  assert(
    typeof value === 'string' && value.trim().length > 0,
    'Nonempty text required',
  );
}

export function uniqueStrings(value: unknown): asserts value is string[] {
  assert(Array.isArray(value), 'String list required');
  value.forEach(text);
  assert.equal(
    new Set(value).size,
    value.length,
    'Duplicate reference or criterion',
  );
}

export function validateProposal(
  input: unknown,
  checkpoint: InvestigationCheckpoint,
): asserts input is Proposal {
  bounded(input, 256 * 1024, 'Proposal');
  assert(
    input !== null && typeof input === 'object',
    'Proposal object required',
  );
  const value = input as Proposal;
  const findings = new Map(
    checkpoint.assessment!.findings.map((f) => [f.id, f]),
  );
  for (const [name, entries] of Object.entries({
    planImpact: value.planImpact,
    governingConstraints: value.governingConstraints,
    proposedSteps: value.proposedSteps,
  })) {
    assert(
      Array.isArray(entries) && entries.length > 0 && entries.length <= 64,
      `${name} requires 1–64 entries`,
    );
    for (const entry of entries) {
      text(entry.text);
      uniqueStrings(entry.findingIds);
      uniqueStrings(entry.evidenceIds);
      assert(
        entry.findingIds.length && entry.evidenceIds.length,
        'Each entry requires findings and evidence',
      );
      const cited = new Set<string>();
      for (const id of entry.findingIds) {
        const finding = findings.get(id);
        assert(finding, `Unknown finding ${id}`);
        assert(
          checkpoint.findingValidity.some(
            (f) => f.id === id && f.state === 'needs-semantic-review',
          ),
          `Unusable finding ${id}`,
        );
        const ids = [
          ...finding.supports,
          ...finding.contrary,
          ...finding.authorityEvidence,
        ];
        assert(
          ids.some((id) => entry.evidenceIds.includes(id)),
          `Finding ${id} has no cited evidence in entry`,
        );
        ids.forEach((id) => cited.add(id));
      }
      for (const id of entry.evidenceIds) {
        assert(
          cited.has(id) && checkpoint.contextEvidenceIds.includes(id),
          `Foreign or unsupplied evidence ${id}`,
        );
      }
      if (name === 'proposedSteps') {
        assert('verification' in entry);
        text(entry.verification);
      }
    }
  }
}

export function issuesFor(checkpoint: InvestigationCheckpoint): DraftIssue[] {
  return [
    ...checkpoint.gaps.map((gap, i): DraftIssue => ({
      id: `retrieval:${i}`,
      kind: 'retrieval-gap',
      detail: `${gap.kind}: ${gap.subject}: ${gap.detail}`,
    })),
    ...checkpoint.assessment!.findings.flatMap((finding, i) =>
      finding.verificationGaps.map((gap, j): DraftIssue => ({
        id: `verification:${i}:${j}`,
        kind: 'verification-gap',
        detail: `${finding.id}: ${gap}`,
      })),
    ),
    ...checkpoint.assessment!.remainingQuestions.map(
      (question, i): DraftIssue => ({
        id: `question:${i}`,
        kind: 'remaining-question',
        detail: question,
      }),
    ),
  ];
}

export function validateReview(
  value: unknown,
  candidateHash: string,
  criteria: readonly string[],
  issues: readonly DraftIssue[],
): DraftReview {
  const body = bounded(value, 256 * 1024, 'Review');
  const snapshot: unknown = JSON.parse(body);
  assert(
    snapshot !== null && typeof snapshot === 'object',
    'Review object required',
  );
  const r = snapshot as DraftReview;
  assert.equal(
    r.candidateSha256,
    candidateHash,
    'Review candidate hash mismatch',
  );
  assert(
    r.verdict === 'approve' || r.verdict === 'reject',
    'Invalid review verdict',
  );
  text(r.reason);
  assert(
    Array.isArray(r.criteria) && Array.isArray(r.issues),
    'Review coverage required',
  );
  const coveredCriteria = r.criteria.map((c) => c.criterion);
  uniqueStrings(coveredCriteria);
  assert.deepEqual(
    [...coveredCriteria].sort(),
    [...criteria].sort(),
    'Review must cover every criterion exactly once',
  );
  for (const criterion of r.criteria) {
    assert(
      typeof criterion.satisfied === 'boolean',
      'Criterion disposition required',
    );
    text(criterion.reason);
  }
  const coveredIssues = r.issues.map((i) => i.issueId);
  uniqueStrings(coveredIssues);
  assert.deepEqual(
    [...coveredIssues].sort(),
    issues.map((i) => i.id).sort(),
    'Review must cover every issue exactly once',
  );
  for (const issue of r.issues) {
    assert(
      ['resolved', 'preserved-open', 'blocking'].includes(issue.disposition),
      'Invalid issue disposition',
    );
    text(issue.reason);
    if (
      issues.find((i) => i.id === issue.issueId)!.kind === 'remaining-question'
    ) {
      assert(
        issue.disposition !== 'resolved',
        'Review cannot settle a remaining question',
      );
    }
  }
  return frozenCopy(r);
}

export function requireApproval(review: DraftReview): void {
  assert(review.verdict === 'approve', `Review rejected: ${review.reason}`);
  assert(
    review.criteria.every((c) => c.satisfied),
    'Acceptance criterion not satisfied',
  );
  assert(
    review.issues.every((i) => i.disposition !== 'blocking'),
    'Review identified a blocking issue',
  );
}

const line = (value: string): string =>
  value.replace(/\r?\n/g, ' ').replace(/[\\`*_{}[\]()<>#!|]/g, '\\$&');

export function validateTitle(title: string): void {
  text(title);
  assert(
    title.length <= 300 && !/[\r\n]/.test(title),
    'Title must be one line, at most 300 characters',
  );
}

export function renderDraft(
  title: string,
  proposal: Proposal,
  checkpoint: InvestigationCheckpoint,
  issues: readonly DraftIssue[],
): string {
  validateTitle(title);
  const entry = (e: Proposal['planImpact'][number]): string =>
    `${line(e.text)}\n  Findings: ${e.findingIds.map(line).join(', ')}. Evidence: ${e.evidenceIds.map(line).join(', ')}.`;
  const markdown =
    [
      `# ${line(title)}`,
      'Proposed implementation plan. This draft does not settle remaining owner decisions or complete the parent workflow.',
      '## Plan impact',
      ...proposal.planImpact.map((e) => `- ${entry(e)}`),
      '## Governing constraints',
      ...proposal.governingConstraints.map((e) => `- ${entry(e)}`),
      '## Proposed steps',
      ...proposal.proposedSteps.map(
        (e, i) =>
          `${i + 1}. ${entry(e)}\n   Verification: ${line(e.verification)}`,
      ),
      '## Remaining questions and verification gaps',
      ...(issues.length
        ? issues.map((i) => `- ${line(i.id)} (${i.kind}): ${line(i.detail)}`)
        : ['None recorded by this investigation.']),
      '## Source revisions',
      ...checkpoint.evidence.map(
        (e) =>
          `- Evidence ${e.id}: ${line(e.document.source.provider)} / ${line(e.document.source.id)} / ${line(e.document.source.locator)} / ${line(e.document.path)}; SHA-256 ${e.sha256}; ${line(e.representation.method)} (${line(e.representation.signature)}); Unicode code points ${e.span.start}–${e.span.end}.`,
      ),
      'Sequential local evidence checks establish neither exhaustive recall nor currency of the original live sources. Parent engineering, QA, maintenance and owner decisions remain with the caller.',
    ].join('\n\n') + '\n';
  assert(
    Buffer.byteLength(markdown) <= 512 * 1024,
    'Rendered draft exceeds 512 KiB',
  );
  return markdown;
}
