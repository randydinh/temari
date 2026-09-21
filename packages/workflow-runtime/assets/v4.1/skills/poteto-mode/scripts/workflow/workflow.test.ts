import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { sha256 } from "./profiles.ts";
import { loadProfile, loadRun, startRun } from "./workflow.ts";
import { openGate, pivotRoute, resolveGate, satisfyRequirement, skipRequirement, workflowCheck, writeReceipt } from "./workflow.ts";
import { repositoryRevision } from "./store.ts";
import { GATE_ACTOR_IDENTITY_LIMITATION } from "./receipt.ts";

const CONTRACTS = resolve(import.meta.dir, "../../playbook-contracts/v1");
const LIGHTWEIGHT = join(CONTRACTS, "lightweight-engineering.json");
const FEATURE = join(CONTRACTS, "feature.json");
const CLI = resolve(import.meta.dir, "workflow.ts");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ readonly root: string; readonly repo: string; readonly run: string; readonly evidence: string }> {
  const root = await mkdtemp(join(tmpdir(), "temari-workflow-"));
  roots.push(root);
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  await writeFile(join(repo, "README.md"), "fixture\n");
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", repo, "add", "README.md"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "fixture"]);
  const evidence = join(root, "evidence.txt");
  await writeFile(evidence, "observed result\n");
  return { root, repo, run: join(root, "run"), evidence };
}

async function satisfyLightweight(run: string, evidence: string): Promise<void> {
  for (const requirementId of [
    "lightweight.intake.inspect",
    "lightweight.route.qualifies",
    "lightweight.build.smallest-complete-change",
    "lightweight.verify.direct-check",
  ]) {
    const kind = requirementId.includes("build") ? "diff" : requirementId.includes("route") ? "review" : "command";
    await satisfyRequirement({ runDirectory: run, actor: "lead", requirementId, evidencePath: evidence, evidenceKind: kind });
  }
}

function recordFile(run: string, sequence: number, stage: string, requirement: string, kind: "evidence" | "skip" = "evidence"): string {
  return join(run, "stages", stage, "records", String(sequence).padStart(6, "0"), `${requirement}.${kind}.json`);
}

describe("WorkflowRun", () => {
  test("runs the lightweight lifecycle through the public API with derived completion", async () => {
    const { repo, run, evidence } = await fixture();
    const started = await startRun({ runDirectory: run, profilePath: LIGHTWEIGHT, repositoryRoot: repo, coordinator: "lead" });
    expect(started.profile.stages.map((stage) => stage.id)).toEqual(["intake", "route", "build", "verify"]);
    await satisfyLightweight(run, evidence);
    expect(await workflowCheck(run, "final")).toMatchObject({ boundary: "final", passed: true, profileId: "lightweight-engineering-v1" });
    expect(await workflowCheck(run, "publish")).toMatchObject({ passed: false, gates: [{ gateId: "operator-approval", state: "missing" }] });
    await openGate(run, "operator-approval", "Operator reviews the exact head", "lead", "2026-09-17T00:00:00.000Z");
    expect(await workflowCheck(run, "publish")).toMatchObject({ passed: false, gates: [{ gateId: "operator-approval", state: "open" }] });
    await resolveGate(run, "operator-approval", "approved", "lead", "2026-09-17T00:01:00.000Z");
    expect((await workflowCheck(run, "publish")).passed).toBe(true);
    const receipt = await writeReceipt(run, "publish", "lead", "2026-09-17T00:02:00.000Z");
    expect(receipt).toMatchObject({ runId: "run", boundary: "publish", limitation: GATE_ACTOR_IDENTITY_LIMITATION, verdict: { passed: true } });
    expect(await writeReceipt(run, "publish", "lead", "later")).toEqual(receipt);
  });

  test("completes a Feature run while preserving parallel design and delegated implementation", async () => {
    const { repo, run, evidence } = await fixture();
    await startRun({ runDirectory: run, profilePath: FEATURE, repositoryRoot: repo, coordinator: "lead", capabilities: ["subagents"], assignments: { build: "builder", review: "reviewer" } });
    const requirements: readonly [string, "document" | "review" | "diff" | "runtime"][] = [
      ["feature.shape.how", "document"],
      ["feature.shape.parallel-design", "review"],
      ["feature.shape.throughput-checkpoint", "document"],
      ["feature.build.delegated-implementation", "diff"],
      ["feature.verify.matching-surface", "runtime"],
      ["feature.review.ordered-commits", "review"],
    ];
    for (const [requirementId, evidenceKind] of requirements) {
      const actor = requirementId.includes(".build.") ? "builder" : requirementId.includes(".review.") ? "reviewer" : "lead";
      await satisfyRequirement({ runDirectory: run, actor, requirementId, evidencePath: evidence, evidenceKind });
    }
    await skipRequirement({ runDirectory: run, actor: "lead", requirementId: "feature.delivery.pull-request", reason: "Forge access is unavailable", allowedBy: "forge" });
    expect((await workflowCheck(run, "review")).passed).toBe(true);
    await openGate(run, "operator-approval", "Review exact Feature head", "lead");
    await resolveGate(run, "operator-approval", "approved", "lead");
    expect((await workflowCheck(run, "publish")).passed).toBe(true);
    const routePath = join(run, "events", "routes", "000001.json");
    const route = JSON.parse(await readFile(routePath, "utf8"));
    route.assignments.review = "builder";
    await writeFile(routePath, JSON.stringify(route));
    await expect(workflowCheck(run, "publish")).rejects.toThrow("stage build: stage owner must differ from review");
    await expect(writeReceipt(run, "publish", "lead")).rejects.toThrow("stage build: stage owner must differ from review");
  });

  test("completes a Feature review with only the skips allowed when subagents are unavailable", async () => {
    const { repo, run, evidence } = await fixture();
    await startRun({ runDirectory: run, profilePath: FEATURE, repositoryRoot: repo, coordinator: "lead", assignments: { build: "builder", review: "reviewer" } });
    await satisfyRequirement({ runDirectory: run, actor: "lead", requirementId: "feature.shape.how", evidencePath: evidence, evidenceKind: "document" });
    await skipRequirement({ runDirectory: run, actor: "lead", requirementId: "feature.shape.parallel-design", reason: "Host does not declare subagents", allowedBy: "subagents" });
    await satisfyRequirement({ runDirectory: run, actor: "lead", requirementId: "feature.shape.throughput-checkpoint", evidencePath: evidence, evidenceKind: "document" });
    await skipRequirement({ runDirectory: run, actor: "builder", requirementId: "feature.build.delegated-implementation", reason: "Host does not declare subagents", allowedBy: "subagents" });
    await satisfyRequirement({ runDirectory: run, actor: "lead", requirementId: "feature.verify.matching-surface", evidencePath: evidence, evidenceKind: "runtime" });
    await satisfyRequirement({ runDirectory: run, actor: "reviewer", requirementId: "feature.review.ordered-commits", evidencePath: evidence, evidenceKind: "review" });
    await expect(skipRequirement({ runDirectory: run, actor: "lead", requirementId: "feature.shape.how", reason: "Host does not declare subagents", allowedBy: "subagents" })).rejects.toThrow("cannot be skipped");
    expect(await workflowCheck(run, "review")).toMatchObject({
      passed: true,
      assignments: [
        { stageId: "shape", state: "valid", owner: "lead" },
        { stageId: "build", state: "valid", owner: "builder" },
        { stageId: "verify", state: "valid", owner: "lead" },
        { stageId: "review", state: "valid", owner: "reviewer" },
        { stageId: "delivery", state: "valid", owner: "lead" },
      ],
      requirements: [
        { requirementId: "feature.shape.how", state: "satisfied" },
        { requirementId: "feature.shape.parallel-design", state: "skipped" },
        { requirementId: "feature.shape.throughput-checkpoint", state: "satisfied" },
        { requirementId: "feature.build.delegated-implementation", state: "skipped" },
        { requirementId: "feature.verify.matching-surface", state: "satisfied" },
        { requirementId: "feature.review.ordered-commits", state: "satisfied" },
      ],
    });
  });

  test("does not allow Feature subagent requirements to be skipped when subagents are available", async () => {
    const { repo, run } = await fixture();
    await startRun({ runDirectory: run, profilePath: FEATURE, repositoryRoot: repo, coordinator: "lead", capabilities: ["subagents"], assignments: { build: "builder", review: "reviewer" } });
    await expect(skipRequirement({ runDirectory: run, actor: "lead", requirementId: "feature.shape.parallel-design", reason: "Not needed", allowedBy: "subagents" })).rejects.toThrow("cannot be skipped for subagents");
    await expect(skipRequirement({ runDirectory: run, actor: "builder", requirementId: "feature.build.delegated-implementation", reason: "Not needed", allowedBy: "subagents" })).rejects.toThrow("cannot be skipped for subagents");
  });

  test("emits actionable compact and JSON startup output through the CLI", async () => {
    const { repo, run } = await fixture();
    const compact = spawnSync(process.execPath, [CLI, "--run", run, "start", "--profile", LIGHTWEIGHT, "--repo", repo, "--coordinator", "lead"], { encoding: "utf8" });
    expect(compact.status).toBe(0);
    expect(compact.stdout.trim()).toBe("started run playbook=320f33d095434c5a58fd2adb2abf6a1fcd458fe3a2af431a227d6f51dde6e492 stage=intake next=lightweight.intake.inspect");
    const json = spawnSync(process.execPath, [CLI, "--json", "--run", run, "start", "--profile", LIGHTWEIGHT, "--repo", repo, "--coordinator", "lead"], { encoding: "utf8" });
    expect(json.status).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual({ runId: "run", playbookSha256: "320f33d095434c5a58fd2adb2abf6a1fcd458fe3a2af431a227d6f51dde6e492", currentStage: "intake", nextRequirement: "lightweight.intake.inspect" });
  });

  test.each(["bad", "FINAL", "release"])("rejects the invalid boundary literal %s", async (invalidBoundary) => {
    const { repo, run } = await fixture();
    await startRun({ runDirectory: run, profilePath: LIGHTWEIGHT, repositoryRoot: repo, coordinator: "lead" });
    const result = spawnSync(process.execPath, [CLI, "--run", run, "check", "--boundary", invalidBoundary], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("boundary must be final, commit, review, or publish");
  });

  test("rejects malformed profiles and canonical playbook drift", async () => {
    const { root, repo } = await fixture();
    const malformed = join(root, "malformed.json");
    const raw = JSON.parse(await readFile(LIGHTWEIGHT, "utf8"));
    raw.unexpected = true;
    await writeFile(malformed, JSON.stringify(raw));
    await expect(startRun({ runDirectory: join(root, "bad"), profilePath: malformed, repositoryRoot: repo, coordinator: "lead" })).rejects.toThrow("unknown or missing fields");

    const playbook = join(root, "playbook.md");
    const drifted = join(root, "drifted.json");
    await writeFile(playbook, "canonical v1\n");
    raw.unexpected = undefined;
    delete raw.unexpected;
    raw.id = "custom-v1";
    raw.playbook = { path: "playbook.md", sha256: "0".repeat(64) };
    await writeFile(drifted, JSON.stringify(raw));
    await expect(startRun({ runDirectory: join(root, "drift"), profilePath: drifted, repositoryRoot: repo, coordinator: "lead" })).rejects.toThrow("playbook drift");
  });

  test("requires profiles to declare all required and skippable capabilities", async () => {
    const { root, repo } = await fixture();
    const missingForge = join(root, "missing-forge.json");
    const profile = JSON.parse(await readFile(FEATURE, "utf8"));
    profile.hostCapabilities = ["subagents"];
    delete profile.stages.at(-1).requirements[0].requiredCapabilities;
    await writeFile(missingForge, JSON.stringify(profile));
    await expect(loadProfile(missingForge, false)).rejects.toThrow("feature.delivery.pull-request skips for undeclared capability forge");
    const missingSubagents = join(root, "missing-subagents.json");
    const missingSubagentsProfile = JSON.parse(await readFile(FEATURE, "utf8"));
    missingSubagentsProfile.hostCapabilities = ["forge"];
    await writeFile(missingSubagents, JSON.stringify(missingSubagentsProfile));
    await expect(loadProfile(missingSubagents, false)).rejects.toThrow("feature.shape.parallel-design requires undeclared capability subagents");
    await expect(startRun({ runDirectory: join(root, "claimed"), profilePath: LIGHTWEIGHT, repositoryRoot: repo, coordinator: "lead", capabilities: ["forge"] })).rejects.toThrow("claimed capability forge is not declared by profile lightweight-engineering-v1");
    expect((await loadProfile(FEATURE)).hostCapabilities).toEqual(["subagents", "forge"]);
  });

  test("ingests evidence below the assigned stage and preserves the prior record on retry", async () => {
    const { repo, run, evidence } = await fixture();
    await startRun({ runDirectory: run, profilePath: LIGHTWEIGHT, repositoryRoot: repo, coordinator: "lead" });
    const first = await satisfyRequirement({ runDirectory: run, actor: "lead", requirementId: "lightweight.intake.inspect", evidencePath: evidence, evidenceKind: "command" });
    expect(first.evidencePath).toBe(`stages/intake/evidence/lightweight.intake.inspect.${first.evidenceSha256}.evidence`);
    expect(await readFile(join(run, first.evidencePath), "utf8")).toBe("observed result\n");
    await writeFile(evidence, "changed source\n");
    expect((await workflowCheck(run, "final")).requirements[0]).toMatchObject({ state: "satisfied" });
    await expect(satisfyRequirement({ runDirectory: run, actor: "lead", requirementId: "lightweight.intake.inspect", evidencePath: evidence, evidenceKind: "command" })).rejects.toThrow("already has different evidence");
    expect(JSON.parse(await readFile(recordFile(run, 1, "intake", "lightweight.intake.inspect"), "utf8"))).toMatchObject({ evidencePath: first.evidencePath, evidenceSha256: first.evidenceSha256 });
    const repeated = await satisfyRequirement({ runDirectory: run, actor: "lead", requirementId: "lightweight.intake.inspect", evidencePath: join(run, first.evidencePath), evidenceKind: "command" });
    expect(repeated).toEqual(first);
  });

  test("rejects evidence records that escape the deterministic run-relative artifact path", async () => {
    const { repo, run, evidence } = await fixture();
    await startRun({ runDirectory: run, profilePath: LIGHTWEIGHT, repositoryRoot: repo, coordinator: "lead" });
    await satisfyRequirement({ runDirectory: run, actor: "lead", requirementId: "lightweight.intake.inspect", evidencePath: evidence, evidenceKind: "command" });
    const record = recordFile(run, 1, "intake", "lightweight.intake.inspect");
    const raw = JSON.parse(await readFile(record, "utf8"));
    raw.evidencePath = "../../evidence.txt";
    await writeFile(record, JSON.stringify(raw));
    expect((await workflowCheck(run, "final")).requirements[0]).toMatchObject({ state: "invalid", reason: "evidence record evidencePath is not the deterministic stage artifact path" });
  });

  test("enforces stage ownership, allowed evidence kinds, and skip policy", async () => {
    const { repo, run, evidence } = await fixture();
    await startRun({ runDirectory: run, profilePath: FEATURE, repositoryRoot: repo, coordinator: "lead", capabilities: ["subagents"], assignments: { build: "builder", review: "reviewer" } });
    await expect(satisfyRequirement({ runDirectory: run, actor: "lead", requirementId: "feature.build.delegated-implementation", evidencePath: evidence, evidenceKind: "diff" })).rejects.toThrow("does not own stage build");
    await expect(satisfyRequirement({ runDirectory: run, actor: "builder", requirementId: "feature.build.delegated-implementation", evidencePath: evidence, evidenceKind: "command" })).rejects.toThrow("is not allowed");
    await expect(skipRequirement({ runDirectory: run, actor: "lead", requirementId: "feature.shape.how", reason: "no", allowedBy: "forge" })).rejects.toThrow("cannot be skipped");
    const skipped = await skipRequirement({ runDirectory: run, actor: "lead", requirementId: "feature.delivery.pull-request", reason: "No configured forge", allowedBy: "forge" });
    expect(skipped).toMatchObject({ allowedBy: "forge", producer: "lead" });
    expect(await skipRequirement({ runDirectory: run, actor: "lead", requirementId: "feature.delivery.pull-request", reason: "No configured forge", allowedBy: "forge" })).toEqual(skipped);
    const other = await fixture();
    await startRun({ runDirectory: other.run, profilePath: LIGHTWEIGHT, repositoryRoot: other.repo, coordinator: "lead" });
    await expect(resolveGate(other.run, "operator-approval", "approved", "lead")).rejects.toThrow("has never been opened");
  });

  test("enforces profile-declared assignment constraints before creating run state", async () => {
    const { root, repo, run } = await fixture();
    await expect(startRun({ runDirectory: run, profilePath: FEATURE, repositoryRoot: repo, coordinator: "lead", capabilities: ["subagents"] })).rejects.toThrow("stage build: stage must be owned by a non-coordinator");
    expect(await readdir(root)).not.toContain("run");
    await expect(startRun({ runDirectory: run, profilePath: FEATURE, repositoryRoot: repo, coordinator: "lead", capabilities: ["subagents"], assignments: { build: "worker", review: "worker" } })).rejects.toThrow("stage build: stage owner must differ from review");
    expect(await readdir(root)).not.toContain("run");
    await expect(startRun({ runDirectory: run, profilePath: LIGHTWEIGHT, repositoryRoot: repo, coordinator: "lead", assignments: { build: "worker" } })).rejects.toThrow("stage build: stage must be owned by the coordinator");
    expect(await readdir(root)).not.toContain("run");
    await startRun({ runDirectory: run, profilePath: FEATURE, repositoryRoot: repo, coordinator: "lead", capabilities: ["subagents"], assignments: { build: "builder", review: "reviewer" } });
    expect((await workflowCheck(run, "final")).assignments).toEqual([
      { stageId: "shape", state: "valid", owner: "lead" },
      { stageId: "build", state: "valid", owner: "builder" },
      { stageId: "verify", state: "valid", owner: "lead" },
      { stageId: "review", state: "valid", owner: "reviewer" },
      { stageId: "delivery", state: "valid", owner: "lead" },
    ]);
  });

  test("rejects tampered active route capabilities and assignments at load time", async () => {
    const lightweight = await fixture();
    await startRun({ runDirectory: lightweight.run, profilePath: LIGHTWEIGHT, repositoryRoot: lightweight.repo, coordinator: "lead" });
    const routePath = join(lightweight.run, "events", "routes", "000001.json");
    const original = JSON.parse(await readFile(routePath, "utf8"));
    await writeFile(routePath, JSON.stringify({ ...original, capabilities: ["forge"] }));
    await expect(loadRun(lightweight.run)).rejects.toThrow("capability forge is not declared");
    const missing = structuredClone(original);
    delete missing.assignments.verify;
    await writeFile(routePath, JSON.stringify(missing));
    await expect(loadRun(lightweight.run)).rejects.toThrow("do not cover exactly");
    await writeFile(routePath, JSON.stringify({ ...original, assignments: { ...original.assignments, unknown: "intruder" } }));
    await expect(loadRun(lightweight.run)).rejects.toThrow("unknown stage unknown");

    const feature = await fixture();
    await startRun({ runDirectory: feature.run, profilePath: FEATURE, repositoryRoot: feature.repo, coordinator: "lead", capabilities: ["subagents"], assignments: { build: "builder", review: "reviewer" } });
    const featureRoutePath = join(feature.run, "events", "routes", "000001.json");
    const featureRoute = JSON.parse(await readFile(featureRoutePath, "utf8"));
    featureRoute.capabilities = ["subagents", "subagents"];
    await writeFile(featureRoutePath, JSON.stringify(featureRoute));
    await expect(loadRun(feature.run)).rejects.toThrow("claimed capabilities must be unique");
  });

  test("rejects tampered evidence hashes, producers, revisions, and SHA fields", async () => {
    const { repo, run, evidence } = await fixture();
    await startRun({ runDirectory: run, profilePath: LIGHTWEIGHT, repositoryRoot: repo, coordinator: "lead" });
    await satisfyLightweight(run, evidence);
    const firstRecord = JSON.parse(await readFile(recordFile(run, 1, "intake", "lightweight.intake.inspect"), "utf8"));
    const ingestedEvidence = join(run, firstRecord.evidencePath);
    await writeFile(ingestedEvidence, "tampered\n");
    expect((await workflowCheck(run, "final")).requirements[0]).toMatchObject({ state: "invalid", reason: "evidence hash does not match the recorded artifact" });
    await writeFile(ingestedEvidence, "observed result\n");
    const record = recordFile(run, 1, "intake", "lightweight.intake.inspect");
    const raw = JSON.parse(await readFile(record, "utf8"));
    raw.producer = "intruder";
    await writeFile(record, JSON.stringify(raw));
    expect((await workflowCheck(run, "final")).requirements[0]).toMatchObject({ state: "invalid", reason: "evidence producer is not the assigned stage owner" });
    raw.producer = "lead";
    raw.evidenceSha256 = "NOT-A-SHA";
    await writeFile(record, JSON.stringify(raw));
    expect((await workflowCheck(run, "final")).requirements[0]).toMatchObject({ state: "invalid", reason: expect.stringContaining("invalid format") });
    raw.evidenceSha256 = sha256("observed result\n");
    await writeFile(record, JSON.stringify(raw));
    await writeFile(join(repo, "new.txt"), "revision change\n");
    expect((await workflowCheck(run, "final")).requirements[0]).toMatchObject({ state: "invalid", reason: "evidence belongs to a different repository revision" });
  });

  test("pivots away from stale profiles while preserving and invalidating old evidence", async () => {
    const { root, repo, run, evidence } = await fixture();
    const playbook = join(root, "custom-playbook.md");
    await writeFile(playbook, "version one\n");
    const profilePath = join(root, "profile-v1.json");
    const profile = JSON.parse(await readFile(LIGHTWEIGHT, "utf8"));
    profile.id = "custom-lightweight-v1";
    profile.playbook = { path: "custom-playbook.md", sha256: sha256("version one\n") };
    await writeFile(profilePath, JSON.stringify(profile));
    await startRun({ runDirectory: run, profilePath, repositoryRoot: repo, coordinator: "lead" });
    await satisfyRequirement({ runDirectory: run, actor: "lead", requirementId: "lightweight.intake.inspect", evidencePath: evidence, evidenceKind: "command" });
    await openGate(run, "operator-approval", "old route", "lead");
    await resolveGate(run, "operator-approval", "approved", "lead");
    await writeFile(playbook, "unreviewed drift\n");
    await expect(loadRun(run)).rejects.toThrow("playbook drift");
    await expect(pivotRoute(run, FEATURE, "lead")).rejects.toThrow("stage build: stage must be owned by a non-coordinator");
    await expect(pivotRoute(run, FEATURE, "lead", { capabilities: ["subagents"], assignments: { build: "worker", review: "worker" } })).rejects.toThrow("stage build: stage owner must differ from review");
    expect(await readdir(join(run, "events", "routes"))).toEqual(["000001.json"]);
    expect((await readdir(join(run, "stages"))).sort()).toEqual(["build", "intake", "route", "verify"]);
    const pivot = spawnSync(process.execPath, [CLI, "--run", run, "--actor", "lead", "route-pivot", "--profile", FEATURE, "--capability", "subagents", "--assign", "build=builder", "--assign", "review=reviewer"], { encoding: "utf8" });
    expect(pivot.status).toBe(0);
    const event = (await loadRun(run)).routes.at(-1)!;
    expect(event).toMatchObject({ fromProfileId: "custom-lightweight-v1", profileId: "feature-v1", invalidatedRequirementIds: expect.arrayContaining(["lightweight.intake.inspect"]) });
    expect(event).toMatchObject({ capabilities: ["subagents"], assignments: { shape: "lead", build: "builder", verify: "lead", review: "reviewer", delivery: "lead" } });
    expect(await readFile(recordFile(run, 1, "intake", "lightweight.intake.inspect"), "utf8")).toContain("custom-lightweight-v1");
    await satisfyRequirement({ runDirectory: run, actor: "builder", requirementId: "feature.build.delegated-implementation", evidencePath: evidence, evidenceKind: "diff" });
    expect(await readFile(recordFile(run, 2, "build", "feature.build.delegated-implementation"), "utf8")).toContain("feature-v1");
    expect((await workflowCheck(run, "publish")).gates).toEqual([{ gateId: "operator-approval", state: "stale" }]);
  });

  test("refreshes an edited sidecar after drift and invalidates records by profile identity", async () => {
    const { root, repo, run, evidence } = await fixture();
    const playbook = join(root, "playbook.md");
    const profilePath = join(root, "profile.json");
    await writeFile(playbook, "version one\n");
    const profile = JSON.parse(await readFile(LIGHTWEIGHT, "utf8"));
    profile.id = "refresh-v1";
    profile.playbook = { path: "playbook.md", sha256: sha256("version one\n") };
    await writeFile(profilePath, JSON.stringify(profile));
    await startRun({ runDirectory: run, profilePath, repositoryRoot: repo, coordinator: "lead" });
    await satisfyRequirement({ runDirectory: run, actor: "lead", requirementId: "lightweight.intake.inspect", evidencePath: evidence, evidenceKind: "command" });
    await writeFile(playbook, "version two\n");
    profile.id = "refresh-v2";
    profile.playbook.sha256 = sha256("version two\n");
    await writeFile(profilePath, JSON.stringify(profile));
    const event = await pivotRoute(run, profilePath, "lead");
    expect(event).toMatchObject({ fromProfileId: "refresh-v1", profileId: "refresh-v2", sequence: 2, invalidatedRequirementIds: ["lightweight.intake.inspect", "lightweight.route.qualifies", "lightweight.build.smallest-complete-change", "lightweight.verify.direct-check"] });
    expect((await workflowCheck(run, "final")).requirements[0]).toMatchObject({ state: "pending", reason: "no evidence or allowed skip" });
    expect(await readFile(recordFile(run, 1, "intake", "lightweight.intake.inspect"), "utf8")).toContain("refresh-v1");
    await satisfyRequirement({ runDirectory: run, actor: "lead", requirementId: "lightweight.intake.inspect", evidencePath: evidence, evidenceKind: "command" });
    expect((await workflowCheck(run, "final")).requirements[0]).toMatchObject({ state: "satisfied", recordPath: recordFile(run, 2, "intake", "lightweight.intake.inspect") });
    expect(await readFile(recordFile(run, 2, "intake", "lightweight.intake.inspect"), "utf8")).toContain("refresh-v2");
  });

  test("reconciles partial start state and retries gates only at the same revision", async () => {
    const { repo, run } = await fixture();
    const first = await startRun({ runDirectory: run, profilePath: LIGHTWEIGHT, repositoryRoot: repo, coordinator: "lead", now: () => "2026-09-17T00:00:00.000Z" });
    await rm(join(run, "events", "routes"), { recursive: true });
    await rm(join(run, "stages"), { recursive: true });
    const resumed = await startRun({ runDirectory: run, profilePath: LIGHTWEIGHT, repositoryRoot: repo, coordinator: "lead", now: () => "later" });
    expect(resumed.routes).toHaveLength(1);
    expect(resumed.routes[0]!.at).toBe(first.manifest.createdAt);
    expect((await readdir(join(run, "stages"))).sort()).toEqual(["build", "intake", "route", "verify"]);
    const opened = await openGate(run, "operator-approval", "Review head", "lead");
    expect(await openGate(run, "operator-approval", "Review head", "lead", "later")).toEqual(opened);
    const resolved = await resolveGate(run, "operator-approval", "approved", "lead");
    expect(await resolveGate(run, "operator-approval", "approved", "lead", "later")).toEqual(resolved);
    await writeFile(join(repo, "README.md"), "changed revision\n");
    const renewed = await resolveGate(run, "operator-approval", "approved", "lead", "2026-09-17T01:00:00.000Z");
    expect(renewed.sequence).toBe(3);
    expect(renewed.worktreeFingerprint).not.toBe(resolved.worktreeFingerprint);
  });

  test("fingerprints different content even when porcelain status is unchanged", async () => {
    const { repo, run, evidence } = await fixture();
    await startRun({ runDirectory: run, profilePath: LIGHTWEIGHT, repositoryRoot: repo, coordinator: "lead" });
    await writeFile(join(repo, "README.md"), "first dirty content\n");
    await satisfyRequirement({ runDirectory: run, actor: "lead", requirementId: "lightweight.intake.inspect", evidencePath: evidence, evidenceKind: "command" });
    await writeFile(join(repo, "README.md"), "second dirty content\n");
    expect((await workflowCheck(run, "final")).requirements[0]).toMatchObject({ state: "invalid", reason: "evidence belongs to a different repository revision" });
  });

  test("checks one hundred requirements within the boundary latency budget", async () => {
    const { root, repo, run, evidence } = await fixture();
    const playbook = join(root, "perf-playbook.md");
    const profilePath = join(root, "perf-profile.json");
    await writeFile(playbook, "performance fixture\n");
    const requirementIds = Array.from({ length: 100 }, (_, index) => `perf.verify.r${String(index + 1).padStart(3, "0")}`);
    const requirements = requirementIds.map((id, index) => ({ id, sourceStep: String(index + 1), description: `Requirement ${index + 1}`, allowedEvidenceKinds: ["command"], skip: { allowed: false } }));
    const boundaryRule = { requirements: requirementIds, resolvedGates: [] };
    await writeFile(profilePath, JSON.stringify({ version: 1, id: "perf-v1", route: "lightweight-engineering", playbook: { path: "perf-playbook.md", sha256: sha256("performance fixture\n") }, hostCapabilities: [], stages: [{ id: "verify", assignment: { owner: "coordinator", distinctFrom: [] }, requirements }], boundaries: { final: boundaryRule, commit: boundaryRule, review: boundaryRule, publish: boundaryRule } }));
    await startRun({ runDirectory: run, profilePath, repositoryRoot: repo, coordinator: "lead" });
    for (const requirementId of requirementIds) await satisfyRequirement({ runDirectory: run, actor: "lead", requirementId, evidencePath: evidence, evidenceKind: "command" });
    const durations: number[] = [];
    for (let index = 0; index < 6; index += 1) {
      const startedAt = performance.now();
      expect((await workflowCheck(run, "final")).passed).toBe(true);
      durations.push(performance.now() - startedAt);
    }
    durations.sort((left, right) => left - right);
    expect(durations[Math.ceil(durations.length * 0.95) - 1]!).toBeLessThan(250);
  });

  test("recovers stale locks, writes atomically, and rejects tampered receipts", async () => {
    const { repo, run, evidence } = await fixture();
    await mkdir(run, { recursive: true });
    await writeFile(join(run, ".workflow.lock"), "99999999\n");
    await startRun({ runDirectory: run, profilePath: LIGHTWEIGHT, repositoryRoot: repo, coordinator: "lead" });
    await satisfyLightweight(run, evidence);
    await writeReceipt(run, "final", "lead");
    const receiptPath = join(run, "receipt.json");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    receipt.unexpected = true;
    await writeFile(receiptPath, JSON.stringify(receipt));
    await expect(writeReceipt(run, "final", "lead")).rejects.toThrow("unknown or missing fields");
    delete receipt.unexpected;
    receipt.limitation = "The host proves every gate actor identity.";
    await writeFile(receiptPath, JSON.stringify(receipt));
    await expect(writeReceipt(run, "final", "lead")).rejects.toThrow("receipt.limitation is invalid");
    const names = await readdir(run, { recursive: true });
    expect(names.some((name) => String(name).endsWith(".tmp"))).toBe(false);
  });
});

test("repository revision inspection preserves Git index bytes after content restoration", async () => {
  const { repo } = await fixture();
  const before = repositoryRevision(repo);
  const index = await readFile(join(repo, ".git/index"));
  await writeFile(join(repo, "README.md"), "changed fixture\n");
  expect(repositoryRevision(repo).fingerprint).not.toBe(before.fingerprint);
  await writeFile(join(repo, "README.md"), "fixture\n");
  await utimes(join(repo, "README.md"), 1_000_000_000, 1_000_000_000);
  expect(repositoryRevision(repo)).toEqual(before);
  expect(await readFile(join(repo, ".git/index"))).toEqual(index);
});
