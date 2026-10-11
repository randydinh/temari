import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, promisify } from 'node:util';

const { values } = parseArgs({ options: { distribution: { type: 'string' }, 'expected-manifest-sha256': { type: 'string' } } });
const root = await realpath(await mkdtemp(join(tmpdir(), 'temari-guided-recipient-')));
const home = join(root, 'home'), workspace = join(root, 'project'); await mkdir(workspace);
let readResult, discovered, modelError, started = false, calls = 0;
const model = createServer(async (request, response) => {
  try {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/tags') { response.end(JSON.stringify({ models: [{ name: 'guided-fixture' }] })); return; }
    assert.equal(request.url, '/api/chat');
    let input = ''; for await (const chunk of request) input += chunk;
    const packet = JSON.parse(input);
    let message = { role: 'assistant', content: 'OK' };
    if (packet.messages[0]?.content !== 'Reply with OK.') {
      calls++;
      if (calls === 1) message = { role: 'assistant', content: '', tool_calls: [{ function: { name: 'temari_host_1', arguments: { query: 'Temari starter library' } } }] };
      else if (calls === 2) {
        discovered = JSON.parse(packet.messages.at(-1).content)[0].value;
        const doc = discovered.documents.find(document => document.path === 'welcome.md'); assert(doc);
        message = { role: 'assistant', content: '', tool_calls: [{ function: { name: 'temari_host_2', arguments: { sourceId: doc.source_id, path: doc.path, generation: doc.generation, sha256: doc.sha256 } } }] };
      } else {
        if (calls === 3) readResult = JSON.parse(packet.messages.at(-1).content)[0].value;
        assert.equal(readResult.status, 'complete'); const citation = readResult.record.citations[0];
        message = { role: 'assistant', content: JSON.stringify({ kind: 'answer', text: `Temari is the main chat; Archon executes workflows. ${citation.path}, ${citation.source_id}, ${citation.sha256}.`, proposedTask: null }) };
      }
    }
    response.end(JSON.stringify({ done: true, message }));
  } catch (error) { modelError = error; response.writeHead(500).end(); }
});
await new Promise(done => model.listen(0, '127.0.0.1', done));
const execute = promisify(execFile);
const command = async (file, args, extraEnv = {}) => JSON.parse((await execute(file, args, { env: { ...process.env, PATH: '/usr/bin:/bin', ...extraEnv }, timeout: 120000, maxBuffer: 4 * 1024 * 1024 })).stdout);
const guide = () => command(join(values.distribution, 'setup'), ['guide', '--home', home, '--workspace', workspace, '--expected-manifest-sha256', values['expected-manifest-sha256'], '--chat', 'ollama', '--model', 'guided-fixture', '--ollama-url', `http://127.0.0.1:${model.address().port}`, '--worker', 'none', '--clients', 'none', '--port', '0', '--no-start']);
try {
  const first = await guide(), retry = await guide();
  assert.equal(first.phase, 'ready'); assert.equal(retry.phase, 'ready'); assert.equal(first.knowledge.sourceId, retry.knowledge.sourceId);
  assert.equal(first.chat.status, 'PASS'); assert(first.knowledge.connected);
  const launcher = join(home, 'temari'), runtime = await command(launcher, ['start']); started = true;
  const dashboard = await (await fetch(`${runtime.url}/api/dashboard`)).json();
  const post = async (path, body) => {
    const response = await fetch(runtime.url + path, { method: 'POST', headers: { origin: runtime.url, 'content-type': 'application/json', 'x-temari-token': dashboard.csrfToken }, body: JSON.stringify(body) });
    assert(response.ok); return response.json();
  };
  const { topic } = await post('/api/topics', { requestId: 'guided-library', title: 'Temari library' });
  await post(`/api/topics/${topic.topicId}/turns`, { requestId: 'guided-citation', expectedVersion: topic.version, text: 'Search the starter library and read welcome.md. What do Temari and Archon do?' });
  let detail;
  for (let i = 0; i < 150; i++) {
    detail = await (await fetch(`${runtime.url}/api/topics/${topic.topicId}`)).json();
    if (['responded', 'blocked'].includes(detail.turns[0]?.state)) break;
    await new Promise(done => setTimeout(done, 100));
  }
  if (modelError) throw modelError;
  assert.equal(detail.turns[0]?.state, 'responded', JSON.stringify(detail));
  assert.equal(calls, 4); assert.match(detail.turns[0].assistantMessage, /welcome\.md/);
  assert(detail.turns[0].assistantMessage.includes(first.knowledge.sourceId));
  const stored = JSON.parse(await readFile(join(home, 'guided-setup.json')));
  assert.equal(stored.phase, 'ready');
  await command(launcher, ['stop']); started = false;
  // Launch actual packaged supervisors and worker processes. The provider CLI is
  // an explicit fixture, so no account or network model is required in native CI.
  const manifest = JSON.parse(await readFile(join(values.distribution, 'UNIFIED.json')));
  const managedNode = join(values.distribution, manifest.assets.node.executable);
  const executable = join(root, 'claude-fixture'), workerHome = join(root, 'worker-home');
  const localUrl = `http://127.0.0.1:${model.address().port}`;
  await writeFile(join(workspace, 'fixture.txt'), 'installed worker fixture\n');
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Temari Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']]) await execute('git', args, { cwd: workspace });
  await writeFile(executable, `#!${managedNode}\nimport assert from 'node:assert/strict'; import {readFileSync} from 'node:fs'; import {join} from 'node:path'; import {randomUUID} from 'node:crypto';\nconst args=process.argv.slice(2);\nif(args[0]==='--version'){console.log('2.1.296 (Claude Code)');process.exit(0);}\nif(args[0]==='auth'){process.exit(1);}\nassert(args.includes('--bare')); assert(args.includes('--strict-mcp-config'));\nassert.equal(process.env.ANTHROPIC_API_KEY,''); assert.equal(process.env.ANTHROPIC_AUTH_TOKEN,'ollama'); assert.equal(process.env.ANTHROPIC_BASE_URL,${JSON.stringify(localUrl)});\nassert.equal(readFileSync(join(process.cwd(),'fixture.txt'),'utf8'),'installed worker fixture\\n');\nprocess.stdin.resume(); process.stdin.on('end',()=>console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,session_id:randomUUID(),structured_output:{status:'PASS',summary:'Read fixture.txt; saved selected credentials reached the packaged worker.'}})));\n`, { mode: 0o700 });
  const installedWorkers = await command(join(values.distribution, 'setup'), ['guide', '--home', workerHome, '--workspace', workspace, '--expected-manifest-sha256', values['expected-manifest-sha256'], '--chat', 'ollama', '--model', 'guided-fixture', '--ollama-url', localUrl, '--worker', 'claude-code', '--worker-executable', executable, '--worker-model', 'guided-fixture', '--claude-auth', 'ollama', '--clients', 'none', '--port', '0', '--no-start']);
  assert.equal(installedWorkers.phase, 'ready');
  const workerLauncher = join(workerHome, 'temari');
  let workerStarted = false;
  try {
    const workerRuntime = await command(workerLauncher, ['start'], { ANTHROPIC_API_KEY: 'unselected-fixture-key', ANTHROPIC_AUTH_TOKEN: 'unselected-fixture-token', ANTHROPIC_BASE_URL: 'https://unselected.invalid' }); workerStarted = true;
    const initial = await (await fetch(workerRuntime.url + '/api/dashboard')).json();
    const workerPost = async (path, body) => { const response = await fetch(workerRuntime.url + path, { method: 'POST', headers: { origin: workerRuntime.url, 'content-type': 'application/json', 'x-temari-token': initial.csrfToken }, body: JSON.stringify(body) }); const data = await response.json(); assert(response.ok, JSON.stringify(data)); return data; };
    const task = await workerPost('/api/tasks', { requestId: 'installed-workers', mode: 'swarm', title: 'Read fixture', goal: 'Read fixture.txt and report the observed content.', workerCount: 2, maxConcurrency: 2 });
    await workerPost(`/api/tasks/${task.taskId}/actions`, { requestId: 'start-installed-workers', action: 'swarm-start', expectedVersion: task.version });
    let swarm;
    for (let i = 0; i < 150; i++) {
      const current = await (await fetch(workerRuntime.url + '/api/dashboard')).json(); swarm = current.config.controls[task.taskId].swarm;
      if (['COMPLETE', 'FAILED', 'RECOVERY_REQUIRED', 'CANCELLED'].includes(swarm.state)) break;
      await new Promise(done => setTimeout(done, 100));
    }
    assert.equal(swarm.state, 'COMPLETE', JSON.stringify(swarm)); assert.equal(swarm.receipt.status, 'PASS'); assert.equal(swarm.workers.length, 2);
  } finally { if (workerStarted) await command(workerLauncher, ['stop']); }
  console.log(JSON.stringify({ status: 'PASS', coldPath: '/usr/bin:/bin', profile: 'generated by guide; no authored JSON', retry: 'exact choices reused', model: 'loopback fixture with actual knowledge tools', knowledge: 'verified search, document read, citation and restart', workers: 'two packaged supervisor/provider-fixture workers; saved authentication and retained progress; no recipient TypeScript loader', hosts: 'provider CLI fixture; native account/client registration verified separately' }));
} finally {
  if (started) await command(join(home, 'temari'), ['stop']).catch(() => {});
  model.closeAllConnections(); await new Promise(done => model.close(done));
  await rm(root, { recursive: true, force: true });
}
