import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { link, lstat, open, realpath, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { sha256 } from './data.js';

export type OutputObservation =
  | { readonly kind: 'absent' }
  | { readonly kind: 'matching'; readonly sha256: string }
  | { readonly kind: 'conflict'; readonly sha256: string }
  | { readonly kind: 'unreviewed'; readonly sha256: string }
  | { readonly kind: 'invalid'; readonly reason: string };

export const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
export const hasCode = (error: unknown, code: string): boolean =>
  error !== null &&
  typeof error === 'object' &&
  'code' in error &&
  error.code === code;

export async function canonicalDirectory(directory: string): Promise<void> {
  assert(
    isAbsolute(directory) &&
      resolve(directory) === directory &&
      (await realpath(directory)) === directory,
    'Existing canonical directory required',
  );
  assert((await lstat(directory)).isDirectory(), 'Directory required');
}

export async function readRegular(
  path: string,
  limit: number,
): Promise<Buffer | null> {
  try {
    const stat = await lstat(path);
    assert(stat.isFile() && !stat.isSymbolicLink(), `Nonregular file: ${path}`);
    assert(stat.size <= limit, `File exceeds ${limit} bytes: ${path}`);
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const current = await file.stat();
      assert(
        current.isFile() && current.size <= limit,
        `Invalid file: ${path}`,
      );
      const bytes = Buffer.alloc(limit + 1);
      let size = 0;
      while (size < bytes.length) {
        const read = await file.read(bytes, size, bytes.length - size, null);
        if (read.bytesRead === 0) break;
        size += read.bytesRead;
      }
      assert(size <= limit, `File exceeds ${limit} bytes: ${path}`);
      return bytes.subarray(0, size);
    } finally {
      await file.close();
    }
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return null;
    throw error;
  }
}

export async function observe(
  path: string,
  expected?: string,
): Promise<OutputObservation> {
  try {
    const bytes = await readRegular(path, 512 * 1024);
    if (bytes === null) return { kind: 'absent' };
    const digest = sha256(bytes);
    if (expected === undefined) return { kind: 'unreviewed', sha256: digest };
    return bytes.equals(Buffer.from(expected))
      ? { kind: 'matching', sha256: digest }
      : { kind: 'conflict', sha256: digest };
  } catch (error) {
    return { kind: 'invalid', reason: message(error) };
  }
}

export async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function publish(
  directory: string,
  target: string,
  body: string,
): Promise<boolean> {
  const temporary = join(directory, `.plan-draft-${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    try {
      await file.writeFile(body);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(temporary, target);
    } catch (error) {
      if (hasCode(error, 'EEXIST')) return false;
      throw error;
    }
    await syncDirectory(dirname(target));
    return true;
  } finally {
    await unlink(temporary);
  }
}
