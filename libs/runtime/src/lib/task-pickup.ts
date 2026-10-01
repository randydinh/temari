import assert from 'node:assert/strict';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { WorkflowStageId } from '@temari/contracts';
import {
  assertTaskId,
  assertTaskSessionIdentity,
  type TaskContextRef,
  type TaskEvent,
  type TaskHandoff,
  type TaskRecord,
  type TaskRun,
  type TaskSessionIdentity,
} from './task-store.js';
import type {
  TaskEvidenceSnapshot,
  TaskSnapshot,
  TaskStatus,
} from './task-runtime.js';

export const TASK_PICKUP_LIMITS = {
  defaultChoices: 20,
  maxChoices: 50,
  recentEvents: 12,
  handoffDecisions: 8,
  contextRefs: 8,
  evidenceIssues: 8,
  unresolvedOperations: 1,
  briefBytes: 128 * 1024,
} as const;

export interface TaskPickupRequest {
  readonly taskId?: string;
  readonly workspaceRoot?: string;
  readonly session?: TaskSessionIdentity;
  readonly limit?: number;
}
export type TaskStatusHint =
  'OPEN' | 'RUNNING' | 'BLOCKED' | 'CANCELLED' | 'ACCEPTED_UNVERIFIED';
export interface TaskPickupChoice {
  readonly taskId: string;
  readonly title: string;
  readonly version: number;
  readonly workspaceRoot: string;
  readonly updatedAt: string;
  /** Stored hints have not revalidated evidence and can never assert DONE. */
  readonly statusHint: TaskStatusHint;
  readonly nextAction: string | null;
  readonly blocker: string | null;
}
export interface TaskPickupCurrentRun {
  readonly runId: string;
  readonly revision: string;
  readonly planSha256: string;
  readonly receiptRoot: string | null;
  readonly evidenceRoot: string | null;
  readonly nativeRef: {
    readonly harnessId: string;
    readonly harnessVersion: string;
    readonly externalRunId: string;
    readonly startedAt: string;
  } | null;
  readonly nativeStatus: string | null;
  readonly unresolvedOperations: readonly {
    readonly commandId: string;
    readonly kind: string;
    readonly state: string;
    readonly reason: string | null;
  }[];
}
export interface TaskPickupBrief {
  readonly taskId: string;
  readonly title: string;
  readonly version: number;
  readonly goal: string;
  readonly workspaceRoot: string;
  readonly status: TaskStatus;
  readonly nextAction: string | null;
  readonly blocker: string | null;
  readonly currentStage: WorkflowStageId | null;
  readonly currentRun: TaskPickupCurrentRun | null;
  readonly evidence: TaskEvidenceSnapshot;
  readonly semanticAcceptance: boolean;
  /** Handoff prose is context; refreshed status and evidence remain separate. */
  readonly handoff: (TaskHandoff & { readonly contextOnly: true }) | null;
  readonly recentEvents: readonly {
    readonly sequence: number;
    readonly taskVersion: number;
    readonly type: TaskEvent['change']['type'];
    readonly actor: string;
    readonly at: string;
    readonly summary: string;
  }[];
  readonly history: {
    readonly totalEvents: number;
    readonly omittedEvents: number;
    readonly totalRuns: number;
    readonly omittedRuns: number;
  };
  readonly truncation: {
    readonly fields: readonly string[];
    readonly omittedDecisions: number;
    readonly omittedContextRefs: number;
    readonly omittedEvidenceIssues: number;
    readonly omittedUnresolvedOperations: number;
  };
}
export interface TaskPickupResult {
  readonly schema: 1;
  readonly status: 'selected' | 'choices' | 'empty';
  readonly choices: readonly TaskPickupChoice[];
  readonly hasMore: boolean;
  readonly selected: TaskPickupBrief | null;
}

function clipped(value: string, maxBytes: number): string {
  // Account for JSON escapes as well as UTF-8 so serialization cannot expand
  // a bounded field through control characters or multibyte text.
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') - 2 <= maxBytes)
    return value;
  let result = '';
  let bytes = 0;
  for (const character of value) {
    bytes += Buffer.byteLength(JSON.stringify(character), 'utf8') - 2;
    if (bytes > maxBytes) break;
    result += character;
  }
  return result;
}
function hint(task: TaskRecord): TaskStatusHint {
  const run = task.runs.find((item) => item.runId === task.currentRunId);
  if (
    task.blocker ||
    run?.operations.some((operation) => operation.state !== 'CONFIRMED')
  )
    return 'BLOCKED';
  if (run?.nativeRef && !run.nativeSnapshot) return 'BLOCKED';
  if (run?.nativeSnapshot?.status === 'CANCELLED') return 'CANCELLED';
  if (
    run?.nativeSnapshot &&
    ['FAILED', 'BLOCKED', 'UNKNOWN'].includes(run.nativeSnapshot.status)
  )
    return 'BLOCKED';
  if (
    run?.nativeSnapshot &&
    ['RUNNING', 'QUEUED'].includes(run.nativeSnapshot.status)
  )
    return 'RUNNING';
  if (task.acceptance) return 'ACCEPTED_UNVERIFIED';
  return 'OPEN';
}

/** Compact choice projection never opens artifacts and never claims DONE. */
export function projectTaskPickupChoice(task: TaskRecord): TaskPickupChoice {
  return {
    taskId: task.taskId,
    title: clipped(task.title, 256),
    version: task.version,
    workspaceRoot: task.workspaceRoot,
    updatedAt: task.updatedAt,
    statusHint: hint(task),
    nextAction: task.nextAction === null ? null : clipped(task.nextAction, 512),
    blocker: task.blocker === null ? null : clipped(task.blocker, 512),
  };
}

/** Scope raw records before any evidence read. An acceptance event and a
 * cancellation are deliberately retained as discovery candidates: neither
 * proves the user's goal is currently complete without evidence verification.
 */
export async function selectTaskPickupCandidates(
  tasks: readonly TaskRecord[],
  request: TaskPickupRequest,
): Promise<{
  readonly candidates: readonly TaskRecord[];
  readonly limit: number;
}> {
  assert(
    request && typeof request === 'object' && !Array.isArray(request),
    'Pickup request must be an object.',
  );
  assert(
    Object.keys(request).every((key) =>
      ['taskId', 'workspaceRoot', 'session', 'limit'].includes(key),
    ),
    'Unknown pickup request field.',
  );
  assert(
    request.taskId !== undefined || request.workspaceRoot !== undefined,
    'Pickup requires an exact task ID or an absolute workspace root.',
  );
  if (request.taskId !== undefined) assertTaskId(request.taskId);
  if (request.session !== undefined) assertTaskSessionIdentity(request.session);
  const limit = request.limit ?? TASK_PICKUP_LIMITS.defaultChoices;
  assert(
    Number.isSafeInteger(limit) &&
      limit >= 1 &&
      limit <= TASK_PICKUP_LIMITS.maxChoices,
    `Pickup limit must be 1-${TASK_PICKUP_LIMITS.maxChoices}.`,
  );
  let candidates = tasks.filter(
    (task) =>
      (request.taskId === undefined || task.taskId === request.taskId) &&
      (request.session === undefined ||
        task.sessions.some(
          (session) =>
            session.host === request.session!.host &&
            session.sessionId === request.session!.sessionId,
        )),
  );
  if (request.workspaceRoot !== undefined) {
    assert(
      typeof request.workspaceRoot === 'string' &&
        request.workspaceRoot.length <= 4096 &&
        isAbsolute(request.workspaceRoot) &&
        !request.workspaceRoot.includes('\0'),
      'Pickup workspace root must be absolute.',
    );
    const scope = await realpath(request.workspaceRoot);
    assert(
      (await stat(scope)).isDirectory(),
      'Pickup workspace root must be a directory.',
    );
    const canonicalRoots = new Map<string, string | null>();
    for (const root of new Set(candidates.map((task) => task.workspaceRoot))) {
      try {
        canonicalRoots.set(root, await realpath(root));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        canonicalRoots.set(root, null);
      }
    }
    candidates = candidates.filter(
      (task) => canonicalRoots.get(task.workspaceRoot) === scope,
    );
  }
  return {
    candidates: candidates.sort(
      (a, b) =>
        b.updatedAt.localeCompare(a.updatedAt) ||
        a.taskId.localeCompare(b.taskId),
    ),
    limit,
  };
}

function eventSummary(event: TaskEvent): string {
  switch (event.change.type) {
    case 'task-created':
      return 'Task created.';
    case 'task-entered':
      return event.change.create
        ? 'Task created and session linked.'
        : 'Session entered the task.';
    case 'handoff-recorded':
      return 'Continuation handoff recorded.';
    case 'metadata-updated':
      return 'Task context updated.';
    case 'run-bound':
      return 'Execution plan and run identity bound.';
    case 'evidence-roots-attached':
      return 'Canonical evidence locations attached.';
    case 'dispatch-requested':
      return 'Native dispatch intent retained.';
    case 'control-requested':
      return `${event.change.kind === 'cancel' ? 'Cancellation' : 'Resume'} intent retained.`;
    case 'native-bound':
      return 'Exact native run identity bound.';
    case 'native-observed':
      return `Native status observed: ${event.change.snapshot.status}.`;
    case 'operation-uncertain':
      return 'Executor outcome requires reconciliation.';
    case 'evidence-verified':
      return 'Persisted stage evidence verified at this point.';
    case 'task-accepted':
      return 'Coordinator acceptance recorded at this point.';
  }
}

/** Pure bounded handoff projection. Never return dispatch inputs, native log
 * paths, complete event payloads, or source bytes to a pickup consumer.
 */
export function projectTaskPickupBrief(
  snapshot: TaskSnapshot,
): TaskPickupBrief {
  const fields = new Set<string>();
  const clip = (value: string, bytes: number, field: string): string => {
    const projected = clipped(value, bytes);
    if (projected !== value) fields.add(field);
    return projected;
  };
  const nullable = (
    value: string | null,
    bytes: number,
    field: string,
  ): string | null => (value === null ? null : clip(value, bytes, field));
  const run: TaskRun | undefined = snapshot.runs.find(
    (item) => item.runId === snapshot.currentRunId,
  );
  const unresolved =
    run?.operations.filter((operation) => operation.state !== 'CONFIRMED') ??
    [];
  const sourceHandoff = snapshot.handoff;
  const decisions =
    sourceHandoff?.decisions
      .slice(0, TASK_PICKUP_LIMITS.handoffDecisions)
      .map((decision, index) =>
        clip(decision, 512, `handoff.decisions[${index}]`),
      ) ?? [];
  const contextRefs: TaskContextRef[] =
    sourceHandoff?.contextRefs
      .slice(0, TASK_PICKUP_LIMITS.contextRefs)
      .map((ref, index) => ({
        kind: clip(ref.kind, 64, `handoff.contextRefs[${index}].kind`),
        location: clip(
          ref.location,
          1024,
          `handoff.contextRefs[${index}].location`,
        ),
        ...(ref.sha256 === undefined ? {} : { sha256: ref.sha256 }),
      })) ?? [];
  const recent = snapshot.events.slice(-TASK_PICKUP_LIMITS.recentEvents);
  const brief: TaskPickupBrief = {
    taskId: snapshot.taskId,
    title: clip(snapshot.title, 256, 'title'),
    version: snapshot.version,
    goal: clip(snapshot.goal, 8192, 'goal'),
    workspaceRoot: snapshot.workspaceRoot,
    status: snapshot.status,
    nextAction: nullable(snapshot.nextAction, 2048, 'nextAction'),
    blocker: nullable(snapshot.blocker, 2048, 'blocker'),
    currentStage: snapshot.currentStage,
    currentRun: run
      ? {
          runId: run.runId,
          revision: run.revision,
          planSha256: run.planSha256,
          receiptRoot: run.receiptRoot ?? null,
          evidenceRoot: run.evidenceRoot ?? null,
          nativeRef: run.nativeRef
            ? {
                harnessId: run.nativeRef.harnessId,
                harnessVersion: run.nativeRef.harnessVersion,
                externalRunId: run.nativeRef.externalRunId,
                startedAt: new Date(run.nativeRef.startedAt).toISOString(),
              }
            : null,
          nativeStatus: run.nativeSnapshot?.status ?? null,
          unresolvedOperations: unresolved
            .slice(0, TASK_PICKUP_LIMITS.unresolvedOperations)
            .map((operation, index) => ({
              commandId: operation.commandId,
              kind: operation.kind,
              state: operation.state,
              reason: nullable(
                operation.reason,
                512,
                `currentRun.unresolvedOperations[${index}].reason`,
              ),
            })),
        }
      : null,
    evidence: {
      verified: snapshot.evidence.verified,
      scope: snapshot.evidence.scope,
      receiptSha256: snapshot.evidence.receiptSha256,
      issues: snapshot.evidence.issues
        .slice(0, TASK_PICKUP_LIMITS.evidenceIssues)
        .map((issue, index) => clip(issue, 512, `evidence.issues[${index}]`)),
    },
    semanticAcceptance: snapshot.semanticAcceptance,
    handoff: sourceHandoff
      ? {
          summary: clip(sourceHandoff.summary, 2048, 'handoff.summary'),
          decisions,
          nextAction: clip(
            sourceHandoff.nextAction,
            2048,
            'handoff.nextAction',
          ),
          blocker: nullable(sourceHandoff.blocker, 2048, 'handoff.blocker'),
          contextRefs,
          actor: clip(sourceHandoff.actor, 128, 'handoff.actor'),
          at: sourceHandoff.at,
          taskVersion: sourceHandoff.taskVersion,
          runId: sourceHandoff.runId,
          contextOnly: true,
        }
      : null,
    recentEvents: recent.map((event) => ({
      sequence: event.sequence,
      taskVersion: event.taskVersion,
      type: event.change.type,
      actor: clip(event.actor, 128, `events[${event.sequence}].actor`),
      at: event.at,
      summary: eventSummary(event),
    })),
    history: {
      totalEvents: snapshot.events.length,
      omittedEvents: snapshot.events.length - recent.length,
      totalRuns: snapshot.runs.length,
      omittedRuns: snapshot.runs.length - (run ? 1 : 0),
    },
    truncation: {
      fields: [],
      omittedDecisions:
        (sourceHandoff?.decisions.length ?? 0) - decisions.length,
      omittedContextRefs:
        (sourceHandoff?.contextRefs.length ?? 0) - contextRefs.length,
      omittedEvidenceIssues: Math.max(
        0,
        snapshot.evidence.issues.length - TASK_PICKUP_LIMITS.evidenceIssues,
      ),
      omittedUnresolvedOperations:
        unresolved.length -
        Math.min(unresolved.length, TASK_PICKUP_LIMITS.unresolvedOperations),
    },
  };
  const result = {
    ...brief,
    truncation: { ...brief.truncation, fields: [...fields] },
  };
  assert(
    Buffer.byteLength(JSON.stringify(result), 'utf8') <=
      TASK_PICKUP_LIMITS.briefBytes,
    'Pickup brief exceeds its bounded output size.',
  );
  return result;
}
