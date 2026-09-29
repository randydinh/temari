import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const POLICY_BYTES = 64 * 1024;
const REQUEST_BYTES = 64 * 1024;
const MANIFEST_BYTES = 1024 * 1024;
const FILE_BYTES = 16 * 1024 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function readBoundedFile(path, limit) {
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
    'Usage: entry policy | admit --request ABS_JSON | start|resume|run-workers --request ABS_JSON --expected-request-sha256 HEX --expected-manifest-sha256 HEX | closeout verify --request ABS_JSON --expected-request-sha256 HEX --expected-manifest-sha256 HEX --expected-current ABS_JSON --expected-current-sha256 HEX',
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

async function admitEngineering(entry, request, policy, trusted = false) {
  exactFields(
    request,
    ['schemaVersion', 'entry', 'route', 'profile', 'obligations'],
    ['routeInput', 'invocation'],
  );
  const reasons = [];
  if (request.schemaVersion !== 1) reasons.push('unsupported-request-schema');
  if (request.entry !== entry) reasons.push('entry-mismatch');
  if (request.route === 'full-playbook') {
    if (request.profile !== 'feature-v1') reasons.push('profile-not-admitted');
    if (!compareObligations(request.obligations, policy.feature.obligations))
      reasons.push('obligations-not-admitted');
    if (request.routeInput || request.invocation)
      reasons.push('unexpected-route-input');
    if (reasons.length > 0)
      return {
        schemaVersion: 1,
        entry,
        status: 'rejected',
        reasons,
        policyId: policy.policyId,
      };
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

async function verifyBundle(expectedDigest) {
  assert.match(
    expectedDigest ?? '',
    /^[a-f0-9]{64}$/,
    'External artifact digest required.',
  );
  const manifestBytes = await readBoundedFile(
    join(root, 'public-entry-manifest.json'),
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
  await walk(root);
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
    const bytes = await readBoundedFile(join(root, record.path), record.bytes);
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
  return JSON.parse(
    utf8.decode(await readBoundedFile(join(root, 'policy.json'), POLICY_BYTES)),
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

async function startBridge(mode, request, policy) {
  const invocation = {
    schemaVersion: 1,
    ...request.invocation,
    obligations: policy.lightweight.obligations,
    sourceProfile: policy.entries[request.entry].supportedProfile,
  };
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
      core.createExecutionPlan(policy.lightweight.obligations),
      'Retained plan differs from admitted obligations.',
    );
    assert.equal(
      saved.sourceProfile,
      invocation.sourceProfile,
      'Retained source profile differs from admitted policy.',
    );
  }
  let temporary;
  try {
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
    ];
    const child = spawn(process.execPath, args, {
      stdio: 'inherit',
      env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
    });
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (value) => resolve(value ?? 1));
    });
    process.exitCode = code;
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

export async function run(entry, argv = process.argv.slice(2)) {
  const command = argv[0];
  const flag = argv[1];
  const argument = argv[2];
  const extra = argv.slice(3);
  const digestIndex = extra.indexOf('--expected-manifest-sha256');
  const requestDigestIndex = extra.indexOf('--expected-request-sha256');
  const trusted =
    command === 'start' ||
    command === 'resume' ||
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
    if (admission.status !== 'admitted') return finish(admission, 1);
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
    const result = await admitEngineering(entry, request, policy, true);
    if (result.status !== 'admitted') return finish(result, 1);
    await startBridge(command, request, policy);
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
