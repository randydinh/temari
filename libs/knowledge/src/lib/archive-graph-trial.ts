/** One-hop, snapshot-pinned graph candidate trial; lexical ranking stays authoritative. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type {
  KnowledgeEvidence,
  KnowledgeGap,
  KnowledgeProvider,
  KnowledgeSource,
} from '@temari/contracts';
import {
  createArchiveGraphReader,
  type ArchiveGraphAnchor,
  type ArchiveGraphRecord,
} from './archive-graph.js';
import { canonical, hash } from './codec.js';
import { publishJson } from './durable.js';

export interface RankedArchiveDocument {
  readonly sourceId: string;
  readonly path: string;
  readonly sha256: string;
}
export interface ArchiveGraphTrial {
  readonly graphId: string;
  readonly status: 'complete' | 'gap';
  readonly policy: 'one-lexical-seed-one-hop-related-first-v1';
  readonly ranked: readonly RankedArchiveDocument[];
  readonly expectedRecallAtK: number;
  readonly added: readonly (RankedArchiveDocument & {
    readonly relationshipId: string;
    readonly predicate: string;
    readonly provenance: ArchiveGraphRecord['provenance'];
  })[];
  readonly verifiedEvidenceCount: number;
  readonly checkpointPath: string | null;
  readonly gaps: readonly KnowledgeGap[];
  readonly timingMs: number;
}

const policy = 'one-lexical-seed-one-hop-related-first-v1' as const;
const key = (sourceId: string, path: string): string =>
  canonical([sourceId, path]);
const identity = (item: RankedArchiveDocument): string =>
  key(item.sourceId, item.path);

/** This is an ablation, not default ranking or a semantic correctness claim. */
export async function evaluateArchiveGraphTrial(input: {
  readonly graphId: string;
  readonly publications: readonly string[];
  readonly scope: readonly KnowledgeSource[];
  readonly provider: KnowledgeProvider;
  readonly lexical: readonly RankedArchiveDocument[];
  readonly expected: readonly { sourceId: string; path: string }[];
  readonly topK: number;
  readonly taskDirectory: string;
}): Promise<ArchiveGraphTrial> {
  const started = performance.now();
  const gaps: KnowledgeGap[] = [];
  const added: (RankedArchiveDocument & {
    relationshipId: string;
    predicate: string;
    provenance: ArchiveGraphRecord['provenance'];
  })[] = [];
  const evidence: KnowledgeEvidence[] = [];
  const result = (
    status: ArchiveGraphTrial['status'],
    checkpointPath: string | null,
  ): ArchiveGraphTrial => {
    const ranked = input.lexical.length
      ? [input.lexical[0], ...added, ...input.lexical.slice(1)]
          .filter(
            (item, index, all) =>
              all.findIndex((other) => identity(other) === identity(item)) ===
              index,
          )
          .slice(0, input.topK)
      : [];
    const expected = new Set(
      input.expected.map((item) => key(item.sourceId, item.path)),
    );
    return {
      graphId: input.graphId,
      status,
      policy,
      ranked,
      expectedRecallAtK:
        ranked.filter((item) => expected.has(identity(item))).length /
        expected.size,
      added,
      verifiedEvidenceCount: evidence.length,
      checkpointPath,
      gaps,
      timingMs: Math.max(0, Math.round(performance.now() - started)),
    };
  };
  assert(input.topK >= 1 && input.topK <= 8);
  assert(input.expected.length > 0);
  if (!input.lexical.length || input.topK === 1) {
    gaps.push({
      kind: 'pending',
      subject: 'graph-trial',
      detail: 'A lexical seed and topK of at least two are required.',
    });
    return result('gap', null);
  }
  const reader = await createArchiveGraphReader({
    publications: input.publications,
    readScope: 'source-root',
  });
  const projection = await reader.projection(input.graphId, input.scope);
  if (!projection.ok) {
    gaps.push(projection.gap);
    return result('gap', null);
  }
  const records = new Map(
    projection.value.nodes.map((node) => [node.id, node.attributes]),
  );
  const connected = new Set(
    [...records.values()]
      .filter(
        (record) =>
          (record.kind === 'relationship' || record.kind === 'identity-link') &&
          record.lifecycle === 'active',
      )
      .flatMap((record) => [record.subject, record.object]),
  );
  const nodesFor = (candidate: RankedArchiveDocument): Set<string> =>
    new Set(
      [...records.values()]
        .filter(
          (record) =>
            (record.kind === 'entity' || record.kind === 'mention') &&
            connected.has(record.id) &&
            record.anchors?.some(
              (anchor: ArchiveGraphAnchor) =>
                anchor.source_id === candidate.sourceId &&
                anchor.path === candidate.path &&
                anchor.original_sha256 === candidate.sha256,
            ),
        )
        .map((record) => record.id),
    );
  const seed =
    input.lexical.find((candidate) => nodesFor(candidate).size > 0) ??
    input.lexical[0];
  const seedNodes = nodesFor(seed);
  const scopedIds = new Set(input.scope.map((source) => source.id));
  const seen = new Set(input.lexical.map(identity));
  for (const relation of [...records.values()].sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    if (
      (relation.kind !== 'relationship' && relation.kind !== 'identity-link') ||
      relation.lifecycle !== 'active'
    )
      continue;
    const opposite = seedNodes.has(relation.subject!)
      ? relation.object
      : relation.predicate !== 'links-to' && seedNodes.has(relation.object!)
        ? relation.subject
        : null;
    if (!opposite) continue;
    const target = records.get(opposite);
    if (!target || (target.kind !== 'entity' && target.kind !== 'mention'))
      continue;
    for (const anchor of target.anchors ?? []) {
      if (added.length >= input.topK - 1) break;
      if (!scopedIds.has(anchor.source_id)) continue;
      const candidate: RankedArchiveDocument = {
        sourceId: anchor.source_id,
        path: anchor.path,
        sha256: anchor.original_sha256,
      };
      if (seen.has(identity(candidate))) continue;
      seen.add(identity(candidate));
      const source = input.scope.find((item) => item.id === anchor.source_id)!;
      try {
        const read = await input.provider.read({
          document: { source, path: anchor.path },
          expectedSha256: anchor.original_sha256,
          maxCodePoints: 1000,
          maxBytes: 65536,
          continuation: null,
        });
        if (!read.ok) {
          gaps.push(read.gap);
          continue;
        }
        const item = read.value.evidence;
        if (
          item.sha256 !== anchor.original_sha256 ||
          canonical(item.document) !== canonical({ source, path: anchor.path })
        )
          throw new Error('Graph target does not match archived document');
        const check = await input.provider.revalidate(item);
        if (
          check.evidenceId !== item.id ||
          check.state !== 'unchanged' ||
          check.basis !== 'archive-snapshot'
        )
          throw new Error('Graph target archive check failed');
        evidence.push(item);
        added.push({
          ...candidate,
          relationshipId: relation.id,
          predicate: relation.predicate!,
          provenance: relation.provenance,
        });
      } catch {
        gaps.push({
          kind: 'unknown',
          subject: 'graph-trial',
          detail: 'A related archive target could not be verified.',
        });
      }
    }
    if (added.length >= input.topK - 1) break;
  }
  const checkpoint = {
    schema: 1,
    kind: 'temari-archive-graph-trial',
    graphId: input.graphId,
    provider: input.provider.identity,
    seed,
    added,
    evidence,
    gaps,
    policy,
    fullDocumentRead: false,
  };
  const checkpointPath = join(
    input.taskDirectory,
    `archive-graph-trial-${hash(canonical(checkpoint))}.json`,
  );
  await publishJson(checkpointPath, checkpoint);
  return result('complete', checkpointPath);
}
