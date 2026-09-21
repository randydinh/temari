import type {
  InvestigationCheckpoint,
  InvestigationRequest,
  InvestigationTask,
  KnowledgeProvider,
  WorkerBrief,
  WorkerResult,
} from '@temari/contracts';
import type { DesignUpdateOptions } from '@temari/knowledge';

export interface CitedEntry {
  readonly text: string;
  readonly findingIds: readonly string[];
  readonly evidenceIds: readonly string[];
}

export interface Proposal {
  readonly planImpact: readonly CitedEntry[];
  readonly governingConstraints: readonly CitedEntry[];
  readonly proposedSteps: readonly (CitedEntry & {
    readonly verification: string;
  })[];
}

export interface DraftAuthority {
  readonly schema: 1;
  readonly operation: 'create-local-plan-draft';
  readonly taskId: string;
  readonly taskDirectory: string;
  readonly destination: string;
  readonly taskEvidence: true;
}

export interface DraftIdentity {
  readonly id: string;
  readonly revision: string;
}

export interface DraftIssue {
  readonly id: string;
  readonly kind: 'retrieval-gap' | 'verification-gap' | 'remaining-question';
  readonly detail: string;
}

export interface DraftReview {
  readonly candidateSha256: string;
  readonly verdict: 'approve' | 'reject';
  readonly reason: string;
  readonly criteria: readonly {
    readonly criterion: string;
    readonly satisfied: boolean;
    readonly reason: string;
  }[];
  readonly issues: readonly {
    readonly issueId: string;
    readonly disposition: 'resolved' | 'preserved-open' | 'blocking';
    readonly reason: string;
  }[];
}

export interface DraftReviewInput {
  readonly candidate: { readonly markdown: string; readonly sha256: string };
  readonly destination: string;
  readonly authority: DraftAuthority;
  readonly task: InvestigationTask;
  readonly brief: WorkerBrief;
  readonly request: InvestigationRequest;
  readonly investigationResult: WorkerResult;
  readonly checkpoint: InvestigationCheckpoint;
  readonly proposal: Proposal;
  readonly issues: readonly DraftIssue[];
  readonly writer: DraftIdentity;
  readonly reviewer: DraftIdentity;
}

export interface LocalPlanDraftInput {
  readonly task: InvestigationTask;
  readonly brief: WorkerBrief;
  readonly request: InvestigationRequest;
  readonly provider: KnowledgeProvider;
  readonly investigationResult: WorkerResult;
  readonly proposal: Proposal;
  readonly destination: string;
  readonly title: string;
  readonly authority: { readonly path: string; readonly sha256: string };
  readonly writer: DraftIdentity;
  readonly reviewer: DraftIdentity & {
    readonly review: (input: DraftReviewInput) => Promise<DraftReview>;
  };
}

export type ConversationDraftIntent = Pick<
  LocalPlanDraftInput,
  'task' | 'brief' | 'request' | 'destination' | 'title' | 'authority'
>;

export type JudgmentRole = 'assess' | 'propose' | 'review';

export interface ProposalInput {
  readonly brief: WorkerBrief;
  readonly request: InvestigationRequest;
  readonly investigationResult: WorkerResult;
  readonly checkpoint: InvestigationCheckpoint;
}

export interface ConversationDraftDependencies {
  readonly provider: KnowledgeProvider;
  readonly assessor: DraftIdentity & {
    readonly assess: DesignUpdateOptions['assess'];
  };
  readonly writer: DraftIdentity & {
    readonly propose: (input: ProposalInput) => Promise<Proposal>;
  };
  readonly reviewer: LocalPlanDraftInput['reviewer'];
  readonly checkReady: (roles: readonly JudgmentRole[]) => Promise<void>;
}

export type ConversationDraftCommand =
  | { readonly kind: 'start'; readonly intent: ConversationDraftIntent }
  | {
      readonly kind: 'resume';
      readonly task: InvestigationTask;
      readonly destination: string;
    };

export type ConversationDraftOutcome =
  | {
      readonly kind: 'draft';
      readonly investigation: WorkerResult;
      readonly draft: WorkerResult;
      readonly checkpointPath: string;
    }
  | {
      readonly kind: 'stopped';
      readonly result: WorkerResult;
      readonly investigation: WorkerResult | null;
      readonly checkpointPath: string | null;
    };
