import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import test from 'node:test';

import {
  parseV41Profile,
  parseV41RouteEvent,
  type V41ProfileInput,
} from '@temari/contracts';
import { FileWorkflowRunStore } from './run-store.js';
import {
  parseV41RouteReplayEvent,
  replayV41RouteEvent,
} from './v4-1-route-replay.js';

const fixtureRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/v4.1',
);

async function fixture(name: string): Promise<string> {
  return readFile(join(fixtureRoot, name), 'utf8');
}

function profileInput(profileText: string): V41ProfileInput {
  return {
    sourceRevision: '959c8f7be3d7b684207d9e626263d41540d5ecdc',
    profileText,
  };
}

async function parsedFeatureProfile() {
  const result = parseV41Profile(
    profileInput(await fixture('profile-feature-v1.json')),
  );
  if (result.status !== 'valid') throw new Error(result.reason);
  return result.value;
}

async function featureRouteEvent() {
  const result = parseV41RouteEvent(
    JSON.parse(await fixture('route-feature-v1.json')),
  );
  if (result.status !== 'valid') throw new Error(result.reason);
  return result.value;
}

function at(value: string): Date {
  return new Date(value);
}

test('persists and reloads a v4.1 route projection without the old checkout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-route-replay-'));
  try {
    const store = await FileWorkflowRunStore.create(root);
    await store.create({
      runId: 'route-replay-1',
      revision: 'revision-route-replay-1',
      actor: 'coordinator',
      now: at('2026-09-24T12:00:00.000Z'),
    });

    const first = await replayV41RouteEvent(store, {
      runId: 'route-replay-1',
      actor: 'coordinator',
      idempotencyKey: 'route-replay:route-replay-1:1',
      parsed: await parsedFeatureProfile(),
      event: await featureRouteEvent(),
      now: at('2026-09-24T12:00:01.000Z'),
    });
    const replay = await replayV41RouteEvent(store, {
      runId: 'route-replay-1',
      actor: 'coordinator',
      idempotencyKey: 'route-replay:route-replay-1:1',
      parsed: await parsedFeatureProfile(),
      event: await featureRouteEvent(),
      now: at('2026-09-24T12:01:01.000Z'),
    });

    assert.deepEqual(replay, first);
    const events = await store.events('route-replay-1');
    assert.deepEqual(
      events.map((event) => event.type),
      ['run-created', 'run-event'],
    );
    assert.deepEqual(parseV41RouteReplayEvent(events[1]!), first.state);
    assert.equal(
      events[1]!.payload.profilePath as string,
      '/old/checkout/profile.json',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a mismatched route before appending a runtime event', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-route-replay-'));
  try {
    const store = await FileWorkflowRunStore.create(root);
    await store.create({
      runId: 'route-replay-2',
      revision: 'revision-route-replay-2',
      actor: 'coordinator',
      now: at('2026-09-24T12:00:00.000Z'),
    });
    const event = await featureRouteEvent();

    await assert.rejects(
      replayV41RouteEvent(store, {
        runId: 'route-replay-2',
        actor: 'coordinator',
        idempotencyKey: 'route-replay:route-replay-2:1',
        parsed: await parsedFeatureProfile(),
        event: { ...event, profileId: 'other-profile' },
        now: at('2026-09-24T12:00:01.000Z'),
      }),
      /profileId does not match/,
    );
    assert.deepEqual(
      (await store.events('route-replay-2')).map((item) => item.type),
      ['run-created'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a changed projection under an existing idempotency key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'temari-route-replay-'));
  try {
    const store = await FileWorkflowRunStore.create(root);
    await store.create({
      runId: 'route-replay-3',
      revision: 'revision-route-replay-3',
      actor: 'coordinator',
      now: at('2026-09-24T12:00:00.000Z'),
    });
    const parsed = await parsedFeatureProfile();
    const event = await featureRouteEvent();
    const request = {
      runId: 'route-replay-3',
      actor: 'coordinator',
      idempotencyKey: 'route-replay:route-replay-3:1',
      parsed,
      event,
      now: at('2026-09-24T12:00:01.000Z'),
    } as const;
    await replayV41RouteEvent(store, request);

    await assert.rejects(
      replayV41RouteEvent(store, {
        ...request,
        event: {
          ...event,
          assignments: { ...event.assignments, build: 'another-builder' },
        },
      }),
      /Idempotency key payload changed/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
