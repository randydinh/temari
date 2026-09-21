import assert from 'node:assert/strict';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  minimalPlan,
  type InvestigationCheckpoint,
  type KnowledgeCheck,
  type KnowledgeProvider,
  type WorkerResult,
} from '@temari/contracts';
import { loadInvestigation } from '@temari/knowledge';
import { runPlan } from '@temari/workflow-engine';
import type {
  DraftAuthority,
  DraftIdentity,
  DraftIssue,
  DraftReview,
  LocalPlanDraftInput,
} from './types.js';
import {
  bounded,
  canonical,
  frozenCopy,
  issuesFor,
  renderDraft,
  requireApproval,
  sha256,
  text,
  uniqueStrings,
  validateProposal,
  validateReview,
} from './data.js';
import {
  canonicalDirectory,
  message,
  observe,
  publish,
  readRegular,
  syncDirectory,
  type OutputObservation,
} from './files.js';

type Subject = Omit<LocalPlanDraftInput, 'provider' | 'reviewer'> & {
  readonly provider: KnowledgeProvider['identity'];
  readonly reviewer: DraftIdentity;
  readonly renderer: 'local-plan-draft-v1';
};
interface Preparation {
  readonly schema: 1;
  readonly subject: Subject;
  readonly candidate: { readonly markdown: string; readonly sha256: string };
  readonly issues: readonly DraftIssue[];
  readonly review: DraftReview;
}
type PreparedDraft =
  | { readonly kind: 'unprepared' }
  | { readonly kind: 'prepared'; readonly record: Preparation };
class DraftStop extends Error {}

async function investigation(
  subject: Subject,
  paths?: Set<string>,
): Promise<InvestigationCheckpoint> {
  const result = subject.investigationResult;
  text(result.summary);
  assert(
    result.status === 'ISSUES' || result.status === 'BLOCKED',
    'Actual investigation status required',
  );
  assert(
    result.rawLogPath === null && result.evidencePaths.length === 2,
    'Actual two-checkpoint result required',
  );
  const [partialPath, finalPath] = result.evidencePaths;
  assert(
    partialPath !== finalPath,
    'Distinct partial and final checkpoints required',
  );
  const partial = await loadInvestigation(partialPath);
  paths?.add(partialPath);
  const final = await loadInvestigation(finalPath);
  paths?.add(finalPath);
  assert.equal(
    final.prior,
    partialPath,
    'Final checkpoint does not follow the supplied partial checkpoint',
  );
  for (const checkpoint of [partial, final]) {
    assert.equal(
      canonical(checkpoint.task),
      canonical(subject.task),
      'Investigation task/authority mismatch',
    );
    assert.equal(
      canonical(checkpoint.trustedBrief),
      canonical(subject.brief),
      'Trusted brief mismatch',
    );
    assert.equal(
      canonical(checkpoint.request),
      canonical(subject.request),
      'Investigation request mismatch',
    );
    assert.equal(
      canonical(checkpoint.provider),
      canonical(subject.provider),
      'Investigation provider mismatch',
    );
  }
  const stable = ({
    prior,
    assessment,
    completedAssessments,
    gaps,
    checks,
    findingValidity,
    ...rest
  }: InvestigationCheckpoint) => rest;
  assert.equal(
    canonical(stable(partial)),
    canonical(stable(final)),
    'Partial/final retrieval mismatch',
  );
  const incomplete =
    final.assessment === null ||
    final.gaps.length > 0 ||
    final.findingValidity.some((f) => f.state !== 'needs-semantic-review') ||
    final.checks.some((c) => c.state !== 'unchanged');
  assert.equal(
    result.status,
    incomplete ? 'BLOCKED' : 'ISSUES',
    'Investigation status/checkpoint mismatch',
  );
  assert(final.assessment !== null, 'Missing assessment');
  assert(
    !final.gaps.some((g) => g.subject === 'assessment'),
    'Assessment failed; retained old assessment cannot authorize a draft',
  );
  assert.equal(
    canonical(partial.gaps),
    canonical(final.gaps),
    'Unaccounted final investigation gaps',
  );
  const assessmentInput = sha256(
    canonical({
      task: partial.task,
      brief: partial.trustedBrief,
      request: partial.request,
      provider: partial.provider,
      suppliedContext: partial.suppliedContext,
      evidence: partial.evidence.map((e) => e.id),
      discovery: partial.discovery,
      pending: partial.pendingReads,
      checks: partial.checks.map((c) => ({
        evidenceId: c.evidenceId,
        state: c.state,
      })),
      gaps: partial.gaps,
    }),
  );
  const expectedAssessments = partial.completedAssessments.includes(
    assessmentInput,
  )
    ? partial.completedAssessments
    : [...partial.completedAssessments, assessmentInput];
  assert.equal(
    canonical(final.completedAssessments),
    canonical(expectedAssessments),
    'Current assessment input was not completed',
  );
  const questions = [
    ...final.assessment.assessedQuestions,
    ...final.assessment.remainingQuestions,
  ];
  uniqueStrings(questions);
  for (const question of [
    ...subject.request.questions,
    ...(partial.assessment?.remainingQuestions ?? []),
    ...(partial.assessment?.assessedQuestions ?? []),
  ]) {
    assert(questions.includes(question), `Known question omitted: ${question}`);
  }
  assert(final.pendingReads.length === 0, 'Selected reads are incomplete');
  for (const selection of subject.request.selections) {
    assert(
      final.evidence.some(
        (e) => canonical(e.document) === canonical(selection.document),
      ),
      `Missing selected evidence: ${selection.id}`,
    );
  }
  assert(
    final.checks.length === final.evidence.length &&
      new Set(final.checks.map((c) => c.evidenceId)).size ===
        final.evidence.length,
    'Missing or duplicate evidence checks',
  );
  for (const evidence of final.evidence) {
    assert(
      final.contextEvidenceIds.includes(evidence.id),
      `Selected evidence omitted from assessment: ${evidence.id}`,
    );
    assert(
      final.checks.some(
        (c) => c.evidenceId === evidence.id && c.state === 'unchanged',
      ),
      `Stale or unavailable evidence: ${evidence.id}`,
    );
  }
  const discoveryOnly = new Set(
    final.discovery.flatMap((page) =>
      page.documents
        .filter(
          (d) =>
            !subject.request.selections.some(
              (s) => canonical(s.document) === canonical(d.document),
            ),
        )
        .map((d) => d.document.path),
    ),
  );
  assert(
    final.gaps.every(
      (g) => g.subject === 'discovery' || discoveryOnly.has(g.subject),
    ),
    'Required investigation gap blocks the draft',
  );
  return final;
}

async function authorityFor(subject: Subject): Promise<DraftAuthority> {
  const { task, destination, authority } = subject;
  text(task.id);
  assert.equal(
    task.authorityRef,
    authority.path,
    'Task authorityRef must equal the authority record path',
  );
  assert(
    isAbsolute(authority.path) &&
      resolve(authority.path) === authority.path &&
      (await realpath(authority.path)) === authority.path,
    'Canonical authority record required',
  );
  assert(/^[a-f0-9]{64}$/.test(authority.sha256), 'Authority SHA-256 required');
  const bytes = await readRegular(authority.path, 64 * 1024);
  assert(
    bytes && sha256(bytes) === authority.sha256,
    'Authority record missing or changed',
  );
  const expected: DraftAuthority = {
    schema: 1,
    operation: 'create-local-plan-draft',
    taskId: task.id,
    taskDirectory: task.directory,
    destination,
    taskEvidence: true,
  };
  assert.equal(
    canonical(JSON.parse(bytes.toString('utf8'))),
    canonical(expected),
    'Authority does not authorize this exact operation/task/destination and task evidence',
  );
  return expected;
}

async function readPreparation(
  path: string,
  subject: Subject,
  candidate: Preparation['candidate'],
  issues: readonly DraftIssue[],
): Promise<PreparedDraft> {
  const bytes = await readRegular(path, 2 * 1024 * 1024);
  if (bytes === null) return { kind: 'unprepared' };
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  assert(value !== null && typeof value === 'object', 'Invalid preparation');
  const record = value as Preparation;
  assert.equal(record.schema, 1, 'Unsupported preparation');
  assert.equal(
    canonical(record.subject),
    canonical(subject),
    'Preparation is pinned to different inputs; retain it and use a new authorized task/destination',
  );
  assert.equal(
    canonical(record.candidate),
    canonical(candidate),
    'Preparation candidate changed',
  );
  assert.equal(
    canonical(record.issues),
    canonical(issues),
    'Preparation issue list changed',
  );
  const review = validateReview(
    record.review,
    candidate.sha256,
    subject.brief.acceptanceCriteria,
    issues,
  );
  requireApproval(review);
  assert.equal(
    canonical(record),
    canonical({ schema: 1, subject, candidate, issues, review }),
    'Unexpected preparation fields',
  );
  return { kind: 'prepared', record: frozenCopy(record) };
}

export async function createLocalPlanDraft(
  input: LocalPlanDraftInput,
): Promise<WorkerResult> {
  const directory = input.task.directory;
  await canonicalDirectory(directory);
  const paths = new Set<string>();
  let subject: Subject | undefined;
  let stage = 'investigate';
  let checkpoint: InvestigationCheckpoint | undefined;
  let authority: DraftAuthority | undefined;
  let issues: readonly DraftIssue[] = [];
  let candidate: Preparation['candidate'] | undefined;
  let prepared: PreparedDraft = { kind: 'unprepared' };
  let attemptedReview: DraftReview | null = null;
  let output: OutputObservation = { kind: 'absent' };
  const checks: {
    readonly phase: 'before' | 'after';
    readonly check: KnowledgeCheck;
  }[] = [];
  let preparationPath = '';
  let completionPath = '';
  let slot = '';
  const provider = input.provider;
  const review = input.reviewer.review;

  async function dependencies(phase: 'before' | 'after'): Promise<void> {
    assert(subject && checkpoint && authority);
    await canonicalDirectory(directory);
    await canonicalDirectory(dirname(subject.destination));
    await authorityFor(subject);
    assert.equal(
      canonical(provider.identity),
      canonical(subject.provider),
      'Provider identity changed',
    );
    assert.equal(
      canonical(await investigation(subject)),
      canonical(checkpoint),
      'Investigation changed',
    );
    for (const evidence of checkpoint.evidence) {
      const value: unknown = await provider.revalidate(frozenCopy(evidence));
      const snapshot: unknown = JSON.parse(
        bounded(value, 16 * 1024, 'Provider check'),
      );
      assert(
        snapshot !== null && typeof snapshot === 'object',
        'Invalid provider check',
      );
      const check = snapshot as KnowledgeCheck;
      assert.equal(
        check.evidenceId,
        evidence.id,
        'Provider checked different evidence',
      );
      text(check.detail);
      text(check.checkedAt);
      assert(
        ['unchanged', 'changed', 'unavailable', 'unknown'].includes(
          check.state,
        ),
        'Invalid provider check state',
      );
      checks.push({ phase, check: frozenCopy(check) });
      assert.equal(
        check.state,
        'unchanged',
        `${phase} publication evidence ${evidence.id}: ${check.state}: ${check.detail}`,
      );
    }
    assert.equal(
      canonical(provider.identity),
      canonical(subject.provider),
      'Provider identity changed during revalidation',
    );
    await authorityFor(subject);
  }

  async function completionExists(): Promise<boolean> {
    assert(subject && candidate && prepared.kind === 'prepared');
    const bytes = await readRegular(completionPath, 4096);
    if (bytes === null) return false;
    paths.add(completionPath);
    assert.equal(
      bytes.toString('utf8'),
      completionBody(),
      'Completion record is invalid or belongs to different preparation',
    );
    return true;
  }

  function completionBody(): string {
    assert(subject && candidate && prepared.kind === 'prepared');
    return canonical({
      schema: 1,
      kind: 'completed',
      slot,
      destination: subject.destination,
      preparationSha256: sha256(canonical(prepared.record)),
      candidateSha256: candidate.sha256,
    });
  }

  async function outcome(
    status: 'PASS' | 'BLOCKED',
    reason: string,
  ): Promise<WorkerResult> {
    if (subject && isAbsolute(subject.destination)) {
      output = await observe(subject.destination, candidate?.markdown);
      if (output.kind !== 'absent') paths.add(subject.destination);
      if (status === 'PASS')
        assert(
          output.kind === 'matching',
          `Outcome output changed: ${output.kind}`,
        );
    }
    for (const path of [preparationPath, completionPath]) {
      if (path && (await lstat(path).catch(() => null))) paths.add(path);
    }
    for (const path of paths) {
      if (!(await lstat(path).catch(() => null))) paths.delete(path);
    }
    const body = bounded(
      {
        schema: 1,
        kind: status === 'PASS' ? 'completed' : 'blocked',
        stage,
        subject: subject ?? null,
        candidateSha256: candidate?.sha256 ?? null,
        review: attemptedReview,
        output,
        checks,
        reason,
        artifacts: [...paths],
      },
      4 * 1024 * 1024,
      'Outcome',
    );
    const path = join(directory, `plan-draft-observation-${sha256(body)}.json`);
    if (!(await publish(directory, path, body))) {
      const existing = await readRegular(path, 4 * 1024 * 1024);
      assert(
        existing?.equals(Buffer.from(body)),
        'Outcome collision or tampering',
      );
    }
    paths.add(path);
    return {
      status,
      summary: reason,
      evidencePaths: [...paths],
      rawLogPath: null,
    };
  }

  try {
    const snapshot = {
      task: input.task,
      brief: input.brief,
      request: input.request,
      provider: provider.identity,
      investigationResult: input.investigationResult,
      proposal: input.proposal,
      destination: input.destination,
      title: input.title,
      authority: input.authority,
      writer: input.writer,
      reviewer: { id: input.reviewer.id, revision: input.reviewer.revision },
      renderer: 'local-plan-draft-v1' as const,
    };
    bounded(snapshot, 1024 * 1024, 'Draft input');
    subject = frozenCopy(snapshot);
    await runPlan(
      {
        ...minimalPlan('feature'),
        stages: ['investigate', 'plan', 'review', 'build', 'verify', 'deliver'],
        review: 'independent',
        evidence: 'revision-bound',
      },
      [],
      async (current) => {
        stage = current;
        try {
          assert(subject);
          switch (current) {
            case 'investigate': {
              assert.equal(
                subject.brief.verificationCommand,
                null,
                'This fixed draft action cannot execute a verificationCommand; parent obligations remain with the caller',
              );
              uniqueStrings(subject.brief.acceptanceCriteria);
              assert(
                subject.brief.acceptanceCriteria.length > 0,
                'Acceptance criteria required',
              );
              text(subject.writer.id);
              text(subject.writer.revision);
              text(subject.reviewer.id);
              text(subject.reviewer.revision);
              assert(
                subject.writer.id !== subject.reviewer.id,
                'Independent reviewer identity required',
              );
              assert(
                isAbsolute(subject.destination) &&
                  resolve(subject.destination) === subject.destination &&
                  subject.destination.endsWith('.md'),
                'Exact absolute Markdown destination required',
              );
              await canonicalDirectory(dirname(subject.destination));
              assert.equal(
                (await lstat(directory)).dev,
                (await lstat(dirname(subject.destination))).dev,
                'Task and output parent must share one filesystem',
              );
              authority = await authorityFor(subject);
              checkpoint = await investigation(subject, paths);
              slot = sha256(
                canonical({
                  taskId: subject.task.id,
                  taskDirectory: directory,
                  destination: subject.destination,
                }),
              );
              preparationPath = join(
                directory,
                `plan-draft-${slot}-prepared.json`,
              );
              completionPath = join(
                directory,
                `plan-draft-${slot}-completed.json`,
              );
              break;
            }
            case 'plan': {
              assert(checkpoint);
              validateProposal(subject.proposal, checkpoint);
              issues = issuesFor(checkpoint);
              const markdown = renderDraft(
                subject.title,
                subject.proposal,
                checkpoint,
                issues,
              );
              candidate = { markdown, sha256: sha256(markdown) };
              prepared = await readPreparation(
                preparationPath,
                subject,
                candidate,
                issues,
              );
              if (prepared.kind === 'prepared') paths.add(preparationPath);
              else {
                output = await observe(subject.destination, markdown);
                assert(
                  output.kind === 'absent',
                  'Existing output without matching preparation cannot be adopted',
                );
                assert(
                  (await readRegular(completionPath, 4096)) === null,
                  'Completion exists without preparation',
                );
              }
              break;
            }
            case 'review': {
              assert(candidate && checkpoint && authority);
              if (prepared.kind === 'prepared')
                attemptedReview = prepared.record.review;
              else {
                const reviewInput = {
                  candidate,
                  destination: subject.destination,
                  authority,
                  task: subject.task,
                  brief: subject.brief,
                  request: subject.request,
                  investigationResult: subject.investigationResult,
                  checkpoint,
                  proposal: subject.proposal,
                  issues,
                  writer: subject.writer,
                  reviewer: subject.reviewer,
                };
                bounded(reviewInput, 20 * 1024 * 1024, 'Review input');
                attemptedReview = validateReview(
                  await review(frozenCopy(reviewInput)),
                  candidate.sha256,
                  subject.brief.acceptanceCriteria,
                  issues,
                );
              }
              requireApproval(attemptedReview);
              break;
            }
            case 'build': {
              assert(candidate && attemptedReview);
              if (prepared.kind === 'unprepared') {
                const record: Preparation = {
                  schema: 1,
                  subject,
                  candidate,
                  issues,
                  review: attemptedReview,
                };
                await publish(
                  directory,
                  preparationPath,
                  bounded(record, 2 * 1024 * 1024, 'Preparation'),
                );
                prepared = await readPreparation(
                  preparationPath,
                  subject,
                  candidate,
                  issues,
                );
                assert(prepared.kind === 'prepared');
                attemptedReview = prepared.record.review;
                paths.add(preparationPath);
              }
              const completed = await completionExists();
              await dependencies('before');
              output = await observe(subject.destination, candidate.markdown);
              if (output.kind === 'absent') {
                assert(
                  !completed,
                  'Completed output is missing; automatic recreation is refused',
                );
                await publish(
                  directory,
                  subject.destination,
                  candidate.markdown,
                );
              } else
                assert(
                  output.kind === 'matching',
                  `Output ${output.kind}; existing bytes preserved`,
                );
              break;
            }
            case 'verify': {
              assert(candidate);
              await dependencies('after');
              output = await observe(subject.destination, candidate.markdown);
              assert(
                output.kind === 'matching',
                `Output verification failed: ${output.kind}`,
              );
              paths.add(subject.destination);
              prepared = await readPreparation(
                preparationPath,
                subject,
                candidate,
                issues,
              );
              assert(prepared.kind === 'prepared', 'Preparation disappeared');
              await syncDirectory(dirname(subject.destination));
              break;
            }
            case 'deliver': {
              if (!(await publish(directory, completionPath, completionBody())))
                await completionExists();
              paths.add(completionPath);
              break;
            }
          }
        } catch (error) {
          throw new DraftStop(`${current}: ${message(error)}`);
        }
      },
    );
    return await outcome(
      'PASS',
      'Exact authorized plan draft reviewed, published and revalidated. Parent workflow completion remains with the caller.',
    );
  } catch (error) {
    return await outcome(
      'BLOCKED',
      error instanceof DraftStop
        ? error.message
        : `${stage}: ${message(error)}`,
    );
  }
}
