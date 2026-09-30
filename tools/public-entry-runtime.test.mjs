import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  checkPublicEntryArtifact,
  manifestSha256,
  packagePublicEntries,
} from './public-entry-runtime.mjs';
import { assertSourceEvidence } from '../packages/workflow-runtime/host/source.mjs';
import { syntheticQaRequest } from './fixtures/qa-synthetic.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const packager = fileURLToPath(
  new URL('./public-entry-runtime.mjs', import.meta.url),
);
let buildRoot;
let output;
let manifest;

before(async () => {
  buildRoot = await mkdtemp(join(tmpdir(), 'temari public-entry-build-'));
  output = join(buildRoot, 'artifact');
  manifest = await packagePublicEntries(output);
});

after(async () => {
  if (buildRoot) await rm(buildRoot, { recursive: true, force: true });
});

async function childResult(args, expectedCode = 0, env = {}) {
  const result = await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      args,
      {
        cwd: buildRoot,
        env: { ...process.env, ...env, NODE_OPTIONS: '', NODE_PATH: '' },
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
  assert.equal(result.code, expectedCode, `${result.stderr}\n${result.stdout}`);
  return result;
}

async function child(args, expectedCode = 0) {
  const result = await childResult(args, expectedCode);
  return JSON.parse(result.stdout);
}

function request(entry, overrides = {}) {
  return {
    schemaVersion: 1,
    entry,
    route: 'full-playbook',
    profile: 'feature-v1',
    obligations: {
      workType: 'feature',
      delegation: 'required',
      review: 'independent',
      evidence: 'revision-bound',
      delivery: 'pull-request',
    },
    ...overrides,
  };
}

test('packages an isolated relocated outer bundle with three current public entries', async () => {
  assert.deepEqual(
    await checkPublicEntryArtifact(output, manifestSha256(manifest)),
    manifest,
  );
  assert.deepEqual(manifest.entries, ['temari', 'poteto-mode', 'closeout']);
  assert(!JSON.stringify(manifest).includes(repository));

  const relocatedRoot = await mkdtemp(
    join(tmpdir(), 'temari public-entry-relocated-'),
  );
  try {
    const artifact = join(relocatedRoot, 'artifact');
    await cp(output, artifact, { recursive: true });
    assert.deepEqual(
      await checkPublicEntryArtifact(artifact, manifestSha256(manifest)),
      manifest,
    );
    assert.deepEqual(
      await child([
        packager,
        'check',
        '--artifact',
        artifact,
        '--expected-manifest-sha256',
        manifestSha256(manifest),
      ]),
      manifest,
    );
    const policy = await child([join(artifact, 'bin/temari.mjs'), 'policy']);
    assert.equal(policy.status, 'described');
    assert.equal(policy.supportedProfile, 'lightweight-engineering-v1');
  } finally {
    await rm(relocatedRoot, { recursive: true, force: true });
  }
});

test('relocated QA entry runs the packaged evaluator without source-checkout access', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari qa-relocated-'));
  try {
    const artifact = join(root, 'artifact');
    const candidate = join(root, 'candidate');
    await cp(output, artifact, { recursive: true });
    const loader = join(root, 'deny-source-loader.mjs');
    await writeFile(
      loader,
      `export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  if (result.url.startsWith(${JSON.stringify(pathToFileURL(repository).href)})) throw Error('Source checkout import refused');
  return result;
}\n`,
    );
    const denied = await childResult(
      [
        '--experimental-loader',
        pathToFileURL(loader).href,
        '--input-type=module',
        '-e',
        `import(${JSON.stringify(pathToFileURL(packager).href)})`,
      ],
      1,
    );
    assert.match(denied.stderr, /Source checkout import refused/);
    await mkdir(candidate);
    await writeFile(join(candidate, 'product.txt'), 'synthetic fixture\n');
    const base = syntheticQaRequest(candidate, join(root, 'run'));
    await mkdir(base.invocation.evidenceRoot, { recursive: true });
    const invoke = async (input, name, expectedCode = 1) => {
      const path = join(root, `${name}.json`);
      const bytes = Buffer.from(`${JSON.stringify(input)}\n`);
      await writeFile(path, bytes);
      return childResult(
        [
          '--experimental-loader',
          pathToFileURL(loader).href,
          join(artifact, 'bin/temari.mjs'),
          'qa',
          '--request',
          path,
          '--expected-request-sha256',
          createHash('sha256').update(bytes).digest('hex'),
          '--expected-manifest-sha256',
          manifestSha256(manifest),
        ],
        expectedCode,
      );
    };
    const result = await invoke(base, 'valid');
    const qaOutput = JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.equal(qaOutput.route.route, 'qa-review');
    assert.equal(qaOutput.guidance.playbookId, 'ticket-acceptance-v1');
    assert.match(qaOutput.guidance.playbook.text, /pinned product decision/);
    assert.match(qaOutput.guidance.evidenceSkill.text, /QA/);
    assert.equal(
      qaOutput.guidance.projectVerifier.status,
      'missing-project-profile',
    );
    assert.equal(qaOutput.guidance.execution, 'not-observed');
    assert.deepEqual(qaOutput.plan.stages, [
      'investigate',
      'plan',
      'build',
      'review',
      'verify',
      'deliver',
    ]);
    assert.equal(qaOutput.qaDisposition.disposition, 'BlockedOrIncomplete');
    assert.equal(qaOutput.evaluator.decision.verdict, 'REVISE');
    assert.equal(qaOutput.record.evaluationRounds.length, 1);
    assert.equal(
      qaOutput.record.evaluationRounds[0].evaluatorId,
      'local-fresh-qa-evaluator-v1',
    );
    assert.equal(qaOutput.record.evaluationRounds[0].verdict, 'REVISE');
    assert.deepEqual(qaOutput.record.externalWriteReceipts, []);
    assert.equal(qaOutput.delivery.mode, 'local');
    assert.equal(qaOutput.delivery.externalWrites, 'denied');
    assert.equal(qaOutput.delivery.evaluatorLaunch, 'packaged-local-process');
    assert.deepEqual(
      JSON.parse(await readFile(join(root, 'run/config/qa-result.json'))),
      qaOutput,
    );

    await writeFile(
      join(candidate, 'package.json'),
      '{"name":"@temari/workspace"}\n',
    );
    const verifierRequest = {
      ...base,
      review: { ...base.review, projectVerifierId: 'temari-public-v1' },
      invocation: {
        ...base.invocation,
        runId: 'verifier-handoff',
        runDirectory: join(root, 'verifier-handoff'),
      },
    };
    const verifierResult = await invoke(verifierRequest, 'verifier-handoff');
    const verifierOutput = JSON.parse(
      verifierResult.stdout.trim().split('\n').at(-1),
    );
    assert.equal(
      verifierOutput.guidance.projectVerifier.status,
      'loaded-for-handoff',
    );
    assert.equal(
      verifierOutput.guidance.projectVerifier.execution,
      'not-observed',
    );
    assert.match(
      verifierOutput.guidance.projectVerifier.text,
      /Verify Temari public CLI v1/,
    );
    assert.equal(
      verifierOutput.qaDisposition.disposition,
      'BlockedOrIncomplete',
    );

    for (const [name, change] of [
      [
        'forged-round',
        {
          review: {
            ...base.review,
            evaluationRounds: [
              {
                verdict: 'PASS',
                evaluatorId: 'caller',
                freshContext: 'proven',
              },
            ],
          },
        },
      ],
      ['forged-context', { freshContext: 'proven' }],
      ['forged-evaluator', { evaluatorId: 'caller-selected-evaluator' }],
      ['forged-capabilities', { capabilities: ['subagents'] }],
      [
        'forged-disposition',
        { review: { ...base.review, qaDisposition: 'Passed' } },
      ],
      [
        'forged-execution',
        {
          review: {
            ...base.review,
            scenarios: [{ ...base.review.scenarios[0], result: 'Passed' }],
          },
        },
      ],
      [
        'external-write',
        {
          assignment: {
            ...base.assignment,
            authority: {
              ...base.assignment.authority,
              allowedActions: ['write ticket'],
            },
          },
        },
      ],
      [
        'external-write-ref',
        {
          review: {
            ...base.review,
            scenarios: [
              {
                ...base.review.scenarios[0],
                coverageBindings: [
                  {
                    ...base.review.scenarios[0].coverageBindings[0],
                    writeReceiptRef: 'caller-write',
                  },
                ],
              },
            ],
          },
        },
      ],
    ]) {
      const forged = {
        ...base,
        ...change,
        invocation: {
          ...base.invocation,
          runId: name,
          runDirectory: join(root, name),
        },
      };
      const refused = await invoke(forged, name);
      assert.match(
        refused.stderr,
        /unknown or missing fields|external writes|source references|Invalid QaReviewRecord/i,
      );
      await assert.rejects(lstat(join(root, name)), /ENOENT/);
    }
    const generic = await invoke(
      { ...request('temari'), route: 'qa-review' },
      'generic',
    );
    assert.match(generic.stderr, /unknown or missing fields|QA requires/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('relocated public bundle routes workers and observes host-owned local processes', async (t) => {
  if (process.platform === 'win32')
    return t.skip('The fake Codex fixture is a POSIX executable script.');
  const root = await mkdtemp(join(tmpdir(), 'temari public-parallel-'));
  try {
    const artifact = join(root, 'artifact');
    await cp(output, artifact, { recursive: true });
    await checkPublicEntryArtifact(artifact, manifestSha256(manifest));
    const repo = join(root, 'repo');
    execFileSync('git', ['init', '-q', repo]);
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@localhost'], {
      cwd: repo,
    });
    await writeFile(join(repo, 'README.md'), 'base\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: repo });
    const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repo,
      encoding: 'utf8',
    }).trim();
    const executable = join(root, 'fake-codex');
    await writeFile(
      executable,
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const final = args[args.indexOf('--output-last-message') + 1];
const sandbox = args[args.indexOf('--sandbox') + 1];
let prompt = '';
process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', () => {
  const id = prompt.match(/Goal: ([A-Za-z]+)/)?.[1] ?? 'unknown';
  setTimeout(() => {
    if (sandbox === 'workspace-write') fs.writeFileSync(id + '.txt', id + '\\n');
    fs.writeFileSync(final, JSON.stringify({status:'PASS',summary:id}));
  }, 150);
});

`,
    );
    await chmod(executable, 0o755);
    const brief = (id) => ({
      goal: id,
      context: 'relocated bundle test',
      scope: id,
      acceptanceCriteria: ['produce result'],
      verificationCommand: null,
      reportFormat: 'json',
      forbiddenActions: ['stay in scope'],
    });
    const readRequest = join(root, 'read-request.json');
    await writeFile(
      readRequest,
      JSON.stringify({
        runId: 'read-run',
        revision: 'base',
        workspaceRoot: repo,
        evidenceRoot: join(root, 'evidence'),
        maxConcurrency: 2,
        executable,
        timeoutMs: 5000,
        assignments: [
          {
            id: 'review',
            role: 'reviewer',
            required: true,
            brief: brief('review'),
          },
        ],
      }),
    );
    const runner = join(artifact, 'bin/codex-parallel.mjs');
    const read = await child([runner, readRequest]);
    assert.equal(read.route, 'read-only');
    assert.equal(read.status, 'PASS');
    assert.equal(
      JSON.parse(await readFile(read.receiptPath, 'utf8')).status,
      'PASS',
    );
    const invalidRequest = join(root, 'invalid-request.json');
    await writeFile(
      invalidRequest,
      JSON.stringify({
        ...JSON.parse(await readFile(readRequest, 'utf8')),
        runId: 'invalid-run',
        mode: 'write',
      }),
    );
    const rejected = await childResult([runner, invalidRequest], 1);
    assert.match(rejected.stderr, /mode is unsupported/);
    await assert.rejects(lstat(join(root, 'evidence', 'invalid-run')));

    const writeRequest = join(root, 'write-request.json');
    await writeFile(
      writeRequest,
      JSON.stringify({
        runId: 'write-run',
        sourceRepo: repo,
        baseCommit,
        evidenceRoot: join(root, 'evidence'),
        maxConcurrency: 2,
        executable,
        timeoutMs: 5000,
        verify: [
          {
            program: process.execPath,
            args: [
              '-e',
              "const fs=require('fs');if(!fs.existsSync('alpha.txt')||!fs.existsSync('beta.txt'))process.exit(5)",
            ],
          },
        ],
        assignments: ['alpha', 'beta'].map((id) => ({
          worker: { id, role: 'implementer', required: true, brief: brief(id) },
          owns: [{ kind: 'file', path: `${id}.txt` }],
        })),
      }),
    );
    const write = await child([runner, writeRequest]);
    assert.equal(write.route, 'write');
    assert.equal(write.status, 'PASS');
    assert.equal(
      await readFile(join(write.integrationPath, 'alpha.txt'), 'utf8'),
      'alpha\n',
    );
    assert.equal(
      await readFile(join(write.integrationPath, 'beta.txt'), 'utf8'),
      'beta\n',
    );
    assert.equal(
      execFileSync('git', ['status', '--porcelain'], {
        cwd: repo,
        encoding: 'utf8',
      }),
      '',
    );
    assert.equal(
      execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repo,
        encoding: 'utf8',
      }).trim(),
      baseCommit,
    );
    const receipt = JSON.parse(await readFile(write.receiptPath, 'utf8'));
    assert.equal(receipt.workerReceipt.peakConcurrency, 2);
    assert.equal(receipt.verification[0].code, 0);

    const {
      runLocalHostWorker,
      runLocalFeatureWorkerPair,
      verifyLocalFeatureWorkerPair,
    } = await import(
      pathToFileURL(join(artifact, 'host/local-worker.mjs')).href
    );
    const hostInput = {
      runId: 'host-review-run',
      revision: 'base',
      candidateRoot: repo,
      evidenceRoot: join(root, 'evidence'),
      baseCommit,
      executable,
      timeoutMs: 15000,
      assignment: {
        id: 'host-reviewer',
        role: 'reviewer',
        required: true,
        brief: brief('review'),
      },
    };
    const observedReview = await runLocalHostWorker(hostInput);
    assert.equal(observedReview.status, 'PASS');
    assert.equal(observedReview.route, 'read-only');
    assert.equal(observedReview.candidate.baseCommit, baseCommit);
    assert.notEqual(observedReview.worker.pid, process.pid);
    assert.equal(
      observedReview.receipt.sha256,
      createHash('sha256')
        .update(await readFile(observedReview.receipt.path))
        .digest('hex'),
    );
    assert.equal(
      observedReview.observationSha256,
      createHash('sha256')
        .update(await readFile(observedReview.observationPath))
        .digest('hex'),
    );
    await assert.rejects(
      runLocalHostWorker({
        ...hostInput,
        runId: 'spoofed-host-run',
        receiptPath: write.receiptPath,
      }),
      /Unexpected or missing JSON fields/,
    );
    await assert.rejects(lstat(join(root, 'evidence', 'spoofed-host-run')));
    await assert.rejects(
      runLocalHostWorker({
        ...hostInput,
        runId: 'invalid/revision',
        revision: 'base',
      }),
      /runId must be a safe identifier/,
    );
    await assert.rejects(
      runLocalHostWorker({
        ...hostInput,
        runId: 'nested-host-run',
        evidenceRoot: repo,
      }),
      /Candidate and worker evidence must be disjoint/,
    );
    await assert.rejects(lstat(join(repo, 'nested-host-run')));
    await writeFile(join(repo, 'untracked.txt'), 'dirty\n');
    await assert.rejects(
      runLocalHostWorker({ ...hostInput, runId: 'dirty-host-run' }),
      /Candidate must be clean/,
    );
    await unlink(join(repo, 'untracked.txt'));
    await assert.rejects(lstat(join(root, 'evidence', 'dirty-host-run')));

    const observedWrite = await runLocalHostWorker({
      ...hostInput,
      runId: 'host-write-run',
      assignment: {
        id: 'host-builder',
        role: 'implementer',
        required: true,
        brief: brief('gamma'),
      },
      owns: [{ kind: 'file', path: 'gamma.txt' }],
      verify: [
        {
          program: process.execPath,
          args: [
            '-e',
            "if(!require('fs').existsSync('gamma.txt'))process.exit(5)",
          ],
        },
      ],
    });
    assert.equal(observedWrite.status, 'PASS');
    assert.equal(observedWrite.route, 'write');
    assert.notEqual(observedWrite.worker.pid, observedReview.worker.pid);
    assert.match(observedWrite.integratedCommit, /^[0-9a-f]{40}$/);
    assert.equal(
      await readFile(join(observedWrite.integrationPath, 'gamma.txt'), 'utf8'),
      'gamma\n',
    );
    assert.equal(
      execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repo,
        encoding: 'utf8',
      }).trim(),
      baseCommit,
    );

    const pairInput = {
      runId: 'feature-pair',
      revision: 'feature-request',
      candidateRoot: repo,
      evidenceRoot: join(root, 'evidence'),
      baseCommit,
      executable,
      timeoutMs: 5000,
      builder: {
        id: 'pair-builder',
        role: 'implementer',
        required: true,
        brief: brief('delta'),
      },
      owns: [{ kind: 'file', path: 'delta.txt' }],
      verify: [
        {
          program: process.execPath,
          args: [
            '-e',
            "if(!require('fs').existsSync('delta.txt'))process.exit(5)",
          ],
        },
      ],
      reviewer: {
        id: 'pair-reviewer',
        role: 'reviewer',
        required: true,
        brief: brief('review'),
      },
    };
    const pair = await runLocalFeatureWorkerPair(pairInput);
    assert.equal(pair.status, 'PASS');
    assert.notEqual(pair.builder.pid, pair.reviewer.pid);
    assert.equal(pair.reviewer.candidate.baseCommit, pair.integratedCommit);
    assert.equal(
      pair.reviewer.candidate.root,
      await realpath(
        join(
          root,
          'evidence',
          'feature-pair',
          'build',
          'feature-pair-build',
          'integration',
        ),
      ),
    );
    assert.equal(
      pair.reportSha256,
      createHash('sha256')
        .update(await readFile(pair.reportPath))
        .digest('hex'),
    );
    assert.equal(
      execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repo,
        encoding: 'utf8',
      }).trim(),
      baseCommit,
    );

    await symlink(executable, join(root, 'codex'));
    const publicWorkerRequest = {
      schemaVersion: 1,
      entry: 'temari',
      ...pairInput,
      runId: 'public-feature-pair',
    };
    delete publicWorkerRequest.executable;
    const publicWorkerBytes = Buffer.from(JSON.stringify(publicWorkerRequest));
    const publicWorkerPath = join(root, 'public-workers.json');
    await writeFile(publicWorkerPath, publicWorkerBytes);
    const publicWorkerArgs = [
      join(artifact, 'bin/temari.mjs'),
      'run-workers',
      '--request',
      publicWorkerPath,
      '--expected-request-sha256',
      createHash('sha256').update(publicWorkerBytes).digest('hex'),
      '--expected-manifest-sha256',
      manifestSha256(manifest),
    ];
    const publicResult = JSON.parse(
      (
        await childResult(publicWorkerArgs, 0, {
          PATH: `${root}:${process.env.PATH}`,
        })
      ).stdout,
    );
    assert.equal(publicResult.status, 'PASS');
    assert.deepEqual(publicResult.hostBinding, {
      entry: 'temari',
      policyId: 'temari-public-feature-v2',
      requestSha256: createHash('sha256')
        .update(publicWorkerBytes)
        .digest('hex'),
      manifestSha256: manifestSha256(manifest),
    });
    assert.notEqual(publicResult.builder.pid, publicResult.reviewer.pid);
    assert.equal(
      publicResult.reviewer.candidate.baseCommit,
      publicResult.integratedCommit,
    );
    const retainedPair = {
      runId: publicWorkerRequest.runId,
      revision: publicWorkerRequest.revision,
      candidateRoot: repo,
      evidenceRoot: join(root, 'evidence'),
      baseCommit,
      hostBinding: publicResult.hostBinding,
      reportSha256: publicResult.reportSha256,
    };
    assert.equal(
      (await verifyLocalFeatureWorkerPair(retainedPair)).integratedCommit,
      publicResult.integratedCommit,
    );
    const wrongDigest = [...publicWorkerArgs];
    wrongDigest[5] = '0'.repeat(64);
    const rejectedWorkers = await childResult(wrongDigest, 1, {
      PATH: `${root}:${process.env.PATH}`,
    });
    assert.match(rejectedWorkers.stderr, /Request bytes differ/);
    const spoofedWorkerRequest = {
      ...publicWorkerRequest,
      runId: 'public-spoofed-pair',
      executable,
    };
    const spoofedWorkerBytes = Buffer.from(
      JSON.stringify(spoofedWorkerRequest),
    );
    const spoofedWorkerPath = join(root, 'spoofed-public-workers.json');
    await writeFile(spoofedWorkerPath, spoofedWorkerBytes);
    const spoofedWorkerArgs = [
      ...publicWorkerArgs.slice(0, 3),
      spoofedWorkerPath,
      publicWorkerArgs[4],
      createHash('sha256').update(spoofedWorkerBytes).digest('hex'),
      ...publicWorkerArgs.slice(6),
    ];
    const rejectedExecutable = await childResult(spoofedWorkerArgs, 1, {
      PATH: `${root}:${process.env.PATH}`,
    });
    assert.match(
      rejectedExecutable.stderr,
      /Request has unknown or missing fields/,
    );
    await assert.rejects(lstat(join(root, 'evidence', 'public-spoofed-pair')));
    const retainedBuilder = JSON.parse(
      await readFile(publicResult.builder.observationPath, 'utf8'),
    );
    await writeFile(retainedBuilder.process.path, 'tampered');
    await assert.rejects(
      verifyLocalFeatureWorkerPair(retainedPair),
      /Expected values to be strictly equal/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('host forge gate observes repository access and exact pull-request head', async (t) => {
  if (process.platform === 'win32')
    return t.skip('The fake gh fixture is a POSIX executable script.');
  const root = await mkdtemp(join(tmpdir(), 'temari-forge-'));
  try {
    const artifact = join(root, 'artifact');
    await cp(output, artifact, { recursive: true });
    const repo = join(root, 'repo');
    execFileSync('git', ['init', '-q', repo]);
    execFileSync('git', [
      '-C',
      repo,
      'remote',
      'add',
      'origin',
      'git@github.com:test/repo.git',
    ]);
    const fakeGh = join(root, 'gh');
    await writeFile(
      fakeGh,
      `#!/usr/bin/env node
const args = process.argv.slice(2).join(' ');
if (args === 'api user --jq .login') console.log('test-user');
else if (args === 'api repos/test/repo') console.log(JSON.stringify({full_name:'test/repo',html_url:'https://github.com/test/repo',permissions:{push:true}}));
else if (args === 'api repos/test/repo/pulls/7') console.log(JSON.stringify({html_url:'https://github.com/test/repo/pull/7',base:{repo:{full_name:'test/repo'}},head:{sha:'${'a'.repeat(40)}'},state:'open'}));
else process.exit(3);
`,
    );
    await chmod(fakeGh, 0o755);
    const moduleUrl = pathToFileURL(join(artifact, 'host/forge.mjs')).href;
    const runForge = (commit, expectedCode = 0) =>
      childResult(
        [
          '--input-type=module',
          '-e',
          `import {observeLocalForge,verifyLocalPullRequest} from '${moduleUrl}'; const proof=observeLocalForge(process.argv[1]); console.log(JSON.stringify(verifyLocalPullRequest(proof,process.argv[2],'https://github.com/test/repo/pull/7')));`,
          repo,
          commit,
        ],
        expectedCode,
        { PATH: `${root}:${process.env.PATH}` },
      );
    const result = JSON.parse((await runForge('a'.repeat(40))).stdout);
    assert.equal(result.status, 'proven');
    assert.equal(result.integratedCommit, 'a'.repeat(40));
    assert.match(
      (await runForge('b'.repeat(40), 1)).stderr,
      /Pull request head differs from the integrated commit/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('feature host proof requires architect, builder, reviewer, and forge evidence', async (t) => {
  if (process.platform === 'win32')
    return t.skip('The fake host tools are POSIX executable scripts.');
  const root = await mkdtemp(join(tmpdir(), 'temari-feature-proof-'));
  try {
    const artifact = join(root, 'artifact');
    await cp(output, artifact, { recursive: true });
    const repo = join(root, 'repo');
    execFileSync('git', ['init', '-q', repo]);
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@localhost'], {
      cwd: repo,
    });
    await writeFile(join(repo, 'README.md'), 'base\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: repo });
    execFileSync('git', [
      '-C',
      repo,
      'remote',
      'add',
      'origin',
      'git@github.com:test/repo.git',
    ]);
    const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repo,
      encoding: 'utf8',
    }).trim();
    const evidenceRoot = join(root, 'evidence');
    await mkdir(evidenceRoot);
    const fakeGh = join(root, 'gh');
    await writeFile(
      fakeGh,
      `#!/usr/bin/env node
const args = process.argv.slice(2).join(' ');
if (args === 'api user --jq .login') console.log('test-user');
else if (args === 'api repos/test/repo') console.log(JSON.stringify({full_name:'test/repo',html_url:'https://github.com/test/repo',permissions:{push:true}}));
else process.exit(3);
`,
    );
    await chmod(fakeGh, 0o755);
    const executable = join(root, 'fake-codex');
    await writeFile(
      executable,
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const final = args[args.indexOf('--output-last-message') + 1];
const sandbox = args[args.indexOf('--sandbox') + 1];
let prompt = '';
process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', () => {
  const id = prompt.match(/Goal: ([A-Za-z]+)/)?.[1] ?? 'unknown';
  if (sandbox === 'workspace-write') fs.writeFileSync(id + '.txt', id + '\\n');
  fs.writeFileSync(final, JSON.stringify({status:'PASS',summary:id}));
});
`,
    );
    await chmod(executable, 0o755);
    const brief = (id) => ({
      goal: id,
      context: 'feature proof test',
      scope: id,
      acceptanceCriteria: ['produce result'],
      verificationCommand: null,
      reportFormat: 'json',
      forbiddenActions: ['stay in scope'],
    });
    const hostBinding = {
      entry: 'temari',
      policyId: 'temari-public-feature-v2',
      requestSha256: 'a'.repeat(64),
      manifestSha256: manifestSha256(manifest),
    };
    const input = {
      runId: 'feature-proof',
      revision: 'selected-revision',
      candidateRoot: repo,
      evidenceRoot,
      baseCommit,
      executable,
      timeoutMs: 5000,
      hostBinding,
      architect: {
        id: 'architect',
        role: 'investigator',
        required: true,
        brief: brief('design'),
      },
      builder: {
        id: 'builder',
        role: 'implementer',
        required: true,
        brief: brief('delta'),
      },
      owns: [{ kind: 'file', path: 'delta.txt' }],
      verify: [
        {
          program: process.execPath,
          args: [
            '-e',
            "if(!require('fs').existsSync('delta.txt'))process.exit(5)",
          ],
        },
      ],
      reviewer: {
        id: 'reviewer',
        role: 'reviewer',
        required: true,
        brief: brief('review'),
      },
    };
    const moduleUrl = pathToFileURL(
      join(artifact, 'host/feature-proof.mjs'),
    ).href;
    const requestPath = join(root, 'feature-input.json');
    await writeFile(requestPath, JSON.stringify(input));
    const script = `import {readFileSync} from 'node:fs'; import {runLocalFeatureHostProof,verifyLocalFeatureHostProof} from '${moduleUrl}'; const input=JSON.parse(readFileSync(process.argv[1],'utf8')); const result=process.argv[2]==='run' ? await runLocalFeatureHostProof(input) : await verifyLocalFeatureHostProof(input); console.log(JSON.stringify(result));`;
    const call = (mode, path, code = 0) =>
      childResult(['--input-type=module', '-e', script, path, mode], code, {
        PATH: `${root}:${process.env.PATH}`,
      });
    const proof = JSON.parse((await call('run', requestPath)).stdout);
    assert.equal(proof.status, 'proven');
    assert.equal(
      new Set([proof.architect.pid, proof.integratedCommit]).size,
      2,
    );
    const verifyInput = {
      runId: input.runId,
      revision: input.revision,
      candidateRoot: repo,
      evidenceRoot,
      baseCommit,
      hostBinding,
      proofSha256: proof.proofSha256,
    };
    const verifyPath = join(root, 'verify-input.json');
    await writeFile(verifyPath, JSON.stringify(verifyInput));
    assert.equal(
      JSON.parse((await call('verify', verifyPath)).stdout).integratedCommit,
      proof.integratedCommit,
    );
    await writeFile(proof.architect.observationPath, 'tampered');
    assert.match(
      (await call('verify', verifyPath, 1)).stderr,
      /Expected values to be strictly equal/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('full feature start binds local host proof to six persisted stages', async (t) => {
  if (process.platform === 'win32')
    return t.skip('The fake host tools are POSIX executable scripts.');
  const root = await mkdtemp(join(tmpdir(), 'temari-feature-start-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifact = join(root, 'artifact');
  await cp(output, artifact, { recursive: true });
  const candidate = join(root, 'candidate');
  execFileSync('git', ['init', '-q', candidate]);
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: candidate });
  execFileSync('git', ['config', 'user.email', 'test@localhost'], {
    cwd: candidate,
  });
  await writeFile(join(candidate, 'README.md'), 'base\n');
  execFileSync('git', ['add', 'README.md'], { cwd: candidate });
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: candidate });
  execFileSync('git', [
    '-C',
    candidate,
    'remote',
    'add',
    'origin',
    'git@github.com:test/repo.git',
  ]);
  const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: candidate,
    encoding: 'utf8',
  }).trim();
  const evidenceRoot = join(root, 'worker-evidence');
  await mkdir(evidenceRoot);
  const integrationPath = join(
    evidenceRoot,
    'feature-start-workers',
    'build',
    'feature-start-workers-build',
    'integration',
  );
  const fakeGh = join(root, 'gh');
  await writeFile(
    fakeGh,
    `#!/usr/bin/env node
const {execFileSync} = require('node:child_process');
const args = process.argv.slice(2).join(' ');
if (args === 'api user --jq .login') console.log('test-user');
else if (args === 'api repos/test/repo') console.log(JSON.stringify({full_name:'test/repo',html_url:'https://github.com/test/repo',permissions:{push:true}}));
else if (args === 'api repos/test/repo/pulls/7') console.log(JSON.stringify({html_url:'https://github.com/test/repo/pull/7',base:{repo:{full_name:'test/repo'}},head:{sha:execFileSync('git',['-C',process.env.FAKE_INTEGRATION_PATH,'rev-parse','HEAD'],{encoding:'utf8'}).trim()},state:'open'}));
else process.exit(3);
`,
  );
  await chmod(fakeGh, 0o755);
  const fakeCodex = join(root, 'codex');
  await writeFile(
    fakeCodex,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const final = args[args.indexOf('--output-last-message') + 1];
const sandbox = args[args.indexOf('--sandbox') + 1];
let prompt = '';
process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', () => {
  const id = prompt.match(/Goal: ([A-Za-z]+)/)?.[1] ?? 'unknown';
  if (sandbox === 'workspace-write') fs.writeFileSync(id + '.txt', id + '\\n');
  fs.writeFileSync(final, JSON.stringify({status:'PASS',summary:id}));
});
`,
  );
  await chmod(fakeCodex, 0o755);
  const brief = (id) => ({
    goal: id,
    context: 'feature lifecycle test',
    scope: id,
    acceptanceCriteria: ['produce result'],
    verificationCommand: null,
    reportFormat: 'json',
    forbiddenActions: ['stay in scope'],
  });
  const runDirectory = join(root, 'run');
  const featureRequest = {
    ...request('temari'),
    invocation: {
      runId: 'feature-start',
      revision: 'selected-feature',
      candidate: { scopeId: 'feature-candidate', root: candidate },
      runDirectory,
    },
    featureWorkers: {
      evidenceRoot,
      baseCommit,
      timeoutMs: 5000,
      architect: {
        id: 'architect',
        role: 'investigator',
        required: true,
        brief: brief('design'),
      },
      builder: {
        id: 'builder',
        role: 'implementer',
        required: true,
        brief: brief('delta'),
      },
      owns: [{ kind: 'file', path: 'delta.txt' }],
      verify: [
        {
          program: process.execPath,
          args: [
            '-e',
            "if(!require('fs').existsSync('delta.txt'))process.exit(5)",
          ],
        },
      ],
      reviewer: {
        id: 'reviewer',
        role: 'reviewer',
        required: true,
        brief: brief('review'),
      },
    },
  };
  const requestBytes = Buffer.from(JSON.stringify(featureRequest));
  const requestPath = join(root, 'request.json');
  await writeFile(requestPath, requestBytes);
  const launch = (mode) => {
    const child = spawn(
      process.execPath,
      [
        join(artifact, 'bin/temari.mjs'),
        mode,
        '--request',
        requestPath,
        '--expected-request-sha256',
        digest(requestBytes),
        '--expected-manifest-sha256',
        manifestSha256(manifest),
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${root}:${process.env.PATH}`,
          FAKE_INTEGRATION_PATH: integrationPath,
          NODE_OPTIONS: '',
          NODE_PATH: '',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let buffer = '';
    let stderr = '';
    const messages = [];
    let waiter;
    child.stderr.setEncoding('utf8').on('data', (part) => (stderr += part));
    child.stdout.setEncoding('utf8').on('data', (part) => {
      buffer += part;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (waiter) {
          clearTimeout(waiter.timer);
          waiter.resolve(message);
          waiter = undefined;
        } else messages.push(message);
      }
    });
    const done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code));
    });
    t.after(async () => {
      if (child.exitCode === null) child.kill('SIGKILL');
      await done;
    });
    return {
      child,
      done,
      stderr: () => stderr,
      next: async () => {
        if (messages.length) return messages.shift();
        return new Promise((resolve, reject) => {
          waiter = {
            resolve,
            reject,
            timer: setTimeout(
              () => reject(new Error(`Feature stage timeout: ${stderr}`)),
              15000,
            ),
          };
        });
      },
    };
  };
  let session = launch('start');
  let resumed = false;
  const seen = [];
  while (true) {
    const message = await session.next();
    if (message.type === 'complete') {
      assert.equal(message.status, 'PASS', session.stderr());
      break;
    }
    if (message.type !== 'stage') continue;
    if (message.stage === 'plan' && !resumed) {
      session.child.kill('SIGKILL');
      await session.done;
      session = launch('resume');
      resumed = true;
      continue;
    }
    seen.push(message.stage);
    const sourceRequired = ['investigate', 'plan', 'deliver'].includes(
      message.stage,
    );
    await writeFile(
      join(message.workspace, 'observation.txt'),
      `stage ${message.stage}\n`,
    );
    if (sourceRequired)
      await writeFile(
        join(message.workspace, 'source.txt'),
        message.stage === 'deliver'
          ? JSON.stringify({
              pullRequestUrl: 'https://github.com/test/repo/pull/7',
            })
          : `documented ${message.stage}\n`,
      );
    await writeFile(
      join(message.workspace, 'host-result.json'),
      JSON.stringify({
        schemaVersion: 1,
        sessionId: message.sessionId,
        requestId: message.requestId,
        stage: message.stage,
        status: 'PASS',
        summary: `feature ${message.stage} complete`,
        evidence: [
          {
            name: 'observation',
            kind: 'verification',
            path: 'observation.txt',
          },
          ...(sourceRequired
            ? [{ name: 'source', kind: 'other', path: 'source.txt' }]
            : []),
        ],
      }),
    );
    session.child.stdin.write(
      JSON.stringify({
        type: 'result',
        sessionId: message.sessionId,
        requestId: message.requestId,
        stage: message.stage,
      }) + '\n',
    );
  }
  assert.equal(await session.done, 0, session.stderr());
  assert(resumed, 'Feature lifecycle did not resume.');
  assert.deepEqual(seen, [
    'investigate',
    'plan',
    'build',
    'review',
    'verify',
    'deliver',
  ]);
  assert.equal(
    execFileSync('git', ['-C', candidate, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim(),
    baseCommit,
  );
  const descriptor = JSON.parse(
    await readFile(join(runDirectory, 'config/input.json'), 'utf8'),
  );
  assert.deepEqual(descriptor.plan.requiredCapabilities, [
    'subagents',
    'forge',
  ]);
  assert.equal(descriptor.candidate.root, await realpath(integrationPath));
  const artifactRequire = createRequire(
    pathToFileURL(join(artifact, 'runtime/consumer.mjs')),
  );
  const runtime = await import(
    pathToFileURL(artifactRequire.resolve('@temari/runtime')).href
  );
  const current = await runtime.observeCandidate(descriptor.candidate);
  const currentBytes = Buffer.from(JSON.stringify(current));
  const currentPath = join(root, 'current.json');
  await writeFile(currentPath, currentBytes);
  const closeout = await childResult(
    [
      join(artifact, 'bin/closeout.mjs'),
      'verify',
      '--request',
      requestPath,
      '--expected-request-sha256',
      digest(requestBytes),
      '--expected-manifest-sha256',
      manifestSha256(manifest),
      '--expected-current',
      currentPath,
      '--expected-current-sha256',
      digest(currentBytes),
    ],
    0,
    {
      PATH: `${root}:${process.env.PATH}`,
      FAKE_INTEGRATION_PATH: integrationPath,
    },
  );
  assert.equal(JSON.parse(closeout.stdout).status, 'candidate-verified');
});

test('both engineering skills reach the complete versioned QA writer inside the artifact', async () => {
  for (const entry of ['temari', 'poteto-mode']) {
    const visited = new Set();
    const visit = async (path) => {
      if (visited.has(path)) return;
      visited.add(path);
      const bytes = await readFile(join(output, path));
      const artifactRecord = manifest.files.find((file) => file.path === path);
      assert(artifactRecord, `Unmanifested skill resource: ${path}`);
      assert.equal(
        artifactRecord.sha256,
        createHash('sha256').update(bytes).digest('hex'),
      );
      for (const [, link] of bytes.toString().matchAll(/\]\(([^)]+)\)/g)) {
        if (/^[a-z][a-z\d+.-]*:|^#/i.test(link)) continue;
        const target = fileURLToPath(
          new URL(link, pathToFileURL(join(output, path))),
        );
        const resource = relative(output, target).split('\\').join('/');
        assert(
          resource.startsWith('skills/'),
          `Link escapes bundled skills: ${link}`,
        );
        await visit(resource);
      }
    };
    await visit(`skills/${entry}/SKILL.md`);
    for (const resource of [
      'SKILL.md',
      'CHANGELOG.md',
      'references/maintenance.md',
      'assets/ticket-comment.md',
      'assets/ticket-verification.md',
      'assets/release-qa-report.md',
    ]) {
      const path = `skills/qa-review-verification/${resource}`;
      assert(
        visited.has(path),
        `Unreachable QA resource from ${entry}: ${resource}`,
      );
      assert(
        manifest.source.files.some(
          (file) => file.path === `packages/workflow-runtime/public/${path}`,
        ),
      );
    }
    const skill = await readFile(
      join(output, 'skills/qa-review-verification/SKILL.md'),
      'utf8',
    );
    const frontmatter = skill.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    assert(frontmatter, 'Missing QA skill frontmatter');
    assert.match(frontmatter[1], /^name: qa-review-verification$/m);
    assert.match(frontmatter[1], /^description: .+$/m);
    assert.match(
      frontmatter[1],
      /^metadata:\r?\n  version: (['"]?)\d+\.\d+\.\d+\1$/m,
    );
  }
});

test('installed overlay checker accepts pinned external assets and refuses incompatible overlays', async () => {
  const checker = join(output, 'bin/overlay-check.mjs');
  const publicDigest = manifestSha256(manifest);
  const absent = await child([
    checker,
    '--expected-manifest-sha256',
    publicDigest,
  ]);
  assert.equal(absent.status, 'compatible');
  assert.equal(absent.overlayId, null);

  const overlayRoot = await mkdtemp(join(tmpdir(), 'temari-overlay-'));
  const assetPath = 'knowledge/context.md';
  const assetBytes = Buffer.from('Sanitized overlay fixture.\n');
  const assetFile = join(overlayRoot, assetPath);
  const overlayManifest = {
    schemaVersion: 1,
    overlayId: 'fixture-overlay',
    compatiblePublicManifestSha256: publicDigest,
    assets: [
      {
        path: assetPath,
        kind: 'knowledge',
        sha256: createHash('sha256').update(assetBytes).digest('hex'),
        bytes: assetBytes.length,
      },
    ],
    credentialRefs: [
      {
        id: 'model',
        provider: 'openai',
        handle: 'credential-ref:fixture-model',
      },
    ],
  };
  const run = async (value, expectedCode = 0) => {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
    await writeFile(join(overlayRoot, 'temari-overlay.json'), bytes);
    return childResult(
      [
        checker,
        '--expected-manifest-sha256',
        publicDigest,
        '--overlay-root',
        overlayRoot,
        '--expected-overlay-sha256',
        createHash('sha256').update(bytes).digest('hex'),
      ],
      expectedCode,
    );
  };
  try {
    await mkdir(join(overlayRoot, 'knowledge'));
    await writeFile(assetFile, assetBytes);
    const accepted = await run(overlayManifest);
    assert.equal(accepted.code, 0);
    const report = JSON.parse(accepted.stdout);
    assert.equal(report.overlayId, 'fixture-overlay');
    assert.equal(report.assetCount, 1);
    assert.equal(report.credentialReferenceCount, 1);
    assert(!accepted.stdout.includes('fixture-model'));

    await writeFile(assetFile, 'Changed overlay fixture.\n');
    assert.equal((await run(overlayManifest, 1)).code, 1);
    await writeFile(assetFile, assetBytes);
    assert.equal(
      (
        await run(
          {
            ...overlayManifest,
            compatiblePublicManifestSha256: '0'.repeat(64),
          },
          1,
        )
      ).code,
      1,
    );
    assert.equal(
      (
        await run(
          {
            ...overlayManifest,
            credentialRefs: [
              {
                ...overlayManifest.credentialRefs[0],
                value: 'forbidden-secret',
              },
            ],
          },
          1,
        )
      ).code,
      1,
    );
    assert.equal(
      (
        await run(
          {
            ...overlayManifest,
            assets: [{ ...overlayManifest.assets[0], path: '../outside.md' }],
          },
          1,
        )
      ).code,
      1,
    );
    await writeFile(join(overlayRoot, 'undeclared.txt'), 'extra');
    assert.equal((await run(overlayManifest, 1)).code, 1);
  } finally {
    await rm(overlayRoot, { recursive: true, force: true });
  }
});

test('public policy records the exact reviewed legacy profile and playbook provenance', async () => {
  const policy = JSON.parse(
    await readFile(join(output, 'policy.json'), 'utf8'),
  );
  assert.equal(policy.policyId, 'temari-public-feature-v2');
  assert.deepEqual(policy.feature.unsupportedRoutes, ['qa-review']);
  const sha256 = (text) => createHash('sha256').update(text).digest('hex');
  const profile = await readFile(
    join(
      repository,
      'packages/workflow-runtime/assets/v4.1/skills/poteto-mode/playbook-contracts/v1/feature.json',
    ),
    'utf8',
  );
  const playbook = await readFile(
    join(
      repository,
      'packages/workflow-runtime/assets/v4.1/skills/poteto-mode/playbooks/feature.md',
    ),
    'utf8',
  );
  assert.equal(
    sha256(profile.replace(/\r\n?/g, '\n')),
    policy.feature.source.profileSha256,
  );
  assert.equal(
    sha256(playbook.replace(/\r\n?/g, '\n')),
    policy.feature.source.playbookSha256,
  );
  const lightweightProfile = await readFile(
    join(
      repository,
      'packages/workflow-runtime/assets/v4.1/skills/poteto-mode/playbook-contracts/v1/lightweight-engineering.json',
    ),
    'utf8',
  );
  const lightweightPlaybook = await readFile(
    join(
      repository,
      'packages/workflow-runtime/assets/v4.1/skills/poteto-mode/playbooks/lightweight-engineering.md',
    ),
    'utf8',
  );
  assert.equal(
    sha256(lightweightProfile.replace(/\r\n?/g, '\n')),
    policy.lightweight.source.profileSha256,
  );
  assert.equal(
    sha256(lightweightPlaybook.replace(/\r\n?/g, '\n')),
    policy.lightweight.source.playbookSha256,
  );
  const requirementIds = JSON.parse(lightweightProfile).stages.flatMap(
    (stage) => stage.requirements.map((requirement) => requirement.id),
  );
  assert.deepEqual(
    [...new Set(Object.values(policy.lightweight.stageMapping).flat())].sort(),
    requirementIds.sort(),
  );
  assert.deepEqual(Object.keys(policy.lightweight.stageMapping), [
    'investigate',
    'plan',
    'build',
    'review',
    'verify',
    'deliver',
  ]);
  assert.equal(policy.lightweight.publishGate, 'operator-approval');
});

test('artifact checking requires an external expected manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari public-entry-untrusted-'));
  try {
    const artifact = join(root, 'artifact');
    await cp(output, artifact, { recursive: true });
    const policyPath = join(artifact, 'policy.json');
    const policy = JSON.parse(await readFile(policyPath, 'utf8'));
    policy.feature.source.playbookSha256 = '0'.repeat(64);
    const policyBytes = Buffer.from(`${JSON.stringify(policy, null, 2)}\n`);
    await writeFile(policyPath, policyBytes);

    const manifestPath = join(artifact, 'public-entry-manifest.json');
    const rewrittenManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const policyRecord = rewrittenManifest.files.find(
      (record) => record.path === 'policy.json',
    );
    policyRecord.sha256 = createHash('sha256')
      .update(policyBytes)
      .digest('hex');
    policyRecord.bytes = policyBytes.byteLength;
    await writeFile(
      manifestPath,
      `${JSON.stringify(rewrittenManifest, null, 2)}\n`,
    );

    await assert.rejects(
      checkPublicEntryArtifact(artifact),
      /external expected manifest/i,
    );
    await assert.rejects(
      checkPublicEntryArtifact(artifact, manifestSha256(manifest)),
      /external expected digest/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('public engineering admission refuses unsupported routes and blocks unproven capabilities', async () => {
  const requestPath = join(buildRoot, 'feature-request.json');
  await writeFile(requestPath, JSON.stringify(request('temari')));
  const temari = await child(
    [join(output, 'bin/temari.mjs'), 'admit', '--request', requestPath],
    1,
  );
  assert.equal(temari.status, 'blocked');
  assert.deepEqual(temari.missingCapabilities, ['subagents', 'forge']);
  assert.deepEqual(temari.reasons, ['host-capability-proof-missing']);

  const poteto = await child(
    [join(output, 'bin/poteto-mode.mjs'), 'admit', '--request', requestPath],
    1,
  );
  assert.equal(poteto.status, 'rejected');
  assert(poteto.reasons.includes('entry-mismatch'));

  await writeFile(
    requestPath,
    JSON.stringify(
      request('poteto-mode', {
        route: 'lightweight-engineering',
        profile: 'lightweight-engineering',
      }),
    ),
  );
  const lightweight = await child(
    [join(output, 'bin/poteto-mode.mjs'), 'admit', '--request', requestPath],
    1,
  );
  assert.equal(lightweight.status, 'rejected');
  assert(lightweight.reasons.includes('profile-not-admitted'));
});

test('installed Temari and Poteto skills expose the bundled worker guide', async () => {
  const temariSkill = await readFile(
    join(output, 'skills/temari/SKILL.md'),
    'utf8',
  );
  const potetoSkill = await readFile(
    join(output, 'skills/poteto-mode/SKILL.md'),
    'utf8',
  );
  const guide = await readFile(
    join(output, 'skills/poteto-mode/references/codex-parallel-workers.md'),
    'utf8',
  );
  assert.match(
    temariSkill,
    /parallel worker guide.*codex-parallel-workers\.md/,
  );
  assert.match(
    potetoSkill,
    /parallel worker guide.*codex-parallel-workers\.md/,
  );
  assert.match(guide, /bin\/codex-parallel\.mjs/);
  assert((await lstat(join(output, 'bin/codex-parallel.mjs'))).isFile());
});

test('closeout preflight blocks without trusted candidate selection', async () => {
  const closeout = await child(
    [
      join(output, 'bin/closeout.mjs'),
      'admit',
      '--run-directory',
      join(buildRoot, 'run'),
    ],
    1,
  );
  assert.equal(closeout.status, 'blocked');
  assert.deepEqual(closeout.reasons, [
    'trusted-invocation-and-current-candidate-selection-required',
  ]);
});

test('public entries refuse symlinked policy and request inputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari public-entry-inputs-'));
  try {
    const artifact = join(root, 'artifact');
    await cp(output, artifact, { recursive: true });
    const policyPath = join(artifact, 'policy.json');
    const policyTarget = join(root, 'policy-target.json');
    await rename(policyPath, policyTarget);
    await symlink(policyTarget, policyPath);
    const policyResult = await childResult(
      [join(artifact, 'bin/temari.mjs'), 'policy'],
      1,
    );
    assert.match(
      policyResult.stderr,
      /regular file|symbolic|symlink|nofollow/i,
    );

    await unlink(policyPath);
    await writeFile(policyPath, await readFile(policyTarget));
    const requestTarget = join(root, 'request-target.json');
    const requestPath = join(root, 'request.json');
    await writeFile(requestTarget, JSON.stringify(request('temari')));
    await symlink(requestTarget, requestPath);
    const requestResult = await childResult(
      [join(artifact, 'bin/temari.mjs'), 'admit', '--request', requestPath],
      1,
    );
    assert.match(
      requestResult.stderr,
      /regular file|symbolic|symlink|nofollow/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('failed publication removes staging and leaves no destination', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari public-entry-failure-'));
  try {
    const artifact = join(root, 'artifact');
    await assert.rejects(
      packagePublicEntries(artifact, {
        packageCanonical: async () => {
          throw new Error('injected canonical packaging failure');
        },
      }),
      /injected canonical packaging failure/,
    );
    await assert.rejects(lstat(artifact), { code: 'ENOENT' });
    const leftovers = await readdir(root);
    assert.deepEqual(leftovers, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('concurrent publication has one exclusive owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari public-entry-race-'));
  try {
    const artifact = join(root, 'artifact');
    const results = await Promise.allSettled([
      packagePublicEntries(artifact),
      packagePublicEntries(artifact),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].reason.message, /reserved|exists/i);
    const publishedManifest = fulfilled[0].value;
    assert.deepEqual(
      await checkPublicEntryArtifact(
        artifact,
        manifestSha256(publishedManifest),
      ),
      publishedManifest,
    );
    await assert.rejects(lstat(`${artifact}.publish-lock`), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('outer publication is no-overwrite and rejects tampering or symlinks', async () => {
  await assert.rejects(packagePublicEntries(output), /Output already exists/);

  const policyPath = join(output, 'policy.json');
  const policyBytes = await readFile(policyPath);
  const tampered = Buffer.from(policyBytes);
  tampered[tampered.length - 2] ^= 1;
  await writeFile(policyPath, tampered);
  await assert.rejects(
    checkPublicEntryArtifact(output, manifestSha256(manifest)),
    /inventory|digest|hash|policy/i,
  );
  await writeFile(policyPath, policyBytes);
  assert.deepEqual(
    await checkPublicEntryArtifact(output, manifestSha256(manifest)),
    manifest,
  );

  const symlinkPath = join(output, 'bin/temari.mjs');
  const entryBytes = await readFile(symlinkPath);
  await unlink(symlinkPath);
  await symlink('../policy.json', symlinkPath);
  await assert.rejects(
    checkPublicEntryArtifact(output, manifestSha256(manifest)),
    /Symlink/,
  );
  await unlink(symlinkPath);
  await writeFile(symlinkPath, entryBytes, { mode: 0o755 });
  assert.deepEqual(
    await checkPublicEntryArtifact(output, manifestSha256(manifest)),
    manifest,
  );
});

function lightweightRequest(entry, candidate, runDirectory) {
  return {
    schemaVersion: 1,
    entry,
    route: 'lightweight-engineering',
    profile: 'lightweight-engineering-v1',
    obligations: {
      workType: 'feature',
      delegation: 'none',
      review: 'self',
      evidence: 'revision-bound',
      delivery: 'local',
    },
    routeInput: {
      workType: 'feature',
      lightweight: {
        resultIsClearLocalAndReversible: true,
        changesSharedBoundary: false,
        isReportedDefect: false,
        hasUnexplainedSymptom: false,
        makesPerformanceClaim: false,
        isDesignChoice: false,
        isMigration: false,
        affectedCallersAreKnown: true,
        crossesArchitecturalBoundary: false,
        directCheckAvailable: true,
      },
    },
    invocation: {
      runId: 'installed-lightweight',
      revision: 'synthetic-candidate-v1',
      candidate: { scopeId: 'synthetic-product', root: candidate },
      runDirectory,
    },
  };
}

async function installedFixture(t, entry = 'temari') {
  const root = await mkdtemp(join(tmpdir(), 'temari installed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifact = join(root, 'artifact');
  await cp(output, artifact, { recursive: true });
  const candidate = join(root, 'candidate');
  await mkdir(candidate);
  await writeFile(join(candidate, 'product.txt'), 'pear\napple\n');
  const runDirectory = join(root, 'run');
  const request = lightweightRequest(entry, candidate, runDirectory);
  const requestPath = join(root, 'request.json');
  const requestBytes = Buffer.from(JSON.stringify(request));
  await writeFile(requestPath, requestBytes);
  const launch = (
    mode = 'start',
    digest = createHash('sha256').update(requestBytes).digest('hex'),
    loader,
  ) => {
    const args = [
      ...(loader ? ['--experimental-loader', pathToFileURL(loader).href] : []),
      join(artifact, `bin/${entry}.mjs`),
      mode,
      '--request',
      requestPath,
      '--expected-request-sha256',
      digest,
      '--expected-manifest-sha256',
      manifestSha256(manifest),
    ];
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    let tail = '';
    const messages = [];
    let pending;
    let closed = false;
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk;
    });
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      tail += chunk;
      let end;
      while ((end = tail.indexOf('\n')) !== -1) {
        const message = JSON.parse(tail.slice(0, end));
        tail = tail.slice(end + 1);
        if (pending) {
          clearTimeout(pending.timer);
          pending.resolve(message);
          pending = undefined;
        } else messages.push(message);
      }
    });
    const done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => {
        closed = true;
        if (pending) {
          clearTimeout(pending.timer);
          pending.reject(new Error(`Entry closed: ${code}: ${stderr}`));
          pending = undefined;
        }
        resolve({ code, stderr, messages });
      });
    });
    t.after(async () => {
      if (!closed) child.kill('SIGKILL');
      await done;
    });
    return {
      child,
      done,
      next: async () => {
        if (messages.length) return messages.shift();
        assert(!closed, stderr);
        return new Promise((resolve, reject) => {
          pending = {
            resolve,
            reject,
            timer: setTimeout(() => {
              pending = undefined;
              reject(new Error(`Stage timeout: ${stderr}`));
            }, 10_000),
          };
        });
      },
      reply(message) {
        child.stdin.write(
          JSON.stringify({
            type: 'result',
            sessionId: message.sessionId,
            requestId: message.requestId,
            stage: message.stage,
          }) + '\n',
        );
      },
    };
  };
  return {
    root,
    artifact,
    candidate,
    runDirectory,
    request,
    requestPath,
    requestBytes,
    launch,
  };
}

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function canonicalReceipt(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalReceipt).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalReceipt(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

async function completeInstalledFixture(t) {
  const fixture = await installedFixture(t);
  const session = fixture.launch();
  while (true) {
    const message = await session.next();
    if (message.type === 'complete') {
      assert.equal(message.status, 'PASS');
      break;
    }
    if (message.type === 'stage') await answerStage(fixture, session, message);
  }
  assert.equal((await session.done).code, 0);
  return fixture;
}

async function selectedCurrent(fixture) {
  const bytes = Buffer.from('APPLE\nPEAR\n');
  const mode = Number(
    (await lstat(join(fixture.candidate, 'product.txt'))).mode & 0o777,
  );
  return {
    scope: 'local-regular-files-v1',
    sha256: digest(
      JSON.stringify([
        'local-regular-files-v1',
        [['product.txt', mode, bytes.length, digest(bytes)]],
      ]),
    ),
  };
}

async function filesystemSnapshot(...roots) {
  const entries = [];
  async function walk(root, path) {
    const stat = await lstat(path, { bigint: true });
    entries.push([
      relative(root, path),
      stat.mode.toString(),
      stat.size.toString(),
      stat.mtimeNs.toString(),
      stat.isFile() ? digest(await readFile(path)) : null,
    ]);
    if (stat.isDirectory())
      for (const name of (await readdir(path)).sort())
        await walk(root, join(path, name));
  }
  for (const root of roots) await walk(root, root);
  return entries;
}

let closeoutSequence = 0;
async function closeoutArgs(
  fixture,
  expectedCurrent,
  request = fixture.request,
) {
  const sequence = ++closeoutSequence;
  const currentPath = join(fixture.root, `selected-current-${sequence}.json`);
  const currentBytes = Buffer.from(JSON.stringify(expectedCurrent));
  await writeFile(currentPath, currentBytes);
  const requestPath = join(fixture.root, `closeout-request-${sequence}.json`);
  const requestBytes = Buffer.from(JSON.stringify(request));
  await writeFile(requestPath, requestBytes);
  return [
    join(fixture.artifact, 'bin/closeout.mjs'),
    'verify',
    '--request',
    requestPath,
    '--expected-request-sha256',
    digest(requestBytes),
    '--expected-manifest-sha256',
    manifestSha256(manifest),
    '--expected-current',
    currentPath,
    '--expected-current-sha256',
    digest(currentBytes),
  ];
}

async function answerStage(
  fixture,
  session,
  message,
  withSource = true,
  sourceKindOverride,
  sourceMode = 'dedicated',
) {
  assert.equal(message.type, 'stage');
  let evidence = `observed ${message.stage}\n`;
  if (message.stage === 'build') {
    assert.equal(
      await readFile(join(fixture.candidate, 'product.txt'), 'utf8'),
      'pear\napple\n',
    );
    await writeFile(join(fixture.candidate, 'product.txt'), 'APPLE\nPEAR\n');
    evidence =
      'diff --git a/product.txt b/product.txt\n-pear\n-apple\n+APPLE\n+PEAR\n';
  }
  if (message.stage === 'review') {
    assert.equal(
      await readFile(join(fixture.candidate, 'product.txt'), 'utf8'),
      'APPLE\nPEAR\n',
    );
    evidence = 'Reviewed product.txt change from pear/apple to APPLE/PEAR.\n';
  }
  if (message.stage === 'verify') {
    const bytes = await readFile(join(fixture.candidate, 'product.txt'));
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      'a356e1ad77377b48e6090cda3e5ae651809c835b3b9e65aa742d3d031b283fa8',
    );
    evidence = 'Direct check: product.txt is APPLE\\nPEAR\\n.\n';
  }
  if (message.stage === 'deliver') {
    evidence =
      'Result: product.txt is APPLE\\nPEAR\\n. Publish approval remains unresolved.\n';
  }
  await writeFile(join(message.workspace, 'evidence.txt'), evidence);
  const genericSourceAlias = sourceMode === 'generic-alias';
  const claims = {
    investigate: { id: 'lightweight.intake.inspect', sourceKind: 'document' },
    plan: { id: 'lightweight.route.qualifies', sourceKind: 'document' },
    build: {
      id: 'lightweight.build.smallest-complete-change',
      sourceKind: 'diff',
    },
    review: { id: 'lightweight.verify.direct-check', sourceKind: 'diff' },
    verify: { id: 'lightweight.verify.direct-check', sourceKind: 'command' },
  };
  if (withSource)
    await writeFile(join(message.workspace, 'source.txt'), evidence);
  await writeFile(
    join(message.workspace, 'host-result.json'),
    JSON.stringify({
      schemaVersion: 1,
      sessionId: message.sessionId,
      requestId: message.requestId,
      stage: message.stage,
      status: 'PASS',
      summary: `synthetic ${message.stage} complete`,
      evidence: [
        { name: 'observation', kind: 'verification', path: 'evidence.txt' },
        ...(withSource && !genericSourceAlias
          ? [
              {
                name: 'source',
                kind: sourceMode === 'wrong-kind' ? 'verification' : 'other',
                path: 'source.txt',
              },
            ]
          : []),
        ...(sourceMode === 'reserved-name'
          ? [{ name: 'source-requirements', kind: 'other', path: 'source.txt' }]
          : []),
        ...(sourceMode === 'duplicate-name'
          ? [{ name: 'source', kind: 'other', path: 'source.txt' }]
          : []),
      ],
      ...(withSource
        ? {
            sourceRequirements: claims[message.stage]
              ? [
                  {
                    ...claims[message.stage],
                    sourceKind:
                      sourceKindOverride ?? claims[message.stage].sourceKind,
                    evidenceName: genericSourceAlias ? 'observation' : 'source',
                  },
                ]
              : [],
          }
        : {}),
    }),
  );
  session.reply(message);
}

async function retainedClaims(runDirectory, stage) {
  const checkpointNames = await readdir(join(runDirectory, 'checkpoints'));
  const checkpoint = JSON.parse(
    await readFile(
      join(runDirectory, 'checkpoints', checkpointNames[0]),
      'utf8',
    ),
  );
  const record = checkpoint.checkpoint ?? checkpoint;
  const stageRecord = record.stages.find((item) => item.stage === stage);
  assert(stageRecord);
  const evidenceRoot = join(runDirectory, 'evidence');
  const attestation = JSON.parse(
    await readFile(
      join(evidenceRoot, `${stageRecord.stageEvidence.sha256}.artifact`),
      'utf8',
    ),
  );
  const sourcePayload = attestation.payloads.find(
    (item) => item.name === 'source-requirements',
  );
  assert(sourcePayload);
  const bytes = await readFile(
    join(evidenceRoot, `${sourcePayload.reference.sha256}.artifact`),
  );
  return {
    source: JSON.parse(bytes.toString()),
    path: join(evidenceRoot, `${sourcePayload.reference.sha256}.artifact`),
    attestation,
  };
}

test('installed entry refuses a six-stage PASS without source requirement evidence', async (t) => {
  const f = await installedFixture(t);
  const session = f.launch();
  while (true) {
    const message = await session.next();
    if (message.type === 'complete') {
      assert.notEqual(message.status, 'PASS');
      break;
    }
    if (message.type === 'checkpoint') continue;
    await answerStage(f, session, message, false);
  }
  assert.notEqual((await session.done).code, 0);
  const receipt = JSON.parse(
    await readFile(
      join(f.runDirectory, 'receipts/installed-lightweight.receipt.json'),
      'utf8',
    ),
  ).receipt;
  assert.notEqual(receipt.status, 'PASS');
});

test('installed entry rejects a renamed source evidence kind before a PASS checkpoint', async (t) => {
  const f = await installedFixture(t);
  const session = f.launch();
  await answerStage(f, session, await session.next(), true, 'verification');
  const complete = await session.next();
  assert.equal(complete.type, 'complete');
  assert.equal(complete.status, 'BLOCKED');
  assert.notEqual((await session.done).code, 0);
  assert.deepEqual(await readdir(join(f.runDirectory, 'checkpoints')), [
    'installed-lightweight.checkpoint.json',
  ]);
  const checkpoint = JSON.parse(
    await readFile(
      join(f.runDirectory, 'checkpoints/installed-lightweight.checkpoint.json'),
      'utf8',
    ),
  );
  assert.equal((checkpoint.checkpoint ?? checkpoint).stages.length, 0);
});

test('installed entry rejects allowed source kinds bound to generic verification payloads', async (t) => {
  const f = await installedFixture(t);
  const session = f.launch();
  await answerStage(
    f,
    session,
    await session.next(),
    true,
    undefined,
    'generic-alias',
  );
  const complete = await session.next();
  assert.equal(complete.type, 'complete');
  assert.equal(complete.status, 'BLOCKED');
  assert.notEqual((await session.done).code, 0);
  const checkpoint = JSON.parse(
    await readFile(
      join(f.runDirectory, 'checkpoints/installed-lightweight.checkpoint.json'),
      'utf8',
    ),
  );
  assert.equal((checkpoint.checkpoint ?? checkpoint).stages.length, 0);
});

test('installed entry rejects wrong generic kind and reserved or duplicate source names', async (t) => {
  for (const sourceMode of ['wrong-kind', 'reserved-name', 'duplicate-name']) {
    await t.test(sourceMode, async (t) => {
      const f = await installedFixture(t);
      const session = f.launch();
      await answerStage(
        f,
        session,
        await session.next(),
        true,
        undefined,
        sourceMode,
      );
      const complete = await session.next();
      assert.equal(complete.type, 'complete');
      assert.equal(complete.status, 'BLOCKED');
      assert.notEqual((await session.done).code, 0);
      const checkpoint = JSON.parse(
        await readFile(
          join(
            f.runDirectory,
            'checkpoints/installed-lightweight.checkpoint.json',
          ),
          'utf8',
        ),
      );
      assert.equal((checkpoint.checkpoint ?? checkpoint).stages.length, 0);
    });
  }
});

test('retained validation rejects a previously acknowledged generic payload alias', async () => {
  const runId = 'retained-alias';
  const revision = 'synthetic-v1';
  const payload = Buffer.from('generic verification for investigate\n');
  const reference = {
    schema: 1,
    runId,
    revision,
    kind: 'verification',
    sha256: createHash('sha256').update(payload).digest('hex'),
    bytes: payload.byteLength,
  };
  const claims = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      stage: 'investigate',
      claims: [
        {
          id: 'lightweight.intake.inspect',
          sourceKind: 'document',
          evidenceName: 'observation',
          reference,
        },
      ],
    }),
  );
  const claimReference = {
    ...reference,
    kind: 'other',
    sha256: createHash('sha256').update(claims).digest('hex'),
    bytes: claims.byteLength,
  };
  const attestation = Buffer.from(
    JSON.stringify({
      payloads: [
        { name: 'observation', reference },
        { name: 'source-requirements', reference: claimReference },
      ],
    }),
  );
  const attestationReference = {
    ...reference,
    kind: 'other',
    sha256: createHash('sha256').update(attestation).digest('hex'),
    bytes: attestation.byteLength,
  };
  const artifacts = new Map([
    [attestationReference.sha256, attestation],
    [claimReference.sha256, claims],
    [reference.sha256, payload],
  ]);
  const record = {
    runId,
    revision,
    stages: [{ stage: 'investigate', stageEvidence: attestationReference }],
  };
  const store = {
    loadPortable: async (item) => {
      const bytes = artifacts.get(item.sha256);
      assert(bytes);
      assert.equal(bytes.byteLength, item.bytes);
      assert.equal(
        createHash('sha256').update(bytes).digest('hex'),
        item.sha256,
      );
      return bytes;
    },
  };
  const contract = {
    requirements: new Map([
      ['lightweight.intake.inspect', { allowedEvidenceKinds: ['document'] }],
    ]),
    stageRequirements: { investigate: ['lightweight.intake.inspect'] },
  };
  const runtime = { verifyCandidateEvidenceRecord: async () => undefined };
  await assert.rejects(
    assertSourceEvidence(record, store, contract, runtime),
    /Retained dedicated source evidence differs/,
  );
});

test('relocated public entry starts, resumes, and persists the six-stage candidate result', async (t) => {
  const f = await installedFixture(t, 'poteto-mode');
  assert.deepEqual(
    await checkPublicEntryArtifact(f.artifact, manifestSha256(manifest)),
    manifest,
  );
  const loader = join(f.root, 'deny-legacy-loader.mjs');
  await writeFile(
    loader,
    `export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  if (result.url.startsWith(${JSON.stringify(pathToFileURL(repository).href)})) throw Error('Legacy checkout import refused');
  return result;
}\n`,
  );
  const denied = await childResult(
    [
      '--experimental-loader',
      pathToFileURL(loader).href,
      '--input-type=module',
      '-e',
      `import(${JSON.stringify(pathToFileURL(packager).href)})`,
    ],
    1,
  );
  assert.match(denied.stderr, /Legacy checkout import refused/);
  const first = f.launch('start', undefined, loader);
  const requested = [];
  while (true) {
    const message = await first.next();
    if (message.type === 'checkpoint' && message.stage === 'build') break;
    if (message.type === 'checkpoint') continue;
    requested.push(message.stage);
    await answerStage(f, first, message);
  }
  first.child.stdin.end();
  assert.notEqual((await first.done).code, 0);
  assert.deepEqual(requested, ['investigate', 'plan', 'build']);
  const resumed = f.launch('resume', undefined, loader);
  while (true) {
    const message = await resumed.next();
    if (message.type === 'complete') {
      assert.equal(message.status, 'PASS');
      break;
    }
    if (message.type === 'checkpoint') continue;
    requested.push(message.stage);
    await answerStage(f, resumed, message);
  }
  assert.equal((await resumed.done).code, 0);
  assert.deepEqual(requested, [
    'investigate',
    'plan',
    'build',
    'review',
    'verify',
    'deliver',
  ]);
  const bytes = await readFile(join(f.candidate, 'product.txt'));
  assert.equal(bytes.toString(), 'APPLE\nPEAR\n');
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    'a356e1ad77377b48e6090cda3e5ae651809c835b3b9e65aa742d3d031b283fa8',
  );
  const receipt = JSON.parse(
    await readFile(
      join(f.runDirectory, 'receipts/installed-lightweight.receipt.json'),
      'utf8',
    ),
  ).receipt;
  assert.equal(receipt.status, 'PASS');
  assert.deepEqual(
    receipt.stages.map((stage) => stage.stage),
    requested,
  );
  assert.deepEqual(receipt.capabilities.available, []);
  assert.equal(receipt.plan.review, 'self');
  assert.equal(receipt.plan.delivery, 'local');
  const retained = await Promise.all(
    ['investigate', 'plan', 'build', 'review', 'verify', 'deliver'].map(
      (stage) => retainedClaims(f.runDirectory, stage),
    ),
  );
  const expectedIds = [
    'lightweight.intake.inspect',
    'lightweight.route.qualifies',
    'lightweight.build.smallest-complete-change',
    'lightweight.verify.direct-check',
  ];
  assert.deepEqual(
    [
      ...new Set(
        retained.flatMap((item) => item.source.claims.map((claim) => claim.id)),
      ),
    ].sort(),
    expectedIds.sort(),
  );
  assert.deepEqual(
    retained.map((item) => [
      item.source.stage,
      item.source.claims.map((claim) => claim.id),
    ]),
    [
      ['investigate', ['lightweight.intake.inspect']],
      ['plan', ['lightweight.route.qualifies']],
      ['build', ['lightweight.build.smallest-complete-change']],
      ['review', ['lightweight.verify.direct-check']],
      ['verify', ['lightweight.verify.direct-check']],
      ['deliver', []],
    ],
  );
  for (const item of retained)
    for (const claim of item.source.claims) {
      const reference = item.attestation.payloads.find(
        (payload) => payload.name === claim.evidenceName,
      )?.reference;
      assert.deepEqual(claim.reference, reference);
      assert.equal(reference.kind, 'other');
      const bytes = await readFile(
        join(f.runDirectory, 'evidence', `${reference.sha256}.artifact`),
      );
      assert.equal(
        createHash('sha256').update(bytes).digest('hex'),
        reference.sha256,
      );
    }
});

test('packaged closeout verifies an independently selected current candidate without mutating the run', async (t) => {
  const fixture = await completeInstalledFixture(t);
  const current = await selectedCurrent(fixture);
  const args = await closeoutArgs(fixture, current);
  const loader = join(fixture.root, 'deny-legacy-loader.mjs');
  await writeFile(
    loader,
    `export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  if (result.url.startsWith(${JSON.stringify(pathToFileURL(repository).href)})) throw Error('Legacy checkout import refused');
  return result;
}\n`,
  );
  const denied = await childResult(
    [
      '--experimental-loader',
      pathToFileURL(loader).href,
      '--input-type=module',
      '-e',
      `import(${JSON.stringify(pathToFileURL(packager).href)})`,
    ],
    1,
  );
  assert.match(denied.stderr, /Legacy checkout import refused/);
  const before = await filesystemSnapshot(
    fixture.runDirectory,
    fixture.candidate,
  );
  const result = await childResult([
    '--experimental-loader',
    pathToFileURL(loader).href,
    ...args,
  ]);
  const verified = JSON.parse(result.stdout);
  assert.equal(verified.entry, 'closeout');
  assert.equal(verified.status, 'candidate-verified');
  assert.equal(verified.scope, 'local-regular-file-candidate-only');
  assert.deepEqual(verified.current, current);
  assert.equal(verified.runId, fixture.request.invocation.runId);
  assert.deepEqual(
    await filesystemSnapshot(fixture.runDirectory, fixture.candidate),
    before,
  );
});

test('packaged closeout refuses a rehashed PASS receipt with a different plan', async (t) => {
  const fixture = await completeInstalledFixture(t);
  const args = await closeoutArgs(fixture, await selectedCurrent(fixture));
  const receiptPath = join(
    fixture.runDirectory,
    'receipts/installed-lightweight.receipt.json',
  );
  const stored = JSON.parse(await readFile(receiptPath, 'utf8'));
  assert.equal(stored.receipt.status, 'PASS');
  assert.equal(stored.receipt.stages.length, 6);
  assert.equal(stored.receipt.plan.review, 'self');
  stored.receipt.plan.review = 'independent';
  stored.sha256 = digest(canonicalReceipt(stored.receipt));
  await writeFile(receiptPath, canonicalReceipt(stored));
  const result = await childResult(args, 1);
  assert(!result.stdout.includes('candidate-verified'));
  assert.match(
    result.stderr,
    /Retained receipt plan differs from admitted policy/,
  );
});

test('packaged closeout refuses changed selection, product, retained records, invocation, and absent stores', async (t) => {
  const fixture = await completeInstalledFixture(t);
  const current = await selectedCurrent(fixture);
  const args = await closeoutArgs(fixture, current);
  const refuse = async (selected = args) => {
    const result = await childResult(selected, 1);
    assert(!result.stdout.includes('candidate-verified'));
    return result;
  };
  await refuse(
    await closeoutArgs(fixture, { ...current, sha256: '0'.repeat(64) }),
  );
  await refuse([...args.slice(0, -1), '0'.repeat(64)]);
  const retainedSelection = join(fixture.runDirectory, 'config/selected.json');
  await writeFile(retainedSelection, JSON.stringify(current));
  const insideRun = [...args];
  insideRun[insideRun.indexOf('--expected-current') + 1] = retainedSelection;
  await refuse(insideRun);
  const product = join(fixture.candidate, 'product.txt');
  const originalMode = (await lstat(product)).mode & 0o777;
  await writeFile(product, 'ALTERED\n');
  await refuse(args);
  await writeFile(product, 'APPLE\nPEAR\n');
  const changedMode =
    originalMode & 0o200 ? originalMode & ~0o222 : originalMode | 0o200;
  await chmod(product, changedMode);
  assert.notEqual(
    (await lstat(product)).mode & 0o777,
    originalMode,
    'The file mode did not change.',
  );
  await refuse(args);
  await chmod(product, originalMode);

  const receipt = join(
    fixture.runDirectory,
    'receipts/installed-lightweight.receipt.json',
  );
  const manifestFile = join(
    fixture.runDirectory,
    'manifests/installed-lightweight.build.workspace.json',
  );
  const source = (await retainedClaims(fixture.runDirectory, 'investigate'))
    .path;
  for (const path of [receipt, manifestFile, source]) {
    const original = await readFile(path);
    await writeFile(path, Buffer.concat([original, Buffer.from('x')]));
    await refuse(args);
    await writeFile(path, original);
  }
  const movedReceipt = join(fixture.root, 'redirected-receipt.json');
  await rename(receipt, movedReceipt);
  await symlink(movedReceipt, receipt);
  await refuse(args);
  await unlink(receipt);
  await rename(movedReceipt, receipt);

  const redirected = join(fixture.root, 'redirected-candidate');
  await cp(fixture.candidate, redirected, { recursive: true });
  await refuse(
    await closeoutArgs(fixture, current, {
      ...fixture.request,
      invocation: {
        ...fixture.request.invocation,
        candidate: {
          ...fixture.request.invocation.candidate,
          root: redirected,
        },
      },
    }),
  );
  const otherRun = join(fixture.root, 'other-run');
  await mkdir(otherRun);
  await refuse(
    await closeoutArgs(fixture, current, {
      ...fixture.request,
      invocation: { ...fixture.request.invocation, runDirectory: otherRun },
    }),
  );
  for (const name of ['receipts', 'evidence', 'manifests', 'checkpoints']) {
    const path = join(fixture.runDirectory, name);
    const moved = join(fixture.root, `missing-${name}`);
    await rename(path, moved);
    await refuse(args);
    await assert.rejects(lstat(path), { code: 'ENOENT' });
    await rename(moved, path);
  }
  const evidenceRoot = join(fixture.runDirectory, 'evidence');
  const movedEvidence = join(fixture.root, 'redirected-evidence');
  await rename(evidenceRoot, movedEvidence);
  await symlink(movedEvidence, evidenceRoot);
  await refuse(args);
  await unlink(evidenceRoot);
  await rename(movedEvidence, evidenceRoot);
  await rename(receipt, join(fixture.root, 'missing-receipt.json'));
  await refuse(args);
  await assert.rejects(lstat(receipt), { code: 'ENOENT' });
});

test('packaged closeout refuses a genuine non-PASS terminal run', async (t) => {
  const fixture = await installedFixture(t);
  const session = fixture.launch();
  const stage = await session.next();
  assert.equal(stage.type, 'stage');
  await writeFile(
    join(stage.workspace, 'host-result.json'),
    JSON.stringify({
      schemaVersion: 1,
      sessionId: stage.sessionId,
      requestId: stage.requestId,
      stage: stage.stage,
      status: 'ISSUES',
      summary: 'Synthetic issue stops the run.',
      evidence: [],
    }),
  );
  session.reply(stage);
  const completed = await session.next();
  assert.equal(completed.type, 'complete');
  assert.equal(completed.status, 'ISSUES');
  assert.notEqual((await session.done).code, 0);
  const args = await closeoutArgs(fixture, {
    scope: 'local-regular-files-v1',
    sha256: '0'.repeat(64),
  });
  const result = await childResult(args, 1);
  assert(!result.stdout.includes('candidate-verified'));
});

test('restart refuses changed retained source requirement references', async (t) => {
  const f = await installedFixture(t);
  const first = f.launch();
  await answerStage(f, first, await first.next());
  assert.equal((await first.next()).type, 'checkpoint');
  first.child.stdin.end();
  assert.notEqual((await first.done).code, 0);
  const retained = await retainedClaims(f.runDirectory, 'investigate');
  assert.equal(retained.source.claims[0].id, 'lightweight.intake.inspect');
  const claimed = retained.source.claims[0].reference.sha256;
  retained.source.claims[0].reference.sha256 = `${claimed.slice(0, -1)}${claimed.endsWith('0') ? '1' : '0'}`;
  await writeFile(retained.path, JSON.stringify(retained.source));
  const resumed = await f.launch('resume').done;
  assert.notEqual(resumed.code, 0);
  assert(!resumed.messages.some((message) => message.type === 'stage'));
  assert.match(resumed.stderr, /hash changed|source kind|source reference/i);
});

test('restart refuses a changed source profile in the retained descriptor', async (t) => {
  const f = await installedFixture(t);
  const first = f.launch();
  await answerStage(f, first, await first.next());
  assert.equal((await first.next()).type, 'checkpoint');
  first.child.stdin.end();
  assert.notEqual((await first.done).code, 0);
  const descriptorPath = join(f.runDirectory, 'config/input.json');
  const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8'));
  descriptor.sourceProfile = 'feature-v1';
  await writeFile(descriptorPath, JSON.stringify(descriptor));
  const resumed = await f.launch('resume').done;
  assert.notEqual(resumed.code, 0);
  assert(!resumed.messages.some((message) => message.type === 'stage'));
  assert.match(resumed.stderr, /Retained source profile differs/);
});

test('installed entry refuses altered artifact, request, route, obligations, capability labels, and retained evidence', async (t) => {
  for (const mode of [
    'policy',
    'package',
    'profile',
    'playbook',
    'request',
    'route',
    'obligations',
    'capabilities',
    'worker-receipt',
    'qa',
    'full',
    'qa-template',
  ]) {
    await t.test(mode, async (t) => {
      const f = await installedFixture(t);
      if (mode === 'policy')
        await writeFile(join(f.artifact, 'policy.json'), '{}');
      if (mode === 'package')
        await writeFile(
          join(f.artifact, 'host/entry.mjs'),
          'throw Error("altered")',
        );
      if (mode === 'qa-template')
        await writeFile(
          join(
            f.artifact,
            'skills/qa-review-verification/assets/ticket-comment.md',
          ),
          'altered template',
        );
      if (mode === 'profile')
        await writeFile(
          join(f.artifact, 'source/lightweight-engineering.json'),
          '{}',
        );
      if (mode === 'playbook')
        await writeFile(
          join(f.artifact, 'source/lightweight-engineering.md'),
          'changed',
        );
      if (mode === 'request')
        await writeFile(
          f.requestPath,
          JSON.stringify({ ...f.request, profile: 'feature-v1' }),
        );
      if (mode === 'route') {
        f.request.routeInput.lightweight.isMigration = true;
        await writeFile(f.requestPath, JSON.stringify(f.request));
      }
      if (mode === 'obligations') {
        f.request.obligations.review = 'independent';
        await writeFile(f.requestPath, JSON.stringify(f.request));
      }
      if (mode === 'capabilities') {
        f.request.capabilities = ['subagents'];
        await writeFile(f.requestPath, JSON.stringify(f.request));
      }
      if (mode === 'worker-receipt') {
        const receiptPath = join(f.root, 'worker-receipt.json');
        await writeFile(receiptPath, JSON.stringify({ status: 'PASS' }));
        await writeFile(
          f.requestPath,
          JSON.stringify(request('temari', { workerReceipt: receiptPath })),
        );
      }
      if (mode === 'qa') {
        f.request.route = 'qa-review';
        f.request.profile = 'qa-review-v1';
        await writeFile(f.requestPath, JSON.stringify(f.request));
      }
      if (mode === 'full')
        await writeFile(f.requestPath, JSON.stringify(request('temari')));
      const digest = [
        'route',
        'obligations',
        'capabilities',
        'worker-receipt',
        'qa',
        'full',
      ].includes(mode)
        ? createHash('sha256')
            .update(await readFile(f.requestPath))
            .digest('hex')
        : undefined;
      const result = await f.launch('start', digest).done;
      assert.notEqual(result.code, 0);
      assert(!result.messages.some((message) => message.type === 'stage'));
      await assert.rejects(lstat(f.runDirectory), { code: 'ENOENT' });
      if (
        ['policy', 'package', 'profile', 'playbook', 'qa-template'].includes(
          mode,
        )
      )
        assert.match(result.stderr, /Artifact (bytes|size) changed/);
      if (mode === 'request')
        assert.match(
          result.stderr,
          /Request bytes differ from trusted invocation/,
        );
      if (mode === 'route')
        assert.deepEqual(result.messages[0].reasons, [
          'lightweight-conditions-not-proven',
        ]);
      if (mode === 'obligations')
        assert.deepEqual(result.messages[0].reasons, [
          'obligations-not-admitted',
        ]);
      if (mode === 'capabilities')
        assert.match(result.stderr, /unknown or missing fields/);
      if (mode === 'worker-receipt')
        assert.match(result.stderr, /unknown or missing fields/);
      if (mode === 'qa')
        assert(result.messages[0].reasons.includes('route-not-admitted'));
      if (mode === 'full') {
        assert.deepEqual(result.messages[0].reasons, [
          'host-capability-proof-missing',
        ]);
        assert.deepEqual(result.messages[0].missingCapabilities, [
          'subagents',
          'forge',
        ]);
      }
    });
  }
  const f = await installedFixture(t);
  const first = f.launch();
  const stage = await first.next();
  await answerStage(f, first, stage);
  assert.equal((await first.next()).type, 'checkpoint');
  first.child.stdin.end();
  assert.notEqual((await first.done).code, 0);
  await writeFile(join(stage.workspace, 'evidence.txt'), 'altered evidence\n');
  const resumed = await f.launch('resume').done;
  assert.notEqual(resumed.code, 0);
  assert(!resumed.messages.some((message) => message.type === 'stage'));
  await assert.rejects(
    lstat(join(f.runDirectory, 'receipts/installed-lightweight.receipt.json')),
    { code: 'ENOENT' },
  );
});
