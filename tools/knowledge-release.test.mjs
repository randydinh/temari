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

async function derivedRelease(
  name,
  version,
  changeSkill = false,
  historicalRegistrar = undefined,
) {
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
  if (historicalRegistrar) {
    const upstreamPath = `${prefix}registrar/UPSTREAM.json`;
    const upstream = JSON.parse(files.get(upstreamPath).toString());
    upstream.upstream.commit = '760926907669ae34bd1861732edbbf8f5afaf588';
    if (historicalRegistrar.invalidInnerHash)
      upstream.files[0].sha256 = '0'.repeat(64);
    files.set(upstreamPath, jsonBytes(upstream));
    if (
      historicalRegistrar.catalogInstallation ||
      historicalRegistrar.catalogSourcePath
    ) {
      const catalogPath = '.agents/plugins/marketplace.json';
      const catalog = JSON.parse(files.get(catalogPath).toString());
      if (historicalRegistrar.catalogInstallation)
        catalog.plugins[0].policy.installation =
          historicalRegistrar.catalogInstallation;
      if (historicalRegistrar.catalogSourcePath)
        catalog.plugins[0].source.path = historicalRegistrar.catalogSourcePath;
      files.set(catalogPath, jsonBytes(catalog));
    }
  }
  const manifest = JSON.parse(files.get(manifestPath).toString());
  if (historicalRegistrar?.dirtySource) manifest.source.dirty = true;
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
  if (historicalRegistrar?.readmeVariant)
    files.set(
      'README.md',
      Buffer.concat([
        files.get('README.md'),
        Buffer.from('\nPrior installation instructions differ.\n'),
      ]),
    );
  if (historicalRegistrar?.readmeMalformed)
    files.set('README.md', Buffer.from('unrelated notes\n'));
  if (historicalRegistrar?.readmeMissing) files.delete('README.md');
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
    '0.1.2',
  );
  const contents = parseArchive(await readFile(archives[0]));
  assert.equal(
    JSON.parse(contents.get('.agents/plugins/marketplace.json').toString())
      .plugins[0].policy.installation,
    'INSTALLED_BY_DEFAULT',
  );
  assert.match(
    contents.get('README.md').toString(),
    /Adding the marketplace alone did not auto-install the plugin in the tested macOS Codex CLI/,
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
  const changed = await derivedRelease('changed-source.tar.gz', '0.1.2', true);
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
  const lower = await derivedRelease('lower-version.tar.gz', '0.1.1');
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

test('externally pinned historical 0.1.1 release admits current 0.1.2 successor', async (t) => {
  const prior =
    process.env.KNOWLEDGE_RELEASE_TEST_PRIOR_ARCHIVE ||
    '/private/tmp/content-registrar-knowledge-0.1.1-final-a-20261003.tar.gz';
  try {
    await stat(prior);
  } catch (error) {
    if (error.code === 'ENOENT')
      return t.skip('Historical release fixture unavailable');
    throw error;
  }
  assert.equal(release.version, '0.1.2');
  assert.equal(
    (
      await checkKnowledgeReleaseSuccessor(
        prior,
        '6859336960a6eca0c608ad2fb3a276ba8ef0df4df58e48f995ea3081897081b6',
        archives[0],
        release.archiveSha256,
      )
    ).succession,
    'advanced',
  );
  const output = join(root, 'historical-successor.tar.gz');
  const packaged = await packageKnowledgeRelease(
    plugin,
    manifestSha256,
    output,
    {
      archive: prior,
      sha256:
        '6859336960a6eca0c608ad2fb3a276ba8ef0df4df58e48f995ea3081897081b6',
    },
  );
  assert.equal(packaged.succession, 'advanced');
  assert.equal(packaged.archiveSha256, release.archiveSha256);
});

test('historical pin is scoped to prior and still checks inner Registrar hashes', async () => {
  const prior = await derivedRelease(
    'synthetic-historical-prior.tar.gz',
    '0.1.0',
    false,
    {},
  );
  await assert.rejects(
    checkKnowledgeRelease(prior.path, prior.sha256),
    /differs from reviewed upstream inventory/,
  );
  assert.equal(
    (
      await checkKnowledgeReleaseSuccessor(
        prior.path,
        prior.sha256,
        archives[0],
        release.archiveSha256,
      )
    ).succession,
    'advanced',
  );
  const badInner = await derivedRelease(
    'bad-historical-inner-hash.tar.gz',
    '0.1.0',
    false,
    { invalidInnerHash: true },
  );
  await assert.rejects(
    checkKnowledgeReleaseSuccessor(
      badInner.path,
      badInner.sha256,
      archives[0],
      release.archiveSha256,
    ),
    /Registrar payload hash drift/,
  );
  const dirty = await derivedRelease(
    'dirty-historical-prior.tar.gz',
    '0.1.0',
    false,
    { dirtySource: true },
  );
  await assert.rejects(
    checkKnowledgeReleaseSuccessor(
      dirty.path,
      dirty.sha256,
      archives[0],
      release.archiveSha256,
    ),
    /Release requires a clean source commit/,
  );
  const tampered = join(root, 'tampered-historical.tar.gz');
  const bytes = await readFile(prior.path);
  bytes[Math.floor(bytes.length / 2)] ^= 1;
  await writeFile(tampered, bytes);
  await assert.rejects(
    checkKnowledgeReleaseSuccessor(
      tampered,
      prior.sha256,
      archives[0],
      release.archiveSha256,
    ),
    /digest mismatch/,
  );
});

test('historical catalog admits a prior install policy but refuses changed identity', async () => {
  const policyVariant = await derivedRelease(
    'historical-policy-variant.tar.gz',
    '0.1.0',
    false,
    { catalogInstallation: 'AVAILABLE' },
  );
  await assert.rejects(
    checkKnowledgeRelease(policyVariant.path, policyVariant.sha256),
    /Expected values to be strictly deep-equal/,
  );
  assert.equal(
    (
      await checkKnowledgeReleaseSuccessor(
        policyVariant.path,
        policyVariant.sha256,
        archives[0],
        release.archiveSha256,
      )
    ).succession,
    'advanced',
  );
  const malformed = await derivedRelease(
    'malformed-historical-catalog.tar.gz',
    '0.1.0',
    false,
    { catalogSourcePath: '../wrong-plugin' },
  );
  await assert.rejects(
    checkKnowledgeReleaseSuccessor(
      malformed.path,
      malformed.sha256,
      archives[0],
      release.archiveSha256,
    ),
    /Expected values to be strictly deep-equal/,
  );
  const forbiddenPolicy = await derivedRelease(
    'forbidden-historical-policy.tar.gz',
    '0.1.0',
    false,
    { catalogInstallation: 'SILENT_AUTO_INSTALL' },
  );
  await assert.rejects(
    checkKnowledgeReleaseSuccessor(
      forbiddenPolicy.path,
      forbiddenPolicy.sha256,
      archives[0],
      release.archiveSha256,
    ),
    /Historical marketplace installation policy is invalid/,
  );
});

test('historical README may evolve but must remain bounded and identify its release', async () => {
  const prior = await derivedRelease(
    'historical-readme-variant.tar.gz',
    '0.1.0',
    false,
    { readmeVariant: true },
  );
  await assert.rejects(
    checkKnowledgeRelease(prior.path, prior.sha256),
    /Expected values to be strictly deep-equal/,
  );
  assert.equal(
    (
      await checkKnowledgeReleaseSuccessor(
        prior.path,
        prior.sha256,
        archives[0],
        release.archiveSha256,
      )
    ).succession,
    'advanced',
  );
  const malformed = await derivedRelease(
    'historical-readme-malformed.tar.gz',
    '0.1.0',
    false,
    { readmeMalformed: true },
  );
  await assert.rejects(
    checkKnowledgeReleaseSuccessor(
      malformed.path,
      malformed.sha256,
      archives[0],
      release.archiveSha256,
    ),
    /Historical README metadata does not match its release/,
  );
  const missing = await derivedRelease(
    'historical-readme-missing.tar.gz',
    '0.1.0',
    false,
    { readmeMissing: true },
  );
  await assert.rejects(
    checkKnowledgeReleaseSuccessor(
      missing.path,
      missing.sha256,
      archives[0],
      release.archiveSha256,
    ),
    /Historical README is missing or unreasonably large/,
  );
});
