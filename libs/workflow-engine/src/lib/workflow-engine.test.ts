import assert from 'node:assert/strict';
import test from 'node:test';

import {
  expandedPlan,
  minimalPlan,
  parallelPlan,
  reconcilePlan,
  type WorkerAssignment,
} from '@temari/contracts';

import {
  CapabilityError,
  joinParallelWorkers,
  runPlan,
  runParallelWorkers,
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

test('derives parallelism as an explicit plan capability', () => {
  const plan = parallelPlan('feature', 3);

  assert.deepEqual(plan.parallelism, { maxConcurrency: 3 });
  assert.deepEqual(plan.requiredCapabilities, [
    'subagents',
    'parallelism',
    'forge',
  ]);
});

test('runs the canonical stage sequence serially', async () => {
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

test('rejects a reordered or partial serial lifecycle before invoking the handler', async () => {
  const started: string[] = [];

  await assert.rejects(
    runPlan(
      {
        ...minimalPlan('bug'),
        stages: ['investigate', 'plan', 'review', 'build', 'verify', 'deliver'],
      },
      [],
      (stage) => {
        started.push(stage);
      },
    ),
    /canonical workflow stage sequence/i,
  );

  await assert.rejects(
    runPlan({ ...minimalPlan('bug'), stages: ['investigate'] }, [], (stage) => {
      started.push(stage);
    }),
    /canonical workflow stage sequence/i,
  );

  assert.deepEqual(started, []);
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
  assert.equal(
    receipt.stages[0]?.evidencePaths[0],
    'evidence/investigate.json',
  );
  assert.equal(receipt.failure, null);
});

test('rejects a non-canonical receipt lifecycle before creating a receipt', async () => {
  await assert.rejects(
    runPlanWithReceipt({
      runId: 'non-canonical',
      revision: 'revision-non-canonical',
      plan: {
        ...minimalPlan('feature'),
        stages: ['investigate', 'plan', 'review', 'build', 'verify', 'deliver'],
      },
      capabilities: serialCapabilities(),
      handler: () => ({ status: 'PASS', summary: 'must not run' }),
    }),
    /canonical workflow stage sequence/i,
  );
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

test('resumes after a verified pass-stage checkpoint without replaying its prefix', async () => {
  const plan = minimalPlan('feature');
  const checkpoints: import('./workflow-engine.js').WorkflowCheckpoint[] = [];
  const firstCalls: string[] = [];
  const first = await runPlanWithReceipt({
    runId: 'checkpoint-1',
    revision: 'revision-checkpoint-1',
    plan,
    capabilities: serialCapabilities(),
    now: sequenceClock(),
    handler: (stage) => {
      firstCalls.push(stage);
      if (stage === 'build') throw new Error('builder interrupted');
      return { status: 'PASS', summary: `${stage} complete` };
    },
    onStageCheckpoint: (checkpoint) => {
      checkpoints.push(checkpoint);
    },
  });

  assert.equal(first.status, 'BLOCKED');
  assert.deepEqual(firstCalls, ['investigate', 'plan', 'build']);
  assert.deepEqual(
    checkpoints.at(-1)?.stages.map((stage) => stage.stage),
    ['investigate', 'plan'],
  );

  const resumedCalls: string[] = [];
  const resumed = await runPlanWithReceipt({
    runId: 'checkpoint-1',
    revision: 'revision-checkpoint-1',
    plan,
    capabilities: serialCapabilities(),
    checkpoint: checkpoints.at(-1),
    now: sequenceClock(),
    handler: (stage) => {
      resumedCalls.push(stage);
      return { status: 'PASS', summary: `${stage} complete` };
    },
  });

  assert.equal(resumed.status, 'PASS');
  assert.deepEqual(resumedCalls, ['build', 'review', 'verify', 'deliver']);
  assert.deepEqual(
    resumed.stages.map((stage) => stage.stage),
    ['investigate', 'plan', 'build', 'review', 'verify', 'deliver'],
  );
});

test('rejects a checkpoint bound to a different plan', async () => {
  const plan = minimalPlan('feature');
  const checkpoint: import('./workflow-engine.js').WorkflowCheckpoint = {
    schema: 1,
    runId: 'checkpoint-2',
    revision: 'revision-checkpoint-2',
    plan,
    capabilities: serialCapabilities(),
    startedAt: '2026-09-22T12:00:00.000Z',
    stages: [],
  };

  await assert.rejects(
    runPlanWithReceipt({
      runId: checkpoint.runId,
      revision: checkpoint.revision,
      plan: minimalPlan('bug'),
      capabilities: serialCapabilities(),
      checkpoint,
      handler: () => ({ status: 'PASS', summary: 'must not run' }),
    }),
    /checkpoint plan does not match/i,
  );
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

test('fans out independent workers within the declared concurrency bound', async () => {
  const active: string[] = [];
  let peak = 0;
  const assignments = workerAssignments(4);
  const receipt = await runParallelWorkers({
    runId: 'parallel-1',
    revision: 'revision-parallel-1',
    plan: parallelPlan('feature', 2),
    capabilities: parallelCapabilities(),
    assignments,
    handler: async (assignment) => {
      active.push(assignment.id);
      peak = Math.max(peak, active.length);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active.splice(active.indexOf(assignment.id), 1);
      return {
        status: 'PASS',
        summary: `${assignment.id} complete`,
        evidencePaths: [`evidence/${assignment.id}.json`],
        rawLogPath: null,
      };
    },
    now: sequenceClock(),
  });

  assert.equal(receipt.status, 'PASS');
  assert.equal(receipt.peakConcurrency, 2);
  assert.equal(peak, 2);
  assert.deepEqual(receipt.executionEvidence, {
    schema: 1,
    groupId: null,
    assignmentIds: assignments.map((assignment) => assignment.id),
    maxConcurrency: 2,
    peakConcurrency: 2,
  });
  assert.deepEqual(
    receipt.outcomes.map((outcome) => outcome.assignment.id),
    ['worker-1', 'worker-2', 'worker-3', 'worker-4'],
  );
});

test('joins the exact worker membership in declaration order', () => {
  const assignments = workerAssignments(3);
  const outcomes = assignments.map((assignment) => ({
    assignment,
    result: {
      status: 'PASS' as const,
      summary: `${assignment.id} complete`,
      evidencePaths: [`evidence/${assignment.id}.json`],
      rawLogPath: null,
    },
    error: null,
  }));

  const joined = joinParallelWorkers(assignments, [
    outcomes[2]!,
    outcomes[0]!,
    outcomes[1]!,
  ]);
  assert.deepEqual(
    joined.outcomes.map((outcome) => outcome.assignment.id),
    ['worker-1', 'worker-2', 'worker-3'],
  );

  assert.throws(
    () => joinParallelWorkers(assignments, outcomes.slice(0, 2)),
    /outcome count 2 does not match assignment count 3/,
  );
  const extraAssignment = {
    ...workerAssignments(1)[0]!,
    id: 'worker-extra',
  };
  assert.throws(
    () =>
      joinParallelWorkers(assignments, [
        outcomes[0]!,
        outcomes[1]!,
        { ...outcomes[2]!, assignment: extraAssignment },
      ]),
    /outcome is not declared: worker-extra/,
  );
  assert.throws(
    () =>
      joinParallelWorkers(assignments, [
        {
          ...outcomes[0]!,
          assignment: { ...assignments[0]!, required: false },
          result: { ...outcomes[0]!.result!, status: 'BLOCKED' },
        },
        outcomes[1]!,
        outcomes[2]!,
      ]),
    /assignment changed: worker-1/,
  );
  assert.throws(
    () =>
      joinParallelWorkers(assignments, [
        {
          ...outcomes[0]!,
          assignment: {
            ...assignments[0]!,
            brief: { ...assignments[0]!.brief, scope: 'different work' },
          },
        },
        outcomes[1]!,
        outcomes[2]!,
      ]),
    /assignment changed: worker-1/,
  );
});

test('degrades optional worker failures without hiding required success', () => {
  const required = workerAssignments(2);
  const assignments = [required[0]!, { ...required[1]!, required: false }];
  const joined = joinParallelWorkers(assignments, [
    {
      assignment: assignments[0]!,
      result: {
        status: 'PASS',
        summary: 'required work complete',
        evidencePaths: ['evidence/required.json'],
        rawLogPath: null,
      },
      error: null,
    },
    {
      assignment: assignments[1]!,
      result: {
        status: 'BLOCKED',
        summary: 'optional provider unavailable',
        evidencePaths: ['evidence/optional.json'],
        rawLogPath: null,
      },
      error: null,
    },
  ]);

  assert.equal(joined.status, 'PASS');
  assert.equal(joined.failure, null);
  assert.deepEqual(joined.degradations, [
    {
      workerId: 'worker-2',
      status: 'BLOCKED',
      message: 'optional provider unavailable',
    },
  ]);
});

test('blocks parallel workers before execution when the host lacks parallelism', async () => {
  let invoked = false;
  const receipt = await runParallelWorkers({
    runId: 'parallel-2',
    revision: 'revision-parallel-2',
    plan: parallelPlan('feature', 2),
    capabilities: serialCapabilities(),
    assignments: workerAssignments(2),
    handler: () => {
      invoked = true;
      return {
        status: 'PASS',
        summary: 'unexpected',
        evidencePaths: ['evidence/unexpected.json'],
        rawLogPath: null,
      };
    },
    now: sequenceClock(),
  });

  assert.equal(receipt.status, 'BLOCKED');
  assert.equal(invoked, false);
  assert.deepEqual(receipt.failure?.missingCapabilities, [
    'subagents',
    'parallelism',
    'forge',
  ]);
});

test('joins worker issues and preserves handler failures as outcomes', async () => {
  const receipt = await runParallelWorkers({
    runId: 'parallel-3',
    revision: 'revision-parallel-3',
    plan: parallelPlan('feature', 2),
    capabilities: parallelCapabilities(),
    assignments: workerAssignments(3),
    handler: (assignment) => {
      if (assignment.id === 'worker-2') throw new Error('worker interrupted');
      return {
        status: assignment.id === 'worker-3' ? 'ISSUES' : 'PASS',
        summary: assignment.id === 'worker-3' ? 'needs review' : 'complete',
        evidencePaths: [`evidence/${assignment.id}.json`],
        rawLogPath: null,
      } as const;
    },
    now: sequenceClock(),
  });

  assert.equal(receipt.status, 'BLOCKED');
  assert.equal(receipt.failure?.kind, 'worker-error');
  assert.equal(receipt.failure?.workerId, 'worker-2');
  assert.equal(receipt.outcomes[1]?.error, 'worker interrupted');
  assert.equal(receipt.outcomes[2]?.result?.status, 'ISSUES');
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

function parallelCapabilities() {
  return {
    host: 'cursor',
    available: [
      'subagents',
      'parallelism',
      'model_diversity',
      'worktree_isolation',
      'durable_delivery',
      'forge',
    ] as const,
    missing: [] as const,
    notes: {},
  };
}

function workerAssignments(count: number): WorkerAssignment[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `worker-${index + 1}`,
    role: 'investigator' as const,
    required: true,
    brief: {
      goal: `Inspect work item ${index + 1}`,
      context: 'The coordinator supplied bounded context.',
      scope: `Work item ${index + 1} only`,
      acceptanceCriteria: ['Return retained evidence.'],
      verificationCommand: null,
      reportFormat: 'json' as const,
      forbiddenActions: ['Do not modify shared state.'],
    },
  }));
}
