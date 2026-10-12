import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify, isDeepStrictEqual } from 'node:util';

const execute = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');
// Mirrors the existing scoped worker admission boundary for both supported hosts.
const protectedSegments = new Set(['.git', '.claude', '.codex', '.agents', '.archon', '.temari', '.aws', '.ssh', '.mcp.json', 'node_modules', 'agents.md', 'claude.md']);
const protectedPath = path => path.split('/').some(part => protectedSegments.has(part.toLowerCase().replace(/[. ]+$/, '')) || part.toLowerCase().startsWith('.env'));
const lockfiles = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'];
function absolute(value, label) {
  assert(typeof value === 'string' && isAbsolute(value) && !value.includes('\0'), `${label} must be an absolute path.`);
  return value;
}
async function executable(value, label) {
  absolute(value, label);
  const path = await realpath(value); const stat = await lstat(path);
  assert(stat.isFile(), `${label} must be a regular executable file.`);
  return path;
}
function repoPath(value) {
  assert(typeof value === 'string' && value.length <= 1024 && value && !value.startsWith('/') && !value.includes('\\') && !/[\x00-\x1f\x7f]/.test(value), 'Select a safe repository-relative write path.');
  assert(value.split('/').every(part => part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git'), 'Select a safe repository-relative write path.');
  return value;
}
async function metadata(root, path) {
  try {
    const stat = await lstat(join(root, path));
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024 * 1024, `${path} must be a bounded regular file.`);
    const bytes = await readFile(join(root, path));
    assert(bytes.length <= 1024 * 1024, `${path} changed beyond the metadata bound.`);
    return bytes;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function executableIdentity(path) {
  if (!path) return null;
  const stat = await lstat(path);
  assert(stat.size <= 256 * 1024 * 1024, 'Selected runtime binary exceeds its identity bound.');
  return hash(await readFile(path));
}
async function gitRun(git, root, args) {
  const { stdout } = await execute(git, ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', root, ...args], { timeout: 10000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' });
  return stdout;
}

/** Reads bounded metadata and invokes only native Git; never executes project scripts. */
export async function discoverProject({ workspaceRoot, git, node, npmCli, packageManagers = {} }) {
  const root = await realpath(absolute(workspaceRoot, 'Workspace'));
  const reasons = [];
  if (!git) return { schema: 1, workspaceRoot: root, baseCommit: null, metadataSha256: null, checks: [], prepare: [], scopeCandidates: [], blockedReasons: ['Install Git before configuring isolated engineering tasks.'] };
  git = await executable(git, 'Git');
  let baseCommit, tracked, status;
  try {
    assert.equal(await realpath((await gitRun(git, root, ['rev-parse', '--show-toplevel'])).trim()), root, 'Select the Git repository root.');
    baseCommit = (await gitRun(git, root, ['rev-parse', '--verify', 'HEAD'])).trim();
    assert(/^[a-f0-9]{40,64}$/.test(baseCommit), 'Project requires a committed Git revision.');
    const raw = (await gitRun(git, root, ['ls-files', '--stage', '-z'])).split('\0').filter(Boolean);
    assert(raw.length <= 20000, 'Project tracked-file inventory exceeds the onboarding bound.');
    tracked = raw.map(line => {
      const match = /^(\d{6}) ([a-f0-9]{40,64}) ([0-3])\t([\s\S]+)$/.exec(line);
      assert(match && match[3] === '0', 'Resolve the Git index before onboarding.');
      return { mode: match[1], path: repoPath(match[4]) };
    });
    status = await gitRun(git, root, ['status', '--porcelain=v1', '--untracked-files=all']);
  } catch (error) { throw new Error(`Engineering onboarding requires a committed Git repository at its root: ${error.message}`); }
  if (status.trim()) reasons.push('Commit or preserve pending project changes before configuring isolated engineering tasks.');
  const records = [];
  for (const path of ['package.json', ...lockfiles]) {
    const bytes = await metadata(root, path);
    if (bytes) {
      assert(tracked.some(item => item.path === path && item.mode !== '120000'), `${path} must be committed before configuring engineering.`);
      records.push({ path, sha256: hash(bytes) });
    }
  }
  const packageBytes = await metadata(root, 'package.json');
  let pkg = null;
  if (packageBytes) { pkg = JSON.parse(packageBytes.toString('utf8')); assert(pkg && typeof pkg === 'object' && !Array.isArray(pkg), 'package.json must be an object.'); }
  const declared = typeof pkg?.packageManager === 'string' ? pkg.packageManager.split('@')[0] : null;
  const present = records.map(item => item.path);
  const manager = declared ?? (present.includes('pnpm-lock.yaml') ? 'pnpm' : present.includes('yarn.lock') ? 'yarn' : present.some(path => path.startsWith('bun.lock')) ? 'bun' : 'npm');
  assert(['npm', 'pnpm', 'yarn', 'bun'].includes(manager), 'Unsupported package manager; configure a supported Node project or use advanced host preparation.');
  const command = (program, args, timeoutMs = 600000) => ({ program, args, timeoutMs });
  let runner = null;
  if (manager === 'npm' && node && npmCli) {
    node = await executable(node, 'Node'); npmCli = await executable(npmCli, 'npm CLI');
    runner = { program: node, prefix: [npmCli], runtime: 'managed-npm' };
  } else if (packageManagers[manager]) {
    runner = { program: await executable(packageManagers[manager], manager), prefix: [], runtime: manager };
  }
  const requiresPreparation = Boolean(pkg && ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].some(key => pkg[key] && Object.keys(pkg[key]).length));
  const checks = [];
  if (pkg?.scripts) {
    assert(typeof pkg.scripts === 'object' && !Array.isArray(pkg.scripts) && Object.keys(pkg.scripts).length <= 200, 'Project scripts exceed the discovery bound.');
    for (const [name, script] of Object.entries(pkg.scripts).sort(([a], [b]) => a.localeCompare(b))) {
      if (!/^(?:test|build|lint|typecheck|check|verify)(?::[A-Za-z0-9._:-]+)?$/.test(name)) continue;
      assert(typeof script === 'string' && script.length <= 8192 && !script.includes('\0'), 'Project check script must be bounded text.');
      if (runner) {
        // npm explicitly executes the selected main script while suppressing implicit pre/post hooks.
        // Other managers differ by version/configuration: expose and pin every possible hook.
        const hooks = manager === 'npm' ? [] : [`pre${name}`, `post${name}`].filter(id => typeof pkg.scripts[id] === 'string').map(id => ({ id, script: pkg.scripts[id] }));
        for (const hook of hooks) assert(hook.script.length <= 8192 && !hook.script.includes('\0'), 'Project hook script must be bounded text.');
        checks.push({ id: name, label: `${manager} run ${name}${hooks.length ? ` (possible hooks: ${hooks.map(hook => hook.id).join(', ')})` : ''}`, script, hooks, hookPolicy: manager === 'npm' ? 'disabled' : 'visible-pinned-chain', runtime: runner.runtime, command: command(runner.program, [...runner.prefix, 'run', ...(manager === 'npm' ? ['--ignore-scripts'] : []), name]) });
      }
    }
  }
  const tests = tracked.filter(item => item.mode !== '120000' && item.mode !== '160000' && /(?:^|\/)[^/]+\.test\.mjs$/.test(item.path));
  if (node && tests.length > 0 && tests.length <= 64) {
    node = await executable(node, 'Node');
    checks.push({ id: 'node:test', label: 'Node built-in .test.mjs tests', script: null, runtime: 'managed-node', command: command(node, ['--test', ...tests.map(item => item.path)]) });
  }
  const prepare = [];
  const matchingLock = manager === 'npm' ? present.some(path => ['package-lock.json', 'npm-shrinkwrap.json'].includes(path)) : manager === 'pnpm' ? present.includes('pnpm-lock.yaml') : manager === 'bun' ? present.some(path => ['bun.lock', 'bun.lockb'].includes(path)) : present.includes('yarn.lock');
  if (runner && matchingLock) {
    const args = manager === 'npm' ? ['ci', '--ignore-scripts'] : manager === 'pnpm' ? ['install', '--frozen-lockfile', '--ignore-scripts'] : manager === 'bun' ? ['install', '--frozen-lockfile', '--ignore-scripts'] : null;
    if (args) prepare.push({ id: 'install-dependencies', label: `${manager} dependency installation with lifecycle scripts disabled`, runtime: runner.runtime, command: command(runner.program, [...runner.prefix, ...args]) });
  }
  if (pkg && runner && !prepare.length && requiresPreparation) reasons.push('Dependencies are required but no supported frozen installation was discovered; add a matching committed lockfile or prepare this project through the advanced host route.');
  if (pkg && !runner) reasons.push(`Install ${manager} or choose available Node built-in tests; project script checks require the selected package manager.`);
  if (!checks.length) reasons.push('No supported verification checks were discovered. Add a committed test/build/check script or Node .test.mjs tests.');
  const candidates = new Map();
  for (const item of tracked) {
    if (item.mode === '120000' || item.mode === '160000' || protectedPath(item.path)) continue;
    candidates.set(`file:${item.path}`, { kind: 'file', path: item.path });
    const parts = item.path.split('/');
    if (parts.length > 1) {
      const path = parts.slice(0, Math.min(parts.length - 1, 2)).join('/');
      if (!tracked.some(entry => (['120000', '160000'].includes(entry.mode) || protectedPath(entry.path)) && (entry.path === path || entry.path.startsWith(`${path}/`)))) candidates.set(`directory:${path}`, { kind: 'directory', path });
    }
  }
  const semanticCommand = candidate => ({ ...candidate, command: { ...candidate.command, program: candidate.runtime === 'managed-npm' || candidate.runtime === 'managed-node' ? 'managed:node' : candidate.command.program, args: candidate.runtime === 'managed-npm' ? ['managed:npm-cli', ...candidate.command.args.slice(1)] : candidate.command.args } });
  // Distribution relocation preserves runtime identity; final selected commands still use installed absolute paths.
  const runtimeIdentities = { node: await executableIdentity(node), npmCli: await executableIdentity(npmCli) };
  const metadataSha256 = hash(JSON.stringify({ root, baseCommit, tracked, records, manager, requiresPreparation, runtimeIdentities, checks: checks.map(semanticCommand), prepare: prepare.map(semanticCommand) }));
  return { schema: 1, workspaceRoot: root, git, node: node ?? null, npmCli: npmCli ?? null, packageManagers, baseCommit, metadataSha256, packageManager: manager, requiresPreparation, checks, prepare, scopeCandidates: [...candidates.values()].sort((a, b) => a.path.localeCompare(b.path)).slice(0, 200), blockedReasons: reasons, tracked };
}

async function validateScope(root, raw, tracked) {
  const scope = typeof raw === 'string' ? { kind: raw.endsWith('/') ? 'directory' : 'file', path: raw.replace(/\/$/, '') } : raw;
  assert(scope && Object.keys(scope).sort().join(',') === 'kind,path' && ['file', 'directory'].includes(scope.kind), 'Use typed file/directory scopes or a trailing slash for a directory.');
  repoPath(scope.path);
  assert(!protectedPath(scope.path), 'Write scope crosses a protected workspace boundary.');
  assert(scope.kind !== 'directory' || !tracked.some(item => item.path.startsWith(`${scope.path}/`) && protectedPath(item.path)), 'Write scope contains a protected tracked path.');
  const parts = scope.path.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const path = parts.slice(0, i).join('/');
    assert(!tracked.some(item => ['120000', '160000'].includes(item.mode) && (item.path === path || (scope.kind === 'directory' && item.path.startsWith(`${scope.path}/`)))), 'Write scopes cannot include symbolic links or submodules.');
    try {
      const stat = await lstat(join(root, path));
      assert(!stat.isSymbolicLink(), 'Write scope cannot traverse a symbolic link.');
      if (i < parts.length) assert(stat.isDirectory(), 'Write scope parent must be a directory.');
      else assert(scope.kind === 'directory' ? stat.isDirectory() : stat.isFile(), 'Write scope type does not match the project path.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { kind: scope.kind, path: scope.path };
}

/** Generates existing isolated implementation control, never starts or applies work. */
export async function createProjectOnboarding({ discovery, scopes, checks, prepare = [], worker, runtimeNode, runtimeNpmCli, timeoutMs = 600000, previousSelection }) {
  assert(discovery?.schema === 1 && discovery.git, 'Discover a Git project before selecting engineering configuration.');
  const current = await discoverProject(discovery);
  assert.equal(current.metadataSha256, discovery.metadataSha256, 'Project metadata or revision changed; start a new onboarding selection.');
  assert(current.baseCommit && !current.blockedReasons.some(reason => reason.startsWith('Commit or preserve')), 'Engineering requires a clean committed Git checkout.');
  assert(Array.isArray(scopes) && scopes.length >= 2 && scopes.length <= 4, 'Select two to four disjoint implementer scope groups.');
  const groups = [];
  for (const raw of scopes) {
    const group = Array.isArray(raw) ? raw : [raw];
    assert(group.length >= 1 && group.length <= 20, 'Select one to twenty scopes per implementer.');
    groups.push(await Promise.all(group.map(scope => validateScope(current.workspaceRoot, scope, current.tracked))));
  }
  const all = groups.flat();
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    const a = all[i], b = all[j], left = a.path.toLowerCase(), right = b.path.toLowerCase();
    assert(!(left === right || (a.kind === 'directory' && right.startsWith(`${left}/`)) || (b.kind === 'directory' && left.startsWith(`${right}/`))), 'Selected write scopes overlap, including case-folded paths.');
  }
  absolute(worker?.executable, 'Worker executable');
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 1800000, 'Worker timeout must be from one second to thirty minutes.');
  const select = (ids, available, required) => {
    assert(Array.isArray(ids) && ids.length <= 10 && (!required || ids.length >= 1) && new Set(ids).size === ids.length, 'Select bounded distinct discovered checks and preparation steps.');
    return ids.map(id => {
      const candidate = available.find(item => item.id === id); assert(candidate, 'Select an existing discovered command ID.');
      const result = structuredClone(candidate.command);
      if (candidate.runtime === 'managed-node' || candidate.runtime === 'managed-npm') { if (runtimeNode) result.program = absolute(runtimeNode, 'Installed Node'); }
      if (candidate.runtime === 'managed-npm' && runtimeNpmCli) result.args[0] = absolute(runtimeNpmCli, 'Installed npm CLI');
      return result;
    });
  };
  const selectedPrepare = select(prepare, current.prepare, false), selectedChecks = select(checks, current.checks, true);
  if (current.requiresPreparation) {
    assert(current.prepare.some(candidate => candidate.id === 'install-dependencies'), 'Selected project checks require dependencies in isolated clones. Commit a supported matching lockfile and supply its package manager before configuring engineering.');
    assert(prepare.includes('install-dependencies'), 'Selected project checks require install-dependencies preparation because isolated clones do not copy existing node_modules.');
  }
  const selection = { schema: 1, workspaceRoot: current.workspaceRoot, baseCommit: current.baseCommit, metadataSha256: current.metadataSha256, scopes: groups, checks: [...checks], prepare: [...prepare], commands: { prepare: selectedPrepare, verify: selectedChecks }, worker: structuredClone(worker), timeoutMs };
  if (previousSelection) assert(isDeepStrictEqual(selection, previousSelection), 'Onboarding choices changed; use a new installation instead of silently changing pinned engineering permissions.');
  const brief = (goal, scope, reviewer = false) => ({ goal, context: 'Follow the user goal supplied when preparing this task. Work stays in isolated candidates; coordinator review is required before source application or publication.', scope, acceptanceCriteria: ['Meet the selected goal within the explicit owned paths.', 'Report concrete changes, checks and unresolved evidence gaps.'], verificationCommand: null, reportFormat: 'json', forbiddenActions: reviewer ? ['Do not edit files, install dependencies, commit or publish.', 'Do not run mutating commands.'] : ['Do not edit unowned paths, change Git HEAD, commit, publish or apply changes to the source checkout.', 'Do not install dependencies; selected host preparation owns dependency setup.'] });
  const assignments = groups.map((owns, index) => ({ owns, worker: { id: `project-implementer-${index + 1}`, role: 'implementer', required: true, brief: brief('Implement the selected goal within your explicit ownership. Check scope-local acceptance; combined checks run after integration.', owns.map(scope => `${scope.kind}:${scope.path}`).join(', ')) } }));
  const implementation = { executable: worker.executable, ...(worker.providerSelection ? { providerSelection: structuredClone(worker.providerSelection) } : {}), ...(worker.scopedToolServer ? { scopedToolServer: structuredClone(worker.scopedToolServer) } : {}), maxConcurrency: groups.length, timeoutMs, plans: [{ id: 'guided-project', title: 'Configured project engineering', description: 'Explicit disjoint scopes, selected project checks, isolated implementation candidates and an independent reviewer. Result needs coordinator review.', assignments, prepare: selectedPrepare, verify: selectedChecks, reviewer: { id: 'project-independent-review', role: 'reviewer', required: true, brief: brief('Review the exact combined candidate and retained check evidence for concrete defects and missing requirements.', all.map(scope => `${scope.kind}:${scope.path}`).join(', '), true) } }] };
  return { schema: 1, selection, implementation };
}
