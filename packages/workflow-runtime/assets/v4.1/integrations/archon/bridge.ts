#!/usr/bin/env bun
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdir, open, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { assignmentVerdicts, loadProfile, requirementById, sha256 } from "../../skills/poteto-mode/scripts/workflow/profiles.ts";
import { atomicJson, repositoryRevision, startRun } from "../../skills/poteto-mode/scripts/workflow/store.ts";
import { satisfyRequirement, workflowCheck, writeReceipt } from "../../skills/poteto-mode/scripts/workflow/workflow.ts";
import type { EvidenceKind, Profile, Receipt } from "../../skills/poteto-mode/scripts/workflow/types.ts";

export const STAGES = ["build", "shape-final", "verify", "review"] as const;
export type StageId = typeof STAGES[number];
const PROFILE_STAGE: Readonly<Record<StageId, string>> = { build: "build", "shape-final": "shape", verify: "verify", review: "review" };
export type Candidate = Readonly<{ head: string; fingerprint: string }>;
type Command = Readonly<{ executable: string; args: readonly string[]; timeoutMs: number }>;
type EvidenceBinding = Readonly<{ requirementId: string; kind: EvidenceKind; artifact: string }>;
export type StageSpec = Readonly<{ actor: string; command: Command; evidence: readonly EvidenceBinding[] }>;
export type PilotSpec = Readonly<{
  version: 1; profilePath: string; coordinator: string;
  assignments: Readonly<Record<string, string>>;
  stages: Readonly<Record<StageId, StageSpec>>;
}>;
export type RunBinding = Readonly<{
  version: 1; archonRunId: string; repositoryRoot: string; artifactsDirectory: string;
  specSha256: string; profilePath: string; profileSha256: string; playbookSha256: string;
  temariRunDirectory: string; temariRunId: string;
}>;
type SealedFile = Readonly<{ path: string; sha256: string }>;
type CapturedEvidence = EvidenceBinding & SealedFile;
type Attempt = Readonly<{
  version: 1; stage: StageId; actor: string; attempt: string; startedAt: string;
  bindingSha256: string; before: Candidate;
}>;
type CommandResult = Readonly<{ exitCode: number | null; signal: string | null; timedOut: boolean; error: string | null }>;
export type Capture =
  | (Attempt & Readonly<{ state: "running" }>)
  | (Attempt & Readonly<{ state: "failed"; after: Candidate; result: CommandResult; reason: string }>)
  | (Attempt & Readonly<{ state: "complete"; candidate: Candidate; result: CommandResult; logs: readonly SealedFile[]; evidence: readonly CapturedEvidence[] }>);
export type BridgeRequest = Readonly<{ artifactsDirectory: string; specPath: string; repositoryRoot: string; archonRunId: string }>;
type Context = Readonly<{ binding: RunBinding; spec: PilotSpec; profile: Profile; directory: string }>;
export type CompletionMarker = Readonly<{ version: 1; kind: "temari-review-receipt"; binding: RunBinding; candidate: Candidate; receipt: SealedFile }>;

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}
function exact(value: Record<string, unknown>, names: readonly string[], label: string): void {
  if (Object.keys(value).sort().join("\0") !== [...names].sort().join("\0")) throw new Error(`${label} has unknown or missing fields`);
}
function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}
async function json(path: string): Promise<unknown> { return JSON.parse(await readFile(path, "utf8")); }
async function optionalJson(path: string): Promise<unknown | null> {
  try { return await json(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
function sameCandidate(a: Candidate, b: Candidate): boolean { return a.head === b.head && a.fingerprint === b.fingerprint; }
function assertCandidate(context: Context, expected: Candidate): void {
  if (!sameCandidate(repositoryRevision(context.binding.repositoryRoot), expected)) throw new Error("candidate changed; start a new run after reconciling the checkout");
}

export async function loadSpec(path: string): Promise<{ spec: PilotSpec; profile: Profile; specSha256: string }> {
  const bytes = await readFile(path);
  const raw = object(JSON.parse(bytes.toString()), "spec");
  exact(raw, ["version", "profilePath", "coordinator", "assignments", "stages"], "spec");
  if (raw.version !== 1) throw new Error("spec.version must be 1");
  const profilePath = await realpath(resolve(dirname(path), text(raw.profilePath, "profilePath")));
  const profile = await loadProfile(profilePath);
  if (profile.route !== "feature") throw new Error("this pilot supports the Feature profile only");
  const coordinator = text(raw.coordinator, "coordinator");
  const assignments = Object.fromEntries(Object.entries(object(raw.assignments, "assignments")).map(([stage, actor]) => [stage, text(actor, `assignment ${stage}`)]));
  const invalid = assignmentVerdicts(profile, coordinator, assignments).find((item) => item.state === "invalid");
  if (invalid) throw new Error(`invalid assignment for ${invalid.stageId}: ${invalid.state === "invalid" ? invalid.reason : ""}`);
  const stagesRaw = object(raw.stages, "stages");
  exact(stagesRaw, STAGES, "stages");
  const stages = {} as Record<StageId, StageSpec>;
  const requirements = new Set<string>();
  for (const id of STAGES) {
    const stage = object(stagesRaw[id], `stage ${id}`);
    exact(stage, ["actor", "command", "evidence"], `stage ${id}`);
    const actor = text(stage.actor, `stage ${id} actor`);
    if (actor !== assignments[PROFILE_STAGE[id]]) throw new Error(`actor ${actor} does not own stage ${id}`);
    const command = object(stage.command, `stage ${id} command`);
    exact(command, ["executable", "args", "timeoutMs"], `stage ${id} command`);
    if (!Array.isArray(command.args) || command.args.some((arg) => typeof arg !== "string")) throw new Error(`stage ${id} args must be strings`);
    if (!Number.isSafeInteger(command.timeoutMs) || Number(command.timeoutMs) < 1 || Number(command.timeoutMs) > 3_600_000) throw new Error(`stage ${id} timeoutMs must be between 1 and 3600000`);
    if (!Array.isArray(stage.evidence) || stage.evidence.length === 0) throw new Error(`stage ${id} evidence must be a non-empty array`);
    const evidence = stage.evidence.map((value): EvidenceBinding => {
      const binding = object(value, `stage ${id} evidence`);
      exact(binding, ["requirementId", "kind", "artifact"], "evidence binding");
      const requirementId = text(binding.requirementId, "requirementId");
      const { stage: owner, requirement } = requirementById(profile, requirementId);
      const kind = text(binding.kind, "kind") as EvidenceKind;
      if (owner.id !== PROFILE_STAGE[id] || !requirement.allowedEvidenceKinds.includes(kind)) throw new Error(`invalid evidence mapping for ${requirementId}`);
      if (requirements.has(requirementId)) throw new Error(`duplicate requirement ${requirementId}`);
      requirements.add(requirementId);
      const artifact = text(binding.artifact, "artifact");
      if (isAbsolute(artifact) || !within("/output", resolve("/output", artifact)) || artifact === ".") throw new Error("artifact must stay inside the command output directory");
      return { requirementId, kind, artifact };
    });
    stages[id] = { actor, command: { executable: text(command.executable, "executable"), args: command.args as string[], timeoutMs: Number(command.timeoutMs) }, evidence };
  }
  if (requirements.size !== profile.boundaries.review.requirements.length || profile.boundaries.review.requirements.some((id) => !requirements.has(id))) throw new Error("stage evidence must cover the canonical review boundary exactly");
  return { spec: { version: 1, profilePath, coordinator, assignments, stages }, profile, specSha256: sha256(bytes) };
}

async function contextFor(request: BridgeRequest): Promise<Context> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(request.archonRunId)) throw new Error("invalid Archon workflow ID");
  const repositoryRoot = await realpath(request.repositoryRoot);
  const gitRoot = await realpath(execFileSync("git", ["-C", repositoryRoot, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim());
  if (repositoryRoot !== gitRoot) throw new Error("repositoryRoot must be the Git worktree root");
  await mkdir(request.artifactsDirectory, { recursive: true });
  const artifactsDirectory = await realpath(request.artifactsDirectory);
  if (within(repositoryRoot, artifactsDirectory)) throw new Error("all bridge state must be outside the target checkout");
  const { spec, profile, specSha256 } = await loadSpec(resolve(request.specPath));
  const directory = join(artifactsDirectory, "temari-bridge");
  await mkdir(directory, { recursive: true });
  const binding: RunBinding = {
    version: 1, archonRunId: request.archonRunId, repositoryRoot, artifactsDirectory, specSha256,
    profilePath: spec.profilePath, profileSha256: profile.profileSha256, playbookSha256: profile.playbook.sha256,
    temariRunDirectory: join(directory, "workflow", request.archonRunId), temariRunId: request.archonRunId,
  };
  return { binding, spec, profile, directory };
}

async function locked<T>(request: BridgeRequest, action: (context: Context) => Promise<T>): Promise<T> {
  const context = await contextFor(request);
  const lockPath = join(context.directory, ".capture.lock");
  let handle;
  try { handle = await open(lockPath, "wx"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("bridge is locked; another capture may be running. After an interruption, stop surviving children and reconcile the checkout before removing .capture.lock");
    throw error;
  }
  try {
    await handle.writeFile(`${process.pid}\n`);
    const path = join(context.directory, "binding.json");
    const prior = await optionalJson(path);
    if (prior !== null && JSON.stringify(prior) !== JSON.stringify(context.binding)) throw new Error("run binding changed: workflow ID, repository, artifacts, spec or profile differs");
    if (prior === null) await atomicJson(path, context.binding);
    return await action(context);
  } finally { await handle.close(); await rm(lockPath, { force: true }); }
}

function candidate(value: unknown): Candidate {
  const raw = object(value, "candidate");
  if (!/^[a-f0-9]{40,64}$/.test(String(raw.head)) || !/^[a-f0-9]{64}$/.test(String(raw.fingerprint))) throw new Error("invalid recorded candidate");
  return { head: String(raw.head), fingerprint: String(raw.fingerprint) };
}

async function priorCapture(context: Context, stage: StageId): Promise<Capture | null> {
  const pointer = await optionalJson(join(context.directory, "stages", `${stage}.json`));
  if (pointer === null) return null;
  const attempt = text(object(pointer, "attempt pointer").attempt, "attempt");
  if (!/^[a-f0-9-]{36}$/.test(attempt)) throw new Error("invalid attempt ID");
  const raw = object(await json(join(context.directory, "attempts", attempt, "capture.json")), "capture");
  if (raw.version !== 1 || raw.attempt !== attempt || raw.stage !== stage || raw.actor !== context.spec.stages[stage].actor || raw.bindingSha256 !== sha256(JSON.stringify(context.binding))) throw new Error(`capture identity changed for ${stage}`);
  candidate(raw.before);
  text(raw.startedAt, "startedAt");
  if (raw.state === "running") return raw as unknown as Capture;
  const result = object(raw.result, "command result");
  if ((result.exitCode !== null && !Number.isInteger(result.exitCode)) || (result.signal !== null && typeof result.signal !== "string") || typeof result.timedOut !== "boolean" || (result.error !== null && typeof result.error !== "string")) throw new Error("invalid command result");
  if (raw.state === "failed") { candidate(raw.after); text(raw.reason, "failure reason"); return raw as unknown as Capture; }
  if (raw.state !== "complete") throw new Error(`invalid capture state for ${stage}`);
  candidate(raw.candidate);
  if (result.exitCode !== 0 || result.signal !== null || result.timedOut || result.error !== null) throw new Error("complete capture has a failed command result");
  if (!Array.isArray(raw.logs) || raw.logs.length !== 2 || !Array.isArray(raw.evidence)) throw new Error("invalid sealed capture files");
  const capture = raw as unknown as Extract<Capture, { state: "complete" }>;
  const stageSpec = context.spec.stages[stage];
  if (capture.evidence.length !== stageSpec.evidence.length) throw new Error("capture evidence mapping changed");
  for (const [index, file] of capture.evidence.entries()) {
    const expected = stageSpec.evidence[index]!;
    if (file.requirementId !== expected.requirementId || file.kind !== expected.kind || file.artifact !== expected.artifact) throw new Error("capture evidence mapping changed");
  }
  for (const file of [...capture.logs, ...capture.evidence]) {
    const path = resolve(context.directory, text(file.path, "sealed path"));
    if (!within(join(context.directory, "attempts", attempt, "sealed"), await realpath(path))) throw new Error("sealed file escaped its attempt");
    if (sha256(await readFile(path)) !== file.sha256) throw new Error(`sealed artifact changed: ${file.path}`);
  }
  if (stage !== "build" && !sameCandidate(capture.before, capture.candidate)) throw new Error(`read-only stage ${stage} changed the candidate`);
  return capture;
}

async function completeCapture(context: Context, stage: StageId): Promise<Extract<Capture, { state: "complete" }>> {
  const capture = await priorCapture(context, stage);
  if (capture?.state !== "complete") throw new Error(`stage ${stage} has no completed capture`);
  assertCandidate(context, capture.candidate);
  return capture;
}

async function execute(command: Command, context: Context, stage: StageId, attemptDirectory: string): Promise<CommandResult> {
  const outputDirectory = join(attemptDirectory, "output");
  await mkdir(outputDirectory);
  const stdout = await open(join(attemptDirectory, "stdout.log"), "wx");
  const stderr = await open(join(attemptDirectory, "stderr.log"), "wx");
  try {
    return await new Promise<CommandResult>((resolveResult) => {
      let timedOut = false;
      let errorMessage: string | null = null;
      const child = spawn(command.executable, [...command.args], {
        cwd: context.binding.repositoryRoot, detached: true, stdio: ["ignore", stdout.fd, stderr.fd],
        env: { ...process.env, TEMARI_OUTPUT_DIR: outputDirectory, TEMARI_STAGE: stage, TEMARI_ACTOR: context.spec.stages[stage].actor, TEMARI_ARCHON_RUN_ID: context.binding.archonRunId },
      });
      const stopGroup = () => {
        if (child.pid !== undefined) {
          try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") errorMessage = String(error); }
        }
      };
      const timer = setTimeout(() => { timedOut = true; stopGroup(); }, command.timeoutMs);
      const interrupted = () => { errorMessage = "bridge received a termination signal"; stopGroup(); };
      process.on("SIGINT", interrupted);
      process.on("SIGTERM", interrupted);
      if (child.pid !== undefined) {
        try { writeFileSync(join(attemptDirectory, "process.json"), `${JSON.stringify({ pid: child.pid, processGroupId: child.pid, bridgePid: process.pid })}\n`, { flag: "wx" }); }
        catch (error) { errorMessage = `could not record child identity: ${String(error)}`; stopGroup(); }
      }
      child.on("error", (error) => { errorMessage = error.message; });
      child.on("close", (exitCode, signal) => {
        clearTimeout(timer);
        process.off("SIGINT", interrupted);
        process.off("SIGTERM", interrupted);
        stopGroup();
        resolveResult({ exitCode, signal, timedOut, error: errorMessage });
      });
    });
  } finally { await stdout.close(); await stderr.close(); }
}

async function seal(context: Context, attempt: string, name: string, bytes: Uint8Array): Promise<SealedFile> {
  const path = join("attempts", attempt, "sealed", name);
  await mkdir(dirname(join(context.directory, path)), { recursive: true });
  await writeFile(join(context.directory, path), bytes, { flag: "wx" });
  return { path, sha256: sha256(bytes) };
}

export async function captureStage(request: BridgeRequest, stage: StageId): Promise<Capture> {
  if (!STAGES.includes(stage)) throw new Error(`unknown stage ${stage}`);
  return locked(request, async (context) => {
    await rm(join(context.binding.artifactsDirectory, "evidence.json"), { force: true });
    const before = repositoryRevision(context.binding.repositoryRoot);
    for (const previous of STAGES.slice(0, STAGES.indexOf(stage))) await completeCapture(context, previous);
    const prior = await priorCapture(context, stage);
    if (prior?.state === "complete") { assertCandidate(context, prior.candidate); return prior; }
    if (prior !== null) {
      if (stage === "build" && (prior.state === "running" || !sameCandidate(prior.before, prior.after) || prior.result.signal !== null || prior.result.timedOut || prior.result.error !== null)) throw new Error("mutating attempt is indeterminate; do not replay it. Reconcile the checkout and start a new run");
      if (!sameCandidate(prior.before, before)) throw new Error("candidate changed since the previous attempt; start a new run");
    }
    const attempt = randomUUID();
    const attemptDirectory = join(context.directory, "attempts", attempt);
    await mkdir(attemptDirectory, { recursive: true });
    const base: Attempt = { version: 1, stage, actor: context.spec.stages[stage].actor, attempt, startedAt: new Date().toISOString(), bindingSha256: sha256(JSON.stringify(context.binding)), before };
    const capturePath = join(attemptDirectory, "capture.json");
    await atomicJson(capturePath, { ...base, state: "running" });
    await atomicJson(join(context.directory, "stages", `${stage}.json`), { attempt });
    const result = await execute(context.spec.stages[stage].command, context, stage, attemptDirectory);
    const after = repositoryRevision(context.binding.repositoryRoot);
    const failure = async (reason: string): Promise<never> => {
      await atomicJson(capturePath, { ...base, state: "failed", after, result, reason });
      throw new Error(`${stage}: ${reason}`);
    };
    if (stage !== "build" && !sameCandidate(before, after)) return failure("read-only command changed the candidate; start a new run");
    if (result.exitCode !== 0 || result.timedOut || result.error !== null || result.signal !== null) return failure(`command failed (${JSON.stringify(result)})`);
    try {
      const logs = await Promise.all(["stdout", "stderr"].map(async (stream) => seal(context, attempt, `${stream}.log`, await readFile(join(attemptDirectory, `${stream}.log`)))));
      const evidence: CapturedEvidence[] = [];
      for (const [index, binding] of context.spec.stages[stage].evidence.entries()) {
        const output = join(attemptDirectory, "output");
        const source = await realpath(join(output, binding.artifact));
        if (!within(output, source) || !(await stat(source)).isFile()) throw new Error("evidence output must be a regular file inside the command output directory");
        const sealed = await seal(context, attempt, `evidence-${index}`, await readFile(source));
        evidence.push({ ...binding, ...sealed });
      }
      assertCandidate(context, after);
      const capture: Capture = { ...base, state: "complete", candidate: after, result, logs, evidence };
      await atomicJson(capturePath, capture);
      return capture;
    } catch (error) { return failure(error instanceof Error ? error.message : String(error)); }
  });
}

export async function finalize(request: BridgeRequest): Promise<CompletionMarker> {
  return locked(request, async (context) => {
    const markerPath = join(context.binding.artifactsDirectory, "evidence.json");
    await rm(markerPath, { force: true });
    const captures: Extract<Capture, { state: "complete" }>[] = [];
    for (const stage of STAGES) captures.push(await completeCapture(context, stage));
    const candidate = captures[0]!.candidate;
    if (captures.some((capture) => !sameCandidate(capture.candidate, candidate))) throw new Error("captures describe different candidates");
    await startRun({ runDirectory: context.binding.temariRunDirectory, profilePath: context.spec.profilePath, repositoryRoot: context.binding.repositoryRoot, coordinator: context.spec.coordinator, assignments: context.spec.assignments, capabilities: context.profile.hostCapabilities.filter((capability) => capability === "subagents") });
    for (const capture of captures) {
      assertCandidate(context, candidate);
      for (const evidence of capture.evidence) await satisfyRequirement({ runDirectory: context.binding.temariRunDirectory, actor: capture.actor, requirementId: evidence.requirementId, evidenceKind: evidence.kind, evidencePath: join(context.directory, evidence.path) });
    }
    const verdict = await workflowCheck(context.binding.temariRunDirectory, "review");
    if (!verdict.passed) throw new Error(`canonical review boundary failed: ${JSON.stringify(verdict)}`);
    const receipt: Receipt = await writeReceipt(context.binding.temariRunDirectory, "review", context.spec.coordinator);
    if (receipt.runId !== context.binding.temariRunId) throw new Error("receipt run identity differs");
    for (const stage of STAGES) await completeCapture(context, stage);
    assertCandidate(context, candidate);
    const receiptPath = join(context.binding.temariRunDirectory, "receipt.json");
    const marker: CompletionMarker = { version: 1, kind: "temari-review-receipt", binding: context.binding, candidate, receipt: { path: relative(context.binding.artifactsDirectory, receiptPath), sha256: sha256(await readFile(receiptPath)) } };
    await atomicJson(markerPath, marker);
    try { assertCandidate(context, candidate); } catch (error) { await rm(markerPath, { force: true }); throw error; }
    return marker;
  });
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const [operation, ...args] = argv;
    if (operation !== "capture" && operation !== "finalize") throw new Error("usage: bridge.ts capture|finalize --artifacts DIR --spec FILE --workflow-id ID [--stage build|shape-final|verify|review] [--repository DIR]");
    const values: Record<string, string> = {};
    for (let index = 0; index < args.length; index += 2) {
      const flag = args[index]!;
      const value = args[index + 1];
      if (!["--artifacts", "--spec", "--workflow-id", "--stage", "--repository"].includes(flag) || value === undefined || values[flag] !== undefined) throw new Error(`invalid argument ${flag}`);
      values[flag] = value;
    }
    const request = { artifactsDirectory: text(values["--artifacts"], "--artifacts"), specPath: text(values["--spec"], "--spec"), repositoryRoot: values["--repository"] ?? process.cwd(), archonRunId: text(values["--workflow-id"], "--workflow-id") };
    if (operation === "finalize" && values["--stage"] !== undefined) throw new Error("finalize does not accept --stage");
    const result = operation === "capture" ? await captureStage(request, text(values["--stage"], "--stage") as StageId) : await finalize(request);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) { process.stderr.write(`temari-archon: ${error instanceof Error ? error.message : String(error)}\n`); return 1; }
}
if (import.meta.main) process.exitCode = await main();
