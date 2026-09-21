#!/usr/bin/env bun
import { execFileSync, spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Candidate, PilotSpec, StageId } from "./bridge.ts";
import { finalize } from "./bridge.ts";
import { executeCodex, inspectRolePlan } from "./live-codex.ts";
import { inspectPilotConfiguration, freezePilotExecution, executionDigest, authorizePilotExecution, assertPilotExecution, verifierArguments, type ExecutionContract, type AuthorizedLaunch } from "./live-permissions.ts";
import { repositoryRevision } from "../../skills/poteto-mode/scripts/workflow/store.ts";
import { workflowCheck } from "../../skills/poteto-mode/scripts/workflow/workflow.ts";

import { taskRecipe, taskBudget, type TaskId } from "./live-tasks.ts";
import { payload } from "./lifecycle.ts";
import { parseRoleSelection, validateRoleSelection, routingDigest, type RolePlan, type RoleSelection } from "./live-routing.ts";

const integration = dirname(fileURLToPath(import.meta.url));
const actors = { build: "live-builder", "shape-final": "live-coordinator", verify: "live-coordinator", review: "live-reviewer" } as const;
export const liveTimeouts = { workflowWaitSeconds: 2940, reportingGraceMs: 30_000 } as const;
const planningKinds = ["how", "design-a", "design-b", "selection", "checkpoint"] as const;
type PlanningKind = typeof planningKinds[number];
type PlanningEntry = { kind: PlanningKind; author: string; file: string; sha256: string; authoredAt: string };
type Planning = { version: 1; baseline: Candidate; taskSha256: string; entries: PlanningEntry[] };
export type PreparedPilot = { version: 2; task: TaskId; root: string; repositoryRoot: string; baseline: Candidate; taskSha256: string; inventorySha256: string; source: { repository: string; candidate: Candidate; payloadSha256: string } | null };
type Preparation = { root: string; task?: "charge-cost" } | { root: string; task: "temari-routing-doc"; repository: string };
type Selection = { root: string; planning: string; archon: string; codex: string; roles?: RoleSelection; model?: string; reasoning?: string; failVerificationOnce?: boolean };
type FileIdentity = { sha256: string; mode: number; size: number };
type Frozen = { execution: ExecutionContract; prepared: PreparedPilot; planning: Planning; planningSha256: string; files: Record<string, FileIdentity>; codex: string; codexSha256: string; codexVersion: string; routing: RolePlan; failVerificationOnce: boolean };
type ReviewIdentity = { candidate: Candidate; baselineHead: string; sourceSha256: string; testsSha256: string; planningSha256: string; diffSha256: string; executionSha256: string; routingSha256: string; inventorySha256: string };
const shapeRequirements = {
  "feature.shape.how": ["how"],
  "feature.shape.parallel-design": ["design-a", "design-b", "selection"],
  "feature.shape.throughput-checkpoint": ["checkpoint"],
} as const;
type PlanningSnapshot = Readonly<{
  baseline: Candidate; taskSha256: string; manifestSha256: string; manifestBase64: string;
  artifacts: readonly Readonly<{ kind: PlanningKind; author: string; authoredAt: string; sha256: string; contentBase64: string }>[];
}>;
type ShapeAssessment = Readonly<{
  version: 1; kind: "temari-live-shape-assessment"; origin: PlanningSnapshot;
  assessment: Readonly<{
    kind: "mechanical-reconciliation"; actor: "live-coordinator"; archonRunId: string; assessedAt: string;
    identity: ReviewIdentity; changedFiles: readonly string[];
    protectedContractsUnchanged: true; implementationCommitCount: 1;
    semanticDesignAdherence: "pending-independent-review";
  }>;
  requirements: typeof shapeRequirements; attribution: "host-reported";
}>;
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const same = isDeepStrictEqual;
const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const writeJson = (path: string, value: unknown) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
function object(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== keys.sort().join()) throw new Error(`${label} has unknown or missing fields`);
  return value as Record<string, unknown>;
}
function nonempty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && value.length < 16_384; }
function git(repository: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repository, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-c", "diff.autoRefreshIndex=false", ...args], { encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }).trim();
}
export async function inventory(root: string): Promise<Record<string, FileIdentity>> {
  const result: Record<string, FileIdentity> = Object.create(null); let entries = 0; let bytes = 0;
  async function visit(prefix: string) {
    for (const name of (await readdir(join(root, prefix))).sort()) {
      const path = prefix ? `${prefix}/${name}` : name; const absolute = join(root, path);
      const info = await lstat(absolute);
      if (++entries > 10_000) throw new Error("canonical inventory exceeds entry bound");
      if (info.isDirectory()) { result[path] = { sha256: "directory", mode: info.mode & 0o777, size: 0 }; await visit(path); }
      else {
        bytes += info.size;
        if (!info.isFile() || info.nlink !== 1 || info.size > (path.startsWith(".git/") ? 64 : 4) * 1024 * 1024 || bytes > 256 * 1024 * 1024) throw new Error(`unsupported file or inventory size: ${path}`);
        const digest = createHash("sha256"); for await (const chunk of createReadStream(absolute)) digest.update(chunk);
        const after = await lstat(absolute);
        if (info.ino !== after.ino || info.dev !== after.dev || info.size !== after.size || info.mtimeMs !== after.mtimeMs || info.ctimeMs !== after.ctimeMs) throw new Error("canonical file changed during inventory");
        result[path] = { sha256: digest.digest("hex"), mode: info.mode & 0o777, size: info.size };
      }
    }
  }
  await visit(""); return result;
}
export async function admitSource(scratch: string, baseline: FileIdentity, taskId: TaskId = "charge-cost"): Promise<Buffer> {
  const filename = taskRecipe(taskId).actorFilename;
  if ((await readdir(scratch)).join() !== filename) throw new Error(`builder output must contain only ${filename}`);
  const handle = await open(join(scratch, filename), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > 64 * 1024 || (before.mode & 0o777) !== baseline.mode) throw new Error("builder source must be a bounded regular single-link file with unchanged mode");
    const buffer = Buffer.alloc(64 * 1024 + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = await handle.read(buffer, size, buffer.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    const after = await handle.stat();
    const current = await lstat(join(scratch, filename));
    if (size !== before.size || size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || after.nlink !== 1 || current.ino !== after.ino || current.dev !== after.dev || current.isSymbolicLink() || (await readdir(scratch)).join() !== filename) throw new Error("builder source changed during bounded admission");
    const admitted = buffer.subarray(0, size);
    if (hash(admitted) === baseline.sha256) throw new Error("builder source is unchanged");
    return admitted;
  } finally { await handle.close(); }
}

function testPath(prepared: PreparedPilot): string { return prepared.task === "charge-cost" ? join(prepared.repositoryRoot, taskRecipe(prepared.task).testFilename) : join(prepared.root, "control/task", taskRecipe(prepared.task).testFilename); }
function workflowRoot(prepared: PreparedPilot): string { return prepared.task === "charge-cost" ? prepared.repositoryRoot : join(prepared.root, "control/workflow-source"); }
async function preparedAt(root: string): Promise<PreparedPilot> {
  const prepared = await json(join(root, "prepared.json")) as PreparedPilot;
  if (prepared.version !== 2 || prepared.root !== await realpath(root) || prepared.repositoryRoot !== join(prepared.root, "target") || prepared.taskSha256 !== hash(taskRecipe(prepared.task).task)) throw new Error("invalid prepared pilot identity");
  return prepared;
}
async function matchingPayload(repository: string): Promise<string> {
  const identities: Record<string, string> = {};
  for (const path of payload) {
    const source = join(repository, path); const info = await lstat(source);
    if (!info.isFile() || info.nlink !== 1 || info.size > 4 * 1024 * 1024 || await realpath(source) !== source) throw new Error(`unsupported Temari payload file: ${path}`);
    const bytes = await readFile(source); const expected = await readFile(resolve(integration, "../..", path));
    if (!bytes.equals(expected) || !bytes.equals(execFileSync("git", ["-C", repository, "show", `HEAD:${path}`], { maxBuffer: 4 * 1024 * 1024 }))) throw new Error(`Temari source and executing package differ: ${path}`);
    identities[path] = hash(bytes);
  }
  return hash(JSON.stringify(identities));
}
export async function preparePilot(selection: string | Preparation): Promise<PreparedPilot> {
  const input: Preparation = typeof selection === "string" ? { root: selection } : selection;
  const recipe = taskRecipe(input.task ?? "charge-cost");
  if (!isAbsolute(input.root)) throw new Error("pilot root must be absolute");
  await mkdir(input.root, { recursive: true });
  if ((await lstat(input.root)).isSymbolicLink() || (await readdir(input.root)).length) throw new Error("pilot root must be empty and not a symlink");
  const root = await realpath(input.root);
  if (root === integration || root.startsWith(`${resolve(integration, "../..")}${sep}`)) throw new Error("pilot root must be outside the package");
  const repositoryRoot = join(root, "target");
  await mkdir(join(root, "control")); await writeFile(join(root, "task.md"), recipe.task);
  let source: PreparedPilot["source"] = null;
  if (input.task === "temari-routing-doc") {
    if (!isAbsolute(input.repository)) throw new Error("Temari repository must be absolute");
    const repository = await realpath(input.repository);
    if (root === repository || root.startsWith(`${repository}${sep}`) || repository.startsWith(`${root}${sep}`) || git(repository, "rev-parse", "--show-toplevel") !== repository || git(repository, "status", "--porcelain", "--untracked-files=all")) throw new Error("Temari source must be a clean separate repository root");
    const candidate = repositoryRevision(repository); const payloadSha256 = await matchingPayload(repository);
    if (git(repository, "ls-tree", "HEAD", "--", recipe.repositoryPath)) throw new Error("documentation output already exists in source baseline");
    for (const entry of git(repository, "ls-tree", "-r", "-z", "HEAD").split("\0").filter(Boolean)) {
      const [metadata, path] = entry.split("\t"); const mode = metadata!.split(" ")[0];
      if (!["100644", "100755"].includes(mode!) && !(mode === "160000" && path === "external/content-registrar")) throw new Error(`unsupported Temari tracked file: ${path}`);
      if (mode === "160000" && (await readdir(join(repository, path!))).length) throw new Error("known Temari gitlink must remain uninitialized");
    }
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "clone", "--no-local", "--no-hardlinks", "--no-checkout", "--", repository, repositoryRoot], { encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024 });
    git(repositoryRoot, "checkout", "--detach", candidate.head);
    git(repositoryRoot, "remote", "remove", "origin");
    if (git(repositoryRoot, "status", "--porcelain", "--untracked-files=all") || git(repositoryRoot, "rev-parse", "HEAD") !== candidate.head || !same(repositoryRevision(repository), candidate) || await matchingPayload(repository) !== payloadSha256 || await matchingPayload(repositoryRoot) !== payloadSha256) throw new Error("Temari source changed during isolated preparation");
    source = { repository, candidate, payloadSha256 };
    await mkdir(join(root, "control/task"));
    await writeFile(join(root, "control/task", recipe.testFilename), recipe.tests, { mode: 0o444 });
    for (const name of recipe.references) await writeFile(join(root, "control/task", name), await readFile(join(integration, name)), { mode: 0o444 });
    await mkdir(join(root, "control/workflow-source/.archon/workflows"), { recursive: true });
    await copyFile(join(integration, ".archon/workflows/temari-live-pilot.yaml"), join(root, "control/workflow-source/.archon/workflows/temari-live-pilot.yaml"));
    git(join(root, "control/workflow-source"), "init", "-b", "main");
  } else {
    await mkdir(join(repositoryRoot, ".archon/workflows"), { recursive: true });
    await writeFile(join(repositoryRoot, recipe.repositoryPath), recipe.initial, { mode: 0o644 });
    await writeFile(join(repositoryRoot, recipe.testFilename), recipe.tests, { mode: 0o644 });
    await copyFile(join(integration, ".archon/workflows/temari-live-pilot.yaml"), join(repositoryRoot, ".archon/workflows/temari-live-pilot.yaml"));
    git(repositoryRoot, "init", "-b", "main"); git(repositoryRoot, "add", ".");
    git(repositoryRoot, "-c", "user.name=Temari live pilot", "-c", "user.email=pilot@example.invalid", "commit", "-m", "Prepare bounded charge cost task");
  }
  const prepared: PreparedPilot = { version: 2, task: recipe.id, root, repositoryRoot, baseline: repositoryRevision(repositoryRoot), taskSha256: hash(recipe.task), inventorySha256: hash(JSON.stringify(await inventory(repositoryRoot))), source };
  await writeJson(join(root, "prepared.json"), prepared); return prepared;
}

async function freezePlanning(path: string, prepared: PreparedPilot): Promise<Planning> {
  const raw = object(await json(path), ["version", "baseline", "taskSha256", "entries"], "planning manifest");
  if (raw.version !== 1 || !same(raw.baseline, prepared.baseline) || raw.taskSha256 !== prepared.taskSha256 || !Array.isArray(raw.entries) || raw.entries.length !== 5) throw new Error("planning must bind this baseline/task and all five entries");
  const entries: PlanningEntry[] = [];
  const copies: [string, Buffer][] = [];
  for (const value of raw.entries) {
    const item = object(value, ["kind", "author", "file", "sha256", "authoredAt"], "planning entry");
    if (!planningKinds.includes(item.kind as PlanningKind) || !nonempty(item.author) || !nonempty(item.file) || !/^[a-f0-9]{64}$/.test(String(item.sha256)) || !nonempty(item.authoredAt) || !Number.isFinite(Date.parse(item.authoredAt)) || Date.parse(item.authoredAt) > Date.now()) throw new Error("invalid planning entry provenance");
    const file = resolve(dirname(path), item.file);
    const info = await lstat(file);
    if (!info.isFile() || info.nlink !== 1 || info.size < 40 || info.size > 128 * 1024) throw new Error("planning document must be a bounded regular file");
    const bytes = await readFile(file);
    if (hash(bytes) !== item.sha256) throw new Error("planning document hash mismatch");
    if (item.kind === "checkpoint" && ["Blocking first steps", "Independent workstreams", "Shared mutable state", "Smallest safe decomposition"].some(heading => !bytes.toString().includes(heading))) throw new Error("checkpoint is missing a required dimension");
    entries.push({ kind: item.kind as PlanningKind, author: item.author, file: `${item.kind}.md`, sha256: item.sha256 as string, authoredAt: item.authoredAt });
    copies.push([`${item.kind}.md`, bytes]);
  }
  if (new Set(entries.map(entry => entry.kind)).size !== 5) throw new Error("planning kinds must be distinct");
  const author = (kind: PlanningKind) => entries.find(entry => entry.kind === kind)!.author;
  if (author("design-a") === author("design-b") || [author("design-a"), author("design-b")].includes(author("selection")) || author("selection") !== author("checkpoint")) throw new Error("planning needs independent design authors and a coordinator selection/checkpoint");
  const directory = join(prepared.root, "control/planning");
  await mkdir(directory);
  for (const [name, bytes] of copies) await writeFile(join(directory, name), bytes, { flag: "wx" });
  const planning: Planning = { version: 1, baseline: prepared.baseline, taskSha256: prepared.taskSha256, entries };
  await writeJson(join(directory, "manifest.json"), planning);
  return planning;
}

async function planningSnapshot(frozen: Frozen): Promise<PlanningSnapshot> {
  const directory = join(frozen.prepared.root, "control/planning");
  const manifest = await readFile(join(directory, "manifest.json"));
  if (hash(manifest) !== frozen.planningSha256 || !same(JSON.parse(manifest.toString()), frozen.planning)) throw new Error("frozen planning manifest changed");
  if (!same(frozen.planning.baseline, frozen.prepared.baseline) || frozen.planning.taskSha256 !== frozen.prepared.taskSha256) throw new Error("frozen planning origin differs from prepared task");
  const artifacts: PlanningSnapshot["artifacts"][number][] = [];
  for (const entry of frozen.planning.entries) {
    const bytes = await readFile(join(directory, entry.file));
    if (hash(bytes) !== entry.sha256) throw new Error(`frozen planning changed: ${entry.kind}`);
    artifacts.push({ kind: entry.kind, author: entry.author, authoredAt: entry.authoredAt, sha256: entry.sha256, contentBase64: bytes.toString("base64") });
  }
  return { baseline: frozen.planning.baseline, taskSha256: frozen.planning.taskSha256, manifestSha256: frozen.planningSha256, manifestBase64: manifest.toString("base64"), artifacts };
}
async function planningText(frozen: Frozen): Promise<string> {
  return (await planningSnapshot(frozen)).artifacts.map(entry => `## ${entry.kind}\nHost-reported author: ${entry.author}\nAuthored: ${entry.authoredAt}\nSHA-256: ${entry.sha256}\n\n${Buffer.from(entry.contentBase64, "base64").toString()}`).join("\n\n");
}
async function assertContracts(frozen: Frozen): Promise<void> {
  const source = frozen.prepared.source;
  if (source && (!same(repositoryRevision(source.repository), source.candidate) || git(source.repository, "status", "--porcelain", "--untracked-files=all") || await matchingPayload(source.repository) !== source.payloadSha256)) throw new Error("original Temari source changed during pilot");
  if (await readFile(join(frozen.prepared.root, "task.md"), "utf8") !== taskRecipe(frozen.prepared.task).task) throw new Error("task changed");
  for (const [name, identity] of Object.entries(frozen.files)) {
    const info = await lstat(name);
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== identity.mode || hash(await readFile(name)) !== identity.sha256) throw new Error(`protected contract changed: ${name}`);
  }
  await planningSnapshot(frozen);
  if (hash(await readFile(frozen.codex)) !== frozen.codexSha256) throw new Error("Codex executable changed");
}
async function identity(frozen: Frozen): Promise<ReviewIdentity> {
  await assertContracts(frozen);
  const repository = frozen.prepared.repositoryRoot;
  const recipe = taskRecipe(frozen.prepared.task);
  const candidate = repositoryRevision(repository);
  if (git(repository, "status", "--porcelain") || git(repository, "rev-list", "--count", `${frozen.prepared.baseline.head}..HEAD`) !== "1" || git(repository, "diff", "--name-only", frozen.prepared.baseline.head, "HEAD") !== recipe.repositoryPath) throw new Error(`candidate must be one clean implementation commit changing only ${recipe.repositoryPath}`);
  return { executionSha256: executionDigest(frozen.execution), routingSha256: routingDigest(frozen.routing), inventorySha256: hash(JSON.stringify(await inventory(repository))), candidate, baselineHead: frozen.prepared.baseline.head, sourceSha256: hash(await readFile(join(repository, taskRecipe(frozen.prepared.task).repositoryPath))), testsSha256: frozen.files[testPath(frozen.prepared)]!.sha256, planningSha256: frozen.planningSha256, diffSha256: hash(git(repository, "diff", frozen.prepared.baseline.head, "HEAD", "--")) };
}
function schema(properties: Record<string, unknown>) { return { type: "object", additionalProperties: false, properties, required: Object.keys(properties) }; }
const string = { type: "string" };
const candidateSchema = schema({ head: string, fingerprint: string });
const identitySchema = schema({ candidate: candidateSchema, baselineHead: string, sourceSha256: string, testsSha256: string, planningSha256: string, diffSha256: string, executionSha256: string, routingSha256: string, inventorySha256: string });

async function model(frozen: Frozen, role: "build" | "review", launch: AuthorizedLaunch, expected: Candidate | ReviewIdentity, context: string) {
  const recipe = taskRecipe(frozen.prepared.task);
  const control = join(frozen.prepared.root, "control");
  const invocationId = randomUUID();
  const invocation = { invocationId, role, task: recipe.id, budget: taskBudget(recipe.id), execution: launch.observation, requested: frozen.routing.roles[role], routingSha256: routingDigest(frozen.routing), executable: frozen.codex, executableSha256: frozen.codexSha256, version: frozen.codexVersion };
  await writeJson(join(control, `${role}-invocation.json`), invocation);
  const responseSchema = role === "build"
    ? schema({ verdict: { type: "string", enum: ["implemented", "blocked"] }, invocationId: string, baseline: candidateSchema, summary: string, changedFiles: { type: "array", maxItems: 1, items: { type: "string", enum: [recipe.repositoryPath] } } })
    : schema({ verdict: { type: "string", enum: ["accept", "reject"] }, invocationId: string, identity: identitySchema, rationale: string, designAdherence: string, inspectedFiles: { type: "array", items: string }, findings: { type: "array", items: string } });
  const schemaPath = join(control, `${role}-schema.json`);
  await writeJson(schemaPath, responseSchema);
  const playbook = join(launch.context, "feature.md");
  const prompt = `You are the bounded delegated ${role === "build" ? "implementation owner" : "independent reviewer"} for Temari's Feature playbook. Invoke only this bounded role from the packaged Feature instructions at ${playbook}. Read that file. The coordinator has completed planning and owns orchestration, verification, Git and delivery. Do not load full orchestration, delegate, commit, retry, or expand scope. You are explicitly forbidden to spawn; the Feature playbook permits the forbidden worker to own its assigned diff directly.\n\n${recipe.task}\n${role === "build" ? `Your only writable output is the existing ${recipe.actorFilename} in this scratch directory. Do not add other files. Tests and Git are controller owned. Report changedFiles as exactly ${JSON.stringify([recipe.repositoryPath])} when implemented: this names the controller's repository destination, not an additional scratch path to create. Return blocked honestly if needed. Report changedFiles as [] when blocked.` : "Tools are read-only. Inspect source, tests, the actual baseline-to-HEAD commit diff, supplied observed test output and planning. Assess semantic adherence and explain any deviations. Return reject for actionable problems. Do not repair code."}\n\nInvocation ID: ${invocationId}\nExpected ${role === "build" ? "baseline" : "identity"}: ${JSON.stringify(expected)}\n\n${context}\n\nReturn only the structured final object. Never claim tests you did not run or planning you did not perform.\n`;
  await writeFile(join(control, `${role}-prompt.txt`), prompt, { flag: "wx" });
  process.stderr.write(`${JSON.stringify({ kind: "live-invocation", ...invocation, expected })}\n`);
  await assertPilotExecution(frozen.execution, launch);
  const result = await executeCodex({ launch, executable: frozen.codex, cwd: launch.cwd, ...frozen.routing.roles[role], role, prompt, schema: schemaPath, lastMessage: join(control, `${role}-last-message.json`) });
  await assertPilotExecution(frozen.execution, launch);
  const keys = role === "build" ? ["verdict", "invocationId", "baseline", "summary", "changedFiles"] : ["verdict", "invocationId", "identity", "rationale", "designAdherence", "inspectedFiles", "findings"];
  const verdict = object(result.final, keys, `${role} verdict`);
  if (verdict.invocationId !== invocationId || !same(verdict[role === "build" ? "baseline" : "identity"], expected)) throw new Error(`${role} returned stale identity`);
  if (role === "build") {
    if (verdict.verdict !== "implemented" || !nonempty(verdict.summary) || !same(verdict.changedFiles, [recipe.repositoryPath])) throw new Error("builder did not report the bounded implementation");
  } else {
    const builder = await json(join(control, "build-result.json"));
    if (result.threadId === builder.threadId) throw new Error("reviewer reused builder thread");
    if (!nonempty(verdict.rationale) || !nonempty(verdict.designAdherence) || !Array.isArray(verdict.findings) || verdict.findings.some(finding => !nonempty(finding)) || !same(verdict.inspectedFiles, [recipe.actorFilename, recipe.testFilename, ...recipe.references, "commit-diff", "planning"])) throw new Error("invalid reviewer findings or inspection report");
    if (verdict.verdict !== "accept" || verdict.findings.length !== 0) throw new Error("reviewer rejected candidate or returned contradictory acceptance");
  }
  const report = { ...invocation, threadId: result.threadId, turnId: result.turnId, observed: result.observed, finalSha256: hash(result.finalText), verdict };
  await writeJson(join(control, `${role}-result.json`), report);
  return report;
}

async function executeStage(stage: StageId, root: string, frozenSha256: string): Promise<void> {
  const output = process.env.TEMARI_OUTPUT_DIR;
  if (!output || stage !== process.env.TEMARI_STAGE || process.env.TEMARI_ACTOR !== actors[stage] || !process.env.TEMARI_ARCHON_RUN_ID) throw new Error("live stage requires its exact bridge actor environment");
  const frozenBytes = await readFile(join(root, "control/frozen.json"));
  if (hash(frozenBytes) !== frozenSha256) throw new Error("frozen pilot configuration changed");
  const frozen = JSON.parse(frozenBytes.toString()) as Frozen;
  if (frozen.prepared.root !== await realpath(root) || frozen.prepared.repositoryRoot !== await realpath(process.cwd())) throw new Error("live stage repository identity mismatch");
  await assertContracts(frozen);
  const report = (name: string, contents: string) => writeFile(join(output, name), `# Bounded live Codex pilot\n\nActor: ${actors[stage]}\nArchon run: ${process.env.TEMARI_ARCHON_RUN_ID}\nActor and planning attribution are host reported. Model thread IDs are observed CLI events.\n\n${contents}\n`, { flag: "wx" });
  const repository = frozen.prepared.repositoryRoot;
  const recipe = taskRecipe(frozen.prepared.task);
  const sourcePath = join(repository, recipe.repositoryPath);
  const control = join(root, "control");
  if (stage === "build") {
    if (!same(repositoryRevision(repository), frozen.prepared.baseline)) throw new Error("baseline changed before build");
    const before = await inventory(repository);
    if (hash(JSON.stringify(before)) !== frozen.prepared.inventorySha256) throw new Error("prepared canonical inventory changed before build");
    const scratch = join(root, "builder-workspace");
    await mkdir(scratch);
    await writeFile(join(scratch, recipe.actorFilename), recipe.initial, { mode: 0o644, flag: "wx" });
    const launch = await authorizePilotExecution(frozen.execution, { role: "build", identity: frozen.prepared.baseline });
    const result = await model(frozen, "build", launch, frozen.prepared.baseline, `Task inputs: ${launch.context}\n${await planningText(frozen)}`);
    const admitted = await admitSource(scratch, { sha256: hash(recipe.initial), mode: 0o644, size: Buffer.byteLength(recipe.initial) }, recipe.id);
    if (!same(await inventory(repository), before) || !same(repositoryRevision(repository), frozen.prepared.baseline)) throw new Error("builder modified canonical repository");
    await assertContracts(frozen);
    const promoted = join(control, recipe.actorFilename);
    await writeFile(promoted, admitted, { mode: 0o644, flag: "wx" });
    await mkdir(dirname(sourcePath), { recursive: true });
    await rename(promoted, sourcePath);
    git(repository, "add", "--", recipe.repositoryPath);
    git(repository, "-c", "user.name=Temari live pilot", "-c", "user.email=pilot@example.invalid", "commit", "-m", recipe.commitMessage);
    const candidate = await identity(frozen);
    await writeJson(join(control, "candidate.json"), candidate);
    await report("build.md", `Actual Codex builder output was admitted from its scratch directory and promoted by the controller. The controller created one fixed commit.\n\n${JSON.stringify({ ...result, identity: candidate }, null, 2)}\n\n${git(repository, "diff", candidate.baselineHead, "HEAD", "--")}`);
  } else {
    const expected = await json(join(control, "candidate.json")) as ReviewIdentity;
    const observed = await identity(frozen);
    if (!same(observed, expected)) throw new Error("implementation candidate changed");
    if (stage === "shape-final") {
      const assessment: ShapeAssessment = {
        version: 1, kind: "temari-live-shape-assessment", origin: await planningSnapshot(frozen),
        assessment: {
          kind: "mechanical-reconciliation", actor: actors[stage], archonRunId: process.env.TEMARI_ARCHON_RUN_ID,
          assessedAt: new Date().toISOString(), identity: observed, changedFiles: [recipe.repositoryPath],
          protectedContractsUnchanged: true, implementationCommitCount: 1, semanticDesignAdherence: "pending-independent-review",
        },
        requirements: shapeRequirements, attribution: "host-reported",
      };
      await writeJson(join(output, "shape-final.json"), assessment);
    } else if (stage === "verify") {
      const launch = await authorizePilotExecution(frozen.execution, { role: "verify", identity: expected, source: await readFile(sourcePath), tests: await readFile(testPath(frozen.prepared)) });
      const args = verifierArguments(launch);
      await assertPilotExecution(frozen.execution, launch);
      const result = spawnSync(frozen.codex, args, { cwd: launch.cwd, env: process.env, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
      await assertPilotExecution(frozen.execution, launch);
      process.stdout.write(result.stdout ?? ""); process.stderr.write(result.stderr ?? "");
      if (result.error || result.status !== 0 || result.signal) throw new Error(`sandboxed target tests failed: ${result.error ?? result.status}`);
      const testOutput = `${result.stdout}\n${result.stderr}`;
      if (!new RegExp(`^ ${recipe.expectedTests} pass$`, "m").test(testOutput) || !/^ 0 fail$/m.test(testOutput) || !new RegExp(`^ ${recipe.expectedAssertions} expect\\(\\) calls$`, "m").test(testOutput) || !new RegExp(`^Ran ${recipe.expectedTests} tests across 1 file\\.`, "m").test(testOutput)) throw new Error("sandboxed test suite did not complete all expected tests and assertions");
      if (!same(await identity(frozen), expected)) throw new Error("verification changed the candidate");
      if (frozen.failVerificationOnce) {
        const flag = join(control, "verification-failed-once");
        try { await writeFile(flag, "Controlled failure after actual sandboxed tests passed.\n", { flag: "wx" }); throw new Error("controlled verification checkpoint failed once"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      }
      const observation = { identity: expected, execution: launch.observation, executable: frozen.codex, args, exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
      await writeJson(join(control, "verification.json"), observation);
      await report("verification.md", `Actual non-model Bun tests executed under the fixed Codex read-only sandbox.\n\n${JSON.stringify(observation, null, 2)}`);
    } else if (stage === "review") {
      const verification = await json(join(control, "verification.json"));
      if (!same(verification.identity, expected) || verification.exitCode !== 0) throw new Error("review requires current passing target tests");
      const launch = await authorizePilotExecution(frozen.execution, { role: "review", identity: expected, source: await readFile(sourcePath), tests: await readFile(testPath(frozen.prepared)), diff: git(repository, "diff", expected.baselineHead, "HEAD", "--"), verification: JSON.stringify(verification) });
      const result = await model(frozen, "review", launch, expected, `${await planningText(frozen)}\n\nObserved non-model tests:\n${JSON.stringify(verification)}\n\nActual commit diff:\n${git(repository, "diff", expected.baselineHead, "HEAD", "--")}\n\nReturn inspectedFiles exactly ${JSON.stringify([recipe.actorFilename, recipe.testFilename, ...recipe.references, "commit-diff", "planning"])} after inspection.`);
      if (!same(await identity(frozen), expected)) throw new Error("review changed the candidate");
      await report("review.md", `Actual fresh read-only Codex review accepted this candidate. The model's semantic judgment is retained below with its invocation and observed identity.\n\n${JSON.stringify(result, null, 2)}`);
    } else throw new Error("unknown live stage");
  }
}

export async function runPilot(selection: Selection) {
  if (process.platform !== "darwin") throw new Error("the task-scoped live pilot currently supports only verified macOS execution");
  if (selection.roles && (selection.model !== undefined || selection.reasoning !== undefined)) throw new Error("legacy and per-role model options cannot be mixed");
  const roles = selection.roles ? validateRoleSelection(selection.roles) : parseRoleSelection({ "--model": selection.model, "--reasoning": selection.reasoning });
  const prepared = await preparedAt(selection.root);
  const root = prepared.root;
  const recipe = taskRecipe(prepared.task);
  if (!same(repositoryRevision(prepared.repositoryRoot), prepared.baseline) || hash(JSON.stringify(await inventory(prepared.repositoryRoot))) !== prepared.inventorySha256 || await readFile(testPath(prepared), "utf8") !== recipe.tests) throw new Error("prepared baseline changed");
  if (prepared.source && (await matchingPayload(prepared.repositoryRoot) !== prepared.source.payloadSha256 || prepared.baseline.head !== prepared.source.candidate.head)) throw new Error("prepared Temari payload changed");
  const codex = await realpath(selection.codex);
  const codexVersion = execFileSync(codex, ["--version"], { encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 }).trim();
  if (codexVersion !== "codex-cli 0.154.0") throw new Error("live pilot requires verified Codex CLI 0.154.0");
  const codexSha256 = hash(await readFile(codex));
  const configurationSha256 = await inspectPilotConfiguration(codex, root);
  const routing = await inspectRolePlan(codex, root, roles);
  if (hash(await readFile(codex)) !== codexSha256 || await inspectPilotConfiguration(codex, root) !== configurationSha256) throw new Error("Codex runtime/configuration changed during routing discovery");
  const planning = await freezePlanning(selection.planning, prepared);
  const files: Record<string, FileIdentity> = {};
  for (const name of recipe.references) if (!(await readFile(join(root, "control/task", name))).equals(await readFile(join(integration, name)))) throw new Error("prepared reference changed");
  if (!(await readFile(join(workflowRoot(prepared), ".archon/workflows/temari-live-pilot.yaml"))).equals(await readFile(join(integration, ".archon/workflows/temari-live-pilot.yaml")))) throw new Error("prepared workflow changed");
  const protectedPaths = [testPath(prepared), join(workflowRoot(prepared), ".archon/workflows/temari-live-pilot.yaml"), ...recipe.references.map(name => join(root, "control/task", name))];
  for (const name of protectedPaths) {
    const info = await lstat(name);
    if (!info.isFile() || info.nlink !== 1) throw new Error("prepared task must contain regular single-link files");
    files[name] = { sha256: hash(await readFile(name)), mode: info.mode & 0o777, size: info.size };
  }
  const execution = await freezePilotExecution({ root, task: prepared.task, baseline: prepared.baseline, taskSha256: prepared.taskSha256, codex, bun: process.execPath, playbook: resolve(integration, "../../skills/poteto-mode/playbooks/feature.md") });
  if (execution.configurationSha256 !== configurationSha256 || execution.runtime.codex.sha256 !== codexSha256) throw new Error("Codex runtime/configuration changed after routing discovery");
  const frozen: Frozen = { execution, prepared, planning, planningSha256: hash(await readFile(join(root, "control/planning/manifest.json"))), files, codex, codexSha256: hash(await readFile(codex)), codexVersion, routing, failVerificationOnce: selection.failVerificationOnce === true };
  await writeJson(join(root, "control/frozen.json"), frozen);
  const frozenSha256 = hash(await readFile(join(root, "control/frozen.json")));
  const stage = (id: StageId, evidence: PilotSpec["stages"][StageId]["evidence"]) => ({ actor: actors[id], command: { executable: process.execPath, args: [fileURLToPath(import.meta.url), "stage", id, root, frozenSha256], timeoutMs: taskBudget(prepared.task).stageMs }, evidence });
  const spec: PilotSpec = {
    version: 1, profilePath: resolve(integration, "../../skills/poteto-mode/playbook-contracts/v1/feature.json"), coordinator: actors.verify,
    assignments: { shape: actors.verify, build: actors.build, verify: actors.verify, review: actors.review, delivery: actors.verify },
    stages: {
      build: stage("build", [{ requirementId: "feature.build.delegated-implementation", kind: "diff", artifact: "build.md" }]),
      "shape-final": stage("shape-final", Object.keys(shapeRequirements).map(requirementId => ({ requirementId, kind: "document", artifact: "shape-final.json" }))),
      verify: stage("verify", [{ requirementId: "feature.verify.matching-surface", kind: "command", artifact: "verification.md" }]),
      review: stage("review", [{ requirementId: "feature.review.ordered-commits", kind: "review", artifact: "review.md" }]),
    },
  };
  const specPath = join(root, "pilot-spec.json");
  await writeJson(specPath, spec);
  const env = { ...process.env, ARCHON_HOME: join(root, "archon-home"), LOG_LEVEL: "error", DO_NOT_TRACK: "1", CLAUDE_BIN_PATH: "/usr/bin/false", PATH: `${dirname(process.execPath)}:${process.env.PATH}` };
  async function archon(label: string, args: string[], allowFailure = false, timeoutMs = 480_000) {
    const result = spawnSync(selection.archon, args, { cwd: prepared.repositoryRoot, env, encoding: "utf8", timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 });
    await writeFile(join(root, `${label}.stdout.log`), result.stdout ?? ""); await writeFile(join(root, `${label}.stderr.log`), result.stderr ?? "");
    if (result.error || (!allowFailure && result.status !== 0)) throw new Error(`Archon ${label} failed; evidence retained at ${root}: ${result.error ?? result.stderr}`);
    return result;
  }
  const version = (await archon("version", ["version"])).stdout;
  if (!/^Archon CLI v0\.10\.1$/m.test(version) || !/^  Git commit: 9820785c$/m.test(version)) throw new Error("live pilot requires Archon v0.10.1 at 9820785c");
  await archon("validate", ["validate", "workflows", "temari-live-pilot", "--cwd", workflowRoot(prepared)]);
  const launch = await archon("launch", ["workflow", "run", "temari-live-pilot", "--cwd", prepared.repositoryRoot, "--workflow-source", workflowRoot(prepared), "--no-worktree", "--input", `bridge=${join(integration, "bridge.ts")}`, "--input", `spec=${specPath}`, "--detach", "--json"]);
  const runId = JSON.parse(launch.stdout).runId;
  if (typeof runId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(runId)) throw new Error("native launch did not return an exact run ID");
  await writeJson(join(root, "native-run.json"), { runId, archonHome: env.ARCHON_HOME, repositoryRoot: prepared.repositoryRoot });
  console.log(JSON.stringify({ state: "started", runId, root }));
  const completionTimeoutMs = liveTimeouts.workflowWaitSeconds * 1000 + liveTimeouts.reportingGraceMs;
  await archon("wait", ["workflow", "wait", runId, "--timeout", String(liveTimeouts.workflowWaitSeconds), "--json"], true, completionTimeoutMs);
  let completed = JSON.parse((await archon("status", ["workflow", "get", runId, "--json"])).stdout);
  if (completed.id !== runId) throw new Error("native status returned another run");
  const artifactsDirectory = join(completed.output_root, "artifacts/runs", runId);
  if (frozen.failVerificationOnce) {
    if (completed.status !== "failed") throw new Error("expected controlled verification failure");
    const verifierCapture = join(artifactsDirectory, "temari-bridge/stages/verify.json");
    if (!(await Bun.file(verifierCapture).exists())) throw new Error(`live run ${runId} failed before the controlled verifier checkpoint: ${completed.metadata?.error ?? "no verifier capture"}; evidence ${root}`);
    const failed = await json(verifierCapture);
    const failureLog = await readFile(join(artifactsDirectory, "temari-bridge/attempts", failed.attempt, "stderr.log"), "utf8");
    const capture = await json(join(artifactsDirectory, "temari-bridge/attempts", failed.attempt, "capture.json"));
    if (capture.state !== "failed" || !failureLog.includes("controlled verification checkpoint failed once") || await Bun.file(join(artifactsDirectory, "evidence.json")).exists()) throw new Error("native failure was not the controlled verifier checkpoint");
    const buildBefore = await readFile(join(artifactsDirectory, "temari-bridge/stages/build.json"), "utf8");
    await archon("resume", ["workflow", "resume", runId, "--cwd", prepared.repositoryRoot], false, completionTimeoutMs);
    if (buildBefore !== await readFile(join(artifactsDirectory, "temari-bridge/stages/build.json"), "utf8")) throw new Error("resume changed successful builder capture");
    completed = JSON.parse((await archon("completed", ["workflow", "get", runId, "--json"])).stdout);
  }
  if (completed.id !== runId || completed.status !== "completed") throw new Error(`live run ${runId} stopped with status ${completed.status}; use native Archon status; evidence ${root}`);
  const marker = await finalize({ repositoryRoot: prepared.repositoryRoot, artifactsDirectory, specPath, archonRunId: runId });
  if (!(await workflowCheck(marker.binding.temariRunDirectory, "review")).passed) throw new Error("canonical review check failed");
  const summary = { state: "review-passed", archonRunId: runId, root, task: prepared.task, budget: taskBudget(prepared.task), source: prepared.source, routing: frozen.routing, routingSha256: routingDigest(frozen.routing), observedRoles: { build: await json(join(root, "control/build-result.json")), review: await json(join(root, "control/review-result.json")) }, builderInvocations: 1, reviewerInvocations: 1, controlledVerificationResume: frozen.failVerificationOnce, candidate: marker.candidate, artifactsDirectory, receipt: resolve(artifactsDirectory, marker.receipt.path), planningProvenance: "host-reported", hardCrashRecovery: false };
  await writeJson(join(root, "summary.json"), summary);
  return summary;
}

if (import.meta.main) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === "stage") {
      if (args.length !== 3 || !Object.hasOwn(actors, args[0]!)) throw new Error("invalid internal live stage");
      await executeStage(args[0] as StageId, args[1]!, args[2]!);
    } else if (command === "prepare" || command === "run") {
      const options: Record<string, string | boolean> = {};
      for (let index = 0; index < args.length; index++) {
        const name = args[index]!;
        if (name in options) throw new Error(`duplicate option ${name}`);
        if (command === "run" && name === "--fail-verification-once") options[name] = true;
        else if (["--root", ...(command === "run" ? ["--planning", "--archon", "--codex", "--model", "--reasoning", "--builder-model", "--builder-reasoning", "--reviewer-model", "--reviewer-reasoning"] : ["--task", "--repository"])].includes(name)) {
          const value = args[++index];
          if (!value || value.startsWith("--")) throw new Error(`missing value for ${name}`);
          if (!["--model", "--reasoning", "--builder-model", "--builder-reasoning", "--reviewer-model", "--reviewer-reasoning", "--task"].includes(name) && !isAbsolute(value)) throw new Error(`${name} must be absolute`);
          options[name] = value;
        } else throw new Error(`unknown option ${name}`);
      }
      if (typeof options["--root"] !== "string") throw new Error("--root is required");
      if (command === "prepare") {
        const task = options["--task"] ?? "charge-cost";
        if (task === "charge-cost" && options["--repository"] !== undefined) throw new Error("--repository requires the Temari documentation task");
        if (task !== "charge-cost" && task !== "temari-routing-doc") throw new Error("unsupported closed pilot task");
        if (task === "temari-routing-doc" && typeof options["--repository"] !== "string") throw new Error("--repository is required for the Temari documentation task");
        console.log(JSON.stringify(await preparePilot(task === "charge-cost" ? { root: options["--root"] } : { root: options["--root"], task, repository: options["--repository"] as string }), null, 2));
      }
      else {
        for (const name of ["--planning", "--archon", "--codex"]) if (typeof options[name] !== "string") throw new Error(`${name} is required`);
        console.log(JSON.stringify(await runPilot({ root: options["--root"], planning: options["--planning"] as string, archon: options["--archon"] as string, codex: options["--codex"] as string, roles: parseRoleSelection(options), failVerificationOnce: options["--fail-verification-once"] === true }), null, 2));
      }
    } else throw new Error("Usage: bun live.ts prepare --root /absolute/empty-root [--task temari-routing-doc --repository /absolute/clean-temari-checkout]\n       bun live.ts run --root /absolute/root --planning /absolute/manifest.json --archon /absolute/archon --codex /absolute/codex [--builder-model MODEL --builder-reasoning EFFORT] [--reviewer-model MODEL --reviewer-reasoning EFFORT] [--fail-verification-once]");
  } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
