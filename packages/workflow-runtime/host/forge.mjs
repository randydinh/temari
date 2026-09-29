import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    timeout: 10000,
  }).trim();
}

function gh(...args) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    timeout: 20000,
    maxBuffer: 1024 * 1024,
  }).trim();
}

function remoteRepository(remote) {
  const match = remote.match(
    /^(?:[A-Za-z0-9._-]+@[^:/]+:|https:\/\/[^/]+\/|ssh:\/\/[^/]+\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/,
  );
  assert(match, 'Candidate origin is not a supported forge repository.');
  return `${match[1]}/${match[2]}`;
}

/** Ask the local forge client about the selected repository and write access. */
export function observeLocalForge(candidateRoot) {
  const remote = git(candidateRoot, 'remote', 'get-url', 'origin');
  const nameWithOwner = remoteRepository(remote);
  const actor = gh('api', 'user', '--jq', '.login');
  assert.match(actor, /^[A-Za-z0-9-]+$/, 'Forge actor is invalid.');
  const repository = JSON.parse(gh('api', `repos/${nameWithOwner}`));
  assert.equal(
    repository.full_name?.toLowerCase(),
    nameWithOwner.toLowerCase(),
    'Forge returned a different repository.',
  );
  assert.equal(
    repository.permissions?.push,
    true,
    'Forge does not report push access to the selected repository.',
  );
  assert.match(
    repository.html_url,
    /^https:\/\/[^/]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
    'Forge repository URL is invalid.',
  );
  return {
    schemaVersion: 1,
    host: 'local-gh',
    status: 'proven',
    actor,
    nameWithOwner: repository.full_name,
    repositoryUrl: repository.html_url,
    remoteSha256: createHash('sha256').update(remote).digest('hex'),
    observedAt: new Date().toISOString(),
  };
}

/** Verify that a retained pull request actually carries the integrated commit. */
export function verifyLocalPullRequest(
  forge,
  integratedCommit,
  pullRequestUrl,
) {
  assert.match(integratedCommit, /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
  assert.equal(forge.status, 'proven');
  const prefix = `${forge.repositoryUrl}/pull/`;
  assert(
    typeof pullRequestUrl === 'string' &&
      pullRequestUrl.startsWith(prefix) &&
      /^[1-9][0-9]*$/.test(pullRequestUrl.slice(prefix.length)),
    'Pull request URL does not belong to the selected repository.',
  );
  const number = Number(pullRequestUrl.slice(prefix.length));
  assert(Number.isSafeInteger(number));
  const pull = JSON.parse(
    gh('api', `repos/${forge.nameWithOwner}/pulls/${number}`),
  );
  assert.equal(pull.html_url, pullRequestUrl);
  assert.equal(
    pull.base?.repo?.full_name?.toLowerCase(),
    forge.nameWithOwner.toLowerCase(),
  );
  assert.equal(
    pull.head?.sha,
    integratedCommit,
    'Pull request head differs from the integrated commit.',
  );
  assert.equal(pull.state, 'open', 'Pull request is not open.');
  return {
    schemaVersion: 1,
    status: 'proven',
    repository: forge.nameWithOwner,
    pullRequestUrl,
    integratedCommit,
    checkedAt: new Date().toISOString(),
  };
}
