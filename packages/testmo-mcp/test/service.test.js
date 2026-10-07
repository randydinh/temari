import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../src/service.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readWindowsToken } from '../src/credential.js';

const config = { baseUrl: 'https://example.testmo.net', projectId: 41 };

async function setup(t, responses, options = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'testmo-mcp-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const calls = [];
  const service = createService({
    ...config,
    token: 'secret-test-token',
    writeEnabled: true,
    stateDir,
    fetchImpl: async (url, init) => {
      calls.push({ url, ...init });
      assert.equal(init.redirect, 'error');
      assert.ok(url.startsWith('https://example.testmo.net/api/v1/'));
      let next = responses.shift();
      if (typeof next === 'function') next = next(calls);
      if (next instanceof Error) throw next;
      assert.ok(next, 'Unexpected HTTP request');
      return new Response(JSON.stringify(next.body ?? next), {
        status: next.status ?? 200,
      });
    },
    ...options,
  });
  return { service, calls, responses, stateDir };
}
test('pagination finds a case on the second page, scoped to the configured project', async (t) => {
  const { service, calls } = await setup(t, [
    { result: [], next_page: 2 },
    { result: [{ id: 9, project_id: 41 }] },
  ]);
  assert.equal(
    (await service.call('testmo_get_case', { case_id: 9 })).result.id,
    9,
  );
  assert.match(calls[1].url, /page=2/);
});
test('wrong project run and caller-supplied project cannot escape scope', async (t) => {
  const { service, calls } = await setup(t, [
    { result: { id: 9, project_id: 4 } },
  ]);
  await assert.rejects(
    service.call('testmo_list_results', { run_id: 9 }),
    /outside the configured project/,
  );
  await assert.rejects(
    service.call('testmo_list_cases', { project_id: 4 }),
    /Unrecognized/,
  );
  assert.equal(calls.length, 1);
});
test('read-only mode blocks writes before any HTTP request', async (t) => {
  const { service, calls } = await setup(t, [], { writeEnabled: false });
  await assert.rejects(
    service.call('testmo_create_case', {
      operation_key: 'case-key-1',
      name: 'Login',
    }),
    /disabled/,
  );
  assert.equal(calls.length, 0);
});
test('case creation readback and durable replay avoid duplicates across restart', async (t) => {
  const { service, calls, stateDir } = await setup(t, [
    { result: [{ id: 9 }] },
    {
      result: [
        {
          id: 9,
          project_id: 41,
          name: 'Login',
          custom_description: 'Expected behavior',
        },
      ],
    },
  ]);
  const input = {
    operation_key: 'case-key-1',
    name: 'Login',
    custom_fields: { custom_description: 'Expected behavior' },
  };
  assert.equal(
    (await service.call('testmo_create_case', input)).state,
    'verified',
  );
  const restarted = createService({
    ...config,
    token: 'other-token',
    writeEnabled: true,
    stateDir,
    fetchImpl: () => {
      throw new Error('Replay must not call HTTP');
    },
  });
  assert.equal(
    (await restarted.call('testmo_create_case', input)).state,
    'verified',
  );
  assert.equal(
    (await service.call('testmo_create_case', input)).state,
    'verified',
  );
  await assert.rejects(
    service.call('testmo_create_case', { ...input, name: 'Different' }),
    /different content/,
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].body).cases[0], {
    name: 'Login',
    custom_description: 'Expected behavior',
  });
});
test('timeout remains uncertain and cannot resend even after restart', async (t) => {
  const { service, calls, stateDir } = await setup(t, [
    new Error('secret-test-token'),
  ]);
  const input = { operation_key: 'case-key-1', name: 'Login' };
  await assert.rejects(
    service.call('testmo_create_case', input),
    /No automatic retry/,
  );
  await assert.rejects(service.call('testmo_create_case', input), /uncertain/);
  const restarted = createService({
    ...config,
    token: 'other-token',
    writeEnabled: true,
    stateDir,
    fetchImpl: () => {
      throw new Error('Uncertain operation must not call HTTP');
    },
  });
  await assert.rejects(
    restarted.call('testmo_create_case', input),
    /uncertain/,
  );
  const receipt = await service.call('testmo_operation', {
    operation_key: input.operation_key,
  });
  assert.equal(receipt.state, 'uncertain');
  assert.ok(!JSON.stringify(receipt).includes('secret-test-token'));
  assert.equal(calls.length, 1);
});
test('stale update rejects and a narrow update preserves omitted fields', async (t) => {
  const initial = {
    id: 9,
    project_id: 41,
    name: 'Old',
    updated_at: 'v1',
    custom_steps: [{ text1: 'Act', text3: 'Expect' }],
  };
  const { service, calls } = await setup(t, [
    { result: [initial] },
    { result: [initial] },
    { result: [initial] },
    { result: [{ ...initial, name: 'New' }] },
  ]);
  const input = {
    operation_key: 'update-key-1',
    case_id: 9,
    name: 'New',
    expected_updated_at: null,
  };
  await assert.rejects(
    service.call('testmo_update_case', input),
    /changed since/,
  );
  assert.equal(
    (
      await service.call('testmo_update_case', {
        ...input,
        expected_updated_at: 'v1',
      })
    ).state,
    'verified',
  );
  assert.deepEqual(JSON.parse(calls[2].body), { ids: [9], name: 'New' });
});
test('custom field readback mismatch cannot be reported as verified', async (t) => {
  const { service } = await setup(t, [
    { result: [{ id: 9 }] },
    { result: [{ id: 9, project_id: 41, name: 'Login', custom_steps: [] }] },
  ]);
  await assert.rejects(
    service.call('testmo_create_case', {
      operation_key: 'case-key-1',
      name: 'Login',
      custom_fields: { custom_steps: [{ text1: 'Act', text3: 'Expect' }] },
    }),
    /readback mismatch/,
  );
  assert.equal(
    (await service.call('testmo_operation', { operation_key: 'case-key-1' }))
      .state,
    'uncertain',
  );
});
const proof = {
  operation_key: 'result-key-1',
  run_id: 8,
  test_id: 90,
  status_id: 7,
  executed: true,
  candidate_commit: 'a'.repeat(40),
  served_build: 'Example build 42',
  environment: 'isolated lab',
  scope: 'partial-check',
  assertions: 'normal edit succeeds <script>',
  remaining_scenarios: 'Additional scenario',
  evidence: ['C:/evidence/run.json'],
  ticket: 'ISSUE-123',
};
test('append result records escaped provenance, verifies history and never patches it', async (t) => {
  const { service, calls, responses } = await setup(t, [
    { result: { project_id: 41 } },
    { result: [{ id: 7, is_active: true }] },
    { result: { id: 91 } },
  ]);
  responses.push((calls) => ({
    result: [
      {
        id: 91,
        test_id: 90,
        status_id: 7,
        note: JSON.parse(calls[2].body).comment,
      },
    ],
  }));
  assert.equal(
    (await service.call('testmo_add_result', proof)).state,
    'verified',
  );
  const body = JSON.parse(calls[2].body);
  assert.match(body.comment, /partial-check/);
  assert.match(body.comment, /&lt;script&gt;/);
  assert.match(body.comment, /Additional scenario/);
  assert.equal(calls[2].method, 'POST');
  assert.match(calls[2].url, /runs\/8\/tests\/90\/results$/);
});
test('unexecuted proof, inactive status and incomplete full acceptance rejected', async (t) => {
  const { service, calls } = await setup(t, [
    { result: { project_id: 41 } },
    { result: { project_id: 41 } },
    { result: [{ id: 7, is_active: false }] },
  ]);
  await assert.rejects(
    service.call('testmo_add_result', { ...proof, executed: false }),
  );
  await assert.rejects(
    service.call('testmo_add_result', {
      ...proof,
      scope: 'full-ticket-acceptance',
    }),
    /remaining scenarios/,
  );
  await assert.rejects(service.call('testmo_add_result', proof), /inactive/);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
});
test('run creation validates case ownership and explicit subset', async (t) => {
  const { service, calls } = await setup(t, [
    { result: [{ id: 9, project_id: 41 }] },
    { result: [{ id: 2 }] },
    { result: { id: 8 } },
    {
      result: {
        id: 8,
        project_id: 41,
        name: 'Candidate QA',
        state_id: 2,
        include_all: false,
        total_count: 1,
      },
    },
  ]);
  assert.equal(
    (
      await service.call('testmo_create_run', {
        operation_key: 'run-key-1',
        name: 'Candidate QA',
        state_id: 2,
        case_ids: [9],
        docs: 'Pinned candidate',
      })
    ).state,
    'verified',
  );
  assert.deepEqual(JSON.parse(calls[2].body).cases, [9]);
  assert.equal(JSON.parse(calls[2].body).include_all, false);
});
test('remote error bodies and redirected requests cannot leak tokens', async (t) => {
  const { service } = await setup(t, [
    { status: 401, body: { error: 'secret-test-token' } },
  ]);
  await assert.rejects(
    service.call('testmo_list_cases', {}),
    (e) =>
      e.message.includes('401') && !e.message.includes('secret-test-token'),
  );
});
test('concurrent writes with one key issue at most one POST', async (t) => {
  const { service, calls } = await setup(t, [
    { result: [{ id: 9 }] },
    { result: [{ id: 9, project_id: 41, name: 'Login' }] },
  ]);
  const input = { operation_key: 'case-key-1', name: 'Login' };
  const outcomes = await Promise.allSettled([
    service.call('testmo_create_case', input),
    service.call('testmo_create_case', input),
  ]);
  assert.ok(outcomes.some((r) => r.status === 'fulfilled'));
  assert.equal(calls.filter((c) => c.method === 'POST').length, 1);
});
test('full acceptance cannot publish a failed status', async (t) => {
  const { service, calls } = await setup(t, [
    { result: { project_id: 41 } },
    { result: [{ id: 7, is_active: true, is_passed: false }] },
  ]);
  await assert.rejects(
    service.call('testmo_add_result', {
      ...proof,
      scope: 'full-ticket-acceptance',
      remaining_scenarios: '',
    }),
    /passing status/,
  );
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
});
test('real stdio MCP handshake lists read-only tools and handles missing credential', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../src/index.js', import.meta.url))],
    env: {
      TESTMO_BASE_URL: config.baseUrl,
      TESTMO_PROJECT_ID: String(config.projectId),
      TESTMO_MCP_WRITE_ENABLED: 'false',
      TESTMO_TOKEN: '',
    },
  });
  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 7);
    assert.ok(tools.tools.every((t) => t.annotations.readOnlyHint));
    const result = await client.callTool({
      name: 'testmo_list_cases',
      arguments: {},
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /TOKEN is missing/);
  } finally {
    await client.close();
  }
});
test(
  'registered Windows launcher starts MCP in read-only mode',
  { skip: process.platform !== 'win32' },
  async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('../src/index.js', import.meta.url))],
      env: {
        TESTMO_BASE_URL: config.baseUrl,
        TESTMO_PROJECT_ID: String(config.projectId),
        TESTMO_MCP_WRITE_ENABLED: 'false',
        TESTMO_TOKEN: '',
      },
    });
    const client = new Client({
      name: 'windows-launcher-test',
      version: '1.0.0',
    });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      assert.equal(tools.tools.length, 7);
      assert.ok(tools.tools.every((t) => t.annotations.readOnlyHint));
    } finally {
      await client.close();
    }
  },
);
test(
  'Windows DPAPI roundtrip captures a synthetic token privately',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'testmo-dpapi-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const tokenPath = join(dir, 'token.dpapi');
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Import-Module (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop; ConvertTo-SecureString 'synthetic-test-token-only' -AsPlainText -Force | ConvertFrom-SecureString | Set-Content -LiteralPath $env:MCP_TEST_TOKEN_FILE",
      ],
      {
        env: { ...process.env, MCP_TEST_TOKEN_FILE: tokenPath },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    assert.equal(readWindowsToken(tokenPath), 'synthetic-test-token-only');
    assert.throws(
      () => readWindowsToken(join(dir, 'missing')),
      /Unable to decrypt/,
    );
  },
);

test('invalid or absent host configuration fails before any HTTP request', () => {
  const noHttp = () => {
    throw new Error('No HTTP allowed');
  };
  for (const baseUrl of [
    undefined,
    '',
    'http://example.testmo.net',
    'https://example.testmo.net.evil.invalid',
    'https://user:pass@example.testmo.net',
    'https://example.testmo.net/path',
    'https://example.testmo.net?secret=value',
    'https://example.testmo.net#fragment',
    'https://example.testmo.net:8443',
  ])
    assert.throws(
      () => createService({ ...config, baseUrl, fetchImpl: noHttp }),
      /TESTMO_BASE_URL/,
    );
  for (const projectId of [
    undefined,
    '',
    0,
    -1,
    1.5,
    '41junk',
    '1e3',
    Number.MAX_SAFE_INTEGER + 1,
  ])
    assert.throws(
      () => createService({ ...config, projectId, fetchImpl: noHttp }),
      /TESTMO_PROJECT_ID/,
    );
});

test('configured origin and project bind requests and permit no caller scope override', async (t) => {
  const { service, calls } = await setup(t, [{ result: [] }], {
    baseUrl: 'https://another.testmo.net/',
    projectId: '73',
    fetchImpl: async (url, init) => {
      assert.equal(
        url,
        'https://another.testmo.net/api/v1/projects/73/cases?page=1&per_page=100',
      );
      assert.equal(init.redirect, 'error');
      return new Response(JSON.stringify({ result: [] }));
    },
  });
  await service.call('testmo_list_cases', {});
  assert.deepEqual(service.scope, {
    baseUrl: 'https://another.testmo.net',
    projectId: 73,
  });
  await assert.rejects(
    service.call('testmo_list_cases', { baseUrl: config.baseUrl }),
    /Unrecognized/,
  );
  assert.equal(calls.length, 0);
});

test('receipts cannot replay across tenants or projects even with the same operation key', async (t) => {
  const { service, stateDir } = await setup(t, [
    { result: [{ id: 9 }] },
    { result: [{ id: 9, project_id: 41, name: 'Login' }] },
  ]);
  const input = { operation_key: 'case-key-1', name: 'Login' };
  await service.call('testmo_create_case', input);
  for (const other of [
    { baseUrl: 'https://another.testmo.net' },
    { projectId: 73 },
  ]) {
    const scoped = createService({
      ...config,
      ...other,
      token: 'synthetic',
      stateDir,
      writeEnabled: true,
      fetchImpl: async () => {
        throw new Error('different scope attempted HTTP');
      },
    });
    assert.deepEqual(
      await scoped.call('testmo_operation', {
        operation_key: input.operation_key,
      }),
      { state: 'not-started' },
    );
    await assert.rejects(
      scoped.call('testmo_create_case', input),
      /No automatic retry/,
    );
  }
  const receipt = await service.call('testmo_operation', {
    operation_key: input.operation_key,
  });
  assert.equal(receipt.state, 'verified');
  assert.deepEqual(receipt.scope, config);
});

test('unscoped legacy journals require reconciliation and are never replayed', async (t) => {
  const { service, calls, stateDir } = await setup(t, []);
  await writeFile(
    join(stateDir, 'legacy-key-1.json'),
    JSON.stringify({ state: 'verified' }),
  );
  await assert.rejects(
    service.call('testmo_create_case', {
      operation_key: 'legacy-key-1',
      name: 'Login',
    }),
    /Legacy unscoped/,
  );
  assert.equal(calls.length, 0);
});

test('tampered receipt scope fails closed', async (t) => {
  const { service, stateDir } = await setup(t, [
    { result: [{ id: 9 }] },
    { result: [{ id: 9, project_id: 41, name: 'Login' }] },
  ]);
  await service.call('testmo_create_case', {
    operation_key: 'case-key-1',
    name: 'Login',
  });
  const [dir] = await readdir(stateDir);
  const file = join(stateDir, dir, 'case-key-1.json');
  const entry = JSON.parse(await readFile(file, 'utf8'));
  entry.scope.projectId = 73;
  await writeFile(file, JSON.stringify(entry));
  await assert.rejects(
    service.call('testmo_operation', { operation_key: 'case-key-1' }),
    /scope binding/,
  );
});
