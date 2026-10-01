#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { existsSync, realpathSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const artifact = fileURLToPath(new URL('..', import.meta.url));
const registrar = join(artifact, 'registrar');
const knowledgeCli = join(
  artifact,
  'runtime/node_modules/@temari/knowledge/src/demo.js',
);
const defaultHome = join(homedir(), '.local', 'share', 'temari-knowledge');
const serverName = 'temari-content-registrar';
const registrarVersion = '0.1.0';
// Reviewed payload inventory, including recorded downstream changes, is a trust anchor.
const registrarManifestSha256 = '95da2a2cc4e01de8d378dc79e9b742dd661584bbc65eaf6502caaa26b951e467';
const registrarCommit = '760926907669ae34bd1861732edbbf8f5afaf588';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function verifyRegistrarPayload() {
  const root = await realpath(registrar);
  assert.equal(root, registrar, 'Registrar source must be a regular bundled directory.');
  const manifestPath = join(root, 'UPSTREAM.json');
  const manifestStat = await lstat(manifestPath);
  assert(manifestStat.isFile() && !manifestStat.isSymbolicLink(),
    'Registrar manifest must be a regular file.');
  const bytes = await readFile(manifestPath);
  assert.equal(sha256(bytes), registrarManifestSha256,
    'Bundled Registrar manifest differs from the pinned payload.');
  const manifest = JSON.parse(bytes.toString('utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.upstream?.commit, registrarCommit);
  assert(Array.isArray(manifest.files));
  const expected = manifest.files.map((file) => file.path);
  assert.deepEqual(expected, [...new Set(expected)].sort(),
    'Registrar manifest paths must be sorted and unique.');
  for (const file of manifest.files) {
    assert(typeof file.path === 'string' &&
      !file.path.startsWith('/') &&
      file.path.split('/').every((part) => part && part !== '.' && part !== '..') &&
      /^[a-f0-9]{64}$/.test(file.sha256),
    'Registrar manifest contains an invalid path or digest.');
  }
  const actual = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = await lstat(path);
      assert(!stat.isSymbolicLink(), 'Registrar payload contains a symlink.');
      if (stat.isDirectory()) await walk(path);
      else {
        assert(stat.isFile(), 'Registrar payload contains a nonregular file.');
        actual.push(relative(root, path).split(sep).join('/'));
      }
    }
  }
  await walk(root);
  assert.deepEqual(actual.filter((path) => path !== 'UPSTREAM.json').sort(), expected,
    'Bundled Registrar file inventory differs from the pinned payload.');
  for (const file of manifest.files)
    assert.equal(sha256(await readFile(join(root, file.path))), file.sha256,
      `Bundled Registrar bytes differ: ${file.path}`);
  return root;
}

function usage() {
  return `Usage: temari-knowledge status [--home ABS]
       temari-knowledge setup [--home ABS] [--python PYTHON_3_12] [--connect-codex]
                              [--workspace ABS] [--codex CODEX]
       temari-knowledge connect-codex [--home ABS] [--workspace ABS] [--codex CODEX]
       temari-knowledge journey-intake|journey-query|journey-jobs-create|journey-jobs-tick|journey-search|archive-collect ...

Setup builds a wheel from the pinned bundled Registrar source and installs it in
a user-local Python venv. The registry and archives live outside the plugin.
Connecting Codex is a separate, explicit command. Source intake requires a
separately selected input plan; setup and connection do not register sources.`;
}

function options(args, permitted, booleans = []) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    assert(permitted.includes(key) && !Object.hasOwn(result, key), usage());
    if (booleans.includes(key)) result[key] = true;
    else {
      const value = args[++i];
      assert(value && !value.startsWith('--'), usage());
      result[key] = value;
    }
  }
  return result;
}

function locations(flags) {
  const home = flags['--home'] ?? defaultHome;
  assert(isAbsolute(home), '--home must be absolute.');
  const selected = resolve(home);
  let existing = selected;
  const suffix = [];
  while (!existsSync(existing)) {
    suffix.unshift(existing.slice(dirname(existing).length + 1));
    existing = dirname(existing);
  }
  const physical = resolve(realpathSync(existing), ...suffix);
  const artifactPhysical = realpathSync(artifact);
  assert(
    physical !== artifactPhysical && !physical.startsWith(`${artifactPhysical}${sep}`),
    'Knowledge home must be outside the immutable artifact.',
  );
  const venv = join(selected, 'venv');
  const python = join(
    venv,
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
  );
  return {
    home: selected,
    venv,
    python,
    workspace: join(selected, 'workspace'),
    receipt: join(selected, 'installation.json'),
  };
}

async function installationReceipt(place) {
  try {
    const stat = await lstat(place.receipt);
    assert(stat.isFile() && !stat.isSymbolicLink(),
      'Installation receipt must be a regular file.');
    return JSON.parse(await readFile(place.receipt, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function currentInstallation(place) {
  const receipt = await installationReceipt(place);
  const recorded = (await installedVersion(place.python)) === registrarVersion &&
    receipt?.schemaVersion === 1 &&
    receipt.registrarManifestSha256 === registrarManifestSha256 &&
    receipt.registrarVersion === registrarVersion;
  if (!recorded) return false;
  const located = await invoke(place.python, [
    '-c',
    'import importlib.metadata; print(importlib.metadata.distribution("knowledge-agent").locate_file("knowledge_agent"))',
  ], { capture: true, allowFailure: true });
  if (located.code !== 0) return false;
  let installedRoot;
  try {
    installedRoot = realpathSync(resolve(located.stdout.trim()));
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  const physicalVenv = realpathSync(place.venv);
  if (!installedRoot.startsWith(`${physicalVenv}${sep}`)) return false;
  const manifest = JSON.parse(await readFile(join(registrar, 'UPSTREAM.json'), 'utf8'));
  for (const file of manifest.files) {
    if (!file.path.startsWith('src/knowledge_agent/')) continue;
    const installedPath = join(installedRoot, file.path.slice('src/knowledge_agent/'.length));
    try {
      const stat = await lstat(installedPath);
      if (!stat.isFile() || stat.isSymbolicLink() ||
          sha256(await readFile(installedPath)) !== file.sha256) return false;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }
  return true;
}

function invoke(command, args, { capture = false, allowFailure = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let stdout = '';
    let stderr = '';
    if (capture) {
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.stderr.on('data', (chunk) => (stderr += chunk));
    }
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0 && !allowFailure)
        reject(new Error(`${command} exited ${code}: ${stderr.trim()}`));
      else resolvePromise({ code, stdout, stderr });
    });
  });
}

async function installedVersion(python) {
  if (!existsSync(python)) return null;
  const result = await invoke(
    python,
    ['-c', 'import importlib.metadata; print(importlib.metadata.version("knowledge-agent"))'],
    { capture: true, allowFailure: true },
  );
  return result.code === 0 ? result.stdout.trim() : null;
}

async function status(flags) {
  const place = locations(flags);
  await verifyRegistrarPayload();
  return {
    schemaVersion: 1,
    capability: 'temari-knowledge',
    registrarVersion,
    installedVersion: await installedVersion(place.python),
    payloadInstalled: await currentInstallation(place),
    registrarManifestSha256,
    home: place.home,
    workspace: place.workspace,
    venv: place.venv,
    knowledgeCliAvailable: existsSync(knowledgeCli),
    registrarSourceAvailable: existsSync(join(registrar, 'pyproject.toml')),
    platformSupport: process.platform === 'win32' ? 'use-wsl2' : 'local',
    codexConnection: 'not-checked',
  };
}

async function setup(flags) {
  assert(process.platform !== 'win32',
    'Native Windows setup is unsupported. Run this launcher in WSL2 with Python 3.12.');
  const place = locations(flags);
  const source = await verifyRegistrarPayload();
  const existing = await installedVersion(place.python);
  if (await currentInstallation(place)) {
    return { ...(await status(flags)), setup: 'already-installed' };
  }
  const selectedPython = flags['--python'] ?? 'python3.12';
  const version = await invoke(selectedPython, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { capture: true });
  assert.equal(version.stdout.trim(), '3.12', 'Registrar requires Python 3.12.');
  await mkdir(place.home, { recursive: true, mode: 0o700 });
  await mkdir(place.workspace, { recursive: true, mode: 0o700 });
  if (!existsSync(place.python))
    await invoke(selectedPython, ['-m', 'venv', place.venv], { capture: true });
  const wheelDir = await mkdtemp(join(place.home, 'wheel-build-'));
  try {
    await invoke(place.python, [
      '-m', 'pip', 'wheel', '--no-deps', '--wheel-dir', wheelDir, source,
    ], { capture: true });
    const wheel = (await readdir(wheelDir)).filter((name) =>
      /^knowledge_agent-0\.1\.0-py3-none-any\.whl$/.test(name),
    );
    assert.equal(wheel.length, 1, 'Pinned Registrar wheel was not built.');
    const wheelPath = join(wheelDir, wheel[0]);
    const wheelStat = await lstat(wheelPath);
    assert(wheelStat.isFile() && !wheelStat.isSymbolicLink(),
      'Registrar wheel must be a regular file.');
    await invoke(place.python,
      ['-m', 'pip', 'install', ...(existing ? ['--force-reinstall'] : []), wheelPath],
      { capture: true });
  } finally {
    await rm(wheelDir, { recursive: true, force: true });
  }
  assert.equal(await installedVersion(place.python), registrarVersion);
  const receipt = {
    schemaVersion: 1,
    registrarVersion,
    registrarManifestSha256,
  };
  const tempReceipt = `${place.receipt}.${randomUUID()}.tmp`;
  await writeFile(tempReceipt, `${JSON.stringify(receipt)}\n`, {
    flag: 'wx', mode: 0o600,
  });
  await rename(tempReceipt, place.receipt);
  return { ...(await status(flags)), setup: existing ? 'repaired' : 'installed' };
}

async function connectCodex(flags) {
  assert(process.platform !== 'win32',
    'Native Windows connection is unsupported here. Configure Windows Codex to launch the WSL2 Python MCP server.');
  const place = locations(flags);
  await verifyRegistrarPayload();
  assert(await currentInstallation(place),
    'Run setup before connecting Codex.');
  const workspace = flags['--workspace'] ?? place.workspace;
  assert(isAbsolute(workspace), '--workspace must be absolute.');
  assert((await lstat(workspace)).isDirectory(), 'Registrar workspace must exist.');
  const codex = flags['--codex'] ?? 'codex';
  const existing = await invoke(codex, ['mcp', 'get', serverName, '--json'], {
    capture: true,
    allowFailure: true,
  });
  assert.notEqual(existing.code, 0,
    `${serverName} is already configured; inspect it before changing the connection.`);
  assert.match(existing.stderr, /No MCP server named/u,
    'Could not establish that the Codex MCP name is unused.');
  await invoke(codex, [
    'mcp', 'add', serverName, '--', place.python,
    '-m', 'knowledge_agent.cli', 'mcp', 'serve', '--workspace', workspace,
  ], { capture: true });
  return { status: 'connected', serverName, workspace, python: place.python };
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === 'help') {
    console.log(usage());
    if (existsSync(knowledgeCli))
      await invoke(process.execPath, [knowledgeCli, '--help']);
    return;
  }
  if (command === 'status') {
    console.log(JSON.stringify(await status(options(rest, ['--home'])), null, 2));
    return;
  }
  if (command === 'setup') {
    const flags = options(
      rest,
      ['--home', '--python', '--connect-codex', '--workspace', '--codex'],
      ['--connect-codex'],
    );
    assert(flags['--connect-codex'] ||
      (flags['--workspace'] === undefined && flags['--codex'] === undefined),
    '--workspace and --codex require --connect-codex.');
    const installed = await setup(flags);
    const connection = flags['--connect-codex']
      ? await connectCodex(flags)
      : undefined;
    console.log(JSON.stringify({ ...installed, ...(connection ? { connection } : {}) }, null, 2));
    return;
  }
  if (command === 'connect-codex') {
    console.log(JSON.stringify(await connectCodex(options(rest, ['--home', '--workspace', '--codex'])), null, 2));
    return;
  }
  assert(existsSync(knowledgeCli), 'Compiled knowledge CLI is missing.');
  const result = await invoke(process.execPath, [knowledgeCli, command, ...rest], {
    allowFailure: true,
  });
  process.exitCode = result.code;
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
