import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  checkPstackMethodLibrary,
  pstackMethodCatalog,
  pstackMethodInventory,
  readPstackMethodLibrary,
  validatePstackReferences,
  writePstackMethodLibrary,
} from './pstack-method-library.mjs';

const workspace = fileURLToPath(new URL('../', import.meta.url));
const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

function inventory(files) {
  return {
    schema: 1,
    sourceRevision: 'a'.repeat(40),
    files: [...files]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, bytes]) => ({
        path,
        lane: 'portable',
        sourceSha256: hash(bytes),
        artifactSha256: hash(bytes),
        executable: false,
        transformation: null,
      })),
  };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'temari-method-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assetRoot = join(root, 'assets');
  const files = new Map([
    [
      'skills/how/SKILL.md',
      Buffer.from('# How\n[reference](references/check.md)\n'),
    ],
    ['skills/how/references/check.md', Buffer.from('# Check\n')],
    ['skills/poteto-mode/playbooks/feature.md', Buffer.from('# Feature\n')],
    ['skills/principle-prove-it-works/SKILL.md', Buffer.from('# Principle\n')],
    ['agents/poteto-agent.md', Buffer.from('# Agent\n')],
    ['adapters/codex/HOST.md', Buffer.from('# Host\n')],
  ]);
  for (const [path, bytes] of files) {
    await mkdir(join(assetRoot, path, '..'), { recursive: true });
    await writeFile(join(assetRoot, path), bytes, { mode: 0o644 });
  }
  const provenance = inventory(files);
  const provenancePath = join(root, 'provenance.json');
  await writeFile(provenancePath, json(provenance));
  return { root, assetRoot, files, provenance, provenancePath };
}

test('portable catalog covers the complete authoritative method without Archon', async () => {
  const library = await readPstackMethodLibrary(
    join(workspace, 'packages/workflow-runtime/assets/v4.1'),
    join(workspace, 'packages/workflow-runtime/provenance.json'),
  );
  assert.equal(library.files.size, 216);
  assert.equal(library.catalog.skills.length, 53);
  assert.equal(library.catalog.principles.length, 23);
  assert.equal(library.catalog.playbooks.length, 24);
  assert.equal(library.catalog.agents.length, 3);
  assert.equal(
    library.catalog.hostMappings.filter((entry) =>
      entry.path.endsWith('/HOST.md'),
    ).length,
    4,
  );
  for (const name of ['how', 'architect', 'interrogate', 'swarm'])
    assert(library.catalog.skills.some((entry) => entry.name === name));
  assert(
    ![...library.files.keys()].some((path) =>
      path.startsWith('integrations/archon/'),
    ),
  );
  assert.match(library.catalog.availability, /reference-only/);
  assert(
    library.catalog.externalRequirements.some(
      (entry) => entry.component === 'Archon',
    ),
  );
  assert(
    library.catalog.externalRequirements.some(
      (entry) => entry.kind === 'historical-source-check',
    ),
  );
});

test('inventory refuses traversal, platform collisions, malformed hashes and lane escalation', () => {
  const files = new Map([['skills/how/SKILL.md', Buffer.from('# How')]]);
  const original = inventory(files);
  for (const path of [
    '/escape',
    '../escape',
    'a/../escape',
    'a\\escape',
    'a//b',
    'a:b',
    'catalog.json',
    'node_modules/tool.md',
    'scripts/.git/config',
    'docs/evidence/result.md',
    'docs/eval-replication/result.md',
    'docs/OpConnect.md',
  ]) {
    const value = structuredClone(original);
    value.files[0].path = path;
    assert.throws(
      () => pstackMethodInventory(json(value)),
      /Unsafe|conflicting/,
    );
  }
  for (const path of [
    'skills/how/SKILL.md',
    'SKILLS/HOW/skill.md',
    'skills',
    'skills/how/SKILL.md/child',
  ]) {
    const value = structuredClone(original);
    value.files.push({ ...value.files[0], path });
    assert.throws(() => pstackMethodInventory(json(value)), /conflicting/);
  }
  const wrongHash = structuredClone(original);
  wrongHash.files[0].artifactSha256 = 'x'.repeat(64);
  assert.throws(() => pstackMethodInventory(json(wrongHash)));
  const wrongLane = structuredClone(original);
  wrongLane.files[0].lane = 'archon';
  assert.throws(() => pstackMethodInventory(json(wrongLane)), /Invalid lane/);
  const undeclaredChange = structuredClone(original);
  undeclaredChange.files[0].artifactSha256 = 'b'.repeat(64);
  assert.throws(
    () => pstackMethodInventory(json(undeclaredChange)),
    /Missing transformation/,
  );
  assert.throws(
    () => pstackMethodInventory(json({ ...original, files: [] })),
    /Empty/,
  );
  const unordered = inventory(
    new Map([...files, ['agents/example.md', Buffer.from('# Agent')]]),
  );
  unordered.files.reverse();
  assert.throws(() => pstackMethodInventory(json(unordered)), /must be sorted/);
});

test('references resolve document, nearest skill, package and owning playbook paths; failures stay explicit', () => {
  const files = new Map([
    [
      'skills/how/SKILL.md',
      Buffer.from('[nested](references/check.md)\n[dir](references/)'),
    ],
    [
      'skills/how/references/check.md',
      Buffer.from(
        '`references/check.md`\n`agents/poteto-agent.md`\n`playbooks/feature.md`',
      ),
    ],
    ['skills/poteto-mode/playbooks/feature.md', Buffer.from('# Feature')],
    ['agents/poteto-agent.md', Buffer.from('# Agent')],
  ]);
  assert.deepEqual(validatePstackReferences(files), []);
  for (const content of [
    '[missing](references/missing.md)',
    '[escape](../../../../secret.md)',
    '`scripts/missing.mjs`',
    '[not a URL](url)',
    '[template](<not-a-real-path>)',
    '**principle-unknown**',
    '`principle-unknown`',
  ]) {
    const changed = new Map(files);
    changed.set('skills/how/SKILL.md', Buffer.from(content));
    assert.throws(
      () => validatePstackReferences(changed),
      /Unresolved (?:method reference|principle skill)/,
    );
  }
  const fallbackLink = new Map(files);
  fallbackLink.set(
    'skills/how/references/check.md',
    Buffer.from('[invalid fallback](references/check.md)'),
  );
  assert.throws(
    () => validatePstackReferences(fallbackLink),
    /Unresolved method reference/,
  );
  const declared = new Map(files);
  declared.set(
    'verification/verify-temari/features/routing-chain.md',
    Buffer.from('`scripts/check-routing-evals.py`'),
  );
  assert.equal(
    validatePstackReferences(declared)[0].kind,
    'historical-source-check',
  );
  declared.set(
    'verification/verify-temari/features/routing-chain.md',
    Buffer.from('[actual missing link](scripts/check-routing-evals.py)'),
  );
  assert.throws(
    () => validatePstackReferences(declared),
    /Unresolved method reference/,
  );
  declared.set(
    'verification/verify-temari/features/routing-chain.md',
    Buffer.from('`scripts/another-missing.py`'),
  );
  assert.throws(
    () => validatePstackReferences(declared),
    /Unresolved method reference/,
  );
});

test('source reader rejects hash and executable drift, symlink files and inventory ancestors', async (t) => {
  const f = await fixture(t);
  const path = join(f.assetRoot, 'skills/how/SKILL.md');
  await writeFile(path, '# Tampered');
  await assert.rejects(
    readPstackMethodLibrary(f.assetRoot, f.provenancePath),
    /hash drift/,
  );
  await writeFile(path, f.files.get('skills/how/SKILL.md'));
  if (process.platform !== 'win32') {
    await chmod(path, 0o755);
    await assert.rejects(
      readPstackMethodLibrary(f.assetRoot, f.provenancePath),
      /executable-mode drift/,
    );
    await chmod(path, 0o644);
  }
  await unlink(path);
  await symlink(f.provenancePath, path);
  await assert.rejects(
    readPstackMethodLibrary(f.assetRoot, f.provenancePath),
    /symlink/,
  );
  await rm(join(f.assetRoot, 'skills/how'), { recursive: true });
  await symlink(f.root, join(f.assetRoot, 'skills/how'));
  await assert.rejects(
    readPstackMethodLibrary(f.assetRoot, f.provenancePath),
    /symlink/,
  );
});

test('relocated checker reconstructs membership and catalog without the source assets', async (t) => {
  const f = await fixture(t);
  const library = await readPstackMethodLibrary(f.assetRoot, f.provenancePath);
  const artifact = join(f.root, 'artifact');
  await writePstackMethodLibrary(library, artifact);
  await rm(f.assetRoot, { recursive: true });
  await unlink(f.provenancePath);
  const checked = await checkPstackMethodLibrary(artifact);
  assert.deepEqual(checked.catalog, library.catalog);
  assert.equal(checked.provenanceSha256, hash(library.provenance));
  await writeFile(join(artifact, 'extra.md'), '# Unlisted');
  await assert.rejects(checkPstackMethodLibrary(artifact), /membership/);
  await unlink(join(artifact, 'extra.md'));
  await mkdir(join(artifact, 'extra-directory'));
  await assert.rejects(checkPstackMethodLibrary(artifact), /membership/);
  await rm(join(artifact, 'extra-directory'), { recursive: true });
  const catalogPath = join(artifact, 'catalog.json');
  const original = await readFile(catalogPath);
  await writeFile(
    catalogPath,
    json({ ...library.catalog, availability: 'admitted' }),
  );
  await assert.rejects(checkPstackMethodLibrary(artifact), /catalog differs/);
  await writeFile(catalogPath, original);
  await unlink(join(artifact, 'agents/poteto-agent.md'));
  await assert.rejects(checkPstackMethodLibrary(artifact), /membership/);
});

test('catalog cannot discover unlisted files or accept stale inventory bytes', () => {
  const files = new Map([['skills/how/SKILL.md', Buffer.from('# How')]]);
  const provenance = inventory(files);
  assert.equal(pstackMethodCatalog(provenance, files).skills.length, 1);
  assert.throws(
    () =>
      pstackMethodCatalog(
        provenance,
        new Map([...files, ['skills/extra/SKILL.md', Buffer.from('# Extra')]]),
      ),
    /inventory/,
  );
  assert.throws(
    () =>
      pstackMethodCatalog(
        provenance,
        new Map([['skills/how/SKILL.md', Buffer.from('# Changed')]]),
      ),
    /hash drift/,
  );
});
