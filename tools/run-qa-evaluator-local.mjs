import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createQaEvaluationInputFromDraft,
  createQaReviewRecord,
  deriveQaEvaluatorDecision,
  deriveQaDisposition,
  assertQaReviewRecord,
} from '../libs/temari-core/src/index.ts';
import { FileEvidenceStore } from '../libs/runtime/src/index.ts';

const MAX_OUTPUT_BYTES = 256 * 1024;
const workspace = fileURLToPath(new URL('..', import.meta.url));

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function optionsFrom(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      !['--draft', '--evidence-root'].includes(flag) ||
      !value ||
      values.has(flag)
    ) {
      throw new Error(
        'Usage: run-qa-evaluator-local.mjs --draft ABSOLUTE_JSON --evidence-root ABSOLUTE_DIRECTORY',
      );
    }
    values.set(flag, value);
  }
  if (
    values.size !== 2 ||
    !isAbsolute(values.get('--draft')) ||
    !isAbsolute(values.get('--evidence-root'))
  ) {
    throw new Error('Draft and evidence-root must be absolute paths.');
  }
  return {
    draftPath: values.get('--draft'),
    evidenceRoot: values.get('--evidence-root'),
  };
}

function invokeWorker(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [...process.execArgv, 'tools/qa-evaluator-worker.mjs'],
      {
        cwd: workspace,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, NODE_OPTIONS: '' },
      },
    );
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    child.stdout.on('data', (chunk) => {
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.byteLength > MAX_OUTPUT_BYTES) child.kill('SIGKILL');
    });
    child.stderr.on('data', (chunk) => {
      stderr = Buffer.concat([stderr, chunk]);
      if (stderr.byteLength > MAX_OUTPUT_BYTES) child.kill('SIGKILL');
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0)
        return reject(
          new Error(
            `Evaluator process failed: ${stderr.toString('utf8').slice(0, 512)}`,
          ),
        );
      try {
        const output = JSON.parse(stdout.toString('utf8'));
        assert.equal(output.schemaVersion, 1);
        assert.equal(output.evaluatorId, 'local-fresh-qa-evaluator-v1');
        assert.equal(output.inputSha256, sha256(input));
        assert(Array.isArray(output.findings));
        resolve({ output, pid: child.pid });
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(input);
  });
}

function behaviorResult(draft) {
  const required = draft.scenarios.filter(
    (scenario) => scenario.obligation === 'Required',
  );
  if (required.some((scenario) => scenario.result === 'Failed'))
    return 'failed';
  if (required.some((scenario) => scenario.result !== 'Passed'))
    return 'blocked';
  return 'passed';
}

const options = optionsFrom(process.argv.slice(2));
const draft = JSON.parse(await readFile(options.draftPath, 'utf8'));
const evaluationInput = createQaEvaluationInputFromDraft(draft);
const evidence = await FileEvidenceStore.openExisting(options.evidenceRoot);
await Promise.all(
  evaluationInput.canonicalEvidenceRefs.map((reference) =>
    evidence.loadPortable(reference),
  ),
);
const inputBytes = Buffer.from(JSON.stringify(evaluationInput));
const startedAt = new Date().toISOString();
const { output, pid } = await invokeWorker(inputBytes);
const endedAt = new Date().toISOString();
assert(Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid);
const evaluatorEvidence = await evidence.put({
  runId: draft.assignment.assignmentId,
  revision: draft.assignment.candidateRef ?? draft.reviewRevision,
  kind: 'verification',
  content: JSON.stringify(output),
});
const decision = deriveQaEvaluatorDecision({
  authorId: draft.authorId,
  evaluatorId: output.evaluatorId,
  freshContext: 'proven',
  round: 1,
  findings: output.findings,
});
const disposition = deriveQaDisposition({
  scope: 'full',
  evaluatorVerdict: decision.verdict,
  behaviorResult: behaviorResult(draft),
});
const record = createQaReviewRecord({
  ...draft,
  evaluationRounds: [
    {
      round: 1,
      evaluatorId: output.evaluatorId,
      freshContextAttestation: `Independent local evaluator process ${pid} received only the frozen review input.`,
      verdict: decision.verdict,
      findingIds: output.findings.map((finding) => finding.findingId),
      evidenceRefs: [
        {
          schema: evaluatorEvidence.schema,
          runId: evaluatorEvidence.runId,
          revision: evaluatorEvidence.revision,
          kind: evaluatorEvidence.kind,
          sha256: evaluatorEvidence.sha256,
          bytes: evaluatorEvidence.bytes,
        },
      ],
    },
  ],
  qaDisposition: disposition.disposition,
  dispositionBasis: decision.reason,
  externalWriteReceipts: [],
});
assertQaReviewRecord(record);
process.stdout.write(
  `${JSON.stringify({
    schemaVersion: 1,
    evaluator: {
      id: output.evaluatorId,
      pid,
      startedAt,
      endedAt,
      inputSha256: output.inputSha256,
    },
    decision,
    qaDisposition: disposition,
    record,
  })}\n`,
);
