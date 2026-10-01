import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
  loadSourceContract,
  attachSourceClaims,
  assertSourceEvidence,
} from './source.mjs';
import { invocationScope } from './invocation.mjs';
import { prepareTaskTracking } from './task-tracking.mjs';
import { verifyLocalFeatureHostProof } from './feature-proof.mjs';
import { verifyLocalPullRequest } from './forge.mjs';
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
async function featureCapabilities(
  featureHost,
  runId,
  revision,
  candidateRoot,
  all,
) {
  exactFields(featureHost, [
    'sourceCandidate',
    'evidenceRoot',
    'baseCommit',
    'hostBinding',
    'proofSha256',
  ]);
  exactFields(featureHost.sourceCandidate, ['scopeId', 'root']);
  assert.equal(featureHost.sourceCandidate.scopeId.length > 0, true);
  const proof = await verifyLocalFeatureHostProof({
    runId,
    revision,
    candidateRoot: featureHost.sourceCandidate.root,
    evidenceRoot: featureHost.evidenceRoot,
    baseCommit: featureHost.baseCommit,
    hostBinding: featureHost.hostBinding,
    proofSha256: featureHost.proofSha256,
  });
  assert.equal(
    candidateRoot,
    proof.integrationPath,
    'Feature candidate differs from the verified worker integration.',
  );
  const capabilities = {
    host: 'local-codex-feature-host',
    available: ['subagents', 'forge'],
    missing: all.filter((name) => name !== 'subagents' && name !== 'forge'),
    notes: {},
    provenance: {
      subagents: {
        status: 'proven',
        source: proof.proofSha256,
        observedAt: proof.forge.observedAt,
      },
      forge: {
        status: 'proven',
        source: proof.forge.nameWithOwner,
        observedAt: proof.forge.observedAt,
      },
    },
  };
  return { capabilities, proof };
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

async function featureStageResult(stage, result, proof) {
  assert(
    result.sourceRequirements === undefined,
    'Feature source claims are owned by the host.',
  );
  const suppliedSource = result.evidence.filter(
    (item) => item.name === 'source',
  );
  assert(suppliedSource.length <= 1, 'Duplicate feature source evidence.');
  const callerSource = suppliedSource[0];
  if (['investigate', 'plan', 'deliver'].includes(stage))
    assert(
      callerSource?.kind === 'other' && callerSource.content.length > 0,
      `Feature ${stage} requires source input.`,
    );
  else assert(!callerSource, `Feature ${stage} source is host-owned.`);
  const verifiedJson = async (path, expectedSha256, limit) => {
    const bytes = await readBoundedFile(path, limit);
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      expectedSha256,
    );
    return JSON.parse(bytes.toString());
  };
  const workerReport = await verifiedJson(
    proof.workers.reportPath,
    proof.workers.reportSha256,
    64 * 1024,
  );
  const builderObservation = await verifiedJson(
    workerReport.builder.observationPath,
    workerReport.builder.observationSha256,
    64 * 1024,
  );
  const reviewerObservation = await verifiedJson(
    workerReport.reviewer.observationPath,
    workerReport.reviewer.observationSha256,
    64 * 1024,
  );
  const builderReceipt = await verifiedJson(
    builderObservation.receipt.path,
    builderObservation.receipt.sha256,
    4 * 1024 * 1024,
  );
  let source;
  let claims;
  if (stage === 'investigate') {
    source = callerSource.content;
    claims = [{ id: 'feature.shape.how', sourceKind: 'document' }];
  } else if (stage === 'plan') {
    source = Buffer.from(
      JSON.stringify({
        hostProofSha256: proof.proofSha256,
        architectObservationSha256: proof.architect.observationSha256,
        throughputCheckpoint: callerSource.content.toString(),
      }),
    );
    claims = [
      { id: 'feature.shape.parallel-design', sourceKind: 'review' },
      { id: 'feature.shape.throughput-checkpoint', sourceKind: 'document' },
    ];
  } else if (stage === 'build') {
    const diff = execFileSync(
      'git',
      ['-C', proof.integrationPath, 'show', '--format=', '--binary', 'HEAD'],
      { encoding: 'utf8', timeout: 10000, maxBuffer: 750 * 1024 },
    );
    assert(diff.length > 0, 'Builder produced no committed diff.');
    source = Buffer.from(
      JSON.stringify({
        hostProofSha256: proof.proofSha256,
        integratedCommit: proof.integratedCommit,
        diff,
      }),
    );
    claims = [
      { id: 'feature.build.delegated-implementation', sourceKind: 'diff' },
    ];
  } else if (stage === 'review') {
    const receipt = await readBoundedFile(
      reviewerObservation.receipt.path,
      4 * 1024 * 1024,
    );
    assert.equal(
      createHash('sha256').update(receipt).digest('hex'),
      reviewerObservation.receipt.sha256,
      'Reviewer receipt changed.',
    );
    source = Buffer.from(
      JSON.stringify({
        hostProofSha256: proof.proofSha256,
        reviewerObservationSha256: workerReport.reviewer.observationSha256,
        integratedCommit: proof.integratedCommit,
        receiptSha256: createHash('sha256').update(receipt).digest('hex'),
      }),
    );
    claims = [{ id: 'feature.review.ordered-commits', sourceKind: 'review' }];
  } else if (stage === 'verify') {
    assert(
      Array.isArray(builderReceipt.verification) &&
        builderReceipt.verification.length > 0 &&
        builderReceipt.verification.every((item) => item.code === 0),
      'Matching-surface verification did not pass.',
    );
    source = Buffer.from(
      JSON.stringify({
        hostProofSha256: proof.proofSha256,
        integratedCommit: proof.integratedCommit,
        verification: builderReceipt.verification,
      }),
    );
    claims = [{ id: 'feature.verify.matching-surface', sourceKind: 'command' }];
  } else {
    const deliveryInput = JSON.parse(callerSource.content.toString());
    exactFields(deliveryInput, ['pullRequestUrl']);
    source = Buffer.from(
      JSON.stringify(
        verifyLocalPullRequest(
          proof.forge,
          proof.integratedCommit,
          deliveryInput.pullRequestUrl,
        ),
      ),
    );
    claims = [{ id: 'feature.delivery.pull-request', sourceKind: 'runtime' }];
  }
  assert(
    source.length <= 1024 * 1024,
    'Feature source evidence exceeds 1 MiB.',
  );
  return {
    ...result,
    evidence: [
      ...result.evidence.filter((item) => item.name !== 'source'),
      { name: 'source', kind: 'other', content: source },
    ],
    sourceRequirements: claims.map((claim) => ({
      ...claim,
      evidenceName: 'source',
    })),
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
      (extra.length === 0 ||
        (extra.length === 4 &&
          extra[0] === '--task-tracking' &&
          extra[2] === '--expected-task-tracking-sha256')),
    'Usage: node entry.mjs start --runtime ABS --request ABS_JSON | resume --runtime ABS --run-directory ABS [--task-tracking ABS_JSON --expected-task-tracking-sha256 HEX]',
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
  let capabilities = {
    host: 'experimental-local-host',
    available: [],
    missing: [...hostCapabilities],
    notes: {},
  };
  let input;
  let paths;
  let featureProof;
  if (mode === 'start') {
    const request = await readBoundedJson(
      absolute(inputArgument),
      CONFIG_BYTES,
    );
    exactFields(
      request,
      [
        'schemaVersion',
        'runId',
        'revision',
        'candidate',
        'runDirectory',
        'obligations',
      ],
      ['sourceProfile', 'featureHost'],
    );
    assert(request.schemaVersion === 1, 'Unsupported request schema.');
    identity(request);
    validateObligations(request.obligations, hostCapabilities);
    const candidate = {
      scopeId: request.candidate.scopeId,
      root: await directory(request.candidate.root),
    };
    if (request.sourceProfile === 'feature-v1') {
      const feature = await featureCapabilities(
        request.featureHost,
        request.runId,
        request.revision,
        candidate.root,
        hostCapabilities,
      );
      capabilities = feature.capabilities;
      featureProof = feature.proof;
    } else
      assert(
        request.featureHost === undefined,
        'Feature host proof is only valid for the feature profile.',
      );
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
      ...(request.sourceProfile === undefined
        ? {}
        : { sourceProfile: request.sourceProfile }),
      ...(request.featureHost === undefined
        ? {}
        : { featureHost: request.featureHost }),
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
    exactFields(
      input,
      [
        'schemaVersion',
        'runId',
        'revision',
        'candidate',
        'runDirectory',
        'plan',
        'capabilities',
        'expectedInitial',
        'runtimeManifestSha256',
      ],
      ['sourceProfile', 'featureHost'],
    );
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
    if (input.sourceProfile === 'feature-v1') {
      const feature = await featureCapabilities(
        input.featureHost,
        input.runId,
        input.revision,
        input.candidate.root,
        hostCapabilities,
      );
      capabilities = feature.capabilities;
      featureProof = feature.proof;
    } else
      assert(
        input.featureHost === undefined,
        'Feature host proof is only valid for the feature profile.',
      );
    assert.deepEqual(
      input.capabilities,
      capabilities,
      'Host capabilities differ from independently verified proof.',
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
  const sourceContract =
    input.sourceProfile === undefined
      ? null
      : await loadSourceContract(
          contracts,
          runtimeRoot,
          input.sourceProfile,
          input.capabilities,
        );
  if (sourceContract)
    assert.deepEqual(
      input.plan,
      sourceContract.plan,
      'Retained execution plan differs from the pinned source plan.',
    );
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
    if (sourceContract) {
      const retained =
        (await checkpoints.load(input.runId)) ??
        (await receipts.load(input.runId));
      await assertSourceEvidence(
        retained,
        evidenceStore,
        sourceContract,
        runtime,
      );
    }
    assert.equal(
      await receipts.load(input.runId),
      null,
      'Terminal workflow receipt already exists; use the persisted reader or a new run ID.',
    );
  }
  const tracking = await prepareTaskTracking({
    runtime,
    runtimeRoot,
    input,
    paths,
    sidecarPath: extra[1],
    expectedSha256: extra[3],
  });
  let trackingFailure;
  const store = {
    load: (id) => receipts.load(id),
    save: async (receipt) => {
      if (trackingFailure) throw trackingFailure;
      await nextTurn();
      if (receipt.status !== 'BLOCKED') session.assertHealthy();
      if (sourceContract && receipt.status === 'PASS')
        await assertSourceEvidence(
          receipt,
          evidenceStore,
          sourceContract,
          runtime,
          true,
        );
      const saved = await receipts.save(receipt);
      if (receipt.status !== 'BLOCKED') session.assertHealthy();
      return saved;
    },
  };
  const checkpointStore = {
    load: (id) => checkpoints.load(id),
    save: async (checkpoint) => {
      if (trackingFailure) throw trackingFailure;
      if (sourceContract)
        await assertSourceEvidence(
          checkpoint,
          evidenceStore,
          sourceContract,
          runtime,
        );
      return checkpoints.save(checkpoint);
    },
  };
  let receipt;
  try {
    receipt = await runtime.executeAndPersist({
      runId: input.runId,
      revision: input.revision,
      plan: input.plan,
      capabilities: input.capabilities,
      store,
      checkpointStore,
      stageEvidence: { store: evidenceStore },
      workspaceManifestStore,
      workspaceForStage: paths.workspaceForStage,
      candidate: {
        scope: invocationScope(input),
        expectedInitial: input.expectedInitial,
        knownWriteRoots: paths.knownWriteRoots,
      },
      handler: async (stage) => {
        try {
          await tracking?.start();
        } catch (error) {
          // The engine captures worker failures. A bookkeeping refusal must not
          // become an ISSUES stage, checkpoint or terminal engineering receipt.
          trackingFailure = error;
          throw error;
        }
        const result = await session.stage(
          stage,
          paths.workspaceForStage(stage).root,
          input.candidate,
        );
        if (!sourceContract || result.status !== 'PASS') return result;
        return attachSourceClaims(
          stage,
          featureProof
            ? await featureStageResult(stage, result, featureProof)
            : result,
          input,
          sourceContract,
        );
      },
      onStageCheckpoint: async (checkpoint) => {
        await session.emit({
          type: 'checkpoint',
          stage: checkpoint.stages.at(-1).stage,
        });
      },
    });
  } catch (error) {
    if (tracking?.started && !trackingFailure)
      await tracking.finish(await receipts.load(input.runId), error);
    throw error;
  }
  await tracking?.finish(receipt);
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
