import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { TextDecoder } from 'node:util';
import { canonical, hash } from './codec.js';

const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
const MAX_GRAPH_BYTES = 1024 * 1024;
const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;

export interface ArchiveRecoveryDependencyPlan {
  archivePackagePath: string;
  graphPackagePaths: string[];
}

export interface ArchiveRecoveryDependencyReceipt {
  schema: 1;
  kind: 'archive-recovery-dependency-plan';
  status: 'dependency-closed';
  payloadIntegrity: 'not-validated';
  admission: 'not-checked';
  atomicity: 'none';
  archive: {
    sha256: string;
    bytes: number;
    selections: Array<{
      sourceId: string;
      generation: string;
      manifestSha256: string;
    }>;
  };
  graphs: Array<{
    sha256: string;
    bytes: number;
    graphId: string;
    revisionSetId: string;
    parentGraphId: string | null;
  }>;
  importOrder: Array<{ kind: 'archive' | 'graph'; sha256: string }>;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Invalid ${label} declaration`);
  return value as Record<string, unknown>;
}

function hex(value: unknown, width: 32 | 64, label: string): string {
  if (typeof value !== 'string' || !(width === 32 ? HEX32 : HEX64).test(value))
    throw new Error(`Invalid ${label} declaration`);
  return value;
}

function selection(value: unknown) {
  const item = object(value, 'archive selection');
  return {
    sourceId: hex(item['source_id'], 32, 'source ID'),
    generation: hex(item['generation'], 32, 'generation'),
    manifestSha256: hex(item['manifest_sha256'], 64, 'manifest hash'),
  };
}

function selectionKey(item: ReturnType<typeof selection>): string {
  return `${item.sourceId}:${item.generation}:${item.manifestSha256}`;
}

async function packageJson(path: string, maxBytes: number) {
  if (typeof path !== 'string' || !path || constants.O_NOFOLLOW === undefined)
    throw new Error('Recovery package path is not admitted');
  let handle;
  try {
    // O_NOFOLLOW protects the final file component; ancestor symlinks are not excluded.
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > maxBytes)
      throw new Error('Recovery package is not a bounded regular file');
    const raw = Buffer.allocUnsafe(maxBytes + 1);
    let length = 0;
    while (length <= maxBytes) {
      const result = await handle.read(
        raw,
        length,
        maxBytes + 1 - length,
        null,
      );
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const after = await handle.stat();
    if (
      length > maxBytes ||
      length !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error('Recovery package changed or exceeded its byte bound');
    const bytes = raw.subarray(0, length);
    const payload = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    ) as unknown;
    return { payload, bytes: length, sha256: hash(bytes) };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Recovery package'))
      throw error;
    throw new Error('Recovery package is unreadable or malformed');
  } finally {
    await handle?.close();
  }
}

/** Plan declared package dependencies only. Registrar performs import validation. */
export async function planArchiveRecoveryDependencies(
  request: ArchiveRecoveryDependencyPlan,
): Promise<ArchiveRecoveryDependencyReceipt> {
  if (
    !request ||
    typeof request.archivePackagePath !== 'string' ||
    !Array.isArray(request.graphPackagePaths) ||
    request.graphPackagePaths.length < 1 ||
    request.graphPackagePaths.length > 4 ||
    request.graphPackagePaths.some((path) => typeof path !== 'string')
  )
    throw new Error(
      'Recovery package selection requires one archive and 1–4 graphs',
    );
  const archiveFile = await packageJson(
    request.archivePackagePath,
    MAX_ARCHIVE_BYTES,
  );
  const archive = object(archiveFile.payload, 'archive package');
  if (
    archive['schema'] !== 1 ||
    archive['kind'] !== 'registrar-archive-only' ||
    archive['blobs'] === null ||
    typeof archive['blobs'] !== 'object' ||
    Array.isArray(archive['blobs']) ||
    !Array.isArray(archive['generations']) ||
    archive['generations'].length < 1 ||
    archive['generations'].length > 100
  )
    throw new Error('Unsupported archive package declaration');
  const archiveSelections = archive['generations'].map((value) => {
    const envelope = object(value, 'archive envelope');
    if (Object.keys(envelope).sort().join(',') !== 'manifest,manifest_sha256')
      throw new Error('Invalid archive envelope declaration');
    const manifest = object(envelope['manifest'], 'archive manifest');
    const selected = selection({
      source_id: manifest['source_id'],
      generation: manifest['generation'],
      manifest_sha256: envelope['manifest_sha256'],
    });
    if (hash(canonical(manifest)) !== selected.manifestSha256)
      throw new Error('Archive manifest declaration pin mismatch');
    return selected;
  });
  const available = new Set(archiveSelections.map(selectionKey));
  const generationIds = new Set(
    archiveSelections.map((item) => item.generation),
  );
  const sourceGenerations = new Set(
    archiveSelections.map((item) => `${item.sourceId}:${item.generation}`),
  );
  if (
    available.size !== archiveSelections.length ||
    sourceGenerations.size !== archiveSelections.length ||
    generationIds.size !== archiveSelections.length
  )
    throw new Error('Duplicate archive generation declaration');

  const graphFiles = await Promise.all(
    request.graphPackagePaths.map((path) => packageJson(path, MAX_GRAPH_BYTES)),
  );
  const graphs = graphFiles.map((file) => {
    const envelope = object(file.payload, 'OKF package');
    const graph = object(envelope['graph'], 'graph');
    const revisionSet = object(graph['revision_set'], 'RevisionSet');
    if (
      envelope['schema'] !== 1 ||
      envelope['format'] !== 'OKF' ||
      envelope['profile'] !== 'registrar.archived-graph' ||
      envelope['profile_version'] !== 1 ||
      envelope['version'] !== '0.2' ||
      envelope['files'] === null ||
      typeof envelope['files'] !== 'object' ||
      Array.isArray(envelope['files']) ||
      graph['schema'] !== 1 ||
      !Object.hasOwn(graph, 'parent') ||
      revisionSet['schema'] !== 1 ||
      !Array.isArray(revisionSet['selections']) ||
      revisionSet['selections'].length < 1 ||
      revisionSet['selections'].length > 100
    )
      throw new Error('Unsupported graph package declaration');
    const selectors = revisionSet['selections'].map(selection);
    if (
      new Set(selectors.map((item) => item.sourceId)).size !==
        selectors.length ||
      selectors.some((item) => !available.has(selectionKey(item)))
    )
      throw new Error(
        'Graph RevisionSet is outside included archive declarations',
      );
    const parentGraphId =
      graph['parent'] === null
        ? null
        : hex(graph['parent'], 64, 'parent graph hash');
    return {
      sha256: file.sha256,
      bytes: file.bytes,
      graphId: hex(envelope['graph_id'], 64, 'graph hash'),
      revisionSetId: hex(envelope['revision_set_id'], 64, 'RevisionSet hash'),
      parentGraphId,
      graphPayload: graph,
      revisionSetPayload: revisionSet,
    };
  });
  const byId = new Map(graphs.map((graph) => [graph.graphId, graph]));
  if (byId.size !== graphs.length)
    throw new Error('Duplicate graph ID declaration');
  if (graphs.filter((graph) => graph.parentGraphId === null).length !== 1)
    throw new Error('Recovery dependency plan requires exactly one root');
  for (const graph of graphs)
    if (graph.parentGraphId !== null && !byId.has(graph.parentGraphId))
      throw new Error('Orphan graph parent declaration');
  const ordered: typeof graphs = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(graph: (typeof graphs)[number]) {
    if (visited.has(graph.graphId)) return;
    if (visiting.has(graph.graphId))
      throw new Error('Cyclic graph parent declaration');
    visiting.add(graph.graphId);
    if (graph.parentGraphId !== null) visit(byId.get(graph.parentGraphId)!);
    visiting.delete(graph.graphId);
    visited.add(graph.graphId);
    ordered.push(graph);
  }
  for (const graph of [...graphs].sort((a, b) =>
    a.graphId.localeCompare(b.graphId),
  ))
    visit(graph);
  for (const graph of ordered)
    if (
      hash(canonical(graph.graphPayload)) !== graph.graphId ||
      hash(canonical(graph.revisionSetPayload)) !== graph.revisionSetId
    )
      throw new Error('Graph declaration identity mismatch');
  const orderedMetadata = ordered.map(
    ({ sha256, bytes, graphId, revisionSetId, parentGraphId }) => ({
      sha256,
      bytes,
      graphId,
      revisionSetId,
      parentGraphId,
    }),
  );
  return {
    schema: 1,
    kind: 'archive-recovery-dependency-plan',
    status: 'dependency-closed',
    payloadIntegrity: 'not-validated',
    admission: 'not-checked',
    atomicity: 'none',
    archive: {
      sha256: archiveFile.sha256,
      bytes: archiveFile.bytes,
      selections: archiveSelections.sort((a, b) =>
        selectionKey(a).localeCompare(selectionKey(b)),
      ),
    },
    graphs: orderedMetadata,
    importOrder: [
      { kind: 'archive', sha256: archiveFile.sha256 },
      ...orderedMetadata.map((graph) => ({
        kind: 'graph' as const,
        sha256: graph.sha256,
      })),
    ],
  };
}
