import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  readdir,
  unlink,
  link,
} from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

export interface WorkspaceManifestEntry {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly mode: number;
}

export interface WorkspaceManifest {
  readonly schema: 1;
  readonly runId: string;
  readonly revision: string;
  readonly subjectId: string;
  readonly workspaceId: string;
  readonly createdAt: string;
  readonly bytes: number;
  readonly entries: readonly WorkspaceManifestEntry[];
}

export interface CaptureWorkspaceManifestRequest {
  readonly runId: string;
  readonly revision: string;
  readonly subjectId: string;
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly maxFiles?: number;
  readonly maxBytes?: number;
  readonly now?: Date;
}

export interface WorkspaceManifestStore {
  capture(request: CaptureWorkspaceManifestRequest): Promise<WorkspaceManifest>;
  save(manifest: WorkspaceManifest): Promise<string>;
  load(runId: string, subjectId: string): Promise<WorkspaceManifest | null>;
  verify(manifest: WorkspaceManifest, workspaceRoot: string): Promise<void>;
}

interface StoredWorkspaceManifest {
  readonly schema: 1;
  readonly sha256: string;
  readonly manifest: WorkspaceManifest;
}

const DEFAULT_MAX_FILES = 10_000;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const HASH_BUFFER_BYTES = 64 * 1024;

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertSafeId(value: string, label: string): void {
  assert(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value),
    `${label} must be a safe identifier.`,
  );
}

function assertRevision(revision: string): void {
  assert(
    revision.length > 0 && revision.length <= 512,
    'Manifest revision is required.',
  );
}

function assertText(value: string, label: string): void {
  assert(
    value.trim().length > 0 && value.length <= 512,
    `${label} is required.`,
  );
}

function assertLimits(maxFiles: number, maxBytes: number): void {
  assert(
    Number.isInteger(maxFiles) && maxFiles > 0,
    'Manifest maxFiles must be a positive integer.',
  );
  assert(
    Number.isInteger(maxBytes) && maxBytes > 0,
    'Manifest maxBytes must be a positive integer.',
  );
}

function assertRelativePath(value: string): void {
  assert(value.length > 0 && !value.includes('\0'));
  assert(!value.startsWith('/') && !value.startsWith('\\'));
  assert(
    !value.split('/').includes('..'),
    'Manifest path traversal is invalid.',
  );
  assert(!value.includes('\\'), 'Manifest paths must use POSIX separators.');
}

function assertHash(value: string): void {
  assert(/^[0-9a-f]{64}$/.test(value), 'Manifest hash is invalid.');
}

function compareBytes(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertEntry(entry: WorkspaceManifestEntry): void {
  assertRelativePath(entry.path);
  assertHash(entry.sha256);
  assert(Number.isSafeInteger(entry.bytes) && entry.bytes >= 0);
  assert(
    Number.isInteger(entry.mode) && entry.mode >= 0 && entry.mode <= 0o777,
  );
}

function assertManifest(manifest: WorkspaceManifest): void {
  assert.equal(manifest.schema, 1);
  assertSafeId(manifest.runId, 'Run ID');
  assertRevision(manifest.revision);
  assertSafeId(manifest.subjectId, 'Manifest subject ID');
  assertText(manifest.workspaceId, 'Workspace ID');
  assert(Number.isFinite(Date.parse(manifest.createdAt)));
  assert(Number.isSafeInteger(manifest.bytes) && manifest.bytes >= 0);
  assert(Array.isArray(manifest.entries));
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const entry of manifest.entries) {
    assertEntry(entry);
    assert(!paths.has(entry.path), 'Manifest paths must be unique.');
    paths.add(entry.path);
    totalBytes += entry.bytes;
  }
  assert.equal(totalBytes, manifest.bytes, 'Manifest byte total is invalid.');
}

async function hashFile(
  path: string,
  expectedBytes: number,
  maxBytes: number,
): Promise<string> {
  assert(expectedBytes <= maxBytes, 'Workspace file exceeds manifest limit.');
  const file = await open(path, 'r');
  const hash = createHash('sha256');
  let bytes = 0;
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
  try {
    while (true) {
      const result = await file.read(buffer, 0, buffer.byteLength, null);
      if (result.bytesRead === 0) break;
      bytes += result.bytesRead;
      assert(bytes <= maxBytes, 'Workspace file exceeds manifest limit.');
      hash.update(buffer.subarray(0, result.bytesRead));
    }
  } finally {
    await file.close();
  }
  assert.equal(bytes, expectedBytes, 'Workspace file changed during capture.');
  return hash.digest('hex');
}

async function collectFiles(
  root: string,
  current: string,
  entries: WorkspaceManifestEntry[],
  limits: { readonly maxFiles: number; readonly maxBytes: number },
  total: { bytes: number },
): Promise<void> {
  const children = (await readdir(current, { withFileTypes: true })).sort(
    (left, right) => compareBytes(left.name, right.name),
  );
  for (const child of children) {
    const path = join(current, child.name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      throw new Error(`Workspace manifest refuses symlink: ${child.name}`);
    }
    if (stat.isDirectory()) {
      await collectFiles(root, path, entries, limits, total);
      continue;
    }
    assert(
      stat.isFile(),
      `Workspace manifest refuses non-regular path: ${child.name}`,
    );
    assert(
      entries.length < limits.maxFiles,
      'Workspace manifest has too many files.',
    );
    assert(
      total.bytes + stat.size <= limits.maxBytes,
      'Workspace manifest exceeds its byte limit.',
    );
    const normalized = relative(root, path).split(sep).join('/');
    assertRelativePath(normalized);
    const sha256 = await hashFile(path, stat.size, limits.maxBytes);
    entries.push({
      path: normalized,
      sha256,
      bytes: stat.size,
      mode: stat.mode & 0o777,
    });
    total.bytes += stat.size;
  }
}

export async function captureWorkspaceManifest(
  request: CaptureWorkspaceManifestRequest,
): Promise<WorkspaceManifest> {
  assertSafeId(request.runId, 'Run ID');
  assertRevision(request.revision);
  assertSafeId(request.subjectId, 'Manifest subject ID');
  assertText(request.workspaceId, 'Workspace ID');
  assert(isAbsolute(request.workspaceRoot), 'Workspace root must be absolute.');
  const rootStat = await lstat(request.workspaceRoot);
  assert(
    rootStat.isDirectory() && !rootStat.isSymbolicLink(),
    'Workspace root must be a regular directory.',
  );
  const maxFiles = request.maxFiles ?? DEFAULT_MAX_FILES;
  const maxBytes = request.maxBytes ?? DEFAULT_MAX_BYTES;
  assertLimits(maxFiles, maxBytes);
  const root = await realpath(request.workspaceRoot);
  const entries: WorkspaceManifestEntry[] = [];
  const total = { bytes: 0 };
  await collectFiles(root, root, entries, { maxFiles, maxBytes }, total);
  const createdAt = request.now ?? new Date();
  assert(
    Number.isFinite(createdAt.getTime()),
    'Manifest timestamp is invalid.',
  );
  return {
    schema: 1,
    runId: request.runId,
    revision: request.revision,
    subjectId: request.subjectId,
    workspaceId: request.workspaceId,
    createdAt: createdAt.toISOString(),
    bytes: total.bytes,
    entries,
  };
}

function storedBody(manifest: WorkspaceManifest): string {
  const body = canonical(manifest);
  const stored: StoredWorkspaceManifest = {
    schema: 1,
    sha256: digest(body),
    manifest,
  };
  return canonical(stored);
}

function parseStored(value: unknown): WorkspaceManifest {
  assert(value && typeof value === 'object');
  const stored = value as Partial<StoredWorkspaceManifest>;
  assert.equal(stored.schema, 1);
  assert(typeof stored.sha256 === 'string');
  assert(stored.manifest && typeof stored.manifest === 'object');
  assert.equal(stored.sha256, digest(canonical(stored.manifest)));
  assertManifest(stored.manifest);
  return stored.manifest;
}

export class FileWorkspaceManifestStore implements WorkspaceManifestStore {
  private constructor(private readonly root: string) {}

  static async create(root: string): Promise<FileWorkspaceManifestStore> {
    assert(isAbsolute(root), 'Manifest store root must be absolute.');
    await mkdir(root, { recursive: true, mode: 0o700 });
    return new FileWorkspaceManifestStore(await realpath(root));
  }

  capture(
    request: CaptureWorkspaceManifestRequest,
  ): Promise<WorkspaceManifest> {
    return captureWorkspaceManifest(request);
  }

  async save(manifest: WorkspaceManifest): Promise<string> {
    assertManifest(manifest);
    const path = join(
      this.root,
      `${manifest.runId}.${manifest.subjectId}.workspace.json`,
    );
    const body = storedBody(manifest);
    const temporary = join(
      this.root,
      `.${manifest.runId}.${manifest.subjectId}.${randomUUID()}.tmp`,
    );
    const file = await open(temporary, 'wx', 0o600);
    try {
      try {
        await file.writeFile(body);
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        await link(temporary, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        assert.equal(
          await readFile(path, 'utf8'),
          body,
          'Workspace manifest collision or mutation.',
        );
      }
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    return path;
  }

  async load(
    runId: string,
    subjectId: string,
  ): Promise<WorkspaceManifest | null> {
    assertSafeId(runId, 'Run ID');
    assertSafeId(subjectId, 'Manifest subject ID');
    try {
      const manifest = parseStored(
        JSON.parse(
          await readFile(
            join(this.root, `${runId}.${subjectId}.workspace.json`),
            'utf8',
          ),
        ),
      );
      assert.equal(manifest.runId, runId);
      assert.equal(manifest.subjectId, subjectId);
      return manifest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async verify(
    manifest: WorkspaceManifest,
    workspaceRoot: string,
  ): Promise<void> {
    assertManifest(manifest);
    const actual = await captureWorkspaceManifest({
      runId: manifest.runId,
      revision: manifest.revision,
      subjectId: manifest.subjectId,
      workspaceId: manifest.workspaceId,
      workspaceRoot,
      maxFiles: Math.max(manifest.entries.length, 1),
      maxBytes: Math.max(manifest.bytes, 1),
      now: new Date(manifest.createdAt),
    });
    assert.deepEqual(
      actual.entries,
      manifest.entries,
      'Workspace manifest changed.',
    );
    assert.equal(actual.bytes, manifest.bytes);
  }
}
