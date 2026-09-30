import assert from 'node:assert/strict';
import type {
  KnowledgeGap,
  KnowledgeResult,
  KnowledgeSource,
} from '@temari/contracts';
import {
  canonical,
  digest,
  hash,
  integer,
  list,
  object,
  text,
} from './codec.js';
import {
  loadArchivePublication,
  registrationFor,
  type ArchivePublication,
} from './archive-intake.js';
import { ArchiveFailure, archiveTransport } from './archive-transport.js';

export interface ArchiveGraphOptions {
  readonly publications: readonly string[];
  readonly readScope: 'source-root';
}
export interface ArchiveGraphAnchor {
  readonly source_id: string;
  readonly generation: string;
  readonly manifest_sha256: string;
  readonly path: string;
  readonly original_sha256: string;
  readonly representation_sha256: string;
  readonly text_start: number;
  readonly text_end: number;
  readonly quote: string;
  readonly quote_sha256: string;
}
export interface ArchiveGraphRecord {
  readonly id: string;
  readonly kind: 'entity' | 'mention' | 'relationship' | 'identity-link';
  readonly provenance: 'extracted' | 'inferred' | 'ambiguous';
  readonly label?: string;
  readonly anchors?: readonly ArchiveGraphAnchor[];
  readonly subject?: string;
  readonly predicate?: string;
  readonly object?: string;
  readonly support?: readonly ArchiveGraphAnchor[];
  readonly contrary?: readonly ArchiveGraphAnchor[];
  readonly lifecycle?: 'active' | 'retracted' | 'supersedes';
  readonly supersedes?: readonly string[];
}
export interface ArchiveGraphPage {
  readonly graphId: string;
  readonly revisionSetId: string;
  readonly evidence: 'archived-snapshot';
  readonly currentOriginal: 'not-checked';
  readonly consistency: 'declared-selection-not-atomic';
  readonly records: readonly ArchiveGraphRecord[];
  readonly offset: number;
  readonly totalRecords: number;
  readonly exhausted: boolean;
  readonly next: string | null;
}
export interface ArchiveGraphProjection {
  readonly graphId: string;
  readonly directed: true;
  readonly nodes: readonly {
    readonly id: string;
    readonly label: string;
    readonly attributes: ArchiveGraphRecord;
  }[];
  readonly edges: readonly {
    readonly source: string;
    readonly target: string;
    readonly type: 'subject' | 'object';
  }[];
  /** Registrar confirms no native Graphify proof exists for this projection. */
  readonly native: { readonly status: 'unavailable'; readonly gap: string };
}
export interface ArchiveGraphReadRequest {
  readonly graphId: string;
  readonly scope: readonly KnowledgeSource[];
  readonly limit: number;
  readonly maxBytes: number;
  readonly cursor: string | null;
  readonly nodeId?: string | null;
}

function failure<T>(error: unknown): KnowledgeResult<T> {
  const gap: KnowledgeGap = {
    kind: error instanceof ArchiveFailure ? error.kind : 'unknown',
    subject: 'archived-graph',
    detail:
      error instanceof ArchiveFailure
        ? error.message
        : 'Graph response, admission, continuation, or retained integrity validation failed',
  };
  return { ok: false, gap };
}
function recordId(value: unknown): string {
  const id = text(value);
  assert(/^[0-9a-f]{32}$/.test(id), 'Invalid graph record ID');
  return id;
}
function continuation(value: unknown): string | null {
  if (value === null) return null;
  const cursor = text(value);
  assert(cursor.length <= 2048 && /^[A-Za-z0-9_=-]+$/.test(cursor));
  return cursor;
}

/** Read-only graph navigation. Every anchor is still resolved through archive reads. */
export async function createArchiveGraphReader(options: ArchiveGraphOptions) {
  assert.equal(options.readScope, 'source-root');
  assert(options.publications.length >= 1 && options.publications.length <= 8);
  const paths = [...options.publications];
  const pubs = await Promise.all(paths.map(loadArchivePublication));
  assert.equal(new Set(pubs.map((p) => p.source.id)).size, pubs.length);
  assert(
    pubs.every((p) => canonical(p.transport) === canonical(pubs[0].transport)),
  );
  const transport = await archiveTransport(pubs[0].transport);
  for (const p of pubs) {
    assert.equal(p.implementation, transport.implementation);
    assert.equal(p.protocolSha256, transport.protocolSha256);
  }
  const identity = Object.freeze({
    instance: `registrar-archived-graph:${hash(pubs[0].transport.workspace)}`,
    implementation: transport.implementation,
    configuration: hash(canonical(pubs)),
  });
  function select(scope: readonly KnowledgeSource[]): ArchivePublication[] {
    assert(scope.length >= 1 && scope.length <= 8);
    const selected = scope.map((source) => {
      const p = pubs.find(
        (item) => canonical(item.source) === canonical(source),
      );
      if (!p)
        throw new ArchiveFailure(
          'scope-refused',
          'Source is outside explicit graph admission',
        );
      return p;
    });
    assert.equal(new Set(selected).size, selected.length);
    return selected.sort((a, b) => a.source.id.localeCompare(b.source.id));
  }
  async function preflight(selected: readonly ArchivePublication[]) {
    for (const p of selected) {
      const index = pubs.indexOf(p);
      assert.equal(
        canonical(await loadArchivePublication(paths[index])),
        canonical(p),
      );
      try {
        assert.equal(
          await registrationFor(transport, p.source),
          p.registration,
        );
      } catch {
        throw new ArchiveFailure(
          'scope-refused',
          'Graph access refused by current source admission',
        );
      }
    }
  }
  function anchor(
    value: unknown,
    selected: readonly ArchivePublication[],
  ): ArchiveGraphAnchor {
    const a = object(value);
    const p = selected.find((item) => item.source.id === a['source_id']);
    assert(p, 'Anchor outside selected source scope');
    assert.equal(a['generation'], p.generation);
    assert.equal(a['manifest_sha256'], p.manifestSha256);
    const path = text(a['path']);
    assert(
      path &&
        path.length <= 4096 &&
        !path.startsWith('/') &&
        !path.includes('\\') &&
        path
          .split('/')
          .every((part) => part !== '' && part !== '.' && part !== '..'),
    );
    digest(a['original_sha256']);
    digest(a['representation_sha256']);
    const start = integer(a['text_start'], 0, 8 * 1024 * 1024);
    const end = integer(a['text_end'], start + 1, 8 * 1024 * 1024);
    const quote = text(a['quote']);
    assert.equal(Array.from(quote).length, end - start);
    assert.equal(hash(quote), digest(a['quote_sha256']));
    return a as unknown as ArchiveGraphAnchor;
  }
  function record(
    value: unknown,
    selected: readonly ArchivePublication[],
  ): ArchiveGraphRecord {
    const r = object(value);
    recordId(r['id']);
    assert(
      ['extracted', 'inferred', 'ambiguous'].includes(text(r['provenance'])),
    );
    if (r['kind'] === 'entity' || r['kind'] === 'mention') {
      assert(text(r['label']).length <= 512);
      assert(list(r['anchors']).length >= 1);
      list(r['anchors']).forEach((a) => anchor(a, selected));
    } else {
      assert(['relationship', 'identity-link'].includes(text(r['kind'])));
      recordId(r['subject']);
      recordId(r['object']);
      assert(/^[a-z][a-z0-9_-]{0,63}$/.test(text(r['predicate'])));
      assert(
        ['active', 'retracted', 'supersedes'].includes(text(r['lifecycle'])),
      );
      assert(list(r['support']).length >= 1);
      list(r['support']).forEach((a) => anchor(a, selected));
      list(r['contrary']).forEach((a) => anchor(a, selected));
      list(r['supersedes']).forEach(recordId);
    }
    return r as unknown as ArchiveGraphRecord;
  }
  function argumentsFor(
    graphId: string,
    selected: readonly ArchivePublication[],
  ) {
    digest(graphId);
    return [graphId, ...selected.flatMap((p) => ['--source', p.source.id])];
  }
  function expectedRevisionSetId(selected: readonly ArchivePublication[]) {
    return hash(canonical({
      schema: 1,
      selections: selected.map((p) => ({
        source_id: p.source.id,
        generation: p.generation,
        manifest_sha256: p.manifestSha256,
      })),
    }));
  }
  return Object.freeze({
    identity,
    async read(
      request: ArchiveGraphReadRequest,
    ): Promise<KnowledgeResult<ArchiveGraphPage>> {
      try {
        const selected = select(request.scope);
        const limit = integer(request.limit, 1, 200);
        const maxBytes = integer(request.maxBytes, 1024, 1_048_576);
        const nodeId = request.nodeId == null ? null : recordId(request.nodeId);
        const cursor = continuation(request.cursor);
        digest(request.graphId);
        await preflight(selected);
        const args = [
          ...argumentsFor(request.graphId, selected),
          '--limit',
          String(limit),
          '--max-bytes',
          String(maxBytes),
        ];
        if (cursor) args.push('--cursor', cursor);
        if (nodeId) args.push('--node-id', nodeId);
        const r = await transport.invoke('graph-read', args, maxBytes);
        assert.equal(r['graph_id'], request.graphId);
        const revisionSetId = digest(r['revision_set_id']);
        assert.equal(revisionSetId, expectedRevisionSetId(selected),
          'Graph RevisionSet differs from admitted archive publications');
        assert.equal(r['evidence'], 'archived-snapshot');
        assert.equal(r['current_original'], 'not-checked');
        assert.equal(r['consistency'], 'declared-selection-not-atomic');
        const records = list(r['records']).map((item) =>
          record(item, selected),
        );
        assert(records.length <= limit);
        const offset = integer(r['offset'], 0, 1500),
          totalRecords = integer(
            r['total_records'],
            offset + records.length,
            1500,
          ),
          exhausted = r['exhausted'];
        assert.equal(typeof exhausted, 'boolean');
        assert.equal(exhausted, offset + records.length === totalRecords);
        const next = continuation(r['next_cursor']);
        assert.equal(next === null, exhausted);
        assert(exhausted || records.length > 0, 'Graph page made no progress');
        const result: KnowledgeResult<ArchiveGraphPage> = {
          ok: true,
          value: {
            graphId: request.graphId,
            revisionSetId,
            evidence: 'archived-snapshot',
            currentOriginal: 'not-checked',
            consistency: 'declared-selection-not-atomic',
            records,
            offset,
            totalRecords,
            exhausted,
            next,
          },
        };
        assert(Buffer.byteLength(canonical(result)) <= maxBytes);
        return result;
      } catch (error) {
        return failure(error);
      }
    },
    async projection(
      graphId: string,
      scope: readonly KnowledgeSource[],
    ): Promise<KnowledgeResult<ArchiveGraphProjection>> {
      try {
        const selected = select(scope);
        digest(graphId);
        await preflight(selected);
        const selection = await transport.invoke('graph-read', [
          ...argumentsFor(graphId, selected), '--limit', '1',
          '--max-bytes', '1048576',
        ]);
        assert.equal(selection['graph_id'], graphId);
        assert.equal(digest(selection['revision_set_id']), expectedRevisionSetId(selected),
          'Graph RevisionSet differs from admitted archive publications');
        const r = await transport.invoke(
          'graph-projection',
          argumentsFor(graphId, selected),
        );
        assert.equal(r['graph_id'], graphId);
        const raw = object(r['projection']);
        assert.equal(raw['schema'], 1);
        assert.equal(raw['directed'], true);
        const nodes = list(raw['nodes']).map((value) => {
          const n = object(value),
            attributes = record(n['attributes'], selected);
          assert.equal(n['id'], attributes.id);
          assert.equal(n['label'], attributes.id);
          return { id: attributes.id, label: attributes.id, attributes };
        });
        assert(nodes.length <= 1500);
        assert.equal(new Set(nodes.map((n) => n.id)).size, nodes.length);
        const ids = new Set(nodes.map((n) => n.id));
        const edges = list(raw['edges']).map((value) => {
          const edge = object(value);
          const source = recordId(edge['source']),
            target = recordId(edge['target']);
          assert(ids.has(source) && ids.has(target));
          assert(edge['type'] === 'subject' || edge['type'] === 'object');
          return { source, target, type: edge['type'] as 'subject' | 'object' };
        });
        assert(edges.length <= 2000);
        const expected = nodes.flatMap(({ attributes: a }) =>
          a.kind === 'relationship' || a.kind === 'identity-link'
            ? [
                { source: a.subject!, target: a.id, type: 'subject' as const },
                { source: a.id, target: a.object!, type: 'object' as const },
              ]
            : [],
        );
        assert.equal(
          canonical(
            edges.sort((a, b) => canonical(a).localeCompare(canonical(b))),
          ),
          canonical(
            expected.sort((a, b) => canonical(a).localeCompare(canonical(b))),
          ),
        );
        const native = object(r['native']);
        assert.equal(native['status'], 'unavailable');
        assert.equal(native['gap'], 'native-graphify-adapter-not-configured');
        return {
          ok: true,
          value: {
            graphId,
            directed: true,
            nodes,
            edges,
            native: { status: 'unavailable', gap: text(native['gap']) },
          },
        };
      } catch (error) {
        return failure(error);
      }
    },
  });
}
