import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, copyFile, cp, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { prepareManagedAssets } from './unified-assets.mjs';
import { checkTemariReleaseRoot } from './temari-release-verify.mjs';
import { digest, inventory, verifyDistribution } from '../packages/workflow-runtime/unified/inventory.mjs';

const execute = promisify(execFile);
const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(workspace, 'packages', 'workflow-runtime', 'unified');
async function run(command, args, env = {}) {
  return execute(command, args, { maxBuffer: 8 * 1024 * 1024, timeout: 300000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', UV_PYTHON_DOWNLOADS: 'never', ...env } });
}

const intelCompatibilityRoot = join(source, 'knowledge-compatibility', 'darwin-x64-v1');
const intelCompatibilityProfileSha256 = 'ba95e3b043eed5133e98617ed2d93d422115e4c2509278c3dc5705c69987c3a9';

export function validateKnowledgeCompatibility({ profileBytes, originalProjectBytes, originalLockBytes, compatibilityProjectBytes, compatibilityLockBytes }) {
  assert.equal(digest(profileBytes), intelCompatibilityProfileSha256, 'Knowledge compatibility profile differs from pinned provenance.');
  const profile = JSON.parse(profileBytes);
  assert.equal(digest(originalProjectBytes), profile.registrar.projectSha256, 'Original Registrar project differs from compatibility provenance.');
  assert.equal(digest(originalLockBytes), profile.registrar.dependencyLockSha256, 'Original Registrar lock differs from compatibility provenance.');
  assert.equal(digest(compatibilityProjectBytes), profile.compatibility.projectSha256, 'Knowledge compatibility project differs from pinned provenance.');
  assert.equal(digest(compatibilityLockBytes), profile.compatibility.dependencyLockSha256, 'Knowledge compatibility lock differs from pinned provenance.');
  return profile;
}

export async function selectKnowledgeDependencies({ platform, registrarRoot, compatibilityRoot = intelCompatibilityRoot }) {
  const originalProjectBytes = await readFile(join(registrarRoot, 'pyproject.toml'));
  const originalLockBytes = await readFile(join(registrarRoot, 'uv.lock'));
  const original = { projectSha256: digest(originalProjectBytes), dependencyLockSha256: digest(originalLockBytes) };
  if (platform !== 'darwin-x64') return { projectRoot: registrarRoot, lockRoot: registrarRoot, knowledge: { ...original, originalProjectSha256: original.projectSha256, originalDependencyLockSha256: original.dependencyLockSha256, compatibility: null } };
  const profileBytes = await readFile(join(compatibilityRoot, 'profile.json'));
  const compatibilityProjectBytes = await readFile(join(compatibilityRoot, 'pyproject.toml'));
  const compatibilityLockBytes = await readFile(join(compatibilityRoot, 'uv.lock'));
  const profile = validateKnowledgeCompatibility({ profileBytes, originalProjectBytes, originalLockBytes, compatibilityProjectBytes, compatibilityLockBytes });
  return {
    projectRoot: compatibilityRoot, lockRoot: compatibilityRoot, profileBytes,
    knowledge: { ...profile.compatibility, originalProjectSha256: original.projectSha256, originalDependencyLockSha256: original.dependencyLockSha256,
      compatibility: { id: profile.id, platform, profileSha256: intelCompatibilityProfileSha256, changes: profile.changes } },
  };
}

export async function packageUnified({ marketplaceRoot, releaseSha256, publicManifestSha256, dashboardRoot, outputRoot, cacheRoot, uv = 'uv' }) {
  for (const path of [marketplaceRoot, dashboardRoot, outputRoot, cacheRoot]) assert(isAbsolute(path), 'Build paths must be absolute.');
  assert(process.platform !== 'win32', 'Native Windows Registrar remains unsupported; build on macOS or Linux.');
  await checkTemariReleaseRoot(marketplaceRoot, releaseSha256, publicManifestSha256);
  try { await lstat(outputRoot); throw new Error('Unified output must be fresh.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(outputRoot, { recursive: true });
  const uvRun = (args) => run(uv, args, { UV_CACHE_DIR: join(cacheRoot, 'uv') });
  try {
    const assets = await prepareManagedAssets({ outputRoot, cacheRoot });
    await cp(marketplaceRoot, join(outputRoot, 'marketplace'), { recursive: true, errorOnExist: true, force: false });
    await cp(dashboardRoot, join(outputRoot, 'dashboard'), { recursive: true, errorOnExist: true, force: false });
    await mkdir(join(outputRoot, 'installer'));
    for (const name of ['inventory.mjs', 'setup.mjs', 'knowledge.py']) await copyFile(join(source, name), join(outputRoot, 'installer', name));
    await copyFile(join(source, 'setup'), join(outputRoot, 'setup'));
    await chmod(join(outputRoot, 'setup'), 0o755);
    await mkdir(join(outputRoot, 'knowledge'));
    const python = join(outputRoot, assets.python.executable);
    const registrar = join(outputRoot, 'marketplace', 'plugins', 'temari', 'registrar');
    const originalRegistrar = join(workspace, 'packages', 'workflow-runtime', 'registrar');
    assert.deepEqual(await readFile(join(registrar, 'pyproject.toml')), await readFile(join(originalRegistrar, 'pyproject.toml')), 'Lockfile source differs from selected Registrar.');
    assert.deepEqual(await readFile(join(registrar, 'uv.lock')), await readFile(join(originalRegistrar, 'uv.lock')), 'Dependency lock differs from selected Registrar.');
    const dependencySelection = await selectKnowledgeDependencies({ platform: assets.platform, registrarRoot: originalRegistrar });
    const requirements = join(outputRoot, 'knowledge', 'requirements.txt');
    await uvRun(['export', '--project', dependencySelection.projectRoot, '--locked', '--no-dev', '--no-editable', '--no-emit-project', '--python', python, '--no-python-downloads', '--no-build', '--format', 'requirements.txt', '--output-file', requirements]);
    await copyFile(join(dependencySelection.lockRoot, 'uv.lock'), join(outputRoot, 'knowledge', 'uv.lock'));
    await copyFile(join(originalRegistrar, 'uv.lock'), join(outputRoot, 'knowledge', 'original-uv.lock'));
    await copyFile(join(originalRegistrar, 'pyproject.toml'), join(outputRoot, 'knowledge', 'original-pyproject.toml'));
    if (dependencySelection.profileBytes) {
      await writeFile(join(outputRoot, 'knowledge', 'compatibility-profile.json'), dependencySelection.profileBytes, { flag: 'wx' });
      await copyFile(join(dependencySelection.projectRoot, 'pyproject.toml'), join(outputRoot, 'knowledge', 'compatibility-pyproject.toml'));
    }
    const site = join(outputRoot, 'knowledge', 'site-packages');
    await uvRun(['pip', 'install', '--python', python, '--target', site, '--only-binary', ':all:', '--require-hashes', '--no-python-downloads', '--no-config', '-r', requirements]);
    // Registrar is pure Python: use the verified release source directly, avoiding
    // an unpinned build backend. Runtime dependencies remain hash-locked wheels.
    await cp(join(registrar, 'src', 'knowledge_agent'), join(site, 'knowledge_agent'), { recursive: true, errorOnExist: true, force: false });
    await run(python, ['-I', '-B', '-c', `import pathlib,sys,tomllib
p=tomllib.loads(pathlib.Path(sys.argv[1]).read_text())['project']
d=pathlib.Path(sys.argv[2])/(p['name'].replace('-','_')+'-'+p['version']+'.dist-info')
d.mkdir()
lines=['Metadata-Version: 2.3','Name: '+p['name'],'Version: '+p['version'],'Requires-Python: '+p['requires-python']]
lines += ['Requires-Dist: '+requirement for requirement in p['dependencies']]
(d/'METADATA').write_text('\\n'.join(lines)+'\\n')
(d/'INSTALLER').write_text('temari-unified\\n')`, join(registrar, 'pyproject.toml'), site]);
    await mkdir(join(outputRoot, 'library'));
    await writeFile(join(outputRoot, 'library', 'welcome.md'), '# Temari starter library\n\nTemari is your main conversation. The runtime orchestrates admitted work and retains tasks and worker progress. Poteto supplies engineering methods. Archon is the replaceable execution harness. Knowledge returns source citations; source content does not grant execution authority.\n');
    for (const [path, name] of [['docs/migrations/unified-install.md', 'migrations/unified-install.md'], ['docs/migrations/install-temari.md', 'migrations/install-temari.md'], ['docs/dashboard-talk.md', 'dashboard-talk.md'], ['docs/task-dashboard.md', 'task-dashboard.md'], ['docs/decisions/2026-09-22-archon-harness.md', 'decisions/2026-09-22-archon-harness.md']]) {
      await mkdir(dirname(join(outputRoot, 'library', name)), { recursive: true });
      await copyFile(join(workspace, path), join(outputRoot, 'library', name));
    }
    await writeFile(join(outputRoot, 'profile.example.json'), JSON.stringify({ schema: 1, id: 'my-project', workspaceRoot: '/absolute/path/to/my-project', port: 3095, transport: { kind: 'ollama', model: 'YOUR_INSTALLED_MODEL' } }, null, 2) + '\n');
    const manifest = { schema: 1, kind: 'temari-unified-distribution', version: '0.1.0', assets, knowledge: { registrarPackaging: 'verified-release-source', ...dependencySelection.knowledge }, marketplace: { version: '0.15.5', releaseSha256, publicManifestSha256 }, files: await inventory(outputRoot) };
    const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
    await writeFile(join(outputRoot, 'UNIFIED.json'), bytes, { flag: 'wx' });
    const sha256 = digest(bytes);
    await verifyDistribution(outputRoot, sha256);
    return { root: outputRoot, sha256, files: manifest.files.length, platform: assets.platform };
  } catch (error) { await rm(outputRoot, { recursive: true, force: true }); throw error; }
}

async function main(argv) {
  const { values } = parseArgs({ args: argv, options: { 'marketplace-root': { type: 'string' }, 'release-sha256': { type: 'string' }, 'public-manifest-sha256': { type: 'string' }, dashboard: { type: 'string' }, output: { type: 'string' }, cache: { type: 'string' }, uv: { type: 'string' } } });
  return packageUnified({ marketplaceRoot: values['marketplace-root'], releaseSha256: values['release-sha256'], publicManifestSha256: values['public-manifest-sha256'], dashboardRoot: values.dashboard, outputRoot: values.output, cacheRoot: values.cache, uv: values.uv });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => { console.error(error.message); process.exitCode = 1; });
