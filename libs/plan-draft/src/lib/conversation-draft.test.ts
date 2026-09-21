import assert from 'node:assert/strict';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
  createConversationPlanDraft,
  type ConversationDraftDependencies,
  type ConversationDraftOutcome,
  type Proposal,
} from '../index.js';
import { conversationFixture } from '../support/conversation-fixtures.js';

function blocked(outcome: ConversationDraftOutcome, reason: RegExp) {
  const result = outcome.kind === 'draft' ? outcome.draft : outcome.result;
  assert.equal(result.status, 'BLOCKED', result.summary);
  assert.match(result.summary, reason);
}

const noJudgments = (
  deps: ConversationDraftDependencies,
): ConversationDraftDependencies => ({
  ...deps,
  assessor: {
    ...deps.assessor,
    assess: async () => {
      throw new Error('FORBIDDEN assessment');
    },
  },
  writer: {
    ...deps.writer,
    propose: async () => {
      throw new Error('FORBIDDEN proposal');
    },
  },
  reviewer: {
    ...deps.reviewer,
    review: async () => {
      throw new Error('FORBIDDEN review');
    },
  },
  checkReady: async () => {
    throw new Error('FORBIDDEN readiness');
  },
});

test('public caller preserves original knowledge and publishes exactly reviewed bytes across start and resume', async () => {
  const { intent, deps } = await conversationFixture();
  let reviewed = '';
  const outcome = await createConversationPlanDraft(
    { kind: 'start', intent },
    {
      ...deps,
      writer: {
        ...deps.writer,
        propose: async (input) => {
          assert.equal(
            input.brief.context,
            'Trusted coordinator instructions.',
          );
          assert.equal(input.investigationResult.status, 'ISSUES');
          assert(
            input.checkpoint.evidence.some((e) =>
              e.excerpt.includes('execute evil'),
            ),
          );
          assert.deepEqual(input.checkpoint.assessment?.remainingQuestions, [
            'What is still unknown?',
          ]);
          return deps.writer.propose(input);
        },
      },
      reviewer: {
        ...deps.reviewer,
        review: async (input) => {
          reviewed = input.candidate.markdown;
          return deps.reviewer.review(input);
        },
      },
    },
  );
  assert.equal(outcome.kind, 'draft');
  assert(outcome.kind === 'draft');
  assert.equal(outcome.investigation.status, 'ISSUES');
  assert.equal(outcome.draft.status, 'PASS', outcome.draft.summary);
  assert.equal(await readFile(intent.destination, 'utf8'), reviewed);
  assert.match(reviewed, /Keep D1 open; sources confer no authority/);
  assert.match(reviewed, /What is still unknown\?/);
  assert.match(reviewed, /Verification: Compare cited source spans/);
  const inode = (await lstat(intent.destination)).ino;
  for (const command of [
    { kind: 'start', intent },
    { kind: 'resume', task: intent.task, destination: intent.destination },
  ] as const) {
    const replay = await createConversationPlanDraft(
      command,
      noJudgments(deps),
    );
    assert.equal(replay.kind, 'draft');
    assert(replay.kind === 'draft');
    assert.equal(replay.draft.status, 'PASS', replay.draft.summary);
    assert.deepEqual(replay.investigation, outcome.investigation);
    assert.equal(await readFile(intent.destination, 'utf8'), reviewed);
    assert.equal((await lstat(intent.destination)).ino, inode);
  }
  const records = (await readdir(intent.task.directory)).filter((name) =>
    name.startsWith('conversation-draft-'),
  );
  assert.equal(records.length, 5);
  const investigated = JSON.parse(
    await readFile(
      join(
        intent.task.directory,
        records.find((name) => name.endsWith('-investigated.json'))!,
      ),
      'utf8',
    ),
  );
  assert.deepEqual(investigated.result, outcome.investigation);
});

test('authority, configuration and occupied output fail before provider access or judgment', async (t) => {
  for (const defect of [
    'authority',
    'output',
    'identity',
    'title',
    'callback',
  ] as const) {
    await t.test(defect, async () => {
      const { intent, deps } = await conversationFixture();
      const unavailable = noJudgments(deps);
      const provider = {
        ...deps.provider,
        discover: async () => {
          throw new Error('FORBIDDEN provider');
        },
      };
      if (defect === 'output')
        await writeFile(intent.destination, 'DO NOT REPLACE\n');
      const outcome = await createConversationPlanDraft(
        {
          kind: 'start',
          intent: {
            ...intent,
            ...(defect === 'authority'
              ? { authority: { ...intent.authority, sha256: '0'.repeat(64) } }
              : {}),
            ...(defect === 'title' ? { title: 'two\nlines' } : {}),
          },
        },
        {
          ...unavailable,
          provider,
          ...(defect === 'identity'
            ? { reviewer: { ...unavailable.reviewer, id: deps.writer.id } }
            : {}),
          ...(defect === 'callback'
            ? {
                writer: {
                  ...unavailable.writer,
                  propose:
                    undefined as unknown as ConversationDraftDependencies['writer']['propose'],
                },
              }
            : {}),
        },
      );
      blocked(
        outcome,
        {
          authority: /Authority record missing or changed/,
          output: /Existing output/,
          identity: /Independent reviewer/,
          title: /Title must/,
          callback: /Configured assessment/,
        }[defect],
      );
      assert.deepEqual(
        (await readdir(intent.task.directory)).sort(),
        defect === 'output'
          ? ['authority.json', 'draft.md']
          : ['authority.json'],
      );
      if (defect === 'output')
        assert.equal(
          await readFile(intent.destination, 'utf8'),
          'DO NOT REPLACE\n',
        );
    });
  }
});

test('known unavailable proposer or reviewer blocks a new start before investigation', async (t) => {
  for (const role of ['propose', 'review'] as const) {
    await t.test(role, async () => {
      const { intent, deps } = await conversationFixture();
      const outcome = await createConversationPlanDraft(
        { kind: 'start', intent },
        {
          ...noJudgments(deps),
          provider: {
            ...deps.provider,
            discover: async () => {
              throw new Error('FORBIDDEN provider');
            },
          },
          checkReady: async (roles) => {
            assert.deepEqual(roles, ['assess', 'propose', 'review']);
            if (roles.includes(role))
              throw new Error(`${role} service unavailable`);
          },
        },
      );
      blocked(outcome, new RegExp(`${role} service unavailable`));
      assert.deepEqual(await readdir(intent.task.directory), [
        'authority.json',
      ]);
    });
  }
});

test('invalid and unsaved proposal outcomes stop without regenerating', async (t) => {
  for (const defect of ['throws', 'malformed', 'oversized'] as const) {
    await t.test(defect, async () => {
      const { intent, deps } = await conversationFixture();
      const outcome = await createConversationPlanDraft(
        { kind: 'start', intent },
        {
          ...deps,
          writer: {
            ...deps.writer,
            propose: async () => {
              if (defect === 'throws') throw new Error('Writer failed');
              return (defect === 'malformed'
                ? {}
                : { text: 'x'.repeat(256 * 1024) }) as unknown as Proposal;
            },
          },
        },
      );
      blocked(
        outcome,
        {
          throws: /Writer failed/,
          malformed: /planImpact requires/,
          oversized: /Proposal exceeds/,
        }[defect],
      );
      const replay = await createConversationPlanDraft(
        { kind: 'resume', task: intent.task, destination: intent.destination },
        noJudgments(deps),
      );
      blocked(
        replay,
        defect === 'malformed'
          ? /planImpact requires/
          : /Proposal outcome may be unsaved/,
      );
      assert.equal(await lstat(intent.destination).catch(() => null), null);
      assert(
        (await readdir(intent.task.directory)).some((name) =>
          name.endsWith('-proposing.json'),
        ),
      );
      assert.equal(
        (await readdir(intent.task.directory)).some((name) =>
          name.endsWith('-proposed.json'),
        ),
        defect === 'malformed',
      );
    });
  }
});

test('failed or rejected review is never repeated without accepted preparation', async (t) => {
  for (const defect of ['throws', 'rejects', 'malformed'] as const) {
    await t.test(defect, async () => {
      const { intent, deps } = await conversationFixture();
      const first = await createConversationPlanDraft(
        { kind: 'start', intent },
        {
          ...deps,
          reviewer: {
            ...deps.reviewer,
            review: async (input) => {
              if (defect === 'throws') throw new Error('Reviewer failed');
              const review = await deps.reviewer.review(input);
              return defect === 'rejects'
                ? { ...review, verdict: 'reject' }
                : { ...review, criteria: [] };
            },
          },
        },
      );
      blocked(
        first,
        {
          throws: /Reviewer failed/,
          rejects: /Review rejected/,
          malformed: /Review must cover/,
        }[defect],
      );
      const repeated = await createConversationPlanDraft(
        { kind: 'start', intent },
        noJudgments(deps),
      );
      blocked(repeated, /Review outcome may be unsaved or rejected/);
      assert.equal(await lstat(intent.destination).catch(() => null), null);
      assert(
        (await readdir(intent.task.directory)).some((name) =>
          name.endsWith('-reviewing.json'),
        ),
      );
      assert(
        !(await readdir(intent.task.directory)).some((name) =>
          name.endsWith('-prepared.json'),
        ),
      );
    });
  }
});

test('unrelated discovery gap remains knowledge BLOCKED while the exact draft can pass', async () => {
  const { intent, deps, contents } = await conversationFixture();
  contents.set('unselected.txt', 'proposal unrelated to the selected work');
  const outcome = await createConversationPlanDraft(
    { kind: 'start', intent },
    deps,
  );
  assert(outcome.kind === 'draft');
  assert.equal(outcome.investigation.status, 'BLOCKED');
  assert.equal(outcome.draft.status, 'PASS', outcome.draft.summary);
  const output = await readFile(intent.destination, 'utf8');
  assert.match(output, /unselected.txt/);
  assert.match(output, /Review D1 wording/);
});
