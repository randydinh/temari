import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { actualFixture } from '../support/fixtures.js';
import { prepareRegistrar } from '../support/prepare.js';
import { runArchiveIntake } from './archive-journey.js';
import { discoveryCompleteAtK, representationCoverage, retrievalGateStatus, runRetrievalGate, type RetrievalGatePlan } from './archive-evaluation-gate.js';
import { hash } from './codec.js';
import { loadRetrieval } from './retrieval.js';

test('ACTUAL CLI: sealed gate separates absent text coverage from exact/BM25 ranking', async () => {
  const f = await actualFixture();
  const task = {
    id: 'sealed-gate-fixture', directory: join(f.base, 'task'),
    authorityRef: 'synthetic-local-admission',
  };
  const intake = await runArchiveIntake({
    task,
    intakes: [{
      task, source: f.source, readScope: 'source-root', requestKey: 'gate-v1',
      transport: {
        python: f.config.python,
        registrarSource: f.config.registrarSource,
        workspace: join(f.base, 'state'),
      },
    }],
  });
  assert.equal(intake.status, 'published');
  const plan: RetrievalGatePlan = {
    schema: 1, handoffPath: intake.handoffPath!, topK: 2,
    cohorts: {
      development: [{
        id: 'known-text', query: 'Proposal plan', sourceIds: [f.source.id],
        expected: [{ sourceId: f.source.id, path: 'plan.txt' }],
      }],
      holdout: [{
        id: 'absent-text', query: 'Unindexed target', sourceIds: [f.source.id],
        expected: [{ sourceId: f.source.id, path: 'missing.txt' }],
      }],
    },
  };
  const planPath = join(f.base, 'sealed-questions.json');
  const bytes = Buffer.from(JSON.stringify(plan));
  await writeFile(planPath, bytes, { flag: 'wx' });
  await assert.rejects(() => runRetrievalGate(planPath, hash('different-plan')),
    /Question set pin changed/);
  let keyLookups = 0, hostedCalls = 0;
  const { receipt, receiptPath } = await runRetrievalGate(planPath, hash(bytes), {
    keyResolver: async () => { keyLookups++; return 'test-key'; },
    fetcher: async () => { hostedCalls++; throw new Error('Hosted call from sealed gate'); },
  });
  assert.equal(keyLookups, 0);
  assert.equal(hostedCalls, 0);
  assert.equal(receipt.status, 'coverage-blocked');
  assert.equal(receipt.cohorts.development.indexedGold, 1);
  assert.equal(receipt.cohorts.holdout.indexedGold, 0);
  assert.deepEqual(receipt.cohorts.holdout.coverageGapCaseIds, ['absent-text']);
  assert.equal(receipt.cohorts.holdout.coverageReasons['missing-from-capture'], 1);
  const raw = await readFile(receiptPath, 'utf8');
  assert(!raw.includes('Proposal plan'));
  assert(!raw.includes('missing.txt'));
  for (const cohort of Object.values(receipt.cohorts)) {
    for (const path of Object.values(cohort.reportPaths)) {
      const report = JSON.parse(await readFile(path, 'utf8'));
      assert(report.cases.every((item: { jevSharing: string }) =>
        item.jevSharing === 'case-opt-out'));
      assert(report.cases.every((item: { jev: { judgments: { gap: string }[] } | null }) =>
        item.jev === null || item.jev.judgments.every((judgment) =>
          judgment.gap === 'case-opt-out')));
      for (const item of report.cases) {
        const checkpoint = await loadRetrieval(item.discoveryCheckpointPath);
        if (item.id === 'known-text') {
          assert(discoveryCompleteAtK(checkpoint, item, plan.topK));
          assert(!discoveryCompleteAtK({
            ...checkpoint, discovery: [], discoveryStarted: false,
            gaps: [{ kind: 'unknown', subject: 'provider', detail: 'failed' }],
          }, item, plan.topK));
          assert(!discoveryCompleteAtK({
            ...checkpoint, gaps: [
              ...checkpoint.gaps,
              { kind: 'pending', subject: 'response-budget', detail: 'page rejected' },
            ],
          }, item, plan.topK));
        }
      }
    }
  }

  const overlap = {
    ...plan,
    cohorts: {
      ...plan.cohorts,
      holdout: [{
        id: 'different-wording', query: 'Completely different words',
        sourceIds: [f.source.id],
        expected: [{ sourceId: f.source.id, path: 'plan.txt' }],
      }],
    },
  };
  const overlapPath = join(f.base, 'overlap-questions.json');
  const overlapBytes = Buffer.from(JSON.stringify(overlap));
  await writeFile(overlapPath, overlapBytes, { flag: 'wx' });
  await assert.rejects(() => runRetrievalGate(overlapPath, hash(overlapBytes)),
    /Gold target repeated across questions/);

  const repeatedQuery = {
    ...plan,
    cohorts: {
      ...plan.cohorts,
      holdout: [{
        id: 'same-question-other-gold', query: '  PROPOSAL   plan ',
        sourceIds: [f.source.id],
        expected: [{ sourceId: f.source.id, path: 'missing.txt' }],
      }],
    },
  };
  const repeatedPath = join(f.base, 'repeated-query.json');
  const repeatedBytes = Buffer.from(JSON.stringify(repeatedQuery));
  await writeFile(repeatedPath, repeatedBytes, { flag: 'wx' });
  await assert.rejects(() => runRetrievalGate(repeatedPath, hash(repeatedBytes)),
    /Question repeated across cohorts/);
});

test('ACTUAL CLI: ten sealed questions measure indexed exact/BM25 retrieval on distinct development and holdout gold', async () => {
  const registrarSource = process.env['TEMARI_REGISTRAR_SOURCE'];
  const python = process.env['TEMARI_REGISTRAR_PYTHON'];
  assert(registrarSource && python);
  const records = [
    [
      'z-dev-pressure.txt',
      'QX7314 pressure cutoff. QX7314 pressure cutoff is the approved setting.',
    ],
    [
      'z-dev-coolant.txt',
      'K7M042 coolant purge. K7M042 coolant purge remains scheduled.',
    ],
    [
      'z-dev-handoff.txt',
      'Release handoff transfers custody to the registrar.',
    ],
    ['z-dev-cap.txt', 'Current cap decision retains the seven unit ceiling.'],
    [
      'z-dev-replay.txt',
      'VR9281 replay token protects an intake restart. VR9281 replay token.',
    ],
    [
      'z-holdout-seal.txt',
      'HN5268 seal check is required before retrieval. HN5268 seal check.',
    ],
    ['z-holdout-queue.txt', 'PY4017 queue drain records the final offset.'],
    [
      'z-holdout-review.txt',
      'Reviewer signoff completes the approval transfer.',
    ],
    [
      'z-holdout-window.txt',
      'Current window closes after the audit checkpoint.',
    ],
    [
      'z-holdout-ledger.txt',
      'LK8832 ledger checksum detects stale records. LK8832 ledger checksum.',
    ],
    // These earlier paths crowd exact discovery for two rare-ID questions.
    [
      'a-dev-replay-copy-a.txt',
      'VR9281 is mentioned in a duplicate intake note.',
    ],
    [
      'a-dev-replay-copy-b.txt',
      'VR9281 is mentioned in another duplicate intake note.',
    ],
    ['a-holdout-seal-copy-a.txt', 'HN5268 appears in an obsolete seal note.'],
    [
      'a-holdout-seal-copy-b.txt',
      'HN5268 appears in a second obsolete seal note.',
    ],
    // Contrary evidence remains searchable; the current decision has distinct wording.
    [
      'a-contrary-cap.txt',
      'Old draft: remove the cap. Superseded by the current decision.',
    ],
    [
      'a-contrary-window.txt',
      'Old draft: extend the window. Superseded by the current checkpoint.',
    ],
  ] as const;
  const f = await prepareRegistrar({
    registrarSource,
    python,
    documents: records.map(([path, body]) => ({
      path,
      bytes: Buffer.from(body),
    })),
  });
  const task = {
    id: 'sealed-ten-question-fixture',
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
        requestKey: 'ten-question-gate-v1',
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
  const question = (id: string, query: string, path: string) => ({
    id,
    query,
    sourceIds: [f.source.id],
    expected: [{ sourceId: f.source.id, path }],
  });
  // This frozen question file is outside the registered source root. The
  // fixture measures lexical retrieval only: it has no no-answer or image-only
  // questions and cannot establish semantic or production recall.
  const plan: RetrievalGatePlan = {
    schema: 1,
    handoffPath: intake.handoffPath,
    topK: 2,
    cohorts: {
      development: [
        question(
          'dev-pressure',
          'QX7314 pressure cutoff',
          'z-dev-pressure.txt',
        ),
        question('dev-coolant', 'K7M042 coolant purge', 'z-dev-coolant.txt'),
        question('dev-handoff', 'custody reassignment', 'z-dev-handoff.txt'),
        question('dev-cap', 'current cap ceiling', 'z-dev-cap.txt'),
        question('dev-replay', 'VR9281 replay token', 'z-dev-replay.txt'),
      ],
      holdout: [
        question('holdout-seal', 'HN5268 seal check', 'z-holdout-seal.txt'),
        question('holdout-queue', 'PY4017 queue drain', 'z-holdout-queue.txt'),
        question(
          'holdout-review',
          'approval endorsement',
          'z-holdout-review.txt',
        ),
        question(
          'holdout-window',
          'current window checkpoint',
          'z-holdout-window.txt',
        ),
        question(
          'holdout-ledger',
          'LK8832 ledger checksum',
          'z-holdout-ledger.txt',
        ),
      ],
    },
  };
  const planPath = join(f.base, 'frozen-gold-outside-source-root.json');
  assert(!planPath.startsWith(join(f.base, 'sources') + '/'));
  const planBytes = Buffer.from(JSON.stringify(plan));
  await writeFile(planPath, planBytes, { flag: 'wx' });
  const allQuestions = [...plan.cohorts.development, ...plan.cohorts.holdout];
  assert.equal(new Set(allQuestions.map((item) => item.query)).size, 10);
  assert.equal(
    new Set(allQuestions.map((item) => item.expected[0].path)).size,
    10,
  );
  let keyLookups = 0,
    hostedCalls = 0;
  const { receipt, receiptPath } = await runRetrievalGate(
    planPath,
    hash(planBytes),
    {
      keyResolver: async () => {
        keyLookups++;
        return 'unused';
      },
      fetcher: async () => {
        hostedCalls++;
        throw new Error('Hosted call from sealed gate');
      },
    },
  );
  assert.equal(keyLookups, 0);
  assert.equal(hostedCalls, 0);
  assert.equal(receipt.topK, 2);
  for (const cohort of Object.values(receipt.cohorts)) {
    assert.equal(cohort.questions, 5);
    assert.equal(cohort.totalGold, 5);
    assert.equal(cohort.indexedGold, 5);
    assert.deepEqual(cohort.coverageGapCaseIds, []);
    assert.deepEqual(cohort.unverifiedCaseIds, []);
    for (const reportPath of Object.values(cohort.reportPaths)) {
      const report = JSON.parse(await readFile(reportPath, 'utf8'));
      assert.equal(report.cases.length, 5);
      assert(
        report.cases.every(
          (item: { shortlistVerified: boolean; jevSharing: string }) =>
            item.shortlistVerified && item.jevSharing === 'case-opt-out',
        ),
      );
    }
  }
  assert.equal(receipt.status, 'promotion-eligible');
  assert.equal(receipt.cohorts.development.exactHits, 3);
  assert.equal(receipt.cohorts.development.bm25Hits, 5);
  assert.equal(receipt.cohorts.holdout.exactHits, 3);
  assert.equal(receipt.cohorts.holdout.bm25Hits, 5);
  assert.deepEqual(receipt.cohorts.development.improvedCaseIds, [
    'dev-cap',
    'dev-replay',
  ]);
  assert.deepEqual(receipt.cohorts.holdout.improvedCaseIds, [
    'holdout-seal',
    'holdout-window',
  ]);
  assert.deepEqual(receipt.cohorts.development.regressedCaseIds, []);
  assert.deepEqual(receipt.cohorts.holdout.regressedCaseIds, []);
  for (const [name, id, exactPaths, bm25Paths] of [
    ['development', 'dev-cap',
      ['a-contrary-cap.txt', 'a-contrary-window.txt'],
      ['z-dev-cap.txt', 'a-contrary-cap.txt']],
    ['holdout', 'holdout-window',
      ['a-contrary-cap.txt', 'a-contrary-window.txt'],
      ['z-holdout-window.txt', 'a-contrary-window.txt']],
  ] as const) {
    for (const [route, expectedPaths] of [
      ['exact', exactPaths], ['bm25', bm25Paths],
    ] as const) {
      const report = JSON.parse(await readFile(receipt.cohorts[name].reportPaths[route], 'utf8'));
      const result = report.cases.find((item: { id: string }) => item.id === id);
      assert(result);
      assert.deepEqual(result.ranked.map((item: { path: string }) => item.path),
        expectedPaths);
    }
  }
  const rawReceipt = await readFile(receiptPath, 'utf8');
  assert(!rawReceipt.includes('QX7314 pressure cutoff'));
  assert(!rawReceipt.includes('z-dev-pressure.txt'));
});

test('gate policy gives coverage and sample gates priority and rejects regressions', () => {
  const valid = {
    questions: 5, indexedGold: 5, totalGold: 5,
    exactHits: 1, bm25Hits: 3,
    regressedCaseIds: [] as string[], unverifiedCaseIds: [] as string[],
  };
  const both = (development = valid, holdout = valid) => ({ development, holdout });
  assert.equal(retrievalGateStatus(both()), 'promotion-eligible');
  assert.equal(retrievalGateStatus(both(valid, { ...valid, questions: 4 })),
    'insufficient-sample');
  assert.equal(retrievalGateStatus(both(valid, { ...valid, indexedGold: 4, questions: 4 })),
    'coverage-blocked');
  assert.equal(retrievalGateStatus(both(valid, { ...valid, regressedCaseIds: ['h-1'] })),
    'rejected');
  assert.equal(retrievalGateStatus(both(valid, { ...valid, unverifiedCaseIds: ['h-2'] })),
    'rejected');
  assert.equal(retrievalGateStatus(both(valid, { ...valid, bm25Hits: 1 })),
    'rejected');
});

test('retained originals without text carry bounded extraction reasons', () => {
  assert.deepEqual(representationCoverage({
    representation: null, status: 'limited', gaps: ['empty-document'],
  }), { indexed: false, reason: 'empty-document' });
  assert.deepEqual(representationCoverage({
    representation: null, status: 'limited', gaps: ['pdf-memory-boundary-unavailable'],
  }), { indexed: false, reason: 'pdf-memory-boundary-unavailable' });
});
