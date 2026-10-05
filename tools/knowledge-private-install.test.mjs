import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { packageKnowledgePlugin } from './knowledge-plugin.mjs';
import { packageKnowledgeRelease } from './knowledge-release.mjs';
import { runPrivateKnowledgeInstall } from './knowledge-private-install.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const pinnedArchive =
  '/private/tmp/content-registrar-knowledge-0.1.2-final-a-20261003.tar.gz';
const pinnedSha256 =
  '709783cee705373df1ba1358e0fbba703d305ee13157976e37bbcf801399d583';
let root;
let archive;
let expectedSha256;
let fakeBin;

const fakeCodex = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const home = process.env.CODEX_HOME;
const statePath = path.join(home, 'fake-state.json');
const callsPath = path.join(home, 'fake-calls.jsonl');
const args = process.argv.slice(2);
fs.mkdirSync(home, { recursive: true });
fs.appendFileSync(callsPath, JSON.stringify(args) + '\\n');
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath)) : {};
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const reply = (data) => process.stdout.write(JSON.stringify(data));
const root = state.marketplaceRoot;
const entry = root && {
  pluginId: 'content-registrar-knowledge@temari-knowledge',
  name: 'content-registrar-knowledge',
  marketplaceName: 'temari-knowledge',
  version: state.version || '0.1.2',
  installed: !!state.installed,
  enabled: !!state.installed,
  source: { source: 'local', path: path.join(root, 'plugins/content-registrar-knowledge') },
  marketplaceSource: { sourceType: 'local', source: root },
  installPolicy: 'INSTALLED_BY_DEFAULT',
  authPolicy: 'ON_INSTALL',
};
const foreignInstalled = state.foreignInstalled && {
  pluginId: 'content-registrar-knowledge@another-marketplace',
  name: 'content-registrar-knowledge',
  marketplaceName: 'another-marketplace',
  installed: true,
};
if (args.join(' ') === 'plugin marketplace list --json') {
  reply({ marketplaces: root ? [{ name: 'temari-knowledge', root,
    marketplaceSource: { sourceType: 'local', source: root } }] : [] });
} else if (args.join(' ') === 'plugin list --json') {
  reply({ installed: [
    ...(entry && state.installed ? [entry] : []),
    ...(foreignInstalled ? [foreignInstalled] : []),
  ], available: [] });
} else if (args.join(' ') === 'plugin list --marketplace temari-knowledge --available --json') {
  reply({ installed: entry && state.installed ? [entry] : [],
    available: entry && !state.installed ? [entry] : [] });
} else if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add') {
  if (state.failMarketplaceAdd) process.exit(2);
  state.marketplaceRoot = args[3];
  save();
  reply({ marketplaceName: 'temari-knowledge', installedRoot: args[3] });
} else if (args[0] === 'plugin' && args[1] === 'add') {
  if (state.failPluginAdd) process.exit(2);
  state.installed = true;
  save();
  reply({ pluginId: args[2], version: '0.1.2' });
} else process.exit(2);
`;

async function fixture() {
  const directory = await mkdtemp(join(root, 'case-'));
  const codexHome = join(directory, 'codex-home');
  await mkdir(codexHome);
  const stateRoot = join(directory, 'temari-state');
  const options = {
    archive,
    expectedSha256,
    codexHome,
    stateRoot,
    codexBin: fakeBin,
  };
  const statePath = join(codexHome, 'fake-state.json');
  const callsPath = join(codexHome, 'fake-calls.jsonl');
  const state = async (value) => {
    await writeFile(statePath, JSON.stringify(value));
  };
  const calls = async () => {
    try {
      return (await readFile(callsPath, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(JSON.parse);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  };
  return { options, state, calls, statePath };
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'knowledge-private-install-test-'));
  fakeBin = join(root, 'fake-codex.cjs');
  await writeFile(fakeBin, fakeCodex);
  await chmod(fakeBin, 0o755);
  try {
    await stat(pinnedArchive);
    archive = pinnedArchive;
    expectedSha256 = pinnedSha256;
    assert.equal(sha256(await readFile(archive)), expectedSha256);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const artifact = join(root, 'plugin');
    const manifest = await packageKnowledgePlugin(artifact);
    archive = join(root, 'release.tar.gz');
    expectedSha256 = (
      await packageKnowledgeRelease(
        artifact,
        sha256(
          await readFile(join(artifact, 'knowledge-plugin-manifest.json')),
        ),
        archive,
      )
    ).archiveSha256;
    assert.equal(manifest.source.dirty, false);
  }
});

after(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

test('archive tamper is refused before any Codex call', async () => {
  const { options, calls } = await fixture();
  const tampered = join(root, 'tampered.tar.gz');
  const bytes = await readFile(archive);
  bytes[Math.floor(bytes.length / 2)] ^= 1;
  await writeFile(tampered, bytes);
  await assert.rejects(
    runPrivateKnowledgeInstall({
      ...options,
      archive: tampered,
      command: 'install',
    }),
    /digest mismatch/,
  );
  assert.deepEqual(await calls(), []);
});

test('cold install is exact and repeated install is idempotent', async () => {
  const { options, calls } = await fixture();
  assert.deepEqual(
    await runPrivateKnowledgeInstall({ ...options, command: 'install' }),
    { command: 'install', state: 'installed', changed: true, version: '0.1.2' },
  );
  const receipt = JSON.parse(
    await readFile(join(options.stateRoot, 'private-knowledge-install.json')),
  );
  assert.equal(receipt.phase, 'installed');
  assert.equal(receipt.archiveSha256, expectedSha256);
  assert.equal(
    (await runPrivateKnowledgeInstall({ ...options, command: 'install' }))
      .changed,
    false,
  );
  const mutations = (await calls()).filter((args) => args.includes('add'));
  assert.equal(mutations.length, 2);
  assert(
    (await calls()).some(
      (args) =>
        args.join(' ') ===
        'plugin list --marketplace temari-knowledge --available --json',
    ),
  );
  assert(
    !(await calls()).some(
      (args) => args.join(' ') === 'plugin list --available --json',
    ),
  );
  assert.equal(
    (await runPrivateKnowledgeInstall({ ...options, command: 'status' }))
      .receipt,
    'installed',
  );
});

test('external removal survives rerun until explicit reinstall', async () => {
  const { options, state, statePath, calls } = await fixture();
  await runPrivateKnowledgeInstall({ ...options, command: 'install' });
  const observed = JSON.parse(await readFile(statePath));
  observed.installed = false;
  await state(observed);
  assert.equal(
    (await runPrivateKnowledgeInstall({ ...options, command: 'install' }))
      .state,
    'user-removed',
  );
  assert.equal(
    (await runPrivateKnowledgeInstall({ ...options, command: 'install' }))
      .changed,
    false,
  );
  assert.equal(
    (await runPrivateKnowledgeInstall({ ...options, command: 'reinstall' }))
      .state,
    'installed',
  );
  assert.equal(
    (await calls()).filter((args) => args[0] === 'plugin' && args[1] === 'add')
      .length,
    2,
  );
});

test('failed plugin add leaves a partial receipt and refuses blind retry', async () => {
  const { options, state, calls } = await fixture();
  await state({ failPluginAdd: true });
  await assert.rejects(
    runPrivateKnowledgeInstall({ ...options, command: 'install' }),
    /Codex command failed: plugin add/,
  );
  const receipt = JSON.parse(
    await readFile(join(options.stateRoot, 'private-knowledge-install.json')),
  );
  assert.equal(receipt.phase, 'installing');
  const count = (await calls()).length;
  await assert.rejects(
    runPrivateKnowledgeInstall({ ...options, command: 'install' }),
    /Partial Knowledge installation needs review/,
  );
  assert.equal((await calls()).length, count);
});

test('foreign marketplace and wrong plugin version fail closed', async () => {
  const first = await fixture();
  await first.state({ marketplaceRoot: join(root, 'foreign') });
  await assert.rejects(
    runPrivateKnowledgeInstall({ ...first.options, command: 'install' }),
    /Knowledge marketplace collision/,
  );
  assert.equal(
    (await first.calls()).filter((args) => args.includes('add')).length,
    0,
  );
  const second = await fixture();
  const expectedRoot = join(
    second.options.stateRoot,
    'releases',
    `0.1.2-${expectedSha256}`,
  );
  await second.state({ marketplaceRoot: expectedRoot, version: '9.9.9' });
  await assert.rejects(
    runPrivateKnowledgeInstall({ ...second.options, command: 'install' }),
    /Knowledge plugin collision or unknown state/,
  );
  assert.equal(
    (await second.calls()).filter((args) => args.includes('add')).length,
    0,
  );
});

test('bounded marketplace query still refuses an installed name collision', async () => {
  const { options, state, calls } = await fixture();
  await state({ foreignInstalled: true });
  await assert.rejects(
    runPrivateKnowledgeInstall({ ...options, command: 'install' }),
    /Knowledge plugin name collision/,
  );
  assert.equal(
    (await calls()).filter((args) => args.includes('add')).length,
    0,
  );
});

test('an existing lock and a changed release cache refuse mutation', async () => {
  const locked = await fixture();
  await mkdir(locked.options.stateRoot);
  const lockPath = join(
    locked.options.stateRoot,
    'private-knowledge-install.lock',
  );
  await writeFile(lockPath, 'unknown owner\n');
  await assert.rejects(
    runPrivateKnowledgeInstall({ ...locked.options, command: 'install' }),
    /install lock exists/,
  );
  assert.deepEqual(await locked.calls(), []);
  const changed = await fixture();
  await runPrivateKnowledgeInstall({ ...changed.options, command: 'install' });
  const receipt = JSON.parse(
    await readFile(
      join(changed.options.stateRoot, 'private-knowledge-install.json'),
    ),
  );
  await writeFile(join(receipt.releaseRoot, 'README.md'), 'changed\n');
  await assert.rejects(
    runPrivateKnowledgeInstall({ ...changed.options, command: 'install' }),
    /Release cache hash drift/,
  );
});

test('receipt is bound to one Codex home and rejects oversized receipt data', async () => {
  const first = await fixture();
  await runPrivateKnowledgeInstall({ ...first.options, command: 'install' });
  const receiptPath = join(
    first.options.stateRoot,
    'private-knowledge-install.json',
  );
  const original = JSON.parse(await readFile(receiptPath));
  assert.equal(original.codexHome, await realpath(first.options.codexHome));
  const secondHome = join(root, 'other-codex-home');
  await mkdir(secondHome);
  await assert.rejects(
    runPrivateKnowledgeInstall({
      ...first.options,
      command: 'install',
      codexHome: secondHome,
    }),
    /Install receipt belongs to another release/,
  );
  assert.deepEqual(JSON.parse(await readFile(receiptPath)), original);
  assert.equal(JSON.parse(await readFile(first.statePath)).installed, true);
  await assert.rejects(stat(join(secondHome, 'fake-calls.jsonl')), {
    code: 'ENOENT',
  });
  await writeFile(receiptPath, 'x'.repeat(4097));
  const callCount = (await first.calls()).length;
  await assert.rejects(
    runPrivateKnowledgeInstall({ ...first.options, command: 'status' }),
    /Install receipt size is invalid/,
  );
  assert.equal((await first.calls()).length, callCount);
});
