#!/usr/bin/env bun
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { atomicJson, repositoryRevision } from "../../skills/poteto-mode/scripts/workflow/store.ts";

export const CANONICAL_STAGES = ["investigate", "plan", "build", "review", "verify", "deliver"] as const;
type Stage = typeof CANONICAL_STAGES[number];
type Command = { executable: string; args: string[]; timeoutMs: number; summary: string };
type Spec = { schema: 1; runId: string; revision: string; repositoryRoot: string; plan: Record<string, unknown>; stages: Record<Stage, Command> };
type Candidate = ReturnType<typeof repositoryRevision>;
type Binding = { schema: 1; nativeRunId: string; runId: string; revision: string; planSha256: string; specSha256: string; repositoryRoot: string; artifactsDirectory: string; candidate: Candidate };
type Capture = { schema: 1; stage: Stage; bindingSha256: string; attempt: string; startedAt: string; completedAt: string; summary: string; stdoutSha256: string; stderrSha256: string; candidate: Candidate };
type Request = { specPath: string; artifactsDirectory: string; nativeRunId: string };

const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const safeId = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
const within = (parent: string, child: string) => {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected an object");
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, names: readonly string[]): void {
  if (Object.keys(value).sort().join("\0") !== [...names].sort().join("\0")) throw new Error("unknown or missing fields");
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
async function load(request: Request): Promise<{ spec: Spec; binding: Binding; directory: string }> {
  if (!safeId(request.nativeRunId)) throw new Error("invalid native run ID");
  const bytes = await readFile(request.specPath);
  const raw = object(JSON.parse(bytes.toString("utf8")));
  exact(raw, ["schema", "runId", "revision", "repositoryRoot", "plan", "stages"]);
  if (raw.schema !== 1 || typeof raw.runId !== "string" || !safeId(raw.runId) || typeof raw.revision !== "string" || !raw.revision) throw new Error("invalid spec identity");
  const plan = object(raw.plan);
  if (JSON.stringify(plan.stages) !== JSON.stringify(CANONICAL_STAGES)) throw new Error("spec plan is not canonical");
  const commands = object(raw.stages);
  exact(commands, CANONICAL_STAGES);
  const stages = {} as Record<Stage, Command>;
  for (const stage of CANONICAL_STAGES) {
    const command = object(commands[stage]);
    exact(command, ["executable", "args", "timeoutMs", "summary"]);
    if (typeof command.executable !== "string" || !isAbsolute(command.executable) || !Array.isArray(command.args) || command.args.some((arg) => typeof arg !== "string") || !Number.isSafeInteger(command.timeoutMs) || Number(command.timeoutMs) < 1 || Number(command.timeoutMs) > 60_000 || typeof command.summary !== "string" || !command.summary) throw new Error(`invalid ${stage} command`);
    if (!(await stat(command.executable)).isFile()) throw new Error(`non-file ${stage} executable`);
    stages[stage] = command as Command;
  }
  if (typeof raw.repositoryRoot !== "string" || !isAbsolute(raw.repositoryRoot)) throw new Error("repository root must be absolute");
  const repositoryRoot = await realpath(raw.repositoryRoot);
  const gitRoot = await realpath(execFileSync("git", ["-C", repositoryRoot, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim());
  if (repositoryRoot !== gitRoot) throw new Error("repository root must be the Git worktree root");
  await mkdir(request.artifactsDirectory, { recursive: true });
  const artifactsDirectory = await realpath(request.artifactsDirectory);
  if (within(repositoryRoot, artifactsDirectory)) throw new Error("artifacts must be outside the checkout");
  const directory = join(artifactsDirectory, "temari-nx-canonical");
  await mkdir(directory, { recursive: true });
  const binding: Binding = {
    schema: 1, nativeRunId: request.nativeRunId, runId: raw.runId,
    revision: raw.revision, planSha256: sha256(canonical(plan)),
    specSha256: sha256(bytes), repositoryRoot, artifactsDirectory,
    candidate: repositoryRevision(repositoryRoot),
  };
  const path = join(directory, "binding.json");
  const prior = await readFile(path, "utf8").then(JSON.parse, (error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (prior === null) await atomicJson(path, binding);
  else if (canonical(prior) !== canonical(binding)) throw new Error("native run binding or checkout changed");
  return { spec: { schema: 1, runId: raw.runId, revision: raw.revision, repositoryRoot, plan, stages }, binding, directory };
}

async function readCapture(directory: string, binding: Binding, stage: Stage, summary: string): Promise<{ capture: Capture; stdout: Uint8Array; stderr: Uint8Array } | null> {
  const pointerPath = join(directory, "stages", `${stage}.json`);
  const pointer = await readFile(pointerPath, "utf8").then(JSON.parse, (error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (pointer === null) return null;
  if (!pointer || typeof pointer.attempt !== "string" || !/^[a-f0-9-]{36}$/.test(pointer.attempt)) throw new Error("invalid stage pointer");
  const attemptDirectory = join(directory, "attempts", pointer.attempt);
  const capture = object(JSON.parse(await readFile(join(attemptDirectory, "capture.json"), "utf8"))) as Capture;
  if (capture.schema !== 1 || capture.stage !== stage || capture.attempt !== pointer.attempt || capture.bindingSha256 !== sha256(canonical(binding)) || capture.summary !== summary || canonical(capture.candidate) !== canonical(binding.candidate)) throw new Error(`stale ${stage} capture`);
  if (!Number.isFinite(Date.parse(capture.startedAt)) || !Number.isFinite(Date.parse(capture.completedAt))) throw new Error(`invalid ${stage} timestamps`);
  const stdout = await readFile(join(attemptDirectory, "stdout.bin"));
  const stderr = await readFile(join(attemptDirectory, "stderr.bin"));
  if (sha256(stdout) !== capture.stdoutSha256 || sha256(stderr) !== capture.stderrSha256) throw new Error(`sealed ${stage} output changed`);
  return { capture, stdout, stderr };
}

async function commandOutput(command: Command, repositoryRoot: string, stage: Stage, nativeRunId: string): Promise<{ stdout: Buffer; stderr: Buffer }> {
  return new Promise((resolveOutput, rejectOutput) => {
    const child = spawn(command.executable, command.args, { cwd: repositoryRoot, shell: false, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TEMARI_STAGE: stage, TEMARI_ARCHON_RUN_ID: nativeRunId } });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let exceeded = false;
    let timedOut = false;
    const collect = (chunks: Buffer[], chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024) { exceeded = true; child.kill(); }
      else chunks.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, command.timeoutMs);
    child.once("error", rejectOutput);
    child.once("close", (code) => {
      clearTimeout(timer);
      if (exceeded || timedOut || code !== 0) rejectOutput(new Error(`${stage} command failed: exit=${code} timeout=${timedOut} outputLimit=${exceeded}`));
      else resolveOutput({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
  });
}

export async function captureCanonicalStage(request: Request, stage: Stage): Promise<Capture> {
  if (!CANONICAL_STAGES.includes(stage)) throw new Error("unknown canonical stage");
  const { spec, binding, directory } = await load(request);
  const lock = await open(join(directory, ".capture.lock"), "wx");
  try {
    for (const preceding of CANONICAL_STAGES.slice(0, CANONICAL_STAGES.indexOf(stage))) if (!await readCapture(directory, binding, preceding, spec.stages[preceding].summary)) throw new Error(`${preceding} has no completed capture`);
    const prior = await readCapture(directory, binding, stage, spec.stages[stage].summary);
    if (prior) return prior.capture;
    const attempt = randomUUID();
    const attemptDirectory = join(directory, "attempts", attempt);
    await mkdir(attemptDirectory, { recursive: true });
    const startedAt = new Date().toISOString();
    const output = await commandOutput(spec.stages[stage], binding.repositoryRoot, stage, binding.nativeRunId);
    if (canonical(repositoryRevision(binding.repositoryRoot)) !== canonical(binding.candidate)) throw new Error("read-only conformance command changed the checkout");
    await writeFile(join(attemptDirectory, "stdout.bin"), output.stdout, { flag: "wx" });
    await writeFile(join(attemptDirectory, "stderr.bin"), output.stderr, { flag: "wx" });
    const capture: Capture = { schema: 1, stage, attempt, bindingSha256: sha256(canonical(binding)), startedAt, completedAt: new Date().toISOString(), summary: spec.stages[stage].summary, stdoutSha256: sha256(output.stdout), stderrSha256: sha256(output.stderr), candidate: binding.candidate };
    await atomicJson(join(attemptDirectory, "capture.json"), capture);
    await atomicJson(join(directory, "stages", `${stage}.json`), { attempt });
    return capture;
  } finally {
    await lock.close();
    await Bun.file(join(directory, ".capture.lock")).delete();
  }
}

export async function verifyCanonicalCaptures(request: Request) {
  const { spec, binding, directory } = await load(request);
  const stages = [];
  for (const stage of CANONICAL_STAGES) {
    const item = await readCapture(directory, binding, stage, spec.stages[stage].summary);
    if (!item) throw new Error(`${stage} has no completed capture`);
    stages.push({ stage, summary: item.capture.summary, stdoutBase64: Buffer.from(item.stdout).toString("base64"), stderrBase64: Buffer.from(item.stderr).toString("base64") });
  }
  return { binding, stages };
}

async function main(args: string[]): Promise<void> {
  const [operation, ...rest] = args;
  if (operation !== "capture" && operation !== "verify") throw new Error("usage: canonical-bridge.ts capture|verify --spec FILE --artifacts DIR --workflow-id ID [--stage STAGE]");
  const flags: Record<string, string> = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index]!;
    const value = rest[index + 1];
    if (!["--spec", "--artifacts", "--workflow-id", "--stage"].includes(flag) || !value || flags[flag]) throw new Error(`invalid argument ${flag}`);
    flags[flag] = value;
  }
  if (!flags["--spec"] || !flags["--artifacts"] || !flags["--workflow-id"]) throw new Error("missing bridge input");
  const request = { specPath: resolve(flags["--spec"]), artifactsDirectory: resolve(flags["--artifacts"]), nativeRunId: flags["--workflow-id"] };
  if (operation === "capture") {
    if (!CANONICAL_STAGES.includes(flags["--stage"] as Stage)) throw new Error("invalid stage");
    console.log(JSON.stringify(await captureCanonicalStage(request, flags["--stage"] as Stage)));
  } else {
    if (flags["--stage"]) throw new Error("verify does not accept a stage");
    console.log(JSON.stringify(await verifyCanonicalCaptures(request)));
  }
}

if (import.meta.main) main(process.argv.slice(2)).catch((error) => { console.error(error); process.exitCode = 1; });
