import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  assessV41RouteReplay,
  assessV41PlanBoundary,
  parseV41Profile,
  parseV41RouteEvent,
  type V41ProfileInput,
  type V41RetainedRequirementEvidence,
} from './v4-1-compatibility.js';

const fixtureRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/v4.1',
);
const featurePlaybookPath = join(
  fixtureRoot,
  '../../packages/workflow-runtime/assets/v4.1/skills/poteto-mode/playbooks/feature.md',
);
const lightweightRoot = join(
  fixtureRoot,
  '../../packages/workflow-runtime/assets/v4.1/skills/poteto-mode',
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
  return createHash('sha256')
    .update(value.replace(/\r\n?/g, '\n'))
    .digest('hex');
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

test('keeps profile identity stable across LF and CRLF text', async () => {
  const profileText = await fixture('profile-feature-v1.json');
  const lf = parseV41Profile(profileInput(profileText.replace(/\r\n?/g, '\n')));
  const crlf = parseV41Profile(
    profileInput(profileText.replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n')),
  );

  assert.equal(lf.status, 'valid');
  assert.equal(crlf.status, 'valid');
  if (lf.status !== 'valid' || crlf.status !== 'valid') return;
  assert.deepEqual(crlf.value.identity, lf.value.identity);
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
  assert.equal(
    result.value.profileSha256,
    '12f4e650dd15d1d5dd9ee7bd4c2af39c0e872155714e76f1f1e024beb516b0a3',
  );
  assert.deepEqual(result.value.assignments, {
    shape: 'coordinator',
    build: 'builder',
    verify: 'coordinator',
    review: 'reviewer',
    delivery: 'coordinator',
  });
});

test('replays a valid route while preserving assignments and historical invalidations', async () => {
  const event = parseV41RouteEvent(
    JSON.parse(await fixture('route-feature-v1.json')),
  );
  assert.equal(event.status, 'valid');
  if (event.status !== 'valid') return;

  const replay = assessV41RouteReplay({
    parsed: await parsedFeatureProfile(),
    event: event.value,
  });

  assert.equal(replay.status, 'supported');
  assert.deepEqual(replay.state, {
    routeVersion: 1,
    profileVersion: 1,
    sourceRevision: '959c8f7be3d7b684207d9e626263d41540d5ecdc',
    profilePath: '/old/checkout/profile.json',
    profileId: 'feature-v1',
    profileSha256:
      '12f4e650dd15d1d5dd9ee7bd4c2af39c0e872155714e76f1f1e024beb516b0a3',
    capabilities: ['subagents', 'forge'],
    assignments: {
      shape: 'coordinator',
      build: 'builder',
      verify: 'coordinator',
      review: 'reviewer',
      delivery: 'coordinator',
    },
    fromProfileId: null,
    invalidatedRequirementIds: [],
  });
});

test('refuses route replay when profile identity or stage coverage is ambiguous', async () => {
  const event = parseV41RouteEvent(
    JSON.parse(await fixture('route-feature-v1.json')),
  );
  assert.equal(event.status, 'valid');
  if (event.status !== 'valid') return;
  const parsed = await parsedFeatureProfile();

  const mismatchedIdentity = assessV41RouteReplay({
    parsed,
    event: { ...event.value, profileId: 'other-profile' },
  });
  assert.equal(mismatchedIdentity.status, 'blocked');
  assert.equal(mismatchedIdentity.state, null);
  assert.equal(
    mismatchedIdentity.reason,
    'Route event profileId does not match the parsed profile.',
  );

  const incompleteAssignments = assessV41RouteReplay({
    parsed,
    event: {
      ...event.value,
      assignments: Object.fromEntries(
        Object.entries(event.value.assignments).filter(
          ([stageId]) => stageId !== 'delivery',
        ),
      ),
    },
  });
  assert.equal(incompleteAssignments.status, 'blocked');
  assert.equal(incompleteAssignments.state, null);
});

test('rejects a route event that claims a capability outside the profile', async () => {
  const event = parseV41RouteEvent(
    JSON.parse(await fixture('route-feature-v1.json')),
  );
  assert.equal(event.status, 'valid');
  if (event.status !== 'valid') return;

  const replay = assessV41RouteReplay({
    parsed: await parsedFeatureProfile(),
    event: {
      ...event.value,
      capabilities: [...event.value.capabilities, 'parallelism'],
    },
  });

  assert.equal(replay.status, 'blocked');
  assert.equal(
    replay.reason,
    'Route event claims a capability not declared by the profile: parallelism.',
  );
});

test('marks a future route event version incompatible before replay', async () => {
  const event = parseV41RouteEvent(
    JSON.parse(await fixture('route-feature-v1.json')),
  );
  assert.equal(event.status, 'valid');
  if (event.status !== 'valid') return;

  const replay = assessV41RouteReplay({
    parsed: await parsedFeatureProfile(),
    event: { ...event.value, version: 2 } as never,
  });

  assert.equal(replay.status, 'incompatible');
  assert.equal(replay.state, null);
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

test('maps only the pinned lightweight source at final, commit, and review', async () => {
  const profileText = await readFile(
    join(lightweightRoot, 'playbook-contracts/v1/lightweight-engineering.json'),
    'utf8',
  );
  const playbookText = await readFile(
    join(lightweightRoot, 'playbooks/lightweight-engineering.md'),
    'utf8',
  );
  const parsed = parseV41Profile(profileInput(profileText));
  if (parsed.status !== 'valid') throw new Error(parsed.reason);
  const reference = {
    schema: 1 as const,
    runId: 'synthetic-run',
    revision: 'synthetic-revision',
    kind: 'other' as const,
    sha256: 'a'.repeat(64),
    bytes: 12,
  };
  const sourceEvidence: V41RetainedRequirementEvidence[] = [
    {
      stage: 'investigate',
      id: 'lightweight.intake.inspect',
      sourceKind: 'document',
      reference,
    },
    {
      stage: 'plan',
      id: 'lightweight.route.qualifies',
      sourceKind: 'document',
      reference,
    },
    {
      stage: 'build',
      id: 'lightweight.build.smallest-complete-change',
      sourceKind: 'diff',
      reference,
    },
    {
      stage: 'review',
      id: 'lightweight.verify.direct-check',
      sourceKind: 'diff',
      reference,
    },
    {
      stage: 'verify',
      id: 'lightweight.verify.direct-check',
      sourceKind: 'command',
      reference,
    },
  ];
  assert.equal(
    assessV41PlanBoundary({
      parsed: parsed.value,
      boundary: 'final',
      playbookText,
      workType: 'feature',
    }).status,
    'blocked',
  );
  for (const boundary of ['final', 'commit', 'review'] as const) {
    const result = assessV41PlanBoundary({
      parsed: parsed.value,
      boundary,
      playbookText,
      workType: 'feature',
      sourceEvidence,
    });
    assert.equal(result.status, 'supported');
    assert.deepEqual(result.plan?.stages, [
      'investigate',
      'plan',
      'build',
      'review',
      'verify',
      'deliver',
    ]);
    assert.deepEqual(
      [...new Set(Object.values(result.stageMapping).flat())].sort(),
      parsed.value.profile.stages
        .flatMap((stage) =>
          stage.requirements.map((requirement) => requirement.id),
        )
        .sort(),
    );
  }
  const publish = assessV41PlanBoundary({
    parsed: parsed.value,
    boundary: 'publish',
    playbookText,
    workType: 'feature',
  });
  assert.equal(publish.status, 'blocked');
  assert.deepEqual(publish.requiredGates, ['operator-approval']);
  assert.equal(publish.plan, null);
  assert.equal(
    assessV41PlanBoundary({
      parsed: parsed.value,
      boundary: 'final',
      playbookText,
      workType: 'feature',
      sourceEvidence: sourceEvidence.slice(0, -1),
    }).status,
    'blocked',
  );
  assert.equal(
    assessV41PlanBoundary({
      parsed: parsed.value,
      boundary: 'final',
      playbookText,
      workType: 'feature',
      sourceEvidence: [...sourceEvidence.slice(0, -1), sourceEvidence[0]!],
    }).status,
    'blocked',
  );
  assert.equal(
    assessV41PlanBoundary({
      parsed: parsed.value,
      boundary: 'final',
      playbookText,
      workType: 'feature',
      sourceEvidence: sourceEvidence.map((item, index) =>
        index === 0 ? { ...item, reference: { ...reference, bytes: 0 } } : item,
      ),
    }).status,
    'blocked',
  );
  assert.equal(
    assessV41PlanBoundary({
      parsed: parsed.value,
      boundary: 'final',
      playbookText: 'changed',
      workType: 'feature',
    }).status,
    'blocked',
  );
  assert.equal(
    assessV41PlanBoundary({
      parsed: parsed.value,
      boundary: 'final',
      playbookText,
      workType: 'bug',
    }).status,
    'incompatible',
  );
});

test('accepts equivalent CRLF playbook text on Windows hosts', async () => {
  const playbook = await featurePlaybookText();
  const boundary = assessV41PlanBoundary({
    parsed: await parsedFeatureProfile(),
    boundary: 'final',
    playbookText: playbook.replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n'),
    workType: 'feature',
  });

  assert.equal(boundary.status, 'supported');
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
