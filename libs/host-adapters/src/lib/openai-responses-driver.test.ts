import assert from 'node:assert/strict';
import test from 'node:test';

import { createProtectedModelTransport } from './model-transport.js';
import { createOpenAIResponsesDriver } from './openai-responses-driver.js';

function reply(output: unknown) {
  return new Response(JSON.stringify({ status: 'completed', output }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

test('Responses driver keeps provider details behind ModelDriver and host tool content masked', async () => {
  const requests: { url: string; body: any; authorization: string }[] = [];
  let credentialCalls = 0;
  let toolCalls = 0;
  const responses = [
    reply([
      {
        type: 'function_call',
        name: 'temari_host_1',
        call_id: 'call_1',
        arguments: JSON.stringify({ id: 'account-1' }),
      },
    ]),
    reply([
      {
        type: 'message',
        content: [{ type: 'output_text', text: 'Account is ready.' }],
      },
    ]),
  ];
  const driver = createOpenAIResponsesDriver({
    model: 'test-model',
    credential: async () => {
      credentialCalls++;
      return 'test-secret';
    },
    fetchImpl: (async (url, init) => {
      requests.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
        authorization: new Headers(init?.headers).get('authorization') ?? '',
      });
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
          toolCalls++;
          assert.deepEqual(args, { id: 'account-1' });
          return [{ kind: 'text', text: 'Alice owns this account.' }];
        },
      },
    ],
  });
  const result = await transport.complete({ prompt: 'Check Alice’s account.' });
  try {
    assert.equal(result.text, 'Account is ready.');
    assert.equal(result.coverage, 'host-mediated-text');
    assert.equal(toolCalls, 1);
    assert.equal(credentialCalls, 1);
    assert.equal(requests.length, 2);
    assert(
      requests.every(
        ({ url }) => url === 'https://api.openai.com/v1/responses',
      ),
    );
    assert(requests.every(({ body }) => body.store === false));
    assert(
      requests.every(
        ({ authorization }) => authorization === 'Bearer test-secret',
      ),
    );
    assert(!JSON.stringify(requests.map(({ body }) => body)).includes('Alice'));
    assert(
      !JSON.stringify(requests.map(({ body }) => body)).includes('test-secret'),
    );
    assert.equal(requests[1].body.input.at(-1).type, 'function_call_output');
  } finally {
    result.dispose();
  }
});

test('Responses driver sends a declared JSON schema and returns masked JSON', async () => {
  let body: any;
  const driver = createOpenAIResponsesDriver({
    model: 'other-model',
    credential: async () => 'test-secret',
    fetchImpl: (async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return reply([
        {
          type: 'message',
          content: [{ type: 'output_text', text: '{"person":"Alice"}' }],
        },
      ]);
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
    assert.equal(body.text.format.type, 'json_schema');
    assert.equal(body.text.format.strict, true);
    assert(!result.text.includes('Alice'));
    assert.equal(JSON.parse(result.displayText()).person, 'Alice');
  } finally {
    result.dispose();
  }
});

test('Responses driver rejects unknown tools, provider errors, and incomplete replies without fallback', async () => {
  for (const output of [
    reply([
      {
        type: 'function_call',
        name: 'unknown_tool',
        call_id: 'call_1',
        arguments: '{}',
      },
    ]),
    new Response('private provider detail', { status: 500 }),
    new Response(JSON.stringify({ status: 'incomplete', output: [] }), {
      status: 200,
    }),
  ]) {
    let calls = 0;
    const driver = createOpenAIResponsesDriver({
      model: 'test-model',
      credential: async () => 'test-secret',
      fetchImpl: (async () => {
        calls++;
        return output;
      }) as typeof fetch,
    });
    const transport = createProtectedModelTransport(driver);
    await assert.rejects(
      transport.complete({ prompt: 'hello' }),
      /Protected model request failed/,
    );
    assert.equal(calls, 1);
  }
});
