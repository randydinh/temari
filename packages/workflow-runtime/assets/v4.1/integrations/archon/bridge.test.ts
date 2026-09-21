import { afterEach, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { captureStage, finalize, STAGES, type BridgeRequest, type Capture, type StageId } from "./bridge.ts";
import { createPilot } from "./fixtures/pilot.ts";
import { startRun, satisfyRequirement, workflowCheck } from "../../skills/poteto-mode/scripts/workflow/workflow.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function pilot(options = {}): Promise<BridgeRequest> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "temari-archon-test-")));
  roots.push(root);
  return createPilot(root, options);
}
async function all(request: BridgeRequest): Promise<void> { for (const stage of STAGES) await captureStage(request, stage); }
async function exists(path: string): Promise<boolean> { return readFile(path).then(() => true, () => false); }
async function current(request: BridgeRequest, stage: StageId): Promise<{ path: string; value: Capture }> {
  const dir = join(request.artifactsDirectory, "temari-bridge");
  const { attempt } = JSON.parse(await readFile(join(dir, "stages", `${stage}.json`), "utf8"));
  const path = join(dir, "attempts", attempt, "capture.json");
  return { path, value: JSON.parse(await readFile(path, "utf8")) };
}
async function changeSpec(request: BridgeRequest, change: (spec: any) => void): Promise<void> {
  const spec = JSON.parse(await readFile(request.specPath, "utf8"));
  change(spec);
  await writeFile(request.specPath, JSON.stringify(spec));
}

test("happy capture creates a canonical review receipt and unchanged replay is idempotent", async () => {
  const request = await pilot();
  await all(request);
  const before = await current(request, "build");
  const first = await finalize(request);
  const firstMarker = await readFile(join(request.artifactsDirectory, "evidence.json"), "utf8");
  expect(first.binding.archonRunId).toBe(request.archonRunId);
  expect((await workflowCheck(first.binding.temariRunDirectory, "review")).passed).toBe(true);
  expect(JSON.parse(await readFile(join(first.binding.temariRunDirectory, "receipt.json"), "utf8")).boundary).toBe("review");
  expect(await captureStage(request, "build")).toEqual(before.value);
  await finalize(request);
  expect(await readFile(join(request.artifactsDirectory, "evidence.json"), "utf8")).toBe(firstMarker);
  expect(await readFile(join(roots[0]!, "control", "build-count"), "utf8")).toBe("1");
});

test("actual failing target tests block review, finalization and marker", async () => {
  const request = await pilot({ brokenBuild: true });
  await captureStage(request, "build");
  await captureStage(request, "shape-final");
  await expect(captureStage(request, "verify")).rejects.toThrow("command failed");
  await expect(captureStage(request, "review")).rejects.toThrow("verify has no completed capture");
  await expect(finalize(request)).rejects.toThrow("verify has no completed capture");
  expect(await exists(join(request.artifactsDirectory, "evidence.json"))).toBe(false);
  const { path } = await current(request, "verify");
  expect(await readFile(join(path, "..", "stderr.log"), "utf8")).toContain("fail");
});

test("a failed unchanged verifier retries without rebuilding", async () => {
  const request = await pilot({ failOnce: true });
  await captureStage(request, "build");
  await captureStage(request, "shape-final");
  await expect(captureStage(request, "verify")).rejects.toThrow('"exitCode":23');
  const failed = await current(request, "verify");
  await captureStage(request, "verify");
  expect((await current(request, "verify")).value.attempt).not.toBe(failed.value.attempt);
  await captureStage(request, "review");
  await finalize(request);
  expect(await readFile(join(roots[0]!, "control", "build-count"), "utf8")).toBe("1");
});

test.each(["tracked", "untracked", "commit"])("%s candidate drift rejects cached build and completion", async (drift) => {
  const request = await pilot();
  await all(request);
  await finalize(request);
  if (drift === "tracked") await writeFile(join(request.repositoryRoot, "charge-cost.ts"), "changed\n");
  if (drift === "untracked") await writeFile(join(request.repositoryRoot, "unexpected.txt"), "changed\n");
  if (drift === "commit") execFileSync("git", ["-C", request.repositoryRoot, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "Changed HEAD"], { stdio: "pipe" });
  await expect(captureStage(request, "build")).rejects.toThrow("candidate changed");
  await expect(finalize(request)).rejects.toThrow("candidate changed");
  expect(await exists(join(request.artifactsDirectory, "evidence.json"))).toBe(false);
});

test("sealed artifact and sealed command output drift reject completion", async () => {
  for (const field of ["evidence", "logs"] as const) {
    const request = await pilot();
    await all(request);
    const capture = (await current(request, "verify")).value;
    if (capture.state !== "complete") throw new Error("fixture incomplete");
    await writeFile(join(request.artifactsDirectory, "temari-bridge", capture[field][0]!.path), "changed\n");
    await expect(finalize(request)).rejects.toThrow("sealed artifact changed");
  }
});

test("run ID, spec bytes and repository identity cannot be rebound", async () => {
  const request = await pilot();
  await captureStage(request, "build");
  await expect(finalize({ ...request, archonRunId: "other-run" })).rejects.toThrow("run binding changed");
  const another = await pilot();
  await expect(finalize({ ...request, repositoryRoot: another.repositoryRoot })).rejects.toThrow("run binding changed");
  await writeFile(request.specPath, `${await readFile(request.specPath, "utf8")}\n`);
  await expect(captureStage(request, "shape-final")).rejects.toThrow("run binding changed");
});

test("profile content drift invalidates the run", async () => {
  const request = await pilot();
  const spec = JSON.parse(await readFile(request.specPath, "utf8"));
  const profile = JSON.parse(await readFile(spec.profilePath, "utf8"));
  const copy = join(roots[0]!, "profile.json");
  profile.playbook.path = relative(dirname(copy), resolve(dirname(spec.profilePath), profile.playbook.path));
  await writeFile(copy, JSON.stringify(profile));
  await changeSpec(request, (value) => { value.profilePath = copy; });
  await captureStage(request, "build");
  await writeFile(copy, `${await readFile(copy, "utf8")}\n`);
  await expect(captureStage(request, "shape-final")).rejects.toThrow("run binding changed");
});

test("independent ownership and stage order are required before execution", async () => {
  const request = await pilot();
  await expect(captureStage(request, "verify")).rejects.toThrow("build has no completed capture");
  const duplicate = await pilot();
  await changeSpec(duplicate, (spec) => { spec.assignments.review = spec.assignments.build; spec.stages.review.actor = spec.assignments.build; });
  await expect(captureStage(duplicate, "build")).rejects.toThrow("must differ");
  const wrong = await pilot();
  await changeSpec(wrong, (spec) => { spec.stages.review.actor = "unassigned-reviewer"; });
  await expect(captureStage(wrong, "build")).rejects.toThrow("does not own stage review");
});

test("a failed mutating attempt that changed files is never replayed", async () => {
  const request = await pilot();
  await changeSpec(request, (spec) => {
    spec.stages.build.command = { executable: process.execPath, args: ["-e", 'await Bun.write("partial.txt", "partial edit"); process.exit(9)'], timeoutMs: 3000 };
  });
  await expect(captureStage(request, "build")).rejects.toThrow("command failed");
  await expect(captureStage(request, "build")).rejects.toThrow("mutating attempt is indeterminate");
});

test("a persisted interrupted builder fails closed even if its current tree is unchanged", async () => {
  const request = await pilot();
  await changeSpec(request, (spec) => { spec.stages.build.command = { executable: process.execPath, args: ["-e", "process.exit(9)"], timeoutMs: 3000 }; });
  await expect(captureStage(request, "build")).rejects.toThrow("command failed");
  const { path, value } = await current(request, "build");
  const { version, stage, actor, attempt, startedAt, bindingSha256, before } = value;
  await writeFile(path, JSON.stringify({ version, stage, actor, attempt, startedAt, bindingSha256, before, state: "running" }));
  await expect(captureStage(request, "build")).rejects.toThrow("mutating attempt is indeterminate");
});

test("terminating the bridge stops its builder and cannot repeat an external side effect", async () => {
  const request = await pilot();
  const count = join(roots[0]!, "counter");
  await changeSpec(request, (spec) => { spec.stages.build.command = { executable: process.execPath, args: ["-e", `const file = Bun.file(${JSON.stringify(count)}); await Bun.write(file, String(Number(await file.text().catch(() => "0")) + 1)); await Bun.sleep(10000)`], timeoutMs: 3000 }; });
  const child = spawn(process.execPath, [fileURLToPath(new URL("./bridge.ts", import.meta.url)), "capture", "--repository", request.repositoryRoot, "--artifacts", request.artifactsDirectory, "--spec", request.specPath, "--workflow-id", request.archonRunId, "--stage", "build"], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (data) => { stderr += data; });
  const ended = new Promise((done) => child.on("close", done));
  for (let index = 0; index < 100 && !await exists(count); index++) await Bun.sleep(10);
  child.kill("SIGTERM");
  await ended;
  expect(stderr).toContain("bridge received a termination signal");
  await expect(captureStage(request, "build")).rejects.toThrow("mutating attempt is indeterminate");
  expect(await readFile(count, "utf8")).toBe("1");
});

test("another capture is excluded before spawning and command timeout is recorded", async () => {
  const request = await pilot();
  const started = join(roots[0]!, "started");
  await changeSpec(request, (spec) => { spec.stages.build.command = { executable: process.execPath, args: ["-e", `await Bun.write(${JSON.stringify(started)}, "started"); await Bun.sleep(10000)`], timeoutMs: 500 }; });
  const first = captureStage(request, "build").then(() => "unexpected success", (error: Error) => error.message);
  for (let index = 0; index < 100 && !await exists(started); index++) await Bun.sleep(10);
  expect(await exists(started)).toBe(true);
  await expect(captureStage(request, "build")).rejects.toThrow("bridge is locked");
  expect(await first).toContain('"timedOut":true');
  await expect(captureStage(request, "build")).rejects.toThrow("mutating attempt is indeterminate");
});

test("a partial canonical import resumes without replacing existing evidence", async () => {
  const request = await pilot();
  await all(request);
  const binding = JSON.parse(await readFile(join(request.artifactsDirectory, "temari-bridge", "binding.json"), "utf8"));
  const spec = JSON.parse(await readFile(request.specPath, "utf8"));
  await startRun({ runDirectory: binding.temariRunDirectory, profilePath: spec.profilePath, repositoryRoot: binding.repositoryRoot, coordinator: spec.coordinator, assignments: spec.assignments, capabilities: ["subagents"] });
  const build = (await current(request, "build")).value;
  if (build.state !== "complete") throw new Error("fixture incomplete");
  const evidence = build.evidence[0]!;
  const record = await satisfyRequirement({ runDirectory: binding.temariRunDirectory, actor: build.actor, requirementId: evidence.requirementId, evidenceKind: evidence.kind, evidencePath: join(request.artifactsDirectory, "temari-bridge", evidence.path) });
  await finalize(request);
  const again = await satisfyRequirement({ runDirectory: binding.temariRunDirectory, actor: build.actor, requirementId: evidence.requirementId, evidenceKind: evidence.kind, evidencePath: join(request.artifactsDirectory, "temari-bridge", evidence.path) });
  expect(again).toEqual(record);
});

test("read-only stage mutation invalidates its capture", async () => {
  const request = await pilot();
  await changeSpec(request, (spec) => { spec.stages.verify.command = { executable: process.execPath, args: ["-e", 'await Bun.write("unexpected.txt", "edit")'], timeoutMs: 3000 }; });
  await captureStage(request, "build");
  await captureStage(request, "shape-final");
  await expect(captureStage(request, "verify")).rejects.toThrow("read-only command changed");
  await expect(finalize(request)).rejects.toThrow("candidate changed");
});
