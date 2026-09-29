import { createHash } from 'node:crypto';

import { deriveQaEvidenceFindings } from '../libs/temari-core/src/index.ts';

const MAX_INPUT_BYTES = 256 * 1024;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

const chunks = [];
let bytes = 0;
for await (const chunk of process.stdin) {
  bytes += chunk.byteLength;
  if (bytes > MAX_INPUT_BYTES)
    throw new Error('Evaluator input exceeds 256 KiB.');
  chunks.push(chunk);
}

const inputBytes = Buffer.concat(chunks);
const input = JSON.parse(inputBytes.toString('utf8'));
const findings = deriveQaEvidenceFindings(input);
process.stdout.write(
  `${JSON.stringify({
    schemaVersion: 1,
    evaluatorId: 'local-fresh-qa-evaluator-v1',
    inputSha256: sha256(inputBytes),
    findings,
  })}\n`,
);
