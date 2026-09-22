import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import {
  archonAssetFor,
  installAsset,
  installArchonRuntime,
  installPinnedAsset,
  UnsupportedArchonPlatformError,
  type ArchonReleaseAsset,
} from './managed-runtime.js';

const RELEASE_BASE =
  'https://github.com/coleam00/Archon/releases/download/v0.10.1/';

async function withTempDirectory(
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'archon-runtime-test-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function fixtureAsset(
  payload: Buffer,
  source: ArchonReleaseAsset = archonAssetFor('linux', 'x64'),
  overrides: Partial<ArchonReleaseAsset> = {},
): ArchonReleaseAsset {
  return {
    ...source,
    size: payload.byteLength,
    sha256: createHash('sha256').update(payload).digest('hex'),
    ...overrides,
  };
}

function stubFetch(responses: Response[], calls: string[] = []): typeof fetch {
  let index = 0;
  return (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    assert.equal(init?.redirect, 'manual');
    calls.push(input instanceof URL ? input.href : String(input));
    const response = responses[index];
    index += 1;
    if (!response) {
      throw new Error('Unexpected Archon fetch.');
    }
    return response;
  }) as typeof fetch;
}

test('maps every supported platform to the pinned v0.10.1 release asset', () => {
  const expected = [
    {
      platform: 'darwin',
      arch: 'arm64',
      key: 'darwin-arm64',
      name: 'archon-darwin-arm64',
      size: 75401632,
      sha256:
        '61aa2430198c27b2b3fcc97890c8e4b73b0c7cc99e417930ddb4b1f8c59e6933',
    },
    {
      platform: 'darwin',
      arch: 'x64',
      key: 'darwin-x64',
      name: 'archon-darwin-x64',
      size: 80349760,
      sha256:
        'f4766a8bcb9ab6e688ad6d38b4019cdb84ccce5f6701bfa8e56dfbb9f8ca6cee',
    },
    {
      platform: 'linux',
      arch: 'arm64',
      key: 'linux-arm64',
      name: 'archon-linux-arm64',
      size: 112969153,
      sha256:
        '9b8acd643a224385dc511c8d77400e31166e7e5c5579eb0335ed56e3434d4bff',
    },
    {
      platform: 'linux',
      arch: 'x64',
      key: 'linux-x64',
      name: 'archon-linux-x64',
      size: 113528087,
      sha256:
        '7aa8b25a4b0017dddb05aead518cbd453ca8db9c54ac4a7611f40164fecd3973',
    },
    {
      platform: 'win32',
      arch: 'x64',
      key: 'win32-x64',
      name: 'archon-windows-x64.exe',
      size: 129650176,
      sha256:
        '335cee6aedf7ee5e67a23ee5748813d5f161f4f37e207e61ae9c9a52cd36f54b',
    },
  ] as const;

  for (const item of expected) {
    const asset = archonAssetFor(item.platform, item.arch);
    assert.equal(asset.version, '0.10.1');
    assert.equal(asset.commitPrefix, '9820785c');
    assert.equal(asset.platformKey, item.key);
    assert.equal(asset.assetName, item.name);
    assert.equal(asset.size, item.size);
    assert.equal(asset.sha256, item.sha256);
    assert.equal(asset.url, RELEASE_BASE + item.name);
    assert.equal(asset.url.includes('latest'), false);
  }
});

test('public pinned installer rejects caller-supplied size or digest changes', async () => {
  await withTempDirectory(async (cacheDirectory) => {
    const pinned = archonAssetFor('win32', 'x64');
    const fetchImpl = stubFetch([]);
    await assert.rejects(
      installPinnedAsset(
        cacheDirectory,
        { ...pinned, size: pinned.size + 1 },
        fetchImpl,
      ),
      /does not match the pinned/,
    );
    await assert.rejects(
      installPinnedAsset(
        cacheDirectory,
        { ...pinned, sha256: '0'.repeat(64) },
        fetchImpl,
      ),
      /does not match the pinned/,
    );
  });
});

test('rejects Windows ARM64 and unknown platform combinations with a typed error', async () => {
  assert.throws(
    () => archonAssetFor('win32', 'arm64'),
    UnsupportedArchonPlatformError,
  );
  assert.throws(
    () => archonAssetFor('plan9' as NodeJS.Platform, 'x64'),
    UnsupportedArchonPlatformError,
  );
  await assert.rejects(
    installArchonRuntime({
      cacheDirectory: '/unused',
      platform: 'win32',
      arch: 'arm64',
      fetchImpl: stubFetch([]),
    }),
    UnsupportedArchonPlatformError,
  );
});

test('streams a tiny release asset to the native path and reuses it on repeat install', async () => {
  await withTempDirectory(async (cacheDirectory) => {
    const payload = Buffer.from('small deterministic Archon test binary');
    const asset = fixtureAsset(payload, archonAssetFor('win32', 'x64'));
    const calls: string[] = [];
    const fetchImpl = stubFetch(
      [
        new Response(null, {
          status: 302,
          headers: {
            location:
              'https://release-assets.githubusercontent.com/release/fixture?sig=test',
          },
        }),
        new Response(payload),
      ],
      calls,
    );
    const executablePath = await installAsset(cacheDirectory, asset, fetchImpl);
    assert.equal(
      executablePath,
      join(
        cacheDirectory,
        'components',
        'archon',
        '0.10.1',
        'win32-x64',
        'archon-windows-x64.exe',
      ),
    );
    assert.deepEqual(await readFile(executablePath), payload);
    assert.equal(calls.length, 2);
    assert.equal(calls[0], asset.url);
    assert.equal(
      new URL(calls[1]).hostname,
      'release-assets.githubusercontent.com',
    );
    if (process.platform !== 'win32') {
      assert.notEqual((await lstat(executablePath)).mode & 0o111, 0);
    }

    const reusedPath = await installAsset(cacheDirectory, asset, stubFetch([]));
    assert.equal(reusedPath, executablePath);
    assert.equal(
      (
        await readdir(
          join(cacheDirectory, 'components', 'archon', '0.10.1', 'win32-x64'),
        )
      ).length,
      1,
    );
  });
});

test('rejects non-pinned URLs and redirects outside the GitHub release hosts', async () => {
  await withTempDirectory(async (cacheDirectory) => {
    const payload = Buffer.from('fixture');
    const asset = fixtureAsset(payload);
    await assert.rejects(
      installAsset(
        cacheDirectory,
        { ...asset, url: 'http://github.com/coleam00/Archon/release/file' },
        stubFetch([]),
      ),
      /non-HTTPS/,
    );

    const calls: string[] = [];
    await assert.rejects(
      installAsset(
        cacheDirectory,
        asset,
        stubFetch(
          [
            new Response(null, {
              status: 302,
              headers: { location: 'https://example.com/archon' },
            }),
          ],
          calls,
        ),
      ),
      /untrusted Archon download URL/,
    );
    assert.equal(calls.length, 1);

    const followedResponse = new Response(payload);
    Object.defineProperty(followedResponse, 'url', {
      value: 'https://example.com/archon',
    });
    await assert.rejects(
      installAsset(cacheDirectory, asset, stubFetch([followedResponse])),
      /untrusted Archon download URL/,
    );
  });
});

test('rejects byte-count and SHA-256 mismatches and removes temporary files', async () => {
  await withTempDirectory(async (cacheDirectory) => {
    const payload = Buffer.from('fixture payload');
    const asset = fixtureAsset(payload);
    await assert.rejects(
      installAsset(
        cacheDirectory,
        { ...asset, size: payload.length + 1 },
        stubFetch([new Response(payload)]),
      ),
      /size mismatch/,
    );
    await assert.rejects(
      installAsset(
        cacheDirectory,
        { ...asset, sha256: '0'.repeat(64) },
        stubFetch([new Response(payload)]),
      ),
      /SHA-256 mismatch/,
    );
    const directory = join(
      cacheDirectory,
      'components',
      'archon',
      '0.10.1',
      'linux-x64',
    );
    assert.deepEqual(await readdir(directory), []);
  });
});

test('refuses corrupt files, symlinks, and non-regular existing paths without fetching', async () => {
  await withTempDirectory(async (cacheDirectory) => {
    const payload = Buffer.from('verified payload');
    const asset = fixtureAsset(payload);
    const directory = join(
      cacheDirectory,
      'components',
      'archon',
      '0.10.1',
      'linux-x64',
    );
    await mkdir(directory, { recursive: true });
    const destination = join(directory, asset.assetName);
    await writeFile(destination, 'corrupt');
    await assert.rejects(
      installAsset(cacheDirectory, asset, stubFetch([])),
      /unexpected size/,
    );
    await rm(destination);
    await writeFile(destination, Buffer.alloc(payload.length, 0));
    await assert.rejects(
      installAsset(cacheDirectory, asset, stubFetch([])),
      /does not match the pinned size and SHA-256/,
    );
    await rm(destination);

    const linkTarget = join(cacheDirectory, 'link-target');
    await writeFile(linkTarget, payload);
    await symlink(linkTarget, destination);
    await assert.rejects(
      installAsset(cacheDirectory, asset, stubFetch([])),
      /symbolic link/,
    );
    await rm(destination);

    await mkdir(destination);
    await assert.rejects(
      installAsset(cacheDirectory, asset, stubFetch([])),
      /non-regular/,
    );
  });
});
