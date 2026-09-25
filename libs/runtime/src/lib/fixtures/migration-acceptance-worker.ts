import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  HOST_CAPABILITIES,
  type WorkerEvidenceReference,
  type WorkflowReceipt,
  type WorkflowStageId,
} from '@temari/contracts';
import {
  createRequestPlan,
  deriveCloseout,
  type CloseoutDecision,
  type TemariPlanRequest,
  type TemariRequestPlan,
} from '@temari/temari-core';
import {
  executeRequestPlanAndPersist,
  FileEvidenceStore,
  FileWorkflowCheckpointStore,
  FileWorkflowReceiptStore,
  FileWorkspaceManifestStore,
} from '../../index.js';

// A deterministic filesystem fixture, not an independent agent or QA reviewer.
async function main(): Promise<void> {
  const [root, mode, revisionOverride] = process.argv.slice(2);
  assert(root);
  assert(['interrupt', 'resume', 'run', 'closeout'].includes(mode));
  const input: {
    runId: string;
    revision: string;
    request: TemariPlanRequest;
  } = JSON.parse(await readFile(join(root, 'request.json'), 'utf8'));
  const revision = revisionOverride ?? input.revision;
  const requestPlan: TemariRequestPlan = createRequestPlan(input.request);
  const receipts = await FileWorkflowReceiptStore.create(
    join(root, 'receipts'),
  );
  const checkpoints = await FileWorkflowCheckpointStore.create(
    join(root, 'checkpoints'),
  );
  const manifests = await FileWorkspaceManifestStore.create(
    join(root, 'manifests'),
  );
  const evidence = await FileEvidenceStore.create(join(root, 'evidence'));
  const log = (event: object) =>
    appendFile(join(root, 'events.jsonl'), `${JSON.stringify(event)}\n`);
  const workspace = (stage: WorkflowStageId) => join(root, 'workspaces', stage);
  const artifact = (stage: WorkflowStageId) =>
    join(workspace(stage), 'result.txt');

  async function checkCloseout(receipt: WorkflowReceipt): Promise<void> {
    const references: WorkerEvidenceReference[] = [];
    for (const stage of receipt.stages) {
      assert.equal(stage.evidencePaths.length, 2);
      const reference: WorkerEvidenceReference = JSON.parse(
        await readFile(stage.evidencePaths[1], 'utf8'),
      );
      // The semantic closeout decision cannot check bytes. Load and verify first.
      const bytes = await evidence.loadPortable(reference);
      assert.deepEqual(
        Buffer.from(bytes),
        await readFile(stage.evidencePaths[0]),
      );
      references.push(reference);
      await log({
        kind: 'evidence-verified',
        stage: stage.stage,
        sha256: reference.sha256,
      });
    }
    await log({ kind: 'closeout-evaluated' });
    const decision: CloseoutDecision = deriveCloseout(receipt, references);
    assert.equal(decision.status, 'ready', JSON.stringify(decision));
    await writeFile(join(root, 'closeout.json'), JSON.stringify(decision));
  }

  if (mode === 'closeout') {
    const receipt = await receipts.load(input.runId);
    assert(receipt);
    await checkCloseout(receipt);
    return;
  }

  const receipt = await executeRequestPlanAndPersist({
    runId: input.runId,
    revision,
    requestPlan,
    capabilities: {
      host: 'node-serial-acceptance-fixture',
      available: [],
      missing: [...HOST_CAPABILITIES],
      notes: { subagents: 'Fixture callbacks provide no independent review.' },
    },
    store: receipts,
    checkpointStore: checkpoints,
    workspaceManifestStore: manifests,
    workspaceForStage: (stage) => ({
      workspaceId: `fixture-${stage}`,
      root: workspace(stage),
    }),
    handler: async (stage) => {
      await log({ kind: 'handler', stage, runId: input.runId, revision });
      await mkdir(workspace(stage), { recursive: true });
      let content: string;
      switch (stage) {
        case 'investigate': {
          const source = await readFile(join(root, 'source.txt'), 'utf8');
          const lines = source
            .trim()
            .split('\n')
            .map((line) => line.trim());
          assert.deepEqual(lines, ['pear', 'apple']);
          content = JSON.stringify(lines);
          break;
        }
        case 'plan': {
          const lines: string[] = JSON.parse(
            await readFile(artifact('investigate'), 'utf8'),
          );
          assert.equal(lines.length, 2);
          content = JSON.stringify({
            operation: 'uppercase-sort',
            rows: lines.length,
          });
          break;
        }
        case 'build': {
          const plan = JSON.parse(await readFile(artifact('plan'), 'utf8'));
          const lines: string[] = JSON.parse(
            await readFile(artifact('investigate'), 'utf8'),
          );
          assert.equal(plan.operation, 'uppercase-sort');
          assert.equal(lines.length, plan.rows);
          content = `${lines
            .map((line) => line.toUpperCase())
            .sort()
            .join('\n')}\n`;
          break;
        }
        case 'review': {
          const built = await readFile(artifact('build'), 'utf8');
          assert.equal(built, 'APPLE\nPEAR\n');
          content = 'Self-review: two sorted uppercase rows; no extra rows.\n';
          break;
        }
        case 'verify': {
          assert.equal(
            await readFile(artifact('review'), 'utf8'),
            'Self-review: two sorted uppercase rows; no extra rows.\n',
          );
          assert.deepEqual(
            await readFile(artifact('build')),
            Buffer.from('APPLE\nPEAR\n'),
          );
          content = 'Verified exact UTF-8 bytes: APPLE\\nPEAR\\n\n';
          break;
        }
        case 'deliver': {
          assert.equal(
            await readFile(artifact('verify'), 'utf8'),
            'Verified exact UTF-8 bytes: APPLE\\nPEAR\\n\n',
          );
          content = await readFile(artifact('build'), 'utf8');
          break;
        }
      }
      await writeFile(artifact(stage), content);
      const bytes = await readFile(artifact(stage));
      assert.equal(bytes.toString('utf8'), content);
      const stored = await evidence.put({
        runId: input.runId,
        revision,
        kind: stage === 'verify' ? 'verification' : 'other',
        content: bytes,
      });
      const reference: WorkerEvidenceReference = {
        schema: stored.schema,
        runId: stored.runId,
        revision: stored.revision,
        kind: stored.kind,
        sha256: stored.sha256,
        bytes: stored.bytes,
      };
      const referencePath = join(workspace(stage), 'evidence.json');
      await writeFile(referencePath, JSON.stringify(reference));
      return {
        status: 'PASS',
        summary: `${stage}: filesystem artifact written and read back`,
        evidencePaths: [artifact(stage), referencePath],
      };
    },
    onStageCheckpoint: async (checkpoint) => {
      if (mode === 'interrupt' && checkpoint.stages.at(-1)?.stage === 'build') {
        assert.deepEqual(await checkpoints.load(input.runId), checkpoint);
        await log({ kind: 'checkpoint-persisted', stage: 'build' });
        process.exit(73);
      }
    },
  });
  const reloaded = await receipts.load(input.runId);
  assert.deepEqual(reloaded, receipt);
  assert(reloaded);
  if (input.request.qaResponsibility) {
    assert.equal(reloaded.status, 'BLOCKED');
    assert.deepEqual(reloaded.failure?.missingCapabilities, ['subagents']);
    return;
  }
  assert.equal(reloaded.status, 'PASS', JSON.stringify(reloaded.failure));
  await checkCloseout(reloaded);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
