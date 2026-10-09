import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  checkHistoricalKnowledgePlugin,
  checkKnowledgePlugin,
  packageKnowledgePlugin,
  readRegularSource,
} from './knowledge-plugin.mjs';

let root;
let artifact;
let manifest;
let expected;

before(async () => {
  root = await realpath(
    await mkdtemp(join(tmpdir(), 'content-registrar-plugin-')),
  );
  artifact = join(root, 'built');
  manifest = await packageKnowledgePlugin(artifact);
  expected = createHash('sha256')
    .update(await readFile(join(artifact, 'knowledge-plugin-manifest.json')))
    .digest('hex');
});

test('historical plugin without intake guidance remains historical, never a current candidate', async () => {
  const historical = join(root, 'historical-without-intake');
  await cp(artifact, historical, { recursive: true });
  const reference =
    'skills/content-registrar-knowledge/references/evidence-intake.md';
  await rm(join(historical, reference));
  const vintage = structuredClone(manifest);
  vintage.files = vintage.files.filter((file) => file.path !== reference);
  vintage.source.additionalFiles = vintage.source.additionalFiles.filter(
    (file) =>
      file.path !==
      'packages/workflow-runtime/public/skills/temari-knowledge/references/evidence-intake.md',
  );
  const bytes = Buffer.from(`${JSON.stringify(vintage, null, 2)}\n`);
  await writeFile(join(historical, 'knowledge-plugin-manifest.json'), bytes);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const upstreamBytes = await readFile(
    join(historical, 'registrar/UPSTREAM.json'),
  );
  const provenance = {
    commit: JSON.parse(upstreamBytes).upstream.commit,
    manifestSha256: createHash('sha256').update(upstreamBytes).digest('hex'),
  };
  assert.deepEqual(
    await checkHistoricalKnowledgePlugin(historical, digest, provenance),
    vintage,
  );
  await assert.rejects(checkKnowledgePlugin(historical, digest), /deep-equal/);
});

after(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

function run(file, args, options = {}) {
  return execFileSync(file, args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 180_000,
    env: {
      ...process.env,
      NODE_OPTIONS: '',
      NODE_PATH: '',
      TYPESAFE_API_KEY: '',
    },
    ...options,
  });
}

test('standalone plugin has only Knowledge entry files and a checked payload', async () => {
  assert.deepEqual(await checkKnowledgePlugin(artifact, expected), manifest);
  assert.deepEqual(
    manifest.files
      .map((file) => file.path)
      .filter(
        (path) =>
          !path.startsWith('registrar/') && !path.startsWith('runtime/'),
      ),
    [
      '.codex-plugin/plugin.json',
      'bin/temari-knowledge.mjs',
      'skills/content-registrar-knowledge/SKILL.md',
      'skills/content-registrar-knowledge/references/evidence-intake.md',
    ],
  );
  const reference =
    'skills/content-registrar-knowledge/references/evidence-intake.md';
  assert.deepEqual(
    await readFile(join(artifact, reference)),
    await readFile(
      new URL(
        '../packages/workflow-runtime/public/skills/temari-knowledge/references/evidence-intake.md',
        import.meta.url,
      ),
    ),
    'standalone intake guidance must preserve its owning source bytes',
  );
  for (const [, link] of (
    await readFile(
      join(artifact, 'skills/content-registrar-knowledge/SKILL.md'),
      'utf8',
    )
  ).matchAll(/\]\(([^)]+)\)/g)) {
    if (/^[a-z][a-z\d+.-]*:|^#/i.test(link)) continue;
    const target = new URL(
      link,
      pathToFileURL(
        join(artifact, 'skills/content-registrar-knowledge/SKILL.md'),
      ),
    );
    assert(
      target.pathname.startsWith(
        `${artifact}/skills/content-registrar-knowledge/`,
      ),
      `Standalone skill link escapes its available resources: ${link}`,
    );
    await readFile(target);
  }
  await assert.rejects(packageKnowledgePlugin(artifact), /already exists/);
  const tampered = join(root, 'tampered');
  await cp(artifact, tampered, { recursive: true });
  await writeFile(join(tampered, 'bin/temari-knowledge.mjs'), 'tampered');
  await assert.rejects(
    checkKnowledgePlugin(tampered, expected),
    /inventory differs|deep-equal/,
  );
  const linked = join(root, 'linked');
  await cp(artifact, linked, { recursive: true });
  await rm(join(linked, 'bin/temari-knowledge.mjs'));
  await symlink(
    join(artifact, 'bin/temari-knowledge.mjs'),
    join(linked, 'bin/temari-knowledge.mjs'),
  );
  await assert.rejects(checkKnowledgePlugin(linked, expected), /Symlink/);
  const sourceLink = join(root, 'linked-source.json');
  await symlink(join(artifact, '.codex-plugin/plugin.json'), sourceLink);
  await assert.rejects(readRegularSource(sourceLink, root), { code: 'ELOOP' });
  const linkedParent = join(root, 'linked-parent');
  await symlink(join(artifact, '.codex-plugin'), linkedParent);
  await assert.rejects(
    readRegularSource(join(linkedParent, 'plugin.json'), root),
    /Symlink or non-directory source path component/,
  );
});

test('relocated standalone plugin installs and runs local-only intake and BM25 search', async () => {
  const installed = join(root, 'recipient', 'plugin');
  const home = join(root, 'recipient', 'home');
  const sourceRoot = join(root, 'recipient', 'source');
  const task = {
    id: 'standalone-smoke',
    directory: join(root, 'recipient', 'task'),
    authorityRef: 'synthetic-local-only',
  };
  await cp(artifact, installed, { recursive: true });
  const launcher = join(installed, 'bin/temari-knowledge.mjs');
  const cold = JSON.parse(
    run(process.execPath, [launcher, 'status', '--home', home]),
  );
  assert.deepEqual(cold.providerSelection, {
    selection: 'registrar',
    phase: 'uninitialized',
    persisted: false,
  });
  const setup = JSON.parse(
    run(process.execPath, [
      launcher,
      'setup',
      '--home',
      home,
      '--python',
      'python3.12',
    ]),
  );
  assert.equal(setup.installedVersion, '0.1.0');
  assert.equal(setup.providerSelection.phase, 'ready');
  assert.equal(setup.connection, undefined);
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(task.directory, { recursive: true });
  await writeFile(
    join(sourceRoot, 'plan.txt'),
    'Neptune migration owner is Mira. Review date is Friday.\n',
  );
  const python = join(home, 'venv/bin/python');
  const workspace = join(home, 'workspace');
  const registered = JSON.parse(
    run(python, [
      '-m',
      'knowledge_agent.cli',
      'sources',
      '--workspace',
      workspace,
      'add',
      sourceRoot,
    ]),
  );
  const sourceId = registered.id;
  const sharing = JSON.parse(
    run(python, [
      '-m',
      'knowledge_agent.cli',
      'sources',
      '--workspace',
      workspace,
      'set-sharing',
      sourceId,
      'local-only',
    ]),
  );
  assert.equal(sharing.sharing, 'local-only');
  const source = {
    provider: 'standalone-smoke',
    id: sourceId,
    locator: pathToFileURL(sourceRoot).href,
  };
  const plan = {
    task,
    intakes: [
      {
        task,
        source,
        readScope: 'source-root',
        requestKey: 'standalone-v1',
        transport: {
          python,
          registrarSource: join(installed, 'registrar'),
          workspace,
        },
      },
    ],
    localOnlySourceIds: [sourceId],
  };
  const intakeInput = join(root, 'intake.json');
  await writeFile(intakeInput, JSON.stringify(plan));
  const intake = JSON.parse(
    run(process.execPath, [
      launcher,
      'journey-intake',
      '--input',
      intakeInput,
      '--home',
      home,
    ]),
  );
  assert.equal(intake.status, 'published');
  assert(intake.handoffPath);
  const searchInput = join(root, 'search.json');
  await writeFile(
    searchInput,
    JSON.stringify({
      handoffPath: intake.handoffPath,
      cases: [
        {
          id: 'bm25-owner',
          query: 'Who owns Neptune migration?',
          sourceIds: [sourceId],
          topK: 2,
          discoveryMode: 'bm25',
          expected: [{ sourceId, path: 'plan.txt' }],
        },
      ],
    }),
  );
  const result = JSON.parse(
    run(process.execPath, [
      launcher,
      'journey-search',
      '--input',
      searchInput,
      '--home',
      home,
    ]),
  );
  const item = result.report.cases[0];
  assert.equal(item.expectedRecallAtK, 1);
  assert.equal(item.verifiedEvidenceCount, 1);
  assert.equal(item.shortlistVerified, true);
  assert.equal(item.jevSharing, 'local-only');
  assert.equal(item.jev.attemptedRequests, 0);
  const codex = join(root, 'fake-codex');
  await writeFile(
    codex,
    '#!/bin/sh\necho "Error: No MCP server named temari-content-registrar found." >&2\nexit 1\n',
  );
  await chmod(codex, 0o755);
  const disabled = JSON.parse(
    run(process.execPath, [
      launcher,
      'disable',
      '--home',
      home,
      '--codex',
      codex,
    ]),
  );
  assert.equal(disabled.status, 'disabled');
  await rm(installed, { recursive: true });
  await cp(artifact, installed, { recursive: true });
  assert.equal(
    JSON.parse(run(process.execPath, [launcher, 'status', '--home', home]))
      .providerSelection.phase,
    'disabled',
  );
  assert.throws(
    () =>
      run(process.execPath, [
        launcher,
        'journey-search',
        '--input',
        searchInput,
        '--home',
        home,
      ]),
    /Knowledge provider selection is disabled/,
  );
  assert.deepEqual(await checkKnowledgePlugin(installed, expected), manifest);
});
