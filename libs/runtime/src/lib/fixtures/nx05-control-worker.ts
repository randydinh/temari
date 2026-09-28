import assert from 'node:assert/strict';

import { FileChildTaskStore } from '../child-task-store.js';
import type { EvidenceReference } from '../evidence-store.js';
import { openNx05FileConformanceAdapters } from '../nx05-control-contract.js';
import { FileWorkflowRunStore } from '../run-store.js';

type Stage =
  | 'after-sidecar-fsync'
  | 'after-state-publication'
  | 'after-event-publication'
  | 'after-sidecar-removal';

interface Input {
  readonly id?: string;
  readonly owner?: string;
  readonly token?: string;
  readonly epoch?: number;
  readonly key?: string;
  readonly now?: string;
  readonly stage?: Stage;
  readonly content?: string;
  readonly reference?: EvidenceReference;
  readonly taskIds?: readonly string[];
}

const [root, operation, rawInput] = process.argv.slice(2);
assert(root && operation && rawInput);
const input = JSON.parse(rawInput) as Input;
const id = input.id ?? '';
const now = input.now ? new Date(input.now) : undefined;
const adapters = await openNx05FileConformanceAdapters(root);
assert.equal(adapters.scope, 'single-host-file');
const parent = adapters.runs;
const child = adapters.children;
const artifacts = adapters.artifacts;

let value: unknown;
switch (operation) {
  case 'create-parent':
    value = await parent.create({
      runId: id,
      revision: 'synthetic-revision',
      actor: 'fixture',
      now,
    });
    break;
  case 'load-parent':
    value = await parent.load(id);
    break;
  case 'claim-parent':
  case 'crash-parent-claim':
    if (operation === 'crash-parent-claim') {
      (
        FileWorkflowRunStore as unknown as { failureInjection: Stage | null }
      ).failureInjection = input.stage ?? null;
    }
    value = await parent.claim({
      runId: id,
      owner: input.owner ?? 'crashed',
      leaseMs: 1_000,
      now,
    });
    break;
  case 'complete-parent':
    value = await parent.transition({
      runId: id,
      owner: input.owner ?? '',
      leaseToken: input.token ?? '',
      status: 'SUCCEEDED',
      idempotencyKey: input.key ?? '',
      now,
    });
    break;
  case 'cancel-parent':
    value = await parent.cancel({
      runId: id,
      actor: 'fixture',
      idempotencyKey: `cancel:${id}`,
      now,
    });
    break;
  case 'cancellation-requested':
    value = await parent.cancellationRequested(id);
    break;
  case 'create-child':
    value = await child.create({
      taskId: id,
      runId: 'synthetic-parent',
      revision: 'synthetic-revision',
      dependsOn: [],
      actor: 'fixture',
      now,
    });
    break;
  case 'ensure-group':
    assert(input.taskIds);
    value = await child.ensureGroup({
      groupId: id,
      runId: 'synthetic-parent',
      revision: 'synthetic-revision',
      taskIds: input.taskIds,
      assignmentIds: input.taskIds,
      now,
    });
    break;
  case 'claim-group':
    assert(input.taskIds);
    value = await child.claimGroup({
      groupId: id,
      runId: 'synthetic-parent',
      revision: 'synthetic-revision',
      taskIds: input.taskIds,
      maxConcurrency: 2,
      owner: input.owner ?? '',
      leaseMs: 1_000,
      now,
    });
    break;
  case 'load-child':
    value = await child.load(id);
    break;
  case 'claim-child':
  case 'crash-child-claim':
    if (operation === 'crash-child-claim') {
      (
        FileChildTaskStore as unknown as { failureInjection: Stage | null }
      ).failureInjection = input.stage ?? null;
    }
    value = await child.claim({
      taskId: id,
      owner: input.owner ?? 'crashed',
      leaseMs: 1_000,
      now,
    });
    break;
  case 'complete-child':
    value = await child.complete({
      taskId: id,
      owner: input.owner ?? '',
      leaseToken: input.token ?? '',
      fencingEpoch: input.epoch ?? 0,
      status: 'FAILED',
      idempotencyKey: input.key ?? '',
      error: 'synthetic failure',
      now,
    });
    break;
  case 'cancel-child':
    value = await child.cancel({
      taskId: id,
      actor: 'fixture',
      idempotencyKey: `cancel:${id}`,
      now,
    });
    break;
  case 'child-events':
    value = await child.events(id);
    break;
  case 'put-artifact':
    value = await artifacts.put({
      runId: 'synthetic-parent',
      revision: 'synthetic-revision',
      kind: 'worker-result',
      content: input.content ?? '',
    });
    break;
  case 'load-artifact':
    assert(input.reference);
    value = Buffer.from(await artifacts.loadPortable(input.reference)).toString(
      'utf8',
    );
    break;
  default:
    assert.fail(`Unknown fixture operation ${operation}`);
}

process.stdout.write(JSON.stringify({ pid: process.pid, value }));
