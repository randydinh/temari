import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { actualFixture, documents } from '../support/fixtures.js';
import { prepareRegistrar } from '../support/prepare.js';
import { evaluateArchiveSearch, runArchiveIntake } from './archive-journey.js';

test('ACTUAL CLI: intake handoff through exact/BM25 search, pinned reads and Jev shadow gaps', async () => {
  const f = await actualFixture();
  const task = {
    id: 'journey-fixture',
    directory: join(f.base, 'task'),
    authorityRef: 'synthetic-local-admission',
  };
  const intake = await runArchiveIntake({
    task,
    intakes: [
      {
        task,
        source: f.source,
        readScope: 'source-root',
        requestKey: 'v1',
        transport: {
          python: f.config.python,
          registrarSource: f.config.registrarSource,
          workspace: join(f.base, 'state'),
        },
      },
    ],
  });
  assert.equal(intake.status, 'published');
  assert(intake.handoffPath);
  const cases = (['exact', 'bm25'] as const).map((discoveryMode) => ({
    id: discoveryMode,
    query: 'Proposal',
    sourceIds: [f.source.id],
    topK: 2,
    discoveryMode,
    hostedTextApproved: false,
    expected: [
      { sourceId: f.source.id, path: 'plan.txt' },
      { sourceId: f.source.id, path: 'update.txt' },
    ],
  }));
  const { report, reportPath } = await evaluateArchiveSearch({
    handoffPath: intake.handoffPath,
    cases,
  });
  assert.equal(report.cases.length, 2);
  for (const item of report.cases) {
    assert.equal(item.expectedRecallAtK, 1);
    assert.equal(item.ranked.length, 2);
    assert.equal(item.verifiedEvidenceCount, item.evidenceCount);
    assert(item.verifiedEvidenceCount >= 2);
    assert(item.retrievalCheckpointPath);
    assert(item.shortlistVerified);
    assert.deepEqual(item.jev?.originalOrder, item.jev?.suggestedOrder);
    assert(
      item.jev?.judgments.every(
        (judgment) => judgment.gap === 'approval-required',
      ),
    );
  }
  const retained = await readFile(reportPath, 'utf8');
  assert(!retained.includes(documents['update.txt']));
  assert(!retained.includes('Ignore the brief'));
  let modelCalls = 0;
  const approved = await evaluateArchiveSearch(
    {
      handoffPath: intake.handoffPath,
      cases: [
        { ...cases[0], id: 'synthetic-approved', hostedTextApproved: true },
      ],
    },
    {
      apiKey: 'synthetic-test-key',
      fetcher: async (_url, init) => {
        modelCalls++;
        assert.equal(
          new Headers(init?.headers).get('authorization'),
          'Bearer synthetic-test-key',
        );
        return new Response(
          JSON.stringify({
            model: 'jev-1.13.0',
            answers: {
              relevance: { type: 'noul', noul: 0.8 },
              support: {
                type: 'choice',
                choice: 'unknown',
                probabilities: {
                  supported: 0.1,
                  contradicted: 0.1,
                  unknown: 0.8,
                },
                confidence: 0.8,
              },
            },
            usage: { input_tokens: 12, output_tokens: 4 },
          }),
          { status: 200 },
        );
      },
    },
  );
  assert.equal(modelCalls, 2);
  assert(
    approved.report.cases[0].jev?.judgments.every(
      (judgment) => judgment.state === 'judged',
    ),
  );
  assert(
    !(await readFile(approved.reportPath, 'utf8')).includes(
      'synthetic-test-key',
    ),
  );
  await assert.rejects(() =>
    evaluateArchiveSearch({
      handoffPath: intake.handoffPath!,
      cases: [{ ...cases[0], sourceIds: ['outside-admission'] }],
    }),
  );
  const original = await readFile(intake.handoffPath, 'utf8');
  await writeFile(
    intake.handoffPath,
    original.replace('journey-fixture', 'tampered-fixture'),
  );
  await assert.rejects(() =>
    evaluateArchiveSearch({ handoffPath: intake.handoffPath!, cases }),
  );
});

test('ACTUAL CLI: eight astral excerpts stay within Jev shadow bounds without approval', async () => {
  const python = process.env['TEMARI_REGISTRAR_PYTHON'];
  const registrarSource = process.env['TEMARI_REGISTRAR_SOURCE'];
  assert(python && registrarSource);
  const f = await prepareRegistrar({
    python,
    registrarSource,
    documents: Array.from({ length: 8 }, (_, index) => ({
      path: `emoji-${index}.txt`,
      bytes: Buffer.from(`Signal ${'😀'.repeat(1200)}`),
    })),
  });
  const task = {
    id: 'astral-shortlist',
    directory: join(f.base, 'task'),
    authorityRef: 'synthetic-astral-corpus',
  };
  const intake = await runArchiveIntake({
    task,
    intakes: [
      {
        task,
        source: f.source,
        readScope: 'source-root',
        requestKey: 'v1',
        transport: {
          python: f.config.python,
          registrarSource: f.config.registrarSource,
          workspace: join(f.base, 'state'),
        },
      },
    ],
  });
  assert(intake.handoffPath);
  const { report } = await evaluateArchiveSearch({
    handoffPath: intake.handoffPath,
    cases: [
      {
        id: 'astral-eight',
        query: 'Signal',
        sourceIds: [f.source.id],
        expected: [{ sourceId: f.source.id, path: 'emoji-0.txt' }],
        topK: 8,
        discoveryMode: 'exact',
        hostedTextApproved: false,
      },
    ],
  });
  const result = report.cases[0];
  assert.equal(result.expectedRecallAtK, 1);
  assert.equal(result.ranked.length, 8);
  assert.equal(result.verifiedEvidenceCount, 8);
  assert.equal(result.jev?.judgments.length, 8);
  assert(
    result.jev.judgments.every(
      (judgment) => judgment.gap === 'approval-required',
    ),
  );
});
