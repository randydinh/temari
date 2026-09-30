import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import test from 'node:test';

import {
  doctor,
  findExecutable,
  formatInitialization,
  initialize,
  parseVersion,
  type CommandResult,
  type CommandRunner,
  type DependencyManifest,
} from './initializer.js';
import { platformInfo } from './platform.js';
import { commandInvocation } from './command.js';
import type { ManagedArchonRuntime } from '@temari/archon-harness';

const manifest: DependencyManifest = {
  schema: 1,
  version: 'test',
  tools: {
    pnpm: { command: 'pnpm', required: true, minimumMajor: 9 },
    bun: { command: 'bun', required: true, minimumMajor: 1 },
    git: { command: 'git', required: true },
  },
  installations: [
    {
      id: 'workspace',
      manager: 'pnpm',
      workingDirectory: '.',
      lockfile: 'pnpm-lock.yaml',
      args: ['install', '--frozen-lockfile'],
      required: true,
    },
    {
      id: 'runtime',
      manager: 'bun',
      workingDirectory: '.',
      sourceDirectory: 'runtime',
      lockfile: 'runtime/bun.lock',
      args: ['install', '--frozen-lockfile', '--ignore-scripts'],
      cache: true,
      required: true,
    },
  ],
};

function runnerFor(
  versions: Readonly<Record<string, string>>,
  calls: Array<{ file: string; args: readonly string[]; cwd: string }>,
): CommandRunner {
  return {
    async run(file, args, cwd): Promise<CommandResult> {
      calls.push({ file, args, cwd });
      const name =
        file
          .split(/[\\/]/)
          .pop()
          ?.replace(/\.(?:cmd|exe)$/i, '') ?? file;
      return {
        exitCode: 0,
        signal: null,
        stdout: versions[name] ?? '',
        stderr: '',
      };
    },
  };
}

test('uses platform-native user data locations', () => {
  assert.equal(
    platformInfo({
      platform: 'win32',
      arch: 'x64',
      homeDirectory: 'C:\\Users\\tester',
      environment: { LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' },
    }).dataDirectory,
    'C:\\Users\\tester\\AppData\\Local\\Temari',
  );
  assert.equal(
    platformInfo({
      platform: 'darwin',
      arch: 'arm64',
      homeDirectory: '/Users/tester',
      environment: {},
    }).dataDirectory,
    '/Users/tester/Library/Application Support/Temari',
  );
});

test('parses common tool version output', () => {
  assert.deepEqual(parseVersion('pnpm 9.15.9'), {
    version: '9.15.9',
    major: 9,
  });
  assert.deepEqual(parseVersion('bun 1.4.2'), { version: '1.4.2', major: 1 });
  assert.equal(parseVersion('not a version'), null);
});

test('finds executables through a platform-specific PATH', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-initializer-'));
  try {
    await writeFile(join(root, 'pnpm'), 'extensionless shim');
    const executable = join(root, 'pnpm.cmd');
    await writeFile(executable, '');
    assert.equal(
      await findExecutable('pnpm', 'win32', {
        PATH: root,
        PATHEXT: '.CMD',
      }),
      executable,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('quotes Windows command wrappers for cmd.exe /s /c', () => {
  assert.deepEqual(
    commandInvocation(
      'C:\\Program Files\\pnpm\\pnpm.CMD',
      ['--version'],
      'win32',
      { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    ),
    {
      file: 'C:\\Windows\\System32\\cmd.exe',
      args: [
        '/d',
        '/s',
        '/c',
        '""C:\\Program Files\\pnpm\\pnpm.CMD" "--version""',
      ],
      windowsVerbatimArguments: true,
    },
  );
});

test('resolves Windows shell variables without relying on environment casing', () => {
  assert.deepEqual(
    commandInvocation(
      'C:\\Program Files\\pnpm\\pnpm.CMD',
      ['--version'],
      'win32',
      { COMSPEC: 'C:\\Windows\\System32\\cmd.exe' },
    ),
    {
      file: 'C:\\Windows\\System32\\cmd.exe',
      args: [
        '/d',
        '/s',
        '/c',
        '""C:\\Program Files\\pnpm\\pnpm.CMD" "--version""',
      ],
      windowsVerbatimArguments: true,
    },
  );
});

test('doctor reports required lockfiles and allows unsupported optional tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-initializer-'));
  try {
    await writeFile(join(root, 'pnpm-lock.yaml'), 'lock');
    await mkdir(join(root, 'runtime'), { recursive: true });
    await writeFile(join(root, 'runtime', 'bun.lock'), 'lock');
    await writeFile(join(root, 'pnpm'), '');
    await writeFile(join(root, 'bun'), '');
    await chmod(join(root, 'pnpm'), 0o755);
    await chmod(join(root, 'bun'), 0o755);
    const manifestPath = join(root, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify(manifest));
    const report = await doctor({
      workspaceRoot: root,
      manifestPath,
      platform: platformInfo({
        platform: 'win32',
        arch: 'x64',
        homeDirectory: root,
        environment: {},
      }),
      environment: { PATH: '' },
    });
    assert.equal(report.ok, false);
    assert.equal(
      report.lockfiles.every((lockfile) => lockfile.ok),
      true,
    );
    assert.equal(
      report.tools.find((tool) => tool.name === 'archon'),
      undefined,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('init runs locked installs and writes a receipt without shell-specific commands', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-initializer-'));
  const manifestPath = join(root, 'manifest.json');
  const calls: Array<{ file: string; args: readonly string[]; cwd: string }> =
    [];
  try {
    await writeFile(join(root, 'pnpm-lock.yaml'), 'lock');
    await mkdir(join(root, 'runtime'), { recursive: true });
    await writeFile(join(root, 'runtime', 'bun.lock'), 'lock');
    await writeFile(manifestPath, JSON.stringify(manifest));
    await writeFile(join(root, 'pnpm'), '');
    await writeFile(join(root, 'bun'), '');
    await writeFile(join(root, 'git'), '');
    await chmod(join(root, 'pnpm'), 0o755);
    await chmod(join(root, 'bun'), 0o755);
    await chmod(join(root, 'git'), 0o755);
    const installCalls: unknown[] = [];
    const fakeRuntime: ManagedArchonRuntime = {
      version: '0.10.1',
      commitPrefix: '9820785c',
      platform: 'darwin',
      arch: 'arm64',
      platformKey: 'darwin-arm64',
      assetName: 'archon-darwin-arm64',
      size: 75_401_632,
      sha256: 'a'.repeat(64),
      executablePath: join(root, 'cache', 'archon'),
    };
    const result = await initialize({
      workspaceRoot: root,
      manifestPath,
      platform: platformInfo({
        platform: 'darwin',
        arch: 'arm64',
        homeDirectory: root,
        environment: {},
      }),
      environment: { PATH: root },
      runner: runnerFor(
        {
          pnpm: 'pnpm 9.15.9',
          bun: 'bun 1.4.2',
          git: 'git version 2.0.0',
          archon: 'Archon CLI v0.10.1\n  Git commit: 9820785c\n',
        },
        calls,
      ),
      archonInstaller: async (options) => {
        installCalls.push(options);
        return fakeRuntime;
      },
      dataDirectory: join(root, 'state'),
    });
    assert.equal(result.receipt.status, 'SUCCEEDED');
    assert.equal(result.receipt.archon.status, 'INSTALLED');
    assert.equal(result.receipt.archon.sha256, 'a'.repeat(64));
    assert.equal(result.doctor.archon.status, 'MISSING');
    assert.equal(result.doctor.ok, false);
    assert.deepEqual(installCalls, [
      {
        cacheDirectory: posix.join(root, 'Library', 'Caches', 'Temari'),
        platform: 'darwin',
        arch: 'arm64',
      },
    ]);
    assert.deepEqual(
      calls.map((call) => call.args),
      [
        ['--version'],
        ['--version'],
        ['--version'],
        ['install', '--frozen-lockfile'],
        ['install', '--frozen-lockfile', '--ignore-scripts'],
        ['version'],
      ],
    );
    assert.deepEqual(
      calls.slice(3, 5).map((call) => call.cwd),
      [
        root,
        join(
          root,
          'Library',
          'Caches',
          'Temari',
          'installations',
          'test',
          'runtime',
        ),
      ],
    );
    const stored = JSON.parse(await readFile(result.receiptPath, 'utf8')) as {
      status: string;
    };
    assert.equal(stored.status, 'SUCCEEDED');
    assert.equal(result.receipt.status, 'SUCCEEDED');
    assert.match(
      formatInitialization(result),
      /next=temari doctor --live --host <codex\|claude-code\|cursor>/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
