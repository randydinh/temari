import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { prepareTalkKnowledge } from '../../../tools/fixtures/dashboard-talk-knowledge.mjs';

// Actual scoped knowledge gateway; the model is an explicit loopback fixture.
const exec = promisify(execFile);
const root = await realpath(
  await mkdtemp(join(tmpdir(), 'temari-installed-knowledge-talk-')),
);
const installation = join(root, 'installation'),
  artifact = join(installation, 'main.mjs'),
  home = join(root, 'dashboard');
const workspace = join(root, 'product'),
  preparation = join(root, 'preparation'),
  archonHome = join(root, 'archon');
let started = false,
  calls = 0,
  discovered,
  readResult,
  modelError;
const requests = [];
const model = createServer(async (req, res) => {
  try {
    assert.equal(req.url, '/api/chat');
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    requests.push(request);
    calls++;
    assert.equal(request.tools.length, calls === 4 ? 0 : 2);
    if (calls === 4) assert.equal(request.format.type, 'object');
    else assert.equal(request.format, undefined);
    let message;
    if (calls === 1)
      message = {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            function: { name: 'temari_host_1', arguments: { query: 'Temari' } },
          },
        ],
      };
    else if (calls === 2) {
      discovered = JSON.parse(request.messages.at(-1).content)[0].value;
      assert.equal(discovered.documents.length, 1);
      assert.equal(discovered.documents[0].retrieval.kind, 'exact');
      const doc = discovered.documents[0];
      message = {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            function: {
              name: 'temari_host_2',
              arguments: {
                sourceId: doc.source_id,
                path: doc.path,
                generation: doc.generation,
                sha256: doc.sha256,
              },
            },
          },
        ],
      };
    } else {
      assert(calls === 3 || calls === 4);
      if (calls === 3) {
        readResult = JSON.parse(request.messages.at(-1).content)[0].value;
        assert.equal(readResult.status, 'complete');
      }
      const cite = readResult.record.citations[0];
      message = {
        role: 'assistant',
        content: JSON.stringify({
          kind: 'answer',
          text: `Temari owns intent and Archon executes workflows. [${cite.path}] (source ${cite.source_id}, SHA-256 ${cite.sha256}, lines ${cite.start}-${cite.end}).`,
          proposedTask: null,
        }),
      };
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ done: true, message }));
  } catch (error) {
    modelError = error;
    res.writeHead(500).end();
  }
});
await new Promise((resolve) => model.listen(0, '127.0.0.1', resolve));
const run = async (...args) =>
  JSON.parse(
    (
      await exec(process.execPath, [artifact, ...args, '--home', home], {
        cwd: installation,
        maxBuffer: 4 * 1024 * 1024,
      })
    ).stdout,
  );
const get = async (base, path) => {
  const response = await fetch(base + path);
  assert.equal(response.status, 200);
  return response.json();
};
const post = async (base, token, path, input, status) => {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: {
      origin: base,
      'content-type': 'application/json',
      'x-temari-token': token,
    },
    body: JSON.stringify(input),
  });
  const value = await response.json();
  assert.equal(response.status, status, JSON.stringify(value));
  return value;
};
try {
  const knowledge = await prepareTalkKnowledge(
    root,
    process.env.TEMARI_REGISTRAR_PYTHON,
  );
  await cp(fileURLToPath(new URL('../dist', import.meta.url)), installation, {
    recursive: true,
  });
  for (const path of [home, workspace, preparation, archonHome])
    await mkdir(path);
  const cached =
    process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Caches', 'Temari', 'components', 'archon')
      : process.platform === 'win32'
        ? join(
            process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
            'Temari',
            'cache',
            'components',
            'archon',
          )
        : join(
            process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'),
            'Temari',
            'components',
            'archon',
          );
  try {
    await cp(cached, join(home, 'cache', 'components', 'archon'), {
      recursive: true,
    });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const talk = {
    schema: 1,
    root: join(root, 'conversations'),
    workspaceRoot: workspace,
    hostId: 'knowledge-release-proof',
    workspaceId: 'product',
    taskStoreId: 'shared-tasks',
    transport: {
      kind: 'ollama',
      model: 'knowledge-fixture',
      baseUrl: `http://127.0.0.1:${model.address().port}`,
    },
    knowledge: knowledge.config,
  };
  const profile = {
    schema: 1,
    id: 'knowledge-talk-proof',
    archonHome,
    port: 0,
    control: {
      schema: 1,
      workspaceRoot: workspace,
      preparationRoot: preparation,
      recipes: [],
    },
    talk,
  };
  const profilePath = join(root, 'profile.json');
  await writeFile(profilePath, JSON.stringify(profile));
  assert.equal(
    (await run('configure', '--profile', profilePath)).status,
    'configured',
  );
  assert.equal((await run('doctor')).status, 'PASS');
  const first = await run('start');
  started = true;
  const dashboard = await get(first.url, '/api/dashboard');
  assert.equal(dashboard.talkAvailable, true);
  const created = await post(
    first.url,
    dashboard.csrfToken,
    '/api/topics',
    { requestId: 'library-question', title: 'Ask Temari about her library' },
    200,
  );
  const topic = created.topic;
  await post(
    first.url,
    dashboard.csrfToken,
    `/api/topics/${topic.topicId}/turns`,
    {
      requestId: 'cited-turn',
      expectedVersion: topic.version,
      text: 'Use your knowledge library: what do Temari and Archon do?',
    },
    202,
  );
  let detail;
  for (let count = 0; count < 150; count++) {
    detail = await get(first.url, `/api/topics/${topic.topicId}`);
    if (['responded', 'blocked'].includes(detail.turns[0]?.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (modelError) throw modelError;
  assert.equal(detail.turns[0]?.state, 'responded', JSON.stringify(detail));
  assert.equal(calls, 4, 'Search and read must execute before final packet rendering.');
  assert.equal(discovered.documents[0].source_id, knowledge.allowedSourceId);
  assert.equal(readResult.record.support, 'source-bytes-and-spans-verified');
  assert.match(detail.turns[0].assistantMessage, /welcome\.md/);
  assert(detail.turns[0].assistantMessage.includes(knowledge.allowedSourceId));
  assert(
    detail.turns[0].assistantMessage.includes(discovered.documents[0].sha256),
  );
  assert(!JSON.stringify(requests).includes(knowledge.deniedSourceId));
  assert(!JSON.stringify(requests).includes('PRIVATE_SOURCE_MUST_NOT_LEAK'));
  await run('stop');
  started = false;
  const second = await run('start');
  started = true;
  const retained = await get(second.url, `/api/topics/${topic.topicId}`);
  assert.deepEqual(retained.turns, detail.turns);
  assert.equal(
    calls,
    4,
    'Restart must preserve the cited answer without replay.',
  );
  console.log(
    'Installed knowledge Talk proof passed: scoped exact search, pinned document read, byte-span citations, final cited fixture answer, denied-source isolation and restart.',
  );
} finally {
  if (started) await run('stop');
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  await rm(root, { recursive: true, force: true });
}
