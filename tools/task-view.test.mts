import assert from 'node:assert/strict';
import { request } from 'node:http';
import test from 'node:test';
import { startTaskViewServer, validateArchonBaseUrl } from './task-view.mjs';

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
  assert.equal((await fetch(`${base}/api/tasks/one`)).status, 200);
  assert.equal((await fetch(`${base}/api/tasks/missing`)).status, 404);
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
  assert.match(await page.text(), /Task inbox/);
  assert.equal((await fetch(`${base}/task-view.js`)).status, 200);
  assert.equal((await fetch(`${base}/task-view.css`)).status, 200);
  assert.equal((await fetch(base, { method: 'HEAD' })).status, 200);
});

test('task read failures stay visible instead of looking like an empty inbox', async (t) => {
  const server = await startTaskViewServer({
    runtime: {
      listSnapshots: async () => {
        throw new Error('Task ledger digest mismatch.');
      },
      snapshot: async () => null,
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
