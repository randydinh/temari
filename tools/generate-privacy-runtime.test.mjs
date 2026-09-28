import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  checkPrivacyRuntime,
  generatePrivacyRuntime,
} from './generate-privacy-runtime.mjs';

const run = promisify(execFile);
const script = fileURLToPath(
  new URL('./generate-privacy-runtime.mjs', import.meta.url),
);
const pkg = 'packages/workflow-runtime';
const assets = `${pkg}/assets/v4.1`;
const archon = 'integrations/archon/';
const provenance = `${pkg}/provenance.json`;
const imported = `${pkg}/import-paths.txt`;
const revision = 'a'.repeat(40);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sources = new Map([
  [
    'privacy.ts',
    [
      'libs/privacy/src/lib/privacy.ts',
      "import { randomUUID } from 'node:crypto';\nexport const mask = (text: string) => ({ text, id: randomUUID() });\n",
    ],
  ],
  [
    'model-transport.ts',
    [
      'libs/host-adapters/src/lib/model-transport.ts',
      "import { mask } from '@temari/privacy';\n// Keep '@temari/privacy' in commentary.\nexport const description = '@temari/privacy';\nexport const complete = (text: string) => mask(text);\n",
    ],
  ],
  [
    'codex-model-driver.ts',
    [
      'libs/host-adapters/src/lib/codex-model-driver.ts',
      'import { complete } from "./model-transport.js";\nexport const driver = complete;\n',
    ],
  ],
]);
const legacy = [
  'live-codex.ts',
  'live.ts',
  'live.test.ts',
  'lifecycle.ts',
  'runtime-files.txt',
];
let template;

async function put(root, path, value) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), value);
}

async function readInventory(root) {
  return JSON.parse(await readFile(join(root, provenance), 'utf8'));
}

async function editInventory(root, edit) {
  const value = await readInventory(root);
  edit(value);
  await put(root, provenance, `${JSON.stringify(value, null, 2)}\n`);
}

async function snapshot(root, prefix = '') {
  const result = {};
  for (const name of (await readdir(join(root, prefix))).sort()) {
    const path = prefix ? `${prefix}/${name}` : name;
    const info = await lstat(join(root, path));
    if (info.isDirectory()) Object.assign(result, await snapshot(root, path));
    else if (info.isFile())
      result[path] = {
        hash: hash(await readFile(join(root, path))),
        mode: info.mode,
      };
    else result[path] = { link: info.isSymbolicLink() };
  }
  return result;
}

before(async () => {
  template = await mkdtemp(join(tmpdir(), 'temari-privacy-template-'));
  for (const [path, source] of sources.values())
    await put(template, path, source);
  const files = new Map([
    ['README.md', 'Unrelated preserved runtime asset.\n'],
    [
      `${archon}live-codex.ts`,
      'export const coverage = "explicit-request-only";\n',
    ],
    [
      `${archon}live.ts`,
      'export const privacyCoverage = "explicit-request-only";\n',
    ],
    [
      `${archon}live.test.ts`,
      'export const expectedFailure = "Codex protocol or privacy validation failed";\n',
    ],
    [
      `${archon}lifecycle.ts`,
      `export const payload = ${JSON.stringify([...sources.keys()].map((name) => archon + name))}.sort();\n`,
    ],
    [
      `${archon}runtime-files.txt`,
      `${[...legacy, ...sources.keys()].join('\n')}\n`,
    ],
  ]);
  const entries = [];
  for (const [path, content] of files) {
    await put(template, `${assets}/${path}`, content);
    const isLegacy = legacy.includes(path.slice(archon.length));
    entries.push({
      path,
      lane: path.startsWith(archon) ? 'archon' : 'portable',
      sourceSha256: hash(isLegacy ? `historical ${path}` : content),
      artifactSha256: hash(isLegacy ? `prior packaged ${path}` : content),
      executable: false,
      transformation: isLegacy
        ? `Earlier documented transformation for ${path}.`
        : null,
    });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  await put(
    template,
    provenance,
    `${JSON.stringify({ schema: 1, sourceRevision: revision, files: entries }, null, 2)}\n`,
  );
  await put(
    template,
    imported,
    `${entries.map((file) => file.path).join('\n')}\n`,
  );
});

after(async () => {
  if (template) await rm(template, { recursive: true, force: true });
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'temari-privacy-fixture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(template, root, { recursive: true });
  return root;
}

test('generates only three standalone sources and the two manifests, reproducibly', async (t) => {
  const root = await fixture(t);
  const beforeFiles = await snapshot(root);
  const original = await readInventory(root);
  await assert.rejects(checkPrivacyRuntime(root), /Privacy runtime is stale/);
  assert.deepEqual(await snapshot(root), beforeFiles);
  const expected = [...sources.keys()]
    .map((name) => `${assets}/${archon}${name}`)
    .concat(provenance, imported);
  assert.deepEqual((await generatePrivacyRuntime(root)).changed, expected);
  assert.deepEqual(await checkPrivacyRuntime(root), { changed: [] });
  const afterFiles = await snapshot(root);
  for (const [path, value] of Object.entries(beforeFiles))
    if (!expected.includes(path))
      assert.deepEqual(afterFiles[path], value, path);
  assert.deepEqual(
    Object.keys(afterFiles)
      .filter((path) => !beforeFiles[path])
      .sort(),
    expected.slice(0, 3).sort(),
  );

  const manifest = await readInventory(root);
  assert.equal(manifest.sourceRevision, revision);
  for (const [name, [sourcePath, text]] of sources) {
    const path = archon + name;
    const entry = manifest.files.find((file) => file.path === path);
    const output = await readFile(join(root, assets, path));
    const expectedText = text
      .replace("from '@temari/privacy'", "from './privacy.ts'")
      .replace('from "./model-transport.js"', 'from "./model-transport.ts"');
    assert.equal(output.toString(), expectedText);
    assert.equal(
      entry.sourceSha256,
      hash(await readFile(join(root, sourcePath))),
    );
    assert.equal(entry.artifactSha256, hash(output));
    assert(entry.transformation.includes(`Nx source ${sourcePath}`));
    assert(entry.transformation.includes('content snapshot'));
    assert.equal(entry.executable, false);
  }
  for (const old of original.files) {
    const next = manifest.files.find((file) => file.path === old.path);
    if (!legacy.includes(old.path.slice(archon.length)))
      assert.deepEqual(next, old);
    else {
      assert.equal(next.sourceSha256, old.sourceSha256);
      assert.equal(
        next.artifactSha256,
        hash(await readFile(join(root, assets, old.path))),
      );
      assert(next.transformation.startsWith(`${old.transformation} `));
      assert(
        next.transformation.includes(
          'Nx privacy host integration (content snapshot)',
        ),
      );
    }
  }
  const paths = manifest.files.map((file) => file.path);
  assert.deepEqual(paths, [...paths].sort());
  assert.equal(
    await readFile(join(root, imported), 'utf8'),
    `${paths.join('\n')}\n`,
  );
  assert.deepEqual(await generatePrivacyRuntime(root), { changed: [] });
  assert.deepEqual(await snapshot(root), afterFiles);
  const relocated = await fixture(t);
  await generatePrivacyRuntime(relocated);
  for (const path of expected)
    assert.deepEqual(
      await readFile(join(relocated, path)),
      await readFile(join(root, path)),
      path,
    );
});

test('rewrites only module specifiers and preserves BOM, CRLF and final-newline state', async (t) => {
  const root = await fixture(t);
  const source =
    '\uFEFFexport { mask } from "@temari/privacy";\r\nexport type M = typeof import("./model-transport.js");\r\nexport const lazy = () => import("node:fs");';
  await put(root, sources.get('codex-model-driver.ts')[0], source);
  await generatePrivacyRuntime(root);
  assert.equal(
    await readFile(join(root, assets, archon, 'codex-model-driver.ts'), 'utf8'),
    source
      .replace('from "@temari/privacy"', 'from "./privacy.ts"')
      .replace(
        'import("./model-transport.js")',
        'import("./model-transport.ts")',
      ),
  );
  await checkPrivacyRuntime(root);
});

for (const drift of [
  'source',
  'generated',
  'generated-mode',
  'generated-source-hash',
  'generated-artifact-hash',
  'generated-transformation',
  'legacy',
  'legacy-transformation',
  'import-list',
  'manifest-order',
  'missing-generated',
]) {
  test(`check detects ${drift} staleness without writes; write repairs only permitted outputs`, async (t) => {
    const root = await fixture(t);
    await generatePrivacyRuntime(root);
    const path = `${assets}/${archon}privacy.ts`;
    if (drift === 'source')
      await put(
        root,
        sources.get('privacy.ts')[0],
        `${sources.get('privacy.ts')[1]}// updated source\n`,
      );
    if (drift === 'generated')
      await put(root, path, '// stale generated content\n');
    if (drift === 'generated-mode') await chmod(join(root, path), 0o755);
    if (drift === 'missing-generated') await rm(join(root, path));
    if (drift === 'legacy')
      await put(
        root,
        `${assets}/${archon}live.ts`,
        'export const privacyCoverage = "host-mediated-text";\n',
      );
    if (drift === 'import-list')
      await put(
        root,
        imported,
        (await readFile(join(root, imported), 'utf8')).replace(
          `${archon}privacy.ts\n`,
          '',
        ),
      );
    if (drift.startsWith('generated-') && drift !== 'generated-mode')
      await editInventory(root, (value) => {
        const entry = value.files.find(
          (file) => file.path === `${archon}privacy.ts`,
        );
        if (drift === 'generated-source-hash')
          entry.sourceSha256 = '0'.repeat(64);
        if (drift === 'generated-artifact-hash')
          entry.artifactSha256 = '0'.repeat(64);
        if (drift === 'generated-transformation')
          entry.transformation = 'Incorrect source origin.';
      });
    if (drift === 'legacy-transformation')
      await editInventory(root, (value) => {
        value.files.find(
          (file) => file.path === `${archon}live.ts`,
        ).transformation = 'Earlier provenance.';
      });
    if (drift === 'manifest-order')
      await editInventory(root, (value) => value.files.reverse());
    const beforeFiles = await snapshot(root);
    await assert.rejects(checkPrivacyRuntime(root), /Privacy runtime is stale/);
    assert.deepEqual(await snapshot(root), beforeFiles);
    await generatePrivacyRuntime(root);
    await checkPrivacyRuntime(root);
  });
}

for (const drift of [
  'changed',
  'missing',
  'extra',
  'mode',
  'import-list',
  'duplicate',
  'unsafe-path',
  'unknown-field',
  'symlink',
  'source-symlink',
  'output-symlink',
]) {
  test(`write refuses ${drift} unrelated or unsafe drift before changing any files`, async (t) => {
    const root = await fixture(t);
    const readme = `${assets}/README.md`;
    if (drift === 'changed') await put(root, readme, 'unrelated edit');
    if (drift === 'missing') await rm(join(root, readme));
    if (drift === 'extra')
      await put(root, `${assets}/unexpected.txt`, 'unrecorded');
    if (drift === 'mode') await chmod(join(root, readme), 0o755);
    if (drift === 'import-list')
      await put(
        root,
        imported,
        (await readFile(join(root, imported), 'utf8')).replace(
          'README.md\n',
          '',
        ),
      );
    if (drift === 'duplicate')
      await editInventory(root, (value) => value.files.push(value.files[0]));
    if (drift === 'unsafe-path')
      await editInventory(root, (value) => {
        value.files[0].path = '../escape';
      });
    if (drift === 'unknown-field')
      await editInventory(root, (value) => {
        value.files[0].unknown = true;
      });
    if (drift.endsWith('symlink')) {
      const target =
        drift === 'source-symlink'
          ? sources.get('privacy.ts')[0]
          : drift === 'output-symlink'
            ? `${assets}/${archon}privacy.ts`
            : readme;
      await rm(join(root, target), { force: true });
      await symlink(join(root, provenance), join(root, target));
    }
    const beforeFiles = await snapshot(root);
    await assert.rejects(checkPrivacyRuntime(root));
    await assert.rejects(generatePrivacyRuntime(root));
    assert.deepEqual(await snapshot(root), beforeFiles);
  });
}

for (const name of ['runtime-files.txt', 'lifecycle.ts']) {
  test(`requires the parent's ${name} additions instead of editing them`, async (t) => {
    const root = await fixture(t);
    await put(
      root,
      `${assets}/${archon}${name}`,
      name === 'runtime-files.txt'
        ? 'live.ts\n'
        : 'export const payload = [];\n',
    );
    const beforeFiles = await snapshot(root);
    await assert.rejects(generatePrivacyRuntime(root), /missing|must include/);
    assert.deepEqual(await snapshot(root), beforeFiles);
  });
}

for (const source of [
  "import thing from 'third-party';\n",
  "export { thing } from 'third-party';\n",
  "const thing = import('third-party');\n",
  "const thing = require('third-party');\n",
  "type Thing = import('third-party').Thing;\n",
  "import thing from '../outside.ts';\n",
  'const thing = import(process.env.MODULE);\n',
  '/// <reference types="third-party" />\nexport {};\n',
]) {
  test(`rejects non-standalone module dependency: ${source.trim()}`, async (t) => {
    const root = await fixture(t);
    await put(root, sources.get('codex-model-driver.ts')[0], source);
    const beforeFiles = await snapshot(root);
    await assert.rejects(generatePrivacyRuntime(root), /dependency|reference/);
    assert.deepEqual(await snapshot(root), beforeFiles);
  });
}

test('missing worker source prevents partial publication', async (t) => {
  const root = await fixture(t);
  await rm(join(root, sources.get('codex-model-driver.ts')[0]));
  const beforeFiles = await snapshot(root);
  await assert.rejects(generatePrivacyRuntime(root), /ENOENT/);
  assert.deepEqual(await snapshot(root), beforeFiles);
});

test('refuses a generated path colliding with an existing inventory entry', async (t) => {
  const root = await fixture(t);
  const path = `${archon}PRIVACY.ts`;
  const content = '// unrelated existing asset\n';
  await put(root, `${assets}/${path}`, content);
  await editInventory(root, (value) =>
    value.files.push({
      path,
      lane: 'archon',
      sourceSha256: hash(content),
      artifactSha256: hash(content),
      executable: false,
      transformation: null,
    }),
  );
  await put(
    root,
    imported,
    `${(await readInventory(root)).files
      .map((file) => file.path)
      .sort()
      .join('\n')}\n`,
  );
  const beforeFiles = await snapshot(root);
  await assert.rejects(
    generatePrivacyRuntime(root),
    /Duplicate or conflicting/,
  );
  assert.deepEqual(await snapshot(root), beforeFiles);
});

test('CLI defaults to check and accepts only --check or --write in a minimal fixture', async (t) => {
  const root = await fixture(t);
  const options = { cwd: root, timeout: 30_000 };
  const beforeFiles = await snapshot(root);
  for (const args of [[], ['--check']])
    await assert.rejects(
      run(process.execPath, [script, ...args], options),
      (error) =>
        error.code === 1 && /Privacy runtime is stale/.test(error.stderr),
    );
  for (const args of [
    ['--write', '--check'],
    ['--force'],
    ['--write', 'README.md'],
  ])
    await assert.rejects(
      run(process.execPath, [script, ...args], options),
      (error) => error.code === 1 && /Usage:/.test(error.stderr),
    );
  assert.deepEqual(await snapshot(root), beforeFiles);
  assert.match(
    (await run(process.execPath, [script, '--write'], options)).stdout,
    /Updated:/,
  );
  const afterFiles = await snapshot(root);
  assert.match(
    (await run(process.execPath, [script], options)).stdout,
    /is current/,
  );
  assert.match(
    (await run(process.execPath, [script, '--check'], options)).stdout,
    /is current/,
  );
  assert.deepEqual(await snapshot(root), afterFiles);
});
