import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DAILY_VERIFICATION_MAINTENANCE,
  VERIFICATION_MAINTENANCE_SKILL,
  classifySerialEngineering,
  createExecutionPlan,
  verificationMaintenanceDecision,
} from './temari-core.js';

const NOW = new Date('2026-09-20T12:00:00.000Z');

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
