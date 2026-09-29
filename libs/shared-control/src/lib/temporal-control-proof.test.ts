import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  minimalPlan,
  expandedPlan,
  DEFAULT_STAGES,
  type WorkflowReceipt,
} from '@temari/contracts';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';

import { createProofActivities } from './temporal-control-activity.js';
import {
  readControlPhase,
  releaseControl,
  temporalControlWorkflow,
  type TemporalControlInput,
} from './temporal-control-workflow.js';

const workflowsPath = new URL('./temporal-control-workflow.ts', import.meta.url)
  .pathname;
const taskQueue = 'temari-nx-local-control-proof';

function input(runId: string, required = false): TemporalControlInput {
  return {
    runId,
    revision: 'fixture-revision',
    plan: required ? expandedPlan() : minimalPlan(),
    capabilities: {
      host: 'local-temporal-fixture',
      available: [],
      missing: required ? ['subagents', 'forge'] : [],
      notes: {},
    },
  };
}

test('local Temporal wait survives worker replacement and invokes the canonical six-stage engine', async () => {
  const environment = await TestWorkflowEnvironment.createLocal();
  let active: { worker: Worker; run: Promise<void> } | undefined;
  try {
    const first = await Worker.create({
      connection: environment.nativeConnection,
      namespace: environment.namespace,
      taskQueue,
      workflowsPath,
      activities: createProofActivities('worker-1'),
    });
    active = { worker: first, run: first.run() };
    const handle = await environment.client.workflow.start(
      temporalControlWorkflow,
      {
        workflowId: 'temari-nx-local-restart',
        taskQueue,
        args: [input('temari-nx-local-restart')],
      },
    );
    assert.equal(await handle.query(readControlPhase), 'waiting');

    await first.shutdown();
    await active.run;
    active = undefined;

    const replacement = await Worker.create({
      connection: environment.nativeConnection,
      namespace: environment.namespace,
      taskQueue,
      workflowsPath,
      activities: createProofActivities('worker-2'),
    });
    active = { worker: replacement, run: replacement.run() };
    const reattached = environment.client.workflow.getHandle(handle.workflowId);
    assert.equal(await reattached.query(readControlPhase), 'waiting');
    await reattached.signal(releaseControl);
    const receipt = (await reattached.result()) as WorkflowReceipt;
    assert.equal(receipt.status, 'PASS');
    assert.deepEqual(
      receipt.stages.map((stage) => stage.stage),
      DEFAULT_STAGES,
    );
    assert(receipt.stages.every((stage) => stage.summary.includes('worker-2')));
  } finally {
    if (active) {
      await active.worker.shutdown();
      await active.run;
    }
    await environment.teardown();
  }
});

test('local Temporal route retains a required capability block without running stages', async () => {
  const environment = await TestWorkflowEnvironment.createLocal();
  const worker = await Worker.create({
    connection: environment.nativeConnection,
    namespace: environment.namespace,
    taskQueue,
    workflowsPath,
    activities: createProofActivities('worker-blocked'),
  });
  const run = worker.run();
  try {
    const handle = await environment.client.workflow.start(
      temporalControlWorkflow,
      {
        workflowId: 'temari-nx-required-block',
        taskQueue,
        args: [input('temari-nx-required-block', true)],
      },
    );
    await handle.signal(releaseControl);
    const receipt = await handle.result();
    assert.equal(receipt.status, 'BLOCKED');
    assert.equal(receipt.failure?.kind, 'capability-gap');
    assert.deepEqual(receipt.stages, []);
  } finally {
    await worker.shutdown();
    await run;
    await environment.teardown();
  }
});
