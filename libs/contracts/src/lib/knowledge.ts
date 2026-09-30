import type { WorkerBrief } from './worker.js';

export interface KnowledgeSource {
  readonly provider: string;
  readonly id: string;
  readonly locator: string;
}
export interface KnowledgeDocument {
  readonly source: KnowledgeSource;
  readonly path: string;
}
export interface KnowledgeEvidence {
  readonly id: string;
  readonly document: KnowledgeDocument;
  readonly sha256: string;
  readonly archive?: {
    readonly schema: 1;
    readonly generation: string;
    readonly manifestSha256: string;
    readonly representationSha256: string;
    readonly extractorSettingsSha256: string;
    readonly coordinateSpace: 'extracted-text';
    readonly currentOriginal: 'not-checked';
    readonly omissions: readonly KnowledgeGap[];
  };
  readonly representation: {
    readonly method: string;
    readonly signature: string;
  };
  readonly span: {
    readonly unit: 'unicode-codepoint';
    readonly start: number;
    readonly end: number;
  };
  readonly excerpt: string;
}
export interface KnowledgeGap {
  readonly kind:
    | 'unsupported'
    | 'scope-refused'
    | 'changed'
    | 'unavailable'
    | 'unknown'
    | 'pending';
  readonly subject: string;
  readonly detail: string;
}
export type KnowledgeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly gap: KnowledgeGap };
export interface KnowledgeDiscoveryRequest {
  readonly scope: readonly KnowledgeSource[];
  readonly query: string;
  readonly limit: number;
  readonly maxBytes: number;
  readonly continuation: string | null;
}
export interface KnowledgeDiscovery {
  readonly snapshot: string;
  readonly documents: readonly {
    readonly document: KnowledgeDocument;
    readonly sha256: string;
    readonly applicability: string;
    readonly conflicts: readonly string[];
  }[];
  readonly sources: readonly {
    readonly source: KnowledgeSource;
    readonly generation: string;
    readonly scannedAt: string | null;
    readonly observation: string;
  }[];
  readonly coverage: {
    readonly indexed: number;
    readonly matched: number;
    readonly returned: number;
    readonly consumed: number;
    readonly remaining: number;
    readonly exhausted: boolean;
    readonly semanticRecall: 'not-evaluated';
  };
  readonly gaps: readonly KnowledgeGap[];
  readonly next: string | null;
}
export interface KnowledgeReadRequest {
  readonly document: KnowledgeDocument;
  readonly expectedSha256: string | null;
  readonly maxCodePoints: number;
  readonly maxBytes: number;
  readonly continuation: string | null;
}
export interface KnowledgeRead {
  readonly evidence: KnowledgeEvidence;
  readonly snapshot: string;
  readonly totalCodePoints: number;
  readonly next: string | null;
}
export interface KnowledgeCheck {
  readonly basis?: 'archive-snapshot' | 'current-source';
  readonly evidenceId: string;
  readonly state: 'unchanged' | 'changed' | 'unavailable' | 'unknown';
  readonly detail: string;
  readonly checkedAt: string;
}
export interface KnowledgeProvider {
  readonly identity: {
    readonly instance: string;
    readonly implementation: string;
    readonly configuration: string;
  };
  discover(
    request: KnowledgeDiscoveryRequest,
  ): Promise<KnowledgeResult<KnowledgeDiscovery>>;
  read(request: KnowledgeReadRequest): Promise<KnowledgeResult<KnowledgeRead>>;
  revalidate(evidence: KnowledgeEvidence): Promise<KnowledgeCheck>;
}
export interface KnowledgeSelection {
  readonly id: string;
  readonly document: KnowledgeDocument;
  readonly role: 'plan' | 'update' | 'constraint' | 'dependency';
  readonly requires: readonly string[];
}
export interface InvestigationRequest {
  readonly scope: readonly KnowledgeSource[];
  readonly query: string;
  readonly selections: readonly KnowledgeSelection[];
  readonly questions: readonly string[];
  readonly budget: {
    readonly discoveryPages: number;
    readonly documentsPerPage: number;
    readonly readPagesPerDocument: number;
    readonly codePointsPerRead: number;
    readonly responseBytes: number;
    readonly contextCodePoints: number;
  };
}
export interface KnowledgeFinding {
  readonly id: string;
  readonly proposition: string;
  readonly basis: 'explicit' | 'inferred' | 'unknown';
  readonly standing: 'proposed' | 'accepted' | 'deferred' | 'superseded';
  readonly supports: readonly string[];
  readonly contrary: readonly string[];
  readonly authorityEvidence: readonly string[];
  readonly affectedDecisions: readonly string[];
  readonly verificationGaps: readonly string[];
}
export interface KnowledgeAssessment {
  readonly findings: readonly KnowledgeFinding[];
  readonly assessedQuestions: readonly string[];
  readonly remainingQuestions: readonly string[];
  readonly rejectedAlternatives: readonly {
    readonly idea: string;
    readonly reason: string;
  }[];
  readonly completedActions: readonly {
    readonly id: string;
    readonly description: string;
    readonly evidenceIds: readonly string[];
  }[];
  readonly nextSafeStep: string;
}
export interface InvestigationTask {
  readonly id: string;
  readonly directory: string;
  readonly authorityRef: string;
}
export interface InvestigationCheckpoint {
  readonly schema: 1;
  readonly task: InvestigationTask;
  readonly provider: KnowledgeProvider['identity'];
  readonly request: InvestigationRequest;
  readonly trustedBrief: WorkerBrief;
  readonly suppliedContext: string;
  readonly contextEvidenceIds: readonly string[];
  readonly prior: string | null;
  readonly discovery: readonly KnowledgeDiscovery[];
  readonly discoveryNext: string | null;
  readonly discoveryStarted: boolean;
  readonly evidence: readonly KnowledgeEvidence[];
  readonly pendingReads: readonly KnowledgeReadRequest[];
  readonly gaps: readonly KnowledgeGap[];
  readonly checks: readonly KnowledgeCheck[];
  readonly readActions: readonly string[];
  readonly completedAssessments: readonly string[];
  readonly assessment: KnowledgeAssessment | null;
  readonly findingValidity: readonly {
    readonly id: string;
    readonly state: 'stale' | 'blocked' | 'needs-semantic-review';
  }[];
  readonly semanticReview: 'required';
  readonly coherence: 'sequential-checks-not-atomic';
}
