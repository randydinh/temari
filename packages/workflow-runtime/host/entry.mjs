import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  sep,
} from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import {
  controlLine,
  createStdioSession,
  diagnostic,
  exactFields,
  readBoundedFile,
  readBoundedJson,
} from './stdio.mjs';

// Source-only experimental bridge. The trusted caller must have verified the
// compiled artifact with its canonical checker. This pins manifest bytes only;
// it does not authenticate the artifact closure or provide public skill policy.
const CONFIG_BYTES = 32 * 1024;
const MANIFEST_BYTES = 1024 * 1024;
const obligationKeys = [
  'workType',
  'delegation',
  'review',
  'evidence',
  'delivery',
];
const optionalObligations = ['requiredCapabilities', 'parallelism'];
const storeNames = ['receipts', 'checkpoints', 'evidence', 'manifests'];
const enums = {
  workType: ['investigation', 'design', 'bug', 'feature', 'qa', 'migration'],
  delegation: ['none', 'optional', 'required'],
  review: ['self', 'coordinator', 'independent'],
  evidence: ['minimal', 'standard', 'revision-bound'],
  delivery: ['local', 'commit', 'pull-request'],
};

function absolute(value) {
  assert(
    typeof value === 'string' &&
      isAbsolute(value) &&
      !/[\x00-\x1f\x7f]/.test(value),
    'Expected an absolute path without control characters.',
  );
  return normalize(value);
}
function identity(value) {
  assert(
    typeof value.runId === 'string' &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.runId),
    'Invalid run ID.',
  );
  assert(
    typeof value.revision === 'string' &&
      value.revision.trim().length > 0 &&
      Buffer.byteLength(value.revision) <= 512,
    'Invalid revision.',
  );
  exactFields(value.candidate, ['scopeId', 'root']);
  assert(
    typeof value.candidate.scopeId === 'string' &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.candidate.scopeId),
    'Invalid candidate scope ID.',
  );
  absolute(value.candidate.root);
  absolute(value.runDirectory);
}
function validateObligations(value, capabilities) {
  exactFields(value, obligationKeys, optionalObligations);
  for (const key of obligationKeys)
    assert(enums[key].includes(value[key]), `Invalid ${key} obligation.`);
  if (Object.hasOwn(value, 'requiredCapabilities')) {
    assert(
      Array.isArray(value.requiredCapabilities) &&
        value.requiredCapabilities.length <= capabilities.length &&
        value.requiredCapabilities.every((name) =>
          capabilities.includes(name),
        ) &&
        new Set(value.requiredCapabilities).size ===
          value.requiredCapabilities.length,
      'Invalid required capabilities.',
    );
  }
  if (Object.hasOwn(value, 'parallelism')) {
    exactFields(value.parallelism, ['maxConcurrency']);
    assert(
      Number.isSafeInteger(value.parallelism.maxConcurrency) &&
        value.parallelism.maxConcurrency >= 1,
      'parallelism.maxConcurrency must be a positive safe integer.',
    );
  }
}
async function directory(path) {
  const selected = absolute(path);
  const stat = await lstat(selected);
  assert(
    stat.isDirectory() && !stat.isSymbolicLink(),
    'Expected an existing nonsymlink directory.',
  );
  return realpath(selected);
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
async function freshDirectory(path) {
  const selected = absolute(path);
  assert(
    dirname(selected) !== selected,
    'Run directory must have an existing parent.',
  );
  const root = join(await directory(dirname(selected)), basename(selected));
  try {
    await lstat(root);
  } catch (error) {
    if (error.code === 'ENOENT') return root;
    throw error;
  }
  throw new Error('Run directory already exists.');
}
function layout(root, stages) {
  const config = join(root, 'config');
  const workspaces = join(root, 'workspaces');
  const stageRoots = stages.map((stage) => join(workspaces, stage));
  const stores = storeNames.map((name) => join(root, name));
  return {
    config,
    workspaces,
    stores,
    directories: [config, workspaces, ...stageRoots, ...stores],
    knownWriteRoots: [config, ...stores],
    workspaceForStage: (stage) => {
      assert(stages.includes(stage), 'Unknown runtime stage.');
      return { workspaceId: stage, root: join(workspaces, stage) };
    },
  };
}
function checkControlPaths(input, paths, stages) {
  for (const stage of stages) {
    controlLine({
      type: 'stage',
      sessionId: '00000000-0000-0000-0000-000000000000',
      requestId: Number.MAX_SAFE_INTEGER,
      stage,
      workspace: paths.workspaceForStage(stage).root,
      candidate: input.candidate,
    });
  }
}
async function writeDescriptor(path, descriptor) {
  const bytes = Buffer.from(`${JSON.stringify(descriptor)}\n`);
  assert(bytes.length <= CONFIG_BYTES, 'Run descriptor exceeds 32 KiB.');
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
}

function invocationScope(input) {
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, canonical(value[key])]),
      );
    return value;
  };
  return {
    scopeId: `host-${createHash('sha256')
      .update(JSON.stringify(canonical(input)))
      .digest('hex')}`,
    root: input.candidate.root,
  };
}

async function main(session) {
  const [
    mode,
    runtimeFlag,
    runtimeArgument,
    inputFlag,
    inputArgument,
    ...extra
  ] = process.argv.slice(2);
  assert(
    (mode === 'start' || mode === 'resume') &&
      runtimeFlag === '--runtime' &&
      inputFlag === (mode === 'start' ? '--request' : '--run-directory') &&
      inputArgument !== undefined &&
      extra.length === 0,
    'Usage: node entry.mjs start --runtime ABS --request ABS_JSON | resume --runtime ABS --run-directory ABS',
  );
  const runtimeRoot = await directory(runtimeArgument);
  absolute(inputArgument);
  const runtimeManifestSha256 = createHash('sha256')
    .update(
      await readBoundedFile(
        join(runtimeRoot, 'canonical-manifest.json'),
        MANIFEST_BYTES,
      ),
    )
    .digest('hex');
  const consumer = createRequire(
    pathToFileURL(join(runtimeRoot, 'consumer.mjs')),
  );
  async function load(name) {
    const entry = await realpath(consumer.resolve(name));
    assert(
      contains(runtimeRoot, entry) && entry.endsWith('.js'),
      'Production package entry must resolve inside the compiled artifact.',
    );
    return import(pathToFileURL(entry).href);
  }
  const contracts = await load('@temari/contracts');
  const core = await load('@temari/temari-core');
  const runtime = await load('@temari/runtime');
  const { DEFAULT_STAGES: stages, HOST_CAPABILITIES: hostCapabilities } =
    contracts;
  const capabilities = {
    host: 'experimental-local-host',
    available: [],
    missing: [...hostCapabilities],
    notes: {},
  };
  let input;
  let paths;
  if (mode === 'start') {
    const request = await readBoundedJson(
      absolute(inputArgument),
      CONFIG_BYTES,
    );
    exactFields(request, [
      'schemaVersion',
      'runId',
      'revision',
      'candidate',
      'runDirectory',
      'obligations',
    ]);
    assert(request.schemaVersion === 1, 'Unsupported request schema.');
    identity(request);
    validateObligations(request.obligations, hostCapabilities);
    const candidate = {
      scopeId: request.candidate.scopeId,
      root: await directory(request.candidate.root),
    };
    const runDirectory = await freshDirectory(request.runDirectory);
    disjoint(candidate.root, runtimeRoot, runDirectory);
    const plan = core.createExecutionPlan(request.obligations);
    paths = layout(runDirectory, stages);
    input = {
      schemaVersion: 1,
      runId: request.runId,
      revision: request.revision,
      candidate,
      runDirectory,
      plan,
      capabilities,
      expectedInitial: await runtime.observeCandidate(candidate),
      runtimeManifestSha256,
    };
    checkControlPaths(input, paths, stages);
    session.assertHealthy();
    // Preserve partial starts for diagnosis; resume never adopts them.
    await mkdir(runDirectory, { mode: 0o700 });
    assert.equal(
      await directory(runDirectory),
      runDirectory,
      'Run directory resolution changed.',
    );
    for (const path of paths.directories) await mkdir(path, { mode: 0o700 });
    await writeDescriptor(join(paths.config, 'input.json'), input);
  } else {
    const runDirectory = await directory(inputArgument);
    assert.equal(
      await directory(join(runDirectory, 'config')),
      join(runDirectory, 'config'),
      'Config directory resolution changed.',
    );
    input = await readBoundedJson(
      join(runDirectory, 'config', 'input.json'),
      CONFIG_BYTES,
    );
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
    ]);
    assert(input.schemaVersion === 1, 'Unsupported run descriptor schema.');
    identity(input);
    assert.equal(
      input.runDirectory,
      runDirectory,
      'Run directory differs from original input.',
    );
    assert.equal(
      await directory(input.candidate.root),
      input.candidate.root,
      'Candidate root differs from original input.',
    );
    assert.equal(
      input.runtimeManifestSha256,
      runtimeManifestSha256,
      'Runtime manifest changed.',
    );
    assert.deepEqual(
      input.capabilities,
      capabilities,
      'Host capabilities differ from fixed experimental report.',
    );
    contracts.assertCandidateIdentity(input.expectedInitial);
    exactFields(
      input.plan,
      ['version', 'stages', ...obligationKeys, 'requiredCapabilities'],
      ['parallelism'],
    );
    const obligations = Object.fromEntries(
      [...obligationKeys, ...optionalObligations]
        .filter((key) => Object.hasOwn(input.plan, key))
        .map((key) => [key, input.plan[key]]),
    );
    validateObligations(obligations, hostCapabilities);
    assert.deepEqual(
      input.plan,
      core.createExecutionPlan(obligations),
      'Retained plan is not canonical.',
    );
    disjoint(input.candidate.root, runtimeRoot, runDirectory);
    paths = layout(runDirectory, stages);
    for (const path of paths.directories) {
      assert.equal(
        await directory(path),
        path,
        'Retained run layout resolution changed.',
      );
    }
    checkControlPaths(input, paths, stages);
  }
  session.assertHealthy();
  const [receipts, checkpoints, evidenceStore, workspaceManifestStore] =
    await Promise.all([
      runtime.FileWorkflowReceiptStore.create(paths.stores[0]),
      runtime.FileWorkflowCheckpointStore.create(paths.stores[1]),
      runtime.FileEvidenceStore.create(paths.stores[2]),
      runtime.FileWorkspaceManifestStore.create(paths.stores[3]),
    ]);
  if (mode === 'resume') {
    // Presence only: the runtime remains the sole prefix/replay validator, and
    // refuses existing terminal receipts. Never recapture/adopt a new initial.
    assert(
      (await receipts.load(input.runId)) ||
        (await checkpoints.load(input.runId)),
      'Resume requires an original checkpoint or terminal receipt.',
    );
  }
  const store = {
    load: (id) => receipts.load(id),
    save: async (receipt) => {
      await nextTurn();
      if (receipt.status !== 'BLOCKED') session.assertHealthy();
      const saved = await receipts.save(receipt);
      if (receipt.status !== 'BLOCKED') session.assertHealthy();
      return saved;
    },
  };
  const receipt = await runtime.executeAndPersist({
    runId: input.runId,
    revision: input.revision,
    plan: input.plan,
    capabilities: input.capabilities,
    store,
    checkpointStore: checkpoints,
    stageEvidence: { store: evidenceStore },
    workspaceManifestStore,
    workspaceForStage: paths.workspaceForStage,
    candidate: {
      scope: invocationScope(input),
      expectedInitial: input.expectedInitial,
      knownWriteRoots: paths.knownWriteRoots,
    },
    handler: (stage) =>
      session.stage(
        stage,
        paths.workspaceForStage(stage).root,
        input.candidate,
      ),
    onStageCheckpoint: async (checkpoint) => {
      await session.emit({
        type: 'checkpoint',
        stage: checkpoint.stages.at(-1).stage,
      });
    },
  });
  if (receipt.status !== 'BLOCKED') session.assertHealthy();
  await session.emit({
    type: 'complete',
    status: receipt.status,
    runId: receipt.runId,
  });
  return receipt.status === 'PASS' && !session.fault ? 0 : 1;
}

let session;
let exitCode = 1;
try {
  session = createStdioSession();
  exitCode = await main(session);
} catch (error) {
  diagnostic(error);
} finally {
  session?.dispose();
}
// All emitted records have completed their write callbacks; do not retain stdin.
process.exit(exitCode);
