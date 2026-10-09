/** Server-side, shadow-only LLM judgments over policy-admitted archive excerpts. */
import assert from 'node:assert/strict';
import { canonical, hash, object, list } from './codec.js';
import {
  checkCurrentJevSharing,
  type CurrentJevSharing,
  type CurrentJevSharingGuard,
} from './current-jev-sharing.js';

const ENDPOINT = 'https://api.openai.com/v1/responses';
const RUBRIC = 'knowledge-candidate-v1';

export interface OpenAIResponsesShadowCandidate {
  readonly id: string;
  readonly evidenceIds: readonly string[];
  readonly excerpt: string;
  readonly required: boolean;
  readonly contrary: boolean;
}
export interface OpenAIResponsesShadowRequest {
  readonly provider: 'none' | 'openai-responses';
  /** Exact Responses API model or snapshot selected by the caller. */
  readonly model: string;
  readonly query: string;
  readonly hostedTextApproved: boolean;
  readonly denialReason?: 'local-only' | 'case-opt-out';
  readonly candidates: readonly OpenAIResponsesShadowCandidate[];
}
export interface OpenAIResponsesShadowOptions {
  /** Server-side only. Only this explicit key or OPENAI_API_KEY is used. */
  readonly apiKey?: string;
  readonly fetcher?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly timeoutMs?: number;
  /** Required for hosted use; checked before credential resolution and each POST. */
  readonly currentSharingGuard?: CurrentJevSharingGuard;
}

export interface OpenAIResponsesShadowJudgment {
  readonly candidateId: string;
  readonly evidenceIds: readonly string[];
  readonly evidenceSha256: string;
  readonly required: boolean;
  readonly contrary: boolean;
  readonly relevance: number | null;
  readonly support: 'supported' | 'contradicted' | 'unknown';
  readonly supportConfidence: number | null;
  readonly model: string | null;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
  } | null;
  readonly requestSha256: string | null;
  readonly latencyMs: number | null;
  readonly state: 'judged' | 'unknown';
  readonly gap:
    | 'provider-none'
    | 'refusal'
    | 'incomplete'
    | 'approval-required'
    | 'local-only'
    | 'case-opt-out'
    | 'current-local-only'
    | 'policy-unavailable'
    | 'missing-key'
    | 'unavailable'
    | 'invalid-response'
    | null;
}
export interface OpenAIResponsesShadowResult {
  readonly provider: 'none' | 'openai-responses';
  readonly mode: 'shadow';
  readonly model: string;
  readonly rubric: typeof RUBRIC;
  readonly querySha256: string;
  readonly originalOrder: readonly string[];
  readonly suggestedOrder: readonly string[];
  readonly judgments: readonly OpenAIResponsesShadowJudgment[];
  /** A later denial also covers all remaining candidates and retries. */
  readonly sharing: CurrentJevSharing | 'not-requested';
  /** POST attempts begun, including overloads before a later revocation. */
  readonly attemptedRequests: number;
}

function boundedString(value: unknown, name: string, max: number): string {
  assert(
    typeof value === 'string' && value.length > 0 && value.length <= max,
    `Invalid ${name}`,
  );
  assert(!value.includes('\0'), `Invalid ${name}`);
  return value;
}
function boundedModel(value: unknown, name: string): string {
  const model = boundedString(value, name, 128);
  assert(
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(model),
    `Invalid ${name}`,
  );
  return model;
}
function finiteProbability(value: unknown): number {
  assert(
    typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= 1,
    'Invalid Responses probability',
  );
  return value;
}
function usageCount(value: unknown): number {
  assert(
    Number.isSafeInteger(value) &&
      (value as number) >= 0 &&
      (value as number) <= 1_000_000,
    'Invalid Responses usage',
  );
  return value as number;
}
function validateRequest(request: OpenAIResponsesShadowRequest): void {
  assert(
    Object.keys(request).every((k) =>
      [
        'provider',
        'model',
        'query',
        'hostedTextApproved',
        'denialReason',
        'candidates',
      ].includes(k),
    ),
    'Unknown Responses request field',
  );
  boundedModel(request.model, 'Responses model');
  boundedString(request.query, 'query', 512);
  assert(
    Array.isArray(request.candidates) &&
      request.candidates.length >= 0 &&
      request.candidates.length <= 16,
    'Invalid Responses shortlist',
  );
  const ids = new Set<string>();
  let total = 0;
  for (const c of request.candidates) {
    boundedString(c.id, 'candidate ID', 256);
    assert(!ids.has(c.id), 'Duplicate Responses candidate');
    ids.add(c.id);
    assert(
      Array.isArray(c.evidenceIds) &&
        c.evidenceIds.length >= 1 &&
        c.evidenceIds.length <= 16,
    );
    assert(new Set(c.evidenceIds).size === c.evidenceIds.length);
    c.evidenceIds.forEach((id: string) =>
      boundedString(id, 'evidence ID', 256),
    );
    boundedString(c.excerpt, 'excerpt', 4000);
    assert(typeof c.required === 'boolean' && typeof c.contrary === 'boolean');
    total += c.excerpt.length;
  }
  assert(total <= 16_000, 'Responses shortlist text exceeds bound');
}
function unknown(
  c: OpenAIResponsesShadowCandidate,
  gap: NonNullable<OpenAIResponsesShadowJudgment['gap']>,
): OpenAIResponsesShadowJudgment {
  return {
    candidateId: c.id,
    evidenceIds: [...c.evidenceIds],
    evidenceSha256: hash(
      canonical({ evidenceIds: c.evidenceIds, excerpt: c.excerpt }),
    ),
    required: c.required,
    contrary: c.contrary,
    relevance: null,
    support: 'unknown',
    supportConfidence: null,
    model: null,
    usage: null,
    requestSha256: null,
    latencyMs: null,
    state: 'unknown',
    gap,
  };
}
function parsedAnswer(body: unknown) {
  const r = object(body);
  const model = boundedModel(r['model'], 'Responses resolved model');
  const u = object(r['usage']);
  const usage = {
    inputTokens: usageCount(u['input_tokens']),
    outputTokens: usageCount(u['output_tokens']),
    totalTokens: usageCount(u['total_tokens']),
  };
  assert.equal(usage.totalTokens, usage.inputTokens + usage.outputTokens);
  const status = r['status'];
  assert(status === 'completed' || status === 'incomplete');
  if (status === 'incomplete')
    return {
      gap: 'incomplete' as const,
      usage,
      model,
      relevance: null,
      support: 'unknown' as const,
      confidence: null,
    };
  const messages = list(r['output'])
    .map(object)
    .filter((item) => item['type'] === 'message');
  assert.equal(messages.length, 1);
  const content = list(messages[0]['content']).map(object);
  const refusals = content.filter((item) => item['type'] === 'refusal');
  if (refusals.length > 0) {
    assert.equal(refusals.length, 1);
    boundedString(refusals[0]['refusal'], 'refusal', 4096);
    return {
      gap: 'refusal' as const,
      usage,
      model,
      relevance: null,
      support: 'unknown' as const,
      confidence: null,
    };
  }
  const outputs = content.filter((item) => item['type'] === 'output_text');
  assert.equal(outputs.length, 1);
  const answer = object(
    JSON.parse(boundedString(outputs[0]['text'], 'output text', 16384)),
  );
  assert.deepEqual(Object.keys(answer).sort(), [
    'confidence',
    'relevance',
    'support',
  ]);
  assert(
    typeof answer['support'] === 'string' &&
      ['supported', 'contradicted', 'unknown'].includes(answer['support']),
    'Invalid Responses support',
  );
  return {
    gap: null,
    usage,
    model,
    relevance: finiteProbability(answer['relevance']),
    support: answer['support'] as OpenAIResponsesShadowJudgment['support'],
    confidence: finiteProbability(answer['confidence']),
  };
}

async function evaluate(
  c: OpenAIResponsesShadowCandidate,
  query: string,
  model: string,
  apiKey: string,
  options: OpenAIResponsesShadowOptions,
  checkSharing: () => Promise<CurrentJevSharing>,
  markAttempt: () => void,
): Promise<OpenAIResponsesShadowJudgment> {
  const payload = {
    model,
    store: false,
    input: [
      {
        role: 'system',
        content: [
          {
            type: 'input_text',
            text: 'Judge only the supplied excerpt. Do not use outside knowledge. Relevance is 0 to 1. Support is supported only for explicit support, contradicted only for explicit contradiction, and unknown when the excerpt is insufficient or the query is not a proposition. Confidence is your confidence in the support label, from 0 to 1.',
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: canonical({
              query,
              candidate: { id: c.id, excerpt: c.excerpt },
            }),
          },
        ],
      },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'knowledge_candidate_judgment',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            relevance: { type: 'number' },
            support: {
              type: 'string',
              enum: ['supported', 'contradicted', 'unknown'],
            },
            confidence: { type: 'number' },
          },
          required: ['relevance', 'support', 'confidence'],
          additionalProperties: false,
        },
      },
    },
    max_output_tokens: 256,
  };
  const requestSha256 = hash(canonical(payload));
  const timeoutMs = options.timeoutMs ?? 5000;
  assert(Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 30000);
  const fetcher = options.fetcher ?? fetch;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let response: Response | null = null;
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const deadline = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener(
      'abort',
      () => reject(new Error('Responses deadline exceeded')),
      { once: true },
    );
  });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      let sharing: CurrentJevSharing;
      try {
        sharing = await Promise.race([checkSharing(), deadline]);
      } catch {
        return unknown(c, 'policy-unavailable');
      }
      if (sharing !== 'allowed') return unknown(c, sharing);
      markAttempt();
      response = await Promise.race([
        fetcher(ENDPOINT, {
          method: 'POST',
          redirect: 'error',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        }),
        deadline,
      ]);
      if (
        response.status !== 429 &&
        response.status !== 529 &&
        response.status !== 503
      )
        break;
      void response.body?.cancel().catch(() => undefined);
      if (attempt < 2)
        await Promise.race([sleep(200 * 2 ** attempt), deadline]);
    }
    if (!response?.ok) return unknown(c, 'unavailable');
    const reader = response.body?.getReader();
    if (!reader) return unknown(c, 'invalid-response');
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const part = await Promise.race([reader.read(), deadline]);
        if (part.done) break;
        length += part.value.byteLength;
        if (length > 65536) {
          await Promise.race([reader.cancel(), deadline]);
          return unknown(c, 'invalid-response');
        }
        chunks.push(part.value);
      }
    } finally {
      void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const parsed = parsedAnswer(JSON.parse(raw));
    return {
      ...unknown(c, 'unavailable'),
      relevance: parsed.relevance,
      support: parsed.support,
      supportConfidence: parsed.confidence,
      model: parsed.model,
      usage: parsed.usage,
      requestSha256,
      latencyMs: Math.max(0, Math.round(performance.now() - started)),
      state: parsed.gap ? 'unknown' : 'judged',
      gap: parsed.gap,
    };
  } catch {
    return unknown(c, response?.ok ? 'invalid-response' : 'unavailable');
  } finally {
    controller.abort();
    clearTimeout(timer);
  }
}

/** Ranking advice only: all candidates and required/contrary flags survive intact. */
export async function judgeOpenAIResponsesShadow(
  request: OpenAIResponsesShadowRequest,
  options: OpenAIResponsesShadowOptions = {},
): Promise<OpenAIResponsesShadowResult> {
  // Snapshot before the first await: caller mutations cannot widen the grant,
  // shortlist or text after validation or alter the evidence hash in a receipt.
  const selected = JSON.parse(
    canonical(request),
  ) as OpenAIResponsesShadowRequest;
  validateRequest(selected);
  assert(
    selected.denialReason === undefined ||
      ['local-only', 'case-opt-out'].includes(selected.denialReason),
  );
  assert(['none', 'openai-responses'].includes(selected.provider));
  assert.equal(typeof selected.hostedTextApproved, 'boolean');
  const grant =
    selected.provider === 'openai-responses' &&
    selected.hostedTextApproved === true &&
    selected.candidates.length > 0;
  assert(
    !grant || selected.denialReason === undefined,
    'Allowed Responses request cannot have a denial reason',
  );
  const timeoutMs = options.timeoutMs ?? 5000;
  assert(Number.isInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 30000);
  const expires = performance.now() + timeoutMs;
  const guard = options.currentSharingGuard;
  const fetcher = options.fetcher;
  const sleep = options.sleep;
  const checkSharing = async (): Promise<CurrentJevSharing> => {
    const remaining = expires - performance.now();
    if (remaining <= 0) return 'policy-unavailable';
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        checkCurrentJevSharing(guard),
        new Promise<CurrentJevSharing>((resolve) => {
          timer = setTimeout(() => resolve('policy-unavailable'), remaining);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  let sharing: CurrentJevSharing | 'not-requested' = grant
    ? await checkSharing()
    : 'not-requested';
  // No key source is consulted until the current Registrar guard has allowed use.
  const apiKey =
    sharing === 'allowed'
      ? (options.apiKey ?? process.env['OPENAI_API_KEY'])
      : undefined;
  if (apiKey !== undefined)
    assert(
      typeof apiKey === 'string' &&
        apiKey.length <= 4096 &&
        !/[\r\n\0]/.test(apiKey),
      'Invalid API key',
    );
  const judgments: OpenAIResponsesShadowJudgment[] = [];
  let attemptedRequests = 0;
  for (const c of selected.candidates) {
    const judgment = !grant
      ? unknown(
          c,
          selected.provider === 'none'
            ? 'provider-none'
            : (selected.denialReason ?? 'approval-required'),
        )
      : sharing !== 'allowed'
        ? unknown(
            c,
            sharing === 'current-local-only' ? sharing : 'policy-unavailable',
          )
        : !apiKey
          ? unknown(c, 'missing-key')
          : await evaluate(
              c,
              selected.query,
              selected.model,
              apiKey,
              {
                fetcher,
                sleep,
                timeoutMs: Math.max(1, Math.ceil(expires - performance.now())),
              },
              checkSharing,
              () => {
                attemptedRequests++;
              },
            );
    if (
      judgment.gap === 'current-local-only' ||
      judgment.gap === 'policy-unavailable'
    )
      sharing = judgment.gap;
    judgments.push(judgment);
  }
  const originalOrder = selected.candidates.map((c) => c.id);
  if (grant && sharing === 'allowed') sharing = await checkSharing();
  if (sharing === 'current-local-only' || sharing === 'policy-unavailable') {
    const gap = sharing;
    judgments.splice(
      0,
      judgments.length,
      ...judgments.map((j) => ({
        ...j,
        relevance: null,
        support: 'unknown' as const,
        supportConfidence: null,
        state: 'unknown' as const,
        gap,
      })),
    );
  }
  const suggestedOrder = [...originalOrder];
  return {
    provider: selected.provider,
    mode: 'shadow',
    model: selected.model,
    rubric: RUBRIC,
    querySha256: hash(canonical(selected.query)),
    originalOrder,
    suggestedOrder,
    judgments,
    sharing,
    attemptedRequests,
  };
}
