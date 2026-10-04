import { createHash } from 'node:crypto';
import { readdir, readFile, lstat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PAYLOAD_RELATIVE_ROOT = 'packages/workflow-runtime/registrar';
export const REGISTRAR_PAYLOAD_ROOT = join(REPOSITORY_ROOT, PAYLOAD_RELATIVE_ROOT);

const EXPECTED_COMMIT = 'd73f626133b2543345c32805957e05b61e386bad';
const EXPECTED_MANIFEST_SHA256 = '5ecf0874189fcfe6d0a0ad317ef78877a3cc390171c0240823598ac7de3d6e83';
const CURRENT_PROVENANCE = {
  commit: EXPECTED_COMMIT,
  manifestSha256: EXPECTED_MANIFEST_SHA256,
};

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readManifest(root, expected) {
  if (!/^[a-f0-9]{40}$/.test(expected.commit) ||
      !/^[a-f0-9]{64}$/.test(expected.manifestSha256)) {
    throw new Error('Registrar provenance pin is invalid');
  }
  const manifestPath = join(root, 'UPSTREAM.json');
  const stat = await lstat(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Registrar payload manifest must be a regular file');
  }
  const bytes = await readFile(manifestPath);
  if (sha256(bytes) !== expected.manifestSha256) {
    throw new Error('Registrar payload manifest differs from reviewed upstream inventory');
  }
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (manifest.schemaVersion !== 1 || manifest.upstream?.commit !== expected.commit || !Array.isArray(manifest.files)) {
    throw new Error('Registrar payload manifest has invalid provenance');
  }
  return manifest;
}

async function inventory(root) {
  const found = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error(`Registrar payload contains a symlink: ${relative(root, path)}`);
      if (stat.isDirectory()) await walk(path);
      else if (stat.isFile()) found.push(relative(root, path).split(sep).join('/'));
      else throw new Error(`Registrar payload contains a non-file entry: ${relative(root, path)}`);
    }
  }
  await walk(root);
  return found.sort();
}

async function verifyRegistrarPayloadAtPin(root, provenancePin) {
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Registrar payload root must be a real directory');
  }
  const manifest = await readManifest(root, provenancePin);
  const expected = manifest.files.map(({ path }) => path);
  if (expected.some((path) => typeof path !== 'string' || path.startsWith('/') || path.split('/').includes('..')) ||
      expected.join('\n') !== [...new Set(expected)].sort().join('\n')) {
    throw new Error('Registrar payload manifest has an invalid file inventory');
  }
  const actual = (await inventory(root)).filter((path) => path !== 'UPSTREAM.json');
  if (actual.join('\n') !== expected.join('\n')) {
    throw new Error(`Registrar payload file inventory drift: expected ${expected.length}, found ${actual.length}`);
  }
  for (const file of manifest.files) {
    const digest = sha256(await readFile(join(root, file.path)));
    if (digest !== file.sha256) throw new Error(`Registrar payload hash drift: ${file.path}`);
  }
  return { upstream: manifest.upstream, files: manifest.files.length };
}

/** Current payload checks always use the pin reviewed in this checkout. */
export async function verifyRegistrarPayload(root = REGISTRAR_PAYLOAD_ROOT) {
  return verifyRegistrarPayloadAtPin(root, CURRENT_PROVENANCE);
}

/** For a prior release only, after its whole archive digest is independently pinned. */
export async function verifyHistoricalRegistrarPayload(root, provenancePin) {
  if (!provenancePin) throw new Error('Historical Registrar provenance pin is required');
  return verifyRegistrarPayloadAtPin(root, provenancePin);
}

const canonicalManifest = await readManifest(REGISTRAR_PAYLOAD_ROOT, CURRENT_PROVENANCE);
export const REGISTRAR_PAYLOAD_FILES = Object.freeze([
  'UPSTREAM.json',
  ...canonicalManifest.files.map(({ path }) => path),
]);

export async function getRegistrarPayloadFileMap(root = REGISTRAR_PAYLOAD_ROOT) {
  await verifyRegistrarPayload(root);
  return [
    { path: 'UPSTREAM.json', sha256: EXPECTED_MANIFEST_SHA256,
      source: `${PAYLOAD_RELATIVE_ROOT}/UPSTREAM.json` },
    ...canonicalManifest.files.map(({ path, sha256: digest }) => ({
      path,
      sha256: digest,
      source: `${PAYLOAD_RELATIVE_ROOT}/${path}`,
    })),
  ];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await verifyRegistrarPayload();
  process.stdout.write(`Registrar payload verified: ${REGISTRAR_PAYLOAD_FILES.length} files at ${EXPECTED_COMMIT}\n`);
}
