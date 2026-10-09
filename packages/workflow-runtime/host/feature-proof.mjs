import { verifyGitCandidate } from './git-candidate.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { observeLocalForge } from './forge.mjs';
import {
  runLocalFeatureWorkerPair,
  runLocalHostWorker,
  verifyLocalFeatureWorkerPair,
} from './local-worker.mjs';
import { exactFields, readBoundedFile } from './stdio.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Observe architecture, implementation, review, and forge on this host. */
export async function runLocalFeatureHostProof(input, signal) {
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
      'hostBinding',
      'architect',
      'builder',
      'owns',
      'verify',
      'reviewer',
    ],
    ['prepare'],
  );
  assert.match(input.runId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,109}$/);
  assert.equal(input.architect?.role, 'investigator');
  assert.equal(input.architect?.required, true);
  assert.equal(input.builder?.role, 'implementer');
  assert.equal(input.reviewer?.role, 'reviewer');
  assert.equal(
    new Set([input.architect.id, input.builder.id, input.reviewer.id]).size,
    3,
    'Feature workers must have distinct identities.',
  );
  const dependencies = await verifyGitCandidate(
    input.candidateRoot,
    input.baseCommit,
  );
  const forge = observeLocalForge(input.candidateRoot);
  const architect = await runLocalHostWorker(
    {
      runId: `${input.runId}-architect`,
      revision: input.revision,
      candidateRoot: input.candidateRoot,
      evidenceRoot: input.evidenceRoot,
      baseCommit: input.baseCommit,
      executable: input.executable,
      timeoutMs: input.timeoutMs,
      assignment: input.architect,
    },
    signal,
  );
  const workers = await runLocalFeatureWorkerPair(
    {
      runId: `${input.runId}-workers`,
      revision: input.revision,
      candidateRoot: input.candidateRoot,
      evidenceRoot: input.evidenceRoot,
      baseCommit: input.baseCommit,
      executable: input.executable,
      timeoutMs: input.timeoutMs,
      hostBinding: input.hostBinding,
      builder: input.builder,
      owns: input.owns,
      verify: input.verify,
      reviewer: input.reviewer,
      ...(input.prepare === undefined ? {} : { prepare: input.prepare }),
    },
    signal,
  );
  assert.notEqual(architect.worker.pid, workers.builder.pid);
  assert.notEqual(architect.worker.pid, workers.reviewer.pid);
  await verifyGitCandidate(input.candidateRoot, input.baseCommit, dependencies);
  await verifyGitCandidate(
    workers.integrationPath,
    workers.integratedCommit,
    dependencies,
  );
  const proof = {
    dependencies,
    schemaVersion: 1,
    host: 'local-feature',
    status: 'proven',
    runId: input.runId,
    revision: input.revision,
    hostBinding: input.hostBinding,
    source: workers.source,
    integratedCommit: workers.integratedCommit,
    forge,
    architect: {
      id: architect.worker.id,
      pid: architect.worker.pid,
      observationPath: architect.observationPath,
      observationSha256: architect.observationSha256,
    },
    workers: {
      reportPath: workers.reportPath,
      reportSha256: workers.reportSha256,
    },
  };
  const proofPath = join(
    await realpath(input.evidenceRoot),
    `${input.runId}-host-proof.json`,
  );
  const bytes = Buffer.from(`${JSON.stringify(proof, null, 2)}\n`);
  await writeFile(proofPath, bytes, { flag: 'wx', mode: 0o600 });
  return {
    ...proof,
    proofPath,
    proofSha256: digest(bytes),
    integrationPath: workers.integrationPath,
  };
}

/** Revalidate the host proof and current candidate before a lifecycle resumes. */
export async function verifyLocalFeatureHostProof(input) {
  exactFields(input, [
    'runId',
    'revision',
    'candidateRoot',
    'evidenceRoot',
    'baseCommit',
    'hostBinding',
    'proofSha256',
  ]);
  assert.match(input.proofSha256, /^[0-9a-f]{64}$/);
  const evidenceRoot = await realpath(input.evidenceRoot);
  const proofPath = join(evidenceRoot, `${input.runId}-host-proof.json`);
  const bytes = await readBoundedFile(proofPath, 4 * 1024 * 1024);
  assert.equal(digest(bytes), input.proofSha256, 'Feature host proof changed.');
  const proof = JSON.parse(bytes.toString());
  assert.equal(proof.schemaVersion, 1);
  assert.equal(proof.host, 'local-feature');
  assert.equal(proof.status, 'proven');
  assert.equal(proof.runId, input.runId);
  assert.equal(proof.revision, input.revision);
  assert.deepEqual(proof.hostBinding, input.hostBinding);
  assert.equal(proof.source.baseCommit, input.baseCommit);
  await verifyGitCandidate(
    input.candidateRoot,
    input.baseCommit,
    proof.dependencies,
  );
  const currentForge = observeLocalForge(input.candidateRoot);
  for (const key of ['actor', 'nameWithOwner', 'repositoryUrl', 'remoteSha256'])
    assert.equal(
      proof.forge[key],
      currentForge[key],
      'Forge identity changed.',
    );
  const architectRoot = join(
    evidenceRoot,
    `${input.runId}-architect`,
    input.revision,
  );
  assert.equal(
    proof.architect.observationPath,
    join(architectRoot, 'host-observation.json'),
  );
  const architectBytes = await readBoundedFile(
    proof.architect.observationPath,
    4 * 1024 * 1024,
  );
  assert.equal(digest(architectBytes), proof.architect.observationSha256);
  const architect = JSON.parse(architectBytes.toString());
  assert.equal(architect.status, 'PASS');
  assert.equal(architect.route, 'read-only');
  assert.equal(architect.runId, `${input.runId}-architect`);
  assert.equal(architect.revision, input.revision);
  assert.equal(architect.worker.role, 'investigator');
  assert.equal(architect.worker.id, proof.architect.id);
  assert.equal(architect.worker.pid, proof.architect.pid);
  assert.deepEqual(architect.candidate, proof.source);
  assert.equal(architect.receipt.path, join(architectRoot, 'receipt.json'));
  assert.equal(
    architect.process.path,
    join(architectRoot, proof.architect.id, 'process.json'),
  );
  const architectReceipt = await readBoundedFile(
    architect.receipt.path,
    4 * 1024 * 1024,
  );
  const architectProcess = await readBoundedFile(
    architect.process.path,
    64 * 1024,
  );
  assert.equal(digest(architectReceipt), architect.receipt.sha256);
  assert.equal(digest(architectProcess), architect.process.sha256);
  assert.equal(JSON.parse(architectReceipt.toString()).status, 'PASS');
  const processEvidence = JSON.parse(architectProcess.toString());
  assert.equal(processEvidence.pid, proof.architect.pid);
  assert.equal(processEvidence.exitCode, 0);
  assert.equal(processEvidence.error, null);
  const workers = await verifyLocalFeatureWorkerPair({
    runId: `${input.runId}-workers`,
    revision: input.revision,
    candidateRoot: input.candidateRoot,
    evidenceRoot,
    baseCommit: input.baseCommit,
    hostBinding: input.hostBinding,
    reportSha256: proof.workers.reportSha256,
  });
  assert.equal(proof.workers.reportPath, workers.reportPath);
  assert.equal(proof.integratedCommit, workers.integratedCommit);
  await verifyGitCandidate(
    workers.integrationPath,
    workers.integratedCommit,
    proof.dependencies,
  );
  assert.notEqual(proof.architect.id, workers.builder.id);
  assert.notEqual(proof.architect.id, workers.reviewer.id);
  assert.notEqual(proof.architect.pid, workers.builder.pid);
  assert.notEqual(proof.architect.pid, workers.reviewer.pid);
  return {
    ...proof,
    proofPath,
    proofSha256: input.proofSha256,
    integrationPath: workers.integrationPath,
  };
}
