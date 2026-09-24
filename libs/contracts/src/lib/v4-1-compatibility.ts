import { createHash } from 'node:crypto';

import {
  DEFAULT_STAGES,
  reconcilePlan,
  type ExecutionPlan,
  type WorkType,
  type WorkflowStageId,
} from './execution-plan.js';

export type V41Route = 'lightweight-engineering' | 'feature';
export type V41Boundary = 'final' | 'commit' | 'review' | 'publish';
export type V41EvidenceKind =
  'command' | 'diff' | 'document' | 'runtime' | 'review';

export type V41SkipPolicy =
  | { readonly allowed: false }
  | { readonly allowed: true; readonly whenCapabilityMissing: string };

export interface V41Requirement {
  readonly id: string;
  readonly sourceStep: string;
  readonly description: string;
  readonly allowedEvidenceKinds: readonly V41EvidenceKind[];
  readonly requiredCapabilities: readonly string[];
  readonly skip: V41SkipPolicy;
}

export interface V41Stage {
  readonly id: string;
  readonly assignment: {
    readonly owner: 'coordinator' | 'non-coordinator';
    readonly distinctFrom: readonly string[];
  };
  readonly requirements: readonly V41Requirement[];
}

export interface V41BoundaryRule {
  readonly requirements: readonly string[];
  readonly resolvedGates: readonly string[];
}

export interface V41ProfileRecord {
  readonly version: 1;
  readonly id: string;
  readonly route: V41Route;
  readonly playbook: { readonly path: string; readonly sha256: string };
  readonly hostCapabilities: readonly string[];
  readonly stages: readonly V41Stage[];
  readonly boundaries: Readonly<Record<V41Boundary, V41BoundaryRule>>;
}

export interface V41ProfileIdentity {
  readonly sourceRevision: string;
  readonly profileSha256: string;
}

export interface V41ParsedProfile {
  readonly identity: V41ProfileIdentity;
  readonly profile: V41ProfileRecord;
  readonly validation: 'structural-only';
}

export type V41PlanBoundaryStatus = 'supported' | 'blocked' | 'incompatible';

export interface V41PlanBoundaryInput {
  readonly parsed: V41ParsedProfile;
  readonly boundary: V41Boundary;
  readonly playbookText: string;
  readonly workType: WorkType;
}

export interface V41PlanBoundary {
  readonly status: V41PlanBoundaryStatus;
  readonly source: V41ProfileIdentity;
  readonly profileId: string;
  readonly route: V41Route;
  readonly targetExecutionPlanVersion: 1;
  readonly targetStages: readonly WorkflowStageId[];
  readonly sourceStageIds: readonly string[];
  readonly stageMapping: Readonly<Record<WorkflowStageId, readonly string[]>>;
  readonly requiredGates: readonly string[];
  readonly plan: ExecutionPlan | null;
  readonly reason: string | null;
}

export interface V41RouteEvent {
  readonly version: 1;
  readonly kind: 'route';
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

export type V41ParseResult<T> =
  | { readonly status: 'valid'; readonly value: T }
  | { readonly status: 'invalid'; readonly reason: string };

export interface V41ProfileInput {
  readonly sourceRevision: string;
  readonly profileText: string;
  readonly expectedProfileSha256?: string;
}

const BOUNDARIES: readonly V41Boundary[] = [
  'final',
  'commit',
  'review',
  'publish',
];
const EVIDENCE_KINDS: readonly V41EvidenceKind[] = [
  'command',
  'diff',
  'document',
  'runtime',
  'review',
];
const IDENTIFIER = /^[a-z][a-z0-9-]*$/;
const REQUIREMENT_ID = /^[a-z][a-z0-9.-]*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SOURCE_REVISION = /^[a-f0-9]{40}$/;

const FEATURE_PLAYBOOK_PATH = '../../playbooks/feature.md';
const FEATURE_SOURCE_STAGE_IDS = [
  'shape',
  'build',
  'verify',
  'review',
  'delivery',
] as const;
const FEATURE_STAGE_MAPPING: Readonly<
  Record<WorkflowStageId, readonly string[]>
> = {
  investigate: ['shape'],
  plan: ['shape'],
  build: ['build'],
  review: ['review'],
  verify: ['verify'],
  deliver: ['delivery'],
};
const EMPTY_STAGE_MAPPING: Readonly<
  Record<WorkflowStageId, readonly string[]>
> = {
  investigate: [],
  plan: [],
  build: [],
  review: [],
  verify: [],
  deliver: [],
};

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

class CompatibilityParseError extends Error {}

function record(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CompatibilityParseError(`${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  where: string,
): void {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (
    actual.length !== keys.length ||
    actual.some((key, index) => key !== keys[index])
  ) {
    throw new CompatibilityParseError(`${where} has unknown or missing fields`);
  }
}

function text(value: unknown, where: string, pattern?: RegExp): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    (pattern !== undefined && !pattern.test(value))
  ) {
    throw new CompatibilityParseError(`${where} is invalid`);
  }
  return value;
}

function uniqueTexts(
  value: unknown,
  where: string,
  pattern?: RegExp,
): readonly string[] {
  if (!Array.isArray(value)) {
    throw new CompatibilityParseError(`${where} must be an array`);
  }
  const values = value.map((item, index) =>
    text(item, `${where}[${index}]`, pattern),
  );
  if (new Set(values).size !== values.length) {
    throw new CompatibilityParseError(`${where} contains duplicates`);
  }
  return values;
}

function parseSkip(value: unknown, where: string): V41SkipPolicy {
  const raw = record(value, where);
  if (raw.allowed === false) {
    exactKeys(raw, ['allowed'], where);
    return { allowed: false };
  }
  if (raw.allowed === true) {
    exactKeys(raw, ['allowed', 'whenCapabilityMissing'], where);
    return {
      allowed: true,
      whenCapabilityMissing: text(
        raw.whenCapabilityMissing,
        `${where}.whenCapabilityMissing`,
        IDENTIFIER,
      ),
    };
  }
  throw new CompatibilityParseError(`${where}.allowed is invalid`);
}

function parseRequirement(value: unknown, where: string): V41Requirement {
  const raw = record(value, where);
  const expected = [
    'id',
    'sourceStep',
    'description',
    'allowedEvidenceKinds',
    'skip',
  ];
  if (raw.requiredCapabilities !== undefined) {
    expected.push('requiredCapabilities');
  }
  exactKeys(raw, expected, where);
  const allowedEvidenceKinds = uniqueTexts(
    raw.allowedEvidenceKinds,
    `${where}.allowedEvidenceKinds`,
  );
  if (
    allowedEvidenceKinds.length === 0 ||
    allowedEvidenceKinds.some(
      (kind) => !EVIDENCE_KINDS.includes(kind as V41EvidenceKind),
    )
  ) {
    throw new CompatibilityParseError(
      `${where}.allowedEvidenceKinds contains an unsupported value`,
    );
  }
  return {
    id: text(raw.id, `${where}.id`, REQUIREMENT_ID),
    sourceStep: text(raw.sourceStep, `${where}.sourceStep`),
    description: text(raw.description, `${where}.description`),
    allowedEvidenceKinds: allowedEvidenceKinds as V41EvidenceKind[],
    requiredCapabilities: uniqueTexts(
      raw.requiredCapabilities ?? [],
      `${where}.requiredCapabilities`,
      IDENTIFIER,
    ),
    skip: parseSkip(raw.skip, `${where}.skip`),
  };
}

function parseStage(value: unknown, index: number): V41Stage {
  const where = `profile.stages[${index}]`;
  const raw = record(value, where);
  exactKeys(raw, ['id', 'assignment', 'requirements'], where);
  if (!Array.isArray(raw.requirements) || raw.requirements.length === 0) {
    throw new CompatibilityParseError(
      `${where}.requirements must not be empty`,
    );
  }
  const assignment = record(raw.assignment, `${where}.assignment`);
  exactKeys(assignment, ['owner', 'distinctFrom'], `${where}.assignment`);
  const owner = text(assignment.owner, `${where}.assignment.owner`);
  if (owner !== 'coordinator' && owner !== 'non-coordinator') {
    throw new CompatibilityParseError(`${where}.assignment.owner is invalid`);
  }
  return {
    id: text(raw.id, `${where}.id`, IDENTIFIER),
    assignment: {
      owner,
      distinctFrom: uniqueTexts(
        assignment.distinctFrom,
        `${where}.assignment.distinctFrom`,
        IDENTIFIER,
      ),
    },
    requirements: raw.requirements.map((item, requirementIndex) =>
      parseRequirement(item, `${where}.requirements[${requirementIndex}]`),
    ),
  };
}

function parseBoundary(value: unknown, where: string): V41BoundaryRule {
  const raw = record(value, where);
  exactKeys(raw, ['requirements', 'resolvedGates'], where);
  return {
    requirements: uniqueTexts(
      raw.requirements,
      `${where}.requirements`,
      REQUIREMENT_ID,
    ),
    resolvedGates: uniqueTexts(raw.resolvedGates, `${where}.resolvedGates`),
  };
}

function parseProfile(value: unknown): V41ProfileRecord {
  const raw = record(value, 'profile');
  exactKeys(
    raw,
    [
      'version',
      'id',
      'route',
      'playbook',
      'hostCapabilities',
      'stages',
      'boundaries',
    ],
    'profile',
  );
  if (raw.version !== 1) {
    throw new CompatibilityParseError('profile.version must be 1');
  }
  const route = text(raw.route, 'profile.route');
  if (route !== 'lightweight-engineering' && route !== 'feature') {
    throw new CompatibilityParseError('profile.route is invalid');
  }
  const playbook = record(raw.playbook, 'profile.playbook');
  exactKeys(playbook, ['path', 'sha256'], 'profile.playbook');
  const playbookPath = text(playbook.path, 'profile.playbook.path');
  if (playbookPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(playbookPath)) {
    throw new CompatibilityParseError('profile.playbook.path must be relative');
  }
  const playbookSha256 = text(
    playbook.sha256,
    'profile.playbook.sha256',
    SHA256,
  );
  if (!Array.isArray(raw.stages) || raw.stages.length === 0) {
    throw new CompatibilityParseError('profile.stages must not be empty');
  }
  const stages = raw.stages.map(parseStage);
  const stageIds = stages.map((stage) => stage.id);
  if (new Set(stageIds).size !== stageIds.length) {
    throw new CompatibilityParseError('profile stage ids must be unique');
  }
  const requirementIds = stages.flatMap((stage) =>
    stage.requirements.map((requirement) => requirement.id),
  );
  if (new Set(requirementIds).size !== requirementIds.length) {
    throw new CompatibilityParseError('profile requirement ids must be unique');
  }
  for (const stage of stages) {
    const invalidReference = stage.assignment.distinctFrom.find(
      (stageId) => stageId === stage.id || !stageIds.includes(stageId),
    );
    if (invalidReference !== undefined) {
      throw new CompatibilityParseError(
        `profile stage ${stage.id} has invalid distinctFrom stage ${invalidReference}`,
      );
    }
  }
  const boundaryObject = record(raw.boundaries, 'profile.boundaries');
  exactKeys(boundaryObject, BOUNDARIES, 'profile.boundaries');
  const boundaries = Object.fromEntries(
    BOUNDARIES.map((boundary) => [
      boundary,
      parseBoundary(boundaryObject[boundary], `profile.boundaries.${boundary}`),
    ]),
  ) as Record<V41Boundary, V41BoundaryRule>;
  for (const [boundary, rule] of Object.entries(boundaries)) {
    const unknown = rule.requirements.find(
      (id) => !requirementIds.includes(id),
    );
    if (unknown !== undefined) {
      throw new CompatibilityParseError(
        `profile boundary ${boundary} references unknown requirement ${unknown}`,
      );
    }
  }
  return {
    version: 1,
    id: text(raw.id, 'profile.id', IDENTIFIER),
    route: route as V41Route,
    playbook: { path: playbookPath, sha256: playbookSha256 },
    hostCapabilities: uniqueTexts(
      raw.hostCapabilities,
      'profile.hostCapabilities',
      IDENTIFIER,
    ),
    stages,
    boundaries,
  };
}

function parseAssignments(
  value: unknown,
  where: string,
): Readonly<Record<string, string>> {
  const raw = record(value, where);
  const assignments: Record<string, string> = {};
  for (const [stageId, actor] of Object.entries(raw)) {
    assignments[text(stageId, `${where} stage`, IDENTIFIER)] = text(
      actor,
      `${where}.${stageId}`,
    );
  }
  return assignments;
}

function parseRouteEvent(value: unknown): V41RouteEvent {
  const raw = record(value, 'route event');
  exactKeys(
    raw,
    [
      'version',
      'kind',
      'sequence',
      'at',
      'actor',
      'profilePath',
      'profileId',
      'profileSha256',
      'capabilities',
      'assignments',
      'fromProfileId',
      'invalidatedRequirementIds',
    ],
    'route event',
  );
  if (raw.version !== 1 || raw.kind !== 'route') {
    throw new CompatibilityParseError('route event version or kind is invalid');
  }
  if (
    typeof raw.sequence !== 'number' ||
    !Number.isSafeInteger(raw.sequence) ||
    raw.sequence < 1
  ) {
    throw new CompatibilityParseError('route event.sequence is invalid');
  }
  const fromProfileId =
    raw.fromProfileId === null
      ? null
      : text(raw.fromProfileId, 'route event.fromProfileId', IDENTIFIER);
  return {
    version: 1,
    kind: 'route',
    sequence: raw.sequence,
    at: text(raw.at, 'route event.at'),
    actor: text(raw.actor, 'route event.actor'),
    profilePath: text(raw.profilePath, 'route event.profilePath'),
    profileId: text(raw.profileId, 'route event.profileId', IDENTIFIER),
    profileSha256: text(raw.profileSha256, 'route event.profileSha256', SHA256),
    capabilities: uniqueTexts(
      raw.capabilities,
      'route event.capabilities',
      IDENTIFIER,
    ),
    assignments: parseAssignments(raw.assignments, 'route event.assignments'),
    fromProfileId,
    invalidatedRequirementIds: uniqueTexts(
      raw.invalidatedRequirementIds,
      'route event.invalidatedRequirementIds',
      REQUIREMENT_ID,
    ),
  };
}

function invalid<T>(error: unknown): V41ParseResult<T> {
  return {
    status: 'invalid',
    reason: error instanceof Error ? error.message : String(error),
  };
}

/** Parse a v4.1 profile without translating it into an executable Nx plan. */
export function parseV41Profile(
  input: V41ProfileInput,
): V41ParseResult<V41ParsedProfile> {
  try {
    const sourceRevision = text(
      input.sourceRevision,
      'sourceRevision',
      SOURCE_REVISION,
    );
    const profileText = text(input.profileText, 'profileText');
    const profileSha256 = sha256(profileText);
    if (input.expectedProfileSha256 !== undefined) {
      const expectedProfileSha256 = text(
        input.expectedProfileSha256,
        'expectedProfileSha256',
        SHA256,
      );
      if (expectedProfileSha256 !== profileSha256) {
        throw new CompatibilityParseError(
          'profileSha256 does not match profileText',
        );
      }
    }
    let value: unknown;
    try {
      value = JSON.parse(profileText);
    } catch {
      throw new CompatibilityParseError('profileText is not valid JSON');
    }
    return {
      status: 'valid',
      value: {
        identity: { sourceRevision, profileSha256 },
        profile: parseProfile(value),
        validation: 'structural-only',
      },
    };
  } catch (error) {
    return invalid(error);
  }
}

/** Parse a v4.1 route event while retaining its local profile path as data. */
export function parseV41RouteEvent(
  value: unknown,
): V41ParseResult<V41RouteEvent> {
  try {
    return { status: 'valid', value: parseRouteEvent(value) };
  } catch (error) {
    return invalid(error);
  }
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length && left.every((value) => right.includes(value))
  );
}

function boundaryResult(
  input: V41PlanBoundaryInput,
  status: V41PlanBoundaryStatus,
  reason: string | null,
  plan: ExecutionPlan | null,
): V41PlanBoundary {
  const { parsed } = input;
  return {
    status,
    source: parsed.identity,
    profileId: parsed.profile.id,
    route: parsed.profile.route,
    targetExecutionPlanVersion: 1,
    targetStages: DEFAULT_STAGES,
    sourceStageIds: parsed.profile.stages.map((stage) => stage.id),
    stageMapping:
      parsed.profile.route === 'feature'
        ? FEATURE_STAGE_MAPPING
        : EMPTY_STAGE_MAPPING,
    requiredGates: parsed.profile.boundaries[input.boundary].resolvedGates,
    plan,
    reason,
  };
}

/**
 * Assess the only currently verified v4.1 profile-to-plan mapping.
 * Structural parsing alone never creates an executable plan. The mapping is
 * explicit because the source profile order differs from the canonical Nx
 * stage order, and unresolved source gates remain a blocked boundary.
 */
export function assessV41PlanBoundary(
  input: V41PlanBoundaryInput,
): V41PlanBoundary {
  const profile = input.parsed.profile;
  const sourceStageIds = profile.stages.map((stage) => stage.id);

  if (profile.route !== 'feature') {
    return boundaryResult(
      input,
      'incompatible',
      'Only the verified feature route has an explicit Nx stage mapping.',
      null,
    );
  }

  if (profile.playbook.path !== FEATURE_PLAYBOOK_PATH) {
    return boundaryResult(
      input,
      'incompatible',
      'Profile playbook path is not the verified feature playbook.',
      null,
    );
  }

  if (sha256(input.playbookText) !== profile.playbook.sha256) {
    return boundaryResult(
      input,
      'blocked',
      'Playbook bytes do not match the profile hash.',
      null,
    );
  }

  if (!sameSet(profile.hostCapabilities, ['subagents', 'forge'])) {
    return boundaryResult(
      input,
      'incompatible',
      'Feature profile capabilities do not match the verified route.',
      null,
    );
  }

  if (!sameSet(sourceStageIds, FEATURE_SOURCE_STAGE_IDS)) {
    return boundaryResult(
      input,
      'incompatible',
      'Feature profile stages do not match the verified source mapping.',
      null,
    );
  }

  const unsupportedCapability = profile.stages
    .flatMap((stage) => stage.requirements)
    .flatMap((requirement) => requirement.requiredCapabilities)
    .find((capability) => !['subagents', 'forge'].includes(capability));
  if (unsupportedCapability !== undefined) {
    return boundaryResult(
      input,
      'blocked',
      `Feature profile requires an unmapped capability: ${unsupportedCapability}.`,
      null,
    );
  }

  const requiredGates = profile.boundaries[input.boundary].resolvedGates;
  if (requiredGates.length > 0) {
    return boundaryResult(
      input,
      'blocked',
      `Source boundary requires unresolved gates: ${requiredGates.join(', ')}.`,
      null,
    );
  }

  return boundaryResult(
    input,
    'supported',
    null,
    reconcilePlan({
      workType: input.workType,
      delegation: 'required',
      review: 'independent',
      evidence: 'revision-bound',
      delivery: 'pull-request',
    }),
  );
}
