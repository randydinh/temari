import { win32 } from 'node:path';

export interface CommandInvocation {
  readonly file: string;
  readonly args: readonly string[];
  readonly windowsVerbatimArguments?: boolean;
}

function quoteWindows(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}

function environmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const key = Object.keys(environment).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
  return key ? environment[key] : undefined;
}

function windowsShell(environment: NodeJS.ProcessEnv): string {
  const comspec = environmentValue(environment, 'ComSpec');
  if (comspec) return comspec;
  const systemRoot = environmentValue(environment, 'SystemRoot');
  if (systemRoot) return win32.join(systemRoot, 'System32', 'cmd.exe');
  return 'cmd.exe';
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
    file: windowsShell(environment),
    args: ['/d', '/s', '/c', `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}
