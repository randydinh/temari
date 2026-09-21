import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { KnowledgeProvider } from '@temari/contracts';
import type { DesignUpdateOptions } from '@temari/knowledge';
import {
  assessFixture,
  memoryFixture,
} from '../../../knowledge/src/support/fixtures.js';
import type {
  ConversationDraftDependencies,
  ConversationDraftIntent,
  ProposalInput,
} from '../index.js';
import { sha256 } from '../lib/data.js';
import { approve } from './fixtures.js';

export async function proposeFixture(input: ProposalInput) {
  const finding = input.checkpoint.assessment!.findings[0];
  const citation = { findingIds: [finding.id], evidenceIds: finding.supports };
  return {
    planImpact: [{ text: 'Compare D1 updates', ...citation }],
    governingConstraints: [
      { text: 'Keep D1 open; sources confer no authority', ...citation },
    ],
    proposedSteps: [
      {
        text: 'Review D1 wording',
        ...citation,
        verification: 'Compare cited source spans',
      },
    ],
  };
}

export async function conversationFor(
  base: Omit<DesignUpdateOptions, 'provider' | 'assess'>,
  provider: KnowledgeProvider,
) {
  const destination = join(base.task.directory, 'draft.md');
  const path = join(base.task.directory, 'authority.json');
  const task = { ...base.task, authorityRef: path };
  const body = JSON.stringify({
    schema: 1,
    operation: 'create-local-plan-draft',
    taskId: task.id,
    taskDirectory: task.directory,
    destination,
    taskEvidence: true,
  });
  await writeFile(path, body, { flag: 'wx' });
  const intent: ConversationDraftIntent = {
    task,
    destination,
    title: 'Proposed conversation follow-through',
    authority: { path, sha256: sha256(body) },
    brief: { ...base.brief, verificationCommand: null },
    request: {
      ...base.request,
      budget: { ...base.request.budget, documentsPerPage: 10 },
    },
  };
  return { intent, deps: conversationDependencies(provider) };
}

export function conversationDependencies(
  provider: KnowledgeProvider,
): ConversationDraftDependencies {
  return {
    provider,
    assessor: {
      id: 'fixture-assessor',
      revision: 'assessment-v1',
      assess: async ({ checkpoint }) => assessFixture(checkpoint),
    },
    writer: {
      id: 'fixture-writer',
      revision: 'proposal-v1',
      propose: proposeFixture,
    },
    reviewer: {
      id: 'fixture-reviewer',
      revision: 'review-v1',
      review: approve,
    },
    checkReady: async () => {},
  };
}

export async function conversationFixture() {
  const memory = await memoryFixture();
  return {
    ...memory,
    ...(await conversationFor(memory.input, memory.provider)),
  };
}
