import assert from 'node:assert/strict';
import test from 'node:test';

import type { WorkerAssignment } from '@temari/contracts';
import {
  assertNx05ParentCommit,
  nx05AssignmentSha256,
  type Nx05ParentCommit,
} from './nx05-control-contract.js';

const assignment: WorkerAssignment = {
  id: 'implementer',
  role: 'implementer',
  required: true,
  brief: {
    goal: 'Build the bounded fixture',
    context: 'Synthetic NX05 contract fixture',
    scope: 'fixture.txt',
    acceptanceCriteria: ['The fixture passes its check'],
    verificationCommand: 'node fixture-check.mjs',
    reportFormat: 'json',
    forbiddenActions: ['Do not edit another workspace'],
  },
};

function commit(): Nx05ParentCommit {
  return {
    runId: 'nx05-parent',
    lease: { owner: 'coordinator', token: 'lease-token', fencingEpoch: 1 },
    idempotencyKey: 'commit-1',
    status: 'RUNNING',
    event: { type: 'run-event', payload: { step: 'dispatch' } },
    dispatch: [
      {
        groupId: 'group-1',
        maxConcurrency: 2,
        tasks: [
          {
            taskId: 'task-1',
            idempotencyKey: 'dispatch-1',
            assignment,
            assignmentSha256: nx05AssignmentSha256(assignment),
            dependsOn: [],
          },
        ],
      },
    ],
  };
}

test('parent dispatch carries a complete immutable group and verified assignment', () => {
  assert.doesNotThrow(() => assertNx05ParentCommit(commit()));
  const changed: any = structuredClone(commit());
  changed.dispatch[0]!.tasks[0]!.assignment.brief.goal = 'Changed';
  assert.throws(() => assertNx05ParentCommit(changed), /assignment digest/i);
  const extra: any = structuredClone(commit());
  extra.dispatch[0]!.tasks[0]!.assignment.unexpected = 'not on the wire';
  assert.throws(() => assertNx05ParentCommit(extra), /assignment fields/i);
});

test('parent dispatch refuses duplicate IDs, undeclared dependencies, and cycles', () => {
  const duplicate: any = structuredClone(commit());
  duplicate.dispatch[0]!.tasks.push({
    ...duplicate.dispatch[0]!.tasks[0]!,
    taskId: 'task-2',
    idempotencyKey: 'dispatch-2',
  });
  assert.throws(() => assertNx05ParentCommit(duplicate), /assignment ID/i);

  const undeclared: any = structuredClone(commit());
  undeclared.dispatch[0]!.tasks[0]!.dependsOn.push('missing-task');
  assert.throws(() => assertNx05ParentCommit(undeclared), /dependency/i);

  const cycle: any = structuredClone(commit());
  cycle.dispatch[0]!.tasks[0]!.dependsOn.push('task-2');
  cycle.dispatch[0]!.tasks.push({
    ...cycle.dispatch[0]!.tasks[0]!,
    taskId: 'task-2',
    idempotencyKey: 'dispatch-2',
    assignment: { ...assignment, id: 'verifier' },
    assignmentSha256: nx05AssignmentSha256({ ...assignment, id: 'verifier' }),
    dependsOn: ['task-1'],
  });
  assert.throws(() => assertNx05ParentCommit(cycle), /cycle/i);
});

test('parent dispatch rejects a terminal parent or invalid concurrency bound', () => {
  const terminal: any = structuredClone(commit());
  terminal.status = 'SUCCEEDED';
  assert.throws(() => assertNx05ParentCommit(terminal), /RUNNING/i);
  const unbounded: any = structuredClone(commit());
  unbounded.dispatch[0]!.maxConcurrency = 0;
  assert.throws(() => assertNx05ParentCommit(unbounded), /maxConcurrency/i);
});
