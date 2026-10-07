import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const BUN_VERSION = '1.4.2';
const RELEASE_BASE = `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/`;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_MEMBER_BYTES = 120 * 1024 * 1024;

export interface BunReleaseAsset {
  readonly version: typeof BUN_VERSION;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly archive: string;
  readonly member: string;
  readonly sha256: string;
  readonly url: string;
}

const RELEASE_ASSETS: readonly BunReleaseAsset[] = [
  asset(
    'darwin',
    'arm64',
    'bun-darwin-aarch64.zip',
    'bun-darwin-aarch64/bun',
    '90987a3a16d7db556d886ac3d551e7b6d3edf0a1cf43acaed622e8676be1d12f',
  ),
  asset(
    'darwin',
    'x64',
    'bun-darwin-x64.zip',
    'bun-darwin-x64/bun',
    '80520d7e17526308c9185d261679ac6d27798d3803a0e9f7ff9121ab8affb012',
  ),
  asset(
    'linux',
    'arm64',
    'bun-linux-aarch64.zip',
    'bun-linux-aarch64/bun',
    '54328bbc2d9c8e0c9f892c544d66c57a83b84139e34909e5ee81758f1ac8fda7',
  ),
  asset(
    'linux',
    'x64',
    'bun-linux-x64.zip',
    'bun-linux-x64/bun',
    '36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913',
  ),
  asset(
    'win32',
    'x64',
    'bun-windows-x64.zip',
    'bun-windows-x64/bun.exe',
    'ce4c17497b2f29712a99d3d53f028de28cd42e3bacb8589599e7f000e49b6405',
  ),
];

export interface BunInstallOptions {
  readonly cacheDirectory: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly minimumMajor: number;
  readonly fetchImpl?: typeof fetch;
}

function asset(
  platform: NodeJS.Platform,
  arch: string,
  archive: string,
  member: string,
  sha256: string,
): BunReleaseAsset {
  return {
    version: BUN_VERSION,
    platform,
    arch,
    archive,
    member,
    sha256,
    url: RELEASE_BASE + archive,
  };
}

export function bunAssetFor(
  platform: NodeJS.Platform,
  arch: string,
): BunReleaseAsset {
  const match = RELEASE_ASSETS.find(
    (item) => item.platform === platform && item.arch === arch,
  );
  if (!match) {
    throw new Error(`Temari cannot bootstrap Bun on ${platform}-${arch}.`);
  }
  return match;
}

export function managedBunExecutable(
  cacheDirectory: string,
  platform: NodeJS.Platform,
  arch: string,
): string {
  const name = platform === 'win32' ? 'bun.exe' : 'bun';
  return join(
    cacheDirectory,
    'tools',
    'bun',
    BUN_VERSION,
    `${platform}-${arch}`,
    name,
  );
}

export async function installManagedBun(
  options: BunInstallOptions,
): Promise<string> {
  const release = bunAssetFor(options.platform, options.arch);
  const destination = managedBunExecutable(
    options.cacheDirectory,
    options.platform,
    options.arch,
  );
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  if (
    await bunMeetsMinimum(destination, options.minimumMajor, options.platform)
  ) {
    return destination;
  }

  const archive = await downloadArchive(release, options.fetchImpl ?? fetch);
  const binary = extractZipMember(archive, release.member);
  const temporary = join(dirname(destination), `.bun.${randomUUID()}.tmp`);
  await writeFile(temporary, binary, { mode: 0o700 });
  if (options.platform !== 'win32') await chmod(temporary, 0o755);
  try {
    if (
      !(await bunMeetsMinimum(
        temporary,
        options.minimumMajor,
        options.platform,
      ))
    ) {
      throw new Error(
        `Bootstrapped Bun does not meet major version ${options.minimumMajor}.`,
      );
    }
    await rm(destination, { force: true });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return destination;
}

export function extractZipMember(zip: Buffer, member: string): Buffer {
  if (
    member.length === 0 ||
    member.startsWith('/') ||
    member.includes('\\') ||
    member.split('/').includes('..')
  ) {
    throw new Error('Bun archive member path is invalid.');
  }
  const eocd = locateEndOfCentralDirectory(zip);
  const entryCount = zip.readUInt16LE(eocd + 10);
  const directoryOffset = zip.readUInt32LE(eocd + 16);
  if (directoryOffset === 0xffffffff) {
    throw new Error('Bun archive uses ZIP64, which is not supported.');
  }
  let offset = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > zip.length || zip.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('Bun archive directory is invalid.');
    }
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const uncompressedSize = zip.readUInt32LE(offset + 24);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (name === member) {
      return inflateMember(
        zip,
        localOffset,
        method,
        compressedSize,
        uncompressedSize,
      );
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`Bun archive is missing ${member}.`);
}

function locateEndOfCentralDirectory(zip: Buffer): number {
  const minimum = Math.max(0, zip.length - 22 - 0xffff);
  for (let offset = zip.length - 22; offset >= minimum; offset -= 1) {
    if (zip.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error('Bun archive is missing the ZIP directory.');
}

function inflateMember(
  zip: Buffer,
  localOffset: number,
  method: number,
  compressedSize: number,
  uncompressedSize: number,
): Buffer {
  if (
    compressedSize === 0xffffffff ||
    uncompressedSize === 0xffffffff ||
    localOffset === 0xffffffff
  ) {
    throw new Error('Bun archive uses ZIP64, which is not supported.');
  }
  if (uncompressedSize <= 0 || uncompressedSize > MAX_MEMBER_BYTES) {
    throw new Error('Bun archive member has an unexpected size.');
  }
  if (
    localOffset + 30 > zip.length ||
    zip.readUInt32LE(localOffset) !== 0x04034b50
  ) {
    throw new Error('Bun archive member header is invalid.');
  }
  const nameLength = zip.readUInt16LE(localOffset + 26);
  const extraLength = zip.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + nameLength + extraLength;
  const compressed = zip.subarray(dataStart, dataStart + compressedSize);
  if (compressed.length !== compressedSize) {
    throw new Error('Bun archive member is truncated.');
  }
  if (method === 0) {
    if (compressed.length !== uncompressedSize) {
      throw new Error('Bun archive member size does not match its directory.');
    }
    return Buffer.from(compressed);
  }
  if (method !== 8) {
    throw new Error(`Bun archive compression method ${method} is unsupported.`);
  }
  const data = inflateRawSync(compressed);
  if (data.length !== uncompressedSize) {
    throw new Error('Bun archive member size does not match its directory.');
  }
  return data;
}

async function downloadArchive(
  release: BunReleaseAsset,
  fetchImpl: typeof fetch,
): Promise<Buffer> {
  const response = await fetchImpl(release.url);
  if (!response.ok) {
    throw new Error(
      `Bun download failed with HTTP ${response.status} for ${release.archive}.`,
    );
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_ARCHIVE_BYTES) {
    throw new Error('Bun download has an unexpected size.');
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== release.sha256) {
    throw new Error('Bun download SHA-256 does not match the pinned release.');
  }
  return bytes;
}

async function bunMeetsMinimum(
  file: string,
  minimumMajor: number,
  platform: NodeJS.Platform,
): Promise<boolean> {
  try {
    await access(file, platform === 'win32' ? constants.F_OK : constants.X_OK);
  } catch {
    return false;
  }
  const output = await commandOutput(file, ['--version']);
  const match = output.match(/(?:^|\s)v?(\d+)/);
  return match !== null && Number(match[1]) >= minimumMajor;
}

function commandOutput(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], {
      shell: false,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', reject);
    child.once('close', (exitCode) => {
      if (exitCode !== 0) {
        reject(
          new Error(`Bun version check failed (exit code ${exitCode ?? 1}).`),
        );
        return;
      }
      resolve(`${stdout}\n${stderr}`);
    });
  });
}
