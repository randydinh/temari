import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  assertTemariVersionSuccessor,
  assertTemariPackagingSource,
  checkTemariHistoricalRelease,
  checkTemariRelease,
  checkTemariReleaseRoot,
  packageTemariHistoricalRelease,
  parseTemariArchive,
  temariArchiveBytes,
} from './temari-release.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const artifact = process.env.TEMARI_HISTORICAL_ARTIFACT;
const manifestSha256 = process.env.TEMARI_HISTORICAL_MANIFEST_SHA256;
const fixtureReady = Boolean(
  artifact && manifestSha256 && existsSync(artifact),
);
if (!fixtureReady && process.env.TEMARI_TEST_PURE_UNITS !== '1')
  throw new Error(
    'Release acceptance requires independently pinned TEMARI_HISTORICAL_ARTIFACT and TEMARI_HISTORICAL_MANIFEST_SHA256; TEMARI_TEST_PURE_UNITS=1 is an explicit unit-only opt-out, not release acceptance',
  );
const fixtureOptions = {
  skip: fixtureReady
    ? false
    : 'Set independently pinned TEMARI_HISTORICAL_ARTIFACT and TEMARI_HISTORICAL_MANIFEST_SHA256 for the clean shipped predecessor fixture',
};
let root, archive, release;
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'temari-release-test-'));
  if (fixtureReady) {
    archive = join(root, 'prior.tar.gz');
    release = await packageTemariHistoricalRelease(
      artifact,
      manifestSha256,
      archive,
    );
  }
});
after(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

function sampleFiles() {
  return new Map([
    [
      'bin/launcher.mjs',
      { bytes: Buffer.from('#!/usr/bin/env node\n'), executable: true },
    ],
    ['scripts/run.sh', { bytes: Buffer.from('#!/bin/sh\n'), executable: true }],
    ['docs/readme.md', { bytes: Buffer.from('# Readme\n'), executable: false }],
  ]);
}
function modifyHeader(bytes, change) {
  const tar = gunzipSync(bytes);
  change(tar.subarray(0, 512));
  tar.fill(0x20, 148, 156);
  const checksum = tar.subarray(0, 512).reduce((sum, byte) => sum + byte, 0);
  Buffer.from(`${checksum.toString(8).padStart(6, '0')}\0 `).copy(tar, 148);
  return gzipSync(tar, { level: 9, mtime: 0 });
}

test('canonical archive bytes are deterministic and preserve every executable flag', () => {
  const files = sampleFiles(),
    bytes = temariArchiveBytes(files);
  assert.deepEqual(bytes, temariArchiveBytes(new Map([...files].reverse())));
  const decoded = parseTemariArchive(bytes);
  assert.equal(decoded.get('bin/launcher.mjs').executable, true);
  assert.equal(decoded.get('scripts/run.sh').executable, true);
  assert.equal(decoded.get('docs/readme.md').executable, false);
  assert.deepEqual(temariArchiveBytes(decoded), bytes);
});

test('archive parser refuses traversal, links, duplicates, platform collisions and damaged encodings', () => {
  const files = sampleFiles(),
    bytes = temariArchiveBytes(files);
  for (const name of ['../escape', '/absolute', 'C:drive', 'a\\b', 'a//b']) {
    const changed = modifyHeader(bytes, (header) => {
      header.fill(0, 0, 100);
      Buffer.from(name).copy(header);
    });
    assert.throws(() => parseTemariArchive(changed), /Unsafe/);
  }
  for (const type of ['1', '2', '5'])
    assert.throws(
      () =>
        parseTemariArchive(
          modifyHeader(bytes, (header) => {
            header[156] = type.charCodeAt(0);
          }),
        ),
      /Only regular/,
    );
  assert.throws(
    () =>
      parseTemariArchive(
        modifyHeader(bytes, (header) => {
          Buffer.from('0000777\0').copy(header, 100);
        }),
      ),
    /mode/,
  );
  const tar = gunzipSync(bytes),
    firstSize = Number.parseInt(tar.subarray(124, 136).toString(), 8);
  const first = tar.subarray(0, 512 + Math.ceil(firstSize / 512) * 512);
  assert.throws(
    () => parseTemariArchive(gzipSync(Buffer.concat([first, tar]))),
    /Duplicate/,
  );
  assert.throws(
    () =>
      temariArchiveBytes(
        new Map([
          ['file', { bytes: Buffer.alloc(0), executable: false }],
          ['FILE', { bytes: Buffer.alloc(0), executable: false }],
        ]),
      ),
    /conflicting/,
  );
  assert.throws(
    () =>
      temariArchiveBytes(
        new Map([
          ['file', { bytes: Buffer.alloc(0), executable: false }],
          ['file/child', { bytes: Buffer.alloc(0), executable: false }],
        ]),
      ),
    /conflicting/,
  );
  const badChecksum = Buffer.from(tar);
  badChecksum[0] ^= 1;
  assert.throws(() => parseTemariArchive(gzipSync(badChecksum)), /checksum/);
  assert.throws(
    () => parseTemariArchive(gzipSync(tar.subarray(0, 100))),
    /end blocks/,
  );
  assert.throws(() => parseTemariArchive(Buffer.from('not gzip')));
});

test('version succession compares precedence and rejects same version, metadata-only bumps, and downgrade', () => {
  assert.doesNotThrow(() =>
    assertTemariVersionSuccessor('0.15.4+codex.2', '0.15.5'),
  );
  for (const [prior, candidate] of [
    ['0.15.5', '0.15.5'],
    ['0.15.4+codex.2', '0.15.4+codex.3'],
    ['0.15.5', '0.15.4'],
    ['1.0.0', '0.99.99'],
  ])
    assert.throws(
      () => assertTemariVersionSuccessor(prior, candidate),
      /higher plugin version/,
    );
  for (const value of ['0.15.5-beta', '00.15.5', '0.15', 'latest'])
    assert.throws(
      () => assertTemariVersionSuccessor('0.15.4', value),
      /Invalid stable/,
    );
});

test('packaging source gate binds a real clean distribution commit and refuses dirty helper bytes', async () => {
  const source = join(root, 'packaging-source');
  await mkdir(join(source, 'tools'), { recursive: true });
  for (const name of [
    'temari-release.mjs',
    'temari-release-verify.mjs',
    'temari-install-state.mjs',
  ])
    await writeFile(join(source, 'tools', name), '// tracked fixture source\n');
  const git = (...args) =>
    execFileSync('git', ['-C', source, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Temari release test',
        GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'Temari release test',
        GIT_COMMITTER_EMAIL: 'test@example.invalid',
      },
    }).trim();
  git('init', '-q');
  git('add', 'tools');
  git('commit', '-qm', 'Record genuine packaging fixture');
  const commit = git('rev-parse', 'HEAD');
  assert.equal(assertTemariPackagingSource(source, commit), commit);
  assert.throws(
    () => assertTemariPackagingSource(source, 'a'.repeat(40)),
    /must equal/,
  );
  assert.equal(
    assertTemariPackagingSource(source, 'a'.repeat(40), { historical: true }),
    commit,
  );
  await writeFile(
    join(source, 'tools/temari-release-verify.mjs'),
    '// uncommitted changed helper\n',
  );
  assert.throws(
    () => assertTemariPackagingSource(source, commit, { historical: true }),
    /clean distribution source/,
  );
});

test('release CLI refuses irrelevant, missing and duplicate flags before artifact or release work', () => {
  const tool = fileURLToPath(new URL('./temari-release.mjs', import.meta.url));
  const output = join(root, 'must-not-exist.tar.gz');
  const fixtures = [
    [
      'package',
      '--artifact',
      '/missing',
      '--expected-manifest-sha256',
      'a'.repeat(64),
      '--output',
      output,
      '--prior-archive',
      '/unverified-prior',
      '--prior-sha256',
      'b'.repeat(64),
    ],
    [
      'check',
      '--archive',
      '/missing',
      '--expected-sha256',
      'a'.repeat(64),
      '--output',
      output,
    ],
    ['successor', '--archive', '/missing', '--expected-sha256', 'a'.repeat(64)],
    [
      'check',
      '--archive',
      '/missing',
      '--archive',
      '/different',
      '--expected-sha256',
      'a'.repeat(64),
    ],
  ];
  for (const args of fixtures) {
    assert.throws(
      () =>
        execFileSync(process.execPath, [tool, ...args], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      (error) =>
        error.status === 1 &&
        /declared paths|Duplicate release flags/.test(error.stderr),
    );
    assert.equal(existsSync(output), false);
  }
});

test('wrong external archive digest is refused before decompression', async () => {
  const path = join(root, 'opaque.tar.gz');
  await writeFile(path, Buffer.from('opaque'));
  await assert.rejects(
    checkTemariRelease(path, 'a'.repeat(64)),
    /digest mismatch/,
  );
});

test(
  'clean historical release is deterministic, pinned, and preserves the genuinely shipped shape',
  fixtureOptions,
  async () => {
    const repeated = join(root, 'prior-repeat.tar.gz');
    const second = await packageTemariHistoricalRelease(
      artifact,
      manifestSha256,
      repeated,
    );
    assert.equal(second.archiveSha256, release.archiveSha256);
    const checked = await checkTemariHistoricalRelease(
      archive,
      release.archiveSha256,
    );
    assert.equal(checked.sourceRevision, release.sourceRevision);
    const files = parseTemariArchive(await readFile(archive));
    assert(
      files.has('temari-release-verify.mjs') &&
        files.has('temari-install-state.mjs'),
    );
    assert(
      ![...files.keys()].some((path) =>
        path.startsWith('plugins/temari/method/'),
      ),
    );
    const guidance = files.get('README.md').bytes.toString('utf8');
    assert(guidance.includes(' --historical'));
    assert(
      guidance.includes('--candidate-root /absolute/current-release-root'),
    );
    assert(guidance.includes('--prior-root /absolute/release-root'));
    assert(!guidance.includes('--candidate-root /absolute/release-root'));
    assert(
      !guidance.includes('codex plugin marketplace add /absolute/release-root'),
    );
    await assert.rejects(
      checkTemariRelease(archive, release.archiveSha256),
      /Unsupported Temari release version/,
    );
    await assert.rejects(
      packageTemariHistoricalRelease(artifact, manifestSha256, archive),
      /EEXIST/,
    );
  },
);

test(
  'relocated recipient verification runs without a checkout or developer dependencies and refuses tamper',
  fixtureOptions,
  async () => {
    const relocated = join(root, 'relocated release');
    const files = parseTemariArchive(await readFile(archive));
    for (const [path, file] of files) {
      await mkdir(join(relocated, path, '..'), { recursive: true });
      await writeFile(join(relocated, path), file.bytes);
      await chmod(join(relocated, path), file.executable ? 0o755 : 0o644);
    }
    const args = [
      join(relocated, 'temari-release-verify.mjs'),
      '--root',
      relocated,
      '--expected-release-sha256',
      release.releaseSha256,
      '--expected-manifest-sha256',
      manifestSha256,
      '--historical',
    ];
    const result = JSON.parse(
      execFileSync(process.execPath, args, {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
      }),
    );
    assert.equal(result.sourceRevision, release.sourceRevision);
    await assert.rejects(
      checkTemariReleaseRoot(relocated, 'a'.repeat(64), manifestSha256, {
        historical: true,
      }),
      /descriptor digest mismatch/,
    );
    const target = join(relocated, 'plugins/temari/bin/temari.mjs');
    if (process.platform !== 'win32') {
      await chmod(target, 0o644);
      await assert.rejects(
        checkTemariReleaseRoot(
          relocated,
          release.releaseSha256,
          manifestSha256,
          { historical: true },
        ),
        /modes/,
      );
      await chmod(target, 0o755);
    }
    await writeFile(target, '# Tampered');
    await assert.rejects(
      checkTemariReleaseRoot(relocated, release.releaseSha256, manifestSha256, {
        historical: true,
      }),
      /inventory/,
    );
  },
);

test(
  'historical packaging refuses dirty source identity and symlink input without creating an archive',
  fixtureOptions,
  async () => {
    const dirty = join(root, 'dirty artifact');
    await cp(artifact, dirty, { recursive: true });
    const path = join(dirty, 'public-entry-manifest.json'),
      value = JSON.parse(await readFile(path, 'utf8'));
    // This negative fixture is explicitly dirty; it is never relabeled as a clean release.
    value.source.dirty = true;
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    await writeFile(path, bytes);
    const output = join(root, 'dirty.tar.gz');
    await assert.rejects(
      packageTemariHistoricalRelease(dirty, sha256(bytes), output),
      /clean source commit/,
    );
    assert.equal(existsSync(output), false);
    const link = join(root, 'artifact symlink');
    await symlink(artifact, link);
    await assert.rejects(
      packageTemariHistoricalRelease(
        link,
        manifestSha256,
        join(root, 'linked.tar.gz'),
      ),
      /Symlink/,
    );
  },
);
