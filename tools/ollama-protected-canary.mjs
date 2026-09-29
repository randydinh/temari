import assert from 'node:assert/strict';

import { createOllamaModelTransport } from '../libs/host-adapters/src/index.ts';

const model = process.env.TEMARI_OLLAMA_MODEL ?? 'qwen3-coder:30b';
let maskedRequest = false;
const transport = createOllamaModelTransport(
  {
    model,
    fetchImpl: async (url, init) => {
      assert.equal(String(url), 'http://127.0.0.1:11434/api/chat');
      const body = String(init?.body);
      assert(!body.includes('Alice'), 'Private fixture was not masked.');
      maskedRequest = true;
      return fetch(url, init);
    },
  },
  {
    policy: { literals: [{ value: 'Alice', kind: 'PERSON' }] },
  },
);
const started = Date.now();
const reply = await transport.complete(
  {
    prompt:
      'This is a synthetic canary for Alice. Return exactly the required JSON object with marker SYNTHETIC_OK.',
    outputSchema: {
      type: 'object',
      properties: { marker: { type: 'string', enum: ['SYNTHETIC_OK'] } },
      required: ['marker'],
      additionalProperties: false,
    },
  },
  AbortSignal.timeout(120_000),
);
try {
  assert.equal(JSON.parse(reply.displayText()).marker, 'SYNTHETIC_OK');
  assert(maskedRequest);
  assert(!reply.text.includes('Alice'));
} finally {
  reply.dispose();
}

let toolCalls = 0;
const toolTransport = createOllamaModelTransport(
  { model },
  {
    tools: [
      {
        description:
          'Read the only synthetic marker. Call this tool before answering.',
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        execute: async () => {
          toolCalls++;
          return [{ kind: 'text', text: 'SYNTHETIC_TOOL_OK' }];
        },
      },
    ],
  },
);
const toolReply = await toolTransport.complete(
  {
    prompt:
      'Call the available host tool to get the synthetic marker. Then report only the marker value.',
  },
  AbortSignal.timeout(120_000),
);
try {
  assert.equal(toolCalls, 1);
  assert.match(toolReply.displayText(), /SYNTHETIC_TOOL_OK/);
  process.stdout.write(
    `${JSON.stringify({ model, endpoint: 'loopback', masking: 'PASS', schema: 'PASS', hostTool: 'PASS', elapsedMs: Date.now() - started })}\n`,
  );
} finally {
  toolReply.dispose();
}
