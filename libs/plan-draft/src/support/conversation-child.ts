import assert from 'node:assert/strict';
import { lstat, open, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { memoryFixture } from '../../../knowledge/src/support/fixtures.js';
import {
  createConversationPlanDraft,
  type ConversationDraftIntent,
  type DraftReviewInput,
} from '../index.js';
import { conversationDependencies } from './conversation-fixtures.js';

const [mode, manifest] = process.argv.slice(2);
const saved = JSON.parse(await readFile(manifest, 'utf8')) as {
  intent: ConversationDraftIntent;
  contents: [string, string][];
};
const { intent } = saved;
const memory = await memoryFixture();
memory.contents.clear();
saved.contents.forEach(([key, value]) => memory.contents.set(key, value));
const original = conversationDependencies(memory.provider);
const eventPath = join(intent.task.directory, 'callback-events.jsonl');
async function persist(path: string, body: string): Promise<void> {
  const file = await open(path, 'a', 0o600);
  try {
    await file.writeFile(body);
    await file.sync();
  } finally {
    await file.close();
  }
}
async function enter(role: string, input: unknown): Promise<void> {
  await persist(eventPath, JSON.stringify({ role, input }) + '\n');
  if (mode === `${role}-crash`) process.exit(73);
  if (mode === 'resume' || mode === 'replay-start')
    throw new Error(`FORBIDDEN ${role}`);
  if (mode === 'resume-propose' && role === 'assess')
    throw new Error('FORBIDDEN repeated assessment');
  if (mode === 'resume-review' && role !== 'review')
    throw new Error(`FORBIDDEN repeated ${role}`);
}
const revalidate = memory.provider.revalidate.bind(memory.provider);
const outcome = await createConversationPlanDraft(
  mode.startsWith('resume')
    ? { kind: 'resume', task: intent.task, destination: intent.destination }
    : { kind: 'start', intent },
  {
    ...original,
    provider: {
      ...memory.provider,
      revalidate: async (evidence) => {
        const output = await lstat(intent.destination).catch(() => null);
        if (mode === 'post-link-crash' && output) process.exit(73);
        if (
          mode === 'prepared-crash' &&
          !output &&
          (await readdir(intent.task.directory)).some((name) =>
            name.endsWith('-prepared.json'),
          )
        )
          process.exit(73);
        return revalidate(evidence);
      },
    },
    assessor: {
      ...original.assessor,
      assess: async (input) => {
        await enter('assess', input);
        return original.assessor.assess(input);
      },
    },
    writer: {
      ...original.writer,
      propose: async (input) => {
        await enter('propose', input);
        return original.writer.propose(input);
      },
    },
    reviewer: {
      ...original.reviewer,
      review: async (input: DraftReviewInput) => {
        await enter('review', input);
        const review = await original.reviewer.review(input);
        if (mode === 'review-return-crash') {
          return Object.defineProperty(review, 'reason', {
            enumerable: true,
            get() {
              process.exit(73);
            },
          });
        }
        return review;
      },
    },
    checkReady: async (roles) => {
      if (mode === 'resume' || mode === 'replay-start')
        throw new Error('FORBIDDEN readiness');
      if (mode === 'investigated-crash' && roles.length === 2) process.exit(73);
      if (mode === 'proposed-crash' && roles.length === 1) process.exit(73);
      if (mode === 'resume-propose')
        assert.deepEqual(
          roles,
          roles.length === 1 ? ['review'] : ['propose', 'review'],
        );
      if (mode === 'resume-review') assert.deepEqual(roles, ['review']);
    },
  },
);
process.stdout.write(JSON.stringify(outcome));
