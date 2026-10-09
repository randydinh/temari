import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire, isBuiltin } from 'node:module';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  posix,
} from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import ts from 'typescript';

const toolPath = fileURLToPath(import.meta.url);
const workspace = resolve(dirname(toolPath), '..');
const packageNames = [
  'contracts',
  'temari-core',
  'workflow-engine',
  'runtime',
  'knowledge',
];
const manifestName = 'canonical-manifest.json';
const knowledgePrepare = 'node_modules/@temari/knowledge/src/support/prepare.py';
const compilerSettings = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  lib: ['lib.es2022.d.ts'],
  types: ['node'],
  strict: true,
  skipLibCheck: true,
  noEmitOnError: true,
  declaration: true,
  declarationMap: false,
  sourceMap: false,
  importHelpers: false,
  forceConsistentCasingInFileNames: true,
};

function digest(content) {
  return createHash('sha256').update(content).digest('hex');
}

function record(path, content) {
  return { path, sha256: digest(content), bytes: Buffer.byteLength(content) };
}

function portable(path) {
  return path.split(sep).join('/');
}

function safePath(path) {
  assert(
    typeof path === 'string' &&
      path.length > 0 &&
      !path.includes('\\') &&
      !path.includes(':') &&
      !/[\x00-\x1f]/.test(path) &&
      !posix.isAbsolute(path) &&
      path
        .split('/')
        .every((part) => part !== '' && part !== '.' && part !== '..'),
    `Unsafe artifact path: ${path}`,
  );
  return path;
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function sortedRecords(files) {
  return [...files]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, content]) => record(path, content));
}

function packageRoot(name) {
  return `node_modules/@temari/${name}`;
}

function auditImports(files) {
  const packages = new Map();
  for (const name of packageNames) {
    const root = packageRoot(name);
    assert(files.has(`${root}/package.json`), `Missing package: ${name}`);
    const metadata = JSON.parse(files.get(`${root}/package.json`).toString());
    assert.equal(metadata.name, `@temari/${name}`);
    assert.match(
      metadata.version,
      /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/,
    );
    assert.equal(metadata.type, 'module');
    assert.equal(metadata.main, './src/index.js');
    assert.equal(metadata.types, './src/index.d.ts');
    const expectedExports = {
      '.': {
        types: './src/index.d.ts',
        import: './src/index.js',
        default: './src/index.js',
      },
      './package.json': './package.json',
    };
    if (name === 'knowledge') {
      expectedExports['./cli'] = './src/demo.js';
      assert.deepEqual(metadata.bin, {
        'temari-knowledge': './src/demo.js',
      });
      assert(files.has(`${root}/src/demo.js`), 'Missing knowledge CLI');
      assert(files.has(knowledgePrepare), 'Missing knowledge preparation helper');
    } else assert.equal(metadata.bin, undefined);
    assert.deepEqual(metadata.exports, expectedExports);
    assert(files.has(`${root}/src/index.js`), `Missing entry for ${name}`);
    assert(
      files.has(`${root}/src/index.d.ts`),
      `Missing declarations for ${name}`,
    );
    packages.set(metadata.name, { root, metadata });
  }
  for (const { metadata } of packages.values()) {
    assert(
      metadata.dependencies &&
        typeof metadata.dependencies === 'object' &&
        !Array.isArray(metadata.dependencies),
    );
    for (const [name, version] of Object.entries(metadata.dependencies)) {
      assert(packages.has(name), `Dependency not included: ${name}`);
      assert.equal(
        version,
        packages.get(name).metadata.version,
        `Nonconcrete dependency: ${name}`,
      );
    }
  }
  for (const [path, content] of files) {
    const owner = [...packages.values()].find(({ root }) =>
      path.startsWith(`${root}/`),
    );
    assert(owner, `File outside included packages: ${path}`);
    if (path === `${owner.root}/package.json`) continue;
    if (path === knowledgePrepare) continue;
    assert(
      /^src\/.+\.(?:js|d\.ts)$/.test(path.slice(owner.root.length + 1)),
      `Unexpected emitted file: ${path}`,
    );
    assert(
      !/(?:^|\/)(?:fixtures?|demos?|__tests__)(?:\/|$)|\.(?:test|spec)\./.test(path),
      `Nonproduction file: ${path}`,
    );
    const source = ts.createSourceFile(
      path,
      content.toString(),
      ts.ScriptTarget.ES2022,
      true,
    );
    assert.equal(
      source.parseDiagnostics.length,
      0,
      `Invalid emitted source: ${path}`,
    );
    const check = (specifier) => {
      assert(ts.isStringLiteralLike(specifier), `Nonliteral import in ${path}`);
      const name = specifier.text;
      if (isBuiltin(name)) return;
      if (name.startsWith('./') || name.startsWith('../')) {
        assert(
          !/[\\%?#:\x00-\x1f]/.test(name),
          `Invalid relative import: ${name}`,
        );
        const target = posix.normalize(posix.join(posix.dirname(path), name));
        assert(
          target.startsWith(`${owner.root}/`),
          `Import escapes package: ${path} -> ${name}`,
        );
        const declarationTarget = target.replace(/\.js$/, '.d.ts');
        assert(
          files.has(target) ||
            (path.endsWith('.d.ts') && files.has(declarationTarget)),
          `Missing imported file: ${path} -> ${name}`,
        );
        return;
      }
      const dependency = [...packages.keys()].find(
        (entry) => name === entry || name === `${entry}/package.json`,
      );
      assert(dependency, `External import not included: ${path} -> ${name}`);
      assert(
        dependency === owner.metadata.name ||
          Object.hasOwn(owner.metadata.dependencies, dependency),
        `Undeclared dependency: ${path} -> ${name}`,
      );
    };
    const visit = (node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier
      )
        check(node.moduleSpecifier);
      if (ts.isImportTypeNode(node)) {
        assert(
          ts.isLiteralTypeNode(node.argument),
          `Nonliteral type import: ${path}`,
        );
        check(node.argument.literal);
      }
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === 'require'))
      ) {
        assert(node.arguments.length > 0, `Missing import argument: ${path}`);
        check(node.arguments[0]);
      }
      if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference)
      )
        check(node.moduleReference.expression);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
}

async function artifactFiles(root) {
  const files = new Map();
  const walk = async (path) => {
    const absolute = path ? join(root, path) : root;
    const stat = await lstat(absolute);
    assert(!stat.isSymbolicLink(), `Symlink not permitted: ${absolute}`);
    if (stat.isDirectory()) {
      for (const entry of await readdir(absolute))
        await walk(path ? `${path}/${entry}` : entry);
    } else {
      assert(stat.isFile(), `Nonregular artifact file: ${absolute}`);
      safePath(path);
      files.set(path, await readFile(absolute));
    }
  };
  await walk('');
  return files;
}

/** Checks local integrity, not provenance or a signature. */
export async function checkCanonicalArtifact(root, expectedManifest) {
  assert(isAbsolute(root), 'Artifact path must be absolute');
  const files = await artifactFiles(root);
  assert(files.has(manifestName), `Missing ${manifestName}`);
  const manifest = JSON.parse(files.get(manifestName).toString());
  assert.equal(
    manifest.schemaVersion,
    1,
    'Unsupported canonical manifest schema',
  );
  assert.equal(
    typeof manifest.source?.dirty,
    'boolean',
    'Missing source dirty state',
  );
  assert.match(manifest.source.revision, /^[a-f0-9]{40,64}$/);
  assert.equal(manifest.compiler?.name, 'typescript');
  assert.equal(typeof manifest.compiler.version, 'string');
  assert.match(manifest.compiler.sha256, /^[a-f0-9]{64}$/);
  assert.equal(typeof manifest.build?.node, 'string');
  assert.match(manifest.build.tool.sha256, /^[a-f0-9]{64}$/);
  assert(
    Array.isArray(manifest.source.files) && manifest.source.files.length > 0,
    'Missing source identity',
  );
  assert(Array.isArray(manifest.files), 'Missing artifact file inventory');
  for (const entry of [...manifest.source.files, ...manifest.files]) {
    safePath(entry.path);
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    assert(
      Number.isSafeInteger(entry.bytes) && entry.bytes >= 0,
      `Invalid byte length: ${entry.path}`,
    );
  }
  if (expectedManifest !== undefined)
    assert.deepEqual(
      manifest,
      expectedManifest,
      'Artifact manifest differs from expected manifest',
    );
  files.delete(manifestName);
  assert.deepEqual(
    manifest.files,
    sortedRecords(files),
    'Artifact file integrity differs from manifest (missing, extra, or tampered content)',
  );
  auditImports(files);
  return manifest;
}

/** Compiles only reachable production code and never replaces a destination. */
export async function packageCanonicalRuntime(output) {
  assert(isAbsolute(output), 'Output path must be absolute');
  try {
    await lstat(output);
    throw new Error(`Output already exists: ${output}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const files = new Map();
  const inputs = new Map();
  const metadata = new Map();
  for (const name of packageNames) {
    const path = `libs/${name}/package.json`;
    const bytes = await readFile(join(workspace, path));
    inputs.set(path, bytes);
    const value = JSON.parse(bytes.toString());
    assert.equal(value.name, `@temari/${name}`);
    metadata.set(value.name, value);
  }
  const outDir = join(workspace, '.canonical-emit');
  const options = {
    ...compilerSettings,
    rootDir: join(workspace, 'libs'),
    outDir,
  };
  const host = ts.createCompilerHost(options);
  host.getCurrentDirectory = () => workspace;
  const program = ts.createProgram(
    [
      ...packageNames.map((name) => join(workspace, 'libs', name, 'src/index.ts')),
      join(workspace, 'libs/knowledge/src/demo.ts'),
    ],
    options,
    host,
  );
  const diagnostics = ts.getPreEmitDiagnostics(program);
  const failDiagnostics = (values) => {
    if (values.length)
      throw new Error(
        ts.formatDiagnosticsWithColorAndContext(values, {
          getCanonicalFileName: (path) => path,
          getCurrentDirectory: () => workspace,
          getNewLine: () => '\n',
        }),
      );
  };
  failDiagnostics(diagnostics);
  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile) continue;
    const path = portable(relative(join(workspace, 'libs'), source.fileName));
    const [name, directory] = path.split('/');
    assert(
      packageNames.includes(name) &&
        directory === 'src' &&
        path.endsWith('.ts'),
      `Source outside production closure: ${path}`,
    );
    assert(
      !/(?:^|\/)(?:fixtures?|demos?|__tests__)(?:\/|$)|\.(?:test|spec)\./.test(path),
      `Nonproduction source: ${path}`,
    );
    inputs.set(`libs/${path}`, Buffer.from(source.text));
  }
  const result = program.emit(undefined, (path, text) => {
    const emitted = portable(relative(outDir, path));
    safePath(emitted);
    assert(
      packageNames.includes(emitted.split('/')[0]),
      `Unexpected compiler output: ${emitted}`,
    );
    const target = `node_modules/@temari/${emitted}`;
    assert(!files.has(target), `Duplicate compiler output: ${target}`);
    files.set(target, Buffer.from(text));
  });
  failDiagnostics(result.diagnostics);
  assert(!result.emitSkipped, 'TypeScript skipped canonical runtime emit');
  const preparationSource = 'libs/knowledge/src/support/prepare.py';
  const preparationBytes = await readFile(join(workspace, preparationSource));
  inputs.set(preparationSource, preparationBytes);
  files.set(knowledgePrepare, preparationBytes);
  for (const value of metadata.values()) {
    const dependencies = Object.fromEntries(
      Object.keys(value.dependencies ?? {})
        .sort()
        .map((name) => {
          assert(
            metadata.has(name),
            `Dependency outside canonical package: ${name}`,
          );
          return [name, metadata.get(name).version];
        }),
    );
    files.set(
      `${packageRoot(value.name.slice('@temari/'.length))}/package.json`,
      jsonBytes({
        name: value.name,
        version: value.version,
        private: true,
        type: 'module',
        main: './src/index.js',
        types: './src/index.d.ts',
        exports: {
          '.': {
            types: './src/index.d.ts',
            import: './src/index.js',
            default: './src/index.js',
          },
          './package.json': './package.json',
          ...(value.name === '@temari/knowledge'
            ? { './cli': './src/demo.js' }
            : {}),
        },
        ...(value.name === '@temari/knowledge'
          ? { bin: { 'temari-knowledge': './src/demo.js' } }
          : {}),
        dependencies,
      }),
    );
  }
  auditImports(files);
  const git = (...args) =>
    execFileSync('git', ['-C', workspace, ...args], {
      encoding: 'utf8',
    }).trim();
  const manifest = {
    schemaVersion: 1,
    source: {
      revision: git('rev-parse', 'HEAD'),
      dirty: git('status', '--porcelain=v1', '--untracked-files=normal') !== '',
      files: sortedRecords(inputs),
    },
    compiler: {
      name: 'typescript',
      version: ts.version,
      sha256: digest(
        await readFile(createRequire(import.meta.url).resolve('typescript')),
      ),
    },
    build: {
      node: process.version,
      tool: record('tools/canonical-runtime.mjs', await readFile(toolPath)),
      options: compilerSettings,
    },
    files: sortedRecords(files),
  };
  // Exclusive mkdir is the publication guard, including simultaneous builders.
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output);
  for (const [path, content] of files) {
    const destination = join(output, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content, { flag: 'wx' });
  }
  await writeFile(join(output, manifestName), jsonBytes(manifest), {
    flag: 'wx',
  });
  return checkCanonicalArtifact(output, manifest);
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    const { values, positionals } = parseArgs({
      options: { output: { type: 'string' }, artifact: { type: 'string' } },
      allowPositionals: true,
    });
    const [command] = positionals;
    assert(
      positionals.length === 1 &&
        ((command === 'package' && values.output && !values.artifact) ||
          (command === 'check' && values.artifact && !values.output)),
      'Usage: canonical-runtime.mjs package --output ABSOLUTE_NEW_PATH | check --artifact ABSOLUTE_PATH',
    );
    const manifest =
      command === 'package'
        ? await packageCanonicalRuntime(values.output)
        : await checkCanonicalArtifact(values.artifact);
    console.log(JSON.stringify(manifest, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
