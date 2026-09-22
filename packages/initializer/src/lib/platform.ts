import { homedir } from 'node:os';
import { delimiter, join, win32 } from 'node:path';

export interface PlatformInfo {
  readonly platform: NodeJS.Platform;
  readonly arch: NodeJS.Architecture;
  readonly key: string;
  readonly homeDirectory: string;
  readonly dataDirectory: string;
  readonly cacheDirectory: string;
}

export interface PlatformInputs {
  readonly platform?: NodeJS.Platform;
  readonly arch?: NodeJS.Architecture;
  readonly homeDirectory?: string;
  readonly environment?: NodeJS.ProcessEnv;
}

export function platformKey(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string {
  return `${platform}-${arch}`;
}

export function platformInfo(inputs: PlatformInputs = {}): PlatformInfo {
  const platform = inputs.platform ?? process.platform;
  const arch = inputs.arch ?? process.arch;
  const homeDirectory = inputs.homeDirectory ?? homedir();
  const environment = inputs.environment ?? process.env;
  const joinPath = platform === 'win32' ? win32.join : join;

  if (platform === 'win32') {
    const localAppData =
      environment.LOCALAPPDATA ??
      joinPath(environment.USERPROFILE ?? homeDirectory, 'AppData', 'Local');
    return {
      platform,
      arch,
      key: platformKey(platform, arch),
      homeDirectory,
      dataDirectory: joinPath(localAppData, 'Temari'),
      cacheDirectory: joinPath(localAppData, 'Temari', 'cache'),
    };
  }

  if (platform === 'darwin') {
    return {
      platform,
      arch,
      key: platformKey(platform, arch),
      homeDirectory,
      dataDirectory: joinPath(
        homeDirectory,
        'Library',
        'Application Support',
        'Temari',
      ),
      cacheDirectory: joinPath(homeDirectory, 'Library', 'Caches', 'Temari'),
    };
  }

  const dataRoot =
    environment.XDG_DATA_HOME ?? joinPath(homeDirectory, '.local', 'share');
  const cacheRoot =
    environment.XDG_CACHE_HOME ?? joinPath(homeDirectory, '.cache');
  return {
    platform,
    arch,
    key: platformKey(platform, arch),
    homeDirectory,
    dataDirectory: joinPath(dataRoot, 'Temari'),
    cacheDirectory: joinPath(cacheRoot, 'Temari'),
  };
}

export function pathDelimiter(
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === 'win32' ? win32.delimiter : delimiter;
}
