import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  TEMARI_MARKETPLACE,
  TEMARI_PLUGIN_ID,
  checkTemariInstalledArtifact,
  checkTemariReleaseRoot,
} from './temari-release-verify.mjs';

function codexJson(bin, home, args) {
  let output;
  try {
    output = execFileSync(bin, args, {
      encoding: 'utf8',
      env: { ...process.env, CODEX_HOME: home },
      timeout: 20_000,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error(
      `Read-only Codex inspection failed: ${args.slice(0, 3).join(' ')}`,
    );
  }
  try {
    return JSON.parse(output);
  } catch {
    throw new Error('Codex inspection returned non-JSON output');
  }
}
async function realDirectory(path) {
  const stat = await lstat(path);
  assert(
    stat.isDirectory() && !stat.isSymbolicLink(),
    `Expected real directory: ${path}`,
  );
}
async function optionalDirectoryWithin(home, parts) {
  let path = home;
  for (const part of parts) {
    path = join(path, part);
    try {
      await realDirectory(path);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }
  return path;
}
async function selectedRelease(selection, historical) {
  assert(selection && typeof selection === 'object');
  assert.deepEqual(Object.keys(selection).sort(), [
    'manifestSha256',
    'releaseSha256',
    'root',
  ]);
  assert(isAbsolute(selection.root), 'Selected release root must be absolute');
  const release = await checkTemariReleaseRoot(
    selection.root,
    selection.releaseSha256,
    selection.manifestSha256,
    { historical },
  );
  return { root: await realpath(selection.root), ...release, historical };
}
function summary(release) {
  if (!release) return null;
  return {
    root: release.root,
    version: release.version,
    sourceRevision: release.sourceRevision,
    releaseSha256: release.releaseSha256,
    publicManifestSha256: release.publicManifestSha256,
  };
}

/** Observe only. Returned native command proposals require a subsequent explicit operator action. */
export async function inspectTemariInstall({
  codexHome,
  codexBin = 'codex',
  candidate,
  prior,
}) {
  assert(isAbsolute(codexHome), 'Codex home must be explicit and absolute');
  assert(
    codexBin === 'codex' || isAbsolute(codexBin),
    'Codex binary must be absolute or codex',
  );
  await realDirectory(codexHome);
  const home = await realpath(codexHome);
  // Verify all selected inputs before contacting the CLI or proposing any removal.
  const current = await selectedRelease(candidate, false);
  const predecessor = prior ? await selectedRelease(prior, true) : null;
  if (predecessor)
    assert.notEqual(
      current.root,
      predecessor.root,
      'Current and predecessor releases need distinct immutable roots',
    );
  const selections = [current, ...(predecessor ? [predecessor] : [])];
  const cacheBase = await optionalDirectoryWithin(home, [
    'plugins',
    'cache',
    TEMARI_MARKETPLACE,
    'temari',
  ]);
  const verifiedCaches = [];
  if (cacheBase) {
    for (const version of (await readdir(cacheBase)).sort()) {
      const selection = selections.find(
        (release) => release.version === version,
      );
      assert(selection, `Unselected Temari cache version: ${version}`);
      const cache = await optionalDirectoryWithin(home, [
        'plugins',
        'cache',
        TEMARI_MARKETPLACE,
        'temari',
        version,
      ]);
      await checkTemariInstalledArtifact(
        cache,
        selection.publicManifestSha256,
        { historical: selection.historical },
      );
      for (const file of selection.files.filter((file) =>
        file.path.startsWith('plugins/temari/'),
      )) {
        const path = file.path.slice('plugins/temari/'.length);
        const stat = await lstat(join(cache, path));
        if (process.platform !== 'win32')
          assert.equal(
            Boolean(stat.mode & 0o111),
            file.executable,
            `Installed cache mode drift: ${version}/${path}`,
          );
      }
      verifiedCaches.push(version);
    }
  }
  const markets = codexJson(codexBin, home, [
    'plugin',
    'marketplace',
    'list',
    '--json',
  ]);
  const plugins = codexJson(codexBin, home, [
    'plugin',
    'list',
    '--available',
    '--json',
  ]);
  assert(
    Array.isArray(markets.marketplaces) &&
      Array.isArray(plugins.installed) &&
      Array.isArray(plugins.available),
    'Unknown Codex inspection schema',
  );
  const ownMarkets = markets.marketplaces.filter(
    (market) => market.name === TEMARI_MARKETPLACE,
  );
  assert(ownMarkets.length <= 1, 'Duplicate selected marketplaces');
  const market = ownMarkets[0];
  const selected = market
    ? selections.find((release) => market.root === release.root)
    : null;
  if (market) {
    assert(
      selected,
      'Selected Temari marketplace belongs to an unverified root',
    );
    assert.deepEqual(
      market.marketplaceSource,
      { sourceType: 'local', source: selected.root },
      'Selected marketplace source differs',
    );
  }
  assert(
    !plugins.installed.some(
      (plugin) =>
        plugin.name === 'temari' && plugin.pluginId !== TEMARI_PLUGIN_ID,
    ),
    'Conflicting installed Temari identity',
  );
  const own = [
    ...plugins.installed.map((entry) => ({ entry, installed: true })),
    ...plugins.available.map((entry) => ({ entry, installed: false })),
  ].filter(({ entry }) => entry.pluginId === TEMARI_PLUGIN_ID);
  assert(own.length <= 1, 'Duplicate selected Temari plugins');
  const match = own[0];
  if (match) {
    assert(selected, 'Selected plugin exists without its verified marketplace');
    const { entry, installed } = match;
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
        name: 'temari',
        marketplaceName: TEMARI_MARKETPLACE,
        version: selected.version,
        installed,
        source: {
          source: 'local',
          path: join(selected.root, 'plugins/temari'),
        },
        marketplaceSource: { sourceType: 'local', source: selected.root },
        installPolicy: 'AVAILABLE',
        authPolicy: 'ON_INSTALL',
      },
      'Selected plugin identity or source differs',
    );
    assert.equal(
      typeof entry.enabled,
      'boolean',
      'Selected plugin enabled state is unknown',
    );
    if (installed)
      assert(
        verifiedCaches.includes(selected.version),
        'Installed Temari cache is missing',
      );
    else
      assert.equal(
        entry.enabled,
        false,
        'Available plugin has unknown enabled state',
      );
  } else assert(!market, 'Selected marketplace has no Temari catalog entry');
  const installed = match?.installed === true,
    enabled = installed && match.entry.enabled;
  const place = !market
    ? 'absent'
    : selected === current
      ? 'candidate'
      : 'prior';
  const plugin = !match
    ? 'absent'
    : !installed
      ? 'available'
      : enabled
        ? 'installed'
        : 'disabled';
  let state, readiness;
  const commands = { install: [], reinstall: [], upgrade: [] };
  const addMarket = ['plugin', 'marketplace', 'add', current.root, '--json'];
  const addPlugin = ['plugin', 'add', TEMARI_PLUGIN_ID, '--json'];
  const removePlugin = ['plugin', 'remove', TEMARI_PLUGIN_ID, '--json'];
  const removeMarket = [
    'plugin',
    'marketplace',
    'remove',
    TEMARI_MARKETPLACE,
    '--json',
  ];
  if (place === 'absent') {
    state = verifiedCaches.length
      ? 'not-configured-with-retained-cache'
      : 'not-configured';
    readiness = verifiedCaches.length
      ? 'explicit-reinstall-required'
      : 'ready-to-install';
    if (!verifiedCaches.length) commands.install = [addMarket, addPlugin];
    commands.reinstall = [addMarket, addPlugin];
  } else if (place === 'candidate') {
    state = installed
      ? enabled
        ? 'installed-current'
        : 'disabled-current'
      : 'available-current';
    readiness =
      installed && enabled ? 'current-verified' : 'explicit-reinstall-required';
    commands.reinstall = installed ? [removePlugin, addPlugin] : [addPlugin];
  } else {
    state = installed
      ? enabled
        ? 'installed-prior'
        : 'disabled-prior'
      : 'available-prior';
    readiness =
      installed && enabled ? 'ready-to-upgrade' : 'explicit-reinstall-required';
    const upgrade = [
      ...(installed ? [removePlugin] : []),
      removeMarket,
      addMarket,
      addPlugin,
    ];
    commands.reinstall = upgrade;
    if (installed && enabled) commands.upgrade = upgrade;
  }
  return {
    schemaVersion: 1,
    state,
    readiness,
    codexHome: home,
    codexBin,
    candidate: summary(current),
    prior: summary(predecessor),
    observed: {
      marketplace: place,
      plugin,
      verifiedCaches,
      foreignAvailable: plugins.available
        .filter(
          (entry) =>
            entry.name === 'temari' && entry.pluginId !== TEMARI_PLUGIN_ID,
        )
        .map(({ pluginId, name, marketplaceName, version }) => ({
          pluginId,
          name,
          marketplaceName,
          version,
        })),
    },
    commands,
  };
}

if (
  process.argv[1] &&
  pathToFileURL(await realpath(process.argv[1])).href ===
    pathToFileURL(fileURLToPath(import.meta.url)).href
) {
  try {
    const { values, positionals } = parseArgs({
      options: {
        'codex-home': { type: 'string' },
        'codex-bin': { type: 'string' },
        'candidate-root': { type: 'string' },
        'candidate-release-sha256': { type: 'string' },
        'candidate-manifest-sha256': { type: 'string' },
        'prior-root': { type: 'string' },
        'prior-release-sha256': { type: 'string' },
        'prior-manifest-sha256': { type: 'string' },
      },
      allowPositionals: true,
    });
    assert.deepEqual(
      positionals,
      ['inspect'],
      'Usage: temari-install-state.mjs inspect with explicit home and independently pinned release roots',
    );
    assert(
      values['prior-root'] ||
        (!values['prior-release-sha256'] && !values['prior-manifest-sha256']),
      'Incomplete predecessor selection',
    );
    const result = await inspectTemariInstall({
      codexHome: values['codex-home'],
      codexBin: values['codex-bin'] ?? 'codex',
      candidate: {
        root: values['candidate-root'],
        releaseSha256: values['candidate-release-sha256'],
        manifestSha256: values['candidate-manifest-sha256'],
      },
      ...(values['prior-root']
        ? {
            prior: {
              root: values['prior-root'],
              releaseSha256: values['prior-release-sha256'],
              manifestSha256: values['prior-manifest-sha256'],
            },
          }
        : {}),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
