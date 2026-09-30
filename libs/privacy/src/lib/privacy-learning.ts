import { createHash, createHmac, randomBytes } from 'node:crypto';
import { assertJsonValue, PrivacyError, type PrivacyKind } from './privacy.js';
import {
  validatePrivacyPreferences,
  type PrivacyLearningMemory,
  type PrivacyPreferences,
} from './privacy-preferences.js';

type PrivateKind = Exclude<PrivacyKind, 'CREDENTIAL'>;
type Literal = string | number | boolean;

export type PrivacyLearningDecision = {
  readonly id: string;
  readonly scope: { readonly workspaceId: string; readonly sourceId: string };
  readonly category: PrivateKind;
  readonly decision: 'allow' | 'mask';
  readonly value: Literal;
  /** The host observed this choice from the user, rather than inferring it. */
  readonly explicitUser: true;
};

export type PrivacyGroupProposal = {
  readonly id: string;
  readonly scope: PrivacyLearningDecision['scope'];
  readonly category: PrivateKind;
  readonly suggestedDefault: 'allow' | 'mask';
  readonly distinctValues: number;
  readonly decisionCount: number;
  readonly requiresApproval: true;
};

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
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
const sensitiveAllow = new Set<PrivateKind>([
  'ACCOUNT',
  'CARD',
  'PRIVATE',
  'SSN',
]);

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function checkedDecision(value: unknown): PrivacyLearningDecision {
  assertJsonValue(value);
  if (
    !object(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          'id',
          'scope',
          'category',
          'decision',
          'value',
          'explicitUser',
        ].includes(key),
    ) ||
    !object(value.scope) ||
    Object.keys(value.scope).some(
      (key) => !['workspaceId', 'sourceId'].includes(key),
    ) ||
    typeof value.id !== 'string' ||
    !identifier.test(value.id) ||
    typeof value.scope.workspaceId !== 'string' ||
    !identifier.test(value.scope.workspaceId) ||
    typeof value.scope.sourceId !== 'string' ||
    !identifier.test(value.scope.sourceId) ||
    !categories.has(value.category as PrivateKind) ||
    !['allow', 'mask'].includes(String(value.decision)) ||
    value.explicitUser !== true ||
    !(
      (typeof value.value === 'string' &&
        value.value.length > 0 &&
        Buffer.byteLength(value.value) <= 4096 &&
        !value.value.includes('\0') &&
        !value.value.includes('[[TM_PRIVACY_')) ||
      (typeof value.value === 'number' && Number.isFinite(value.value)) ||
      typeof value.value === 'boolean'
    )
  )
    throw new PrivacyError('Invalid explicit privacy learning decision.');
  return value as PrivacyLearningDecision;
}

function storedPreferences(value: PrivacyPreferences): PrivacyPreferences {
  const selected = validatePrivacyPreferences(value);
  if (selected.rules.some((rule) => rule.persistence !== 'saved'))
    throw new PrivacyError('Submission-only privacy rules cannot be saved.');
  return selected;
}

function fingerprint(key: string, decision: PrivacyLearningDecision): string {
  return createHmac('sha256', Buffer.from(key, 'base64url'))
    .update(
      JSON.stringify([
        decision.scope.workspaceId,
        decision.scope.sourceId,
        decision.category,
        decision.value,
      ]),
    )
    .digest('hex');
}

/** Retain an explicit choice locally without retaining its raw value. */
export function recordPrivacyLearningDecision(
  preferences: PrivacyPreferences,
  input: PrivacyLearningDecision,
): PrivacyPreferences {
  const selected = storedPreferences(preferences);
  const decision = checkedDecision(input);
  const memory: PrivacyLearningMemory = selected.learningMemory ?? {
    key: randomBytes(32).toString('base64url'),
    events: [],
    suppressedProposalIds: [],
  };
  const event = {
    id: decision.id,
    scope: decision.scope,
    category: decision.category,
    decision: decision.decision,
    fingerprint: fingerprint(memory.key, decision),
  };
  const previous = memory.events.find((item) => item.id === event.id);
  if (previous) {
    if (
      previous.scope.workspaceId !== event.scope.workspaceId ||
      previous.scope.sourceId !== event.scope.sourceId ||
      previous.category !== event.category ||
      previous.decision !== event.decision ||
      previous.fingerprint !== event.fingerprint
    )
      throw new PrivacyError('Conflicting privacy learning decision ID.');
    return selected;
  }
  if (memory.events.length >= 256)
    throw new PrivacyError('Privacy learning memory is full.');
  return validatePrivacyPreferences({
    ...selected,
    learningMemory: {
      ...memory,
      events: [...memory.events, event],
    },
  });
}

/** Proposals have no effect on the model-bound payload. */
export function suggestPrivacyGroupDefaults(
  preferences: PrivacyPreferences,
): readonly PrivacyGroupProposal[] {
  const selected = validatePrivacyPreferences(preferences);
  const memory = selected.learningMemory;
  if (!memory) return [];
  const grouped = new Map<string, PrivacyLearningMemory['events'][number][]>();
  for (const event of memory.events) {
    const key = JSON.stringify([
      event.scope.workspaceId,
      event.scope.sourceId,
      event.category,
    ]);
    grouped.set(key, [...(grouped.get(key) ?? []), event]);
  }
  const suppressed = new Set(memory.suppressedProposalIds);
  const proposals: PrivacyGroupProposal[] = [];
  for (const events of grouped.values()) {
    const first = events[0];
    const distinctValues = new Set(events.map((event) => event.fingerprint));
    const decisions = new Set(events.map((event) => event.decision));
    if (
      distinctValues.size < 3 ||
      decisions.size !== 1 ||
      (first.decision === 'allow' && sensitiveAllow.has(first.category))
    )
      continue;
    const id = createHash('sha256')
      .update(
        JSON.stringify([
          first.scope.workspaceId,
          first.scope.sourceId,
          first.category,
          first.decision,
        ]),
      )
      .digest('hex');
    if (suppressed.has(id)) continue;
    proposals.push({
      id,
      scope: first.scope,
      category: first.category,
      suggestedDefault: first.decision,
      distinctValues: distinctValues.size,
      decisionCount: events.length,
      requiresApproval: true,
    });
  }
  return proposals.sort((left, right) => left.id.localeCompare(right.id));
}

/** Honor a user's choice not to see this scoped group suggestion again. */
export function suppressPrivacyGroupProposal(
  preferences: PrivacyPreferences,
  proposalId: string,
): PrivacyPreferences {
  const selected = storedPreferences(preferences);
  if (!/^[a-f0-9]{64}$/.test(proposalId))
    throw new PrivacyError('Invalid privacy group proposal ID.');
  const memory = selected.learningMemory;
  if (!memory) throw new PrivacyError('Privacy group proposal is unavailable.');
  if (memory.suppressedProposalIds.includes(proposalId)) return selected;
  if (
    !suggestPrivacyGroupDefaults(selected).some(
      (item) => item.id === proposalId,
    )
  )
    throw new PrivacyError('Privacy group proposal is unavailable.');
  if (memory.suppressedProposalIds.length >= 64)
    throw new PrivacyError('Privacy group suppression memory is full.');
  return validatePrivacyPreferences({
    ...selected,
    learningMemory: {
      ...memory,
      suppressedProposalIds: [...memory.suppressedProposalIds, proposalId],
    },
  });
}
