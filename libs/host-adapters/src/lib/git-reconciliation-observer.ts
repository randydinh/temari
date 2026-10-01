import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readlink, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;

export type GitReconciliationOperation =
  | 'none'
  | 'merge'
  | 'rebase'
  | 'cherry-pick'
  | 'revert'
  | 'bisect';

export interface GitReconciliationSourceIdentity {
  readonly repositoryRoot: string;
  readonly commonGitDirectory: string;
  readonly headObjectId: string | null;
  readonly headReference: string | null;
}

export interface GitIndexStage {
  readonly stage: 1 | 2 | 3;
  readonly mode: string;
  readonly objectId: string;
}

export interface GitIndexBlobIdentity {
  readonly stage: 0 | 1 | 2 | 3;
  readonly mode: string;
  readonly objectId: string;
}

export interface GitUnmergedPath {
  readonly path: string;
  readonly stages: readonly GitIndexStage[];
}

export interface GitPathIdentity {
  readonly path: string;
  readonly pathSha256: string;
  readonly indexBlobs: readonly GitIndexBlobIdentity[];
  readonly worktreeKind: 'file' | 'symlink' | 'directory' | 'missing';
  readonly worktreeSha256: string | null;
  /** SHA-256 of Git's binary, no-external-diff output for this path. */
  readonly diffSha256: string;
}

/** A strictly read-only observation of a repository's merge-relevant state. */
export interface GitReconciliationObservation {
  readonly schema: 1;
  readonly source: GitReconciliationSourceIdentity;
  readonly operation: GitReconciliationOperation;
  /** Exact UTF-8 porcelain v2 output, including NUL record delimiters. */
  readonly porcelainV2: string;
  readonly porcelainSha256: string;
  readonly unmerged: readonly GitUnmergedPath[];
  readonly untrackedPaths: readonly string[];
  readonly paths: readonly GitPathIdentity[];
}

interface GitResult {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly code: number;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function text(value: Buffer): string {
  return value.toString('utf8').replace(/\n$/, '');
}

function safeRelativePath(path: string): string {
  if (
    path.length === 0 ||
    path.includes('\0') ||
    isAbsolute(path) ||
    path.split(/[\\/]/).some((part) => part === '..')
  ) {
    throw new Error('Git returned an unsafe repository-relative path.');
  }
  return path;
}

async function runGit(
  repositoryRoot: string,
  args: readonly string[],
  allowedCodes: readonly number[] = [0],
): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', ['--no-optional-locks', ...args], {
      cwd: repositoryRoot,
      encoding: 'buffer',
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    return {
      stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
      stderr: Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr),
      code: 0,
    };
  } catch (error: unknown) {
    const result = error as {
      code?: number | string;
      stdout?: Buffer | string;
      stderr?: Buffer | string;
    };
    const code = typeof result.code === 'number' ? result.code : -1;
    if (!allowedCodes.includes(code)) {
      const detail = Buffer.isBuffer(result.stderr)
        ? text(result.stderr)
        : String(result.stderr ?? 'Git read failed.').trim();
      throw new Error(`Read-only Git observation failed: ${detail || `exit ${code}`}`);
    }
    return {
      stdout: Buffer.isBuffer(result.stdout)
        ? result.stdout
        : Buffer.from(result.stdout ?? ''),
      stderr: Buffer.isBuffer(result.stderr)
        ? result.stderr
        : Buffer.from(result.stderr ?? ''),
      code,
    };
  }
}

async function requiredRepositoryRoot(repositoryRoot: string): Promise<string> {
  if (typeof repositoryRoot !== 'string' || repositoryRoot.trim().length === 0) {
    throw new Error('A repository root is required.');
  }
  const input = resolve(repositoryRoot);
  const inputStat = await stat(input).catch(() => null);
  if (!inputStat?.isDirectory()) {
    throw new Error('Repository root must name an existing directory.');
  }
  const canonicalInput = await realpath(input);
  if (canonicalInput === sep) throw new Error('Filesystem root is not a safe repository root.');
  const topLevel = await runGit(canonicalInput, ['rev-parse', '--show-toplevel']);
  const canonicalTopLevel = await realpath(text(topLevel.stdout));
  if (canonicalTopLevel !== canonicalInput) {
    throw new Error('Repository root must be the repository top level, not a subdirectory.');
  }
  return canonicalInput;
}

async function optionalGitText(
  repositoryRoot: string,
  args: readonly string[],
): Promise<string | null> {
  const result = await runGit(repositoryRoot, args, [0, 1]);
  return result.code === 0 ? text(result.stdout) || null : null;
}

async function gitPathExists(repositoryRoot: string, path: string): Promise<boolean> {
  const value = await runGit(repositoryRoot, ['rev-parse', '--git-path', path]);
  const location = text(value.stdout);
  return Boolean(await lstat(resolve(repositoryRoot, location)).catch(() => null));
}

async function operation(repositoryRoot: string): Promise<GitReconciliationOperation> {
  if (await optionalGitText(repositoryRoot, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])) {
    return 'merge';
  }
  if (
    (await gitPathExists(repositoryRoot, 'rebase-merge')) ||
    (await gitPathExists(repositoryRoot, 'rebase-apply'))
  ) {
    return 'rebase';
  }
  if (await optionalGitText(repositoryRoot, ['rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD'])) {
    return 'cherry-pick';
  }
  if (await optionalGitText(repositoryRoot, ['rev-parse', '-q', '--verify', 'REVERT_HEAD'])) {
    return 'revert';
  }
  if (await gitPathExists(repositoryRoot, 'BISECT_LOG')) return 'bisect';
  return 'none';
}

function tail(record: string, prefixFields: number): string {
  const fields = record.split(' ');
  return fields.slice(prefixFields).join(' ');
}

function pathsFromPorcelain(porcelain: string): {
  readonly paths: readonly string[];
  readonly untrackedPaths: readonly string[];
} {
  const paths = new Set<string>();
  const untrackedPaths = new Set<string>();
  const records = porcelain.split('\0');
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (!record) continue;
    if (record.startsWith('? ')) {
      const path = safeRelativePath(record.slice(2));
      paths.add(path);
      untrackedPaths.add(path);
    } else if (record.startsWith('1 ')) {
      paths.add(safeRelativePath(tail(record, 8)));
    } else if (record.startsWith('2 ')) {
      paths.add(safeRelativePath(tail(record, 9)));
      index += 1; // The following NUL-delimited record is the original path.
    } else if (record.startsWith('u ')) {
      paths.add(safeRelativePath(tail(record, 10)));
    }
  }
  return {
    paths: [...paths].sort(),
    untrackedPaths: [...untrackedPaths].sort(),
  };
}

function indexStages(output: string): readonly GitUnmergedPath[] {
  const byPath = new Map<string, GitIndexStage[]>();
  for (const record of output.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab < 0) throw new Error('Git returned an invalid unmerged index record.');
    const [mode, objectId, stageText] = record.slice(0, tab).split(' ');
    const stage = Number(stageText);
    if (
      !mode ||
      !objectId ||
      (stage !== 1 && stage !== 2 && stage !== 3)
    ) {
      throw new Error('Git returned an invalid unmerged index stage.');
    }
    const path = safeRelativePath(record.slice(tab + 1));
    const stages = byPath.get(path) ?? [];
    stages.push({ stage, mode, objectId });
    byPath.set(path, stages);
  }
  return [...byPath.entries()]
    .map(([path, stages]) => ({
      path,
      stages: stages.sort((left, right) => left.stage - right.stage),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function indexBlobs(output: string): readonly GitIndexBlobIdentity[] {
  const blobs: GitIndexBlobIdentity[] = [];
  for (const record of output.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    const [mode, objectId, stageText] = record.slice(0, tab).split(' ');
    const stage = Number(stageText);
    if (!mode || !objectId || (stage !== 0 && stage !== 1 && stage !== 2 && stage !== 3)) {
      throw new Error('Git returned an invalid index blob identity.');
    }
    blobs.push({ stage: stage as 0 | 1 | 2 | 3, mode, objectId });
  }
  return blobs.sort((left, right) => left.stage - right.stage);
}

async function worktreeIdentity(
  repositoryRoot: string,
  path: string,
): Promise<Pick<GitPathIdentity, 'worktreeKind' | 'worktreeSha256'>> {
  const absolute = resolve(repositoryRoot, path);
  if (relative(repositoryRoot, absolute).startsWith('..')) {
    throw new Error('Git path resolved outside the repository root.');
  }
  const entry = await lstat(absolute).catch(() => null);
  if (!entry) return { worktreeKind: 'missing', worktreeSha256: null };
  if (entry.isFile()) {
    return { worktreeKind: 'file', worktreeSha256: sha256(await readFile(absolute)) };
  }
  if (entry.isSymbolicLink()) {
    return { worktreeKind: 'symlink', worktreeSha256: sha256(await readlink(absolute)) };
  }
  return { worktreeKind: 'directory', worktreeSha256: null };
}

async function diffIdentity(
  repositoryRoot: string,
  path: string,
  hasHead: boolean,
  untracked: boolean,
): Promise<string> {
  const args = untracked
    ? ['diff', '--no-index', '--no-ext-diff', '--binary', '--no-color', '--', '/dev/null', path]
    : hasHead
      ? ['diff', '--no-ext-diff', '--binary', '--no-color', 'HEAD', '--', path]
      : ['diff', '--no-ext-diff', '--binary', '--no-color', '--', path];
  const result = await runGit(repositoryRoot, args, [0, 1]);
  return sha256(result.stdout);
}

/**
 * Observe without changing a repository. The only Git subcommands issued are
 * rev-parse, symbolic-ref, status, ls-files, and diff with --no-ext-diff.
 */
export async function observeGitReconciliation(
  repositoryRoot: string,
): Promise<GitReconciliationObservation> {
  const root = await requiredRepositoryRoot(repositoryRoot);
  const [commonDir, headObjectId, headReference, activeOperation, porcelain, unmergedOutput] =
    await Promise.all([
      runGit(root, ['rev-parse', '--git-common-dir']),
      optionalGitText(root, ['rev-parse', '-q', '--verify', 'HEAD']),
      optionalGitText(root, ['symbolic-ref', '-q', '--short', 'HEAD']),
      operation(root),
      runGit(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all']),
      runGit(root, ['ls-files', '-u', '-z']),
    ]);
  const commonGitDirectory = await realpath(resolve(root, text(commonDir.stdout)));
  const porcelainV2 = porcelain.stdout.toString('utf8');
  const porcelainPaths = pathsFromPorcelain(porcelainV2);
  const unmerged = indexStages(unmergedOutput.stdout.toString('utf8'));
  const observedPaths = new Set(porcelainPaths.paths);
  unmerged.forEach((entry) => observedPaths.add(entry.path));
  const untracked = new Set(porcelainPaths.untrackedPaths);
  const hasHead = headObjectId !== null;

  const paths = await Promise.all(
    [...observedPaths]
      .sort()
      .map(async (path): Promise<GitPathIdentity> => {
        const index = await runGit(root, ['ls-files', '-s', '-z', '--', path]);
        const [worktree, diffSha256] = await Promise.all([
          worktreeIdentity(root, path),
          diffIdentity(root, path, hasHead, untracked.has(path)),
        ]);
        return {
          path,
          pathSha256: sha256(path),
          indexBlobs: indexBlobs(index.stdout.toString('utf8')),
          ...worktree,
          diffSha256,
        };
      }),
  );

  return {
    schema: 1,
    source: {
      repositoryRoot: root,
      commonGitDirectory,
      headObjectId,
      headReference,
    },
    operation: activeOperation,
    porcelainV2,
    porcelainSha256: sha256(porcelain.stdout),
    unmerged,
    untrackedPaths: porcelainPaths.untrackedPaths,
    paths,
  };
}
