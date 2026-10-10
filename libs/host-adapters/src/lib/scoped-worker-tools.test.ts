import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  createScopedWorkerToolConfig,
  ScopedWorkerTools,
} from './scoped-worker-tools.js';

test('scoped worker tools confine reads, typed writes, metadata and linked files', async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'temari-scoped-tools-')),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const outside = join(root, 'outside.txt');
  await writeFile(outside, 'outside sentinel');
  await writeFile(join(workspace, 'owned.txt'), 'before');
  await writeFile(join(workspace, 'unowned.txt'), 'unowned sentinel');
  await mkdir(join(workspace, '.git'));
  await writeFile(join(workspace, '.git', 'config'), 'git sentinel');
  await symlink(outside, join(workspace, 'linked.txt'));
  await symlink(root, join(workspace, 'linked-dir'));
  await link(outside, join(workspace, 'hardlink.txt'));
  const audit = join(root, 'tool-calls.jsonl');
  await writeFile(audit, '');
  const config = await createScopedWorkerToolConfig(
    workspace,
    'workspace-write',
    [
      { kind: 'file', path: 'owned.txt' },
      { kind: 'file', path: 'hardlink.txt' },
      { kind: 'directory', path: 'src' },
    ],
    audit,
  );
  const tools = new ScopedWorkerTools(config);
  const before = await tools.read('owned.txt');
  assert.equal(before.text, 'before');
  await tools.invoke('write_file', {
    path: 'owned.txt',
    text: 'after',
    expectedSha256: before.sha256,
  });
  assert.equal((await tools.read('owned.txt')).text, 'after');
  await tools.write('src/new.txt', 'new', null);
  assert.equal(
    await readFile(join(workspace, 'src', 'new.txt'), 'utf8'),
    'new',
  );
  for (const path of [
    'unowned.txt',
    '../outside.txt',
    '.git/config',
    '.GIT/config',
    '.git./config',
    'agents.md',
    'linked.txt',
    'linked-dir/outside.txt',
    'hardlink.txt',
  ]) {
    await assert.rejects(tools.write(path, 'must not write', null));
  }
  for (const path of [
    '../outside.txt',
    outside,
    '.git/config',
    'linked.txt',
    'linked-dir/outside.txt',
    'hardlink.txt',
  ])
    await assert.rejects(tools.read(path));
  await assert.rejects(tools.write('owned.txt', 'stale write', before.sha256));
  assert.equal(await readFile(outside, 'utf8'), 'outside sentinel');
  assert.equal(
    await readFile(join(workspace, 'unowned.txt'), 'utf8'),
    'unowned sentinel',
  );
  assert.equal(
    await readFile(join(workspace, '.git', 'config'), 'utf8'),
    'git sentinel',
  );
  const listing = await tools.list();
  assert(
    !listing.entries.some(
      (entry) => entry.name === '.git' || entry.name === 'linked.txt',
    ),
  );
  const found = await tools.search('after');
  assert(found.matches.some((match) => match.path === 'owned.txt'));
  const retained = JSON.parse((await readFile(audit, 'utf8')).trim());
  assert.equal(retained.tool, 'write_file');
  assert.equal(retained.succeeded, true);
  assert.equal(retained.writeSha256, (await tools.read('owned.txt')).sha256);
  const readonly = new ScopedWorkerTools(
    await createScopedWorkerToolConfig(workspace, 'read-only'),
  );
  await assert.rejects(readonly.write('owned.txt', 'forbidden', null));
  await assert.rejects(
    createScopedWorkerToolConfig(workspace, 'workspace-write', [
      { kind: 'directory', path: '.git' },
    ]),
  );
});

test('scoped tool bounds and root identity refuse oversized or replaced sources', async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'temari-scoped-bounds-')),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  await writeFile(join(workspace, 'large.txt'), 'a'.repeat(256 * 1024 + 1));
  await writeFile(join(workspace, 'small.txt'), 'okay');
  const tools = new ScopedWorkerTools(
    await createScopedWorkerToolConfig(workspace, 'read-only'),
  );
  await assert.rejects(tools.read('large.txt'));
  await Promise.all(
    Array.from({ length: 205 }, (_, index) =>
      writeFile(join(workspace, `entry-${index}.txt`), ''),
    ),
  );
  const listing = await tools.list();
  assert.equal(listing.entries.length, 200);
  assert.equal(listing.truncated, true);
  for (let i = 0; i < 128; i++)
    await tools.invoke('read_file', { path: 'small.txt' });
  await assert.rejects(
    tools.invoke('read_file', { path: 'small.txt' }),
    /bound/,
  );
  const other = new ScopedWorkerTools(
    await createScopedWorkerToolConfig(workspace, 'read-only'),
  );
  const pending = Array.from({ length: 8 }, () =>
    other.invoke('read_file', { path: 'small.txt' }),
  );
  assert.throws(
    () => other.invoke('read_file', { path: 'small.txt' }),
    /concurrency/,
  );
  await Promise.all(pending);
  await rm(workspace, { recursive: true });
  await symlink(root, workspace);
  await assert.rejects(tools.read('small.txt'), /canonical|identity/);
});
test(
  'FIFO reads are refused without blocking the tool process',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'temari-scoped-fifo-')),
    );
    t.after(() => rm(root, { recursive: true, force: true }));
    const run = promisify(execFile);
    await run('mkfifo', [join(root, 'pipe')]);
    const source = pathToFileURL(
      resolve('libs/host-adapters/src/lib/scoped-worker-tools.ts'),
    ).href;
    const code = `import assert from 'node:assert/strict';import {ScopedWorkerTools,createScopedWorkerToolConfig} from ${JSON.stringify(source)};const tools=new ScopedWorkerTools(await createScopedWorkerToolConfig(${JSON.stringify(root)},'read-only'));await assert.rejects(tools.read('pipe'),/regular text file/);console.log('FIFO_REFUSED');`;
    const result = await run(
      process.execPath,
      [
        '--import',
        '@swc-node/register/esm-register',
        '--input-type=module',
        '--eval',
        code,
      ],
      { timeout: 3000, maxBuffer: 65536 },
    );
    assert.match(result.stdout, /FIFO_REFUSED/);
  },
);

test('cumulative output is bounded across individually valid file reads', async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'temari-scoped-output-')),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'within-limit.txt'), 'x'.repeat(256 * 1024));
  const tools = new ScopedWorkerTools(
    await createScopedWorkerToolConfig(root, 'read-only'),
  );
  for (let count = 0; count < 15; count++)
    await tools.invoke('read_file', { path: 'within-limit.txt' });
  await assert.rejects(
    tools.invoke('read_file', { path: 'within-limit.txt' }),
    /cumulative output bound/,
  );
});


test('file-scoped search retains line evidence and refuses linked, metadata and oversized files', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'temari-search-file-')));
  t.after(() => rm(root, {recursive:true, force:true}));
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  await writeFile(join(workspace, 'allowed.txt'), 'before\nneedle one\nneedle two\n');
  await writeFile(join(root, 'outside.txt'), 'needle secret');
  await symlink(join(root, 'outside.txt'), join(workspace, 'linked.txt'));
  await link(join(root, 'outside.txt'), join(workspace, 'hardlinked.txt'));
  await mkdir(join(workspace, '.git')); await writeFile(join(workspace, '.git', 'config'), 'needle secret');
  await writeFile(join(workspace, 'large.txt'), 'needle\n'.repeat(40000));
  const tools = new ScopedWorkerTools(await createScopedWorkerToolConfig(workspace, 'read-only'));
  assert.deepEqual(await tools.search('needle', 'allowed.txt'), {matches:[{path:'allowed.txt',line:2,text:'needle one'},{path:'allowed.txt',line:3,text:'needle two'}],truncated:false});
  for(const path of ['../outside.txt','linked.txt','hardlinked.txt','.git/config','large.txt']) await assert.rejects(tools.search('needle', path));
  await writeFile(join(workspace, 'many.txt'), 'needle\n'.repeat(41));
  const bounded = await tools.search('needle','many.txt'); assert.equal(bounded.matches.length,40); assert.equal(bounded.truncated,true);
});
