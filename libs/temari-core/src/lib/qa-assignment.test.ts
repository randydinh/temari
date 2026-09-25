import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertQaAssignment,
  validateQaAssignment,
  type QaFullAssignment,
  type QaNarrowAssignment,
} from './qa-assignment.js';

const FULL_ASSIGNMENT: QaFullAssignment = {
  assignmentId: 'qa-assignment-1',
  requestKind: 'full',
  tier: 'standard',
  requestedScope: 'ticket behavior and required regression coverage',
  excludedScope: ['test implementation'],
  ticketRef: 'ticket-123',
  ticketRevision: 'ticket-revision-4',
  requirementRefs: ['requirement-1'],
  requirementRevisions: ['requirement-revision-2'],
  candidateRef: 'commit-abc123',
  environmentRef: 'staging-build-7',
  authority: {
    allowedActions: ['read ticket', 'run approved checks'],
    deniedActions: ['publish ticket transition'],
  },
  knownConstraints: ['payment writes are out of scope'],
};

const NARROW_ASSIGNMENT: QaNarrowAssignment = {
  assignmentId: 'qa-assignment-2',
  requestKind: 'narrow',
  tier: 'focused',
  requestedScope: 'review the acceptance-case mapping',
  excludedScope: ['runtime execution', 'ticket disposition'],
  ticketRef: null,
  ticketRevision: null,
  requirementRefs: [],
  requirementRevisions: [],
  candidateRef: null,
  authority: {
    allowedActions: ['read the supplied case mapping'],
    deniedActions: ['execute the candidate'],
  },
  knownConstraints: [],
};

test('accepts a full assignment with an identified environment', () => {
  assert.deepEqual(validateQaAssignment(FULL_ASSIGNMENT), []);
  assert.doesNotThrow(() => assertQaAssignment(FULL_ASSIGNMENT));
});

test('accepts a full assignment with an explicit missing-environment blocker', () => {
  const assignment: QaFullAssignment = {
    ...FULL_ASSIGNMENT,
    environmentRef: undefined,
    missingEnvironmentBlocker: 'fresh-context evaluator unavailable',
  };

  assert.deepEqual(validateQaAssignment(assignment), []);
});

test('rejects a full assignment with ambiguous environment state', () => {
  const bothContexts = {
    ...FULL_ASSIGNMENT,
    missingEnvironmentBlocker: 'also unavailable',
  } as unknown as QaFullAssignment;
  const noContext = {
    ...FULL_ASSIGNMENT,
    environmentRef: undefined,
  } as unknown as QaFullAssignment;

  assert.match(
    validateQaAssignment(bothContexts).join(' '),
    /exactly one environmentRef or missingEnvironmentBlocker/,
  );
  assert.match(
    validateQaAssignment(noContext).join(' '),
    /exactly one environmentRef or missingEnvironmentBlocker/,
  );
});

test('accepts a focused narrow assignment without execution context', () => {
  assert.deepEqual(validateQaAssignment(NARROW_ASSIGNMENT), []);
});

test('rejects a narrow assignment that claims a full-review tier', () => {
  const invalid = {
    ...NARROW_ASSIGNMENT,
    tier: 'standard',
  } as unknown as QaNarrowAssignment;

  assert.match(
    validateQaAssignment(invalid).join(' '),
    /narrow assignments must use the focused tier/,
  );
});

test('rejects unpaired requirement revisions', () => {
  const invalid = {
    ...FULL_ASSIGNMENT,
    requirementRevisions: [],
  } as unknown as QaFullAssignment;

  assert.match(
    validateQaAssignment(invalid).join(' '),
    /requirementRefs and requirementRevisions must contain the same number/,
  );
});

test('rejects an assignment without a denied-action boundary', () => {
  const invalid = {
    ...FULL_ASSIGNMENT,
    authority: {
      ...FULL_ASSIGNMENT.authority,
      deniedActions: [],
    },
  } as unknown as QaFullAssignment;

  assert.match(
    validateQaAssignment(invalid).join(' '),
    /authority.deniedActions must contain at least one boundary/,
  );
});
