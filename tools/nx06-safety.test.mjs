import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const rehearsal = fileURLToPath(
  new URL('./nx06-cutover-rehearsal.mjs', import.meta.url),
);
const drift = fileURLToPath(
  new URL('./nx06-matrix-drift.mjs', import.meta.url),
);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'temari-nx06-safety-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function treeSha(root) {
  const entries = [];
  async function visit(path, name) {
    const stat = await lstat(path);
    if (stat.isDirectory()) {
      for (const child of (await readdir(path)).sort())
        await visit(join(path, child), name ? `${name}/${child}` : child);
      return;
    }
    const bytes = await readFile(path);
    entries.push({
      path: name,
      sha256: sha(bytes),
      bytes: bytes.length,
      mode: stat.mode & 0o777,
    });
  }
  await visit(root, '');
  return sha(Buffer.from(JSON.stringify(entries)));
}

test('rehearsal refuses a symlinked output parent before writing into either artifact', async (t) => {
  const root = await fixture(t);
  const publicRoot = join(root, 'public');
  const previousRoot = join(root, 'previous');
  await mkdir(publicRoot);
  await mkdir(previousRoot);

  for (const [name, target] of [
    ['public', publicRoot],
    ['previous', previousRoot],
  ]) {
    const alias = join(root, `${name}-alias`);
    await symlink(
      target,
      alias,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const output = join(alias, 'scratch');
    const result = spawnSync(
      process.execPath,
      [
        rehearsal,
        '--public-artifact',
        publicRoot,
        '--public-sha256',
        '0'.repeat(64),
        '--previous-artifact',
        previousRoot,
        '--previous-sha256',
        '0'.repeat(64),
        '--candidate-sha',
        'a'.repeat(40),
        '--output',
        output,
      ],
      { encoding: 'utf8' },
    );
    assert.notEqual(result.status, 0, `${name} alias unexpectedly accepted`);
    await assert.rejects(lstat(join(target, 'scratch')), { code: 'ENOENT' });
  }
});

test('release remains blocked when writable report JSON claims every proof passed', async (t) => {
  const root = await fixture(t);
  const publicRoot = join(root, 'public');
  const previousRoot = join(root, 'previous');
  await mkdir(publicRoot);
  await mkdir(previousRoot);
  const candidateSha = 'a'.repeat(40);
  const sourceRevision = 'b'.repeat(40);
  const publicBytes = Buffer.from(
    JSON.stringify({
      source: { revision: candidateSha, dirty: false },
      entries: ['temari', 'poteto-mode', 'closeout'],
    }),
  );
  const previousBytes = Buffer.from(
    JSON.stringify({
      sourceRevision,
    }),
  );
  await writeFile(join(publicRoot, 'public-entry-manifest.json'), publicBytes);
  await writeFile(
    join(previousRoot, '.temari-distribution.json'),
    previousBytes,
  );
  const publicTreeSha256 = await treeSha(publicRoot);
  const previousTreeSha256 = await treeSha(previousRoot);
  const ids = Array.from(
    { length: 13 },
    (_, index) => `V41-${String(index + 1).padStart(2, '0')}`,
  );
  const matrixPath = join(root, 'matrix.md');
  await writeFile(
    matrixPath,
    [
      `Portable v4.1 source revision: \`${sourceRevision}\``,
      ...ids.map((id) => `| ${id} | a | b | c | d | e | f |`),
    ].join('\n'),
  );
  const reportPath = join(root, 'report.json');
  await writeFile(
    reportPath,
    JSON.stringify({
      candidateSha,
      input: {
        publicArtifact: publicRoot,
        publicManifestSha256: sha(publicBytes),
        publicTreeSha256,
        previousArtifact: previousRoot,
        previousManifestSha256: sha(previousBytes),
        previousTreeSha256,
      },
      rollback: {
        beforeSha256: publicTreeSha256,
        afterSha256: previousTreeSha256,
        previousProjectionSha256: previousTreeSha256,
      },
      rowProofs: Object.fromEntries(
        ids.map((id) => [id, { status: 'PASS', evidence: 'unverified' }]),
      ),
      gates: {
        localPreparatoryRehearsal: 'PASS',
        qa: 'PASS',
        privacy: 'PASS',
        sharedService: 'PASS',
        secondHost: 'PASS',
        cutover: 'PASS',
      },
    }),
  );
  const result = spawnSync(
    process.execPath,
    [drift, '--matrix', matrixPath, '--rehearsal', reportPath, '--release'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 2, result.stderr);
  const verdict = JSON.parse(result.stdout);
  assert.equal(verdict.release, 'BLOCKED');
  assert.equal(verdict.reason, 'external-proof-not-verified');
  assert.deepEqual(verdict.missingProof, ids);
});
