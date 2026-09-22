export interface CommandInvocation {
  readonly file: string;
  readonly args: readonly string[];
  readonly windowsVerbatimArguments?: boolean;
}

function quoteWindows(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}

/** Build cmd.exe's /s /c form while preserving the wrapper and argument quotes. */
export function commandInvocation(
  file: string,
  args: readonly string[],
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): CommandInvocation {
  if (platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(file)) {
    return { file, args };
  }
  const commandLine = [file, ...args].map(quoteWindows).join(' ');
  return {
    file: environment.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}
