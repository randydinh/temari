import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonical, hash } from './codec.js';
import { judgeJevShadow } from './jev.js';

const request = {
  query: 'Which document supports the deployment requirement?',
  hostedTextApproved: true as const,
  candidates: [
    { id: 'a', evidenceIds: ['e1'], excerpt: 'Deployment requires an audit receipt.', required: true, contrary: false },
    { id: 'b', evidenceIds: ['e2'], excerpt: 'Deployment is optional for local tests.', required: false, contrary: true },
  ],
};

function reply(relevance: number, support: string, model = 'jev-1.13.0') {
  return new Response(JSON.stringify({
    model,
    answers: {
      relevance: { type: 'noul', noul: relevance },
      support: {
        type: 'choice', choice: support,
        probabilities: { supported: support === 'supported' ? 0.8 : 0.1,
          contradicted: support === 'contradicted' ? 0.8 : 0.1,
          unknown: support === 'unknown' ? 0.8 : 0.1 },
        confidence: 0.7,
      },
    },
    usage: { input_tokens: 120, output_tokens: 4 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('Jev shadow uses typed judgments and preserves every candidate and evidence identity', async () => {
  const seen: unknown[] = [];
  const responses = [reply(0.2, 'unknown'), reply(0.9, 'contradicted')];
  const result = await judgeJevShadow(request, {
    apiKey: 'secret-for-test',
    fetcher: async (url, init) => {
      assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer secret-for-test');
      seen.push(JSON.parse(String(init?.body)));
      return responses.shift()!;
    },
  });
  assert.equal(result.mode, 'shadow');
  assert.deepEqual(result.originalOrder, ['a', 'b']);
  assert.deepEqual(result.suggestedOrder, ['b', 'a']);
  assert.deepEqual(result.judgments.map((j) => j.evidenceIds), [['e1'], ['e2']]);
  assert.equal(result.judgments[1].support, 'contradicted');
  assert.equal(result.judgments[0].required, true);
  assert.equal(result.judgments[1].contrary, true);
  assert(seen.every((body) => (body as Record<string, unknown>).model === 'jev-1.13.0'));
  assert(seen.every((body) => Object.keys((body as { questions: object }).questions).join(',') === 'relevance,support'));
  assert(!JSON.stringify(result).includes('secret-for-test'));
  assert(!JSON.stringify(result).includes('Deployment requires'));
  assert(result.judgments.every((j) => /^[0-9a-f]{64}$/.test(j.evidenceSha256)));
  assert(result.judgments.every((j) => j.latencyMs !== null && j.latencyMs >= 0));
});

test('Jev shadow refuses unapproved text before transport', async () => {
  let calls = 0;
  const result = await judgeJevShadow({ ...request, hostedTextApproved: false }, {
    apiKey: 'secret-for-test', fetcher: async () => { calls++; throw Error('must not call'); },
  });
  assert.equal(calls, 0);
  assert(result.judgments.every((j) => j.relevance === null && j.support === 'unknown'));
});

test('Jev shadow resolves a local credential only after the source grant', async () => {
  let lookups = 0;
  const options = {
    keyResolver: async () => { lookups++; return 'keychain-test-secret'; },
    fetcher: async (_url: unknown, init?: RequestInit) => {
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer keychain-test-secret');
      return reply(0.8, 'supported');
    },
  };
  const denied = await judgeJevShadow({ ...request, hostedTextApproved: false }, options);
  assert.equal(lookups, 0);
  assert(denied.judgments.every((item) => item.gap === 'approval-required'));
  const allowed = await judgeJevShadow({ ...request, candidates: [request.candidates[0]] }, options);
  assert.equal(lookups, 1);
  assert.equal(allowed.judgments[0].state, 'judged');
  assert(!JSON.stringify(allowed).includes('keychain-test-secret'));
});

test('Jev shadow retries bounded overload and retains unknown on invalid resolved model', async () => {
  let calls = 0;
  const overload = await judgeJevShadow({ ...request, candidates: [request.candidates[0]] }, {
    apiKey: 'secret-for-test',
    fetcher: async () => { calls++; return calls === 1 ? new Response('', { status: 429 }) : reply(0.7, 'supported'); },
    sleep: async () => {},
  });
  assert.equal(calls, 2);
  assert.equal(overload.judgments[0].relevance, 0.7);
  const invalid = await judgeJevShadow({ ...request, candidates: [request.candidates[0]] }, {
    apiKey: 'secret-for-test', fetcher: async () => reply(0.9, 'supported', 'other-model'),
  });
  assert.equal(invalid.judgments[0].relevance, null);
  assert.equal(invalid.judgments[0].support, 'unknown');
  assert.deepEqual(invalid.suggestedOrder, ['a']);
});

test('Jev shadow bounds response bytes and never turns malformed output into evidence', async () => {
  const huge = await judgeJevShadow({ ...request, candidates: [request.candidates[0]] }, {
    apiKey: 'secret-for-test',
    fetcher: async () => new Response('x'.repeat(65537), { status: 200 }),
  });
  assert.equal(huge.judgments[0].state, 'unknown');
  assert.equal(huge.judgments[0].gap, 'invalid-response');
  assert.equal(huge.judgments[0].requestSha256, null);
});

test('Jev shadow deadline includes a stalled response body', async () => {
  const started = performance.now();
  const result = await judgeJevShadow({ ...request, candidates: [request.candidates[0]] }, {
    apiKey: 'secret-for-test', timeoutMs: 100,
    fetcher: async () => new Response(new ReadableStream({ start() {} }), { status: 200 }),
  });
  assert.equal(result.judgments[0].state, 'unknown');
  assert(performance.now() - started < 1000);
});

test('Jev shadow deadline includes cancellation of an oversized body', async () => {
  const started = performance.now();
  const result = await judgeJevShadow({ ...request, candidates: [request.candidates[0]] }, {
    apiKey: 'secret-for-test', timeoutMs: 100,
    fetcher: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(65537)); },
      cancel() { return new Promise<void>(() => {}); },
    }), { status: 200 }),
  });
  assert.equal(result.judgments[0].state, 'unknown');
  assert(performance.now() - started < 1000);
});

test('Jev shadow copies candidate text and IDs before any awaited transport', async () => {
  const mutable = {
    ...request,
    candidates: [{ ...request.candidates[0], evidenceIds: ['e1'] }],
  };
  const originalExcerpt = mutable.candidates[0].excerpt;
  let sent: unknown;
  const result = await judgeJevShadow(mutable, {
    apiKey: 'secret-for-test',
    fetcher: async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      mutable.candidates[0].excerpt = 'Changed after approval';
      mutable.candidates[0].evidenceIds.push('e2');
      mutable.candidates.push({ ...mutable.candidates[0], id: 'unapproved' });
      return reply(0.8, 'supported');
    },
  });
  assert.deepEqual(result.originalOrder, ['a']);
  assert.deepEqual(result.judgments[0].evidenceIds, ['e1']);
  assert.equal((sent as { state: { candidate: { excerpt: string } } }).state.candidate.excerpt, originalExcerpt);
  assert.equal(result.judgments[0].evidenceSha256, hash(canonical({ evidenceIds: ['e1'], excerpt: originalExcerpt })));
});

test('Jev shadow rejects malformed Choice answer types', async () => {
  const malformed = JSON.parse(await reply(0.8, 'supported').text());
  malformed.answers.support.choice = ['supported'];
  const result = await judgeJevShadow({ ...request, candidates: [request.candidates[0]] }, {
    apiKey: 'secret-for-test', fetcher: async () => new Response(JSON.stringify(malformed)),
  });
  assert.equal(result.judgments[0].state, 'unknown');
  assert.equal(result.judgments[0].support, 'unknown');
});
