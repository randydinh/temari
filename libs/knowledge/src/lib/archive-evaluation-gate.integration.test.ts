import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { actualFixture } from '../support/fixtures.js';
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
