import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  InvestigationTask,
  KnowledgeGap,
  KnowledgeSource,
} from '@temari/contracts';
import {
  canonical,
  digest,
  hash,
  integer,
  knowledgeGap,
  list,
  object,
  source,
  text,
} from './codec.js';
import {
  archiveTransport,
  type ArchiveTransportOptions,
} from './archive-transport.js';
import { publishJson, readJson, readJsonWithBytes } from './durable.js';

export interface ArchiveIntakeOptions {
  readonly task: InvestigationTask;
  readonly source: KnowledgeSource;
  readonly readScope: 'source-root';
  readonly transport: ArchiveTransportOptions;
  readonly requestKey: string;
  readonly limits?: {
    readonly entries?: number;
    readonly file_bytes?: number;
    readonly total_bytes?: number;
    readonly text_bytes?: number;
  };
}
export interface ArchivePublication {
  readonly schema: 1;
  readonly kind: 'temari-archive-publication';
  readonly task: InvestigationTask;
  readonly source: KnowledgeSource;
  readonly readScope: 'source-root';
  readonly transport: Required<ArchiveTransportOptions>;
  readonly implementation: string;
  readonly protocolSha256: string;
  readonly registration: string;
  readonly binding: string;
  readonly generation: string;
  readonly manifestSha256: string;
  readonly captureRequestKey: string;
  readonly captureFingerprint: string;
  readonly preservation: 'complete-admitted' | 'incomplete';
  readonly counts: Record<string, number>;
  readonly capabilities: Record<string, unknown>;
  readonly gaps: readonly KnowledgeGap[];
  readonly currentOriginal: 'not-checked';
  /** An operator-verified upgrade of the same retained capture, never a recapture. */
  readonly rebind?: {
    readonly priorPublicationPath: string;
    readonly priorPublicationSha256: string;
    readonly priorBinding: string;
    readonly auditPath: string;
  };
}
export function generation(value: unknown): string {
  const result = text(value);
  assert(/^[a-f0-9]{32}$/.test(result), 'Invalid archive generation');
  return result;
}
export function historical(r: Record<string, unknown>): void {
  assert.equal(r['evidence'], 'archived-snapshot');
  assert.equal(r['current_original'], 'not-checked');
}
export function snapshot(
  r: Record<string, unknown>,
  p: Pick<ArchivePublication, 'source' | 'generation' | 'manifestSha256'>,
): void {
  assert.equal(r['source_id'], p.source.id);
  assert.equal(generation(r['generation']), p.generation);
  assert.equal(digest(r['manifest_sha256']), p.manifestSha256);
  historical(r);
  assert.equal(r['integrity'], 'verified');
}
export async function registrationFor(
  transport: Awaited<ReturnType<typeof archiveTransport>>,
  selected: KnowledgeSource,
): Promise<string> {
  source(selected);
  const rows = list((await transport.invoke('list', []))['sources']).map(
    object,
  );
  const row = rows.find((r) => r['id'] === selected.id);
  assert(row, 'Admitted registration unavailable');
  assert.equal(row['enabled'], true, 'Admitted source disabled');
  assert.equal(
    pathToFileURL(text(row['root'])).href,
    selected.locator,
    'Admitted source locator mismatch',
  );
  assert(
    !['testmo', 'shortcut', 'notion'].includes(String(row['kind'])),
    'Local registration required',
  );
  assert(typeof row['recursive'] === 'boolean');
  return canonical({
    source: selected,
    root: row['root'],
    kind: row['kind'] ?? 'local',
    recursive: row['recursive'],
    exclude: list(row['exclude']).map(text),
    enabled: true,
  });
}
export function omission(reason: unknown, subject: string): KnowledgeGap {
  const detail = text(reason);
  assert(detail.length <= 512);
  return { kind: 'unsupported', subject, detail };
}
export function validatePublication(
  value: unknown,
): asserts value is ArchivePublication {
  const p = object(value);
  assert.equal(p['schema'], 1);
  assert.equal(p['kind'], 'temari-archive-publication');
  assert.equal(p['readScope'], 'source-root');
  source(p['source']);
  generation(p['generation']);
  for (const k of [
    'implementation',
    'protocolSha256',
    'manifestSha256',
    'captureFingerprint',
    'binding',
  ])
    digest(p[k]);
  assert(/^temari-archive-v1:[a-f0-9]{64}$/.test(text(p['captureRequestKey'])));
  assert.equal(p['currentOriginal'], 'not-checked');
  assert(['complete-admitted', 'incomplete'].includes(text(p['preservation'])));
  text(p['registration']);
  object(p['capabilities']);
  for (const n of Object.values(object(p['counts']))) integer(n, 0, 1000);
  const t = object(p['task']);
  text(t['id']);
  text(t['authorityRef']);
  text(t['directory']);
  const c = object(p['transport']);
  for (const k of ['python', 'registrarSource', 'workspace']) text(c[k]);
  integer(c['timeoutMs'], 1, 60000);
  integer(c['maxStdoutBytes'], 1024, 1_048_576);
  assert(list(p['gaps']).length <= 64);
  list(p['gaps']).forEach(knowledgeGap);
  if (p['rebind'] !== undefined) {
    const rebind = object(p['rebind']);
    for (const key of ['priorPublicationPath', 'auditPath'])
      assert(isAbsolute(text(rebind[key])));
    digest(rebind['priorPublicationSha256']);
    digest(rebind['priorBinding']);
  }
  assert(
    Buffer.byteLength(canonical(value)) <= 65536,
    'Publication exceeds bound',
  );
}
export async function loadArchivePublication(
  path: string,
): Promise<ArchivePublication> {
  return loadArchivePublicationChain(path, new Set<string>());
}
async function loadArchivePublicationChain(
  path: string,
  seen: Set<string>,
  loaded?: Awaited<ReturnType<typeof readJsonWithBytes>>,
): Promise<ArchivePublication> {
  assert(seen.size < 16 && !seen.has(path), 'Invalid publication ancestry');
  seen.add(path);
  const { value } = loaded ?? await readJsonWithBytes(path);
  validatePublication(value);
  assert.equal(dirname(path), value.task.directory);
  assert.equal(basename(path), `archive-publication-${value.binding}.json`);
  if (value.rebind) {
    const { priorPublicationPath, priorPublicationSha256, priorBinding, auditPath } = value.rebind;
    assert.equal(auditPath, join(value.task.directory, `archive-rebind-${value.binding}.json`));
    const audit = object(await readJson(auditPath));
    assert.equal(audit['schema'], 1);
    assert.equal(audit['kind'], 'temari-archive-rebind');
    assert.equal(audit['publicationSha256'], hash(canonical(value)), 'Rebound publication changed');
    assert.equal(audit['binding'], value.binding);
    assert.equal(audit['priorPublicationPath'], priorPublicationPath);
    assert.equal(audit['priorPublicationSha256'], priorPublicationSha256);
    assert.equal(audit['priorBinding'], priorBinding);
    const priorBytes = await readJsonWithBytes(priorPublicationPath);
    assert.equal(hash(priorBytes.bytes), priorPublicationSha256,
      'Earlier publication changed');
    const prior = await loadArchivePublicationChain(priorPublicationPath, seen, priorBytes);
    assert.equal(prior.binding, priorBinding);
    for (const key of ['task', 'source', 'readScope', 'generation', 'manifestSha256',
      'captureRequestKey', 'captureFingerprint', 'preservation', 'counts', 'currentOriginal']) {
      const nextFields = value as unknown as Record<string, unknown>;
      const priorFields = prior as unknown as Record<string, unknown>;
      assert.equal(canonical(nextFields[key]), canonical(priorFields[key]),
        `Rebound ${key} changed`);
    }
    for (const key of ['task', 'source', 'readScope', 'generation', 'manifestSha256',
      'captureRequestKey', 'captureFingerprint', 'preservation', 'counts',
      'registration', 'implementation', 'protocolSha256']) {
      const fields = value as unknown as Record<string, unknown>;
      assert.equal(canonical(audit[key]), canonical(fields[key]),
        `Rebind audit ${key} changed`);
    }
    assert.equal(audit['priorImplementation'], prior.implementation);
    assert.equal(audit['priorProtocolSha256'], prior.protocolSha256);
    assert.equal(audit['currentOriginal'], 'not-checked');
  }
  return value;
}

export interface ArchiveRebindOptions {
  readonly priorPublicationPath: string;
  readonly transport: ArchiveTransportOptions;
}

/**
 * Operator-only upgrade for a retained generation after the Registrar or Temari
 * archive implementation changes. The old publication remains immutable and the
 * new reader identity is issued only after the new runtime verifies the old pin.
 */
export async function rebindArchivePublication(
  options: ArchiveRebindOptions,
): Promise<{ publicationPath: string; auditPath: string }> {
  const o = JSON.parse(canonical(options)) as ArchiveRebindOptions;
  const ancestry = new Set<string>();
  const priorArtifact = await readJsonWithBytes(o.priorPublicationPath);
  const prior = await loadArchivePublicationChain(o.priorPublicationPath, ancestry, priorArtifact);
  assert(ancestry.size < 16, 'Rebind ancestry limit');
  const priorPublicationSha256 = hash(priorArtifact.bytes);
  if (!prior.rebind) {
    const oldBinding = object(
      await readJson(join(prior.task.directory, `archive-binding-${prior.binding}.json`)),
    );
    // The binding was durably written before the original capture. A publication
    // edited after that point must never become an upgrade authority.
    assert.equal(oldBinding['schema'], 1);
    const priorFields = prior as unknown as Record<string, unknown>;
    for (const key of ['task', 'source', 'readScope', 'transport', 'implementation',
      'protocolSha256', 'registration', 'captureRequestKey'])
      assert.equal(canonical(oldBinding[key]), canonical(priorFields[key]));
    assert.equal(
      hash(prior.captureRequestKey),
      prior.binding,
      'Prior capture binding mismatch',
    );
  }
  const transport = await archiveTransport(o.transport);
  const registration = await registrationFor(transport, prior.source);
  assert.equal(registration, prior.registration, 'Source admission changed');
  const pin = {
    source: prior.source,
    generation: prior.generation,
    manifestSha256: prior.manifestSha256,
  };
  let offset = 0;
  let capabilities: Record<string, unknown> | null = null;
  const gaps: KnowledgeGap[] = [];
  do {
    const inspected = await transport.invoke('inspect', [
      prior.source.id,
      prior.generation,
      '--manifest-sha256',
      prior.manifestSha256,
      '--offset',
      String(offset),
      '--limit',
      '100',
      '--max-bytes',
      '1048576',
    ]);
    snapshot(inspected, pin);
    assert.equal(inspected['request_key'], prior.captureRequestKey);
    assert.equal(
      digest(inspected['request_fingerprint']),
      prior.captureFingerprint,
      'Capture fingerprint changed',
    );
    assert.equal(inspected['preservation'], prior.preservation);
    assert.equal(canonical(inspected['counts']), canonical(prior.counts));
    const inspectedCapabilities = object(inspected['capabilities']);
    assert(Buffer.byteLength(canonical(inspectedCapabilities)) <= 8192);
    if (capabilities !== null)
      assert.equal(canonical(inspectedCapabilities), canonical(capabilities));
    capabilities = inspectedCapabilities;
    for (const [key, value] of Object.entries(prior.capabilities)) {
      if (key !== 'retrieval')
        assert.equal(
          canonical(inspectedCapabilities[key]),
          canonical(value),
          `Archived capability ${key} changed`,
        );
    }
    for (const raw of list(inspected['documents'])) {
      const document = object(raw);
      for (const reason of list(document['gaps'])) {
        const gap = omission(reason, prior.source.id);
        if (!gaps.some((item) => canonical(item) === canonical(gap)))
          gaps.push(gap);
      }
      if (
        document['status'] === 'unavailable' &&
        !gaps.some((item) => item.kind === 'unavailable')
      )
        gaps.push({
          kind: 'unavailable',
          subject: prior.source.id,
          detail: 'Original preservation incomplete',
        });
    }
    assert(gaps.length <= 64, 'Capability receipt exceeds bound');
    if (inspected['next_offset'] === null) break;
    offset = integer(inspected['next_offset'], offset + 1, 1000);
  } while (true);
  assert(capabilities !== null);
  if (
    prior.preservation === 'incomplete' &&
    !gaps.some((item) => item.kind === 'unavailable')
  )
    gaps.push({
      kind: 'unavailable',
      subject: prior.source.id,
      detail: 'Original preservation incomplete',
    });
  assert.equal(canonical(gaps), canonical(prior.gaps), 'Capture gaps changed');

  const binding = hash(canonical({
    schema: 1,
    operation: 'archive-rebind',
    priorPublicationSha256,
    priorBinding: prior.binding,
    transport: transport.config,
    implementation: transport.implementation,
    protocolSha256: transport.protocolSha256,
    registration,
    pin,
  }));
  const auditPath = join(prior.task.directory, `archive-rebind-${binding}.json`);
  const publicationPath = join(
    prior.task.directory,
    `archive-publication-${binding}.json`,
  );
  const audit = {
    schema: 1,
    kind: 'temari-archive-rebind',
    priorPublicationPath: o.priorPublicationPath,
    priorPublicationSha256,
    priorBinding: prior.binding,
    binding,
    source: prior.source,
    generation: prior.generation,
    manifestSha256: prior.manifestSha256,
    captureRequestKey: prior.captureRequestKey,
    captureFingerprint: prior.captureFingerprint,
    counts: prior.counts,
    registration,
    priorImplementation: prior.implementation,
    priorProtocolSha256: prior.protocolSha256,
    implementation: transport.implementation,
    protocolSha256: transport.protocolSha256,
    currentOriginal: 'not-checked',
  };
  const publication: ArchivePublication = {
    ...prior,
    transport: transport.config,
    implementation: transport.implementation,
    protocolSha256: transport.protocolSha256,
    registration,
    binding,
    capabilities,
    gaps,
    rebind: {
      priorPublicationPath: o.priorPublicationPath,
      priorPublicationSha256,
      priorBinding: prior.binding,
      auditPath,
    },
  };
  validatePublication(publication);
  await publishJson(auditPath, {
    ...audit,
    task: publication.task,
    readScope: publication.readScope,
    preservation: publication.preservation,
    publicationSha256: hash(canonical(publication)),
  });
  await publishJson(publicationPath, publication);
  return { publicationPath, auditPath };
}
export class ArchivePersistenceError extends Error {
  constructor(
    readonly attemptPath: string,
    cause: unknown,
  ) {
    super(
      'Archive intake persistence failed; capture may have committed. Replay the same request key.',
      { cause },
    );
  }
}
export interface ArchiveIntakeOutcome {
  readonly status: 'published' | 'blocked';
  readonly publicationPath: string | null;
  readonly preservation: ArchivePublication['preservation'] | null;
  readonly gaps: readonly KnowledgeGap[];
  readonly attemptPath: string;
  readonly resultPath: string;
}
/** Operator-only. Does not register, refresh, or copy any source bytes into Temari. */
export async function captureArchive(
  options: ArchiveIntakeOptions,
): Promise<ArchiveIntakeOutcome> {
  // Copy caller input so an asynchronous caller cannot change admission mid-capture.
  const o = JSON.parse(canonical(options)) as ArchiveIntakeOptions;
  text(o.task.id);
  text(o.task.authorityRef);
  source(o.source);
  assert.equal(o.readScope, 'source-root');
  assert(/^[A-Za-z0-9_.:-]{1,128}$/.test(o.requestKey));
  const attempt = randomUUID(),
    attemptPath = join(o.task.directory, `archive-attempt-${attempt}.json`),
    resultPath = join(o.task.directory, `archive-result-${attempt}.json`);
  await publishJson(attemptPath, {
    schema: 1,
    kind: 'temari-archive-attempt',
    options: o,
    state: 'started',
  });
  let publicationPath: string | null = null;
  try {
    const transport = await archiveTransport(o.transport);
    const limits = {
      entries: 1000,
      file_bytes: 8 * 1024 * 1024,
      total_bytes: 64 * 1024 * 1024,
      text_bytes: 8 * 1024 * 1024,
      ...o.limits,
    };
    assert(Object.keys(limits).length === 4);
    for (const [key, max] of Object.entries({
      entries: 1000,
      file_bytes: 8 * 1024 * 1024,
      total_bytes: 64 * 1024 * 1024,
      text_bytes: 8 * 1024 * 1024,
    }))
      integer(limits[key as keyof typeof limits], 1, max);
    const captureRequestKey = `temari-archive-v1:${hash(canonical({ task: o.task, key: o.requestKey }))}`;
    // Key is task-scoped locally; changing the selected source under that key collides.
    const bindingId = hash(captureRequestKey);
    const registration = await registrationFor(transport, o.source);
    const binding = {
      schema: 1,
      task: o.task,
      source: o.source,
      readScope: o.readScope,
      limits,
      captureRequestKey,
      transport: transport.config,
      implementation: transport.implementation,
      protocolSha256: transport.protocolSha256,
      registration,
    };
    await publishJson(
      join(o.task.directory, `archive-binding-${bindingId}.json`),
      binding,
    );
    const r = await transport.invoke('capture', [
      o.source.id,
      '--request-key',
      captureRequestKey,
      '--limits',
      canonical(limits),
    ]);
    assert.equal(r['status'], 'complete');
    assert.equal(r['source_id'], o.source.id);
    assert.equal(r['request_key'], captureRequestKey);
    assert(typeof r['replayed'] === 'boolean');
    historical(r);
    const pin = {
      source: o.source,
      generation: generation(r['generation']),
      manifestSha256: digest(r['manifest_sha256']),
    };
    const gaps: KnowledgeGap[] = [];
    let capabilities: Record<string, unknown> = {},
      offset = 0;
    do {
      const inspected = await transport.invoke('inspect', [
        o.source.id,
        pin.generation,
        '--manifest-sha256',
        pin.manifestSha256,
        '--offset',
        String(offset),
        '--limit',
        '100',
        '--max-bytes',
        '1048576',
      ]);
      snapshot(inspected, pin);
      assert.equal(inspected['request_key'], captureRequestKey);
      assert.equal(inspected['request_fingerprint'], r['request_fingerprint']);
      assert.equal(inspected['preservation'], r['preservation']);
      assert.equal(canonical(inspected['counts']), canonical(r['counts']));
      const rawCapabilities = object(inspected['capabilities']);
      capabilities = {};
      for (const [key, expected] of Object.entries({
        retrieval: 'exact-lexical',
        visual: 'unsupported',
        ocr: 'unsupported',
        asset_inventory: 'partial-or-unknown',
        structural_navigation: 'unsupported',
      })) {
        assert.equal(
          rawCapabilities[key],
          expected,
          'Unsupported archive capability contract',
        );
        capabilities[key] = expected;
      }
      for (const raw of list(inspected['documents'])) {
        const d = object(raw);
        for (const reason of list(d['gaps'])) {
          const gap = omission(reason, o.source.id);
          if (!gaps.some((g) => canonical(g) === canonical(gap)))
            gaps.push(gap);
        }
        if (
          d['status'] === 'unavailable' &&
          !gaps.some((g) => g.kind === 'unavailable')
        )
          gaps.push({
            kind: 'unavailable',
            subject: o.source.id,
            detail: 'Original preservation incomplete',
          });
      }
      assert(gaps.length <= 64, 'Capability receipt exceeds bound');
      if (inspected['next_offset'] === null) break;
      offset = integer(inspected['next_offset'], offset + 1, 1000);
    } while (true);
    const p: ArchivePublication = {
      schema: 1,
      kind: 'temari-archive-publication',
      task: o.task,
      readScope: o.readScope,
      transport: transport.config,
      implementation: transport.implementation,
      protocolSha256: transport.protocolSha256,
      registration,
      binding: bindingId,
      ...pin,
      captureRequestKey,
      captureFingerprint: digest(r['request_fingerprint']),
      preservation: r['preservation'] as ArchivePublication['preservation'],
      counts: object(r['counts']) as Record<string, number>,
      capabilities,
      gaps,
      currentOriginal: 'not-checked',
    };
    if (
      p.preservation === 'incomplete' &&
      !gaps.some((g) => g.kind === 'unavailable')
    )
      gaps.push({
        kind: 'unavailable',
        subject: o.source.id,
        detail: 'Original preservation incomplete',
      });
    validatePublication(p);
    publicationPath = join(
      o.task.directory,
      `archive-publication-${bindingId}.json`,
    );
    await publishJson(publicationPath, p);
    const outcome: ArchiveIntakeOutcome = {
      status: 'published',
      publicationPath,
      preservation: p.preservation,
      gaps,
      attemptPath,
      resultPath,
    };
    await publishJson(resultPath, outcome);
    return outcome;
  } catch (error) {
    const outcome: ArchiveIntakeOutcome = {
      status: 'blocked',
      publicationPath: null,
      preservation: null,
      gaps: [
        {
          kind: 'unknown',
          subject: 'archive-intake',
          detail:
            'Capture or immutable publication refused; replay requires identical admission, key and settings.',
        },
      ],
      attemptPath,
      resultPath,
    };
    try {
      await publishJson(resultPath, {
        ...outcome,
        error: String(error).slice(0, 2048),
      });
    } catch (cause) {
      throw new ArchivePersistenceError(attemptPath, cause);
    }
    if (
      publicationPath !== null ||
      [
        'EACCES',
        'EPERM',
        'EIO',
        'ENOSPC',
        'EROFS',
        'EMFILE',
        'ENFILE',
        'ENOENT',
        'ENOTDIR',
        'ELOOP',
      ].includes((error as NodeJS.ErrnoException).code ?? '')
    )
      throw new ArchivePersistenceError(attemptPath, error);
    return outcome;
  }
}
