#!/usr/bin/env bun

import { Command, CommanderError, InvalidArgumentError } from "commander";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { atomicJson, appendGateEvent, appendRouteEvent, assertStageOwner, ingestEvidence, loadRun, loadRunForPivot, parseEvidence, parseSkip, readJson, recordPath, repositoryRevision, routeConfiguration, startRun, withRunLock, type RunContext } from "./store.ts";
import { loadProfile, requirementById, sha256 } from "./profiles.ts";
import { checkBoundary, createReceipt } from "./receipt.ts";
import type { Boundary, BoundaryVerdict, EvidenceKind, EvidenceRecord, GateEvent, Profile, Receipt, RouteEvent, SkipRecord } from "./types.ts";
import { WorkflowError, WorkflowUsageError } from "./types.ts";

export { checkBoundary, loadProfile, loadRun, startRun };
export type { BoundaryVerdict, Profile, Receipt, RunContext };

export interface SatisfyOptions {
  readonly runDirectory: string;
  readonly actor: string;
  readonly requirementId: string;
  readonly evidencePath: string;
  readonly evidenceKind: EvidenceKind;
  readonly now?: () => string;
}

export interface SkipOptions {
  readonly runDirectory: string;
  readonly actor: string;
  readonly requirementId: string;
  readonly reason: string;
  readonly allowedBy: string;
  readonly now?: () => string;
}

async function optionalRecord(path: string, parser: (value: unknown) => EvidenceRecord | SkipRecord): Promise<EvidenceRecord | SkipRecord | null> {
  try {
    return parser(await readJson(path));
  } catch (error) {
    if (error instanceof WorkflowError && error.message.startsWith("cannot read ") && error.message.includes("ENOENT")) return null;
    throw error;
  }
}

export async function satisfyRequirement(options: SatisfyOptions): Promise<EvidenceRecord> {
  return withRunLock(resolve(options.runDirectory), async () => {
    const run = await loadRun(options.runDirectory);
    const { stage, requirement } = requirementById(run.profile, options.requirementId);
    assertStageOwner(run, stage.id, options.actor);
    if (!requirement.allowedEvidenceKinds.includes(options.evidenceKind)) throw new WorkflowError(`evidence kind ${options.evidenceKind} is not allowed for ${requirement.id}`);
    const skipPath = recordPath(run, stage.id, requirement.id, "skip");
    if (await optionalRecord(skipPath, parseSkip) !== null) throw new WorkflowError(`requirement ${requirement.id} is already skipped`);
    const source = await readFile(resolve(options.evidencePath));
    const evidenceSha256 = sha256(source);
    const evidencePath = `stages/${stage.id}/evidence/${requirement.id}.${evidenceSha256}.evidence`;
    const revision = repositoryRevision(run.manifest.repositoryRoot);
    const candidate: EvidenceRecord = {
      version: 1,
      requirementId: requirement.id,
      stageId: stage.id,
      evidenceKind: options.evidenceKind,
      evidencePath,
      evidenceSha256,
      producer: options.actor,
      at: options.now?.() ?? new Date().toISOString(),
      repositoryHead: revision.head,
      worktreeFingerprint: revision.fingerprint,
      profileId: run.profile.id,
      profileSha256: run.profile.profileSha256,
    };
    const path = recordPath(run, stage.id, requirement.id, "evidence");
    const existing = await optionalRecord(path, parseEvidence) as EvidenceRecord | null;
    if (existing !== null) {
      const same = existing.requirementId === candidate.requirementId && existing.stageId === candidate.stageId && existing.evidenceKind === candidate.evidenceKind && existing.evidencePath === candidate.evidencePath && existing.evidenceSha256 === candidate.evidenceSha256 && existing.producer === candidate.producer && existing.repositoryHead === candidate.repositoryHead && existing.worktreeFingerprint === candidate.worktreeFingerprint && existing.profileSha256 === candidate.profileSha256;
      if (same) return existing;
      throw new WorkflowError(`requirement ${requirement.id} already has different evidence`);
    }
    await ingestEvidence(run, stage.id, requirement.id, source);
    await atomicJson(path, candidate);
    return candidate;
  });
}

export async function skipRequirement(options: SkipOptions): Promise<SkipRecord> {
  return withRunLock(resolve(options.runDirectory), async () => {
    const run = await loadRun(options.runDirectory);
    const { stage, requirement } = requirementById(run.profile, options.requirementId);
    assertStageOwner(run, stage.id, options.actor);
    if (!requirement.skip.allowed || requirement.skip.whenCapabilityMissing !== options.allowedBy || run.capabilities.includes(options.allowedBy)) throw new WorkflowError(`requirement ${requirement.id} cannot be skipped for ${options.allowedBy}`);
    const evidencePath = recordPath(run, stage.id, requirement.id, "evidence");
    if (await optionalRecord(evidencePath, parseEvidence) !== null) throw new WorkflowError(`requirement ${requirement.id} is already satisfied`);
    const candidate: SkipRecord = { version: 1, requirementId: requirement.id, stageId: stage.id, reason: options.reason, allowedBy: options.allowedBy, producer: options.actor, at: options.now?.() ?? new Date().toISOString(), profileId: run.profile.id, profileSha256: run.profile.profileSha256 };
    const path = recordPath(run, stage.id, requirement.id, "skip");
    const existing = await optionalRecord(path, parseSkip) as SkipRecord | null;
    if (existing !== null) {
      const same = existing.reason === candidate.reason && existing.allowedBy === candidate.allowedBy && existing.producer === candidate.producer && existing.profileSha256 === candidate.profileSha256;
      if (same) return existing;
      throw new WorkflowError(`requirement ${requirement.id} already has a different skip`);
    }
    await atomicJson(path, candidate);
    return candidate;
  });
}

export interface PivotOptions {
  readonly capabilities?: readonly string[];
  readonly assignments?: Readonly<Record<string, string>>;
  readonly now?: string;
}

export async function pivotRoute(runDirectory: string, profilePath: string, actor: string, options: PivotOptions = {}): Promise<RouteEvent> {
  return withRunLock(resolve(runDirectory), async () => {
    const run = await loadRunForPivot(runDirectory);
    const profile = await loadProfile(profilePath);
    const configuration = routeConfiguration(profile, run.manifest.coordinator, options.capabilities ?? run.capabilities, options.assignments, run.assignments);
    return appendRouteEvent(run, profile, actor, configuration.capabilities, configuration.assignments, options.now ?? new Date().toISOString());
  });
}

export async function openGate(runDirectory: string, gateId: string, summary: string, actor: string, now = new Date().toISOString()): Promise<GateEvent> {
  return withRunLock(resolve(runDirectory), async () => {
    const run = await loadRun(runDirectory);
    const revision = repositoryRevision(run.manifest.repositoryRoot);
    return appendGateEvent(run, { version: 1, kind: "gate-opened", at: now, actor, gateId, summary, repositoryHead: revision.head, worktreeFingerprint: revision.fingerprint, profileId: run.profile.id, profileSha256: run.profile.profileSha256 });
  });
}

export async function resolveGate(runDirectory: string, gateId: string, resolution: string, actor: string, now = new Date().toISOString()): Promise<GateEvent> {
  return withRunLock(resolve(runDirectory), async () => {
    const run = await loadRun(runDirectory);
    const revision = repositoryRevision(run.manifest.repositoryRoot);
    return appendGateEvent(run, { version: 1, kind: "gate-resolved", at: now, actor, gateId, resolution, repositoryHead: revision.head, worktreeFingerprint: revision.fingerprint, profileId: run.profile.id, profileSha256: run.profile.profileSha256 });
  });
}

export async function workflowCheck(runDirectory: string, boundary: Boundary): Promise<BoundaryVerdict> {
  return checkBoundary(await loadRun(runDirectory), boundary);
}

export async function writeReceipt(runDirectory: string, boundary: Boundary, actor: string, now = new Date().toISOString()): Promise<Receipt> {
  return withRunLock(resolve(runDirectory), async () => {
    const run = await loadRun(runDirectory);
    const receipt = await createReceipt(run, boundary, actor, now);
    await atomicJson(resolve(runDirectory, "receipt.json"), receipt);
    return receipt;
  });
}

interface Io {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
}

interface Globals { readonly run?: string; readonly actor?: string; readonly json: boolean }

function globalOptions(command: Command): { readonly runDirectory: string; readonly actor: string; readonly json: boolean } {
  const values = command.optsWithGlobals<Globals>();
  if (values.run === undefined || values.run.trim() === "") throw new WorkflowUsageError("set --run <directory>");
  if (values.actor === undefined || values.actor.trim() === "") throw new WorkflowUsageError("set --actor <id>");
  return { runDirectory: values.run, actor: values.actor, json: values.json };
}

function emit(io: Io, json: boolean, value: unknown, compact: string): void {
  io.stdout(`${json ? JSON.stringify(value, null, 2) : compact}\n`);
}

function collect(value: string, previous?: readonly string[]): readonly string[] {
  return [...(previous ?? []), value];
}

function assignments(values: readonly string[]): Readonly<Record<string, string>> {
  return Object.fromEntries(values.map((value) => {
    const separator = value.indexOf("=");
    if (separator < 1 || separator === value.length - 1) throw new InvalidArgumentError("assignments use stage=actor");
    return [value.slice(0, separator), value.slice(separator + 1)];
  }));
}

function boundary(value: string): Boundary {
  if (value === "final" || value === "commit" || value === "review" || value === "publish") return value;
  throw new InvalidArgumentError("boundary must be final, commit, review, or publish");
}

function evidenceKind(value: string): EvidenceKind {
  if (value === "command" || value === "diff" || value === "document" || value === "runtime" || value === "review") return value;
  throw new InvalidArgumentError("kind must be command, diff, document, runtime, or review");
}

export function createProgram(io: Io): Command {
  const program = new Command("workflow")
    .description("Record and verify a Temari playbook run")
    .option("--run <directory>", "workflow run directory")
    .option("--actor <id>", "actor performing the command")
    .option("--json", "emit JSON", false)
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr })
    .exitOverride();

  program.command("start")
    .requiredOption("--profile <path>")
    .requiredOption("--repo <path>")
    .requiredOption("--coordinator <id>")
    .option("--capability <name>", "host capability", collect, [])
    .option("--assign <stage=actor>", "stage owner", collect, [])
    .action(async (options: { profile: string; repo: string; coordinator: string; capability: readonly string[]; assign: readonly string[] }, command: Command) => {
      const globals = command.optsWithGlobals<Globals>();
      if (globals.run === undefined) throw new WorkflowUsageError("set --run <directory>");
      const run = await startRun({ runDirectory: globals.run, profilePath: options.profile, repositoryRoot: options.repo, coordinator: options.coordinator, capabilities: options.capability, assignments: assignments(options.assign) });
      const verdict = await checkBoundary(run, "publish");
      const next = verdict.requirements.find((item) => item.state !== "satisfied" && item.state !== "skipped");
      const nextGate = verdict.gates.find((item) => item.state !== "resolved");
      const currentStage = next === undefined ? nextGate === undefined ? "complete" : "gate" : requirementById(run.profile, next.requirementId).stage.id;
      const nextRequirement = next?.requirementId ?? nextGate?.gateId ?? "complete";
      const summary = { runId: run.manifest.runId, playbookSha256: run.profile.playbook.sha256, currentStage, nextRequirement };
      emit(io, globals.json, summary, `started ${summary.runId} playbook=${summary.playbookSha256} stage=${summary.currentStage} next=${summary.nextRequirement}`);
    });

  const stage = program.command("stage");
  stage.command("satisfy <requirement>")
    .requiredOption("--evidence <path>")
    .requiredOption("--kind <kind>", "evidence kind", evidenceKind)
    .action(async (requirement: string, options: { evidence: string; kind: EvidenceKind }, command: Command) => {
      const globals = globalOptions(command);
      const result = await satisfyRequirement({ ...globals, requirementId: requirement, evidencePath: options.evidence, evidenceKind: options.kind });
      emit(io, globals.json, result, `satisfied ${result.requirementId} evidence=${result.evidenceSha256}`);
    });
  stage.command("skip <requirement>")
    .requiredOption("--reason <text>")
    .requiredOption("--allowed-by <capability>")
    .action(async (requirement: string, options: { reason: string; allowedBy: string }, command: Command) => {
      const globals = globalOptions(command);
      const result = await skipRequirement({ ...globals, requirementId: requirement, reason: options.reason, allowedBy: options.allowedBy });
      emit(io, globals.json, result, `skipped ${result.requirementId} allowed-by=${result.allowedBy}`);
    });

  const gate = program.command("gate");
  gate.command("open <gate>").requiredOption("--summary <text>").action(async (gateId: string, options: { summary: string }, command: Command) => {
    const globals = globalOptions(command);
    const result = await openGate(globals.runDirectory, gateId, options.summary, globals.actor);
    emit(io, globals.json, result, `opened ${result.gateId}`);
  });
  gate.command("resolve <gate>").requiredOption("--resolution <text>").action(async (gateId: string, options: { resolution: string }, command: Command) => {
    const globals = globalOptions(command);
    const result = await resolveGate(globals.runDirectory, gateId, options.resolution, globals.actor);
    emit(io, globals.json, result, `resolved ${result.gateId}`);
  });

  program.command("route-pivot").requiredOption("--profile <path>").option("--capability <name>", "host capability", collect).option("--assign <stage=actor>", "stage owner", collect).action(async (options: { profile: string; capability?: readonly string[]; assign?: readonly string[] }, command: Command) => {
    const globals = globalOptions(command);
    const result = await pivotRoute(globals.runDirectory, options.profile, globals.actor, { capabilities: options.capability, assignments: options.assign === undefined ? undefined : assignments(options.assign) });
    emit(io, globals.json, result, `route=${result.profileId} sequence=${result.sequence}`);
  });
  program.command("check").requiredOption("--boundary <name>", "boundary", boundary).action(async (options: { boundary: Boundary }, command: Command) => {
    const globals = command.optsWithGlobals<Globals>();
    if (globals.run === undefined) throw new WorkflowUsageError("set --run <directory>");
    const result = await workflowCheck(globals.run, options.boundary);
    emit(io, globals.json, result, `${result.passed ? "pass" : "fail"} boundary=${result.boundary} pending=${result.requirements.filter((item) => item.state !== "satisfied" && item.state !== "skipped").length} gates=${result.gates.filter((item) => item.state !== "resolved").length}`);
    if (!result.passed) process.exitCode = 1;
  });
  program.command("receipt").option("--boundary <name>", "boundary", boundary, "final").action(async (options: { boundary: Boundary }, command: Command) => {
    const globals = globalOptions(command);
    const result = await writeReceipt(globals.runDirectory, options.boundary, globals.actor);
    emit(io, globals.json, result, `receipt ${result.runId} boundary=${result.boundary} head=${result.repositoryHead}`);
  });
  return program;
}

export async function main(argv = process.argv): Promise<number> {
  const io: Io = { stdout: (value) => process.stdout.write(value), stderr: (value) => process.stderr.write(value) };
  try {
    await createProgram(io).parseAsync(argv);
    return Number(process.exitCode ?? 0);
  } catch (error) {
    if (error instanceof CommanderError) return Number(error.exitCode);
    io.stderr(`workflow: ${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof WorkflowUsageError ? 2 : 1;
  }
}

if (import.meta.main) process.exitCode = await main();
