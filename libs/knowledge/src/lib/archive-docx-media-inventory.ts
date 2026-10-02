/** Bounded, metadata-only inventory of media packaged inside a retained DOCX. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { open, lstat, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  loadArchivePublication,
  registrationFor,
  snapshot,
} from './archive-intake.js';
import { archiveTransport } from './archive-transport.js';
import { canonical, digest, hash, integer, list, object, text } from './codec.js';
import { publishJson, readJsonWithBytes } from './durable.js';

const MAX_ORIGINAL = 8 * 1024 * 1024;
const MAX_RESPONSE = 1024 * 1024;
const MAX_EXPANDED = 32 * 1024 * 1024;
const MAX_MEDIA = 256;

// Run with -I -S. No third-party parser or network access is needed. Reading
// every member validates its actual expanded size and CRC, including nonmedia.
const ZIP_INVENTORY = String.raw`
import hashlib, json, os, sys, zipfile
path, expected_sha = sys.argv[1:]
MAX_ORIGINAL = 8 * 1024 * 1024
MAX_EXPANDED = 32 * 1024 * 1024
try:
    if os.stat(path).st_size > MAX_ORIGINAL:
        raise ValueError('original-limit')
    original = hashlib.sha256()
    with open(path, 'rb') as stream:
        while block := stream.read(65536):
            original.update(block)
            if stream.tell() > MAX_ORIGINAL:
                raise ValueError('original-limit')
    if original.hexdigest() != expected_sha:
        raise ValueError('original-sha256-mismatch')
    result = []
    total = 0
    with zipfile.ZipFile(path, 'r') as archive:
        infos = archive.infolist()
        if len(infos) > 1000:
            raise ValueError('member-limit')
        if not {'[Content_Types].xml', 'word/document.xml'}.issubset(
                {info.filename for info in infos}):
            raise ValueError('docx-markers-missing')
        seen = set()
        for info in infos:
            name = info.filename
            if name in seen:
                raise ValueError('duplicate-member')
            seen.add(name)
            parts = name[:-1].split('/') if info.is_dir() else name.split('/')
            if (len(name) > 4096 or name.startswith('/') or chr(92) in name
                    or any(part in ('', '.', '..') for part in parts)
                    or any(ord(char) < 32 for char in name)):
                raise ValueError('invalid-member-name')
            if info.flag_bits & 1:
                raise ValueError('encrypted-member')
            if info.file_size > MAX_EXPANDED or total + info.file_size > MAX_EXPANDED:
                raise ValueError('expansion-limit')
            media = name.startswith('word/media/') and not info.is_dir()
            if media and len(result) >= 256:
                raise ValueError('media-limit')
            member_sha = hashlib.sha256()
            count = 0
            with archive.open(info) as stream:
                while block := stream.read(65536):
                    count += len(block)
                    total += len(block)
                    if total > MAX_EXPANDED or count > info.file_size:
                        raise ValueError('expansion-limit')
                    if media:
                        member_sha.update(block)
            if count != info.file_size:
                raise ValueError('member-size-mismatch')
            if media:
                result.append({'name': name, 'sha256': member_sha.hexdigest(), 'bytes': count})
    print(json.dumps({'members': sorted(result, key=lambda row: row['name']), 'expandedBytes': total}, separators=(',', ':')))
except (OSError, ValueError, RuntimeError, EOFError, zipfile.BadZipFile, zipfile.LargeZipFile) as error:
    print(type(error).__name__, file=sys.stderr)
    sys.exit(2)
`;

export interface ArchiveDocxMediaInventoryPlan {
  readonly publicationPath: string;
  readonly sourcePath: string;
  readonly recoveredOriginalPath: string;
}

export interface ArchiveDocxMediaInventoryReceipt {
  readonly schema: 1;
  readonly kind: 'temari-archive-docx-media-inventory';
  readonly policy: 'pinned-docx-package-media-v1';
  readonly workerSha256: string;
  readonly adapterSha256: string;
  readonly sourceId: string;
  readonly generation: string;
  readonly manifestSha256: string;
  readonly publicationPath: string;
  readonly publicationSha256: string;
  readonly sourcePath: string;
  readonly original: { readonly sha256: string; readonly bytes: number };
  readonly members: readonly {
    readonly name: string;
    readonly sha256: string;
    readonly bytes: number;
  }[];
  readonly expandedBytes: number;
  readonly currentOriginal: 'not-checked';
  readonly coverage: 'package-media-only';
  readonly visualMeaning: 'not-evaluated';
}

function sourcePath(value: unknown): string {
  const path = text(value);
  assert(
    path.length <= 4096 && !isAbsolute(path) && !path.startsWith('-') &&
      !path.includes(String.fromCharCode(92)) &&
      !path.includes(String.fromCharCode(0)) &&
      path.split('/').every((part) => part && part !== '.' && part !== '..') &&
      /\.docx$/i.test(path),
    'Canonical source-relative DOCX path required',
  );
  return path;
}

async function boundedOriginal(path: string): Promise<{ sha256: string; bytes: number }> {
  assert(isAbsolute(text(path)), 'Absolute recovered original path required');
  const stat = await lstat(path);
  assert(stat.isFile() && stat.size <= MAX_ORIGINAL, 'Bound regular recovered file required');
  const handle = await open(path, 'r');
  try {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for (;;) {
      const block = Buffer.allocUnsafe(65536);
      const read = await handle.read(block, 0, block.length, null);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
      assert(bytes <= MAX_ORIGINAL, 'Recovered original exceeds bound');
      chunks.push(block.subarray(0, read.bytesRead));
    }
    return { sha256: hash(Buffer.concat(chunks)), bytes };
  } finally {
    await handle.close();
  }
}

/** Package parser is separate so rejected archive shapes can be tested directly. */
export async function scanRecoveredDocxPackage(
  recoveredOriginalPath: string,
  expectedSha256: string,
  pythonExecutable: string,
): Promise<Pick<ArchiveDocxMediaInventoryReceipt, 'members' | 'expandedBytes'>> {
  digest(expectedSha256);
  assert(isAbsolute(text(pythonExecutable)));
  assert.equal((await boundedOriginal(recoveredOriginalPath)).sha256, expectedSha256);
  const worker = await promisify(execFile)(
    pythonExecutable,
    ['-I', '-S', '-c', ZIP_INVENTORY, recoveredOriginalPath, expectedSha256],
    { timeout: 30000, maxBuffer: MAX_RESPONSE, encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' } },
  );
  assert(Buffer.byteLength(worker.stdout) <= MAX_RESPONSE, 'Worker response exceeds bound');
  const parsed = object(JSON.parse(worker.stdout));
  const members = list(parsed['members']).map((raw) => {
    const member = object(raw);
    const name = text(member['name']);
    assert(name.startsWith('word/media/') && name.length <= 4096);
    return { name, sha256: digest(member['sha256']),
      bytes: integer(member['bytes'], 0, MAX_EXPANDED) };
  });
  assert(members.length <= MAX_MEDIA);
  assert.equal(new Set(members.map((member) => member.name)).size, members.length);
  const expandedBytes = integer(parsed['expandedBytes'], 0, MAX_EXPANDED);
  assert.equal((await boundedOriginal(recoveredOriginalPath)).sha256, expectedSha256);
  return { members, expandedBytes };
}

/** Accepts only an operator-supplied, explicitly recovered archived original. */
export async function inventoryArchiveDocxMedia(
  input: ArchiveDocxMediaInventoryPlan,
): Promise<{ receipt: ArchiveDocxMediaInventoryReceipt; receiptPath: string }> {
  assert.deepEqual(Object.keys(input).sort(), [
    'publicationPath', 'recoveredOriginalPath', 'sourcePath',
  ]);
  assert(isAbsolute(text(input.publicationPath)));
  const selected = sourcePath(input.sourcePath);
  const adapterModulePath = fileURLToPath(import.meta.url);
  const adapterSha256 = hash(await readFile(adapterModulePath));
  const saved = await readJsonWithBytes(input.publicationPath);
  const publication = await loadArchivePublication(input.publicationPath);
  assert.equal(saved.bytes.toString('utf8'), canonical(publication), 'Publication bytes changed');
  assert.equal(publication.preservation, 'complete-admitted');
  const transport = await archiveTransport(publication.transport);
  assert.equal(transport.implementation, publication.implementation);
  assert.equal(transport.protocolSha256, publication.protocolSha256);
  const admission = async () => assert.equal(
    await registrationFor(transport, publication.source), publication.registration,
    'Current source registration changed',
  );
  await admission();

  let original: { sha256: string; bytes: number } | null = null;
  let offset = 0;
  for (let pageNumber = 0; pageNumber < 50; pageNumber++) {
    const page = await transport.invoke('inspect', [
      publication.source.id, publication.generation,
      '--manifest-sha256', publication.manifestSha256,
      '--offset', String(offset), '--limit', '20',
      '--max-bytes', String(transport.config.maxStdoutBytes),
    ]);
    snapshot(page, publication);
    assert.equal(page['status'], 'complete');
    assert.equal(page['request_key'], publication.captureRequestKey);
    assert.equal(page['request_fingerprint'], publication.captureFingerprint);
    assert.equal(page['preservation'], publication.preservation);
    assert.equal(canonical(page['counts']), canonical(publication.counts));
    const docs = list(page['documents']);
    assert(docs.length <= 20 && offset + docs.length <= 1000);
    for (const raw of docs) {
      const doc = object(raw);
      if (doc['path'] !== selected) continue;
      assert.equal(original, null, 'Duplicate archived DOCX path');
      assert.equal(doc['status'], 'captured', 'DOCX was not captured');
      const archived = object(doc['original']);
      original = {
        sha256: digest(archived['sha256']),
        bytes: integer(archived['bytes'], 0, MAX_ORIGINAL),
      };
    }
    if (page['next_offset'] === null) break;
    const next = integer(page['next_offset'], offset + 1, 1000);
    assert.equal(next, offset + docs.length, 'Archive inventory skipped records');
    offset = next;
    assert(pageNumber < 49, 'Archive inventory page limit');
  }
  assert(original, 'Selected DOCX original missing from archive');
  assert.deepEqual(await boundedOriginal(input.recoveredOriginalPath), original,
    'Recovered DOCX does not match retained original');
  const { members, expandedBytes } = await scanRecoveredDocxPackage(
    input.recoveredOriginalPath, original.sha256, publication.transport.python,
  );
  assert.deepEqual(await boundedOriginal(input.recoveredOriginalPath), original,
    'Recovered DOCX changed during inventory');
  await admission();
  assert.equal(hash((await readJsonWithBytes(input.publicationPath)).bytes),
    hash(saved.bytes), 'Publication changed during inventory');
  assert.equal(hash(await readFile(adapterModulePath)), adapterSha256,
    'DOCX inventory adapter changed during operation');
  const receipt: ArchiveDocxMediaInventoryReceipt = {
    schema: 1, kind: 'temari-archive-docx-media-inventory',
    policy: 'pinned-docx-package-media-v1', workerSha256: hash(ZIP_INVENTORY),
    adapterSha256,
    sourceId: publication.source.id, generation: publication.generation,
    manifestSha256: publication.manifestSha256,
    publicationPath: input.publicationPath,
    publicationSha256: hash(saved.bytes), sourcePath: selected, original,
    members, expandedBytes, currentOriginal: 'not-checked',
    coverage: 'package-media-only', visualMeaning: 'not-evaluated',
  };
  const receiptPath = join(publication.task.directory,
    `archive-docx-media-inventory-${hash(canonical(receipt))}.json`);
  await publishJson(receiptPath, receipt);
  return { receipt, receiptPath };
}
