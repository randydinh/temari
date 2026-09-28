import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  readFile,
  readdir,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const packagePath = 'packages/workflow-runtime';
const assetPath = `${packagePath}/assets/v4.1`;
const provenancePath = `${packagePath}/provenance.json`;
const importPathsPath = `${packagePath}/import-paths.txt`;
const archon = 'integrations/archon/';
const generated = new Map([
  [`${archon}privacy.ts`, 'libs/privacy/src/lib/privacy.ts'],
  [
    `${archon}model-transport.ts`,
    'libs/host-adapters/src/lib/model-transport.ts',
  ],
  [
    `${archon}codex-model-driver.ts`,
    'libs/host-adapters/src/lib/codex-model-driver.ts',
  ],
]);
const rewrites = new Map([
  ['@temari/privacy', './privacy.ts'],
  ['./model-transport.js', './model-transport.ts'],
]);
const legacyChanges = new Map([
  [
    `${archon}live-codex.ts`,
    'Expose the controlled Codex model transport; mask native prompt/schema and sanitize replies; omit raw event/stderr bodies; report explicit-request-only native coverage.',
  ],
  [
    `${archon}live.ts`,
    'Move prompt artifact persistence behind the sanitized boundary and attach privacyCoverage to the result.',
  ],
  [
    `${archon}live.test.ts`,
    'Verify content-free native progress and generic protocol/privacy failures after diagnostic redaction.',
  ],
  [
    `${archon}lifecycle.ts`,
    'Include privacy.ts, model-transport.ts and codex-model-driver.ts in the standalone installation payload.',
  ],
  [
    `${archon}runtime-files.txt`,
    'Include privacy.ts, model-transport.ts and codex-model-driver.ts in the runtime file inventory.',
  ],
]);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function fail(message) {
  throw new Error(message);
}

function safePath(path) {
  if (
    typeof path !== 'string' ||
    !/^[A-Za-z0-9_./-]+$/.test(path) ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    fail(`Unsafe inventory path: ${path}`);
  return path;
}

function exactKeys(value, keys, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== [...keys].sort().join()
  )
    fail(`Invalid ${label} fields`);
}

function inventory(bytes) {
  const value = JSON.parse(bytes.toString('utf8'));
  exactKeys(value, ['schema', 'sourceRevision', 'files'], 'provenance');
  if (
    value.schema !== 1 ||
    !/^[a-f0-9]{40}$/.test(value.sourceRevision) ||
    !Array.isArray(value.files)
  )
    fail('Invalid provenance header');
  const paths = new Set();
  for (const file of value.files) {
    exactKeys(
      file,
      [
        'path',
        'lane',
        'sourceSha256',
        'artifactSha256',
        'executable',
        'transformation',
      ],
      'provenance entry',
    );
    safePath(file.path);
    const folded = file.path.toLowerCase();
    if (
      paths.has(folded) ||
      [...paths].some(
        (path) =>
          path.startsWith(`${folded}/`) || folded.startsWith(`${path}/`),
      )
    )
      fail(`Duplicate or conflicting inventory path: ${file.path}`);
    paths.add(folded);
    if (
      file.lane !== (file.path.startsWith(archon) ? 'archon' : 'portable') ||
      !/^[a-f0-9]{64}$/.test(file.sourceSha256) ||
      !/^[a-f0-9]{64}$/.test(file.artifactSha256) ||
      typeof file.executable !== 'boolean' ||
      !(
        file.transformation === null ||
        (typeof file.transformation === 'string' && file.transformation.trim())
      ) ||
      (file.sourceSha256 !== file.artifactSha256 &&
        file.transformation === null)
    )
      fail(`Invalid provenance entry: ${file.path}`);
  }
  for (const path of legacyChanges.keys())
    if (!value.files.some((file) => file.path === path))
      fail(`Missing legacy provenance: ${path}`);
  return value;
}

function parseSource(text, path) {
  const source = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  if (source.parseDiagnostics.length) fail(`Invalid TypeScript: ${path}`);
  if (source.referencedFiles.length || source.typeReferenceDirectives.length)
    fail(`External TypeScript reference: ${path}`);
  return source;
}

// TypeScript is a build-time parser only; emitted files retain no compiler dependency.
function transform(bytes, sourcePath, artifact) {
  const text = new TextDecoder('utf-8', {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes);
  const source = parseSource(text, sourcePath);
  const edits = [];
  const applied = new Set();
  const dependency = (literal) => {
    if (!literal || !ts.isStringLiteral(literal))
      fail(`Computed module dependency: ${sourcePath}`);
    const original = literal.text;
    const replacement = rewrites.get(original) ?? original;
    if (
      !isBuiltin(replacement) &&
      !(
        replacement.startsWith('./') &&
        generated.has(posix.join(posix.dirname(artifact), replacement))
      )
    )
      fail(`Non-standalone dependency in ${sourcePath}: ${original}`);
    if (replacement !== original) {
      const start = literal.getStart(source);
      edits.push({ start: start + 1, end: literal.end - 1, text: replacement });
      applied.add(original);
    }
  };
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    )
      dependency(node.moduleSpecifier);
    else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    )
      dependency(node.moduleReference.expression);
    else if (ts.isImportTypeNode(node))
      dependency(
        ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined,
      );
    else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === 'require'))
    )
      dependency(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(source);
  let output = text;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  const instructions = [...applied]
    .sort()
    .map(
      (name) =>
        `${JSON.stringify(name)} -> ${JSON.stringify(rewrites.get(name))}`,
    )
    .join('; ');
  return {
    bytes: Buffer.from(output),
    transformation: `Generated by tools/generate-privacy-runtime.mjs from Nx source ${sourcePath}; content snapshot identified by sourceSha256 (not the historical v4.1 sourceRevision). ${instructions ? `Rewrite module specifiers: ${instructions}; preserve all other bytes.` : 'Copy source bytes unchanged.'}`,
  };
}

function listPaths(bytes, label) {
  const lines = bytes.toString('utf8').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const paths = lines.map(safePath);
  if (new Set(paths.map((path) => path.toLowerCase())).size !== paths.length)
    fail(`Duplicate path in ${label}`);
  return paths;
}

/** Prepare every output and validate the entire inventory before allowing any write. */
export async function planPrivacyRuntime(root = process.cwd()) {
  root = await realpath(root);
  const snapshots = new Map();
  async function read(path, optional = false) {
    safePath(path);
    const parts = path.split('/');
    let absolute = root;
    for (let index = 0; index < parts.length; index++) {
      absolute = join(absolute, parts[index]);
      let info;
      try {
        info = await lstat(absolute);
      } catch (error) {
        if (optional && index === parts.length - 1 && error.code === 'ENOENT') {
          snapshots.set(path, null);
          return null;
        }
        throw error;
      }
      if (
        info.isSymbolicLink() ||
        (index < parts.length - 1
          ? !info.isDirectory()
          : !info.isFile() || info.nlink !== 1)
      )
        fail(`Expected regular, unlinked file path: ${path}`);
      if (index === parts.length - 1) {
        const snapshot = {
          bytes: await readFile(absolute),
          executable: !!(info.mode & 0o111),
        };
        snapshots.set(path, snapshot);
        return snapshot;
      }
    }
  }
  const original = inventory((await read(provenancePath)).bytes);
  const imported = listPaths(
    (await read(importPathsPath)).bytes,
    'import-paths.txt',
  );
  const records = new Map(original.files.map((file) => [file.path, file]));
  const ordinary = (paths) =>
    paths.filter((path) => !generated.has(path)).sort();
  if (
    ordinary(imported).join('\n') !== ordinary([...records.keys()]).join('\n')
  )
    fail('Unrelated import-paths.txt inventory drift');

  async function walk(relative = '') {
    const directory = join(root, assetPath, relative);
    if (
      !(await lstat(directory)).isDirectory() ||
      (await realpath(directory)) !== directory
    )
      fail(`Unsafe asset directory: ${relative}`);
    const paths = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      safePath(path);
      if (entry.isDirectory()) paths.push(...(await walk(path)));
      else if (entry.isFile()) paths.push(path);
      else fail(`Unsupported asset entry: ${path}`);
    }
    return paths;
  }
  const assets = await walk();
  for (const path of assets)
    if (!records.has(path) && !generated.has(path))
      fail(`Uninventoried asset: ${path}`);
  for (const file of original.files) {
    const current = await read(
      `${assetPath}/${file.path}`,
      generated.has(file.path),
    );
    if (generated.has(file.path)) continue;
    if (current.executable !== file.executable)
      fail(`Asset executable-mode drift: ${file.path}`);
    if (
      !legacyChanges.has(file.path) &&
      hash(current.bytes) !== file.artifactSha256
    )
      fail(`Unrelated asset drift: ${file.path}`);
  }

  const outputs = new Map();
  for (const [path, sourcePath] of generated) {
    const source = await read(sourcePath);
    const result = transform(source.bytes, sourcePath, path);
    await read(`${assetPath}/${path}`, true);
    outputs.set(`${assetPath}/${path}`, result.bytes);
    records.set(path, {
      path,
      lane: 'archon',
      sourceSha256: hash(source.bytes),
      artifactSha256: hash(result.bytes),
      executable: false,
      transformation: result.transformation,
    });
  }
  const runtimePaths = listPaths(
    snapshots.get(`${assetPath}/${archon}runtime-files.txt`).bytes,
    'runtime-files.txt',
  );
  const lifecycle = parseSource(
    snapshots.get(`${assetPath}/${archon}lifecycle.ts`).bytes.toString('utf8'),
    'lifecycle.ts',
  );
  let payload;
  const findPayload = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'payload'
    ) {
      const value = node.initializer;
      payload =
        value &&
        ts.isCallExpression(value) &&
        ts.isPropertyAccessExpression(value.expression) &&
        value.expression.name.text === 'sort'
          ? value.expression.expression
          : value;
    }
    ts.forEachChild(node, findPayload);
  };
  findPayload(lifecycle);
  if (!payload || !ts.isArrayLiteralExpression(payload))
    fail('Unsupported lifecycle payload declaration');
  const payloadPaths = payload.elements
    .filter(ts.isStringLiteral)
    .map((node) => node.text);
  for (const path of generated.keys()) {
    if (!runtimePaths.includes(path.slice(archon.length)))
      fail(`runtime-files.txt is missing ${path}`);
    if (payloadPaths.filter((value) => value === path).length !== 1)
      fail(`lifecycle.ts payload must include ${path} exactly once`);
  }
  for (const path of runtimePaths)
    if (!records.has(`${archon}${path}`))
      fail(`Uninventoried runtime file: ${path}`);
  for (const [path, description] of legacyChanges) {
    const file = records.get(path);
    const note = `Nx privacy host integration (content snapshot): ${description}`;
    const prior = file.transformation;
    records.set(path, {
      ...file,
      artifactSha256: hash(snapshots.get(`${assetPath}/${path}`).bytes),
      transformation: prior?.endsWith(note)
        ? prior
        : [prior, note].filter(Boolean).join(' '),
    });
  }
  const files = [...records.values()].sort((a, b) => compare(a.path, b.path));
  const manifestBytes = json({ ...original, files });
  inventory(manifestBytes);
  outputs.set(provenancePath, manifestBytes);
  outputs.set(
    importPathsPath,
    Buffer.from(`${files.map((file) => file.path).join('\n')}\n`),
  );
  const stale = [...outputs]
    .filter(([path, bytes]) => {
      const prior = snapshots.get(path);
      return (
        !prior ||
        !prior.bytes.equals(bytes) ||
        (path.startsWith(`${assetPath}/`) && prior.executable)
      );
    })
    .map(([path]) => path);
  return { root, outputs, stale, snapshots, assets: assets.sort() };
}

export async function checkPrivacyRuntime(root = process.cwd()) {
  const plan = await planPrivacyRuntime(root);
  if (plan.stale.length)
    fail(`Privacy runtime is stale:\n${plan.stale.join('\n')}`);
  return { changed: [] };
}

export async function generatePrivacyRuntime(root = process.cwd()) {
  const plan = await planPrivacyRuntime(root);
  // Revalidate the complete read set, including absent outputs, before publishing.
  const fresh = await planPrivacyRuntime(plan.root);
  if (
    JSON.stringify(plan.assets) !== JSON.stringify(fresh.assets) ||
    plan.snapshots.size !== fresh.snapshots.size ||
    [...plan.snapshots].some(([path, before]) => {
      const after = fresh.snapshots.get(path);
      return before === null
        ? after !== null
        : !after ||
            before.executable !== after.executable ||
            !before.bytes.equals(after.bytes);
    })
  )
    fail('Privacy runtime inputs changed during generation');
  for (const path of plan.stale) {
    await writeFile(join(plan.root, path), plan.outputs.get(path), {
      mode: 0o644,
    });
    if (path.startsWith(`${assetPath}/`))
      await chmod(join(plan.root, path), 0o644);
  }
  return { changed: plan.stale };
}

async function main(args) {
  if (
    args.length > 1 ||
    (args.length === 1 && !['--check', '--write'].includes(args[0]))
  )
    fail(
      'Usage: node tools/generate-privacy-runtime.mjs [--check|--write] (from the workspace root)',
    );
  const result =
    args[0] === '--write'
      ? await generatePrivacyRuntime()
      : await checkPrivacyRuntime();
  process.stdout.write(
    result.changed.length
      ? `Updated:\n${result.changed.join('\n')}\n`
      : 'Privacy runtime is current.\n',
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
