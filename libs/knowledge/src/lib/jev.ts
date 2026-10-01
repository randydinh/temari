/** Server-side, shadow-only Jev judgments over policy-admitted archive excerpts. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { userInfo } from 'node:os';
import { promisify } from 'node:util';
import { canonical, hash } from './codec.js';
import {
  checkCurrentJevSharing,
  type CurrentJevSharing,
  type CurrentJevSharingGuard,
} from './current-jev-sharing.js';

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const MODEL = 'jev-1.13.0';
const RUBRIC = 'knowledge-candidate-v1';

export interface JevShadowCandidate {
  readonly id: string;
  readonly evidenceIds: readonly string[];
  readonly excerpt: string;
  readonly required: boolean;
  readonly contrary: boolean;
}
export interface JevShadowRequest {
  readonly query: string;
  readonly hostedTextApproved: boolean;
  readonly denialReason?: 'local-only' | 'case-opt-out';
  readonly candidates: readonly JevShadowCandidate[];
}
export interface JevShadowOptions {
  /** Server-side only. Environment takes precedence over macOS Keychain. */
  readonly apiKey?: string;
  readonly keyResolver?: () => Promise<string | undefined>;
  readonly fetcher?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly timeoutMs?: number;
  /** Required for hosted use; checked before credential resolution and each POST. */
  readonly currentSharingGuard?: CurrentJevSharingGuard;
}

async function keychainTypeSafeKey(): Promise<string | undefined> {
  if (process.platform !== 'darwin') return undefined;
  try {
    const account = userInfo().username;
    if (!account || account.length > 256) return undefined;
    const { stdout } = await promisify(execFile)(
      '/usr/bin/security',
      [
        'find-generic-password',
        '-a',
        account,
        '-s',
        'temari-typesafe-jev',
        '-w',
      ],
      { timeout: 3000, maxBuffer: 8192, encoding: 'utf8', windowsHide: true },
    );
    const key = stdout.trim();
    return key && key.length <= 4096 && !/[\r\n\0]/.test(key) ? key : undefined;
  } catch {
    // Credential availability is an explicit missing-key gap in the caller.
    return undefined;
  }
}
export interface JevShadowJudgment {
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
  } | null;
  readonly requestSha256: string | null;
  readonly latencyMs: number | null;
  readonly state: 'judged' | 'unknown';
  readonly gap:
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
export interface JevShadowResult {
  readonly mode: 'shadow';
  readonly model: typeof MODEL;
  readonly rubric: typeof RUBRIC;
  readonly querySha256: string;
  readonly originalOrder: readonly string[];
  readonly suggestedOrder: readonly string[];
  readonly judgments: readonly JevShadowJudgment[];
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
    'Invalid Jev probability',
  );
  return value;
}
function usageCount(value: unknown): number {
  assert(
    Number.isSafeInteger(value) &&
      (value as number) >= 0 &&
      (value as number) <= 1_000_000,
    'Invalid Jev usage',
  );
  return value as number;
}
function validateRequest(request: JevShadowRequest): void {
  boundedString(request.query, 'query', 512);
  assert(
    Array.isArray(request.candidates) &&
      request.candidates.length >= 1 &&
      request.candidates.length <= 16,
    'Invalid Jev shortlist',
  );
  const ids = new Set<string>();
  let total = 0;
  for (const c of request.candidates) {
    boundedString(c.id, 'candidate ID', 256);
    assert(!ids.has(c.id), 'Duplicate Jev candidate');
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
  assert(total <= 16_000, 'Jev shortlist text exceeds bound');
}
function unknown(
  c: JevShadowCandidate,
  gap: NonNullable<JevShadowJudgment['gap']>,
): JevShadowJudgment {
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
function parsedAnswer(body: unknown): {
  relevance: number;
  support: JevShadowJudgment['support'];
  confidence: number;
  usage: NonNullable<JevShadowJudgment['usage']>;
} {
  assert(body && typeof body === 'object' && !Array.isArray(body));
  const response = body as Record<string, unknown>;
  assert.equal(response.model, MODEL, 'Unexpected resolved Jev model');
  assert(
    response.answers &&
      typeof response.answers === 'object' &&
      !Array.isArray(response.answers),
  );
  const answers = response.answers as Record<string, unknown>;
  assert.deepEqual(Object.keys(answers).sort(), ['relevance', 'support']);
  const relevance = answers.relevance as Record<string, unknown>;
  const support = answers.support as Record<string, unknown>;
  assert.equal(relevance?.type, 'noul');
  assert.equal(support?.type, 'choice');
  const value = finiteProbability(relevance.noul);
  assert(
    typeof support.choice === 'string' &&
      ['supported', 'contradicted', 'unknown'].includes(support.choice),
  );
  const probabilities = support.probabilities as Record<string, unknown>;
  assert(probabilities && typeof probabilities === 'object');
  assert.deepEqual(Object.keys(probabilities).sort(), [
    'contradicted',
    'supported',
    'unknown',
  ]);
  const sum = Object.values(probabilities).reduce<number>(
    (acc, part) => acc + finiteProbability(part),
    0,
  );
  assert(Math.abs(sum - 1) <= 0.01, 'Invalid Jev choice distribution');
  const confidence = finiteProbability(support.confidence);
  const usage = response.usage as Record<string, unknown>;
  assert(usage && typeof usage === 'object');
  return {
    relevance: value,
    support: support.choice as JevShadowJudgment['support'],
    confidence,
    usage: {
      inputTokens: usageCount(usage.input_tokens),
      outputTokens: usageCount(usage.output_tokens),
    },
  };
}

async function evaluate(
  c: JevShadowCandidate,
  query: string,
  apiKey: string,
  options: JevShadowOptions,
  checkSharing: () => Promise<CurrentJevSharing>,
  markAttempt: () => void,
): Promise<JevShadowJudgment> {
  const state = { query, candidate: { id: c.id, excerpt: c.excerpt } };
  const payload = {
    state,
    model: MODEL,
    questions: {
      relevance: {
        type: 'noul',
        instructions:
          'Is the candidate excerpt relevant to answering the query? Answer yes only for content directly useful to the query.',
      },
      support: {
        type: 'choice',
        instructions:
          'Does the candidate excerpt support or contradict the query proposition? Choose unknown if the query is not a proposition or evidence is insufficient.',
        criteria: {
          supported: 'The excerpt explicitly supports it',
          contradicted: 'The excerpt explicitly contradicts it',
          unknown: 'Neither is established',
        },
      },
    },
  };
  const requestSha256 = hash(canonical(payload));
  const timeoutMs = options.timeoutMs ?? 5000;
  assert(Number.isInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 30000);
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
      () => reject(new Error('Jev deadline exceeded')),
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
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        }),
        deadline,
      ]);
      if (response.status !== 429 && response.status !== 529) break;
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
      state: 'judged',
      gap: null,
    };
  } catch {
    return unknown(c, response?.ok ? 'invalid-response' : 'unavailable');
  } finally {
    clearTimeout(timer);
  }
}

/** Ranking advice only: all candidates and required/contrary flags survive intact. */
export async function judgeJevShadow(
  request: JevShadowRequest,
  options: JevShadowOptions = {},
): Promise<JevShadowResult> {
  // Snapshot before the first await: caller mutations cannot widen the grant,
  // shortlist or text after validation or alter the evidence hash in a receipt.
  const selected = JSON.parse(canonical(request)) as JevShadowRequest;
  validateRequest(selected);
  assert(
    selected.denialReason === undefined ||
      ['local-only', 'case-opt-out'].includes(selected.denialReason),
  );
  const grant = selected.hostedTextApproved === true;
  assert(
    !grant || selected.denialReason === undefined,
    'Allowed Jev request cannot have a denial reason',
  );
  const checkSharing = () =>
    checkCurrentJevSharing(options.currentSharingGuard);
  let sharing: CurrentJevSharing | 'not-requested' = grant
    ? await checkSharing()
    : 'not-requested';
  // No key source is consulted until the current Registrar guard has allowed use.
  let apiKey =
    sharing === 'allowed'
      ? (options.apiKey ?? process.env['TYPESAFE_API_KEY'])
      : undefined;
  if (sharing === 'allowed' && !apiKey) {
    try {
      const resolved = await (options.keyResolver ?? keychainTypeSafeKey)();
      if (resolved && resolved.length <= 4096 && !/[\r\n\0]/.test(resolved))
        apiKey = resolved;
    } catch {
      // Keep the credential failure local; no source text is sent without a key.
    }
  }
  const judgments: JevShadowJudgment[] = [];
  let attemptedRequests = 0;
  for (const c of selected.candidates) {
    const judgment = !grant
      ? unknown(c, selected.denialReason ?? 'approval-required')
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
              options,
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
  const suggestedOrder = [...judgments]
    .sort(
      (a, b) =>
        (b.relevance ?? -1) - (a.relevance ?? -1) ||
        originalOrder.indexOf(a.candidateId) -
          originalOrder.indexOf(b.candidateId),
    )
    .map((j) => j.candidateId);
  return {
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
