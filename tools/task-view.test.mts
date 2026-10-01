import assert from 'node:assert/strict';
import { request, type Server } from 'node:http';
import test, { type TestContext } from 'node:test';
import {
  startTaskViewServer,
  TaskViewControllerError,
  validateArchonBaseUrl,
  type TaskViewController,
} from './task-view.mjs';

const emptyReader = {
  listSnapshots: async () => [],
  snapshot: async () => null,
  pickup: async () => ({ status: 'empty', selected: null }),
};

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

async function writableServer(t: TestContext, controller: TaskViewController) {
  const server = await startTaskViewServer({
    runtime: emptyReader,
    controller,
    archonBaseUrl: 'http://127.0.0.1:3091',
    port: 0,
  });
  t.after(() => closeServer(server));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const dashboard = await (await fetch(`${base}/api/dashboard`)).json();
  const token = dashboard.csrfToken as string;
  const headers = {
    origin: base,
    'content-type': 'application/json',
    'x-temari-token': token,
  };
  return { server, base, dashboard, token, headers };
}

async function rawRequest(
  url: string,
  options: {
    headers: Record<string, string | string[]>;
    body?: string | Buffer;
    setHost?: boolean;
    finish?: boolean;
  },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'POST',
        headers: options.headers,
        setHost: options.setHost ?? true,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => {
          resolve({ status: res.statusCode!, body });
          req.destroy();
        });
      },
    );
    req.setTimeout(8_000, () =>
      req.destroy(new Error('HTTP fixture timed out.')),
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    if (options.finish === false) req.flushHeaders();
    else req.end();
  });
}

test('read-only task view serves retained task data and rejects mutation and foreign hosts', async (t) => {
  const task = {
    taskId: 'one',
    title: '<script>no execution</script>',
    status: 'OPEN',
  };
  const server = await startTaskViewServer({
    runtime: {
      listSnapshots: async () => [task],
      snapshot: async (id) => (id === 'one' ? task : null),
      pickup: async ({ taskId }) => ({
        status: taskId === 'one' ? 'selected' : 'empty',
        selected:
          taskId === 'one'
            ? { taskId, nextAction: 'Review retained evidence' }
            : null,
      }),
    },
    archonBaseUrl: 'http://127.0.0.1:3091',
    port: 0,
  });
  t.after(
    () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  );
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const list = await fetch(`${base}/api/tasks`);
  assert.deepEqual(await list.json(), {
    tasks: [task],
    archonBaseUrl: 'http://127.0.0.1:3091',
  });
  assert.equal(list.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await (await fetch(`${base}/api/dashboard`)).json(), {
    mode: 'read-only',
    csrfToken: null,
    config: null,
    archonBaseUrl: 'http://127.0.0.1:3091',
    knowledgeAvailable: false,
    schedulingAvailable: false,
  });
  assert.equal((await fetch(`${base}/api/tasks/one`)).status, 200);
  assert.equal((await fetch(`${base}/api/tasks/missing`)).status, 404);
  assert.deepEqual(await (await fetch(`${base}/api/tasks/one/pickup`)).json(), {
    status: 'selected',
    selected: { taskId: 'one', nextAction: 'Review retained evidence' },
  });
  assert.equal((await fetch(`${base}/api/tasks/missing/pickup`)).status, 404);
  assert.equal(
    (await fetch(`${base}/api/tasks/one/pickup`, { method: 'POST' })).status,
    405,
  );
  assert.equal(
    (await fetch(`${base}/api/tasks`, { method: 'POST' })).status,
    405,
  );
  assert.equal(
    (await fetch(`${base}/api/tasks/one`, { method: 'DELETE' })).status,
    405,
  );
  assert.equal((await fetch(`${base}/api/tasks/%2e%2e%2fprivate`)).status, 404);
  const foreignStatus = await new Promise((resolve, reject) => {
    const req = request(
      `${base}/api/tasks`,
      { headers: { host: `foreign.example:${port}` } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(foreignStatus, 403);
  const page = await fetch(base);
  assert.match(
    page.headers.get('content-security-policy')!,
    /script-src 'self'/,
  );
  const html = await page.text();
  assert.match(html, /Task inbox/);
  assert.match(html, /id="knowledge-drives"/);
  assert.match(html, /id="knowledge-source-browser"/);
  assert.match(html, /id="knowledge-graph-view"/);
  assert.match(html, /Expand folders to inspect/);
  assert.equal((await fetch(`${base}/task-view.js`)).status, 200);
  assert.equal((await fetch(`${base}/task-view.css`)).status, 200);
  const dashboardPages = await (await fetch(`${base}/dashboard-pages.js`)).text();
  assert.match(dashboardPages, /No content source is connected yet/);
  assert.match(dashboardPages, /node\.kind === 'path' \? parts : parts\.slice\(0, -1\)/);
  assert.match(dashboardPages, /pages\.knowledgeView === 'sources' && sourceEmpty/);
  assert.equal((await fetch(base, { method: 'HEAD' })).status, 200);
});

test('task read failures stay visible instead of looking like an empty inbox', async (t) => {
  const server = await startTaskViewServer({
    runtime: {
      listSnapshots: async () => {
        throw new Error('Task ledger digest mismatch.');
      },
      snapshot: async () => null,
      pickup: async () => {
        throw new Error('Task ledger digest mismatch.');
      },
    },
    archonBaseUrl: 'http://localhost:3091',
    port: 0,
  });
  t.after(
    () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  );
  const response = await fetch(
    `http://127.0.0.1:${(server.address() as { port: number }).port}/api/tasks`,
  );
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: 'Task ledger digest mismatch.',
  });
  const pickup = await fetch(
    `http://127.0.0.1:${(server.address() as { port: number }).port}/api/tasks/one/pickup`,
  );
  assert.equal(pickup.status, 500);
  assert.deepEqual(await pickup.json(), {
    error: 'Task ledger digest mismatch.',
  });
});

test('console links require a configured HTTP origin', () => {
  assert.equal(
    validateArchonBaseUrl('https://archon.example/'),
    'https://archon.example',
  );
  for (const value of [
    'javascript:alert(1)',
    'file:///private/data',
    'https://user:pass@archon.example',
    'http://localhost/other',
    'http://localhost/?key=secret',
  ])
    assert.throws(() => validateArchonBaseUrl(value));
});

test('writable dashboard delegates only POST intake and selected task actions', async (t) => {
  const calls: unknown[] = [];
  const config = {
    actions: ['start', 'resume', 'cancel', 'verify', 'accept'],
    csrfToken: 'not-authoritative',
  };
  const { base, dashboard, token, headers } = await writableServer(t, {
    describe: async () => config,
    create: async (input) => {
      calls.push(['create', input]);
      return { taskId: 'new-task', status: 'OPEN' };
    },
    action: async (taskId, input) => {
      calls.push(['action', taskId, input]);
      return { taskId, outcome: 'delegated', status: 'NEEDS_REVIEW' };
    },
  });
  assert.equal(dashboard.mode, 'writable');
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.notEqual(token, config.csrfToken);
  assert.deepEqual(dashboard.config, config);
  const created = await fetch(`${base}/api/tasks`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ goal: 'Finish the report' }),
  });
  assert.equal(created.status, 200);
  assert.deepEqual(await created.json(), {
    taskId: 'new-task',
    status: 'OPEN',
  });
  const acted = await fetch(`${base}/api/tasks/new-task/actions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ action: 'verify', expectedVersion: 2 }),
  });
  assert.deepEqual(await acted.json(), {
    taskId: 'new-task',
    outcome: 'delegated',
    status: 'NEEDS_REVIEW',
  });
  assert.equal((await fetch(`${base}/api/tasks/new-task/actions`)).status, 405);
  assert.equal(
    (await fetch(`${base}/api/tasks/new-task/actions`, { method: 'HEAD' }))
      .status,
    405,
  );
  assert.equal(
    (await fetch(`${base}/api/tasks`, { method: 'DELETE', headers })).status,
    405,
  );
  for (const path of [
    '/api/commands',
    '/api/tasks/new-task/pickup',
    '/api/tasks/new-task/actions/extra',
    '/api/tasks?command=start',
  ])
    assert.equal(
      (await fetch(`${base}${path}`, { method: 'POST', headers, body: '{}' }))
        .status,
      404,
    );
  assert.deepEqual(calls, [
    ['create', { goal: 'Finish the report' }],
    ['action', 'new-task', { action: 'verify', expectedVersion: 2 }],
  ]);
});

test('mutations reject missing or foreign origin, host, and token before dispatch', async (t) => {
  let calls = 0;
  const { base, headers } = await writableServer(t, {
    describe: () => ({}),
    create: async () => {
      calls++;
      return {};
    },
    action: async () => {
      calls++;
      return {};
    },
  });
  const withoutOrigin = {
    'content-type': headers['content-type'],
    'x-temari-token': headers['x-temari-token'],
  };
  const withoutToken = {
    'content-type': headers['content-type'],
    origin: base,
  };
  for (const requestHeaders of [
    withoutOrigin,
    withoutToken,
    { ...headers, origin: 'http://foreign.example' },
    { ...headers, origin: `${base}/` },
    { ...headers, origin: base.replace('127.0.0.1', 'localhost') },
    { ...headers, origin: base.replace('http:', 'https:') },
    { ...headers, origin: 'null' },
    { ...headers, 'x-temari-token': 'x'.repeat(64) },
  ]) {
    const response = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: requestHeaders,
      body: '{}',
    });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
  for (const host of [
    'foreign.example',
    '127.0.0.1:1',
    'localhost',
    '127.0.0.1.attacker.example',
  ]) {
    assert.equal(
      (
        await rawRequest(`${base}/api/tasks`, {
          headers: { ...headers, host },
          body: '{}',
        })
      ).status,
      403,
    );
  }
  const missingHost = await rawRequest(`${base}/api/tasks`, {
    headers,
    setHost: false,
    body: '{}',
  });
  assert.ok([400, 403].includes(missingHost.status));
  const duplicateOrigin = await rawRequest(`${base}/api/tasks`, {
    headers: { ...headers, origin: [base, base] },
    body: '{}',
  });
  assert.equal(duplicateOrigin.status, 403);
  assert.equal(calls, 0);
});

test(
  'mutation bodies require bounded UTF-8 JSON and stalled bodies expire',
  { timeout: 12_000 },
  async (t) => {
    const calls: unknown[] = [];
    const { base, headers } = await writableServer(t, {
      describe: () => ({}),
      create: async (input) => {
        calls.push(input);
        return { stored: true };
      },
      action: async () => ({}),
    });
    for (const contentType of [
      'text/plain',
      'application/x-www-form-urlencoded',
      'application/json; charset=latin1',
    ]) {
      assert.equal(
        (
          await fetch(`${base}/api/tasks`, {
            method: 'POST',
            headers: { ...headers, 'content-type': contentType },
            body: '{}',
          })
        ).status,
        415,
      );
    }
    const noType = await rawRequest(`${base}/api/tasks`, {
      headers: { origin: base, 'x-temari-token': headers['x-temari-token'] },
      body: '{}',
    });
    assert.equal(noType.status, 415);
    for (const body of ['', '{not json', Buffer.from([0xc3, 0x28])]) {
      assert.equal(
        (await rawRequest(`${base}/api/tasks`, { headers, body })).status,
        400,
      );
    }
    const tooLarge = JSON.stringify('x'.repeat(64 * 1024));
    assert.equal(
      (
        await fetch(`${base}/api/tasks`, {
          method: 'POST',
          headers,
          body: tooLarge,
        })
      ).status,
      413,
    );
    assert.equal(
      (
        await rawRequest(`${base}/api/tasks`, {
          headers: { ...headers, 'transfer-encoding': 'chunked' },
          body: tooLarge,
        })
      ).status,
      413,
    );
    const stalled = await rawRequest(`${base}/api/tasks`, {
      headers: { ...headers, 'content-length': '100' },
      body: '{',
      finish: false,
    });
    assert.equal(stalled.status, 408);
    assert.equal(calls.length, 0);
    const boundary = 'x'.repeat(64 * 1024 - 2);
    const accepted = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: {
        ...headers,
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(boundary),
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(calls, [boundary]);
  },
);

test('controller owns duplicate dispatch, stale versions, and validation errors', async (t) => {
  let createCalls = 0;
  let dispatches = 0;
  const seen = new Set<string>();
  const { base, headers } = await writableServer(t, {
    describe: () => ({}),
    create: async (input) => {
      createCalls++;
      const key = (input as { idempotencyKey: string }).idempotencyKey;
      if (!seen.has(key)) {
        seen.add(key);
        dispatches++;
      }
      return { taskId: 'same-task', version: 1 };
    },
    action: async (_taskId, input) => {
      const action = (input as { action: string }).action;
      if (action === 'stale')
        throw new TaskViewControllerError(409, 'Task version changed.');
      if (action === 'invalid')
        throw Object.assign(new Error('Unknown task action.'), { status: 400 });
      throw Object.assign(new Error('Unexpected controller failure.'), {
        status: 418,
      });
    },
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ idempotencyKey: 'once' }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      taskId: 'same-task',
      version: 1,
    });
  }
  assert.equal(createCalls, 2);
  assert.equal(dispatches, 1);
  for (const [action, status] of [
    ['stale', 409],
    ['invalid', 400],
    ['unexpected', 500],
  ] as const) {
    const response = await fetch(`${base}/api/tasks/same-task/actions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ action }),
    });
    assert.equal(response.status, status);
    assert.equal(typeof (await response.json()).error, 'string');
  }
});

test('dashboard restart invalidates the prior server token', async (t) => {
  let changes = 0;
  const controller: TaskViewController = {
    describe: () => ({}),
    create: async () => {
      changes++;
      return {};
    },
    action: async () => ({}),
  };
  const first = await writableServer(t, controller);
  await closeServer(first.server);
  const second = await writableServer(t, controller);
  assert.notEqual(first.token, second.token);
  const stale = await fetch(`${second.base}/api/tasks`, {
    method: 'POST',
    headers: { ...second.headers, 'x-temari-token': first.token },
    body: '{}',
  });
  assert.equal(stale.status, 403);
  assert.equal(changes, 0);
  const current = await fetch(`${second.base}/api/tasks`, {
    method: 'POST',
    headers: second.headers,
    body: '{}',
  });
  assert.equal(current.status, 200);
  assert.equal(changes, 1);
});

test('schedule mutations retain local-origin protection and knowledge selections admit only one server node ID', async (t) => {
  const calls: string[] = [];
  const server = await startTaskViewServer({
    runtime: emptyReader,
    controller: {
      describe: () => ({}),
      create: async () => ({}),
      action: async () => ({}),
    },
    archonBaseUrl: 'http://127.0.0.1:3091',
    port: 0,
    schedules: {
      describe: async () => ({ schedules: [], targets: [] }),
      create: async (input) => {
        calls.push('create');
        return input;
      },
      update: async (id, input) => {
        calls.push(id);
        return input;
      },
    },
    knowledge: {
      inspect: async () => ({ nodes: [] }),
      select: async (id) => {
        calls.push(id);
        return { node: { id } };
      },
      expand: async (id) => ({ nodes: [{ id }] }),
    },
  });
  t.after(() => closeServer(server));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const dashboard = await (await fetch(`${base}/api/dashboard`)).json();
  assert.equal(
    (
      await fetch(`${base}/api/schedules`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
    ).status,
    403,
  );
  const response = await fetch(`${base}/api/schedules`, {
    method: 'POST',
    headers: {
      origin: base,
      'content-type': 'application/json',
      'x-temari-token': dashboard.csrfToken,
    },
    body: JSON.stringify({ requestId: 'one' }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ['create']);
  assert.equal(
    (await fetch(`${base}/api/knowledge/node?node=known&path=/etc/passwd`))
      .status,
    400,
  );
  assert.equal(
    (await fetch(`${base}/api/knowledge/node?node=known&node=other`)).status,
    400,
  );
  assert.equal(
    (await fetch(`${base}/api/knowledge/node?node=known`)).status,
    200,
  );
  assert.deepEqual(calls, ['create', 'known']);
  assert.equal((await fetch(`${base}/dashboard-pages.js`)).status, 200);
});
