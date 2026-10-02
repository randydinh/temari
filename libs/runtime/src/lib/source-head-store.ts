/** Append-only CAS for generations managed inside one trusted ledger root.
 * This is not Registrar's global source head or an independent admission oracle.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  unlink,
} from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

const SHA = /^[a-f0-9]{64}$/;
const SOURCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_CHAIN = 64;
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_ARTIFACT_BYTES = 1024 * 1024;

export interface SourceHeadPin {
  readonly sourceId: string;
  readonly sourceLocator: string;
  readonly taskId: string;
  readonly taskDirectory: string;
  readonly publicationPath: string;
  readonly publicationSha256: string;
  readonly generation: string;
  readonly manifestSha256: string;
  readonly registrationSha256: string;
  readonly captureRequestKey: string;
}
export interface SourceHeadReservation {
  readonly schema: 1;
  readonly kind: 'temari-source-head-reservation';
  readonly id: string;
  readonly cycleKey: string;
  readonly before: SourceHeadPin;
}
/** Caller attestation. Knowledge must validate current admission and complete
 * freshness, refresh, and handoff receipts before requesting an advance.
 */
export interface SourceHeadCompletionProof {
  readonly schema: 1;
  readonly kind: 'temari-source-cycle-completion';
  readonly reservationId: string;
  readonly before: SourceHeadPin;
  readonly after: SourceHeadPin;
  readonly freshnessStagePath: string;
  readonly freshnessStageSha256: string;
  readonly refreshStagePath: string;
  readonly refreshStageSha256: string;
  readonly handoffReceiptPath: string;
  readonly handoffReceiptSha256: string;
}
export interface SourceHeadAdvance {
  readonly schema: 1;
  readonly kind: 'temari-source-head-advance';
  readonly reservationId: string;
  readonly before: SourceHeadPin;
  readonly after: SourceHeadPin;
  readonly proofPath: string;
  readonly proofSha256: string;
}
export interface SourceHeadHold {
  readonly schema: 1;
  readonly kind: 'temari-source-head-hold';
  readonly before: SourceHeadPin;
  readonly requestKey: string;
  readonly reason:
    | 'unknown-outcome'
    | 'admission-changed'
    | 'external-generation'
    | 'conflict';
}
export type SourceHeadState =
  | {
      readonly status: 'READY';
      readonly head: SourceHeadPin;
      readonly reservation: null;
      readonly hold: null;
    }
  | {
      readonly status: 'RESERVED';
      readonly head: SourceHeadPin;
      readonly reservation: SourceHeadReservation;
      readonly hold: null;
    }
  | {
      readonly status: 'HELD';
      readonly head: SourceHeadPin;
      readonly reservation: SourceHeadReservation | null;
      readonly hold: SourceHeadHold;
    };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
export function sourceHeadDigest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
function fields(
  value: unknown,
  expected: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  assert(
    value && typeof value === 'object' && !Array.isArray(value),
    `Invalid ${label}`,
  );
  assert.deepEqual(
    Object.keys(value).sort(),
    [...expected].sort(),
    `Invalid ${label} fields`,
  );
}
function recordValue(value: unknown, label: string): Record<string, unknown> {
  assert(
    value && typeof value === 'object' && !Array.isArray(value),
    `Invalid ${label}`,
  );
  return value as Record<string, unknown>;
}
function sha(value: unknown, label: string): asserts value is string {
  assert(typeof value === 'string' && SHA.test(value), `Invalid ${label}`);
}
function source(value: unknown): asserts value is string {
  assert(typeof value === 'string' && SOURCE.test(value), 'Invalid source ID');
}
function path(value: unknown): asserts value is string {
  assert(
    typeof value === 'string' && isAbsolute(value) && !value.includes('\0'),
    'Absolute path required',
  );
}
function pin(value: unknown): asserts value is SourceHeadPin {
  fields(
    value,
    [
      'sourceId',
      'sourceLocator',
      'taskId',
      'taskDirectory',
      'publicationPath',
      'publicationSha256',
      'generation',
      'manifestSha256',
      'registrationSha256',
      'captureRequestKey',
    ],
    'source head pin',
  );
  source(value.sourceId);
  path(value.publicationPath);
  path(value.taskDirectory);
  assert.equal(
    dirname(value.publicationPath),
    value.taskDirectory,
    'Publication outside pinned task directory',
  );
  assert(
    typeof value.sourceLocator === 'string' &&
      value.sourceLocator.startsWith('file://') &&
      value.sourceLocator.length <= 4096,
    'Local source locator required',
  );
  assert(
    typeof value.taskId === 'string' &&
      value.taskId.length > 0 &&
      value.taskId.length <= 128,
    'Invalid task ID',
  );
  sha(value.publicationSha256, 'publication SHA');
  assert(
    typeof value.generation === 'string' &&
      /^[a-f0-9]{32}$/.test(value.generation),
    'Invalid generation',
  );
  sha(value.manifestSha256, 'manifest SHA');
  sha(value.registrationSha256, 'registration SHA');
  assert(
    typeof value.captureRequestKey === 'string' &&
      value.captureRequestKey.length > 0 &&
      value.captureRequestKey.length <= 256,
    'Invalid capture request key',
  );
}
function same(a: unknown, b: unknown): void {
  assert.equal(canonical(a), canonical(b), 'Source-head CAS pin conflict');
}
function reservation(value: unknown): asserts value is SourceHeadReservation {
  fields(value, ['schema', 'kind', 'id', 'cycleKey', 'before'], 'reservation');
  assert.equal(value.schema, 1);
  assert.equal(value.kind, 'temari-source-head-reservation');
  sha(value.id, 'reservation ID');
  sha(value.cycleKey, 'cycle key');
  pin(value.before);
  assert.equal(
    value.id,
    sourceHeadDigest({ before: value.before, cycleKey: value.cycleKey }),
  );
}
function advance(value: unknown): asserts value is SourceHeadAdvance {
  fields(
    value,
    [
      'schema',
      'kind',
      'reservationId',
      'before',
      'after',
      'proofPath',
      'proofSha256',
    ],
    'advance',
  );
  assert.equal(value.schema, 1);
  assert.equal(value.kind, 'temari-source-head-advance');
  sha(value.reservationId, 'reservation ID');
  pin(value.before);
  pin(value.after);
  assert.equal(value.after.sourceId, value.before.sourceId);
  assert.equal(value.after.sourceLocator, value.before.sourceLocator);
  assert.equal(value.after.taskId, value.before.taskId);
  assert.equal(value.after.taskDirectory, value.before.taskDirectory);
  assert.equal(value.after.registrationSha256, value.before.registrationSha256);
  assert.notEqual(
    value.after.publicationSha256,
    value.before.publicationSha256,
    'Advance must select a new publication',
  );
  path(value.proofPath);
  sha(value.proofSha256, 'proof SHA');
}
function hold(value: unknown): asserts value is SourceHeadHold {
  fields(value, ['schema', 'kind', 'before', 'requestKey', 'reason'], 'hold');
  assert.equal(value.schema, 1);
  assert.equal(value.kind, 'temari-source-head-hold');
  pin(value.before);
  sha(value.requestKey, 'hold request key');
  assert(
    [
      'unknown-outcome',
      'admission-changed',
      'external-generation',
      'conflict',
    ].includes(String(value.reason)),
    'Invalid hold reason',
  );
}
function proof(value: unknown): asserts value is SourceHeadCompletionProof {
  fields(
    value,
    [
      'schema',
      'kind',
      'reservationId',
      'before',
      'after',
      'freshnessStagePath',
      'freshnessStageSha256',
      'refreshStagePath',
      'refreshStageSha256',
      'handoffReceiptPath',
      'handoffReceiptSha256',
    ],
    'completion proof',
  );
  assert.equal(value.schema, 1);
  assert.equal(value.kind, 'temari-source-cycle-completion');
  sha(value.reservationId, 'reservation ID');
  pin(value.before);
  pin(value.after);
  for (const name of [
    'freshnessStagePath',
    'refreshStagePath',
    'handoffReceiptPath',
  ] as const)
    path(value[name]);
  for (const name of [
    'freshnessStageSha256',
    'refreshStageSha256',
    'handoffReceiptSha256',
  ] as const)
    sha(value[name], name);
  for (const name of [
    'freshnessStagePath',
    'refreshStagePath',
    'handoffReceiptPath',
  ] as const) {
    const selected: unknown = value[name];
    path(selected);
    assert.equal(
      dirname(selected),
      value.before.taskDirectory,
      'Completion evidence outside pinned task directory',
    );
  }
}
async function readExact(
  filePath: string,
): Promise<{ value: unknown; sha256: string }> {
  assert.equal(
    await realpath(filePath),
    filePath,
    'Noncanonical source-head artifact',
  );
  const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    assert(
      stat.isFile() && stat.size <= MAX_ARTIFACT_BYTES,
      'Invalid source-head artifact',
    );
    const chunks: Buffer[] = [];
    let length = 0;
    while (length <= MAX_ARTIFACT_BYTES) {
      const chunk = Buffer.allocUnsafe(
        Math.min(64 * 1024, MAX_ARTIFACT_BYTES + 1 - length),
      );
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      length += bytesRead;
    }
    assert(length <= MAX_ARTIFACT_BYTES, 'Source-head artifact exceeds bound');
    assert.equal(
      (await file.stat()).size,
      length,
      'Artifact changed during read',
    );
    const bytes = Buffer.concat(chunks, length);
    const value = JSON.parse(bytes.toString('utf8'));
    assert.equal(
      bytes.toString('utf8'),
      canonical(value),
      'Noncanonical source-head artifact',
    );
    return { value, sha256: createHash('sha256').update(bytes).digest('hex') };
  } finally {
    await file.close();
  }
}
async function maybeRead(
  filePath: string,
): Promise<{ value: unknown; sha256: string } | null> {
  try {
    return await readExact(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
async function publish(filePath: string, value: unknown): Promise<void> {
  const directory = dirname(filePath);
  assert.equal(
    await realpath(directory),
    directory,
    'Noncanonical source-head directory',
  );
  const body = canonical(value);
  assert(Buffer.byteLength(body) <= MAX_RECORD_BYTES);
  const temporary = join(directory, `.source-head-${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    try {
      await file.writeFile(body);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(temporary, filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await readExact(filePath);
      same(existing.value, value);
    }
    const folder = await open(directory, 'r');
    try {
      await folder.sync();
    } finally {
      await folder.close();
    }
  } finally {
    await unlink(temporary);
  }
}

/** The chain is bounded to 64 managed advances in this root. It is not a
 * recurrence scheduler; out-of-band Registrar captures are invisible here.
 */
export class FileSourceHeadStore {
  private constructor(readonly root: string) {}
  static async create(root: string): Promise<FileSourceHeadStore> {
    path(root);
    await mkdir(root, { recursive: true, mode: 0o700 });
    assert(
      (await lstat(root)).isDirectory() && (await realpath(root)) === root,
      'Canonical source-head root required',
    );
    return new FileSourceHeadStore(root);
  }
  private directory(sourceId: string): string {
    source(sourceId);
    return join(this.root, sourceHeadDigest(sourceId));
  }
  private file(
    sourceId: string,
    prefix: 'reservation' | 'terminal',
    priorSha: string,
  ): string {
    sha(priorSha, 'prior publication SHA');
    return join(this.directory(sourceId), `${prefix}-${priorSha}.json`);
  }
  private async ensureSource(sourceId: string): Promise<void> {
    const directory = this.directory(sourceId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    assert(
      (await lstat(directory)).isDirectory() &&
        (await realpath(directory)) === directory,
    );
    const markerPath = join(directory, 'source.json');
    if (!(await maybeRead(markerPath)))
      assert(
        (await readdir(directory)).every((name) =>
          name.startsWith('.source-head-'),
        ),
        'Missing source marker in nonempty ledger',
      );
    await publish(markerPath, {
      schema: 1,
      kind: 'temari-source-head',
      sourceId,
    });
  }
  async initialize(initial: SourceHeadPin): Promise<SourceHeadState> {
    pin(initial);
    await this.checkPublication(initial);
    await this.ensureSource(initial.sourceId);
    await publish(join(this.directory(initial.sourceId), 'genesis.json'), {
      schema: 1,
      kind: 'temari-source-head-genesis',
      initial,
    });
    const state = await this.load(initial.sourceId);
    assert(state);
    return state;
  }
  async load(sourceId: string): Promise<SourceHeadState | null> {
    const directory = this.directory(sourceId);
    try {
      await lstat(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    assert.equal(await realpath(directory), directory);
    const marker = (await readExact(join(directory, 'source.json'))).value;
    same(marker, { schema: 1, kind: 'temari-source-head', sourceId });
    const genesis = (await readExact(join(directory, 'genesis.json'))).value;
    fields(genesis, ['schema', 'kind', 'initial'], 'genesis');
    assert.equal(genesis.schema, 1);
    assert.equal(genesis.kind, 'temari-source-head-genesis');
    pin(genesis.initial);
    assert.equal(genesis.initial.sourceId, sourceId);
    let head = genesis.initial;
    const traversed = new Set<string>(['source.json', 'genesis.json']);
    for (let depth = 0; depth <= MAX_CHAIN; depth++) {
      if (depth === MAX_CHAIN) {
        const entries = await readdir(directory);
        assert(
          entries.length <= MAX_CHAIN * 3 + 4,
          'Source-head history exceeds bound',
        );
        for (const name of entries)
          assert(
            traversed.has(name) || name.startsWith('.source-head-'),
            `Orphan or unexpected source-head artifact: ${name}`,
          );
        await this.checkPublication(head);
        return { status: 'READY', head, reservation: null, hold: null };
      }
      const priorSha = head.publicationSha256;
      const reservationName = `reservation-${priorSha}.json`,
        terminalName = `terminal-${priorSha}.json`;
      const [r, terminal] = await Promise.all([
        maybeRead(this.file(sourceId, 'reservation', priorSha)),
        maybeRead(this.file(sourceId, 'terminal', priorSha)),
      ]);
      let rValue: SourceHeadReservation | null = null;
      let aValue: SourceHeadAdvance | null = null;
      let hValue: SourceHeadHold | null = null;
      if (r) {
        reservation(r.value);
        rValue = r.value;
      }
      if (terminal) {
        const kind = recordValue(terminal.value, 'terminal')['kind'];
        if (kind === 'temari-source-head-advance') {
          advance(terminal.value);
          aValue = terminal.value;
        } else if (kind === 'temari-source-head-hold') {
          hold(terminal.value);
          hValue = terminal.value;
        } else assert.fail('Unknown source-head terminal decision');
      }
      if (rValue) {
        same(rValue.before, head);
        traversed.add(reservationName);
      }
      if (aValue) {
        same(aValue.before, head);
        traversed.add(terminalName);
        assert(rValue, 'Advance lacks reservation');
        assert.equal(aValue.reservationId, rValue.id);
        await this.checkProof(aValue);
      }
      if (hValue) {
        same(hValue.before, head);
        traversed.add(terminalName);
      }
      if (aValue) {
        head = aValue.after;
        continue;
      }
      const entries = await readdir(directory);
      assert(
        entries.length <= MAX_CHAIN * 3 + 4,
        'Source-head history exceeds bound',
      );
      for (const name of entries)
        assert(
          traversed.has(name) || name.startsWith('.source-head-'),
          `Orphan or unexpected source-head artifact: ${name}`,
        );
      await this.checkPublication(head);
      if (hValue)
        return {
          status: 'HELD',
          head,
          reservation: rValue,
          hold: hValue,
        };
      if (rValue)
        return { status: 'RESERVED', head, reservation: rValue, hold: null };
      return { status: 'READY', head, reservation: null, hold: null };
    }
    assert.fail('Unreachable source-head chain bound');
  }
  private async checkProof(record: SourceHeadAdvance): Promise<void> {
    const artifact = await readExact(record.proofPath);
    assert.equal(
      artifact.sha256,
      record.proofSha256,
      'Completion proof changed',
    );
    proof(artifact.value);
    assert.equal(artifact.value.reservationId, record.reservationId);
    same(artifact.value.before, record.before);
    same(artifact.value.after, record.after);
    const [freshnessArtifact, refreshArtifact, handoffArtifact] =
      await Promise.all([
        readExact(artifact.value.freshnessStagePath),
        readExact(artifact.value.refreshStagePath),
        readExact(artifact.value.handoffReceiptPath),
      ]);
    assert.equal(freshnessArtifact.sha256, artifact.value.freshnessStageSha256);
    assert.equal(refreshArtifact.sha256, artifact.value.refreshStageSha256);
    assert.equal(handoffArtifact.sha256, artifact.value.handoffReceiptSha256);
    const freshness = recordValue(freshnessArtifact.value, 'freshness stage');
    const refresh = recordValue(refreshArtifact.value, 'refresh stage');
    const handoff = recordValue(handoffArtifact.value, 'recapture handoff');
    assert.equal(freshness['kind'], 'temari-archive-freshness-job-stage');
    assert.equal(freshness['decision'], 'recapture-needed');
    assert.equal(refresh['kind'], 'temari-archive-refresh-handoff-stage');
    assert.equal(refresh['graphMutation'], 'none');
    assert.equal(
      refresh['handoffReceiptPath'],
      artifact.value.handoffReceiptPath,
    );
    assert.equal(
      refresh['handoffReceiptSha256'],
      artifact.value.handoffReceiptSha256,
    );
    assert.equal(refresh['afterPublicationPath'], record.after.publicationPath);
    assert.equal(
      refresh['afterPublicationSha256'],
      record.after.publicationSha256,
    );
    assert.equal(handoff['status'], 'handoff');
    assert(
      [
        'temari-archive-source-recapture',
        'temari-archive-source-resume',
      ].includes(String(handoff['kind'])),
    );
    same(handoff['before'], {
      publicationPath: record.before.publicationPath,
      publicationSha256: record.before.publicationSha256,
      generation: record.before.generation,
      manifestSha256: record.before.manifestSha256,
    });
    same(handoff['after'], {
      publicationPath: record.after.publicationPath,
      publicationSha256: record.after.publicationSha256,
      generation: record.after.generation,
      manifestSha256: record.after.manifestSha256,
    });
    await this.checkPublication(record.before);
    await this.checkPublication(record.after);
  }
  private async checkPublication(selected: SourceHeadPin): Promise<void> {
    const artifact = await readExact(selected.publicationPath);
    assert.equal(
      artifact.sha256,
      selected.publicationSha256,
      'Selected publication changed',
    );
    const publication = recordValue(artifact.value, 'archive publication');
    assert.equal(publication['kind'], 'temari-archive-publication');
    assert.equal(
      recordValue(publication['source'], 'publication source')['id'],
      selected.sourceId,
    );
    assert.equal(
      recordValue(publication['source'], 'publication source')['locator'],
      selected.sourceLocator,
    );
    assert.equal(
      recordValue(publication['task'], 'publication task')['id'],
      selected.taskId,
    );
    assert.equal(
      recordValue(publication['task'], 'publication task')['directory'],
      selected.taskDirectory,
    );
    assert.equal(publication['generation'], selected.generation);
    assert.equal(publication['manifestSha256'], selected.manifestSha256);
    assert.equal(publication['captureRequestKey'], selected.captureRequestKey);
    assert.equal(
      sourceHeadDigest(publication['registration']),
      selected.registrationSha256,
    );
    assert.equal(publication['preservation'], 'complete-admitted');
  }
  async reserve(
    expected: SourceHeadPin,
    cycleKey: string,
  ): Promise<SourceHeadState> {
    pin(expected);
    sha(cycleKey, 'cycle key');
    await this.checkPublication(expected);
    const before = await this.load(expected.sourceId);
    assert(before, 'Source head must be initialized');
    same(before.head, expected);
    assert(before.status !== 'HELD', 'Source head is held');
    const terminalCount = (
      await readdir(this.directory(expected.sourceId))
    ).filter(
      (name) => name.startsWith('terminal-') && name.endsWith('.json'),
    ).length;
    assert(
      terminalCount < MAX_CHAIN,
      'Source-head chain capacity exhausted before reservation',
    );
    const value: SourceHeadReservation = {
      schema: 1,
      kind: 'temari-source-head-reservation',
      id: sourceHeadDigest({ before: expected, cycleKey }),
      cycleKey,
      before: expected,
    };
    if (before.status === 'RESERVED') same(before.reservation, value);
    else
      await publish(
        this.file(expected.sourceId, 'reservation', expected.publicationSha256),
        value,
      );
    const after = await this.load(expected.sourceId);
    assert(after && after.status === 'RESERVED');
    same(after.head, expected);
    same(after.reservation, value);
    return after;
  }
  async advance(input: {
    readonly reservationId: string;
    readonly before: SourceHeadPin;
    readonly after: SourceHeadPin;
    readonly proofPath: string;
    readonly proofSha256: string;
  }): Promise<SourceHeadState> {
    fields(
      input,
      ['reservationId', 'before', 'after', 'proofPath', 'proofSha256'],
      'advance request',
    );
    sha(input.reservationId, 'reservation ID');
    pin(input.before);
    pin(input.after);
    assert.equal(input.before.sourceId, input.after.sourceId);
    path(input.proofPath);
    sha(input.proofSha256, 'proof SHA');
    const value: SourceHeadAdvance = {
      schema: 1,
      kind: 'temari-source-head-advance',
      ...input,
    };
    advance(value);
    await this.checkProof(value);
    const existing = await maybeRead(
      this.file(
        input.before.sourceId,
        'terminal',
        input.before.publicationSha256,
      ),
    );
    if (existing) {
      same(existing.value, value);
      const replay = await this.load(input.before.sourceId);
      assert(replay);
      return replay;
    }
    const prior = await this.load(input.before.sourceId);
    assert(
      prior && prior.status === 'RESERVED',
      'Exact reserved source head required',
    );
    same(prior.head, input.before);
    assert.equal(prior.reservation.id, input.reservationId);
    await publish(
      this.file(
        input.before.sourceId,
        'terminal',
        input.before.publicationSha256,
      ),
      value,
    );
    const updated = await this.load(input.before.sourceId);
    assert(updated);
    return updated;
  }
  async hold(
    expected: SourceHeadPin,
    requestKey: string,
    reason: SourceHeadHold['reason'],
  ): Promise<SourceHeadState> {
    pin(expected);
    sha(requestKey, 'hold request key');
    const prior = await this.load(expected.sourceId);
    assert(prior, 'Source head must be initialized');
    same(prior.head, expected);
    const value: SourceHeadHold = {
      schema: 1,
      kind: 'temari-source-head-hold',
      before: expected,
      requestKey,
      reason,
    };
    if (prior.status === 'HELD') {
      same(prior.hold, value);
      return prior;
    }
    assert.equal(prior.status, 'RESERVED', 'Hold requires a reservation');
    await publish(
      this.file(expected.sourceId, 'terminal', expected.publicationSha256),
      value,
    );
    const updated = await this.load(expected.sourceId);
    assert(updated && updated.status === 'HELD');
    same(updated.hold, value);
    return updated;
  }
}
