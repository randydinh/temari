/** Server-side, shadow-only Decisions judgments over policy-admitted archive excerpts. */
import assert from 'node:assert/strict';
import { canonical, hash, object, list } from './codec.js';
import {
  checkCurrentJevSharing,
  type CurrentJevSharing,
  type CurrentJevSharingGuard,
} from './current-jev-sharing.js';

const ENDPOINT = 'https://api.openai.com/v1/decisions';
const MODEL = 'gpt-6-luna';
const RUBRIC = 'knowledge-candidate-v1';

export interface OpenAIDecisionsShadowCandidate {
  readonly id: string;
  readonly evidenceIds: readonly string[];
  readonly excerpt: string;
  readonly required: boolean;
  readonly contrary: boolean;
}
export interface OpenAIDecisionsShadowRequest {
  readonly provider: 'none' | 'openai-decisions';
  readonly query: string;
  readonly hostedTextApproved: boolean;
  readonly denialReason?: 'local-only' | 'case-opt-out';
  readonly candidates: readonly OpenAIDecisionsShadowCandidate[];
}
export interface OpenAIDecisionsShadowOptions {
  /** Server-side only. Only this explicit key or OPENAI_API_KEY is used. */
  readonly apiKey?: string;
  readonly fetcher?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly timeoutMs?: number;
  /** Required for hosted use; checked before credential resolution and each POST. */
  readonly currentSharingGuard?: CurrentJevSharingGuard;
}

export interface OpenAIDecisionsShadowJudgment {
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
export interface OpenAIDecisionsShadowResult {
  readonly provider: 'none' | 'openai-decisions';
  readonly mode: 'shadow';
  readonly model: typeof MODEL;
  readonly rubric: typeof RUBRIC;
  readonly querySha256: string;
  readonly originalOrder: readonly string[];
  readonly suggestedOrder: readonly string[];
  readonly judgments: readonly OpenAIDecisionsShadowJudgment[];
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
function finiteProbability(value: unknown): number {
  assert(
    typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= 1,
    'Invalid Decisions probability',
  );
  return value;
}
function usageCount(value: unknown): number {
  assert(
    Number.isSafeInteger(value) &&
      (value as number) >= 0 &&
      (value as number) <= 1_000_000,
    'Invalid Decisions usage',
  );
  return value as number;
}
function validateRequest(request: OpenAIDecisionsShadowRequest): void {
  assert(
    Object.keys(request).every((k) =>
      [
        'provider',
        'query',
        'hostedTextApproved',
        'denialReason',
        'candidates',
      ].includes(k),
    ),
    'Unknown Decisions request field',
  );
  boundedString(request.query, 'query', 512);
  assert(
    Array.isArray(request.candidates) &&
      request.candidates.length >= 0 &&
      request.candidates.length <= 16,
    'Invalid Decisions shortlist',
  );
  const ids = new Set<string>();
  let total = 0;
  for (const c of request.candidates) {
    boundedString(c.id, 'candidate ID', 256);
    assert(!ids.has(c.id), 'Duplicate Decisions candidate');
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
  assert(total <= 16_000, 'Decisions shortlist text exceeds bound');
}
function unknown(
  c: OpenAIDecisionsShadowCandidate,
  gap: NonNullable<OpenAIDecisionsShadowJudgment['gap']>,
): OpenAIDecisionsShadowJudgment {
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
  assert.equal(r['model'], MODEL);
  const answers = list(r['answers']).map(object);
  assert.equal(answers.length, 2);
  assert.deepEqual(answers.map((a) => a['name']).sort(), [
    'relevance',
    'support',
  ]);
  const relevance = answers.find((a) => a['name'] === 'relevance')!;
  const support = answers.find((a) => a['name'] === 'support')!;
  const u = object(r['usage']);
  const usage = {
    inputTokens: usageCount(u['input_tokens']),
    outputTokens: usageCount(u['output_tokens']),
    totalTokens: usageCount(u['total_tokens']),
  };
  assert.equal(usage.totalTokens, usage.inputTokens + usage.outputTokens);
  if (relevance['type'] !== 'refusal') {
    assert.equal(relevance['type'], 'predicate');
    finiteProbability(relevance['probability']);
  }
  if (support['type'] !== 'refusal') {
    assert.equal(support['type'], 'choice');
    assert.equal(typeof support['choice'], 'string', 'Invalid Decisions choice');
    assert(
      ['supported', 'contradicted', 'unknown'].includes(
        support['choice'] as string,
      ),
    );
    const probabilities = list(support['probabilities']).map(object);
    assert.deepEqual(probabilities.map((p) => p['value']).sort(), [
      'contradicted',
      'supported',
      'unknown',
    ]);
    assert(
      Math.abs(
        probabilities.reduce(
          (sum, p) => sum + finiteProbability(p['probability']),
          0,
        ) - 1,
      ) <= 0.000001,
    );
    finiteProbability(support['confidence']);
  }
  const refusal = answers.some((a) => a['type'] === 'refusal');
  return {
    refusal,
    usage,
    relevance: refusal ? null : finiteProbability(relevance['probability']),
    support: refusal
      ? ('unknown' as const)
      : (support['choice'] as OpenAIDecisionsShadowJudgment['support']),
    confidence: refusal ? null : finiteProbability(support['confidence']),
  };
}

async function evaluate(
  c: OpenAIDecisionsShadowCandidate,
  query: string,
  apiKey: string,
  options: OpenAIDecisionsShadowOptions,
  checkSharing: () => Promise<CurrentJevSharing>,
  markAttempt: () => void,
): Promise<OpenAIDecisionsShadowJudgment> {
  const payload = {
    model: MODEL,
    input: canonical({ query, candidate: { id: c.id, excerpt: c.excerpt } }),
    questions: [
      {
        type: 'predicate',
        name: 'relevance',
        instructions: 'Does the excerpt directly help answer the query?',
      },
      {
        type: 'choice',
        name: 'support',
        instructions:
          'Does the excerpt support or contradict the query proposition? Choose unknown if not established or query is not a proposition.',
        choices: [
          { value: 'supported', description: 'Explicit support' },
          { value: 'contradicted', description: 'Explicit contradiction' },
          { value: 'unknown', description: 'Neither established' },
        ],
      },
    ],
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
      () => reject(new Error('Decisions deadline exceeded')),
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
      model: MODEL,
      usage: parsed.usage,
      requestSha256,
      latencyMs: Math.max(0, Math.round(performance.now() - started)),
      state: parsed.refusal ? 'unknown' : 'judged',
      gap: parsed.refusal ? 'refusal' : null,
    };
  } catch {
    return unknown(c, response?.ok ? 'invalid-response' : 'unavailable');
  } finally {
    controller.abort();
    clearTimeout(timer);
  }
}

/** Ranking advice only: all candidates and required/contrary flags survive intact. */
export async function judgeOpenAIDecisionsShadow(
  request: OpenAIDecisionsShadowRequest,
  options: OpenAIDecisionsShadowOptions = {},
): Promise<OpenAIDecisionsShadowResult> {
  // Snapshot before the first await: caller mutations cannot widen the grant,
  // shortlist or text after validation or alter the evidence hash in a receipt.
  const selected = JSON.parse(
    canonical(request),
  ) as OpenAIDecisionsShadowRequest;
  validateRequest(selected);
  assert(
    selected.denialReason === undefined ||
      ['local-only', 'case-opt-out'].includes(selected.denialReason),
  );
  assert(['none', 'openai-decisions'].includes(selected.provider));
  assert.equal(typeof selected.hostedTextApproved, 'boolean');
  const grant =
    selected.provider === 'openai-decisions' &&
    selected.hostedTextApproved === true &&
    selected.candidates.length > 0;
  assert(
    !grant || selected.denialReason === undefined,
    'Allowed Decisions request cannot have a denial reason',
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
  const judgments: OpenAIDecisionsShadowJudgment[] = [];
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
    model: MODEL,
    rubric: RUBRIC,
    querySha256: hash(canonical(selected.query)),
    originalOrder,
    suggestedOrder,
    judgments,
    sharing,
    attemptedRequests,
  };
}
