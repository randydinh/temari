import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type {
  Boundary,
  BoundaryRule,
  AssignmentVerdict,
  EvidenceKind,
  Profile,
  Requirement,
  Route,
  SkipPolicy,
  Stage,
} from "./types.ts";
import { WorkflowError } from "./types.ts";

const BOUNDARIES: readonly Boundary[] = ["final", "commit", "review", "publish"];
const EVIDENCE_KINDS: readonly EvidenceKind[] = ["command", "diff", "document", "runtime", "review"];
const IDENTIFIER = /^[a-z][a-z0-9-]*$/;
const REQUIREMENT_ID = /^[a-z][a-z0-9.-]*$/;
const SHA256 = /^[a-f0-9]{64}$/;

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkflowError(`${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], where: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new WorkflowError(`${where} has unknown or missing fields`);
  }
}

function string(value: unknown, where: string, pattern?: RegExp): string {
  if (typeof value !== "string" || value.length === 0 || (pattern !== undefined && !pattern.test(value))) {
    throw new WorkflowError(`${where} is invalid`);
  }
  return value;
}

function stringArray(value: unknown, where: string, allowed?: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) {
    throw new WorkflowError(`${where} must be an array`);
  }
  const parsed = value.map((item, index) => string(item, `${where}[${index}]`));
  if (new Set(parsed).size !== parsed.length || (allowed !== undefined && parsed.some((item) => !allowed.includes(item)))) {
    throw new WorkflowError(`${where} contains an invalid or duplicate value`);
  }
  return parsed;
}

function parseSkip(value: unknown, where: string): SkipPolicy {
  const raw = record(value, where);
  if (raw.allowed === false) {
    exactKeys(raw, ["allowed"], where);
    return { allowed: false };
  }
  if (raw.allowed === true) {
    exactKeys(raw, ["allowed", "whenCapabilityMissing"], where);
    return { allowed: true, whenCapabilityMissing: string(raw.whenCapabilityMissing, `${where}.whenCapabilityMissing`, IDENTIFIER) };
  }
  throw new WorkflowError(`${where}.allowed must be a boolean`);
}

function parseRequirement(value: unknown, where: string): Requirement {
  const raw = record(value, where);
  const keys = ["id", "sourceStep", "description", "allowedEvidenceKinds", "skip"];
  if (raw.requiredCapabilities !== undefined) keys.push("requiredCapabilities");
  exactKeys(raw, keys, where);
  const kinds = stringArray(raw.allowedEvidenceKinds, `${where}.allowedEvidenceKinds`, EVIDENCE_KINDS) as EvidenceKind[];
  if (kinds.length === 0) throw new WorkflowError(`${where}.allowedEvidenceKinds must not be empty`);
  return {
    id: string(raw.id, `${where}.id`, REQUIREMENT_ID),
    sourceStep: string(raw.sourceStep, `${where}.sourceStep`),
    description: string(raw.description, `${where}.description`),
    allowedEvidenceKinds: kinds,
    requiredCapabilities: stringArray(raw.requiredCapabilities ?? [], `${where}.requiredCapabilities`).map((item) => string(item, `${where}.requiredCapabilities`, IDENTIFIER)),
    skip: parseSkip(raw.skip, `${where}.skip`),
  };
}

function parseStage(value: unknown, index: number): Stage {
  const where = `profile.stages[${index}]`;
  const raw = record(value, where);
  exactKeys(raw, ["id", "assignment", "requirements"], where);
  if (!Array.isArray(raw.requirements) || raw.requirements.length === 0) {
    throw new WorkflowError(`${where}.requirements must be a non-empty array`);
  }
  const assignment = record(raw.assignment, `${where}.assignment`);
  exactKeys(assignment, ["owner", "distinctFrom"], `${where}.assignment`);
  const owner = string(assignment.owner, `${where}.assignment.owner`);
  if (owner !== "coordinator" && owner !== "non-coordinator") throw new WorkflowError(`${where}.assignment.owner is invalid`);
  return {
    id: string(raw.id, `${where}.id`, IDENTIFIER),
    assignment: {
      owner,
      distinctFrom: stringArray(assignment.distinctFrom, `${where}.assignment.distinctFrom`).map((item) => string(item, `${where}.assignment.distinctFrom`, IDENTIFIER)),
    },
    requirements: raw.requirements.map((item, requirementIndex) => parseRequirement(item, `${where}.requirements[${requirementIndex}]`)),
  };
}

function parseBoundary(value: unknown, where: string): BoundaryRule {
  const raw = record(value, where);
  exactKeys(raw, ["requirements", "resolvedGates"], where);
  return {
    requirements: stringArray(raw.requirements, `${where}.requirements`),
    resolvedGates: stringArray(raw.resolvedGates, `${where}.resolvedGates`),
  };
}

export async function loadProfile(profilePath: string, verifyPlaybook = true): Promise<Profile> {
  const absolutePath = resolve(profilePath);
  let text: string;
  try {
    text = await readFile(absolutePath, "utf8");
  } catch (error) {
    throw new WorkflowError(`cannot read profile ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new WorkflowError(`profile ${absolutePath} is not valid JSON`);
  }
  const raw = record(parsed, "profile");
  exactKeys(raw, ["version", "id", "route", "playbook", "hostCapabilities", "stages", "boundaries"], "profile");
  if (raw.version !== 1) throw new WorkflowError("profile.version must be 1");
  const route = string(raw.route, "profile.route") as Route;
  if (route !== "lightweight-engineering" && route !== "feature") throw new WorkflowError("profile.route is invalid");
  const playbook = record(raw.playbook, "profile.playbook");
  exactKeys(playbook, ["path", "sha256"], "profile.playbook");
  const playbookPath = string(playbook.path, "profile.playbook.path");
  if (isAbsolute(playbookPath)) throw new WorkflowError("profile.playbook.path must be relative");
  const playbookSha256 = string(playbook.sha256, "profile.playbook.sha256", SHA256);
  if (!Array.isArray(raw.stages) || raw.stages.length === 0) throw new WorkflowError("profile.stages must be a non-empty array");
  const stages = raw.stages.map(parseStage);
  const stageIds = stages.map((stage) => stage.id);
  const requirementIds = stages.flatMap((stage) => stage.requirements.map((requirement) => requirement.id));
  if (new Set(stageIds).size !== stageIds.length) throw new WorkflowError("profile stage ids must be unique");
  if (new Set(requirementIds).size !== requirementIds.length) throw new WorkflowError("profile requirement ids must be unique");
  for (const stage of stages) {
    const invalidReference = stage.assignment.distinctFrom.find((stageId) => stageId === stage.id || !stageIds.includes(stageId));
    if (invalidReference !== undefined) throw new WorkflowError(`profile stage ${stage.id} has invalid distinctFrom stage ${invalidReference}`);
  }
  const boundaryObject = record(raw.boundaries, "profile.boundaries");
  exactKeys(boundaryObject, BOUNDARIES, "profile.boundaries");
  const boundaries = Object.fromEntries(BOUNDARIES.map((boundary) => [boundary, parseBoundary(boundaryObject[boundary], `profile.boundaries.${boundary}`)])) as Record<Boundary, BoundaryRule>;
  for (const [boundary, rule] of Object.entries(boundaries)) {
    const unknown = rule.requirements.find((id) => !requirementIds.includes(id));
    if (unknown !== undefined) throw new WorkflowError(`profile boundary ${boundary} references unknown requirement ${unknown}`);
  }
  if (verifyPlaybook) {
    const canonicalPath = resolve(dirname(absolutePath), playbookPath);
    const actual = sha256(await readFile(canonicalPath));
    if (actual !== playbookSha256) throw new WorkflowError(`playbook drift for ${canonicalPath}: expected ${playbookSha256}, got ${actual}`);
  }
  const hostCapabilities = stringArray(raw.hostCapabilities, "profile.hostCapabilities").map((item) => string(item, "profile.hostCapabilities", IDENTIFIER));
  const declaredCapabilities = new Set(hostCapabilities);
  for (const stage of stages) {
    for (const requirement of stage.requirements) {
      for (const capability of requirement.requiredCapabilities) {
        if (!declaredCapabilities.has(capability)) throw new WorkflowError(`profile requirement ${requirement.id} requires undeclared capability ${capability}`);
      }
      if (requirement.skip.allowed && !declaredCapabilities.has(requirement.skip.whenCapabilityMissing)) {
        throw new WorkflowError(`profile requirement ${requirement.id} skips for undeclared capability ${requirement.skip.whenCapabilityMissing}`);
      }
    }
  }
  return {
    version: 1,
    id: string(raw.id, "profile.id", IDENTIFIER),
    route,
    profilePath: absolutePath,
    profileSha256: sha256(text),
    playbook: { path: playbookPath, sha256: playbookSha256 },
    hostCapabilities,
    stages,
    boundaries,
  };
}

export function assignmentVerdicts(profile: Profile, coordinator: string, assignments: Readonly<Record<string, string>>): readonly AssignmentVerdict[] {
  const stageVerdicts: AssignmentVerdict[] = profile.stages.map((stage) => {
    const owner = assignments[stage.id];
    if (owner === undefined) return { stageId: stage.id, state: "invalid", owner: null, reason: "stage has no assigned owner" };
    if (stage.assignment.owner === "coordinator" && owner !== coordinator) {
      return { stageId: stage.id, state: "invalid", owner, reason: "stage must be owned by the coordinator" };
    }
    if (stage.assignment.owner === "non-coordinator" && owner === coordinator) {
      return { stageId: stage.id, state: "invalid", owner, reason: "stage must be owned by a non-coordinator" };
    }
    const conflict = stage.assignment.distinctFrom.find((other) => assignments[other] === owner);
    if (conflict !== undefined) return { stageId: stage.id, state: "invalid", owner, reason: `stage owner must differ from ${conflict}` };
    return { stageId: stage.id, state: "valid", owner };
  });
  const stageIds = new Set(profile.stages.map((stage) => stage.id));
  const unknownVerdicts: AssignmentVerdict[] = Object.entries(assignments)
    .filter(([stageId]) => !stageIds.has(stageId))
    .map(([stageId, owner]) => ({ stageId, state: "invalid", owner, reason: "assignment references an unknown stage" }));
  return [...stageVerdicts, ...unknownVerdicts];
}

export function requirementById(profile: Profile, requirementId: string): { readonly stage: Stage; readonly requirement: Requirement } {
  for (const stage of profile.stages) {
    const requirement = stage.requirements.find((candidate) => candidate.id === requirementId);
    if (requirement !== undefined) return { stage, requirement };
  }
  throw new WorkflowError(`unknown requirement ${requirementId}`);
}
