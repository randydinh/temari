import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm, mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileScheduleStore } from '../libs/runtime/src/lib/schedule-store.js';
import { createDashboardScheduler } from './dashboard-scheduler.mjs';
import { createOpenWorkReader } from './dashboard-open-work.mjs';
import { request, type Server } from 'node:http';
import test, { type TestContext } from 'node:test';
import {
  startTaskViewServer,
  TaskViewControllerError,
  validateArchonBaseUrl,
  type TaskViewController,
  type TaskViewTalk,
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
    method?: string;
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
        method: options.method ?? 'POST',
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
    openWorkAvailable: false,
    knowledgeAvailable: false,
    schedulingAvailable: false,
    talkAvailable: false,
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
  const dashboardPages = await (
    await fetch(`${base}/dashboard-pages.js`)
  ).text();
  assert.match(dashboardPages, /No content source is connected yet/);
  assert.match(
    dashboardPages,
    /node\.kind === 'path' \? parts : parts\.slice\(0, -1\)/,
  );
  assert.match(
    dashboardPages,
    /pages\.knowledgeView === 'sources' && sourceEmpty/,
  );
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

test('task view exposes reconciliation reads and delegates only intent controls', async (t) => {
  const calls: unknown[] = [];
  const view = {
    attemptId: 'attempt-reconcile-1',
    state: 'awaiting-confirmation',
    blockedReason: null,
    candidate: { readiness: 'not-ready' },
    terminal: false,
  };
  const { base, headers } = await writableServer(t, {
    describe: () => ({}),
    create: async () => ({}),
    action: async () => ({}),
    reconciliationView: async (attemptId) =>
      attemptId === view.attemptId ? view : null,
    reconciliationCreate: async (input) => {
      calls.push(['create', input]);
      return view;
    },
    reconciliationInvalidate: async (attemptId, input) => {
      calls.push(['invalidate', attemptId, input]);
      return { ...view, state: 'blocked', blockedReason: 'binding changed' };
    },
    reconciliationConfirm: async (attemptId, input) => {
      calls.push(['confirm', attemptId, input]);
      return {
        ...view,
        state: 'observed',
        candidate: { readiness: 'not-ready' },
        terminal: false,
      };
    },
  });
  const read = await fetch(`${base}/api/reconciliation/${view.attemptId}`);
  assert.equal(read.status, 200);
  assert.equal(((await read.json()) as typeof view).terminal, false);
  assert.equal((await fetch(`${base}/api/reconciliation/missing`)).status, 404);
  const created = await fetch(`${base}/api/reconciliation`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ idempotencyKey: 'intent-1' }),
  });
  assert.equal(created.status, 200);
  const blocked = await fetch(
    `${base}/api/reconciliation/${view.attemptId}/invalidate`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    },
  );
  assert.equal(blocked.status, 200);
  const confirmed = await fetch(
    `${base}/api/reconciliation/${view.attemptId}/confirm`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ confirmation: {} }),
    },
  );
  assert.equal(confirmed.status, 200);
  assert.deepEqual(calls, [
    ['create', { idempotencyKey: 'intent-1' }],
    ['invalidate', view.attemptId, {}],
    ['confirm', view.attemptId, { confirmation: {} }],
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

test('open-work is available without controls and allows only query-free GET/HEAD', async (t) => {
  let calls = 0;
  const server = await startTaskViewServer({
    runtime: emptyReader,
    archonBaseUrl: 'http://127.0.0.1:3091',
    port: 0,
    openWork: {
      async describe() {
        calls++;
        return { state: 'unavailable', chats: [], worktrees: [] };
      },
    },
  });
  t.after(() => closeServer(server));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const dashboard = await (await fetch(`${base}/api/dashboard`)).json();
  assert.equal(dashboard.openWorkAvailable, true);
  assert.equal(dashboard.mode, 'read-only');
  const response = await fetch(`${base}/api/open-work`);
  assert.deepEqual(await response.json(), {
    state: 'unavailable',
    chats: [],
    worktrees: [],
  });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.ok(response.headers.get('content-security-policy'));
  const head = await fetch(`${base}/api/open-work`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal(calls, 2);
  for (const query of [
    '?path=/secret',
    '?manifestPath=/secret',
    '?sha256=anything',
  ]) {
    assert.equal((await fetch(`${base}/api/open-work${query}`)).status, 400);
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal(
      (await fetch(`${base}/api/open-work`, { method })).status,
      405,
    );
  }
  assert.equal((await fetch(`${base}/api/open-work/secret`)).status, 404);
  assert.equal(
    (
      await rawRequest(`${base}/api/open-work`, {
        method: 'GET',
        headers: { host: 'foreign.example' },
      })
    ).status,
    403,
  );
  assert.equal(calls, 2);
});

test('unconfigured open-work returns an honest empty projection', async (t) => {
  const server = await startTaskViewServer({
    runtime: emptyReader,
    archonBaseUrl: 'http://127.0.0.1:3091',
    port: 0,
  });
  t.after(() => closeServer(server));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const result = await (await fetch(`${base}/api/open-work`)).json();
  assert.equal(result.state, 'not-configured');
  assert.equal(result.configured, false);
  assert.equal(result.capture, null);
  assert.equal(result.coverage, null);
  assert.equal(result.readOnly, true);
  assert.equal(result.currentWriterState, 'not-checked');
  assert.equal(result.closureEligibility, 'not-assessed');
  assert.deepEqual(result.chats, []);
  assert.deepEqual(result.worktrees, []);
  assert.equal(
    (await (await fetch(`${base}/api/dashboard`)).json()).openWorkAvailable,
    false,
  );
});

test('open-work HTTP refresh clears a previously available capture when its pinned file changes', async (t) => {
  const root = await mkdtemp(join(process.cwd(), '.open-work-http-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifestPath = join(root, 'capture.json');
  const bytes = JSON.stringify({
    schema: 1,
    id: 'http-capture',
    capturedAt: new Date().toISOString(),
    baseline: 'a'.repeat(40),
    coverage: {
      chatScope: 'fixture',
      chatLimit: 1,
      allChats: false,
      worktreeScope: 'none',
      unavailableHosts: [],
      unavailableSources: [],
      gaps: [],
    },
    chats: [
      {
        id: 'thread',
        title: 'Unobserved writer',
        kind: 'chatgpt',
        hostId: null,
        cwd: null,
        status: 'notLoaded',
        updatedAt: null,
        worktreeId: null,
      },
    ],
    worktrees: [],
    sourceRefs: [{ kind: 'provenance-only', sha256: 'b'.repeat(64) }],
  });
  await writeFile(manifestPath, bytes);
  const server = await startTaskViewServer({
    runtime: emptyReader,
    archonBaseUrl: 'http://127.0.0.1:3091',
    port: 0,
    openWork: createOpenWorkReader({
      manifestPath,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }),
  });
  t.after(() => closeServer(server));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/open-work`;
  const first = await (await fetch(url)).json();
  assert.equal(first.state, 'available');
  assert.equal(first.chats[0].status, 'notLoaded');
  assert.equal(first.sourceRefs.length, 1);
  await writeFile(manifestPath, bytes + ' ');
  const changed = await (await fetch(url)).json();
  assert.equal(changed.state, 'unavailable');
  assert.deepEqual(changed.chats, []);
  assert.equal(changed.capture, null);
  assert.equal(changed.baseline, null);
  await rm(manifestPath);
  assert.equal((await (await fetch(url)).json()).state, 'unavailable');
});

function talkFixture(calls: unknown[]): TaskViewTalk {
  return {
    describe: async () => ({ configured: true, topics: [{ topicId: 'topic-one' }], attention: [], capabilities: { canCreateTopic: true, canSendTurn: true, canLinkTask: true } }),
    topic: async (id, page) => {
      calls.push(['topic', id, page]);
      return id === 'missing' ? null : { topic: { topicId: id, version: 3 }, turns: [], page };
    },
    create: async (input) => { calls.push(['create', input]); return { topic: { topicId: 'topic-one' } }; },
    turn: async (id, input) => { calls.push(['turn', id, input]); return { topicId: id, turnId: 'turn-one', topicVersion: 3, state: 'uncertain' }; },
    link: async (id, input) => { calls.push(['link', id, input]); return { linked: true }; },
    ack: async (id, attentionId, input) => { calls.push(['ack', id, attentionId, input]); return { acknowledged: true }; },
    accept: async (id, turnId, input) => { calls.push(['accept', id, turnId, input]); return { accepted: true }; },
  };
}
async function talkServer(t: TestContext, talk: TaskViewTalk) {
  const server = await startTaskViewServer({ runtime: emptyReader, talk, archonBaseUrl: 'http://127.0.0.1:3091', port: 0 });
  t.after(() => closeServer(server));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const dashboard = await (await fetch(`${base}/api/dashboard`)).json();
  const headers = { origin: base, 'content-type': 'application/json', 'x-temari-token': dashboard.csrfToken as string };
  return { base, dashboard, headers };
}

test('Talk-only HTTP admits topic writes while task execution stays read-only and turn ACK preserves uncertainty', async (t) => {
  const calls: unknown[] = [];
  const { base, dashboard, headers } = await talkServer(t, talkFixture(calls));
  assert.equal(dashboard.mode, 'read-only');
  assert.equal(dashboard.config, null);
  assert.equal(dashboard.talkAvailable, true);
  assert.match(dashboard.csrfToken, /^[a-f0-9]{64}$/);
  assert.equal((await (await fetch(`${base}/api/topics`)).json()).configured, true);
  assert.equal((await fetch(`${base}/api/tasks`, { method: 'POST', headers, body: '{}' })).status, 405);
  assert.equal((await fetch(`${base}/api/tasks/task-one/actions`, { method: 'POST', headers, body: '{}' })).status, 405);
  const mutations = [
    ['/api/topics', { requestId: 'create-one', title: 'Source ownership' }, 200],
    ['/api/topics/topic-one/turns', { requestId: 'turn-one', expectedVersion: 3, text: 'Review these boundaries.' }, 202],
    ['/api/topics/topic-one/links', { requestId: 'link-one', expectedVersion: 3, taskId: 'task-one' }, 200],
    ['/api/topics/topic-one/attention/attention-one/ack', { requestId: 'ack-one', expectedVersion: 3 }, 200],
    ['/api/topics/topic-one/proposals/turn-one/accept', { requestId: 'accept-one', expectedVersion: 3 }, 200],
  ] as const;
  for (const [path, body, status] of mutations) {
    const response = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal(response.status, status);
    const result = await response.json();
    if (status === 202) assert.deepEqual(result, { topicId: 'topic-one', turnId: 'turn-one', topicVersion: 3, state: 'uncertain' });
  }
  assert.deepEqual(calls, [
    ['create', mutations[0][1]], ['turn', 'topic-one', mutations[1][1]], ['link', 'topic-one', mutations[2][1]],
    ['ack', 'topic-one', 'attention-one', mutations[3][1]], ['accept', 'topic-one', 'turn-one', mutations[4][1]],
  ]);
  assert.equal((await fetch(`${base}/dashboard-talk.js`)).status, 200);
});

test('Talk rejects foreign/missing origin and token, unknown DTO fields, path IDs and unbounded/ambiguous pages before delegation', async (t) => {
  const calls: unknown[] = [];
  const { base, headers } = await talkServer(t, talkFixture(calls));
  const body = JSON.stringify({ requestId: 'create-one', title: 'Boundary review' });
  const invalidHeaders: Record<string, string>[] = [
    { 'content-type': 'application/json' },
    { ...headers, origin: 'http://foreign.example' },
    { ...headers, 'x-temari-token': 'wrong' },
  ];
  for (const badHeaders of invalidHeaders)
    assert.equal((await fetch(`${base}/api/topics`, { method: 'POST', headers: badHeaders, body })).status, 403);
  assert.equal((await rawRequest(`${base}/api/topics`, { headers: { ...headers, origin: [base, base] }, body })).status, 403);
  for (const [path, input] of [
    ['/api/topics', { requestId: 'create-one', title: 'A', executable: '/bin/echo' }],
    ['/api/topics', { requestId: 'create-one' }],
    ['/api/topics/topic-one/turns', { requestId: 'turn-one', expectedVersion: 1, text: 'A', actor: 'other' }],
    ['/api/topics/topic-one/turns', { requestId: 'turn-one', expectedVersion: 0, text: 'A' }],
    ['/api/topics/topic-one/links', { requestId: 'link-one', expectedVersion: 1, taskId: '../other' }],
    ['/api/topics/topic-one/attention/attention-one/ack', { requestId: 'ack-one', expectedVersion: 1, attentionId: 'other' }],
  ] as const) assert.equal((await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(input) })).status, 400);
  for (const path of [
    '/api/topics/topic-one?offset=-1', '/api/topics/topic-one?limit=0', '/api/topics/topic-one?limit=51',
    '/api/topics/topic-one?offset=9007199254740992', '/api/topics/topic-one?limit=2&limit=3',
    '/api/topics/topic-one?offset=1&actor=other', '/api/topics?limit=2',
  ]) assert.equal((await fetch(`${base}${path}`)).status, 400);
  for (const path of ['/api/topics/topic%2Fother', '/api/topics/topic-one/execute', '/api/topics/topic-one/turns?extra=one'])
    assert.equal((await fetch(`${base}${path}`, { method: 'POST', headers, body })).status, 404);
  assert.equal((await fetch(`${base}/api/topics/topic-one/turns`)).status, 405);
  assert.deepEqual(calls, []);
  const page = await fetch(`${base}/api/topics/topic-one?offset=4&limit=50`);
  assert.equal(page.status, 200);
  assert.deepEqual(calls, [['topic', 'topic-one', { offset: 4, limit: 50 }]]);
  assert.equal((await fetch(`${base}/api/topics/missing`)).status, 404);
});

test('registry Talk HTTP requires an opaque creation workspace and routes qualified topic identities without execution authority', async (t) => {
  const calls: unknown[] = [];
  const port = { ...talkFixture(calls), topicCreationScope: 'workspace-registry' as const };
  const { base, headers } = await talkServer(t, port);
  const post = (body: unknown) => fetch(`${base}/api/topics`, { method: 'POST', headers, body: JSON.stringify(body) });
  for (const body of [
    { requestId: 'registry-create', title: 'Scope review' },
    { requestId: 'registry-create', title: 'Scope review', workspaceKey: '../roles' },
    { requestId: 'registry-create', title: 'Scope review', workspaceKey: '' },
    { requestId: 'registry-create', title: 'Scope review', workspaceKey: 'roles', workspaceRoot: '/caller/source' },
  ]) assert.equal((await post(body)).status, 400);
  assert.deepEqual(calls, []);
  const input = { requestId: 'registry-create', title: 'Scope review', workspaceKey: 'roles' };
  assert.equal((await post(input)).status, 200);
  assert.deepEqual(calls, [['create', input]]);
  const topicId = 'mw.roles.topic-one';
  assert.equal((await fetch(`${base}/api/topics/${topicId}`)).status, 200);
  assert.deepEqual(calls[1], ['topic', topicId, {}]);
  assert.equal((await fetch(`${base}/api/topics/${topicId}/links`, { method: 'POST', headers, body: JSON.stringify({ requestId: 'retarget', expectedVersion: 3, taskId: 'task-one', workspaceKey: 'other' }) })).status, 400);
  assert.equal((await fetch(`${base}/api/tasks/task-one/actions`, { method: 'POST', headers, body: '{}' })).status, 405);
  assert.equal((await fetch(`${base}/api/topics`, { method: 'POST', headers: { ...headers, origin: 'http://other.invalid' }, body: JSON.stringify(input) })).status, 403);
  assert.equal(calls.length, 2);
});

test('unconfigured Talk is explicit and typed availability/conflict errors are plain while I/O failures stay500', async (t) => {
  const server = await startTaskViewServer({ runtime: emptyReader, archonBaseUrl: 'http://127.0.0.1:3091', port: 0 });
  t.after(() => closeServer(server));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const unavailable = await (await fetch(`${base}/api/topics`)).json();
  assert.equal(unavailable.configured, false);
  assert.deepEqual(unavailable.topics, []);
  assert.deepEqual(unavailable.attention, []);
  assert.equal((await fetch(`${base}/api/topics/topic-one`)).status, 404);
  const calls: unknown[] = [];
  const talk = talkFixture(calls);
  let failure: Error = Object.assign(new Error('\u001b[31mTransport not configured.\u001b[0m\nInternal detail'), { name: 'TalkRequestError', status: 503 });
  talk.turn = async () => { throw failure; };
  const configured = await talkServer(t, talk);
  const send = () => fetch(`${configured.base}/api/topics/topic-one/turns`, { method: 'POST', headers: configured.headers, body: JSON.stringify({ requestId: 'turn-one', expectedVersion: 1, text: 'A' }) });
  let response = await send();
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'Transport not configured.' });
  failure = Object.assign(new Error('Topic version changed.\nCurrent ledger is retained.'), { name: 'TalkRequestError', status: 409 });
  response = await send();
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'Topic version changed.' });
  failure = Object.assign(new Error('Unreadable ledger.\nEIO detail'), { code: 'EIO', status: 409 });
  response = await send();
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'Unreadable ledger.' });
});

test('actual scheduler HTTP validation/conflicts stay client refusals and ledger failures stay500', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'temari-schedule-http-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const store = await FileScheduleStore.create(join(root, 'schedules'), workspace);
  let dispatches = 0;
  const scheduler = createDashboardScheduler({ store, dispatcher: {
    describeTargets: async () => [{ id: 'verify', title: 'Verify', goal: 'Fixed checks', pin: 'a'.repeat(64) }],
    create: async () => { dispatches++; throw new Error('HTTP controls must not dispatch.'); },
    inspect: async () => { throw new Error('HTTP controls must not inspect.'); },
    start: async () => { throw new Error('HTTP controls must not start.'); },
  } });
  const server = await startTaskViewServer({ runtime: emptyReader, archonBaseUrl: 'http://127.0.0.1:3091', port: 0,
    controller: { describe: () => ({}), create: async () => ({}), action: async () => ({}) },
    schedules: { describe: () => scheduler.describe(), create: (input) => scheduler.create(input), update: (id, input) => scheduler.update(id, input) },
  });
  t.after(() => closeServer(server));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const dashboard = await (await fetch(`${base}/api/dashboard`)).json();
  const headers = { origin: base, 'content-type': 'application/json', 'x-temari-token': dashboard.csrfToken as string };
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const valid = { requestId: 'schedule-one', targetId: 'verify', cadence: { kind: 'interval', anchor: '2026-10-03T00:00:00.000Z', everyMs: 60000 } };
  for (const input of [{ ...valid, targetId: 'unknown' }, { ...valid, command: 'unexpected' }, { ...valid, cadence: { ...valid.cadence, everyMs: 1000 } }]) {
    const response = await post('/api/schedules', input);
    assert.equal(response.status, 400);
    const error = (await response.json()).error;
    assert.equal(/[\u001b\r\n]/.test(error), false);
  }
  assert.deepEqual(await store.list(), []);
  const created = await post('/api/schedules', valid);
  assert.equal(created.status, 200);
  const schedule = await created.json();
  const conflict = await post('/api/schedules', { ...valid, cadence: { ...valid.cadence, everyMs: 120000 } });
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { error: 'Schedule creation idempotency conflict.' });
  assert.equal((await post(`/api/schedules/${schedule.id}/actions`, { requestId: 'future-version', expectedVersion: 2, action: 'pause' })).status, 409);
  assert.equal((await post('/api/schedules/missing/actions', { requestId: 'missing', expectedVersion: 1, action: 'pause' })).status, 404);
  store.update = async () => { throw new assert.AssertionError({ message: 'Schedule ledger is corrupt.' }); };
  const corrupted = await post(`/api/schedules/${schedule.id}/actions`, { requestId: 'pause', expectedVersion: 1, action: 'pause' });
  assert.equal(corrupted.status, 500);
  assert.deepEqual(await corrupted.json(), { error: 'Schedule ledger is corrupt.' });
  assert.equal(dispatches, 0);
});


test('reconciliation browser routes decode portable IDs and refuse query, method and caller evidence before dispatch', async (t) => {
  const calls: unknown[] = []; const attemptId = 'attempt:portable';
  const review = { schema: 1, attempt: { attemptId, state: 'awaiting-confirmation', candidate: { readiness: 'not-ready' }, terminal: false }, currentBinding: { state: 'not-checked' }, effects: { terminal: false } };
  const { base, headers } = await writableServer(t, {
    describe: () => ({}), create: async () => ({}), action: async () => ({}),
    reconciliationList: async () => { calls.push(['list']); return { configured: true, attempts: [review.attempt], page: { total: 1, limit: 50, omitted: 0 } }; },
    reconciliationReview: async (id) => { calls.push(['review', id]); return id === attemptId ? review : null; },
    reconciliationCheckCurrentBinding: async (id, input) => { calls.push(['check', id, input]); return { ...review, attempt: { ...review.attempt, state: 'blocked' }, currentBinding: { state: 'drift' } }; },
    reconciliationConfirmReviewed: async (id, input) => { calls.push(['confirm-reviewed', id, input]); return { schema: 1, outcome: 'blocked', requestId: 'request:one', review }; },
  });
  const encoded = encodeURIComponent(attemptId); const route = `${base}/api/reconciliation/${encoded}`;
  assert.equal((await fetch(base + '/api/reconciliation')).status, 200);
  assert.deepEqual(await (await fetch(route + '/review')).json(), review);
  assert.equal((await fetch(base + '/api/reconciliation/missing/review')).status, 404);
  const beforeDenials = calls.length;
  for (const url of [base + '/api/reconciliation?', base + '/api/reconciliation?limit=1', route + '/review?', route + '/review?evidence=caller', route + '/check-current-binding?'])
    assert.equal((await fetch(url)).status, 400);
  for (const path of ['/%2Fsource/review', '/bad%ZZ/review', '/a%2Fb/review'])
    assert.equal((await fetch(base + '/api/reconciliation' + path)).status, 400);
  assert.equal((await fetch(route + '/review/extra')).status, 404);
  assert.equal((await fetch(route + '/confirm-reviewed')).status, 405);
  assert.equal((await fetch(route + '/confirm-reviewed', { method: 'PUT', headers, body: '{}' })).status, 405);
  assert.equal((await fetch(route + '/review', { method: 'POST', headers, body: '{}' })).status, 405);
  const post = (action: string, input: unknown, selectedHeaders: Record<string, string> = headers) => fetch(route + '/' + action, { method: 'POST', headers: selectedHeaders, body: JSON.stringify(input) });
  const request = { requestId: 'request:one', reviewSha256: 'a'.repeat(64) };
  for (const input of [{ ...request, evidence: [] }, { ...request, confirmedAt: 'browser-time' }, { ...request, confirmedBy: 'browser-operator' }, { ...request, current: {} }, { ...request, requestId: 'bad/id' }, { ...request, reviewSha256: 'A'.repeat(64) }, { requestId: 'missing-digest' }])
    assert.equal((await post('confirm-reviewed', input)).status, 400);
  assert.equal((await post('check-current-binding', { current: {} })).status, 400);
  assert.equal((await post('confirm-reviewed', request, { ...headers, origin: 'http://untrusted.invalid' })).status, 403);
  assert.equal((await post('confirm-reviewed', request, { ...headers, 'x-temari-token': 'wrong-token' })).status, 403);
  assert.equal((await post('confirm-reviewed', request, { ...headers, 'content-type': 'text/plain' })).status, 415);
  assert.equal(calls.length, beforeDenials);
  const check = await post('check-current-binding', {}); assert.equal(check.status, 200); assert.equal((await check.json()).currentBinding.state, 'drift');
  const result = await post('confirm-reviewed', request); assert.equal(result.status, 200); assert.equal((await result.json()).outcome, 'blocked');
  assert.deepEqual(calls.slice(beforeDenials), [['check', attemptId, {}], ['confirm-reviewed', attemptId, request]]);
});

test('unconfigured and Talk-only reconciliation stays read-only and raw host errors are not projected', async (t) => {
  const server = await startTaskViewServer({ runtime: emptyReader, archonBaseUrl: 'http://127.0.0.1:3091', port: 0 });
  t.after(() => closeServer(server)); const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const list = await (await fetch(base + '/api/reconciliation')).json(); assert.equal(list.configured, false); assert.deepEqual(list.attempts, []); assert.equal(list.capabilities.canRecordConfirmationIntent, false);
  assert.equal((await fetch(base + '/api/reconciliation/a/confirm-reviewed', { method: 'POST', body: '{}' })).status, 405);
  const talkOnly = await talkServer(t, talkFixture([]));
  assert.equal(talkOnly.dashboard.talkAvailable, true);
  assert.equal((await (await fetch(talkOnly.base + '/api/reconciliation')).json()).configured, false);
  assert.equal((await fetch(talkOnly.base + '/api/reconciliation/a/confirm-reviewed', { method: 'POST', headers: talkOnly.headers, body: JSON.stringify({ requestId: 'r', reviewSha256: 'a'.repeat(64) }) })).status, 405);
  const broken = await writableServer(t, {
    describe: () => ({}), create: async () => ({}), action: async () => ({}),
    reconciliationList: async () => { throw new Error('Unsealed source /private/unselected/root\nprivate native command output'); },
    reconciliationReview: async () => { const error = new Error('\u001b[31mprivate root /not/for/browser\u001b[0m') as Error & { status: number }; error.name = 'ReconciliationBrowserRequestError'; error.status = 409; throw error; },
  });
  const failure = await fetch(broken.base + '/api/reconciliation'); assert.equal(failure.status, 500); assert.deepEqual(await failure.json(), { error: 'Reconciliation state could not be read or retained.' });
  const conflict = await fetch(broken.base + '/api/reconciliation/a/review'); assert.equal(conflict.status, 409); assert.deepEqual(await conflict.json(), { error: 'Reconciliation request refused.' });
});
