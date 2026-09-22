import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  unlink,
} from 'node:fs/promises';
import { join } from 'node:path';

export type EvidenceKind =
  | 'stdout'
  | 'stderr'
  | 'worker-result'
  | 'verification'
  | 'other';

export interface EvidenceReference {
  readonly schema: 1;
  readonly runId: string;
  readonly revision: string;
  readonly kind: EvidenceKind;
  readonly sha256: string;
  readonly bytes: number;
  readonly path: string;
}

export interface PutEvidenceRequest {
  readonly runId: string;
  readonly revision: string;
  readonly kind: EvidenceKind;
  readonly content: string | Uint8Array;
}

export interface EvidenceStore {
  put(request: PutEvidenceRequest): Promise<EvidenceReference>;
  load(reference: EvidenceReference): Promise<Uint8Array>;
}

const MAX_EVIDENCE_BYTES = 16 * 1024 * 1024;

function assertRunId(runId: string): void {
  assert(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId),
    'Run ID must be a safe filename component.',
  );
}

function assertRevision(revision: string): void {
  assert(revision.length > 0 && revision.length <= 512, 'Revision is required.');
}

function bytesOf(content: string | Uint8Array): Uint8Array {
  return typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
}

function hash(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function assertHash(value: string): void {
  assert(/^[0-9a-f]{64}$/.test(value), 'Evidence hash is invalid.');
}

export class FileEvidenceStore implements EvidenceStore {
  private constructor(private readonly root: string) {}

  static async create(root: string): Promise<FileEvidenceStore> {
    assert(root.startsWith('/'), 'Evidence store root must be absolute.');
    await mkdir(root, { recursive: true, mode: 0o700 });
    return new FileEvidenceStore(await realpath(root));
  }

  async put(request: PutEvidenceRequest): Promise<EvidenceReference> {
    assertRunId(request.runId);
    assertRevision(request.revision);
    const content = bytesOf(request.content);
    assert(content.byteLength <= MAX_EVIDENCE_BYTES, 'Evidence exceeds 16 MiB.');
    const sha256 = hash(content);
    const path = join(this.root, `${sha256}.artifact`);
    const temporary = join(this.root, `.${sha256}.${process.pid}.${Date.now()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      try {
        await file.writeFile(content);
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        await link(temporary, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = await readFile(path);
        assert.equal(hash(existing), sha256, 'Evidence artifact collision or mutation.');
      }
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    return {
      schema: 1,
      runId: request.runId,
      revision: request.revision,
      kind: request.kind,
      sha256,
      bytes: content.byteLength,
      path,
    };
  }

  async load(reference: EvidenceReference): Promise<Uint8Array> {
    assert.equal(reference.schema, 1);
    assertRunId(reference.runId);
    assertRevision(reference.revision);
    assertHash(reference.sha256);
    const path = join(this.root, `${reference.sha256}.artifact`);
    assert.equal(reference.path, path, 'Evidence path is outside its configured store.');
    const stat = await lstat(path);
    assert(stat.isFile() && !stat.isSymbolicLink(), 'Evidence must be a regular file.');
    assert(stat.size <= MAX_EVIDENCE_BYTES, 'Evidence exceeds 16 MiB.');
    const content = await readFile(path);
    assert.equal(content.byteLength, reference.bytes, 'Evidence byte count changed.');
    assert.equal(hash(content), reference.sha256, 'Evidence hash changed.');
    return content;
  }
}
