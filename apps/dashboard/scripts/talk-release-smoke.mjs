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

// This is a relocated recipient/lifecycle proof with a loopback model fixture.
// The fixture proves transport wiring, not live model/provider availability.
const exec = promisify(execFile);
const root = await realpath(
  await mkdtemp(join(tmpdir(), 'temari-installed-talk-')),
);
const install = join(root, 'installation');
const artifact = join(install, 'main.mjs');
const home = join(root, 'dashboard');
const workspace = join(root, 'workspace');
const preparation = join(root, 'preparation');
const archonHome = join(root, 'archon');
const profilePath = join(root, 'profile.json');
let started = false;
const modelRequests = [];
const model = createServer(async (req, res) => {
  try {
    assert.equal(req.url, '/api/chat');
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    assert.equal(request.model, 'installed-talk-fixture');
    assert.equal(request.stream, false);
    modelRequests.push(request);
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        done: true,
        message: {
          role: 'assistant',
          content: JSON.stringify({
            kind: 'answer',
            text: 'Temari received your linked task context.',
            proposedTask: null,
          }),
        },
      }),
    );
  } catch {
    res.writeHead(500).end();
  }
});
await new Promise((resolve) => model.listen(0, '127.0.0.1', resolve));
const transport = {
  kind: 'ollama',
  model: 'installed-talk-fixture',
  baseUrl: `http://127.0.0.1:${model.address().port}`,
};
const profile = {
  schema: 1,
  id: 'installed-talk-proof',
  archonHome,
  port: 0,
  control: {
    schema: 1,
    workspaceRoot: workspace,
    preparationRoot: preparation,
    recipes: [],
  },
  talk: {
    schema: 1,
    root: join(root, 'conversations'),
    workspaceRoot: workspace,
    hostId: 'release-proof',
    workspaceId: 'selected-product',
    taskStoreId: 'shared-tasks',
    transport,
  },
};
const run = async (...args) =>
  JSON.parse(
    (
      await exec(process.execPath, [artifact, ...args, '--home', home], {
        cwd: install,
        env: { ...process.env, TEMARI_DASHBOARD_HOME: home },
        maxBuffer: 4 * 1024 * 1024,
      })
    ).stdout,
  );
// Task commands forward to the existing CLI, which does not accept --home.
const task = async (command, input) => {
  const path = join(root, `${command}.json`);
  await writeFile(path, JSON.stringify(input));
  return JSON.parse(
    (
      await exec(
        process.execPath,
        [artifact, command, '--root', join(home, 'tasks'), '--input', path],
        { cwd: install },
      )
    ).stdout,
  );
};
const configure = async (value) => {
  await writeFile(profilePath, JSON.stringify(value));
  return run('configure', '--profile', profilePath);
};
const get = async (base, path) => {
  const response = await fetch(base + path);
  const value = await response.json();
  assert.equal(response.status, 200, JSON.stringify(value));
  return value;
};
const post = async (base, token, path, body, status = 200) => {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: {
      origin: base,
      'content-type': 'application/json',
      'x-temari-token': token,
    },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  assert.equal(response.status, status, JSON.stringify(value));
  return value;
};
const waitFor = async (read) => {
  for (let count = 0; count < 100; count++) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for the installed Talk turn.');
};
try {
  await cp(fileURLToPath(new URL('../dist', import.meta.url)), install, {
    recursive: true,
  });
  for (const path of [home, workspace, preparation, archonHome])
    await mkdir(path);
  // Reuse an available pinned cache; the production installer still verifies it.
  // With no cache this test exercises the existing pinned Archon download.
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

  const { talk, ...legacy } = profile;
  assert.equal((await configure(legacy)).status, 'configured');
  assert.equal((await run('doctor')).status, 'PASS');
  await assert.rejects(
    configure({ ...profile, talk: null }),
    /schema1 configuration/,
  );
  await assert.rejects(
    configure({
      ...profile,
      talk: {
        ...talk,
        transport: {
          kind: 'openai-responses',
          model: 'fixture',
          credentialEnv: 'KEY',
          secret: 'must-not-be-retained',
        },
      },
    }),
    /Unknown or missing Talk fields/,
  );
  const foreign = join(root, 'foreign');
  await mkdir(foreign);
  await assert.rejects(
    configure({ ...profile, talk: { ...talk, workspaceRoot: foreign } }),
    /same workspace/,
  );
  await assert.rejects(
    configure({
      ...profile,
      talk: { ...talk, root: join(workspace, 'conversations') },
    }),
    /outside the selected source workspace/,
  );
  assert.equal((await configure(profile)).status, 'configured');
  assert.equal((await configure(profile)).status, 'configured');
  assert.deepEqual(
    JSON.parse(await readFile(join(home, 'talk.json'), 'utf8')),
    talk,
  );
  assert.equal((await run('doctor')).status, 'PASS');

  const first = await run('start');
  started = true;
  assert.equal(first.status, 'running');
  assert.equal((await run('start')).reused, true);
  assert.equal((await configure(profile)).reused, true);
  await assert.rejects(
    configure({ ...profile, id: 'live-reconfiguration' }),
    /Stop the dashboard/,
  );
  const dashboard = await get(first.url, '/api/dashboard');
  assert.equal(dashboard.talkAvailable, true);
  const topics = await get(first.url, '/api/topics');
  assert.equal(topics.capabilities.canSendTurn, true);
  assert.equal(topics.capabilities.canStartTask, false);
  const pageScript = await (
    await fetch(first.url + '/dashboard-pages.js')
  ).text();
  assert.match(pageScript, /temari-talk-configured/);
  assert.match(pageScript, /selectDashboardView\('talk', false\)/);
  const created = await post(first.url, dashboard.csrfToken, '/api/topics', {
    requestId: 'first-topic',
    title: 'My main Temari chat',
  });
  const topicId = created.topic.topicId;
  const retainedTask = await task('create', {
    taskId: 'worker-progress',
    title: 'Visible worker progress',
    goal: 'Retain progress in the same durable task store.',
    workspaceRoot: workspace,
    actor: 'release-proof',
    idempotencyKey: 'create-progress',
  });
  await post(first.url, dashboard.csrfToken, `/api/topics/${topicId}/links`, {
    requestId: 'link-progress',
    expectedVersion: created.topic.version,
    taskId: retainedTask.taskId,
  });
  let detail = await get(first.url, `/api/topics/${topicId}`);
  assert.equal(detail.linkedTasks[0].taskId, retainedTask.taskId);
  const updated = await task('update', {
    taskId: retainedTask.taskId,
    actor: 'release-proof',
    idempotencyKey: 'updated-progress',
    expectedVersion: retainedTask.version,
    nextAction: 'Review the worker result',
    blocker: null,
  });
  detail = await get(first.url, `/api/topics/${topicId}`);
  assert.equal(detail.linkedTasks[0].version, updated.version);
  assert.equal(detail.linkedTasks[0].nextAction, 'Review the worker result');
  await post(
    first.url,
    dashboard.csrfToken,
    `/api/topics/${topicId}/turns`,
    {
      requestId: 'conversation-turn',
      expectedVersion: detail.topic.version,
      text: 'What is happening with my linked work?',
    },
    202,
  );
  const responded = await waitFor(async () => {
    const observed = await get(first.url, `/api/topics/${topicId}`);
    return observed.turns[0]?.state === 'responded' ? observed : null;
  });
  assert.equal(
    responded.turns[0].assistantMessage,
    'Temari received your linked task context.',
  );
  assert.equal(modelRequests.length, 1);
  assert.match(JSON.stringify(modelRequests[0]), /worker-progress/);
  assert.match(JSON.stringify(modelRequests[0]), /Review the worker result/);
  await run('stop');
  started = false;
  assert.equal((await run('doctor')).status, 'PASS');
  const second = await run('start');
  started = true;
  assert.notEqual(second.pid, first.pid);
  const restored = await get(second.url, `/api/topics/${topicId}`);
  assert.deepEqual(restored.turns, responded.turns);
  assert.equal(restored.linkedTasks[0].taskId, retainedTask.taskId);
  assert.equal(modelRequests.length, 1, 'Restart must not replay model calls.');
  await run('stop');
  started = false;
  await writeFile(
    join(home, 'talk.json'),
    JSON.stringify({ ...talk, hostId: 'changed-host' }),
  );
  const tampered = await run('doctor');
  assert.equal(tampered.status, 'FAIL');
  assert(
    tampered.checks.some(
      (check) => check.id === 'talk' && check.status === 'FAIL',
    ),
  );
  await assert.rejects(run('_serve'), /changed after configure/);
  assert.equal((await configure(profile)).status, 'configured');
  const credentialProfile = {
    ...profile,
    talk: {
      ...talk,
      transport: {
        kind: 'openai-responses',
        model: 'fixture',
        credentialEnv: 'TEMARI_RELEASE_PROOF_MISSING_CREDENTIAL',
      },
    },
  };
  await configure(credentialProfile);
  const noCredential = await run('doctor');
  assert.equal(noCredential.status, 'FAIL');
  assert(
    noCredential.checks.some(
      (check) =>
        check.id === 'talk-model-credential' && check.status === 'FAIL',
    ),
  );
  assert(!JSON.stringify(noCredential).includes('must-not-be-retained'));
  console.log(
    'Installed Talk release smoke passed: relocation, legacy profiles, configuration refusal, shared task progress, fixture model turn, restart and tamper checks.',
  );
} finally {
  if (started) await run('stop');
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  await rm(root, { recursive: true, force: true });
}
