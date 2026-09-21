import { stat } from "node:fs/promises";
import { join } from "node:path";
import { fileSha256, gateEvents, parseEvidence, parseSkip, readJson, recordPath, repositoryRevision, type RunContext } from "./store.ts";
import { assignmentVerdicts, requirementById } from "./profiles.ts";
import type { AssignmentVerdict, Boundary, BoundaryVerdict, EvidenceRecord, Receipt, RequirementVerdict, SkipRecord } from "./types.ts";
import { WorkflowError } from "./types.ts";

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_HEAD = /^[a-f0-9]{40,64}$/;
export const GATE_ACTOR_IDENTITY_LIMITATION = "Gate actor identity is host-reported and not cryptographically verified.";

function object(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new WorkflowError(`${where} must be an object`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, expected: readonly string[], where: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new WorkflowError(`${where} has unknown or missing fields`);
}

function text(value: unknown, where: string, pattern?: RegExp): string {
  if (typeof value !== "string" || value.length === 0 || (pattern !== undefined && !pattern.test(value))) throw new WorkflowError(`${where} is invalid`);
  return value;
}

function parseBoundaryName(value: unknown, where: string): Boundary {
  if (value === "final" || value === "commit" || value === "review" || value === "publish") return value;
  throw new WorkflowError(`${where} is invalid`);
}

function parseVerdict(value: unknown): BoundaryVerdict {
  const raw = object(value, "receipt.verdict");
  exact(raw, ["boundary", "passed", "profileId", "profileSha256", "repositoryHead", "worktreeFingerprint", "assignments", "requirements", "gates"], "receipt.verdict");
  if (typeof raw.passed !== "boolean") throw new WorkflowError("receipt.verdict.passed must be a boolean");
  if (!Array.isArray(raw.assignments) || !Array.isArray(raw.requirements) || !Array.isArray(raw.gates)) throw new WorkflowError("receipt verdict collections must be arrays");
  const assignments = raw.assignments.map((value, index): AssignmentVerdict => {
    const item = object(value, `receipt.verdict.assignments[${index}]`);
    const stageId = text(item.stageId, `receipt.verdict.assignments[${index}].stageId`);
    if (item.state === "valid") {
      exact(item, ["stageId", "state", "owner"], `receipt.verdict.assignments[${index}]`);
      return { stageId, state: "valid", owner: text(item.owner, `receipt.verdict.assignments[${index}].owner`) };
    }
    if (item.state === "invalid") {
      exact(item, ["stageId", "state", "owner", "reason"], `receipt.verdict.assignments[${index}]`);
      if (item.owner !== null && typeof item.owner !== "string") throw new WorkflowError(`receipt.verdict.assignments[${index}].owner is invalid`);
      return { stageId, state: "invalid", owner: item.owner, reason: text(item.reason, `receipt.verdict.assignments[${index}].reason`) };
    }
    throw new WorkflowError(`receipt.verdict.assignments[${index}].state is invalid`);
  });
  const requirements = raw.requirements.map((value, index): RequirementVerdict => {
    const item = object(value, `receipt.verdict.requirements[${index}]`);
    const requirementId = text(item.requirementId, `receipt.verdict.requirements[${index}].requirementId`);
    if (item.state === "satisfied" || item.state === "skipped") {
      exact(item, ["requirementId", "state", "recordPath"], `receipt.verdict.requirements[${index}]`);
      return { requirementId, state: item.state, recordPath: text(item.recordPath, `receipt.verdict.requirements[${index}].recordPath`) };
    }
    if (item.state === "pending") {
      exact(item, ["requirementId", "state", "reason"], `receipt.verdict.requirements[${index}]`);
      return { requirementId, state: "pending", reason: text(item.reason, `receipt.verdict.requirements[${index}].reason`) };
    }
    if (item.state === "invalid") {
      exact(item, ["requirementId", "state", "reason", "recordPath"], `receipt.verdict.requirements[${index}]`);
      return { requirementId, state: "invalid", reason: text(item.reason, `receipt.verdict.requirements[${index}].reason`), recordPath: text(item.recordPath, `receipt.verdict.requirements[${index}].recordPath`) };
    }
    throw new WorkflowError(`receipt.verdict.requirements[${index}].state is invalid`);
  });
  const gates = raw.gates.map((value, index) => {
    const item = object(value, `receipt.verdict.gates[${index}]`);
    exact(item, ["gateId", "state"], `receipt.verdict.gates[${index}]`);
    if (item.state !== "resolved" && item.state !== "open" && item.state !== "missing" && item.state !== "stale") throw new WorkflowError(`receipt.verdict.gates[${index}].state is invalid`);
    return { gateId: text(item.gateId, `receipt.verdict.gates[${index}].gateId`), state: item.state as "resolved" | "open" | "missing" | "stale" };
  });
  return { boundary: parseBoundaryName(raw.boundary, "receipt.verdict.boundary"), passed: raw.passed, profileId: text(raw.profileId, "receipt.verdict.profileId"), profileSha256: text(raw.profileSha256, "receipt.verdict.profileSha256", SHA256), repositoryHead: text(raw.repositoryHead, "receipt.verdict.repositoryHead", GIT_HEAD), worktreeFingerprint: text(raw.worktreeFingerprint, "receipt.verdict.worktreeFingerprint", SHA256), assignments, requirements, gates };
}

export function parseReceipt(value: unknown): Receipt {
  const raw = object(value, "receipt");
  exact(raw, ["version", "runId", "createdAt", "boundary", "profileId", "profileSha256", "repositoryHead", "worktreeFingerprint", "limitation", "verdict"], "receipt");
  if (raw.version !== 1) throw new WorkflowError("receipt.version must be 1");
  const receipt: Receipt = { version: 1, runId: text(raw.runId, "receipt.runId"), createdAt: text(raw.createdAt, "receipt.createdAt"), boundary: parseBoundaryName(raw.boundary, "receipt.boundary"), profileId: text(raw.profileId, "receipt.profileId"), profileSha256: text(raw.profileSha256, "receipt.profileSha256", SHA256), repositoryHead: text(raw.repositoryHead, "receipt.repositoryHead", GIT_HEAD), worktreeFingerprint: text(raw.worktreeFingerprint, "receipt.worktreeFingerprint", SHA256), limitation: text(raw.limitation, "receipt.limitation"), verdict: parseVerdict(raw.verdict) };
  if (receipt.limitation !== GATE_ACTOR_IDENTITY_LIMITATION) throw new WorkflowError("receipt.limitation is invalid");
  if (receipt.boundary !== receipt.verdict.boundary || receipt.profileId !== receipt.verdict.profileId || receipt.profileSha256 !== receipt.verdict.profileSha256 || receipt.repositoryHead !== receipt.verdict.repositoryHead || receipt.worktreeFingerprint !== receipt.verdict.worktreeFingerprint || !receipt.verdict.passed) throw new WorkflowError("receipt fields do not match its passing verdict");
  return receipt;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function requirementVerdict(run: RunContext, requirementId: string, revision: { readonly head: string; readonly fingerprint: string }): Promise<RequirementVerdict> {
  const { stage, requirement } = requirementById(run.profile, requirementId);
  const evidencePath = recordPath(run, stage.id, requirementId, "evidence");
  const skipPath = recordPath(run, stage.id, requirementId, "skip");
  const hasEvidence = await exists(evidencePath);
  const hasSkip = await exists(skipPath);
  if (hasEvidence && hasSkip) return { requirementId, state: "invalid", reason: "both evidence and skip records exist", recordPath: evidencePath };
  if (hasEvidence) {
    let record: EvidenceRecord;
    try {
      record = parseEvidence(await readJson(evidencePath));
    } catch (error) {
      return { requirementId, state: "invalid", reason: error instanceof Error ? error.message : String(error), recordPath: evidencePath };
    }
    if (record.requirementId !== requirementId || record.stageId !== stage.id) return { requirementId, state: "invalid", reason: "evidence record identity does not match its path", recordPath: evidencePath };
    if (record.profileId !== run.profile.id || record.profileSha256 !== run.profile.profileSha256) return { requirementId, state: "invalid", reason: "evidence belongs to an inactive profile revision", recordPath: evidencePath };
    if (record.producer !== run.assignments[stage.id]) return { requirementId, state: "invalid", reason: "evidence producer is not the assigned stage owner", recordPath: evidencePath };
    if (record.repositoryHead !== revision.head || record.worktreeFingerprint !== revision.fingerprint) return { requirementId, state: "invalid", reason: "evidence belongs to a different repository revision", recordPath: evidencePath };
    if (!requirement.allowedEvidenceKinds.includes(record.evidenceKind)) return { requirementId, state: "invalid", reason: `evidence kind ${record.evidenceKind} is not allowed`, recordPath: evidencePath };
    try {
      if ((await fileSha256(join(run.runDirectory, record.evidencePath))) !== record.evidenceSha256) return { requirementId, state: "invalid", reason: "evidence hash does not match the recorded artifact", recordPath: evidencePath };
    } catch {
      return { requirementId, state: "invalid", reason: "evidence artifact is missing", recordPath: evidencePath };
    }
    return { requirementId, state: "satisfied", recordPath: evidencePath };
  }
  if (hasSkip) {
    let record: SkipRecord;
    try {
      record = parseSkip(await readJson(skipPath));
    } catch (error) {
      return { requirementId, state: "invalid", reason: error instanceof Error ? error.message : String(error), recordPath: skipPath };
    }
    if (record.requirementId !== requirementId || record.stageId !== stage.id) return { requirementId, state: "invalid", reason: "skip record identity does not match its path", recordPath: skipPath };
    if (record.profileId !== run.profile.id || record.profileSha256 !== run.profile.profileSha256) return { requirementId, state: "invalid", reason: "skip belongs to an inactive profile revision", recordPath: skipPath };
    if (record.producer !== run.assignments[stage.id]) return { requirementId, state: "invalid", reason: "skip producer is not the assigned stage owner", recordPath: skipPath };
    if (!requirement.skip.allowed || requirement.skip.whenCapabilityMissing !== record.allowedBy || run.capabilities.includes(record.allowedBy)) return { requirementId, state: "invalid", reason: "skip is not allowed by the active profile and host capabilities", recordPath: skipPath };
    return { requirementId, state: "skipped", recordPath: skipPath };
  }
  const missingCapabilities = requirement.requiredCapabilities.filter((capability) => !run.capabilities.includes(capability));
  return { requirementId, state: "pending", reason: missingCapabilities.length > 0 ? `missing host capabilities ${missingCapabilities.join(",")}` : "no evidence or allowed skip" };
}

export async function checkBoundary(run: RunContext, boundary: Boundary): Promise<BoundaryVerdict> {
  const rule = run.profile.boundaries[boundary];
  const revision = repositoryRevision(run.manifest.repositoryRoot);
  const assignments = assignmentVerdicts(run.profile, run.manifest.coordinator, run.assignments);
  const requirements = await Promise.all(rule.requirements.map((requirementId) => requirementVerdict(run, requirementId, revision)));
  const events = await gateEvents(run.runDirectory);
  const gates = rule.resolvedGates.map((gateId) => {
    const event = [...events].reverse().find((candidate) => candidate.gateId === gateId);
    if (event === undefined) return { gateId, state: "missing" as const };
    if (event.kind === "gate-opened") return { gateId, state: "open" as const };
    if (event.profileId !== run.profile.id || event.profileSha256 !== run.profile.profileSha256 || event.repositoryHead !== revision.head || event.worktreeFingerprint !== revision.fingerprint) return { gateId, state: "stale" as const };
    return { gateId, state: "resolved" as const };
  });
  return {
    boundary,
    passed: assignments.every((verdict) => verdict.state === "valid") && requirements.every((verdict) => verdict.state === "satisfied" || verdict.state === "skipped") && gates.every((gate) => gate.state === "resolved"),
    profileId: run.profile.id,
    profileSha256: run.profile.profileSha256,
    repositoryHead: revision.head,
    worktreeFingerprint: revision.fingerprint,
    assignments,
    requirements,
    gates,
  };
}

export async function createReceipt(run: RunContext, boundary: Boundary, actor: string, now: string): Promise<Receipt> {
  if (actor !== run.manifest.coordinator) throw new WorkflowError("only the coordinator may write a receipt");
  const verdict = await checkBoundary(run, boundary);
  if (!verdict.passed) throw new WorkflowError(`boundary ${boundary} is not satisfied`);
  const path = join(run.runDirectory, "receipt.json");
  if (await exists(path)) {
    const prior = parseReceipt(await readJson(path));
    if (prior.runId === run.manifest.runId && prior.boundary === boundary && prior.profileSha256 === verdict.profileSha256 && prior.repositoryHead === verdict.repositoryHead && prior.worktreeFingerprint === verdict.worktreeFingerprint) return prior;
    throw new WorkflowError("receipt.json exists for a different profile, boundary, or repository revision");
  }
  return {
    version: 1,
    runId: run.manifest.runId,
    createdAt: now,
    boundary,
    profileId: verdict.profileId,
    profileSha256: verdict.profileSha256,
    repositoryHead: verdict.repositoryHead,
    worktreeFingerprint: verdict.worktreeFingerprint,
    limitation: GATE_ACTOR_IDENTITY_LIMITATION,
    verdict,
  };
}
