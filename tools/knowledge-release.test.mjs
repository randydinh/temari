import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  archiveBytes,
  checkKnowledgeRelease,
  checkKnowledgeReleaseSuccessor,
  packageKnowledgeRelease,
  parseArchive,
} from './knowledge-release.mjs';
import { packageKnowledgePlugin } from './knowledge-plugin.mjs';

let root;
let plugin;
let manifestSha256;
let archives;
let release;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

async function derivedRelease(name, version, changeSkill = false) {
  const files = parseArchive(await readFile(archives[0]));
  const prefix = 'plugins/content-registrar-knowledge/';
  const pluginPath = `${prefix}.codex-plugin/plugin.json`;
  const manifestPath = `${prefix}knowledge-plugin-manifest.json`;
  const skillPath = `${prefix}skills/content-registrar-knowledge/SKILL.md`;
  const plugin = JSON.parse(files.get(pluginPath).toString());
  plugin.version = version;
  files.set(pluginPath, jsonBytes(plugin));
  if (changeSkill)
    files.set(
      skillPath,
      Buffer.concat([files.get(skillPath), Buffer.from('\nUpdated.\n')]),
    );
  const manifest = JSON.parse(files.get(manifestPath).toString());
  manifest.source.additionalFiles.find(
    (file) =>
      file.path ===
      'packages/workflow-runtime/knowledge-plugin/.codex-plugin/plugin.json',
  ).sha256 = sha256(files.get(pluginPath));
  manifest.source.additionalFiles.find(
    (file) =>
      file.path ===
      'packages/workflow-runtime/knowledge-plugin/.codex-plugin/plugin.json',
  ).bytes = files.get(pluginPath).length;
  manifest.files = manifest.files.map((file) => {
    const path = `${prefix}${file.path}`;
    return {
      ...file,
      sha256: sha256(files.get(path)),
      bytes: files.get(path).length,
    };
  });
  files.set(manifestPath, jsonBytes(manifest));
  const releaseData = JSON.parse(files.get('RELEASE.json').toString());
  releaseData.version = version;
  releaseData.pluginManifestSha256 = sha256(files.get(manifestPath));
  files.set(
    'README.md',
    Buffer.from(
      files
        .get('README.md')
        .toString()
        .replace(
          `private release ${release.version}`,
          `private release ${version}`,
        )
        .replace(
          release.pluginManifestSha256,
          releaseData.pluginManifestSha256,
        ),
    ),
  );
  releaseData.files = [...files]
    .filter(([path]) => path !== 'RELEASE.json')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, bytes]) => ({
      path,
      sha256: sha256(bytes),
      bytes: bytes.length,
    }));
  files.set('RELEASE.json', jsonBytes(releaseData));
  const bytes = archiveBytes(files);
  const path = join(root, name);
  await writeFile(path, bytes);
  return { path, sha256: sha256(bytes) };
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'knowledge-release-test-'));
  plugin = process.env.KNOWLEDGE_RELEASE_TEST_ARTIFACT || join(root, 'plugin');
  if (process.env.KNOWLEDGE_RELEASE_TEST_ARTIFACT) {
    manifestSha256 = process.env.KNOWLEDGE_RELEASE_TEST_MANIFEST_SHA256;
  } else {
    await packageKnowledgePlugin(plugin);
    manifestSha256 = createHash('sha256')
      .update(await readFile(join(plugin, 'knowledge-plugin-manifest.json')))
      .digest('hex');
  }
  archives = [join(root, 'a.tar.gz'), join(root, 'b.tar.gz')];
  release = await packageKnowledgeRelease(plugin, manifestSha256, archives[0]);
  await packageKnowledgeRelease(plugin, manifestSha256, archives[1]);
});

after(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

test('two versioned private release builds are byte identical and digest checked', async () => {
  assert.deepEqual(await readFile(archives[0]), await readFile(archives[1]));
  assert.equal(
    (await checkKnowledgeRelease(archives[0], release.archiveSha256)).version,
    '0.1.0',
  );
  const existing = await readFile(archives[0]);
  await assert.rejects(
    packageKnowledgeRelease(plugin, manifestSha256, archives[0]),
    { code: 'EEXIST' },
  );
  assert.deepEqual(await readFile(archives[0]), existing);
  const tampered = join(root, 'tampered.tar.gz');
  const bytes = await readFile(archives[0]);
  bytes[Math.floor(bytes.length / 2)] ^= 1;
  await writeFile(tampered, bytes);
  await assert.rejects(
    checkKnowledgeRelease(tampered, release.archiveSha256),
    /digest mismatch/,
  );
});

test(
  'file-size write failure never publishes a partial archive',
  {
    skip: process.platform === 'win32',
  },
  async () => {
    const output = join(root, 'write-failure.tar.gz');
    const command = spawnSync(
      'bash',
      [
        '-c',
        'ulimit -f 1; exec "$@"',
        '--',
        process.execPath,
        fileURLToPath(new URL('./knowledge-release.mjs', import.meta.url)),
        'package',
        '--artifact',
        plugin,
        '--expected-manifest-sha256',
        manifestSha256,
        '--output',
        output,
      ],
      { encoding: 'utf8', timeout: 30_000 },
    );
    assert.notEqual(command.status, 0);
    assert(
      command.signal === 'SIGXFSZ' ||
        /EFBIG|file size limit/i.test(command.stderr),
      `Expected a file-size write failure, got: ${command.stderr}`,
    );
    await assert.rejects(stat(output), { code: 'ENOENT' });
  },
);

test('archive extracts into isolated recipient root and launcher remains usable', async () => {
  const recipient = join(root, 'recipient');
  await mkdir(recipient);
  execFileSync('tar', ['-xzf', archives[0], '-C', recipient]);
  const installed = join(recipient, 'plugins/content-registrar-knowledge');
  const home = join(root, 'recipient-home');
  const status = JSON.parse(
    execFileSync(
      process.execPath,
      [join(installed, 'bin/temari-knowledge.mjs'), 'status', '--home', home],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_OPTIONS: '',
          NODE_PATH: '',
          TYPESAFE_API_KEY: '',
        },
        timeout: 30_000,
      },
    ),
  );
  assert.deepEqual(status.providerSelection, {
    selection: 'registrar',
    phase: 'uninitialized',
    persisted: false,
  });
  assert.equal(
    JSON.parse((await readFile(join(recipient, 'RELEASE.json'))).toString())
      .pluginManifestSha256,
    manifestSha256,
  );
});

test('recipient checker rejects a digest-pinned dirty-source release', async () => {
  const files = parseArchive(await readFile(archives[0]));
  const manifestPath =
    'plugins/content-registrar-knowledge/knowledge-plugin-manifest.json';
  const manifest = JSON.parse(files.get(manifestPath).toString());
  manifest.source.dirty = true;
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  files.set(manifestPath, manifestBytes);
  const previousHash = release.pluginManifestSha256;
  const newHash = createHash('sha256').update(manifestBytes).digest('hex');
  const releaseData = JSON.parse(files.get('RELEASE.json').toString());
  releaseData.pluginManifestSha256 = newHash;
  files.set(
    'README.md',
    Buffer.from(
      files.get('README.md').toString().replace(previousHash, newHash),
    ),
  );
  releaseData.files = [...files]
    .filter(([path]) => path !== 'RELEASE.json')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, bytes]) => ({
      path,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
    }));
  files.set(
    'RELEASE.json',
    Buffer.from(`${JSON.stringify(releaseData, null, 2)}\n`),
  );
  const forged = archiveBytes(files);
  const path = join(root, 'dirty-source.tar.gz');
  await writeFile(path, forged);
  await assert.rejects(
    checkKnowledgeRelease(
      path,
      createHash('sha256').update(forged).digest('hex'),
    ),
    /Release requires a clean source commit/,
  );
});

test('successor guard rejects changed source with unchanged or lower version', async () => {
  const changed = await derivedRelease('changed-source.tar.gz', '0.1.0', true);
  await checkKnowledgeRelease(changed.path, changed.sha256);
  await assert.rejects(
    checkKnowledgeReleaseSuccessor(
      archives[0],
      release.archiveSha256,
      changed.path,
      changed.sha256,
    ),
    /Changed release requires a higher plugin version/,
  );
  const lower = await derivedRelease('lower-version.tar.gz', '0.0.9');
  await checkKnowledgeRelease(lower.path, lower.sha256);
  await assert.rejects(
    checkKnowledgeReleaseSuccessor(
      archives[0],
      release.archiveSha256,
      lower.path,
      lower.sha256,
    ),
    /Changed release requires a higher plugin version/,
  );
});

test('successor guard accepts higher version and identical digest', async () => {
  const higher = await derivedRelease('higher-version.tar.gz', '0.2.0');
  assert.equal(
    (
      await checkKnowledgeReleaseSuccessor(
        archives[0],
        release.archiveSha256,
        higher.path,
        higher.sha256,
      )
    ).succession,
    'advanced',
  );
  assert.equal(
    (
      await checkKnowledgeReleaseSuccessor(
        archives[0],
        release.archiveSha256,
        archives[1],
        release.archiveSha256,
      )
    ).succession,
    'identical',
  );
});

test('malformed versions and missing prior pin fail closed', async () => {
  for (const version of ['01.0.0', '0.1.0-beta', '9007199254740992.0.0']) {
    const malformed = await derivedRelease(`bad-${version}.tar.gz`, version);
    await assert.rejects(
      checkKnowledgeRelease(malformed.path, malformed.sha256),
      /Invalid stable plugin version/,
    );
  }
  await assert.rejects(
    checkKnowledgeReleaseSuccessor(
      archives[0],
      '0'.repeat(64),
      archives[1],
      release.archiveSha256,
    ),
    /digest mismatch/,
  );
});

test('package path enforces prior pin and removes refused candidate', async () => {
  const prior = await derivedRelease('future-prior.tar.gz', '0.2.0');
  const refused = join(root, 'refused.tar.gz');
  await assert.rejects(
    packageKnowledgeRelease(plugin, manifestSha256, refused, {
      archive: prior.path,
      sha256: prior.sha256,
    }),
    /Changed release requires a higher plugin version/,
  );
  await assert.rejects(stat(refused), { code: 'ENOENT' });
  const accepted = join(root, 'identical-successor.tar.gz');
  assert.equal(
    (
      await packageKnowledgeRelease(plugin, manifestSha256, accepted, {
        archive: archives[0],
        sha256: release.archiveSha256,
      })
    ).succession,
    'identical',
  );
});
