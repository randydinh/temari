import {
  PrivacyError,
  recordPrivacyLearningDecision,
  recordPrivacyOverride,
  resolvePrivacyOverride,
  suggestPrivacyGroupDefaults,
  suppressPrivacyGroupProposal,
  type PrivacyGroupProposal,
  type PrivacyLearningDecision,
  type PrivacyPersistenceChoice,
  type PrivacyPersistenceOffer,
  type PrivacyPreferences,
  type PrivacyRule,
} from '@temari/privacy';

/** The host owns this store and must use one coordinator for its writes. */
export interface PrivacyDecisionStore {
  load(): Promise<PrivacyPreferences>;
  save(preferences: PrivacyPreferences): Promise<void>;
}

export type ExplicitAllowChoice = {
  readonly id: string;
  readonly rule: PrivacyRule;
  readonly explicitUser: true;
};

export type PrivacyChoiceResult = {
  readonly persistenceOffer: PrivacyPersistenceOffer | null;
  /** Only proposals created by this choice; a settings view can list all pending proposals. */
  readonly newGroupProposals: readonly PrivacyGroupProposal[];
};

export interface PrivacyDecisionHost {
  allowOnce(choice: ExplicitAllowChoice): Promise<PrivacyChoiceResult>;
  maskOnce(choice: PrivacyLearningDecision): Promise<PrivacyChoiceResult>;
  resolveExactOffer(
    rule: PrivacyRule,
    choice: PrivacyPersistenceChoice,
  ): Promise<void>;
  pendingGroupProposals(
    scope: PrivacyLearningDecision['scope'],
  ): Promise<readonly PrivacyGroupProposal[]>;
  neverSuggestGroup(proposalId: string): Promise<void>;
}

function newProposals(
  before: PrivacyPreferences,
  after: PrivacyPreferences,
): readonly PrivacyGroupProposal[] {
  const prior = new Set(
    suggestPrivacyGroupDefaults(before).map((item) => item.id),
  );
  return suggestPrivacyGroupDefaults(after).filter(
    (item) => !prior.has(item.id),
  );
}

/** Turn a host-observed user action into one durable local update. */
export function createPrivacyDecisionHost(
  store: PrivacyDecisionStore,
): PrivacyDecisionHost {
  let tail: Promise<void> = Promise.resolve();
  const queue = <T>(work: () => Promise<T>): Promise<T> => {
    const result = tail.then(work);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return {
    allowOnce: (choice) =>
      queue(async () => {
        const before = await store.load();
        if (!choice.rule.scope.sourceId)
          throw new PrivacyError('An explicit allow needs a source scope.');
        const recorded = recordPrivacyOverride(before, choice.rule);
        const after = recordPrivacyLearningDecision(recorded.preferences, {
          id: choice.id,
          scope: {
            workspaceId: choice.rule.scope.workspaceId,
            sourceId: choice.rule.scope.sourceId,
          },
          category: choice.rule.category,
          decision: 'allow',
          value: choice.rule.value,
          explicitUser: choice.explicitUser,
        });
        if (
          after.learningMemory?.events.length ===
          before.learningMemory?.events.length
        )
          return { persistenceOffer: null, newGroupProposals: [] };
        await store.save(after);
        return {
          persistenceOffer: recorded.offer,
          newGroupProposals: newProposals(before, after),
        };
      }),
    maskOnce: (choice) =>
      queue(async () => {
        if (choice.decision !== 'mask')
          throw new PrivacyError('An explicit mask choice is required.');
        const before = await store.load();
        const after = recordPrivacyLearningDecision(before, choice);
        if (
          after.learningMemory?.events.length ===
          before.learningMemory?.events.length
        )
          return { persistenceOffer: null, newGroupProposals: [] };
        await store.save(after);
        return {
          persistenceOffer: null,
          newGroupProposals: newProposals(before, after),
        };
      }),
    resolveExactOffer: (rule, choice) =>
      queue(async () => {
        const before = await store.load();
        const after = resolvePrivacyOverride(before, rule, choice);
        if (choice !== 'not-now') await store.save(after);
      }),
    pendingGroupProposals: (scope) =>
      queue(async () =>
        suggestPrivacyGroupDefaults(await store.load()).filter(
          (item) =>
            item.scope.workspaceId === scope.workspaceId &&
            item.scope.sourceId === scope.sourceId,
        ),
      ),
    neverSuggestGroup: (proposalId) =>
      queue(async () => {
        const before = await store.load();
        const after = suppressPrivacyGroupProposal(before, proposalId);
        if (!before.learningMemory?.suppressedProposalIds.includes(proposalId))
          await store.save(after);
      }),
  };
}
