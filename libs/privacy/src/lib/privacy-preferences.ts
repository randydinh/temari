import { constants } from 'node:fs';
import { lstat, open, realpath, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import {
  assertJsonValue,
  disposePrivacySession,
  mask,
  PrivacyError,
  type JsonValue,
  type MaskedRequest,
  type PrivacyKind,
  type PrivacyPolicy,
} from './privacy.js';

export type PrivacyLevel = 'strict' | 'balanced' | 'permissive';
type PrivateKind = Exclude<PrivacyKind, 'CREDENTIAL'>;
type Literal = string | number | boolean;

export type PrivacyRule = {
  readonly id: string;
  readonly scope: { readonly workspaceId: string; readonly sourceId?: string };
  readonly persistence: 'submission' | 'saved';
  readonly category: PrivateKind;
  readonly value: Literal;
  readonly action: 'allow' | 'substitute';
  /** A verified-public claim needs a local evidence reference; it is not inferred. */
  readonly basis?: 'verified-public' | 'user-authorized';
  readonly evidenceRef?: string;
  /** A deterministic local substitute. It is masked again before model egress. */
  readonly substitute?: Literal;
};

export type PrivacyPreferences = {
  readonly schemaVersion: 1;
  readonly level: PrivacyLevel;
  /** Required once when the user selects the broad disclosure setting. */
  readonly permissiveAcknowledged?: true;
  readonly rules: readonly PrivacyRule[];
  /** Opaque local memory of repeated one-submission approvals. */
  readonly approvalMemory?: PrivacyApprovalMemory;
  /** Explicit user decisions used only for local group suggestions. */
  readonly learningMemory?: PrivacyLearningMemory;
};

export type PrivacyApprovalMemory = {
  readonly key: string;
  readonly entries: readonly {
    readonly fingerprint: string;
    readonly count: number;
    /** Null means the user chose not to see this suggestion again. */
    readonly nextOfferAt: number | null;
  }[];
};

export type PrivacyLearningMemory = {
  readonly key: string;
  readonly events: readonly {
    readonly id: string;
    readonly scope: { readonly workspaceId: string; readonly sourceId: string };
    readonly category: PrivateKind;
    readonly decision: 'allow' | 'mask';
    readonly fingerprint: string;
  }[];
  readonly suppressedProposalIds: readonly string[];
};

export type PrivacyPersistenceOffer = {
  readonly ruleId: string;
  readonly approvalCount: number;
};

export type PrivacyPersistenceChoice = 'save' | 'not-now' | 'never-suggest';

export type PrivacyScope = {
  readonly workspaceId: string;
  readonly sourceId?: string;
};

export type PrivacyDecisionPreview = {
  readonly level: PrivacyLevel;
  readonly masked: MaskedRequest['counts'];
  readonly rulesApplied: readonly {
    readonly id: string;
    readonly action: PrivacyRule['action'];
    readonly persistence: PrivacyRule['persistence'];
    readonly occurrences: number;
  }[];
  readonly possibleImpact: readonly (
    | 'identity-matching'
    | 'location-reasoning'
    | 'exact-value-validation'
    | 'network-context'
  )[];
  /** The user explicitly selected broad noncredential disclosure. */
  readonly unclassifiedDisclosurePossible: boolean;
};

export type PlannedPrivacySubmission = MaskedRequest & {
  readonly preview: PrivacyDecisionPreview;
};

const categories = new Set<PrivateKind>([
  'ACCOUNT',
  'ADDRESS',
  'CARD',
  'EMAIL',
  'IP',
  'PERSON',
  'PHONE',
  'PRIVATE',
  'SSN',
]);
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new PrivacyError('Unknown privacy preference field.');
}

function scalar(value: unknown): value is Literal {
  return (
    (typeof value === 'string' &&
      value.length > 0 &&
      Buffer.byteLength(value) <= 4096 &&
      !value.includes('\0') &&
      !value.includes('[[TM_PRIVACY_')) ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    typeof value === 'boolean'
  );
}

function checkScope(value: unknown): PrivacyScope {
  if (!record(value)) throw new PrivacyError('Invalid privacy rule scope.');
  exactKeys(value, ['workspaceId', 'sourceId']);
  if (
    typeof value.workspaceId !== 'string' ||
    !identifier.test(value.workspaceId) ||
    (value.sourceId !== undefined &&
      (typeof value.sourceId !== 'string' || !identifier.test(value.sourceId)))
  )
    throw new PrivacyError('Invalid privacy rule scope.');
  return value as PrivacyScope;
}

function checkRule(value: unknown): PrivacyRule {
  if (!record(value)) throw new PrivacyError('Invalid privacy rule.');
  exactKeys(value, [
    'id',
    'scope',
    'persistence',
    'category',
    'value',
    'action',
    'basis',
    'evidenceRef',
    'substitute',
  ]);
  if (
    typeof value.id !== 'string' ||
    !identifier.test(value.id) ||
    !['submission', 'saved'].includes(String(value.persistence)) ||
    !categories.has(value.category as PrivateKind) ||
    !scalar(value.value) ||
    !['allow', 'substitute'].includes(String(value.action))
  )
    throw new PrivacyError('Invalid privacy rule.');
  checkScope(value.scope);
  if (value.action === 'allow') {
    if (
      value.substitute !== undefined ||
      !['verified-public', 'user-authorized'].includes(String(value.basis)) ||
      (value.basis === 'verified-public' &&
        (typeof value.evidenceRef !== 'string' ||
          !value.evidenceRef.trim() ||
          value.evidenceRef.length > 2048)) ||
      (value.basis === 'user-authorized' && value.evidenceRef !== undefined)
    )
      throw new PrivacyError(
        'An allow rule needs an explicit authorization basis.',
      );
  } else if (
    !scalar(value.substitute) ||
    Object.is(value.value, value.substitute) ||
    value.basis !== undefined ||
    value.evidenceRef !== undefined
  )
    throw new PrivacyError('Invalid deterministic privacy substitute.');
  return value as PrivacyRule;
}

function checkApprovalMemory(value: unknown): void {
  if (!record(value))
    throw new PrivacyError('Invalid privacy approval memory.');
  exactKeys(value, ['key', 'entries']);
  if (
    typeof value.key !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.key) ||
    Buffer.from(value.key, 'base64url').length !== 32 ||
    !Array.isArray(value.entries) ||
    value.entries.length > 128
  )
    throw new PrivacyError('Invalid privacy approval memory.');
  const fingerprints = new Set<string>();
  for (const entry of value.entries) {
    if (!record(entry))
      throw new PrivacyError('Invalid privacy approval memory.');
    exactKeys(entry, ['fingerprint', 'count', 'nextOfferAt']);
    if (
      typeof entry.fingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/.test(entry.fingerprint) ||
      fingerprints.has(entry.fingerprint) ||
      !Number.isSafeInteger(entry.count) ||
      (entry.count as number) < 1 ||
      (entry.count as number) > 1_000_000 ||
      (entry.nextOfferAt !== null &&
        (!Number.isSafeInteger(entry.nextOfferAt) ||
          (entry.nextOfferAt as number) < 2 ||
          (entry.nextOfferAt as number) > 1_000_000))
    )
      throw new PrivacyError('Invalid privacy approval memory.');
    fingerprints.add(entry.fingerprint);
  }
}

function checkLearningMemory(value: unknown): void {
  if (!record(value))
    throw new PrivacyError('Invalid privacy learning memory.');
  exactKeys(value, ['key', 'events', 'suppressedProposalIds']);
  if (
    typeof value.key !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.key) ||
    Buffer.from(value.key, 'base64url').length !== 32 ||
    !Array.isArray(value.events) ||
    value.events.length > 256 ||
    !Array.isArray(value.suppressedProposalIds) ||
    value.suppressedProposalIds.length > 64
  )
    throw new PrivacyError('Invalid privacy learning memory.');
  const eventIds = new Set<string>();
  for (const event of value.events) {
    if (!record(event))
      throw new PrivacyError('Invalid privacy learning event.');
    exactKeys(event, ['id', 'scope', 'category', 'decision', 'fingerprint']);
    const scope = checkScope(event.scope);
    if (
      typeof event.id !== 'string' ||
      !identifier.test(event.id) ||
      eventIds.has(event.id) ||
      scope.sourceId === undefined ||
      !categories.has(event.category as PrivateKind) ||
      !['allow', 'mask'].includes(String(event.decision)) ||
      typeof event.fingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/.test(event.fingerprint)
    )
      throw new PrivacyError('Invalid privacy learning event.');
    eventIds.add(event.id);
  }
  const suppressed = new Set<string>();
  for (const id of value.suppressedProposalIds) {
    if (
      typeof id !== 'string' ||
      !/^[a-f0-9]{64}$/.test(id) ||
      suppressed.has(id)
    )
      throw new PrivacyError('Invalid suppressed privacy group.');
    suppressed.add(id);
  }
}

export function validatePrivacyPreferences(value: unknown): PrivacyPreferences {
  assertJsonValue(value);
  if (Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024)
    throw new PrivacyError('Privacy preferences exceed the local size limit.');
  if (!record(value)) throw new PrivacyError('Invalid privacy preferences.');
  exactKeys(value, [
    'schemaVersion',
    'level',
    'permissiveAcknowledged',
    'rules',
    'approvalMemory',
    'learningMemory',
  ]);
  if (
    value.schemaVersion !== 1 ||
    !['strict', 'balanced', 'permissive'].includes(String(value.level)) ||
    !Array.isArray(value.rules) ||
    value.rules.length > 64 ||
    (value.level === 'permissive' && value.permissiveAcknowledged !== true) ||
    (value.permissiveAcknowledged !== undefined &&
      value.permissiveAcknowledged !== true)
  )
    throw new PrivacyError('Invalid privacy preferences.');
  const rules = value.rules.map(checkRule);
  if (new Set(rules.map((rule) => rule.id)).size !== rules.length)
    throw new PrivacyError('Duplicate privacy rule ID.');
  if (value.approvalMemory !== undefined)
    checkApprovalMemory(value.approvalMemory);
  if (value.learningMemory !== undefined)
    checkLearningMemory(value.learningMemory);
  return structuredClone(value) as PrivacyPreferences;
}

function storedPreferences(value: PrivacyPreferences): PrivacyPreferences {
  const selected = validatePrivacyPreferences(value);
  if (selected.rules.some((rule) => rule.persistence !== 'saved'))
    throw new PrivacyError('Submission-only privacy rules cannot be saved.');
  return selected;
}

function approvalFingerprint(key: string, rule: PrivacyRule): string {
  return createHmac('sha256', Buffer.from(key, 'base64url'))
    .update(
      JSON.stringify([
        rule.scope.workspaceId,
        rule.scope.sourceId ?? null,
        rule.category,
        rule.value,
      ]),
    )
    .digest('hex');
}

function overlappingScopes(left: PrivacyScope, right: PrivacyScope): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    (left.sourceId === undefined ||
      right.sourceId === undefined ||
      left.sourceId === right.sourceId)
  );
}

/**
 * Record an explicit one-submission allowance locally. The raw value is not
 * stored until the user separately chooses `save`.
 */
export function recordPrivacyOverride(
  preferences: PrivacyPreferences,
  oneSubmissionRule: PrivacyRule,
): {
  readonly preferences: PrivacyPreferences;
  readonly offer: PrivacyPersistenceOffer | null;
} {
  const selected = storedPreferences(preferences);
  assertJsonValue(oneSubmissionRule);
  const rule = checkRule(oneSubmissionRule);
  if (
    rule.persistence !== 'submission' ||
    rule.action !== 'allow' ||
    rule.basis !== 'user-authorized'
  )
    throw new PrivacyError('Only one-submission allow rules can be recorded.');
  if (
    selected.rules.some(
      (saved) =>
        overlappingScopes(saved.scope, rule.scope) &&
        Object.is(saved.value, rule.value),
    )
  )
    return { preferences: selected, offer: null };
  const memory = selected.approvalMemory ?? {
    key: randomBytes(32).toString('base64url'),
    entries: [],
  };
  const fingerprint = approvalFingerprint(memory.key, rule);
  const existing = memory.entries.find(
    (entry) => entry.fingerprint === fingerprint,
  );
  const count = Math.min((existing?.count ?? 0) + 1, 1_000_000);
  const nextOfferAt = existing?.nextOfferAt ?? (existing ? null : 2);
  const offer = nextOfferAt !== null && count >= nextOfferAt;
  const entry = {
    fingerprint,
    count,
    nextOfferAt: offer
      ? count >= 1_000_000
        ? null
        : Math.min(count + Math.max(3, count), 1_000_000)
      : nextOfferAt,
  };
  const entries = [
    ...memory.entries.filter((item) => item.fingerprint !== fingerprint),
    entry,
  ].slice(-128);
  return {
    preferences: validatePrivacyPreferences({
      ...selected,
      approvalMemory: { key: memory.key, entries },
    }),
    offer: offer ? { ruleId: rule.id, approvalCount: count } : null,
  };
}

/** Apply the user's answer to a local save suggestion. No rule is saved implicitly. */
export function resolvePrivacyOverride(
  preferences: PrivacyPreferences,
  oneSubmissionRule: PrivacyRule,
  choice: PrivacyPersistenceChoice,
): PrivacyPreferences {
  const selected = storedPreferences(preferences);
  assertJsonValue(oneSubmissionRule);
  const rule = checkRule(oneSubmissionRule);
  if (
    rule.persistence !== 'submission' ||
    rule.action !== 'allow' ||
    rule.basis !== 'user-authorized' ||
    !['save', 'not-now', 'never-suggest'].includes(choice)
  )
    throw new PrivacyError('Invalid privacy persistence choice.');
  if (choice === 'not-now') return selected;
  const memory = selected.approvalMemory;
  const fingerprint = memory && approvalFingerprint(memory.key, rule);
  const entry = memory?.entries.find(
    (item) => item.fingerprint === fingerprint,
  );
  if (!memory || !entry)
    throw new PrivacyError('Privacy approval has not been recorded.');
  if (choice === 'never-suggest')
    return validatePrivacyPreferences({
      ...selected,
      approvalMemory: {
        ...memory,
        entries: memory.entries.map((item) =>
          item.fingerprint === fingerprint
            ? { ...item, nextOfferAt: null }
            : item,
        ),
      },
    });
  if (
    selected.rules.some(
      (saved) =>
        saved.id === rule.id ||
        (overlappingScopes(saved.scope, rule.scope) &&
          Object.is(saved.value, rule.value)),
    )
  )
    throw new PrivacyError('Conflicting saved privacy rule.');
  const savedRule = { ...rule, persistence: 'saved' as const };
  return validatePrivacyPreferences({
    ...selected,
    rules: [...selected.rules, savedRule],
    approvalMemory: {
      ...memory,
      entries: memory.entries.filter(
        (item) => item.fingerprint !== fingerprint,
      ),
    },
  });
}

function activeRule(rule: PrivacyRule, scope: PrivacyScope): boolean {
  return (
    rule.scope.workspaceId === scope.workspaceId &&
    (rule.scope.sourceId === undefined ||
      rule.scope.sourceId === scope.sourceId)
  );
}

function identity(value: Literal): string {
  return JSON.stringify(value);
}

function replacePlainText(
  text: string,
  rules: readonly PrivacyRule[],
  counts: Map<string, number>,
): string {
  let result = '';
  let cursor = 0;
  while (cursor < text.length) {
    let selected: PrivacyRule | undefined;
    let at = text.length;
    for (const rule of rules) {
      if (typeof rule.value !== 'string') continue;
      const found = text.indexOf(rule.value, cursor);
      const selectedLength =
        typeof selected?.value === 'string' ? selected.value.length : 0;
      if (
        found >= 0 &&
        (found < at || (found === at && rule.value.length > selectedLength))
      ) {
        selected = rule;
        at = found;
      }
    }
    if (!selected) return result + text.slice(cursor);
    result += text.slice(cursor, at) + String(selected.substitute);
    counts.set(selected.id, (counts.get(selected.id) ?? 0) + 1);
    cursor = at + (selected.value as string).length;
  }
  return result + text.slice(cursor);
}

function plainSegments(text: string): string[] {
  return text.split(/\[\[TM_PRIVACY_[^\]]+\]\]/g);
}

function replaceText(
  text: string,
  rules: readonly PrivacyRule[],
  counts: Map<string, number>,
): string {
  let cursor = 0;
  let result = '';
  for (const match of text.matchAll(/\[\[TM_PRIVACY_[^\]]+\]\]/g)) {
    result += replacePlainText(text.slice(cursor, match.index), rules, counts);
    result += match[0];
    cursor = match.index + match[0].length;
  }
  return result + replacePlainText(text.slice(cursor), rules, counts);
}

function substitute(
  payload: JsonValue,
  rules: readonly PrivacyRule[],
  counts: Map<string, number>,
): JsonValue {
  if (Array.isArray(payload))
    return payload.map((value) => substitute(value, rules, counts));
  if (payload !== null && typeof payload === 'object')
    return Object.fromEntries(
      Object.entries(payload).map(([key, value]) => [
        key,
        substitute(value, rules, counts),
      ]),
    );
  if (typeof payload === 'string') return replaceText(payload, rules, counts);
  for (const rule of rules) {
    if (Object.is(payload, rule.value)) {
      counts.set(rule.id, (counts.get(rule.id) ?? 0) + 1);
      return rule.substitute!;
    }
  }
  return payload;
}

function occurrences(payload: JsonValue, value: Literal): number {
  if (Array.isArray(payload))
    return payload.reduce<number>(
      (sum, child) => sum + occurrences(child, value),
      0,
    );
  if (payload !== null && typeof payload === 'object')
    return Object.entries(payload).reduce(
      (sum, [key, child]) =>
        sum + occurrences(key, value) + occurrences(child, value),
      0,
    );
  if (typeof value === 'string' && typeof payload === 'string')
    return plainSegments(payload).reduce(
      (sum, segment) => sum + segment.split(value).length - 1,
      0,
    );
  return Object.is(payload, value) ? 1 : 0;
}

export function planPrivacySubmission(
  payload: JsonValue,
  preferences: PrivacyPreferences,
  scope: PrivacyScope,
  policy: Omit<
    PrivacyPolicy,
    'detect' | 'fieldDefaults' | 'allowedLiterals' | 'derivedLiterals'
  > = {},
): PlannedPrivacySubmission {
  const selected = validatePrivacyPreferences(preferences);
  assertJsonValue(scope);
  checkScope(scope);
  assertJsonValue(payload);
  const active = selected.rules.filter((rule) => activeRule(rule, scope));
  const byValue = new Map<string, PrivacyRule>();
  for (const rule of active) {
    const key = identity(rule.value);
    if (byValue.has(key))
      throw new PrivacyError('Conflicting privacy rules for one value.');
    byValue.set(key, rule);
  }
  const substitutions = active.filter((rule) => rule.action === 'substitute');
  const allows = active.filter(
    (rule) =>
      rule.action === 'allow' &&
      (selected.level !== 'strict' || rule.basis === 'user-authorized'),
  );
  const counts = new Map<string, number>();
  // App-declared denials and credential syntax are masked before a substitute
  // can remove their original bytes. The second pass inherits those tokens.
  const initial = mask(payload, {
    literals: policy.literals,
    fields: policy.fields,
    detect: false,
    fieldDefaults: false,
  });
  let protectedRequest: MaskedRequest;
  try {
    const prepared = substitute(initial.payload, substitutions, counts);
    protectedRequest = mask(
      prepared,
      {
        ...policy,
        detect: selected.level !== 'permissive',
        fieldDefaults: selected.level !== 'permissive',
        allowedLiterals: allows.map((rule) => rule.value),
        derivedLiterals: substitutions.map((rule) => rule.substitute!),
      },
      [initial.session],
    );
  } finally {
    disposePrivacySession(initial.session);
  }
  const rulesApplied = [...substitutions, ...allows]
    .map((rule) => ({
      id: rule.id,
      action: rule.action,
      persistence: rule.persistence,
      occurrences:
        rule.action === 'substitute'
          ? (counts.get(rule.id) ?? 0)
          : occurrences(protectedRequest.payload, rule.value),
    }))
    .filter((rule) => rule.occurrences > 0);
  const masked = Object.fromEntries(
    [
      ...new Set([
        ...Object.keys(initial.counts),
        ...Object.keys(protectedRequest.counts),
      ]),
    ].map((category) => [
      category,
      (initial.counts[category as PrivacyKind] ?? 0) +
        (protectedRequest.counts[category as PrivacyKind] ?? 0),
    ]),
  ) as MaskedRequest['counts'];
  const impact = new Set<PrivacyDecisionPreview['possibleImpact'][number]>();
  if (masked.PERSON || masked.EMAIL || masked.PHONE)
    impact.add('identity-matching');
  if (masked.ADDRESS) impact.add('location-reasoning');
  if (masked.ACCOUNT || masked.CARD || masked.SSN || masked.PRIVATE)
    impact.add('exact-value-validation');
  if (masked.IP) impact.add('network-context');
  return {
    ...protectedRequest,
    counts: masked,
    preview: {
      level: selected.level,
      masked,
      rulesApplied,
      possibleImpact: [...impact],
      unclassifiedDisclosurePossible: selected.level === 'permissive',
    },
  };
}

async function checkStorePath(path: string): Promise<void> {
  if (!isAbsolute(path))
    throw new PrivacyError('Privacy settings path must be absolute.');
  const directory = dirname(path);
  const [resolved, info] = await Promise.all([
    realpath(directory),
    stat(directory),
  ]);
  if (
    resolved !== directory ||
    !info.isDirectory() ||
    (process.getuid && info.uid !== process.getuid()) ||
    (info.mode & 0o077) !== 0
  )
    throw new PrivacyError('Privacy settings directory must be private.');
}

async function checkExisting(path: string): Promise<void> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (
    !info.isFile() ||
    info.nlink !== 1 ||
    (process.getuid && info.uid !== process.getuid()) ||
    (info.mode & 0o077) !== 0
  )
    throw new PrivacyError(
      'Privacy settings file must be private and regular.',
    );
}

/** Save only standing rules. Submission-only decisions must never persist. */
export async function savePrivacyPreferences(
  path: string,
  value: PrivacyPreferences,
): Promise<void> {
  if (process.platform === 'win32')
    throw new PrivacyError(
      'Use a host-approved Windows store for privacy rules.',
    );
  const preferences = validatePrivacyPreferences(value);
  if (preferences.rules.some((rule) => rule.persistence !== 'saved'))
    throw new PrivacyError('Submission-only privacy rules cannot be saved.');
  await checkStorePath(path);
  await checkExisting(path);
  const temporary = join(dirname(path), `.temari-privacy-${randomUUID()}`);
  try {
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    try {
      await handle.writeFile(`${JSON.stringify(preferences)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await checkExisting(path);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function loadPrivacyPreferences(
  path: string,
): Promise<PrivacyPreferences> {
  if (process.platform === 'win32')
    throw new PrivacyError(
      'Use a host-approved Windows store for privacy rules.',
    );
  await checkStorePath(path);
  await checkExisting(path);
  const info = await lstat(path);
  if (info.size > 1024 * 1024)
    throw new PrivacyError('Privacy settings file is too large.');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: string;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > 1024 * 1024)
      throw new PrivacyError('Privacy settings file is unsupported.');
    bytes = await handle.readFile('utf8');
    if (Buffer.byteLength(bytes) > 1024 * 1024)
      throw new PrivacyError('Privacy settings file is too large.');
  } finally {
    await handle.close();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    throw new PrivacyError('Invalid local privacy settings file.');
  }
  const value = validatePrivacyPreferences(parsed);
  if (value.rules.some((rule) => rule.persistence !== 'saved'))
    throw new PrivacyError('Stored privacy rules must be saved rules.');
  return value;
}
