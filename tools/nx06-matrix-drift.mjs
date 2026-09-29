import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const expectedIds = Array.from(
  { length: 13 },
  (_, index) => `V41-${String(index + 1).padStart(2, '0')}`,
);

async function treeSha(root) {
  const entries = [];
  async function visit(path, name) {
    const stat = await lstat(path);
    assert(!stat.isSymbolicLink(), `Symlink in artifact: ${path}`);
    if (stat.isDirectory()) {
      for (const child of (await readdir(path)).sort())
        await visit(join(path, child), name ? `${name}/${child}` : child);
      return;
    }
    assert(stat.isFile(), `Nonregular artifact entry: ${path}`);
    const bytes = await readFile(path);
    entries.push({
      path: name,
      sha256: sha(bytes),
      bytes: bytes.length,
      mode: stat.mode & 0o777,
    });
  }
  await visit(root, '');
  return sha(Buffer.from(JSON.stringify(entries)));
}

const { values } = parseArgs({
  options: {
    matrix: { type: 'string' },
    rehearsal: { type: 'string' },
    release: { type: 'boolean', default: false },
  },
});
assert(values.matrix && values.rehearsal, 'Pass --matrix and --rehearsal');
const matrix = await readFile(values.matrix, 'utf8');
const report = JSON.parse(await readFile(values.rehearsal, 'utf8'));
const rows = matrix
  .split('\n')
  .filter((line) => /^\| V41-\d\d \|/.test(line))
  .map((line) =>
    line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim()),
  );
assert.deepEqual(
  rows.map((row) => row[0]),
  expectedIds,
  'Matrix row set or order drifted',
);
for (const row of rows) {
  assert.equal(row.length, 7, `${row[0]} has changed columns`);
  for (const [index, cell] of row.entries())
    assert(
      cell && !/^(?:tbd|todo|none)$/i.test(cell),
      `${row[0]} is missing column ${index}`,
    );
}
const sourceRevision = matrix.match(
  /Portable v4\.1 source revision: `([a-f0-9]{40})`/i,
)?.[1];
assert(sourceRevision, 'Matrix lacks the v4.1 source revision');
const publicRoot = report.input.publicArtifact;
const previousRoot = report.input.previousArtifact;
const publicBytes = await readFile(
  join(publicRoot, 'public-entry-manifest.json'),
);
const previousBytes = await readFile(
  join(previousRoot, '.temari-distribution.json'),
);
assert.equal(sha(publicBytes), report.input.publicManifestSha256);
assert.equal(sha(previousBytes), report.input.previousManifestSha256);
assert.equal(await treeSha(publicRoot), report.input.publicTreeSha256);
assert.equal(await treeSha(previousRoot), report.input.previousTreeSha256);
const publicManifest = JSON.parse(publicBytes);
const previousManifest = JSON.parse(previousBytes);
assert.equal(publicManifest.source.revision, report.candidateSha);
assert.equal(publicManifest.source.dirty, false);
assert.equal(previousManifest.sourceRevision, sourceRevision);
assert.deepEqual(publicManifest.entries, ['temari', 'poteto-mode', 'closeout']);
assert.equal(report.rollback.beforeSha256, report.input.publicTreeSha256);
assert.equal(
  report.rollback.afterSha256,
  report.rollback.previousProjectionSha256,
);
assert.equal(report.gates.localPreparatoryRehearsal, 'PASS');
// This checker validates structure and local artifact consistency only. The
// rehearsal report is writable JSON, so its row and external-gate claims cannot
// establish independent release evidence.
const missingProof = expectedIds;
const openGates = ['qa', 'privacy', 'sharedService', 'secondHost', 'cutover'];
console.log(
  JSON.stringify({
    candidateSha: report.candidateSha,
    matrixRows: rows.length,
    inventory: 'PASS',
    structure: 'PASS',
    release: 'BLOCKED',
    reason: 'external-proof-not-verified',
    missingProof,
    openGates,
  }),
);
if (values.release) process.exitCode = 2;
