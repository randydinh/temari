import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';
import type {
  KnowledgeCheck,
  KnowledgeDiscovery,
  KnowledgeDiscoveryRequest,
  KnowledgeEvidence,
  KnowledgeGap,
  KnowledgeProvider,
  KnowledgeRead,
  KnowledgeReadRequest,
  KnowledgeResult,
  KnowledgeSource,
} from '@temari/contracts';
import {
  canonical,
  digest,
  discovery,
  evidence,
  evidenceId,
  hash,
  integer,
  list,
  object,
  text,
} from './codec.js';
import { ArchiveFailure, archiveTransport } from './archive-transport.js';
import {
  historical,
  loadArchivePublication,
  omission,
  registrationFor,
  snapshot,
} from './archive-intake.js';

export interface ArchiveRegistrarOptions {
  readonly publications: readonly string[];
  readonly readScope: 'source-root';
  /** Explicit opt-in. Exact lexical discovery remains the default. */
  readonly discoveryMode?: 'exact' | 'bm25';
}
function path(value: unknown): string {
  const p = text(value);
  if (
    p.length > 4096 ||
    isAbsolute(p) ||
    p.startsWith('-') ||
    p.includes('\\') ||
    p.includes('\0') ||
    p.split('/').some((s) => ['', '.', '..'].includes(s))
  )
    throw new ArchiveFailure(
      'scope-refused',
      'Canonical source-relative path required',
    );
  return p;
}
function fail<T>(e: unknown): KnowledgeResult<T> {
  return {
    ok: false,
    gap: {
      kind: e instanceof ArchiveFailure ? e.kind : 'unknown',
      subject: 'archive',
      detail:
        e instanceof ArchiveFailure
          ? e.message
          : 'Archive response, continuation, configuration or integrity validation failed',
    },
  };
}
/** A pinned historical reader. This object deliberately has no operator methods. */
export async function createArchiveRegistrar(
  options: ArchiveRegistrarOptions,
): Promise<KnowledgeProvider> {
  assert.equal(
    options.readScope,
    'source-root',
    'Whole selected source admission required',
  );
  assert(options.publications.length >= 1 && options.publications.length <= 8);
  const discoveryMode = options.discoveryMode ?? 'exact';
  assert(['exact', 'bm25'].includes(discoveryMode));
  const paths = [...options.publications];
  const pubs = await Promise.all(paths.map(loadArchivePublication));
  assert.equal(
    new Set(pubs.map((p) => p.source.id)).size,
    pubs.length,
    'One explicit generation per source required',
  );
  assert(
    pubs.every((p) => canonical(p.transport) === canonical(pubs[0].transport)),
    'One admitted Registrar workspace required',
  );
  const transport = await archiveTransport(pubs[0].transport);
  for (const p of pubs) {
    assert.equal(
      transport.implementation,
      p.implementation,
      'Publication implementation changed',
    );
    assert.equal(
      transport.protocolSha256,
      p.protocolSha256,
      'Publication protocol changed',
    );
  }
  const configuration = hash(
    canonical(discoveryMode === 'exact' ? pubs : { pubs, discoveryMode }),
  );
  const identity = Object.freeze({
    instance: `registrar-archive:${hash(pubs[0].transport.workspace)}`,
    implementation: transport.implementation,
    configuration,
  });
  function admit(source: KnowledgeSource) {
    const p = pubs.find((p) => canonical(p.source) === canonical(source));
    if (!p)
      throw new ArchiveFailure(
        'scope-refused',
        'Source is outside explicit archive admission',
      );
    return p;
  }
  async function preflight(selected: typeof pubs) {
    for (const p of selected) {
      const i = pubs.indexOf(p);
      assert.equal(
        canonical(await loadArchivePublication(paths[i])),
        canonical(p),
        'Publication changed',
      );
      try {
        assert.equal(
          await registrationFor(transport, p.source),
          p.registration,
        );
      } catch {
        throw new ArchiveFailure(
          'scope-refused',
          'Archive access refused by current source admission',
        );
      }
    }
  }
  function token(operation: string, key: string, value: unknown): string {
    return Buffer.from(
      canonical({ schema: 1, operation, configuration, key, value }),
    ).toString('base64url');
  }
  function untoken(
    raw: string,
    operation: string,
    key: string,
  ): Record<string, unknown> {
    assert(
      raw.length <= 16384 && /^[A-Za-z0-9_-]+$/.test(raw),
      'Invalid archive continuation',
    );
    const r = object(
      JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')),
    );
    assert.equal(r['schema'], 1);
    assert.equal(r['operation'], operation);
    assert.equal(r['configuration'], configuration);
    assert.equal(r['key'], key);
    return object(r['value']);
  }
  function cursor(value: unknown): string | null {
    if (value === null) return null;
    const c = text(value);
    assert(c.length <= 2048);
    return c;
  }
  async function readPage(
    request: KnowledgeReadRequest,
    exactOffset?: number,
  ): Promise<KnowledgeResult<KnowledgeRead>> {
    try {
      const p = admit(request.document.source),
        relative = path(request.document.path);
      const count = integer(request.maxCodePoints, 1, 8000),
        maxBytes = integer(request.maxBytes, 1024, 65536);
      if (request.expectedSha256 !== null) digest(request.expectedSha256);
      const key = hash(canonical(request.document));
      const prior =
        request.continuation === null
          ? null
          : untoken(request.continuation, 'read', key);
      if (prior && request.expectedSha256 !== null)
        assert.equal(prior['sha256'], request.expectedSha256);
      assert(
        !(prior && exactOffset !== undefined),
        'Contradictory read selectors',
      );
      await preflight([p]);
      const args = [
        p.source.id,
        p.generation,
        relative,
        '--manifest-sha256',
        p.manifestSha256,
        '--max-chars',
        String(count),
        '--max-bytes',
        String(maxBytes),
      ];
      if (prior) args.push('--cursor', text(prior['cursor']));
      else if (exactOffset !== undefined)
        args.push('--offset', String(exactOffset));
      const r = await transport.invoke('read', args, maxBytes);
      snapshot(r, p);
      assert.equal(r['path'], relative);
      const rep = object(r['representation']),
        record = object(r['record']);
      assert.equal(rep['version'], 1);
      assert.equal(rep['encoding'], 'utf-8');
      assert.equal(rep['coordinate_space'], 'unicode-codepoints');
      integer(rep['bytes'], 0, 8 * 1024 * 1024);
      const sha256 = digest(rep['original_sha256']),
        representationSha256 = digest(rep['sha256']);
      if (request.expectedSha256 !== null)
        assert.equal(sha256, request.expectedSha256);
      const representation = {
        method: text(rep['extraction']),
        signature: digest(rep['extractor_signature']),
      };
      const settings = object(rep['settings']);
      assert(Buffer.byteLength(canonical(settings)) <= 8192);
      const omissions = list(rep['omissions']).map((reason) =>
        omission(reason, relative),
      );
      for (const reason of list(r['gaps'])) {
        const gap = omission(reason, relative);
        if (!omissions.some((g) => canonical(g) === canonical(gap)))
          omissions.push(gap);
      }
      const archive: NonNullable<KnowledgeEvidence['archive']> = {
        schema: 1,
        generation: p.generation,
        manifestSha256: p.manifestSha256,
        representationSha256,
        extractorSettingsSha256: hash(canonical(settings)),
        coordinateSpace: 'extracted-text',
        currentOriginal: 'not-checked',
        omissions,
      };
      const citations = list(record['citations']);
      assert.equal(citations.length, 1);
      const c = object(citations[0]);
      historical(c);
      assert.equal(c['source_id'], p.source.id);
      assert.equal(c['snapshot_generation'], p.generation);
      assert.equal(c['manifest_sha256'], p.manifestSha256);
      assert.equal(c['path'], relative);
      assert.equal(c['sha256'], sha256);
      assert.equal(c['original_sha256'], sha256);
      assert.equal(c['representation_sha256'], representationSha256);
      assert.equal(c['extractor_signature'], representation.signature);
      assert.equal(c['extraction'], representation.method);
      assert.equal(c['coordinate_space'], 'unicode-codepoints');
      const excerpt = text(record['body']);
      assert.equal(c['quote'], excerpt);
      const start = integer(c['text_start'], 0, 8 * 1024 * 1024),
        end = integer(c['text_end'], start + 1, 8 * 1024 * 1024);
      assert.equal(
        start,
        prior
          ? integer(prior['offset'], 0, 8 * 1024 * 1024)
          : (exactOffset ?? 0),
      );
      assert.equal(r['offset'], start);
      assert.equal(Array.from(excerpt).length, end - start);
      assert(end - start <= count);
      const total = integer(r['total_chars'], end, 8 * 1024 * 1024),
        nextCursor = cursor(r['next_cursor']);
      assert.equal(r['next_offset'], nextCursor === null ? null : end);
      assert.equal(nextCursor === null, end === total);
      assert.equal(r['status'], nextCursor === null ? 'complete' : 'partial');
      // A complete representation also permits local consistency checks. Partial
      // excerpts still rely on Registrar's whole-snapshot integrity verification.
      if (start === 0 && end === total) {
        assert.equal(hash(excerpt), representationSha256);
        assert.equal(Buffer.byteLength(excerpt), rep['bytes']);
      }
      if (prior) {
        assert.equal(prior['total'], total);
        assert.equal(prior['sha256'], sha256);
        assert.equal(canonical(prior['archive']), canonical(archive));
        assert.equal(
          canonical(prior['representation']),
          canonical(representation),
        );
      }
      const body = {
        document: request.document,
        sha256,
        representation,
        archive,
        span: { unit: 'unicode-codepoint' as const, start, end },
        excerpt,
      };
      const item = { ...body, id: evidenceId(body) };
      evidence(item);
      const result: KnowledgeResult<KnowledgeRead> = {
        ok: true,
        value: {
          evidence: item,
          snapshot: p.manifestSha256,
          totalCodePoints: total,
          next:
            nextCursor === null
              ? null
              : token('read', key, {
                  cursor: nextCursor,
                  offset: end,
                  total,
                  sha256,
                  archive,
                  representation,
                }),
        },
      };
      assert(
        Buffer.byteLength(canonical(result)) <= maxBytes,
        'Adapted response exceeds requested bound',
      );
      return result;
    } catch (e) {
      return fail(e);
    }
  }
  return Object.freeze({
    identity,
    async discover(
      request: KnowledgeDiscoveryRequest,
    ): Promise<KnowledgeResult<KnowledgeDiscovery>> {
      try {
        assert(request.scope.length >= 1 && request.scope.length <= 8);
        const selected = request.scope
          .map(admit)
          .sort((a, b) => a.source.id.localeCompare(b.source.id));
        assert.equal(new Set(selected).size, selected.length);
        assert(text(request.query).length <= 512);
        integer(request.limit, 1, 50);
        integer(request.maxBytes, 1024, 65536);
        const key = hash(
          canonical({
            scope: selected.map((p) => p.source),
            query: request.query,
            mode: discoveryMode,
          }),
        );
        const prior =
          request.continuation === null
            ? null
            : untoken(request.continuation, 'discover', key);
        await preflight(selected);
        const snapshots = Object.fromEntries(
          selected.map((p) => [p.source.id, p.generation]),
        );
        const args = [
          request.query,
          ...selected.flatMap((p) => ['--source', p.source.id]),
          '--snapshots',
          canonical(snapshots),
          '--limit',
          String(request.limit),
          '--max-bytes',
          String(request.maxBytes),
        ];
        if (discoveryMode === 'bm25') args.push('--mode', 'bm25');
        if (prior) args.push('--cursor', text(prior['cursor']));
        const r = await transport.invoke('discover', args, request.maxBytes);
        historical(r);
        assert.equal(r['integrity'], 'verified');
        if (discoveryMode === 'bm25') {
          assert.equal(r['route'], 'archive-bm25');
          assert.equal(r['ranker'], 'sqlite-fts5-bm25-v1');
          assert.equal(r['tokenizer'], 'unicode61 remove_diacritics 0');
          digest(r['index_digest']);
          assert.equal(r['shortlist_truncated'], false);
          text(r['sqlite_version']);
        } else {
          assert.equal(r['route'], undefined);
          assert.equal(r['ranker'], undefined);
        }
        const pins = list(r['snapshots']).map(object);
        assert.equal(pins.length, selected.length);
        for (const p of selected) {
          const pin = pins.find((s) => s['source_id'] === p.source.id);
          assert(pin);
          assert.equal(pin['generation'], p.generation);
          assert.equal(pin['manifest_sha256'], p.manifestSha256);
        }
        const docs = list(r['documents']).map((value) => {
          const d = object(value),
            p = selected.find((p) => p.source.id === d['source_id']);
          assert(p, 'Outside scope');
          assert.equal(d['snapshot_generation'], p.generation);
          assert.equal(d['manifest_sha256'], p.manifestSha256);
          digest(d['representation_sha256']);
          digest(d['extractor_signature']);
          return {
            document: { source: p.source, path: path(d['path']) },
            sha256: digest(d['sha256']),
            applicability:
              discoveryMode === 'bm25'
                ? 'BM25-ranked archived text candidate; current originals not checked'
                : 'Exact lexical archive match; current originals not checked',
            conflicts: [],
          };
        });
        assert(docs.length <= request.limit);
        const offset = integer(r['offset']);
        assert.equal(offset, prior ? integer(prior['offset']) : 0);
        const indexed = integer(r['indexed_documents'], 0, 8000);
        const matched = integer(r['matched_documents'], 0, indexed),
          consumed = integer(r['consumed_documents']),
          remaining = integer(r['remaining_documents']);
        assert.equal(integer(r['returned_documents']), docs.length);
        assert.equal(consumed, offset + docs.length);
        assert.equal(consumed + remaining, matched);
        assert.equal(r['exhausted'], remaining === 0);
        const nextCursor = cursor(r['next_cursor']);
        assert.equal(nextCursor === null, remaining === 0);
        const gaps: KnowledgeGap[] = list(r['gaps']).map((value) => {
          const g = object(value),
            p = selected.find((p) => p.source.id === g['source_id']);
          assert(p);
          integer(g['count'], 1, 1000);
          return omission(g['reason'], p.source.id);
        });
        assert.equal(
          r['status'],
          remaining > 0 || gaps.length > 0 ? 'partial' : 'complete',
        );
        assert(
          remaining === 0 || docs.length > 0,
          'Discovery made no progress',
        );
        const value: KnowledgeDiscovery = {
          snapshot: hash(canonical(pins)),
          documents: docs,
          sources: selected.map((p) => ({
            source: p.source,
            generation: p.generation,
            scannedAt: null,
            observation:
              'Retained archive snapshot verified; current originals not checked',
          })),
          coverage: {
            indexed,
            matched,
            returned: docs.length,
            consumed,
            remaining,
            exhausted: remaining === 0,
            semanticRecall: 'not-evaluated',
          },
          gaps,
          next:
            nextCursor === null
              ? null
              : token('discover', key, {
                  cursor: nextCursor,
                  offset: consumed,
                }),
        };
        discovery(value, request.scope);
        const result: KnowledgeResult<KnowledgeDiscovery> = { ok: true, value };
        assert(Buffer.byteLength(canonical(result)) <= request.maxBytes);
        return result;
      } catch (e) {
        return fail(e);
      }
    },
    read: readPage,
    async revalidate(item: KnowledgeEvidence): Promise<KnowledgeCheck> {
      try {
        evidence(item);
        const p = admit(item.document.source);
        path(item.document.path);
        assert(item.archive);
        assert.equal(item.archive.generation, p.generation);
        assert.equal(item.archive.manifestSha256, p.manifestSha256);
        const result = await readPage(
          {
            document: item.document,
            expectedSha256: item.sha256,
            maxCodePoints: item.span.end - item.span.start,
            maxBytes: 65536,
            continuation: null,
          },
          item.span.start,
        );
        if (!result.ok)
          return {
            evidenceId: item.id,
            basis: 'archive-snapshot',
            state: result.gap.kind === 'unknown' ? 'unknown' : 'unavailable',
            detail: result.gap.detail,
            checkedAt: new Date().toISOString(),
          };
        assert.equal(result.value.evidence.id, item.id);
        return {
          evidenceId: item.id,
          basis: 'archive-snapshot',
          state: 'unchanged',
          detail:
            'Pinned retained snapshot integrity/access verified by trusted Registrar process; current originals were not checked.',
          checkedAt: new Date().toISOString(),
        };
      } catch {
        return {
          evidenceId: item.id,
          basis: 'archive-snapshot',
          state: 'unknown',
          detail:
            'Archive evidence or retained integrity check failed; current originals were not checked.',
          checkedAt: new Date().toISOString(),
        };
      }
    },
  });
}
