import assert from 'node:assert/strict';

import {
  assessV41RouteReplay,
  parseV41RouteEvent,
  type V41ParsedProfile,
  type V41RouteReplayState,
} from '@temari/contracts';
import type {
  RunEvent,
  RunEventPayload,
  WorkflowRunStore,
} from './run-store.js';

const REPLAY_KIND = 'v4.1-route-replay';
const IDENTIFIER = /^[a-z][a-z0-9-]*$/;
const REQUIREMENT_ID = /^[a-z][a-z0-9.-]*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SOURCE_REVISION = /^[a-f0-9]{40}$/;

export interface V41RouteReplayRequest {
  readonly runId: string;
  readonly actor: string;
  readonly idempotencyKey: string;
  readonly parsed: V41ParsedProfile;
  readonly event: unknown;
  readonly now?: Date;
}

export interface V41RouteReplayRecord {
  readonly state: V41RouteReplayState;
  readonly event: RunEvent;
}

function expectedKeys(payload: RunEventPayload): void {
  const actual = Object.keys(payload).sort();
  const expected = [
    'assignments',
    'capabilities',
    'fromProfileId',
    'invalidatedRequirementIds',
    'kind',
    'profileId',
    'profilePath',
    'profileSha256',
    'profileVersion',
    'routeVersion',
    'sourceRevision',
  ].sort();
  assert.deepEqual(actual, expected, 'Route replay payload fields changed.');
}

function text(value: unknown, label: string, pattern?: RegExp): string {
  assert(
    typeof value === 'string' &&
      value.length > 0 &&
      (pattern === undefined || pattern.test(value)),
    `${label} is invalid.`,
  );
  return value;
}

function uniqueTexts(
  value: unknown,
  label: string,
  pattern?: RegExp,
): readonly string[] {
  assert(Array.isArray(value), `${label} must be an array.`);
  const values = value.map((item, index) =>
    text(item, `${label}[${index}]`, pattern),
  );
  assert(
    new Set(values).size === values.length,
    `${label} contains duplicates.`,
  );
  return values;
}

function json(value: unknown, label: string): unknown {
  assert(typeof value === 'string', `${label} is not encoded JSON.`);
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

function assignments(value: unknown): Readonly<Record<string, string>> {
  assert(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'Route replay assignments must be an object.',
  );
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([stageId, actor]) => [
      text(stageId, 'Route replay assignment stage', IDENTIFIER),
      text(actor, `Route replay assignment ${stageId}`),
    ]),
  );
}

function replayPayload(state: V41RouteReplayState): RunEventPayload {
  return {
    kind: REPLAY_KIND,
    routeVersion: state.routeVersion,
    profileVersion: state.profileVersion,
    sourceRevision: state.sourceRevision,
    profilePath: state.profilePath,
    profileId: state.profileId,
    profileSha256: state.profileSha256,
    capabilities: JSON.stringify(state.capabilities),
    assignments: JSON.stringify(state.assignments),
    fromProfileId: state.fromProfileId,
    invalidatedRequirementIds: JSON.stringify(state.invalidatedRequirementIds),
  };
}

/** Decode the durable route projection without consulting the old checkout. */
export function parseV41RouteReplayEvent(event: RunEvent): V41RouteReplayState {
  assert.equal(event.type, 'run-event');
  const payload = event.payload;
  expectedKeys(payload);
  assert.equal(payload.kind, REPLAY_KIND);
  assert.equal(payload.routeVersion, 1);
  assert.equal(payload.profileVersion, 1);

  const fromProfileId = payload.fromProfileId;
  assert(
    fromProfileId === null ||
      (typeof fromProfileId === 'string' && IDENTIFIER.test(fromProfileId)),
    'Route replay fromProfileId is invalid.',
  );

  return {
    routeVersion: 1,
    profileVersion: 1,
    sourceRevision: text(
      payload.sourceRevision,
      'Route replay sourceRevision',
      SOURCE_REVISION,
    ),
    profilePath: text(payload.profilePath, 'Route replay profilePath'),
    profileId: text(payload.profileId, 'Route replay profileId', IDENTIFIER),
    profileSha256: text(
      payload.profileSha256,
      'Route replay profileSha256',
      SHA256,
    ),
    capabilities: uniqueTexts(
      json(payload.capabilities, 'Route replay capabilities'),
      'Route replay capabilities',
      IDENTIFIER,
    ),
    assignments: assignments(
      json(payload.assignments, 'Route replay assignments'),
    ),
    fromProfileId,
    invalidatedRequirementIds: uniqueTexts(
      json(
        payload.invalidatedRequirementIds,
        'Route replay invalidatedRequirementIds',
      ),
      'Route replay invalidatedRequirementIds',
      REQUIREMENT_ID,
    ),
  };
}

/** Validate and persist one v4.1 route as an idempotent runtime event. */
export async function replayV41RouteEvent(
  store: WorkflowRunStore,
  request: V41RouteReplayRequest,
): Promise<V41RouteReplayRecord> {
  const parsedEvent = parseV41RouteEvent(request.event);
  if (parsedEvent.status !== 'valid') {
    throw new Error(`Cannot replay v4.1 route event: ${parsedEvent.reason}`);
  }

  const assessed = assessV41RouteReplay({
    parsed: request.parsed,
    event: parsedEvent.value,
  });
  if (assessed.status !== 'supported' || assessed.state === null) {
    throw new Error(
      `Cannot replay v4.1 route event: ${assessed.reason ?? assessed.status}.`,
    );
  }

  const event = await store.appendEvent({
    runId: request.runId,
    actor: request.actor,
    type: 'run-event',
    idempotencyKey: request.idempotencyKey,
    payload: replayPayload(assessed.state),
    now: request.now,
  });
  return { state: assessed.state, event };
}
