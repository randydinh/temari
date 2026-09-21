export type Route = "lightweight-engineering" | "feature";
export type Boundary = "final" | "commit" | "review" | "publish";
export type EvidenceKind = "command" | "diff" | "document" | "runtime" | "review";

export type SkipPolicy =
  | { readonly allowed: false }
  | { readonly allowed: true; readonly whenCapabilityMissing: string };

export interface Requirement {
  readonly id: string;
  readonly sourceStep: string;
  readonly description: string;
  readonly allowedEvidenceKinds: readonly EvidenceKind[];
  readonly requiredCapabilities: readonly string[];
  readonly skip: SkipPolicy;
}

export interface Stage {
  readonly id: string;
  readonly assignment: {
    readonly owner: "coordinator" | "non-coordinator";
    readonly distinctFrom: readonly string[];
  };
  readonly requirements: readonly Requirement[];
}

export interface BoundaryRule {
  readonly requirements: readonly string[];
  readonly resolvedGates: readonly string[];
}

export interface Profile {
  readonly version: 1;
  readonly id: string;
  readonly route: Route;
  readonly profilePath: string;
  readonly profileSha256: string;
  readonly playbook: { readonly path: string; readonly sha256: string };
  readonly hostCapabilities: readonly string[];
  readonly stages: readonly Stage[];
  readonly boundaries: Readonly<Record<Boundary, BoundaryRule>>;
}

export interface RunManifest {
  readonly version: 1;
  readonly runId: string;
  readonly createdAt: string;
  readonly coordinator: string;
  readonly repositoryRoot: string;
  readonly capabilities: readonly string[];
  readonly assignments: Readonly<Record<string, string>>;
  readonly initialProfilePath: string;
}

export interface RouteEvent {
  readonly version: 1;
  readonly kind: "route";
  readonly sequence: number;
  readonly at: string;
  readonly actor: string;
  readonly profilePath: string;
  readonly profileId: string;
  readonly profileSha256: string;
  readonly capabilities: readonly string[];
  readonly assignments: Readonly<Record<string, string>>;
  readonly fromProfileId: string | null;
  readonly invalidatedRequirementIds: readonly string[];
}

export type GateEvent =
  | {
      readonly version: 1;
      readonly kind: "gate-opened";
      readonly sequence: number;
      readonly at: string;
      readonly actor: string;
      readonly gateId: string;
      readonly summary: string;
      readonly repositoryHead: string;
      readonly worktreeFingerprint: string;
      readonly profileId: string;
      readonly profileSha256: string;
    }
  | {
      readonly version: 1;
      readonly kind: "gate-resolved";
      readonly sequence: number;
      readonly at: string;
      readonly actor: string;
      readonly gateId: string;
      readonly resolution: string;
      readonly repositoryHead: string;
      readonly worktreeFingerprint: string;
      readonly profileId: string;
      readonly profileSha256: string;
    };

export interface EvidenceRecord {
  readonly version: 1;
  readonly requirementId: string;
  readonly stageId: string;
  readonly evidenceKind: EvidenceKind;
  readonly evidencePath: string;
  readonly evidenceSha256: string;
  readonly producer: string;
  readonly at: string;
  readonly repositoryHead: string;
  readonly worktreeFingerprint: string;
  readonly profileId: string;
  readonly profileSha256: string;
}

export interface SkipRecord {
  readonly version: 1;
  readonly requirementId: string;
  readonly stageId: string;
  readonly reason: string;
  readonly allowedBy: string;
  readonly producer: string;
  readonly at: string;
  readonly profileId: string;
  readonly profileSha256: string;
}

export type RequirementVerdict =
  | { readonly requirementId: string; readonly state: "satisfied"; readonly recordPath: string }
  | { readonly requirementId: string; readonly state: "skipped"; readonly recordPath: string }
  | { readonly requirementId: string; readonly state: "pending"; readonly reason: string }
  | { readonly requirementId: string; readonly state: "invalid"; readonly reason: string; readonly recordPath: string };

export interface BoundaryVerdict {
  readonly boundary: Boundary;
  readonly passed: boolean;
  readonly profileId: string;
  readonly profileSha256: string;
  readonly repositoryHead: string;
  readonly worktreeFingerprint: string;
  readonly assignments: readonly AssignmentVerdict[];
  readonly requirements: readonly RequirementVerdict[];
  readonly gates: readonly { readonly gateId: string; readonly state: "resolved" | "open" | "missing" | "stale" }[];
}

export type AssignmentVerdict =
  | { readonly stageId: string; readonly state: "valid"; readonly owner: string }
  | { readonly stageId: string; readonly state: "invalid"; readonly owner: string | null; readonly reason: string };

export interface Receipt {
  readonly version: 1;
  readonly runId: string;
  readonly createdAt: string;
  readonly boundary: Boundary;
  readonly profileId: string;
  readonly profileSha256: string;
  readonly repositoryHead: string;
  readonly worktreeFingerprint: string;
  readonly limitation: string;
  readonly verdict: BoundaryVerdict;
}

export interface StartOptions {
  readonly runDirectory: string;
  readonly profilePath: string;
  readonly repositoryRoot: string;
  readonly coordinator: string;
  readonly capabilities?: readonly string[];
  readonly assignments?: Readonly<Record<string, string>>;
  readonly now?: () => string;
}

export class WorkflowError extends Error {}
export class WorkflowUsageError extends WorkflowError {}
