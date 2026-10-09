import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  packageCanonicalRuntime,
  checkCanonicalArtifact,
} from './canonical-runtime.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const stages = ['investigate', 'plan', 'build', 'review', 'verify', 'deliver'];
let buildRoot;
let output;
let manifest;

before(async () => {
  buildRoot = await realpath(
    await mkdtemp(join(tmpdir(), 'temari canonical build-')),
  );
  output = join(buildRoot, 'artifact');
  manifest = await packageCanonicalRuntime(output);
});
after(async () => {
  if (buildRoot) await rm(buildRoot, { recursive: true, force: true });
});

async function relocated(t) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'temari relocated café-')),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifact = join(root, 'artifact');
  await cp(output, artifact, { recursive: true });
  return { root, artifact };
}

async function child(args, options = {}, expectedCode = 0) {
  const result = await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      args,
      { timeout: 30_000, maxBuffer: 1024 * 1024, encoding: 'utf8', ...options },
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

test('canonical artifact contains only compiled production packages and verifies after relocation', async (t) => {
  const { artifact } = await relocated(t);
  assert.deepEqual(await checkCanonicalArtifact(artifact, manifest), manifest);
  assert(manifest.files.length > 4);
  assert(!JSON.stringify(manifest).includes(repository));
  for (const file of manifest.files) {
    assert(
      !/\.test\.|\/demo\/|\/fixtures\/|\.map$|tsbuildinfo/.test(file.path),
      file.path,
    );
    assert(/\.(?:m?js|d\.ts|json|py)$/.test(file.path), file.path);
    const text = await readFile(join(artifact, file.path), 'utf8');
    assert(!text.includes(repository), file.path);
    assert(!text.includes('@swc-node/register'), file.path);
  }
  for (const name of [
    'contracts',
    'temari-core',
    'workflow-engine',
    'runtime',
    'knowledge',
    'privacy',
    'host-adapters',
    'plan-draft',
    'archon-harness',
  ]) {
    const pkg = JSON.parse(
      await readFile(
        join(artifact, 'node_modules', '@temari', name, 'package.json'),
        'utf8',
      ),
    );
    assert.equal(pkg.name, `@temari/${name}`);
    assert.equal(pkg.type, 'module');
    assert(!JSON.stringify(pkg).includes('workspace:'));
    assert(!JSON.stringify(pkg).includes('@org/source'));
  }
  const knowledge = JSON.parse(
    await readFile(
      join(artifact, 'node_modules/@temari/knowledge/package.json'),
      'utf8',
    ),
  );
  assert.deepEqual(knowledge.bin, {
    'temari-knowledge': './src/demo.js',
  });
  assert.equal(knowledge.exports['./cli'], './src/demo.js');
  assert.match(
    await readFile(
      join(artifact, 'node_modules/@temari/knowledge/src/demo.js'),
      'utf8',
    ),
    /^#!\/usr\/bin\/env node\n/,
  );
  assert(
    manifest.files.some(
      (file) => file.path === 'node_modules/@temari/knowledge/src/support/prepare.py',
    ),
  );
});

test('relocated knowledge API and CLI run with stock Node and no workspace loader', async (t) => {
  const { artifact } = await relocated(t);
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  const imported = await child(
    [
      '--permission',
      `--allow-fs-read=${artifact}`,
      '--input-type=module',
      '-e',
      'import * as knowledge from "@temari/knowledge"; console.log(JSON.stringify([typeof knowledge.createLocalRegistrar, typeof knowledge.captureArchive]));',
    ],
    { cwd: artifact, env },
  );
  assert.deepEqual(JSON.parse(imported.stdout), ['function', 'function']);
  const cli = await child(
    [
      '--permission',
      `--allow-fs-read=${artifact}`,
      join(artifact, 'node_modules/@temari/knowledge/src/demo.js'),
      '--help',
    ],
    { cwd: artifact, env },
  );
  assert.match(cli.stdout, /journey-intake --input/);
  assert.match(cli.stdout, /journey-query --input/);
  assert.match(cli.stdout, /journey-jobs-tick --spec/);
});

test('relocated managed APIs preserve the shared policy and privacy without source access', async (t) => {
  const { artifact } = await relocated(t);
  const env = { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' };
  const result = await child(
    [
      '--permission',
      `--allow-fs-read=${artifact}`,
      '--input-type=module',
      '-e',
      `import assert from 'node:assert/strict';
     import {workerEfficiencyPolicy} from '@temari/contracts';
     import {createProtectedModelTransport,runCodexExecWorker} from '@temari/host-adapters';
     import {createCommandJudgments} from '@temari/plan-draft';
     import {ArchonHarness} from '@temari/archon-harness';
     import {assessmentPolicy,proposalPolicy,reviewPolicy} from './node_modules/@temari/plan-draft/src/lib/judgment-policy.js';
     assert.equal(typeof runCodexExecWorker,'function');
     assert.equal(typeof createCommandJudgments,'function');
     assert.equal(typeof ArchonHarness,'function');
     for(const policy of [assessmentPolicy,proposalPolicy,reviewPolicy]) {
       assert.equal(policy.revision,2);
       assert(policy.instructions.includes(workerEfficiencyPolicy.instructions));
       assert(policy.instructions.includes('Do not execute tools'));
     }
     let sent;
     const transport=createProtectedModelTransport({async complete(request){sent=request.prompt;return 'Checked';}}, {
       policy:{literals:[{value:'synthetic@example.invalid',kind:'EMAIL'},{value:'fixture-secret',kind:'CREDENTIAL'}]},
     });
     const reply=await transport.complete({prompt:'Inspect synthetic@example.invalid. password=fixture-secret'});
     assert(sent.includes(workerEfficiencyPolicy.id));
     assert(!sent.includes('synthetic@example.invalid'));
     assert(!sent.includes('fixture-secret'));
     assert.equal(reply.text,'Checked');reply.dispose();
     console.log(JSON.stringify({policy:workerEfficiencyPolicy.id,privacy:'masked',knowledgePolicies:3}));`,
    ],
    { cwd: artifact, env },
  );
  assert.deepEqual(JSON.parse(result.stdout), {
    policy: 'temari-worker-efficiency/v1',
    privacy: 'masked',
    knowledgePolicies: 3,
  });
});

test('relocated knowledge prepare command finds its packaged helper', async (t) => {
  const { root, artifact } = await relocated(t);
  const snapshots = join(root, 'snapshots');
  await mkdir(snapshots);
  const documents = [];
  for (const [snapshot, role] of [
    ['plan.txt', 'plan'],
    ['update.txt', 'update'],
  ]) {
    const bytes = Buffer.from(`${role} fixture\n`);
    await writeFile(join(snapshots, snapshot), bytes);
    documents.push({
      snapshot,
      role,
      origin: 'packaged CLI test',
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  const selected = join(root, 'selected.json');
  await writeFile(selected, JSON.stringify({ snapshotRoot: snapshots, documents }));
  const python = join(root, 'python-shim');
  await writeFile(
    python,
    '#!/bin/sh\ntest -f "$2" || exit 17\nprintf \'{"sourceId":"fixture","receipt":{"status":"complete"}}\\n\'\n',
    { mode: 0o700 },
  );
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  const result = await child(
    [
      join(artifact, 'node_modules/@temari/knowledge/src/demo.js'),
      'prepare',
      '--manifest',
      selected,
      '--python',
      python,
      '--registrar-source',
      root,
    ],
    { cwd: root, env },
  );
  const prepared = JSON.parse(result.stdout);
  t.after(() => rm(prepared.base, { recursive: true, force: true }));
  assert.equal(prepared.source.id, 'fixture');
  assert.equal(prepared.config.registrarSource, root);
  assert.equal(prepared.input, join(prepared.base, 'input.json'));
});

test('compiled archive adapter hashes emitted JavaScript and refuses changed bytes', async (t) => {
  const { root, artifact } = await relocated(t);
  const registrar = join(root, 'registrar');
  await mkdir(join(registrar, 'src'), { recursive: true });
  await mkdir(join(registrar, 'docs/design'), { recursive: true });
  await writeFile(join(registrar, 'src/cli.py'), 'pass\n');
  await writeFile(join(registrar, 'pyproject.toml'), '[project]\nname="fixture"\n');
  await writeFile(join(registrar, 'uv.lock'), 'fixture\n');
  await writeFile(
    join(registrar, 'docs/design/source-archive-contract-v1.json'),
    '{}\n',
  );
  const adapter = await import(
    pathToFileURL(
      join(artifact, 'node_modules/@temari/knowledge/src/lib/archive-transport.js'),
    ).href
  );
  const transport = await adapter.archiveTransport({
    python: process.execPath,
    registrarSource: registrar,
    workspace: root,
  });
  assert.match(transport.implementation, /^[a-f0-9]{64}$/);
  const codec = join(
    artifact,
    'node_modules/@temari/knowledge/src/lib/codec.js',
  );
  const bytes = await readFile(codec);
  const altered = Buffer.from(bytes);
  altered[0] ^= 1;
  await writeFile(codec, altered);
  await assert.rejects(transport.invoke('list', []), /Archive implementation changed/);
  await assert.rejects(checkCanonicalArtifact(artifact, manifest), /integrity/i);
});

test('compiled local registrar hashes emitted JavaScript and detects adapter tampering', async (t) => {
  const { root, artifact } = await relocated(t);
  const registrar = join(root, 'registrar');
  const state = join(root, 'state');
  const sources = join(root, 'sources');
  await mkdir(join(registrar, 'src'), { recursive: true });
  await mkdir(state);
  await mkdir(sources);
  await writeFile(join(registrar, 'src/cli.py'), 'pass\n');
  await writeFile(join(registrar, 'pyproject.toml'), '[project]\nname="fixture"\n');
  await writeFile(join(registrar, 'uv.lock'), 'fixture\n');
  await writeFile(join(state, 'registry.sqlite3'), 'fixture\n');
  const python = join(root, 'python-shim');
  await writeFile(
    python,
    `#!/bin/sh\ncat <<'EOF'\n${JSON.stringify({
      sources: [{
        id: 'fixture-source',
        root: sources,
        kind: 'local',
        recursive: false,
        exclude: [],
        enabled: true,
        generation: 'fixture-generation',
      }],
    })}\nEOF\n`,
    { mode: 0o700 },
  );
  const preparation = join(root, 'preparation.json');
  await writeFile(preparation, JSON.stringify({
    kind: 'temari-knowledge-isolated',
    schema: 1,
    state,
    root: sources,
    instance: 'fixture-instance',
    sourceId: 'fixture-source',
  }));
  const knowledge = await import(
    pathToFileURL(join(artifact, 'node_modules/@temari/knowledge/src/index.js')).href
  );
  const provider = await knowledge.createLocalRegistrar({
    python,
    registrarSource: registrar,
    preparation,
    readScope: 'source-root',
  });
  assert.match(provider.identity.implementation, /^registrar-source\+adapter\+python-binary:[a-f0-9]{64}$/);
  const codec = join(artifact, 'node_modules/@temari/knowledge/src/lib/codec.js');
  const bytes = await readFile(codec);
  const altered = Buffer.from(bytes);
  altered[0] ^= 1;
  await writeFile(codec, altered);
  const result = await provider.discover({
    scope: [{
      provider: 'fixture-instance',
      id: 'fixture-source',
      locator: pathToFileURL(sources).href,
    }],
    query: 'fixture',
    limit: 1,
    maxBytes: 1024,
    continuation: null,
  });
  assert.equal(result.ok, false);
  assert.match(result.gap.detail, /Provider implementation changed/);
});

test('relocated stock Node resumes an acknowledged prefix and verifies bytes with isolated readback', async (t) => {
  const { root, artifact } = await relocated(t);
  const state = join(root, 'state');
  await mkdir(state);
  const consumer = join(root, 'consumer.mjs');
  await copyFile(
    new URL('./fixtures/canonical-consumer.mjs', import.meta.url),
    consumer,
  );
  await writeFile(join(state, 'source.txt'), 'pear\napple\n');
  const runId = randomUUID();
  const revision = 'packaged-pear-apple-fixture-v1';
  await writeFile(
    join(state, 'request.json'),
    JSON.stringify({
      runId,
      revision,
      request: {
        workType: 'feature',
        obligations: { evidence: 'revision-bound' },
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
    }),
  );
  const blocked = [
    join(repository, 'libs/runtime/src/index.ts'),
    join(repository, 'node_modules/typescript/package.json'),
    join(output, 'canonical-manifest.json'),
  ];
  for (const path of blocked) await access(path);
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  const run = (mode, expectedCode = 0) =>
    child(
      [
        // Node permission mode disables fsync; use it for the readback, not writes.
        ...(mode === 'inspect'
          ? [
              '--permission',
              `--allow-fs-read=${artifact}`,
              `--allow-fs-read=${consumer}`,
              `--allow-fs-read=${state}`,
              `--allow-fs-write=${state}`,
            ]
          : []),
        consumer,
        artifact,
        state,
        mode,
        JSON.stringify(blocked),
      ],
      { cwd: root, env },
      expectedCode,
    );
  await run('interrupt', 73);
  const prefix = JSON.parse(
    await readFile(join(state, 'acknowledged-prefix.json'), 'utf8'),
  );
  assert.deepEqual(
    prefix.stages.map((s) => s.stage),
    stages.slice(0, 3),
  );
  assert.equal(prefix.revision, revision);
  const attestationPath = join(
    state,
    'evidence',
    `${prefix.stages[0].stageEvidence.sha256}.artifact`,
  );
  const attestationBytes = await readFile(attestationPath);
  const handlersBeforeResume = await readFile(
    join(state, 'handlers.jsonl'),
    'utf8',
  );
  await unlink(attestationPath);
  await run('resume', 1);
  const changedAttestation = Buffer.from(attestationBytes);
  changedAttestation[0] ^= 1;
  await writeFile(attestationPath, changedAttestation);
  await run('resume', 1);
  assert.equal(
    await readFile(join(state, 'handlers.jsonl'), 'utf8'),
    handlersBeforeResume,
  );
  await assert.rejects(
    access(join(state, 'receipts', `${runId}.receipt.json`)),
    { code: 'ENOENT' },
  );
  await writeFile(attestationPath, attestationBytes);
  await run('resume');
  const { stdout } = await run('inspect');
  const { receipt, checkpoint, artifacts, verified } = JSON.parse(stdout);
  assert.equal(receipt.evidenceProfile, 'stage-evidence-v1');
  assert.equal(checkpoint.evidenceProfile, 'stage-evidence-v1');
  assert.equal(verified.status, 'evidence-verified');
  assert.equal(verified.scope, 'persisted-stage-evidence-only');
  assert.deepEqual(
    verified.stages.map((s) => s.payloads[0].text),
    [
      'investigate:\npear\napple\n',
      'plan:\nuppercase-sort',
      'build:\nAPPLE\nPEAR\n',
      'review:\nAPPLE\nPEAR\n',
      'verify:\nAPPLE\nPEAR\n',
      'deliver:\nAPPLE\nPEAR\n',
    ],
  );
  assert.equal(receipt.runId, runId);
  assert.equal(receipt.revision, revision);
  assert.equal(receipt.status, 'PASS');
  assert.equal(receipt.failure, null);
  assert.equal(receipt.startedAt, prefix.startedAt);
  assert.deepEqual(receipt.stages.slice(0, 3), prefix.stages);
  assert.deepEqual(
    receipt.stages.map((s) => s.stage),
    stages,
  );
  assert.deepEqual(checkpoint.stages, receipt.stages);
  assert.deepEqual(
    (await readFile(join(state, 'handlers.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)),
    stages,
  );
  assert.deepEqual(
    artifacts.map((a) => a.stage),
    stages,
  );
  assert.equal(artifacts.at(-1).text, 'APPLE\nPEAR\n');
  assert.equal(
    await readFile(join(state, 'workspaces/deliver/result.txt'), 'utf8'),
    'APPLE\nPEAR\n',
  );
  assert.deepEqual(await checkCanonicalArtifact(artifact, manifest), manifest);
  const attestation = JSON.parse(attestationBytes.toString('utf8'));
  const payloadPath = join(
    state,
    'evidence',
    `${attestation.payloads[0].reference.sha256}.artifact`,
  );
  const payloadBytes = await readFile(payloadPath);
  await unlink(payloadPath);
  await run('inspect', 1);
  const changedPayload = Buffer.from(payloadBytes);
  changedPayload[0] ^= 1;
  await writeFile(payloadPath, changedPayload);
  await run('inspect', 1);
  await writeFile(payloadPath, payloadBytes);
  await run('inspect');
});

test('canonical inventory rejects missing and same-size tampered dependency bytes', async (t) => {
  const { artifact } = await relocated(t);
  const dependency = join(
    artifact,
    'node_modules/@temari/contracts/src/index.js',
  );
  const bytes = await readFile(dependency);
  await unlink(dependency);
  await assert.rejects(
    checkCanonicalArtifact(artifact, manifest),
    /missing|inventory|files/i,
  );
  const altered = Buffer.from(bytes);
  altered[0] = altered[0] === 120 ? 121 : 120;
  await writeFile(dependency, altered);
  await assert.rejects(
    checkCanonicalArtifact(artifact, manifest),
    /hash|digest|integrity/i,
  );
  await writeFile(dependency, bytes);
  assert.deepEqual(await checkCanonicalArtifact(artifact, manifest), manifest);
});

async function candidateFixture(t) {
  const { root, artifact } = await relocated(t);
  const state = join(root, 'candidate-state');
  await mkdir(state);
  const consumer = join(root, 'candidate-consumer.mjs');
  await copyFile(
    new URL('./fixtures/canonical-candidate-consumer.mjs', import.meta.url),
    consumer,
  );
  const runId = randomUUID();
  const revision = 'candidate-changing-fixture-v1';
  await writeFile(
    join(state, 'request.json'),
    JSON.stringify({ runId, revision }),
  );
  const blocked = [
    join(repository, 'libs/runtime/src/index.ts'),
    join(repository, 'node_modules/typescript/package.json'),
    join(output, 'canonical-manifest.json'),
  ];
  for (const path of blocked) await access(path);
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  const run = (mode, expectedCode = 0) =>
    child(
      [
        ...(mode === 'inspect'
          ? [
              '--permission',
              `--allow-fs-read=${artifact}`,
              `--allow-fs-read=${consumer}`,
              `--allow-fs-read=${state}`,
              `--allow-fs-write=${state}`,
            ]
          : []),
        consumer,
        artifact,
        state,
        mode,
        JSON.stringify(blocked),
      ],
      { cwd: root, env },
      expectedCode,
    );
  await run('prepare');
  const product = join(state, 'candidate', 'product.txt');
  const built = 'APPLE\nPEAR\n';
  const expected = {
    scope: 'local-regular-files-v1',
    sha256: createHash('sha256')
      .update(
        JSON.stringify([
          'local-regular-files-v1',
          [
            [
              'product.txt',
              (await stat(product)).mode & 0o777,
              Buffer.byteLength(built),
              createHash('sha256').update(built).digest('hex'),
            ],
          ],
        ]),
      )
      .digest('hex'),
  };
  const expectedPath = join(state, 'expected-current.json');
  await writeFile(expectedPath, JSON.stringify(expected));
  const history = async () =>
    readFile(join(state, 'logs', 'handlers.jsonl'), 'utf8');
  const prefix = async () =>
    JSON.parse(
      await readFile(join(state, 'logs', 'acknowledged-prefix.json'), 'utf8'),
    );
  const noReceipt = () =>
    assert.rejects(access(join(state, 'receipts', `${runId}.receipt.json`)), {
      code: 'ENOENT',
    });
  return {
    state,
    artifact,
    runId,
    revision,
    run,
    product,
    built,
    expected,
    expectedPath,
    history,
    prefix,
    noReceipt,
  };
}

test('compiled candidate build changes A to B, resumes exact history and refuses stale closeout', async (t) => {
  const f = await candidateFixture(t);
  await f.run('interrupt-build', 73);
  const prefix = await f.prefix();
  assert.equal(prefix.evidenceProfile, 'candidate-stage-evidence-v1');
  assert.deepEqual(
    prefix.stages.map((s) => s.stage),
    stages.slice(0, 3),
  );
  const initial = JSON.parse(
    await readFile(join(f.state, 'initial.json'), 'utf8'),
  );
  assert.deepEqual(prefix.candidateBinding, {
    scopeId: 'packaged-product',
    initial,
  });
  assert.notDeepEqual(initial, f.expected);
  assert.equal(await readFile(f.product, 'utf8'), f.built);
  const history = await f.history();
  await writeFile(f.product, 'STALE\nPEAR\n');
  await f.run('resume', 1);
  assert.equal(await f.history(), history);
  await f.noReceipt();
  await writeFile(f.product, f.built);
  const attestationPath = join(
    f.state,
    'evidence',
    `${prefix.stages[2].stageEvidence.sha256}.artifact`,
  );
  const attestationBytes = await readFile(attestationPath);
  await unlink(attestationPath);
  await f.run('resume', 1);
  assert.equal(await f.history(), history);
  await f.noReceipt();
  await writeFile(attestationPath, attestationBytes);
  await f.run('resume');
  const result = JSON.parse((await f.run('inspect')).stdout);
  assert.equal(result.receipt.status, 'PASS');
  assert.equal(result.receipt.revision, f.revision);
  assert.equal(result.receipt.startedAt, prefix.startedAt);
  assert.deepEqual(result.receipt.stages.slice(0, 3), prefix.stages);
  assert.deepEqual(result.checkpoint.stages, result.receipt.stages);
  assert.equal(result.verified.status, 'candidate-verified');
  assert.equal(result.verified.scope, 'local-regular-file-candidate-only');
  assert.deepEqual(result.verified.initial, initial);
  assert.deepEqual(result.verified.current, f.expected);
  assert.equal(result.product, f.built);
  assert.deepEqual(
    (await f.history()).trim().split('\n').map(JSON.parse),
    stages,
  );
  for (const [index, stage] of result.receipt.stages.entries()) {
    const record = JSON.parse(
      await readFile(
        join(f.state, 'evidence', `${stage.stageEvidence.sha256}.artifact`),
        'utf8',
      ),
    );
    assert.equal(record.schema, 2);
    assert.deepEqual(record.candidate.binding, prefix.candidateBinding);
    assert.deepEqual(
      record.candidate.before,
      index <= 2 ? initial : f.expected,
    );
    assert.deepEqual(record.candidate.after, index < 2 ? initial : f.expected);
  }
  await writeFile(f.expectedPath, JSON.stringify(initial));
  await f.run('inspect', 1);
  await writeFile(f.expectedPath, JSON.stringify(f.expected));
  await writeFile(f.product, 'CHANGED AFTER REVIEW\n');
  await f.run('inspect', 1);
  await writeFile(f.product, f.built);
  const stageArtifact = join(f.state, 'workspaces', 'review', 'result.txt');
  await writeFile(stageArtifact, 'altered review artifact');
  await f.run('inspect', 1);
  await writeFile(stageArtifact, f.built);
  const attestation = JSON.parse(attestationBytes);
  const payloadPath = join(
    f.state,
    'evidence',
    `${attestation.payloads[0].reference.sha256}.artifact`,
  );
  const payload = await readFile(payloadPath);
  await unlink(payloadPath);
  await f.run('inspect', 1);
  const altered = Buffer.from(payload);
  altered[0] ^= 1;
  await writeFile(payloadPath, altered);
  await f.run('inspect', 1);
  await writeFile(payloadPath, payload);
  await f.run('inspect');
  const completedHistory = await f.history();
  await f.run('resume', 1);
  assert.equal(await f.history(), completedHistory);
  assert.deepEqual(
    await checkCanonicalArtifact(f.artifact, manifest),
    manifest,
  );
});

test('compiled candidate recovery retains empty initial intent before any handler', async (t) => {
  const f = await candidateFixture(t);
  await f.run('interrupt-empty', 73);
  const prefix = await f.prefix();
  assert.deepEqual(prefix.stages, []);
  await assert.rejects(f.history(), { code: 'ENOENT' });
  await writeFile(f.product, 'unacknowledged change');
  await f.run('resume', 1);
  await assert.rejects(f.history(), { code: 'ENOENT' });
  await f.noReceipt();
  await writeFile(f.product, 'pear\napple\n');
  await f.run('resume');
  const result = JSON.parse((await f.run('inspect')).stdout);
  assert.equal(result.receipt.startedAt, prefix.startedAt);
  assert.deepEqual(result.receipt.candidateBinding, prefix.candidateBinding);
  assert.deepEqual(
    (await f.history()).trim().split('\n').map(JSON.parse),
    stages,
  );
});

test('compiled complete candidate checkpoint revalidates without replaying handlers', async (t) => {
  const f = await candidateFixture(t);
  await f.run('interrupt-complete', 73);
  const prefix = await f.prefix();
  assert.equal(prefix.stages.length, 6);
  const history = await f.history();
  await f.noReceipt();
  await writeFile(f.product, 'unacknowledged post-delivery change');
  await f.run('resume', 1);
  assert.equal(await f.history(), history);
  await f.noReceipt();
  await writeFile(f.product, f.built);
  await f.run('resume');
  const result = JSON.parse((await f.run('inspect')).stdout);
  assert.equal(await f.history(), history);
  assert.deepEqual(result.receipt.stages, prefix.stages);
  assert.equal(result.receipt.startedAt, prefix.startedAt);
});

test('compiled pre-acknowledgment build crash cannot silently adopt changed candidate', async (t) => {
  const f = await candidateFixture(t);
  await f.run('interrupt-unacknowledged', 74);
  assert.equal(await readFile(f.product, 'utf8'), f.built);
  const history = await f.history();
  const checkpointPath = join(
    f.state,
    'checkpoints',
    `${f.runId}.checkpoint.json`,
  );
  const checkpoint = await readFile(checkpointPath, 'utf8');
  assert.equal(JSON.parse(checkpoint).checkpoint.stages.length, 2);
  await f.run('resume', 1);
  assert.equal(await f.history(), history);
  assert.equal(await readFile(checkpointPath, 'utf8'), checkpoint);
  await f.noReceipt();
});

test('compiled candidate recovery refuses an orphan manifest even when candidate bytes match', async (t) => {
  const f = await candidateFixture(t);
  await f.run('interrupt-orphan', 75);
  assert.equal(await readFile(f.product, 'utf8'), 'pear\napple\n');
  const history = await f.history();
  assert.deepEqual(history.trim().split('\n').map(JSON.parse), ['investigate']);
  const checkpointPath = join(
    f.state,
    'checkpoints',
    `${f.runId}.checkpoint.json`,
  );
  const checkpoint = await readFile(checkpointPath, 'utf8');
  assert.deepEqual(JSON.parse(checkpoint).checkpoint.stages, []);
  await f.run('resume', 1);
  assert.equal(await f.history(), history);
  assert.equal(await readFile(checkpointPath, 'utf8'), checkpoint);
  await f.noReceipt();
});

test('canonical inventory rejects unknown files and links', async (t) => {
  const { root, artifact } = await relocated(t);
  const extra = join(artifact, 'unexpected.txt');
  await writeFile(extra, 'not part of the artifact');
  await assert.rejects(
    checkCanonicalArtifact(artifact, manifest),
    /unknown|unexpected|inventory|files/i,
  );
  await unlink(extra);
  await symlink(root, join(artifact, 'outside-link'), 'junction');
  await assert.rejects(
    checkCanonicalArtifact(artifact, manifest),
    /link|regular|directory/i,
  );
});

test('canonical inventory rejects escaping paths and rewritten manifests', async (t) => {
  const { artifact } = await relocated(t);
  const path = join(artifact, 'canonical-manifest.json');
  const escaped = structuredClone(manifest);
  escaped.files[0].path = '../outside.txt';
  await writeFile(path, JSON.stringify(escaped));
  await assert.rejects(
    checkCanonicalArtifact(artifact),
    /path|safe|inventory/i,
  );
  const rewritten = structuredClone(manifest);
  const file = rewritten.files.find((entry) =>
    entry.path.endsWith('/contracts/src/index.js'),
  );
  assert(file);
  const bytes = await readFile(join(artifact, file.path));
  bytes[0] = bytes[0] === 120 ? 121 : 120;
  await writeFile(join(artifact, file.path), bytes);
  file.sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(path, JSON.stringify(rewritten));
  await assert.rejects(
    checkCanonicalArtifact(artifact, manifest),
    /manifest|expected|identity/i,
  );
});

test('packaging refuses to replace an existing destination', async (t) => {
  const { root } = await relocated(t);
  const existing = join(root, 'existing');
  await mkdir(existing);
  await writeFile(join(existing, 'keep.txt'), 'original');
  await assert.rejects(
    packageCanonicalRuntime(existing),
    /exist|empty|destination/i,
  );
  assert.equal(await readFile(join(existing, 'keep.txt'), 'utf8'), 'original');
});
