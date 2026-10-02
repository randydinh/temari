import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
} from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { checkCanonicalArtifact } from './canonical-runtime.mjs';
import { packagePublicEntries } from './public-entry-runtime.mjs';
import { verifyRegistrarPayload } from './registrar-payload.mjs';

const toolPath = fileURLToPath(import.meta.url);
const workspace = resolve(dirname(toolPath), '..');
const manifestName = 'knowledge-plugin-manifest.json';
const pluginPath = '.codex-plugin/plugin.json';
const launcherPath = 'bin/temari-knowledge.mjs';
const skillPath = 'skills/content-registrar-knowledge/SKILL.md';
const sourcePluginPath =
  'packages/workflow-runtime/knowledge-plugin/.codex-plugin/plugin.json';
const sourceSkillPath =
  'packages/workflow-runtime/public/skills/temari-knowledge/SKILL.md';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

function safePath(path) {
  assert(
    path &&
      !posix.isAbsolute(path) &&
      !/[\\:\x00-\x1f]/.test(path) &&
      path.split('/').every((part) => part && part !== '.' && part !== '..'),
    `Unsafe artifact path: ${path}`,
  );
}

async function filesAt(root) {
  const files = new Map();
  async function walk(relative = '') {
    const stat = await lstat(join(root, relative));
    assert(!stat.isSymbolicLink(), `Symlink in plugin: ${relative}`);
    if (stat.isDirectory()) {
      for (const entry of await readdir(join(root, relative)))
        await walk(relative ? `${relative}/${entry}` : entry);
      return;
    }
    assert(stat.isFile(), `Nonregular plugin file: ${relative}`);
    safePath(relative);
    files.set(relative, await readFile(join(root, relative)));
  }
  await walk();
  return files;
}

function records(files) {
  return [...files]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, bytes]) => ({
      path,
      sha256: sha256(bytes),
      bytes: bytes.length,
    }));
}

export async function readRegularSource(path, root = workspace) {
  assert(isAbsolute(path) && isAbsolute(root));
  const inside = relative(root, path);
  assert(
    inside && !inside.startsWith('..') && !isAbsolute(inside),
    'Source must be inside its trust root',
  );
  let component = root;
  for (const part of ['', ...inside.split(/[\\/]/).slice(0, -1)]) {
    if (part) component = join(component, part);
    const stat = await lstat(component);
    assert(
      stat.isDirectory() && !stat.isSymbolicLink(),
      `Symlink or non-directory source path component: ${component}`,
    );
  }
  assert(
    Number.isInteger(constants.O_NOFOLLOW),
    'No-follow source reads are required',
  );
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    assert(stat.isFile(), `Source must be a regular file: ${path}`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function git(...args) {
  return execFileSync('git', ['-C', workspace, ...args], {
    encoding: 'utf8',
  }).trim();
}

function standaloneSkill(source) {
  const original = source.toString('utf8');
  const first = 'name: temari-knowledge\n';
  const paragraph =
    "# Temari Knowledge\n\nThis skill exposes a knowledge capability beside Temari's three public workflow\nentries. It does not admit an engineering or QA route, decide a disposition, or\nexpand the current task's authority.";
  assert(original.includes(first) && original.includes(paragraph));
  return Buffer.from(
    original
      .replace(first, 'name: content-registrar-knowledge\n')
      .replace(
        paragraph,
        "# Content Registrar Knowledge\n\nThis standalone plugin exposes the source-backed Knowledge workflow. It does not\nadmit an engineering or QA route, decide a disposition, or expand the current\ntask's authority.",
      ),
  );
}

async function writeExclusive(root, path, bytes, executable = false) {
  safePath(path);
  const destination = join(root, path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes, { flag: 'wx' });
  if (executable) await chmod(destination, 0o755);
}

export async function checkKnowledgePlugin(root, expectedManifestSha256) {
  assert(isAbsolute(root));
  assert.match(expectedManifestSha256 ?? '', /^[a-f0-9]{64}$/);
  const files = await filesAt(root);
  const bytes = files.get(manifestName);
  assert(bytes, `Missing ${manifestName}`);
  assert.equal(sha256(bytes), expectedManifestSha256);
  const manifest = JSON.parse(bytes.toString());
  assert.equal(manifest.schemaVersion, 1);
  assert.match(manifest.source.revision, /^[a-f0-9]{40,64}$/);
  assert.equal(typeof manifest.source.dirty, 'boolean');
  assert.match(manifest.source.publicManifestSha256, /^[a-f0-9]{64}$/);
  assert(Array.isArray(manifest.source.additionalFiles));
  assert.deepEqual(
    manifest.source.additionalFiles.map((file) => file.path),
    [sourcePluginPath, sourceSkillPath, 'tools/knowledge-plugin.mjs'].sort(),
  );
  for (const file of manifest.source.additionalFiles) {
    safePath(file.path);
    assert.match(file.sha256, /^[a-f0-9]{64}$/);
    assert(Number.isSafeInteger(file.bytes) && file.bytes >= 0);
  }
  assert.match(manifest.runtimeManifestSha256, /^[a-f0-9]{64}$/);
  files.delete(manifestName);
  assert.deepEqual(manifest.files, records(files));
  const paths = [...files.keys()];
  assert.deepEqual(
    paths
      .filter(
        (path) =>
          !path.startsWith('registrar/') && !path.startsWith('runtime/'),
      )
      .sort(),
    [pluginPath, launcherPath, skillPath].sort(),
  );
  const plugin = JSON.parse(files.get(pluginPath).toString());
  assert.equal(
    sha256(files.get(pluginPath)),
    manifest.source.additionalFiles.find(
      (file) => file.path === sourcePluginPath,
    ).sha256,
  );
  assert.equal(plugin.name, 'content-registrar-knowledge');
  assert.equal(plugin.version, '0.1.0');
  assert.equal(plugin.skills, './skills/');
  assert.match(
    files.get(skillPath).toString(),
    /^---\nname: content-registrar-knowledge\n/,
  );
  assert(
    files.get(launcherPath).includes('temari-knowledge-provider-selection'),
  );
  await verifyRegistrarPayload(join(root, 'registrar'));
  const runtime = await checkCanonicalArtifact(join(root, 'runtime'));
  assert.equal(
    sha256(await readFile(join(root, 'runtime/canonical-manifest.json'))),
    manifest.runtimeManifestSha256,
  );
  assert.equal(runtime.source.revision, manifest.source.revision);
  if (process.platform !== 'win32')
    assert((await lstat(join(root, launcherPath))).mode & 0o111);
  return manifest;
}

/** Projects the reviewed Knowledge payload from a verified Temari package. */
export async function packageKnowledgePlugin(output) {
  assert(isAbsolute(output));
  try {
    await lstat(output);
    throw new Error(`Output already exists: ${output}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await mkdir(dirname(output), { recursive: true });
  const reservationPath = `${output}.publish-lock`;
  let reservation;
  try {
    reservation = await open(reservationPath, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST')
      throw new Error(`Output is already reserved: ${output}`);
    throw error;
  }
  let buildRoot;
  try {
    buildRoot = await mkdtemp(
      join(dirname(output), `.${basename(output)}.staging-`),
    );
    const publicRoot = join(buildRoot, 'temari');
    const publicManifest = await packagePublicEntries(publicRoot);
    const publicManifestBytes = await readFile(
      join(publicRoot, 'public-entry-manifest.json'),
    );
    const staging = join(buildRoot, 'plugin');
    await mkdir(staging);
    const publicFiles = await filesAt(publicRoot);
    for (const [path, bytes] of publicFiles) {
      if (path.startsWith('registrar/') || path.startsWith('runtime/'))
        await writeExclusive(staging, path, bytes);
    }
    await writeExclusive(
      staging,
      launcherPath,
      publicFiles.get(launcherPath),
      true,
    );
    const pluginSource = await readRegularSource(
      join(workspace, sourcePluginPath),
    );
    const skillSource = await readRegularSource(
      join(workspace, sourceSkillPath),
    );
    const toolSource = await readRegularSource(toolPath);
    await writeExclusive(staging, pluginPath, pluginSource);
    await writeExclusive(staging, skillPath, standaloneSkill(skillSource));
    assert.equal(git('rev-parse', 'HEAD'), publicManifest.source.revision);
    const files = await filesAt(staging);
    const manifest = {
      schemaVersion: 1,
      source: {
        revision: publicManifest.source.revision,
        dirty:
          publicManifest.source.dirty ||
          git('status', '--porcelain=v1', '--untracked-files=all') !== '',
        publicManifestSha256: sha256(publicManifestBytes),
        additionalFiles: records(
          new Map([
            [sourcePluginPath, pluginSource],
            [sourceSkillPath, skillSource],
            ['tools/knowledge-plugin.mjs', toolSource],
          ]),
        ),
      },
      runtimeManifestSha256: sha256(
        await readFile(join(staging, 'runtime/canonical-manifest.json')),
      ),
      files: records(files),
    };
    const manifestBytes = jsonBytes(manifest);
    await writeExclusive(staging, manifestName, manifestBytes);
    await checkKnowledgePlugin(staging, sha256(manifestBytes));
    try {
      await lstat(output);
      throw new Error(`Output already exists: ${output}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await rename(staging, output);
    return checkKnowledgePlugin(output, sha256(manifestBytes));
  } finally {
    if (buildRoot) await rm(buildRoot, { recursive: true, force: true });
    await reservation.close();
    await rm(reservationPath, { force: true });
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === pathToFileURL(toolPath).href
) {
  const { values, positionals } = parseArgs({
    options: {
      output: { type: 'string' },
      artifact: { type: 'string' },
      'expected-manifest-sha256': { type: 'string' },
    },
    allowPositionals: true,
  });
  const [command] = positionals;
  assert(positionals.length === 1);
  const result =
    command === 'package' && values.output && !values.artifact
      ? await packageKnowledgePlugin(values.output)
      : command === 'check' &&
          values.artifact &&
          values['expected-manifest-sha256'] &&
          !values.output
        ? await checkKnowledgePlugin(
            values.artifact,
            values['expected-manifest-sha256'],
          )
        : (() => {
            throw new Error(
              'Usage: knowledge-plugin.mjs package --output ABS | check --artifact ABS --expected-manifest-sha256 HEX',
            );
          })();
  process.stdout.write(
    `${JSON.stringify(
      {
        source: result.source,
        files: result.files.length,
        bytes: result.files.reduce((sum, file) => sum + file.bytes, 0),
      },
      null,
      2,
    )}\n`,
  );
}
