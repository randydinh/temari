import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, realpath, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { discoverProject, createProjectOnboarding } from './project.mjs';

const run = promisify(execFile);
const git = (await run('/usr/bin/env', ['which', 'git'])).stdout.trim();
const node = process.execPath;
async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'temari-project-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src')); await mkdir(join(root, 'tests'));
  await writeFile(join(root, 'src', 'a.mjs'), 'export const a=1;\n');
  await writeFile(join(root, 'src', 'b.mjs'), 'export const b=2;\n');
  await writeFile(join(root, 'tests', 'a.test.mjs'), "import test from 'node:test'; test('ok',()=>{});\n");
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { test: 'node --test', build: 'node -e "throw Error()"', postinstall: 'node -e "throw Error()"' }, ...overrides }));
  await writeFile(join(root, 'package-lock.json'), '{"name":"fixture","lockfileVersion":3,"packages":{}}');
  const npmCli = join(root, 'npm-cli-fixture.mjs'); await writeFile(npmCli, '// Never run during discovery.\n');
  await run(git, ['init', root]);
  await run(git, ['-C', root, 'add', '.']);
  await run(git, ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
  return { root, npmCli, input: { workspaceRoot: root, git, node, npmCli } };
}
const worker = { executable: process.execPath };
const options = discovery => ({ discovery, scopes: ['src/a.mjs', 'src/b.mjs'], checks: ['test'], prepare: ['install-dependencies'], worker });

test('discovers scripts and tracked scopes without invoking scripts; generates isolated typed plan', async t => {
  const f = await fixture(t, { scripts: { test: 'touch discovery-must-not-run', 'lint:ci': 'eslint .', postinstall: 'touch discovery-must-not-run', '-test': 'false' } });
  const discovery = await discoverProject(f.input);
  assert.equal(discovery.blockedReasons.length, 0);
  assert.deepEqual(discovery.checks.map(item => item.id), ['lint:ci', 'test', 'node:test']);
  assert(discovery.scopeCandidates.some(item => item.kind === 'directory' && item.path === 'src'));
  assert.equal(await readFile(join(f.root, 'package.json'), 'utf8').then(text => text.includes('touch')), true);
  const guided = await createProjectOnboarding({ ...options(discovery), runtimeNode: '/future/home/runtime/node/bin/node', runtimeNpmCli: '/future/home/runtime/node/lib/node_modules/npm/bin/npm-cli.js' });
  const plan = guided.implementation.plans[0];
  assert.equal(plan.assignments.length, 2); assert.equal(plan.reviewer.id, 'project-independent-review');
  assert.deepEqual(plan.assignments[0].owns, [{ kind: 'file', path: 'src/a.mjs' }]);
  assert.deepEqual(plan.verify[0], { program: '/future/home/runtime/node/bin/node', args: ['/future/home/runtime/node/lib/node_modules/npm/bin/npm-cli.js', 'run', '--ignore-scripts', 'test'], timeoutMs: 600000 });
  assert.deepEqual(plan.prepare[0].args.slice(1), ['ci', '--ignore-scripts']);
  assert.equal(plan.assignments[0].worker.brief.verificationCommand, null);
  assert.match(plan.description, /needs coordinator review/);
  assert.equal((await run(git, ['-C', f.root, 'status', '--porcelain'])).stdout, '');
});

test('rejects metadata, base revision, selected checks or permissions drift across retries', async t => {
  const f = await fixture(t); const discovery = await discoverProject(f.input);
  const first = await createProjectOnboarding(options(discovery));
  await createProjectOnboarding({ ...options(discovery), previousSelection: first.selection });
  await assert.rejects(createProjectOnboarding({ ...options(discovery), checks: ['build'], previousSelection: first.selection }), /choices changed/);
  await writeFile(join(f.root, 'package.json'), '{}');
  await assert.rejects(createProjectOnboarding(options(discovery)), /metadata or revision changed/);
});

test('rejects dirty Git, absent verification, arbitrary commands and duplicate IDs', async t => {
  const f = await fixture(t); let discovery = await discoverProject(f.input);
  await assert.rejects(createProjectOnboarding({ ...options(discovery), checks: [] }), /bounded distinct/);
  await assert.rejects(createProjectOnboarding({ ...options(discovery), checks: ['test', 'test'] }), /bounded distinct/);
  await assert.rejects(createProjectOnboarding({ ...options(discovery), checks: ['node -e malicious'] }), /existing discovered/);
  await writeFile(join(f.root, 'untracked.txt'), 'pending'); discovery = await discoverProject(f.input);
  assert(discovery.blockedReasons.some(reason => reason.startsWith('Commit')));
  await assert.rejects(createProjectOnboarding(options(discovery)), /clean committed/);
});

test('rejects root, traversal, overlap, case overlap, wrong typed paths and too few scopes', async t => {
  const f = await fixture(t); const discovery = await discoverProject(f.input);
  for (const scopes of [['./', 'src/b.mjs'], ['../escape', 'src/b.mjs'], ['src/', 'src/b.mjs'], ['src/A.mjs', 'src/a.mjs'], ['src/a.mjs/', 'src/b.mjs'], ['src/a.mjs'], ['.git/config', 'src/a.mjs']]) {
    await assert.rejects(createProjectOnboarding({ ...options(discovery), scopes }), /safe repository|overlap|type does not match|two to four/);
  }
});

test('rejects scope traversing symlink or containing tracked symbolic links', async t => {
  const f = await fixture(t); await symlink(dirname(f.root), join(f.root, 'linked'));
  await run(git, ['-C', f.root, 'add', 'linked']);
  await run(git, ['-C', f.root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'link']);
  const discovery = await discoverProject(f.input);
  await assert.rejects(createProjectOnboarding({ ...options(discovery), scopes: ['linked/escape.mjs', 'src/b.mjs'] }), /symbolic links/);
});

test('missing Git and unsupported metadata explain capability prerequisites', async t => {
  const f = await fixture(t);
  const absent = await discoverProject({ workspaceRoot: f.root, node });
  assert.equal(absent.baseCommit, null); assert.match(absent.blockedReasons[0], /Install Git/);
  await assert.rejects(createProjectOnboarding(options(absent)), /Discover a Git project/);
  await writeFile(join(f.root, 'package.json'), JSON.stringify({ packageManager: 'unknown@1', scripts: { test: 'true' } }));
  await assert.rejects(discoverProject(f.input), /Unsupported package manager/);
});

test('managed Node built-in checks remain available when project package manager is missing', async t => {
  const f = await fixture(t, { packageManager: 'pnpm@10' });
  const discovery = await discoverProject(f.input);
  assert(discovery.blockedReasons.some(reason => reason.startsWith('Install pnpm')));
  assert.deepEqual(discovery.checks.map(item => item.id), ['node:test']);
  const result = await createProjectOnboarding({ ...options(discovery), checks: ['node:test'], prepare: [] });
  assert.deepEqual(result.implementation.plans[0].verify[0].args, ['--test', 'tests/a.test.mjs']);
});

test('non-Node projects expose a supported-check gap rather than inventing commands', async t => {
  const f = await fixture(t); await rm(join(f.root, 'package.json')); await rm(join(f.root, 'package-lock.json')); await rm(join(f.root, 'tests', 'a.test.mjs'));
  await run(git, ['-C', f.root, 'add', '-A']); await run(git, ['-C', f.root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'remove Node']);
  const discovery = await discoverProject(f.input);
  assert.equal(discovery.checks.length, 0); assert.match(discovery.blockedReasons.at(-1), /No supported verification/);
});

test('selected npm check runs its main script while suppressing undisclosed pre/post hooks', async t => {
  const actualNpm = await realpath((await run('/usr/bin/env', ['which', 'npm'])).stdout.trim());
  const f = await fixture(t, { scripts: { pretest: `node -e "require('fs').writeFileSync('pre-marker','ran')"`, test: `node -e "require('fs').writeFileSync('main-marker','ran')"`, posttest: `node -e "require('fs').writeFileSync('post-marker','ran')"` } });
  const discovery = await discoverProject({ ...f.input, npmCli: actualNpm });
  assert.equal(discovery.checks.find(item => item.id === 'test').hookPolicy, 'disabled');
  const generated = await createProjectOnboarding({ ...options(discovery), prepare: [] });
  const command = generated.implementation.plans[0].verify[0];
  await run(command.program, command.args, { cwd: f.root });
  assert.equal(await readFile(join(f.root, 'main-marker'), 'utf8'), 'ran');
  await assert.rejects(readFile(join(f.root, 'pre-marker')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(f.root, 'post-marker')), { code: 'ENOENT' });
});

test('non-npm script checks expose and pin possible lifecycle hook chains', async t => {
  const f = await fixture(t, { packageManager: 'bun@1', scripts: { pretest: 'before-hook', test: 'main-check', posttest: 'after-hook' } });
  const discovery = await discoverProject({ ...f.input, packageManagers: { bun: node } });
  const check = discovery.checks.find(item => item.id === 'test');
  assert.deepEqual(check.hooks, [{ id: 'pretest', script: 'before-hook' }, { id: 'posttest', script: 'after-hook' }]);
  assert.match(check.label, /pretest, posttest/);
});

test('managed runtime relocation preserves metadata identity and installed command choices', async t => {
  const f = await fixture(t);
  const alternate = await mkdtemp(join(tmpdir(), 'temari-project-runtime-')); t.after(() => rm(alternate, { recursive: true, force: true }));
  const fakeNode = join(alternate, 'node-original'), relocatedNode = join(alternate, 'node-relocated'), relocatedNpm = join(alternate, 'npm-relocated.mjs');
  await writeFile(fakeNode, 'same-runtime'); await writeFile(relocatedNode, 'same-runtime'); await writeFile(relocatedNpm, await readFile(f.npmCli));
  const first = await discoverProject({ ...f.input, node: fakeNode });
  const relocated = await discoverProject({ ...f.input, node: relocatedNode, npmCli: relocatedNpm });
  assert.equal(first.metadataSha256, relocated.metadataSha256);
  const installed = { runtimeNode: '/future/installation/node', runtimeNpmCli: '/future/installation/npm-cli.mjs' };
  const generated = await createProjectOnboarding({ ...options(first), ...installed });
  await createProjectOnboarding({ ...options(relocated), ...installed, previousSelection: generated.selection });
});

test('dependency-bearing script checks require matching frozen preparation in isolated clones', async t => {
  const f = await fixture(t, { dependencies: { 'local-fixture': 'file:./dependency' } });
  const discovery = await discoverProject(f.input);
  assert.equal(discovery.requiresPreparation, true);
  await assert.rejects(createProjectOnboarding({ ...options(discovery), prepare: [] }), /require install-dependencies/);
  await assert.rejects(createProjectOnboarding({ ...options(discovery), checks: ['node:test'], prepare: [] }), /require install-dependencies/);
  await createProjectOnboarding(options(discovery));
  await rm(join(f.root, 'package-lock.json')); await run(git, ['-C', f.root, 'add', '-A']);
  await run(git, ['-C', f.root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'missing lock']);
  const absentLock = await discoverProject(f.input);
  await assert.rejects(createProjectOnboarding({ ...options(absentLock), prepare: [] }), /supported matching lockfile/);
});

test('known scoped-worker protected paths are rejected before saving project control', async t => {
  const f = await fixture(t); const discovery = await discoverProject(f.input);
  for (const path of ['node_modules/new.mjs', '.temari/control.json', '.codex/config.toml', '.claude/notes', '.agents/skill', '.aws/config', '.ssh/id', '.env.production', 'docs/AGENTS.md', 'docs/CLAUDE.md', 'docs/.mcp.json', 'NODE_MODULES./new.mjs']) {
    await assert.rejects(createProjectOnboarding({ ...options(discovery), scopes: [path, 'src/b.mjs'] }), /protected workspace/);
  }
});

test('selected frozen npm preparation supplies a local dependency to an isolated clone', async t => {
  const actualNpm = await realpath((await run('/usr/bin/env', ['which', 'npm'])).stdout.trim());
  const f = await fixture(t, { dependencies: { 'local-fixture': 'file:./dependency' }, scripts: { test: `node -e "require('node:assert/strict').equal(require('local-fixture').value,42)"` } });
  await mkdir(join(f.root, 'dependency'));
  await writeFile(join(f.root, 'dependency', 'package.json'), JSON.stringify({ name: 'local-fixture', version: '1.0.0', main: 'index.cjs' }));
  await writeFile(join(f.root, 'dependency', 'index.cjs'), 'module.exports={value:42};\n');
  const env = { ...process.env, npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false' };
  await run(node, [actualNpm, 'install', '--package-lock-only', '--ignore-scripts', '--offline'], { cwd: f.root, env });
  await run(git, ['-C', f.root, 'add', '-A']);
  await run(git, ['-C', f.root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'local dependency lock']);
  const discovery = await discoverProject({ ...f.input, npmCli: actualNpm });
  const generated = await createProjectOnboarding(options(discovery));
  const cloneRoot = await mkdtemp(join(tmpdir(), 'temari-project-clone-')); t.after(() => rm(cloneRoot, { recursive: true, force: true }));
  const clone = join(cloneRoot, 'candidate'); await run(git, ['clone', '--no-hardlinks', f.root, clone]);
  const plan = generated.implementation.plans[0];
  await assert.rejects(run(plan.verify[0].program, plan.verify[0].args, { cwd: clone, env }), /Command failed/);
  await run(plan.prepare[0].program, plan.prepare[0].args, { cwd: clone, env });
  await run(plan.verify[0].program, plan.verify[0].args, { cwd: clone, env });
  assert.equal((await run(git, ['-C', f.root, 'status', '--porcelain'])).stdout, '');
});
