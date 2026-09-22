import assert from 'node:assert/strict';
import test from 'node:test';

import { expandedPlan, minimalPlan, reconcilePlan } from '@temari/contracts';

import {
  CapabilityError,
  runPlan,
  runPlanWithReceipt,
} from './workflow-engine.js';

test('reconciles serial obligations without host requirements', () => {
  const plan = reconcilePlan({ workType: 'feature' });

  assert.equal(plan.delegation, 'none');
  assert.equal(plan.review, 'self');
  assert.equal(plan.evidence, 'minimal');
  assert.equal(plan.delivery, 'local');
  assert.deepEqual(plan.requiredCapabilities, []);
});

test('derives capabilities from stronger obligations', () => {
  const plan = reconcilePlan({
    workType: 'feature',
    delegation: 'required',
    review: 'independent',
    evidence: 'revision-bound',
    delivery: 'pull-request',
  });

  assert.deepEqual(plan.requiredCapabilities, ['subagents', 'forge']);
});

test('runs the same declared stage sequence serially', async () => {
  const stages: string[] = [];
  const plan = minimalPlan('bug');

  await runPlan(plan, [], (stage) => {
    stages.push(stage);
  });

  assert.deepEqual(stages, [
    'investigate',
    'plan',
    'build',
    'review',
    'verify',
    'deliver',
  ]);
});

test('stops before execution when required capabilities are absent', async () => {
  const started: string[] = [];

  await assert.rejects(
    runPlan(expandedPlan('feature'), [], (stage) => {
      started.push(stage);
    }),
    (error: unknown) => {
      assert.ok(error instanceof CapabilityError);
      assert.deepEqual(error.gap.missing, ['subagents', 'forge']);
      return true;
    },
  );

  assert.deepEqual(started, []);
});

test('returns a revision-bound receipt for a completed serial run', async () => {
  const receipt = await runPlanWithReceipt({
    runId: 'run-1',
    revision: 'revision-1',
    plan: minimalPlan('feature'),
    capabilities: serialCapabilities(),
    now: sequenceClock(),
    handler: (stage) => ({
      status: 'PASS',
      summary: `${stage} complete`,
      evidencePaths: [`evidence/${stage}.json`],
    }),
  });

  assert.equal(receipt.status, 'PASS');
  assert.equal(receipt.runId, 'run-1');
  assert.equal(receipt.revision, 'revision-1');
  assert.equal(receipt.stages.length, 6);
  assert.equal(receipt.stages[0]?.evidencePaths[0], 'evidence/investigate.json');
  assert.equal(receipt.failure, null);
});

test('returns a blocked receipt without invoking stages for a capability gap', async () => {
  let invoked = false;
  const receipt = await runPlanWithReceipt({
    runId: 'run-2',
    revision: 'revision-2',
    plan: expandedPlan('feature'),
    capabilities: serialCapabilities(),
    now: sequenceClock(),
    handler: () => {
      invoked = true;
      return { status: 'PASS', summary: 'unexpected' };
    },
  });

  assert.equal(receipt.status, 'BLOCKED');
  assert.equal(invoked, false);
  assert.deepEqual(receipt.failure?.missingCapabilities, [
    'subagents',
    'forge',
  ]);
});

test('stops at a non-pass stage and preserves its evidence', async () => {
  const receipt = await runPlanWithReceipt({
    runId: 'run-3',
    revision: 'revision-3',
    plan: minimalPlan('bug'),
    capabilities: serialCapabilities(),
    now: sequenceClock(),
    handler: (stage) => ({
      status: stage === 'verify' ? 'ISSUES' : 'PASS',
      summary: stage === 'verify' ? 'verification needs review' : 'complete',
      evidencePaths: [`evidence/${stage}.txt`],
    }),
  });

  assert.equal(receipt.status, 'ISSUES');
  assert.deepEqual(
    receipt.stages.map((stage) => stage.stage),
    ['investigate', 'plan', 'build', 'review', 'verify'],
  );
  assert.equal(receipt.stages.at(-1)?.evidencePaths[0], 'evidence/verify.txt');
});

test('converts handler failures into a blocked receipt', async () => {
  const receipt = await runPlanWithReceipt({
    runId: 'run-4',
    revision: 'revision-4',
    plan: minimalPlan('bug'),
    capabilities: serialCapabilities(),
    now: sequenceClock(),
    handler: (stage) => {
      if (stage === 'build') throw new Error('build interrupted');
      return { status: 'PASS', summary: 'complete' };
    },
  });

  assert.equal(receipt.status, 'BLOCKED');
  assert.equal(receipt.failure?.kind, 'stage-handler-error');
  assert.equal(receipt.failure?.stage, 'build');
  assert.equal(receipt.stages.at(-1)?.status, 'BLOCKED');
});

function sequenceClock(): () => Date {
  let count = 0;
  const start = new Date('2026-09-22T12:00:00.000Z').getTime();
  return () => new Date(start + count++ * 1000);
}

function serialCapabilities() {
  return {
    host: 'generic',
    available: [],
    missing: [
      'subagents',
      'parallelism',
      'model_diversity',
      'worktree_isolation',
      'durable_delivery',
      'forge',
    ] as const,
    notes: {},
  };
}
