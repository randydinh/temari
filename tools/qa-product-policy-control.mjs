import { spawn } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { POLICY_PROFILE_ID, policyProofDigest, sha256 } from './qa-temari-policy-semantic.mjs';

export const POLICY_CONTROL_MAX_STREAM_BYTES = 64 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;

async function regularBytes(path, maxBytes) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes)
    throw new Error('Control input must be a bounded regular file.');
  const bytes = await readFile(path);
  if (bytes.byteLength > maxBytes) throw new Error('Control input exceeds its bound.');
  return bytes;
}

export async function verifyPolicyArtifactPin(candidateRoot, expectedManifestSha256) {
  if (!isAbsolute(candidateRoot) || !/^[a-f0-9]{64}$/.test(expectedManifestSha256))
    throw new Error('Policy control requires an absolute root and selected manifest SHA256.');
  const stat = await lstat(candidateRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Candidate root must be a real directory.');
  const root = await realpath(candidateRoot);
  const raw = await regularBytes(join(root, 'public-entry-manifest.json'), MAX_MANIFEST_BYTES);
  const manifest = JSON.parse(raw);
  if (sha256(raw) !== expectedManifestSha256)
    throw new Error('Candidate manifest differs from the selected pin.');
  if (!Array.isArray(manifest.files)) throw new Error('Candidate manifest file inventory is unavailable.');
  const entries = manifest.files.filter((entry) => entry.path === 'bin/temari.mjs');
  if (entries.length !== 1) throw new Error('Candidate manifest must contain exactly one fixed CLI entry.');
  const entryPath = join(root, 'bin', 'temari.mjs');
  const bin = await lstat(dirname(entryPath));
  if (!bin.isDirectory() || bin.isSymbolicLink()) throw new Error('CLI parent must be a real directory.');
  const entryBytes = await regularBytes(entryPath, POLICY_CONTROL_MAX_STREAM_BYTES);
  if (sha256(entryBytes) !== entries[0].sha256 || entryBytes.byteLength !== entries[0].bytes)
    throw new Error('Fixed CLI entry differs from its manifest.');
  // The admitted host verifies the full artifact inventory before/after the
  // control. This local guard checks only the selected manifest and fixed entry.
  return { root, entryPath, entrySha256: sha256(entryBytes), manifest };
}

/** Execute the actual fixed relocated CLI. No supplied command, fixture or shell. */
export async function runPolicyControl({ candidateRoot, expectedManifestSha256,
  timeoutMs = 10_000, maxStreamBytes = POLICY_CONTROL_MAX_STREAM_BYTES }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000 ||
      !Number.isSafeInteger(maxStreamBytes) || maxStreamBytes < 1 ||
      maxStreamBytes > POLICY_CONTROL_MAX_STREAM_BYTES)
    throw new Error('Policy control bounds are invalid.');
  const artifact = await verifyPolicyArtifactPin(candidateRoot, expectedManifestSha256);
  const implementationSha256 = sha256(await regularBytes(fileURLToPath(import.meta.url), 128 * 1024));
  const runtimeSha256 = sha256(await regularBytes(await realpath(process.execPath), 256 * 1024 * 1024));
  const command = [process.execPath, artifact.entryPath, 'policy'];
  const inputSha256 = sha256(Buffer.alloc(0));
  const invocationSha256 = policyProofDigest({ command, cwd: artifact.root, inputSha256 });
  const startedAt = new Date().toISOString();
  const capture = await new Promise((done) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: artifact.root, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: dirname(process.execPath), LANG: 'C.UTF-8', TZ: 'UTC', NODE_OPTIONS: '', NODE_PATH: '' },
    });
    const chunks = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };
    let failure = null;
    const stop = (reason) => { failure ??= reason; child.kill('SIGKILL'); };
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    for (const stream of ['stdout', 'stderr']) child[stream].on('data', (chunk) => {
      const remaining = maxStreamBytes - sizes[stream];
      if (remaining > 0) chunks[stream].push(chunk.subarray(0, remaining));
      sizes[stream] += chunk.byteLength;
      if (sizes[stream] > maxStreamBytes) stop(`${stream}-overflow`);
    });
    child.once('error', () => { failure ??= 'spawn-unavailable'; });
    child.stdin.on('error', () => { failure ??= 'stdin-unavailable'; });
    child.stdin.end();
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      done({ processId: child.pid ?? null, exitCode, signal,
        failure, completion: failure || signal ? 'unavailable' : 'completed',
        stdout: Buffer.concat(chunks.stdout), stderr: Buffer.concat(chunks.stderr) });
    });
  });
  const endedAt = new Date().toISOString();
  let output = null;
  if (capture.completion === 'completed') {
    try { output = JSON.parse(capture.stdout.toString('utf8')); } catch { /* retain bytes; semantic blocks */ }
  }
  return { profileId: POLICY_PROFILE_ID, processId: capture.processId,
    command, cwd: artifact.root, invocationSha256, inputSha256,
    implementationSha256, runtimeSha256, artifactManifestSha256: expectedManifestSha256,
    startedAt, endedAt, completion: capture.completion, exitCode: capture.exitCode,
    signal: capture.signal, failure: capture.failure,
    rawStdout: capture.stdout.toString('utf8'), rawStderr: capture.stderr.toString('utf8'),
    stdoutSha256: sha256(capture.stdout), stderrSha256: sha256(capture.stderr),
    outputSha256: output === null ? null : policyProofDigest(output), output };
}
