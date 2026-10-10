import assert from 'node:assert/strict';
import test from 'node:test';

import { createProtectedModelTransport } from './model-transport.js';
import { createOllamaModelDriver } from './ollama-model-driver.js';

function reply(message: unknown) {
  return new Response(JSON.stringify({ done: true, message }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

test('Ollama driver uses loopback and keeps host tool content behind masking', async () => {
  const requests: { url: string; body: any }[] = [];
  const responses = [
    reply({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          function: {
            name: 'temari_host_1',
            arguments: { id: 'account-1' },
          },
        },
      ],
    }),
    reply({ role: 'assistant', content: 'Account is ready.' }),
  ];
  const driver = createOllamaModelDriver({
    model: 'qwen3-coder:30b',
    fetchImpl: (async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return responses.shift()!;
    }) as typeof fetch,
  });
  const transport = createProtectedModelTransport(driver, {
    policy: { literals: [{ value: 'Alice', kind: 'PERSON' }] },
    tools: [
      {
        description: 'Read the selected account.',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
          additionalProperties: false,
        },
        execute: async (args) => {
          assert.deepEqual(args, { id: 'account-1' });
          return [{ kind: 'text', text: 'Alice owns this account.' }];
        },
      },
    ],
  });
  const result = await transport.complete({ prompt: 'Check Alice’s account.' });
  try {
    assert.equal(result.text, 'Account is ready.');
    assert.equal(requests.length, 2);
    assert(
      requests.every(({ url }) => url === 'http://127.0.0.1:11434/api/chat'),
    );
    assert(requests.every(({ body }) => body.stream === false));
    assert(!JSON.stringify(requests).includes('Alice'));
    assert.equal(requests[1].body.messages.at(-1).role, 'tool');
  } finally {
    result.dispose();
  }
});

test('Ollama driver sends a JSON schema through its native API', async () => {
  let body: any;
  const driver = createOllamaModelDriver({
    model: 'qwen3-coder:30b',
    fetchImpl: (async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return reply({ role: 'assistant', content: '{"person":"Alice"}' });
    }) as typeof fetch,
  });
  const transport = createProtectedModelTransport(driver, {
    policy: { literals: [{ value: 'Alice', kind: 'PERSON' }] },
  });
  const result = await transport.complete({
    prompt: 'Name the person.',
    outputSchema: {
      type: 'object',
      properties: { person: { type: 'string' } },
      required: ['person'],
      additionalProperties: false,
    },
  });
  try {
    assert.equal(body.format.type, 'object');
    assert(!result.text.includes('Alice'));
    assert.equal(JSON.parse(result.displayText()).person, 'Alice');
  } finally {
    result.dispose();
  }
});

test('Ollama separates tool calls from constrained final packet rendering', async () => {
  const requests: any[] = [];
  const replies = [
    reply({ role: 'assistant', content: '', tool_calls: [{ function: { name: 'temari_host_1', arguments: { query: 'Temari' } } }] }),
    reply({ role: 'assistant', content: '{"answer":"Verified document."}' }),
    reply({ role: 'assistant', content: '{"answer":"Verified document."}' }),
  ];
  let called = false;
  const transport = createProtectedModelTransport(createOllamaModelDriver({
    model: 'tool-fixture',
    fetchImpl: (async (_url, init) => { requests.push(JSON.parse(String(init?.body))); return replies.shift()!; }) as typeof fetch,
  }), { tools: [{ description: 'Search the selected library.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false }, execute: async (args) => { assert.deepEqual(args, { query: 'Temari' }); called = true; return [{ kind: 'text', text: 'Verified source evidence.' }]; } }] });
  const result = await transport.complete({ prompt: 'Retrieve evidence, then answer.', outputSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false } });
  try {
    assert(called);
    assert.equal(requests.length, 3);
    assert(requests.slice(0, 2).every((request) => request.format === undefined));
    assert.equal(requests[2].format.type, 'object');
    assert.deepEqual(requests[2].tools, []);
    assert.match(requests[0].messages[0].content, /After all tool calls/);
    assert.match(requests[0].messages[0].content, /final schema/);
    assert.equal(requests[1].messages.at(-1).role, 'tool');
    assert.equal(JSON.parse(result.displayText()).answer, 'Verified document.');
  } finally { result.dispose(); }
});

test('Ollama refuses tool calls during final packet rendering', async () => {
  const responses = [reply({ role: 'assistant', content: 'Draft answer.' }), reply({ role: 'assistant', content: '', tool_calls: [{ function: { name: 'selected_tool', arguments: {} } }] })];
  const driver = createOllamaModelDriver({ model: 'tool-fixture', fetchImpl: (async () => responses.shift()!) as typeof fetch });
  let calls = 0;
  await assert.rejects(driver.complete({ prompt: 'Answer.', tools: [{ name: 'selected_tool', description: 'Selected library.', inputSchema: { type: 'object' } }], outputSchema: { type: 'object' } }, async () => { calls++; return '{}'; }), /Tools are unavailable during final packet rendering/);
  assert.equal(calls, 0);
});

test('Ollama endpoint rejects non-loopback and credentials in the URL', () => {
  assert.throws(
    () =>
      createOllamaModelDriver({
        model: 'qwen3-coder:30b',
        baseUrl: 'http://example.com:11434',
      }),
    /loopback/,
  );
  assert.throws(
    () =>
      createOllamaModelDriver({
        model: 'qwen3-coder:30b',
        baseUrl: 'http://user:secret@127.0.0.1:11434',
      }),
    /loopback/,
  );
});
