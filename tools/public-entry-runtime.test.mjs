import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cp,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  checkPublicEntryArtifact,
  packagePublicEntries,
} from './public-entry-runtime.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
let buildRoot;
let output;
let manifest;

before(async () => {
  buildRoot = await mkdtemp(join(tmpdir(), 'temari public-entry-build-'));
  output = join(buildRoot, 'artifact');
  manifest = await packagePublicEntries(output);
});

after(async () => {
  if (buildRoot) await rm(buildRoot, { recursive: true, force: true });
});

async function child(args, expectedCode = 0) {
  const result = await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      args,
      {
        cwd: buildRoot,
        env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        timeout: 30_000,
      },
      (error, stdout, stderr) => {
        if (error && (error.killed || typeof error.code !== 'number'))
          reject(error);
        else resolve({ code: error ? Number(error.code) : 0, stdout, stderr });
      },
    );
  });
  assert.equal(result.code, expectedCode, `${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}

function request(entry, overrides = {}) {
  return {
    schemaVersion: 1,
    entry,
    route: 'full-playbook',
    profile: 'feature-v1',
    obligations: {
      workType: 'feature',
      delegation: 'required',
      review: 'independent',
      evidence: 'revision-bound',
      delivery: 'pull-request',
    },
    ...overrides,
  };
}

test('packages an isolated relocated outer bundle with three current public entries', async () => {
  assert.deepEqual(await checkPublicEntryArtifact(output, manifest), manifest);
  assert.deepEqual(manifest.entries, ['temari', 'poteto-mode', 'closeout']);
  assert(!JSON.stringify(manifest).includes(repository));

  const relocatedRoot = await mkdtemp(
    join(tmpdir(), 'temari public-entry-relocated-'),
  );
  try {
    const artifact = join(relocatedRoot, 'artifact');
    await cp(output, artifact, { recursive: true });
    assert.deepEqual(
      await checkPublicEntryArtifact(artifact, manifest),
      manifest,
    );
    const policy = await child([join(artifact, 'bin/temari.mjs'), 'policy']);
    assert.equal(policy.status, 'described');
    assert.equal(policy.supportedProfile, 'feature-v1');
  } finally {
    await rm(relocatedRoot, { recursive: true, force: true });
  }
});

test('public policy records the exact reviewed legacy profile and playbook provenance', async () => {
  const policy = JSON.parse(
    await readFile(join(output, 'policy.json'), 'utf8'),
  );
  const sha256 = (text) => createHash('sha256').update(text).digest('hex');
  const profile = await readFile(
    join(
      repository,
      'packages/workflow-runtime/assets/v4.1/skills/poteto-mode/playbook-contracts/v1/feature.json',
    ),
    'utf8',
  );
  const playbook = await readFile(
    join(
      repository,
      'packages/workflow-runtime/assets/v4.1/skills/poteto-mode/playbooks/feature.md',
    ),
    'utf8',
  );
  assert.equal(
    sha256(profile.replace(/\r\n?/g, '\n')),
    policy.feature.source.profileSha256,
  );
  assert.equal(
    sha256(playbook.replace(/\r\n?/g, '\n')),
    policy.feature.source.playbookSha256,
  );
});

test('public engineering admission refuses unsupported routes and blocks unproven capabilities', async () => {
  const requestPath = join(buildRoot, 'feature-request.json');
  await writeFile(requestPath, JSON.stringify(request('temari')));
  const temari = await child(
    [join(output, 'bin/temari.mjs'), 'admit', '--request', requestPath],
    1,
  );
  assert.equal(temari.status, 'blocked');
  assert.deepEqual(temari.missingCapabilities, ['subagents', 'forge']);
  assert.deepEqual(temari.reasons, ['host-capability-proof-missing']);

  const poteto = await child(
    [join(output, 'bin/poteto-mode.mjs'), 'admit', '--request', requestPath],
    1,
  );
  assert.equal(poteto.status, 'rejected');
  assert(poteto.reasons.includes('entry-mismatch'));

  await writeFile(
    requestPath,
    JSON.stringify(
      request('poteto-mode', {
        route: 'lightweight-engineering',
        profile: 'lightweight-engineering',
      }),
    ),
  );
  const lightweight = await child(
    [join(output, 'bin/poteto-mode.mjs'), 'admit', '--request', requestPath],
    1,
  );
  assert.equal(lightweight.status, 'rejected');
  assert(lightweight.reasons.includes('route-not-admitted'));
  assert(lightweight.reasons.includes('profile-not-admitted'));
});

test('closeout public entry remains explicitly blocked until trusted candidate selection exists', async () => {
  const closeout = await child(
    [
      join(output, 'bin/closeout.mjs'),
      'admit',
      '--run-directory',
      join(buildRoot, 'run'),
    ],
    1,
  );
  assert.equal(closeout.status, 'blocked');
  assert.deepEqual(closeout.reasons, [
    'trusted-invocation-and-current-candidate-selection-unimplemented',
  ]);
});

test('outer publication is no-overwrite and rejects tampering or symlinks', async () => {
  await assert.rejects(packagePublicEntries(output), /Output already exists/);

  const policyPath = join(output, 'policy.json');
  const policyBytes = await readFile(policyPath);
  const tampered = Buffer.from(policyBytes);
  tampered[tampered.length - 2] ^= 1;
  await writeFile(policyPath, tampered);
  await assert.rejects(
    checkPublicEntryArtifact(output, manifest),
    /inventory|digest|hash|policy/i,
  );
  await writeFile(policyPath, policyBytes);
  assert.deepEqual(await checkPublicEntryArtifact(output, manifest), manifest);

  const symlinkPath = join(output, 'bin/temari.mjs');
  const entryBytes = await readFile(symlinkPath);
  await unlink(symlinkPath);
  await symlink('../policy.json', symlinkPath);
  await assert.rejects(checkPublicEntryArtifact(output, manifest), /Symlink/);
  await unlink(symlinkPath);
  await writeFile(symlinkPath, entryBytes, { mode: 0o755 });
  assert.deepEqual(await checkPublicEntryArtifact(output, manifest), manifest);
});
