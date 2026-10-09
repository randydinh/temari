import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { actualFixture, documents } from '../support/fixtures.js';
import { prepareRegistrar } from '../support/prepare.js';
import {
  evaluateArchiveSearch,
  runArchiveIntake,
  runArchiveQuery,
} from './archive-journey.js';
import { loadArchivePublication } from './archive-intake.js';
import { canonical, hash } from './codec.js';

async function setCurrentSharing(
  python: string,
  registrarSource: string,
  workspace: string,
  sourceId: string,
  mode: 'registered-sources' | 'local-only',
): Promise<void> {
  const { stdout } = await promisify(execFile)(
    python,
    [
      '-B',
      '-m',
      'knowledge_agent.cli',
      'sources',
      '--workspace',
      workspace,
      'set-sharing',
      sourceId,
      mode,
    ],
    {
      env: {
        PATH: '/usr/bin:/bin',
        PYTHONPATH: join(registrarSource, 'src'),
        PYTHONNOUSERSITE: '1',
        PYTHONDONTWRITEBYTECODE: '1',
      },
      timeout: 30000,
      maxBuffer: 65536,
    },
  );
  assert.equal(JSON.parse(stdout).sharing, mode);
}

test('ACTUAL Registrar: live sharing revocation blocks direct, labeled and retry Jev calls', async () => {
  const f = await actualFixture();
  const task = {
    id: 'sharing-gate',
    directory: join(f.base, 'task'),
    authorityRef: 'synthetic-live-sharing',
  };
  const workspace = join(f.base, 'state');
  const intake = await runArchiveIntake({
    task,
    intakes: [
      {
        task,
        source: f.source,
        readScope: 'source-root',
        requestKey: 'sharing-v1',
        transport: {
          python: f.config.python,
          registrarSource: f.config.registrarSource,
          workspace,
        },
      },
    ],
  });
  assert(intake.handoffPath);
  await setCurrentSharing(
    f.config.python,
    f.config.registrarSource,
    workspace,
    f.source.id,
    'local-only',
  );
  let keyLookups = 0;
  let fetches = 0;
  const options = {
    keyResolver: async () => {
      keyLookups++;
      return 'synthetic-key';
    },
    fetcher: async () => {
      fetches++;
      throw Error('revoked source reached TypeSafe');
    },
  };
  const direct = await runArchiveQuery(
    {
      handoffPath: intake.handoffPath,
      id: 'current-local-only',
      query: 'Proposal',
      sourceIds: [f.source.id],
      topK: 2,
      discoveryMode: 'bm25',
    },
    options,
  );
  assert.equal(direct.report.query.jevSharing, 'current-local-only');
  assert.equal(direct.report.query.jev?.sharing, 'current-local-only');
  assert(
    direct.report.query.jev?.judgments.every(
      (item) => item.gap === 'current-local-only',
    ),
  );
  assert(
    direct.report.query.gaps.some(
      (gap) => gap.subject === 'jev-shadow' && gap.kind === 'scope-refused',
    ),
  );
  const labeled = await evaluateArchiveSearch(
    {
      handoffPath: intake.handoffPath,
      cases: [
        {
          id: 'labeled-current-local-only',
          query: 'Proposal',
          sourceIds: [f.source.id],
          expected: [{ sourceId: f.source.id, path: 'plan.txt' }],
          topK: 1,
          discoveryMode: 'bm25',
        },
      ],
    },
    options,
  );
  assert.equal(labeled.report.cases[0].jevSharing, 'current-local-only');
  assert.equal(keyLookups, 0);
  assert.equal(fetches, 0);

  await setCurrentSharing(
    f.config.python,
    f.config.registrarSource,
    workspace,
    f.source.id,
    'registered-sources',
  );
  let retryFetches = 0;
  const retried = await runArchiveQuery(
    {
      handoffPath: intake.handoffPath,
      id: 'sharing-changed-after-429',
      query: 'Proposal',
      sourceIds: [f.source.id],
      topK: 2,
      discoveryMode: 'bm25',
    },
    {
      apiKey: 'synthetic-key',
      sleep: async () => {},
      fetcher: async () => {
        retryFetches++;
        await setCurrentSharing(
          f.config.python,
          f.config.registrarSource,
          workspace,
          f.source.id,
          'local-only',
        );
        return new Response('', { status: 429 });
      },
    },
  );
  assert.equal(retryFetches, 1);
  assert.equal(retried.report.query.jevSharing, 'current-local-only');
  assert.equal(retried.report.query.jev?.sharing, 'current-local-only');
  assert(
    retried.report.query.jev?.judgments.every(
      (item) => item.gap === 'current-local-only',
    ),
  );

  await setCurrentSharing(
    f.config.python,
    f.config.registrarSource,
    workspace,
    f.source.id,
    'registered-sources',
  );
  let lastFetches = 0;
  const changedAfterLastAttempt = await runArchiveQuery(
    {
      handoffPath: intake.handoffPath,
      id: 'sharing-changed-after-last-response',
      query: 'Proposal',
      sourceIds: [f.source.id],
      topK: 1,
      discoveryMode: 'bm25',
    },
    {
      apiKey: 'synthetic-key',
      fetcher: async () => {
        lastFetches++;
        await setCurrentSharing(
          f.config.python,
          f.config.registrarSource,
          workspace,
          f.source.id,
          'local-only',
        );
        return new Response('', { status: 503 });
      },
    },
  );
  assert.equal(lastFetches, 1);
  assert.equal(
    changedAfterLastAttempt.report.query.jevSharing,
    'current-local-only',
  );
});

test('ACTUAL CLI: explicit OCR mode is retained in the archive publication', async () => {
  const f = await actualFixture();
  const task = {
    id: 'ocr-intake-fixture',
    directory: join(f.base, 'task'),
    authorityRef: 'synthetic-local-admission',
  };
  await assert.rejects(
    () =>
      runArchiveIntake({
        task,
        intakes: [],
        localOnlySourceId: [f.source.id],
      } as unknown as Parameters<typeof runArchiveIntake>[0]),
    /Unknown intake plan field/,
  );
  const intake = await runArchiveIntake({
    task,
    intakes: [
      {
        task,
        source: f.source,
        readScope: 'source-root',
        requestKey: 'ocr-v1',
        ocrMode: 'macos-vision',
        transport: {
          python: f.config.python,
          registrarSource: f.config.registrarSource,
          workspace: join(f.base, 'state'),
        },
      },
    ],
  });
  assert.equal(intake.status, 'published', JSON.stringify(intake.outcomes));
  const publication = await loadArchivePublication(
    intake.outcomes[0].publicationPath!,
  );
  assert.equal(publication.capabilities['ocr'], 'macos-vision-optional');
});

test('ACTUAL CLI: intake handoff through exact/BM25 search, pinned reads and Jev shadow gaps', async () => {
  const f = await actualFixture();
  const task = {
    id: 'journey-fixture',
    directory: join(f.base, 'task'),
    authorityRef: 'synthetic-local-admission',
  };
  const intake = await runArchiveIntake({
    task,
    intakes: [
      {
        task,
        source: f.source,
        readScope: 'source-root',
        requestKey: 'v1',
        transport: {
          python: f.config.python,
          registrarSource: f.config.registrarSource,
          workspace: join(f.base, 'state'),
        },
      },
    ],
  });
  assert.equal(intake.status, 'published');
  assert(intake.handoffPath);
  const cases = (['exact', 'bm25'] as const).map((discoveryMode) => ({
    id: discoveryMode,
    query: 'Proposal',
    sourceIds: [f.source.id],
    topK: 2,
    discoveryMode,
    hostedTextApproved: false,
    expected: [
      { sourceId: f.source.id, path: 'plan.txt' },
      { sourceId: f.source.id, path: 'update.txt' },
    ],
  }));
  const { report, reportPath } = await evaluateArchiveSearch({
    handoffPath: intake.handoffPath,
    cases,
  });
  assert.equal(report.cases.length, 2);
  for (const item of report.cases) {
    assert.equal(item.expectedRecallAtK, 1);
    assert.equal(item.ranked.length, 2);
    assert.equal(item.verifiedEvidenceCount, item.evidenceCount);
    assert(item.verifiedEvidenceCount >= 2);
    assert(item.retrievalCheckpointPath);
    assert(item.shortlistVerified);
    assert.deepEqual(item.jev?.originalOrder, item.jev?.suggestedOrder);
    assert(
      item.jev?.judgments.every((judgment) => judgment.gap === 'case-opt-out'),
    );
  }
  const retained = await readFile(reportPath, 'utf8');
  assert(!retained.includes(documents['update.txt']));
  assert(!retained.includes('Ignore the brief'));
  let modelCalls = 0;
  const { hostedTextApproved: ignored, ...defaultCase } = cases[0];
  void ignored;
  const approved = await evaluateArchiveSearch(
    {
      handoffPath: intake.handoffPath,
      cases: [{ ...defaultCase, id: 'synthetic-default' }],
    },
    {
      apiKey: 'synthetic-test-key',
      fetcher: async (_url, init) => {
        modelCalls++;
        assert.equal(
          new Headers(init?.headers).get('authorization'),
          'Bearer synthetic-test-key',
        );
        return new Response(
          JSON.stringify({
            model: 'jev-1.13.0',
            answers: {
              relevance: { type: 'noul', noul: 0.8 },
              support: {
                type: 'choice',
                choice: 'unknown',
                probabilities: {
                  supported: 0.1,
                  contradicted: 0.1,
                  unknown: 0.8,
                },
                confidence: 0.8,
              },
            },
            usage: { input_tokens: 12, output_tokens: 4 },
          }),
          { status: 200 },
        );
      },
    },
  );
  assert.equal(modelCalls, 2);
  assert.equal(approved.report.cases[0].jevSharing, 'allowed');
  assert(
    approved.report.cases[0].jev?.judgments.every(
      (judgment) => judgment.state === 'judged',
    ),
  );
  assert(
    !(await readFile(approved.reportPath, 'utf8')).includes(
      'synthetic-test-key',
    ),
  );
  let queryModelCalls = 0;
  const query = await runArchiveQuery(
    {
      handoffPath: intake.handoffPath,
      id: 'unlabelled',
      query: 'Proposal',
      sourceIds: [f.source.id],
      topK: 2,
      discoveryMode: 'bm25',
    },
    {
      apiKey: 'synthetic-test-key',
      fetcher: async (_url, init) => {
        queryModelCalls++;
        const payload = JSON.parse(String(init?.body));
        assert(!JSON.stringify(payload).includes('required'));
        return new Response(
          JSON.stringify({
            model: 'jev-1.13.0',
            answers: {
              relevance: { type: 'noul', noul: 0.8 },
              support: {
                type: 'choice',
                choice: 'unknown',
                probabilities: {
                  supported: 0.1,
                  contradicted: 0.1,
                  unknown: 0.8,
                },
                confidence: 0.8,
              },
            },
            usage: { input_tokens: 12, output_tokens: 4 },
          }),
          { status: 200 },
        );
      },
    },
  );
  assert.equal(query.report.kind, 'temari-archive-query');
  assert.equal(query.report.query.topK, 2);
  assert.equal(query.report.query.ranked.length, 2);
  assert.equal(query.report.query.shortlistVerified, true);
  assert.equal(query.report.query.verifiedEvidenceCount, 2);
  assert.equal(query.report.query.jevSharing, 'allowed');
  assert.equal(queryModelCalls, 2);
  assert(
    query.report.query.jev?.judgments.every((item) => item.state === 'judged'),
  );
  const queryBytes = await readFile(query.reportPath, 'utf8');
  assert.equal(
    basename(query.reportPath),
    `archive-query-${hash(canonical(query.report))}.json`,
  );
  assert(!queryBytes.includes(documents['update.txt']));
  assert(!queryBytes.includes('synthetic-test-key'));
  assert(!queryBytes.includes('expected'));
  assert(!queryBytes.includes('required'));
  assert(!queryBytes.includes('graph'));
  await assert.rejects(
    () =>
      runArchiveQuery(
        {
          handoffPath: intake.handoffPath!,
          id: 'typo-opt-out',
          query: 'Proposal',
          sourceIds: [f.source.id],
          topK: 2,
          discoveryMode: 'bm25',
          hostedTextApproval: false,
        } as unknown as Parameters<typeof runArchiveQuery>[0],
        {
          apiKey: 'synthetic-test-key',
          fetcher: async () => {
            throw new Error('Typo reached TypeSafe');
          },
        },
      ),
    /Unknown operational query field/,
  );
  await assert.rejects(() =>
    runArchiveQuery({
      handoffPath: intake.handoffPath!,
      id: 'bad-label',
      query: 'Proposal',
      sourceIds: [f.source.id],
      topK: 2,
      discoveryMode: 'bm25',
      expected: [{ sourceId: f.source.id, path: 'plan.txt' }],
    } as Parameters<typeof runArchiveQuery>[0]),
  );
  const { hostedTextApproved: _removedApproval, ...unsafeCase } = cases[0];
  void _removedApproval;
  await assert.rejects(
    () =>
      evaluateArchiveSearch(
        {
          handoffPath: intake.handoffPath!,
          cases: [
            { ...unsafeCase, id: 'eval-typo', hostedTextApproval: false },
          ],
        } as unknown as Parameters<typeof evaluateArchiveSearch>[0],
        {
          apiKey: 'synthetic-test-key',
          fetcher: async () => {
            throw new Error('Evaluation typo reached TypeSafe');
          },
        },
      ),
    /Unknown evaluation case field/,
  );
  await assert.rejects(() =>
    evaluateArchiveSearch({
      handoffPath: intake.handoffPath!,
      cases: [{ ...cases[0], sourceIds: ['outside-admission'] }],
    }),
  );
  const original = await readFile(intake.handoffPath, 'utf8');
  await writeFile(
    intake.handoffPath,
    original.replace('journey-fixture', 'tampered-fixture'),
  );
  await assert.rejects(() =>
    evaluateArchiveSearch({ handoffPath: intake.handoffPath!, cases }),
  );
});

test('ACTUAL CLI: local-only source blocks Jev even with a case approval', async () => {
  const f = await actualFixture();
  const task = {
    id: 'local-only-fixture',
    directory: join(f.base, 'task'),
    authorityRef: 'synthetic-local-only-admission',
  };
  const intake = await runArchiveIntake({
    task,
    localOnlySourceIds: [f.source.id],
    intakes: [
      {
        task,
        source: f.source,
        readScope: 'source-root',
        requestKey: 'local-only-v1',
        transport: {
          python: f.config.python,
          registrarSource: f.config.registrarSource,
          workspace: join(f.base, 'state'),
        },
      },
    ],
  });
  assert(intake.handoffPath);
  const { report } = await evaluateArchiveSearch(
    {
      handoffPath: intake.handoffPath,
      cases: [
        {
          id: 'local-only',
          query: 'Proposal',
          sourceIds: [f.source.id],
          topK: 1,
          discoveryMode: 'bm25',
          hostedTextApproved: true,
          expected: [{ sourceId: f.source.id, path: 'plan.txt' }],
        },
      ],
    },
    {
      apiKey: 'synthetic-test-key',
      fetcher: async () => {
        throw new Error('Local-only source reached Jev');
      },
    },
  );
  const result = report.cases[0];
  assert.equal(result.ranked.length, 1);
  assert.equal(result.shortlistVerified, true);
  assert.equal(result.jevSharing, 'local-only');
  assert(result.jev?.judgments.every((item) => item.gap === 'local-only'));
  const operational = await runArchiveQuery(
    {
      handoffPath: intake.handoffPath,
      id: 'local-only-operational',
      query: 'Proposal',
      sourceIds: [f.source.id],
      topK: 1,
      discoveryMode: 'bm25',
      hostedTextApproved: true,
    },
    {
      apiKey: 'synthetic-test-key',
      fetcher: async () => {
        throw new Error('Local-only operational query reached Jev');
      },
    },
  );
  assert.equal(operational.report.query.jevSharing, 'local-only');
  assert(
    operational.report.query.jev?.judgments.every(
      (item) => item.gap === 'local-only',
    ),
  );
  assert(!JSON.stringify(operational.report).includes('required'));
});

test('ACTUAL CLI: eight astral excerpts stay within Jev shadow bounds without approval', async () => {
  const python = process.env['TEMARI_REGISTRAR_PYTHON'];
  const registrarSource = process.env['TEMARI_REGISTRAR_SOURCE'];
  assert(python && registrarSource);
  const f = await prepareRegistrar({
    python,
    registrarSource,
    documents: Array.from({ length: 8 }, (_, index) => ({
      path: `emoji-${index}.txt`,
      bytes: Buffer.from(`Signal ${'😀'.repeat(1200)}`),
    })),
  });
  const task = {
    id: 'astral-shortlist',
    directory: join(f.base, 'task'),
    authorityRef: 'synthetic-astral-corpus',
  };
  const intake = await runArchiveIntake({
    task,
    intakes: [
      {
        task,
        source: f.source,
        readScope: 'source-root',
        requestKey: 'v1',
        transport: {
          python: f.config.python,
          registrarSource: f.config.registrarSource,
          workspace: join(f.base, 'state'),
        },
      },
    ],
  });
  assert(intake.handoffPath);
  const { report } = await evaluateArchiveSearch({
    handoffPath: intake.handoffPath,
    cases: [
      {
        id: 'astral-eight',
        query: 'Signal',
        sourceIds: [f.source.id],
        expected: [{ sourceId: f.source.id, path: 'emoji-0.txt' }],
        topK: 8,
        discoveryMode: 'exact',
        hostedTextApproved: false,
      },
    ],
  });
  const result = report.cases[0];
  assert.equal(result.expectedRecallAtK, 1);
  assert.equal(result.ranked.length, 8);
  assert.equal(result.verifiedEvidenceCount, 8);
  assert.equal(result.jev?.judgments.length, 8);
  assert(
    result.jev.judgments.every((judgment) => judgment.gap === 'case-opt-out'),
  );
});

const exec = promisify(execFile);

test('ACTUAL CLI: graph one-hop trial recovers a lexical miss from a pinned related document', async () => {
  const python = process.env['TEMARI_REGISTRAR_PYTHON'];
  const registrarSource = process.env['TEMARI_REGISTRAR_SOURCE'];
  assert(python && registrarSource);
  const f = await prepareRegistrar({
    python,
    registrarSource,
    documents: [
      { path: 'seed.txt', bytes: Buffer.from('Signal signal signal relay.\n') },
      { path: 'decoy.txt', bytes: Buffer.from('Signal signal unrelated.\n') },
      { path: 'target.txt', bytes: Buffer.from('Charger location record.\n') },
      {
        path: 'inferred.txt',
        bytes: Buffer.from('Unverified relation target.\n'),
      },
    ],
  });
  const task = {
    id: 'graph-trial',
    directory: join(f.base, 'task'),
    authorityRef: 'synthetic-graph-admission',
  };
  const intake = await runArchiveIntake({
    task,
    intakes: [
      {
        task,
        source: f.source,
        readScope: 'source-root',
        requestKey: 'v1',
        transport: {
          python,
          registrarSource,
          workspace: join(f.base, 'state'),
        },
      },
    ],
  });
  assert(intake.handoffPath);
  const publication = await loadArchivePublication(
    intake.outcomes[0].publicationPath!,
  );
  const cli = async (args: string[]): Promise<Record<string, any>> => {
    const output = await exec(
      python,
      [
        '-B',
        '-m',
        'knowledge_agent.cli',
        'archive',
        '--workspace',
        join(f.base, 'state'),
        ...args,
      ],
      {
        cwd: registrarSource,
        timeout: 60000,
        maxBuffer: 1_048_576,
        env: {
          PATH: '/usr/bin:/bin',
          PYTHONPATH: join(registrarSource, 'src'),
          PYTHONNOUSERSITE: '1',
          PYTHONDONTWRITEBYTECODE: '1',
        },
      },
    );
    return JSON.parse(output.stdout);
  };
  const anchors = [];
  for (const path of ['seed.txt', 'target.txt', 'inferred.txt']) {
    const read = await cli([
      'read',
      f.source.id,
      publication.generation,
      path,
      '--manifest-sha256',
      publication.manifestSha256,
      '--max-chars',
      '6',
    ]);
    const c = read['record']['citations'][0];
    anchors.push({
      source_id: f.source.id,
      generation: publication.generation,
      manifest_sha256: publication.manifestSha256,
      path,
      original_sha256: c.original_sha256,
      representation_sha256: c.representation_sha256,
      text_start: c.text_start,
      text_end: c.text_end,
      quote: c.quote,
      quote_sha256: hash(c.quote),
    });
  }
  const graph = {
    schema: 1,
    revision_set: {
      schema: 1,
      selections: [
        {
          source_id: f.source.id,
          generation: publication.generation,
          manifest_sha256: publication.manifestSha256,
        },
      ],
    },
    parent: null,
    nodes: [
      {
        id: '1'.repeat(32),
        kind: 'mention',
        label: 'signal',
        provenance: 'extracted',
        anchors: [anchors[0]],
      },
      {
        id: '2'.repeat(32),
        kind: 'mention',
        label: 'charger location',
        provenance: 'extracted',
        anchors: [anchors[1]],
      },
      {
        id: '4'.repeat(32),
        kind: 'mention',
        label: 'unverified target',
        provenance: 'extracted',
        anchors: [anchors[2]],
      },
    ],
    assertions: [
      {
        id: '3'.repeat(32),
        kind: 'relationship',
        subject: '1'.repeat(32),
        predicate: 'contains',
        object: '2'.repeat(32),
        support: [anchors[0], anchors[1]],
        contrary: [],
        provenance: 'extracted',
        lifecycle: 'active',
        supersedes: [],
      },
      {
        id: '0'.repeat(32),
        kind: 'relationship',
        subject: '1'.repeat(32),
        predicate: 'relates-to',
        object: '4'.repeat(32),
        support: [anchors[0], anchors[2]],
        contrary: [],
        provenance: 'inferred',
        lifecycle: 'active',
        supersedes: [],
      },
    ],
  };
  const batch = join(f.base, 'graph-trial.json');
  await writeFile(batch, JSON.stringify(graph));
  const published = await cli(['graph-publish', batch]);
  assert.equal(published['status'], 'complete');
  const { report, reportPath } = await evaluateArchiveSearch({
    handoffPath: intake.handoffPath,
    cases: [
      {
        id: 'related-target',
        query: 'signal',
        sourceIds: [f.source.id],
        expected: [{ sourceId: f.source.id, path: 'target.txt' }],
        topK: 2,
        discoveryMode: 'bm25',
        hostedTextApproved: false,
        graphId: published['graph_id'],
      },
      {
        id: 'missing-graph',
        query: 'signal',
        sourceIds: [f.source.id],
        expected: [{ sourceId: f.source.id, path: 'target.txt' }],
        topK: 2,
        discoveryMode: 'bm25',
        hostedTextApproved: false,
        graphId: '0'.repeat(64),
      },
    ],
  });
  const result = report.cases[0];
  assert.equal(result.expectedRecallAtK, 0);
  assert.equal(result.graph?.status, 'complete');
  assert.equal(result.graph?.expectedRecallAtK, 1);
  assert.deepEqual(
    result.graph?.added.map((item) => item.path),
    ['target.txt'],
  );
  assert.equal(result.graph?.added[0]?.provenance, 'extracted');
  assert.equal(result.graph?.verifiedEvidenceCount, 1);
  assert.equal(result.graph?.targetReadAttempts, 1);
  assert((result.graph?.projectionNodeCount ?? 0) > 0);
  assert(result.graph?.checkpointPath);
  assert.equal(report.cases[1].graph?.status, 'gap');
  assert.deepEqual(report.cases[1].graph?.ranked, report.cases[1].ranked);
  assert.equal(
    report.cases[1].graph?.expectedRecallAtK,
    report.cases[1].expectedRecallAtK,
  );
  assert(
    !(await readFile(reportPath, 'utf8')).includes('Charger location record'),
  );
});
