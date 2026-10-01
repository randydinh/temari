/** Read-only dashboard projection of explicitly pinned Registrar publications. */
import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';
import type { KnowledgeSource } from '../libs/contracts/src/index.js';
import { createArchiveRegistrar } from '../libs/knowledge/src/lib/archive-registrar.js';
import {
  createArchiveGraphReader,
  type ArchiveGraphAnchor,
  type ArchiveGraphRecord,
} from '../libs/knowledge/src/lib/archive-graph.js';
import {
  loadArchivePublication,
  registrationFor,
  snapshot,
  type ArchivePublication,
} from '../libs/knowledge/src/lib/archive-intake.js';
import { archiveTransport } from '../libs/knowledge/src/lib/archive-transport.js';
import {
  canonical,
  digest,
  hash,
  integer,
  list,
  object,
  text,
} from '../libs/knowledge/src/lib/codec.js';
import { readJsonWithBytes } from '../libs/knowledge/src/lib/durable.js';

export interface DashboardKnowledgeOptions {
  readonly readScope: 'source-root';
  readonly publications: readonly {
    readonly id: string;
    readonly publicationPath: string;
    readonly sha256: string;
  }[];
  readonly graphs?: readonly {
    readonly id: string;
    readonly graphId: string;
    readonly publicationIds: readonly string[];
  }[];
  readonly limits?: {
    readonly documentsPerPublication?: number;
    readonly graphRecords?: number;
    readonly nodes?: number;
    readonly edges?: number;
    readonly responseBytes?: number;
  };
}
export interface KnowledgeMapAnchor {
  readonly publicationId: string;
  readonly source: KnowledgeSource;
  readonly generation: string;
  readonly manifestSha256: string;
  readonly role: 'source' | 'document' | 'support' | 'contrary' | 'mention';
  readonly path?: string;
  readonly originalSha256?: string;
  readonly representationSha256?: string;
  readonly span?: {
    readonly start: number;
    readonly end: number;
    readonly unit: 'unicode-codepoint';
  };
  readonly quoteSha256?: string;
}
export interface KnowledgeMapNode {
  readonly id: string;
  readonly kind:
    | 'source'
    | 'publication'
    | 'document'
    | 'path'
    | 'graph'
    | 'entity'
    | 'mention'
    | 'assertion'
    | 'provenance'
    | 'gap';
  readonly label: string;
  readonly qualifiers: readonly string[];
  readonly anchors: readonly KnowledgeMapAnchor[];
}
export interface KnowledgeMapEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly kind: string;
  readonly qualifiers: readonly string[];
  readonly anchors: readonly KnowledgeMapAnchor[];
}
export interface KnowledgeMapGap {
  readonly id: string;
  readonly kind: string;
  readonly subject: string;
  readonly detail: string;
}
export interface KnowledgeMapSnapshot {
  readonly schema: 1;
  readonly state: 'not-configured' | 'ready' | 'partial' | 'unavailable';
  readonly configurationId: string | null;
  readonly nodes: readonly KnowledgeMapNode[];
  readonly edges: readonly KnowledgeMapEdge[];
  readonly gaps: readonly KnowledgeMapGap[];
  readonly coverage: {
    readonly configuredPublications: number;
    readonly validPublications: number;
    readonly documentsReturned: number;
    readonly documentsKnown: number;
    readonly graphRecordsReturned: number;
    readonly graphRecordsKnown: number;
    readonly truncated: boolean;
    readonly semanticRecall: 'not-evaluated';
    readonly consistency: 'sequential-checks-not-atomic';
  };
  readonly historical: true;
  readonly currentOriginal: 'not-checked';
}
export interface KnowledgeMapDetail {
  readonly configurationId: string;
  readonly state: 'ready' | 'unavailable';
  readonly node: KnowledgeMapNode;
  readonly edges: readonly KnowledgeMapEdge[];
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly gaps: readonly KnowledgeMapGap[];
  readonly historical: true;
  readonly currentOriginal: 'not-checked';
}
interface Limits {
  documentsPerPublication: number;
  graphRecords: number;
  nodes: number;
  edges: number;
  responseBytes: number;
}
interface Pinned {
  option: DashboardKnowledgeOptions['publications'][number];
  publication: ArchivePublication;
}
interface Selection {
  configurationId: string;
  node: KnowledgeMapNode;
  edges: readonly KnowledgeMapEdge[];
  metadata: Readonly<Record<string, unknown>>;
  publicationIds: readonly string[];
  graphAlias?: string;
  recordId?: string;
  readNodeId?: string;
  catalogOffset?: number;
  document?: { publicationId: string; path: string; sha256: string | null };
}
// Selection IDs resolve only through bounded server-held metadata, never client paths.
// Refreshing the map restores initial IDs after a restart; expanded IDs may expire.
const selections = new Map<string, Selection>();
const historical = ['historical', 'current-original-not-checked'];
function keys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  assert(
    Object.keys(value).every((key) => allowed.includes(key)),
    'Unknown knowledge map configuration field.',
  );
}
function identifier(value: unknown): string {
  const id = text(value);
  assert(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id),
    'Expected a bounded host-defined identifier.',
  );
  return id;
}
function relativePath(value: unknown): string {
  const path = text(value);
  assert(
    path.length <= 4096 &&
      !isAbsolute(path) &&
      !path.startsWith('-') &&
      !path.includes('\\') &&
      !path.includes('\0') &&
      path
        .split('/')
        .every((part) => part !== '' && part !== '.' && part !== '..'),
    'Invalid source-relative archive path.',
  );
  return path;
}
function limits(options: DashboardKnowledgeOptions): Limits {
  return {
    documentsPerPublication: options.limits?.documentsPerPublication ?? 30,
    graphRecords: options.limits?.graphRecords ?? 40,
    nodes: options.limits?.nodes ?? 200,
    edges: options.limits?.edges ?? 400,
    responseBytes: options.limits?.responseBytes ?? 262144,
  };
}
export function parseDashboardKnowledgeOptions(
  value: unknown,
): DashboardKnowledgeOptions {
  const raw = object(value);
  keys(raw, ['readScope', 'publications', 'graphs', 'limits']);
  assert.equal(
    raw['readScope'],
    'source-root',
    'Whole explicitly selected source admission is required.',
  );
  const publications = list(raw['publications']).map((value) => {
    const item = object(value);
    keys(item, ['id', 'publicationPath', 'sha256']);
    const publicationPath = text(item['publicationPath']);
    assert(
      isAbsolute(publicationPath) &&
        publicationPath.length <= 4096 &&
        !publicationPath.includes('\0'),
      'Publication paths must be explicit absolute paths.',
    );
    return {
      id: identifier(item['id']),
      publicationPath,
      sha256: digest(item['sha256']),
    };
  });
  assert(
    publications.length >= 1 && publications.length <= 8,
    'Select one to eight publications.',
  );
  assert.equal(
    new Set(publications.map((p) => p.id)).size,
    publications.length,
    'Duplicate publication ID.',
  );
  assert.equal(
    new Set(publications.map((p) => p.publicationPath)).size,
    publications.length,
    'Duplicate publication path.',
  );
  const graphs = list(raw['graphs'] ?? []).map((value) => {
    const item = object(value);
    keys(item, ['id', 'graphId', 'publicationIds']);
    const publicationIds = list(item['publicationIds']).map(identifier);
    assert(
      publicationIds.length >= 1 &&
        publicationIds.length <= 8 &&
        new Set(publicationIds).size === publicationIds.length,
      'Invalid graph source selection.',
    );
    assert(
      publicationIds.every((id) => publications.some((p) => p.id === id)),
      'Graph source is outside explicit publication admission.',
    );
    return {
      id: identifier(item['id']),
      graphId: digest(item['graphId']),
      publicationIds,
    };
  });
  assert(
    graphs.length <= 8 &&
      new Set(graphs.map((g) => g.id)).size === graphs.length,
    'At most eight uniquely named graphs are permitted.',
  );
  const bound = object(raw['limits'] ?? {});
  keys(bound, [
    'documentsPerPublication',
    'graphRecords',
    'nodes',
    'edges',
    'responseBytes',
  ]);
  const parsed = {
    readScope: 'source-root' as const,
    publications,
    graphs,
    limits: {
      documentsPerPublication: integer(
        bound['documentsPerPublication'] ?? 30,
        1,
        100,
      ),
      graphRecords: integer(bound['graphRecords'] ?? 40, 1, 100),
      nodes: integer(bound['nodes'] ?? 200, 16, 300),
      edges: integer(bound['edges'] ?? 400, 16, 600),
      responseBytes: integer(bound['responseBytes'] ?? 262144, 8192, 524288),
    },
  };
  return parsed;
}
function configId(options: DashboardKnowledgeOptions): string {
  return hash(canonical(options));
}
function nodeId(configuration: string, kind: string, key: unknown): string {
  return `km-${hash(canonical([configuration, kind, key])).slice(0, 32)}`;
}
function label(path: string): string {
  return path.replace(/[\u0000-\u001f\u007f]/g, '�').slice(0, 160);
}
function anchor(
  pin: Pinned,
  role: KnowledgeMapAnchor['role'] = 'source',
): KnowledgeMapAnchor {
  return {
    publicationId: pin.option.id,
    source: pin.publication.source,
    generation: pin.publication.generation,
    manifestSha256: pin.publication.manifestSha256,
    role,
  };
}
async function pinned(
  option: DashboardKnowledgeOptions['publications'][number],
): Promise<Pinned> {
  const raw = await readJsonWithBytes(option.publicationPath);
  assert.equal(hash(raw.bytes), option.sha256, 'Publication byte pin changed.');
  const publication = await loadArchivePublication(option.publicationPath);
  assert.equal(
    canonical(raw.value),
    canonical(publication),
    'Publication changed while loading.',
  );
  assert.equal(
    hash((await readJsonWithBytes(option.publicationPath)).bytes),
    option.sha256,
    'Publication changed while loading.',
  );
  return { option, publication };
}
async function catalog(pin: Pinned, count: number, offset = 0) {
  integer(offset, 0, 1000);
  const p = pin.publication,
    transport = await archiveTransport(p.transport);
  assert.equal(transport.implementation, p.implementation);
  assert.equal(transport.protocolSha256, p.protocolSha256);
  assert.equal(
    await registrationFor(transport, p.source),
    p.registration,
    'Current source admission changed.',
  );
  const page = await transport.invoke(
    'inspect',
    [
      p.source.id,
      p.generation,
      '--manifest-sha256',
      p.manifestSha256,
      '--offset',
      String(offset),
      '--limit',
      String(count),
      '--max-bytes',
      '262144',
    ],
    262144,
  );
  snapshot(page, p);
  assert.equal(page['request_key'], p.captureRequestKey);
  assert.equal(page['request_fingerprint'], p.captureFingerprint);
  assert.equal(page['preservation'], p.preservation);
  assert.equal(canonical(page['counts']), canonical(p.counts));
  const documents = list(page['documents']).map((value) => {
    const item = object(value),
      original = item['original'] === null ? null : object(item['original']),
      representation =
        item['representation'] === null ? null : object(item['representation']);
    return {
      path: relativePath(item['path']),
      status: text(item['status']),
      directory:
        item['status'] === 'excluded' && item['reason'] === 'directory',
      sha256: original ? digest(original['sha256']) : null,
      representationSha256: representation
        ? digest(representation['sha256'])
        : null,
      gaps: list(item['gaps']).length,
    };
  });
  assert(documents.length <= count);
  const next =
    page['next_offset'] === null
      ? null
      : integer(page['next_offset'], offset + documents.length, 1000);
  await pinned(pin.option);
  const total = Object.values(p.counts).reduce((sum, n) => sum + n, 0);
  assert.equal(
    new Set(documents.map((document) => document.path)).size,
    documents.length,
  );
  assert.equal(next !== null, offset + documents.length < total);
  if (next !== null) assert.equal(next, offset + documents.length);
  return { documents, next, total };
}
function gapDetail(kind: string): string {
  const descriptions: Record<string, string> = {
    'publication-unavailable':
      'Pinned publication or its source admission did not verify; no live or latest fallback was attempted.',
    'graph-unavailable':
      'The exact archived graph and its source selection did not verify.',
    'document-unavailable':
      'The selected retained document could not be revalidated.',
    'capability-gap':
      'The retained archive reports preservation or interpretation omissions.',
    'catalog-bound':
      'More retained entries exist beyond this bounded catalog page.',
    'catalog-page':
      'This view shows a later bounded catalog page; preceding entries are not repeated here.',
    'graph-bound': 'More graph records exist beyond this bounded graph page.',
    'projection-bound':
      'Node, edge, anchor, or byte limits omit part of this projection.',
    'graph-not-configured':
      'No archived graph is selected; only the admitted document catalog is shown.',
    'selection-unavailable':
      'Selected retained metadata is no longer verifiable under its exact pins.',
  };
  return descriptions[kind] ?? 'Selected knowledge is unavailable.';
}
function addSelection(selection: Selection): void {
  selections.delete(selection.node.id);
  selections.set(selection.node.id, selection);
  while (selections.size > 2048)
    selections.delete(selections.keys().next().value!);
}
function empty(): KnowledgeMapSnapshot {
  return {
    schema: 1,
    state: 'not-configured',
    configurationId: null,
    nodes: [],
    edges: [],
    gaps: [],
    coverage: {
      configuredPublications: 0,
      validPublications: 0,
      documentsReturned: 0,
      documentsKnown: 0,
      graphRecordsReturned: 0,
      graphRecordsKnown: 0,
      truncated: false,
      semanticRecall: 'not-evaluated',
      consistency: 'sequential-checks-not-atomic',
    },
    historical: true,
    currentOriginal: 'not-checked',
  };
}
async function project(
  options: DashboardKnowledgeOptions,
  expansion?: {
    graphAlias?: string;
    recordId?: string;
    publicationId?: string;
    offset?: number;
  },
): Promise<KnowledgeMapSnapshot> {
  const configurationId = configId(options),
    bounds = limits(options),
    nodes = new Map<string, KnowledgeMapNode>(),
    edges = new Map<string, KnowledgeMapEdge>(),
    gaps: KnowledgeMapGap[] = [],
    resolvers = new Map<
      string,
      Omit<Selection, 'node' | 'edges' | 'configurationId'>
    >(),
    pins = new Map<string, Pinned>();
  const knownDocuments = new Set<string>();
  let truncated = false,
    graphRecordsKnown = 0,
    validPublications = 0;
  const add = (
    kind: KnowledgeMapNode['kind'],
    key: unknown,
    text: string,
    anchors: readonly KnowledgeMapAnchor[],
    qualifiers: readonly string[],
    resolver: Omit<Selection, 'node' | 'edges' | 'configurationId'>,
  ): string => {
    const id = nodeId(configurationId, kind, key);
    if (nodes.has(id)) return id;
    if (nodes.size >= bounds.nodes - 1 || anchors.length > 16) {
      truncated = true;
      return id;
    }
    nodes.set(id, {
      id,
      kind,
      label: label(text),
      qualifiers: [...historical, ...qualifiers],
      anchors,
    });
    resolvers.set(id, resolver);
    return id;
  };
  const edge = (
    source: string,
    target: string,
    kind: string,
    anchors: readonly KnowledgeMapAnchor[],
    qualifiers: readonly string[] = [],
  ): void => {
    if (!nodes.has(source) || !nodes.has(target)) {
      truncated = true;
      return;
    }
    if (edges.size >= bounds.edges || anchors.length > 16) {
      truncated = true;
      return;
    }
    const id = nodeId(configurationId, 'edge', [source, target, kind]);
    edges.set(id, {
      id,
      source,
      target,
      kind,
      qualifiers: [...historical, ...qualifiers],
      anchors,
    });
  };
  const gap = (kind: string, subject: string, parent?: string): void => {
    const id = nodeId(configurationId, 'gap', [kind, subject]);
    if (gaps.some((g) => g.id === id)) return;
    if (gaps.length >= 32) {
      truncated = true;
      return;
    }
    const detail = gapDetail(kind);
    gaps.push({ id, kind, subject, detail });
    const gid = add(
      'gap',
      [kind, subject],
      kind,
      [],
      ['unavailable-or-incomplete'],
      { publicationIds: [], metadata: { kind, detail } },
    );
    if (parent)
      edge(parent, gid, 'has-gap', [], ['gap-not-a-source-assertion']);
  };
  const document = (
    pin: Pinned,
    path: string,
    sha256: string | null,
    representationSha256?: string | null,
  ): string => {
    knownDocuments.add(`${pin.option.id}:${path}`);
    const base = anchor(pin, 'document');
    const anchors: KnowledgeMapAnchor[] = [
      {
        ...base,
        path,
        ...(sha256 ? { originalSha256: sha256 } : {}),
        ...(representationSha256 ? { representationSha256 } : {}),
      },
    ];
    let parent = nodeId(configurationId, 'publication', pin.option.id);
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index++) {
      const prefix = parts.slice(0, index).join('/');
      const next = add(
        'path',
        [pin.option.id, prefix],
        prefix,
        [{ ...anchor(pin), path: prefix }],
        ['source-relative-directory', 'derived-from-retained-path'],
        {
          publicationIds: [pin.option.id],
          metadata: { path: prefix, source: pin.publication.source },
        },
      );
      edge(parent, next, 'contains-path', anchors, ['retained-metadata']);
      parent = next;
    }
    const id = add(
      'document',
      [pin.option.id, path],
      path,
      anchors,
      ['retained-document', 'original-currency-not-established'],
      {
        publicationIds: [pin.option.id],
        document: { publicationId: pin.option.id, path, sha256 },
        metadata: {
          path,
          sha256,
          representationSha256: representationSha256 ?? null,
          source: pin.publication.source,
          generation: pin.publication.generation,
          manifestSha256: pin.publication.manifestSha256,
        },
      },
    );
    edge(parent, id, 'contains-document', anchors, ['retained-metadata']);
    return id;
  };
  for (const option of options.publications) {
    try {
      const pin = await pinned(option),
        page = await catalog(
          pin,
          bounds.documentsPerPublication,
          expansion?.publicationId === option.id ? expansion.offset : 0,
        );
      pins.set(option.id, pin);
      validPublications++;

      const anchors = [anchor(pin)],
        source = add(
          'source',
          option.id,
          option.id,
          anchors,
          ['explicit-host-admission'],
          {
            publicationIds: [option.id],
            metadata: { source: pin.publication.source },
          },
        );
      const publication = add(
        'publication',
        option.id,
        `Snapshot ${pin.publication.generation.slice(0, 12)}`,
        anchors,
        ['immutable-generation', pin.publication.preservation],
        {
          publicationIds: [option.id],
          metadata: {
            publicationId: option.id,
            publicationSha256: option.sha256,
            generation: pin.publication.generation,
            manifestSha256: pin.publication.manifestSha256,
            implementation: pin.publication.implementation,
            preservation: pin.publication.preservation,
            counts: pin.publication.counts,
          },
        },
      );
      edge(source, publication, 'retained-publication', anchors, [
        'exact-generation',
      ]);
      if (
        expansion?.publicationId === option.id &&
        (expansion.offset ?? 0) > 0
      ) {
        truncated = true;
        gap('catalog-page', publication, publication);
      }
      for (const item of page.documents) {
        if (item.directory) {
          const pathAnchors = [{ ...anchor(pin), path: item.path }];
          const directory = add(
            'path',
            [pin.option.id, item.path],
            item.path,
            pathAnchors,
            ['source-relative-directory', 'retained-directory'],
            {
              publicationIds: [pin.option.id],
              metadata: {
                path: item.path,
                source: pin.publication.source,
                kind: 'directory',
              },
            },
          );
          edge(publication, directory, 'contains-path', pathAnchors, [
            'retained-metadata',
          ]);
          continue;
        }
        const id = document(
          pin,
          item.path,
          item.sha256,
          item.representationSha256,
        );
        if (
          item.gaps ||
          item.status === 'unavailable' ||
          !item.representationSha256
        )
          gap('capability-gap', id, id);
      }
      if (pin.publication.gaps.length)
        gap('capability-gap', publication, publication);
      if (page.next !== null) {
        truncated = true;
        const subject = `${publication}:${page.next}`;
        gap('catalog-bound', subject, publication);
        const gapId = nodeId(configurationId, 'gap', [
          'catalog-bound',
          subject,
        ]);
        resolvers.set(gapId, {
          publicationIds: [option.id],
          catalogOffset: page.next,
          metadata: {
            kind: 'catalog-bound',
            detail: gapDetail('catalog-bound'),
            nextOffset: page.next,
          },
        });
      }
    } catch {
      gap('publication-unavailable', option.id);
    }
  }
  if (!options.graphs?.length) gap('graph-not-configured', 'configuration');
  for (const config of options.graphs ?? []) {
    if (expansion?.graphAlias && config.id !== expansion.graphAlias) continue;
    const selected = config.publicationIds.map((id) => pins.get(id));
    if (selected.some((pin) => !pin)) {
      gap('graph-unavailable', config.id);
      continue;
    }
    const admitted = selected as Pinned[];
    try {
      const reader = await createArchiveGraphReader({
        publications: admitted.map((pin) => pin.option.publicationPath),
        readScope: 'source-root',
      });
      const result = await reader.read({
        graphId: config.graphId,
        scope: admitted.map((pin) => pin.publication.source),
        limit: bounds.graphRecords,
        maxBytes: 262144,
        cursor: null,
        nodeId: expansion?.recordId ?? null,
      });
      if (!result.ok) throw new Error('Pinned graph unavailable.');
      await Promise.all(admitted.map((pin) => pinned(pin.option)));
      graphRecordsKnown += result.value.totalRecords;
      const graphAnchors = admitted.map((pin) => anchor(pin));
      const graph = add(
        'graph',
        config.id,
        config.id,
        graphAnchors,
        [
          'archived-graph',
          'declared-selection-not-atomic',
          'native-graphify-not-attested',
        ],
        {
          publicationIds: config.publicationIds,
          graphAlias: config.id,
          metadata: {
            graphId: config.graphId,
            revisionSetId: result.value.revisionSetId,
            recordCount: result.value.totalRecords,
            nativeGraphify: 'not-attested',
          },
        },
      );
      for (const pin of admitted)
        edge(
          nodeId(configurationId, 'publication', pin.option.id),
          graph,
          'graph-source',
          [anchor(pin)],
          ['exact-revision-set'],
        );
      const sanitized = (
        a: ArchiveGraphAnchor,
        role: KnowledgeMapAnchor['role'],
      ): KnowledgeMapAnchor => {
        const pin = admitted.find(
          (pin) => pin.publication.source.id === a.source_id,
        );
        assert(pin);
        return {
          ...anchor(pin, role),
          path: a.path,
          originalSha256: a.original_sha256,
          representationSha256: a.representation_sha256,
          span: {
            start: a.text_start,
            end: a.text_end,
            unit: 'unicode-codepoint',
          },
          quoteSha256: a.quote_sha256,
        };
      };
      const recordAnchors = (record: ArchiveGraphRecord) => [
        ...(record.anchors ?? []).map((a) => sanitized(a, 'mention')),
        ...(record.support ?? []).map((a) => sanitized(a, 'support')),
        ...(record.contrary ?? []).map((a) => sanitized(a, 'contrary')),
      ];
      for (const record of result.value.records) {
        const anchors = recordAnchors(record),
          kind =
            record.kind === 'relationship' || record.kind === 'identity-link'
              ? 'assertion'
              : record.kind;
        const id = add(
          kind,
          [config.id, record.id],
          `${kind} ${record.id.slice(0, 10)}`,
          anchors,
          [record.provenance, ...(record.lifecycle ? [record.lifecycle] : [])],
          {
            publicationIds: config.publicationIds,
            graphAlias: config.id,
            recordId: record.id,
            readNodeId: kind === 'assertion' ? record.subject : record.id,
            metadata: {
              graphId: config.graphId,
              recordId: record.id,
              kind: record.kind,
              provenance: record.provenance,
              predicate: record.predicate ?? null,
              lifecycle: record.lifecycle ?? null,
              subject: record.subject ?? null,
              object: record.object ?? null,
              supersedes: record.supersedes ?? [],
            },
          },
        );
        edge(graph, id, 'contains-record', anchors, [record.provenance]);
        const provenance = add(
          'provenance',
          [config.id, record.provenance],
          record.provenance,
          graphAnchors,
          ['declared-provenance'],
          {
            publicationIds: config.publicationIds,
            graphAlias: config.id,
            metadata: {
              provenance: record.provenance,
              meaning:
                'A retained producer qualifier; independent semantic verification remains required.',
            },
          },
        );
        edge(id, provenance, 'has-provenance', anchors, [record.provenance]);
        for (const a of anchors) {
          const pin = pins.get(a.publicationId)!;
          const doc = document(
            pin,
            a.path!,
            a.originalSha256!,
            a.representationSha256,
          );
          edge(id, doc, `anchored-${a.role}`, [a], [record.provenance]);
        }
      }
      for (const record of result.value.records) {
        if (!record.subject || !record.object) continue;
        const anchors = recordAnchors(record),
          assertion = nodeId(configurationId, 'assertion', [
            config.id,
            record.id,
          ]);
        for (const [role, native] of [
          ['subject', record.subject],
          ['object', record.object],
        ] as const) {
          const endpoint = result.value.records.find((r) => r.id === native);
          if (!endpoint) {
            truncated = true;
            gap('graph-bound', assertion, assertion);
            continue;
          }
          const target = nodeId(
            configurationId,
            endpoint.kind === 'entity' || endpoint.kind === 'mention'
              ? endpoint.kind
              : 'assertion',
            [config.id, native],
          );
          edge(assertion, target, role, anchors, [
            record.provenance,
            record.lifecycle ?? 'active',
          ]);
        }
      }
      if (!result.value.exhausted) {
        truncated = true;
        gap('graph-bound', graph, graph);
      }
    } catch {
      gap('graph-unavailable', config.id);
    }
  }
  if (truncated) gap('projection-bound', 'configuration');
  let map: KnowledgeMapSnapshot = {
    schema: 1,
    state:
      validPublications === 0
        ? 'unavailable'
        : gaps.length
          ? 'partial'
          : 'ready',
    configurationId,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    gaps,
    coverage: {
      configuredPublications: options.publications.length,
      validPublications,
      documentsReturned: 0,
      documentsKnown: knownDocuments.size,
      graphRecordsReturned: 0,
      graphRecordsKnown,
      truncated,
      semanticRecall: 'not-evaluated',
      consistency: 'sequential-checks-not-atomic',
    },
    historical: true,
    currentOriginal: 'not-checked',
  };
  while (
    Buffer.byteLength(canonical(map)) > bounds.responseBytes &&
    (map.edges.length || map.nodes.length)
  ) {
    truncated = true;
    if (map.edges.length) map = { ...map, edges: map.edges.slice(0, -1) };
    else map = { ...map, nodes: map.nodes.slice(0, -1) };
  }
  if (truncated && !gaps.some((g) => g.kind === 'projection-bound'))
    gaps.push({
      id: nodeId(configurationId, 'gap', ['projection-bound', 'configuration']),
      kind: 'projection-bound',
      subject: 'configuration',
      detail: gapDetail('projection-bound'),
    });
  map = {
    ...map,
    state:
      validPublications === 0
        ? 'unavailable'
        : gaps.length
          ? 'partial'
          : 'ready',
    coverage: {
      ...map.coverage,
      truncated,
      documentsReturned: map.nodes.filter((n) => n.kind === 'document').length,
      graphRecordsReturned: map.nodes.filter((n) =>
        ['entity', 'mention', 'assertion'].includes(n.kind),
      ).length,
    },
  };
  // Reserve enough space for the bounded coverage/gap footer after truncation.
  while (
    Buffer.byteLength(canonical(map)) > bounds.responseBytes &&
    map.nodes.length
  ) {
    map = { ...map, nodes: map.nodes.slice(0, -1), edges: [] };
  }
  map = {
    ...map,
    coverage: {
      ...map.coverage,
      documentsReturned: map.nodes.filter((node) => node.kind === 'document')
        .length,
      graphRecordsReturned: map.nodes.filter((node) =>
        ['entity', 'mention', 'assertion'].includes(node.kind),
      ).length,
    },
  };
  for (const node of map.nodes) {
    const resolver = resolvers.get(node.id);
    if (resolver)
      addSelection({
        configurationId,
        node,
        edges: map.edges.filter(
          (edge) => edge.source === node.id || edge.target === node.id,
        ),
        ...resolver,
      });
  }
  return map;
}
export async function inspectKnowledgeMap(
  options?: DashboardKnowledgeOptions,
): Promise<KnowledgeMapSnapshot> {
  return options === undefined
    ? empty()
    : project(parseDashboardKnowledgeOptions(options));
}
export class KnowledgeMapSelectionError extends Error {
  readonly status = 404;
}
async function selected(
  options: DashboardKnowledgeOptions,
  nodeId: string,
): Promise<{ options: DashboardKnowledgeOptions; selection: Selection }> {
  const parsed = parseDashboardKnowledgeOptions(options),
    id = configId(parsed);
  if (!/^km-[0-9a-f]{32}$/.test(nodeId))
    throw new KnowledgeMapSelectionError('Unknown knowledge map selection.');
  if (!selections.has(nodeId)) await project(parsed);
  const selection = selections.get(nodeId);
  if (!selection || selection.configurationId !== id)
    throw new KnowledgeMapSelectionError(
      'Unknown or expired knowledge map selection; refresh the map.',
    );
  return { options: parsed, selection };
}
function boundedDetail(
  detail: KnowledgeMapDetail,
  maxBytes: number,
): KnowledgeMapDetail {
  if (Buffer.byteLength(canonical(detail)) <= maxBytes) return detail;
  const gap = {
    id: detail.node.id,
    kind: 'projection-bound',
    subject: detail.node.id,
    detail: gapDetail('projection-bound'),
  };
  let result: KnowledgeMapDetail = {
    ...detail,
    state: 'unavailable',
    edges: [],
    metadata: { omitted: 'Detail exceeded the configured byte bound.' },
    gaps: [gap],
  };
  if (Buffer.byteLength(canonical(result)) > maxBytes)
    result = {
      ...result,
      node: {
        ...result.node,
        anchors: [],
        qualifiers: [
          ...result.node.qualifiers,
          'anchors-omitted-by-detail-bound',
        ],
      },
    };
  return result;
}
export async function selectKnowledgeMapNode(
  options: DashboardKnowledgeOptions,
  nodeId: string,
): Promise<KnowledgeMapDetail> {
  const current = await selected(options, nodeId),
    selection = current.selection;
  const base = {
    configurationId: selection.configurationId,
    node: selection.node,
    edges: selection.edges,
    metadata: selection.metadata,
    historical: true as const,
    currentOriginal: 'not-checked' as const,
  };
  if (selection.node.kind === 'gap')
    return boundedDetail(
      {
        ...base,
        state: 'unavailable',
        gaps: [
          {
            id: nodeId,
            kind: String(selection.metadata['kind']),
            subject: nodeId,
            detail: String(selection.metadata['detail']),
          },
        ],
      },
      limits(current.options).responseBytes,
    );
  try {
    const pins = await Promise.all(
      selection.publicationIds.map((id) =>
        pinned(current.options.publications.find((p) => p.id === id)!),
      ),
    );
    // These are bounded read-only capability checks, never capture or live refresh.
    if (selection.graphAlias) {
      const config = current.options.graphs!.find(
        (g) => g.id === selection.graphAlias,
      )!;
      const reader = await createArchiveGraphReader({
        publications: pins.map((p) => p.option.publicationPath),
        readScope: 'source-root',
      });
      const result = await reader.read({
        graphId: config.graphId,
        scope: pins.map((p) => p.publication.source),
        limit: limits(current.options).graphRecords,
        maxBytes: 262144,
        cursor: null,
        nodeId: selection.readNodeId ?? null,
      });
      assert(result.ok);
      if (selection.recordId)
        assert(
          result.value.records.some(
            (record) => record.id === selection.recordId,
          ),
        );
    } else for (const pin of pins) await catalog(pin, 1);
    if (selection.document) {
      const doc = selection.document,
        pin = pins.find((p) => p.option.id === doc.publicationId)!;
      const provider = await createArchiveRegistrar({
        publications: [pin.option.publicationPath],
        readScope: 'source-root',
      });
      const result = await provider.read({
        document: { source: pin.publication.source, path: doc.path },
        expectedSha256: doc.sha256,
        maxCodePoints: 1,
        maxBytes: 65536,
        continuation: null,
      });
      assert(result.ok);
      assert.equal(
        result.value.evidence.archive?.generation,
        pin.publication.generation,
      );
      assert.equal(
        result.value.evidence.archive?.manifestSha256,
        pin.publication.manifestSha256,
      );
    }
    await Promise.all(pins.map((pin) => pinned(pin.option)));
    return boundedDetail(
      { ...base, state: 'ready', gaps: [] },
      limits(current.options).responseBytes,
    );
  } catch {
    return boundedDetail(
      {
        ...base,
        state: 'unavailable',
        node: {
          id: nodeId,
          kind: 'gap',
          label: 'Selection unavailable',
          qualifiers: [...historical, 'access-or-integrity-not-verified'],
          anchors: [],
        },
        edges: [],
        metadata: {},
        gaps: [
          {
            id: nodeId,
            kind: 'selection-unavailable',
            subject: nodeId,
            detail: gapDetail('selection-unavailable'),
          },
        ],
      },
      limits(current.options).responseBytes,
    );
  }
}
export async function expandKnowledgeMap(
  options: DashboardKnowledgeOptions,
  nodeId: string,
): Promise<KnowledgeMapSnapshot> {
  const current = await selected(options, nodeId);
  return project(
    current.options,
    current.selection.catalogOffset !== undefined
      ? {
          publicationId: current.selection.publicationIds[0]!,
          offset: current.selection.catalogOffset,
        }
      : current.selection.graphAlias && current.selection.readNodeId
        ? {
            graphAlias: current.selection.graphAlias,
            recordId: current.selection.readNodeId,
          }
        : undefined,
  );
}
