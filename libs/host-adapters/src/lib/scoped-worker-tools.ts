import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { CodexWriteOwnedPath } from './codex-exec-worker.js';

export const SCOPED_WORKER_POLICY = 'temari-scoped-tools-v1' as const;
export const SCOPED_WORKER_TOOL_NAMES = [
  'read_file',
  'list_files',
  'search_text',
] as const;
const MAX_FILE_BYTES = 256 * 1024;
const DENIED = new Set([
  '.git',
  '.claude',
  '.codex',
  '.agents',
  '.archon',
  '.temari',
  '.aws',
  '.ssh',
  '.mcp.json',
  'node_modules',
  'agents.md',
  'claude.md',
]);
export interface ScopedWorkerToolConfig {
  readonly schema: 1;
  readonly policy: typeof SCOPED_WORKER_POLICY;
  readonly workspaceRoot: string;
  readonly rootDevice: number;
  readonly rootInode: number;
  readonly access: 'read-only' | 'workspace-write';
  readonly owns: readonly CodexWriteOwnedPath[];
  readonly auditPath?: string;
}
const hash = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
function admittedPath(path: string, allowRoot = false): void {
  assert(
    typeof path === 'string' &&
      path.length <= 4096 &&
      !path.includes('\0') &&
      !path.includes('\\') &&
      !isAbsolute(path),
    'Select a workspace-relative path.',
  );
  if (allowRoot && path === '.') return;
  const segments = path.split('/');
  assert(
    segments.every(
      (part) =>
        part &&
        part !== '.' &&
        part !== '..' &&
        !DENIED.has(part.toLowerCase().replace(/[. ]+$/, '')) &&
        !part.toLowerCase().startsWith('.env'),
    ),
    'Path crosses a protected workspace boundary.',
  );
}
export async function createScopedWorkerToolConfig(
  workspaceRoot: string,
  access: ScopedWorkerToolConfig['access'],
  owns: readonly CodexWriteOwnedPath[] = [],
  auditPath?: string,
): Promise<ScopedWorkerToolConfig> {
  assert(
    isAbsolute(workspaceRoot) &&
      (await realpath(workspaceRoot)) === workspaceRoot,
    'Select a canonical workspace root.',
  );
  assert(
    access === 'read-only' || access === 'workspace-write',
    'Unsupported worker access.',
  );
  assert(Array.isArray(owns) && owns.length <= 128);
  for (const item of owns) {
    assert(item && (item.kind === 'file' || item.kind === 'directory'));
    admittedPath(item.path);
  }
  assert(
    access === 'read-only' ? owns.length === 0 : owns.length > 0,
    'Write access requires typed ownership; read-only access has no write scope.',
  );
  const info = await lstat(workspaceRoot);
  assert(info.isDirectory() && !info.isSymbolicLink());
  if (auditPath)
    assert(
      isAbsolute(auditPath) &&
        !auditPath.includes('\0') &&
        !auditPath.startsWith(workspaceRoot + sep),
      'Tool audit must be retained outside the workspace.',
    );
  return {
    schema: 1,
    policy: SCOPED_WORKER_POLICY,
    workspaceRoot,
    rootDevice: info.dev,
    rootInode: info.ino,
    access,
    owns: structuredClone(owns),
    ...(auditPath ? { auditPath } : {}),
  };
}
export class ScopedWorkerTools {
  private queue: Promise<unknown> = Promise.resolve();
  private invocationQueue: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private calls = 0;
  private inputBytes = 0;
  private outputBytes = 0;
  constructor(readonly config: ScopedWorkerToolConfig) {}
  async validate(): Promise<void> {
    assert.deepEqual(
      Object.keys(this.config).sort(),
      [
        'access',
        'owns',
        'policy',
        'rootDevice',
        'rootInode',
        'schema',
        'workspaceRoot',
        ...('auditPath' in this.config ? ['auditPath'] : []),
      ].sort(),
    );
    assert(
      this.config.schema === 1 && this.config.policy === SCOPED_WORKER_POLICY,
    );
    const selected = await createScopedWorkerToolConfig(
      this.config.workspaceRoot,
      this.config.access,
      this.config.owns,
      this.config.auditPath,
    );
    assert(
      selected.rootDevice === this.config.rootDevice &&
        selected.rootInode === this.config.rootInode,
      'Selected workspace identity changed.',
    );
  }
  invoke(name: string, args: Record<string, unknown>): Promise<unknown> {
    assert(this.pending < 8, 'Worker tool concurrency bound reached.');
    this.pending++;
    const operation = this.invocationQueue.then(async () => {
      assert(
        ++this.calls <= 128 && this.outputBytes < 4 * 1024 * 1024,
        'Worker tool call or cumulative output bound reached.',
      );
      this.inputBytes += Buffer.byteLength(JSON.stringify(args));
      assert(
        this.inputBytes <= 8 * 1024 * 1024,
        'Worker tool cumulative input bound reached.',
      );
      let success = false,
        output: unknown;
      try {
        if (name === 'read_file') output = await this.read(args.path as string);
        else if (name === 'list_files')
          output = await this.list(args.path as string | undefined);
        else if (name === 'search_text')
          output = await this.search(
            args.query as string,
            args.path as string | undefined,
          );
        else if (name === 'write_file')
          output = await this.write(
            args.path as string,
            args.text as string,
            args.expectedSha256 as string | null,
          );
        else throw new Error('Unknown worker tool.');
        this.outputBytes += Buffer.byteLength(JSON.stringify(output));
        assert(
          this.outputBytes <= 4 * 1024 * 1024,
          'Worker tool cumulative output bound reached.',
        );
        success = true;
        return output;
      } finally {
        if (this.config.auditPath) {
          const file = await open(
            this.config.auditPath,
            constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
          );
          try {
            const info = await file.stat();
            assert(info.isFile() && info.nlink === 1 && info.size < 256 * 1024);
            const record = {
              schema: 1,
              sequence: this.calls,
              tool: name,
              succeeded: success,
              path:
                typeof args.path === 'string' ? args.path.slice(0, 4096) : null,
              query:
                typeof args.query === 'string'
                  ? args.query.slice(0, 256)
                  : null,
              writeSha256:
                typeof args.text === 'string'
                  ? hash(Buffer.from(args.text))
                  : null,
              outputSha256: success
                ? hash(Buffer.from(JSON.stringify(output)))
                : null,
              observedAt: new Date().toISOString(),
            };
            await file.writeFile(JSON.stringify(record) + '\n');
          } finally {
            await file.close();
          }
        }
      }
    });
    this.invocationQueue = operation.catch(() => undefined);
    return operation.finally(() => {
      this.pending--;
    });
  }
  private async path(
    path: string,
    allowRoot = false,
    future = false,
  ): Promise<string> {
    admittedPath(path, allowRoot);
    await this.validate();
    const selected =
      path === '.'
        ? this.config.workspaceRoot
        : join(this.config.workspaceRoot, path);
    let current = this.config.workspaceRoot;
    for (const part of path === '.' ? [] : path.split('/')) {
      current = join(current, part);
      try {
        const info = await lstat(current);
        assert(!info.isSymbolicLink(), 'Symlink paths are not admitted.');
      } catch (error) {
        if (future && (error as NodeJS.ErrnoException).code === 'ENOENT') break;
        throw error;
      }
    }
    const distance = relative(this.config.workspaceRoot, selected);
    assert(
      distance === '' ||
        (!isAbsolute(distance) &&
          distance !== '..' &&
          !distance.startsWith('..' + sep)),
    );
    return selected;
  }
  async read(
    path: string,
  ): Promise<{ path: string; sha256: string; text: string }> {
    const selected = await this.path(path);
    const selectedInfo = await lstat(selected);
    assert(
      selectedInfo.isFile() &&
        selectedInfo.nlink === 1 &&
        selectedInfo.size <= MAX_FILE_BYTES,
      'Select a bounded, unlinked regular text file.',
    );
    const file = await open(
      selected,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await file.stat();
      assert(
        info.isFile() && info.nlink === 1 && info.size <= MAX_FILE_BYTES,
        'Select a bounded, unlinked regular text file.',
      );
      assert(
        info.dev === selectedInfo.dev && info.ino === selectedInfo.ino,
        'Selected file identity changed before open.',
      );
      await this.path(path);
      const observed = await lstat(selected);
      assert(
        info.dev === observed.dev && info.ino === observed.ino,
        'Selected file identity changed.',
      );
      const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const got = await file.read(bytes, length, bytes.length - length, null);
        if (!got.bytesRead) break;
        length += got.bytesRead;
      }
      assert(length <= MAX_FILE_BYTES, 'File exceeds the worker byte bound.');
      const data = bytes.subarray(0, length),
        text = new TextDecoder('utf-8', { fatal: true }).decode(data);
      assert(!text.includes('\0'), 'Binary files are not admitted.');
      return { path, sha256: hash(data), text };
    } finally {
      await file.close();
    }
  }
  async list(path = '.'): Promise<{
    path: string;
    entries: { name: string; kind: 'file' | 'directory' }[];
    truncated: boolean;
  }> {
    const selected = await this.path(path, true);
    assert((await lstat(selected)).isDirectory());
    const entries = [];
    let inspected = 0,
      truncated = false;
    const directory = await opendir(selected);
    for await (const item of directory) {
      if (++inspected > 400 || entries.length >= 200) {
        truncated = true;
        break;
      }
      try {
        admittedPath(path === '.' ? item.name : path + '/' + item.name);
      } catch {
        continue;
      }
      if (item.isSymbolicLink() || (!item.isFile() && !item.isDirectory()))
        continue;
      entries.push({
        name: item.name,
        kind: item.isDirectory() ? ('directory' as const) : ('file' as const),
      });
    }
    await this.path(path, true);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return { path, entries, truncated };
  }
  async search(
    query: string,
    path = '.',
  ): Promise<{
    matches: { path: string; line: number; text: string }[];
    truncated: boolean;
  }> {
    assert(
      typeof query === 'string' &&
        query.length > 0 &&
        query.length <= 256 &&
        !query.includes('\0'),
    );
    await this.path(path, true);
    const pending = [path],
      matches = [];
    let inspected = 0,
      truncated = false;
    while (pending.length && inspected < 400 && matches.length < 40) {
      const directory = pending.shift()!,
        listing = await this.list(directory);
      truncated ||= listing.truncated;
      for (const entry of listing.entries) {
        if (++inspected > 400 || matches.length >= 40) {
          truncated = true;
          break;
        }
        const selected =
          directory === '.' ? entry.name : directory + '/' + entry.name;
        if (entry.kind === 'directory') {
          pending.push(selected);
          continue;
        }
        let text: string;
        try {
          text = (await this.read(selected)).text;
        } catch {
          continue;
        }
        for (const [index, line] of text.split('\n').entries())
          if (line.includes(query)) {
            matches.push({
              path: selected,
              line: index + 1,
              text: line.slice(0, 512),
            });
            if (matches.length >= 40) {
              truncated = true;
              break;
            }
          }
      }
    }
    return { matches, truncated: truncated || pending.length > 0 };
  }
  write(
    path: string,
    text: string,
    expectedSha256: string | null,
  ): Promise<{ path: string; sha256: string }> {
    const operation = this.queue.then(() =>
      this.ownedWrite(path, text, expectedSha256),
    );
    this.queue = operation.catch(() => undefined);
    return operation;
  }
  private async ownedWrite(
    path: string,
    text: string,
    expectedSha256: string | null,
  ): Promise<{ path: string; sha256: string }> {
    assert(
      this.config.access === 'workspace-write',
      'This worker is read-only.',
    );
    admittedPath(path);
    assert(
      this.config.owns.some((item) =>
        item.kind === 'file'
          ? path === item.path
          : path.startsWith(item.path + '/'),
      ),
      'Path is outside the typed write scope.',
    );
    assert(
      typeof text === 'string' &&
        !text.includes('\0') &&
        Buffer.byteLength(text) <= MAX_FILE_BYTES,
    );
    assert(expectedSha256 === null || /^[a-f0-9]{64}$/.test(expectedSha256));
    const selected = await this.path(path, false, true),
      parent = dirname(selected);
    await mkdir(parent, { recursive: true });
    await this.path(path, false, true);
    let mode = 0o600;
    try {
      const current = await this.read(path);
      assert(
        current.sha256 === expectedSha256,
        'File changed since it was selected.',
      );
      mode = (await lstat(selected)).mode & 0o777;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      assert(expectedSha256 === null, 'Selected file disappeared.');
    }
    const temporary = join(parent, '.temari-write-' + randomUUID());
    const file = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      mode,
    );
    try {
      await this.path(path, false, true);
      await file.writeFile(text);
      await file.sync();
      await this.path(path, false, true);
      try {
        assert(
          (await this.read(path)).sha256 === expectedSha256,
          'File changed before publication.',
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        assert(expectedSha256 === null);
      }
      await rename(temporary, selected);
      await this.validate();
      return { path, sha256: hash(Buffer.from(text)) };
    } finally {
      await file.close();
      await rm(temporary, { force: true });
    }
  }
}
