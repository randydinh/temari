import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { runCodexParallelRequest } from '../bin/codex-parallel.mjs';
import { exactFields, readBoundedFile } from './stdio.mjs';

const RECEIPT_BYTES = 4 * 1024 * 1024;
const PROCESS_BYTES = 64 * 1024;
const gitEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
);

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function contains(parent, child) {
  const path = relative(parent, child);
  return (
    path === '' ||
    (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
  );
}

async function existingDirectory(path, label) {
  assert(isAbsolute(path), `${label} must be absolute.`);
  const selected = resolve(path);
  const info = await lstat(selected);
  assert(
    info.isDirectory() && !info.isSymbolicLink(),
    `${label} must be a directory.`,
  );
  return realpath(selected);
}

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: gitEnvironment,
    timeout: 10000,
  }).trim();
}

function assertPinnedCandidate(root, baseCommit) {
  assert.equal(
    git(root, 'rev-parse', '--show-toplevel'),
    root,
    'Candidate must be the Git root.',
  );
  assert.equal(
    git(root, 'rev-parse', 'HEAD'),
    baseCommit,
    'Candidate HEAD changed.',
  );
  assert.equal(
    git(root, 'status', '--porcelain=v1', '--untracked-files=all'),
    '',
    'Candidate must be clean.',
  );
}

function workerRoute(assignment) {
  assert(
    assignment && typeof assignment === 'object' && !Array.isArray(assignment),
  );
  exactFields(assignment, ['id', 'role', 'required', 'brief']);
  assert.equal(assignment.required, true, 'The host worker must be required.');
  if (assignment.role === 'reviewer' || assignment.role === 'investigator')
    return 'read-only';
  assert.equal(assignment.role, 'implementer', 'Unsupported host worker role.');
  return 'write';
}

/**
 * Execute one worker under host-selected paths and verify the child process.
 * The public entry never accepts this observation from a request as admission proof.
 */
export async function runLocalHostWorker(input, signal) {
  exactFields(
    input,
    [
      'runId',
      'revision',
      'candidateRoot',
      'evidenceRoot',
      'baseCommit',
      'executable',
      'timeoutMs',
      'assignment',
    ],
    ['owns', 'verify', 'prepare'],
  );
  for (const name of ['runId', 'revision'])
    assert.match(
      input[name],
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
      `${name} must be a safe identifier.`,
    );
  assert.match(
    input.baseCommit,
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/,
    'A pinned full commit is required.',
  );
  const candidateRoot = await existingDirectory(
    input.candidateRoot,
    'candidateRoot',
  );
  const evidenceRoot = await existingDirectory(
    input.evidenceRoot,
    'evidenceRoot',
  );
  assert(
    !contains(candidateRoot, evidenceRoot) &&
      !contains(evidenceRoot, candidateRoot),
    'Candidate and worker evidence must be disjoint.',
  );
  const route = workerRoute(input.assignment);
  if (route === 'read-only') {
    assert(
      !Object.hasOwn(input, 'owns') &&
        !Object.hasOwn(input, 'verify') &&
        !Object.hasOwn(input, 'prepare'),
      'Read-only workers cannot receive write controls.',
    );
  } else {
    assert(
      Array.isArray(input.owns) && input.owns.length > 0,
      'Write worker ownership is required.',
    );
    assert(
      Array.isArray(input.verify) && input.verify.length > 0,
      'Host verification commands are required.',
    );
  }
  assertPinnedCandidate(candidateRoot, input.baseCommit);
  const common = {
    runId: input.runId,
    evidenceRoot,
    maxConcurrency: 1,
    executable: input.executable,
    timeoutMs: input.timeoutMs,
  };
  const request =
    route === 'read-only'
      ? {
          ...common,
          revision: input.revision,
          workspaceRoot: candidateRoot,
          assignments: [input.assignment],
        }
      : {
          ...common,
          sourceRepo: candidateRoot,
          baseCommit: input.baseCommit,
          prepare: input.prepare ?? [],
          verify: input.verify,
          assignments: [{ worker: input.assignment, owns: input.owns }],
        };
  const result = await runCodexParallelRequest(request, signal);
  assertPinnedCandidate(candidateRoot, input.baseCommit);
  assert.equal(result.route, route);
  const runRoot =
    route === 'read-only'
      ? join(evidenceRoot, input.runId, input.revision)
      : join(evidenceRoot, input.runId);
  const expectedReceipt = join(runRoot, 'receipt.json');
  const processPath = join(
    runRoot,
    route === 'read-only'
      ? input.assignment.id
      : `evidence-${input.assignment.id}`,
    'process.json',
  );
  assert.equal(
    result.receiptPath,
    expectedReceipt,
    'Worker receipt path changed.',
  );
  const receiptBytes = await readBoundedFile(expectedReceipt, RECEIPT_BYTES);
  const receipt = JSON.parse(receiptBytes.toString());
  assert.equal(receipt.runId, input.runId);
  assert.equal(receipt.status, 'PASS', 'Worker receipt did not pass.');
  if (route === 'read-only') assert.equal(receipt.revision, input.revision);
  else {
    assert.equal(receipt.baseCommit, input.baseCommit);
    assert.equal(receipt.integratedCommit, result.integratedCommit);
  }
  const processBytes = await readBoundedFile(processPath, PROCESS_BYTES);
  const processEvidence = JSON.parse(processBytes.toString());
  assert(
    Number.isSafeInteger(processEvidence.pid) &&
      processEvidence.pid > 0 &&
      processEvidence.pid !== process.pid,
    'No independent child process was observed.',
  );
  assert.equal(
    processEvidence.exitCode,
    0,
    'Worker process did not exit successfully.',
  );
  assert.equal(processEvidence.timedOut, false);
  assert.equal(processEvidence.cancelled, false);
  assert.equal(processEvidence.outputLimitExceeded, false);
  assert.equal(processEvidence.error, null);
  assert.equal(result.status, 'PASS', 'Host worker did not pass.');
  const observation = {
    schemaVersion: 1,
    host: 'local-codex',
    status: 'PASS',
    route,
    runId: input.runId,
    revision: input.revision,
    candidate: { root: candidateRoot, baseCommit: input.baseCommit },
    worker: {
      id: input.assignment.id,
      role: input.assignment.role,
      pid: processEvidence.pid,
      startedAt: processEvidence.startedAt,
      endedAt: processEvidence.endedAt,
    },
    receipt: { path: expectedReceipt, sha256: digest(receiptBytes) },
    process: { path: processPath, sha256: digest(processBytes) },
    ...(route === 'write'
      ? {
          integratedCommit: result.integratedCommit,
          integrationPath: result.integrationPath,
        }
      : {}),
  };
  const observationPath = join(runRoot, 'host-observation.json');
  const observationBytes = Buffer.from(
    `${JSON.stringify(observation, null, 2)}\n`,
  );
  await writeFile(observationPath, observationBytes, {
    flag: 'wx',
    mode: 0o600,
  });
  return {
    ...observation,
    observationPath,
    observationSha256: digest(observationBytes),
  };
}

/** Run a builder and an independent reviewer against the builder's exact commit. */
export async function runLocalFeatureWorkerPair(input, signal) {
  exactFields(
    input,
    [
      'runId',
      'revision',
      'candidateRoot',
      'evidenceRoot',
      'baseCommit',
      'executable',
      'timeoutMs',
      'builder',
      'owns',
      'verify',
      'reviewer',
    ],
    ['prepare'],
  );
  assert.match(
    input.runId,
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/,
    'Pair runId must leave room for worker suffixes.',
  );
  assert.equal(input.builder?.role, 'implementer');
  assert.equal(input.reviewer?.role, 'reviewer');
  assert.notEqual(
    input.builder.id,
    input.reviewer.id,
    'Builder and reviewer must have distinct identities.',
  );
  const candidateRoot = await existingDirectory(
    input.candidateRoot,
    'candidateRoot',
  );
  const evidenceRoot = await existingDirectory(
    input.evidenceRoot,
    'evidenceRoot',
  );
  assert(
    !contains(candidateRoot, evidenceRoot) &&
      !contains(evidenceRoot, candidateRoot),
    'Candidate and worker evidence must be disjoint.',
  );
  const pairRoot = join(evidenceRoot, input.runId);
  await mkdir(pairRoot, { mode: 0o700 });
  const buildEvidenceRoot = join(pairRoot, 'build');
  const reviewEvidenceRoot = join(pairRoot, 'review');
  await mkdir(buildEvidenceRoot, { mode: 0o700 });
  await mkdir(reviewEvidenceRoot, { mode: 0o700 });
  const common = {
    revision: input.revision,
    candidateRoot,
    baseCommit: input.baseCommit,
    executable: input.executable,
    timeoutMs: input.timeoutMs,
  };
  const build = await runLocalHostWorker(
    {
      ...common,
      runId: `${input.runId}-build`,
      evidenceRoot: buildEvidenceRoot,
      assignment: input.builder,
      owns: input.owns,
      verify: input.verify,
      prepare: input.prepare ?? [],
    },
    signal,
  );
  assert.match(
    build.integratedCommit,
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/,
    'Builder did not produce a commit.',
  );
  const review = await runLocalHostWorker(
    {
      ...common,
      runId: `${input.runId}-review`,
      revision: build.integratedCommit,
      candidateRoot: build.integrationPath,
      evidenceRoot: reviewEvidenceRoot,
      baseCommit: build.integratedCommit,
      assignment: input.reviewer,
    },
    signal,
  );
  assert.notEqual(
    build.worker.pid,
    review.worker.pid,
    'Builder and reviewer did not run in distinct processes.',
  );
  assert.equal(
    review.candidate.baseCommit,
    build.integratedCommit,
    'Reviewer inspected a different commit.',
  );
  const report = {
    schemaVersion: 1,
    host: 'local-codex',
    status: 'PASS',
    runId: input.runId,
    revision: input.revision,
    source: build.candidate,
    integratedCommit: build.integratedCommit,
    builder: {
      id: build.worker.id,
      pid: build.worker.pid,
      observationPath: build.observationPath,
      observationSha256: build.observationSha256,
    },
    reviewer: {
      id: review.worker.id,
      pid: review.worker.pid,
      candidate: review.candidate,
      observationPath: review.observationPath,
      observationSha256: review.observationSha256,
    },
  };
  const reportPath = join(pairRoot, 'feature-workers.json');
  const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  await writeFile(reportPath, reportBytes, { flag: 'wx', mode: 0o600 });
  return { ...report, reportPath, reportSha256: digest(reportBytes) };
}
