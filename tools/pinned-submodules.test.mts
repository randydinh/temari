import { createHash } from 'node:crypto';
import { readdirSync, lstatSync } from 'node:fs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { observeCandidate } from '../libs/runtime/src/lib/candidate.js';
import {
  assertDependencyOwnership,
  observePinnedDependencies,
  preparePinnedDependencies,
  verifyPinnedDependencies,
  observeGitProduct,
} from './pinned-submodules.mjs';
function snapshot(root: string, prefix = ''): unknown[] {
  return readdirSync(join(root, prefix))
    .sort()
    .flatMap((name) => {
      const path = join(prefix, name);
      const info = lstatSync(join(root, path));
      return info.isDirectory()
        ? snapshot(root, path)
        : [
            [
              path,
              info.mode,
              createHash('sha256')
                .update(readFileSync(join(root, path)))
                .digest('hex'),
            ],
          ];
    });
}
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
function init(root: string, name: string) {
  const repo = join(root, name);
  git(root, 'init', '-q', repo);
  git(repo, 'config', 'user.name', 'Fixture');
  git(repo, 'config', 'user.email', 'fixture@localhost');
  writeFileSync(join(repo, 'product.txt'), 'pinned\n');
  writeFileSync(join(repo, '.gitignore'), 'private.txt\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'initial');
  return repo;
}
function fixture(t: { after: (fn: () => void) => void }, directory = false) {
  const root = mkdtempSync(join(tmpdir(), 'temari-pins-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = init(root, 'dependency-origin');
  const source = init(root, 'source');
  git(
    source,
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'add',
    '-q',
    origin,
    'app/deps/privacy',
  );
  git(source, 'commit', '-qam', 'dependency');
  const child = join(source, 'app/deps/privacy');
  if (directory) {
    const admin = git(child, 'rev-parse', '--absolute-git-dir');
    rmSync(join(child, '.git'));
    renameSync(admin, join(child, '.git'));
    git(child, '--work-tree', child, 'config', '--unset', 'core.worktree');
  }
  git(source, 'config', 'submodule.app/deps/privacy.ignore', 'all');
  writeFileSync(join(child, 'private.txt'), 'never copy\n');
  return {
    root,
    origin,
    source,
    child,
    commit: git(source, 'rev-parse', 'HEAD'),
  };
}
for (const directory of [false, true])
  test(`offline exact-pin preparation supports .git ${directory ? 'directory' : 'file'} and excludes private payloads`, (t) => {
    const f = fixture(t, directory);
    const sourceBefore = snapshot(f.source);
    const plan = observePinnedDependencies(f.source, f.commit);
    assert(
      Object.isFrozen(plan) && Object.isFrozen(plan.dependencies[0]!.files),
    );
    assert.equal(plan.dependencies.length, 1);
    const before = observeGitProduct(f.source);
    const target = join(f.root, 'target');
    git(f.root, 'clone', '-q', '--no-hardlinks', f.source, target);
    preparePinnedDependencies(f.source, target, plan);
    assert.equal(
      git(join(target, 'app/deps/privacy'), 'rev-parse', 'HEAD'),
      plan.dependencies[0]!.commit,
    );
    assert.throws(
      () => readFileSync(join(target, 'app/deps/privacy/private.txt')),
      /ENOENT/,
    );
    assert.deepEqual(observeGitProduct(target), before);
    assert.deepEqual(observeGitProduct(f.source), before);
    assert.deepEqual(
      snapshot(f.source),
      sourceBefore,
      'Source worktree and Git administration bytes must remain unchanged.',
    );
    // Relocation proves there are no shared object databases or external gitfiles.
    const relocated = join(f.root, 'relocated');
    renameSync(target, relocated);
    rmSync(f.origin, { recursive: true, force: true });
    verifyPinnedDependencies(relocated, plan);
    writeFileSync(join(relocated, '.git/description'), 'administration only');
    writeFileSync(
      join(relocated, 'app/deps/privacy/.git/description'),
      'administration only',
    );
    assert.deepEqual(observeGitProduct(relocated), before);
  });
for (const mutation of [
  'bytes',
  'mode',
  'untracked',
  'hidden-untracked',
  'index',
  'head',
  'missing',
  'uninitialized',
  'symlink',
  'gitlink',
  'gitmodules',
  'nested',
]) {
  test(`frozen dependency rejects ${mutation} despite ignored submodule status`, (t) => {
    const f = fixture(t);
    const plan = observePinnedDependencies(f.source);
    if (mutation === 'bytes') {
      git(f.child, 'update-index', '--assume-unchanged', 'product.txt');
      writeFileSync(join(f.child, 'product.txt'), 'changed');
    }
    if (mutation === 'mode') {
      git(f.child, 'config', 'core.filemode', 'false');
      chmodSync(join(f.child, 'product.txt'), 0o755);
    }
    if (mutation === 'untracked' || mutation === 'hidden-untracked')
      writeFileSync(join(f.child, 'new.txt'), 'new');
    if (mutation === 'hidden-untracked')
      writeFileSync(
        join(git(f.child, 'rev-parse', '--absolute-git-dir'), 'info/exclude'),
        'new.txt\n',
      );
    if (mutation === 'index') {
      writeFileSync(join(f.child, 'product.txt'), 'changed');
      git(f.child, 'add', '.');
    }
    if (
      mutation === 'head' ||
      mutation === 'gitlink' ||
      mutation === 'nested'
    ) {
      git(f.child, 'config', 'user.name', 'Fixture');
      git(f.child, 'config', 'user.email', 'fixture@localhost');
      if (mutation === 'nested')
        git(
          f.child,
          'update-index',
          '--add',
          '--cacheinfo',
          `160000,${plan.dependencies[0]!.commit},nested`,
        );
      else {
        writeFileSync(join(f.child, 'product.txt'), 'new commit');
        git(f.child, 'add', '.');
      }
      git(f.child, 'commit', '-qm', 'changed');
      if (mutation === 'gitlink') git(f.source, 'add', 'app/deps/privacy');
    }
    if (mutation === 'missing') rmSync(f.child, { recursive: true });
    if (mutation === 'uninitialized') rmSync(join(f.child, '.git'));
    if (mutation === 'symlink') {
      rmSync(join(f.child, 'product.txt'));
      symlinkSync(join(f.origin, 'product.txt'), join(f.child, 'product.txt'));
    }
    if (mutation === 'gitmodules')
      writeFileSync(
        join(f.source, '.gitmodules'),
        '[submodule "evil"]\npath = evil\n',
      );
    assert.throws(() => verifyPinnedDependencies(f.source, plan));
    if (mutation === 'nested') {
      git(f.source, 'add', 'app/deps/privacy');
      git(f.source, 'commit', '-qm', 'new pin');
      assert.throws(() => observePinnedDependencies(f.source), /nested/i);
    }
  });
}
test('dependency scopes and changed paths cannot be authorized by owning their parent', (t) => {
  const f = fixture(t);
  const plan = observePinnedDependencies(f.source);
  assertDependencyOwnership(plan, [{ path: 'app' }]);
  for (const path of [
    '.gitmodules',
    'app/deps/privacy',
    'app/deps/privacy/product.txt',
    'APP/DEPS/PRIVACY/product.txt',
    '../private',
    'app/.git/config',
  ])
    assert.throws(() => assertDependencyOwnership(plan, [{ path }]));
});
test('Git candidate scope preserves legacy regular-file identity semantics', async (t) => {
  const f = fixture(t, true);
  const scope = { scopeId: 'candidate', root: f.source };
  const legacy = await observeCandidate(scope);
  const product = await observeCandidate({
    ...scope,
    observation: 'git-tracked-files-v1',
  });
  writeFileSync(join(f.source, '.git/description'), 'changed admin');
  assert.notDeepEqual(await observeCandidate(scope), legacy);
  assert.deepEqual(
    await observeCandidate({ ...scope, observation: 'git-tracked-files-v1' }),
    product,
  );
  writeFileSync(join(f.source, 'product.txt'), 'application edit');
  assert.notDeepEqual(
    await observeCandidate({ ...scope, observation: 'git-tracked-files-v1' }),
    product,
  );
});

for (const mutation of [
  'child-symlink',
  'admin-symlink',
  'parent-commit',
  'mapping-path',
  'objects-missing',
  'case-collision',
])
  test(`dependency admission refuses unsupported ${mutation}`, (t) => {
    const f = fixture(t);
    const plan = observePinnedDependencies(f.source);
    if (mutation === 'child-symlink') {
      renameSync(f.child, join(f.root, 'moved'));
      symlinkSync(join(f.root, 'moved'), f.child);
    }
    if (mutation === 'admin-symlink') {
      renameSync(join(f.child, '.git'), join(f.child, 'gitfile'));
      symlinkSync('gitfile', join(f.child, '.git'));
    }
    if (mutation === 'parent-commit') {
      git(f.source, 'update-index', '--force-remove', 'app/deps/privacy');
      git(f.source, 'commit', '-qm', 'remove pin');
    }
    if (mutation === 'mapping-path') {
      writeFileSync(
        join(f.source, '.gitmodules'),
        '[submodule "unsafe"]\npath = ../outside\nurl = ignored\n',
      );
      git(f.source, 'add', '.gitmodules');
      git(f.source, 'commit', '-qm', 'unsafe path');
    }
    if (mutation === 'objects-missing')
      rmSync(join(git(f.child, 'rev-parse', '--absolute-git-dir'), 'objects'), {
        recursive: true,
      });
    if (mutation === 'case-collision') {
      const blob = git(f.source, 'rev-parse', 'HEAD:product.txt');
      git(
        f.source,
        'update-index',
        '--add',
        '--cacheinfo',
        `100644,${blob},APP/new.txt`,
      );
      git(f.source, 'commit', '-qm', 'case conflict');
    }
    assert.throws(() => verifyPinnedDependencies(f.source, plan));
    assert.throws(() => observePinnedDependencies(f.source));
  });

test('Git executable mode checks owner execute even when another execute bit remains', t => {
  const f = fixture(t);
  const path = join(f.child, 'product.txt');
  git(f.child, 'config', 'user.name', 'Fixture'); git(f.child, 'config', 'user.email', 'fixture@localhost');
  chmodSync(path, 0o755); git(f.child, 'add', 'product.txt'); git(f.child, 'commit', '-qm', 'executable');
  git(f.source, 'add', 'app/deps/privacy'); git(f.source, 'commit', '-qm', 'executable pin');
  const plan = observePinnedDependencies(f.source);
  git(f.child, 'config', 'core.filemode', 'false');
  chmodSync(path, 0o654);
  assert.throws(() => verifyPinnedDependencies(f.source, plan), /mode changed/);
});

for (const directory of [false, true])
  for (const mutation of [
    'objects-directory',
    'loose-directory',
    'loose-object',
    'pack-directory',
    'pack-file',
    'common-directory',
    'alternates',
    'http-alternates',
  ])
    test(`dependency object isolation rejects ${mutation} after freezing a .git ${directory ? 'directory' : 'file'} plan`, (t) => {
      const f = fixture(t, directory);
      const plan = observePinnedDependencies(f.source);
      const admin = git(f.child, 'rev-parse', '--absolute-git-dir');
      const objects = join(admin, 'objects');
      if (mutation === 'alternates' || mutation === 'http-alternates') {
        writeFileSync(join(objects, 'info', mutation), `${join(f.origin, '.git/objects')}\n`);
      } else if (mutation === 'common-directory') {
        const outside = join(f.root, 'borrowed-administration');
        cpSync(admin, outside, { recursive: true });
        writeFileSync(join(admin, 'commondir'), `${outside}\n`);
      } else {
        let redirected = objects;
        if (mutation.startsWith('pack-')) {
          git(f.child, 'gc', '--prune=now');
          redirected = join(objects, 'pack');
          if (mutation === 'pack-file') {
            const pack = readdirSync(redirected).find(name => name.endsWith('.pack'));
            assert(pack, 'Fixture must have a packed object file.');
            redirected = join(redirected, pack);
          }
        }
        if (mutation.startsWith('loose-')) {
          const fanout = readdirSync(objects).find(name => /^[0-9a-f]{2}$/.test(name));
          assert(fanout, 'Fixture must have a loose object directory.');
          redirected = join(objects, fanout);
          if (mutation === 'loose-object')
            redirected = join(redirected, readdirSync(redirected)[0]!);
        }
        const outside = join(f.root, 'borrowed-objects');
        renameSync(redirected, outside);
        symlinkSync(outside, redirected);
      }
      assert.throws(() => verifyPinnedDependencies(f.source, plan), /Git (objects|common administration)|Borrowed/);
      assert.throws(() => observePinnedDependencies(f.source), /Git (objects|common administration)|Borrowed/);
      assert.throws(() => observeGitProduct(f.source, plan), /Git (objects|common administration)|Borrowed/);
    });

test('object isolation preserves a managed application worktree with independent pinned dependencies', (t) => {
  const f = fixture(t);
  const plan = observePinnedDependencies(f.source);
  const managed = join(f.root, 'managed-application');
  git(f.source, 'worktree', 'add', '-q', '--detach', managed, f.commit);
  preparePinnedDependencies(f.source, managed, plan);
  verifyPinnedDependencies(managed, plan);
  assert.deepEqual(observeGitProduct(managed, plan), observeGitProduct(f.source, plan));
});
