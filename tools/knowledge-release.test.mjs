import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { checkKnowledgeRelease, packageKnowledgeRelease } from './knowledge-release.mjs';
import { packageKnowledgePlugin } from './knowledge-plugin.mjs';

let root;
let plugin;
let manifestSha256;
let archives;
let release;

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

after(async () => { if (root) await rm(root, { recursive: true, force: true }); });

test('two versioned private release builds are byte identical and digest checked', async () => {
  assert.deepEqual(await readFile(archives[0]), await readFile(archives[1]));
  assert.equal((await checkKnowledgeRelease(archives[0], release.archiveSha256)).version, '0.1.0');
  await assert.rejects(packageKnowledgeRelease(plugin, manifestSha256, archives[0]), { code: 'EEXIST' });
  const tampered = join(root, 'tampered.tar.gz');
  const bytes = await readFile(archives[0]);
  bytes[Math.floor(bytes.length / 2)] ^= 1;
  await writeFile(tampered, bytes);
  await assert.rejects(checkKnowledgeRelease(tampered, release.archiveSha256), /digest mismatch/);
});

test('archive extracts into isolated recipient root and launcher remains usable', async () => {
  const recipient = join(root, 'recipient');
  await mkdir(recipient);
  execFileSync('tar', ['-xzf', archives[0], '-C', recipient]);
  const installed = join(recipient, 'plugins/content-registrar-knowledge');
  const home = join(root, 'recipient-home');
  const status = JSON.parse(execFileSync(process.execPath, [
    join(installed, 'bin/temari-knowledge.mjs'), 'status', '--home', home,
  ], {
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', TYPESAFE_API_KEY: '' },
    timeout: 30_000,
  }));
  assert.deepEqual(status.providerSelection, {
    selection: 'registrar', phase: 'uninitialized', persisted: false,
  });
  assert.equal(JSON.parse((await readFile(join(recipient, 'RELEASE.json'))).toString()).pluginManifestSha256, manifestSha256);
});
