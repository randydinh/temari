import { createHash } from 'node:crypto';
import {
  access,
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  archonAssetFor,
  installArchonRuntime,
  UnsupportedArchonPlatformError,
  type ManagedArchonRuntime,
} from '@temari/archon-harness';

import {
  pathDelimiter,
  platformInfo,
  platformKey,
  type PlatformInfo,
} from './platform.js';
import { commandInvocation } from './command.js';

const DEFAULT_MANIFEST_PATH = fileURLToPath(
  new URL('../../dependency-manifest.json', import.meta.url),
);
const MAX_CAPTURED_OUTPUT_BYTES = 64 * 1024;

export interface ToolRequirement {
  readonly command: string;
  readonly required: boolean;
  readonly minimumMajor?: number;
  readonly supportedPlatforms?: readonly string[];
}

export interface InstallationSpec {
  readonly id: string;
  readonly manager: string;
  readonly workingDirectory: string;
  readonly sourceDirectory?: string;
  readonly lockfile: string;
  readonly args: readonly string[];
  readonly cache?: boolean;
  readonly required: boolean;
}

export interface DependencyManifest {
  readonly schema: 1;
  readonly version: string;
  readonly tools: Readonly<Record<string, ToolRequirement>>;
  readonly installations: readonly InstallationSpec[];
}

export interface CommandResult {
  readonly exitCode: number;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandRunner {
  run(
    file: string,
    args: readonly string[],
    cwd: string,
  ): Promise<CommandResult>;
}

export interface ToolCheck {
  readonly name: string;
  readonly command: string;
  readonly path: string | null;
  readonly version: string | null;
  readonly major: number | null;
  readonly required: boolean;
  readonly supported: boolean;
  readonly ok: boolean;
  readonly reason: string;
}

export interface DoctorReport {
  readonly schema: 1;
  readonly ok: boolean;
  readonly workspaceRoot: string;
  readonly platform: PlatformInfo;
  readonly manifestVersion: string;
  readonly tools: readonly ToolCheck[];
  readonly lockfiles: readonly LockfileCheck[];
  readonly archon: ArchonRuntimeCheck;
}

export interface ArchonRuntimeCheck {
  readonly status: 'READY' | 'MISSING' | 'UNSUPPORTED' | 'INVALID';
  readonly platformKey: string;
  readonly version: string | null;
  readonly executable: string | null;
  readonly sha256: string | null;
  readonly sourceUrl: string | null;
  readonly reason: string;
}

export interface LockfileCheck {
  readonly installationId: string;
  readonly path: string;
  readonly exists: boolean;
  readonly ok: boolean;
  readonly reason: string;
}

export interface InitializationStep {
  readonly installationId: string;
  readonly manager: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly status: 'SUCCEEDED' | 'FAILED' | 'SKIPPED';
  readonly exitCode: number | null;
  readonly stdoutSha256: string | null;
  readonly stderrSha256: string | null;
  readonly reason: string | null;
}

export interface InstallationReceipt {
  readonly schema: 1;
  readonly status: 'SUCCEEDED' | 'FAILED';
  readonly initializedAt: string;
  readonly workspaceRoot: string;
  readonly manifestVersion: string;
  readonly platform: PlatformInfo;
  readonly tools: readonly ToolCheck[];
  readonly steps: readonly InitializationStep[];
  readonly archon: {
    readonly status: 'INSTALLED' | 'UNSUPPORTED' | 'FAILED' | 'SKIPPED';
    readonly version: string | null;
    readonly commit: string | null;
    readonly platformKey: string;
    readonly executable: string | null;
    readonly asset: string | null;
    readonly sourceUrl: string | null;
    readonly sha256: string | null;
    readonly reason: string | null;
  };
}

export interface InitializeOptions {
  readonly workspaceRoot?: string;
  readonly manifestPath?: string;
  readonly platform?: PlatformInfo;
  readonly runner?: CommandRunner;
  readonly environment?: NodeJS.ProcessEnv;
  readonly dataDirectory?: string;
  readonly archonInstaller?: (options: {
    readonly cacheDirectory: string;
    readonly platform: NodeJS.Platform;
    readonly arch: string;
  }) => Promise<ManagedArchonRuntime>;
}

export interface DoctorOptions {
  readonly workspaceRoot?: string;
  readonly manifestPath?: string;
  readonly platform?: PlatformInfo;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface InitializationResult {
  readonly receipt: InstallationReceipt;
  readonly receiptPath: string;
  readonly doctor: DoctorReport;
}

interface FileLikeError extends Error {
  readonly code?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean')
    throw new Error(`${label} must be a boolean.`);
  return value;
}

function validateManifest(value: unknown): DependencyManifest {
  if (!isRecord(value) || value.schema !== 1) {
    throw new Error('Dependency manifest must use schema 1.');
  }
  if (!isRecord(value.tools))
    throw new Error('Dependency manifest tools are missing.');
  if (!Array.isArray(value.installations)) {
    throw new Error('Dependency manifest installations are missing.');
  }

  const tools: Record<string, ToolRequirement> = {};
  for (const [name, rawTool] of Object.entries(value.tools)) {
    if (!isRecord(rawTool)) throw new Error(`Tool ${name} is invalid.`);
    const supportedPlatforms = rawTool.supportedPlatforms;
    if (
      supportedPlatforms !== undefined &&
      (!Array.isArray(supportedPlatforms) ||
        supportedPlatforms.some((item) => typeof item !== 'string'))
    ) {
      throw new Error(`Tool ${name} supportedPlatforms is invalid.`);
    }
    const minimumMajor = rawTool.minimumMajor;
    if (
      minimumMajor !== undefined &&
      (typeof minimumMajor !== 'number' ||
        !Number.isInteger(minimumMajor) ||
        minimumMajor < 0)
    ) {
      throw new Error(`Tool ${name} minimumMajor is invalid.`);
    }
    const parsedMinimumMajor =
      typeof minimumMajor === 'number' ? minimumMajor : undefined;
    const parsedSupportedPlatforms =
      supportedPlatforms === undefined
        ? undefined
        : supportedPlatforms.filter(
            (item): item is string => typeof item === 'string',
          );
    tools[name] = {
      command: requireString(rawTool.command, `Tool ${name} command`),
      required: requireBoolean(rawTool.required, `Tool ${name} required`),
      ...(parsedMinimumMajor === undefined
        ? {}
        : { minimumMajor: parsedMinimumMajor }),
      ...(parsedSupportedPlatforms === undefined
        ? {}
        : { supportedPlatforms: parsedSupportedPlatforms }),
    };
  }

  const installations = value.installations.map((rawInstallation, index) => {
    if (!isRecord(rawInstallation))
      throw new Error(`Installation ${index} is invalid.`);
    if (
      !Array.isArray(rawInstallation.args) ||
      rawInstallation.args.some((arg) => typeof arg !== 'string')
    ) {
      throw new Error(`Installation ${index} args are invalid.`);
    }
    return {
      id: requireString(rawInstallation.id, `Installation ${index} id`),
      manager: requireString(
        rawInstallation.manager,
        `Installation ${index} manager`,
      ),
      workingDirectory: requireString(
        rawInstallation.workingDirectory,
        `Installation ${index} workingDirectory`,
      ),
      ...(rawInstallation.sourceDirectory === undefined
        ? {}
        : {
            sourceDirectory: requireString(
              rawInstallation.sourceDirectory,
              `Installation ${index} sourceDirectory`,
            ),
          }),
      lockfile: requireString(
        rawInstallation.lockfile,
        `Installation ${index} lockfile`,
      ),
      args: rawInstallation.args,
      ...(rawInstallation.cache === undefined
        ? {}
        : {
            cache: requireBoolean(
              rawInstallation.cache,
              `Installation ${index} cache`,
            ),
          }),
      required: requireBoolean(
        rawInstallation.required,
        `Installation ${index} required`,
      ),
    } satisfies InstallationSpec;
  });

  return {
    schema: 1,
    version: requireString(value.version, 'Dependency manifest version'),
    tools,
    installations,
  };
}

export async function loadManifest(
  manifestPath = DEFAULT_MANIFEST_PATH,
): Promise<DependencyManifest> {
  return validateManifest(
    JSON.parse(await readFile(manifestPath, 'utf8')) as unknown,
  );
}

export function parseVersion(
  output: string,
): { readonly version: string; readonly major: number } | null {
  const match = output.match(/(?:^|\s)v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return null;
  const version = [match[1], match[2] ?? '0', match[3] ?? '0'].join('.');
  return { version, major: Number(match[1]) };
}

function executableNames(
  command: string,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): string[] {
  if (platform !== 'win32') return [command];
  if (/\.(?:exe|cmd|bat)$/i.test(command)) return [command];
  const extensions = (environment.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter((extension) => extension.length > 0);
  return [
    command,
    ...extensions.map((extension) => `${command}${extension.toLowerCase()}`),
  ];
}

export async function findExecutable(
  command: string,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  if (isAbsolute(command)) {
    try {
      await access(command, constants.F_OK);
      return command;
    } catch {
      return null;
    }
  }

  const pathValue = environment.PATH ?? '';
  for (const directory of pathValue.split(pathDelimiter(platform))) {
    if (directory.length === 0) continue;
    for (const name of executableNames(command, platform, environment)) {
      const candidate = join(directory, name);
      try {
        await access(
          candidate,
          platform === 'win32' ? constants.F_OK : constants.X_OK,
        );
        return candidate;
      } catch {
        // Continue searching PATH.
      }
    }
  }
  return null;
}

function workspacePath(
  workspaceRoot: string,
  child: string,
  label: string,
): string {
  if (isAbsolute(child))
    throw new Error(`${label} must be relative to the workspace.`);
  const candidate = resolve(workspaceRoot, child);
  const remainder = relative(workspaceRoot, candidate);
  if (
    remainder === '..' ||
    remainder.startsWith(`..${sep}`) ||
    isAbsolute(remainder)
  ) {
    throw new Error(`${label} must remain inside the workspace.`);
  }
  return candidate;
}

export function createCommandRunner(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): CommandRunner {
  return {
    run(file, args, cwd) {
      const invocation = commandInvocation(file, args, platform, environment);
      return new Promise((resolveResult, reject) => {
        const child = spawn(invocation.file, [...invocation.args], {
          cwd,
          env: environment,
          shell: false,
          windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        const capture = (current: string, chunk: Buffer): string => {
          if (current.length >= MAX_CAPTURED_OUTPUT_BYTES) return current;
          return `${current}${chunk.toString('utf8')}`.slice(
            0,
            MAX_CAPTURED_OUTPUT_BYTES,
          );
        };
        child.stdout?.on('data', (chunk: Buffer) => {
          stdout = capture(stdout, chunk);
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr = capture(stderr, chunk);
        });
        child.once('error', reject);
        child.once('close', (exitCode, signal) => {
          resolveResult({
            exitCode: exitCode ?? 1,
            signal,
            stdout,
            stderr,
          });
        });
      });
    },
  };
}

function toolReason(
  requirement: ToolRequirement,
  platform: PlatformInfo,
  path: string | null,
  version: string | null,
  major: number | null,
  commandResult: CommandResult | null,
): string {
  if (
    requirement.supportedPlatforms &&
    !requirement.supportedPlatforms.includes(platform.key)
  ) {
    return `not supported on ${platform.key}`;
  }
  if (!path) return 'executable not found on PATH';
  if (!commandResult || commandResult.exitCode !== 0)
    return 'version check failed';
  if (!version || major === null) return 'version could not be parsed';
  if (
    requirement.minimumMajor !== undefined &&
    major < requirement.minimumMajor
  ) {
    return `requires major version ${requirement.minimumMajor} or newer`;
  }
  return 'available';
}

export async function inspectTools(
  manifest: DependencyManifest,
  platform: PlatformInfo = platformInfo(),
  environment: NodeJS.ProcessEnv = process.env,
  runner: CommandRunner = createCommandRunner(platform.platform, environment),
): Promise<readonly ToolCheck[]> {
  const checks: ToolCheck[] = [];
  for (const [name, requirement] of Object.entries(manifest.tools)) {
    if (
      requirement.supportedPlatforms &&
      !requirement.supportedPlatforms.includes(platform.key)
    ) {
      checks.push({
        name,
        command: requirement.command,
        path: null,
        version: null,
        major: null,
        required: requirement.required,
        supported: false,
        ok: !requirement.required,
        reason: `not supported on ${platform.key}`,
      });
      continue;
    }

    const path = await findExecutable(
      requirement.command,
      platform.platform,
      environment,
    );
    if (!path) {
      checks.push({
        name,
        command: requirement.command,
        path: null,
        version: null,
        major: null,
        required: requirement.required,
        supported: true,
        ok: !requirement.required,
        reason: 'executable not found on PATH',
      });
      continue;
    }

    let commandResult: CommandResult | null = null;
    try {
      commandResult = await runner.run(path, ['--version'], process.cwd());
    } catch {
      commandResult = null;
    }
    const parsed = parseVersion(
      `${commandResult?.stdout ?? ''}\n${commandResult?.stderr ?? ''}`,
    );
    const reason = toolReason(
      requirement,
      platform,
      path,
      parsed?.version ?? null,
      parsed?.major ?? null,
      commandResult,
    );
    checks.push({
      name,
      command: requirement.command,
      path,
      version: parsed?.version ?? null,
      major: parsed?.major ?? null,
      required: requirement.required,
      supported: true,
      ok: reason === 'available',
      reason,
    });
  }
  return checks;
}

async function inspectLockfiles(
  manifest: DependencyManifest,
  workspaceRoot: string,
): Promise<readonly LockfileCheck[]> {
  const lockfiles: LockfileCheck[] = [];
  for (const installation of manifest.installations) {
    const lockfilePath = workspacePath(
      workspaceRoot,
      installation.lockfile,
      'Lockfile',
    );
    try {
      await stat(lockfilePath);
      lockfiles.push({
        installationId: installation.id,
        path: lockfilePath,
        exists: true,
        ok: true,
        reason: 'present',
      });
    } catch (error) {
      const code = (error as FileLikeError).code ?? 'unknown';
      lockfiles.push({
        installationId: installation.id,
        path: lockfilePath,
        exists: false,
        ok: false,
        reason: `missing (${code})`,
      });
    }
  }
  return lockfiles;
}

async function prepareWorkingDirectory(
  installation: InstallationSpec,
  manifest: DependencyManifest,
  workspaceRoot: string,
  platform: PlatformInfo,
): Promise<string> {
  if (!installation.cache) {
    return workspacePath(
      workspaceRoot,
      installation.workingDirectory,
      'Working directory',
    );
  }
  if (!installation.sourceDirectory) {
    throw new Error(
      `Installation ${installation.id} enables cache staging without a sourceDirectory.`,
    );
  }
  const source = workspacePath(
    workspaceRoot,
    installation.sourceDirectory,
    'Source directory',
  );
  const target = join(
    platform.cacheDirectory,
    'installations',
    manifest.version,
    installation.id,
  );
  await stat(source);
  await mkdir(target, { recursive: true, mode: 0o700 });
  await cp(source, target, {
    recursive: true,
    force: true,
    filter: (entry) =>
      !entry.endsWith(`${sep}node_modules`) &&
      !entry.includes(`${sep}node_modules${sep}`),
  });
  return target;
}

export async function doctor(
  options: DoctorOptions = {},
): Promise<DoctorReport> {
  const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
  const platform =
    options.platform ?? platformInfo({ environment: options.environment });
  const manifest = await loadManifest(options.manifestPath);
  const environment = options.environment ?? process.env;
  const runner = createCommandRunner(platform.platform, environment);
  const tools = await inspectTools(manifest, platform, environment, runner);
  const lockfiles = await inspectLockfiles(manifest, workspaceRoot);
  const archon = await inspectArchonRuntime(platform, runner);
  return {
    schema: 1,
    ok:
      tools.every((tool) => !tool.required || tool.ok) &&
      lockfiles.every((lockfile) => lockfile.ok) &&
      (archon.status === 'READY' || archon.status === 'UNSUPPORTED'),
    workspaceRoot,
    platform,
    manifestVersion: manifest.version,
    tools,
    lockfiles,
    archon,
  };
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function joinPlatformPath(
  platform: NodeJS.Platform,
  ...parts: string[]
): string {
  return platform === 'win32' ? win32.join(...parts) : join(...parts);
}

async function hashFile(
  path: string,
  platform: NodeJS.Platform,
): Promise<string> {
  const noFollow = platform === 'win32' ? 0 : constants.O_NOFOLLOW;
  const file = await open(path, constants.O_RDONLY | noFollow);
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest('hex');
  } finally {
    await file.close();
  }
}

async function inspectArchonRuntime(
  platform: PlatformInfo,
  runner: CommandRunner,
): Promise<ArchonRuntimeCheck> {
  try {
    const asset = archonAssetFor(platform.platform, platform.arch);
    const executable = joinPlatformPath(
      platform.platform,
      platform.cacheDirectory,
      'components',
      'archon',
      asset.version,
      asset.platformKey,
      asset.assetName,
    );
    let info;
    try {
      info = await lstat(executable);
    } catch (error) {
      if ((error as FileLikeError).code === 'ENOENT') {
        return {
          status: 'MISSING',
          platformKey: platform.key,
          version: asset.version,
          executable,
          sha256: null,
          sourceUrl: asset.url,
          reason: 'managed Archon runtime is not installed',
        };
      }
      throw error;
    }
    if (info.isSymbolicLink() || !info.isFile() || info.size !== asset.size) {
      return {
        status: 'INVALID',
        platformKey: platform.key,
        version: asset.version,
        executable,
        sha256: null,
        sourceUrl: asset.url,
        reason:
          'managed Archon path is not a regular file with the pinned size',
      };
    }
    const observedSha256 = await hashFile(executable, platform.platform);
    if (observedSha256 !== asset.sha256) {
      return {
        status: 'INVALID',
        platformKey: platform.key,
        version: asset.version,
        executable,
        sha256: observedSha256,
        sourceUrl: asset.url,
        reason: 'managed Archon SHA-256 does not match the pinned release',
      };
    }
    const result = await runner.run(executable, ['version'], process.cwd());
    const output = `${result.stdout}\n${result.stderr}`;
    if (
      result.exitCode !== 0 ||
      !new RegExp(
        `^Archon CLI v${asset.version.replaceAll('.', '\\.')}$`,
        'm',
      ).test(output) ||
      !new RegExp(`^  Git commit: ${asset.commitPrefix}$`, 'm').test(output)
    ) {
      return {
        status: 'INVALID',
        platformKey: platform.key,
        version: asset.version,
        executable,
        sha256: observedSha256,
        sourceUrl: asset.url,
        reason: 'managed Archon version or commit does not match the pin',
      };
    }
    return {
      status: 'READY',
      platformKey: platform.key,
      version: asset.version,
      executable,
      sha256: observedSha256,
      sourceUrl: asset.url,
      reason: 'managed Archon runtime matches the pinned release',
    };
  } catch (error) {
    if (error instanceof UnsupportedArchonPlatformError) {
      return {
        status: 'UNSUPPORTED',
        platformKey: platform.key,
        version: null,
        executable: null,
        sha256: null,
        sourceUrl: null,
        reason: error.message,
      };
    }
    return {
      status: 'INVALID',
      platformKey: platform.key,
      version: null,
      executable: null,
      sha256: null,
      sourceUrl: null,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function toolByName(
  tools: readonly ToolCheck[],
  name: string,
): ToolCheck | undefined {
  return tools.find((tool) => tool.name === name);
}

async function writeReceipt(
  path: string,
  receipt: InstallationReceipt,
): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

export async function initialize(
  options: InitializeOptions = {},
): Promise<InitializationResult> {
  const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
  const platform =
    options.platform ?? platformInfo({ environment: options.environment });
  const manifest = await loadManifest(options.manifestPath);
  const environment = options.environment ?? process.env;
  const runner =
    options.runner ?? createCommandRunner(platform.platform, environment);
  const tools = await inspectTools(manifest, platform, environment, runner);
  const lockfiles = await inspectLockfiles(manifest, workspaceRoot);
  const steps: InitializationStep[] = [];

  const missingRequiredTool = tools.find((tool) => tool.required && !tool.ok);
  if (missingRequiredTool) {
    for (const installation of manifest.installations) {
      steps.push({
        installationId: installation.id,
        manager: installation.manager,
        command:
          manifest.tools[installation.manager]?.command ?? installation.manager,
        args: installation.args,
        cwd: resolve(workspaceRoot, installation.workingDirectory),
        status: 'SKIPPED',
        exitCode: null,
        stdoutSha256: null,
        stderrSha256: null,
        reason: `required tool ${missingRequiredTool.name} ${missingRequiredTool.reason}`,
      });
    }
  } else {
    for (const installation of manifest.installations) {
      const lockfile = lockfiles.find(
        (item) => item.installationId === installation.id,
      );
      const tool = toolByName(tools, installation.manager);
      let cwd = workspacePath(
        workspaceRoot,
        installation.workingDirectory,
        'Working directory',
      );
      const command =
        manifest.tools[installation.manager]?.command ?? installation.manager;

      if (!lockfile?.ok) {
        steps.push({
          installationId: installation.id,
          manager: installation.manager,
          command,
          args: installation.args,
          cwd,
          status: 'FAILED',
          exitCode: null,
          stdoutSha256: null,
          stderrSha256: null,
          reason: lockfile?.reason ?? 'lockfile was not declared',
        });
        if (installation.required) break;
        continue;
      }

      try {
        cwd = await prepareWorkingDirectory(
          installation,
          manifest,
          workspaceRoot,
          platform,
        );
      } catch (error) {
        steps.push({
          installationId: installation.id,
          manager: installation.manager,
          command,
          args: installation.args,
          cwd,
          status: 'FAILED',
          exitCode: null,
          stdoutSha256: null,
          stderrSha256: null,
          reason: error instanceof Error ? error.message : String(error),
        });
        if (installation.required) break;
        continue;
      }

      if (!tool?.ok || !tool.path) {
        steps.push({
          installationId: installation.id,
          manager: installation.manager,
          command,
          args: installation.args,
          cwd,
          status: 'FAILED',
          exitCode: null,
          stdoutSha256: null,
          stderrSha256: null,
          reason: tool?.reason ?? `tool ${installation.manager} is unavailable`,
        });
        if (installation.required) break;
        continue;
      }

      const result = await runner.run(tool.path, installation.args, cwd);
      const succeeded = result.exitCode === 0;
      steps.push({
        installationId: installation.id,
        manager: installation.manager,
        command,
        args: installation.args,
        cwd,
        status: succeeded ? 'SUCCEEDED' : 'FAILED',
        exitCode: result.exitCode,
        stdoutSha256: digest(result.stdout),
        stderrSha256: digest(result.stderr),
        reason: succeeded ? null : `command exited with ${result.exitCode}`,
      });
      if (!succeeded && installation.required) break;
    }
  }

  const failed = steps.some((step) => step.status === 'FAILED');
  let archon: InstallationReceipt['archon'] = {
    status: 'SKIPPED',
    version: null,
    commit: null,
    platformKey: platform.key,
    executable: null,
    asset: null,
    sourceUrl: null,
    sha256: null,
    reason: missingRequiredTool
      ? `required tool ${missingRequiredTool.name} is unavailable`
      : failed
        ? 'a required package installation failed'
        : 'not attempted',
  };

  if (!missingRequiredTool && !failed) {
    try {
      const asset = archonAssetFor(platform.platform, platform.arch);
      const runtime = await (options.archonInstaller ?? installArchonRuntime)({
        cacheDirectory: platform.cacheDirectory,
        platform: platform.platform,
        arch: platform.arch,
      });
      const versionResult = await runner.run(
        runtime.executablePath,
        ['version'],
        workspaceRoot,
      );
      const output = `${versionResult.stdout}\n${versionResult.stderr}`;
      const compatible =
        versionResult.exitCode === 0 &&
        new RegExp(
          `^Archon CLI v${asset.version.replaceAll('.', '\\.')}$`,
          'm',
        ).test(output) &&
        new RegExp(`^  Git commit: ${asset.commitPrefix}$`, 'm').test(output);
      if (!compatible) {
        throw new Error(
          'Downloaded Archon version or commit does not match the release pin.',
        );
      }
      archon = {
        status: 'INSTALLED',
        version: runtime.version,
        commit: runtime.commitPrefix,
        platformKey: runtime.platformKey,
        executable: runtime.executablePath,
        asset: runtime.assetName,
        sourceUrl: asset.url,
        sha256: runtime.sha256,
        reason: 'pinned runtime hash and version verified',
      };
    } catch (error) {
      if (error instanceof UnsupportedArchonPlatformError) {
        archon = {
          ...archon,
          status: 'UNSUPPORTED',
          reason: error.message,
        };
      } else {
        archon = {
          ...archon,
          status: 'FAILED',
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }
  }

  const receipt: InstallationReceipt = {
    schema: 1,
    status:
      failed || missingRequiredTool !== undefined || archon.status === 'FAILED'
        ? 'FAILED'
        : 'SUCCEEDED',
    initializedAt: new Date().toISOString(),
    workspaceRoot,
    manifestVersion: manifest.version,
    platform,
    tools,
    steps,
    archon,
  };
  const dataDirectory = options.dataDirectory ?? platform.dataDirectory;
  const receiptPath = join(dataDirectory, 'state', 'install-receipt.json');
  await writeReceipt(receiptPath, receipt);
  const archonCheck = await inspectArchonRuntime(platform, runner);
  const report: DoctorReport = {
    schema: 1,
    ok:
      receipt.status === 'SUCCEEDED' &&
      (archonCheck.status === 'READY' || archonCheck.status === 'UNSUPPORTED'),
    workspaceRoot,
    platform,
    manifestVersion: manifest.version,
    tools,
    lockfiles,
    archon: archonCheck,
  };
  return { receipt, receiptPath, doctor: report };
}

export function formatReport(report: DoctorReport): string {
  const lines = [
    `Temari doctor: ${report.ok ? 'PASS' : 'FAIL'}`,
    `workspace=${report.workspaceRoot}`,
    `platform=${platformKey(report.platform.platform, report.platform.arch)}`,
  ];
  for (const tool of report.tools) {
    lines.push(
      `tool.${tool.name}=${tool.ok ? 'ok' : tool.required ? 'fail' : 'optional'}${
        tool.version ? ` version=${tool.version}` : ''
      } reason=${tool.reason}`,
    );
  }
  for (const lockfile of report.lockfiles) {
    lines.push(
      `lockfile.${lockfile.installationId}=${lockfile.ok ? 'present' : 'missing'}`,
    );
  }
  lines.push(
    `archon=${report.archon.status.toLowerCase()}${report.archon.version ? ` version=${report.archon.version}` : ''} reason=${report.archon.reason}`,
  );
  return `${lines.join('\n')}\n`;
}

export function formatInitialization(result: InitializationResult): string {
  const lines = [
    `Temari init: ${result.receipt.status === 'SUCCEEDED' ? 'PASS' : 'FAIL'}`,
    `receipt=${result.receiptPath}`,
  ];
  for (const step of result.receipt.steps) {
    lines.push(`install.${step.installationId}=${step.status.toLowerCase()}`);
  }
  lines.push(
    `archon=${result.receipt.archon.status.toLowerCase()}${result.receipt.archon.version ? ` version=${result.receipt.archon.version}` : ''}`,
  );
  return `${lines.join('\n')}\n`;
}
