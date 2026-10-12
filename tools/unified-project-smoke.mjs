import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const { values } = parseArgs({ options: { distribution: { type: 'string' }, 'expected-manifest-sha256': { type: 'string' } } });
const distribution = await realpath(values.distribution), execute = promisify(execFile);
const manifest = JSON.parse(await readFile(join(distribution, 'UNIFIED.json')));
const { installManagedProvider } = await import(pathToFileURL(join(distribution, 'installer/providers.mjs')));
const providers = [];
for (const kind of ['codex', 'claude-code']) {
  const observed = await installManagedProvider({ root: distribution, manifest, kind });
  providers.push({ kind, version: observed.version, executableSha256: observed.executableSha256 });
}
const root = await realpath(await mkdtemp(join(tmpdir(), 'temari-project-recipient-')));
const workspace = join(root, 'project'), home = join(root, 'home'), configHome = join(root, 'codex');
await mkdir(workspace); await mkdir(configHome);
const node = join(distribution, manifest.assets.node.executable), executable = join(root, 'codex-fixture');
let started = false;
const model = createServer(async (request, response) => {
  response.setHeader('content-type', 'application/json');
  if (request.url === '/api/tags') response.end(JSON.stringify({ models: [{ name: 'fixture-chat' }] }));
  else if (request.url === '/api/chat') { for await (const chunk of request) { /* Drain harmless probe. */ } response.end(JSON.stringify({ done: true, message: { role: 'assistant', content: 'OK' } })); }
  else response.writeHead(404).end();
});
await new Promise(done => model.listen(0, '127.0.0.1', done));
const env = { ...process.env, PATH: '/usr/bin:/bin', CODEX_HOME: configHome };
const command = async (file, args) => JSON.parse((await execute(file, args, { env, timeout: 180000, maxBuffer: 4 * 1024 * 1024 })).stdout);
try {
  await writeFile(join(workspace, 'package.json'), JSON.stringify({ name: 'temari-fixture-project', version: '1.0.0', private: true, type: 'module', dependencies: { 'fixture-dependency': 'file:./dependency' }, scripts: { test: 'node verify.mjs', pretest: 'node forbidden-hook.mjs' } }));
  await mkdir(join(workspace, 'dependency'));
  await writeFile(join(workspace, 'dependency/package.json'), JSON.stringify({ name: 'fixture-dependency', version: '1.0.0', type: 'module', exports: './index.mjs' }));
  await writeFile(join(workspace, 'dependency/index.mjs'), 'export const dependencyValue = 3;\n');
  await writeFile(join(workspace, '.gitignore'), 'node_modules/\n');
  await execute(node, [join(distribution, 'runtime/node/lib/node_modules/npm/bin/npm-cli.js'), 'install', '--package-lock-only', '--ignore-scripts', '--offline'], { cwd: workspace, env, timeout: 30000 });
  await writeFile(join(workspace, 'forbidden-hook.mjs'), "throw new Error('Unselected lifecycle hook must not execute.');\n");
  await writeFile(join(workspace, 'alpha.mjs'), 'export const value = 0;\n');
  await writeFile(join(workspace, 'beta.mjs'), 'export const value = 0;\n');
  await writeFile(join(workspace, 'verify.mjs'), "import assert from 'node:assert/strict'; import {dependencyValue} from 'fixture-dependency'; import {value as a} from './alpha.mjs'; import {value as b} from './beta.mjs'; assert.equal(a,1); assert.equal(b,2); assert.equal(a+b,dependencyValue); console.log('Both selected changes and prepared dependency verified.');\n");
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base']]) await execute('git', args, { cwd: workspace });
  const base = (await execute('git', ['rev-parse', 'HEAD'], { cwd: workspace })).stdout.trim();
  await writeFile(join(configHome, 'models_cache.json'), JSON.stringify({ client_version: '0.154.0', fetched_at: new Date().toISOString(), models: [{ slug: 'fixture-coder', default_reasoning_level: 'high', supported_reasoning_levels: [{ effort: 'high' }] }] }));
  await writeFile(executable, `#!${node}
import assert from 'node:assert/strict'; import {readFileSync,writeFileSync} from 'node:fs';
const args=process.argv.slice(2);
if(args[0]==='--version'){console.log('codex-cli 0.154.0');process.exit(0);}
if(args[0]==='login'){console.log('Logged in using ChatGPT');process.exit(0);}
assert.equal(args[0],'exec');let prompt='';process.stdin.on('data',chunk=>prompt+=chunk);process.stdin.on('end',()=>{
 if(args[args.indexOf('--sandbox')+1]==='workspace-write'){
  const path=prompt.match(/Owned paths:\\nfile: ([^\\n]+)/)?.[1];assert(['alpha.mjs','beta.mjs'].includes(path));
  writeFileSync(path,'export const value = '+(path==='alpha.mjs'?1:2)+';\\n');
 }else{
  assert.match(readFileSync('alpha.mjs','utf8'),/value = 1/); assert.match(readFileSync('beta.mjs','utf8'),/value = 2/);
 }
 writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({status:'PASS',summary:'Scoped fixture changes or independent review completed.'}));
 console.log(JSON.stringify({type:'fixture.complete'}));
});
`, { mode: 0o700 });
  const args = ['guide', '--home', home, '--workspace', workspace, '--expected-manifest-sha256', values['expected-manifest-sha256'], '--chat', 'ollama', '--model', 'fixture-chat', '--ollama-url', `http://127.0.0.1:${model.address().port}`, '--worker', 'codex', '--worker-executable', executable, '--worker-model', 'fixture-coder', '--worker-reasoning', 'high', '--clients', 'none', '--engineering', 'configure', '--write-scope', 'alpha.mjs', '--write-scope', 'beta.mjs', '--check', 'test', '--prepare', 'install-dependencies', '--port', '0', '--no-start'];
  const installed = await command(join(distribution, 'setup'), args);
  assert.equal(installed.engineering.status, 'configured');
  await command(join(distribution, 'setup'), args);
  const launcher = join(home, 'temari'), runtime = await command(launcher, ['start']); started = true;
  const initial = await (await fetch(runtime.url + '/api/dashboard')).json();
  const post = async (path, body) => { const response = await fetch(runtime.url + path, { method: 'POST', headers: { origin: runtime.url, 'content-type': 'application/json', 'x-temari-token': initial.csrfToken }, body: JSON.stringify(body) }); const result = await response.json(); assert(response.ok, JSON.stringify(result)); return result; };
  const task = await post('/api/tasks', { requestId: 'project-onboarding', mode: 'implementation', planId: 'guided-project', title: 'Implement values', goal: 'Set alpha.mjs value to 1 and beta.mjs value to 2. Preserve verify.mjs.' });
  await post(`/api/tasks/${task.taskId}/actions`, { requestId: 'start-project-onboarding', action: 'implementation-start', expectedVersion: task.version });
  let implementation;
  for (let i = 0; i < 1200; i++) {
    const snapshot = await (await fetch(runtime.url + '/api/dashboard')).json(); implementation = snapshot.config.controls[task.taskId].implementation;
    if (['COMPLETE', 'FAILED', 'RECOVERY_REQUIRED', 'CANCELLED'].includes(implementation.state)) break;
    await new Promise(done => setTimeout(done, 100));
  }
  assert.equal(implementation.state, 'COMPLETE', JSON.stringify(implementation));
  assert.equal(implementation.receipt.status, 'PASS');
  assert.equal((await execute('git', ['rev-parse', 'HEAD'], { cwd: workspace })).stdout.trim(), base);
  assert.equal((await execute('git', ['status', '--porcelain'], { cwd: workspace })).stdout.trim(), '');
  assert.equal(await readFile(join(workspace, 'alpha.mjs'), 'utf8'), 'export const value = 0;\n');
  console.log(JSON.stringify({ status: 'PASS', providers, onboarding: 'guide options only; exact retry; two isolated builders; frozen npm preparation of real dependency; selected check without hidden hooks; independent reviewer; source unchanged', execution: 'provider CLI fixture; no live account claims' }));
} finally {
  if (started) await command(join(home, 'temari'), ['stop']).catch(() => {});
  model.closeAllConnections(); await new Promise(done => model.close(done));
  await rm(root, { recursive: true, force: true });
}
