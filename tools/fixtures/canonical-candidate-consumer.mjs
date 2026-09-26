import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const [artifact, state, mode, blockedPaths] = process.argv.slice(2);
assert(
  [
    'prepare',
    'interrupt-empty',
    'interrupt-build',
    'interrupt-complete',
    'interrupt-unacknowledged',
    'interrupt-orphan',
    'resume',
    'inspect',
  ].includes(mode),
);
assert(!process.env.NODE_OPTIONS);
assert(!process.env.NODE_PATH);
if (mode === 'inspect') {
  for (const path of JSON.parse(blockedPaths))
    assert.throws(() => readFileSync(path), { code: 'ERR_ACCESS_DENIED' });
}
const resolvePackage = createRequire(
  pathToFileURL(join(artifact, 'consumer.mjs')),
);
async function load(name) {
  const entry = resolvePackage.resolve(name);
  assert(entry.startsWith(artifact + sep));
  assert(entry.endsWith('.js'));
  return import(pathToFileURL(entry).href);
}
const { DEFAULT_STAGES, HOST_CAPABILITIES, minimalPlan } =
  await load('@temari/contracts');
const {
  executeAndPersist,
  observeCandidate,
  verifyCandidateCloseout,
  FileWorkflowReceiptStore,
  FileWorkflowCheckpointStore,
  FileEvidenceStore,
  FileWorkspaceManifestStore,
} = await load('@temari/runtime');
const { runId, revision } = JSON.parse(
  await readFile(join(state, 'request.json'), 'utf8'),
);
const scope = { scopeId: 'packaged-product', root: join(state, 'candidate') };
const product = join(scope.root, 'product.txt');
const workspace = (stage) => join(state, 'workspaces', stage);
const workspaceForStage = (stage) => ({
  workspaceId: `candidate-${stage}`,
  root: workspace(stage),
});
const knownWriteRoots = [
  'receipts',
  'checkpoints',
  'evidence',
  'manifests',
  'logs',
].map((name) => join(state, name));
const store = await FileWorkflowReceiptStore.create(knownWriteRoots[0]);
const checkpoints = await FileWorkflowCheckpointStore.create(
  knownWriteRoots[1],
);
const evidenceStore = await FileEvidenceStore.create(knownWriteRoots[2]);
const workspaceManifestStore = await FileWorkspaceManifestStore.create(
  knownWriteRoots[3],
);

if (mode === 'prepare') {
  await mkdir(scope.root);
  await mkdir(knownWriteRoots[4]);
  for (const stage of DEFAULT_STAGES)
    await mkdir(workspace(stage), { recursive: true });
  await writeFile(product, 'pear\napple\n');
  await writeFile(
    join(state, 'initial.json'),
    JSON.stringify(await observeCandidate(scope)),
  );
} else if (mode === 'inspect') {
  const expectedCurrent = JSON.parse(
    await readFile(join(state, 'expected-current.json'), 'utf8'),
  );
  const verified = await verifyCandidateCloseout({
    runId,
    revision,
    store,
    evidenceStore,
    workspaceManifestStore,
    workspaceForStage,
    scope,
    knownWriteRoots,
    expectedCurrent,
  });
  console.log(
    JSON.stringify({
      verified,
      receipt: await store.load(runId),
      checkpoint: await checkpoints.load(runId),
      product: await readFile(product, 'utf8'),
    }),
  );
} else {
  const expectedInitial = JSON.parse(
    await readFile(join(state, 'initial.json'), 'utf8'),
  );
  const persistPrefix = async (checkpoint) => {
    assert.deepEqual(await checkpoints.load(runId), checkpoint);
    assert.equal(await store.load(runId), null);
    await writeFile(
      join(state, 'logs', 'acknowledged-prefix.json'),
      JSON.stringify(checkpoint),
    );
    process.exit(73);
  };
  const checkpointStore = {
    load: (id) => checkpoints.load(id),
    save: async (checkpoint) => {
      if (mode === 'interrupt-orphan' && checkpoint.stages.length === 1)
        process.exit(75);
      const saved = await checkpoints.save(checkpoint);
      if (mode === 'interrupt-empty' && checkpoint.stages.length === 0)
        await persistPrefix(checkpoint);
      return saved;
    },
  };
  const receipt = await executeAndPersist({
    runId,
    revision,
    plan: minimalPlan('feature'),
    capabilities: {
      host: 'packaged-candidate-fixture',
      available: [],
      missing: HOST_CAPABILITIES,
    },
    store,
    checkpointStore,
    workspaceManifestStore,
    workspaceForStage,
    stageEvidence: { store: evidenceStore },
    candidate: { scope, expectedInitial, knownWriteRoots },
    handler: async (stage) => {
      await appendFile(
        join(state, 'logs', 'handlers.jsonl'),
        `${JSON.stringify(stage)}\n`,
      );
      let text = await readFile(product, 'utf8');
      if (stage === 'build') {
        assert.equal(text, 'pear\napple\n');
        text =
          text
            .trim()
            .split('\n')
            .map((line) => line.toUpperCase())
            .sort()
            .join('\n') + '\n';
        await writeFile(product, text);
        if (mode === 'interrupt-unacknowledged') process.exit(74);
      } else if (['review', 'verify', 'deliver'].includes(stage)) {
        assert.equal(text, 'APPLE\nPEAR\n');
      } else assert.equal(text, 'pear\napple\n');
      await writeFile(join(workspace(stage), 'result.txt'), text);
      return {
        status: 'PASS',
        summary: `${stage} observed fixture product`,
        evidence: [
          {
            name: 'stage-output',
            kind: 'verification',
            content: `${stage}:\n${text}`,
          },
        ],
      };
    },
    onStageCheckpoint: async (checkpoint) => {
      const stage = checkpoint.stages.at(-1)?.stage;
      if (
        (mode === 'interrupt-build' && stage === 'build') ||
        (mode === 'interrupt-complete' && stage === 'deliver')
      )
        await persistPrefix(checkpoint);
    },
  });
  assert.equal(receipt.status, 'PASS', JSON.stringify(receipt));
  assert.deepEqual(await store.load(runId), receipt);
}
