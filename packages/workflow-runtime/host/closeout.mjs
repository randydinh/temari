import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { invocationScope } from './invocation.mjs';
import { assertSourceEvidence, loadSourceContract } from './source.mjs';
import { exactFields, readBoundedFile, readBoundedJson } from './stdio.mjs';

const CONFIG_BYTES = 32 * 1024;
const MANIFEST_BYTES = 1024 * 1024;
const RECORD_BYTES = 64 * 1024 * 1024;
const storeNames = ['receipts', 'checkpoints', 'evidence', 'manifests'];

async function directory(path, requireCanonical = false) {
  assert(
    typeof path === 'string' &&
      isAbsolute(path) &&
      !/[\x00-\x1f\x7f]/.test(path),
    'Expected an absolute directory path.',
  );
  const stat = await lstat(path);
  assert(
    stat.isDirectory() && !stat.isSymbolicLink(),
    'Expected an existing nonsymlink directory.',
  );
  const resolved = await realpath(path);
  if (requireCanonical)
    assert.equal(path, resolved, 'Run layout must use canonical paths.');
  return resolved;
}

function contains(parent, child) {
  const path = relative(parent, child);
  return (
    path === '' ||
    (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
  );
}

function disjoint(...roots) {
  for (let i = 0; i < roots.length; i++) {
    for (let j = i + 1; j < roots.length; j++) {
      assert(
        !contains(roots[i], roots[j]) && !contains(roots[j], roots[i]),
        'Candidate, runtime and run directory must be disjoint.',
      );
    }
  }
}

async function load(runtimeRoot, name) {
  const consumer = createRequire(
    pathToFileURL(join(runtimeRoot, 'consumer.mjs')),
  );
  const entry = await realpath(consumer.resolve(name));
  assert(
    contains(runtimeRoot, entry) && entry.endsWith('.js'),
    'Package entry must resolve inside the compiled artifact.',
  );
  return import(pathToFileURL(entry).href);
}

export async function verifyInstalledCloseout({
  bundleRoot,
  policy,
  request,
  expectedCurrent,
  selectionPath,
}) {
  const runtimeRoot = await directory(join(bundleRoot, 'runtime'));
  const invocation = request.invocation;
  assert(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(invocation.runId),
    'Invalid run ID.',
  );
  assert(
    typeof invocation.revision === 'string' &&
      invocation.revision.trim().length > 0 &&
      Buffer.byteLength(invocation.revision) <= 512,
    'Invalid revision.',
  );
  assert(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(invocation.candidate.scopeId),
    'Invalid candidate scope ID.',
  );
  const runDirectory = await directory(invocation.runDirectory);
  const candidateRoot = await directory(invocation.candidate.root);
  disjoint(runDirectory, candidateRoot, runtimeRoot);
  const selectedFile = await realpath(selectionPath);
  assert(
    !contains(runDirectory, selectedFile) &&
      !contains(candidateRoot, selectedFile),
    'Current candidate selection must be outside the run and candidate.',
  );

  const contracts = await load(runtimeRoot, '@temari/contracts');
  const core = await load(runtimeRoot, '@temari/temari-core');
  const runtime = await load(runtimeRoot, '@temari/runtime');
  contracts.assertCandidateIdentity(expectedCurrent);
  const stages = contracts.DEFAULT_STAGES;
  const config = await directory(join(runDirectory, 'config'), true);
  const workspaces = await directory(join(runDirectory, 'workspaces'), true);
  const stageRoots = new Map();
  for (const stage of stages)
    stageRoots.set(stage, await directory(join(workspaces, stage), true));
  const stores = new Map();
  for (const name of storeNames)
    stores.set(name, await directory(join(runDirectory, name), true));

  const input = await readBoundedJson(join(config, 'input.json'), CONFIG_BYTES);
  exactFields(input, [
    'schemaVersion',
    'runId',
    'revision',
    'candidate',
    'runDirectory',
    'plan',
    'capabilities',
    'expectedInitial',
    'runtimeManifestSha256',
    'sourceProfile',
  ]);
  assert.equal(input.schemaVersion, 1, 'Unsupported run descriptor schema.');
  exactFields(input.candidate, ['scopeId', 'root']);
  assert.equal(input.runId, invocation.runId, 'Retained run ID differs.');
  assert.equal(
    input.revision,
    invocation.revision,
    'Retained revision differs.',
  );
  assert.deepEqual(
    input.candidate,
    { scopeId: invocation.candidate.scopeId, root: candidateRoot },
    'Retained candidate differs from trusted invocation.',
  );
  assert.equal(
    input.runDirectory,
    runDirectory,
    'Retained run directory differs from trusted invocation.',
  );
  assert.equal(
    input.sourceProfile,
    policy.entries[request.entry].supportedProfile,
    'Retained source profile differs from admitted policy.',
  );
  assert.deepEqual(
    input.plan,
    core.createExecutionPlan(policy.lightweight.obligations),
    'Retained plan differs from admitted policy.',
  );
  assert.deepEqual(
    input.capabilities,
    {
      host: 'experimental-local-host',
      available: [],
      missing: [...contracts.HOST_CAPABILITIES],
      notes: {},
    },
    'Retained capabilities differ from the bridge report.',
  );
  contracts.assertCandidateIdentity(input.expectedInitial);
  assert.equal(
    input.runtimeManifestSha256,
    createHash('sha256')
      .update(
        await readBoundedFile(
          join(runtimeRoot, 'canonical-manifest.json'),
          MANIFEST_BYTES,
        ),
      )
      .digest('hex'),
    'Retained canonical runtime differs from the installed artifact.',
  );
  const sourceContract = await loadSourceContract(
    contracts,
    runtimeRoot,
    input.sourceProfile,
  );
  assert.deepEqual(input.plan, sourceContract.plan);
  await readBoundedFile(
    join(stores.get('receipts'), `${input.runId}.receipt.json`),
    RECORD_BYTES,
  );
  for (const stage of stages)
    await readBoundedFile(
      join(stores.get('manifests'), `${input.runId}.${stage}.workspace.json`),
      RECORD_BYTES,
    );

  const [receipts, evidenceStore, workspaceManifestStore] = await Promise.all([
    runtime.FileWorkflowReceiptStore.openExisting(stores.get('receipts')),
    runtime.FileEvidenceStore.openExisting(stores.get('evidence')),
    runtime.FileWorkspaceManifestStore.openExisting(stores.get('manifests')),
  ]);
  const verified = await runtime.verifyCandidateCloseout({
    runId: input.runId,
    revision: input.revision,
    store: receipts,
    evidenceStore,
    workspaceManifestStore,
    workspaceForStage: (stage) => {
      assert(stageRoots.has(stage), 'Unknown runtime stage.');
      return { workspaceId: stage, root: stageRoots.get(stage) };
    },
    scope: invocationScope(input),
    knownWriteRoots: [config, ...stores.values()],
    expectedCurrent,
  });
  const receipt = await receipts.load(input.runId);
  assert(receipt, 'Persisted workflow receipt is missing.');
  assert.deepEqual(
    receipt.plan,
    input.plan,
    'Retained receipt plan differs from admitted policy.',
  );
  await assertSourceEvidence(
    receipt,
    evidenceStore,
    sourceContract,
    runtime,
    true,
  );
  return verified;
}
