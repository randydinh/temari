import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { digest, inside, verifyDistribution } from './inventory.mjs';

const execute = promisify(execFile);
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
async function atomic(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, json(value), { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}
async function optional(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function directory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), `Expected owned directory: ${path}`);
  assert.equal(await realpath(path), path, 'Setup paths must be canonical.');
}
export async function copyKnowledge(source, target) {
  await directory(target);
  const expected = await readdir(source);
  assert((await readdir(target)).every((name) => expected.includes(name)), 'Unexpected installed knowledge dependency.');
  for (const name of await readdir(source)) {
    const from = join(source, name), to = join(target, name), stat = await lstat(from);
    assert(!stat.isSymbolicLink(), 'Knowledge dependency symlinks are not admitted.');
    if (stat.isDirectory()) await copyKnowledge(from, to);
    else {
      assert(stat.isFile());
      try {
        const present = await lstat(to);
        assert(present.isFile() && !present.isSymbolicLink(), 'Installed knowledge dependency type changed.');
        assert.equal(digest(await readFile(to)), digest(await readFile(from)), 'Installed knowledge dependency bytes changed.');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await copyFile(from, to);
      }
    }
  }
}
function commandEnvironment(installation, manifest) {
  const python = join(installation, manifest.assets.python.executable);
  return { ...process.env, PATH: `${dirname(python)}:${dirname(join(installation, manifest.assets.node.executable))}:${process.env.PATH ?? ''}`, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', PIP_NO_INDEX: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1' };
}
async function run(executable, args, env) {
  const result = await execute(executable, args, { env, maxBuffer: 8 * 1024 * 1024, timeout: 120000 });
  return result.stdout.trim();
}
function validateProfile(profile) {
  assert(profile && typeof profile === 'object' && !Array.isArray(profile));
  const permitted = ['schema', 'id', 'workspaceRoot', 'port', 'transport', 'control'];
  assert(Object.keys(profile).every((key) => permitted.includes(key)), 'Unknown setup profile field.');
  assert.equal(profile.schema, 1);
  assert.match(profile.id ?? '', /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u);
  assert(isAbsolute(profile.workspaceRoot ?? ''), 'Select an absolute workspaceRoot.');
  assert(Number.isInteger(profile.port) && profile.port >= 0 && profile.port <= 65535);
  assert(profile.transport && ['ollama', 'openai-responses', 'codex'].includes(profile.transport.kind), 'Select a supported Talk model transport.');
}

export async function setup({ root, expectedSha256, home, profilePath, start = false }) {
  assert(process.platform !== 'win32', 'Native Windows knowledge is pending verification; use the Linux distribution inside WSL2.');
  root = await realpath(root);
  const manifest = await verifyDistribution(root, expectedSha256);
  assert.equal(manifest.assets.platform, `${process.platform}-${process.arch}`, 'Select the distribution for this native platform.');
  const profileBytes = await readFile(profilePath), profile = JSON.parse(profileBytes);
  validateProfile(profile);
  profile.workspaceRoot = await realpath(profile.workspaceRoot);
  assert(isAbsolute(home), 'Select an absolute external home.');
  home = resolve(home);
  assert(!inside(root, home) && !inside(home, root), 'Data home must be separate from the distribution.');
  assert(!inside(profile.workspaceRoot, home) && !inside(home, profile.workspaceRoot), 'Data home must be separate from the product workspace.');
  await directory(home);
  const lock = join(home, '.setup-lock');
  await mkdir(lock, { mode: 0o700 }).catch((error) => { if (error.code === 'EEXIST') throw new Error('Setup lock exists; inspect the owning process before recovery.'); throw error; });
  try {
    await writeFile(join(lock, 'owner.json'), json({ pid: process.pid, release: expectedSha256 }), { mode: 0o600, flag: 'wx' });
    const receiptPath = join(home, 'setup.json'), prior = await optional(receiptPath);
    const selection = { schema: 1, kind: 'temari-unified-installation', releaseSha256: expectedSha256, profileSha256: digest(profileBytes) };
    if (prior) for (const key of Object.keys(selection)) assert.deepEqual(prior[key], selection[key], 'Existing installation selects another release or profile.');
    else assert.deepEqual((await readdir(home)).filter((name) => name !== '.setup-lock'), [], 'Nonempty unowned data home cannot be adopted.');
    const installation = join(home, 'installations', expectedSha256);
    await directory(join(home, 'installations'));
    await atomic(receiptPath, { ...selection, phase: 'preparing', installation });
    try { await lstat(installation); await verifyDistribution(installation, expectedSha256); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const staged = `${installation}.staging`;
      try { await lstat(staged); throw new Error('Retained installation staging needs explicit recovery.'); }
      catch (missing) { if (missing.code !== 'ENOENT') throw missing; }
      await cp(root, staged, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false });
      await verifyDistribution(staged, expectedSha256);
      await rename(staged, installation);
    }
    const node = join(installation, manifest.assets.node.executable), python = join(installation, manifest.assets.python.executable);
    const env = commandEnvironment(installation, manifest);
    assert.equal(await run(node, ['--version'], env), `v${manifest.assets.node.version}`);
    assert.equal(await run(python, ['-I', '-B', '-c', 'import platform; print(platform.python_version())'], env), manifest.assets.python.version);
    const plugin = join(installation, 'marketplace', 'plugins', 'temari');
    const nested = await import(pathToFileURL(join(installation, 'marketplace', 'temari-release-verify.mjs')).href);
    await nested.checkTemariReleaseRoot(join(installation, 'marketplace'), manifest.marketplace.releaseSha256, manifest.marketplace.publicManifestSha256);
    const knowledgeHome = join(home, 'knowledge'), venv = join(knowledgeHome, 'venv');
    await directory(knowledgeHome);
    await directory(join(knowledgeHome, 'workspace'));
    const venvPython = join(venv, 'bin', 'python');
    if (!(await optional(join(knowledgeHome, 'installation.json')))) {
      await directory(venv);
      await run(python, ['-I', '-B', '-m', 'venv', '--without-pip', venv], env);
      assert.equal(await realpath(venvPython), await realpath(python), 'Knowledge interpreter must use the managed runtime.');
      const site = await run(python, ['-I', '-B', '-c', 'import sys,sysconfig; print(sysconfig.get_path("purelib",vars={"base":sys.argv[1],"platbase":sys.argv[1]}))', venv], env);
      assert(inside(venv, site), 'Knowledge site path escapes the owned environment.');
      await copyKnowledge(join(installation, 'knowledge', 'site-packages'), site);
      const selected = JSON.parse(await run(node, [join(plugin, 'bin', 'temari-knowledge.mjs'), 'status', '--home', knowledgeHome], env));
      await atomic(join(knowledgeHome, 'installation.json'), { schemaVersion: 1, registrarVersion: selected.registrarVersion, registrarManifestSha256: selected.registrarManifestSha256, venvConfigSha256: digest(await readFile(join(venv, 'pyvenv.cfg'))) });
    }
    const venvConfig = await lstat(join(venv, 'pyvenv.cfg'));
    assert(venvConfig.isFile() && !venvConfig.isSymbolicLink(), 'Knowledge environment configuration changed.');
    assert.equal(digest(await readFile(join(venv, 'pyvenv.cfg'))), (await optional(join(knowledgeHome, 'installation.json'))).venvConfigSha256, 'Knowledge environment configuration changed.');
    assert.equal(await realpath(venvPython), await realpath(python), 'Knowledge interpreter identity changed.');
    const installedSite = await run(python, ['-I', '-B', '-c', 'import sys,sysconfig; print(sysconfig.get_path("purelib",vars={"base":sys.argv[1],"platbase":sys.argv[1]}))', venv], env);
    assert(inside(venv, installedSite));
    await copyKnowledge(join(installation, 'knowledge', 'site-packages'), installedSite);
    const selected = JSON.parse(await run(node, [join(plugin, 'bin', 'temari-knowledge.mjs'), 'status', '--home', knowledgeHome], env));
    assert(selected.payloadInstalled, 'Installed Knowledge payload no longer matches the bundled Registrar.');
    assert(selected.providerSelection.selection === 'registrar', 'Knowledge was disabled; setup does not reactivate it.');
    const library = join(home, 'library');
    try { await lstat(library); }
    catch (error) { if (error.code !== 'ENOENT') throw error; await cp(join(installation, 'library'), library, { recursive: true, errorOnExist: true, force: false }); }
    const helper = join(installation, 'installer', 'knowledge.py');
    const seed = JSON.parse(await run(venvPython, ['-I', '-B', helper, JSON.stringify({ action: 'seed', workspace: selected.workspace, root: library })], env));
    const read = JSON.parse(await run(venvPython, ['-I', '-B', helper, JSON.stringify({ action: 'read', workspace: selected.workspace, sourceIds: [seed.sourceId], sourceId: seed.sourceId, path: 'welcome.md' })], env));
    assert(read.record?.citations?.length, 'Starter library read returned no verified citation.');
    const search = JSON.parse(await run(venvPython, ['-I', '-B', helper, JSON.stringify({ action: 'search', workspace: selected.workspace, sourceIds: [seed.sourceId], query: 'Temari' })], env));
    const dashboardHome = join(home, 'dashboard');
    const archonHome = join(home, 'archon');
    await directory(archonHome);
    // Use the existing harness's cache format rather than create another execution owner.
    const archonModule = await import(pathToFileURL(join(plugin, 'runtime', 'node_modules', '@temari', 'archon-harness', 'src', 'index.js')).href);
    const asset = archonModule.archonAssetFor(process.platform, process.arch);
    const archonBytes = await readFile(join(installation, manifest.assets.archon.executable));
    assert.equal(digest(archonBytes), asset.sha256, 'Bundled Archon differs from the harness pin.');
    assert.equal(archonBytes.length, asset.size);
    const cache = join(dashboardHome, 'cache');
    const cacheDirectory = join(cache, 'components', 'archon', asset.version, asset.platformKey);
    await directory(cacheDirectory);
    const cachedArchon = join(cacheDirectory, asset.assetName);
    try { await lstat(cachedArchon); }
    catch (error) { if (error.code !== 'ENOENT') throw error; await copyFile(join(installation, manifest.assets.archon.executable), cachedArchon); }
    await archonModule.installArchonRuntime({ cacheDirectory: cache, platform: process.platform, arch: process.arch, fetchImpl: async () => { throw new Error('Recipient runtime downloads are disabled.'); } });
    const control = profile.control ?? { schema: 1, workspaceRoot: profile.workspaceRoot, preparationRoot: join(home, 'prepared'), recipes: [] };
    if (control.managedCandidate) {
      control.managedCandidate.bridgeRuntimeExecutable = node;
      control.managedCandidate.bridgeRuntimeSha256 = digest(await readFile(node));
      control.managedCandidate.modelAdmission.parserExecutable = python;
      control.managedCandidate.modelAdmission.parserSha256 = digest(await readFile(await realpath(python)));
    }
    await directory(control.preparationRoot);
    assert.equal(await realpath(control.workspaceRoot), profile.workspaceRoot, 'Talk and controller must select the same workspace.');
    const installedProfile = { schema: 1, id: profile.id, archonHome, port: profile.port, control, talk: { schema: 1, root: join(dashboardHome, 'conversations'), workspaceRoot: profile.workspaceRoot, hostId: 'temari-unified', workspaceId: profile.id, taskStoreId: profile.id, transport: profile.transport, knowledge: { python: venvPython, pythonSha256: digest(await readFile(await realpath(venvPython))), workspace: selected.workspace, sourceIds: [seed.sourceId] } } };
    const materialized = join(home, 'dashboard-profile.json');
    await atomic(materialized, installedProfile);
    const dashboard = join(installation, 'dashboard', 'main.mjs');
    await run(node, [dashboard, 'configure', '--profile', materialized, '--home', dashboardHome], env);
    const readiness = JSON.parse(await run(node, [dashboard, 'doctor', '--home', dashboardHome], env));
    assert.equal(readiness.status, 'PASS', 'Dashboard readiness failed.');
    const connection = { transport: 'stdio', command: venvPython, args: ['-I', '-B', '-m', 'knowledge_agent.cli', 'mcp', 'serve', '--workspace', selected.workspace, '--profile', 'source-read-only', '--allow-source', seed.sourceId] };
    await atomic(join(home, 'knowledge-mcp.json'), connection);
    const mcpReadiness = JSON.parse(await run(venvPython, ['-I', '-B', helper, JSON.stringify({ action: 'mcp', workspace: selected.workspace, sourceIds: [seed.sourceId] })], env));
    assert(mcpReadiness.connected && mcpReadiness.status === 'complete', 'Knowledge MCP connection failed.');
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    const launcher = `#!/bin/sh\nset -eu\nexport PYTHONDONTWRITEBYTECODE=1 PYTHONNOUSERSITE=1\nexec ${quote(node)} ${quote(dashboard)} "$@" --home ${quote(dashboardHome)}\n`;
    const launcherPath = join(home, 'temari');
    try { assert.equal(await readFile(launcherPath, 'utf8'), launcher, 'Installed launcher changed.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; await writeFile(launcherPath, launcher, { mode: 0o755, flag: 'wx' }); }
    const outcome = { ...selection, phase: 'ready', installation, knowledge: { home: knowledgeHome, sourceId: seed.sourceId, citations: read.record.citations, search, mcpReadiness }, dashboard: { home: dashboardHome, command: launcherPath, model: 'configured-not-live-verified', readiness }, archon: manifest.assets.archon, mcp: join(home, 'knowledge-mcp.json') };
    await atomic(receiptPath, outcome);
    if (start) outcome.dashboard.runtime = JSON.parse(await run(node, [dashboard, 'start', '--home', dashboardHome], env));
    return outcome;
  } finally { await rm(lock, { recursive: true, force: true }); }
}

export async function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { home: { type: 'string' }, profile: { type: 'string' }, 'expected-manifest-sha256': { type: 'string' }, start: { type: 'boolean' } } });
  assert.equal(positionals[0], 'setup', 'Usage: ./setup setup --home ABS --profile ABS --expected-manifest-sha256 HEX [--start]');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  return setup({ root, expectedSha256: values['expected-manifest-sha256'], home: values.home, profilePath: values.profile, start: values.start });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then((result) => console.log(json(result))).catch((error) => { console.error(error.message); process.exitCode = 1; });
