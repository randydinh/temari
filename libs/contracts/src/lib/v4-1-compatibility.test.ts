import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  parseV41Profile,
  parseV41RouteEvent,
  type V41ProfileInput,
} from './v4-1-compatibility.js';

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

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

test('parses a valid v4.1 profile and preserves source identity', async () => {
  const profileText = await fixture('profile-feature-v1.json');
  const result = parseV41Profile(profileInput(profileText));

  assert.equal(result.status, 'valid');
  if (result.status !== 'valid') return;
  assert.deepEqual(result.value.identity, {
    sourceRevision: '959c8f7be3d7b684207d9e626263d41540d5ecdc',
    profileSha256: sha256(profileText),
  });
  assert.equal(result.value.validation, 'structural-only');
  assert.equal(result.value.profile.id, 'feature-v1');
  assert.deepEqual(
    result.value.profile.stages.map((stage) => stage.id),
    ['shape', 'build', 'verify', 'review', 'delivery'],
  );
});

test('rejects malformed profiles without producing an executable plan', async () => {
  const profile = JSON.parse(
    await fixture('profile-feature-v1.json'),
  ) as Record<string, unknown>;
  const malformed = {
    ...profile,
    playbook: {
      ...(profile.playbook as Record<string, unknown>),
      path: '/old/checkout/playbooks/feature.md',
    },
  };
  const result = parseV41Profile(profileInput(JSON.stringify(malformed)));

  assert.deepEqual(result, {
    status: 'invalid',
    reason: 'profile.playbook.path must be relative',
  });
});

test('rejects a profile when supplied identity does not match its bytes', async () => {
  const result = parseV41Profile({
    ...profileInput(await fixture('profile-feature-v1.json')),
    expectedProfileSha256: 'a'.repeat(64),
  });

  assert.deepEqual(result, {
    status: 'invalid',
    reason: 'profileSha256 does not match profileText',
  });
});

test('rejects duplicate stage and requirement identities', async () => {
  const profile = JSON.parse(
    await fixture('profile-feature-v1.json'),
  ) as Record<string, unknown>;
  const stages = profile.stages as Array<Record<string, unknown>>;
  const duplicate = {
    ...profile,
    stages: [stages[0], stages[0]],
  };
  const result = parseV41Profile(profileInput(JSON.stringify(duplicate)));

  assert.deepEqual(result, {
    status: 'invalid',
    reason: 'profile stage ids must be unique',
  });
});

test('parses a route event without treating its local path as portable identity', async () => {
  const result = parseV41RouteEvent(
    JSON.parse(await fixture('route-feature-v1.json')),
  );

  assert.equal(result.status, 'valid');
  if (result.status !== 'valid') return;
  assert.equal(result.value.profilePath, '/old/checkout/profile.json');
  assert.equal(result.value.profileSha256, 'a'.repeat(64));
  assert.deepEqual(result.value.assignments, {
    shape: 'coordinator',
    build: 'builder',
    verify: 'coordinator',
    review: 'reviewer',
    delivery: 'coordinator',
  });
});

test('rejects a route event with an unsupported version or invalid assignment', async () => {
  const route = JSON.parse(await fixture('route-feature-v1.json')) as Record<
    string,
    unknown
  >;
  const result = parseV41RouteEvent({
    ...route,
    version: 2,
    assignments: { build: '' },
  });

  assert.deepEqual(result, {
    status: 'invalid',
    reason: 'route event version or kind is invalid',
  });
});
