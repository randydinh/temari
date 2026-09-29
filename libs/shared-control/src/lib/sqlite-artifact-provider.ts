import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { WorkerEvidenceReference } from '@temari/contracts';
import type {
  Nx05ImmutableArtifactProvider,
  PutEvidenceRequest,
} from '@temari/runtime';

const MAX_BYTES = 16 * 1024 * 1024;
const KINDS = ['stdout', 'stderr', 'worker-result', 'verification', 'other'];
const hash = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');

function validateIdentity(runId: string, revision: string, kind: string): void {
  assert(
    typeof runId === 'string' &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId),
    'Artifact run ID is invalid.',
  );
  assert(
    typeof revision === 'string' &&
      revision.length > 0 &&
      revision.length <= 512,
    'Artifact revision is invalid.',
  );
  assert(KINDS.includes(kind), 'Artifact kind is invalid.');
}

function validateReference(reference: WorkerEvidenceReference): void {
  assert.deepEqual(
    Object.keys(reference).sort(),
    ['bytes', 'kind', 'revision', 'runId', 'schema', 'sha256'],
    'Artifact reference fields are invalid.',
  );
  assert.equal(reference.schema, 1);
  validateIdentity(reference.runId, reference.revision, reference.kind);
  assert.match(reference.sha256, /^[a-f0-9]{64}$/);
  assert(
    Number.isSafeInteger(reference.bytes) &&
      reference.bytes >= 0 &&
      reference.bytes <= MAX_BYTES,
    'Artifact byte count is invalid.',
  );
}

/** Local transactional artifact store for the NX05 service test stack. */
export class SqliteImmutableArtifactProvider implements Nx05ImmutableArtifactProvider {
  private constructor(private readonly database: DatabaseSync) {}

  static async open(path: string): Promise<SqliteImmutableArtifactProvider> {
    assert(isAbsolute(path), 'Artifact database path must be absolute.');
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const parent = await realpath(dirname(path));
    const parentStat = await lstat(parent);
    assert(
      parentStat.isDirectory() &&
        (process.platform === 'win32' || (parentStat.mode & 0o077) === 0),
      'Artifact database directory must be private.',
    );
    const databasePath = join(parent, basename(path));
    try {
      const prior = await lstat(databasePath);
      assert(
        prior.isFile() && !prior.isSymbolicLink(),
        'Artifact database must be a regular file.',
      );
      assert(
        process.platform === 'win32' || (prior.mode & 0o077) === 0,
        'Artifact database must be private.',
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const database = new DatabaseSync(databasePath);
    await chmod(databasePath, 0o600);
    database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    database.exec(`
      CREATE TABLE IF NOT EXISTS artifacts (
        sha256 TEXT PRIMARY KEY,
        bytes BLOB NOT NULL,
        byte_length INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS artifact_bindings (
        run_id TEXT NOT NULL,
        revision TEXT NOT NULL,
        kind TEXT NOT NULL,
        sha256 TEXT NOT NULL REFERENCES artifacts(sha256),
        PRIMARY KEY (run_id, revision, kind, sha256)
      );
    `);
    database.exec('PRAGMA foreign_keys = ON;');
    return new SqliteImmutableArtifactProvider(database);
  }

  async put(input: PutEvidenceRequest): Promise<WorkerEvidenceReference> {
    validateIdentity(input.runId, input.revision, input.kind);
    assert(
      typeof input.content === 'string' || input.content instanceof Uint8Array,
      'Artifact content is invalid.',
    );
    const bytes = Buffer.from(input.content);
    assert(bytes.length <= MAX_BYTES, 'Artifact exceeds the byte limit.');
    const sha256 = hash(bytes);
    this.database.exec('BEGIN IMMEDIATE;');
    try {
      const prior = this.database
        .prepare('SELECT bytes, byte_length FROM artifacts WHERE sha256 = ?')
        .get(sha256) as { bytes: Uint8Array; byte_length: number } | undefined;
      if (prior) {
        assert.equal(prior.byte_length, bytes.length, 'Artifact collision.');
        assert.equal(
          hash(prior.bytes),
          sha256,
          'Stored artifact hash changed.',
        );
        assert.deepEqual(
          Buffer.from(prior.bytes),
          bytes,
          'Artifact collision.',
        );
      } else {
        this.database
          .prepare(
            'INSERT INTO artifacts (sha256, bytes, byte_length) VALUES (?, ?, ?)',
          )
          .run(sha256, bytes, bytes.length);
      }
      this.database
        .prepare(
          'INSERT OR IGNORE INTO artifact_bindings (run_id, revision, kind, sha256) VALUES (?, ?, ?, ?)',
        )
        .run(input.runId, input.revision, input.kind, sha256);
      this.database.exec('COMMIT;');
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK;');
      throw error;
    }
    return {
      schema: 1,
      runId: input.runId,
      revision: input.revision,
      kind: input.kind,
      sha256,
      bytes: bytes.length,
    };
  }

  async load(reference: WorkerEvidenceReference): Promise<Uint8Array> {
    validateReference(reference);
    const row = this.database
      .prepare(
        `SELECT a.bytes, a.byte_length FROM artifacts a
         JOIN artifact_bindings b ON b.sha256 = a.sha256
         WHERE b.run_id = ? AND b.revision = ? AND b.kind = ? AND b.sha256 = ?`,
      )
      .get(
        reference.runId,
        reference.revision,
        reference.kind,
        reference.sha256,
      ) as { bytes: Uint8Array; byte_length: number } | undefined;
    assert(row, 'Artifact reference is absent.');
    const bytes = Buffer.from(row.bytes);
    assert.equal(row.byte_length, reference.bytes, 'Artifact size changed.');
    assert.equal(bytes.length, reference.bytes, 'Artifact bytes changed.');
    assert.equal(hash(bytes), reference.sha256, 'Artifact hash changed.');
    return bytes;
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
  }
}
