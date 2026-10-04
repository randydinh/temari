import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute, normalize } from 'node:path';

const LIMIT = 1024 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA = /^[a-fA-F0-9]{40}$/;
const DIGEST = /^[a-fA-F0-9]{64}$/;

type Row = Record<string, unknown>;
export interface OpenWorkManifest {
  schema: 1;
  id: string;
  capturedAt: string;
  baseline: string;
  coverage: {
    chatScope: string;
    chatLimit: number;
    allChats: false;
    worktreeScope: string;
    unavailableHosts: string[];
    unavailableSources: string[];
    gaps: string[];
  };
  chats: {
    id: string;
    // Null retains identity when the captured source title is unavailable or inadmissible.
    title: string | null;
    kind: 'codex' | 'chatgpt';
    hostId: string | null;
    cwd: string | null;
    status: 'active' | 'idle' | 'notLoaded' | 'unknown';
    updatedAt: number | null;
    worktreeId: string | null;
  }[];
  worktrees: {
    id: string;
    root: string;
    exists: boolean;
    head: string | null;
    branch: string | null;
    clean: boolean | null;
    unresolvedPathCount: number | null;
    untrackedPathCount: number | null;
    commitsNotInMain: number | null;
    preservation: 'unverified';
  }[];
  sourceRefs: { kind: string; sha256: string }[];
}
function requireValue(ok: unknown): asserts ok {
  if (!ok) throw new Error('Invalid open-work manifest.');
}
function record(value: unknown, fields: string): Row {
  requireValue(
    value !== null && typeof value === 'object' && !Array.isArray(value),
  );
  const keys = fields.split(' ');
  requireValue(
    Object.keys(value).length === keys.length &&
      keys.every((key) => Object.hasOwn(value, key)),
  );
  return value as Row;
}
function string(value: unknown, max = 512): value is string {
  return (
    typeof value === 'string' && value.length <= max && !value.includes('\0')
  );
}
function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && pattern.test(value);
}
function path(value: unknown): value is string {
  return string(value, 4096) && isAbsolute(value);
}
function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
function nullable(value: unknown, check: (value: unknown) => boolean): boolean {
  return value === null || check(value);
}
function rows(value: unknown, max: number): unknown[] {
  requireValue(Array.isArray(value) && value.length <= max);
  return value;
}
function texts(value: unknown): void {
  for (const item of rows(value, LIMIT)) requireValue(string(item, 2048));
}

/** Strict admission only: sourceRefs are provenance, never files to open. */
export function validateOpenWorkManifest(value: unknown): OpenWorkManifest {
  const m = record(
    value,
    'schema id capturedAt baseline coverage chats worktrees sourceRefs',
  );
  requireValue(Buffer.byteLength(JSON.stringify(value)) <= LIMIT);
  requireValue(m.schema === 1 && matches(m.id, ID) && matches(m.baseline, SHA));
  requireValue(
    matches(
      m.capturedAt,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/,
    ),
  );
  const time = Date.parse(m.capturedAt);
  requireValue(
    Number.isFinite(time) &&
      new Date(time).toISOString().slice(0, 19) === m.capturedAt.slice(0, 19),
  );
  const coverage = record(
    m.coverage,
    'chatScope chatLimit allChats worktreeScope unavailableHosts unavailableSources gaps',
  );
  requireValue(
    string(coverage.chatScope, 2048) && string(coverage.worktreeScope, 2048),
  );
  requireValue(
    count(coverage.chatLimit) &&
      coverage.chatLimit >= 1 &&
      coverage.chatLimit <= 50 &&
      coverage.allChats === false,
  );
  texts(coverage.unavailableHosts);
  texts(coverage.unavailableSources);
  texts(coverage.gaps);
  const worktreeIds = new Set<string>();
  const worktreeRoots = new Map<string, string>();
  const roots = new Set<string>();
  for (const value of rows(m.worktrees, 200)) {
    const w = record(
      value,
      'id root exists head branch clean unresolvedPathCount untrackedPathCount commitsNotInMain preservation',
    );
    requireValue(matches(w.id, ID) && !worktreeIds.has(w.id));
    requireValue(path(w.root) && !roots.has(normalize(w.root)));
    worktreeIds.add(w.id);
    worktreeRoots.set(w.id, w.root);
    roots.add(normalize(w.root));
    requireValue(
      typeof w.exists === 'boolean' && w.preservation === 'unverified',
    );
    requireValue(
      nullable(w.head, (v) => matches(v, SHA)) &&
        nullable(w.branch, (v) => string(v)) &&
        nullable(w.clean, (v) => typeof v === 'boolean'),
    );
    for (const key of [
      'unresolvedPathCount',
      'untrackedPathCount',
      'commitsNotInMain',
    ])
      requireValue(nullable(w[key], count));
    if (!w.exists)
      requireValue(
        ['head', 'clean', 'unresolvedPathCount', 'untrackedPathCount', 'commitsNotInMain'].every(
          (key) => w[key] === null,
        ),
      );
    if (w.clean === true)
      requireValue(
        w.unresolvedPathCount === 0 && w.untrackedPathCount === 0,
      );
  }
  const chatIds = new Set<string>();
  for (const value of rows(m.chats, 1000)) {
    const c = record(
      value,
      'id title kind hostId cwd status updatedAt worktreeId',
    );
    requireValue(matches(c.id, ID) && !chatIds.has(c.id));
    chatIds.add(c.id);
    requireValue(
      nullable(c.title, (v) => string(v)) &&
        ['codex', 'chatgpt'].includes(c.kind as string),
    );
    requireValue(nullable(c.hostId, (v) => string(v)) && nullable(c.cwd, path));
    requireValue(
      ['active', 'idle', 'notLoaded', 'unknown'].includes(c.status as string),
    );
    requireValue(nullable(c.updatedAt, count));
    requireValue(
      c.worktreeId === null ||
        (matches(c.worktreeId, ID) &&
          worktreeIds.has(c.worktreeId) &&
          c.hostId === 'local' &&
          c.cwd === worktreeRoots.get(c.worktreeId)),
    );
  }
  for (const value of rows(m.sourceRefs, 32)) {
    const ref = record(value, 'kind sha256');
    requireValue(string(ref.kind) && matches(ref.sha256, DIGEST));
  }
  return value as OpenWorkManifest;
}

export function emptyOpenWork(configured = false) {
  return {
    schema: 1 as const,
    configured,
    state: configured ? ('unavailable' as const) : ('not-configured' as const),
    readOnly: true as const,
    currentWriterState: 'not-checked' as const,
    closureEligibility: 'not-assessed' as const,
    capture: null,
    baseline: null,
    coverage: null,
    chats: [],
    worktrees: [],
    sourceRefs: [],
    gaps: [
      configured
        ? 'The pinned capture is unavailable or invalid.'
        : 'No open-work capture is configured.',
    ],
  };
}

export function createOpenWorkReader(options: {
  manifestPath: string;
  sha256: string;
  now?: () => number;
}) {
  if (!path(options.manifestPath))
    throw new Error(
      '--open-work-manifest requires an absolute path of at most 4096 characters.',
    );
  if (!matches(options.sha256, DIGEST))
    throw new Error('--open-work-sha256 requires a 64hex digest.');
  const manifestPath = options.manifestPath;
  const sha256 = options.sha256.toLowerCase();
  const now = options.now ?? Date.now;
  return {
    async describe() {
      try {
        // No symlinks, devices or FIFOs; bound reads even if a file grows after stat.
        const file = await open(
          manifestPath,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        let bytes: Buffer;
        try {
          const info = await file.stat();
          if (!info.isFile() || info.size > LIMIT)
            throw new Error('Invalid capture file.');
          const buffer = Buffer.alloc(LIMIT + 1);
          let length = 0;
          while (length < buffer.length) {
            const result = await file.read(
              buffer,
              length,
              buffer.length - length,
              null,
            );
            if (!result.bytesRead) break;
            length += result.bytesRead;
          }
          if (length > LIMIT) throw new Error('Capture too large.');
          bytes = buffer.subarray(0, length);
        } finally {
          await file.close();
        }
        if (createHash('sha256').update(bytes).digest('hex') !== sha256)
          return {
            ...emptyOpenWork(true),
            gaps: ['The saved capture changed and no longer matches its approved digest.'],
          };
        let manifest: OpenWorkManifest;
        try {
          manifest = validateOpenWorkManifest(
            JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
          );
        } catch {
          return {
            ...emptyOpenWork(true),
            gaps: ['The approved capture has invalid JSON, encoding or inventory fields.'],
          };
        }
        const assessed = now();
        const ageMs = assessed - Date.parse(manifest.capturedAt);
        return {
          ...emptyOpenWork(true),
          state: 'available' as const,
          capture: {
            id: manifest.id,
            sha256,
            capturedAt: manifest.capturedAt,
            assessedAt: new Date(assessed).toISOString(),
            ageMs,
            freshness:
              ageMs < 0
                ? ('future' as const)
                : ageMs > 15 * 60 * 1000
                  ? ('stale' as const)
                  : ('fresh' as const),
          },
          baseline: manifest.baseline,
          coverage: manifest.coverage,
          chats: manifest.chats,
          worktrees: manifest.worktrees,
          sourceRefs: manifest.sourceRefs,
          gaps: manifest.coverage.gaps,
        };
      } catch {
        return emptyOpenWork(true);
      }
    },
  };
}
