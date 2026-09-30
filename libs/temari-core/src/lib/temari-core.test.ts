import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WORKFLOW_STAGES,
  type WorkflowReceipt,
  type WorkflowReceiptStatus,
  type WorkerEvidenceReference,
} from '@temari/contracts';

import {
  DAILY_VERIFICATION_MAINTENANCE,
  TEMARI_ROUTE_TABLE,
  VERIFICATION_MAINTENANCE_SKILL,
  classifyEngineeringRoute,
  classifySerialEngineering,
  classifyTemariRoute,
  createExecutionPlan,
  createRequestPlan,
  deriveCloseout,
  validateTemariRouteTable,
  verificationMaintenanceDecision,
} from './temari-core.js';

const NOW = new Date('2026-09-20T12:00:00.000Z');

const LIGHTWEIGHT_EVIDENCE = {
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
} as const;

function closeoutReceipt(
  status: WorkflowReceiptStatus = 'PASS',
  includeStageEvidence = true,
): WorkflowReceipt {
  const plan = createRequestPlan({
    workType: 'feature',
    lightweight: LIGHTWEIGHT_EVIDENCE,
  }).plan;
  return {
    schema: 1,
    runId: 'closeout-run-1',
    revision: 'closeout-revision-1',
    plan,
    capabilities: {
      host: 'generic',
      available: [],
      missing: [],
      notes: {},
    },
    startedAt: '2026-09-24T12:00:00.000Z',
    completedAt: '2026-09-24T12:01:00.000Z',
    status,
    stages: WORKFLOW_STAGES.map((stage) => ({
      stage,
      status: 'PASS' as const,
      startedAt: '2026-09-24T12:00:00.000Z',
      completedAt: '2026-09-24T12:01:00.000Z',
      summary: `${stage} complete`,
      evidencePaths: includeStageEvidence ? [`evidence/${stage}.json`] : [],
      rawLogPath: null,
    })),
    failure: null,
  };
}

const CLOSEOUT_EVIDENCE: WorkerEvidenceReference = {
  schema: 1,
  runId: 'closeout-run-1',
  revision: 'closeout-revision-1',
  kind: 'verification',
  sha256: 'a'.repeat(64),
  bytes: 1,
};

test('selects lightweight engineering only when every condition is proven', () => {
  assert.deepEqual(
    classifyEngineeringRoute({
      workType: 'bug',
      lightweight: LIGHTWEIGHT_EVIDENCE,
    }),
    {
      route: 'lightweight-engineering',
      playbook: 'lightweight-engineering',
      reason: 'all-lightweight-conditions-proven',
    },
  );
});

test('routes a migration to a full playbook without guessing which playbook', () => {
  assert.deepEqual(
    classifyEngineeringRoute({
      workType: 'migration',
      lightweight: { ...LIGHTWEIGHT_EVIDENCE, isMigration: true },
    }),
    {
      route: 'full-playbook',
      playbook: null,
      reason: 'lightweight-condition-not-proven',
    },
  );
});

test('routes uncertain callers to a full playbook', () => {
  const decision = classifyEngineeringRoute({
    workType: 'feature',
    lightweight: { ...LIGHTWEIGHT_EVIDENCE, affectedCallersAreKnown: false },
  });

  assert.equal(decision.route, 'full-playbook');
  assert.equal(decision.playbook, null);
});

test('keeps a closed route table with QA and program owners', () => {
  validateTemariRouteTable();
  assert.deepEqual(
    TEMARI_ROUTE_TABLE.map(({ profileKind, route, owner }) => ({
      profileKind,
      route,
      owner,
    })),
    [
      {
        profileKind: 'playbook',
        route: 'lightweight-engineering',
        owner: 'poteto-mode',
      },
      { profileKind: 'playbook', route: 'full-playbook', owner: 'poteto-mode' },
      { profileKind: 'domain', route: 'qa-review', owner: './qa-review' },
      { profileKind: 'program', route: 'program', owner: 'temari' },
    ],
  );
});

test('routes explicit program intent to Temari before engineering size', () => {
  const decision = classifyTemariRoute({
    workType: 'migration',
    lightweight: LIGHTWEIGHT_EVIDENCE,
    programKind: 'orchestrate',
  });
  assert.deepEqual(decision, {
    profileKind: 'program',
    route: 'program',
    owner: 'temari',
    requestScope: 'full',
    programKind: 'orchestrate',
    admission: 'planning-only',
  });

  const request = createRequestPlan({
    workType: 'migration',
    lightweight: LIGHTWEIGHT_EVIDENCE,
    programKind: 'autopilot-stack',
  });
  assert.equal(request.route.profileKind, 'program');
  assert.equal(request.plan.workType, 'migration');
});

test('rejects a program mixed with QA or nested under a bounded subtask', () => {
  assert.throws(
    () =>
      classifyTemariRoute({
        workType: 'qa',
        lightweight: LIGHTWEIGHT_EVIDENCE,
        programKind: 'orchestrate',
        qaResponsibility: 'ticket-coverage',
      }),
    /cannot also declare QA/,
  );
  assert.throws(
    () =>
      classifyTemariRoute({
        workType: 'migration',
        lightweight: LIGHTWEIGHT_EVIDENCE,
        programKind: 'orchestrate',
        requestScope: 'bounded-subtask',
        parentReviewId: 'review-1',
      }),
    /bounded subtask cannot start/,
  );
});

test('routes explicit ticket QA to the domain owner before playbook matching', () => {
  assert.deepEqual(
    classifyTemariRoute({
      workType: 'qa',
      lightweight: LIGHTWEIGHT_EVIDENCE,
      qaResponsibility: 'ticket-coverage',
    }),
    {
      profileKind: 'domain',
      route: 'qa-review',
      owner: './qa-review',
      requestScope: 'full',
      responsibility: 'ticket-coverage',
    },
  );
});

test('preserves an explicitly narrow QA assignment as a domain route', () => {
  const decision = classifyTemariRoute({
    workType: 'qa',
    lightweight: LIGHTWEIGHT_EVIDENCE,
    qaResponsibility: 'test-plan-review',
    requestScope: 'explicitly-narrow',
  });

  assert.equal(decision.profileKind, 'domain');
  assert.equal(decision.route, 'qa-review');
  assert.equal(decision.requestScope, 'explicitly-narrow');
});

test('keeps QA exclusions on the existing playbook route', () => {
  const decision = classifyTemariRoute({
    workType: 'bug',
    lightweight: { ...LIGHTWEIGHT_EVIDENCE, isReportedDefect: true },
    qaExclusion: 'known-defect-repair',
  });

  assert.deepEqual(decision, {
    profileKind: 'playbook',
    route: 'full-playbook',
    owner: 'poteto-mode',
    requestScope: 'full',
    playbook: null,
    reason: 'qa-exclusion',
  });
});

test('prevents a bounded QA callback from rematching qa-review', () => {
  const decision = classifyTemariRoute({
    workType: 'feature',
    lightweight: LIGHTWEIGHT_EVIDENCE,
    qaResponsibility: 'validation-disposition',
    requestScope: 'bounded-subtask',
    parentReviewId: 'qa-review-1',
  });

  assert.deepEqual(decision, {
    profileKind: 'playbook',
    route: 'lightweight-engineering',
    owner: 'poteto-mode',
    requestScope: 'bounded-subtask',
    parentReviewId: 'qa-review-1',
    playbook: 'lightweight-engineering',
    reason: 'bounded-subtask',
  });
});

test('fails closed on invalid QA routing metadata', () => {
  assert.throws(
    () =>
      classifyTemariRoute({
        workType: 'qa',
        lightweight: LIGHTWEIGHT_EVIDENCE,
        qaResponsibility: 'ticket-readiness',
        requestScope: 'bounded-subtask',
      }),
    /parentReviewId recursion guard/,
  );
  assert.throws(
    () =>
      classifyTemariRoute({
        workType: 'qa',
        lightweight: LIGHTWEIGHT_EVIDENCE,
        qaResponsibility: 'ticket-readiness',
        qaExclusion: 'ambiguous-review',
      }),
    /both QA responsibility and a QA exclusion/,
  );
});

test('rejects malformed closed route tables', () => {
  assert.throws(
    () =>
      validateTemariRouteTable([...TEMARI_ROUTE_TABLE, TEMARI_ROUTE_TABLE[0]!]),
    /duplicate playbook:lightweight-engineering/,
  );
  assert.throws(
    () =>
      validateTemariRouteTable([
        TEMARI_ROUTE_TABLE[0]!,
        TEMARI_ROUTE_TABLE[1]!,
        {
          profileKind: 'domain',
          route: 'qa-review',
          owner: '',
        } as never,
      ]),
    /has no owner/,
  );
});

test('derives ready closeout only from a complete revision-bound receipt', () => {
  const decision = deriveCloseout(closeoutReceipt(), [CLOSEOUT_EVIDENCE]);

  assert.deepEqual(decision, {
    status: 'ready',
    runId: 'closeout-run-1',
    revision: 'closeout-revision-1',
    evidence: [CLOSEOUT_EVIDENCE],
  });
});

test('blocks closeout for a non-pass receipt and tampered evidence identity', () => {
  const decision = deriveCloseout(closeoutReceipt('ISSUES'), [
    {
      ...CLOSEOUT_EVIDENCE,
      revision: 'stale-revision',
      sha256: 'tampered',
      bytes: -1,
    },
  ]);

  assert.equal(decision.status, 'blocked');
  if (decision.status === 'blocked') {
    assert.equal(decision.resumable, true);
    assert.deepEqual(decision.reasons, [
      'receipt-not-pass',
      'evidence-revision-mismatch',
      'evidence-hash-invalid',
      'evidence-size-invalid',
    ]);
  }
});

test('blocks closeout when any completed stage lacks evidence paths', () => {
  const decision = deriveCloseout(closeoutReceipt('PASS', false), [
    CLOSEOUT_EVIDENCE,
  ]);

  assert.equal(decision.status, 'blocked');
  if (decision.status === 'blocked') {
    assert.deepEqual(decision.reasons, ['stage-evidence-missing']);
  }
});

test('converts one ordinary request into one canonical execution plan', () => {
  const request = createRequestPlan({
    workType: 'feature',
    lightweight: LIGHTWEIGHT_EVIDENCE,
    obligations: { delivery: 'commit' },
  });

  assert.equal(request.route.profileKind, 'playbook');
  assert.equal(request.route.route, 'lightweight-engineering');
  assert.deepEqual(request.obligations, {
    workType: 'feature',
    delivery: 'commit',
  });
  assert.deepEqual(request.plan.stages, [
    'investigate',
    'plan',
    'build',
    'review',
    'verify',
    'deliver',
  ]);
  assert.equal(request.plan.delivery, 'commit');
});

test('maps a QA domain route to independent revision-bound plan policy', () => {
  const request = createRequestPlan({
    workType: 'qa',
    lightweight: LIGHTWEIGHT_EVIDENCE,
    qaResponsibility: 'validation-disposition',
  });

  assert.equal(request.route.profileKind, 'domain');
  assert.equal(request.route.route, 'qa-review');
  assert.deepEqual(request.obligations, {
    workType: 'qa',
    review: 'independent',
    evidence: 'revision-bound',
  });
  assert.equal(request.plan.review, 'independent');
  assert.equal(request.plan.evidence, 'revision-bound');
  assert.deepEqual(request.plan.requiredCapabilities, ['subagents']);
});

test('fails closed when a QA policy is weakened at the coordinator boundary', () => {
  assert.throws(
    () =>
      createRequestPlan({
        workType: 'qa',
        lightweight: LIGHTWEIGHT_EVIDENCE,
        qaResponsibility: 'ticket-coverage',
        obligations: { review: 'self' },
      }),
    /require independent review/,
  );
  assert.throws(
    () =>
      createRequestPlan({
        workType: 'qa',
        lightweight: LIGHTWEIGHT_EVIDENCE,
        qaResponsibility: 'ticket-coverage',
        obligations: { evidence: 'minimal' },
      }),
    /require revision-bound evidence/,
  );
});

test('classifies serial engineering without naming a host', () => {
  const plan = createExecutionPlan(classifySerialEngineering('feature'));

  assert.equal(plan.workType, 'feature');
  assert.deepEqual(plan.requiredCapabilities, []);
});

test('dispatches maintenance when no receipt exists', () => {
  const decision = verificationMaintenanceDecision(undefined, NOW);

  assert.equal(decision.due, true);
  if (decision.due) {
    assert.equal(decision.reason, 'missing-receipt');
    assert.equal(decision.dispatch.skillId, VERIFICATION_MAINTENANCE_SKILL);
  }
});

test('does not dispatch within the daily cadence', () => {
  const completedAt = new Date(
    NOW.getTime() - DAILY_VERIFICATION_MAINTENANCE.cadenceMs + 1,
  ).toISOString();
  const decision = verificationMaintenanceDecision(
    { runId: 'run-1', completedAt, outcome: 'clean' },
    NOW,
  );

  assert.equal(decision.due, false);
  if (!decision.due) {
    assert.equal(decision.reason, 'fresh-receipt');
  }
});

test('dispatches when the last successful receipt is stale', () => {
  const completedAt = new Date(
    NOW.getTime() - DAILY_VERIFICATION_MAINTENANCE.cadenceMs,
  ).toISOString();
  const decision = verificationMaintenanceDecision(
    { runId: 'run-1', completedAt, outcome: 'changed' },
    NOW,
  );

  assert.equal(decision.due, true);
  if (decision.due) {
    assert.equal(decision.reason, 'stale-receipt');
  }
});

test('keeps blocked maintenance due', () => {
  const decision = verificationMaintenanceDecision(
    {
      runId: 'run-1',
      completedAt: new Date(NOW.getTime() - 1).toISOString(),
      outcome: 'blocked',
    },
    NOW,
  );

  assert.equal(decision.due, true);
  if (decision.due) {
    assert.equal(decision.reason, 'blocked-receipt');
  }
});

test('fails closed on malformed and clock-skewed receipts', () => {
  const malformed = verificationMaintenanceDecision(
    { runId: 'run-1', completedAt: 'not-a-date', outcome: 'clean' },
    NOW,
  );
  const future = verificationMaintenanceDecision(
    {
      runId: 'run-2',
      completedAt: new Date(NOW.getTime() + 1).toISOString(),
      outcome: 'clean',
    },
    NOW,
  );

  assert.equal(malformed.due, true);
  assert.equal(future.due, true);
  if (malformed.due && future.due) {
    assert.equal(malformed.reason, 'invalid-receipt');
    assert.equal(future.reason, 'invalid-receipt');
  }
});
