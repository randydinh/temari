import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
  writeFile,
  rm,
  symlink,
  realpath,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  createProtectedModelTransport,
  encodeSchemaForPrivacy,
  decodeSchemaForPrivacy,
  type ModelDriver,
} from './model-transport.js';
import type { JsonValue } from '@temari/privacy';

test('masks prompt, file, screenshot text, schema descriptions and dynamic tool results before egress', async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'temari-host-privacy-')),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'input.txt');
  await writeFile(
    file,
    'Contact customer@example.invalid. password=local-secret-canary',
  );
  const sent: string[] = [];
  const driver: ModelDriver = {
    async complete(request, callTool) {
      sent.push(JSON.stringify(request));
      assert.deepEqual(request.outputSchema, {
        type: 'object',
        properties: { email: { type: 'string' }, password: { type: 'string' } },
      });
      const result = await callTool(request.tools[0].name, {
        resource: 'file_1',
      });
      sent.push(result);
      return result;
    },
  };
  const transport = createProtectedModelTransport(driver, {
    files: { file_1: file },
    screenshotText: {
      screen_1: async () => 'Account owner: Alice Example, phone 202-555-0198',
    },
    policy: { literals: [{ value: 'Alice Example', kind: 'PERSON' }] },
    tools: [
      {
        description: 'Inspect customer@example.invalid',
        inputSchema: {
          type: 'object',
          properties: {
            resource: { type: 'string' },
            email: { type: 'string' },
          },
        },
        async execute(args) {
          assert.deepEqual(args, { resource: 'file_1' });
          return [
            {
              kind: 'json',
              value: {
                fullName: 'Alice Example',
                email: 'other@example.invalid',
                password: 'second-secret',
              },
            },
          ];
        },
      },
    ],
  });
  const reply = await transport.complete({
    prompt: 'Help Alice Example and customer@example.invalid.',
    context: [
      { kind: 'file', id: 'file_1' },
      { kind: 'screenshot', id: 'screen_1' },
    ],
    outputSchema: {
      type: 'object',
      properties: { email: { type: 'string' }, password: { type: 'string' } },
    },
  });
  for (const canary of [
    'Alice Example',
    'customer@example.invalid',
    'other@example.invalid',
    '202-555-0198',
    'local-secret-canary',
    'second-secret',
    file,
  ]) {
    assert.equal(
      sent.join('\n').includes(canary),
      false,
      'private value reached the driver',
    );
    assert.equal(
      JSON.stringify(reply).includes(canary),
      false,
      'private value reached a serializable result',
    );
  }
  assert.match(reply.displayText(), /Alice Example/);
  assert.match(reply.displayText(), /other@example.invalid/);
  assert.doesNotMatch(reply.displayText(), /second-secret/);
  reply.dispose();
  assert.throws(() => reply.displayText(), /closed/);
});

test('blocks unauthorized file references, symlinks and screenshots without an extractor before dispatch', async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'temari-host-deny-')),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'file'), 'private');
  await symlink(join(root, 'file'), join(root, 'link'));
  let dispatched = false;
  const transport = createProtectedModelTransport(
    {
      async complete() {
        dispatched = true;
        return 'bad';
      },
    },
    { files: { linked: join(root, 'link') } },
  );
  for (const content of [
    { kind: 'file', id: '../file' },
    { kind: 'file', id: 'linked' },
    { kind: 'screenshot', id: 'screen' },
  ] as const) {
    await assert.rejects(
      transport.complete({ prompt: 'read', context: [content] }),
      /Protected model request failed/,
    );
  }
  assert.equal(dispatched, false);
});

test('rejects an allowlisted file beneath an attacker-writable ancestor before dispatch', async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'temari-host-ancestor-')),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const writable = join(root, 'writable');
  await mkdir(writable, { mode: 0o777 });
  await chmod(writable, 0o777);
  const file = join(writable, 'private.txt');
  await writeFile(file, 'synthetic@example.invalid');
  let dispatched = false;
  const transport = createProtectedModelTransport(
    {
      async complete() {
        dispatched = true;
        return 'unexpected';
      },
    },
    { files: { selected: file } },
  );
  await assert.rejects(
    transport.complete({
      prompt: 'read selected',
      context: [{ kind: 'file', id: 'selected' }],
    }),
    /Protected model request failed/,
  );
  assert.equal(dispatched, false);
});

test('suppresses private tool/provider errors and never retries an unfiltered call', async () => {
  let calls = 0;
  const transport = createProtectedModelTransport({
    async complete() {
      calls++;
      throw new Error('raw-person@example.invalid');
    },
  });
  await assert.rejects(
    transport.complete({ prompt: 'hello' }),
    (error: Error) =>
      !error.message.includes('raw-person') && error.cause === undefined,
  );
  assert.equal(calls, 1);
  const failedTool = createProtectedModelTransport(
    {
      async complete(request, callTool) {
        return callTool(request.tools[0].name, {});
      },
    },
    {
      tools: [
        {
          description: 'lookup',
          inputSchema: { type: 'object' },
          async execute() {
            throw new Error('private credential');
          },
        },
      ],
    },
  );
  await assert.rejects(
    failedTool.complete({ prompt: 'lookup' }),
    (error: Error) => !error.message.includes('credential'),
  );
});

test('keeps request mappings isolated, handles cancellation, and blocks post-completion tools', async () => {
  let delayed: (() => Promise<string>) | undefined;
  let firstReply = '';
  const transport = createProtectedModelTransport({
    async complete(request, callTool) {
      delayed = () => callTool('temari_host_1', {});
      const parsed = JSON.parse(request.prompt);
      if (!firstReply) {
        firstReply = parsed.prompt;
        return firstReply;
      }
      return firstReply;
    },
  });
  const first = await transport.complete({ prompt: 'one@example.invalid' });
  await assert.rejects(
    transport.complete({ prompt: 'two@example.invalid' }),
    /Protected model request failed/,
  );
  await assert.rejects(delayed!(), /not permitted/);
  const controller = new AbortController();
  controller.abort(new Error('private abort reason'));
  await assert.rejects(
    transport.complete({ prompt: 'three@example.invalid' }, controller.signal),
    (error: Error) => !error.message.includes('private abort'),
  );
  first.dispose();
});

test('keeps discovered credentials masked across unlabeled tool results and the final reply', async () => {
  const secret = 'synthetic-cross-batch-credential';
  const sent: string[] = [];
  const transport = createProtectedModelTransport(
    {
      async complete(request, callTool) {
        sent.push(JSON.stringify(request));
        sent.push(await callTool(request.tools[0].name, {}));
        return `The tool returned ${secret}.`;
      },
    },
    {
      tools: [
        {
          description: 'Read an authorized synthetic fixture',
          inputSchema: { type: 'object' },
          async execute() {
            return [{ kind: 'text', text: `Fixture value: ${secret}` }];
          },
        },
      ],
    },
  );
  const reply = await transport.complete({
    prompt: 'Summarize the fixture.',
    context: [{ kind: 'json', value: { password: secret } }],
  });
  try {
    for (const value of [...sent, reply.text, reply.displayText()]) {
      assert.equal(value.includes(secret), false);
    }
  } finally {
    reply.dispose();
  }
});

test('schema encoding preserves keys, arrays and scalar types without interpreting schema field names', () => {
  const schema: JsonValue = JSON.parse(
    '{"type":"object","properties":{"password":{"type":"string"},"__proto__":{"const":null}},"required":["password"],"additionalProperties":false,"examples":[0,true,null,"object",["array",[]]]}',
  );
  assert.deepEqual(
    decodeSchemaForPrivacy(encodeSchemaForPrivacy(schema)),
    schema,
  );
  for (const value of [null, true, false, 0, 1.25, 'value', [], {}])
    assert.deepEqual(
      decodeSchemaForPrivacy(encodeSchemaForPrivacy(value)),
      value,
    );
});

test('restores protected tool property names only for the trusted callback', async () => {
  const property = 'Synthetic Credential Field';
  const value = 'Synthetic Person Name';
  let callbackCalls = 0;
  const transport = createProtectedModelTransport(
    {
      async complete(request, callTool) {
        const properties = (
          request.tools[0].inputSchema as {
            properties: Record<string, unknown>;
          }
        ).properties;
        const [maskedProperty] = Object.keys(properties);
        assert.notEqual(maskedProperty, property);
        const result = await callTool(request.tools[0].name, {
          [maskedProperty]: value,
        });
        assert.equal(result.includes(value), false);
        return result;
      },
    },
    {
      policy: {
        literals: [
          { value: property, kind: 'CREDENTIAL' },
          { value, kind: 'PERSON' },
        ],
      },
      tools: [
        {
          description: 'Use the synthetic field',
          inputSchema: {
            type: 'object',
            properties: { [property]: { type: 'string' } },
          },
          async execute(args) {
            callbackCalls++;
            assert.deepEqual(Object.keys(args as object), [property]);
            assert.notEqual(
              (args as Record<string, JsonValue>)[property],
              value,
            );
            return [{ kind: 'json', value: { accepted: true } }];
          },
        },
      ],
    },
  );
  const reply = await transport.complete({ prompt: 'Use the selected tool.' });
  try {
    assert.equal(callbackCalls, 1);
    assert.deepEqual(JSON.parse(reply.text), [
      { kind: 'json', value: { accepted: true } },
    ]);
  } finally {
    reply.dispose();
  }
});

for (const [label, literal] of [
  ['quotes', 'Synthetic "Private" Name'],
  ['backslashes', 'Synthetic\\Private\\Name'],
  ['newlines', 'Synthetic\nPrivate\nName'],
] as const) {
  for (const kind of ['PERSON', 'CREDENTIAL'] as const) {
    test(`masks decoded output and tool schema ${kind} keys and values containing ${label}`, async () => {
      const schema: { [key: string]: JsonValue } = {
        type: 'object',
        properties: {
          password: { type: 'string' },
          [literal]: { type: 'string', description: literal, enum: [literal] },
        },
        required: [literal],
        additionalProperties: false,
        minProperties: 0,
      };
      let calls = 0;
      const transport = createProtectedModelTransport(
        {
          async complete(request) {
            calls++;
            const token = JSON.parse(request.prompt).prompt;
            assert.notEqual(token, literal);
            const expected = {
              ...schema,
              properties: {
                password: { type: 'string' },
                [token]: { type: 'string', description: token, enum: [token] },
              },
              required: [token],
            };
            assert.deepEqual(request.outputSchema, expected);
            assert.deepEqual(request.tools[0].inputSchema, expected);
            assert.equal(request.tools[0].description, token);
            return JSON.stringify({ echo: token });
          },
        },
        {
          policy: { literals: [{ value: literal, kind }] },
          tools: [
            {
              description: literal,
              inputSchema: schema,
              async execute() {
                return [];
              },
            },
          ],
        },
      );
      const reply = await transport.complete({
        prompt: literal,
        outputSchema: schema,
      });
      try {
        assert.notEqual(JSON.parse(reply.text).echo, literal);
        assert.equal(
          JSON.parse(reply.displayText()).echo === literal,
          kind === 'PERSON',
        );
      } finally {
        reply.dispose();
      }
      assert.equal(calls, 1);
    });
  }
}

test('schema leaves reuse identities discovered in the same initial context batch', async () => {
  const identity = 'Synthetic "Context"\\Name\nNext';
  const schema = { type: 'string', description: identity };
  let checked = false;
  const transport = createProtectedModelTransport(
    {
      async complete(request) {
        const prompt = JSON.parse(request.prompt);
        assert.notEqual(prompt.prompt, identity);
        assert.equal(prompt.context[0].value.fullname, prompt.prompt);
        assert.deepEqual(request.outputSchema, {
          ...schema,
          description: prompt.prompt,
        });
        assert.deepEqual(request.tools[0].inputSchema, request.outputSchema);
        checked = true;
        return JSON.stringify(prompt.prompt);
      },
    },
    {
      tools: [
        {
          description: 'Lookup',
          inputSchema: schema,
          async execute() {
            return [];
          },
        },
      ],
    },
  );
  const reply = await transport.complete({
    prompt: identity,
    context: [{ kind: 'json', value: { fullname: identity } }],
    outputSchema: schema,
  });
  try {
    assert.equal(checked, true);
    assert.equal(JSON.parse(reply.displayText()), identity);
  } finally {
    reply.dispose();
  }
});

test('schema decoding refuses malformed tags, tuples, scalar types and duplicate keys', () => {
  const malformed: JsonValue[] = [
    null,
    {},
    [],
    ['unknown', 'value'],
    ['string'],
    ['null', null],
    ['string', 1],
    ['number', '1'],
    ['boolean', 'false'],
    ['array', {}],
    ['object', {}],
    ['object', [['key']]],
    ['object', [[1, ['null']]]],
    ['object', [['key', ['null'], 'extra']]],
    [
      'object',
      [
        ['key', ['null']],
        ['key', ['null']],
      ],
    ],
  ];
  for (const value of malformed)
    assert.throws(
      () => decodeSchemaForPrivacy(value),
      /Invalid protected schema/,
    );
});

test('policy changes to schema tags or numeric leaf types fail before dispatch', async () => {
  let calls = 0;
  for (const path of ['/outputSchema', '/tools/0/schema']) {
    const transport = createProtectedModelTransport(
      {
        async complete() {
          calls++;
          return '{}';
        },
      },
      {
        policy: { fields: [{ path }] },
        tools: [
          {
            description: 'Lookup',
            inputSchema: { type: 'object' },
            async execute() {
              return [];
            },
          },
        ],
      },
    );
    await assert.rejects(
      transport.complete({ prompt: 'test', outputSchema: { type: 'object' } }),
      /Protected model request failed/,
    );
  }
  const transport = createProtectedModelTransport(
    {
      async complete() {
        calls++;
        return '{}';
      },
    },
    { policy: { literals: [{ value: 17 }] } },
  );
  await assert.rejects(
    transport.complete({ prompt: 'test', outputSchema: { const: 17 } }),
    /Protected model request failed/,
  );
  assert.equal(calls, 0);
});

test('without an output schema JSON-looking replies remain plain text, not semantic fields', async () => {
  const text = JSON.stringify({ fullname: 'Synthetic Plaintext Name' });
  const transport = createProtectedModelTransport({
    async complete() {
      return text;
    },
  });
  const reply = await transport.complete({ prompt: 'test' });
  try {
    assert.equal(reply.text, text);
  } finally {
    reply.dispose();
  }
});
