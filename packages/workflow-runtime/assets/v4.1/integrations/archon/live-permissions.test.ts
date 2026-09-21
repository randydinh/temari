import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { taskRecipe, type TaskId } from "./live-tasks.ts";
import { actorConfiguration, actorPermissionArguments, assertDisabledMcpInventory, assertPilotExecution, authorizePilotExecution, configurationIdentity, executionDigest, freezePilotExecution, verifierArguments } from "./live-permissions.ts";

const runtimeTest = process.platform === "darwin" ? test : test.skip;
const roots: string[] = [];
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const baseline = { head: "a".repeat(40), fingerprint: "b".repeat(64) };
afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });
async function fixture(task: TaskId = "charge-cost") {
  const recipe = taskRecipe(task);
  const outside = await realpath(await mkdtemp(join(tmpdir(), "temari-execution-synthetic-"))); roots.push(outside);
  const root = join(outside, "pilot"); await mkdir(root); await mkdir(join(root, "control")); await mkdir(join(root, "control/planning"));
  await writeFile(join(root, "task.md"), "Synthetic bounded task\n");
  for (const name of ["manifest.json", "how.md", "design-a.md", "design-b.md", "selection.md", "checkpoint.md"]) await writeFile(join(root, "control/planning", name), `Synthetic ${name}\n`);
  const playbook = join(outside, "feature.md"); await writeFile(playbook, "Synthetic packaged playbook\n");
  const codex = join(outside, "codex");
  await writeFile(codex, `#!${process.execPath}\nimport {createInterface} from "node:readline";
for await(const line of createInterface({input:process.stdin})){const message=JSON.parse(line);if(!message.id)continue;console.log(JSON.stringify({id:message.id,result:message.method==="config/read"?{layers:[{name:{type:"system",file:"/synthetic/system"},version:"empty",config:{}}]}:message.method==="configRequirements/read"?{requirements:null}:{}}));}\n`, { mode: 0o755 });
  const bun = join(outside, "bun"); await writeFile(bun, "Synthetic runtime, never used for enforcement\n", { mode: 0o755 });
  if (recipe.references.length) {
    await mkdir(join(root, "control/task"));
    for (const name of recipe.references) await writeFile(join(root, "control/task", name), `Synthetic ${name} reference\n`);
  }
  const contract = await freezePilotExecution({ root, task, baseline, taskSha256: hash(await readFile(join(root, "task.md"))), codex, bun, playbook });
  await mkdir(join(root, "builder-workspace")); await writeFile(join(root, "builder-workspace", recipe.actorFilename), "synthetic initial source\n");
  const source = Buffer.from("synthetic admitted source\n"); const tests = Buffer.from("synthetic protected checks\n"); const diff = "synthetic controller observed diff";
  const identity = { candidate: { head: "c".repeat(40), fingerprint: "d".repeat(64) }, baselineHead: baseline.head, sourceSha256: hash(source), testsSha256: hash(tests), planningSha256: hash("planning"), diffSha256: hash(diff), executionSha256: executionDigest(contract) };
  return { root, outside, contract, source, tests, diff, identity };
}

test("configuration policy binds user settings and refuses unknown or managed authority", () => {
  const layers = [{ name: { type: "system", file: "/synthetic/system" }, version: "empty", config: {} }];
  const expected = configurationIdentity({ layers }, { requirements: null });
  expect(configurationIdentity({ layers: [{ config: {}, version: "empty", name: { file: "/synthetic/system", type: "system" } }] }, { requirements: null })).toBe(expected);
  expect(configurationIdentity({ layers: [...layers, { name: { type: "user" }, version: "ignored", config: { mcp_servers: { unrelated: {} }, sandbox_mode: "danger-full-access" } }] }, { requirements: null })).not.toBe(expected);
  for (const type of ["project", "mdm", "packagedDefaults", "enterpriseManaged", "sessionFlags", "legacyManagedConfigTomlFromFile", "unknown"]) expect(() => configurationIdentity({ layers: [...layers, { name: { type }, version: "injected", config: {} }] }, { requirements: null })).toThrow();
  expect(() => configurationIdentity({ layers: [{ ...layers[0], config: { mcp_servers: { external: {} } } }] }, { requirements: null })).toThrow();
  expect(() => configurationIdentity({ layers }, { requirements: { allowed_permission_profiles: [":read-only"] } })).toThrow("managed");
  expect(() => configurationIdentity({ layers }, {})).toThrow();
  expect(() => configurationIdentity({}, { requirements: null })).toThrow();
});

test("MCP inventory accepts only configured inert disabled rows and rejects unknown authority", () => {
  const server = { name: "configured", runtimeStatus: "disabled", tools: {}, serverInfo: null, toolsError: null, resources: [], resourceTemplates: [] };
  expect(() => assertDisabledMcpInventory({ data: [], nextCursor: null }, ["configured"])).not.toThrow();
  expect(() => assertDisabledMcpInventory({ data: [server], nextCursor: null }, ["configured"])).not.toThrow();
  for (const changed of [{ name: "unknown" }, { runtimeStatus: "connected" }, { runtimeStatus: null }, { tools: { external: {} } }, { serverInfo: {} }, { toolsError: "discovery failed" }, { resources: [{}] }, { resourceTemplates: [{}] }]) expect(() => assertDisabledMcpInventory({ data: [{ ...server, ...changed }], nextCursor: null }, ["configured"])).toThrow();
  expect(() => assertDisabledMcpInventory({ data: [server, server], nextCursor: null }, ["configured"])).toThrow();
  expect(() => assertDisabledMcpInventory({ data: [server], nextCursor: "more" }, ["configured"])).toThrow();
});

runtimeTest("shared temporary roots and runtime executables fail before dispatch", async () => {
  const f = await fixture();
  const unsafe = await mkdtemp("/private/tmp/temari-execution-rejected-"); roots.push(unsafe);
  const args = { root: unsafe, baseline, taskSha256: f.contract.taskSha256, codex: f.contract.runtime.codex.path, bun: f.contract.runtime.bun.path, playbook: join(f.outside, "feature.md") };
  await expect(freezePilotExecution(args)).rejects.toThrow("outside shared temporary");
  const selectedRuntime = join(unsafe, "runtime"); await writeFile(selectedRuntime, "synthetic runtime");
  await expect(freezePilotExecution({ ...args, root: f.root, bun: selectedRuntime })).rejects.toThrow("outside shared temporary");
});

runtimeTest("one contract derives disjoint fixed role inputs and explicit command authority", async () => {
  const f = await fixture();
  const build = await authorizePilotExecution(f.contract, { role: "build", identity: baseline });
  const verify = await authorizePilotExecution(f.contract, { role: "verify", identity: f.identity, source: f.source, tests: f.tests });
  const review = await authorizePilotExecution(f.contract, { role: "review", identity: f.identity, source: f.source, tests: f.tests, diff: f.diff, verification: JSON.stringify({ identity: f.identity, exitCode: 0, execution: verify.observation }) });
  expect(build.cwd).toBe(join(f.root, "builder-workspace"));
  expect(verify.observation.inputs.map(file => file.path.split("/").pop())).toEqual(["charge-cost.ts", "charge-cost.test.ts"]);
  expect(review.observation.inputs.map(file => file.path)).not.toContain(join(f.root, "target/charge-cost.ts"));
  expect(await readFile(join(review.context, "charge-cost.ts"))).toEqual(f.source);
  expect(await readFile(join(review.context, "commit-diff.txt"), "utf8")).toBe(f.diff);
  for (const launch of [build, verify, review]) {
    expect(launch.observation.contractSha256).toBe(f.identity.executionSha256);
    expect(launch.profileArguments.join(" ")).toContain('":root"="deny"');
    expect(launch.profileArguments.join(" ")).toContain('":minimal"="read"');
    expect(launch.profileArguments.join(" ")).toContain('":slash_tmp"="deny"');
    expect(launch.profileArguments.join(" ")).toContain('":tmpdir"="deny"');
    for (const pattern of ["/tm[p]", "/private/tm[p]", "/var/tm[p]", "/private/var/tm[p]", "/tmp/**", "/private/tmp/**", "/var/tmp/**", "/private/var/tmp/**"]) expect(launch.profileArguments.join(" ")).toContain(`${JSON.stringify(pattern)}="deny"`);
    expect(launch.profileArguments.join(" ")).toContain(".network.enabled=false");
    expect(launch.profileArguments).not.toContain("--sandbox");
    expect(Object.keys(launch.environment).sort()).toEqual(["BUN_RUNTIME_TRANSPILER_CACHE_PATH", "HOME", "LANG", "LC_ALL", "LOGNAME", "PATH", "SHELL", "TMPDIR", "USER"]);
    expect(launch.environment.HOME).toBe(join(f.root, "execution/home"));
    await assertPilotExecution(f.contract, launch);
  }
  expect(build.profileArguments.join(" ")).toContain(`${JSON.stringify(build.cwd)}="write"`);
  expect(verify.profileArguments.join(" ")).not.toContain('="write"');
  expect(review.profileArguments.join(" ")).not.toContain('="write"');
  expect(actorConfiguration(build).shell_environment_policy).toEqual({ inherit: "none", include_only: Object.keys(build.environment), exclude: [], set: build.environment });
  expect(actorConfiguration(review).allow_login_shell).toBe(false);
  expect(actorConfiguration(review).agents).toEqual({ max_depth: 0 });
  expect(actorConfiguration(review).notify).toEqual([]);
  expect(actorConfiguration(review).projects).toEqual({ [review.cwd]: { trust_level: "trusted" } });
  expect(verifierArguments(verify)).toContain("/usr/bin/env");
  expect(verifierArguments(verify)).toContain("-i");
  expect(verifierArguments(verify)).toContain(`HOME=${verify.environment.HOME}`);
  expect(verifierArguments(verify).slice(-3)).toEqual([f.contract.runtime.bun.path, "test", "charge-cost.test.ts"]);
  expect(() => actorPermissionArguments(verify)).toThrow();
  expect(() => verifierArguments(build)).toThrow();
});

for (const changed of ["unknown-field", "policy", "environment", "root", "runtime", "input-path"] as const) {
  runtimeTest(`frozen execution rejects ${changed} drift before dispatch`, async () => {
    const f = await fixture(); const changedContract = structuredClone(f.contract) as any;
    if (changed === "unknown-field") changedContract.permissions = "full-access";
    if (changed === "policy") changedContract.policy.roles.review.cwd = "write";
    if (changed === "environment") changedContract.environment.CREDENTIAL = "synthetic";
    if (changed === "root") changedContract.root = f.outside;
    if (changed === "runtime") await writeFile(f.contract.runtime.bun.path, "changed runtime");
    if (changed === "input-path") changedContract.inputs[0].path = join(f.root, "task.md");
    await expect(authorizePilotExecution(changedContract, { role: "build", identity: baseline })).rejects.toThrow();
  });
}
for (const changed of ["bytes", "extra", "symlink", "hardlink"] as const) {
  runtimeTest(`role input ${changed} drift cannot be accepted or replayed`, async () => {
    const f = await fixture(); const request = { role: "verify" as const, identity: f.identity, source: f.source, tests: f.tests };
    const launch = await authorizePilotExecution(f.contract, request); const path = join(launch.context, "charge-cost.ts");
    if (changed === "bytes") { await chmod(path, 0o644); await writeFile(path, "changed context"); }
    if (changed === "extra") await writeFile(join(launch.context, "extra"), "unexpected");
    if (changed === "symlink" || changed === "hardlink") {
      const target = join(f.outside, "outside"); await writeFile(target, f.source); await rm(path);
      if (changed === "symlink") await symlink(target, path); else await link(target, path);
    }
    await expect(assertPilotExecution(f.contract, launch)).rejects.toThrow();
    await expect(authorizePilotExecution(f.contract, request)).rejects.toThrow();
  });
}
runtimeTest("candidate or verification identity cannot relabel another execution policy", async () => {
  const f = await fixture();
  await expect(authorizePilotExecution(f.contract, { role: "verify", identity: { ...f.identity, executionSha256: "0".repeat(64) }, source: f.source, tests: f.tests })).rejects.toThrow("identity");
  await expect(authorizePilotExecution(f.contract, { role: "verify", identity: f.identity, source: Buffer.from("wrong"), tests: f.tests })).rejects.toThrow("identity");
  await expect(authorizePilotExecution(f.contract, { role: "review", identity: f.identity, source: f.source, tests: f.tests, diff: f.diff, verification: JSON.stringify({ identity: f.identity, exitCode: 0, execution: { contractSha256: "0".repeat(64) } }) })).rejects.toThrow("bound verification");
});
runtimeTest("builder source edits do not allow context edits, profile changes or runtime replacement", async () => {
  const f = await fixture(); const launch = await authorizePilotExecution(f.contract, { role: "build", identity: baseline });
  await writeFile(join(launch.cwd, "charge-cost.ts"), "legitimate implementation");
  await assertPilotExecution(f.contract, launch);
  await expect(assertPilotExecution(f.contract, { ...launch, profileArguments: ["--permission-profile", ":danger-full-access"] })).rejects.toThrow("policy");
  await chmod(join(launch.context, "task.md"), 0o644);
  await writeFile(join(launch.context, "task.md"), "relabeled task");
  await expect(assertPilotExecution(f.contract, launch)).rejects.toThrow("changed");
});

runtimeTest("documentation envelope uses only its fixed output test and reference names", async () => {
  const f = await fixture("temari-routing-doc");
  const build = await authorizePilotExecution(f.contract, { role: "build", identity: baseline });
  const verify = await authorizePilotExecution(f.contract, { role: "verify", identity: f.identity, source: f.source, tests: f.tests });
  const names = verify.observation.inputs.map(file => file.path.split("/").pop());
  expect(names).toEqual(["archon-role-routing.md", "archon-role-routing.test.ts", "README.md", "live.ts", "live-routing.ts", "live-permissions.ts"]);
  expect(verifierArguments(verify).slice(-3)).toEqual([f.contract.runtime.bun.path, "test", "archon-role-routing.test.ts"]);
  expect(await readFile(join(verify.context, "archon-role-routing.test.ts"))).toEqual(f.tests);
  expect(build.observation.inputs.map(file => file.path.split("/").pop())).toContain("live-routing.ts");
  expect(actorConfiguration(build)).not.toHaveProperty("model");
  expect(verify.profileArguments.join(" ")).not.toContain('="write"');
  await assertPilotExecution(f.contract, verify);
});
