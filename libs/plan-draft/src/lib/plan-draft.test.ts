import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import type { WorkerResult } from '@temari/contracts';
import { investigateDesignUpdate, loadInvestigation } from '@temari/knowledge';
import {
  createLocalPlanDraft,
  type DraftReview,
  type DraftReviewInput,
  type LocalPlanDraftInput,
} from '../index.js';
import { approve, fixture } from '../support/fixtures.js';
import { sha256 } from './data.js';

const absent = async (path: string) =>
  assert.equal(await lstat(path).catch(() => null), null);
const receipt = async (result: WorkerResult) =>
  JSON.parse(
    await readFile(
      result.evidencePaths.find((p) => p.includes('plan-draft-observation-'))!,
      'utf8',
    ),
  );
const files = async (input: LocalPlanDraftInput) =>
  readdir(input.task.directory);

test('useful draft has exactly the reviewed bytes; identical replay reuses review and observes output', async () => {
  const { input } = await fixture();
  let calls = 0;
  let reviewed = '';
  const reviewer = {
    ...input.reviewer,
    review: async (r: DraftReviewInput) => {
      calls++;
      reviewed = r.candidate.markdown;
      assert(
        Object.isFrozen(r) &&
          Object.isFrozen(r.proposal.proposedSteps) &&
          Object.isFrozen(r.checkpoint),
      );
      assert.throws(() => Object.assign(r.candidate, { markdown: 'injected' }));
      assert.throws(() =>
        Object.assign(r.authority, { destination: '/tmp/foreign.md' }),
      );
      assert.equal(sha256(reviewed), r.candidate.sha256);
      assert(
        reviewed.includes(
          'Implement exact-byte review, exclusive creation and recovery',
        ),
      );
      assert(reviewed.includes('Verification: Read the real Markdown'));
      assert(reviewed.includes('What is still unknown?'));
      assert.equal(r.investigationResult.status, 'ISSUES');
      return approve(r);
    },
  };
  const first = await createLocalPlanDraft({ ...input, reviewer });
  assert.equal(first.status, 'PASS', first.summary);
  assert.equal(await readFile(input.destination, 'utf8'), reviewed);
  const inode = (await lstat(input.destination)).ino;
  const second = await createLocalPlanDraft({ ...input, reviewer });
  assert.equal(second.status, 'PASS', second.summary);
  assert.equal(calls, 1);
  assert.equal((await lstat(input.destination)).ino, inode);
  assert.equal(
    (await files(input)).filter((f) => f.endsWith('-prepared.json')).length,
    1,
  );
  assert.equal(
    (await files(input)).filter((f) => f.endsWith('-completed.json')).length,
    1,
  );
  const evidence = await receipt(second);
  assert.equal(evidence.subject.investigationResult.status, 'ISSUES');
  assert.equal(evidence.output.kind, 'matching');
  assert(evidence.checks.some((c: { phase: string }) => c.phase === 'after'));
});

test('unrelated discovery gap preserves BLOCKED knowledge while the reviewed draft can pass', async () => {
  const { input, checkpoint } = await fixture((m) =>
    m.contents.set(
      'unselected-memo.txt',
      'Proposal historical memo; excluded from this assessment.',
    ),
  );
  assert.equal(input.investigationResult.status, 'BLOCKED');
  assert(
    checkpoint.findingValidity.every(
      (f) => f.state === 'needs-semantic-review',
    ),
  );
  const result = await createLocalPlanDraft(input);
  assert.equal(result.status, 'PASS', result.summary);
  const body = await readFile(input.destination, 'utf8');
  assert(body.includes('unselected-memo.txt'));
  assert.equal(
    (await receipt(result)).subject.investigationResult.status,
    'BLOCKED',
  );
});

test('handoff refuses forged status, swapped checkpoints and changed expected bindings', async (t) => {
  const edits: [string, (i: LocalPlanDraftInput) => LocalPlanDraftInput][] = [
    [
      'status',
      (i) => ({
        ...i,
        investigationResult: { ...i.investigationResult, status: 'PASS' },
      }),
    ],
    [
      'swapped paths',
      (i) => ({
        ...i,
        investigationResult: {
          ...i.investigationResult,
          evidencePaths: [...i.investigationResult.evidencePaths].reverse(),
        },
      }),
    ],
    [
      'one checkpoint',
      (i) => ({
        ...i,
        investigationResult: {
          ...i.investigationResult,
          evidencePaths: [i.investigationResult.evidencePaths[1]],
        },
      }),
    ],
    [
      'brief',
      (i) => ({
        ...i,
        brief: { ...i.brief, context: 'Changed trusted context' },
      }),
    ],
    ['request', (i) => ({ ...i, request: { ...i.request, query: 'changed' } })],
    [
      'provider',
      (i) => ({
        ...i,
        provider: {
          ...i.provider,
          identity: { ...i.provider.identity, implementation: 'changed' },
        },
      }),
    ],
    ['task', (i) => ({ ...i, task: { ...i.task, id: 'another-task' } })],
  ];
  for (const [name, edit] of edits)
    await t.test(name, async () => {
      const { input } = await fixture();
      const result = await createLocalPlanDraft(edit(input));
      assert.equal(result.status, 'BLOCKED', result.summary);
      await absent(input.destination);
      assert.equal((await receipt(result)).kind, 'blocked');
    });
});

test('proposal rejects empty, duplicate, foreign and unusable citations or missing verification', async (t) => {
  const variants: [string, (i: LocalPlanDraftInput) => unknown][] = [
    ['empty section', (i) => ({ ...i.proposal, planImpact: [] })],
    [
      'empty text',
      (i) => ({
        ...i.proposal,
        planImpact: [{ ...i.proposal.planImpact[0], text: ' ' }],
      }),
    ],
    [
      'duplicate finding',
      (i) => ({
        ...i.proposal,
        planImpact: [
          {
            ...i.proposal.planImpact[0],
            findingIds: ['comparison-1', 'comparison-1'],
          },
        ],
      }),
    ],
    [
      'foreign finding',
      (i) => ({
        ...i.proposal,
        planImpact: [{ ...i.proposal.planImpact[0], findingIds: ['foreign'] }],
      }),
    ],
    [
      'duplicate evidence',
      (i) => ({
        ...i.proposal,
        planImpact: [
          {
            ...i.proposal.planImpact[0],
            evidenceIds: [
              i.proposal.planImpact[0].evidenceIds[0],
              i.proposal.planImpact[0].evidenceIds[0],
            ],
          },
        ],
      }),
    ],
    [
      'foreign evidence',
      (i) => ({
        ...i.proposal,
        planImpact: [{ ...i.proposal.planImpact[0], evidenceIds: ['foreign'] }],
      }),
    ],
    [
      'uncited evidence',
      (i) => ({
        ...i.proposal,
        planImpact: [
          {
            ...i.proposal.planImpact[0],
            evidenceIds: [
              ...i.proposal.planImpact[0].evidenceIds,
              i.proposal.governingConstraints[0].evidenceIds[0],
            ],
          },
        ],
      }),
    ],
    [
      'missing verification',
      (i) => ({ ...i.proposal, proposedSteps: [i.proposal.planImpact[0]] }),
    ],
    [
      'proposal size',
      (i) => ({
        ...i.proposal,
        planImpact: [
          { ...i.proposal.planImpact[0], text: 'x'.repeat(256 * 1024) },
        ],
      }),
    ],
  ];
  for (const [name, proposal] of variants)
    await t.test(name, async () => {
      const { input } = await fixture();
      const result = await createLocalPlanDraft({
        ...input,
        proposal: proposal(input) as LocalPlanDraftInput['proposal'],
      });
      assert.equal(result.status, 'BLOCKED', result.summary);
      await absent(input.destination);
    });
});

test('review failures cannot write and remaining questions cannot be resolved by callback', async (t) => {
  const variants: [string, (r: DraftReview) => unknown][] = [
    ['rejected', (r) => ({ ...r, verdict: 'reject' })],
    ['wrong bytes', (r) => ({ ...r, candidateSha256: '0'.repeat(64) })],
    ['missing criterion', (r) => ({ ...r, criteria: [] })],
    [
      'duplicate criterion',
      (r) => ({ ...r, criteria: [...r.criteria, r.criteria[0]] }),
    ],
    [
      'foreign criterion',
      (r) => ({
        ...r,
        criteria: [{ ...r.criteria[0], criterion: 'foreign' }, r.criteria[1]],
      }),
    ],
    [
      'unsatisfied criterion',
      (r) => ({
        ...r,
        criteria: r.criteria.map((c) => ({ ...c, satisfied: false })),
      }),
    ],
    ['missing issue', (r) => ({ ...r, issues: [] })],
    ['duplicate issue', (r) => ({ ...r, issues: [...r.issues, r.issues[0]] })],
    [
      'foreign issue',
      (r) => ({
        ...r,
        issues: r.issues.map((i) => ({ ...i, issueId: 'foreign' })),
      }),
    ],
    [
      'blocking issue',
      (r) => ({
        ...r,
        issues: r.issues.map((i) => ({ ...i, disposition: 'blocking' })),
      }),
    ],
    [
      'settled question',
      (r) => ({
        ...r,
        issues: r.issues.map((i) => ({ ...i, disposition: 'resolved' })),
      }),
    ],
    [
      'empty reason',
      (r) => ({
        ...r,
        criteria: r.criteria.map((c) => ({ ...c, reason: ' ' })),
      }),
    ],
    ['oversize', (r) => ({ ...r, reason: 'x'.repeat(256 * 1024) })],
    ['null', () => null],
  ];
  for (const [name, mutate] of variants)
    await t.test(name, async () => {
      const { input } = await fixture();
      const result = await createLocalPlanDraft({
        ...input,
        reviewer: {
          ...input.reviewer,
          review: async (r) => mutate(await approve(r)) as DraftReview,
        },
      });
      assert.equal(result.status, 'BLOCKED', result.summary);
      await absent(input.destination);
      assert.equal(
        (await files(input)).filter((f) => f.endsWith('-prepared.json')).length,
        0,
      );
    });
  const { input } = await fixture();
  const result = await createLocalPlanDraft({
    ...input,
    reviewer: {
      ...input.reviewer,
      review: async () => {
        throw new Error('Reader unavailable');
      },
    },
  });
  assert.equal(result.status, 'BLOCKED');
  assert.match(result.summary, /Reader unavailable/);
  await absent(input.destination);
});

test('authority, independence and unsupported workflow obligations block before effects', async (t) => {
  const variants: [string, (i: LocalPlanDraftInput) => LocalPlanDraftInput][] =
    [
      [
        'authority hash',
        (i) => ({
          ...i,
          authority: { ...i.authority, sha256: '0'.repeat(64) },
        }),
      ],
      [
        'authority reference',
        (i) => ({ ...i, task: { ...i.task, authorityRef: 'source approval' } }),
      ],
      [
        'destination',
        (i) => ({ ...i, destination: join(i.task.directory, 'other.md') }),
      ],
      [
        'verification command',
        (i) => ({
          ...i,
          brief: { ...i.brief, verificationCommand: 'touch forbidden' },
        }),
      ],
      [
        'same writer/reviewer',
        (i) => ({ ...i, reviewer: { ...i.reviewer, id: i.writer.id } }),
      ],
    ];
  for (const [name, edit] of variants)
    await t.test(name, async () => {
      const { input } = await fixture();
      assert.equal((await createLocalPlanDraft(edit(input))).status, 'BLOCKED');
      await absent(input.destination);
    });
});

test('failed reassessment blocks even with usable retained findings; missing assessment also blocks', async () => {
  const { input, investigationOptions } = await fixture();
  const brief = {
    ...input.brief,
    context: 'New assessment context; same authority and sources.',
  };
  const failed = await investigateDesignUpdate({
    ...investigationOptions,
    brief,
    resumeFrom: input.investigationResult.evidencePaths[1],
    assess: async () => {
      throw new Error('Current reader failed');
    },
  });
  const checkpoint = await loadInvestigation(failed.evidencePaths[1]);
  assert(checkpoint.assessment);
  assert(
    checkpoint.findingValidity.every(
      (f) => f.state === 'needs-semantic-review',
    ),
  );
  assert(checkpoint.gaps.some((g) => g.subject === 'assessment'));
  const result = await createLocalPlanDraft({
    ...input,
    brief,
    investigationResult: failed,
  });
  assert.equal(result.status, 'BLOCKED');
  assert.match(result.summary, /Assessment failed/);
  assert(result.evidencePaths.includes(failed.evidencePaths[1]));
  await absent(input.destination);
  const missing = await investigateDesignUpdate({
    ...investigationOptions,
    assess: async () => {
      throw new Error('No assessment');
    },
  });
  const absentAssessment = await createLocalPlanDraft({
    ...input,
    investigationResult: missing,
  });
  assert.equal(absentAssessment.status, 'BLOCKED');
  assert.match(absentAssessment.summary, /Missing assessment/);
});

test('stale or malformed evidence checks block both before and after publication', async (t) => {
  for (const phase of ['before', 'after', 'malformed'] as const)
    await t.test(phase, async () => {
      const { input, contents } = await fixture();
      if (phase === 'before') contents.set('plan.txt', 'Changed required plan');
      const provider = {
        ...input.provider,
        revalidate: async (
          e: Parameters<LocalPlanDraftInput['provider']['revalidate']>[0],
        ) => {
          if (
            phase === 'after' &&
            (await lstat(input.destination).catch(() => null))
          )
            contents.set('plan.txt', 'Changed after creation');
          const check = await input.provider.revalidate(e);
          return phase === 'malformed'
            ? { ...check, evidenceId: 'foreign' }
            : check;
        },
      };
      const result = await createLocalPlanDraft({ ...input, provider });
      assert.equal(result.status, 'BLOCKED', result.summary);
      if (phase === 'after') {
        assert(result.evidencePaths.includes(input.destination));
        assert(
          (await readFile(input.destination, 'utf8')).includes(
            'Proposed implementation plan',
          ),
        );
      } else await absent(input.destination);
      assert.equal(
        (await files(input)).filter((f) => f.endsWith('-completed.json'))
          .length,
        0,
      );
    });
});

test('unprepared output, symlink and directory are never adopted or overwritten', async (t) => {
  for (const kind of ['file', 'symlink', 'directory'] as const)
    await t.test(kind, async () => {
      const { input } = await fixture();
      if (kind === 'file') await writeFile(input.destination, 'existing bytes');
      if (kind === 'directory') await mkdir(input.destination);
      if (kind === 'symlink')
        await symlink(input.authority.path, input.destination);
      const inode = (await lstat(input.destination)).ino;
      const result = await createLocalPlanDraft(input);
      assert.equal(result.status, 'BLOCKED');
      assert.equal((await lstat(input.destination)).ino, inode);
      assert(result.evidencePaths.includes(input.destination));
      if (kind === 'file')
        assert.equal(
          await readFile(input.destination, 'utf8'),
          'existing bytes',
        );
    });
});

test('recorded completion never conceals deletion, changed bytes or a symlink', async (t) => {
  for (const change of ['delete', 'conflict', 'symlink'] as const)
    await t.test(change, async () => {
      const { input } = await fixture();
      assert.equal((await createLocalPlanDraft(input)).status, 'PASS');
      await unlink(input.destination);
      if (change === 'conflict')
        await writeFile(input.destination, 'preserve conflict');
      if (change === 'symlink')
        await symlink(input.authority.path, input.destination);
      const result = await createLocalPlanDraft(input);
      assert.equal(result.status, 'BLOCKED');
      if (change === 'delete') {
        assert.match(result.summary, /Completed output is missing/);
        await absent(input.destination);
        assert(!result.evidencePaths.includes(input.destination));
      }
      if (change === 'conflict')
        assert.equal(
          await readFile(input.destination, 'utf8'),
          'preserve conflict',
        );
      if (change === 'symlink')
        assert((await lstat(input.destination)).isSymbolicLink());
    });
});

test('preparation pins proposal, writer, reviewer, title and actual result across retries', async (t) => {
  const edits: [string, (i: LocalPlanDraftInput) => LocalPlanDraftInput][] = [
    [
      'proposal',
      (i) => ({
        ...i,
        proposal: {
          ...i.proposal,
          proposedSteps: i.proposal.proposedSteps.map((s) => ({
            ...s,
            text: 'Different proposed work',
          })),
        },
      }),
    ],
    ['writer', (i) => ({ ...i, writer: { ...i.writer, revision: 'v2' } })],
    [
      'reviewer',
      (i) => ({ ...i, reviewer: { ...i.reviewer, revision: 'v2' } }),
    ],
    ['title', (i) => ({ ...i, title: 'Different title' })],
    [
      'result',
      (i) => ({
        ...i,
        investigationResult: {
          ...i.investigationResult,
          summary: 'Different result identity',
        },
      }),
    ],
  ];
  for (const [name, edit] of edits)
    await t.test(name, async () => {
      const { input } = await fixture();
      assert.equal((await createLocalPlanDraft(input)).status, 'PASS');
      const bytes = await readFile(input.destination);
      const result = await createLocalPlanDraft(edit(input));
      assert.equal(result.status, 'BLOCKED');
      assert.match(result.summary, /Preparation is pinned/);
      assert.deepEqual(await readFile(input.destination), bytes);
    });
});

test('malformed or tampered persisted preparation, completion and checkpoint cannot claim PASS', async (t) => {
  for (const record of ['preparation', 'completion', 'checkpoint'] as const)
    await t.test(record, async () => {
      const { input } = await fixture();
      assert.equal((await createLocalPlanDraft(input)).status, 'PASS');
      const paths = await files(input);
      const path =
        record === 'checkpoint'
          ? input.investigationResult.evidencePaths[1]
          : join(
              input.task.directory,
              paths.find((p) =>
                p.endsWith(
                  record === 'preparation'
                    ? '-prepared.json'
                    : '-completed.json',
                ),
              )!,
            );
      if (record === 'preparation') {
        const value = JSON.parse(await readFile(path, 'utf8'));
        value.review.criteria = [];
        await writeFile(path, JSON.stringify(value));
      } else await writeFile(path, '{}');
      const result = await createLocalPlanDraft(input);
      assert.equal(result.status, 'BLOCKED', result.summary);
      assert(result.evidencePaths.includes(input.destination));
    });
});

test('fresh processes reconcile crash after link before receipt with the pinned review', async () => {
  const { input, contents } = await fixture();
  const manifest = join(input.task.directory, 'recovery-input.json');
  await writeFile(manifest, JSON.stringify({ input, contents: [...contents] }));
  const child = fileURLToPath(
    new URL('../support/recovery-child.ts', import.meta.url),
  );
  const args = ['--import', '@swc-node/register/esm-register', child];
  await assert.rejects(
    promisify(execFile)(process.execPath, [...args, 'crash', manifest]),
    (error: unknown) =>
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 73,
  );
  const bytes = await readFile(input.destination);
  assert.equal(
    (await files(input)).filter((f) => f.endsWith('-completed.json')).length,
    0,
  );
  assert.equal(
    (await files(input)).filter((f) => f.endsWith('-prepared.json')).length,
    1,
  );
  const { stdout } = await promisify(execFile)(process.execPath, [
    ...args,
    'recover',
    manifest,
  ]);
  const result = JSON.parse(stdout) as WorkerResult;
  assert.equal(result.status, 'PASS', result.summary);
  assert.deepEqual(await readFile(input.destination), bytes);
  assert.equal(
    (await files(input)).filter((f) => f.endsWith('-completed.json')).length,
    1,
  );
});

test('fresh processes refuse invalidated completion without repeating the draft effect', async (t) => {
  const cases = [
    {
      change: 'deleted completed output',
      stage: 'build',
      reason: /Completed output is missing; automatic recreation is refused/,
    },
    {
      change: 'changed writer revision',
      stage: 'plan',
      reason: /Preparation is pinned to different inputs/,
    },
    {
      change: 'changed source content',
      stage: 'build',
      reason: /before publication evidence .*: changed: Test map observation/,
    },
  ] as const;
  for (const { change, stage, reason } of cases)
    await t.test(change, async () => {
      const { input, contents } = await fixture();
      const manifest = join(input.task.directory, 'refusal-input.json');
      const child = fileURLToPath(
        new URL('../support/recovery-child.ts', import.meta.url),
      );
      const invoke = async (mode: 'publish' | 'recover') => {
        const { stdout } = await promisify(execFile)(
          process.execPath,
          [
            '--import',
            '@swc-node/register/esm-register',
            child,
            mode,
            manifest,
          ],
          { timeout: 20_000 },
        );
        return JSON.parse(stdout) as WorkerResult & {
          processId: number;
          reviewCalls: number;
        };
      };
      await writeFile(
        manifest,
        JSON.stringify({ input, contents: [...contents] }),
        { flag: 'wx' },
      );
      const first = await invoke('publish');
      assert.equal(first.status, 'PASS', first.summary);
      assert.equal(first.reviewCalls, 1);
      assert.notEqual(first.processId, process.pid);
      const bytes = await readFile(input.destination);
      assert.match(bytes.toString('utf8'), /^Proposed implementation plan\./m);
      const inode = (await lstat(input.destination)).ino;
      const firstObservation = await receipt(first);
      assert.equal(firstObservation.kind, 'completed');
      assert.equal(firstObservation.output.kind, 'matching');
      const records = (await files(input)).filter(
        (path) =>
          path.endsWith('-prepared.json') || path.endsWith('-completed.json'),
      );
      assert.equal(
        records.filter((path) => path.endsWith('-prepared.json')).length,
        1,
      );
      assert.equal(
        records.filter((path) => path.endsWith('-completed.json')).length,
        1,
      );
      const retained = await Promise.all(
        first.evidencePaths.map(async (path) => ({
          path,
          bytes: await readFile(path),
        })),
      );

      if (change === 'deleted completed output')
        await unlink(input.destination);
      const retryInput =
        change === 'changed writer revision'
          ? { ...input, writer: { ...input.writer, revision: 'proposal-v2' } }
          : input;
      if (change === 'changed source content')
        contents.set(
          'plan.txt',
          'Changed required plan after recorded completion.',
        );
      await writeFile(
        manifest,
        JSON.stringify({ input: retryInput, contents: [...contents] }),
      );

      const retry = await invoke('recover');
      assert.notEqual(retry.processId, process.pid);
      assert.notEqual(retry.processId, first.processId);
      assert.equal(retry.status, 'BLOCKED', retry.summary);
      assert.match(retry.summary, reason);
      assert.equal(retry.reviewCalls, 0);
      const observation = await receipt(retry);
      assert.equal(observation.kind, 'blocked');
      assert.equal(observation.stage, stage);
      assert.equal(
        observation.output.kind,
        change === 'deleted completed output' ? 'absent' : 'matching',
      );
      if (change === 'deleted completed output') {
        await assert.rejects(readFile(input.destination), { code: 'ENOENT' });
        assert.equal(retry.evidencePaths.includes(input.destination), false);
      } else {
        assert.deepEqual(await readFile(input.destination), bytes);
        assert.equal((await lstat(input.destination)).ino, inode);
        assert.equal(retry.evidencePaths.includes(input.destination), true);
      }
      if (change === 'changed source content') {
        assert.equal(observation.checks.at(-1).phase, 'before');
        assert.equal(observation.checks.at(-1).check.state, 'changed');
      }
      assert.deepEqual(
        (await files(input)).filter(
          (path) =>
            path.endsWith('-prepared.json') || path.endsWith('-completed.json'),
        ),
        records,
      );
      assert.deepEqual(
        (await files(input)).filter((path) => path.endsWith('.md')),
        change === 'deleted completed output' ? [] : ['draft.md'],
      );
      for (const artifact of retained) {
        if (
          change === 'deleted completed output' &&
          artifact.path === input.destination
        )
          continue;
        assert.deepEqual(await readFile(artifact.path), artifact.bytes);
      }
    });
});

test('cooperating concurrent calls converge to one preparation and one output', async () => {
  const { input } = await fixture();
  const results = await Promise.all([
    createLocalPlanDraft(input),
    createLocalPlanDraft(input),
  ]);
  assert(
    results.every((r) => r.status === 'PASS'),
    results.map((r) => r.summary).join('\n'),
  );
  assert.equal(
    (await files(input)).filter((f) => f.endsWith('-prepared.json')).length,
    1,
  );
  assert.equal(
    (await files(input)).filter((f) => f.endsWith('-completed.json')).length,
    1,
  );
});

test('authority or checkpoint drift during review prevents publication and reports only surviving artifacts', async (t) => {
  for (const target of ['authority', 'checkpoint'] as const)
    await t.test(target, async () => {
      const { input } = await fixture();
      const path =
        target === 'authority'
          ? input.authority.path
          : input.investigationResult.evidencePaths[0];
      const result = await createLocalPlanDraft({
        ...input,
        reviewer: {
          ...input.reviewer,
          review: async (r) => {
            await unlink(path);
            return approve(r);
          },
        },
      });
      assert.equal(result.status, 'BLOCKED');
      await absent(input.destination);
      assert(!result.evidencePaths.includes(path));
      for (const artifact of result.evidencePaths)
        assert(await lstat(artifact));
    });
});
