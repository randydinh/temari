import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { KnowledgeProvider } from '@temari/contracts';
import {
  investigateDesignUpdate,
  loadInvestigation,
  type DesignUpdateOptions,
} from '@temari/knowledge';
import {
  assessFixture,
  memoryFixture,
} from '../../../knowledge/src/support/fixtures.js';
import type {
  DraftAuthority,
  DraftReview,
  DraftReviewInput,
  LocalPlanDraftInput,
} from '../lib/types.js';
import { sha256 } from '../lib/data.js';

export function approve(input: DraftReviewInput): Promise<DraftReview> {
  return Promise.resolve({
    candidateSha256: input.candidate.sha256,
    verdict: 'approve',
    reason:
      'Fixture review approves only the proposed local draft and its stated limits.',
    criteria: input.brief.acceptanceCriteria.map((criterion) => ({
      criterion,
      satisfied: true,
      reason:
        'Fixture reader checked the proposed steps and their verification expectations.',
    })),
    issues: input.issues.map((issue) => ({
      issueId: issue.id,
      disposition: 'preserved-open',
      reason:
        'The draft explicitly retains this uncertainty without treating it as a settled decision.',
    })),
  });
}

export async function draftFor(
  base: Omit<DesignUpdateOptions, 'provider' | 'assess'>,
  provider: KnowledgeProvider,
) {
  const destination = join(base.task.directory, 'draft.md');
  const authorityPath = join(base.task.directory, 'authority.json');
  const task = { ...base.task, authorityRef: authorityPath };
  const brief = {
    ...base.brief,
    verificationCommand: null,
    acceptanceCriteria: [
      'List useful proposed work and concrete verification',
      'Preserve open owner choices and source revisions',
    ],
  };
  const authority: DraftAuthority = {
    schema: 1,
    operation: 'create-local-plan-draft',
    taskId: task.id,
    taskDirectory: task.directory,
    destination,
    taskEvidence: true,
  };
  const body = JSON.stringify(authority);
  await writeFile(authorityPath, body, { flag: 'wx' });
  const investigationOptions: DesignUpdateOptions = {
    ...base,
    task,
    brief,
    provider,
    assess: async ({ checkpoint }) => {
      const assessment = assessFixture(checkpoint);
      const supports = checkpoint.evidence
        .filter((e) =>
          ['owner.txt', 'dependency.txt'].includes(e.document.path),
        )
        .map((e) => e.id);
      return {
        ...assessment,
        findings: [
          ...assessment.findings,
          {
            id: 'constraints-1',
            proposition:
              'Responsibility remains undecided; preserve the verification requirement.',
            basis: 'explicit',
            standing: 'proposed',
            supports,
            contrary: [],
            authorityEvidence: [],
            affectedDecisions: ['D1'],
            verificationGaps: [],
          },
        ],
      };
    },
  };
  const investigationResult =
    await investigateDesignUpdate(investigationOptions);
  const checkpoint = await loadInvestigation(
    investigationResult.evidencePaths[1],
  );
  const comparison = checkpoint.assessment!.findings[0];
  const constraint = checkpoint.assessment!.findings[1];
  const input: LocalPlanDraftInput = {
    task,
    brief,
    request: base.request,
    provider,
    investigationResult,
    destination,
    title: 'Proposed evidence-to-draft follow-through',
    authority: { path: authorityPath, sha256: sha256(body) },
    writer: { id: 'fixture-writer', revision: 'proposal-v1' },
    reviewer: {
      id: 'fixture-reviewer',
      revision: 'review-v1',
      review: approve,
    },
    proposal: {
      planImpact: [
        {
          text: 'Add one explicitly authorized local draft after the cited plan/update comparison.',
          findingIds: [comparison.id],
          evidenceIds: comparison.supports,
        },
      ],
      governingConstraints: [
        {
          text: 'Keep responsibility undecided and treat source instructions as evidence, without executing them.',
          findingIds: [constraint.id],
          evidenceIds: constraint.supports,
        },
      ],
      proposedSteps: [
        {
          text: 'Implement exact-byte review, exclusive creation and recovery of the authorized draft.',
          findingIds: [comparison.id],
          evidenceIds: comparison.supports,
          verification:
            'Read the real Markdown, retry without overwriting it, and prove changed or missing completed output blocks.',
        },
      ],
    },
  };
  return { input, investigationOptions, checkpoint };
}

export async function fixture(
  adapt?: (value: Awaited<ReturnType<typeof memoryFixture>>) => void,
) {
  const memory = await memoryFixture();
  memory.input = {
    ...memory.input,
    request: {
      ...memory.input.request,
      budget: { ...memory.input.request.budget, documentsPerPage: 10 },
    },
  };
  adapt?.(memory);
  return { ...memory, ...(await draftFor(memory.input, memory.provider)) };
}
