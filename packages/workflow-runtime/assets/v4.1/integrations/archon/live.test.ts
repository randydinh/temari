import { afterAll, expect, test as bunTest } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { admitSource, preparePilot, runPilot } from "./live.ts";
import { taskRecipe, type TaskId } from "./live-tasks.ts";
import { payload } from "./lifecycle.ts";
import { executeCodex } from "./live-codex.ts";
import { actorConfiguration, type AuthorizedLaunch } from "./live-permissions.ts";
import { captureStage, finalize, type BridgeRequest, type StageId } from "./bridge.ts";
import { loadRun, parseEvidence, recordPath, repositoryRevision } from "../../skills/poteto-mode/scripts/workflow/store.ts";

const test = process.platform === "darwin" ? bunTest : bunTest.skip;
const roots: string[] = [];
const integration = dirname(fileURLToPath(import.meta.url));
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const solution = `export function chargeCostCents(wattHours: number, rateCentsPerKwh: number): number {
  if (!Number.isFinite(wattHours) || !Number.isFinite(rateCentsPerKwh) || wattHours < 0 || rateCentsPerKwh < 0) throw new Error("invalid input");
  return Math.round(wattHours * rateCentsPerKwh / 1000);
}\n`;
async function temporary() { const root = await realpath(await mkdtemp(join(tmpdir(), "temari-live-synthetic-"))); roots.push(root); return root; }
afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });
async function executable(root: string, code: string) {
  const path = join(root, "fake-codex");
  await writeFile(path, `#!${process.execPath}\n${code}`, { mode: 0o755 });
  return path;
}

const syntheticDocument = `# Synthetic guide fixture\n\nThis text verifies the data contract only; no model authored this fixture. ${"Synthetic explanatory text. ".repeat(32)}\n\npermissions planning summary.json native-run.json ARCHON_HOME receipt macOS 0.154.0\n\n\x60\x60\x60sh\nbun /absolute/installed/integrations/archon/live.ts run --root /owned/pilot --planning /owned/manifest.json --archon /absolute/archon --codex /absolute/codex\n\x60\x60\x60\n\n\x60\x60\x60sh\nbun /absolute/installed/integrations/archon/live.ts run \\\n  --root /owned/pilot --planning /owned/manifest.json --archon /absolute/archon --codex /absolute/codex \\\n  --builder-model gpt-5.6-luna --builder-reasoning high --reviewer-model gpt-5.6-luna --reviewer-reasoning xhigh\n\x60\x60\x60\n`;

async function fixture(behavior = "valid", planningMutation?: (manifest: any) => void, failVerificationOnce = false, taskId: TaskId = "charge-cost"): Promise<BridgeRequest & { root: string; planningPath: string }> {
  const root = await temporary();
  const recipe = taskRecipe(taskId);
  let preparation: Parameters<typeof preparePilot>[0] = join(root, "pilot");
  if (taskId === "temari-routing-doc") {
    const repository = join(root, "source"); await mkdir(repository);
    for (const path of payload) { await mkdir(dirname(join(repository, path)), { recursive: true }); await copyFile(resolve(integration, "../..", path), join(repository, path)); }
    const git = (...args: string[]) => execFileSync("git", ["-C", repository, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", ...args], { stdio: "pipe" });
    git("init", "-b", "main"); git("add", "."); git("commit", "-m", "Synthetic matching Temari source");
    preparation = { root: join(root, "pilot"), task: taskId, repository };
  }
  const prepared = await preparePilot(preparation);
  const planning = join(root, "planning");
  await mkdir(planning);
  const entries = [];
  for (const kind of ["how", "design-a", "design-b", "selection", "checkpoint"]) {
    const contents = kind === "checkpoint" ? "Blocking first steps. Prepare a bounded task.\nIndependent workstreams. Build then review.\nShared mutable state. Isolate the scratch directory.\nSmallest safe decomposition. One implementation owner.\n" : `Synthetic ${kind} planning for protocol tests only. No real model designed this fixture.\r\nPreserve café, 計画 and trailing space.  \r\n`;
    const file = join(planning, `original-${kind}.txt`); await writeFile(file, contents);
    entries.push({ kind, author: ["selection", "checkpoint"].includes(kind) ? "synthetic-coordinator" : `synthetic-${kind}`, file, sha256: hash(contents), authoredAt: `2026-01-0${entries.length + 1}T00:00:00Z` });
  }
  const manifest = { version: 1, baseline: { fingerprint: prepared.baseline.fingerprint, head: prepared.baseline.head }, taskSha256: prepared.taskSha256, entries };
  planningMutation?.(manifest);
  const manifestPath = join(planning, "manifest.json"); await writeFile(manifestPath, JSON.stringify(manifest));
  const codex = await executable(root, `
import { writeFileSync, mkdirSync, unlinkSync, symlinkSync, linkSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
const args=process.argv.slice(2);
if (args[0]==="--version") { console.log("codex-cli 0.154.0"); process.exit(0); }
if (args[0]==="sandbox") { const sep=args.indexOf("--"); const r=spawnSync(args[sep+1],args.slice(sep+2),{stdio:"inherit"}); process.exit(r.status ?? 1); }
async function actor(prompt,cwd,outputSchema) {
const id=prompt.match(/Invocation ID: (.+)/)[1];
const build=prompt.includes("Expected baseline:");
const expected=JSON.parse(prompt.match(/Expected (?:baseline|identity): (.+)/)[1]);
const behavior=${JSON.stringify(behavior)};
if (build && !["unchanged","blocked"].includes(behavior)) writeFileSync(cwd+"/${recipe.actorFilename}",${JSON.stringify(taskId === 'temari-routing-doc' ? syntheticDocument : behavior === 'early-exit' ? 'process.exit(0);\n' + solution : solution)});
if (build && behavior==="extra") writeFileSync(cwd+"/.ignored","extra");
if (build && behavior==="directory") mkdirSync(cwd+"/.unexpected");
if (build && behavior==="mode") chmodSync(cwd+"/${recipe.actorFilename}",0o755);
if (build && behavior==="symlink") { unlinkSync(cwd+"/${recipe.actorFilename}"); symlinkSync(${JSON.stringify(join(prepared.repositoryRoot, "charge-cost.ts"))},cwd+"/${recipe.actorFilename}"); }
if (build && behavior==="hardlink") { unlinkSync(cwd+"/${recipe.actorFilename}"); linkSync(${JSON.stringify(join(prepared.repositoryRoot, "charge-cost.ts"))},cwd+"/${recipe.actorFilename}"); }
if (build && behavior==="canonical") writeFileSync(${JSON.stringify(join(prepared.repositoryRoot, "charge-cost.test.ts"))},"changed");
const verdict=build?{verdict:"implemented",invocationId:id,baseline:expected,summary:"Synthetic implementation",changedFiles:${JSON.stringify([recipe.repositoryPath])}}:{verdict:behavior==="reject"?"reject":"accept",invocationId:id,identity:expected,rationale:"Synthetic review only",designAdherence:"Synthetic fixture follows the supplied shape",inspectedFiles:${JSON.stringify([recipe.actorFilename, recipe.testFilename, ...recipe.references, "commit-diff", "planning"])},findings:behavior==="contradictory"||behavior==="reject"?["synthetic problem"]:[]};
if (build && behavior==="schema-report") verdict.changedFiles=outputSchema.properties.changedFiles.items.enum;
if (build && behavior==="scratch-report") verdict.changedFiles=${JSON.stringify([recipe.actorFilename])};
if (build && behavior==="blocked") { verdict.verdict="blocked"; verdict.changedFiles=[]; verdict.summary="Synthetic blocker: no output was written."; }
if (!build && behavior==="stale") verdict.identity.candidate.head="0".repeat(40);
if (!build && behavior==="unknown-field") verdict.extra="unknown";
const reply=JSON.stringify(verdict);
return {text:reply,threadId:build||behavior==="reused-thread"?"synthetic-builder":"synthetic-reviewer"};
}
if (args[0]==="app-server") {
  const {createInterface}=await import("node:readline");
  const config={};for(let i=0;i<args.length;i++)if(args[i]==="-c")Object.assign(config,Bun.TOML.parse(args[++i]));
  let thread;let acted=false;const emit=value=>console.log(JSON.stringify(value));
  for await (const line of createInterface({input:process.stdin})) {
    const message=JSON.parse(line); if (!message.id) continue;
    if(message.method==="config/read") {const layers=[{name:{type:"system",file:"/synthetic/config.toml"},version:acted&&${JSON.stringify(behavior)}==="rpc-config-changed"?"changed":"synthetic-empty",config:{}}];if(Object.keys(config).length)layers.push({name:{type:"sessionFlags"},version:"session",config});emit({id:message.id,result:{layers}});}
    else if(message.method==="configRequirements/read")emit({id:message.id,result:{requirements:null}});
    else if(message.method==="model/list")emit({id:message.id,result:{data:[{id:"synthetic-model",model:"synthetic-model",defaultReasoningEffort:"xhigh",supportedReasoningEfforts:[{reasoningEffort:"xhigh"}]}],nextCursor:null}});
    else if(message.method==="thread/start"){thread=message.params;thread.id=thread.cwd.endsWith("builder-workspace")||${JSON.stringify(behavior)}==="reused-thread"?"synthetic-builder":"synthetic-reviewer";emit({id:message.id,result:{thread:{id:thread.id},cwd:thread.cwd,model:thread.model,modelProvider:thread.modelProvider,reasoningEffort:${JSON.stringify(behavior)}==="rpc-effort"?"low":thread.config.model_reasoning_effort,approvalPolicy:"never",activePermissionProfile:{id:${JSON.stringify(behavior)}==="rpc-profile"?"wrong-profile":thread.permissions,extends:null}}});}
    else if(message.method==="mcpServerStatus/list")emit({id:message.id,result:{data:${JSON.stringify(behavior)}==="rpc-mcp"?[{name:"unexpected"}]:[],nextCursor:null}});
    else if(message.method==="turn/start"){
      const turn={id:"synthetic-turn",status:"inProgress",items:[],error:null};emit({id:message.id,result:{turn}});emit({method:"turn/started",params:{threadId:thread.id,turn}});
      if(${JSON.stringify(behavior)}==="rpc-duplicate-start")emit({method:"turn/started",params:{threadId:thread.id,turn}});
      if(${JSON.stringify(behavior)}==="rpc-pending-item")emit({method:"item/started",params:{threadId:thread.id,turnId:turn.id,item:{id:"pending",type:"commandExecution"}}});
      if(["rpc-command-recovery","rpc-command-failed-turn"].includes(${JSON.stringify(behavior)})) {
        const command={id:"failed-command",type:"commandExecution",command:"git status --short",status:"inProgress"};
        emit({method:"item/started",params:{threadId:thread.id,turnId:turn.id,item:command}});
        emit({method:"item/completed",params:{threadId:thread.id,turnId:turn.id,item:{...command,status:"failed",exitCode:128,aggregatedOutput:"fatal: not a git repository"}}});
        const recovery={id:"recovery-command",type:"commandExecution",command:"cat charge-cost.ts",status:"inProgress"};
        emit({method:"item/started",params:{threadId:thread.id,turnId:turn.id,item:recovery}});
        emit({method:"item/completed",params:{threadId:thread.id,turnId:turn.id,item:{...recovery,status:"completed",exitCode:0,aggregatedOutput:"Source inspected without Git"}}});
      }
      if(${JSON.stringify(behavior)}==="rpc-reroute")emit({method:"model/rerouted",params:{threadId:thread.id,turnId:turn.id,fromModel:thread.model,toModel:"fallback",reason:"highRiskCyberActivity"}});
      if(${JSON.stringify(behavior)}==="rpc-settings")emit({method:"thread/settings/updated",params:{threadId:thread.id,threadSettings:{model:thread.model,modelProvider:"openai",effort:"low"}}});
      const result=await actor(message.params.input[0].text,thread.cwd,message.params.outputSchema);acted=true;const item={id:"reply",type:${JSON.stringify(behavior)}==="rpc-error-item"?"error":"agentMessage",text:result.text};
      if(${JSON.stringify(behavior)}==="rpc-failed-item")item.status="failed";
      emit({method:"item/completed",params:{threadId:${JSON.stringify(behavior)}==="rpc-thread"?"another-thread":thread.id,turnId:turn.id,item}});emit({method:"turn/completed",params:{threadId:thread.id,turn:{...turn,status:["rpc-failed-turn","rpc-command-failed-turn"].includes(${JSON.stringify(behavior)})?"failed":"completed",items:${JSON.stringify(behavior)}==="rpc-no-final"?[]:[${JSON.stringify(behavior)}==="rpc-final-mismatch"?{...item,text:"different terminal reply"}:item]}}});
    }else emit({id:message.id,result:{}});
  }
}
`);
  const archon = join(root, "fake-archon");
  await writeFile(archon, behavior === "archon-build-failure" ? `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args=process.argv.slice(2);appendFileSync(${JSON.stringify(join(prepared.root, "archon-invocations.jsonl"))},JSON.stringify(args)+"\\n");
if(args[0]==="version")console.log("Archon CLI v0.10.1\\n  Git commit: 9820785c");
else if(args[0]==="validate")process.exit(0);
else if(args[1]==="run")console.log(JSON.stringify({runId:"synthetic-native-run"}));
else if(args[1]==="wait")console.log(JSON.stringify({status:"failed"}));
else if(args[1]==="get")console.log(JSON.stringify({id:"synthetic-native-run",status:"failed",output_root:${JSON.stringify(join(root, "native-output"))},metadata:{error:"DAG workflow 'temari-live-pilot' failed: node build failed. 4 downstream nodes were skipped."}}));
else process.exit(2);
` : "#!/bin/sh\nprintf 'Synthetic Archon prelaunch stop\\n'\n", { mode: 0o755 });
  await expect(runPilot({ root: prepared.root, planning: manifestPath, codex, archon, model: "synthetic-model", reasoning: "xhigh", failVerificationOnce })).rejects.toThrow(planningMutation ? /planning|checkpoint/ : behavior === "archon-build-failure" ? /live run synthetic-native-run.*node build failed.*evidence/ : "requires Archon");
  return { root: prepared.root, planningPath: manifestPath, repositoryRoot: prepared.repositoryRoot, artifactsDirectory: join(root, "artifacts"), archonRunId: "synthetic-live-run", specPath: join(prepared.root, "pilot-spec.json") };
}
async function stages(request: BridgeRequest, until: StageId = "verify") {
  for (const stage of ["build", "shape-final", "verify", "review"] as const) { try { await captureStage(request, stage); } catch (error) { console.error(await failedLog(request, stage)); throw error; } if (stage === until) return; }
}
async function failedLog(request: BridgeRequest, stage: StageId) {
  const base = join(request.artifactsDirectory, "temari-bridge");
  const pointer = JSON.parse(await readFile(join(base, "stages", `${stage}.json`), "utf8"));
  return await readFile(join(base, "attempts", pointer.attempt, "stderr.log"), "utf8");
}

test("synthetic live stages admit changed source, protect contracts, commit once and produce canonical receipt", async () => {
  const request = await fixture();
  await stages(request, "review");
  const marker = await finalize(request);
  expect(marker.kind).toBe("temari-review-receipt");
  expect(await readFile(join(request.repositoryRoot, "charge-cost.ts"), "utf8")).toBe(solution);
  const review = JSON.parse(await readFile(join(request.root, "control/review-result.json"), "utf8"));
  expect(review.threadId).toBe("synthetic-reviewer");
  const check = JSON.parse(await readFile(join(request.root, "control/verification.json"), "utf8"));
  expect(check.stderr).toContain("13 expect() calls");
  expect(check.args.slice(0, 4)).toEqual(["sandbox", "--include-managed-config", "--permission-profile", "temari_verify"]);
  expect(check.execution.contractSha256).toBe(check.identity.executionSha256);
  expect(check.args).not.toContain(":read-only");
  expect((await json(request.specPath)).stages.build.command.timeoutMs).toBe(240_000);
  expect((await json(join(request.root, "control/build-invocation.json"))).budget.actorMs).toBe(180_000);
}, 20_000);

for (const task of ["charge-cost", "temari-routing-doc"] as const) {
  test(`builder reporting contract maps ${task} scratch output to its repository destination`, async () => {
    const request = await fixture("schema-report", undefined, false, task);
    const recipe = taskRecipe(task);
    await captureStage(request, "build");
    const responseSchema = await json(join(request.root, "control/build-schema.json"));
    expect(responseSchema.properties.changedFiles.items).toEqual({ type: "string", enum: [recipe.repositoryPath] });
    expect(responseSchema.properties.changedFiles.maxItems).toBe(1);
    expect(responseSchema.properties.changedFiles.minItems ?? 0).toBe(0);
    const prompt = await readFile(join(request.root, "control/build-prompt.txt"), "utf8");
    expect(prompt).toContain(`Your only writable output is the existing ${recipe.actorFilename} in this scratch directory.`);
    expect(prompt).toContain(`Report changedFiles as exactly ${JSON.stringify([recipe.repositoryPath])} when implemented`);
    expect(prompt).toContain("Report changedFiles as [] when blocked.");
    expect((await json(join(request.root, "control/build-result.json"))).verdict.changedFiles).toEqual([recipe.repositoryPath]);
    expect(await readFile(join(request.repositoryRoot, recipe.repositoryPath), "utf8")).toBe(task === "charge-cost" ? solution : syntheticDocument);
    expect(execFileSync("git", ["-C", request.repositoryRoot, "diff", "--name-only", "HEAD^", "HEAD"], { encoding: "utf8" }).trim()).toBe(recipe.repositoryPath);
  }, 15_000);

  test(`blocked ${task} builder reports no changes without admitting output`, async () => {
    const request = await fixture("blocked", undefined, false, task);
    const recipe = taskRecipe(task);
    const baseline = repositoryRevision(request.repositoryRoot);
    await expect(captureStage(request, "build")).rejects.toThrow();
    expect(await failedLog(request, "build")).toContain("builder did not report the bounded implementation");
    const responseSchema = await json(join(request.root, "control/build-schema.json"));
    expect(responseSchema.properties.changedFiles.minItems ?? 0).toBe(0);
    expect((await json(join(request.root, "control/build-last-message.json"))).changedFiles).toEqual([]);
    expect(await readFile(join(request.root, "builder-workspace", recipe.actorFilename), "utf8")).toBe(recipe.initial);
    expect(repositoryRevision(request.repositoryRoot)).toEqual(baseline);
    expect(await Bun.file(join(request.root, "control/build-result.json")).exists()).toBe(false);
    await expect(finalize(request)).rejects.toThrow();
    expect(await Bun.file(join(request.artifactsDirectory, "evidence.json")).exists()).toBe(false);
  }, 15_000);
}

test("documentation scratch-path report cannot admit output or create an implementation commit", async () => {
  const request = await fixture("scratch-report", undefined, false, "temari-routing-doc");
  const baseline = repositoryRevision(request.repositoryRoot);
  await expect(captureStage(request, "build")).rejects.toThrow();
  expect(await failedLog(request, "build")).toContain("builder did not report the bounded implementation");
  expect(await readFile(join(request.root, "builder-workspace/archon-role-routing.md"), "utf8")).toBe(syntheticDocument);
  expect(repositoryRevision(request.repositoryRoot)).toEqual(baseline);
  expect(await Bun.file(join(request.repositoryRoot, "docs/archon-role-routing.md")).exists()).toBe(false);
  expect(await Bun.file(join(request.root, "control/build-result.json")).exists()).toBe(false);
  await expect(finalize(request)).rejects.toThrow();
  expect(await Bun.file(join(request.artifactsDirectory, "evidence.json")).exists()).toBe(false);
}, 15_000);

test("synthetic command failure can recover within a successful actor turn", async () => {
  const request = await fixture("rpc-command-recovery");
  await stages(request, "review");
  expect((await finalize(request)).kind).toBe("temari-review-receipt");
  expect(await readFile(join(request.repositoryRoot, "charge-cost.ts"), "utf8")).toBe(solution);
  for (const stage of ["build", "review"]) {
    const pointer = await json(join(request.artifactsDirectory, "temari-bridge/stages", `${stage}.json`));
    const events = (await readFile(join(request.artifactsDirectory, "temari-bridge/attempts", pointer.attempt, "stdout.log"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const commands = events.filter(event => event.method === "item/completed" && event.params.item.type === "commandExecution").map(event => ({ id: event.params.item.id, status: event.params.item.status, exitCode: event.params.item.exitCode }));
    expect(commands).toEqual([{ id: "failed-command", status: "failed", exitCode: 128 }, { id: "recovery-command", status: "completed", exitCode: 0 }]);
  }
}, 20_000);

test("synthetic command recovery still rejects a failed terminal turn", async () => {
  const request = await fixture("rpc-command-failed-turn");
  await expect(captureStage(request, "build")).rejects.toThrow("command failed");
  expect(await failedLog(request, "build")).toContain("Codex turn did not complete successfully");
  expect(await Bun.file(join(request.root, "control/build-result.json")).exists()).toBe(false);
  expect(await readFile(join(request.repositoryRoot, "charge-cost.ts"), "utf8")).not.toBe(solution);
});

test("synthetic native build failure reports its cause without resuming a missing verifier", async () => {
  const request = await fixture("archon-build-failure", undefined, true);
  expect((await json(join(request.root, "native-run.json"))).runId).toBe("synthetic-native-run");
  const calls = (await readFile(join(request.root, "archon-invocations.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(calls.map(args => args.slice(0, args[0] === "workflow" ? 2 : 1))).toEqual([["version"], ["validate"], ["workflow", "run"], ["workflow", "wait"], ["workflow", "get"]]);
});

for (const behavior of ["rpc-effort", "rpc-reroute", "rpc-settings", "rpc-profile", "rpc-mcp", "rpc-config-changed", "rpc-thread", "rpc-failed-turn", "rpc-failed-item", "rpc-error-item", "rpc-no-final", "rpc-final-mismatch", "rpc-duplicate-start", "rpc-pending-item"]) {
  test(`synthetic app-server ${behavior} cannot admit a successful actor result`, async () => {
    const request = await fixture(behavior);
    await expect(captureStage(request, "build")).rejects.toThrow();
    await expect(finalize(request)).rejects.toThrow();
    expect(await failedLog(request, "build")).toMatch(/Codex|configuration|profile|MCP|turn/);
    expect(await Bun.file(join(request.root, "control/build-result.json")).exists()).toBe(false);
    expect(await readFile(join(request.repositoryRoot, "charge-cost.ts"), "utf8")).not.toBe(solution);
  }, 15_000);
}

for (const behavior of ["unchanged", "extra", "directory", "mode", "symlink", "hardlink", "canonical"]) {
  test(`synthetic builder rejects ${behavior} output before success capture`, async () => {
    const request = await fixture(behavior);
    await expect(captureStage(request, "build")).rejects.toThrow();
    await expect(finalize(request)).rejects.toThrow();
    expect(await failedLog(request, "build")).toMatch(/builder|unsupported|protected|symlink|ELOOP/);
    expect(await Bun.file(join(request.artifactsDirectory, "evidence.json")).exists()).toBe(false);
  }, 15_000);
}
for (const behavior of ["reject", "contradictory", "stale", "unknown-field", "reused-thread"]) {
  test(`synthetic reviewer ${behavior} cannot publish successful review or receipt`, async () => {
    const request = await fixture(behavior);
    await stages(request);
    await expect(captureStage(request, "review")).rejects.toThrow();
    await expect(finalize(request)).rejects.toThrow();
    expect(await failedLog(request, "review")).toMatch(/reviewer|review|stale/);
    expect(await Bun.file(join(request.artifactsDirectory, "evidence.json")).exists()).toBe(false);
  }, 20_000);
}
test("synthetic early process exit cannot masquerade as completed target tests", async () => {
  const request = await fixture("early-exit");
  await stages(request, "shape-final");
  await expect(captureStage(request, "verify")).rejects.toThrow();
  expect(await failedLog(request, "verify")).toContain("did not complete all expected tests");
}, 15_000);

test("planning requires honest distinct design attribution and the exact prepared identity", async () => {
  await fixture("valid", manifest => { manifest.entries[2].author = manifest.entries[1].author; });
  await fixture("valid", manifest => { manifest.baseline.head = "0".repeat(40); });
  await fixture("valid", manifest => { manifest.entries[0].sha256 = "0".repeat(64); });
});
test("frozen historical planning drift blocks a builder", async () => {
  const request = await fixture();
  await writeFile(join(request.root, "control/planning/how.md"), "changed historical plan");
  await expect(captureStage(request, "build")).rejects.toThrow();
  expect(await failedLog(request, "build")).toContain("frozen planning changed");
});

test("canonical shape evidence preserves original planning bytes and separates origin from the assessed candidate", async () => {
  const request = await fixture();
  const original = await json(request.planningPath);
  const originals = await Promise.all(original.entries.map(async (entry: { file: string }) => readFile(entry.file)));
  const normalizedBytes = await readFile(join(request.root, "control/planning/manifest.json"));
  await captureStage(request, "build");
  for (const entry of original.entries) await writeFile(entry.file, "Caller changed this source after freezing.\n");
  await stages(request, "review");
  const capture = await captureStage(request, "shape-final");
  if (capture.state !== "complete") throw new Error("shape fixture incomplete");
  const marker = await finalize(request);
  const run = await loadRun(marker.binding.temariRunDirectory);
  const requirements = {
    "feature.shape.how": ["how"],
    "feature.shape.parallel-design": ["design-a", "design-b", "selection"],
    "feature.shape.throughput-checkpoint": ["checkpoint"],
  };
  expect(capture.evidence.map(evidence => evidence.requirementId)).toEqual(Object.keys(requirements));
  for (const evidence of capture.evidence) {
    expect(evidence.sha256).toBe(capture.evidence[0]!.sha256);
    const record = parseEvidence(await json(recordPath(run, "shape", evidence.requirementId, "evidence")));
    const imported = await readFile(join(run.runDirectory, record.evidencePath));
    const sealed = await readFile(join(request.artifactsDirectory, "temari-bridge", evidence.path));
    const shape = JSON.parse(imported.toString());
    expect(imported).toEqual(sealed);
    expect(hash(imported)).toBe(evidence.sha256);
    expect(record.evidenceSha256).toBe(evidence.sha256);
    expect(record.producer).toBe("live-coordinator");
    expect({ head: record.repositoryHead, fingerprint: record.worktreeFingerprint }).toEqual(shape.assessment.identity.candidate);
    expect(shape.version).toBe(1);
    expect(shape.kind).toBe("temari-live-shape-assessment");
    expect(shape.attribution).toBe("host-reported");
    expect(shape.origin.baseline).toEqual(original.baseline);
    expect(shape.origin.taskSha256).toBe(original.taskSha256);
    expect(shape.assessment.identity.candidate).toEqual(repositoryRevision(request.repositoryRoot));
    expect(shape.assessment.identity.candidate.head).not.toBe(original.baseline.head);
    expect(shape.assessment.identity.baselineHead).toBe(original.baseline.head);
    expect(shape.assessment.identity.planningSha256).toBe(shape.origin.manifestSha256);
    expect(shape.assessment.kind).toBe("mechanical-reconciliation");
    expect(shape.assessment.actor).toBe("live-coordinator");
    expect(shape.assessment.archonRunId).toBe(request.archonRunId);
    expect(Date.parse(shape.assessment.assessedAt)).toBeGreaterThanOrEqual(Date.parse(capture.startedAt));
    expect(shape.assessment.changedFiles).toEqual(["charge-cost.ts"]);
    expect(shape.assessment.protectedContractsUnchanged).toBe(true);
    expect(shape.assessment.implementationCommitCount).toBe(1);
    expect(shape.assessment.semanticDesignAdherence).toBe("pending-independent-review");
    expect(shape.requirements).toEqual(requirements);
    const manifestBytes = Buffer.from(shape.origin.manifestBase64, "base64");
    expect(manifestBytes).toEqual(normalizedBytes);
    expect(hash(manifestBytes)).toBe(shape.origin.manifestSha256);
    const normalized = JSON.parse(manifestBytes.toString());
    expect(normalized.baseline).toEqual(shape.origin.baseline);
    expect(normalized.taskSha256).toBe(shape.origin.taskSha256);
    expect(shape.origin.artifacts).toHaveLength(5);
    for (const [index, artifact] of shape.origin.artifacts.entries()) {
      const { file, ...metadata } = original.entries[index];
      const { contentBase64, ...preserved } = artifact;
      const bytes = Buffer.from(contentBase64, "base64");
      expect(preserved).toEqual(metadata);
      expect(bytes).toEqual(originals[index]);
      expect(hash(bytes)).toBe(artifact.sha256);
      expect(normalized.entries[index]).toEqual({ ...preserved, file: `${artifact.kind}.md` });
      expect(normalized.entries[index].file).not.toBe(file);
      expect(artifact.authoredAt).not.toBe(shape.assessment.assessedAt);
    }
  }
}, 20_000);

for (const mutation of ["document", "document-and-hash", "author", "authoredAt", "baseline-head", "baseline-fingerprint", "task", "rebound-origin"]) {
  test(`frozen planning ${mutation} after build cannot relabel shape evidence`, async () => {
    const request = await fixture();
    await captureStage(request, "build");
    const manifestPath = join(request.root, "control/planning/manifest.json");
    const manifest = await json(manifestPath);
    if (["document", "document-and-hash", "rebound-origin"].includes(mutation)) {
      const changed = "Replacement historical plan supplied after the implementation commit.\n";
      await writeFile(join(request.root, "control/planning/how.md"), changed);
      manifest.entries[0].sha256 = hash(changed);
    }
    if (["author", "rebound-origin"].includes(mutation)) manifest.entries[0].author = "replacement-author";
    if (["authoredAt", "rebound-origin"].includes(mutation)) manifest.entries[0].authoredAt = new Date().toISOString();
    if (["baseline-head", "rebound-origin"].includes(mutation)) manifest.baseline.head = repositoryRevision(request.repositoryRoot).head;
    if (["baseline-fingerprint", "rebound-origin"].includes(mutation)) manifest.baseline.fingerprint = "0".repeat(64);
    if (["task", "rebound-origin"].includes(mutation)) manifest.taskSha256 = hash("replacement task");
    if (mutation !== "document") await writeFile(manifestPath, JSON.stringify(manifest));
    if (mutation === "rebound-origin") {
      const frozenPath = join(request.root, "control/frozen.json");
      const frozen = await json(frozenPath);
      frozen.planning = manifest;
      frozen.planningSha256 = hash(await readFile(manifestPath));
      frozen.prepared.baseline = manifest.baseline;
      frozen.prepared.taskSha256 = manifest.taskSha256;
      await writeFile(frozenPath, JSON.stringify(frozen));
    }
    await expect(captureStage(request, "shape-final")).rejects.toThrow("command failed");
    expect(await failedLog(request, "shape-final")).toContain(mutation === "document" ? "frozen planning changed" : mutation === "rebound-origin" ? "frozen pilot configuration changed" : "frozen planning manifest changed");
    await expect(finalize(request)).rejects.toThrow("shape-final has no completed capture");
    expect(await Bun.file(join(request.artifactsDirectory, "evidence.json")).exists()).toBe(false);
  }, 15_000);
}

for (const drift of ["tracked", "untracked", "HEAD"]) {
  for (const boundary of ["shape", "finalization"]) {
    test(`${drift} candidate drift before ${boundary} cannot reuse live planning evidence`, async () => {
      const request = await fixture();
      await stages(request, boundary === "shape" ? "build" : "review");
      if (boundary === "finalization") await finalize(request);
      const pointerPath = join(request.artifactsDirectory, "temari-bridge/stages/shape-final.json");
      const before = boundary === "shape" ? null : await readFile(pointerPath, "utf8");
      if (drift === "tracked") await writeFile(join(request.repositoryRoot, "charge-cost.ts"), `${solution}\n`);
      if (drift === "untracked") await writeFile(join(request.repositoryRoot, "unexpected.txt"), "new candidate\n");
      if (drift === "HEAD") execFileSync("git", ["-C", request.repositoryRoot, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "--allow-empty", "-m", "Changed candidate"], { stdio: "pipe" });
      await expect(captureStage(request, "shape-final")).rejects.toThrow("candidate changed");
      await expect(finalize(request)).rejects.toThrow("candidate changed");
      if (before === null) expect(await Bun.file(pointerPath).exists()).toBe(false);
      else expect(await readFile(pointerPath, "utf8")).toBe(before);
      expect(await Bun.file(join(request.artifactsDirectory, "evidence.json")).exists()).toBe(false);
    }, 20_000);
  }
}

test("unchanged and restored candidates replay the exact historical shape assessment", async () => {
  const request = await fixture();
  await stages(request, "shape-final");
  const capture = await captureStage(request, "shape-final");
  if (capture.state !== "complete") throw new Error("shape fixture incomplete");
  const shapePath = join(request.artifactsDirectory, "temari-bridge", capture.evidence[0]!.path);
  const original = await readFile(shapePath);
  const sourcePath = join(request.repositoryRoot, "charge-cost.ts");
  const source = await readFile(sourcePath);
  const planning = await json(request.planningPath);
  for (const entry of planning.entries) await writeFile(entry.file, "Changed external planning source.\n");
  await writeFile(request.planningPath, "Changed external manifest.\n");
  expect(await captureStage(request, "shape-final")).toEqual(capture);
  await writeFile(sourcePath, `${source.toString()}\n`);
  await expect(captureStage(request, "shape-final")).rejects.toThrow("candidate changed");
  await writeFile(sourcePath, source);
  expect(await captureStage(request, "shape-final")).toEqual(capture);
  expect(await readFile(shapePath)).toEqual(original);
  expect((await json(shapePath)).assessment.assessedAt).toBe(JSON.parse(original.toString()).assessment.assessedAt);
  try { await captureStage(request, "verify"); } catch (error) { console.error(await failedLog(request, "verify")); throw error; }
  await captureStage(request, "review");
  expect((await finalize(request)).kind).toBe("temari-review-receipt");
}, 20_000);

test("sealed shape mutation invalidates an existing receipt without replacing the assessment", async () => {
  const request = await fixture();
  await stages(request, "review");
  const capture = await captureStage(request, "shape-final");
  if (capture.state !== "complete") throw new Error("shape fixture incomplete");
  await finalize(request);
  const shapePath = join(request.artifactsDirectory, "temari-bridge", capture.evidence[0]!.path);
  const changed = await json(shapePath);
  changed.origin.artifacts[0].author = "relabeled-author";
  await writeFile(shapePath, JSON.stringify(changed));
  await expect(finalize(request)).rejects.toThrow("sealed artifact changed");
  expect(await Bun.file(join(request.artifactsDirectory, "evidence.json")).exists()).toBe(false);
  await expect(captureStage(request, "shape-final")).rejects.toThrow("sealed artifact changed");
}, 20_000);


async function transport(code: string, limit: Record<string, number> = {}, task: TaskId = "charge-cost") {
  const root = await temporary();
  const lastMessage = join(root, "last.json");
  const file = await executable(root, `const last=${JSON.stringify(lastMessage)};\n${code}`);
  const launch: AuthorizedLaunch = { role: "build", task, executable: file, bun: process.execPath, cwd: root, context: root, profileArguments: ["--permission-profile", "temari_build", "-c", "permissions.temari_build.network.enabled=false"], environment: { PATH: "/usr/bin:/bin", HOME: root }, observation: { role: "build", contractSha256: "synthetic", identity: {}, inputs: [], configurationSha256: "synthetic", environmentSha256: "synthetic", profileSha256: "synthetic", toolPolicy: "local-task-tools-only" } };
  await writeFile(join(root, "schema.json"), JSON.stringify({ type: "object" }));
  return executeCodex({ launch, executable: file, cwd: root, model: "synthetic-model", reasoning: "xhigh", role: "build", prompt: "Synthetic protocol test", schema: join(root, "schema.json"), lastMessage }, limit);
}
test("fake app-server rejects unsupported effective configuration before a turn", async () => {
  await expect(transport(`const {createInterface}=await import("node:readline");for await(const line of createInterface({input:process.stdin})){const m=JSON.parse(line);if(!m.id)continue;const result=m.method==="config/read"?{layers:[{name:{type:"project"},version:"changed",config:{}}]}:m.method==="configRequirements/read"?{requirements:null}:{};const bytes=Buffer.from(JSON.stringify({id:m.id,result})+"\\n");process.stdout.write(bytes.subarray(0,10));await Bun.sleep(5);process.stdout.write(bytes.subarray(10));}`)).rejects.toThrow("non-user");
});
test("fake executable nonzero, timeout, overflow and missing final message fail closed", async () => {
  await expect(transport('process.exit(7)')).rejects.toThrow("exited 7");
  await expect(transport('await Bun.sleep(10_000)', { timeoutMs: 50 })).rejects.toThrow("timed out");
  await expect(transport('process.stdout.write("x".repeat(1024)); await Bun.sleep(1000)', { stdout: 128 })).rejects.toThrow("overflow");
  await expect(transport('process.stderr.write("x".repeat(1024)); await Bun.sleep(1000)', { stderr: 128 })).rejects.toThrow("overflow");
  await expect(transport(`process.stdout.write('{"id":1,"result":{}}\\n');`)).rejects.toThrow();
});
test("fake executable descendants holding inherited pipes cause bounded failure", async () => {
  const root = await temporary();
  const script = join(root, "descendant.ts");
  await writeFile(script, 'await Bun.sleep(2000);');
  const started = Date.now();
  await expect(transport(`const {spawn}=await import("node:child_process");spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(script)}],{stdio:["ignore",1,2]}).unref();process.exit(0);`)).rejects.toThrow("before terminal confirmation");
  expect(Date.now() - started).toBeLessThan(1500);
});

test("public prepare CLI rejects unknown scope knobs and preserves existing directories", async () => {
  const root = await temporary();
  await writeFile(join(root, "keep"), "keep");
  const occupied = spawnSync(process.execPath, [join(integration, "live.ts"), "prepare", "--root", root], { encoding: "utf8" });
  expect(occupied.status).toBe(1); expect(occupied.stderr).toContain("empty");
  const knobs = spawnSync(process.execPath, [join(integration, "live.ts"), "run", "--sandbox", "danger-full-access"], { encoding: "utf8" });
  expect(knobs.status).toBe(1); expect(knobs.stderr).toContain("unknown option");
  expect(await readFile(join(root, "keep"), "utf8")).toBe("keep");
});


test("admission retains exact bounded bytes after scratch replacement and rejects oversized source", async () => {
  const root = await temporary();
  const path = join(root, "charge-cost.ts");
  await writeFile(path, solution, { mode: 0o644 });
  const admitted = await admitSource(root, { sha256: hash("baseline"), mode: 0o644, size: 8 });
  await rm(path);
  await writeFile(path, "x".repeat(128 * 1024), { mode: 0o644 });
  expect(admitted.toString()).toBe(solution);
  await expect(admitSource(root, { sha256: hash("baseline"), mode: 0o644, size: 8 })).rejects.toThrow("bounded regular");
});


test("synthetic controlled verifier retry preserves successful builder capture and completes review", async () => {
  const request = await fixture("valid", undefined, true);
  await stages(request, "shape-final");
  const pointer = join(request.artifactsDirectory, "temari-bridge/stages/build.json");
  const buildBefore = await readFile(pointer, "utf8");
  await expect(captureStage(request, "verify")).rejects.toThrow();
  expect(await failedLog(request, "verify")).toContain("controlled verification checkpoint failed once");
  await captureStage(request, "verify");
  await captureStage(request, "review");
  const marker = await finalize(request);
  expect(marker.kind).toBe("temari-review-receipt");
  expect(await readFile(pointer, "utf8")).toBe(buildBefore);
}, 20_000);

test("frozen controller configuration drift is rejected before model dispatch", async () => {
  const request = await fixture();
  const path = join(request.root, "control/frozen.json");
  const frozen = JSON.parse(await readFile(path, "utf8"));
  frozen.routing.roles.review.model = "changed-model";
  await writeFile(path, JSON.stringify(frozen));
  await expect(captureStage(request, "build")).rejects.toThrow();
  expect(await failedLog(request, "build")).toContain("frozen pilot configuration changed");
});

test("synthetic Temari documentation stages preserve original baseline and seal the sole new document", async () => {
  const request = await fixture("valid", undefined, false, "temari-routing-doc");
  const prepared = await json(join(request.root, "prepared.json"));
  await stages(request, "review");
  expect((await finalize(request)).kind).toBe("temari-review-receipt");
  expect(await readFile(join(request.repositoryRoot, "docs/archon-role-routing.md"), "utf8")).toBe(syntheticDocument);
  expect(repositoryRevision(prepared.source.repository)).toEqual(prepared.source.candidate);
  expect(prepared.baseline.head).toBe(prepared.source.candidate.head);
  const candidate = await json(join(request.root, "control/candidate.json"));
  expect(candidate.inventorySha256).toMatch(/^[a-f0-9]{64}$/);
  const check = await json(join(request.root, "control/verification.json"));
  expect(check.stderr).toContain("14 expect() calls");
  expect(check.args.at(-1)).toBe("archon-role-routing.test.ts");
  const spec = await json(request.specPath);
  for (const stage of Object.values(spec.stages) as { command: { timeoutMs: number } }[]) expect(stage.command.timeoutMs).toBe(660_000);
  for (const role of ["build", "review"]) expect((await json(join(request.root, `control/${role}-invocation.json`))).budget).toEqual({ actorMs: 600_000, stageMs: 660_000, minimumCaptureMs: 720_000 });
  const review = await json(join(request.root, "control/review-result.json"));
  expect(review.verdict.inspectedFiles).toEqual(["archon-role-routing.md", "archon-role-routing.test.ts", "README.md", "live.ts", "live-routing.ts", "live-permissions.ts", "commit-diff", "planning"]);
}, 20_000);

test("ignored canonical state cannot change between documentation build and verification", async () => {
  const request = await fixture("valid", undefined, false, "temari-routing-doc");
  await stages(request, "build");
  await writeFile(join(request.repositoryRoot, ".git/ignored-extra"), "changed opaque Git state");
  await expect(captureStage(request, "shape-final")).rejects.toThrow();
  expect(await failedLog(request, "shape-final")).toContain("implementation candidate changed");
  await expect(finalize(request)).rejects.toThrow();
}, 20_000);

test("documentation actor still fails at its injected finite deadline", async () => {
  const started = Date.now();
  await expect(transport('await Bun.sleep(10_000)', { timeoutMs: 50 }, "temari-routing-doc")).rejects.toThrow("timed out");
  expect(Date.now() - started).toBeLessThan(1500);
});
