import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const [artifact, state, mode, blockedPaths] = process.argv.slice(2);
assert(['interrupt', 'resume', 'inspect'].includes(mode));
assert(!process.env.NODE_OPTIONS);
assert(!process.env.NODE_PATH);
if (mode === 'inspect') {
  for (const path of JSON.parse(blockedPaths)) {
    assert.throws(() => readFileSync(path), { code: 'ERR_ACCESS_DENIED' });
  }
}

// Resolve public package exports without adding a file to the artifact inventory.
const resolvePackage = createRequire(
  pathToFileURL(join(artifact, 'consumer.mjs')),
);
async function load(name) {
  const entry = resolvePackage.resolve(name);
  assert(entry.startsWith(artifact + sep));
  assert(entry.endsWith('.js'));
  return import(pathToFileURL(entry).href);
}
const { WORKFLOW_STAGES, HOST_CAPABILITIES } = await load('@temari/contracts');
const { createRequestPlan } = await load('@temari/temari-core');
const {
  executeRequestPlanAndPersist,
  FileWorkflowReceiptStore,
  FileWorkflowCheckpointStore,
  FileEvidenceStore,
  FileWorkspaceManifestStore,
} = await load('@temari/runtime');
const request = JSON.parse(await readFile(join(state, 'request.json'), 'utf8'));
const { runId, revision } = request;
const requestPlan = createRequestPlan(request.request);
const store = await FileWorkflowReceiptStore.create(join(state, 'receipts'));
const checkpointStore = await FileWorkflowCheckpointStore.create(
  join(state, 'checkpoints'),
);
const evidence = await FileEvidenceStore.create(join(state, 'evidence'));
const workspaceManifestStore = await FileWorkspaceManifestStore.create(
  join(state, 'manifests'),
);
const workspace = (stage) => join(state, 'workspaces', stage);

if (mode === 'inspect') {
  const receipt = await store.load(runId);
  assert(receipt);
  const artifacts = [];
  for (const stage of WORKFLOW_STAGES) {
    const reference = JSON.parse(
      await readFile(join(workspace(stage), 'evidence.json'), 'utf8'),
    );
    assert.equal(reference.runId, runId);
    assert.equal(reference.revision, revision);
    const bytes = Buffer.from(await evidence.loadPortable(reference));
    assert.deepEqual(
      bytes,
      await readFile(join(workspace(stage), 'result.txt')),
    );
    artifacts.push({ stage, text: bytes.toString('utf8') });
  }
  console.log(
    JSON.stringify({
      receipt,
      checkpoint: await checkpointStore.load(runId),
      artifacts,
    }),
  );
} else {
  const receipt = await executeRequestPlanAndPersist({
    runId,
    revision,
    requestPlan,
    capabilities: {
      host: 'packaged-node-fixture',
      available: [],
      missing: [...HOST_CAPABILITIES],
    },
    store,
    checkpointStore,
    workspaceManifestStore,
    workspaceForStage: (stage) => ({
      workspaceId: `packaged-${stage}`,
      root: workspace(stage),
    }),
    handler: async (stage) => {
      await appendFile(
        join(state, 'handlers.jsonl'),
        `${JSON.stringify(stage)}\n`,
      );
      await mkdir(workspace(stage), { recursive: true });
      let text;
      if (stage === 'investigate') {
        text = await readFile(join(state, 'source.txt'), 'utf8');
      } else if (stage === 'plan') {
        assert.equal(
          await readFile(join(workspace('investigate'), 'result.txt'), 'utf8'),
          'pear\napple\n',
        );
        text = 'uppercase-sort';
      } else if (stage === 'build') {
        assert.equal(
          await readFile(join(workspace('plan'), 'result.txt'), 'utf8'),
          'uppercase-sort',
        );
        text =
          (await readFile(join(workspace('investigate'), 'result.txt'), 'utf8'))
            .trim()
            .split('\n')
            .map((line) => line.toUpperCase())
            .sort()
            .join('\n') + '\n';
      } else {
        // Fixture self-checks are not independent agents or QA evaluators.
        text = await readFile(join(workspace('build'), 'result.txt'), 'utf8');
        assert.equal(text, 'APPLE\nPEAR\n');
      }
      const output = join(workspace(stage), 'result.txt');
      await writeFile(output, text);
      const stored = await evidence.put({
        runId,
        revision,
        kind: 'other',
        content: Buffer.from(text),
      });
      const { schema, kind, sha256, bytes } = stored;
      await writeFile(
        join(workspace(stage), 'evidence.json'),
        JSON.stringify({ schema, kind, runId, revision, sha256, bytes }),
      );
      return {
        status: 'PASS',
        summary: `Fixture bytes written for ${stage}`,
        evidencePaths: [output],
      };
    },
    onStageCheckpoint: async (checkpoint) => {
      if (mode === 'interrupt' && checkpoint.stages.at(-1)?.stage === 'build') {
        assert.deepEqual(await checkpointStore.load(runId), checkpoint);
        assert.equal(await store.load(runId), null);
        await writeFile(
          join(state, 'acknowledged-prefix.json'),
          JSON.stringify(checkpoint),
        );
        process.exit(73);
      }
    },
  });
  assert.equal(receipt.status, 'PASS', JSON.stringify(receipt));
  assert.deepEqual(await store.load(runId), receipt);
}
