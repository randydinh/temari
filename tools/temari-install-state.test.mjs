import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { inspectTemariInstall } from './temari-install-state.mjs';
import {
  TEMARI_MARKETPLACE,
  TEMARI_PLUGIN_ID,
} from './temari-release-verify.mjs';

const selectionPath = process.env.TEMARI_INSTALL_TEST_SELECTION;
const fixtureReady = Boolean(selectionPath && existsSync(selectionPath));
if (!fixtureReady && process.env.TEMARI_TEST_PURE_UNITS !== '1')
  throw new Error(
    'Install-state acceptance requires TEMARI_INSTALL_TEST_SELECTION with independently pinned clean current and genuine predecessor roots; TEMARI_TEST_PURE_UNITS=1 is an explicit unit-only opt-out, not installation acceptance',
  );
const fixtureOptions = {
  skip: fixtureReady
    ? false
    : 'Set TEMARI_INSTALL_TEST_SELECTION to independently pinned clean current and genuine predecessor release roots',
};
let root, selections, bin;
const fakeCodex = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const home = process.env.CODEX_HOME;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(home, 'calls.jsonl'), JSON.stringify(args) + '\\n');
const state = JSON.parse(fs.readFileSync(path.join(home, 'inspection.json')));
if (args.join(' ') === 'plugin marketplace list --json') process.stdout.write(JSON.stringify(state.markets));
else if (args.join(' ') === 'plugin list --available --json') process.stdout.write(JSON.stringify(state.plugins));
else process.exit(9);
`;
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'temari-state-test-'));
  bin = join(root, 'fake-codex.cjs');
  await writeFile(bin, fakeCodex);
  await chmod(bin, 0o755);
  if (fixtureReady)
    selections = JSON.parse(await readFile(selectionPath, 'utf8'));
});
after(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const home = await mkdtemp(join(root, 'home-'));
  const statePath = join(home, 'inspection.json');
  await writeFile(join(home, 'user-setting.txt'), 'preserve me');
  const state = async (value) => writeFile(statePath, JSON.stringify(value));
  const calls = async () => {
    try {
      return (await readFile(join(home, 'calls.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(JSON.parse);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  };
  return {
    home,
    state,
    calls,
    options: { codexHome: home, codexBin: bin, ...selections },
  };
}
function catalog(
  selection,
  {
    installed = false,
    enabled = installed,
    foreignAvailable = false,
    foreignInstalled = false,
  } = {},
) {
  const version =
    selection?.version ??
    (selection === selections?.prior ? '0.15.4+codex.2' : '0.15.5');
  const entry = selection && {
    pluginId: TEMARI_PLUGIN_ID,
    name: 'temari',
    marketplaceName: TEMARI_MARKETPLACE,
    version,
    installed,
    enabled,
    source: { source: 'local', path: join(selection.root, 'plugins/temari') },
    marketplaceSource: { sourceType: 'local', source: selection.root },
    installPolicy: 'AVAILABLE',
    authPolicy: 'ON_INSTALL',
  };
  const foreign = {
    pluginId: 'temari@personal',
    name: 'temari',
    marketplaceName: 'personal',
    version: '0.15.4+codex.2',
    installed: false,
    enabled: false,
  };
  return {
    markets: {
      marketplaces: selection
        ? [
            {
              name: TEMARI_MARKETPLACE,
              root: selection.root,
              marketplaceSource: {
                sourceType: 'local',
                source: selection.root,
              },
            },
          ]
        : [],
    },
    plugins: {
      installed: [
        ...(entry && installed ? [entry] : []),
        ...(foreignInstalled
          ? [{ ...foreign, installed: true, enabled: true }]
          : []),
      ],
      available: [
        ...(entry && !installed ? [entry] : []),
        ...(foreignAvailable ? [foreign] : []),
      ],
    },
  };
}
async function cache(home, selection, version) {
  const path = join(
    home,
    'plugins/cache',
    TEMARI_MARKETPLACE,
    'temari',
    version,
  );
  await mkdir(join(path, '..'), { recursive: true });
  await cp(join(selection.root, 'plugins/temari'), path, { recursive: true });
  return path;
}

test('inspection requires an explicit existing home and pinned selections before invoking CLI', async () => {
  const f = await fixture();
  await assert.rejects(
    inspectTemariInstall({
      codexHome: 'relative',
      codexBin: bin,
      candidate: {},
    }),
    /explicit and absolute/,
  );
  await assert.rejects(
    inspectTemariInstall({
      codexHome: f.home,
      codexBin: bin,
      candidate: {
        root: 'relative',
        releaseSha256: 'a'.repeat(64),
        manifestSha256: 'b'.repeat(64),
      },
    }),
    /absolute/,
  );
  assert.deepEqual(await f.calls(), []);
  assert.equal(
    await readFile(join(f.home, 'user-setting.txt'), 'utf8'),
    'preserve me',
  );
});

test(
  'cold inspection is idempotent and namespace-specific foreign availability is context',
  fixtureOptions,
  async () => {
    const f = await fixture();
    await f.state(catalog(null, { foreignAvailable: true }));
    const first = await inspectTemariInstall(f.options),
      second = await inspectTemariInstall(f.options);
    assert.deepEqual(first, second);
    assert.equal(first.state, 'not-configured');
    assert.equal(first.readiness, 'ready-to-install');
    assert.deepEqual(first.commands.install, [
      ['plugin', 'marketplace', 'add', selections.candidate.root, '--json'],
      ['plugin', 'add', TEMARI_PLUGIN_ID, '--json'],
    ]);
    assert.equal(first.observed.foreignAvailable.length, 1);
    assert(
      (await f.calls()).every(
        (args) =>
          args.join(' ') === 'plugin marketplace list --json' ||
          args.join(' ') === 'plugin list --available --json',
      ),
    );
    assert.equal(
      await readFile(join(f.home, 'user-setting.txt'), 'utf8'),
      'preserve me',
    );
  },
);

test(
  'verified current install is complete; disabled and removed states require explicit reinstall',
  fixtureOptions,
  async () => {
    const f = await fixture();
    await cache(f.home, selections.candidate, '0.15.5');
    await f.state(catalog(selections.candidate, { installed: true }));
    const installed = await inspectTemariInstall(f.options);
    assert.equal(installed.state, 'installed-current');
    assert.deepEqual(installed.commands.install, []);
    assert.equal(installed.commands.reinstall.length, 2);
    await f.state(
      catalog(selections.candidate, { installed: true, enabled: false }),
    );
    const disabled = await inspectTemariInstall(f.options);
    assert.equal(disabled.state, 'disabled-current');
    assert.deepEqual(disabled.commands.install, []);
    await f.state(catalog(selections.candidate));
    const removed = await inspectTemariInstall(f.options);
    assert.equal(removed.state, 'available-current');
    assert.equal(removed.readiness, 'explicit-reinstall-required');
    assert.deepEqual(removed.commands.install, []);
    assert.deepEqual(removed.commands.reinstall, [
      ['plugin', 'add', TEMARI_PLUGIN_ID, '--json'],
    ]);
    await f.state(catalog(null));
    const partial = await inspectTemariInstall(f.options);
    assert.equal(partial.state, 'not-configured-with-retained-cache');
    assert.deepEqual(partial.commands.install, []);
  },
);

test(
  'genuine pinned installed predecessor yields the probed explicit native upgrade sequence',
  fixtureOptions,
  async () => {
    assert(
      selections.prior,
      'The fixture must include the genuine shipped predecessor',
    );
    const f = await fixture();
    await cache(f.home, selections.prior, '0.15.4+codex.2');
    await f.state(catalog(selections.prior, { installed: true }));
    const result = await inspectTemariInstall(f.options);
    assert.equal(result.state, 'installed-prior');
    assert.equal(result.readiness, 'ready-to-upgrade');
    assert.deepEqual(result.commands.upgrade, [
      ['plugin', 'remove', TEMARI_PLUGIN_ID, '--json'],
      ['plugin', 'marketplace', 'remove', TEMARI_MARKETPLACE, '--json'],
      ['plugin', 'marketplace', 'add', selections.candidate.root, '--json'],
      ['plugin', 'add', TEMARI_PLUGIN_ID, '--json'],
    ]);
    await f.state(catalog(selections.prior));
    const removed = await inspectTemariInstall(f.options);
    assert.equal(removed.state, 'available-prior');
    assert.deepEqual(removed.commands.upgrade, []);
    assert.equal(removed.commands.reinstall.length, 3);
  },
);

test(
  'foreign installed identity, wrong own root, missing cache and unknown versions refuse command proposals',
  fixtureOptions,
  async () => {
    const f = await fixture();
    await f.state(catalog(null, { foreignInstalled: true }));
    await assert.rejects(
      inspectTemariInstall(f.options),
      /Conflicting installed/,
    );
    const changed = catalog(selections.candidate);
    changed.markets.marketplaces[0].root = join(root, 'foreign');
    await f.state(changed);
    await assert.rejects(inspectTemariInstall(f.options), /unverified root/);
    await f.state(catalog(selections.candidate, { installed: true }));
    await assert.rejects(inspectTemariInstall(f.options), /cache is missing/);
    await mkdir(
      join(f.home, 'plugins/cache', TEMARI_MARKETPLACE, 'temari', '99.0.0'),
      { recursive: true },
    );
    await assert.rejects(
      inspectTemariInstall(f.options),
      /Unselected Temari cache version/,
    );
  },
);

test(
  'damaged release or installed cache is refused before any Codex observation',
  fixtureOptions,
  async () => {
    const f = await fixture();
    await f.state(catalog(selections.candidate, { installed: true }));
    await assert.rejects(
      inspectTemariInstall({
        ...f.options,
        candidate: { ...selections.candidate, releaseSha256: 'a'.repeat(64) },
      }),
      /descriptor digest mismatch/,
    );
    assert.deepEqual(await f.calls(), []);
    const installed = await cache(f.home, selections.candidate, '0.15.5');
    await writeFile(join(installed, 'skills/temari/SKILL.md'), '# Altered');
    await assert.rejects(inspectTemariInstall(f.options), /inventory drift/);
    assert.deepEqual(await f.calls(), []);
  },
);
