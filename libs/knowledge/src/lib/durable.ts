import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
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
export async function publishJson(path: string, value: unknown): Promise<void> {
  const directory = dirname(path),
    body = canonical(value);
  assert(
    isAbsolute(path) && (await realpath(directory)) === directory,
    'Canonical existing artifact directory required',
  );
  assert(Buffer.byteLength(body) <= 1_048_576, 'Intake artifact exceeds bound');
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
        existing.size <= 1_048_576,
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
  assert(
    isAbsolute(path) && (await realpath(path)) === path,
    'Canonical artifact required',
  );
  const stat = await lstat(path);
  assert(stat.isFile() && stat.size <= 1_048_576, 'Artifact exceeds bound');
  return JSON.parse(await readFile(path, 'utf8'));
}
