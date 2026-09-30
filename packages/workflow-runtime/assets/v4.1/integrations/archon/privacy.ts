import {
  createHmac,
  createSecretKey,
  randomBytes,
  randomUUID,
  type KeyObject,
} from 'node:crypto';
import { isProxy } from 'node:util/types';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type PrivacyKind =
  | 'ACCOUNT'
  | 'ADDRESS'
  | 'CARD'
  | 'CREDENTIAL'
  | 'EMAIL'
  | 'IP'
  | 'PERSON'
  | 'PHONE'
  | 'PRIVATE'
  | 'SSN';

export type PrivacyFieldRule = {
  readonly path: string;
  readonly kind?: Exclude<PrivacyKind, 'CREDENTIAL'>;
  readonly restore?: boolean;
};

export type PrivacyLiteral = {
  readonly value: string | number | boolean;
  readonly kind?: PrivacyKind;
  readonly restore?: boolean;
};

export type PrivacyPolicy = {
  readonly literals?: readonly PrivacyLiteral[];
  /** Explicitly authorized exact values bypass automatic identity detection only. */
  readonly allowedLiterals?: readonly (string | number | boolean)[];
  /** Derived local values bypass field-name defaults, but not text detectors. */
  readonly derivedLiterals?: readonly (string | number | boolean)[];
  readonly fields?: readonly PrivacyFieldRule[];
  readonly detect?: boolean;
  readonly fieldDefaults?: boolean;
};

type RequestId = string & { readonly __privacyRequestId: 'RequestId' };
type Placeholder = string & { readonly __privacyPlaceholder: 'Placeholder' };
type Scalar = Exclude<JsonPrimitive, null> | null;
type JsonObject = { readonly [key: string]: JsonValue };
type Entry = {
  kind: PrivacyKind;
  restore: boolean;
  value: Scalar | null;
};

export type PrivacySession = {
  readonly requestId: RequestId;
};

export type MaskedRequest = {
  readonly payload: JsonValue;
  readonly session: PrivacySession;
  readonly counts: Readonly<Partial<Record<PrivacyKind, number>>>;
};

export class PrivacyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'PrivacyError';
  }
}

type FingerprintScope = {
  readonly key: KeyObject;
  fingerprints: ReadonlyMap<number, ReadonlyMap<string, PrivacyKind>>;
};

type SessionState = {
  readonly entries: ReadonlyMap<Placeholder, Entry>;
  readonly fingerprints: readonly FingerprintScope[];
};

const sessions = new WeakMap<PrivacySession, SessionState>();
const maxFingerprints = 1024;
const maxFingerprintWindows = 2 * 1024 * 1024;
const maxFingerprintBytes = 128 * 1024 * 1024;

export function disposePrivacySession(session: PrivacySession): void {
  sessions.delete(session);
}

function createSession(
  requestId: RequestId,
  entries: ReadonlyMap<Placeholder, Entry>,
  fingerprints: readonly FingerprintScope[],
): PrivacySession {
  const session = Object.freeze({ requestId });
  sessions.set(session, { entries, fingerprints });
  return session;
}

const placeholderPrefix = '[[TM_PRIVACY_';
const placeholderPattern =
  /^\[\[TM_PRIVACY_([a-f0-9-]{36})_([A-Z][A-Z0-9_]*)_([0-9]+)\]\]$/;

function toPlaceholder(value: string): Placeholder {
  if (!placeholderPattern.test(value))
    throw new PrivacyError('Malformed privacy placeholder.');
  return value as Placeholder;
}
const credentialKeys = new Set([
  'authorization',
  'cookie',
  'password',
  'passwd',
  'apikey',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'clientsecret',
  'secret',
  'token',
  'credentials',
]);
const privateKeys = new Map<string, PrivacyKind>([
  ['email', 'EMAIL'],
  ['emailaddress', 'EMAIL'],
  ['phone', 'PHONE'],
  ['phonenumber', 'PHONE'],
  ['ssn', 'SSN'],
  ['socialsecuritynumber', 'SSN'],
  ['address', 'ADDRESS'],
  ['streetaddress', 'ADDRESS'],
  ['firstname', 'PERSON'],
  ['lastname', 'PERSON'],
  ['fullname', 'PERSON'],
  ['displayname', 'PERSON'],
]);

const emailPattern =
  /(?<![\w.+-])[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}(?![\w.-])/g;
const phonePattern =
  /(?<!\w)(?:\+1[ .-]?)?(?:\(\d{3}\)[ .-]?|\d{3}[ .-])\d{3}[ .-]\d{4}(?!\w)/g;
const ssnPattern =
  /(?<!\d)(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?!\d)/g;
const ipPattern = /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g;
const bearerPattern = /\bBearer\s+([^\s,;"'\]}]+)/dgi;
const basicHeaderPattern = /\bauthorization\s*:\s*basic/gi;
const basicPlaceholderPattern =
  /^\[\[TM_PRIVACY_[a-f0-9-]{36}_[A-Z][A-Z0-9_]*_[0-9]+\]\]/;
const canonicalBasicPattern =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const assignmentPattern =
  /\b(?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|secret|token)\b["']?\s*[:=]\s*(?:"((?:\\.|[^"\\\r\n])*)"|'((?:\\.|[^'\\\r\n])*)'|((?:\[\[TM_PRIVACY_[^\]]+\]\]|[^\s,;{}"'])+))/dgi;
const apiTokenPattern =
  /(?<!\w)(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})(?!\w)/g;
const jwtPattern =
  /(?<![\w-])eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?![\w-])/g;

function dataValue(descriptor: PropertyDescriptor | undefined): unknown {
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))
    throw new PrivacyError('Only enumerable data properties are supported.');
  return descriptor.value;
}

function plainProperties(value: unknown): [string, unknown][] {
  if (
    value === null ||
    typeof value !== 'object' ||
    isProxy(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  )
    throw new PrivacyError('Only plain JSON objects are supported.');
  return Reflect.ownKeys(value).map((key) => {
    if (typeof key !== 'string')
      throw new PrivacyError('Only string property names are supported.');
    return [key, dataValue(Object.getOwnPropertyDescriptor(value, key))];
  });
}

function arrayValues(value: unknown): unknown[] {
  if (
    isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  )
    throw new PrivacyError('Only plain JSON arrays are supported.');
  const length = Object.getOwnPropertyDescriptor(value, 'length')!
    .value as number;
  if (Reflect.ownKeys(value).length !== length + 1)
    throw new PrivacyError('Sparse or extended arrays are not supported.');
  return Array.from({ length }, (_, index) =>
    dataValue(Object.getOwnPropertyDescriptor(value, String(index))),
  );
}

function checkInputText(value: string): string {
  if (value.includes(placeholderPrefix))
    throw new PrivacyError('Input contains a reserved privacy placeholder.');
  return value;
}

function copyJson(value: unknown): JsonValue {
  const ancestors = new Set<object>();
  const visit = (child: unknown, depth: number): JsonValue => {
    if (depth > 256)
      throw new PrivacyError('JSON nesting exceeds the privacy depth limit.');
    if (typeof child === 'string') return child;
    if (child === null || typeof child === 'boolean') return child;
    if (typeof child === 'number' && Number.isFinite(child)) return child;
    if (typeof child !== 'object' || child === null || isProxy(child))
      throw new PrivacyError('Only finite plain JSON is supported.');
    if (ancestors.has(child))
      throw new PrivacyError('Cyclic JSON is not supported.');
    ancestors.add(child);
    const result = Array.isArray(child)
      ? arrayValues(child).map((item) => visit(item, depth + 1))
      : Object.fromEntries(
          plainProperties(child).map(([key, item]) => [
            key,
            visit(item, depth + 1),
          ]),
        );
    ancestors.delete(child);
    return result;
  };
  return visit(value, 0);
}

export function assertJsonValue(value: unknown): asserts value is JsonValue {
  copyJson(value);
}

function normalKey(value: string): string {
  return value.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function parsePath(path: string): readonly string[] {
  if (!path.startsWith('/') || /~(?![01])/.test(path))
    throw new PrivacyError('Invalid privacy field path.');
  return path
    .slice(1)
    .split('/')
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function canonical(value: Scalar): string {
  return JSON.stringify(value);
}

function isPrivacyKind(value: string): value is PrivacyKind {
  switch (value) {
    case 'ACCOUNT':
    case 'ADDRESS':
    case 'CARD':
    case 'CREDENTIAL':
    case 'EMAIL':
    case 'IP':
    case 'PERSON':
    case 'PHONE':
    case 'PRIVATE':
    case 'SSN':
      return true;
    default:
      return false;
  }
}

function kind(value: unknown): PrivacyKind {
  if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(value))
    throw new PrivacyError('Invalid privacy category.');
  if (!isPrivacyKind(value))
    throw new PrivacyError('Unsupported privacy category.');
  return value;
}

function literalValue(value: unknown): value is string | number | boolean {
  return (
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    typeof value === 'boolean'
  );
}

function restoreFlag(value: unknown, category: PrivacyKind): boolean {
  const restore = value === undefined ? category !== 'CREDENTIAL' : value;
  if (typeof restore !== 'boolean' || (category === 'CREDENTIAL' && restore))
    throw new PrivacyError('Credentials cannot be restored.');
  return restore;
}

function policyProperties(
  value: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  const properties = plainProperties(value);
  if (properties.some(([key]) => !allowed.includes(key)))
    throw new PrivacyError('Unknown privacy policy option.');
  return Object.fromEntries(properties);
}

function validatePolicy(policy: unknown) {
  const options = policyProperties(policy, [
    'allowedLiterals',
    'derivedLiterals',
    'detect',
    'fieldDefaults',
    'fields',
    'literals',
  ]);
  for (const key of ['detect', 'fieldDefaults']) {
    if (options[key] !== undefined && typeof options[key] !== 'boolean')
      throw new PrivacyError('Privacy detection options must be booleans.');
  }
  const fields = (
    options.fields === undefined ? [] : arrayValues(options.fields)
  ).map((value) => {
    const rule = policyProperties(value, ['path', 'kind', 'restore']);
    if (typeof rule.path !== 'string')
      throw new PrivacyError('Invalid privacy field rule.');
    const category = kind(rule.kind === undefined ? 'PRIVATE' : rule.kind);
    if (category === 'CREDENTIAL')
      throw new PrivacyError('Credential categories are not field policies.');
    return {
      path: parsePath(rule.path),
      kind: category,
      restore: restoreFlag(rule.restore, category),
    };
  });
  const literals = (
    options.literals === undefined ? [] : arrayValues(options.literals)
  ).map((value) => {
    const literal = policyProperties(value, ['value', 'kind', 'restore']);
    if (!literalValue(literal.value) || literal.value === '')
      throw new PrivacyError(
        'Privacy literals must be nonempty finite JSON scalars.',
      );
    if (typeof literal.value === 'string') checkInputText(literal.value);
    const category = kind(
      literal.kind === undefined ? 'PRIVATE' : literal.kind,
    );
    return {
      value: literal.value,
      kind: category,
      restore: restoreFlag(literal.restore, category),
    };
  });
  const allowedLiterals = (
    options.allowedLiterals === undefined
      ? []
      : arrayValues(options.allowedLiterals)
  ).map((value) => {
    if (!literalValue(value) || value === '')
      throw new PrivacyError(
        'Allowed literals must be nonempty finite JSON scalars.',
      );
    if (typeof value === 'string') checkInputText(value);
    return value;
  });
  if (allowedLiterals.length > 64)
    throw new PrivacyError('Too many allowed privacy literals.');
  const derivedLiterals = (
    options.derivedLiterals === undefined
      ? []
      : arrayValues(options.derivedLiterals)
  ).map((value) => {
    if (!literalValue(value) || value === '')
      throw new PrivacyError(
        'Derived literals must be nonempty finite JSON scalars.',
      );
    if (typeof value === 'string') checkInputText(value);
    return value;
  });
  if (derivedLiterals.length > 64)
    throw new PrivacyError('Too many derived privacy literals.');
  return {
    detect: options.detect !== false,
    fieldDefaults: options.fieldDefaults !== false,
    fields,
    literals,
    allowedLiterals,
    derivedLiterals,
  };
}

function restrictiveEntry(first: Entry, second?: Entry): Entry {
  if (!second) return first;
  const priority = (entry: Entry): number =>
    entry.kind === 'CREDENTIAL' ? 2 : entry.restore ? 0 : 1;
  return priority(second) > priority(first) ? second : first;
}

function detectorMatches(
  text: string,
  detect: boolean,
): readonly {
  start: number;
  end: number;
  kind: PrivacyKind;
  restore: boolean;
}[] {
  const matches: {
    start: number;
    end: number;
    kind: PrivacyKind;
    restore: boolean;
  }[] = [];
  const add = (
    pattern: RegExp,
    category: PrivacyKind,
    restore: boolean,
    groups?: readonly number[],
  ) => {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const group = groups?.find((index) => match[index] !== undefined);
      const start =
        group === undefined ? match.index : match.indices![group]![0];
      const value = match[group ?? 0]!;
      if (pattern === assignmentPattern && group === 3) {
        if (value === '[]') continue;
        let depth = 0;
        for (const char of value) {
          if (char === '[') depth++;
          if (char === ']' && --depth < 0)
            throw new PrivacyError('Ambiguous bracketed credential value.');
        }
        if (depth !== 0)
          throw new PrivacyError('Ambiguous bracketed credential value.');
      }
      if (start !== undefined && value !== '')
        matches.push({
          start,
          end: start + value.length,
          kind: category,
          restore,
        });
    }
  };
  if (detect) {
    add(emailPattern, 'EMAIL', true);
    add(phonePattern, 'PHONE', true);
    add(ssnPattern, 'SSN', true);
    add(ipPattern, 'IP', true);
  }
  add(apiTokenPattern, 'CREDENTIAL', false);
  add(jwtPattern, 'CREDENTIAL', false);
  add(bearerPattern, 'CREDENTIAL', false, [1]);
  for (const header of text.matchAll(basicHeaderPattern)) {
    let start = header.index + header[0].length;
    if (start < text.length && !/\s/.test(text[start]!))
      throw new PrivacyError('Ambiguous Basic authorization value.');
    while (start < text.length && /\s/.test(text[start]!)) start++;
    if (start === text.length) continue;
    const remainder = text.slice(start);
    const placeholder = remainder.match(basicPlaceholderPattern)?.[0];
    const value = placeholder ?? remainder.match(/^[A-Za-z0-9+/=]+/)?.[0];
    const decoded =
      value && !placeholder ? Buffer.from(value, 'base64') : undefined;
    if (
      !value ||
      (text[start + value.length] !== undefined &&
        !/[\s,;}]/.test(text[start + value.length]!)) ||
      (!placeholder &&
        (!canonicalBasicPattern.test(value) ||
          !decoded?.includes(0x3a) ||
          decoded.toString('base64') !== value))
    )
      throw new PrivacyError('Ambiguous Basic authorization value.');
    matches.push({
      start,
      end: start + value.length,
      kind: 'CREDENTIAL',
      restore: false,
    });
  }
  add(assignmentPattern, 'CREDENTIAL', false, [1, 2, 3]);
  return matches;
}

function pathMatches(
  rule: readonly string[],
  path: readonly string[],
): boolean {
  return (
    rule.length === path.length &&
    rule.every((part, index) => part === '*' || part === path[index])
  );
}

function scopeStates(
  scope: PrivacySession | readonly PrivacySession[],
): SessionState[] {
  if (isProxy(scope)) throw new PrivacyError('Unknown privacy session.');
  return (Array.isArray(scope) ? arrayValues(scope) : [scope]).map(
    (session) => {
      const local =
        session !== null && typeof session === 'object'
          ? sessions.get(session as PrivacySession)
          : undefined;
      if (!local) throw new PrivacyError('Unknown privacy session.');
      return local;
    },
  );
}

function scopeEntries(
  states: readonly SessionState[],
): Map<Placeholder, Entry> {
  const entries = new Map<Placeholder, Entry>();
  for (const local of states) {
    for (const [token, entry] of local.entries)
      entries.set(token, restrictiveEntry(entry, entries.get(token)));
  }
  return entries;
}

function fingerprintMatcher(states: readonly SessionState[]) {
  const scopes = [...new Set(states.flatMap((state) => state.fingerprints))];
  if (scopes.length === 0)
    scopes.push({
      key: createSecretKey(randomBytes(32)),
      fingerprints: new Map(),
    });
  const primary = scopes[0]!;
  const pending = new Map(
    [...primary.fingerprints].map(([length, entries]) => [
      length,
      new Map(entries),
    ]),
  );
  let count = scopes.reduce(
    (total, scope) =>
      total +
      [...scope.fingerprints.values()].reduce(
        (sum, entries) => sum + entries.size,
        0,
      ),
    0,
  );
  if (count > maxFingerprints)
    throw new PrivacyError('Privacy fingerprint capacity exceeded.');
  let windows = 0;
  let bytes = 0;
  const charge = (length: number, candidates: number): void => {
    windows += candidates;
    bytes += length * 2 * candidates;
    if (windows > maxFingerprintWindows || bytes > maxFingerprintBytes)
      throw new PrivacyError('Privacy fingerprint matching limit exceeded.');
  };
  const digest = (text: string, key: KeyObject): string =>
    createHmac('sha256', key).update(text, 'utf16le').digest('hex');
  return {
    scan(
      text: string,
      found: (value: string, kind: PrivacyKind) => void,
    ): void {
      for (const scope of scopes) {
        for (const [length, entries] of scope.fingerprints) {
          if (length > text.length) continue;
          charge(length, text.length - length + 1);
          for (let start = 0; start + length <= text.length; start += 1) {
            const candidate = text.slice(start, start + length);
            const category = entries.get(digest(candidate, scope.key));
            if (category) found(candidate, category);
          }
        }
      }
    },
    remember(text: string, category: PrivacyKind): void {
      if (!text) return;
      charge(text.length, 1);
      const hash = digest(text, primary.key);
      const entries =
        pending.get(text.length) ?? new Map<string, PrivacyKind>();
      const prior = entries.get(hash);
      if (!prior && ++count > maxFingerprints)
        throw new PrivacyError('Privacy fingerprint capacity exceeded.');
      if (!prior || category === 'CREDENTIAL') entries.set(hash, category);
      pending.set(text.length, entries);
    },
    commit(): readonly FingerprintScope[] {
      primary.fingerprints = pending;
      return scopes;
    },
  };
}

type TextPart = {
  start: number;
  end: number;
  token?: Placeholder;
};

function textParts(
  text: string,
  entries: ReadonlyMap<Placeholder, Entry>,
): TextPart[] {
  const parts: TextPart[] = [];
  let cursor = 0;
  const plain = (end: number): void => {
    checkInputText(text.slice(cursor, end));
    if (end > cursor) parts.push({ start: cursor, end });
  };
  for (const match of text.matchAll(/\[\[TM_PRIVACY_[^\]]+\]\]/g)) {
    plain(match.index);
    const token = toPlaceholder(match[0]);
    if (!entries.has(token))
      throw new PrivacyError('Unknown privacy placeholder.');
    cursor = match.index + token.length;
    parts.push({ start: match.index, end: cursor, token });
  }
  plain(text.length);
  return parts;
}

// Trusted scopes carry issued tokens and bounded keyed fingerprints of discarded
// values, never their raw text. Every model-bound batch must still pass mask.
export function mask(
  payload: JsonValue,
  policy: PrivacyPolicy = {},
  trustedSessions: readonly PrivacySession[] = [],
): MaskedRequest {
  const input = copyJson(payload);
  const {
    detect,
    fieldDefaults,
    fields,
    literals,
    allowedLiterals,
    derivedLiterals,
  } = validatePolicy(policy);
  const allowed = new Set(allowedLiterals.map(canonical));
  const derived = new Set(derivedLiterals.map(canonical));
  arrayValues(trustedSessions);
  const states = scopeStates(trustedSessions);
  const inherited = scopeEntries(states);
  const fingerprints = fingerprintMatcher(states);
  const trusted = new Map(
    [...inherited].map(([token, entry]) => [token, { ...entry }]),
  );
  const known = new Map<string, Entry>();
  const remember = (
    value: Scalar,
    category: PrivacyKind,
    restore: boolean,
    forced = false,
  ): void => {
    if (value === null || value === '') return;
    const key = canonical(value);
    if (!forced && category !== 'CREDENTIAL' && allowed.has(key)) return;
    const entry = { kind: category, restore, value: restore ? value : null };
    known.set(key, restrictiveEntry(known.get(key) ?? entry, entry));
  };
  const scanned = new Set<string>();
  const collectFingerprints = (text: string): void => {
    if (scanned.has(text)) return;
    scanned.add(text);
    fingerprints.scan(text, (value, category) =>
      remember(value, category, false, true),
    );
  };
  for (const literal of literals)
    remember(literal.value, literal.kind, literal.restore, true);
  for (const entry of trusted.values()) {
    if (entry.restore) {
      remember(entry.value, entry.kind, true, true);
      collectFingerprints(String(entry.value));
    }
  }
  const revoke = (token: Placeholder, restriction: Entry): void => {
    const entry = trusted.get(token)!;
    const effective = restrictiveEntry(entry, restriction);
    if (effective.restore) return;
    remember(entry.value, effective.kind, false, true);
    Object.assign(entry, { kind: effective.kind, restore: false, value: null });
  };
  const collectText = (text: string, protectedEntry?: Entry): void => {
    const parts = textParts(text, trusted);
    // `detect: false` disables ordinary PII patterns, never credential syntax.
    const rememberMatch = (value: string, entry: Entry): void => {
      remember(value, entry.kind, entry.restore);
      if (entry.kind === 'CREDENTIAL') {
        try {
          const decoded: unknown = JSON.parse(`"${value}"`);
          if (typeof decoded === 'string') remember(decoded, entry.kind, false);
        } catch {
          // Unquoted credentials need not be valid JSON string contents.
        }
      }
    };
    for (const part of parts) {
      if (part.token) {
        if (protectedEntry && !protectedEntry.restore)
          revoke(part.token, protectedEntry);
        continue;
      }
      const value = text.slice(part.start, part.end);
      collectFingerprints(value);
      if (protectedEntry)
        remember(value, protectedEntry.kind, protectedEntry.restore, true);
      for (const match of detectorMatches(value, detect))
        rememberMatch(value.slice(match.start, match.end), {
          ...match,
          value: null,
        });
    }
    if (parts.some((part) => part.token)) {
      for (const match of detectorMatches(text, false)) {
        const overlaps = parts.filter(
          (part) => part.start < match.end && part.end > match.start,
        );
        if (!overlaps.some((part) => part.token)) continue;
        const restriction: Entry = {
          kind: 'CREDENTIAL',
          restore: false,
          value: null,
        };
        for (const part of overlaps) {
          if (part.token) revoke(part.token, restriction);
          else
            rememberMatch(
              text.slice(
                Math.max(part.start, match.start),
                Math.min(part.end, match.end),
              ),
              restriction,
            );
        }
      }
    }
  };
  const fieldRule = (
    path: readonly string[],
    key: string,
  ): Entry | undefined => {
    const normalized = normalKey(key);
    if (credentialKeys.has(normalized))
      return { kind: 'CREDENTIAL', restore: false, value: null };
    let explicit: Entry | undefined;
    for (const rule of fields) {
      if (pathMatches(rule.path, path)) {
        const entry = { kind: rule.kind, restore: rule.restore, value: null };
        explicit = restrictiveEntry(explicit ?? entry, entry);
      }
    }
    if (explicit) return explicit;
    if (fieldDefaults) {
      const category = privateKeys.get(normalized);
      if (category) return { kind: category, restore: true, value: null };
    }
    return undefined;
  };
  const collect = (
    value: JsonValue,
    path: readonly string[] = [],
    protectedEntry?: Entry,
  ): void => {
    if (isJsonArray(value)) {
      value.forEach((child, index) =>
        collect(child, [...path, String(index)], protectedEntry),
      );
      return;
    }
    if (isJsonObject(value)) {
      Object.entries(value).forEach(([key, child]) => {
        let keyRestriction: Entry | undefined;
        const semanticKey = textParts(key, trusted)
          .map((part) => {
            if (!part.token) return key.slice(part.start, part.end);
            const entry = trusted.get(part.token)!;
            if (entry.restore) return String(entry.value);
            keyRestriction = restrictiveEntry(keyRestriction ?? entry, entry);
            return part.token;
          })
          .join('');
        const rule =
          child !== null &&
          typeof child !== 'object' &&
          (allowed.has(canonical(child)) || derived.has(canonical(child))) &&
          !credentialKeys.has(normalKey(semanticKey)) &&
          !fields.some((candidate) =>
            pathMatches(candidate.path, [...path, semanticKey]),
          )
            ? undefined
            : fieldRule([...path, semanticKey], semanticKey);
        const next = rule
          ? restrictiveEntry(rule, keyRestriction)
          : keyRestriction;
        collect(
          child,
          [...path, semanticKey],
          next ? restrictiveEntry(next, protectedEntry) : protectedEntry,
        );
        collectText(
          key,
          protectedEntry && !protectedEntry.restore
            ? protectedEntry
            : undefined,
        );
      });
      return;
    }
    if (typeof value === 'string') collectText(value, protectedEntry);
    else if (value !== null) {
      collectFingerprints(String(value));
      if (protectedEntry)
        remember(value, protectedEntry.kind, protectedEntry.restore, true);
    }
  };
  for (const literal of literals) {
    if (literal.kind === 'CREDENTIAL' && typeof literal.value === 'string')
      collectText(literal.value, {
        kind: 'CREDENTIAL',
        restore: false,
        value: null,
      });
  }
  collect(input);
  const knownText = () =>
    [...known].map(([key, entry]) => ({
      text: String(JSON.parse(key)),
      entry,
    }));
  const restrictValue = (value: Scalar, entry: Entry): Entry => {
    for (const literal of knownText()) {
      if (!literal.entry.restore && String(value).includes(literal.text))
        entry = restrictiveEntry(entry, literal.entry);
    }
    return entry;
  };
  // Revocation of a retained identity also covers aliases and raw repetitions.
  let changed: boolean;
  do {
    changed = false;
    for (const [token, entry] of trusted) {
      if (entry.restore) {
        const effective = restrictValue(entry.value, entry);
        if (!effective.restore) {
          revoke(token, effective);
          changed = true;
        }
      }
    }
  } while (changed);
  const replacements = knownText();
  for (const literal of replacements) {
    if (!literal.entry.restore)
      fingerprints.remember(literal.text, literal.entry.kind);
  }
  const requestId = randomUUID() as RequestId;
  const entries = new Map<Placeholder, Entry>(trusted);
  const cache = new Map<string, Placeholder>();
  const counts: Partial<Record<PrivacyKind, number>> = {};
  const tokenFor = (value: Scalar, entry: Entry): Placeholder => {
    const key = canonical(value);
    const prior = restrictValue(value, restrictiveEntry(entry, known.get(key)));
    const existing = cache.get(key);
    if (existing) {
      counts[entries.get(existing)!.kind] =
        (counts[entries.get(existing)!.kind] ?? 0) + 1;
      return existing;
    }
    const category = prior.kind;
    if (!prior.restore) fingerprints.remember(String(value), category);
    const placeholder =
      `[[TM_PRIVACY_${requestId}_${category}_${entries.size + 1}]]` as Placeholder;
    entries.set(placeholder, {
      kind: category,
      restore: prior.restore,
      value: prior.restore ? value : null,
    });
    cache.set(key, placeholder);
    counts[category] = (counts[category] ?? 0) + 1;
    return placeholder;
  };
  const replaceText = (text: string): string => {
    const spans: { start: number; end: number; entry: Entry }[] = [];
    for (const { text: literal, entry } of replacements) {
      let start = text.indexOf(literal);
      while (start >= 0) {
        spans.push({ start, end: start + literal.length, entry });
        start = text.indexOf(literal, start + 1);
      }
    }
    spans.sort((a, b) => a.start - b.start || b.end - a.end);
    const merged: typeof spans = [];
    for (const span of spans) {
      const previous = merged.at(-1);
      if (previous && span.start < previous.end) {
        previous.entry = restrictiveEntry(previous.entry, span.entry);
        previous.end = Math.max(previous.end, span.end);
      } else merged.push({ ...span });
    }
    let output = '';
    let cursor = 0;
    for (const span of merged) {
      output += text.slice(cursor, span.start);
      output += tokenFor(text.slice(span.start, span.end), span.entry);
      cursor = span.end;
    }
    return output + text.slice(cursor);
  };
  const maskText = (value: string): string =>
    textParts(value, trusted)
      .map(
        (part) => part.token ?? replaceText(value.slice(part.start, part.end)),
      )
      .join('');
  const walk = (value: JsonValue): JsonValue => {
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === 'object') {
      const result: Record<string, JsonValue> = {};
      for (const [key, child] of Object.entries(value)) {
        const maskedKey = maskText(key);
        if (Object.hasOwn(result, maskedKey))
          throw new PrivacyError('Masking would create duplicate JSON keys.');
        Object.defineProperty(result, maskedKey, {
          value: walk(child),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return result;
    }
    if (typeof value === 'string') return maskText(value);
    if (value === null) return value;
    const entry =
      known.get(canonical(value)) ??
      restrictValue(value, {
        kind: 'PRIVATE',
        restore: true,
        value,
      });
    return known.has(canonical(value)) || !entry.restore
      ? tokenFor(value, entry)
      : value;
  };
  const masked = walk(input);
  copyJson(masked);
  const validateOutput = (value: JsonValue): void => {
    if (typeof value === 'string') textParts(value, entries);
    else if (Array.isArray(value)) value.forEach(validateOutput);
    else if (isJsonObject(value))
      for (const [key, child] of Object.entries(value)) {
        textParts(key, entries);
        validateOutput(child);
      }
  };
  validateOutput(masked);
  const retainedFingerprints = fingerprints.commit();
  for (const [token, original] of inherited) {
    Object.assign(original, trusted.get(token)!);
    entries.set(token, original);
  }
  return {
    payload: masked,
    session: createSession(requestId, entries, retainedFingerprints),
    counts,
  };
}

export function restoreForDisplay(
  response: JsonValue,
  session: PrivacySession | readonly PrivacySession[],
): JsonValue {
  const input = copyJson(response);
  const entries = scopeEntries(scopeStates(session));
  const replace = (value: string): string | Scalar => {
    let exact: Scalar | undefined;
    const replaced = textParts(value, entries)
      .map((part) => {
        if (!part.token) return value.slice(part.start, part.end);
        const entry = entries.get(part.token)!;
        const original = entry.restore
          ? entry.value
          : entry.kind === 'CREDENTIAL'
            ? '[CREDENTIAL_REMOVED]'
            : '[PRIVATE_REMOVED]';
        if (original === null)
          throw new PrivacyError('Invalid privacy session entry.');
        if (part.token === value) exact = original;
        return String(original);
      })
      .join('');
    if (replaced.includes(placeholderPrefix))
      throw new PrivacyError('Malformed privacy placeholder.');
    return exact ?? replaced;
  };
  const walk = (value: JsonValue): JsonValue => {
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === 'object') {
      const result: Record<string, JsonValue> = {};
      for (const [key, child] of Object.entries(value)) {
        const restoredKey = replace(key);
        if (
          typeof restoredKey !== 'string' ||
          Object.hasOwn(result, restoredKey)
        )
          throw new PrivacyError(
            'Restoration would create duplicate JSON keys.',
          );
        Object.defineProperty(result, restoredKey, {
          value: walk(child),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return result;
    }
    if (typeof value !== 'string') return value;
    const restored = replace(value);
    return restored;
  };
  return walk(input);
}
