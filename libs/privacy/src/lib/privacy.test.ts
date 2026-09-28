import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertJsonValue,
  disposePrivacySession,
  mask,
  PrivacyError,
  restoreForDisplay,
  type JsonValue,
  type PrivacyPolicy,
  type PrivacySession,
} from './privacy.js';

function isObject(
  value: JsonValue,
): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

test('masks explicit identities while preserving enough structure for the model', () => {
  const result = mask(
    {
      prompt: 'Review the account for Alice Example at alice@example.test.',
      customer: {
        name: 'Alice Example',
        email: 'alice@example.test',
        id: 'acct-42',
      },
    },
    {
      literals: [
        { value: 'Alice Example', kind: 'PERSON' },
        { value: 'acct-42', kind: 'ACCOUNT' },
      ],
    },
  );
  const payload = result.payload;
  if (!isObject(payload)) throw new Error('Expected an object payload');
  const customer = payload.customer;
  if (!isObject(customer)) throw new Error('Expected a customer object');

  assert.match(
    String(customer.id),
    new RegExp(
      `^\\[\\[TM_PRIVACY_${result.session.requestId}_ACCOUNT_\\d+\\]\\]$`,
    ),
  );
  assert(!JSON.stringify(result.payload).includes('Alice Example'));
  assert(!JSON.stringify(result.payload).includes('alice@example.test'));
  assert(!JSON.stringify(result.session).includes('Alice Example'));
  assert(!JSON.stringify(result.session).includes('alice@example.test'));
  assert.equal(result.counts.PERSON, 2);
  const prompt = payload.prompt;
  assert.equal(typeof prompt, 'string');
  assert.deepEqual(restoreForDisplay({ answer: prompt }, result.session), {
    answer: 'Review the account for Alice Example at alice@example.test.',
  });
});

test('removes credentials instead of retaining them in the restoration map', () => {
  const result = mask({
    headers: { authorization: 'Bearer secret-token' },
    password: 'pw-123',
  });
  assert(!JSON.stringify(result.payload).includes('secret-token'));
  assert(!JSON.stringify(result.session).includes('secret-token'));
  assert.deepEqual(restoreForDisplay(result.payload, result.session), {
    headers: { authorization: '[CREDENTIAL_REMOVED]' },
    password: '[CREDENTIAL_REMOVED]',
  });
});

test('supports explicit field policies for private identifiers that detectors cannot infer', () => {
  const result = mask(
    { accountId: 'internal-001', notes: 'The account is internal-001.' },
    { fields: [{ path: '/accountId', kind: 'ACCOUNT' }] },
  );
  assert(!JSON.stringify(result.payload).includes('internal-001'));
  assert.deepEqual(restoreForDisplay(result.payload, result.session), {
    accountId: 'internal-001',
    notes: 'The account is internal-001.',
  });
});

test('fails closed for foreign or malformed placeholders', () => {
  const result = mask(
    { name: 'Alice Example' },
    { literals: [{ value: 'Alice Example', kind: 'PERSON' }] },
  );
  assert.throws(
    () =>
      restoreForDisplay(
        '[[TM_PRIVACY_00000000-0000-0000-0000-000000000000_PERSON_1]]',
        result.session,
      ),
    PrivacyError,
  );
  assert.throws(
    () => restoreForDisplay('[[TM_PRIVACY_not-a-token]]', result.session),
    PrivacyError,
  );
});

test('rejects policies that request credential restoration', () => {
  assert.throws(
    () =>
      mask(
        { token: 'secret' },
        { literals: [{ value: 'secret', kind: 'CREDENTIAL', restore: true }] },
      ),
    PrivacyError,
  );
});

function assertAbsent(value: JsonValue, secret: string): void {
  const serialized = JSON.stringify(value);
  assert(!serialized.includes(secret), 'Raw synthetic canary leaked');
  assert(
    !serialized.includes(JSON.stringify(secret).slice(1, -1)),
    'Serialized synthetic canary leaked',
  );
}

test('credential syntax masks bare repeats before and after declarations, including keys', () => {
  const cases = [
    ['CANARY_password_49', 'password=CANARY_password_49'],
    ['CANARY with spaces 49', "passwd='CANARY with spaces 49'"],
    ['CANARY_api_key_49', '"apiKey":"CANARY_api_key_49"'],
    ['CANARY_refresh_49', 'refresh-token = "CANARY_refresh_49"'],
    ['CANARY_id_49', 'id_token: CANARY_id_49'],
    ['CANARY_bearer_49==', 'Bearer CANARY_bearer_49=='],
    [
      'CANARY-"quoted"-49\\tail',
      `password=${JSON.stringify('CANARY-"quoted"-49\\tail')}`,
    ],
    ['canary@example.test', 'password=canary@example.test'],
  ];
  for (const [secret, declaration] of cases) {
    const result = mask({
      before: secret,
      [secret]: { declaration, after: `echo ${secret} again` },
    });
    assertAbsent(result.payload, secret);
    assertAbsent(restoreForDisplay(result.payload, result.session), secret);
    assertAbsent(
      JSON.parse(JSON.stringify(result.session)) as JsonValue,
      secret,
    );
    const roundTrip: JsonValue = JSON.parse(JSON.stringify(result.payload));
    assertAbsent(restoreForDisplay(roundTrip, result.session), secret);
  }
});

test('credential fields extract bearer secrets even with automatic detection disabled', () => {
  const secret = 'CANARY_field_bearer_73';
  const result = mask(
    {
      before: secret,
      headers: { authorization: `Bearer ${secret}` },
      password: `password="${secret}"`,
    },
    { detect: false, fieldDefaults: false },
  );
  assertAbsent(result.payload, secret);
  assertAbsent(restoreForDisplay(result.payload, result.session), secret);
});

test('credential priority dominates explicit identities, fields, and overlapping matches', () => {
  const secret = 'CANARY_overlap_78';
  const identity = `prefix ${secret} suffix`;
  const policies: PrivacyPolicy[] = [
    { literals: [{ value: identity, kind: 'PERSON' }] },
    { literals: [{ value: secret, kind: 'EMAIL', restore: false }] },
    { fields: [{ path: '/password', kind: 'PERSON', restore: true }] },
    { fields: [{ path: '/wrapper', kind: 'PRIVATE', restore: false }] },
  ];
  for (const policy of policies) {
    for (const payload of [
      { before: identity, password: secret, wrapper: { token: secret } },
      { wrapper: { token: secret }, password: secret, before: identity },
    ]) {
      const result = mask(payload, policy);
      assertAbsent(result.payload, secret);
      const restored = restoreForDisplay(result.payload, result.session);
      assertAbsent(restored, secret);
      assert.match(JSON.stringify(restored), /CREDENTIAL_REMOVED/);
    }
  }
  const result = mask('abcde', {
    detect: false,
    literals: [
      { value: 'abcde', restore: true },
      { value: 'abcd', restore: true },
      { value: 'bcde', kind: 'CREDENTIAL' },
    ],
  });
  assert.equal(
    restoreForDisplay(result.payload, result.session),
    '[CREDENTIAL_REMOVED]',
  );
});

test('overlapping occurrences and scalar spellings cannot leave credential tails', () => {
  const result = mask({
    text: 'aaaaa',
    password: 'aaa',
    number: 784321,
    other: '784321',
    secret: 784321,
    flag: true,
    token: 'true',
  });
  assertAbsent(result.payload, 'aaa');
  assertAbsent(result.payload, '784321');
  const restored = restoreForDisplay(result.payload, result.session);
  assert(isObject(restored));
  assert.equal(restored.text, '[CREDENTIAL_REMOVED]');
  assert.equal(restored.number, '[CREDENTIAL_REMOVED]');
  assert.equal(restored.flag, '[CREDENTIAL_REMOVED]');
});

test('nested credential keys and escaped or wildcard field paths propagate to repeats', () => {
  const secret = 'CANARY_key_63';
  const result = mask(
    {
      before: secret,
      credentials: { [secret]: 'CANARY_value_63' },
      'a/b': [{ '~id': 'CANARY_account_63' }],
      echoes: ['CANARY_value_63', 'CANARY_account_63'],
    },
    { fields: [{ path: '/a~1b/*/~0id', kind: 'ACCOUNT' }] },
  );
  for (const canary of [secret, 'CANARY_value_63', 'CANARY_account_63'])
    assertAbsent(result.payload, canary);
  const restored = restoreForDisplay(result.payload, result.session);
  assertAbsent(restored, secret);
  assertAbsent(restored, 'CANARY_value_63');
  assert(JSON.stringify(restored).includes('CANARY_account_63'));
});

test('all matching field rules apply non-restoration regardless of order', () => {
  const fields = [
    { path: '/items/*/id', restore: true },
    { path: '/items/0/id', restore: false },
  ];
  for (const rules of [fields, [...fields].reverse()]) {
    const result = mask(
      { items: [{ id: 'CANARY_policy_54' }] },
      { fields: rules },
    );
    assert.deepEqual(restoreForDisplay(result.payload, result.session), {
      items: [{ id: '[PRIVATE_REMOVED]' }],
    });
  }
});

test('plain JSON round-trips prototype names safely through serialization', () => {
  const payload: JsonValue = JSON.parse(
    '{"__proto__":{"polluted":"safe"},"constructor":"value","toString":"text","hasOwnProperty":true,"toJSON":"data"}',
  );
  const result = mask(payload, { detect: false, fieldDefaults: false });
  assert.deepEqual(result.payload, payload);
  assert.equal(Object.getPrototypeOf(result.payload), Object.prototype);
  assert.equal(Object.hasOwn(result.payload as object, '__proto__'), true);
  assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false);
  assert.deepEqual(JSON.parse(JSON.stringify(result.payload)), payload);
  assert.deepEqual(restoreForDisplay(result.payload, result.session), payload);
  const hiddenKeys = mask(payload, {
    literals: [{ value: '__proto__' }, { value: 'constructor' }],
  });
  assert.deepEqual(
    restoreForDisplay(hiddenKeys.payload, hiddenKeys.session),
    payload,
  );
  const nullPrototype: Record<string, JsonValue> = Object.create(null);
  nullPrototype['__proto__'] = 'own data';
  assert.deepEqual(
    mask(nullPrototype).payload,
    JSON.parse('{"__proto__":"own data"}'),
  );
});

test('restoration rejects duplicate keys instead of overwriting them', () => {
  const result = mask('CANARY_duplicate_81', {
    literals: [{ value: 'CANARY_duplicate_81' }],
  });
  assert.equal(typeof result.payload, 'string');
  assert.throws(
    () =>
      restoreForDisplay(
        {
          [String(result.payload)]: 1,
          CANARY_duplicate_81: 2,
        },
        result.session,
      ),
    PrivacyError,
  );
  const credentials = mask({
    password: 'CANARY_one_81',
    token: 'CANARY_two_81',
  });
  const credentialPayload = credentials.payload;
  assert(isObject(credentialPayload));
  assert.throws(
    () =>
      restoreForDisplay(
        {
          [String(credentialPayload.password)]: 1,
          [String(credentialPayload.token)]: 2,
        },
        credentials.session,
      ),
    PrivacyError,
  );
});

test('valid scalars retain their types, input ownership, and opaque session serialization', () => {
  const input = Object.freeze({
    number: 42,
    flag: false,
    nested: Object.freeze(['CANARY_scalar_72', null]),
  });
  const result = mask(input, {
    literals: [{ value: 42 }, { value: false }, { value: 'CANARY_scalar_72' }],
  });
  assert.deepEqual(
    restoreForDisplay(
      JSON.parse(JSON.stringify(result.payload)),
      result.session,
    ),
    input,
  );
  assert.equal(input.nested[0], 'CANARY_scalar_72');
  assert.notEqual(result.payload, input);
  assert.deepEqual(Object.keys(result.session), ['requestId']);
  assert(Object.isFrozen(result.session));
  const clonedSession = JSON.parse(
    JSON.stringify(result.session),
  ) as PrivacySession;
  assert.throws(
    () => restoreForDisplay(result.payload, clonedSession),
    PrivacyError,
  );
});

test('invalid JSON fails without invoking getters, proxies, or toJSON', () => {
  let calls = 0;
  const getter = Object.defineProperty({}, 'secret', {
    enumerable: true,
    get() {
      calls += 1;
      return 'CANARY_getter_21';
    },
  });
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        calls += 1;
        return [];
      },
      getPrototypeOf() {
        calls += 1;
        return Object.prototype;
      },
    },
  );
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const arrayCycle: unknown[] = [];
  arrayCycle.push(arrayCycle);
  const accessorArray = Object.defineProperty([], '0', {
    enumerable: true,
    get() {
      calls += 1;
      return 'CANARY_array_getter_21';
    },
  });
  const invalid: unknown[] = [
    undefined,
    NaN,
    Infinity,
    -Infinity,
    1n,
    Symbol('canary'),
    () => 1,
    new Date(),
    new Map(),
    new Set(),
    /pattern/,
    new Uint8Array([1]),
    new String('canary'),
    Object.create({ inherited: 'canary' }),
    {
      toJSON() {
        calls += 1;
        return 'CANARY_toJSON_21';
      },
    },
    { nested: undefined },
    { nested: NaN },
    { nested: cycle },
    arrayCycle,
    [undefined],
    new Array(2),
    Object.assign([], { extra: 'canary' }),
    { [Symbol('canary')]: 'hidden' },
    Object.defineProperty({}, 'hidden', { value: 'canary' }),
    getter,
    accessorArray,
    proxy,
    revoked.proxy,
  ];
  let tooDeep: unknown = 'leaf';
  for (let i = 0; i < 300; i += 1) tooDeep = [tooDeep];
  invalid.push(tooDeep);
  const session = mask('safe').session;
  for (const value of invalid) {
    assert.throws(() => assertJsonValue(value), PrivacyError);
    assert.throws(() => mask(value as JsonValue), PrivacyError);
    assert.throws(
      () => restoreForDisplay(value as JsonValue, session),
      PrivacyError,
    );
  }
  assert.equal(calls, 0);
  const shared = { text: 'safe' };
  assertJsonValue([shared, shared]);
  assert.deepEqual(mask([shared, shared]).payload, [shared, shared]);
});

test('runtime policy validation rejects malformed options and rules without executing code', () => {
  let calls = 0;
  const invalid: unknown[] = [
    null,
    false,
    'policy',
    [],
    new Date(),
    { unknown: true },
    { detect: null },
    { detect: 'false' },
    { detect: 0 },
    { fieldDefaults: null },
    { fieldDefaults: 1 },
    { literals: null },
    { literals: false },
    { fields: 0 },
    { fields: {} },
    { fields: [null] },
    { fields: ['path'] },
    { fields: [{ path: 1 }] },
    { fields: [{ path: 'id' }] },
    { fields: [{ path: '/bad~2path' }] },
    { fields: [{ path: '/id', unknown: true }] },
    { fields: [{ path: '/id', restore: null }] },
    { fields: [{ path: '/id', restore: 'false' }] },
    { fields: [{ path: '/id', kind: 'CREDENTIAL' }] },
    { fields: [{ path: '/id', kind: null }] },
    { literals: [null] },
    { literals: [{ value: '' }] },
    { literals: [{ value: null }] },
    { literals: [{ value: NaN }] },
    { literals: [{ value: Infinity }] },
    { literals: [{ value: -Infinity }] },
    { literals: [{ value: 'canary', kind: null }] },
    { literals: [{ value: 'canary', kind: 'UNSUPPORTED' }] },
    { literals: [{ value: 'canary', restore: 'false' }] },
    { literals: [{ value: 'canary', restore: null }] },
    { literals: [{ value: 'canary', unknown: true }] },
    { literals: new Array(1) },
    { fields: new Array(1) },
    Object.create({ detect: false }),
    { [Symbol('unknown')]: false },
    Object.defineProperty({}, 'detect', { value: false }),
    {
      get detect() {
        calls += 1;
        return false;
      },
    },
    {
      literals: [
        {
          get value() {
            calls += 1;
            return 'canary';
          },
        },
      ],
    },
  ];
  for (const policy of invalid)
    assert.throws(() => mask('safe', policy as PrivacyPolicy), PrivacyError);
  assert.equal(calls, 0);
  assert.equal(
    mask('alice@example.test', { detect: false, fieldDefaults: false }).payload,
    'alice@example.test',
  );
});

test('unknown and malformed placeholders fail closed in payloads, keys, and responses', () => {
  const session = mask('safe').session;
  const foreign = mask('CANARY_foreign_32', {
    literals: [{ value: 'CANARY_foreign_32' }],
  }).payload;
  const tokens = [
    String(foreign),
    '[[TM_PRIVACY_broken]]',
    '[[TM_PRIVACY_',
    '[[TM_PRIVACY_]]',
    '[[TM_PRIVACY_00000000-0000-0000-0000-000000000000_PERSON_1]]',
  ];
  for (const token of tokens) {
    for (const payload of [
      token,
      [token],
      { [token]: 'safe' },
      `prefix ${token} suffix`,
    ]) {
      assert.throws(() => mask(payload), PrivacyError);
      assert.throws(() => restoreForDisplay(payload, session), PrivacyError);
    }
  }
});

test('multiple session scopes restore nested tokens in a single strict pass', () => {
  const first = mask('CANARY_first_31', {
    literals: [{ value: 'CANARY_first_31' }],
  });
  const second = mask(64, { literals: [{ value: 64 }] });
  const response = {
    [String(first.payload)]: [
      second.payload,
      `${first.payload}: ${second.payload}`,
    ],
  };
  assert.deepEqual(
    restoreForDisplay(response, [first.session, second.session]),
    {
      CANARY_first_31: [64, 'CANARY_first_31: 64'],
    },
  );
  assert.throws(
    () => restoreForDisplay(response, [first.session]),
    PrivacyError,
  );
  assert.throws(
    () =>
      restoreForDisplay(`${first.payload} [[TM_PRIVACY_broken]]`, [
        first.session,
        second.session,
      ]),
    PrivacyError,
  );
  assert.equal(
    restoreForDisplay(first.payload, [first.session, first.session]),
    'CANARY_first_31',
  );
  assert.equal(restoreForDisplay('safe', []), 'safe');
});

test('disposed sessions are unusable and disposal is idempotent', () => {
  const first = mask('CANARY_dispose_61', {
    literals: [{ value: 'CANARY_dispose_61' }],
  });
  const second = mask('safe');
  disposePrivacySession(first.session);
  disposePrivacySession(first.session);
  assert.throws(
    () => restoreForDisplay(first.payload, first.session),
    PrivacyError,
  );
  assert.throws(
    () => restoreForDisplay('safe', [first.session, second.session]),
    PrivacyError,
  );
  assert.throws(() => mask(first.payload, {}, [first.session]), PrivacyError);
  assert.equal(restoreForDisplay('safe', second.session), 'safe');
  for (const invalid of [null, undefined, {}, [null], new Array(1)])
    assert.throws(
      () => restoreForDisplay('safe', invalid as PrivacySession),
      PrivacyError,
    );
});

test('trusted placeholders pass through unchanged even under single-digit literal policies', () => {
  const policy: PrivacyPolicy = {
    literals: [{ value: 1, kind: 'ACCOUNT' }, { value: 'CANARY_trusted_51' }],
  };
  const first = mask('CANARY_trusted_51', policy);
  const second = mask(
    {
      [String(first.payload)]: first.payload,
      text: `${first.payload} and 1`,
      id: 1,
    },
    policy,
    [first.session],
  );
  assert(isObject(second.payload));
  assert.equal(second.payload[String(first.payload)], first.payload);
  assert(String(second.payload.text).startsWith(`${first.payload} and `));
  assert.deepEqual(restoreForDisplay(second.payload, second.session), {
    CANARY_trusted_51: 'CANARY_trusted_51',
    text: 'CANARY_trusted_51 and 1',
    id: 1,
  });
  assert.deepEqual(
    restoreForDisplay(second.payload, [first.session, second.session]),
    restoreForDisplay(second.payload, second.session),
  );
  assert.throws(() => mask(first.payload, policy), PrivacyError);
  assert.throws(
    () =>
      mask(`${first.payload} [[TM_PRIVACY_broken]]`, policy, [first.session]),
    PrivacyError,
  );
  assert.throws(
    () => mask('safe', policy, first.session as unknown as PrivacySession[]),
    PrivacyError,
  );
});

test('trusted scope credential revocation is monotonic across old handles and aliases', () => {
  for (const context of ['field', 'bearer', 'assignment', 'raw'] as const) {
    const secret = 'CANARY_revocation_91';
    const policy: PrivacyPolicy = {
      literals: [{ value: secret, kind: 'PERSON' }],
    };
    const first = mask(secret, policy);
    const alias = mask(`prefix ${secret} suffix`, {
      literals: [{ value: `prefix ${secret} suffix`, kind: 'PERSON' }],
    });
    const payload: JsonValue =
      context === 'field'
        ? { password: first.payload }
        : context === 'bearer'
          ? { message: `Bearer ${first.payload}` }
          : context === 'assignment'
            ? { message: `password=${first.payload}` }
            : { password: secret, echo: first.payload };
    const later = mask(
      { payload, alias: alias.payload, rawEcho: secret },
      policy,
      [first.session, alias.session],
    );
    assertAbsent(later.payload, secret);
    for (const session of [first.session, later.session])
      assert.equal(
        restoreForDisplay(first.payload, session),
        '[CREDENTIAL_REMOVED]',
      );
    assert.equal(
      restoreForDisplay(alias.payload, alias.session),
      '[CREDENTIAL_REMOVED]',
    );
    assertAbsent(
      restoreForDisplay(later.payload, [
        first.session,
        alias.session,
        later.session,
      ]),
      secret,
    );
    const last = mask(first.payload, {}, [later.session]);
    assert.equal(last.payload, first.payload);
    assert.equal(
      restoreForDisplay(last.payload, last.session),
      '[CREDENTIAL_REMOVED]',
    );
  }
});

test('failed masking does not mutate trusted restoration capabilities', () => {
  const first = mask('CANARY_atomic_61', {
    literals: [{ value: 'CANARY_atomic_61' }],
  });
  assert.throws(
    () =>
      mask(
        {
          password: first.payload,
          malformed: '[[TM_PRIVACY_broken]]',
        },
        {},
        [first.session],
      ),
    PrivacyError,
  );
  assert.equal(
    restoreForDisplay(first.payload, first.session),
    'CANARY_atomic_61',
  );
});

test('serialized schemas preserve structural braces and brackets around credential field definitions', () => {
  const schema = {
    type: 'object',
    properties: {
      email: { type: 'string' },
      password: { type: 'string' },
      token: { type: 'array', items: { type: 'string' } },
    },
    examples: [{ password: {}, token: [] }],
  };
  assertJsonValue(schema);
  const schemaText = JSON.stringify(schema);
  const result = mask({ schemaText });
  assert.deepEqual(result.payload, { schemaText });
  assert(isObject(result.payload));
  assert.deepEqual(JSON.parse(String(result.payload.schemaText)), schema);
  const data = { password: 'CANARY_schema_scalar_81', nested: { token: [] } };
  const scalar = mask({ text: JSON.stringify(data), echo: data.password });
  assertAbsent(scalar.payload, data.password);
  assert(isObject(scalar.payload));
  const parsed: unknown = JSON.parse(String(scalar.payload.text));
  assertJsonValue(parsed);
  assertAbsent(parsed, data.password);
  assertAbsent(
    restoreForDisplay(scalar.payload, scalar.session),
    data.password,
  );
});

test('trusted field names keep their privacy semantics and retained identities mask later repeats', () => {
  const first = mask(
    { email: 'canary-repeated@example.test', name: 'CANARY_repeat_51' },
    {
      fields: [{ path: '/name', kind: 'PERSON' }],
    },
  );
  const later = mask('CANARY_repeat_51', {}, [first.session]);
  assertAbsent(later.payload, 'CANARY_repeat_51');
  assert.equal(
    restoreForDisplay(later.payload, later.session),
    'CANARY_repeat_51',
  );

  const key = mask('password', { literals: [{ value: 'password' }] });
  const credential = mask(
    {
      [String(key.payload)]: 'CANARY_masked_key_85',
      echo: 'CANARY_masked_key_85',
    },
    {},
    [key.session],
  );
  assertAbsent(credential.payload, 'CANARY_masked_key_85');
  assertAbsent(
    restoreForDisplay(credential.payload, credential.session),
    'CANARY_masked_key_85',
  );
});

test('credential literals extract wrapped bare secrets when detection is disabled', () => {
  const result = mask('CANARY_literal_39', {
    detect: false,
    literals: [{ value: 'Bearer CANARY_literal_39', kind: 'CREDENTIAL' }],
  });
  assertAbsent(result.payload, 'CANARY_literal_39');
  assert.equal(
    restoreForDisplay(result.payload, result.session),
    '[CREDENTIAL_REMOVED]',
  );
});

test('discarded credentials stay redacted in subsequent batches without explicit policy', () => {
  const secret = 'CANARY_cross_batch_secret_357';
  const first = mask({ password: secret });
  const intermediate = mask('unrelated content', {}, [first.session]);
  const later = mask(
    {
      echo: `before ${secret} after`,
      nested: [{ [secret]: secret }],
    },
    {},
    [intermediate.session],
  );
  assertAbsent(later.payload, secret);
  assertAbsent(restoreForDisplay(later.payload, later.session), secret);
  assert.deepEqual(restoreForDisplay(later.payload, later.session), {
    echo: 'before [CREDENTIAL_REMOVED] after',
    nested: [{ '[CREDENTIAL_REMOVED]': '[CREDENTIAL_REMOVED]' }],
  });
  assert.deepEqual(Object.keys(later.session), ['requestId']);
  assertAbsent(JSON.parse(JSON.stringify(later.session)), secret);
  assert.equal(mask(secret).payload, secret);
  for (const result of [first, intermediate, later])
    disposePrivacySession(result.session);
});

test('credential fingerprints cover numbers, booleans, wrapped secrets, and non-restorable identities', () => {
  const first = mask(
    {
      password: 784321,
      token: true,
      authorization: 'Bearer CANARY_bare_cross_batch_73',
      note: 'CANARY_private_cross_batch_73',
    },
    { fields: [{ path: '/note', restore: false }] },
  );
  const later = mask(
    [
      784321,
      '784321',
      true,
      'true',
      'prefix CANARY_bare_cross_batch_73 suffix',
      'CANARY_private_cross_batch_73',
    ],
    { detect: false, fieldDefaults: false },
    [first.session],
  );
  assert.deepEqual(restoreForDisplay(later.payload, later.session), [
    '[CREDENTIAL_REMOVED]',
    '[CREDENTIAL_REMOVED]',
    '[CREDENTIAL_REMOVED]',
    '[CREDENTIAL_REMOVED]',
    'prefix [CREDENTIAL_REMOVED] suffix',
    '[PRIVATE_REMOVED]',
  ]);
  const numericSubstring = mask(17843219, {}, [first.session]);
  assert.equal(
    restoreForDisplay(numericSubstring.payload, numericSubstring.session),
    '[CREDENTIAL_REMOVED]',
  );
  const numericString = mask({ password: '982743' });
  const repeatedNumber = mask(982743, {}, [numericString.session]);
  assert.equal(
    restoreForDisplay(repeatedNumber.payload, repeatedNumber.session),
    '[CREDENTIAL_REMOVED]',
  );
});

test('fingerprint matches cannot revive credentials through later identity policies or older aliases', () => {
  const secret = 'CANARY_fingerprint_precedence_35';
  const identity = `prefix ${secret} suffix`;
  const alias = mask(identity, {
    literals: [{ value: identity, kind: 'PERSON' }],
  });
  const credential = mask({ password: secret });
  const later = mask(
    [alias.payload, identity],
    {
      literals: [{ value: identity, kind: 'PERSON', restore: true }],
    },
    [alias.session, credential.session],
  );
  assertAbsent(later.payload, secret);
  assert.deepEqual(restoreForDisplay(later.payload, later.session), [
    '[CREDENTIAL_REMOVED]',
    '[CREDENTIAL_REMOVED]',
  ]);
  assert.equal(
    restoreForDisplay(alias.payload, alias.session),
    '[CREDENTIAL_REMOVED]',
  );
  const revokedRaw = mask(identity, {}, [later.session]);
  assert.equal(
    restoreForDisplay(revokedRaw.payload, revokedRaw.session),
    '[CREDENTIAL_REMOVED]',
  );
});

test('fingerprint matching covers overlapping and exact UTF-16 substrings without touching issued tokens', () => {
  for (const secret of [
    'aaa',
    '🔒CANARY_非ASCII_37',
    '\ud800',
    '\0CANARY_null_37',
  ]) {
    const first = mask({ password: secret });
    const echo = secret === 'aaa' ? 'aaaaa' : `before ${secret} after`;
    const later = mask(echo, {}, [first.session]);
    assertAbsent(later.payload, secret);
    assertAbsent(restoreForDisplay(later.payload, later.session), secret);
  }
  const surrogate = mask({ password: '\ud800' });
  const different = mask('\ud801', {}, [surrogate.session]);
  assert.equal(different.payload, '\ud801');
  const digit = mask(
    { password: '1', name: 'CANARY_trusted_fingerprint_49' },
    {
      literals: [{ value: 'CANARY_trusted_fingerprint_49', kind: 'PERSON' }],
    },
  );
  assert(isObject(digit.payload));
  const next = mask([digit.payload.name, '1'], {}, [digit.session]);
  assert.deepEqual(restoreForDisplay(next.payload, next.session), [
    'CANARY_trusted_fingerprint_49',
    '[CREDENTIAL_REMOVED]',
  ]);
});

test('fingerprint knowledge persists through derived handles and ends when their handles are disposed', () => {
  const secret = 'CANARY_disposed_fingerprint_98';
  const first = mask({ password: secret });
  const second = mask('safe', {}, [first.session]);
  disposePrivacySession(first.session);
  assert.throws(() => mask(secret, {}, [first.session]), PrivacyError);
  const third = mask(secret, {}, [second.session]);
  assert.equal(
    restoreForDisplay(third.payload, third.session),
    '[CREDENTIAL_REMOVED]',
  );
  disposePrivacySession(second.session);
  disposePrivacySession(third.session);
  assert.throws(() => mask(secret, {}, [third.session]), PrivacyError);
  assert.equal(mask(secret).payload, secret);
});

test('fingerprint matching and capacity limits reject atomically instead of letting secrets through', () => {
  const first = mask({ password: 'x' });
  assert.throws(
    () => mask('a'.repeat(2 * 1024 * 1024 + 1), {}, [first.session]),
    (error: unknown) =>
      error instanceof PrivacyError && /matching limit/.test(error.message),
  );
  const tooMany = Array.from({ length: 1025 }, (_, index) => ({
    value: `CANARY_capacity_${index}`,
    kind: 'CREDENTIAL' as const,
  }));
  assert.throws(
    () => mask('safe', { literals: tooMany }, [first.session]),
    (error: unknown) =>
      error instanceof PrivacyError && /capacity/.test(error.message),
  );
  assert.equal(
    mask('CANARY_capacity_0', {}, [first.session]).payload,
    'CANARY_capacity_0',
  );
  const stillProtected = mask('x', {}, [first.session]);
  assert.equal(
    restoreForDisplay(stillProtected.payload, stillProtected.session),
    '[CREDENTIAL_REMOVED]',
  );

  const alias = mask('CANARY_atomic_fingerprint_81', {
    literals: [{ value: 'CANARY_atomic_fingerprint_81' }],
  });
  assert.throws(
    () =>
      mask({ password: alias.payload }, { literals: tooMany }, [alias.session]),
    PrivacyError,
  );
  assert.equal(
    restoreForDisplay(alias.payload, alias.session),
    'CANARY_atomic_fingerprint_81',
  );
});
