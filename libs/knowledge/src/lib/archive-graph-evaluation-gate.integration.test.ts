import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { prepareRegistrar } from '../support/prepare.js';
import { loadArchivePublication } from './archive-intake.js';
import { runArchiveIntake } from './archive-journey.js';
import {
  graphCaseGoldChange, graphGateStatus, nonHostedSharing,
  runGraphRetrievalGate, type GraphGatePlan,
} from './archive-graph-evaluation-gate.js';
import { hash } from './codec.js';

test('ACTUAL CLI: sealed graph gate records an improvement and displacement without promoting', async () => {
  const registrarSource = process.env['TEMARI_REGISTRAR_SOURCE'];
  const python = process.env['TEMARI_REGISTRAR_PYTHON'];
  assert(registrarSource && python);
  const f = await prepareRegistrar({
    registrarSource, python,
    documents: [
      { path: 'seed-alpha.txt', bytes: Buffer.from('alpha alpha alpha alpha alpha anchor\n') },
      { path: 'decoy-alpha.txt', bytes: Buffer.from('alpha distractor\n') },
      { path: 'gold-alpha.txt', bytes: Buffer.from('gold destination one\n') },
      { path: 'seed-beta.txt', bytes: Buffer.from('beta beta beta beta beta anchor\n') },
      { path: 'gold-beta.txt', bytes: Buffer.from('beta second result\n') },
      { path: 'decoy-beta.txt', bytes: Buffer.from('unrelated destination two\n') },
    ],
  });
  const task = { id: 'graph-gate-fixture', directory: join(f.base, 'task'), authorityRef: 'synthetic' };
  const intake = await runArchiveIntake({
    task, intakes: [{
      task, source: f.source, readScope: 'source-root', requestKey: 'graph-gate-v1',
      transport: { python, registrarSource, workspace: join(f.base, 'state') },
    }],
  });
  assert(intake.handoffPath);
  const publication = await loadArchivePublication(intake.outcomes[0].publicationPath!);
  const cli = async (args: string[]): Promise<Record<string, any>> => {
    const { stdout } = await promisify(execFile)(python, [
      '-B', '-m', 'knowledge_agent.cli', 'archive', '--workspace', join(f.base, 'state'), ...args,
    ], {
      cwd: registrarSource, timeout: 60000, maxBuffer: 1_048_576,
      env: { PATH: '/usr/bin:/bin', PYTHONPATH: join(registrarSource, 'src'), PYTHONNOUSERSITE: '1' },
    });
    return JSON.parse(stdout);
  };
  const paths = ['seed-alpha.txt', 'gold-alpha.txt', 'seed-beta.txt', 'decoy-beta.txt'];
  const anchors: {
    source_id: string; generation: string; manifest_sha256: string;
    path: string; original_sha256: string; representation_sha256: string;
    text_start: number; text_end: number; quote: string; quote_sha256: string;
  }[] = [];
  for (const path of paths) {
    const read = await cli([
      'read', f.source.id, publication.generation, path,
      '--manifest-sha256', publication.manifestSha256, '--max-chars', '5',
    ]);
    const c = read['record']['citations'][0];
    anchors.push({
      source_id: f.source.id, generation: publication.generation,
      manifest_sha256: publication.manifestSha256, path,
      original_sha256: c.original_sha256,
      representation_sha256: c.representation_sha256,
      text_start: c.text_start, text_end: c.text_end,
      quote: c.quote, quote_sha256: hash(c.quote),
    });
  }
  const nodes = anchors.map((anchor, i) => ({
    id: String(i + 1).repeat(32), kind: 'mention', label: `fixture ${i}`,
    provenance: 'extracted', anchors: [anchor],
  }));
  const graph = {
    schema: 1,
    revision_set: { schema: 1, selections: [{
      source_id: f.source.id, generation: publication.generation,
      manifest_sha256: publication.manifestSha256,
    }] },
    parent: null, nodes,
    assertions: [[0, 1], [2, 3]].map(([a, b], i) => ({
      id: String(i + 5).repeat(32), kind: 'relationship',
      subject: nodes[a].id, predicate: 'relates-to', object: nodes[b].id,
      support: [anchors[a], anchors[b]], contrary: [],
      provenance: 'inferred', lifecycle: 'active', supersedes: [],
    })),
  };
  const graphPath = join(f.base, 'graph-gate-batch.json');
  await writeFile(graphPath, JSON.stringify(graph));
  const published = await cli(['graph-publish', graphPath]);
  assert.equal(published['status'], 'complete');
  const plan: GraphGatePlan = {
    schema: 1, handoffPath: intake.handoffPath, graphId: published['graph_id'], topK: 2,
    cohorts: {
      development: [{
        id: 'positive', query: 'alpha', sourceIds: [f.source.id],
        expected: [{ sourceId: f.source.id, path: 'gold-alpha.txt' }],
      }],
      holdout: [{
        id: 'displacement', query: 'beta', sourceIds: [f.source.id],
        expected: [{ sourceId: f.source.id, path: 'gold-beta.txt' }],
      }],
    },
  };
  const planPath = join(f.base, 'graph-questions.json');
  const planBytes = Buffer.from(JSON.stringify(plan));
  await writeFile(planPath, planBytes);
  const handoffSha = hash(await readFile(intake.handoffPath));
  await assert.rejects(() => runGraphRetrievalGate(planPath, hash('wrong'), handoffSha),
    /Question set pin changed/);
  await assert.rejects(() => runGraphRetrievalGate(planPath, hash(planBytes), hash('wrong')),
    /Archive handoff pin changed/);
  let keyLookups = 0, hostedCalls = 0;
  const { receipt, receiptPath } = await runGraphRetrievalGate(
    planPath, hash(planBytes), handoffSha, {
      keyResolver: async () => { keyLookups++; return 'test-key'; },
      fetcher: async () => { hostedCalls++; throw new Error('Hosted call from graph gate'); },
    });
  assert.equal(keyLookups, 0);
  assert.equal(hostedCalls, 0);
  assert.equal(receipt.status, 'insufficient-sample');
  assert.equal(receipt.promotionEligible, false);
  assert.deepEqual(receipt.cohorts.development.improvedCaseIds, ['positive']);
  assert.deepEqual(receipt.cohorts.holdout.regressedCaseIds, ['displacement']);
  assert.deepEqual(receipt.cohorts.holdout.negativeExpansionCaseIds, ['displacement']);
  for (const cohort of Object.values(receipt.cohorts)) {
    assert.deepEqual(cohort.unverifiedCaseIds, []);
    assert(cohort.bm25SelectedExcerptBytes > 0);
    assert(cohort.graphSelectedExcerptCodePoints > 0);
    assert.equal(cohort.graphTargetReadAttempts, 1);
    assert(cohort.graphProjectionNodes >= 4);
  }
  const raw = await readFile(receiptPath, 'utf8');
  assert(!raw.includes('gold-alpha.txt'));
  assert(!raw.includes('gold-beta.txt'));
  assert(!raw.includes('alpha alpha'));
});

test('graph gate status remains diagnostic even on improvement and refuses regression', () => {
  assert(nonHostedSharing('case-opt-out'));
  assert(nonHostedSharing('local-only'));
  assert(!nonHostedSharing('allowed'));
  const sourceId = 'fixture-source';
  assert.deepEqual(graphCaseGoldChange(
    [{ sourceId, path: 'gold-a.md' }], [{ sourceId, path: 'gold-b.md' }],
    [{ sourceId, path: 'gold-a.md' }, { sourceId, path: 'gold-b.md' }],
  ), { before: 1, after: 1, displacedGold: true });
  const good = {
    questions: 5, indexedGold: 5, totalGold: 5, bm25Hits: 2, graphHits: 3,
    regressedCaseIds: [], negativeExpansionCaseIds: ['tested-negative'],
    unverifiedCaseIds: [],
  };
  assert.equal(graphGateStatus({ development: good, holdout: good }), 'diagnostic-improvement');
  assert.equal(graphGateStatus({
    development: good, holdout: { ...good, regressedCaseIds: ['displaced'] },
  }), 'rejected');
  assert.equal(graphGateStatus({
    development: good, holdout: { ...good, indexedGold: 4 },
  }), 'coverage-blocked');
  assert.equal(graphGateStatus({
    development: good, holdout: { ...good, negativeExpansionCaseIds: [] },
  }), 'rejected');
});
