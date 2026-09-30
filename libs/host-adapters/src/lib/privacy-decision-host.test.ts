import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import {
  loadPrivacyPreferences,
  savePrivacyPreferences,
  type PrivacyLearningDecision,
  type PrivacyPreferences,
  type PrivacyRule,
} from '@temari/privacy';
import { createPrivacyDecisionHost } from './privacy-decision-host.js';

const initial: PrivacyPreferences = {
  schemaVersion: 1,
  level: 'balanced',
  rules: [],
};
const scope = { workspaceId: 'synthetic-workspace', sourceId: 'ticket' };

async function localHost(t: TestContext) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'temari-privacy-decision-host-')),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'settings.json');
  await savePrivacyPreferences(path, initial);
  const host = createPrivacyDecisionHost({
    load: () => loadPrivacyPreferences(path),
    save: (preferences) => savePrivacyPreferences(path, preferences),
  });
  return { host, path };
}

function allowRule(id: string, value: string): PrivacyRule {
  return {
    id,
    scope,
    persistence: 'submission',
    category: 'EMAIL',
    value,
    action: 'allow',
    basis: 'user-authorized',
  };
}

function maskChoice(id: string, value: string): PrivacyLearningDecision {
  return {
    id,
    scope,
    category: 'PHONE',
    decision: 'mask',
    value,
    explicitUser: true,
  };
}

test(
  'the host persists explicit allows once and offers a new group only at the threshold',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { host, path } = await localHost(t);
    const firstRule = allowRule('exact-1', 'one@example.invalid');
    const first = await host.allowOnce({
      id: 'event-1',
      rule: firstRule,
      explicitUser: true,
    });
    assert.equal(first.persistenceOffer, null);
    assert.deepEqual(first.newGroupProposals, []);

    const repeated = await host.allowOnce({
      id: 'event-1',
      rule: firstRule,
      explicitUser: true,
    });
    assert.equal(repeated.persistenceOffer, null);
    assert.equal(
      (await loadPrivacyPreferences(path)).learningMemory?.events.length,
      1,
    );

    const second = await host.allowOnce({
      id: 'event-2',
      rule: firstRule,
      explicitUser: true,
    });
    assert.equal(second.persistenceOffer?.approvalCount, 2);
    assert.deepEqual(second.newGroupProposals, []);
    await host.allowOnce({
      id: 'event-3',
      rule: allowRule('exact-2', 'two@example.invalid'),
      explicitUser: true,
    });
    const threshold = await host.allowOnce({
      id: 'event-4',
      rule: allowRule('exact-3', 'three@example.invalid'),
      explicitUser: true,
    });
    assert.equal(threshold.newGroupProposals.length, 1);
    assert.equal(threshold.newGroupProposals[0].suggestedDefault, 'allow');
    assert.equal(threshold.newGroupProposals[0].requiresApproval, true);
    const later = await host.allowOnce({
      id: 'event-5',
      rule: allowRule('exact-4', 'four@example.invalid'),
      explicitUser: true,
    });
    assert.deepEqual(later.newGroupProposals, []);
    assert.equal((await host.pendingGroupProposals(scope)).length, 1);
    assert.deepEqual(
      await host.pendingGroupProposals({
        workspaceId: 'different-workspace',
        sourceId: scope.sourceId,
      }),
      [],
    );
    assert(
      !JSON.stringify(await loadPrivacyPreferences(path)).includes(
        'one@example.invalid',
      ),
    );

    await host.neverSuggestGroup(threshold.newGroupProposals[0].id);
    assert.deepEqual(await host.pendingGroupProposals(scope), []);
    await host.resolveExactOffer(firstRule, 'save');
    const saved = await loadPrivacyPreferences(path);
    assert.equal(saved.rules[0].value, 'one@example.invalid');
    assert.deepEqual(await host.pendingGroupProposals(scope), []);
  },
);

test(
  'the host serializes choices and recovers after a rejected input',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { host, path } = await localHost(t);
    const rejected = host.maskOnce({
      ...maskChoice('invalid', 'synthetic-0'),
      explicitUser: false as true,
    });
    const accepted = host.maskOnce(maskChoice('mask-1', 'synthetic-1'));
    await assert.rejects(
      rejected,
      /Invalid explicit privacy learning decision/,
    );
    await accepted;
    const results = await Promise.all([
      host.maskOnce(maskChoice('mask-2', 'synthetic-2')),
      host.maskOnce(maskChoice('mask-3', 'synthetic-3')),
    ]);
    assert.equal(
      results.flatMap((result) => result.newGroupProposals).length,
      1,
    );
    const loaded = await loadPrivacyPreferences(path);
    assert.equal(loaded.learningMemory?.events.length, 3);
    assert.equal(
      (await host.pendingGroupProposals(scope))[0].suggestedDefault,
      'mask',
    );
  },
);
