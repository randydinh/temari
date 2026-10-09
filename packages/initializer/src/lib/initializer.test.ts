import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import test from 'node:test';
import { crc32, deflateRawSync } from 'node:zlib';

import {
  doctor,
  findExecutable,
  formatInitialization,
  formatReport,
  initialize,
  parseVersion,
  type CommandResult,
  type CommandRunner,
  type DependencyManifest,
} from './initializer.js';
import { extractZipMember, managedBunExecutable } from './managed-bun.js';
import { platformInfo } from './platform.js';
import { commandInvocation } from './command.js';
import type {
  ArchonReleaseAsset,
  ManagedArchonRuntime,
} from '@temari/archon-harness';

const manifest: DependencyManifest = {
  schema: 1,
  version: 'test',
  tools: {
    pnpm: { command: 'pnpm', required: true, minimumMajor: 11 },
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
          pnpm: 'pnpm 11.25.0',
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

function zipMember(name: string, data: Buffer, method: 0 | 8): Buffer {
  const payload = method === 8 ? deflateRawSync(data) : data;
  const nameBytes = Buffer.from(name);
  const checksum = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const localPart = Buffer.concat([local, nameBytes, payload]);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(payload.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  const centralPart = Buffer.concat([central, nameBytes]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralPart.length, 12);
  end.writeUInt32LE(localPart.length, 16);
  return Buffer.concat([localPart, centralPart, end]);
}

test('extracts stored and deflated Bun archive members', () => {
  const payload = Buffer.from('bun-binary');
  const member = 'bun-linux-x64/bun';
  assert.deepEqual(
    extractZipMember(zipMember(member, payload, 0), member),
    payload,
  );
  assert.deepEqual(
    extractZipMember(zipMember(member, payload, 8), member),
    payload,
  );
});

test('doctor stays failed and names init when Bun or Archon is missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-initializer-'));
  try {
    const platform = platformInfo({
      platform: 'linux',
      arch: 'x64',
      homeDirectory: root,
      environment: {},
    });
    const manifestPath = join(root, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify(manifest));
    await writeFile(join(root, 'pnpm-lock.yaml'), 'lock');
    await mkdir(join(root, 'runtime'), { recursive: true });
    await writeFile(join(root, 'runtime', 'bun.lock'), 'lock');
    const report = await doctor({
      workspaceRoot: root,
      manifestPath,
      platform,
      environment: { PATH: '' },
    });
    assert.equal(report.ok, false);
    assert.equal(report.tools.find((tool) => tool.name === 'bun')?.ok, false);
    assert.equal(report.archon.status, 'MISSING');
    const text = formatReport(report);
    assert.match(text, /next=pnpm temari:init/);
    assert.doesNotMatch(text, /bun\.sh/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('init bootstraps Bun absent from PATH and a later doctor passes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-initializer-'));
  try {
    const bin = join(root, 'bin');
    const platform = platformInfo({
      platform: 'linux',
      arch: 'x64',
      homeDirectory: root,
      environment: {},
    });
    const manifestPath = join(root, 'manifest.json');
    await mkdir(bin, { recursive: true });
    await mkdir(join(root, 'runtime'), { recursive: true });
    await writeFile(manifestPath, JSON.stringify(manifest));
    await writeFile(join(root, 'pnpm-lock.yaml'), 'lock');
    await writeFile(join(root, 'runtime', 'bun.lock'), 'lock');
    await writeFile(join(bin, 'pnpm'), '#!/bin/sh\necho "pnpm 11.25.0"\n');
    await writeFile(join(bin, 'git'), '#!/bin/sh\necho "git version 2.43.0"\n');
    await chmod(join(bin, 'pnpm'), 0o755);
    await chmod(join(bin, 'git'), 0o755);
    const bunPath = managedBunExecutable(
      platform.cacheDirectory,
      'linux',
      'x64',
    );
    let bootstrapCalls = 0;
    const archonBody =
      "#!/bin/sh\nprintf '%s\\n' 'Archon CLI v0.10.1' '  Git commit: 9820785c'\n";
    const archonBytes = Buffer.from(archonBody);
    const archonAsset = {
      version: '0.10.1',
      commitPrefix: '9820785c',
      platform: 'linux',
      arch: 'x64',
      platformKey: 'linux-x64',
      assetName: 'archon-linux-x64',
      size: archonBytes.length,
      sha256: createHash('sha256').update(archonBytes).digest('hex'),
      url: 'https://example.invalid/archon-linux-x64',
    } satisfies ArchonReleaseAsset;
    const calls: Array<{ file: string; args: readonly string[]; cwd: string }> =
      [];
    const result = await initialize({
      workspaceRoot: root,
      manifestPath,
      platform,
      environment: { PATH: bin },
      dataDirectory: join(root, 'state'),
      runner: runnerFor(
        {
          pnpm: 'pnpm 11.25.0',
          bun: 'bun 1.4.2',
          git: 'git version 2.43.0',
          archon: 'Archon CLI v0.10.1\n  Git commit: 9820785c\n',
        },
        calls,
      ),
      bunInstaller: async () => {
        bootstrapCalls += 1;
        await mkdir(dirname(bunPath), { recursive: true });
        await writeFile(bunPath, '#!/bin/sh\necho "1.4.2"\n');
        await chmod(bunPath, 0o755);
        return bunPath;
      },
      archonInstaller: async () =>
        ({
          version: '0.10.1',
          commitPrefix: '9820785c',
          platform: 'linux',
          arch: 'x64',
          platformKey: 'linux-x64',
          assetName: 'archon-linux-x64',
          size: archonAsset.size,
          sha256: archonAsset.sha256,
          executablePath: join(root, 'archon'),
        }) satisfies ManagedArchonRuntime,
    });
    assert.equal(bootstrapCalls, 1);
    assert.equal(result.receipt.status, 'SUCCEEDED');
    assert.equal(result.receipt.archon.status, 'INSTALLED');
    assert.equal(
      result.receipt.steps.every((step) => step.status === 'SUCCEEDED'),
      true,
    );
    const archonPath = join(
      platform.cacheDirectory,
      'components',
      'archon',
      '0.10.1',
      'linux-x64',
      'archon-linux-x64',
    );
    await mkdir(dirname(archonPath), { recursive: true });
    await writeFile(archonPath, archonBytes);
    await chmod(archonPath, 0o755);
    const report = await doctor({
      workspaceRoot: root,
      manifestPath,
      platform,
      environment: { PATH: bin },
      archonAsset,
    });
    assert.equal(report.ok, true);
    assert.equal(
      report.tools.find((tool) => tool.name === 'bun')?.path,
      bunPath,
    );
    assert.equal(report.archon.status, 'READY');
    assert.equal(report.archon.version, '0.10.1');
    assert.doesNotMatch(formatReport(report), /next=pnpm temari:init/);
    await rm(archonPath);
    const missingArchon = await doctor({
      workspaceRoot: root,
      manifestPath,
      platform,
      environment: { PATH: bin },
      archonAsset,
    });
    assert.equal(missingArchon.ok, false);
    assert.equal(
      missingArchon.tools.find((tool) => tool.name === 'bun')?.ok,
      true,
    );
    assert.equal(missingArchon.archon.status, 'MISSING');
    assert.match(formatReport(missingArchon), /next=pnpm temari:init/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
