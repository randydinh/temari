import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cp,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rename,
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
  manifestSha256,
  packagePublicEntries,
} from './public-entry-runtime.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const packager = fileURLToPath(
  new URL('./public-entry-runtime.mjs', import.meta.url),
);
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

async function childResult(args, expectedCode = 0) {
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
  return result;
}

async function child(args, expectedCode = 0) {
  const result = await childResult(args, expectedCode);
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
  assert.deepEqual(
    await checkPublicEntryArtifact(output, manifestSha256(manifest)),
    manifest,
  );
  assert.deepEqual(manifest.entries, ['temari', 'poteto-mode', 'closeout']);
  assert(!JSON.stringify(manifest).includes(repository));

  const relocatedRoot = await mkdtemp(
    join(tmpdir(), 'temari public-entry-relocated-'),
  );
  try {
    const artifact = join(relocatedRoot, 'artifact');
    await cp(output, artifact, { recursive: true });
    assert.deepEqual(
      await checkPublicEntryArtifact(artifact, manifestSha256(manifest)),
      manifest,
    );
    assert.deepEqual(
      await child([
        packager,
        'check',
        '--artifact',
        artifact,
        '--expected-manifest-sha256',
        manifestSha256(manifest),
      ]),
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

test('artifact checking requires an external expected manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari public-entry-untrusted-'));
  try {
    const artifact = join(root, 'artifact');
    await cp(output, artifact, { recursive: true });
    const policyPath = join(artifact, 'policy.json');
    const policy = JSON.parse(await readFile(policyPath, 'utf8'));
    policy.feature.source.playbookSha256 = '0'.repeat(64);
    const policyBytes = Buffer.from(`${JSON.stringify(policy, null, 2)}\n`);
    await writeFile(policyPath, policyBytes);

    const manifestPath = join(artifact, 'public-entry-manifest.json');
    const rewrittenManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const policyRecord = rewrittenManifest.files.find(
      (record) => record.path === 'policy.json',
    );
    policyRecord.sha256 = createHash('sha256')
      .update(policyBytes)
      .digest('hex');
    policyRecord.bytes = policyBytes.byteLength;
    await writeFile(
      manifestPath,
      `${JSON.stringify(rewrittenManifest, null, 2)}\n`,
    );

    await assert.rejects(
      checkPublicEntryArtifact(artifact),
      /external expected manifest/i,
    );
    await assert.rejects(
      checkPublicEntryArtifact(artifact, manifestSha256(manifest)),
      /external expected digest/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test('public entries refuse symlinked policy and request inputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari public-entry-inputs-'));
  try {
    const artifact = join(root, 'artifact');
    await cp(output, artifact, { recursive: true });
    const policyPath = join(artifact, 'policy.json');
    const policyTarget = join(root, 'policy-target.json');
    await rename(policyPath, policyTarget);
    await symlink(policyTarget, policyPath);
    const policyResult = await childResult(
      [join(artifact, 'bin/temari.mjs'), 'policy'],
      1,
    );
    assert.match(
      policyResult.stderr,
      /regular file|symbolic|symlink|nofollow/i,
    );

    await unlink(policyPath);
    await writeFile(policyPath, await readFile(policyTarget));
    const requestTarget = join(root, 'request-target.json');
    const requestPath = join(root, 'request.json');
    await writeFile(requestTarget, JSON.stringify(request('temari')));
    await symlink(requestTarget, requestPath);
    const requestResult = await childResult(
      [join(artifact, 'bin/temari.mjs'), 'admit', '--request', requestPath],
      1,
    );
    assert.match(
      requestResult.stderr,
      /regular file|symbolic|symlink|nofollow/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('failed publication removes staging and leaves no destination', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari public-entry-failure-'));
  try {
    const artifact = join(root, 'artifact');
    await assert.rejects(
      packagePublicEntries(artifact, {
        packageCanonical: async () => {
          throw new Error('injected canonical packaging failure');
        },
      }),
      /injected canonical packaging failure/,
    );
    await assert.rejects(lstat(artifact), { code: 'ENOENT' });
    const leftovers = await readdir(root);
    assert.deepEqual(leftovers, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('concurrent publication has one exclusive owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari public-entry-race-'));
  try {
    const artifact = join(root, 'artifact');
    const results = await Promise.allSettled([
      packagePublicEntries(artifact),
      packagePublicEntries(artifact),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].reason.message, /reserved|exists/i);
    const publishedManifest = fulfilled[0].value;
    assert.deepEqual(
      await checkPublicEntryArtifact(
        artifact,
        manifestSha256(publishedManifest),
      ),
      publishedManifest,
    );
    await assert.rejects(lstat(`${artifact}.publish-lock`), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('outer publication is no-overwrite and rejects tampering or symlinks', async () => {
  await assert.rejects(packagePublicEntries(output), /Output already exists/);

  const policyPath = join(output, 'policy.json');
  const policyBytes = await readFile(policyPath);
  const tampered = Buffer.from(policyBytes);
  tampered[tampered.length - 2] ^= 1;
  await writeFile(policyPath, tampered);
  await assert.rejects(
    checkPublicEntryArtifact(output, manifestSha256(manifest)),
    /inventory|digest|hash|policy/i,
  );
  await writeFile(policyPath, policyBytes);
  assert.deepEqual(
    await checkPublicEntryArtifact(output, manifestSha256(manifest)),
    manifest,
  );

  const symlinkPath = join(output, 'bin/temari.mjs');
  const entryBytes = await readFile(symlinkPath);
  await unlink(symlinkPath);
  await symlink('../policy.json', symlinkPath);
  await assert.rejects(
    checkPublicEntryArtifact(output, manifestSha256(manifest)),
    /Symlink/,
  );
  await unlink(symlinkPath);
  await writeFile(symlinkPath, entryBytes, { mode: 0o755 });
  assert.deepEqual(
    await checkPublicEntryArtifact(output, manifestSha256(manifest)),
    manifest,
  );
});
