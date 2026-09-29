#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { isAbsolute, join, posix } from 'node:path';
import { parseArgs } from 'node:util';
import { readBoundedFile, verifyBundle } from './public-entry.mjs';

const MANIFEST = 'temari-overlay.json';
const MANIFEST_BYTES = 64 * 1024;
const ASSET_BYTES = 8 * 1024 * 1024;
const TOTAL_ASSET_BYTES = 64 * 1024 * 1024;
const MAX_ASSETS = 128;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const utf8 = new TextDecoder('utf-8', { fatal: true });

function exactFields(value, fields) {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...fields].sort());
}

function opaqueId(value) {
  assert(
    typeof value === 'string' && /^[a-z][a-z0-9._-]{0,63}$/.test(value),
    'Overlay identifiers must be short opaque names.',
  );
}

function safePath(value) {
  assert(
    typeof value === 'string' &&
      value.length > 0 &&
      !value.includes('\\') &&
      !value.includes(':') &&
      !/[\x00-\x1f]/.test(value) &&
      !posix.isAbsolute(value) &&
      value
        .split('/')
        .every((part) => part !== '' && part !== '.' && part !== '..'),
    `Unsafe overlay path: ${value}`,
  );
}

async function listFiles(root) {
  const files = [];
  async function visit(path) {
    const stat = await lstat(path ? join(root, path) : root);
    assert(!stat.isSymbolicLink(), 'Overlay symlinks are forbidden.');
    if (stat.isDirectory()) {
      for (const name of await readdir(path ? join(root, path) : root)) {
        const child = path ? `${path}/${name}` : name;
        safePath(child);
        await visit(child);
      }
      return;
    }
    assert(stat.isFile(), 'Overlay contains a nonregular entry.');
    files.push(path);
    assert(files.length <= MAX_ASSETS + 1, 'Overlay has too many files.');
  }
  await visit('');
  return files.sort();
}

export async function checkOverlay(root, expectedOverlayDigest, publicDigest) {
  assert(isAbsolute(root), 'Overlay root must be absolute.');
  const rootStat = await lstat(root);
  assert(rootStat.isDirectory() && !rootStat.isSymbolicLink());
  assert.match(expectedOverlayDigest ?? '', /^[a-f0-9]{64}$/);
  const manifestBytes = await readBoundedFile(
    join(root, MANIFEST),
    MANIFEST_BYTES,
  );
  assert.equal(
    digest(manifestBytes),
    expectedOverlayDigest,
    'Overlay manifest differs from the trusted digest.',
  );
  const manifest = JSON.parse(utf8.decode(manifestBytes));
  exactFields(manifest, [
    'schemaVersion',
    'overlayId',
    'compatiblePublicManifestSha256',
    'assets',
    'credentialRefs',
  ]);
  assert.equal(manifest.schemaVersion, 1);
  opaqueId(manifest.overlayId);
  assert.equal(
    manifest.compatiblePublicManifestSha256,
    publicDigest,
    'Overlay targets a different public artifact.',
  );
  assert(Array.isArray(manifest.assets));
  assert(manifest.assets.length <= MAX_ASSETS);
  assert(Array.isArray(manifest.credentialRefs));
  assert(manifest.credentialRefs.length <= MAX_ASSETS);
  const assetPaths = new Set();
  let totalAssetBytes = 0;
  for (const asset of manifest.assets) {
    exactFields(asset, ['path', 'kind', 'sha256', 'bytes']);
    safePath(asset.path);
    assert(asset.path !== MANIFEST, 'Manifest cannot be an overlay asset.');
    assert(!assetPaths.has(asset.path), 'Duplicate overlay asset.');
    assetPaths.add(asset.path);
    assert(['skill', 'knowledge', 'provider-profile'].includes(asset.kind));
    assert.match(asset.sha256, /^[a-f0-9]{64}$/);
    assert(
      Number.isSafeInteger(asset.bytes) &&
        asset.bytes >= 0 &&
        asset.bytes <= ASSET_BYTES,
      'Invalid overlay asset size.',
    );
    totalAssetBytes += asset.bytes;
    assert(
      totalAssetBytes <= TOTAL_ASSET_BYTES,
      'Overlay assets exceed the byte limit.',
    );
  }
  const credentialIds = new Set();
  for (const reference of manifest.credentialRefs) {
    exactFields(reference, ['id', 'provider', 'handle']);
    opaqueId(reference.id);
    opaqueId(reference.provider);
    assert(
      typeof reference.handle === 'string' &&
        /^credential-ref:[a-z][a-z0-9._-]{0,63}$/.test(reference.handle),
      'Credential references must be opaque handles.',
    );
    assert(!credentialIds.has(reference.id), 'Duplicate credential reference.');
    credentialIds.add(reference.id);
  }
  assert.deepEqual(
    await listFiles(root),
    [MANIFEST, ...assetPaths].sort(),
    'Overlay inventory differs from its manifest.',
  );
  for (const asset of manifest.assets) {
    const bytes = await readBoundedFile(join(root, asset.path), asset.bytes);
    assert.equal(
      bytes.length,
      asset.bytes,
      `Overlay asset size changed: ${asset.path}`,
    );
    assert.equal(
      digest(bytes),
      asset.sha256,
      `Overlay asset bytes changed: ${asset.path}`,
    );
  }
  return {
    status: 'compatible',
    overlayId: manifest.overlayId,
    assetCount: manifest.assets.length,
    credentialReferenceCount: manifest.credentialRefs.length,
    publicManifestSha256: publicDigest,
    overlayManifestSha256: expectedOverlayDigest,
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      'expected-manifest-sha256': { type: 'string' },
      'overlay-root': { type: 'string' },
      'expected-overlay-sha256': { type: 'string' },
    },
  });
  const publicDigest = values['expected-manifest-sha256'];
  await verifyBundle(publicDigest);
  const overlayRoot = values['overlay-root'] ?? 'none';
  if (overlayRoot === 'none') {
    assert.equal(values['expected-overlay-sha256'], undefined);
    process.stdout.write(
      `${JSON.stringify({ status: 'compatible', overlayId: null, assetCount: 0, credentialReferenceCount: 0, publicManifestSha256: publicDigest })}\n`,
    );
    return;
  }
  process.stdout.write(
    `${JSON.stringify(await checkOverlay(overlayRoot, values['expected-overlay-sha256'], publicDigest))}\n`,
  );
}

if (process.argv[1]?.endsWith('/overlay-check.mjs')) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
