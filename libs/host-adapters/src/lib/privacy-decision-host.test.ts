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

function memoryStore() {
  let state = structuredClone(initial);
  let saves = 0;
  return {
    load: async () => structuredClone(state),
    save: async (next: PrivacyPreferences) => {
      state = structuredClone(next);
      saves++;
    },
    snapshot: () => structuredClone(state),
    saves: () => saves,
  };
}

test('restart retry keeps one approval and conflicting event IDs leave persisted state intact', async () => {
  const store = memoryStore();
  const rule = allowRule('restart-rule', 'restart@example.invalid');
  await createPrivacyDecisionHost(store).allowOnce({
    id: 'restart-event',
    rule,
    explicitUser: true,
  });
  const before = store.snapshot();
  const resumed = createPrivacyDecisionHost(store);
  assert.deepEqual(
    await resumed.allowOnce({ id: 'restart-event', rule, explicitUser: true }),
    {
      persistenceOffer: null,
      newGroupProposals: [],
    },
  );
  assert.equal(store.saves(), 1);
  await assert.rejects(
    resumed.allowOnce({
      id: 'restart-event',
      rule: { ...rule, value: 'different@example.invalid' },
      explicitUser: true,
    }),
    /Conflicting privacy learning decision ID/,
  );
  await assert.rejects(
    resumed.allowOnce({
      id: 'restart-event',
      rule: { ...rule, scope: { ...scope, sourceId: 'other-source' } },
      explicitUser: true,
    }),
    /Conflicting privacy learning decision ID/,
  );
  assert.deepEqual(store.snapshot(), before);
  assert.equal(store.saves(), 1);
});

test('not-now does not save a rule and source-scoped group suppression survives restart', async () => {
  const store = memoryStore();
  const host = createPrivacyDecisionHost(store);
  const rule = allowRule('not-now-rule', 'deferred@example.invalid');
  await host.allowOnce({ id: 'not-now-1', rule, explicitUser: true });
  const offer = await host.allowOnce({
    id: 'not-now-2',
    rule,
    explicitUser: true,
  });
  assert.equal(offer.persistenceOffer?.approvalCount, 2);
  const before = store.snapshot();
  const saves = store.saves();
  await host.resolveExactOffer(rule, 'not-now');
  assert.equal(store.saves(), saves);
  assert.deepEqual(store.snapshot(), before);
  await host.allowOnce({
    id: 'group-a',
    rule: allowRule('group-a-rule', 'a@example.invalid'),
    explicitUser: true,
  });
  const third = await host.allowOnce({
    id: 'group-b',
    rule: allowRule('group-b-rule', 'b@example.invalid'),
    explicitUser: true,
  });
  assert.equal(third.newGroupProposals.length, 1);
  assert.deepEqual(
    await host.pendingGroupProposals({ ...scope, sourceId: 'other-source' }),
    [],
  );
  await host.neverSuggestGroup(third.newGroupProposals[0].id);
  assert.deepEqual(
    await createPrivacyDecisionHost(store).pendingGroupProposals(scope),
    [],
  );
  await host.resolveExactOffer(rule, 'never-suggest');
  assert.deepEqual(store.snapshot().rules, []);
});

test('a pre-write store failure leaves state intact and does not poison the action queue', async () => {
  const memory = memoryStore();
  let fail = true;
  const host = createPrivacyDecisionHost({
    load: memory.load,
    save: async (next) => {
      if (fail) {
        fail = false;
        throw new Error('injected before-write failure');
      }
      await memory.save(next);
    },
  });
  const rejected = host.maskOnce(
    maskChoice('retry-mask', 'fictional-mask-value'),
  );
  await assert.rejects(rejected, /injected before-write failure/);
  assert.deepEqual(memory.snapshot(), initial);
  await host.maskOnce(maskChoice('retry-mask', 'fictional-mask-value'));
  assert.equal(memory.snapshot().learningMemory?.events.length, 1);
  assert.equal(memory.saves(), 1);
});

test('a committed save with lost acknowledgement is reloaded on retry without a duplicate offer', async () => {
  const memory = memoryStore();
  let failAfterCommit = false;
  const host = createPrivacyDecisionHost({
    load: memory.load,
    save: async (next) => {
      await memory.save(next);
      if (failAfterCommit) {
        failAfterCommit = false;
        throw new Error('injected lost acknowledgement');
      }
    },
  });
  await host.maskOnce(maskChoice('ack-1', 'fictional-1'));
  await host.maskOnce(maskChoice('ack-2', 'fictional-2'));
  failAfterCommit = true;
  await assert.rejects(
    host.maskOnce(maskChoice('ack-3', 'fictional-3')),
    /injected lost acknowledgement/,
  );
  assert.equal(memory.snapshot().learningMemory?.events.length, 3);
  assert.equal((await host.pendingGroupProposals(scope)).length, 1);
  const retry = await createPrivacyDecisionHost(memory).maskOnce(
    maskChoice('ack-3', 'fictional-3'),
  );
  assert.deepEqual(retry, { persistenceOffer: null, newGroupProposals: [] });
  assert.equal(memory.snapshot().learningMemory?.events.length, 3);
  assert.equal(memory.saves(), 3);
  assert.equal(
    (await createPrivacyDecisionHost(memory).pendingGroupProposals(scope))
      .length,
    1,
  );
});
