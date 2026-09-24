import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  assessV41PlanBoundary,
  parseV41Profile,
  parseV41RouteEvent,
  type V41ProfileInput,
} from './v4-1-compatibility.js';

const fixtureRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/v4.1',
);
const featurePlaybookPath = join(
  fixtureRoot,
  '../../packages/workflow-runtime/assets/v4.1/skills/poteto-mode/playbooks/feature.md',
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

async function parsedFeatureProfile() {
  const result = parseV41Profile(
    profileInput(await fixture('profile-feature-v1.json')),
  );
  if (result.status !== 'valid') throw new Error(result.reason);
  return result.value;
}

async function featurePlaybookText(): Promise<string> {
  return readFile(featurePlaybookPath, 'utf8');
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

test('maps the verified feature profile to the canonical Nx plan at final', async () => {
  const boundary = assessV41PlanBoundary({
    parsed: await parsedFeatureProfile(),
    boundary: 'final',
    playbookText: await featurePlaybookText(),
    workType: 'feature',
  });

  assert.equal(boundary.status, 'supported');
  assert.equal(boundary.targetExecutionPlanVersion, 1);
  assert.deepEqual(boundary.targetStages, [
    'investigate',
    'plan',
    'build',
    'review',
    'verify',
    'deliver',
  ]);
  assert.deepEqual(boundary.sourceStageIds, [
    'shape',
    'build',
    'verify',
    'review',
    'delivery',
  ]);
  assert.deepEqual(boundary.stageMapping, {
    investigate: ['shape'],
    plan: ['shape'],
    build: ['build'],
    review: ['review'],
    verify: ['verify'],
    deliver: ['delivery'],
  });
  assert.deepEqual(boundary.plan?.requiredCapabilities, ['subagents', 'forge']);
});

test('blocks the feature profile at publish until operator approval is represented', async () => {
  const boundary = assessV41PlanBoundary({
    parsed: await parsedFeatureProfile(),
    boundary: 'publish',
    playbookText: await featurePlaybookText(),
    workType: 'feature',
  });

  assert.equal(boundary.status, 'blocked');
  assert.equal(boundary.plan, null);
  assert.deepEqual(boundary.requiredGates, ['operator-approval']);
  assert.equal(
    boundary.reason,
    'Source boundary requires unresolved gates: operator-approval.',
  );
});

test('refuses a profile that points at a different playbook', async () => {
  const profile = JSON.parse(
    await fixture('profile-feature-v1.json'),
  ) as Record<string, unknown>;
  const parsed = parseV41Profile(
    profileInput(
      JSON.stringify({
        ...profile,
        playbook: {
          ...(profile.playbook as Record<string, unknown>),
          path: '../../playbooks/bug-fix.md',
        },
      }),
    ),
  );
  if (parsed.status === 'invalid') throw new Error(parsed.reason);

  const boundary = assessV41PlanBoundary({
    parsed: parsed.value,
    boundary: 'final',
    playbookText: await featurePlaybookText(),
    workType: 'feature',
  });

  assert.equal(boundary.status, 'incompatible');
  assert.equal(boundary.plan, null);
});

test('does not manufacture an Nx plan for the unmapped lightweight route', async () => {
  const profile = JSON.parse(
    await fixture('profile-feature-v1.json'),
  ) as Record<string, unknown>;
  const parsed = parseV41Profile(
    profileInput(
      JSON.stringify({ ...profile, route: 'lightweight-engineering' }),
    ),
  );
  if (parsed.status === 'invalid') throw new Error(parsed.reason);

  const boundary = assessV41PlanBoundary({
    parsed: parsed.value,
    boundary: 'final',
    playbookText: await featurePlaybookText(),
    workType: 'bug',
  });

  assert.equal(boundary.status, 'incompatible');
  assert.equal(boundary.plan, null);
  assert.deepEqual(boundary.stageMapping.investigate, []);
});

test('blocks a structurally valid profile with an unmapped capability', async () => {
  const profile = JSON.parse(
    await fixture('profile-feature-v1.json'),
  ) as Record<string, unknown>;
  const stages = profile.stages as Array<Record<string, unknown>>;
  const build = stages[1];
  assert.ok(build);
  const requirements = build.requirements as Array<Record<string, unknown>>;
  const requirement = requirements[0];
  assert.ok(requirement);
  const parsed = parseV41Profile(
    profileInput(
      JSON.stringify({
        ...profile,
        stages: [
          stages[0],
          {
            ...build,
            requirements: [
              { ...requirement, requiredCapabilities: ['credential-store'] },
            ],
          },
          ...stages.slice(2),
        ],
      }),
    ),
  );
  if (parsed.status === 'invalid') throw new Error(parsed.reason);

  const boundary = assessV41PlanBoundary({
    parsed: parsed.value,
    boundary: 'final',
    playbookText: await featurePlaybookText(),
    workType: 'feature',
  });

  assert.equal(boundary.status, 'blocked');
  assert.equal(
    boundary.reason,
    'Feature profile requires an unmapped capability: credential-store.',
  );
});

test('blocks a profile when its playbook bytes do not match the identity', async () => {
  const boundary = assessV41PlanBoundary({
    parsed: await parsedFeatureProfile(),
    boundary: 'final',
    playbookText: 'stale playbook bytes',
    workType: 'feature',
  });

  assert.equal(boundary.status, 'blocked');
  assert.equal(
    boundary.reason,
    'Playbook bytes do not match the profile hash.',
  );
});
