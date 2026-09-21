import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { link, mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { assignmentVerdicts, loadProfile, sha256 } from "./profiles.ts";
import type {
  EvidenceKind,
  EvidenceRecord,
  GateEvent,
  Profile,
  RouteEvent,
  RunManifest,
  SkipRecord,
  StartOptions,
} from "./types.ts";
import { WorkflowError } from "./types.ts";

const LOCK_FILE = ".workflow.lock";
const SHA256 = /^[a-f0-9]{64}$/;
const GIT_HEAD = /^[a-f0-9]{40,64}$/;
const IDENTIFIER = /^[a-z][a-z0-9-]*$/;
const REQUIREMENT_ID = /^[a-z][a-z0-9.-]*$/;

function object(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new WorkflowError(`${where} must be an object`);
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, expected: readonly string[], where: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new WorkflowError(`${where} has unknown or missing fields`);
}

function text(value: unknown, where: string): string {
  if (typeof value !== "string" || value.length === 0) throw new WorkflowError(`${where} must be a non-empty string`);
  return value;
}

function matchingText(value: unknown, where: string, pattern: RegExp): string {
  const parsed = text(value, where);
  if (!pattern.test(parsed)) throw new WorkflowError(`${where} has an invalid format`);
  return parsed;
}

function texts(value: unknown, where: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new WorkflowError(`${where} must be a string array`);
  return value as readonly string[];
}

function integer(value: unknown, where: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new WorkflowError(`${where} must be a positive integer`);
  return value as number;
}

export async function readJson(path: string): Promise<unknown> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    throw new WorkflowError(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(content);
  } catch {
    throw new WorkflowError(`${path} is not valid JSON`);
  }
}

export async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function atomicBytes(path: string, value: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temporary, value, { flag: "wx" });
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function processLives(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error !== null && typeof error === "object" && "code" in error && error.code === "EPERM";
  }
}

export async function withRunLock<T>(runDirectory: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(runDirectory, { recursive: true });
  const lockPath = join(runDirectory, LOCK_FILE);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      try {
        return await operation();
      } finally {
        const holder = (await readFile(lockPath, "utf8").catch(() => "")).trim();
        if (holder === String(process.pid)) await unlink(lockPath).catch(() => undefined);
      }
    } catch (error) {
      const code = error !== null && typeof error === "object" && "code" in error ? error.code : null;
      if (code !== "EEXIST") throw error;
      const holderText = (await readFile(lockPath, "utf8").catch(() => "")).trim();
      const holder = /^\d+$/.test(holderText) ? Number(holderText) : null;
      if (holder !== null && processLives(holder)) throw new WorkflowError(`workflow run is locked by pid ${holder}`);
      await unlink(lockPath).catch(() => undefined);
    }
  }
  throw new WorkflowError("could not acquire workflow run lock");
}

export function parseManifest(value: unknown): RunManifest {
  const raw = object(value, "manifest");
  keys(raw, ["version", "runId", "createdAt", "coordinator", "repositoryRoot", "capabilities", "assignments", "initialProfilePath"], "manifest");
  if (raw.version !== 1) throw new WorkflowError("manifest.version must be 1");
  const assignmentsRaw = object(raw.assignments, "manifest.assignments");
  const assignments: Record<string, string> = {};
  for (const [stage, actor] of Object.entries(assignmentsRaw)) assignments[text(stage, "manifest assignment stage")] = text(actor, `manifest.assignments.${stage}`);
  return {
    version: 1,
    runId: text(raw.runId, "manifest.runId"),
    createdAt: text(raw.createdAt, "manifest.createdAt"),
    coordinator: text(raw.coordinator, "manifest.coordinator"),
    repositoryRoot: resolve(text(raw.repositoryRoot, "manifest.repositoryRoot")),
    capabilities: texts(raw.capabilities, "manifest.capabilities"),
    assignments,
    initialProfilePath: resolve(text(raw.initialProfilePath, "manifest.initialProfilePath")),
  };
}

export function parseRouteEvent(value: unknown): RouteEvent {
  const raw = object(value, "route event");
  keys(raw, ["version", "kind", "sequence", "at", "actor", "profilePath", "profileId", "profileSha256", "capabilities", "assignments", "fromProfileId", "invalidatedRequirementIds"], "route event");
  if (raw.version !== 1 || raw.kind !== "route") throw new WorkflowError("route event version or kind is invalid");
  if (raw.fromProfileId !== null && typeof raw.fromProfileId !== "string") throw new WorkflowError("route event fromProfileId is invalid");
  const assignmentsRaw = object(raw.assignments, "route event assignments");
  const assignments: Record<string, string> = {};
  for (const [stage, actor] of Object.entries(assignmentsRaw)) assignments[matchingText(stage, "route event assignment stage", IDENTIFIER)] = text(actor, `route event.assignments.${stage}`);
  return {
    version: 1,
    kind: "route",
    sequence: integer(raw.sequence, "route event sequence"),
    at: text(raw.at, "route event at"),
    actor: text(raw.actor, "route event actor"),
    profilePath: resolve(text(raw.profilePath, "route event profilePath")),
    profileId: text(raw.profileId, "route event profileId"),
    profileSha256: matchingText(raw.profileSha256, "route event profileSha256", SHA256),
    capabilities: texts(raw.capabilities, "route event capabilities"),
    assignments,
    fromProfileId: raw.fromProfileId,
    invalidatedRequirementIds: texts(raw.invalidatedRequirementIds, "route event invalidatedRequirementIds"),
  };
}

export function parseGateEvent(value: unknown): GateEvent {
  const raw = object(value, "gate event");
  const common = ["version", "kind", "sequence", "at", "actor", "gateId", "repositoryHead", "worktreeFingerprint", "profileId", "profileSha256"];
  if (raw.kind === "gate-opened") {
    keys(raw, [...common, "summary"], "gate event");
    if (raw.version !== 1) throw new WorkflowError("gate event version is invalid");
    return { version: 1, kind: "gate-opened", sequence: integer(raw.sequence, "gate event sequence"), at: text(raw.at, "gate event at"), actor: text(raw.actor, "gate event actor"), gateId: text(raw.gateId, "gate event gateId"), summary: text(raw.summary, "gate event summary"), repositoryHead: matchingText(raw.repositoryHead, "gate event repositoryHead", GIT_HEAD), worktreeFingerprint: matchingText(raw.worktreeFingerprint, "gate event worktreeFingerprint", SHA256), profileId: text(raw.profileId, "gate event profileId"), profileSha256: matchingText(raw.profileSha256, "gate event profileSha256", SHA256) };
  }
  if (raw.kind === "gate-resolved") {
    keys(raw, [...common, "resolution"], "gate event");
    if (raw.version !== 1) throw new WorkflowError("gate event version is invalid");
    return { version: 1, kind: "gate-resolved", sequence: integer(raw.sequence, "gate event sequence"), at: text(raw.at, "gate event at"), actor: text(raw.actor, "gate event actor"), gateId: text(raw.gateId, "gate event gateId"), resolution: text(raw.resolution, "gate event resolution"), repositoryHead: matchingText(raw.repositoryHead, "gate event repositoryHead", GIT_HEAD), worktreeFingerprint: matchingText(raw.worktreeFingerprint, "gate event worktreeFingerprint", SHA256), profileId: text(raw.profileId, "gate event profileId"), profileSha256: matchingText(raw.profileSha256, "gate event profileSha256", SHA256) };
  }
  throw new WorkflowError("gate event kind is invalid");
}

export function parseEvidence(value: unknown): EvidenceRecord {
  const raw = object(value, "evidence record");
  keys(raw, ["version", "requirementId", "stageId", "evidenceKind", "evidencePath", "evidenceSha256", "producer", "at", "repositoryHead", "worktreeFingerprint", "profileId", "profileSha256"], "evidence record");
  if (raw.version !== 1) throw new WorkflowError("evidence record version is invalid");
  const evidenceKind = text(raw.evidenceKind, "evidence record evidenceKind") as EvidenceKind;
  if (!["command", "diff", "document", "runtime", "review"].includes(evidenceKind)) throw new WorkflowError("evidence record evidenceKind is invalid");
  const requirementId = matchingText(raw.requirementId, "evidence record requirementId", REQUIREMENT_ID);
  const stageId = matchingText(raw.stageId, "evidence record stageId", IDENTIFIER);
  const evidenceSha256 = matchingText(raw.evidenceSha256, "evidence record evidenceSha256", SHA256);
  const evidencePath = text(raw.evidencePath, "evidence record evidencePath");
  if (evidencePath !== evidenceArtifactPath(stageId, requirementId, evidenceSha256)) throw new WorkflowError("evidence record evidencePath is not the deterministic stage artifact path");
  return { version: 1, requirementId, stageId, evidenceKind, evidencePath, evidenceSha256, producer: text(raw.producer, "evidence record producer"), at: text(raw.at, "evidence record at"), repositoryHead: matchingText(raw.repositoryHead, "evidence record repositoryHead", GIT_HEAD), worktreeFingerprint: matchingText(raw.worktreeFingerprint, "evidence record worktreeFingerprint", SHA256), profileId: text(raw.profileId, "evidence record profileId"), profileSha256: matchingText(raw.profileSha256, "evidence record profileSha256", SHA256) };
}

export function parseSkip(value: unknown): SkipRecord {
  const raw = object(value, "skip record");
  keys(raw, ["version", "requirementId", "stageId", "reason", "allowedBy", "producer", "at", "profileId", "profileSha256"], "skip record");
  if (raw.version !== 1) throw new WorkflowError("skip record version is invalid");
  return { version: 1, requirementId: text(raw.requirementId, "skip record requirementId"), stageId: text(raw.stageId, "skip record stageId"), reason: text(raw.reason, "skip record reason"), allowedBy: text(raw.allowedBy, "skip record allowedBy"), producer: text(raw.producer, "skip record producer"), at: text(raw.at, "skip record at"), profileId: text(raw.profileId, "skip record profileId"), profileSha256: matchingText(raw.profileSha256, "skip record profileSha256", SHA256) };
}

async function jsonFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  });
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => join(directory, entry.name)).sort();
}

export async function routeEvents(runDirectory: string): Promise<readonly RouteEvent[]> {
  const paths = await jsonFiles(join(runDirectory, "events", "routes"));
  const events = await Promise.all(paths.map(async (path) => parseRouteEvent(await readJson(path))));
  events.forEach((event, index) => { if (event.sequence !== index + 1) throw new WorkflowError("route event sequence is not contiguous"); });
  if (events.length === 0) throw new WorkflowError("workflow run has no route event");
  return events;
}

export async function gateEvents(runDirectory: string): Promise<readonly GateEvent[]> {
  const paths = await jsonFiles(join(runDirectory, "events", "gates"));
  const events = await Promise.all(paths.map(async (path) => parseGateEvent(await readJson(path))));
  events.forEach((event, index) => { if (event.sequence !== index + 1) throw new WorkflowError("gate event sequence is not contiguous"); });
  return events;
}

export interface RunContext {
  readonly runDirectory: string;
  readonly manifest: RunManifest;
  readonly routes: readonly RouteEvent[];
  readonly profile: Profile;
  readonly capabilities: readonly string[];
  readonly assignments: Readonly<Record<string, string>>;
}

function activeRouteConfiguration(profile: Profile, manifest: RunManifest, active: RouteEvent): void {
  routeConfiguration(profile, manifest.coordinator, active.capabilities, active.assignments);
  const expectedStages = new Set(profile.stages.map((stage) => stage.id));
  if (Object.keys(active.assignments).length !== expectedStages.size || [...expectedStages].some((stage) => active.assignments[stage] === undefined)) {
    throw new WorkflowError("active route assignments do not cover exactly the active profile stages");
  }
}

export async function loadRun(runDirectory: string, options: { readonly verifyPlaybook?: boolean } = {}): Promise<RunContext> {
  const absolute = resolve(runDirectory);
  const manifest = parseManifest(await readJson(join(absolute, "run.json")));
  const routes = await routeEvents(absolute);
  const active = routes.at(-1)!;
  const profile = await loadProfile(active.profilePath, options.verifyPlaybook ?? true);
  if (profile.id !== active.profileId || profile.profileSha256 !== active.profileSha256) throw new WorkflowError("active profile does not match its route event");
  activeRouteConfiguration(profile, manifest, active);
  return { runDirectory: absolute, manifest, routes, profile, capabilities: active.capabilities, assignments: active.assignments };
}

function profileSnapshotPath(runDirectory: string, profileSha256: string): string {
  return join(runDirectory, "profiles", `${profileSha256}.json`);
}

async function ensureProfileSnapshot(runDirectory: string, profile: Profile): Promise<void> {
  const destination = profileSnapshotPath(runDirectory, profile.profileSha256);
  try {
    const current = await readFile(destination);
    if (sha256(current) !== profile.profileSha256) throw new WorkflowError(`profile snapshot ${destination} is corrupt`);
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    if (!(error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    await atomicBytes(destination, await readFile(profile.profilePath));
  }
}

export async function loadRunForPivot(runDirectory: string): Promise<RunContext> {
  const absolute = resolve(runDirectory);
  const manifest = parseManifest(await readJson(join(absolute, "run.json")));
  const routes = await routeEvents(absolute);
  const active = routes.at(-1)!;
  let profile = await loadProfile(active.profilePath, false);
  if (profile.id !== active.profileId || profile.profileSha256 !== active.profileSha256) {
    profile = await loadProfile(profileSnapshotPath(absolute, active.profileSha256), false);
  }
  if (profile.id !== active.profileId || profile.profileSha256 !== active.profileSha256) throw new WorkflowError("active profile does not match its route event or immutable snapshot");
  activeRouteConfiguration(profile, manifest, active);
  return { runDirectory: absolute, manifest, routes, profile, capabilities: active.capabilities, assignments: active.assignments };
}

export function repositoryRevision(repositoryRoot: string): { readonly head: string; readonly fingerprint: string } {
  try {
    const head = execFileSync("git", ["-C", repositoryRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const trackedDiff = execFileSync("git", ["-C", repositoryRoot, "-c", "diff.autoRefreshIndex=false", "diff", "--binary", "HEAD", "--"]);
    const untrackedOutput = execFileSync("git", ["-C", repositoryRoot, "ls-files", "--others", "--exclude-standard", "-z"]);
    const untracked = untrackedOutput.toString("utf8").split("\0").filter((path) => path.length > 0).sort();
    const hash = createHash("sha256").update(trackedDiff);
    for (const path of untracked) hash.update(path).update("\0").update(readFileSync(join(repositoryRoot, path))).update("\0");
    return { head, fingerprint: hash.digest("hex") };
  } catch {
    throw new WorkflowError(`repository ${repositoryRoot} must be a readable Git worktree`);
  }
}

function sequenceName(sequence: number): string {
  return `${String(sequence).padStart(6, "0")}.json`;
}

function sequenceDirectory(sequence: number): string {
  return String(sequence).padStart(6, "0");
}

export function routeConfiguration(
  profile: Profile,
  coordinator: string,
  capabilities: readonly string[],
  assignmentOptions: Readonly<Record<string, string>> = {},
  priorAssignments: Readonly<Record<string, string>> = {},
): { readonly capabilities: readonly string[]; readonly assignments: Readonly<Record<string, string>> } {
  if (coordinator.length === 0) throw new WorkflowError("coordinator must be a non-empty string");
  if (new Set(capabilities).size !== capabilities.length) throw new WorkflowError("claimed capabilities must be unique");
  const undeclaredCapability = capabilities.find((capability) => !profile.hostCapabilities.includes(capability));
  if (undeclaredCapability !== undefined) throw new WorkflowError(`claimed capability ${undeclaredCapability} is not declared by profile ${profile.id}`);
  const unknownAssignment = Object.keys(assignmentOptions).find((stage) => !profile.stages.some((candidate) => candidate.id === stage));
  if (unknownAssignment !== undefined) throw new WorkflowError(`assignment references unknown stage ${unknownAssignment}`);
  const assignments = Object.fromEntries(profile.stages.map((stage) => [stage.id, assignmentOptions[stage.id] ?? priorAssignments[stage.id] ?? coordinator]));
  const emptyAssignment = Object.entries(assignments).find(([, actor]) => actor.length === 0);
  if (emptyAssignment !== undefined) throw new WorkflowError(`assignment for stage ${emptyAssignment[0]} must be a non-empty string`);
  const invalidAssignment = assignmentVerdicts(profile, coordinator, assignments).find((verdict) => verdict.state === "invalid");
  if (invalidAssignment !== undefined) throw new WorkflowError(`invalid assignment for stage ${invalidAssignment.stageId}: ${invalidAssignment.reason}`);
  return { capabilities: [...capabilities], assignments };
}

export async function startRun(options: StartOptions): Promise<RunContext> {
  const runDirectory = resolve(options.runDirectory);
  const profile = await loadProfile(options.profilePath);
  const { capabilities, assignments } = routeConfiguration(profile, options.coordinator, options.capabilities ?? [], options.assignments);
  const repositoryRoot = resolve(options.repositoryRoot);
  repositoryRevision(repositoryRoot);
  return withRunLock(runDirectory, async () => {
    const manifestPath = join(runDirectory, "run.json");
    let manifest: RunManifest;
    try {
      await stat(manifestPath);
      manifest = parseManifest(await readJson(manifestPath));
      const same = manifest.repositoryRoot === repositoryRoot && manifest.coordinator === options.coordinator && manifest.initialProfilePath === profile.profilePath && JSON.stringify(manifest.assignments) === JSON.stringify(assignments) && JSON.stringify(manifest.capabilities) === JSON.stringify(capabilities);
      if (!same) throw new WorkflowError("workflow run already exists with different start options");
    } catch (error) {
      if (error instanceof WorkflowError) throw error;
      if (!(error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
      const now = options.now?.() ?? new Date().toISOString();
      manifest = { version: 1, runId: basename(runDirectory), createdAt: now, coordinator: options.coordinator, repositoryRoot, capabilities, assignments, initialProfilePath: profile.profilePath };
      await atomicJson(manifestPath, manifest);
    }
    await ensureProfileSnapshot(runDirectory, profile);
    const existingRoutes = await jsonFiles(join(runDirectory, "events", "routes"));
    if (existingRoutes.length === 0) {
      const route: RouteEvent = { version: 1, kind: "route", sequence: 1, at: manifest.createdAt, actor: options.coordinator, profilePath: profile.profilePath, profileId: profile.id, profileSha256: profile.profileSha256, capabilities, assignments, fromProfileId: null, invalidatedRequirementIds: [] };
      await atomicJson(join(runDirectory, "events", "routes", sequenceName(1)), route);
    }
    await mkdir(join(runDirectory, "events", "gates"), { recursive: true });
    for (const stage of profile.stages) await mkdir(join(runDirectory, "stages", stage.id, "records", sequenceDirectory(1)), { recursive: true });
    return loadRun(runDirectory);
  });
}

export async function appendRouteEvent(run: RunContext, profile: Profile, actor: string, capabilities: readonly string[], assignments: Readonly<Record<string, string>>, now: string): Promise<RouteEvent> {
  if (actor !== run.manifest.coordinator) throw new WorkflowError("only the coordinator may change the route");
  const current = run.routes.at(-1)!;
  if (current.profileSha256 === profile.profileSha256 && JSON.stringify(current.capabilities) === JSON.stringify(capabilities) && JSON.stringify(current.assignments) === JSON.stringify(assignments)) return current;
  const oldIds = new Set(run.profile.stages.flatMap((stage) => stage.requirements.map((requirement) => requirement.id)));
  const invalidated = [...oldIds];
  const event: RouteEvent = { version: 1, kind: "route", sequence: run.routes.length + 1, at: now, actor, profilePath: profile.profilePath, profileId: profile.id, profileSha256: profile.profileSha256, capabilities, assignments, fromProfileId: current.profileId, invalidatedRequirementIds: invalidated };
  await ensureProfileSnapshot(run.runDirectory, profile);
  await atomicJson(join(run.runDirectory, "events", "routes", sequenceName(event.sequence)), event);
  for (const stage of profile.stages) await mkdir(join(run.runDirectory, "stages", stage.id, "records", sequenceDirectory(event.sequence)), { recursive: true });
  return event;
}

type GateEventInput =
  | Omit<Extract<GateEvent, { readonly kind: "gate-opened" }>, "sequence">
  | Omit<Extract<GateEvent, { readonly kind: "gate-resolved" }>, "sequence">;

export async function appendGateEvent(run: RunContext, event: GateEventInput): Promise<GateEvent> {
  if (event.actor !== run.manifest.coordinator) throw new WorkflowError("only the coordinator may change gates");
  const existing = await gateEvents(run.runDirectory);
  const latest = [...existing].reverse().find((candidate) => candidate.gateId === event.gateId);
  if (latest !== undefined && latest.kind === event.kind && latest.profileSha256 === event.profileSha256 && latest.repositoryHead === event.repositoryHead && latest.worktreeFingerprint === event.worktreeFingerprint) {
    if (latest.kind === "gate-opened" && event.kind === "gate-opened" && latest.summary === event.summary) return latest;
    if (latest.kind === "gate-resolved" && event.kind === "gate-resolved" && latest.resolution === event.resolution) return latest;
    throw new WorkflowError(`gate ${event.gateId} already has a conflicting ${event.kind} event at this revision`);
  }
  if (event.kind === "gate-resolved") {
    const opened = existing.find((candidate) => candidate.gateId === event.gateId && candidate.kind === "gate-opened");
    if (opened === undefined) throw new WorkflowError(`gate ${event.gateId} has never been opened`);
  }
  const complete = { ...event, sequence: existing.length + 1 } as GateEvent;
  await atomicJson(join(run.runDirectory, "events", "gates", sequenceName(complete.sequence)), complete);
  return complete;
}

export function assertStageOwner(run: RunContext, stageId: string, actor: string): void {
  const owner = run.assignments[stageId];
  if (owner === undefined) throw new WorkflowError(`stage ${stageId} is not assigned in this run`);
  if (owner !== actor) throw new WorkflowError(`actor ${actor} does not own stage ${stageId}`);
}

export function recordPath(run: RunContext, stageId: string, requirementId: string, kind: "evidence" | "skip"): string {
  return join(run.runDirectory, "stages", stageId, "records", sequenceDirectory(run.routes.at(-1)!.sequence), `${requirementId}.${kind}.json`);
}

export function evidenceArtifactPath(stageId: string, requirementId: string, evidenceSha256: string): string {
  if (!IDENTIFIER.test(stageId) || !REQUIREMENT_ID.test(requirementId) || !SHA256.test(evidenceSha256)) {
    throw new WorkflowError("evidence artifact identity is invalid");
  }
  return join("stages", stageId, "evidence", `${requirementId}.${evidenceSha256}.evidence`);
}

async function writeBytesWithoutReplacement(destination: string, bytes: Uint8Array, expectedSha256: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const temporary = join(dirname(destination), `.${basename(destination)}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temporary, bytes, { flag: "wx" });
  try {
    await link(temporary, destination);
  } catch (error) {
    const code = error !== null && typeof error === "object" && "code" in error ? error.code : null;
    if (code !== "EEXIST") throw error;
    const existing = await readFile(destination);
    if (sha256(existing) !== expectedSha256) throw new WorkflowError(`evidence artifact ${destination} conflicts with its recorded content`);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function ingestEvidence(run: RunContext, stageId: string, requirementId: string, bytes: Uint8Array): Promise<{ readonly evidencePath: string; readonly evidenceSha256: string }> {
  const evidenceSha256 = sha256(bytes);
  const evidencePath = evidenceArtifactPath(stageId, requirementId, evidenceSha256);
  await writeBytesWithoutReplacement(join(run.runDirectory, evidencePath), bytes, evidenceSha256);
  return { evidencePath, evidenceSha256 };
}

export async function fileSha256(path: string): Promise<string> {
  return sha256(await readFile(path));
}
