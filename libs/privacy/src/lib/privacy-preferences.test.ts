import assert from 'node:assert/strict';
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { disposePrivacySession, mask } from './privacy.js';
import {
  loadPrivacyPreferences,
  planPrivacySubmission,
  recordPrivacyOverride,
  resolvePrivacyOverride,
  savePrivacyPreferences,
  validatePrivacyPreferences,
  type PrivacyPreferences,
  type PrivacyRule,
} from './privacy-preferences.js';

const scope = { workspaceId: 'workspace-1', sourceId: 'submission' };
const publicEmail: PrivacyRule = {
  id: 'public-contact',
  scope: { workspaceId: 'workspace-1' },
  persistence: 'saved',
  category: 'EMAIL',
  value: 'contact@example.org',
  action: 'allow',
  basis: 'verified-public',
  evidenceRef: 'local-public-directory-record-1',
};
const addressZone: PrivacyRule = {
  id: 'address-zone',
  scope,
  persistence: 'saved',
  category: 'ADDRESS',
  value: '123 Synthetic Lane',
  action: 'substitute',
  substitute: 'service zone 7',
};
const oneTimeContact: PrivacyRule = {
  id: 'remember-contact',
  scope,
  persistence: 'submission',
  category: 'EMAIL',
  value: 'contact@example.org',
  action: 'allow',
  basis: 'user-authorized',
};
const settings = (
  level: PrivacyPreferences['level'],
  rules: readonly PrivacyRule[] = [],
): PrivacyPreferences => ({
  schemaVersion: 1,
  level,
  ...(level === 'permissive' ? { permissiveAcknowledged: true as const } : {}),
  rules,
});

test('strict masks exact public contacts while keeping a local address substitute', () => {
  const planned = planPrivacySubmission(
    { email: 'contact@example.org', address: '123 Synthetic Lane' },
    settings('strict', [publicEmail, addressZone]),
    scope,
  );
  try {
    const text = JSON.stringify(planned.payload);
    assert(!text.includes('contact@example.org'));
    assert(!text.includes('123 Synthetic Lane'));
    assert(text.includes('service zone 7'));
    assert.deepEqual(planned.preview.possibleImpact, ['identity-matching']);
    assert.deepEqual(planned.preview.rulesApplied, [
      {
        id: 'address-zone',
        action: 'substitute',
        persistence: 'saved',
        occurrences: 1,
      },
    ]);
    assert(!JSON.stringify(planned.preview).includes('123 Synthetic Lane'));
  } finally {
    disposePrivacySession(planned.session);
  }
});

test('balanced allows only a scoped exact value with an explicit basis', () => {
  const planned = planPrivacySubmission(
    { email: 'contact@example.org', other: 'private@example.org' },
    settings('balanced', [publicEmail]),
    scope,
  );
  try {
    const text = JSON.stringify(planned.payload);
    assert(text.includes('contact@example.org'));
    assert(!text.includes('private@example.org'));
    assert.deepEqual(planned.preview.rulesApplied, [
      {
        id: 'public-contact',
        action: 'allow',
        persistence: 'saved',
        occurrences: 1,
      },
    ]);
    assert.equal(planned.preview.unclassifiedDisclosurePossible, false);
  } finally {
    disposePrivacySession(planned.session);
  }

  const outOfScope = planPrivacySubmission(
    { email: 'contact@example.org' },
    settings('balanced', [
      { ...publicEmail, scope: { ...scope, sourceId: 'other' } },
    ]),
    scope,
  );
  try {
    assert(!JSON.stringify(outOfScope.payload).includes('contact@example.org'));
  } finally {
    disposePrivacySession(outOfScope.session);
  }
});

test('permissive is explicit, sends unclassified noncredentials, and still removes credentials', () => {
  assert.throws(
    () =>
      validatePrivacyPreferences({
        schemaVersion: 1,
        level: 'permissive',
        rules: [],
      }),
    /Invalid privacy preferences/,
  );
  const planned = planPrivacySubmission(
    { email: 'uncertain@example.org', password: 'synthetic-secret' },
    settings('permissive'),
    scope,
  );
  try {
    const text = JSON.stringify(planned.payload);
    assert(text.includes('uncertain@example.org'));
    assert(!text.includes('synthetic-secret'));
    assert.equal(planned.preview.unclassifiedDisclosurePossible, true);
    assert(planned.preview.masked.CREDENTIAL);
  } finally {
    disposePrivacySession(planned.session);
  }
});

test('automatic allow cannot override credentials, explicit denials, or prior session redaction', () => {
  const credential = mask(
    { note: 'Authorization: Basic YWxpY2U6cGFzcw==' },
    { allowedLiterals: ['YWxpY2U6cGFzcw=='], detect: false },
  );
  try {
    assert(!JSON.stringify(credential.payload).includes('YWxpY2U6cGFzcw=='));
  } finally {
    disposePrivacySession(credential.session);
  }

  const denied = mask(
    { email: 'contact@example.org' },
    {
      allowedLiterals: ['contact@example.org'],
      literals: [
        { value: 'contact@example.org', kind: 'EMAIL', restore: false },
      ],
    },
  );
  try {
    assert(!JSON.stringify(denied.payload).includes('contact@example.org'));
  } finally {
    disposePrivacySession(denied.session);
  }

  const credentialField = mask(
    { password: 'synthetic-secret' },
    { allowedLiterals: ['synthetic-secret'], detect: false },
  );
  try {
    assert(
      !JSON.stringify(credentialField.payload).includes('synthetic-secret'),
    );
    assert(credentialField.counts.CREDENTIAL);
  } finally {
    disposePrivacySession(credentialField.session);
  }

  const first = mask({ password: 'synthetic-secret' }, { detect: false });
  try {
    const later = mask(
      { note: 'synthetic-secret' },
      { allowedLiterals: ['synthetic-secret'], detect: false },
      [first.session],
    );
    try {
      assert(!JSON.stringify(later.payload).includes('synthetic-secret'));
    } finally {
      disposePrivacySession(later.session);
    }
  } finally {
    disposePrivacySession(first.session);
  }
});

test('substitution cannot erase credentials or application-declared private literals', () => {
  const credentialRule: PrivacyRule = {
    id: 'misclassified-credential',
    scope,
    persistence: 'submission',
    category: 'ADDRESS',
    value: 'YWxpY2U6cGFzcw==',
    action: 'substitute',
    substitute: 'public label',
  };
  const credentialPlan = planPrivacySubmission(
    { note: 'Authorization: Basic YWxpY2U6cGFzcw==' },
    settings('permissive', [credentialRule]),
    scope,
  );
  try {
    assert(
      !JSON.stringify(credentialPlan.payload).includes('YWxpY2U6cGFzcw=='),
    );
    assert(!JSON.stringify(credentialPlan.payload).includes('public label'));
    assert(credentialPlan.preview.masked.CREDENTIAL);
  } finally {
    disposePrivacySession(credentialPlan.session);
  }

  const explicitPlan = planPrivacySubmission(
    { address: '123 Synthetic Lane' },
    settings('balanced', [addressZone]),
    scope,
    {
      literals: [
        { value: '123 Synthetic Lane', kind: 'ADDRESS', restore: false },
      ],
    },
  );
  try {
    assert(
      !JSON.stringify(explicitPlan.payload).includes('123 Synthetic Lane'),
    );
    assert(!JSON.stringify(explicitPlan.payload).includes('service zone 7'));
    assert(explicitPlan.preview.masked.ADDRESS);
  } finally {
    disposePrivacySession(explicitPlan.session);
  }
});

test('invalid public claims, conflicting rules, and unsafe substitutes refuse locally', () => {
  assert.throws(
    () =>
      validatePrivacyPreferences(
        settings('balanced', [
          {
            id: 'unverified-public',
            scope,
            persistence: 'saved',
            category: 'EMAIL',
            value: 'contact@example.org',
            action: 'allow',
            basis: 'verified-public',
          },
        ]),
      ),
    /authorization basis/,
  );
  assert.throws(
    () =>
      planPrivacySubmission(
        'contact@example.org',
        settings('balanced', [
          publicEmail,
          {
            id: 'duplicate-value',
            scope,
            persistence: 'saved',
            category: 'EMAIL',
            value: 'contact@example.org',
            action: 'substitute',
            substitute: 'safe',
          },
        ]),
        scope,
      ),
    /Conflicting privacy rules/,
  );
  assert.throws(
    () =>
      validatePrivacyPreferences(
        settings('balanced', [
          { ...addressZone, substitute: '123 Synthetic Lane' },
        ]),
      ),
    /deterministic privacy substitute/,
  );
});

test('repeated one-time approval offers a saved rule and honors the answer', () => {
  const first = recordPrivacyOverride(settings('balanced'), oneTimeContact);
  assert.equal(first.offer, null);
  assert(!JSON.stringify(first.preferences).includes('contact@example.org'));
  assert.equal(
    resolvePrivacyOverride(first.preferences, oneTimeContact, 'save').rules[0]
      .persistence,
    'saved',
  );
  const second = recordPrivacyOverride(first.preferences, oneTimeContact);
  assert.deepEqual(second.offer, {
    ruleId: oneTimeContact.id,
    approvalCount: 2,
  });
  const later = resolvePrivacyOverride(
    second.preferences,
    oneTimeContact,
    'not-now',
  );
  let state = later;
  for (let approval = 3; approval < 5; approval++) {
    const result = recordPrivacyOverride(state, oneTimeContact);
    assert.equal(result.offer, null);
    state = result.preferences;
  }
  const fifth = recordPrivacyOverride(state, oneTimeContact);
  assert.equal(fifth.offer?.approvalCount, 5);
  const saved = resolvePrivacyOverride(
    fifth.preferences,
    oneTimeContact,
    'save',
  );
  assert.equal(saved.rules.length, 1);
  assert.equal(saved.rules[0].persistence, 'saved');
  const planned = planPrivacySubmission(
    { email: 'contact@example.org' },
    saved,
    scope,
  );
  try {
    assert(JSON.stringify(planned.payload).includes('contact@example.org'));
  } finally {
    disposePrivacySession(planned.session);
  }
  const strict = planPrivacySubmission(
    { email: 'contact@example.org' },
    { ...saved, level: 'strict' },
    scope,
  );
  try {
    assert(JSON.stringify(strict.payload).includes('contact@example.org'));
  } finally {
    disposePrivacySession(strict.session);
  }
  assert.equal(recordPrivacyOverride(saved, oneTimeContact).offer, null);
});

test('never-suggest suppresses future save offers for one exact scoped value', () => {
  const first = recordPrivacyOverride(settings('balanced'), oneTimeContact);
  const second = recordPrivacyOverride(first.preferences, oneTimeContact);
  const declined = resolvePrivacyOverride(
    second.preferences,
    oneTimeContact,
    'never-suggest',
  );
  let state = declined;
  for (let count = 0; count < 8; count++) {
    const result = recordPrivacyOverride(state, oneTimeContact);
    assert.equal(result.offer, null);
    state = result.preferences;
  }
  assert.equal(state.rules.length, 0);
  const anotherScope = recordPrivacyOverride(state, {
    ...oneTimeContact,
    scope: { workspaceId: 'another-workspace' },
  });
  assert.equal(anotherScope.offer, null);
  const repeatedElsewhere = recordPrivacyOverride(anotherScope.preferences, {
    ...oneTimeContact,
    scope: { workspaceId: 'another-workspace' },
  });
  assert.equal(repeatedElsewhere.offer?.approvalCount, 2);
});

test(
  'saved rules reload locally, submission-only decisions cannot persist, and symlinks refuse',
  {
    skip: process.platform === 'win32',
  },
  async (t) => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'temari-privacy-rules-')),
    );
    t.after(() => rm(root, { recursive: true, force: true }));
    const path = join(root, 'settings.json');
    const saved = settings('balanced', [publicEmail, addressZone]);
    await savePrivacyPreferences(path, saved);
    assert.deepEqual(await loadPrivacyPreferences(path), saved);
    assert.equal((await stat(path)).mode & 0o077, 0);
    const oneTime = {
      ...oneTimeContact,
      value: 'one-time@example.org',
    };
    const firstApproval = recordPrivacyOverride(saved, oneTime);
    await savePrivacyPreferences(path, firstApproval.preferences);
    assert.deepEqual(
      await loadPrivacyPreferences(path),
      firstApproval.preferences,
    );
    assert(!(await readFile(path, 'utf8')).includes('one-time@example.org'));
    const secondApproval = recordPrivacyOverride(
      await loadPrivacyPreferences(path),
      oneTime,
    );
    assert.equal(secondApproval.offer?.approvalCount, 2);
    const promoted = resolvePrivacyOverride(
      secondApproval.preferences,
      oneTime,
      'save',
    );
    await savePrivacyPreferences(path, promoted);
    const reloaded = await loadPrivacyPreferences(path);
    assert(
      reloaded.rules.some((rule) => rule.value === 'one-time@example.org'),
    );
    const declinedRule = { ...oneTime, value: 'declined@example.org' };
    const declinedFirst = recordPrivacyOverride(reloaded, declinedRule);
    const declinedSecond = recordPrivacyOverride(
      declinedFirst.preferences,
      declinedRule,
    );
    const neverSuggest = resolvePrivacyOverride(
      declinedSecond.preferences,
      declinedRule,
      'never-suggest',
    );
    await savePrivacyPreferences(path, neverSuggest);
    const afterRestart = recordPrivacyOverride(
      await loadPrivacyPreferences(path),
      declinedRule,
    );
    assert.equal(afterRestart.offer, null);
    await savePrivacyPreferences(path, saved);
    const bytes = await readFile(path, 'utf8');
    assert(!bytes.includes('synthetic-secret'));
    await assert.rejects(
      savePrivacyPreferences(
        path,
        settings('balanced', [{ ...publicEmail, persistence: 'submission' }]),
      ),
      /cannot be saved/,
    );
    assert.equal(await readFile(path, 'utf8'), bytes);
    const link = join(root, 'link.json');
    await symlink(path, link);
    await assert.rejects(loadPrivacyPreferences(link), /private and regular/);
    await assert.rejects(
      savePrivacyPreferences(link, saved),
      /private and regular/,
    );
    await writeFile(join(root, 'loose.json'), bytes, { mode: 0o644 });
    await assert.rejects(
      loadPrivacyPreferences(join(root, 'loose.json')),
      /private and regular/,
    );
    const malformed = join(root, 'malformed.json');
    await writeFile(malformed, '{"private":"synthetic-secret",', {
      mode: 0o600,
    });
    await assert.rejects(
      loadPrivacyPreferences(malformed),
      (error: Error) =>
        error.message === 'Invalid local privacy settings file.' &&
        !error.message.includes('synthetic-secret'),
    );
  },
);
