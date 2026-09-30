import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  DEFAULT_STAGES,
  HOST_CAPABILITIES,
  minimalPlan,
  type ExecutionHarness,
  type HarnessRunRef,
  type WorkflowReceipt,
} from '@temari/contracts';
import { FileEvidenceStore } from './evidence-store.js';
import { FileWorkflowReceiptStore, executeAndPersist } from './runtime.js';
import { verifyDeterministicArchonReceiptParity } from './archon-receipt-parity.js';

function canonical(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((item) => canonical(item)).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

async function fixture(t: TestContext, archonOutput = 'same result') {
  const root = await mkdtemp(join(tmpdir(), 'temari-archon-parity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const receipts = await FileWorkflowReceiptStore.create(
    join(root, 'receipts'),
  );
  const evidence = await FileEvidenceStore.create(join(root, 'evidence'));
  const plan = minimalPlan('feature');
  const revision = 'frozen-revision-1';
  const run = (runId: string, output: string) =>
    executeAndPersist({
      runId,
      revision,
      plan,
      capabilities: {
        host: 'fixture',
        available: [],
        missing: HOST_CAPABILITIES,
        notes: {},
      },
      store: receipts,
      stageEvidence: { store: evidence },
      handler: (stage) => ({
        status: 'PASS' as const,
        summary: `${stage} complete`,
        evidence: [
          {
            name: 'result',
            kind: 'verification' as const,
            content: stage === 'build' ? output : 'same result',
          },
        ],
      }),
    });
  const serialReceipt = await run('serial-run', 'same result');
  const archonReceipt = await run('archon-run', archonOutput);
  const reference: HarnessRunRef = {
    schema: 1,
    harnessId: 'archon',
    harnessVersion: '0.10.1',
    runId: 'archon-run',
    revision,
    planSha256: createHash('sha256').update(canonical(plan)).digest('hex'),
    externalRunId: 'native-run-1',
    workspaceRoot: root,
    entrypoint: 'deterministic-fixture',
    startedAt: new Date(0).toISOString(),
  };
  const harness = (status: 'SUCCEEDED' | 'UNKNOWN'): ExecutionHarness => ({
    id: 'archon',
    version: '0.10.1',
    async start() {
      throw new Error('fixture does not launch a native run');
    },
    async status(actual) {
      assert.equal(actual.externalRunId, reference.externalRunId);
      return {
        status,
        observedAt: new Date().toISOString(),
        summary: 'fixture native status',
        rawLogPath: null,
      };
    },
    async resume() {
      throw new Error('fixture does not resume a native run');
    },
  });
  const request = {
    harness: harness('SUCCEEDED'),
    reference,
    serial: { runId: serialReceipt.runId, receipts, evidence },
    archon: { runId: archonReceipt.runId, receipts, evidence },
  };
  return {
    root,
    receipts,
    evidence,
    serialReceipt,
    archonReceipt,
    reference,
    harness,
    request,
  };
}

test('compares two persisted six-stage deterministic receipts and retains native reference', async (t) => {
  const f = await fixture(t);
  const bundle = await verifyDeterministicArchonReceiptParity(f.request);
  assert.equal(bundle.scope, 'deterministic-receipt-parity');
  assert.equal(bundle.nativeRun.externalRunId, 'native-run-1');
  assert.deepEqual(
    bundle.serialReceipt.stages.map((stage) => stage.stage),
    DEFAULT_STAGES,
  );
  assert.deepEqual(
    bundle.archonReceipt.stages.map((stage) => stage.stage),
    DEFAULT_STAGES,
  );
});

test('refuses missing, duplicated, reordered, or stale persisted stage evidence', async (t) => {
  const f = await fixture(t);
  const cases: Record<string, (receipt: WorkflowReceipt) => void> = {
    missing: (receipt) => {
      (receipt.stages as WorkflowReceipt['stages'][number][]).pop();
    },
    duplicated: (receipt) => {
      (receipt.stages as WorkflowReceipt['stages'][number][])[1] =
        receipt.stages[0]!;
    },
    reordered: (receipt) => {
      (receipt.stages as WorkflowReceipt['stages'][number][]).reverse();
    },
    staleRevision: (receipt) => {
      (receipt as { revision: string }).revision = 'older-revision';
    },
    missingEvidence: (receipt) => {
      delete (receipt.stages[0] as { stageEvidence?: unknown }).stageEvidence;
    },
    swappedEvidence: (receipt) => {
      (receipt.stages[0] as { stageEvidence?: unknown }).stageEvidence =
        receipt.stages[1]!.stageEvidence;
    },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    await t.test(name, async () => {
      const receipt = structuredClone(f.archonReceipt);
      mutate(receipt);
      const altered = {
        ...f.request,
        archon: {
          ...f.request.archon,
          receipts: {
            save: f.receipts.save.bind(f.receipts),
            async load() {
              return receipt;
            },
          },
        },
      };
      await assert.rejects(verifyDeterministicArchonReceiptParity(altered));
    });
  }
  await assert.rejects(
    verifyDeterministicArchonReceiptParity({
      ...f.request,
      harness: f.harness('UNKNOWN'),
    }),
    /Native run has not succeeded/,
  );
  await assert.rejects(
    verifyDeterministicArchonReceiptParity({
      ...f.request,
      reference: { ...f.reference, planSha256: 'a'.repeat(64) },
    }),
    /Receipt plan is stale/,
  );
});

test('refuses changed persisted evidence bytes and different stage output', async (t) => {
  const f = await fixture(t);
  const attestation = f.archonReceipt.stages[0]!.stageEvidence!;
  const path = join(f.root, 'evidence', `${attestation.sha256}.artifact`);
  const bytes = await readFile(path);
  await unlink(path);
  await writeFile(path, Buffer.from(bytes).fill(0, 0, 1));
  await assert.rejects(
    verifyDeterministicArchonReceiptParity(f.request),
    /hash/,
  );
  await writeFile(path, bytes);
  await verifyDeterministicArchonReceiptParity(f.request);

  const mismatch = await fixture(t, 'different build output');
  await assert.rejects(
    verifyDeterministicArchonReceiptParity(mismatch.request),
    /Stage payload bytes differ/,
  );
});
