import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { checkKnowledgeRelease, parseArchive } from './knowledge-release.mjs';

const toolPath = fileURLToPath(import.meta.url);
const pluginId = 'content-registrar-knowledge@temari-knowledge';
const pluginName = 'content-registrar-knowledge';
const marketplaceName = 'temari-knowledge';
const receiptName = 'private-knowledge-install.json';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

function assertAbsolute(path, label) {
  assert(isAbsolute(path), `${label} must be absolute`);
}

async function realDirectory(path) {
  const stat = await lstat(path);
  assert(
    stat.isDirectory() && !stat.isSymbolicLink(),
    `Not a real directory: ${path}`,
  );
}

async function treeFiles(root) {
  const files = new Map();
  async function walk(relative = '') {
    const path = join(root, relative);
    const stat = await lstat(path);
    assert(
      !stat.isSymbolicLink(),
      `Release cache contains a symlink: ${relative}`,
    );
    if (stat.isDirectory()) {
      for (const entry of (await readdir(path)).sort())
        await walk(relative ? `${relative}/${entry}` : entry);
    } else {
      assert(stat.isFile(), `Release cache contains a non-file: ${relative}`);
      files.set(relative, await readFile(path));
    }
  }
  await walk();
  return files;
}

async function checkMaterialized(root, files) {
  const actual = await treeFiles(root);
  assert.deepEqual(
    [...actual.keys()].sort(),
    [...files.keys()].sort(),
    'Release cache inventory drift',
  );
  for (const [path, bytes] of files)
    assert.deepEqual(
      actual.get(path),
      bytes,
      `Release cache hash drift: ${path}`,
    );
}

async function materializeRelease(stateRoot, release, files) {
  const releases = join(stateRoot, 'releases');
  await mkdir(releases, { recursive: true, mode: 0o700 });
  await realDirectory(releases);
  const root = join(releases, `${release.version}-${release.archiveSha256}`);
  try {
    await lstat(root);
    await checkMaterialized(root, files);
    return root;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const staging = await mkdtemp(join(releases, '.staging-'));
  try {
    for (const [path, bytes] of files) {
      const target = join(staging, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
      if (
        path === 'plugins/content-registrar-knowledge/bin/temari-knowledge.mjs'
      )
        await chmod(target, 0o755);
    }
    await checkMaterialized(staging, files);
    await rename(staging, root);
    return root;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function codexJson(bin, home, args) {
  let output;
  try {
    output = execFileSync(bin, args, {
      encoding: 'utf8',
      env: { ...process.env, CODEX_HOME: home, TYPESAFE_API_KEY: '' },
      timeout: 20_000,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error(`Codex command failed: ${args.slice(0, 3).join(' ')}`);
  }
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(
      `Codex returned non-JSON output: ${args.slice(0, 3).join(' ')}`,
    );
  }
}

function inspectCodex(bin, home, releaseRoot, version) {
  const markets = codexJson(bin, home, [
    'plugin',
    'marketplace',
    'list',
    '--json',
  ]);
  const plugins = codexJson(bin, home, [
    'plugin',
    'list',
    '--available',
    '--json',
  ]);
  assert(
    Array.isArray(markets.marketplaces),
    'Unknown Codex marketplace state',
  );
  assert(
    Array.isArray(plugins.installed) && Array.isArray(plugins.available),
    'Unknown Codex plugin state',
  );
  const ownMarkets = markets.marketplaces.filter(
    (entry) => entry.name === marketplaceName,
  );
  assert(ownMarkets.length <= 1, 'Duplicate Knowledge marketplaces');
  const market = ownMarkets[0];
  if (market)
    assert.deepEqual(
      { root: market.root, source: market.marketplaceSource },
      {
        root: releaseRoot,
        source: { sourceType: 'local', source: releaseRoot },
      },
      'Knowledge marketplace collision',
    );
  const all = [
    ...plugins.installed.map((entry) => ({ entry, kind: 'installed' })),
    ...plugins.available.map((entry) => ({ entry, kind: 'available' })),
  ];
  assert(
    !all.some(
      ({ entry }) => entry.name === pluginName && entry.pluginId !== pluginId,
    ),
    'Knowledge plugin name collision',
  );
  const own = all.filter(({ entry }) => entry.pluginId === pluginId);
  assert(own.length <= 1, 'Duplicate Knowledge plugin entries');
  const match = own[0];
  if (match) {
    assert(market, 'Knowledge plugin exists without its marketplace');
    const { entry, kind } = match;
    assert.deepEqual(
      {
        name: entry.name,
        marketplaceName: entry.marketplaceName,
        version: entry.version,
        installed: entry.installed,
        source: entry.source,
        marketplaceSource: entry.marketplaceSource,
        installPolicy: entry.installPolicy,
        authPolicy: entry.authPolicy,
      },
      {
        name: pluginName,
        marketplaceName,
        version,
        installed: kind === 'installed',
        source: {
          source: 'local',
          path: join(releaseRoot, 'plugins', pluginName),
        },
        marketplaceSource: { sourceType: 'local', source: releaseRoot },
        installPolicy: 'INSTALLED_BY_DEFAULT',
        authPolicy: 'ON_INSTALL',
      },
      'Knowledge plugin collision or unknown state',
    );
  }
  return { marketplace: Boolean(market), plugin: match?.kind ?? 'absent' };
}

async function readReceipt(path) {
  let bytes;
  try {
    const stat = await lstat(path);
    assert(
      stat.isFile() && !stat.isSymbolicLink(),
      'Install receipt is not a regular file',
    );
    assert(
      stat.size > 0 && stat.size <= 4096,
      'Install receipt size is invalid',
    );
    bytes = await readFile(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const receipt = JSON.parse(bytes.toString());
  assert.deepEqual(
    Object.keys(receipt).sort(),
    [
      'archiveSha256',
      'codexHome',
      'phase',
      'releaseRoot',
      'schemaVersion',
      'version',
    ],
    'Unknown install receipt schema',
  );
  assert.equal(receipt.schemaVersion, 1);
  assert(['installing', 'installed', 'user-removed'].includes(receipt.phase));
  return receipt;
}

async function writeReceipt(path, receipt) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      const bytes = jsonBytes(receipt);
      assert(bytes.length <= 4096, 'Install receipt size is invalid');
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function runPrivateKnowledgeInstall({
  command,
  archive,
  expectedSha256,
  stateRoot,
  codexHome,
  codexBin = 'codex',
}) {
  assert(
    ['install', 'status', 'reinstall'].includes(command),
    'Unknown install command',
  );
  assertAbsolute(archive, 'Archive');
  assertAbsolute(stateRoot, 'State root');
  assertAbsolute(codexHome, 'Codex home');
  assert.match(expectedSha256 ?? '', /^[a-f0-9]{64}$/);
  assert(
    codexBin === 'codex' || isAbsolute(codexBin),
    'Codex binary must be absolute',
  );
  // This strict checker and a second digest read both precede all Codex calls.
  const release = await checkKnowledgeRelease(archive, expectedSha256);
  assert.equal(
    release.version,
    '0.1.2',
    'Unsupported private Knowledge release',
  );
  const archiveBytes = await readFile(archive);
  assert.equal(
    sha256(archiveBytes),
    expectedSha256,
    'Release changed after verification',
  );
  const files = parseArchive(archiveBytes);
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  await realDirectory(stateRoot);
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await realDirectory(codexHome);
  const canonicalCodexHome = await realpath(codexHome);
  const lockPath = join(stateRoot, 'private-knowledge-install.lock');
  let lock;
  try {
    lock = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST')
      throw new Error(
        'Knowledge install lock exists; inspect partial state before retrying',
      );
    throw error;
  }
  try {
    await lock.writeFile(
      jsonBytes({ pid: process.pid, archiveSha256: expectedSha256 }),
    );
    const receiptPath = join(stateRoot, receiptName);
    const receipt = await readReceipt(receiptPath);
    const releaseRoot = join(
      stateRoot,
      'releases',
      `${release.version}-${release.archiveSha256}`,
    );
    if (receipt) {
      assert.deepEqual(
        {
          archiveSha256: receipt.archiveSha256,
          codexHome: receipt.codexHome,
          version: receipt.version,
          releaseRoot: receipt.releaseRoot,
        },
        {
          archiveSha256: expectedSha256,
          codexHome: canonicalCodexHome,
          version: release.version,
          releaseRoot,
        },
        'Install receipt belongs to another release or Codex home',
      );
      assert.notEqual(
        receipt.phase,
        'installing',
        'Partial Knowledge installation needs review',
      );
    }
    const observed = inspectCodex(
      codexBin,
      canonicalCodexHome,
      releaseRoot,
      release.version,
    );
    if (observed.marketplace) await checkMaterialized(releaseRoot, files);
    if (command === 'status')
      return { command, receipt: receipt?.phase ?? 'uninitialized', observed };
    if (!receipt && command === 'reinstall')
      throw new Error('Reinstall requires an existing Knowledge receipt');
    if (!receipt && (observed.marketplace || observed.plugin !== 'absent'))
      throw new Error('Unowned Knowledge install state; refusing adoption');
    if (receipt?.phase === 'user-removed' && observed.plugin === 'installed')
      throw new Error(
        'Knowledge plugin changed outside the recorded lifecycle',
      );
    if (receipt?.phase === 'user-removed' && command === 'install')
      return { command, state: 'user-removed', changed: false };
    if (receipt?.phase === 'installed' && observed.plugin === 'installed')
      return { command, state: 'installed', changed: false };
    if (receipt?.phase === 'installed' && command === 'install') {
      await writeReceipt(receiptPath, { ...receipt, phase: 'user-removed' });
      return { command, state: 'user-removed', changed: true };
    }
    assert(
      observed.plugin !== 'installed',
      'Knowledge plugin is installed outside the recorded lifecycle',
    );
    await materializeRelease(stateRoot, release, files);
    const pending = {
      schemaVersion: 1,
      archiveSha256: expectedSha256,
      codexHome: canonicalCodexHome,
      version: release.version,
      releaseRoot,
      phase: 'installing',
    };
    await writeReceipt(receiptPath, pending);
    if (!observed.marketplace)
      codexJson(codexBin, canonicalCodexHome, [
        'plugin',
        'marketplace',
        'add',
        releaseRoot,
        '--json',
      ]);
    const available = inspectCodex(
      codexBin,
      canonicalCodexHome,
      releaseRoot,
      release.version,
    );
    if (available.plugin === 'absent')
      throw new Error('Knowledge plugin is absent after marketplace add');
    if (available.plugin === 'available')
      codexJson(codexBin, canonicalCodexHome, [
        'plugin',
        'add',
        pluginId,
        '--json',
      ]);
    const installed = inspectCodex(
      codexBin,
      canonicalCodexHome,
      releaseRoot,
      release.version,
    );
    assert.equal(
      installed.plugin,
      'installed',
      'Knowledge plugin install is incomplete',
    );
    await writeReceipt(receiptPath, { ...pending, phase: 'installed' });
    return {
      command,
      state: 'installed',
      changed: true,
      version: release.version,
    };
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === pathToFileURL(toolPath).href
) {
  const { values, positionals } = parseArgs({
    options: {
      archive: { type: 'string' },
      'expected-sha256': { type: 'string' },
      'state-root': { type: 'string' },
      'codex-home': { type: 'string' },
      'codex-bin': { type: 'string' },
    },
    allowPositionals: true,
  });
  assert.equal(positionals.length, 1);
  const result = await runPrivateKnowledgeInstall({
    command: positionals[0],
    archive: values.archive,
    expectedSha256: values['expected-sha256'],
    stateRoot: values['state-root'],
    codexHome: values['codex-home'],
    codexBin: values['codex-bin'] ?? 'codex',
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
