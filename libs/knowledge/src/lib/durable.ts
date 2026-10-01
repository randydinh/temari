import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  constants,
  link,
  lstat,
  open,
  readFile,
  realpath,
  unlink,
} from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { canonical } from './codec.js';

/** Exclusive publication, synced before and after the no-overwrite link. */
export async function publishJson(
  path: string,
  value: unknown,
  maxBytes = 1_048_576,
): Promise<void> {
  const directory = dirname(path),
    body = canonical(value);
  assert(
    Number.isSafeInteger(maxBytes) &&
      maxBytes >= 1 &&
      maxBytes <= 8 * 1_048_576,
    'Invalid artifact byte bound',
  );
  assert(
    isAbsolute(path) && (await realpath(directory)) === directory,
    'Canonical existing artifact directory required',
  );
  assert(Buffer.byteLength(body) <= maxBytes, 'Intake artifact exceeds bound');
  const temporary = join(directory, `.archive-${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    try {
      await file.writeFile(body);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(temporary, path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const existing = await lstat(path);
      assert(
        existing.isFile() && (await realpath(path)) === path,
        'Unsafe artifact collision',
      );
      assert(
        existing.size <= maxBytes,
        'Existing intake artifact exceeds bound',
      );
      assert.equal(
        await readFile(path, 'utf8'),
        body,
        'Immutable request/publication collision',
      );
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
export async function readJson(path: string): Promise<unknown> {
  return (await readJsonWithBytes(path)).value;
}

/** Read exact artifact bytes from one regular file descriptor with a hard byte cap. */
export async function readJsonWithBytes(
  path: string,
  maxBytes = 1_048_576,
): Promise<{ readonly value: unknown; readonly bytes: Buffer }> {
  assert(
    Number.isSafeInteger(maxBytes) &&
      maxBytes >= 1 &&
      maxBytes <= 8 * 1_048_576,
    'Invalid artifact byte bound',
  );
  assert(
    isAbsolute(path) && (await realpath(path)) === path,
    'Canonical artifact required',
  );
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    assert(stat.isFile() && stat.size <= maxBytes, 'Artifact exceeds bound');
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      const next = Buffer.allocUnsafe(Math.min(65536, maxBytes + 1 - size));
      const { bytesRead } = await file.read(next, 0, next.length, null);
      if (bytesRead === 0) break;
      size += bytesRead;
      assert(size <= maxBytes, 'Artifact exceeds bound');
      chunks.push(next.subarray(0, bytesRead));
    }
    const bytes = Buffer.concat(chunks, size);
    return { value: JSON.parse(bytes.toString('utf8')), bytes };
  } finally {
    await file.close();
  }
}
