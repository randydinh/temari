import assert from 'node:assert/strict';
import { lstat, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
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

test('every provider and judgment identity/revision is pinned, as is repeated-start context', async (t) => {
  const changes = [
    ...(['instance', 'implementation', 'configuration'] as const).map(
      (field) => ({
        name: `provider ${field}`,
        change: (
          deps: ConversationDraftDependencies,
        ): ConversationDraftDependencies => ({
          ...deps,
          provider: {
            ...deps.provider,
            identity: { ...deps.provider.identity, [field]: 'changed' },
          },
        }),
      }),
    ),
    ...(['assessor', 'writer', 'reviewer'] as const).flatMap((role) =>
      (['id', 'revision'] as const).map((field) => ({
        name: `${role} ${field}`,
        change: (
          deps: ConversationDraftDependencies,
        ): ConversationDraftDependencies => ({
          ...deps,
          [role]: { ...deps[role], [field]: 'changed' },
        }),
      })),
    ),
  ];
  for (const { name, change } of changes) {
    await t.test(name, async () => {
      const { intent, deps } = await conversationFixture();
      const first = await createConversationPlanDraft(
        { kind: 'start', intent },
        deps,
      );
      assert(first.kind === 'draft' && first.draft.status === 'PASS');
      const bytes = await readFile(intent.destination, 'utf8');
      blocked(
        await createConversationPlanDraft(
          {
            kind: 'resume',
            task: intent.task,
            destination: intent.destination,
          },
          change(noJudgments(deps)),
        ),
        /Saved binding or dependency identity\/revision changed/,
      );
      assert.equal(await readFile(intent.destination, 'utf8'), bytes);
    });
  }
  const { intent, deps } = await conversationFixture();
  const first = await createConversationPlanDraft(
    { kind: 'start', intent },
    deps,
  );
  assert(first.kind === 'draft' && first.draft.status === 'PASS');
  const bytes = await readFile(intent.destination, 'utf8');
  blocked(
    await createConversationPlanDraft(
      {
        kind: 'start',
        intent: {
          ...intent,
          brief: { ...intent.brief, context: 'Different trusted context' },
        },
      },
      noJudgments(deps),
    ),
    /Start inputs differ/,
  );
  assert.equal(await readFile(intent.destination, 'utf8'), bytes);
});

test('missing authority or missing judgment function blocks before any provider data access', async (t) => {
  for (const absent of [
    'authority',
    'assessor',
    'writer',
    'reviewer',
  ] as const) {
    await t.test(absent, async () => {
      const { intent, deps } = await conversationFixture();
      if (absent === 'authority') await unlink(intent.authority.path);
      const broken = noJudgments(deps);
      if (absent === 'assessor')
        Object.assign(broken.assessor, { assess: undefined });
      if (absent === 'writer')
        Object.assign(broken.writer, { propose: undefined });
      if (absent === 'reviewer')
        Object.assign(broken.reviewer, { review: undefined });
      const outcome = await createConversationPlanDraft(
        { kind: 'start', intent },
        {
          ...broken,
          provider: {
            ...deps.provider,
            discover: async () => {
              throw new Error('FORBIDDEN provider');
            },
          },
        },
      );
      blocked(
        outcome,
        absent === 'authority' ? /ENOENT/ : /Configured assessment/,
      );
      assert.deepEqual(
        await readdir(intent.task.directory),
        absent === 'authority' ? [] : ['authority.json'],
      );
    });
  }
});

test('assessment failure and omitted required context preserve actual BLOCKED knowledge without proposal', async (t) => {
  for (const defect of ['throws', 'malformed', 'context'] as const) {
    await t.test(defect, async () => {
      const { intent, deps } = await conversationFixture();
      const outcome = await createConversationPlanDraft(
        {
          kind: 'start',
          intent:
            defect === 'context'
              ? {
                  ...intent,
                  request: {
                    ...intent.request,
                    budget: {
                      ...intent.request.budget,
                      contextCodePoints: 256,
                    },
                  },
                }
              : intent,
        },
        {
          ...deps,
          assessor: {
            ...deps.assessor,
            assess: async (input) => {
              if (defect === 'throws')
                throw new Error('Assessment service failed');
              const assessment = await deps.assessor.assess(input);
              return { ...assessment, findings: [] };
            },
          },
          writer: noJudgments(deps).writer,
        },
      );
      assert(outcome.kind === 'stopped');
      assert.equal(outcome.investigation?.status, 'BLOCKED');
      blocked(
        outcome,
        /Missing assessment|Assessment failed|Required investigation gap|Unaccounted final investigation gaps/,
      );
      assert.equal(await lstat(intent.destination).catch(() => null), null);
      assert(
        (await readdir(intent.task.directory)).some((name) =>
          name.endsWith('-investigated.json'),
        ),
      );
      assert(
        !(await readdir(intent.task.directory)).some((name) =>
          name.endsWith('-proposing.json'),
        ),
      );
    });
  }
});

test('all judgment inputs are frozen and attempted mutation cannot alter the trusted binding or output', async () => {
  const { intent, deps } = await conversationFixture();
  const original = JSON.stringify(intent);
  let reviewed = '';
  const outcome = await createConversationPlanDraft(
    { kind: 'start', intent },
    {
      ...deps,
      assessor: {
        ...deps.assessor,
        assess: async (input) => {
          assert.throws(
            () =>
              Object.assign(input.brief, { context: 'Forged trusted context' }),
            TypeError,
          );
          assert.throws(
            () =>
              Object.assign(input.checkpoint.evidence[0], {
                excerpt: 'Forged source',
              }),
            TypeError,
          );
          return deps.assessor.assess(input);
        },
      },
      writer: {
        ...deps.writer,
        propose: async (input) => {
          assert.throws(
            () =>
              Object.assign(input.brief, { context: 'Forged trusted context' }),
            TypeError,
          );
          assert.throws(
            () => Object.assign(input.checkpoint.task, { directory: '/wrong' }),
            TypeError,
          );
          return deps.writer.propose(input);
        },
      },
      reviewer: {
        ...deps.reviewer,
        review: async (input) => {
          reviewed = input.candidate.markdown;
          assert.throws(
            () => Object.assign(input.candidate, { markdown: 'Forged output' }),
            TypeError,
          );
          assert.throws(
            () => Object.assign(input.authority, { destination: '/wrong.md' }),
            TypeError,
          );
          return deps.reviewer.review(input);
        },
      },
    },
  );
  assert(outcome.kind === 'draft');
  assert.equal(outcome.draft.status, 'PASS', outcome.draft.summary);
  assert.equal(await readFile(intent.destination, 'utf8'), reviewed);
  assert.equal(JSON.stringify(intent), original);
  const started = (await readdir(intent.task.directory)).find((name) =>
    name.endsWith('-started.json'),
  )!;
  const saved = JSON.parse(
    await readFile(join(intent.task.directory, started), 'utf8'),
  );
  assert.equal(
    saved.binding.brief.context,
    'Trusted coordinator instructions.',
  );
  assert.equal(saved.binding.destination, intent.destination);
});

test('concurrent starts claim each judgment once and converge to one reviewed output', async () => {
  const { intent, deps } = await conversationFixture();
  const calls: string[] = [];
  let reviewed = '';
  const concurrent = {
    ...deps,
    assessor: {
      ...deps.assessor,
      assess: async (input: Parameters<typeof deps.assessor.assess>[0]) => {
        calls.push('assess');
        return deps.assessor.assess(input);
      },
    },
    writer: {
      ...deps.writer,
      propose: async (input: Parameters<typeof deps.writer.propose>[0]) => {
        calls.push('propose');
        return deps.writer.propose(input);
      },
    },
    reviewer: {
      ...deps.reviewer,
      review: async (input: Parameters<typeof deps.reviewer.review>[0]) => {
        calls.push('review');
        reviewed = input.candidate.markdown;
        return deps.reviewer.review(input);
      },
    },
  };
  const results = await Promise.all(
    [1, 2, 3].map(() =>
      createConversationPlanDraft({ kind: 'start', intent }, concurrent),
    ),
  );
  assert(results.some((r) => r.kind === 'draft' && r.draft.status === 'PASS'));
  assert.equal(await readFile(intent.destination, 'utf8'), reviewed);
  assert.deepEqual(calls, ['assess', 'propose', 'review']);
  const replay = await createConversationPlanDraft(
    { kind: 'resume', task: intent.task, destination: intent.destination },
    noJudgments(deps),
  );
  assert(replay.kind === 'draft' && replay.draft.status === 'PASS');
  assert.equal(await readFile(intent.destination, 'utf8'), reviewed);
});
