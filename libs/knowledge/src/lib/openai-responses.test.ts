import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { archiveTransport, protocolFile } from './archive-transport.js';
import { canonical, hash } from './codec.js';
import {
  currentJevSharingGuard,
  type CurrentJevSharingGuard,
} from './current-jev-sharing.js';
import { publishJson } from './durable.js';
import { judgeOpenAIResponsesShadow } from './openai-responses.js';

let allowedGuard: CurrentJevSharingGuard;
let policyPath: string;
let fixtureRoot: string;
let sourceRow: Record<string, unknown>;

async function setCurrentRow(fields: Record<string, unknown>): Promise<void> {
  sourceRow = { ...sourceRow, ...fields };
  await writeFile(policyPath, canonical({ sources: [sourceRow] }));
}

before(async () => {
  // A bounded Registrar protocol shim. The production guard still loads a
  // validated pinned publication and invokes the real archive transport path.
  fixtureRoot = await mkdtemp(
    join(await realpath(tmpdir()), 'temari-jev-policy-'),
  );
  const registrarSource = join(fixtureRoot, 'registrar');
  const workspace = join(fixtureRoot, 'state');
  const sourceRoot = join(fixtureRoot, 'source');
  const taskDirectory = join(fixtureRoot, 'task');
  await Promise.all([
    mkdir(join(registrarSource, 'src', 'knowledge_agent'), { recursive: true }),
    mkdir(join(registrarSource, 'docs', 'design'), { recursive: true }),
    mkdir(workspace),
    mkdir(sourceRoot),
    mkdir(taskDirectory),
  ]);
  await Promise.all([
    writeFile(join(registrarSource, 'src', 'knowledge_agent', 'cli.py'), ''),
    writeFile(join(registrarSource, 'pyproject.toml'), ''),
    writeFile(join(registrarSource, 'uv.lock'), ''),
    writeFile(join(registrarSource, protocolFile), '{}'),
    writeFile(join(workspace, 'registry.sqlite3'), ''),
  ]);
  const python = join(fixtureRoot, 'policy-list');
  await writeFile(
    python,
    '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n' +
      '  if [ "$1" = "--workspace" ]; then shift; break; fi\n' +
      '  shift\ndone\nexec /bin/cat "$1/current-row.json"\n',
    { mode: 0o700 },
  );
  const source = {
    provider: 'synthetic-registrar',
    id: 'synthetic-source',
    locator: pathToFileURL(sourceRoot).href,
  };
  sourceRow = {
    id: source.id,
    root: sourceRoot,
    kind: 'local',
    recursive: true,
    exclude: [],
    enabled: true,
    sharing: 'registered-sources',
  };
  policyPath = join(workspace, 'current-row.json');
  await setCurrentRow({});
  const transport = {
    python,
    registrarSource,
    workspace,
    timeoutMs: 30000,
    maxStdoutBytes: 1_048_576,
  };
  const implementation = await archiveTransport(transport);
  const captureRequestKey = `temari-archive-v1:${hash('request')}`;
  const binding = hash(captureRequestKey);
  const task = {
    id: 'jev-unit',
    directory: taskDirectory,
    authorityRef: 'synthetic-policy',
  };
  const registration = canonical({
    source,
    root: sourceRoot,
    kind: 'local',
    recursive: true,
    exclude: [],
    enabled: true,
  });
  const publicationPath = join(
    taskDirectory,
    `archive-publication-${binding}.json`,
  );
  await publishJson(publicationPath, {
    schema: 1,
    kind: 'temari-archive-publication',
    task,
    source,
    readScope: 'source-root',
    transport: implementation.config,
    implementation: implementation.implementation,
    protocolSha256: implementation.protocolSha256,
    registration,
    binding,
    generation: 'a'.repeat(32),
    manifestSha256: hash('manifest'),
    captureRequestKey,
    captureFingerprint: hash('fingerprint'),
    preservation: 'complete-admitted',
    counts: {},
    capabilities: {},
    gaps: [],
    currentOriginal: 'not-checked',
  });
  await publishJson(join(taskDirectory, `archive-binding-${binding}.json`), {
    schema: 1,
    task,
    source,
    readScope: 'source-root',
    transport: implementation.config,
    implementation: implementation.implementation,
    protocolSha256: implementation.protocolSha256,
    registration,
    captureRequestKey,
  });
  allowedGuard = currentJevSharingGuard([publicationPath], [source.id]);
});
after(async () => {
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
});

const request = {
  provider: 'openai-responses' as const,
  model: 'gpt-6-astra',
  query: 'Which document supports the deployment requirement?',
  hostedTextApproved: true as const,
  candidates: [
    {
      id: 'a',
      evidenceIds: ['e1'],
      excerpt: 'Deployment requires an audit receipt.',
      required: true,
      contrary: false,
    },
    {
      id: 'b',
      evidenceIds: ['e2'],
      excerpt: 'Deployment is optional for local tests.',
      required: false,
      contrary: true,
    },
  ],
};

function body() {
  return {
    model: 'gpt-6-astra-2026-10-01',
    status: 'completed',
    output: [
      {
        type: 'message',
        content: [
          {
            type: 'output_text',
            text: JSON.stringify({
              relevance: 0.9,
              support: 'supported',
              confidence: 0.8,
            }),
          },
        ],
      },
    ],
    usage: { input_tokens: 42, output_tokens: 0, total_tokens: 42 },
  };
}
function changeAnswer(
  response: ReturnType<typeof body>,
  mutate: (answer: Record<string, unknown>) => void,
): void {
  const content = response.output[0].content[0];
  const answer = JSON.parse(content.text) as Record<string, unknown>;
  mutate(answer);
  content.text = JSON.stringify(answer);
}
const opts = () => ({ apiKey: 'synthetic', currentSharingGuard: allowedGuard });
test('Responses: strict structured-output payload and unchanged evidence order', async () => {
  const result = await judgeOpenAIResponsesShadow(request, {
    ...opts(),
    fetcher: async (url, init) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      const payload = JSON.parse(String(init?.body));
      assert.equal(payload.model, 'gpt-6-astra');
      assert.equal(payload.store, false);
      assert.equal(payload.input.length, 2);
      assert.equal(payload.input[0].role, 'system');
      const sent = JSON.parse(payload.input[1].content[0].text);
      assert.equal(sent.query, request.query);
      assert(sent.candidate.excerpt.includes('Deployment'));
      assert.equal(payload.text.format.type, 'json_schema');
      assert.equal(payload.text.format.strict, true);
      assert.deepEqual(payload.text.format.schema.required.sort(), [
        'confidence',
        'relevance',
        'support',
      ]);
      assert.equal(payload.max_output_tokens, 256);
      return Response.json(body());
    },
  });
  assert.equal(result.model, 'gpt-6-astra');
  assert.deepEqual(result.originalOrder, ['a', 'b']);
  assert.deepEqual(result.suggestedOrder, ['a', 'b']);
  assert.equal(result.judgments[0].required, true);
  assert.equal(result.judgments[1].contrary, true);
  assert.equal(result.judgments[0].model, 'gpt-6-astra-2026-10-01');
  assert.deepEqual(result.judgments[0].usage, {
    inputTokens: 42,
    outputTokens: 0,
    totalTokens: 42,
  });
  assert.equal(result.judgments[0].state, 'judged');
  assert.equal(result.attemptedRequests, 2);
});
test('Responses: malformed structured outputs and usage stay unknown', async () => {
  const cases: ((b: any) => void)[] = [
    (b) => changeAnswer(b, (a) => delete a.support),
    (b) => changeAnswer(b, (a) => (a.extra = true)),
    (b) => changeAnswer(b, (a) => (a.support = ['supported'])),
    (b) => changeAnswer(b, (a) => (a.support = { value: 'supported' })),
    (b) => changeAnswer(b, (a) => (a.support = null)),
    (b) => changeAnswer(b, (a) => (a.support = 'other')),
    (b) => changeAnswer(b, (a) => (a.relevance = '0.9')),
    (b) => changeAnswer(b, (a) => (a.relevance = 2)),
    (b) => changeAnswer(b, (a) => (a.relevance = null)),
    (b) => changeAnswer(b, (a) => (a.confidence = '0.8')),
    (b) => changeAnswer(b, (a) => (a.confidence = -0.1)),
    (b) => (b.output[0].content[0].text = '{'),
    (b) => (b.output[0].content[0].type = 'other'),
    (b) => b.output.push(b.output[0]),
    (b) => (b.usage.total_tokens = 43),
    (b) => delete b.usage.output_tokens,
    (b) => (b.usage.input_tokens = -1),
    (b) => (b.usage.input_tokens = 1.5),
    (b) => (b.usage.output_tokens = '0'),
    (b) => (b.usage.total_tokens = null),
    (b) => (b.status = 'other'),
    (b) => (b.model = 'bad model'),
  ];
  for (const mutate of cases) {
    const b = body();
    mutate(b);
    const r = await judgeOpenAIResponsesShadow(request, {
      ...opts(),
      fetcher: async () => Response.json(b),
    });
    assert(
      r.judgments.every(
        (j) => j.state === 'unknown' && j.gap === 'invalid-response',
      ),
    );
  }
  const b: any = body();
  b.output[0].content = [{ type: 'refusal', refusal: 'synthetic refusal' }];
  const r = await judgeOpenAIResponsesShadow(request, {
    ...opts(),
    fetcher: async () => Response.json(b),
  });
  assert.equal(r.judgments[0].gap, 'refusal');
  assert.equal(r.judgments[0].usage?.totalTokens, 42);
  const incomplete = body();
  incomplete.status = 'incomplete';
  incomplete.output = [];
  const incompleteResult = await judgeOpenAIResponsesShadow(request, {
    ...opts(),
    fetcher: async () => Response.json(incomplete),
  });
  assert(
    incompleteResult.judgments.every(
      (j) =>
        j.state === 'unknown' &&
        j.gap === 'incomplete' &&
        j.support === 'unknown' &&
        j.relevance === null,
    ),
  );
});
test('Responses: offline, opt-out, absent/forged guards never access key or network', async () => {
  const options = {
    get apiKey(): string {
      throw Error('credential access');
    },
    fetcher: async () => {
      throw Error('network');
    },
  };
  for (const provider of ['none', 'openai-responses'] as const) {
    const r = await judgeOpenAIResponsesShadow(
      {
        ...request,
        provider,
        hostedTextApproved: false,
        denialReason: 'local-only',
      },
      options,
    );
    assert.equal(r.attemptedRequests, 0);
  }
  for (const guard of [
    undefined,
    { check: async () => 'allowed' } as unknown as CurrentJevSharingGuard,
  ]) {
    const r = await judgeOpenAIResponsesShadow(
      request,
      Object.assign(optionsWithoutKey(), { currentSharingGuard: guard }),
    );
    assert.equal(r.judgments[0].gap, 'policy-unavailable');
  }
  const r = await judgeOpenAIResponsesShadow(request, {
    ...opts(),
    apiKey: '',
  });
  assert.equal(r.judgments[0].gap, 'missing-key');
  assert.equal(r.attemptedRequests, 0);
});
function optionsWithoutKey() {
  return {
    get apiKey(): string {
      throw Error('key access before policy');
    },
    fetcher: async () => {
      throw Error('network');
    },
  };
}
test('Responses: current revocation before credentials, POST retry and final result', async () => {
  await setCurrentRow({ sharing: 'local-only' });
  const r = await judgeOpenAIResponsesShadow(
    request,
    Object.assign(optionsWithoutKey(), { currentSharingGuard: allowedGuard }),
  );
  assert.equal(r.judgments[0].gap, 'current-local-only');
  await setCurrentRow({ sharing: 'registered-sources' });
  let calls = 0;
  const retried = await judgeOpenAIResponsesShadow(request, {
    ...opts(),
    sleep: async () => {},
    fetcher: async () => {
      calls++;
      await setCurrentRow({ sharing: 'local-only' });
      return new Response('', { status: 429 });
    },
  });
  assert.equal(calls, 1);
  assert.equal(retried.sharing, 'current-local-only');
  await setCurrentRow({ sharing: 'registered-sources' });
  const last = await judgeOpenAIResponsesShadow(
    { ...request, candidates: request.candidates.slice(0, 1) },
    {
      ...opts(),
      fetcher: async () => {
        await setCurrentRow({ sharing: 'local-only' });
        return Response.json(body());
      },
    },
  );
  assert.equal(last.judgments[0].state, 'unknown');
  await setCurrentRow({ sharing: 'registered-sources' });
});
test('Responses: deadlines, streamed body cap and retry exhaustion', async () => {
  for (const fetcher of [
    async () => new Promise<Response>(() => {}),
    async () => new Response(new ReadableStream({ start() {} })),
    async () => new Response('x'.repeat(65537)),
    async () => new Response('', { status: 503 }),
  ]) {
    const r = await judgeOpenAIResponsesShadow(
      { ...request, candidates: request.candidates.slice(0, 1) },
      { ...opts(), timeoutMs: 100, sleep: async () => {}, fetcher },
    );
    assert.equal(r.judgments[0].state, 'unknown');
    assert(r.attemptedRequests <= 3);
  }
  let posts = 0;
  const exhausted = await judgeOpenAIResponsesShadow(
    { ...request, candidates: request.candidates.slice(0, 1) },
    {
      ...opts(),
      sleep: async () => {},
      fetcher: async () => {
        posts++;
        return new Response('', { status: 529 });
      },
    },
  );
  assert.equal(posts, 3);
  assert.equal(exhausted.attemptedRequests, 3);
  assert.equal(exhausted.judgments[0].gap, 'unavailable');
});
test('Responses: request snapshot and bounds before async admission', async () => {
  const mutable = structuredClone(request);
  const pending = judgeOpenAIResponsesShadow(mutable, {
    ...opts(),
    fetcher: async (_url, init) => {
      assert(!String(init?.body).includes('MUTATED'));
      return Response.json(body());
    },
  });
  mutable.candidates[0].excerpt = 'MUTATED';
  const r = await pending;
  assert.equal(
    r.judgments[0].evidenceSha256,
    hash(
      canonical({
        evidenceIds: request.candidates[0].evidenceIds,
        excerpt: request.candidates[0].excerpt,
      }),
    ),
  );
  await assert.rejects(
    judgeOpenAIResponsesShadow({ ...request, query: 'x'.repeat(513) }),
  );
  for (const model of ['', 'bad model', 'x'.repeat(129)]) {
    await assert.rejects(judgeOpenAIResponsesShadow({ ...request, model }));
  }
  await assert.rejects(
    judgeOpenAIResponsesShadow({
      ...request,
      candidates: [{ ...request.candidates[0], excerpt: 'x'.repeat(4001) }],
    }),
  );
  for (const [count, excerptLength] of [
    [17, 1],
    [5, 4000],
  ]) {
    await assert.rejects(
      judgeOpenAIResponsesShadow(
        {
          ...request,
          candidates: Array.from({ length: count }, (_, i) => ({
            ...request.candidates[0],
            id: `candidate-${i}`,
            excerpt: 'x'.repeat(excerptLength),
          })),
        },
        optionsWithoutKey(),
      ),
    );
  }
});
test('Responses: only direct OpenAI environment lookup, never TypeSafe even when configured', async () => {
  const originalEnv = process.env;
  let openaiLookups = 0;
  let typesafeLookups = 0;
  let posts = 0;
  process.env = new Proxy(originalEnv, {
    get(target, key) {
      if (key === 'OPENAI_API_KEY') {
        openaiLookups++;
        return undefined;
      }
      if (key === 'TYPESAFE_API_KEY') {
        typesafeLookups++;
        return 'synthetic-typesafe';
      }
      return Reflect.get(target, key);
    },
  });
  try {
    const options = {
      currentSharingGuard: allowedGuard,
      fetcher: async () => {
        posts++;
        throw Error('No OpenAI key');
      },
    };
    const offline = await judgeOpenAIResponsesShadow(
      { ...request, provider: 'none' },
      options,
    );
    assert.equal(offline.attemptedRequests, 0);
    assert.equal(openaiLookups, 0);
    const missing = await judgeOpenAIResponsesShadow(request, options);
    assert.equal(missing.attemptedRequests, 0);
    assert(missing.judgments.every((j) => j.gap === 'missing-key'));
    assert.equal(openaiLookups, 1);
    assert.equal(typesafeLookups, 0);
    assert.equal(posts, 0);
  } finally {
    process.env = originalEnv;
  }
});
test('Responses: revocation during key access prevents the first POST', async () => {
  const { writeFileSync } = await import('node:fs');
  let posts = 0;
  const result = await judgeOpenAIResponsesShadow(request, {
    currentSharingGuard: allowedGuard,
    get apiKey() {
      writeFileSync(
        policyPath,
        canonical({ sources: [{ ...sourceRow, sharing: 'local-only' }] }),
      );
      return 'synthetic';
    },
    fetcher: async () => {
      posts++;
      return Response.json(body());
    },
  });
  assert.equal(posts, 0);
  assert.equal(result.sharing, 'current-local-only');
  await setCurrentRow({ sharing: 'registered-sources' });
});
