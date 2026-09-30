import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  minimalPlan,
  type ExecutionHarness,
  type HarnessRunRef,
  type HarnessRunRequest,
  type HarnessRunSnapshot,
} from '@temari/contracts';
import {
  cancelExecutionHarness,
  getExecutionHarnessStatus,
  resumeExecutionHarness,
  startExecutionHarness,
} from './harness-runtime.js';
import type { HarnessSelection } from './harness-selector.js';

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function planDigest(plan: unknown): string {
  return createHash('sha256').update(canonical(plan), 'utf8').digest('hex');
}

function mockHarness(id: string, seen: string[]): ExecutionHarness {
  return {
    id,
    version: '1.2.3',
    async start(request: HarnessRunRequest): Promise<HarnessRunRef> {
      seen.push(`${id}:start`);
      return {
        schema: 1,
        harnessId: id,
        harnessVersion: '1.2.3',
        runId: request.runId,
        revision: request.revision,
        planSha256: planDigest(request.plan),
        externalRunId: `${id}-native-1`,
        workspaceRoot: request.workspaceRoot,
        entrypoint: request.entrypoint,
        startedAt: new Date(0).toISOString(),
      };
    },
    async status(): Promise<HarnessRunSnapshot> {
      seen.push(`${id}:status`);
      return {
        status: 'RUNNING',
        observedAt: new Date(0).toISOString(),
        summary: 'native run remains active',
        rawLogPath: null,
      };
    },
    async resume(): Promise<HarnessRunSnapshot> {
      seen.push(`${id}:resume`);
      return {
        status: 'SUCCEEDED',
        observedAt: new Date(0).toISOString(),
        summary: 'native run ended',
        rawLogPath: null,
      };
    },
  };
}

function request(): HarnessRunRequest {
  return {
    runId: 'temari-run-1',
    revision: 'revision-1',
    plan: minimalPlan('feature'),
    workspaceRoot: '/workspace',
    entrypoint: 'feature',
    inputs: {},
  };
}

test('runtime dispatch selects an injected host and resumes by the same identity', async () => {
  const seen: string[] = [];
  const selection: HarnessSelection = {
    hostHarness: mockHarness('host', seen),
    configuredHarness: mockHarness('alternate', seen),
    managedDefault: mockHarness('archon', seen),
  };

  const reference = await startExecutionHarness(selection, request());
  assert.equal(reference.harnessId, 'host');
  assert.equal(reference.planSha256, planDigest(request().plan));
  assert.equal(
    (await getExecutionHarnessStatus(selection, reference)).status,
    'RUNNING',
  );
  assert.equal(
    (await resumeExecutionHarness(selection, reference)).status,
    'SUCCEEDED',
  );
  assert.deepEqual(seen, ['host:start', 'host:status', 'host:resume']);
});

test('runtime rejects a stale reference after harness selection changes', async () => {
  const seen: string[] = [];
  const host = mockHarness('host', seen);
  const reference = await startExecutionHarness(
    { hostHarness: host, configuredHarness: null, managedDefault: null },
    request(),
  );
  await assert.rejects(
    getExecutionHarnessStatus(
      {
        hostHarness: null,
        configuredHarness: mockHarness('replacement', seen),
        managedDefault: null,
      },
      reference,
    ),
    /does not match the selected implementation/,
  );
  assert.deepEqual(seen, ['host:start']);
});

test('runtime rejects a selected harness returning a different run identity', async () => {
  const seen: string[] = [];
  const incorrect = mockHarness('alternate', seen);
  const originalStart = incorrect.start.bind(incorrect);
  incorrect.start = async (runRequest) => ({
    ...(await originalStart(runRequest)),
    revision: 'different-revision',
  });
  await assert.rejects(
    startExecutionHarness(
      { hostHarness: incorrect, configuredHarness: null, managedDefault: null },
      request(),
    ),
    /different Temari run, revision, or plan/,
  );
});

test('runtime cancellation preserves the exact reference and observed status', async () => {
  const seen: string[] = [];
  const harness = mockHarness('host', seen);
  const selection: HarnessSelection = {
    hostHarness: harness,
    configuredHarness: null,
    managedDefault: null,
  };
  const reference = await startExecutionHarness(selection, request());
  const snapshot: HarnessRunSnapshot = {
    status: 'RUNNING',
    observedAt: new Date(0).toISOString(),
    summary: 'Cancellation requested; native run is still active',
    rawLogPath: '/workspace/run.log',
  };
  harness.cancel = async (received) => {
    assert.equal(received, reference);
    seen.push('host:cancel');
    return snapshot;
  };

  assert.equal(await cancelExecutionHarness(selection, reference), snapshot);
  assert.deepEqual(seen, ['host:start', 'host:cancel']);
});

test('runtime cancellation rejects mismatched and malformed references before dispatch', async () => {
  const seen: string[] = [];
  const harness = mockHarness('host', seen);
  const selection: HarnessSelection = {
    hostHarness: harness,
    configuredHarness: null,
    managedDefault: null,
  };
  const reference = await startExecutionHarness(selection, request());
  harness.cancel = async () => {
    seen.push('host:cancel');
    throw new Error('must not dispatch');
  };

  for (const changes of [
    { harnessId: 'replacement' },
    { harnessVersion: '9.9.9' },
    { externalRunId: '' },
    { planSha256: 'tampered' },
  ]) {
    await assert.rejects(
      cancelExecutionHarness(selection, { ...reference, ...changes }),
      /does not match the selected implementation/,
    );
  }
  assert.deepEqual(seen, ['host:start']);
});

test('runtime reports unsupported cancellation without using resume or status', async () => {
  const seen: string[] = [];
  const selection: HarnessSelection = {
    hostHarness: mockHarness('host', seen),
    configuredHarness: null,
    managedDefault: null,
  };
  const reference = await startExecutionHarness(selection, request());

  await assert.rejects(
    cancelExecutionHarness(selection, reference),
    /Execution harness host@1\.2\.3 does not support cancellation/,
  );
  assert.deepEqual(seen, ['host:start']);
});
