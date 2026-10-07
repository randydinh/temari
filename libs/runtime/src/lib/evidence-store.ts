import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  realpath,
  unlink,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { EvidenceKind, WorkerEvidenceReference } from '@temari/contracts';

export type { EvidenceKind, WorkerEvidenceReference } from '@temari/contracts';

export interface EvidenceReference extends WorkerEvidenceReference {
  readonly path: string;
}

export interface PutEvidenceRequest {
  readonly runId: string;
  readonly revision: string;
  readonly kind: EvidenceKind;
  readonly content: string | Uint8Array;
}

export type EvidenceBytes = AsyncIterable<Uint8Array>;

export interface PutStreamEvidenceRequest {
  readonly runId: string;
  readonly revision: string;
  readonly kind: EvidenceKind;
  readonly content: EvidenceBytes;
}

export interface EvidenceStore {
  put(request: PutEvidenceRequest): Promise<EvidenceReference>;
  load(reference: EvidenceReference): Promise<Uint8Array>;
  loadPortable(reference: WorkerEvidenceReference): Promise<Uint8Array>;
  putStream?(request: PutStreamEvidenceRequest): Promise<EvidenceReference>;
  verifyPortable?(reference: WorkerEvidenceReference): Promise<void>;
}

const MAX_BUFFERED_EVIDENCE_BYTES = 16 * 1024 * 1024;

function assertRunId(runId: string): void {
  assert(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId),
    'Run ID must be a safe filename component.',
  );
}

function assertRevision(revision: string): void {
  assert(
    revision.length > 0 && revision.length <= 512,
    'Revision is required.',
  );
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
    assert(isAbsolute(root), 'Evidence store root must be absolute.');
    await mkdir(root, { recursive: true, mode: 0o700 });
    const canonicalRoot = await realpath(root);
    await chmod(canonicalRoot, 0o700);
    return new FileEvidenceStore(canonicalRoot);
  }

  static async openExisting(root: string): Promise<FileEvidenceStore> {
    assert(isAbsolute(root), 'Evidence store root must be absolute.');
    assert((await lstat(root)).isDirectory(), 'Evidence store must exist.');
    return new FileEvidenceStore(await realpath(root));
  }

  async put(request: PutEvidenceRequest): Promise<EvidenceReference> {
    assertRunId(request.runId);
    assertRevision(request.revision);
    const content = bytesOf(request.content);
    assert(
      content.byteLength <= MAX_BUFFERED_EVIDENCE_BYTES,
      'Evidence exceeds 16 MiB.',
    );
    return this.putStream({
      ...request,
      content: (async function* () {
        yield content;
      })(),
    });
  }

  async putStream(
    request: PutStreamEvidenceRequest,
  ): Promise<EvidenceReference> {
    assertRunId(request.runId);
    assertRevision(request.revision);
    const temporary = join(this.root, `.${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    const hashing = createHash('sha256');
    let bytes = 0;
    try {
      try {
        for await (const chunk of request.content) {
          assert(
            chunk instanceof Uint8Array,
            'Evidence stream must yield bytes.',
          );
          bytes += chunk.byteLength;
          assert(
            Number.isSafeInteger(bytes),
            'Evidence byte count cannot be represented.',
          );
          await file.writeFile(chunk);
          hashing.update(chunk);
        }
        await file.sync();
      } finally {
        await file.close();
      }
      const sha256 = hashing.digest('hex');
      const path = join(this.root, `${sha256}.artifact`);
      const reference: EvidenceReference = {
        schema: 1,
        runId: request.runId,
        revision: request.revision,
        kind: request.kind,
        sha256,
        bytes,
        path,
      };
      try {
        await link(temporary, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await this.verifyPortable(reference);
      }
      const directory = await open(this.root, constants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      return reference;
    } finally {
      await unlink(temporary);
    }
  }

  async verifyPortable(reference: WorkerEvidenceReference): Promise<void> {
    assertReference(reference);
    await verifyEvidenceFile(
      join(this.root, `${reference.sha256}.artifact`),
      this.root,
      reference,
    );
  }

  async load(reference: EvidenceReference): Promise<Uint8Array> {
    assert.equal(reference.schema, 1);
    assertRunId(reference.runId);
    assertRevision(reference.revision);
    assertHash(reference.sha256);
    const path = join(this.root, `${reference.sha256}.artifact`);
    assert.equal(
      reference.path,
      path,
      'Evidence path is outside its configured store.',
    );
    return this.loadAtPath(reference, path);
  }

  async loadPortable(reference: WorkerEvidenceReference): Promise<Uint8Array> {
    assert.equal(reference.schema, 1);
    assertRunId(reference.runId);
    assertRevision(reference.revision);
    assertHash(reference.sha256);
    assert(
      Number.isSafeInteger(reference.bytes) && reference.bytes >= 0,
      'Evidence byte count is invalid.',
    );
    return this.loadAtPath(
      reference,
      join(this.root, `${reference.sha256}.artifact`),
    );
  }

  private async loadAtPath(
    reference: WorkerEvidenceReference,
    path: string,
  ): Promise<Uint8Array> {
    const file = await openEvidenceFile(path, this.root);
    try {
      const stat = await file.stat();
      assert(
        stat.size <= MAX_BUFFERED_EVIDENCE_BYTES,
        'Evidence exceeds 16 MiB.',
      );
      const content = await file.readFile();
      assert.equal(
        content.byteLength,
        reference.bytes,
        'Evidence byte count changed.',
      );
      assert.equal(hash(content), reference.sha256, 'Evidence hash changed.');
      return content;
    } finally {
      await file.close();
    }
  }
}

function assertReference(reference: WorkerEvidenceReference): void {
  assert.equal(reference.schema, 1);
  assertRunId(reference.runId);
  assertRevision(reference.revision);
  assertHash(reference.sha256);
  assert(
    Number.isSafeInteger(reference.bytes) && reference.bytes >= 0,
    'Evidence byte count is invalid.',
  );
}

async function openEvidenceFile(path: string, allowedRoot: string) {
  assert(
    isAbsolute(path) && isAbsolute(allowedRoot),
    'Evidence paths must be absolute.',
  );
  const root = await realpath(allowedRoot);
  const requestedPath = resolve(path);
  const inputRoot = resolve(allowedRoot);
  const inputSuffix = relative(inputRoot, requestedPath);
  const inInputRoot =
    inputSuffix &&
    inputSuffix !== '..' &&
    !inputSuffix.startsWith(`..${sep}`) &&
    !isAbsolute(inputSuffix);
  const suffix = inInputRoot ? inputSuffix : relative(root, requestedPath);
  const resolved = inInputRoot ? join(root, inputSuffix) : requestedPath;
  assert(
    suffix &&
      suffix !== '..' &&
      !suffix.startsWith(`..${sep}`) &&
      !isAbsolute(suffix),
    'Evidence path is outside its allowed root.',
  );
  let component = root;
  for (const part of suffix.split(sep)) {
    component = join(component, part);
    const stat = await lstat(component);
    assert(!stat.isSymbolicLink(), 'Evidence must not traverse symlinks.');
    if (component !== resolved)
      assert(stat.isDirectory(), 'Evidence parent must be a directory.');
  }
  assert.equal(
    await realpath(dirname(resolved)),
    dirname(resolved),
    'Evidence parent changed.',
  );
  const file = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    assert(stat.isFile(), 'Evidence must be a regular file.');
    assert.equal(await realpath(resolved), resolved, 'Evidence path changed.');
    const current = await lstat(resolved);
    assert.equal(current.dev, stat.dev, 'Evidence descriptor changed.');
    assert.equal(current.ino, stat.ino, 'Evidence descriptor changed.');
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

/** Stream a caller-owned, sealed regular file from an allowed root. Reads use
 * the validated descriptor, never a pathname reopened after validation. */
export async function* streamEvidenceFile(
  path: string,
  allowedRoot: string,
): EvidenceBytes {
  const file = await openEvidenceFile(path, allowedRoot);
  try {
    const before = await file.stat();
    let bytes = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      bytes += chunk.byteLength;
      assert(
        Number.isSafeInteger(bytes),
        'Evidence byte count cannot be represented.',
      );
      yield chunk;
    }
    const after = await file.stat();
    assert.equal(bytes, before.size, 'Evidence source byte count changed.');
    assert.equal(
      after.size,
      before.size,
      'Evidence source byte count changed.',
    );
    assert.equal(
      after.mtimeMs,
      before.mtimeMs,
      'Evidence source changed while reading.',
    );
  } finally {
    await file.close();
  }
}

export async function verifyEvidenceFile(
  path: string,
  allowedRoot: string,
  reference: WorkerEvidenceReference,
): Promise<void> {
  assertReference(reference);
  const hashing = createHash('sha256');
  let bytes = 0;
  for await (const chunk of streamEvidenceFile(path, allowedRoot)) {
    hashing.update(chunk);
    bytes += chunk.byteLength;
  }
  assert.equal(bytes, reference.bytes, 'Evidence byte count changed.');
  assert.equal(
    hashing.digest('hex'),
    reference.sha256,
    'Evidence hash changed.',
  );
}

export async function putStreamedEvidence(
  store: EvidenceStore,
  request: PutStreamEvidenceRequest,
): Promise<EvidenceReference> {
  assert(
    store.putStream && store.verifyPortable,
    'Complete diagnostics require streaming evidence publication and verification.',
  );
  const reference = await store.putStream(request);
  await store.verifyPortable(reference);
  return reference;
}

/** Buffered fallback is only for existing bounded semantic evidence. */
export async function verifyPortableEvidence(
  store: EvidenceStore,
  reference: WorkerEvidenceReference,
): Promise<void> {
  if (store.verifyPortable) await store.verifyPortable(reference);
  else await store.loadPortable(reference);
}
