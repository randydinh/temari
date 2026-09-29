import {
  QaControlUnavailableError,
  type QaCategorySearchControl,
  type QaCategorySearchObservation,
} from '@temari/temari-core';

const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_ITEMS = 100;
const FIXTURE_ID = /^fixture-[A-Za-z0-9._-]+$/;

export interface LocalCategorySearchOptions {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
}

function assertLoopbackUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new Error('Local QA control requires a plain 127.0.0.1 HTTP origin.');
  }
  return url;
}

async function boundedBody(response: Response): Promise<string> {
  if (
    response.headers.has('content-length') &&
    Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES
  ) {
    throw new QaControlUnavailableError(
      'Category-search response is too large.',
    );
  }
  if (!response.body) {
    throw new QaControlUnavailableError(
      'Category-search response has no body.',
    );
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        throw new QaControlUnavailableError(
          'Category-search response is too large.',
        );
      }
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseObservation(
  body: string,
  candidateRef: string | null,
  environmentRef: string | null,
): QaCategorySearchObservation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new QaControlUnavailableError(
      'Category-search response is not JSON.',
    );
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('items' in parsed) ||
    !Array.isArray(parsed.items) ||
    parsed.items.length > MAX_ITEMS ||
    !candidateRef ||
    !environmentRef
  ) {
    throw new QaControlUnavailableError('Category-search response is invalid.');
  }
  const items: { id: string; category: string }[] = [];
  for (const item of parsed.items) {
    if (
      !item ||
      typeof item !== 'object' ||
      typeof item.id !== 'string' ||
      typeof item.category !== 'string' ||
      !FIXTURE_ID.test(item.id) ||
      !/^category-[A-Za-z0-9._-]+$/.test(item.category)
    ) {
      throw new QaControlUnavailableError(
        'Category-search response contains a non-synthetic item.',
      );
    }
    items.push({ id: item.id, category: item.category });
  }
  return { candidateRef, environmentRef, items };
}

/** Read-only, loopback-only project-control proof for a synthetic QA pilot. */
export function createLocalCategorySearchControl(
  options: LocalCategorySearchOptions,
): QaCategorySearchControl {
  const baseUrl = assertLoopbackUrl(options.baseUrl);
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) {
    throw new Error('Local QA control timeout must be 1–30000 ms.');
  }
  return {
    id: 'local-category-search-http-v1',
    async search(request) {
      const url = new URL('/category-search', baseUrl);
      url.searchParams.set('category', request.selectedCategory);
      url.searchParams.set('q', request.searchTerm);
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'GET',
          redirect: 'error',
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new QaControlUnavailableError(
          'Local category-search control is unavailable.',
        );
      }
      try {
        if (!response.ok) {
          throw new QaControlUnavailableError(
            `Local category-search returned HTTP ${response.status}.`,
          );
        }
        return parseObservation(
          await boundedBody(response),
          response.headers.get('x-temari-candidate'),
          response.headers.get('x-temari-environment'),
        );
      } catch (error) {
        if (error instanceof QaControlUnavailableError) throw error;
        throw new QaControlUnavailableError(
          'Local category-search observation could not be read.',
        );
      }
    },
  };
}
