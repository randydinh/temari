import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { prepareManagedAssets } from './unified-assets.mjs';
import { packageUnified } from './unified-release.mjs';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exec = promisify(execFile);
const { values } = parseArgs({ options: { output: { type: 'string' }, marketplace: { type: 'string' } } });
assert(values.output);
const output = resolve(values.output);
await mkdir(output, { recursive: true });
const evidence = { schema: 1, platform: `${process.platform}-${process.arch}`, sourceRevision: (await exec('git', ['rev-parse', 'HEAD'], { cwd: workspace })).stdout.trim(), sourceDirty: Boolean((await exec('git', ['status', '--porcelain'], { cwd: workspace })).stdout.trim()), status: 'preparing', installationSupported: process.platform !== 'win32' };
const save = () => writeFile(join(output, 'result.json'), JSON.stringify(evidence, null, 2) + '\n');
const run = async (command, args, env = process.env, timeoutMs = 180000) => {
  const started = Date.now();
  try { return (await exec(command, args, { cwd: workspace, env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 })).stdout.trim(); }
  catch (error) {
    evidence.commandFailure = { phase: evidence.phase ?? 'runtime-probe', elapsedMs: Date.now() - started, timeoutMs, killed: error.killed ?? false, signal: error.signal ?? null, code: error.code ?? null, stderr: String(error.stderr ?? '').slice(-8192) };
    throw error;
  }
};
try {
  const distribution = join(output, 'distribution'), cache = join(output, 'cache');
  let probedAssets;
  if (process.platform === 'win32' || (process.platform === 'darwin' && process.arch === 'x64')) {
    const runtimeRoot = process.platform === 'win32' ? distribution : join(output, 'runtime-probe');
    const assets = await prepareManagedAssets({ outputRoot: runtimeRoot, cacheRoot: cache });
    probedAssets = assets;
    evidence.runtimeVersions = {
      node: await run(join(runtimeRoot, assets.node.executable), ['--version']),
      python: await run(join(runtimeRoot, assets.python.executable), ['-I', '-B', '-c', 'import platform; print(platform.python_version())']),
      archon: await run(join(runtimeRoot, assets.archon.executable), ['--version']),
    };
    assert.equal(evidence.runtimeVersions.node, `v${assets.node.version}`);
    assert.equal(evidence.runtimeVersions.python, assets.python.version);
    assert(evidence.runtimeVersions.archon.split(/\r?\n/).includes(`Archon CLI v${assets.archon.version}`));
  }
  if (process.platform === 'win32') {
    const assets = probedAssets;
    evidence.fcntlAvailable = JSON.parse(await run(join(distribution, assets.python.executable), ['-I', '-B', '-c', 'import importlib.util,json; print(json.dumps(importlib.util.find_spec("fcntl") is not None))']));
    assert.equal(evidence.fcntlAvailable, false, 'Reassess Windows locking support if fcntl becomes available.');
    evidence.status = 'runtime-diagnostic-pass-installation-unsupported';
    evidence.installationBlockers = ['Native Windows setup is explicitly refused.', 'Registrar locking uses fcntl.', 'Bootstrap/venv paths and launcher use POSIX conventions.'];
  } else {
    assert(values.marketplace, 'Select the independently verified 0.15.5 marketplace.');
    const selected = await packageUnified({ marketplaceRoot: resolve(values.marketplace), releaseSha256: '64ac20821793c5c386b97b1468ccff9eef175419a44d4bea23b090257e47a894', publicManifestSha256: '963dce7adf2e4a23eaa022b600d4841067df6d1d830a0e9d84d0fbbf3f103195', dashboardRoot: join(workspace, 'apps/dashboard/dist'), outputRoot: distribution, cacheRoot: cache });
    evidence.distribution = selected;
    const manifest = JSON.parse(await readFile(join(distribution, 'UNIFIED.json'))), node = join(distribution, manifest.assets.node.executable);
    // This journey runs several individually bounded installs and negative retries.
    // Its aggregate budget must exceed a single command's three-minute limit.
    evidence.phase = 'recipient-setup-retry-integrity';
    await save();
    evidence.recipientSmoke = await run(node, [join(workspace, 'tools/unified-recipient-smoke.mjs'), '--distribution', distribution, '--expected-manifest-sha256', selected.sha256], process.env, 600000);
    evidence.phase = 'installed-knowledge-talk';
    const home = join(output, 'home'), project = join(output, 'project'), profile = join(output, 'profile.json');
    await mkdir(project);
    await writeFile(profile, JSON.stringify({ schema: 1, id: 'native-platform-check', workspaceRoot: project, port: 0, transport: { kind: 'ollama', model: 'fixture-model-not-invoked' } }));
    const installed = JSON.parse(await run(join(distribution, 'setup'), ['setup', '--home', home, '--profile', profile, '--expected-manifest-sha256', selected.sha256], { ...process.env, PATH: '/usr/bin:/bin' }));
    evidence.knowledge = { mcpConnected: installed.knowledge.mcpReadiness.connected, sourceId: installed.knowledge.sourceId, citationCount: installed.knowledge.citations.length };
    const python = join(home, 'knowledge/venv/bin/python');
    evidence.installedTalk = await run(node, [join(workspace, 'apps/dashboard/scripts/knowledge-talk-release-smoke.mjs')], { ...process.env, TEMARI_REGISTRAR_PYTHON: python });
    evidence.modelEvidence = 'loopback fixture with actual registry and managed Python; no live provider claims';
    evidence.status = 'PASS';
  }
  await save();
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  evidence.status = 'FAIL';
  evidence.error = error.message;
  await save();
  console.error(error.message);
  process.exitCode = 1;
}
