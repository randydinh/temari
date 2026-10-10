import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest, inventory, verifyDistribution } from '../packages/workflow-runtime/unified/inventory.mjs';
import { copyKnowledge } from '../packages/workflow-runtime/unified/setup.mjs';

async function fixture(action) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'temari-unified-integrity-')));
  try {
    for (const component of ['node', 'python', 'archon']) {
      await mkdir(join(root, 'runtime', component), { recursive: true });
      await writeFile(join(root, 'runtime', component, 'executable'), component, { mode: 0o755 });
    }
    await mkdir(join(root, 'installer'));
    await writeFile(join(root, 'installer', 'setup.mjs'), 'trusted setup');
    const manifest = { schema: 1, kind: 'temari-unified-distribution', assets: Object.fromEntries(['node', 'python', 'archon'].map((component) => [component, { executable: `runtime/${component}/executable` }])), files: await inventory(root) };
    const bytes = Buffer.from(JSON.stringify(manifest));
    await writeFile(join(root, 'UNIFIED.json'), bytes);
    await action(root, digest(bytes));
  } finally { await rm(root, { recursive: true, force: true }); }
}
test('independent distribution digest and exact membership govern verification', async () => fixture(async (root, pin) => {
  await verifyDistribution(root, pin);
  await assert.rejects(verifyDistribution(root, '0'.repeat(64)), /digest differs/);
  await writeFile(join(root, 'unexpected'), 'changed');
  await assert.rejects(verifyDistribution(root, pin), /files changed/);
}));
test('changed managed executable and mode are refused', async () => fixture(async (root, pin) => {
  await chmod(join(root, 'runtime', 'node', 'executable'), 0o644);
  await assert.rejects(verifyDistribution(root, pin), /files changed/);
  await chmod(join(root, 'runtime', 'node', 'executable'), 0o755);
  await writeFile(join(root, 'runtime', 'python', 'executable'), 'tampered');
  await assert.rejects(verifyDistribution(root, pin), /files changed/);
}));
test('native binaries above legacy plugin limits are inventoried', async () => fixture(async (root) => {
  await writeFile(join(root, 'runtime', 'node', 'large'), Buffer.alloc(17 * 1024 * 1024));
  assert.equal((await inventory(root)).find((record) => record.path.endsWith('/large')).bytes, 17 * 1024 * 1024);
}));
test('internal runtime symlinks survive relocation and escaping links are refused', async () => fixture(async (root) => {
  await symlink('executable', join(root, 'runtime', 'python', 'python3'));
  assert((await inventory(root)).some((record) => record.kind === 'symlink'));
  await symlink('/bin/sh', join(root, 'runtime', 'node', 'foreign'));
  await assert.rejects(inventory(root), /escapes distribution/);
}));
test('setup and other non-runtime symlinks are refused', async () => fixture(async (root) => {
  await symlink('../runtime/node/executable', join(root, 'installer', 'alias'));
  await assert.rejects(inventory(root), /Unexpected distribution symlink/);
}));
test('partial dependency copy can resume, while startup injection and changed bytes are refused', async () => fixture(async (root) => {
  const source = join(root, 'expected-site'), target = join(root, 'installed-site');
  await mkdir(source); await mkdir(target);
  await writeFile(join(source, 'module.py'), 'trusted');
  await copyKnowledge(source, target);
  await copyKnowledge(source, target);
  await writeFile(join(target, 'sitecustomize.py'), 'raise Exception("injected")');
  await assert.rejects(copyKnowledge(source, target), /Unexpected installed knowledge dependency/);
  await rm(join(target, 'sitecustomize.py'));
  await writeFile(join(target, 'module.py'), 'changed');
  await assert.rejects(copyKnowledge(source, target), /dependency bytes changed/);
}));

const registrarRoot = new URL('../packages/workflow-runtime/registrar/', import.meta.url);
const compatibilityRoot = new URL('../packages/workflow-runtime/unified/knowledge-compatibility/darwin-x64-v1/', import.meta.url);
async function compatibilityBytes() {
  return {
    profileBytes: await readFile(new URL('profile.json', compatibilityRoot)),
    originalProjectBytes: await readFile(new URL('pyproject.toml', registrarRoot)),
    originalLockBytes: await readFile(new URL('uv.lock', registrarRoot)),
    compatibilityProjectBytes: await readFile(new URL('pyproject.toml', compatibilityRoot)),
    compatibilityLockBytes: await readFile(new URL('uv.lock', compatibilityRoot)),
  };
}
test('Intel compatibility preserves original direct requirements and every package except cryptography', async () => {
  const { validateKnowledgeCompatibility } = await import('./unified-release.mjs'), bytes = await compatibilityBytes();
  const profile = validateKnowledgeCompatibility(bytes);
  assert.equal(profile.id, 'darwin-x64-knowledge-v1');
  assert(bytes.compatibilityProjectBytes.subarray(0, bytes.originalProjectBytes.length).equals(bytes.originalProjectBytes));
  assert.equal(bytes.compatibilityProjectBytes.subarray(bytes.originalProjectBytes.length).toString(), '\n# Outer unified-distribution compatibility profile. Registrar sources stay unchanged.\n[tool.uv]\nconstraint-dependencies = ["cryptography==48.0.1"]\n');
  const packages = value => new Map(value.toString().split('[[package]]\n').slice(1).map(block => [block.match(/^name = "([^"]+)"/)[1], block.split('\n[manifest]')[0]]));
  const original = packages(bytes.originalLockBytes), compatibility = packages(bytes.compatibilityLockBytes);
  assert.deepEqual([...compatibility.keys()], [...original.keys()]);
  for (const [name, block] of original) if (name !== 'cryptography') assert.equal(compatibility.get(name), block);
  assert.match(original.get('cryptography'), /version = "50\.0\.1"/);
  assert.match(compatibility.get('cryptography'), /version = "48\.0\.1"/);
  assert(compatibility.get('cryptography').includes(profile.changes[0].wheel));
  assert(compatibility.get('cryptography').includes(profile.changes[0].wheelSha256));
});
test('compatibility provenance refuses altered profiles, source metadata, and either lock', async () => {
  const { validateKnowledgeCompatibility } = await import('./unified-release.mjs'), bytes = await compatibilityBytes();
  for (const key of Object.keys(bytes)) assert.throws(() => validateKnowledgeCompatibility({ ...bytes, [key]: Buffer.concat([bytes[key], Buffer.from('\nchanged')]) }), /provenance/);
  const forged = JSON.parse(bytes.profileBytes); forged.compatibility.dependencyLockSha256 = digest(Buffer.from('forged lock'));
  assert.throws(() => validateKnowledgeCompatibility({ ...bytes, profileBytes: Buffer.from(JSON.stringify(forged)), compatibilityLockBytes: Buffer.from('forged lock') }), /profile differs/);
});
test('only Intel macOS selects compatibility; ARM and Linux retain the original lock', async () => {
  const { selectKnowledgeDependencies } = await import('./unified-release.mjs'), { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(registrarRoot), bytes = await compatibilityBytes();
  const intel = await selectKnowledgeDependencies({ platform: 'darwin-x64', registrarRoot: root });
  assert.equal(intel.knowledge.dependencyLockSha256, digest(bytes.compatibilityLockBytes));
  assert.equal(intel.knowledge.originalDependencyLockSha256, digest(bytes.originalLockBytes));
  assert.equal(intel.knowledge.compatibility.platform, 'darwin-x64');
  for (const platform of ['darwin-arm64', 'linux-x64', 'linux-arm64']) {
    const selection = await selectKnowledgeDependencies({ platform, registrarRoot: root, compatibilityRoot: '/missing-profile-must-not-be-read' });
    assert.equal(selection.projectRoot, root); assert.equal(selection.knowledge.dependencyLockSha256, digest(bytes.originalLockBytes));
    assert.equal(selection.knowledge.compatibility, null); assert.equal(selection.profileBytes, undefined);
  }
});
