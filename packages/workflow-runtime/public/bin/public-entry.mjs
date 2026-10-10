import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  sep,
} from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const POLICY_BYTES = 64 * 1024;
const REQUEST_BYTES = 64 * 1024;
const MANIFEST_BYTES = 1024 * 1024;
const FILE_BYTES = 16 * 1024 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export async function readBoundedFile(path, limit) {
  const before = await lstat(path);
  assert(
    before.isFile() && !before.isSymbolicLink(),
    'Expected a regular file.',
  );
  assert(before.size <= limit, 'File exceeds the byte limit.');
  const file = await open(
    path,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = await file.stat();
    assert(
      stat.isFile() &&
        stat.dev === before.dev &&
        stat.ino === before.ino &&
        stat.size === before.size &&
        stat.size <= limit,
      'File changed before reading.',
    );
    const bytes = Buffer.alloc(stat.size + 1);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await file.read(
        bytes,
        used,
        bytes.length - used,
        null,
      );
      if (!bytesRead) break;
      used += bytesRead;
    }
    const after = await file.stat();
    assert(
      used === stat.size &&
        after.size === stat.size &&
        after.mtimeMs === stat.mtimeMs,
      'File changed while reading.',
    );
    return bytes.subarray(0, used);
  } finally {
    await file.close();
  }
}

async function readJson(path, limit) {
  assert(isAbsolute(path), 'Request path must be absolute.');
  return JSON.parse(utf8.decode(await readBoundedFile(path, limit)));
}

function exactFields(value, required, optional = []) {
  assert(
    value && typeof value === 'object' && !Array.isArray(value),
    'Expected a JSON object.',
  );
  assert(
    required.every((key) => Object.hasOwn(value, key)) &&
      Object.keys(value).every(
        (key) => required.includes(key) || optional.includes(key),
      ),
    'Request has unknown or missing fields.',
  );
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function finish(value, code = 0) {
  print(value);
  process.exitCode = code;
}

function usage() {
  throw new Error(
    'Usage: entry policy | admit --request ABS_JSON | start|resume --request ABS_JSON --expected-request-sha256 HEX --expected-manifest-sha256 HEX [--task-tracking ABS_JSON --expected-task-tracking-sha256 HEX] | run-workers --request ABS_JSON --expected-request-sha256 HEX --expected-manifest-sha256 HEX | temari qa|qa-resume|qa-result --request ABS_JSON --expected-request-sha256 HEX --expected-manifest-sha256 HEX [--qa-execution-selection ABS_JSON --expected-qa-execution-selection-sha256 HEX --task-tracking ABS_JSON --expected-task-tracking-sha256 HEX] | closeout verify --request ABS_JSON --expected-request-sha256 HEX --expected-manifest-sha256 HEX --expected-current ABS_JSON --expected-current-sha256 HEX',
  );
}

function policyDescription(entry, policy) {
  const selected = policy.entries[entry];
  return {
    schemaVersion: 1,
    entry,
    status: 'described',
    supportedRoute: selected.supportedRoute,
    supportedProfile: selected.supportedProfile,
    ...(selected.supportedRoutes === undefined
      ? {}
      : {
          supportedRoutes: selected.supportedRoutes,
          supportedProfiles: selected.supportedProfiles,
        }),
    ...(entry === 'temari'
      ? {
          qaRoute: 'qa-review',
          qaProfile: policy.qa.profile,
          qaHostStatus: policy.qa.evaluator,
          qaContract: {
            owner: policy.qa.owner,
            allowedActions: policy.qa.allowedActions,
            externalWrites: policy.qa.externalWrites,
            callerDeclaredCapabilitiesAreNotProof:
              policy.admission.callerDeclaredCapabilitiesAreNotProof,
          },
        }
      : {}),
    policyId: policy.policyId,
  };
}

function compareObligations(actual, expected) {
  return (
    Object.keys(expected).every((key) => actual?.[key] === expected[key]) &&
    Object.keys(actual ?? {}).every((key) => Object.hasOwn(expected, key))
  );
}

async function classifyLightweight(request, policy) {
  exactFields(request, [
    'schemaVersion',
    'entry',
    'route',
    'profile',
    'obligations',
    'routeInput',
    'invocation',
  ]);
  exactFields(request.routeInput, ['workType', 'lightweight']);
  exactFields(request.routeInput.lightweight, [
    'resultIsClearLocalAndReversible',
    'changesSharedBoundary',
    'isReportedDefect',
    'hasUnexplainedSymptom',
    'makesPerformanceClaim',
    'isDesignChoice',
    'isMigration',
    'affectedCallersAreKnown',
    'crossesArchitecturalBoundary',
    'directCheckAvailable',
  ]);
  assert(
    Object.values(request.routeInput.lightweight).every(
      (value) => typeof value === 'boolean',
    ),
    'Route conditions must be booleans.',
  );
  exactFields(request.invocation, [
    'runId',
    'revision',
    'candidate',
    'runDirectory',
  ]);
  exactFields(request.invocation.candidate, ['scopeId', 'root']);
  const require = createRequire(
    pathToFileURL(join(root, 'runtime/consumer.mjs')),
  );
  const core = await import(
    pathToFileURL(require.resolve('@temari/temari-core')).href
  );
  const decision = core.classifyEngineeringRoute(request.routeInput);
  return (
    decision.route === 'lightweight-engineering' &&
    request.routeInput.workType === policy.lightweight.obligations.workType
  );
}

export async function admitEngineering(entry, request, policy, trusted = false) {
  exactFields(
    request,
    ['schemaVersion', 'entry', 'route', 'profile', 'obligations'],
    ['routeInput', 'invocation', 'featureWorkers'],
  );
  const reasons = [];
  if (request.schemaVersion !== 1) reasons.push('unsupported-request-schema');
  if (request.entry !== entry) reasons.push('entry-mismatch');
  if (request.route === 'full-playbook') {
    if (request.profile !== 'feature-v1') reasons.push('profile-not-admitted');
    if (!compareObligations(request.obligations, policy.feature.obligations))
      reasons.push('obligations-not-admitted');
    if (request.routeInput) reasons.push('unexpected-route-input');
    if (reasons.length > 0)
      return {
        schemaVersion: 1,
        entry,
        status: 'rejected',
        reasons,
        policyId: policy.policyId,
      };
    if (!trusted || !request.invocation || !request.featureWorkers)
      return {
        schemaVersion: 1,
        entry,
        status: 'blocked',
        route: request.route,
        profile: request.profile,
        reasons: ['host-capability-proof-missing'],
        missingCapabilities: policy.feature.requiredCapabilities,
        policyId: policy.policyId,
      };
    exactFields(request.invocation, [
      'runId',
      'revision',
      'candidate',
      'runDirectory',
    ]);
    exactFields(request.invocation.candidate, ['scopeId', 'root']);
    exactFields(
      request.featureWorkers,
      [
        'evidenceRoot',
        'baseCommit',
        'timeoutMs',
        'architect',
        'builder',
        'owns',
        'verify',
        'reviewer',
      ],
      ['prepare'],
    );
    return {
      schemaVersion: 1,
      entry,
      status: 'pending-host-proof',
      route: request.route,
      profile: request.profile,
      policyId: policy.policyId,
    };
  }
  if (request.route !== 'lightweight-engineering')
    reasons.push('route-not-admitted');
  if (request.profile !== 'lightweight-engineering-v1')
    reasons.push('profile-not-admitted');
  if (!compareObligations(request.obligations, policy.lightweight.obligations))
    reasons.push('obligations-not-admitted');
  if (
    reasons.length === 0 &&
    trusted &&
    !(await classifyLightweight(request, policy))
  )
    reasons.push('lightweight-conditions-not-proven');
  if (reasons.length > 0) {
    return {
      schemaVersion: 1,
      entry,
      status: 'rejected',
      reasons,
      policyId: policy.policyId,
    };
  }
  return {
    schemaVersion: 1,
    entry,
    status: trusted ? 'admitted' : 'blocked',
    route: request.route,
    profile: request.profile,
    ...(trusted ? {} : { reasons: ['trusted-invocation-digest-missing'] }),
    policyId: policy.policyId,
  };
}

export async function verifyBundle(expectedDigest, artifactRoot = root) {
  assert.match(
    expectedDigest ?? '',
    /^[a-f0-9]{64}$/,
    'External artifact digest required.',
  );
  const manifestBytes = await readBoundedFile(
    join(artifactRoot, 'public-entry-manifest.json'),
    MANIFEST_BYTES,
  );
  assert.equal(
    sha256(manifestBytes),
    expectedDigest,
    'Artifact manifest digest differs from trusted value.',
  );
  const manifest = JSON.parse(utf8.decode(manifestBytes));
  assert(Array.isArray(manifest.files), 'Artifact inventory is missing.');
  const actual = [];
  async function walk(directory, prefix = '') {
    const stat = await lstat(directory);
    assert(
      stat.isDirectory() && !stat.isSymbolicLink(),
      'Artifact directory is not regular.',
    );
    for (const name of await readdir(directory)) {
      const path = prefix ? `${prefix}/${name}` : name;
      const selected = join(directory, name);
      const child = await lstat(selected);
      assert(!child.isSymbolicLink(), 'Artifact symlink is forbidden.');
      if (child.isDirectory()) await walk(selected, path);
      else {
        assert(child.isFile(), 'Artifact contains a nonregular file.');
        if (path !== 'public-entry-manifest.json') actual.push(path);
      }
    }
  }
  await walk(artifactRoot);
  const listed = manifest.files.map((record) => record.path);
  assert.deepEqual(
    actual.sort(),
    [...listed].sort(),
    'Artifact inventory differs from files.',
  );
  assert.equal(
    new Set(listed).size,
    listed.length,
    'Artifact inventory repeats a file.',
  );
  for (const record of manifest.files) {
    assert(
      typeof record.path === 'string' &&
        record.path.length > 0 &&
        !isAbsolute(record.path) &&
        !record.path
          .split('/')
          .some((part) => part === '..' || part === '.' || part === ''),
      'Unsafe artifact path.',
    );
    assert(
      Number.isSafeInteger(record.bytes) &&
        record.bytes >= 0 &&
        record.bytes <= FILE_BYTES,
      'Artifact file size is invalid.',
    );
    const bytes = await readBoundedFile(join(artifactRoot, record.path), record.bytes);
    assert.equal(
      bytes.length,
      record.bytes,
      `Artifact size changed: ${record.path}`,
    );
    assert.equal(
      sha256(bytes),
      record.sha256,
      `Artifact bytes changed: ${record.path}`,
    );
  }
  const { checkPstackMethodLibrary } = await import(
    pathToFileURL(join(artifactRoot, 'host/pstack-method-library.mjs')).href
  );
  const method = await checkPstackMethodLibrary(
    join(artifactRoot, 'method/pstack'),
  );
  assert.deepEqual(
    manifest.methodLibrary,
    {
      path: 'method/pstack',
      sourceRevision: method.catalog.sourceRevision,
      provenanceSha256: method.provenanceSha256,
      catalogSha256: method.catalogSha256,
    },
    'Method library differs from the pinned manifest.',
  );
  const sourceProvenance = manifest.source?.files?.filter(
    (record) => record.path === 'packages/workflow-runtime/provenance.json',
  );
  assert.equal(
    sourceProvenance?.length,
    1,
    'Method source provenance is missing or duplicated.',
  );
  assert.equal(
    sourceProvenance[0].sha256,
    method.provenanceSha256,
    'Method provenance differs from its source inventory.',
  );
  return JSON.parse(
    utf8.decode(await readBoundedFile(join(artifactRoot, 'policy.json'), POLICY_BYTES)),
  );
}

function trustedRequest(bytes, expectedDigest) {
  assert.match(
    expectedDigest ?? '',
    /^[a-f0-9]{64}$/,
    'External request digest required.',
  );
  assert.equal(
    sha256(bytes),
    expectedDigest,
    'Request bytes differ from trusted invocation.',
  );
  return JSON.parse(utf8.decode(bytes));
}

async function canonicalDirectory(path) {
  assert(
    typeof path === 'string' &&
      isAbsolute(path) &&
      !/[\x00-\x1f\x7f]/.test(path),
    'Expected an absolute directory without control characters.',
  );
  const stat = await lstat(path);
  assert(
    stat.isDirectory() && !stat.isSymbolicLink(),
    'Expected an existing nonsymlink directory.',
  );
  return realpath(path);
}

async function selectedRunDirectory(path, mode) {
  assert(
    typeof path === 'string' &&
      isAbsolute(path) &&
      !/[\x00-\x1f\x7f]/.test(path),
    'Expected an absolute run directory without control characters.',
  );
  if (mode === 'resume') return canonicalDirectory(path);
  const selected = normalize(path);
  assert.notEqual(
    dirname(selected),
    selected,
    'Run directory requires an existing parent.',
  );
  const canonical = join(
    await canonicalDirectory(dirname(selected)),
    basename(selected),
  );
  try {
    await lstat(canonical);
  } catch (error) {
    if (error.code === 'ENOENT') return canonical;
    throw error;
  }
  throw new Error('Run directory already exists.');
}

function assertDisjointRoots(...roots) {
  const contains = (parent, child) => {
    const part = relative(parent, child);
    return (
      part === '' ||
      (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`))
    );
  };
  for (let left = 0; left < roots.length; left++)
    for (let right = left + 1; right < roots.length; right++)
      assert(
        !contains(roots[left], roots[right]) &&
          !contains(roots[right], roots[left]),
        'Public candidate, artifact, run and feature evidence directories must be disjoint.',
      );
}

async function startBridge(mode, request, policy, digests, trackingSelection) {
  const feature = request.route === 'full-playbook';
  const sourceCandidateRoot = await canonicalDirectory(
    request.invocation.candidate.root,
  );
  const runDirectory = await selectedRunDirectory(
    request.invocation.runDirectory,
    mode,
  );
  const artifactRoot = await canonicalDirectory(root);
  const runtimeRoot = await canonicalDirectory(join(root, 'runtime'));
  assert.match(
    request.invocation.runId ?? '',
    feature
      ? /^[A-Za-z0-9][A-Za-z0-9._-]{0,109}$/
      : /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
    'Invalid public run ID.',
  );
  assert.match(
    request.invocation.candidate.scopeId ?? '',
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
    'Invalid candidate scope ID.',
  );
  assert(
    typeof request.invocation.revision === 'string' &&
      request.invocation.revision.trim().length > 0 &&
      Buffer.byteLength(request.invocation.revision) <= 512,
    'Invalid public revision.',
  );
  const hostBinding = {
    entry: request.entry,
    policyId: policy.policyId,
    requestSha256: digests.requestSha256,
    manifestSha256: digests.manifestSha256,
  };
  const featureContext = feature
    ? {
        sourceCandidateRoot,
        evidenceRoot: await canonicalDirectory(
          request.featureWorkers.evidenceRoot,
        ),
        hostBinding,
      }
    : undefined;
  assertDisjointRoots(
    sourceCandidateRoot,
    artifactRoot,
    runDirectory,
    ...(feature ? [featureContext.evidenceRoot] : []),
  );
  const require = createRequire(
    pathToFileURL(join(root, 'runtime/consumer.mjs')),
  );
  const runtime = await import(
    pathToFileURL(require.resolve('@temari/runtime')).href
  );
  const { prepareTaskTracking } = await import(
    pathToFileURL(join(root, 'host/task-tracking.mjs')).href
  );
  const tracking = await prepareTaskTracking({
    runtime,
    runtimeRoot,
    artifactRoot,
    featureContext,
    requiredSchemaVersion: feature ? 2 : 1,
    input: {
      runId: request.invocation.runId,
      revision: request.invocation.revision,
      runDirectory,
      candidate: { ...request.invocation.candidate, root: sourceCandidateRoot },
    },
    paths: {
      config: join(runDirectory, 'config'),
      stores: ['receipts', 'checkpoints', 'evidence', 'manifests'].map((name) =>
        join(runDirectory, name),
      ),
    },
    ...trackingSelection,
  });
  let temporary;
  let childOwnsOutcome = false;
  try {
    if (feature && mode === 'start') {
      await tracking?.reserve({ exclusive: true });
      await tracking?.start();
    }
    let invocation;
    if (feature) {
      const { runLocalFeatureHostProof, verifyLocalFeatureHostProof } =
        await import(pathToFileURL(join(root, 'host/feature-proof.mjs')).href);
      const workerInput = {
        runId: request.invocation.runId,
        revision: request.invocation.revision,
        candidateRoot: request.invocation.candidate.root,
        evidenceRoot: request.featureWorkers.evidenceRoot,
        baseCommit: request.featureWorkers.baseCommit,
        hostBinding,
      };
      let proof;
      if (mode === 'start') {
        proof = await runLocalFeatureHostProof({
          ...workerInput,
          ...Object.fromEntries(
            Object.entries(request.featureWorkers).filter(
              ([name]) => !['evidenceRoot', 'baseCommit'].includes(name),
            ),
          ),
          executable: 'codex',
        });
      } else {
        const saved = await readJson(
          join(request.invocation.runDirectory, 'config/input.json'),
          REQUEST_BYTES,
        );
        assert.deepEqual(saved.featureHost?.sourceCandidate, {
          ...request.invocation.candidate,
          root: await realpath(request.invocation.candidate.root),
        });
        assert.equal(
          saved.featureHost?.evidenceRoot,
          await realpath(workerInput.evidenceRoot),
        );
        assert.equal(saved.featureHost?.baseCommit, workerInput.baseCommit);
        assert.deepEqual(saved.featureHost?.hostBinding, hostBinding);
        proof = await verifyLocalFeatureHostProof({
          ...workerInput,
          proofSha256: saved.featureHost.proofSha256,
        });
      }
      invocation = {
        schemaVersion: 1,
        ...request.invocation,
        candidate: {
          ...request.invocation.candidate,
          root: proof.integrationPath,
        },
        obligations: policy.feature.obligations,
        sourceProfile: 'feature-v1',
        featureHost: {
          sourceCandidate: {
            ...request.invocation.candidate,
            root: await realpath(request.invocation.candidate.root),
          },
          evidenceRoot: await realpath(request.featureWorkers.evidenceRoot),
          baseCommit: request.featureWorkers.baseCommit,
          hostBinding,
          proofSha256: proof.proofSha256,
        },
      };
    } else
      invocation = {
        schemaVersion: 1,
        ...request.invocation,
        obligations:
          request.route === 'qa-review'
            ? policy.qa.obligations
            : policy.lightweight.obligations,
        ...(request.route === 'qa-review'
          ? {}
          : { sourceProfile: policy.entries[request.entry].supportedProfile }),
      };
    assert.deepEqual(
      Object.keys(invocation.candidate).sort(),
      ['root', 'scopeId'],
      `Invocation candidate fields differ: ${Object.keys(invocation.candidate).join(',')}`,
    );
    if (mode === 'resume') {
      const path = join(invocation.runDirectory, 'config/input.json');
      const saved = await readJson(path, REQUEST_BYTES);
      assert.equal(
        saved.runId,
        invocation.runId,
        'Retained run ID differs from trusted invocation.',
      );
      assert.equal(
        saved.revision,
        invocation.revision,
        'Retained revision differs from trusted invocation.',
      );
      assert.deepEqual(
        saved.candidate,
        {
          ...invocation.candidate,
          root: await realpath(invocation.candidate.root),
        },
        'Retained candidate differs from trusted invocation.',
      );
      assert.equal(
        saved.runDirectory,
        await realpath(invocation.runDirectory),
        'Retained run directory differs from trusted invocation.',
      );
      const require = createRequire(
        pathToFileURL(join(root, 'runtime/consumer.mjs')),
      );
      const core = await import(
        pathToFileURL(require.resolve('@temari/temari-core')).href
      );
      assert.deepEqual(
        saved.plan,
        core.createExecutionPlan(
          feature ? policy.feature.obligations : policy.lightweight.obligations,
        ),
        'Retained plan differs from admitted obligations.',
      );
      assert.equal(
        saved.sourceProfile,
        invocation.sourceProfile,
        'Retained source profile differs from admitted policy.',
      );
      if (feature)
        assert.deepEqual(
          saved.featureHost,
          invocation.featureHost,
          'Retained feature host proof differs from trusted invocation.',
        );
    }
    if (mode === 'start') {
      temporary = await mkdtemp(join(tmpdir(), 'temari-public-invocation-'));
      await writeFile(
        join(temporary, 'request.json'),
        JSON.stringify(invocation),
        { flag: 'wx', mode: 0o600 },
      );
    }
    const args = [
      join(root, 'host/entry.mjs'),
      mode,
      '--runtime',
      join(root, 'runtime'),
      mode === 'start' ? '--request' : '--run-directory',
      mode === 'start'
        ? join(temporary, 'request.json')
        : invocation.runDirectory,
      ...(trackingSelection?.sidecarPath === undefined
        ? []
        : [
            '--task-tracking',
            trackingSelection.sidecarPath,
            '--expected-task-tracking-sha256',
            trackingSelection.expectedSha256,
          ]),
    ];
    const child = spawn(process.execPath, args, {
      stdio: 'inherit',
      env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
    });
    const code = await new Promise((resolve, reject) => {
      child.once('spawn', () => {
        childOwnsOutcome = true;
      });
      child.once('error', reject);
      child.once('close', (value) => resolve(value ?? 1));
    });
    process.exitCode = code;
    return { code, pid: child.pid };
  } catch (error) {
    if (tracking?.started && !childOwnsOutcome)
      await tracking.finish(null, error);
    throw error;
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

async function startQa(request, requestSha256, policy, execution = {}) {
  exactFields(request, [
    'schemaVersion',
    'entry',
    'route',
    'profile',
    'assignment',
    'review',
    'invocation',
  ]);
  assert.equal(request.schemaVersion, 1, 'Unsupported QA request schema.');
  assert.equal(request.entry, 'temari', 'QA requires the Temari domain entry.');
  assert.equal(request.route, 'qa-review', 'QA requires its domain route.');
  assert.equal(request.profile, policy.qa.profile, 'Unsupported QA profile.');
  exactFields(request.invocation, [
    'runId',
    'revision',
    'candidate',
    'runDirectory',
    'evidenceRoot',
  ]);
  exactFields(request.invocation.candidate, ['scopeId', 'root']);
  assert(
    isAbsolute(request.invocation.runDirectory) &&
      isAbsolute(request.invocation.evidenceRoot),
    'Installed QA requires absolute local run and evidence paths.',
  );
  exactFields(request.review, [
    'reviewRevision',
    'authorId',
    'plan',
    'areaDecisions',
    'scenarios',
    'residualRisks',
  ], ['intentSources', 'projectVerifierId']);
  if (request.review.intentSources !== undefined) {
    assert(Array.isArray(request.review.intentSources) &&
      request.review.intentSources.length <= 64);
    request.review.intentSources.forEach((source) => exactFields(source,
      ['requirementRef', 'revision', 'authorityRef', 'expectedOutcome']));
  }
  exactFields(
    request.assignment,
    [
      'assignmentId',
      'requestKind',
      'tier',
      'requestedScope',
      'excludedScope',
      'ticketRef',
      'ticketRevision',
      'requirementRefs',
      'requirementRevisions',
      'candidateRef',
      'authority',
      'knownConstraints',
    ],
    ['environmentRef', 'missingEnvironmentBlocker'],
  );
  exactFields(request.assignment.authority, [
    'allowedActions',
    'deniedActions',
  ]);
  exactFields(request.review.plan, ['tier', 'objectives']);
  assert(
    Array.isArray(request.review.areaDecisions),
    'QA area decisions must be an array.',
  );
  request.review.areaDecisions.forEach((area) =>
    exactFields(area, ['area', 'status', 'basis']),
  );
  assert(
    Array.isArray(request.review.scenarios),
    'QA scenarios must be an array.',
  );
  request.review.scenarios.forEach((scenario) => {
    exactFields(scenario, [
      'scenarioId',
      'requirementRefs',
      'conditions',
      'expectedBehavior',
      'sourceRevision',
      'behavioralReason',
      'areaMappings',
      'obligation',
      'obligationRationale',
      'coverageBindings',
      'executions',
      'result',
      'nextAction',
    ]);
    assert(
      Array.isArray(scenario.coverageBindings),
      'QA coverage bindings must be an array.',
    );
    scenario.coverageBindings.forEach((binding) =>
      exactFields(binding, [
        'bindingId',
        'kind',
        'canonicalRef',
        'repositoryRevision',
        'assertionSummary',
        'designState',
        'implementationState',
        'writeReceiptRef',
      ]),
    );
  });
  assert.equal(
    request.assignment.requestKind,
    'full',
    'Installed QA requires a full assignment.',
  );
  assert.equal(
    request.assignment.candidateRef,
    request.invocation.revision,
    'QA candidate must match the invocation revision.',
  );
  const loadGuidance = async (path) => {
    const content = await readBoundedFile(join(root, path), 64 * 1024);
    return { path, sha256: sha256(content), text: utf8.decode(content) };
  };
  const guidance = {
    playbookId: 'ticket-acceptance-v1',
    playbook: await loadGuidance('qa/ticket-acceptance-v1.md'),
    evidenceSkill: await loadGuidance('skills/qa-review-verification/SKILL.md'),
    projectVerifier: { status: 'missing-project-profile', execution: 'not-observed' },
    execution: 'not-observed',
  };
  if (request.review.projectVerifierId !== undefined) {
    assert.equal(request.review.projectVerifierId, 'temari-public-v1',
      'Unsupported QA project verifier.');
    const marker = await readJson(join(request.invocation.candidate.root,
      'package.json'), 16 * 1024);
    assert.equal(marker.name, '@temari/workspace',
      'QA project profile differs from the candidate.');
    guidance.projectVerifier = {
      status: 'loaded-for-handoff', execution: 'not-observed',
      id: 'temari-public-v1',
      ...(await loadGuidance('qa/verify-temari-public-v1.md')),
    };
  }
  assert(
    Array.isArray(request.assignment.authority.allowedActions) &&
      request.assignment.authority.allowedActions.every((action) =>
        policy.qa.allowedActions.includes(action),
      ),
    'Installed QA does not permit external writes.',
  );
  assert(
    request.review.scenarios.every(
      (scenario) =>
        scenario.requirementRefs.every((ref) =>
          request.assignment.requirementRefs.includes(ref),
        ) &&
        request.assignment.requirementRevisions.includes(
          scenario.sourceRevision,
        ) &&
        scenario.coverageBindings.every(
          (binding) => binding.writeReceiptRef === null,
        ),
    ),
    'QA source references and write controls differ from the assignment.',
  );
  const require = createRequire(
    pathToFileURL(join(root, 'runtime/consumer.mjs')),
  );
  const core = await import(
    pathToFileURL(require.resolve('@temari/temari-core')).href
  );
  core.assertQaAssignment(request.assignment);
  const route = core.createRequestPlan({
    workType: 'qa',
    qaResponsibility: 'validation-disposition',
    lightweight: {
      resultIsClearLocalAndReversible: false,
      changesSharedBoundary: true,
      isReportedDefect: false,
      hasUnexplainedSymptom: false,
      makesPerformanceClaim: false,
      isDesignChoice: false,
      isMigration: false,
      affectedCallersAreKnown: true,
      crossesArchitecturalBoundary: true,
      directCheckAvailable: false,
    },
    obligations: policy.qa.obligations,
  });
  assert.equal(route.route.route, 'qa-review');
  assert.equal(route.route.owner, policy.qa.owner);
  assert.deepEqual(route.obligations, policy.qa.obligations);
  assert.deepEqual(route.plan.stages, policy.qa.stageMapping);
  if (execution.executionSelection) {
    const { runAdmittedQa } = await import(
      pathToFileURL(join(root, 'host/qa.mjs')).href
    );
    const { result, code } = await runAdmittedQa({
      ...execution, artifactRoot: root, request, requestSha256,
      policy, route, guidance, verifyArtifact: verifyBundle,
    });
    finish(result, code);
    return;
  }
  assert(!execution.trackingSelection,
    'Procedural QA does not admit current-task execution tracking.');
  const { runQaEvaluator } = await import(
    pathToFileURL(join(root, 'bin/qa-evaluator.mjs')).href
  );
  const evaluator = await runQaEvaluator({
    draft: {
      schemaVersion: 1,
      reviewRevision: request.review.reviewRevision,
      parentRevision: null,
      authorId: request.review.authorId,
      ...(request.review.intentSources === undefined ? {} : {
        intentSources: request.review.intentSources,
      }),
      assignment: request.assignment,
      plan: request.review.plan,
      areaDecisions: request.review.areaDecisions,
      scenarios: request.review.scenarios,
      residualRisks: request.review.residualRisks,
    },
    evidenceRoot: request.invocation.evidenceRoot,
  });
  assert.deepEqual(
    evaluator.record.externalWriteReceipts,
    [],
    'Installed QA must not create external writes.',
  );
  const result = {
    schemaVersion: 1,
    route: route.route,
    plan: route.plan,
    guidance,
    evaluator,
    qaDisposition: evaluator.qaDisposition,
    record: evaluator.record,
    delivery: {
      mode: 'local',
      externalWrites: 'denied',
      requestSha256,
      evaluatorLaunch: 'packaged-local-process',
    },
  };
  await mkdir(join(request.invocation.runDirectory, 'config'), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(
    join(request.invocation.runDirectory, 'config', 'qa-result.json'),
    `${JSON.stringify(result)}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  finish(result, evaluator.qaDisposition.disposition === 'Passed' ? 0 : 1);
}

export async function run(entry, argv = process.argv.slice(2)) {
  if (argv[0] === 'repair') {
    assert.equal(entry, 'temari', 'Same-task repair is owned by Temari.');
    assert(
      ['start', 'readmit', 'status', 'accept'].includes(argv[1]),
      'Unknown repair operation.',
    );
    const flags = new Map();
    const allowed = [
      '--request',
      '--expected-request-sha256',
      '--expected-manifest-sha256',
      '--task-selection',
      '--expected-task-selection-sha256',
    ];
    for (let index = 2; index < argv.length; index += 2) {
      assert(
        allowed.includes(argv[index]) &&
          !flags.has(argv[index]) &&
          argv[index + 1],
        'Repair requires complete unique flag pairs.',
      );
      flags.set(argv[index], argv[index + 1]);
    }
    assert(
      allowed.every((name) => flags.has(name)),
      'Repair request, artifact and independent current-task selection must be pinned.',
    );
    assert(
      isAbsolute(flags.get('--request')) &&
        isAbsolute(flags.get('--task-selection')),
      'Repair request and selection paths must be absolute.',
    );
    await verifyBundle(flags.get('--expected-manifest-sha256'));
    const request = trustedRequest(
      await readBoundedFile(flags.get('--request'), REQUEST_BYTES),
      flags.get('--expected-request-sha256'),
    );
    const selection = trustedRequest(
      await readBoundedFile(flags.get('--task-selection'), REQUEST_BYTES),
      flags.get('--expected-task-selection-sha256'),
    );
    const { runInstalledRepair } = await import(
      pathToFileURL(join(root, 'host/task-repair.mjs')).href
    );
    finish(
      await runInstalledRepair({
        mode: argv[1],
        request,
        selection,
        selectionPath: flags.get('--task-selection'),
        selectionSha256: flags.get('--expected-task-selection-sha256'),
        manifestSha256: flags.get('--expected-manifest-sha256'),
      }),
    );
    return;
  }
  const command = argv[0];
  const flag = argv[1];
  const argument = argv[2];
  const extra = argv.slice(3);
  const digestIndex = extra.indexOf('--expected-manifest-sha256');
  const requestDigestIndex = extra.indexOf('--expected-request-sha256');
  const trusted =
    command === 'start' ||
    command === 'resume' ||
    (entry === 'temari' && ['qa', 'qa-resume', 'qa-result'].includes(command)) ||
    command === 'run-workers' ||
    (entry === 'closeout' && command === 'verify');
  const policy = trusted
    ? await verifyBundle(extra[digestIndex + 1])
    : await readJson(join(root, 'policy.json'), POLICY_BYTES);
  assert(
    Object.hasOwn(policy.entries, entry),
    `Unknown public entry: ${entry}`,
  );
  if (command === 'policy' && argv.length === 1) {
    finish(policyDescription(entry, policy));
    return;
  }
  if (entry === 'temari' && ['qa', 'qa-resume', 'qa-result'].includes(command)) {
    if (flag !== '--request' || !isAbsolute(argument ?? '')) usage();
    const flags = new Map();
    const allowed = ['--expected-request-sha256', '--expected-manifest-sha256',
      '--qa-execution-selection', '--expected-qa-execution-selection-sha256',
      '--task-tracking', '--expected-task-tracking-sha256'];
    for (let index = 0; index < extra.length; index += 2) {
      assert(allowed.includes(extra[index]) && extra[index + 1] &&
        !flags.has(extra[index]), 'Invalid or duplicate QA selection flag.');
      flags.set(extra[index], extra[index + 1]);
    }
    assert(flags.has('--expected-request-sha256') &&
      flags.has('--expected-manifest-sha256'),
      'Trusted QA request and artifact digests are required.');
    const selected = flags.has('--qa-execution-selection');
    assert(selected === flags.has('--expected-qa-execution-selection-sha256') &&
      selected === flags.has('--task-tracking') &&
      selected === flags.has('--expected-task-tracking-sha256') &&
      (command === 'qa' || selected),
      'Executed QA requires both host-profile and current-task tracking selections.');
    const bytes = await readBoundedFile(argument, REQUEST_BYTES);
    const request = trustedRequest(bytes, extra[requestDigestIndex + 1]);
    await startQa(request, sha256(bytes), policy, {
      mode: command === 'qa-result' ? 'read-result' : command === 'qa-resume' ? 'resume' : 'start',
      manifestSha256: flags.get('--expected-manifest-sha256'),
      ...(selected ? {
        executionSelection: {
          path: flags.get('--qa-execution-selection'),
          expectedSha256: flags.get('--expected-qa-execution-selection-sha256'),
        },
        trackingSelection: {
          sidecarPath: flags.get('--task-tracking'),
          expectedSha256: flags.get('--expected-task-tracking-sha256'),
        },
      } : {}),
    });
    return;
  }
  if (command === 'run-workers' && entry !== 'closeout') {
    if (flag !== '--request' || !isAbsolute(argument ?? '')) usage();
    assert(
      extra.length === 4 &&
        digestIndex >= 0 &&
        requestDigestIndex >= 0 &&
        digestIndex % 2 === 0 &&
        requestDigestIndex % 2 === 0 &&
        digestIndex !== requestDigestIndex,
      'Both independent digests are required.',
    );
    const request = trustedRequest(
      await readBoundedFile(argument, REQUEST_BYTES),
      extra[requestDigestIndex + 1],
    );
    exactFields(
      request,
      [
        'schemaVersion',
        'entry',
        'runId',
        'revision',
        'candidateRoot',
        'evidenceRoot',
        'baseCommit',
        'timeoutMs',
        'builder',
        'owns',
        'verify',
        'reviewer',
      ],
      ['prepare'],
    );
    assert.equal(
      request.schemaVersion,
      1,
      'Unsupported worker request schema.',
    );
    assert.equal(
      request.entry,
      entry,
      'Worker entry differs from selected entry.',
    );
    const {
      schemaVersion: _schemaVersion,
      entry: _entry,
      ...workerInput
    } = request;
    const { runLocalFeatureWorkerPair } = await import(
      pathToFileURL(join(root, 'host/local-worker.mjs')).href
    );
    finish(
      await runLocalFeatureWorkerPair({
        ...workerInput,
        executable: 'codex',
        hostBinding: {
          entry,
          policyId: policy.policyId,
          requestSha256: extra[requestDigestIndex + 1],
          manifestSha256: extra[digestIndex + 1],
        },
      }),
    );
    return;
  }
  if (entry === 'closeout' && command === 'verify') {
    if (flag !== '--request' || !isAbsolute(argument ?? '')) usage();
    assert(
      extra.length === 8 &&
        new Set([extra[0], extra[2], extra[4], extra[6]]).size === 4 &&
        [
          '--expected-request-sha256',
          '--expected-manifest-sha256',
          '--expected-current',
          '--expected-current-sha256',
        ].every((name) =>
          [extra[0], extra[2], extra[4], extra[6]].includes(name),
        ),
      'Trusted request, artifact, and current candidate selection are required.',
    );
    const flags = Object.fromEntries([
      [extra[0], extra[1]],
      [extra[2], extra[3]],
      [extra[4], extra[5]],
      [extra[6], extra[7]],
    ]);
    const request = trustedRequest(
      await readBoundedFile(argument, REQUEST_BYTES),
      flags['--expected-request-sha256'],
    );
    assert(
      ['temari', 'poteto-mode'].includes(request.entry),
      'Closeout requires an admitted public engineering entry.',
    );
    const admission = await admitEngineering(
      request.entry,
      request,
      policy,
      true,
    );
    if (
      admission.status !== 'admitted' &&
      admission.status !== 'pending-host-proof'
    )
      return finish(admission, 1);
    assert(
      isAbsolute(flags['--expected-current']),
      'Current candidate selection path must be absolute.',
    );
    const currentBytes = await readBoundedFile(
      flags['--expected-current'],
      REQUEST_BYTES,
    );
    assert.match(
      flags['--expected-current-sha256'] ?? '',
      /^[a-f0-9]{64}$/,
      'External current candidate digest required.',
    );
    assert.equal(
      sha256(currentBytes),
      flags['--expected-current-sha256'],
      'Current candidate selection differs from trusted value.',
    );
    const expectedCurrent = JSON.parse(utf8.decode(currentBytes));
    const { verifyInstalledCloseout } = await import(
      pathToFileURL(join(root, 'host/closeout.mjs')).href
    );
    finish({
      schemaVersion: 1,
      entry,
      ...(await verifyInstalledCloseout({
        bundleRoot: root,
        policy,
        request,
        expectedCurrent,
        selectionPath: flags['--expected-current'],
        requestSha256: flags['--expected-request-sha256'],
        manifestSha256: flags['--expected-manifest-sha256'],
      })),
      policyId: policy.policyId,
    });
    return;
  }
  if (!['admit', 'start', 'resume'].includes(command) || argument === undefined)
    usage();

  if (entry === 'closeout') {
    if (
      command !== 'admit' ||
      flag !== '--run-directory' ||
      !isAbsolute(argument) ||
      extra.length
    )
      usage();
    finish(
      {
        schemaVersion: 1,
        entry,
        status: 'blocked',
        reasons: [
          'trusted-invocation-and-current-candidate-selection-required',
        ],
        policyId: policy.policyId,
      },
      1,
    );
    return;
  }

  if (flag !== '--request') usage();
  if (!isAbsolute(argument)) usage();
  if (trusted) {
    const names = extra.filter((_value, index) => index % 2 === 0);
    const allowed = [
      '--expected-request-sha256',
      '--expected-manifest-sha256',
      '--task-tracking',
      '--expected-task-tracking-sha256',
    ];
    assert(
      (extra.length === 4 || extra.length === 8) &&
        new Set(names).size === names.length &&
        names.every((name) => allowed.includes(name)) &&
        names.includes('--expected-request-sha256') &&
        names.includes('--expected-manifest-sha256') &&
        names.includes('--task-tracking') ===
          names.includes('--expected-task-tracking-sha256'),
      'Both independent digests and an optional complete task tracking pair are required; duplicate or unknown flags are forbidden.',
    );
    const flags = Object.fromEntries(
      names.map((name, index) => [name, extra[index * 2 + 1]]),
    );
    const trackingSelection =
      flags['--task-tracking'] === undefined
        ? undefined
        : {
            sidecarPath: flags['--task-tracking'],
            expectedSha256: flags['--expected-task-tracking-sha256'],
          };
    if (trackingSelection)
      assert(
        isAbsolute(trackingSelection.sidecarPath),
        'Task tracking sidecar path must be absolute.',
      );
    const request = trustedRequest(
      await readBoundedFile(argument, REQUEST_BYTES),
      flags['--expected-request-sha256'],
    );
    const result = await admitEngineering(entry, request, policy, true);
    if (result.status !== 'admitted' && result.status !== 'pending-host-proof')
      return finish(result, 1);
    await startBridge(
      command,
      request,
      policy,
      {
        requestSha256: flags['--expected-request-sha256'],
        manifestSha256: flags['--expected-manifest-sha256'],
      },
      trackingSelection,
    );
    return;
  }
  if (extra.length) usage();
  finish(
    await admitEngineering(
      entry,
      await readJson(argument, REQUEST_BYTES),
      policy,
    ),
    1,
  );
}
