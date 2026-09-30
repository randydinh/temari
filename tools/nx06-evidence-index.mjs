import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sha40 = /^[a-f0-9]{40}$/;
const sha64 = /^[a-f0-9]{64}$/;
const compatibilityRows = Array.from(
  { length: 13 },
  (_, index) => `V41-${String(index + 1).padStart(2, '0')}`,
);
const lanes = [
  ['trunk-head-regression', 'wp4-regression.png'],
  ['serial-host', 'wp4-serial-host.png'],
  ['primary-host', 'wp4-primary-host.png'],
  ['second-host', 'wp4-second-host.png'],
  ['capability-gap', 'wp4-capability-gap.png'],
  ['retained-record', 'wp4-retained-record.png'],
  ['rollback', 'wp4-rollback.png'],
  ['observation', 'wp4-observation.png'],
  ['folder-disposition', 'wp4-folder-disposition.png'],
  ['final-hermetic', 'wp4-final-hermetic.png'],
];
const externalGates = [
  'finalHeadPackageAndCi',
  'runtimeAndProvenance',
  'hostCapabilityProof',
  'independentQa',
  'privacyAndOverlay',
  'sharedService',
  'archonIfUsed',
  'secondHost',
  'knownGoodV41Install',
  'retainedRecord',
  'observation',
  'performance',
  'independentReview',
  'operatorCutoverApproval',
];

const { values } = parseArgs({
  options: {
    rehearsal: { type: 'string' },
    'expected-rehearsal-sha256': { type: 'string' },
    'expected-candidate-sha': { type: 'string' },
  },
});
assert(isAbsolute(values.rehearsal ?? ''), 'Pass an absolute --rehearsal path');
assert(
  sha64.test(values['expected-rehearsal-sha256'] ?? ''),
  'Pass an externally retained --expected-rehearsal-sha256',
);
assert(
  sha40.test(values['expected-candidate-sha'] ?? ''),
  'Pass an independently selected --expected-candidate-sha',
);
const rehearsalPath = resolve(values.rehearsal);
const rehearsalBytes = await readFile(rehearsalPath);
assert.equal(
  sha256(rehearsalBytes),
  values['expected-rehearsal-sha256'],
  'Rehearsal bytes changed after digest selection',
);
const report = JSON.parse(rehearsalBytes);
assert.equal(report.schemaVersion, 1, 'Unsupported rehearsal schema');
assert.equal(
  report.candidateSha,
  values['expected-candidate-sha'],
  'Rehearsal candidate differs from independently selected head',
);
for (const name of [
  'publicManifestSha256',
  'previousManifestSha256',
  'publicTreeSha256',
  'previousTreeSha256',
]) {
  assert(
    sha64.test(report.input?.[name] ?? ''),
    `Rehearsal lacks input.${name}`,
  );
}

// This is an index of proof still due. A writable rehearsal report cannot
// attest its own release gates, row proofs, or operator authorization.
const pending = () => ({ status: 'PENDING', evidence: [] });
const index = {
  schemaVersion: 1,
  candidateSha: report.candidateSha,
  sourceRehearsal: {
    path: rehearsalPath,
    sha256: sha256(rehearsalBytes),
    reportedLocalPreparatoryRehearsal:
      report.gates?.localPreparatoryRehearsal ?? 'NOT VERIFIED',
  },
  packageIdentity: {
    publicManifestSha256: report.input.publicManifestSha256,
    previousManifestSha256: report.input.previousManifestSha256,
    publicTreeSha256: report.input.publicTreeSha256,
    previousTreeSha256: report.input.previousTreeSha256,
  },
  compatibilityRows: Object.fromEntries(
    compatibilityRows.map((id) => [id, pending()]),
  ),
  liveLanes: lanes.map(([name, screenshot], index) => ({
    number: index + 1,
    name,
    screenshot,
    ...pending(),
  })),
  externalGates: Object.fromEntries(externalGates.map((id) => [id, pending()])),
  release: {
    status: 'BLOCKED',
    reason: 'candidate-specific-proofs-and-operator-approval-pending',
  },
};
process.stdout.write(`${JSON.stringify(index, null, 2)}\n`);
