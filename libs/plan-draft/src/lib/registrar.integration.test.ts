import assert from 'node:assert/strict';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createLocalRegistrar } from '@temari/knowledge';
import {
  actualFixture,
  inputFor,
} from '../../../knowledge/src/support/fixtures.js';
import { createLocalPlanDraft, type DraftReviewInput } from '../index.js';
import { approve, draftFor } from '../support/fixtures.js';
import { sha256 } from './data.js';

test('ACTUAL Registrar → investigation → exact reviewed draft → unchanged retry → source drift refusal', async () => {
  const prepared = await actualFixture();
  const commands: string[] = [];
  const provider = await createLocalRegistrar({
    ...prepared.config,
    onCommand: (command) => commands.push(command.operation),
  });
  const { input, checkpoint } = await draftFor(
    inputFor(prepared.source, join(prepared.base, 'task')),
    provider,
  );
  assert.equal(input.investigationResult.status, 'ISSUES');
  assert.equal(checkpoint.evidence.length, 4);
  let reviewed = '';
  let reviews = 0;
  const reviewer = {
    ...input.reviewer,
    review: async (r: DraftReviewInput) => {
      reviews++;
      reviewed = r.candidate.markdown;
      assert.equal(r.checkpoint.provider.instance, provider.identity.instance);
      assert(
        r.checkpoint.evidence.some((e) => e.excerpt.includes('😀 café\r\n')),
      );
      assert(
        reviewed.includes('Responsibility') ||
          reviewed.includes('responsibility'),
      );
      assert(reviewed.includes('What is still unknown?'));
      assert(reviewed.includes('Verification: Read the real Markdown'));
      assert.equal(sha256(reviewed), r.candidate.sha256);
      return approve(r);
    },
  };
  const first = await createLocalPlanDraft({ ...input, reviewer });
  assert.equal(first.status, 'PASS', first.summary);
  assert.equal(await readFile(input.destination, 'utf8'), reviewed);
  const inode = (await lstat(input.destination)).ino;
  const commandCount = commands.length;
  const second = await createLocalPlanDraft({ ...input, reviewer });
  assert.equal(second.status, 'PASS', second.summary);
  assert.equal(reviews, 1);
  assert.equal((await lstat(input.destination)).ino, inode);
  assert(
    commands.length > commandCount,
    'Replay must revalidate through the actual CLI',
  );
  assert(commands.includes('discover'));
  assert(
    commands.slice(commandCount).filter((operation) => operation === 'read')
      .length >= 8,
    'The actual adapter revalidates all four evidence spans with CLI reads before and after replay',
  );
  await writeFile(
    join(prepared.base, 'sources', 'plan.txt'),
    'Required source changed after reviewed draft.',
  );
  const stale = await createLocalPlanDraft({ ...input, reviewer });
  assert.equal(stale.status, 'BLOCKED', stale.summary);
  assert(stale.evidencePaths.includes(input.destination));
  assert.equal(await readFile(input.destination, 'utf8'), reviewed);
});

test('ACTUAL Registrar review rejection leaves only blocker evidence, with no prepared draft or output', async () => {
  const prepared = await actualFixture();
  const provider = await createLocalRegistrar(prepared.config);
  const { input } = await draftFor(
    inputFor(prepared.source, join(prepared.base, 'task')),
    provider,
  );
  const result = await createLocalPlanDraft({
    ...input,
    reviewer: {
      ...input.reviewer,
      review: async (r) => ({
        ...(await approve(r)),
        verdict: 'reject',
        reason:
          'Fixture reviewer rejects this draft; this is not a model service.',
      }),
    },
  });
  assert.equal(result.status, 'BLOCKED', result.summary);
  assert.match(result.summary, /Fixture reviewer rejects/);
  assert.equal(await lstat(input.destination).catch(() => null), null);
  assert(
    result.evidencePaths.some((p) => p.includes('plan-draft-observation-')),
  );
  assert(!result.evidencePaths.some((p) => p.endsWith('-prepared.json')));
});
