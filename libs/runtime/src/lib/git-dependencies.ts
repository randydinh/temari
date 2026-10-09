import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

/** Portable product evidence. Git administration and ignored payloads are not product files. */
export interface GitProductFile {
  readonly path: string;
  readonly mode: '100644' | '100755';
  readonly bytes: number;
  readonly sha256: string;
}
export interface PinnedDependency {
  readonly path: string;
  readonly commit: string;
  readonly files: readonly GitProductFile[];
}
export interface PinnedDependencyPlan {
  readonly schema: 'pinned-readonly-dependencies-v1';
  readonly gitmodules: GitProductFile | null;
  readonly dependencies: readonly PinnedDependency[];
}

export function localGit(
  root: string,
  args: readonly string[],
  input?: Buffer,
): Buffer {
  return execFileSync(
    'git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=false',
      '-C',
      root,
      ...args,
    ],
    {
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([name]) => !name.startsWith('GIT_'),
          ),
        ),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_NO_LAZY_FETCH: '1',
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_NO_REPLACE_OBJECTS: '1',
        GIT_ALLOW_PROTOCOL: 'file',
      },
      timeout: 120000,
      maxBuffer: 64 * 1024 * 1024,
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
}
const text = (root: string, ...args: string[]) =>
  localGit(root, args).toString('utf8').trim();
const digest = (bytes: Buffer | string) =>
  createHash('sha256').update(bytes).digest('hex');
function safePath(path: string): void {
  assert(
    path &&
      !isAbsolute(path) &&
      !/[\\\x00-\x1f\x7f:]/.test(path) &&
      path
        .split('/')
        .every(
          (part) =>
            part && part !== '.' && part !== '..' && !/^\.git$/i.test(part),
        ),
    `Unsafe Git path: ${path}`,
  );
}
function regularPath(root: string, path: string): string {
  safePath(path);
  let current = root;
  for (const part of path.split('/')) {
    current = join(current, part);
    assert(
      !lstatSync(current).isSymbolicLink(),
      `Symlink in Git product path: ${path}`,
    );
  }
  return current;
}
function isolatedObjects(commonDir: string): void {
  const objects = join(commonDir, 'objects');
  assert(
    lstatSync(objects).isDirectory() && !lstatSync(objects).isSymbolicLink(),
    'Git objects must use a regular local directory.',
  );
  const pending = [objects];
  while (pending.length) {
    const directory = pending.pop()!;
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      assert(
        !stat.isSymbolicLink() && (stat.isDirectory() || stat.isFile()),
        'Git objects must not redirect through symlinks or special files.',
      );
      if (stat.isDirectory()) pending.push(path);
    }
  }
  for (const name of ['alternates', 'http-alternates']) {
    try {
      assert.equal(
        readFileSync(join(objects, 'info', name)).length,
        0,
        'Borrowed Git objects are unsupported.',
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
function repository(root: string, dependency = false): void {
  assert(
    isAbsolute(root) &&
      lstatSync(root).isDirectory() &&
      !lstatSync(root).isSymbolicLink(),
    'Git root must be a regular absolute directory.',
  );
  assert.equal(
    realpathSync(text(root, 'rev-parse', '--show-toplevel')),
    realpathSync(root),
    'Dependency is not an initialized Git root.',
  );
  const admin = lstatSync(join(root, '.git'));
  assert(
    !admin.isSymbolicLink() && (admin.isFile() || admin.isDirectory()),
    'Unsupported Git administration path.',
  );
  // Incomplete/borrowed object databases are not eligible for offline copying.
  const gitDir = text(root, 'rev-parse', '--absolute-git-dir');
  assert.equal(
    realpathSync(gitDir),
    resolve(gitDir),
    'Symlink Git administration is unsupported.',
  );
  const commonDir = resolve(
    realpathSync(root),
    text(root, 'rev-parse', '--git-common-dir'),
  );
  assert.equal(
    realpathSync(commonDir),
    commonDir,
    'Symlink Git common administration is unsupported.',
  );
  // The application may be a managed worktree; each dependency must own its objects.
  if (dependency)
    assert.equal(
      commonDir,
      gitDir,
      'Git common administration must not be shared by dependencies.',
    );
  isolatedObjects(commonDir);
  assert.equal(
    text(root, 'rev-parse', '--is-shallow-repository'),
    'false',
    'Shallow dependencies are unsupported.',
  );
  for (const path of ['shallow']) {
    try {
      assert.equal(
        readFileSync(join(commonDir, path)).length,
        0,
        'Borrowed or shallow Git objects are unsupported.',
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
interface TreeEntry {
  path: string;
  mode: string;
  oid: string;
}
function parseEntries(raw: Buffer, index = false): TreeEntry[] {
  const entries = raw
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const match =
        /^(\d{6}) (?:blob |commit )?([0-9a-f]+)(?: (\d))?\t(.+)$/.exec(line);
      assert(
        match && (!index || match[3] === '0'),
        'Unsupported or unmerged Git entry.',
      );
      const path = match[4]!;
      safePath(path);
      return { mode: match[1]!, oid: match[2]!, path };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const seen = new Set<string>();
  const prefixes = new Map<string, string>();
  for (const entry of entries) {
    assert(
      !seen.has(entry.path.toLowerCase()),
      'Case-colliding Git paths are unsupported.',
    );
    seen.add(entry.path.toLowerCase());
    const parts = entry.path.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join('/');
      const existing = prefixes.get(prefix.toLowerCase());
      assert(
        existing === undefined || existing === prefix,
        'Case-colliding Git path components are unsupported.',
      );
      prefixes.set(prefix.toLowerCase(), prefix);
    }
  }
  return entries;
}
function tree(root: string, commit: string): TreeEntry[] {
  assert(
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit),
    'Expected full Git commit.',
  );
  return parseEntries(
    localGit(root, ['ls-tree', '-rz', '--full-tree', commit]),
  );
}
function index(root: string): TreeEntry[] {
  return parseEntries(localGit(root, ['ls-files', '--stage', '-z']), true);
}
function file(
  root: string,
  entry: TreeEntry,
  fromObject: boolean,
): GitProductFile {
  assert(
    entry.mode === '100644' || entry.mode === '100755',
    `Unsupported Git mode (nested dependencies and symlinks are unsupported): ${entry.path}`,
  );
  let bytes: Buffer;
  if (fromObject) bytes = localGit(root, ['cat-file', 'blob', entry.oid]);
  else {
    const path = regularPath(root, entry.path);
    const stat = lstatSync(path);
    assert(stat.isFile(), `Git product must be a regular file: ${entry.path}`);
    assert.equal(
      stat.mode & 0o100 ? '100755' : '100644',
      entry.mode,
      `Git product mode changed: ${entry.path}`,
    );
    assert(
      stat.size <= 64 * 1024 * 1024,
      'Git product file exceeds capture limit.',
    );
    bytes = readFileSync(path);
  }
  return {
    path: entry.path,
    mode: entry.mode,
    bytes: bytes.length,
    sha256: digest(bytes),
  };
}
function objectFiles(
  root: string,
  entries: readonly TreeEntry[],
): GitProductFile[] {
  assert(entries.length <= 10000, 'Dependencies exceed file capture limit.');
  for (const entry of entries)
    assert(
      entry.mode === '100644' || entry.mode === '100755',
      'Nested dependencies and symlinks are unsupported.',
    );
  if (!entries.length) return [];
  const output = localGit(
    root,
    ['cat-file', '--batch'],
    Buffer.from(entries.map((entry) => entry.oid).join('\n') + '\n'),
  );
  let offset = 0;
  const files = entries.map((entry) => {
    const end = output.indexOf(10, offset);
    assert(end >= 0, 'Incomplete local Git object response.');
    const header = output.subarray(offset, end).toString().split(' ');
    const bytes = Number(header[2]);
    assert(
      header[0] === entry.oid &&
        header[1] === 'blob' &&
        Number.isSafeInteger(bytes) &&
        bytes >= 0,
      'Missing or unsupported local Git object.',
    );
    offset = end + 1;
    assert(
      offset + bytes < output.length && output[offset + bytes] === 10,
      'Incomplete local Git blob.',
    );
    const sha256 = digest(output.subarray(offset, offset + bytes));
    offset += bytes + 1;
    return {
      path: entry.path,
      mode: entry.mode as GitProductFile['mode'],
      bytes,
      sha256,
    };
  });
  assert.equal(
    offset,
    output.length,
    'Unexpected trailing Git object response.',
  );
  return files;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function layout(root: string, commit: string) {
  const entries = tree(root, commit);
  const links = entries.filter((entry) => entry.mode === '160000');
  const modules = entries.find((entry) => entry.path === '.gitmodules');
  const gitmodules = modules ? file(root, modules, true) : null;
  if (links.length || modules) {
    assert(modules, 'Gitlinks require tracked .gitmodules.');
    const mappings = localGit(root, [
      'config',
      '--null',
      '--blob',
      `${commit}:.gitmodules`,
      '--get-regexp',
      '^submodule\\..*\\.path$',
    ])
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
      .map((record) => {
        const path = record.slice(record.indexOf('\n') + 1);
        safePath(path);
        return path;
      })
      .sort();
    assert.deepEqual(
      mappings,
      links.map((entry) => entry.path).sort(),
      'Every dependency must have exactly one tracked .gitmodules mapping.',
    );
  }
  return { links, gitmodules };
}

/** Observe only initialized, exact-pin, clean first-level regular-file dependencies. */
export function observePinnedDependencies(
  root: string,
  commit = text(root, 'rev-parse', 'HEAD'),
): PinnedDependencyPlan {
  repository(root);
  const { links, gitmodules } = layout(root, commit);
  const dependencies = links.map((link) => {
    const child = regularPath(root, link.path);
    repository(child, true);
    const gitDir = text(child, 'rev-parse', '--absolute-git-dir');
    const parentDir = realpathSync(
      resolve(root, text(root, 'rev-parse', '--git-common-dir')),
    );
    const rel = relative(parentDir, gitDir);
    assert(
      lstatSync(join(child, '.git')).isDirectory() ||
        (!rel.startsWith('..') && !isAbsolute(rel)),
      'Dependency gitfile must use the parent Git administration directory.',
    );
    return {
      path: link.path,
      commit: link.oid,
      files: objectFiles(child, tree(child, link.oid)),
    };
  });
  const files = dependencies.flatMap((dependency) => dependency.files);
  assert(
    files.length <= 10000 &&
      files.reduce((sum, item) => sum + item.bytes, 0) <= 64 * 1024 * 1024,
    'Dependencies exceed capture limits.',
  );
  const plan: PinnedDependencyPlan = freeze({
    schema: 'pinned-readonly-dependencies-v1',
    gitmodules,
    dependencies,
  });
  assert(
    Buffer.byteLength(JSON.stringify(plan)) <= 1024 * 1024,
    'Dependency evidence exceeds 1 MiB.',
  );
  verifyPinnedDependencies(root, plan);
  return plan;
}

/** Revalidate HEAD, index, actual bytes/modes and nonignored untracked files, regardless of Git ignore flags. */
export function verifyPinnedDependencies(
  root: string,
  plan: PinnedDependencyPlan,
): void {
  assert.equal(plan.schema, 'pinned-readonly-dependencies-v1');
  repository(root);
  const current = layout(root, text(root, 'rev-parse', 'HEAD'));
  assert.deepEqual(
    current.gitmodules,
    plan.gitmodules,
    'Committed .gitmodules changed.',
  );
  const expectedLinks = plan.dependencies.map((dep) => ({
    path: dep.path,
    mode: '160000',
    oid: dep.commit,
  }));
  assert.deepEqual(
    current.links,
    expectedLinks,
    'Committed dependency gitlinks changed.',
  );
  const staged = index(root);
  assert.deepEqual(
    staged.filter((entry) => entry.mode === '160000'),
    expectedLinks,
    'Dependency index gitlinks changed.',
  );
  const modules = staged.find((entry) => entry.path === '.gitmodules');
  if (plan.gitmodules) {
    assert(modules, '.gitmodules is missing.');
    assert.deepEqual(
      file(root, modules, true),
      plan.gitmodules,
      'Staged .gitmodules changed.',
    );
    assert.deepEqual(
      file(root, modules, false),
      plan.gitmodules,
      '.gitmodules bytes changed.',
    );
  } else {
    assert(!modules, 'Dependency creation is unsupported.');
    try {
      lstatSync(join(root, '.gitmodules'));
      throw new Error('Untracked .gitmodules is unsupported.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  for (const dep of plan.dependencies) {
    const child = regularPath(root, dep.path);
    repository(child, true);
    const admin = text(child, 'rev-parse', '--absolute-git-dir');
    const parentAdmin = realpathSync(
      resolve(root, text(root, 'rev-parse', '--git-common-dir')),
    );
    const adminRelative = relative(parentAdmin, admin);
    assert(
      lstatSync(join(child, '.git')).isDirectory() ||
        (!adminRelative.startsWith('..') && !isAbsolute(adminRelative)),
      'Dependency gitfile left parent administration.',
    );
    assert.equal(
      text(child, 'rev-parse', 'HEAD'),
      dep.commit,
      `Dependency pin changed: ${dep.path}`,
    );
    const expectedTree = tree(child, dep.commit);
    assert.deepEqual(
      index(child),
      expectedTree,
      `Dependency index changed: ${dep.path}`,
    );
    assert.deepEqual(
      objectFiles(child, expectedTree),
      dep.files,
      'Dependency objects changed.',
    );
    assert.deepEqual(
      expectedTree.map((entry) => file(child, entry, false)),
      dep.files,
      `Dependency tracked bytes changed: ${dep.path}`,
    );
    assert.equal(
      localGit(child, [
        'ls-files',
        '--others',
        '--exclude-per-directory=.gitignore',
        '-z',
      ]).length,
      0,
      `Dependency contains untracked files: ${dep.path}`,
    );
    assert.equal(
      localGit(child, [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--ignore-submodules=none',
      ]).length,
      0,
      `Dependency is dirty: ${dep.path}`,
    );
  }
}
export function dependencyPlanSha256(plan: PinnedDependencyPlan): string {
  return digest(JSON.stringify(plan));
}
export function assertDependencyOwnership(
  plan: PinnedDependencyPlan,
  paths: readonly { readonly path: string }[],
): void {
  for (const { path } of paths) {
    safePath(path);
    assert(
      path.toLowerCase() !== '.gitmodules' &&
        !plan.dependencies.some(
          (dep) =>
            path.toLowerCase() === dep.path.toLowerCase() ||
            path.toLowerCase().startsWith(`${dep.path.toLowerCase()}/`),
        ),
      `Read-only dependency ownership is forbidden: ${path}`,
    );
  }
}
export function observeGitProduct(
  root: string,
  plan = observePinnedDependencies(root),
): { scope: 'git-tracked-files-v1'; sha256: string } {
  verifyPinnedDependencies(root, plan);
  assert.equal(
    localGit(root, ['ls-files', '--others', '--exclude-standard', '-z']).length,
    0,
    'Git candidate has nonignored untracked files.',
  );
  const files = index(root)
    .filter((entry) => entry.mode !== '160000')
    .map((entry) => file(root, entry, false));
  assert(
    files.length <= 10000 &&
      files.reduce((sum, item) => sum + item.bytes, 0) <= 64 * 1024 * 1024,
    'Git candidate exceeds capture limits.',
  );
  return {
    scope: 'git-tracked-files-v1',
    sha256: digest(JSON.stringify(['git-tracked-files-v1', files, plan])),
  };
}
