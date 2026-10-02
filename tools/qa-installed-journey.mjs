import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  checkPublicEntryArtifact,
  manifestSha256,
  packagePublicEntries,
} from './public-entry-runtime.mjs';
import { syntheticQaRequest } from './fixtures/qa-synthetic.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const root = await mkdtemp(join(tmpdir(), 'temari-qa-installed-'));
const build = join(root, 'build');
const relocation = join(root, 'relocated');
await mkdir(build);
await mkdir(relocation);
const manifest = await packagePublicEntries(join(build, 'artifact'));
const artifact = join(relocation, 'artifact');
await cp(join(build, 'artifact'), artifact, { recursive: true });
const manifestDigest = manifestSha256(manifest);
await checkPublicEntryArtifact(artifact, manifestDigest);
const loader = join(relocation, 'deny-source-loader.mjs');
await writeFile(
  loader,
  `export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  if (result.url.startsWith(${JSON.stringify(new URL('../', import.meta.url).href)})) throw Error('Source checkout import refused');
  return result;
}\n`,
);

const candidate = join(relocation, 'candidate');
await mkdir(candidate);
await writeFile(join(candidate, 'product.txt'), 'synthetic fixture\n');
const request = syntheticQaRequest(candidate, join(relocation, 'run'));
await mkdir(request.invocation.evidenceRoot, { recursive: true });
const requestPath = join(relocation, 'request.json');
const requestBytes = Buffer.from(`${JSON.stringify(request)}\n`);
await writeFile(requestPath, requestBytes);
const requestDigest = digest(requestBytes);
const args = [
  '--experimental-loader',
  pathToFileURL(loader).href,
  join(artifact, 'bin/temari.mjs'),
  'qa',
  '--request',
  requestPath,
  '--expected-request-sha256',
  requestDigest,
  '--expected-manifest-sha256',
  manifestDigest,
];
const invocation = await new Promise((resolve, reject) => {
  execFile(
    process.execPath,
    args,
    {
      cwd: relocation,
      env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
    },
    (error, stdout, stderr) => {
      if (error && (error.killed || typeof error.code !== 'number'))
        reject(error);
      else resolve({ code: error ? Number(error.code) : 0, stdout, stderr });
    },
  );
});
assert.equal(invocation.code, 1, invocation.stderr);
const result = JSON.parse(invocation.stdout.trim().split('\n').at(-1));
assert.equal(result.route.route, 'qa-review');
assert.equal(result.evaluator.decision.verdict, 'REVISE');
assert.equal(result.record.evaluationRounds.length, 1);
assert.deepEqual(result.record.externalWriteReceipts, []);
assert.equal(result.qaDisposition.disposition, 'BlockedOrIncomplete');
assert.equal(result.delivery.requestSha256, requestDigest);
assert.equal(result.delivery.evaluatorLaunch, 'packaged-local-process');
assert.equal(result.guidance.playbookId, 'ticket-acceptance-v1');
assert.equal(result.guidance.projectVerifier.status, 'missing-project-profile');
assert.equal(result.guidance.execution, 'not-observed');
assert.deepEqual(
  JSON.parse(await readFile(join(relocation, 'run/config/qa-result.json'))),
  result,
);
const evidence = {
  candidateSha: manifest.source.revision,
  dirty: manifest.source.dirty,
  artifact,
  manifestSha256: manifestDigest,
  request: requestPath,
  requestSha256: requestDigest,
  command: [process.execPath, ...args],
  exitCode: invocation.code,
  evaluatorVerdict: result.evaluator.decision.verdict,
  qaDisposition: result.qaDisposition.disposition,
  evaluatorRounds: result.record.evaluationRounds.length,
  guidance: {
    playbookId: result.guidance.playbookId,
    playbookSha256: result.guidance.playbook.sha256,
    evidenceSkillSha256: result.guidance.evidenceSkill.sha256,
    projectVerifierStatus: result.guidance.projectVerifier.status,
    execution: result.guidance.execution,
  },
  evaluator: result.evaluator,
  retainedResult: join(relocation, 'run/config/qa-result.json'),
};
await writeFile(
  join(root, 'journey-evidence.json'),
  `${JSON.stringify(evidence, null, 2)}\n`,
);
process.stdout.write(
  `${JSON.stringify({ evidencePath: join(root, 'journey-evidence.json'), ...evidence })}\n`,
);
