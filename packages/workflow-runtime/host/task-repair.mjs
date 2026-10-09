import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import {
  access,
  mkdir,
  lstat,
  open,
  rename,
  realpath,
  readdir,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { inspect as inspectError } from 'node:util';
import { exactFields, readBoundedFile } from './stdio.mjs';
import {
  runLocalFeatureWorkerPair,
  verifyLocalFeatureWorkerPair,
} from './local-worker.mjs';
import { admitEngineering, verifyBundle } from '../bin/public-entry.mjs';
import { verifyLocalFeatureHostProof } from './feature-proof.mjs';

const script = fileURLToPath(import.meta.url);
const artifactRoot = dirname(dirname(script));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const bytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const gitEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
);
function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: gitEnv,
    timeout: 10000,
  }).trim();
}
async function directory(path) {
  assert(isAbsolute(path));
  const info = await lstat(path);
  assert(
    info.isDirectory() && !info.isSymbolicLink(),
    'Repair paths must be real directories.',
  );
  return realpath(path);
}
function disjoint(...roots) {
  for (const a of roots)
    for (const b of roots)
      if (a !== b) {
        const part = relative(a, b);
        assert(
          part &&
            (isAbsolute(part) || part === '..' || part.startsWith(`..${sep}`)),
          'Repair authority directories must be disjoint.',
        );
      }
  assert.equal(new Set(roots).size, roots.length, 'Repair roots must differ.');
}
async function json(path, expected) {
  const content = await readBoundedFile(path, 4 * 1024 * 1024);
  if (expected)
    assert.equal(sha(content), expected, 'Repair evidence digest changed.');
  return JSON.parse(content.toString());
}
async function optional(path) {
  try {
    return await json(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
async function publish(path, value) {
  try {
    await writeFile(path, bytes(value), { flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}
async function pulse(path, value) {
  const temporary = `${path}.${randomUUID()}`;
  await writeFile(temporary, bytes(value), { flag: 'wx', mode: 0o600 });
  await rename(temporary, path);
}
function pinnedCandidate(root, revision) {
  assert.equal(git(root, 'rev-parse', '--show-toplevel'), root);
  assert.equal(
    git(root, 'rev-parse', 'HEAD'),
    revision,
    'Repair candidate HEAD changed.',
  );
  assert.equal(
    git(root, 'status', '--porcelain=v1', '--untracked-files=all'),
    '',
    'Repair candidate must be clean.',
  );
}
async function loadRuntime() {
  const require = createRequire(
    pathToFileURL(join(artifactRoot, 'runtime/consumer.mjs')),
  );
  return import(pathToFileURL(require.resolve('@temari/runtime')).href);
}
async function loadContracts() {
  const require = createRequire(
    pathToFileURL(join(artifactRoot, 'runtime/consumer.mjs')),
  );
  return import(pathToFileURL(require.resolve('@temari/contracts')).href);
}
export async function retainRepairControllerFailure(
  runtime,
  root,
  repair,
  error,
) {
  const store = await runtime.FileEvidenceStore.create(
    join(root, 'failure-evidence'),
  );
  const complete = inspectError(error, {
    depth: null,
    maxStringLength: null,
    maxArrayLength: null,
    customInspect: false,
    getters: false,
  });
  const reference = await store.putStream({
    runId: repair.admission.executionId,
    revision: repair.admission.revision,
    kind: 'stderr',
    content: (async function* () {
      for (let offset = 0; offset < complete.length;) {
        let end = Math.min(offset + 16384, complete.length);
        if (end < complete.length && /[\uD800-\uDBFF]/.test(complete[end - 1]))
          end--;
        yield Buffer.from(complete.slice(offset, end));
        offset = end;
      }
    })(),
  });
  await store.verifyPortable(reference);
  const { path: _privatePath, ...evidence } = reference;
  const sources = [];
  try {
    const path = join(root, 'supervisor.log');
    const info = await lstat(path);
    assert(
      info.isFile() && !info.isSymbolicLink(),
      'Controller log is nonregular.',
    );
    const raw = await store.putStream({
      runId: repair.admission.executionId,
      revision: repair.admission.revision,
      kind: 'stderr',
      content: createReadStream(path),
    });
    await store.verifyPortable(raw);
    const { path: _rawPath, ...portable } = raw;
    sources.push(portable);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const observation = {
    schemaVersion: 1,
    launchId: repair.launch.launchId,
    reportSha256: repair.reportSha256,
    selectionSha256: repair.admission.selectionSha256,
    evidence,
    sources,
  };
  const observationSha256 = sha(bytes(observation)),
    location = join(root, `controller-failure-${observationSha256}.json`);
  await publish(location, observation);
  return {
    evidence,
    reference: {
      kind: 'repair-controller-failure',
      location,
      sha256: observationSha256,
    },
  };
}
async function verifyControllerFailures(runtime, root, repair, terminalRef) {
  for (const ref of [repair.launch.diagnosticRef, terminalRef].filter(
    Boolean,
  )) {
    assert.equal(ref.kind, 'repair-controller-failure');
    assert.equal(
      ref.location,
      join(root, `controller-failure-${ref.sha256}.json`),
    );
    await json(ref.location, ref.sha256);
  }
  const names = await readdir(root);
  for (const name of names.filter((name) =>
    /^controller-failure-[a-f0-9]{64}\.json$/.test(name),
  )) {
    const observation = await json(join(root, name), name.slice(19, -5));
    assert.equal(observation.launchId, repair.launch.launchId);
    assert.equal(observation.reportSha256, repair.reportSha256);
    assert.equal(observation.selectionSha256, repair.admission.selectionSha256);
    const store = await runtime.FileEvidenceStore.openExisting(
      join(root, 'failure-evidence'),
    );
    for (const ref of [observation.evidence, ...observation.sources])
      await store.verifyPortable(ref);
  }
}
function commands(values) {
  assert(Array.isArray(values) && values.length > 0 && values.length <= 16);
  for (const value of values) {
    exactFields(value, ['program', 'args']);
    assert(isAbsolute(value.program));
    assert(
      Array.isArray(value.args) &&
        value.args.length < 128 &&
        value.args.every(
          (arg) =>
            typeof arg === 'string' && arg.length < 4096 && !arg.includes('\0'),
        ),
    );
  }
}

async function assertPinnedHelperArgv(command, candidateRoot) {
  for (const arg of command.args) {
    if (
      isAbsolute(arg) ||
      arg.startsWith('-') ||
      ['$CANDIDATE', '$ARTIFACT'].includes(arg)
    )
      continue;
    let file = false;
    try {
      const info = await lstat(join(candidateRoot, arg));
      file = info.isFile() || info.isSymbolicLink();
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
    assert(
      !file &&
        !/^(?:\.\.?\/)|\.(?:[cm]?js|[cm]?ts|py|sh|rb|pl|json|wasm)$/.test(arg),
      'Build/regression helper or input file argv must use an absolute independently pinned path; artifact-under-test arguments use explicit placeholders.',
    );
  }
}

async function authority(selection, task, repair) {
  exactFields(selection, [
    'schemaVersion',
    'taskRoot',
    'taskId',
    'workspaceRoot',
    'authority',
    'owningInvocation',
  ]);
  exactFields(selection.authority, ['path', 'sha256']);
  assert.equal(selection.schemaVersion, 1);
  assert.equal(selection.taskId, task.taskId);
  assert.equal(
    await directory(selection.workspaceRoot),
    await directory(task.workspaceRoot),
    'Repair task workspace changed.',
  );
  const linked = task.events.some(
    (event) =>
      event.change.type === 'handoff-recorded' &&
      event.change.handoff.contextRefs.some(
        (ref) =>
          ref.kind === 'repair-authority' &&
          ref.location === selection.authority.path &&
          ref.sha256 === selection.authority.sha256,
      ),
  );
  assert(
    linked,
    'Repair profile continuity link is missing from the selected task.',
  );
  exactFields(selection.owningInvocation, [
    'artifactRoot',
    'manifestSha256',
    'requestPath',
    'requestSha256',
    'hostProofSha256',
  ]);
  const owner = selection.owningInvocation;
  const owningPolicy = await verifyBundle(
    owner.manifestSha256,
    await directory(owner.artifactRoot),
  );
  const request = await json(owner.requestPath, owner.requestSha256);
  assert(
    ['temari', 'poteto-mode'].includes(request.entry),
    'Repair needs an owning public engineering invocation.',
  );
  const admission = await admitEngineering(
    request.entry,
    request,
    owningPolicy,
    true,
  );
  assert(
    ['admitted', 'pending-host-proof'].includes(admission.status),
    `Owning engineering invocation is not admitted: ${(admission.reasons ?? []).join(', ')}.`,
  );
  assert.equal(
    await directory(request.invocation.candidate.root),
    await directory(task.workspaceRoot),
    'Owning invocation does not belong to this task workspace.',
  );
  const p = await json(selection.authority.path, selection.authority.sha256);
  exactFields(p, [
    'schemaVersion',
    'id',
    'taskId',
    'workspaceRoot',
    'candidateRoot',
    'baseCommit',
    'evidenceRoot',
    'scopes',
    'regressionContract',
    'executable',
    'executableSha256',
    'timeoutMs',
    'builder',
    'reviewer',
    'owns',
    'verify',
    'prepare',
    'baselineArtifact',
    'buildArtifact',
    'regression',
    'commandInputs',
  ]);
  assert.equal(p.schemaVersion, 1);
  assert.equal(p.taskId, task.taskId);
  assert.equal(
    await directory(p.workspaceRoot),
    await directory(task.workspaceRoot),
  );
  assert.match(p.id, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
  assert.match(p.baseCommit, /^[a-f0-9]{40,64}$/);
  assert.match(p.regressionContract, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
  assert(
    Array.isArray(p.scopes) &&
      p.scopes.length > 0 &&
      p.scopes.every((scope) =>
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(scope),
      ),
  );
  assert(
    Number.isInteger(p.timeoutMs) &&
      p.timeoutMs >= 1000 &&
      p.timeoutMs <= 600000,
  );
  assert(isAbsolute(p.executable));
  assert.equal(
    (await logIdentity(p.executable)).sha256,
    p.executableSha256,
    'Repair executable changed.',
  );
  assert.equal(p.builder.role, 'implementer');
  assert.equal(p.reviewer.role, 'reviewer');
  assert.notEqual(p.builder.id, p.reviewer.id);
  assert(Array.isArray(p.owns) && p.owns.length > 0);
  for (const own of p.owns) {
    exactFields(own, ['kind', 'path']);
    assert(['file', 'directory'].includes(own.kind));
    assert(
      typeof own.path === 'string' &&
        own.path &&
        !isAbsolute(own.path) &&
        !own.path.split('/').some((part) => ['.', '..', '.git'].includes(part)),
    );
  }
  commands(p.verify);
  if (p.prepare.length) commands(p.prepare);
  commands([p.buildArtifact]);
  commands(p.regression);
  for (const command of [p.buildArtifact, ...p.regression])
    await assertPinnedHelperArgv(
      command,
      repair?.admission.frozenCandidate.root ?? p.candidateRoot,
    );
  assert(
    Array.isArray(p.commandInputs) &&
      p.commandInputs.length > 0 &&
      p.commandInputs.length <= 64,
    'Pinned command input identities are required.',
  );
  for (const ref of p.commandInputs) {
    exactFields(ref, ['path', 'sha256']);
    assert(isAbsolute(ref.path) && /^[a-f0-9]{64}$/.test(ref.sha256));
  }
  assert.equal(
    new Set(p.commandInputs.map((ref) => ref.path)).size,
    p.commandInputs.length,
  );
  const transportRef = p.commandInputs.find((ref) => ref.path === p.executable);
  if (transportRef) assert.equal(transportRef.sha256, p.executableSha256);
  else p.commandInputs.push({ path: p.executable, sha256: p.executableSha256 });
  for (const command of [
    ...p.verify,
    ...p.prepare,
    p.buildArtifact,
    ...p.regression,
  ]) {
    assert(
      p.commandInputs.some((ref) => ref.path === command.program),
      'Command executable bytes must be independently pinned.',
    );
    for (const arg of command.args.filter(isAbsolute)) {
      const info = await lstat(arg);
      assert(
        !info.isSymbolicLink(),
        'Symlink direct helper/input arguments are not supported; select a regular absolute pinned file.',
      );
      if (info.isFile())
        assert(
          p.commandInputs.some((ref) => ref.path === arg),
          'Command helper/input bytes must be independently pinned.',
        );
    }
  }
  await verifyCommandInputs(p.commandInputs);
  exactFields(p.baselineArtifact, ['root', 'manifestSha256']);
  p.candidateRoot = await directory(p.candidateRoot);
  p.evidenceRoot = await directory(p.evidenceRoot);
  p.baselineArtifact.root = await directory(p.baselineArtifact.root);
  disjoint(
    p.candidateRoot,
    p.evidenceRoot,
    artifactRoot,
    await directory(selection.taskRoot),
  );
  if (!repair) pinnedCandidate(p.candidateRoot, p.baseCommit);
  assert(
    p.scopes.every((scope) => scope === request.invocation.candidate.scopeId),
    'Repair profile widens the admitted owning scope.',
  );
  if (request.route === 'full-playbook') {
    assert(
      /^[a-f0-9]{64}$/.test(owner.hostProofSha256 ?? ''),
      'Owning feature is pending host proof; profile and handoff cannot admit repair.',
    );
    const proof = repair
      ? await json(
          repair.admission.authorityRef.location,
          repair.admission.authorityRef.sha256,
        )
      : await verifyLocalFeatureHostProof({
          runId: request.invocation.runId,
          revision: request.invocation.revision,
          candidateRoot: request.invocation.candidate.root,
          evidenceRoot: request.featureWorkers.evidenceRoot,
          baseCommit: request.featureWorkers.baseCommit,
          hostBinding: {
            entry: request.entry,
            policyId: owningPolicy.policyId,
            requestSha256: owner.requestSha256,
            manifestSha256: owner.manifestSha256,
          },
          proofSha256: owner.hostProofSha256,
        });
    assert.equal(
      p.candidateRoot,
      repair ? proof.originalCandidateRoot : proof.integrationPath,
      'Repair must use the owning verified integration candidate.',
    );
    assert.equal(
      p.baseCommit,
      repair ? proof.frozenCandidate.revision : proof.integratedCommit,
    );
    if (!repair)
      p.authorityEvidence = await collectPinnedReferences(
        proof.proofPath,
        proof.proofSha256,
      );
    for (const own of p.owns)
      assert(
        request.featureWorkers.owns.some((allowed) =>
          allowed.kind === 'file'
            ? own.kind === 'file' && own.path === allowed.path
            : own.path === allowed.path ||
              own.path.startsWith(`${allowed.path}/`),
        ),
        'Repair ownership exceeds the owning invocation.',
      );
  } else {
    assert.equal(owner.hostProofSha256, null);
    assert.equal(
      p.candidateRoot,
      await directory(request.invocation.candidate.root),
    );
    assert.equal(
      p.baseCommit,
      request.invocation.revision,
      'Repair candidate differs from the admitted lightweight revision.',
    );
  }
  let hostExecutable = null;
  for (const entry of (process.env.PATH ?? '').split(delimiter)) {
    try {
      const selected = await realpath(join(entry || '.', 'codex'));
      await access(selected, constants.X_OK);
      hostExecutable = selected;
      break;
    } catch {}
  }
  assert.equal(
    p.executable,
    hostExecutable,
    'Repair executable is not the independently selected local Codex transport.',
  );
  p.owningRoute = request.route;
  if (repair) {
    const retained = await json(
      repair.admission.authorityRef.location,
      repair.admission.authorityRef.sha256,
    );
    assert.equal(retained.selectionSha256, repair.admission.selectionSha256);
    assert.equal(retained.profileSha256, selection.authority.sha256);
    assert.equal(retained.owningRequestSha256, owner.requestSha256);
    assert.equal(retained.owningManifestSha256, owner.manifestSha256);
    assert.equal(retained.owningRoute, request.route);
    assert.deepEqual(
      retained.frozenCandidate,
      repair.admission.frozenCandidate,
    );
    for (const ref of retained.authorityEvidence)
      await verifyPinnedReference(ref);
    p.candidateRoot = await directory(repair.admission.frozenCandidate.root);
    pinnedCandidate(p.candidateRoot, p.baseCommit);
    assert.equal(
      git(p.candidateRoot, 'rev-parse', 'HEAD^{tree}'),
      repair.admission.frozenCandidate.tree,
      'Frozen repair candidate tree changed.',
    );
  }
  await verifyBundle(
    p.baselineArtifact.manifestSha256,
    p.baselineArtifact.root,
  );
  return p;
}
async function verifyCommandInputs(refs) {
  for (const ref of refs)
    assert.equal(
      (await logIdentity(ref.path)).sha256,
      ref.sha256,
      `Pinned command/helper/input bytes changed: ${ref.path}`,
    );
}
async function verifyPinnedReference(ref) {
  assert.equal(
    (await logIdentity(ref.path)).sha256,
    ref.sha256,
    'Retained owning authority evidence changed.',
  );
}
async function collectPinnedReferences(path, sha256) {
  const refs = new Map();
  async function visit(path, expected, depth = 0) {
    assert(
      depth < 12 && refs.size < 256,
      'Owning authority evidence exceeds the bounded metadata graph.',
    );
    if (refs.has(path)) {
      assert.equal(refs.get(path), expected);
      return;
    }
    await verifyPinnedReference({ path, sha256: expected });
    refs.set(path, expected);
    if (!path.endsWith('.json')) return;
    const value = await json(path, expected);
    async function scan(value) {
      if (!value || typeof value !== 'object') return;
      for (const [pathKey, hashKey] of [
        ['path', 'sha256'],
        ['observationPath', 'observationSha256'],
        ['reportPath', 'reportSha256'],
        ['patchPath', 'sha256'],
      ])
        if (
          typeof value[pathKey] === 'string' &&
          isAbsolute(value[pathKey]) &&
          /^[a-f0-9]{64}$/.test(value[hashKey] ?? '')
        )
          await visit(value[pathKey], value[hashKey], depth + 1);
      for (const child of Object.values(value)) await scan(child);
    }
    await scan(value);
  }
  await visit(path, sha256);
  return [...refs].map(([path, sha256]) => ({ path, sha256 }));
}
function rootFor(p, repair) {
  return join(p.evidenceRoot, repair.launch.launchId);
}
function pairInput(p, repair, manifestSha256) {
  return {
    runId: repair.admission.executionId,
    revision: p.baseCommit,
    candidateRoot: p.candidateRoot,
    evidenceRoot: join(rootFor(p, repair), 'workers'),
    baseCommit: p.baseCommit,
    executable: p.executable,
    timeoutMs: p.timeoutMs,
    builder: p.builder,
    reviewer: p.reviewer,
    owns: p.owns,
    verify: p.verify,
    prepare: p.prepare,
    hostBinding: {
      entry: 'temari',
      policyId: 'same-task-systemic-repair-v1',
      requestSha256: repair.reportSha256,
      manifestSha256,
    },
  };
}
async function childRequest(runtime, p, repair) {
  const { minimalPlan, HOST_CAPABILITIES } = await loadContracts();
  return {
    runId: repair.admission.executionId,
    revision: p.baseCommit,
    plan: { ...minimalPlan('bug'), parallelism: { maxConcurrency: 1 } },
    capabilities: {
      host: 'local-task-repair',
      available: [],
      missing: HOST_CAPABILITIES,
      notes: {},
    },
    assignments: [p.builder],
    childStore: await runtime.FileChildTaskStore.create(
      repair.admission.childRef.storeRoot,
    ),
    owner: `repair:${repair.launch.launchId}`,
    maxConcurrency: 1,
  };
}

/** The three host operations share one task-ledger reservation; no retry port. */
export async function selectedRepairHost({
  runtime,
  selection,
  selectionPath,
  manifestSha256,
  selectionSha256,
}) {
  const check = async (task, repair) => {
    const p = await authority(selection, task, repair);
    assert.equal(
      repair.admission.selectionSha256,
      selectionSha256,
      'Repair authority selection changed.',
    );
    assert.equal(
      repair.admission.manifestSha256,
      manifestSha256,
      'Repair host artifact changed.',
    );
    assert.equal(p.id, repair.admission.selectionId);
    for (const ref of repair.report.evidenceRefs) await jsonOrBytes(ref);
    return p;
  };
  async function inspect(task, repair) {
    const p = await check(task, repair),
      root = rootFor(p, repair);
    const intent = await optional(join(root, 'intent.json'));
    const reference = await optional(join(root, 'observed.json'));
    const heartbeat = await optional(join(root, 'heartbeat.json'));
    const ended = await optional(join(root, 'ended.json'));
    await verifyControllerFailures(runtime, root, repair, ended?.failureRef);
    const worker = await optional(join(root, 'worker-start.json'));
    const issues = [];
    if (!intent)
      return {
        reference: null,
        workerStarted: false,
        heartbeatCurrent: false,
        drained: false,
        issues: [
          'Repair launch reservation has no independently observed supervisor.',
        ],
      };
    assert.equal(intent.launchId, repair.launch.launchId);
    assert.equal(intent.reportSha256, repair.reportSha256);
    assert.equal(intent.selectionSha256, selectionSha256);
    if (reference) {
      runtime.assertRepairReference(reference);
      assert.equal(reference.supervisorId, intent.nonce);
      assert.equal(reference.launchId, repair.launch.launchId);
      assert.equal(reference.executionId, repair.admission.executionId);
      assert.equal(reference.manifestSha256, manifestSha256);
      assert.equal(reference.evidenceRoot, root);
      if (repair.launch.reference)
        assert.deepEqual(
          reference,
          repair.launch.reference,
          'Repair supervisor observation changed.',
        );
    }
    if (worker) {
      exactFields(worker, [
        'taskId',
        'repairId',
        'launchId',
        'executionId',
        'manifestSha256',
        'selectionSha256',
        'supervisorId',
        'processPath',
        'processSha256',
        'process',
      ]);
      assert.equal(worker.taskId, task.taskId);
      assert.equal(worker.repairId, repair.report.repairId);
      assert.equal(worker.launchId, repair.launch.launchId);
      assert.equal(worker.executionId, repair.admission.executionId);
      assert.equal(worker.manifestSha256, manifestSha256);
      assert.equal(worker.selectionSha256, selectionSha256);
      assert.equal(worker.supervisorId, intent.nonce);
      const expectedPath = join(
        root,
        'workers',
        repair.admission.executionId,
        'build',
        `${repair.admission.executionId}-build`,
        `evidence-${p.builder.id}`,
        'process-start.json',
      );
      assert.equal(worker.processPath, expectedPath);
      assert.deepEqual(
        await json(expectedPath, worker.processSha256),
        worker.process,
      );
      assert(worker.process.pid > 0 && worker.process.pid !== reference?.pid);
      assert.equal(worker.process.assignmentId, p.builder.id);
      assert.equal(worker.process.executable, p.executable);
      assert.equal(worker.process.sandbox, 'workspace-write');
      assert.equal(
        worker.process.workspaceRoot,
        join(dirname(expectedPath), '..', `worker-${p.builder.id}`),
      );
    }
    if (ended) {
      assert.equal(ended.nonce, intent.nonce);
      assert.equal(ended.launchId, repair.launch.launchId);
    }
    return {
      reference,
      workerStarted: Boolean(worker),
      heartbeatCurrent: Boolean(
        reference &&
        heartbeat?.nonce === intent.nonce &&
        Date.now() - heartbeat.at < 5000,
      ),
      drained: Boolean(ended?.workersDrained),
      issues,
    };
  }
  async function verify(task, repair, selected) {
    const p = await check(task, repair),
      root = rootFor(p, repair);
    const ended = await json(join(root, 'ended.json'));
    assert.equal(ended.launchId, repair.launch.launchId);
    assert.equal(ended.workersDrained, true);
    assert.equal(ended.completed, true, 'Repair supervisor did not complete.');
    const proofPath = join(root, 'regression.json'),
      proofBytes = await readBoundedFile(proofPath, 4 * 1024 * 1024),
      proof = JSON.parse(proofBytes.toString());
    assert.equal(
      ended.proofSha256,
      sha(proofBytes),
      'Repair regression evidence changed.',
    );
    assert.equal(proof.launchId, repair.launch.launchId);
    assert.equal(proof.reportSha256, repair.reportSha256);
    assert.equal(proof.selectionSha256, selectionSha256);
    assert.equal(proof.contract, repair.report.regressionContract);
    const input = pairInput(p, repair, manifestSha256);
    const pair = await verifyLocalFeatureWorkerPair({
      runId: input.runId,
      revision: input.revision,
      candidateRoot: input.candidateRoot,
      evidenceRoot: input.evidenceRoot,
      baseCommit: input.baseCommit,
      hostBinding: input.hostBinding,
      reportSha256: proof.pairSha256,
    });
    assert.equal(pair.integratedCommit, proof.revision);
    assert.equal(pair.integrationPath, proof.candidateRoot);
    const start = await json(
      join(root, 'worker-start.json'),
      proof.workerStartSha256,
    );
    assert.equal(
      start.process.pid,
      pair.builder.pid,
      'Repair worker start differs from the completed builder.',
    );
    const builderObservation = await json(
      pair.builder.observationPath,
      pair.builder.observationSha256,
    );
    assert.equal(
      start.process.startedAt,
      builderObservation.worker.startedAt,
      'Repair worker process start identity changed.',
    );
    pinnedCandidate(proof.candidateRoot, proof.revision);
    await verifyBundle(proof.manifestSha256, proof.artifactRoot);
    const freshManifest = await json(
      join(proof.artifactRoot, 'public-entry-manifest.json'),
      proof.manifestSha256,
    );
    assert.equal(
      freshManifest.source.revision,
      proof.revision,
      'Reopened artifact candidate differs from the repaired revision.',
    );
    assert.equal(freshManifest.source.dirty, false);
    assert(
      Array.isArray(freshManifest.source.files) &&
        freshManifest.source.files.length > 0,
      'Fresh artifact source inventory is missing.',
    );
    for (const file of freshManifest.source.files) {
      assert(
        typeof file.path === 'string' &&
          !isAbsolute(file.path) &&
          !file.path.split('/').some((part) => ['', '.', '..'].includes(part)),
        'Fresh artifact source path is invalid.',
      );
      assert.equal(
        sha(
          await readBoundedFile(
            join(proof.candidateRoot, file.path),
            16 * 1024 * 1024,
          ),
        ),
        file.sha256,
        'Fresh installed artifact source differs from the repair candidate.',
      );
    }
    const expectedArtifactRoot = join(root, 'fresh-artifact');
    assert.equal(proof.artifactRoot, expectedArtifactRoot);
    assert.deepEqual(proof.baselineArtifact, p.baselineArtifact);
    assert.equal(proof.baseline.length, p.regression.length);
    assert.equal(proof.fresh.length, p.regression.length);
    for (const [kind, commandsForKind, expectedCode] of [
      ['baseline', p.regression, null],
      ['fresh', p.regression, 0],
      ['build', [p.buildArtifact], 0],
    ]) {
      for (let index = 0; index < commandsForKind.length; index++) {
        const record = proof[kind][index];
        assert(record && record.pid > 0 && record.pid !== process.pid);
        assert.equal(
          record.exitCode === 0,
          expectedCode === 0,
          'Preserved counterexample or fresh-install regression did not have the required outcome.',
        );
        assert.deepEqual(record.command, commandsForKind[index]);
        assert.deepEqual(
          record.inputs,
          p.commandInputs,
          'Regression command byte identities changed.',
        );
        await verifyCommandInputs(record.inputs);
        const observation = await json(
          join(root, `${kind}-${index}.json`),
          record.sha256,
        );
        const { sha256: _hash, ...retained } = record;
        assert.deepEqual(observation, retained);
        for (const stream of ['stdout', 'stderr']) {
          assert.equal(
            record[stream].path,
            join(root, `${kind}-${index}.json.${stream}.log`),
          );
          assert.deepEqual(
            await logIdentity(record[stream].path),
            record[stream],
            'Retained repair diagnostics changed.',
          );
        }
      }
    }
    const selectionResult = {
      candidateRoot: proof.candidateRoot,
      revision: proof.revision,
      artifactRoot: proof.artifactRoot,
      manifestSha256: proof.manifestSha256,
      evidencePath: proofPath,
      evidenceSha256: sha(proofBytes),
    };
    if (selected) {
      runtime.assertRepairSelection(selected);
      assert.deepEqual(
        selected,
        selectionResult,
        'Coordinator selected different repair evidence.',
      );
    }
    return selectionResult;
  }
  return {
    async reserve(task, report, launchId) {
      let p;
      try {
        p = await authority(selection, task);
      } catch (error) {
        return {
          status: 'BLOCKED',
          missingAuthority: String(error).slice(0, 4096),
        };
      }
      assert(
        report.requestedScopes.every((scope) => p.scopes.includes(scope)),
        'Repair requested scopes exceed existing authority.',
      );
      assert.equal(
        report.regressionContract,
        p.regressionContract,
        'Repair regression contract is not admitted.',
      );
      if (
        report.requiredRoute === 'full-playbook' &&
        p.owningRoute !== 'full-playbook'
      )
        return {
          status: 'BLOCKED',
          missingAuthority:
            'This repair needs a shared-boundary/defect/feature route; the selected lightweight owning invocation does not admit that work.',
        };
      for (const ref of report.evidenceRefs) {
        assert(
          isAbsolute(ref.location) && /^[a-f0-9]{64}$/.test(ref.sha256 ?? ''),
          'Repair counterexample requires pinned local evidence.',
        );
        await jsonOrBytes(ref);
      }
      const childStoreRoot = join(p.evidenceRoot, 'children');
      const root = join(p.evidenceRoot, launchId);
      await mkdir(root, { recursive: true, mode: 0o700 });
      const originalCandidateRoot = p.candidateRoot,
        frozenRoot = join(root, 'source-candidate');
      if (!(await optional(join(root, 'admission.json')))) {
        try {
          await lstat(frozenRoot);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          execFileSync(
            'git',
            [
              'clone',
              '--quiet',
              '--no-hardlinks',
              originalCandidateRoot,
              frozenRoot,
            ],
            { env: gitEnv, timeout: 30000 },
          );
          git(frozenRoot, 'checkout', '--quiet', '--detach', p.baseCommit);
        }
        pinnedCandidate(originalCandidateRoot, p.baseCommit);
        pinnedCandidate(frozenRoot, p.baseCommit);
        await publish(join(root, 'admission.json'), {
          schemaVersion: 1,
          originalCandidateRoot,
          selectionSha256,
          profileSha256: selection.authority.sha256,
          owningRequestSha256: selection.owningInvocation.requestSha256,
          owningManifestSha256: selection.owningInvocation.manifestSha256,
          owningRoute: p.owningRoute,
          frozenCandidate: {
            root: await directory(frozenRoot),
            revision: p.baseCommit,
            tree: git(frozenRoot, 'rev-parse', 'HEAD^{tree}'),
          },
          authorityEvidence: p.authorityEvidence ?? [],
        });
      }
      const admissionPath = join(root, 'admission.json'),
        admissionBytes = await readBoundedFile(admissionPath, 1024 * 1024),
        admissionObservation = JSON.parse(admissionBytes.toString());
      assert.equal(
        admissionObservation.selectionSha256,
        selectionSha256,
        'Preparation already belongs to another selected authority.',
      );
      assert.equal(
        admissionObservation.originalCandidateRoot,
        originalCandidateRoot,
      );
      assert.equal(admissionObservation.frozenCandidate.revision, p.baseCommit);
      p.candidateRoot = admissionObservation.frozenCandidate.root;
      const provisional = {
        report,
        reportSha256: runtime.taskDigest(report),
        admission: {
          status: 'ADMITTED',
          executionId: launchId,
          revision: p.baseCommit,
          childRef: { storeRoot: childStoreRoot, groupId: '' },
          selectionId: p.id,
          selectionSha256,
          manifestSha256,
          frozenCandidate: admissionObservation.frozenCandidate,
          authorityRef: {
            kind: 'repair-admission-observation',
            location: admissionPath,
            sha256: sha(admissionBytes),
          },
        },
        launch: { launchId },
      };
      const request = await childRequest(runtime, p, provisional);
      const prepared = await runtime.prepareRestartableParallelWorkers(request);
      return {
        ...provisional.admission,
        childRef: {
          storeRoot: childStoreRoot,
          groupId: prepared.group.groupId,
        },
        selectionRef: {
          kind: 'repair-selection-context',
          location: selectionPath,
          sha256: selectionSha256,
        },
      };
    },
    async launch(task, repair) {
      try {
        const p = await check(task, repair),
          root = rootFor(p, repair);
        await mkdir(root, { recursive: true, mode: 0o700 });
        const nonce = randomUUID();
        if (
          await publish(join(root, 'intent.json'), {
            nonce,
            launchId: repair.launch.launchId,
            reportSha256: repair.reportSha256,
            selectionSha256,
            at: Date.now(),
          })
        ) {
          const descriptorPath = join(root, 'supervision.json');
          await publish(descriptorPath, {
            schemaVersion: 1,
            selection,
            selectionSha256,
            manifestSha256,
            taskId: task.taskId,
            repairId: repair.report.repairId,
            nonce,
          });
          const log = await open(join(root, 'supervisor.log'), 'a', 0o600);
          try {
            const child = spawn(
              process.execPath,
              [
                script,
                '--supervise',
                descriptorPath,
                sha(await readBoundedFile(descriptorPath, 128 * 1024)),
              ],
              {
                detached: process.platform !== 'win32',
                shell: false,
                stdio: ['ignore', log.fd, log.fd],
                env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
              },
            );
            await new Promise((done, reject) => {
              child.once('spawn', done);
              child.once('error', reject);
            });
            child.unref();
          } finally {
            await log.close();
          }
        }
        for (let attempt = 0; attempt < 100; attempt++) {
          const observation = await inspect(task, repair);
          if (
            observation.reference &&
            (observation.workerStarted || observation.drained)
          )
            return observation.reference;
          await sleep(50);
        }
        throw new Error(
          'Repair worker start was not observed; retain the reservation and inspect without relaunching.',
        );
      } catch (error) {
        const retained = await retainRepairControllerFailure(
          runtime,
          dirname(repair.admission.authorityRef.location),
          repair,
          error,
        );
        throw new runtime.RepairLaunchFailure(
          `Repair launch is uncertain; retained controller diagnostic sha256=${retained.evidence.sha256}.`,
          retained.reference,
        );
      }
    },
    inspect,
    async verify(task, repair, selection) {
      await inspect(task, repair);
      return verify(task, repair, selection);
    },
  };
}
async function jsonOrBytes(ref) {
  assert.equal(
    (await logIdentity(ref.location)).sha256,
    ref.sha256,
    'Repair counterexample evidence changed.',
  );
}
async function logIdentity(path) {
  const info = await lstat(path);
  assert(
    info.isFile() && !info.isSymbolicLink(),
    'Repair diagnostic log is missing or nonregular.',
  );
  const hash = createHash('sha256');
  let length = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    length += chunk.length;
  }
  assert.equal(
    length,
    info.size,
    'Repair diagnostic log changed while reading.',
  );
  return { path, sha256: hash.digest('hex'), bytes: length };
}

async function runCommand(
  command,
  replacements,
  cwd,
  timeoutMs,
  path,
  inputRefs,
) {
  await verifyCommandInputs(inputRefs);
  const args = command.args.map((arg) =>
    Object.hasOwn(replacements, arg) ? replacements[arg] : arg,
  );
  const startedAt = new Date().toISOString();
  const child = spawn(command.program, args, {
    cwd,
    shell: false,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: gitEnv,
  });
  let error = null;
  const stdoutPath = `${path}.stdout.log`,
    stderrPath = `${path}.stderr.log`;
  const logs = Promise.allSettled([
    pipeline(
      child.stdout,
      createWriteStream(stdoutPath, { flags: 'wx', mode: 0o600 }),
    ),
    pipeline(
      child.stderr,
      createWriteStream(stderrPath, { flags: 'wx', mode: 0o600 }),
    ),
  ]);
  const timer = setTimeout(() => {
    error = 'Command timed out.';
    try {
      process.kill(
        process.platform === 'win32' ? child.pid : -child.pid,
        'SIGKILL',
      );
    } catch {}
  }, timeoutMs);
  const exitCode = await new Promise((done) => {
    child.once('error', (failure) => {
      error = String(failure);
    });
    child.once('close', done);
  });
  clearTimeout(timer);
  for (const result of await logs)
    if (result.status === 'rejected') error = String(result.reason);
  const record = {
    command,
    inputs: inputRefs,
    argv: args,
    cwd,
    pid: child.pid ?? null,
    startedAt,
    endedAt: new Date().toISOString(),
    exitCode,
    error,
    stdout: await logIdentity(stdoutPath),
    stderr: await logIdentity(stderrPath),
  };
  assert(
    await publish(path, record),
    'Repair command observation already exists.',
  );
  assert.equal(error, null);
  await verifyCommandInputs(inputRefs);
  return { ...record, sha256: sha(bytes(record)) };
}

async function supervise(path, expectedSha256) {
  const descriptor = await json(path, expectedSha256);
  exactFields(descriptor, [
    'schemaVersion',
    'selection',
    'selectionSha256',
    'manifestSha256',
    'taskId',
    'repairId',
    'nonce',
  ]);
  await verifyBundle(descriptor.manifestSha256, artifactRoot);
  const runtime = await loadRuntime(),
    store = await runtime.FileTaskStore.openExisting(
      descriptor.selection.taskRoot,
    ),
    task = await store.load(descriptor.taskId);
  assert(task);
  const repair = task.repairs.find(
    (item) => item.report.repairId === descriptor.repairId,
  );
  assert(repair && repair.admission.status === 'ADMITTED');
  try {
    const p = await authority(descriptor.selection, task, repair),
      root = rootFor(p, repair),
      intent = await json(join(root, 'intent.json'));
    assert.equal(intent.nonce, descriptor.nonce);
    assert.equal(intent.selectionSha256, descriptor.selectionSha256);
    assert.equal(repair.admission.selectionSha256, descriptor.selectionSha256);
    assert.equal(repair.admission.manifestSha256, descriptor.manifestSha256);
    const reference = {
      schema: 1,
      launchId: repair.launch.launchId,
      executionId: repair.admission.executionId,
      manifestSha256: descriptor.manifestSha256,
      evidenceRoot: root,
      supervisorId: descriptor.nonce,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    };
    assert(
      await publish(join(root, 'observed.json'), reference),
      'Repair supervisor already owns this reservation.',
    );
    let active = null,
      pollError = null,
      workerObserved = false;
    const tick = async () => {
      await pulse(join(root, 'heartbeat.json'), {
        nonce: descriptor.nonce,
        at: Date.now(),
      });
      if (!workerObserved) {
        const processPath = join(
          root,
          'workers',
          repair.admission.executionId,
          'build',
          `${repair.admission.executionId}-build`,
          `evidence-${p.builder.id}`,
          'process-start.json',
        );
        const processRecord = await optional(processPath);
        if (processRecord) {
          await publish(join(root, 'worker-start.json'), {
            taskId: task.taskId,
            repairId: repair.report.repairId,
            launchId: repair.launch.launchId,
            executionId: repair.admission.executionId,
            manifestSha256: descriptor.manifestSha256,
            selectionSha256: descriptor.selectionSha256,
            supervisorId: descriptor.nonce,
            processPath,
            processSha256: sha(await readBoundedFile(processPath, 64 * 1024)),
            process: processRecord,
          });
          workerObserved = true;
        }
      }
    };
    await tick();
    const timer = setInterval(() => {
      if (!active)
        active = tick()
          .catch((error) => {
            pollError = error;
          })
          .finally(() => {
            active = null;
          });
    }, 100);
    let completed = false,
      failure = null,
      failureRef = null,
      proofSha256 = null;
    try {
      const input = pairInput(p, repair, descriptor.manifestSha256);
      await mkdir(input.evidenceRoot, { mode: 0o700 });
      const request = await childRequest(runtime, p, repair);
      const result = await runtime.executeRestartableParallelWorkers({
        ...request,
        evidenceStore: await runtime.FileEvidenceStore.create(
          join(root, 'failure-evidence'),
        ),
        failureDiagnostics: { mode: 'required' },
        evidenceForFailure: async () => {
          const sources = [];
          const take = async (path, kind) => {
            let info;
            try {
              info = await lstat(path);
            } catch (error) {
              if (error.code === 'ENOENT') return;
              throw error;
            }
            assert(
              info.isFile() && !info.isSymbolicLink(),
              'Owned repair diagnostic source is nonregular.',
            );
            sources.push({
              source: 'stream',
              kind,
              content: createReadStream(path),
            });
          };
          for (const [phase, count] of [
            ['baseline', p.regression.length],
            ['build', 1],
            ['fresh', p.regression.length],
          ])
            for (let index = 0; index < count; index++)
              for (const stream of ['stdout', 'stderr'])
                await take(
                  join(root, `${phase}-${index}.json.${stream}.log`),
                  stream,
                );
          const builderRoot = join(
            root,
            'workers',
            repair.admission.executionId,
            'build',
            `${repair.admission.executionId}-build`,
          );
          for (const [name, kind] of [
            ['stdout.jsonl', 'stdout'],
            ['stderr.log', 'stderr'],
          ])
            await take(
              join(builderRoot, `evidence-${p.builder.id}`, name),
              kind,
            );
          const builderObservation = await optional(
            join(builderRoot, 'host-observation.json'),
          );
          if (builderObservation) {
            assert.equal(builderObservation.worker.id, p.builder.id);
            assert(
              /^[a-f0-9]{40,64}$/.test(builderObservation.integratedCommit),
            );
            const reviewRoot = join(
              root,
              'workers',
              repair.admission.executionId,
              'review',
              `${repair.admission.executionId}-review`,
              builderObservation.integratedCommit,
              p.reviewer.id,
            );
            for (const [name, kind] of [
              ['stdout.jsonl', 'stdout'],
              ['stderr.log', 'stderr'],
            ])
              await take(join(reviewRoot, name), kind);
          }
          return sources;
        },
        receiptStore: await runtime.FileParallelWorkerReceiptStore.create(
          join(root, 'child-receipts'),
        ),
        leaseMs: 10000,
        leaseRenewal: { intervalMs: 1000 },
        retryPolicy: { maxAttempts: 1 },
        handler: async () => {
          const baseline = [];
          for (let index = 0; index < p.regression.length; index++) {
            const record = await runCommand(
              p.regression[index],
              {
                $CANDIDATE: p.candidateRoot,
                $ARTIFACT: p.baselineArtifact.root,
              },
              p.candidateRoot,
              p.timeoutMs,
              join(root, `baseline-${index}.json`),
              p.commandInputs,
            );
            assert.notEqual(
              record.exitCode,
              0,
              'The preserved installed counterexample did not fail on the baseline.',
            );
            baseline.push(record);
          }
          const pair = await runLocalFeatureWorkerPair(input);
          await verifyCommandInputs(p.commandInputs);
          await tick();
          const freshArtifact = join(root, 'fresh-artifact');
          const build = [
            await runCommand(
              p.buildArtifact,
              { $CANDIDATE: pair.integrationPath, $ARTIFACT: freshArtifact },
              pair.integrationPath,
              p.timeoutMs,
              join(root, 'build-0.json'),
              p.commandInputs,
            ),
          ];
          assert.equal(build[0].exitCode, 0, 'Fresh artifact build failed.');
          const manifestBytes = await readBoundedFile(
              join(freshArtifact, 'public-entry-manifest.json'),
              1024 * 1024,
            ),
            freshManifest = JSON.parse(manifestBytes.toString());
          await verifyBundle(sha(manifestBytes), freshArtifact);
          assert.equal(
            freshManifest.source.revision,
            pair.integratedCommit,
            'Fresh artifact was built from a different candidate.',
          );
          assert.equal(
            freshManifest.source.dirty,
            false,
            'Fresh artifact candidate was dirty.',
          );
          const fresh = [];
          for (let index = 0; index < p.regression.length; index++) {
            const record = await runCommand(
              p.regression[index],
              { $CANDIDATE: pair.integrationPath, $ARTIFACT: freshArtifact },
              pair.integrationPath,
              p.timeoutMs,
              join(root, `fresh-${index}.json`),
              p.commandInputs,
            );
            assert.equal(
              record.exitCode,
              0,
              'Fresh installed regression failed.',
            );
            fresh.push(record);
          }
          const proof = {
            launchId: repair.launch.launchId,
            reportSha256: repair.reportSha256,
            selectionSha256: descriptor.selectionSha256,
            contract: repair.report.regressionContract,
            pairSha256: pair.reportSha256,
            workerStartSha256: sha(
              await readBoundedFile(join(root, 'worker-start.json'), 64 * 1024),
            ),
            candidateRoot: pair.integrationPath,
            revision: pair.integratedCommit,
            artifactRoot: freshArtifact,
            manifestSha256: sha(manifestBytes),
            baselineArtifact: p.baselineArtifact,
            baseline,
            build,
            fresh,
          };
          await publish(join(root, 'regression.json'), proof);
          proofSha256 = sha(bytes(proof));
          return {
            status: 'PASS',
            summary:
              'Repair candidate, independent review and fresh installed regression require coordinator review.',
            evidencePaths: [pair.reportPath, join(root, 'regression.json')],
            rawLogPath: null,
          };
        },
      });
      assert.equal(result.state, 'COMPLETE');
      assert.equal(result.receipt.status, 'PASS');
      assert.equal(pollError, null);
      completed = true;
    } catch (error) {
      const retained = await retainRepairControllerFailure(
        runtime,
        root,
        repair,
        error,
      );
      failure = `Repair supervisor failed; retained controller diagnostic sha256=${retained.evidence.sha256}.`;
      failureRef = retained.reference;
    } finally {
      clearInterval(timer);
      if (active) await active;
      await tick();
      await publish(join(root, 'ended.json'), {
        nonce: descriptor.nonce,
        launchId: repair.launch.launchId,
        workersDrained: true,
        completed,
        failure,
        failureRef,
        proofSha256,
      });
    }
  } catch (error) {
    const retained = await retainRepairControllerFailure(
      runtime,
      dirname(repair.admission.authorityRef.location),
      repair,
      error,
    );
    throw new Error(
      `Repair supervisor failed; retained controller diagnostic sha256=${retained.evidence.sha256}.`,
    );
  }
}

export async function runInstalledRepair({
  mode,
  request,
  selection,
  selectionPath,
  selectionSha256,
  manifestSha256,
}) {
  const runtime = await loadRuntime();
  const store = await runtime.FileTaskStore.openExisting(
    await directory(selection.taskRoot),
  );
  const host = await selectedRepairHost({
    runtime,
    selection,
    selectionPath,
    selectionSha256,
    manifestSha256,
  });
  const service = new runtime.TaskRuntime({ store, repairHost: host });
  assert.equal(
    request.taskId,
    selection.taskId,
    'Repair task selection changed.',
  );
  if (mode === 'start' || mode === 'readmit') {
    exactFields(request, [
      'taskId',
      'actor',
      'idempotencyKey',
      'expectedVersion',
      'report',
    ]);
    return mode === 'readmit'
      ? service.readmitRepair(request)
      : service.initiateRepair(request);
  }
  if (mode === 'status') {
    exactFields(request, ['taskId', 'repairId']);
    return service.reconcileRepair(request);
  }
  exactFields(request, [
    'taskId',
    'actor',
    'idempotencyKey',
    'expectedVersion',
    'repairId',
    'selection',
    'reason',
  ]);
  return service.acceptRepair(request);
}
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1] &&
  process.argv[2] === '--supervise'
) {
  supervise(process.argv[3], process.argv[4]).catch((error) => {
    process.stderr.write(
      `${inspectError(error, { depth: null, maxStringLength: null, maxArrayLength: null, customInspect: false, getters: false })}\n`,
    );
    process.exitCode = 1;
  });
}
