import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createLocalCategorySearchControl } from '../libs/host-adapters/src/index.ts';
import { FileEvidenceStore } from '../libs/runtime/src/index.ts';
import { runQaCategorySearchReproduction } from '../libs/temari-core/src/index.ts';

const execFileAsync = promisify(execFile);
const workspace = fileURLToPath(new URL('..', import.meta.url));
const expectation =
  'Searching within category A returns its matching records and excludes category B.';

function assignment(candidateRef = 'candidate-broken') {
  return {
    assignmentId: 'qa-category-1',
    requestKind: 'full',
    tier: 'standard',
    requestedScope: 'reproduce the synthetic category-filter symptom',
    excludedScope: ['customer data', 'repair', 'external publication'],
    ticketRef: 'DEMO-CATEGORY-1',
    ticketRevision: 'ticket-r1',
    requirementRefs: ['REQ-CATEGORY'],
    requirementRevisions: ['requirement-r2'],
    candidateRef,
    environmentRef: 'local-fixture',
    authority: {
      allowedActions: ['qa:read-category-search'],
      deniedActions: ['qa:mutate'],
    },
    knownConstraints: ['synthetic loopback fixture only'],
  };
}

function request(candidateRef = 'candidate-broken', operation = 'reproduce') {
  return {
    schemaVersion: 1,
    runId: 'qa-category-run-1',
    attemptId: `attempt-${candidateRef}-${operation}`,
    assignment: assignment(candidateRef),
    scenario: {
      scenarioId: 'category-filter',
      requirementRefs: ['REQ-CATEGORY'],
      sourceRevision: 'requirement-r2',
      expectedBehavior: expectation,
    },
    intent: {
      requirementRef: 'REQ-CATEGORY',
      requirementRevision: 'requirement-r2',
      authorityRef: 'approved-product-decision-r2',
      authorityEvidenceRef: 'source-proof-r2',
      authorityStatus: 'Approved',
      expectedBehavior: expectation,
      selectedCategory: 'category-a',
      searchTerm: 'coffee',
      expectedFixtureIds: ['fixture-a1'],
    },
    reportRef: 'DEMO-CATEGORY-1',
    operation,
    fixtureRefs: ['fixture-a1', 'fixture-b1'],
  };
}

test('local Benny-derived reproduction preserves defect, pass, blocked, and ownership boundaries', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'temari-qa-benny-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let served = {
    candidateRef: 'candidate-broken',
    items: [
      { id: 'fixture-a1', category: 'category-a' },
      { id: 'fixture-b1', category: 'category-b' },
    ],
  };
  let requests = 0;
  const server = createServer((incoming, response) => {
    requests += 1;
    const url = new URL(incoming.url, 'http://127.0.0.1');
    assert.equal(incoming.method, 'GET');
    assert.equal(url.pathname, '/category-search');
    assert.equal(url.searchParams.get('category'), 'category-a');
    assert.equal(url.searchParams.get('q'), 'coffee');
    response.writeHead(200, {
      'content-type': 'application/json',
      'x-temari-candidate': served.candidateRef,
      'x-temari-environment': 'local-fixture',
    });
    response.end(JSON.stringify({ items: served.items }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}/`;
  assert.throws(
    () => createLocalCategorySearchControl({ baseUrl: 'https://example.com/' }),
    /plain 127\.0\.0\.1 HTTP origin/,
  );
  const control = createLocalCategorySearchControl({ baseUrl });
  const evidence = await FileEvidenceStore.create(join(root, 'evidence'));
  await assert.rejects(
    runQaCategorySearchReproduction(
      { ...request(), fixtureRefs: ['fixture-b1'] },
      control,
      evidence,
    ),
    /assigned fixture set/,
  );
  assert.equal(requests, 0);

  const broken = await runQaCategorySearchReproduction(
    {
      ...request(),
      priorConclusion: {
        requirementRevision: 'requirement-r1',
        candidateRef: 'candidate-old',
        conclusionRef: 'old-pass',
      },
      existingWork: { ownerRef: 'developer-1', patchRef: 'patch-123' },
    },
    control,
    evidence,
  );
  assert.equal(broken.verdict, 'Reproduced');
  assert.equal(broken.suggestedScenarioResult, 'Failed');
  assert.equal(broken.finding, 'suspected-product-defect');
  assert.equal(broken.priorConclusionStale, true);
  assert.equal(broken.ownershipAction, 'verify-existing-patch');
  assert.equal(broken.qaDisposition, null);
  assert.equal(broken.execution.state, 'Executed');
  assert.equal(broken.execution.evidenceRefs.length, 1);
  assert(!('path' in broken.execution.evidenceRefs[0]));
  const retained = JSON.parse(
    Buffer.from(
      await evidence.loadPortable(broken.execution.evidenceRefs[0]),
    ).toString('utf8'),
  );
  assert.deepEqual(retained.observedFixtureIds, ['fixture-a1', 'fixture-b1']);
  assert.deepEqual(retained.expectedFixtureIds, ['fixture-a1']);

  served = {
    candidateRef: 'candidate-fixed',
    items: [{ id: 'fixture-a1', category: 'category-a' }],
  };
  const notObserved = await runQaCategorySearchReproduction(
    request('candidate-fixed'),
    control,
    evidence,
  );
  assert.equal(notObserved.verdict, 'NotObserved');
  assert.equal(notObserved.suggestedScenarioResult, 'BlockedOrIncomplete');
  const verified = await runQaCategorySearchReproduction(
    request('candidate-fixed', 'verify-fix'),
    control,
    evidence,
  );
  assert.equal(verified.verdict, 'VerifiedOnCandidate');
  assert.equal(verified.suggestedScenarioResult, 'Passed');
  assert.equal(verified.qaDisposition, null);

  served = {
    candidateRef: 'candidate-broken',
    items: [
      { id: 'fixture-a1', category: 'category-a' },
      { id: 'fixture-b1', category: 'category-b' },
    ],
  };
  const stillFailing = await runQaCategorySearchReproduction(
    request('candidate-broken', 'verify-fix'),
    control,
    evidence,
  );
  assert.equal(stillFailing.verdict, 'StillFailing');
  assert.equal(stillFailing.suggestedScenarioResult, 'Failed');
  served = {
    candidateRef: 'candidate-fixed',
    items: [{ id: 'fixture-a1', category: 'category-a' }],
  };

  const countBeforeDenied = requests;
  const denied = await runQaCategorySearchReproduction(
    {
      ...request('candidate-fixed'),
      assignment: {
        ...assignment('candidate-fixed'),
        authority: {
          allowedActions: ['read-source'],
          deniedActions: ['qa:read-category-search'],
        },
      },
    },
    control,
    evidence,
  );
  assert.equal(denied.verdict, 'Blocked');
  assert.equal(denied.blocker, 'action-not-authorized');
  assert.equal(requests, countBeforeDenied);

  const unresolved = await runQaCategorySearchReproduction(
    {
      ...request('candidate-fixed'),
      intent: {
        ...request('candidate-fixed').intent,
        authorityStatus: 'Unresolved',
      },
    },
    control,
    evidence,
  );
  assert.equal(unresolved.blocker, 'intent-unresolved');
  assert.equal(requests, countBeforeDenied);

  served = {
    candidateRef: 'candidate-other',
    items: [{ id: 'fixture-a1', category: 'category-a' }],
  };
  const wrongCandidate = await runQaCategorySearchReproduction(
    request('candidate-fixed'),
    control,
    evidence,
  );
  assert.equal(wrongCandidate.blocker, 'candidate-binding-mismatch');
  served = {
    candidateRef: 'candidate-fixed',
    items: [{ id: 'fixture-a1', category: 'category-a' }],
  };

  const countBeforeEnvironmentBlocked = requests;
  const blocked = await runQaCategorySearchReproduction(
    {
      ...request('candidate-fixed'),
      assignment: {
        ...assignment('candidate-fixed'),
        environmentRef: undefined,
        missingEnvironmentBlocker: 'staging fixture unavailable',
      },
    },
    control,
    evidence,
  );
  assert.equal(blocked.verdict, 'Blocked');
  assert.equal(blocked.blocker, 'environment-unavailable');
  assert.equal(blocked.execution.state, 'Blocked');
  assert.equal(requests, countBeforeEnvironmentBlocked);

  const requestPath = join(root, 'request.json');
  await writeFile(
    requestPath,
    JSON.stringify(request('candidate-fixed', 'verify-fix')),
  );
  const invoked = await execFileAsync(
    process.execPath,
    [
      '--import',
      '@swc-node/register/esm-register',
      'tools/run-qa-benny-local.mjs',
      '--request',
      requestPath,
      '--evidence-root',
      join(root, 'evidence'),
      '--base-url',
      baseUrl,
    ],
    { cwd: workspace },
  );
  const cli = JSON.parse(invoked.stdout);
  assert.equal(cli.verdict, 'VerifiedOnCandidate');
  assert.equal(cli.scope, 'local-reproduction-evidence-only');
  assert.equal(cli.qaDisposition, null);
});
