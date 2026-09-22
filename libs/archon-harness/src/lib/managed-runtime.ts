import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const ARCHON_VERSION = '0.10.1';
const ARCHON_COMMIT_PREFIX = '9820785c';
const RELEASE_BASE =
  'https://github.com/coleam00/Archon/releases/download/v' +
  ARCHON_VERSION +
  '/';

export interface ArchonReleaseAsset {
  readonly version: typeof ARCHON_VERSION;
  readonly commitPrefix: typeof ARCHON_COMMIT_PREFIX;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly platformKey: string;
  readonly assetName: string;
  readonly size: number;
  readonly sha256: string;
  readonly url: string;
}

const RELEASE_ASSETS = [
  {
    version: ARCHON_VERSION,
    commitPrefix: ARCHON_COMMIT_PREFIX,
    platform: 'darwin',
    arch: 'arm64',
    platformKey: 'darwin-arm64',
    assetName: 'archon-darwin-arm64',
    size: 75401632,
    sha256: '61aa2430198c27b2b3fcc97890c8e4b73b0c7cc99e417930ddb4b1f8c59e6933',
    url: RELEASE_BASE + 'archon-darwin-arm64',
  },
  {
    version: ARCHON_VERSION,
    commitPrefix: ARCHON_COMMIT_PREFIX,
    platform: 'darwin',
    arch: 'x64',
    platformKey: 'darwin-x64',
    assetName: 'archon-darwin-x64',
    size: 80349760,
    sha256: 'f4766a8bcb9ab6e688ad6d38b4019cdb84ccce5f6701bfa8e56dfbb9f8ca6cee',
    url: RELEASE_BASE + 'archon-darwin-x64',
  },
  {
    version: ARCHON_VERSION,
    commitPrefix: ARCHON_COMMIT_PREFIX,
    platform: 'linux',
    arch: 'arm64',
    platformKey: 'linux-arm64',
    assetName: 'archon-linux-arm64',
    size: 112969153,
    sha256: '9b8acd643a224385dc511c8d77400e31166e7e5c5579eb0335ed56e3434d4bff',
    url: RELEASE_BASE + 'archon-linux-arm64',
  },
  {
    version: ARCHON_VERSION,
    commitPrefix: ARCHON_COMMIT_PREFIX,
    platform: 'linux',
    arch: 'x64',
    platformKey: 'linux-x64',
    assetName: 'archon-linux-x64',
    size: 113528087,
    sha256: '7aa8b25a4b0017dddb05aead518cbd453ca8db9c54ac4a7611f40164fecd3973',
    url: RELEASE_BASE + 'archon-linux-x64',
  },
  {
    version: ARCHON_VERSION,
    commitPrefix: ARCHON_COMMIT_PREFIX,
    platform: 'win32',
    arch: 'x64',
    platformKey: 'win32-x64',
    assetName: 'archon-windows-x64.exe',
    size: 129650176,
    sha256: '335cee6aedf7ee5e67a23ee5748813d5f161f4f37e207e61ae9c9a52cd36f54b',
    url: RELEASE_BASE + 'archon-windows-x64.exe',
  },
] as const satisfies readonly ArchonReleaseAsset[];

export interface ManagedArchonRuntime {
  readonly version: typeof ARCHON_VERSION;
  readonly commitPrefix: typeof ARCHON_COMMIT_PREFIX;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly platformKey: string;
  readonly assetName: string;
  readonly size: number;
  readonly sha256: string;
  readonly executablePath: string;
}

export interface InstallArchonRuntimeOptions {
  readonly cacheDirectory: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly fetchImpl?: typeof fetch;
}

export class UnsupportedArchonPlatformError extends Error {
  constructor(
    readonly platform: NodeJS.Platform,
    readonly arch: string,
  ) {
    super(
      'Archon v' +
        ARCHON_VERSION +
        ' does not support platform ' +
        platform +
        '/' +
        arch +
        '.',
    );
    this.name = 'UnsupportedArchonPlatformError';
  }
}

export function archonAssetFor(
  platform: NodeJS.Platform,
  arch: string,
): ArchonReleaseAsset {
  const asset = RELEASE_ASSETS.find(
    (candidate) => candidate.platform === platform && candidate.arch === arch,
  );
  if (!asset) {
    throw new UnsupportedArchonPlatformError(platform, arch);
  }
  return asset;
}

function isErrno(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === code
  );
}

function validatePinnedAsset(asset: ArchonReleaseAsset): void {
  const canonical = archonAssetFor(asset.platform, asset.arch);
  if (
    asset.version !== canonical.version ||
    asset.commitPrefix !== canonical.commitPrefix ||
    asset.platformKey !== canonical.platformKey ||
    asset.assetName !== canonical.assetName ||
    asset.url !== canonical.url ||
    asset.size !== canonical.size ||
    asset.sha256.toLowerCase() !== canonical.sha256
  ) {
    throw new Error('Archon asset does not match the pinned v0.10.1 release.');
  }
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0) {
    throw new Error('Archon asset size must be a positive safe integer.');
  }
  if (!/^[a-f0-9]{64}$/i.test(asset.sha256)) {
    throw new Error(
      'Archon asset SHA-256 must contain 64 hexadecimal characters.',
    );
  }
}

function validatedDownloadUrl(
  rawUrl: string,
  asset: ArchonReleaseAsset,
  allowRedirectHost: boolean,
): URL {
  const url = new URL(rawUrl);
  if (
    url.protocol !== 'https:' ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.port.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error('Refusing a non-HTTPS or malformed Archon download URL.');
  }

  const releasePath =
    '/coleam00/Archon/releases/download/v' +
    asset.version +
    '/' +
    asset.assetName;
  if (url.hostname === 'github.com' && url.pathname === releasePath) {
    return url;
  }
  if (
    allowRedirectHost &&
    url.hostname === 'release-assets.githubusercontent.com'
  ) {
    return url;
  }
  throw new Error('Refusing an untrusted Archon download URL: ' + url.origin);
}

async function releaseResponse(
  asset: ArchonReleaseAsset,
  fetchImpl: typeof fetch,
): Promise<Response> {
  let url = validatedDownloadUrl(asset.url, asset, false);
  const visited = new Set<string>();
  let redirects = 0;

  while (true) {
    if (visited.has(url.href)) {
      throw new Error('Archon release download redirect loop detected.');
    }
    visited.add(url.href);

    const response = await fetchImpl(url, { redirect: 'manual' });
    if (response.url) {
      validatedDownloadUrl(response.url, asset, true);
    }
    if (response.status >= 300 && response.status < 400) {
      if (redirects >= 5) {
        throw new Error('Archon release download exceeded five redirects.');
      }
      const location = response.headers.get('location');
      if (!location) {
        throw new Error('Archon release download redirect has no location.');
      }
      url = validatedDownloadUrl(new URL(location, url).href, asset, true);
      redirects += 1;
      continue;
    }
    if (!response.ok) {
      throw new Error(
        'Archon release download failed with HTTP ' + response.status + '.',
      );
    }
    return response;
  }
}

async function writeAll(file: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await file.write(
      chunk,
      offset,
      chunk.byteLength - offset,
      null,
    );
    if (bytesWritten === 0) {
      throw new Error('Could not finish writing the Archon download.');
    }
    offset += bytesWritten;
  }
}

async function writeAndVerify(
  response: Response,
  file: FileHandle,
  asset: ArchonReleaseAsset,
): Promise<void> {
  if (!response.body) {
    throw new Error('Archon release response has no body.');
  }

  const reader = response.body.getReader();
  const digest = createHash('sha256');
  let bytes = 0;
  let reachedEnd = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        reachedEnd = true;
        break;
      }
      bytes += value.byteLength;
      if (bytes > asset.size) {
        throw new Error(
          'Downloaded Archon asset is larger than the pinned size of ' +
            asset.size +
            ' bytes.',
        );
      }
      digest.update(value);
      await writeAll(file, value);
    }
  } finally {
    if (!reachedEnd) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }

  if (bytes !== asset.size) {
    throw new Error(
      'Downloaded Archon asset size mismatch: expected ' +
        asset.size +
        ' bytes, received ' +
        bytes +
        '.',
    );
  }
  const actualSha256 = digest.digest('hex');
  if (actualSha256 !== asset.sha256.toLowerCase()) {
    throw new Error(
      'Downloaded Archon asset SHA-256 mismatch: expected ' +
        asset.sha256 +
        ', received ' +
        actualSha256 +
        '.',
    );
  }
}

async function existingBinaryIsValid(
  destination: string,
  asset: ArchonReleaseAsset,
): Promise<boolean> {
  let pathInfo;
  try {
    pathInfo = await lstat(destination);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      return false;
    }
    throw error;
  }

  if (pathInfo.isSymbolicLink()) {
    throw new Error(
      'Refusing an existing Archon symbolic link: ' + destination,
    );
  }
  if (!pathInfo.isFile()) {
    throw new Error(
      'Refusing a non-regular existing Archon path: ' + destination,
    );
  }
  if (pathInfo.size !== asset.size) {
    throw new Error(
      'Existing Archon binary has an unexpected size: ' + destination,
    );
  }

  const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
  const file = await open(destination, constants.O_RDONLY | noFollow);
  try {
    const fileInfo = await file.stat();
    if (
      !fileInfo.isFile() ||
      (process.platform !== 'win32' &&
        (fileInfo.dev !== pathInfo.dev || fileInfo.ino !== pathInfo.ino))
    ) {
      throw new Error(
        'Existing Archon path changed while it was being checked: ' +
          destination,
      );
    }
    if (fileInfo.size !== asset.size) {
      throw new Error(
        'Existing Archon binary has an unexpected size: ' + destination,
      );
    }

    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytes = 0;
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) {
        break;
      }
      bytes += bytesRead;
      digest.update(buffer.subarray(0, bytesRead));
    }
    if (
      bytes !== asset.size ||
      digest.digest('hex') !== asset.sha256.toLowerCase()
    ) {
      throw new Error(
        'Existing Archon binary does not match the pinned size and SHA-256: ' +
          destination,
      );
    }
    if (process.platform !== 'win32') {
      await file.chmod(0o755);
    }
    return true;
  } finally {
    await file.close();
  }
}

/** Internal generic installer; package consumers must use the pinned wrapper. */
export async function installAsset(
  cacheDirectory: string,
  asset: ArchonReleaseAsset,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0) {
    throw new Error('Archon asset size must be a positive safe integer.');
  }
  if (!/^[a-f0-9]{64}$/i.test(asset.sha256)) {
    throw new Error(
      'Archon asset SHA-256 must contain 64 hexadecimal characters.',
    );
  }

  const directory = join(
    resolve(cacheDirectory),
    'components',
    'archon',
    asset.version,
    asset.platformKey,
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = join(directory, asset.assetName);
  if (await existingBinaryIsValid(destination, asset)) {
    return destination;
  }

  const response = await releaseResponse(asset, fetchImpl);
  const temporary = join(
    directory,
    '.' + asset.assetName + '.' + randomUUID() + '.tmp',
  );
  let file: FileHandle | undefined;
  let temporaryCreated = false;
  try {
    file = await open(temporary, 'wx', 0o600);
    temporaryCreated = true;
    await writeAndVerify(response, file, asset);
    await file.sync();
    if (process.platform !== 'win32') {
      await file.chmod(0o755);
    }
    await file.close();
    file = undefined;

    try {
      await link(temporary, destination);
    } catch (error) {
      if (isErrno(error, 'EEXIST') || isErrno(error, 'EISDIR')) {
        if (await existingBinaryIsValid(destination, asset)) {
          return destination;
        }
      }
      throw error;
    }
    return destination;
  } finally {
    try {
      if (file) {
        await file.close();
      }
    } finally {
      if (temporaryCreated) {
        await unlink(temporary).catch((error: unknown) => {
          if (!isErrno(error, 'ENOENT')) {
            throw error;
          }
        });
      }
    }
  }
}

export async function installPinnedAsset(
  cacheDirectory: string,
  asset: ArchonReleaseAsset,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  validatePinnedAsset(asset);
  return installAsset(cacheDirectory, asset, fetchImpl);
}

export async function installArchonRuntime(
  options: InstallArchonRuntimeOptions,
): Promise<ManagedArchonRuntime> {
  const asset = archonAssetFor(options.platform, options.arch);
  const executablePath = await installPinnedAsset(
    options.cacheDirectory,
    asset,
    options.fetchImpl,
  );
  return {
    version: asset.version,
    commitPrefix: asset.commitPrefix,
    platform: asset.platform,
    arch: asset.arch,
    platformKey: asset.platformKey,
    assetName: asset.assetName,
    size: asset.size,
    sha256: asset.sha256,
    executablePath,
  };
}
