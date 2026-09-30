import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { disposePrivacySession } from './privacy.js';
import {
  loadPrivacyPreferences,
  planPrivacySubmission,
  savePrivacyPreferences,
  type PrivacyPreferences,
} from './privacy-preferences.js';
import {
  recordPrivacyLearningDecision,
  suggestPrivacyGroupDefaults,
  suppressPrivacyGroupProposal,
  type PrivacyLearningDecision,
} from './privacy-learning.js';

const settings: PrivacyPreferences = {
  schemaVersion: 1,
  level: 'balanced',
  rules: [],
};
const scope = { workspaceId: 'synthetic-workspace', sourceId: 'ticket' };

function decision(
  id: string,
  value: string,
  choice: PrivacyLearningDecision['decision'] = 'allow',
  overrides: Partial<PrivacyLearningDecision> = {},
): PrivacyLearningDecision {
  return {
    id,
    value,
    category: 'EMAIL',
    scope,
    decision: choice,
    explicitUser: true,
    ...overrides,
  };
}

test('three distinct explicit decisions propose a narrow group without changing masking', () => {
  let state = settings;
  for (const [index, value] of [
    'one@example.invalid',
    'two@example.invalid',
    'three@example.invalid',
  ].entries()) {
    state = recordPrivacyLearningDecision(
      state,
      decision(`choice-${index}`, value),
    );
    if (index < 2) assert.deepEqual(suggestPrivacyGroupDefaults(state), []);
  }
  const proposals = suggestPrivacyGroupDefaults(state);
  assert.equal(proposals.length, 1);
  assert.deepEqual(
    {
      scope: proposals[0].scope,
      category: proposals[0].category,
      suggestedDefault: proposals[0].suggestedDefault,
      distinctValues: proposals[0].distinctValues,
      decisionCount: proposals[0].decisionCount,
      requiresApproval: proposals[0].requiresApproval,
    },
    {
      scope,
      category: 'EMAIL',
      suggestedDefault: 'allow',
      distinctValues: 3,
      decisionCount: 3,
      requiresApproval: true,
    },
  );
  assert(!JSON.stringify(state).includes('one@example.invalid'));
  assert(!JSON.stringify(proposals).includes('one@example.invalid'));
  const planned = planPrivacySubmission(
    { email: 'one@example.invalid' },
    state,
    scope,
  );
  try {
    assert(!JSON.stringify(planned.payload).includes('one@example.invalid'));
  } finally {
    disposePrivacySession(planned.session);
  }
});

test('conflicting choices, split scopes, and sensitive allows do not produce a group', () => {
  let conflicted = settings;
  for (let index = 0; index < 3; index++)
    conflicted = recordPrivacyLearningDecision(
      conflicted,
      decision(`allow-${index}`, `allowed-${index}@example.invalid`),
    );
  conflicted = recordPrivacyLearningDecision(
    conflicted,
    decision('masked', 'masked@example.invalid', 'mask'),
  );
  assert.deepEqual(suggestPrivacyGroupDefaults(conflicted), []);

  let split = settings;
  for (let index = 0; index < 3; index++)
    split = recordPrivacyLearningDecision(
      split,
      decision(`split-${index}`, `split-${index}@example.invalid`, 'allow', {
        scope: { workspaceId: `workspace-${index}`, sourceId: 'ticket' },
      }),
    );
  assert.deepEqual(suggestPrivacyGroupDefaults(split), []);

  let sensitive = settings;
  for (let index = 0; index < 3; index++)
    sensitive = recordPrivacyLearningDecision(
      sensitive,
      decision(`account-${index}`, `synthetic-account-${index}`, 'allow', {
        category: 'ACCOUNT',
      }),
    );
  assert.deepEqual(suggestPrivacyGroupDefaults(sensitive), []);
});

test('explicit mask choices can suggest a mask default, while forged or repeated events refuse', () => {
  let state = settings;
  for (let index = 0; index < 3; index++)
    state = recordPrivacyLearningDecision(
      state,
      decision(`mask-${index}`, `synthetic-${index}`, 'mask', {
        category: 'PHONE',
      }),
    );
  assert.equal(suggestPrivacyGroupDefaults(state)[0].suggestedDefault, 'mask');
  const repeated = recordPrivacyLearningDecision(
    state,
    decision('mask-0', 'synthetic-0', 'mask', { category: 'PHONE' }),
  );
  assert.deepEqual(repeated, state);
  assert.throws(
    () =>
      recordPrivacyLearningDecision(
        state,
        decision('mask-0', 'different', 'mask', { category: 'PHONE' }),
      ),
    /Conflicting privacy learning decision ID/,
  );
  assert.throws(
    () =>
      recordPrivacyLearningDecision(state, {
        ...decision('forged', 'synthetic'),
        explicitUser: false as true,
      }),
    /Invalid explicit privacy learning decision/,
  );
  assert.throws(
    () =>
      recordPrivacyLearningDecision(state, {
        ...decision('credential', 'synthetic'),
        category: 'CREDENTIAL' as PrivacyLearningDecision['category'],
      }),
    /Invalid explicit privacy learning decision/,
  );
});

test('a bounded history keeps an old conflicting choice instead of silently forgetting it', () => {
  let state = recordPrivacyLearningDecision(
    settings,
    decision('first-mask', 'masked@example.invalid', 'mask'),
  );
  for (let index = 0; index < 255; index++)
    state = recordPrivacyLearningDecision(
      state,
      decision(`later-${index}`, `later-${index}@example.invalid`),
    );
  assert.deepEqual(suggestPrivacyGroupDefaults(state), []);
  assert.throws(
    () =>
      recordPrivacyLearningDecision(
        state,
        decision('overflow', 'overflow@example.invalid'),
      ),
    /Privacy learning memory is full/,
  );
});

test(
  'suppressed groups remain suppressed after preferences are saved and reloaded',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'temari-privacy-learning-')),
    );
    t.after(() => rm(root, { recursive: true, force: true }));
    let state = settings;
    for (let index = 0; index < 3; index++)
      state = recordPrivacyLearningDecision(
        state,
        decision(`choice-${index}`, `choice-${index}@example.invalid`),
      );
    const proposal = suggestPrivacyGroupDefaults(state)[0];
    state = suppressPrivacyGroupProposal(state, proposal.id);
    const path = join(root, 'settings.json');
    await savePrivacyPreferences(path, state);
    const loaded = await loadPrivacyPreferences(path);
    assert.deepEqual(suggestPrivacyGroupDefaults(loaded), []);
    assert.deepEqual(suppressPrivacyGroupProposal(loaded, proposal.id), loaded);
    assert(!JSON.stringify(loaded).includes('choice-0@example.invalid'));
  },
);
