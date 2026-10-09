import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { readFile, rm } from 'node:fs/promises';
import { actualFixture } from '../support/fixtures.js';
import { runArchiveIntake } from './archive-journey.js';
import { runOpenAIResponsesTrial } from './openai-responses-trial.js';
import { canonical, hash } from './codec.js';
import { publishJson } from './durable.js';

test('ACTUAL Registrar: BM25 verified excerpts to synthetic Responses and immutable separate trial receipt', async () => {
  const f = await actualFixture();
  try {
    const task = {
      id: 'responses-trial',
      directory: join(f.base, 'task'),
      authorityRef: 'synthetic-only',
    };
    const intake = await runArchiveIntake({
      task,
      intakes: [
        {
          task,
          source: f.source,
          readScope: 'source-root',
          requestKey: 'responses-synthetic',
          transport: {
            python: f.config.python,
            registrarSource: f.config.registrarSource,
            workspace: join(f.base, 'state'),
          },
        },
      ],
    });
    assert(intake.handoffPath);
    const input = {
      handoffPath: intake.handoffPath,
      id: 'shadow',
      query: 'Proposal',
      sourceIds: [f.source.id],
      topK: 2,
      discoveryMode: 'bm25' as const,
      provider: 'openai-responses' as const,
      model: 'gpt-6-astra',
      hostedTextApproved: true,
    };
    let calls = 0;
    const result = await runOpenAIResponsesTrial(input, {
      apiKey: 'synthetic',
      fetcher: async (url, init) => {
        calls++;
        assert.equal(url, 'https://api.openai.com/v1/responses');
        const sent = JSON.parse(String(init?.body));
        assert.equal(sent.model, 'gpt-6-astra');
        assert.equal(sent.text.format.type, 'json_schema');
        assert(
          JSON.parse(sent.input[1].content[0].text).candidate.excerpt.includes(
            'Proposal',
          ),
        );
        return Response.json({
          model: 'gpt-6-astra-2026-10-01',
          status: 'completed',
          output: [
            {
              type: 'message',
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({
                    relevance: 0.9,
                    support: 'unknown',
                    confidence: 0.8,
                  }),
                },
              ],
            },
          ],
          usage: { input_tokens: 42, output_tokens: 0, total_tokens: 42 },
        });
      },
    });
    assert.equal(calls, 2);
    assert.equal(result.report.result.judgments.length, 2);
    assert(result.report.result.judgments.every((j) => j.state === 'judged'));
    const raw = await readFile(result.reportPath, 'utf8');
    assert.equal(raw, canonical(result.report));
    assert(!raw.includes('Proposal plan'));
    assert(!raw.includes('"synthetic"'));
    const base = JSON.parse(
      await readFile(result.report.baseQueryReportPath, 'utf8'),
    );
    assert.equal(base.query.jev.attemptedRequests, 0);
    assert.equal(base.query.jevSharing, 'case-opt-out');
    const checkpointBytes = await readFile(
      result.report.retrievalCheckpointPath!,
    );
    assert.equal(
      result.report.retrievalCheckpointSha256,
      hash(checkpointBytes),
    );
    const checkpoint = JSON.parse(checkpointBytes.toString('utf8'));
    const orderedEvidence = base.query.ranked.map(
      (rank: { sourceId: string; path: string; sha256: string }) =>
        checkpoint.evidence.find(
          (e: any) =>
            e.document.source.id === rank.sourceId &&
            e.document.path === rank.path &&
            e.sha256 === rank.sha256,
        ),
    );
    assert.deepEqual(
      result.report.result.originalOrder,
      orderedEvidence.map((e: any) => hash(canonical(e.document))),
    );
    assert.deepEqual(
      result.report.result.suggestedOrder,
      result.report.result.originalOrder,
    );
    for (const [i, judgment] of result.report.result.judgments.entries()) {
      const e = orderedEvidence[i];
      assert.deepEqual(judgment.evidenceIds, [e.id]);
      assert.equal(
        judgment.evidenceSha256,
        hash(canonical({ evidenceIds: [e.id], excerpt: e.excerpt })),
      );
      assert.equal(
        checkpoint.checks.find((c: any) => c.evidenceId === e.id).state,
        'unchanged',
      );
    }
    assert.equal(
      result.report.baseQueryReportSha256,
      hash(await readFile(result.report.baseQueryReportPath)),
    );
    await assert.rejects(publishJson(result.reportPath, { changed: true }));
    const noKey = await runOpenAIResponsesTrial(input, { apiKey: '' });
    assert(noKey.report.gaps.includes('missing-key'));
    assert.equal(noKey.report.result.attemptedRequests, 0);
    for (const overrides of [
      { provider: 'none' as const },
      { hostedTextApproved: false },
    ]) {
      const offline = await runOpenAIResponsesTrial(
        { ...input, ...overrides },
        {
          get apiKey(): string {
            throw Error('offline credential lookup');
          },
          fetcher: async () => {
            throw Error('offline network');
          },
        },
      );
      assert.equal(offline.report.result.attemptedRequests, 0);
    }
    const handoff = JSON.parse(await readFile(intake.handoffPath, 'utf8'));
    handoff.jevPolicy.localOnlySourceIds = [f.source.id];
    const localPath = join(
      task.directory,
      `archive-handoff-${hash(canonical(handoff))}.json`,
    );
    await publishJson(localPath, handoff);
    const local = await runOpenAIResponsesTrial(
      { ...input, handoffPath: localPath },
      {
        get apiKey(): string {
          throw Error('local-only key access');
        },
      },
    );
    assert(local.report.gaps.includes('local-only'));
    await assert.rejects(
      runOpenAIResponsesTrial({ ...input, provider: 'jev' as never }),
    );
    await assert.rejects(
      runOpenAIResponsesTrial({ ...input, extra: true } as typeof input),
    );
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});
