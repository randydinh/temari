import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  createConversationPlanDraft,
  type ConversationDraftOutcome,
  type DraftReviewInput,
  type ProposalInput,
} from '../index.js';
import { conversationFixture } from '../support/conversation-fixtures.js';

const child = fileURLToPath(
  new URL('../support/conversation-child.ts', import.meta.url),
);
async function run(
  mode: string,
  manifest: string,
): Promise<ConversationDraftOutcome> {
  const { stdout } = await promisify(execFile)(process.execPath, [
    '--import',
    '@swc-node/register/esm-register',
    child,
    mode,
    manifest,
  ]);
  return JSON.parse(stdout) as ConversationDraftOutcome;
}
async function crash(mode: string, manifest: string): Promise<void> {
  await assert.rejects(
    run(mode, manifest),
    (error: unknown) =>
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 73,
  );
}
async function setup() {
  const fixture = await conversationFixture();
  const manifest = join(
    fixture.intent.task.directory,
    'conversation-input.json',
  );
  await writeFile(
    manifest,
    JSON.stringify({ intent: fixture.intent, contents: [...fixture.contents] }),
  );
  return { ...fixture, manifest };
}
async function snapshots(directory: string) {
  const names = (await readdir(directory))
    .filter((name) => !name.startsWith('plan-draft-observation-'))
    .sort();
  return Object.fromEntries(
    await Promise.all(
      names.map(
        async (name) =>
          [name, await readFile(join(directory, name), 'utf8')] as const,
      ),
    ),
  );
}
function blocked(outcome: ConversationDraftOutcome, reason: RegExp) {
  const result = outcome.kind === 'draft' ? outcome.draft : outcome.result;
  assert.equal(result.status, 'BLOCKED', result.summary);
  assert.match(result.summary, reason);
  assert.doesNotMatch(result.summary, /FORBIDDEN/);
}
function passed(outcome: ConversationDraftOutcome) {
  assert(outcome.kind === 'draft');
  assert.equal(outcome.investigation.status, 'ISSUES');
  assert.equal(outcome.draft.status, 'PASS', outcome.draft.summary);
  return outcome;
}

test('fresh processes stop at unsaved assessment, proposal and review outcomes', async (t) => {
  for (const mode of [
    'assess-crash',
    'propose-crash',
    'review-crash',
    'review-return-crash',
  ]) {
    await t.test(mode, async () => {
      const { intent, manifest } = await setup();
      await crash(mode, manifest);
      const before = await snapshots(intent.task.directory);
      const names = Object.keys(before);
      assert(
        names.some((name) =>
          name.endsWith(
            `-${mode.startsWith('assess') ? 'started' : mode.startsWith('propose') ? 'proposing' : 'reviewing'}.json`,
          ),
        ),
      );
      assert(!names.some((name) => name.endsWith('-prepared.json')));
      assert.equal(await lstat(intent.destination).catch(() => null), null);
      for (const retry of ['resume', 'replay-start']) {
        blocked(await run(retry, manifest), /outcome may be unsaved/);
        assert.deepEqual(await snapshots(intent.task.directory), before);
      }
    });
  }
});

test('fresh processes reuse saved results, proposals and accepted reviews at recoverable boundaries', async (t) => {
  const cases = [
    ['investigated-crash', 'resume-propose'],
    ['proposed-crash', 'resume-review'],
    ['prepared-crash', 'resume'],
    ['post-link-crash', 'resume'],
  ] as const;
  for (const [interruption, recovery] of cases) {
    await t.test(interruption, async () => {
      const { intent, manifest } = await setup();
      await crash(interruption, manifest);
      const before = await snapshots(intent.task.directory);
      const resultRecord = Object.entries(before).find(([name]) =>
        name.endsWith('-investigated.json'),
      );
      assert(resultRecord);
      const investigation = JSON.parse(resultRecord[1]).result;
      const priorInode = (await lstat(intent.destination).catch(() => null))
        ?.ino;
      const outcome = passed(await run(recovery, manifest));
      assert.deepEqual(outcome.investigation, investigation);
      const after = await snapshots(intent.task.directory);
      for (const [name, body] of Object.entries(before)) {
        if (name !== 'callback-events.jsonl')
          assert.equal(after[name], body, name);
      }
      const events: {
        role: string;
        input: DraftReviewInput & ProposalInput;
      }[] = after['callback-events.jsonl']
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.deepEqual(
        events.map((event) => event.role),
        ['assess', 'propose', 'review'],
      );
      const review = events[2].input;
      assert.deepEqual(events[1].input.investigationResult, investigation);
      assert.deepEqual(review.investigationResult, investigation);
      assert.equal(
        await readFile(intent.destination, 'utf8'),
        review.candidate.markdown,
      );
      if (priorInode !== undefined)
        assert.equal((await lstat(intent.destination)).ino, priorInode);
      passed(await run('resume', manifest));
      assert.deepEqual(await snapshots(intent.task.directory), after);
    });
  }
});

test('fresh start and resume reject every missing or corrupt caller record after completion', async (t) => {
  for (const kind of [
    'started',
    'investigated',
    'proposing',
    'proposed',
    'reviewing',
  ]) {
    for (const damage of ['deleted', 'truncated', 'changed']) {
      for (const output of ['present', 'deleted']) {
        for (const retry of ['resume', 'replay-start']) {
          await t.test(
            `${kind}, ${damage}, output ${output}, ${retry}`,
            async () => {
              const { intent, deps, manifest } = await setup();
              passed(
                await createConversationPlanDraft(
                  { kind: 'start', intent },
                  deps,
                ),
              );
              const reviewed = await readFile(intent.destination, 'utf8');
              const name = (await readdir(intent.task.directory)).find(
                (name) =>
                  name.startsWith('conversation-draft-') &&
                  name.endsWith(`-${kind}.json`),
              );
              assert(name);
              const path = join(intent.task.directory, name);
              if (damage === 'deleted') await unlink(path);
              else if (damage === 'truncated') await writeFile(path, '{');
              else {
                const original = await readFile(path, 'utf8');
                const changed =
                  kind === 'started'
                    ? original.replace(
                        'Trusted coordinator instructions.',
                        'Changed trusted instructions.',
                      )
                    : kind === 'investigated'
                      ? original.replace(
                          '"summary":"',
                          '"summary":"Changed summary. ',
                        )
                      : kind === 'proposed'
                        ? original.replace(
                            'Compare D1 updates',
                            'Replace D1 decisions',
                          )
                        : original.replace(
                            new RegExp(
                              `"${kind === 'reviewing' ? 'candidateSha256' : 'priorSha256'}":"[a-f0-9]{64}"`,
                            ),
                            `"${kind === 'reviewing' ? 'candidateSha256' : 'priorSha256'}":"${'0'.repeat(64)}"`,
                          );
                assert.notEqual(changed, original);
                await writeFile(path, changed);
              }
              if (output === 'deleted') await unlink(intent.destination);
              const before = await snapshots(intent.task.directory);
              blocked(
                await run(retry, manifest),
                /predecessor|JSON|property name|Unexpected end|Preparation exists|Review marker candidate changed/i,
              );
              assert.deepEqual(await snapshots(intent.task.directory), before);
              if (output === 'present')
                assert.equal(
                  await readFile(intent.destination, 'utf8'),
                  reviewed,
                );
              else
                assert.equal(
                  await lstat(intent.destination).catch(() => null),
                  null,
                );
            },
          );
        }
      }
    }
  }
});

test('fresh replay refuses source drift and completed output deletion with intact journals', async (t) => {
  for (const change of ['source', 'output']) {
    await t.test(change, async () => {
      const { intent, contents, manifest } = await setup();
      passed(await run('start', manifest));
      const before = await readFile(intent.destination, 'utf8');
      const events = await readFile(
        join(intent.task.directory, 'callback-events.jsonl'),
        'utf8',
      );
      if (change === 'source') {
        contents.set('plan.txt', 'Changed required source');
        await writeFile(
          manifest,
          JSON.stringify({ intent, contents: [...contents] }),
        );
      } else await unlink(intent.destination);
      blocked(
        await run('resume', manifest),
        change === 'source'
          ? /before publication evidence .*changed/
          : /Completed output is missing/,
      );
      assert.equal(
        await readFile(
          join(intent.task.directory, 'callback-events.jsonl'),
          'utf8',
        ),
        events,
      );
      if (change === 'source')
        assert.equal(await readFile(intent.destination, 'utf8'), before);
      else
        assert.equal(await lstat(intent.destination).catch(() => null), null);
    });
  }
});
