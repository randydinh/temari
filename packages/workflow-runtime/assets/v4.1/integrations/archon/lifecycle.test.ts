import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
let root: string;
let runtime: string;
let installed: string;
const recordName = ".temari-archon-install.json";

function cli(packageRoot: string, args: string[]) {
  const result = spawnSync(process.execPath, [join(packageRoot, "integrations/archon/lifecycle.ts"), ...args, "--json"], { cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}` }, timeout: 90_000 });
  if (result.error) throw result.error;
  return { status: result.status, output: JSON.parse(result.stdout), stderr: result.stderr };
}
async function clone(name: string) {
  const destination = join(root, name);
  await cp(installed, destination, { recursive: true });
  return destination;
}
async function fake(name: string, version = "0.10.1", validationFailure = false) {
  const path = join(root, name);
  await writeFile(path, `#!/bin/sh\nif [ "$1" = version ]; then\n  printf 'Archon CLI v${version}\\n  Git commit: 9820785c\\n'\nelse\n  printf '${validationFailure ? '{"error":"fixture validation failed"}' : '{"summary":{"total":1,"valid":1,"errors":0}}'}\\n'\n  exit ${validationFailure ? 1 : 0}\nfi\n`, { mode: 0o755 });
  return path;
}

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "temari-archon-lifecycle-test-")));
  runtime = await fake("archon");
  const result = cli(source, ["install", "--dest", join(root, "fresh"), "--archon", runtime]);
  expect(result.status).toBe(0);
  installed = result.output.packageRoot;
}, 90_000);

afterAll(async () => { await rm(root, { recursive: true, force: true }); });

test("fresh installation preserves hidden workflow and locked production dependencies", async () => {
  const result = cli(installed, ["check", "--archon", runtime]);
  expect(result.status).toBe(0);
  expect(result.output.checks.execution.status).toBe("not-requested");
  expect(result.output.candidate.verified).toBe("unknown");
  expect(result.output.liveAI).toBe("bounded-pilot-available");
  expect(result.output.liveCandidate.verified).toBe("unknown");
  expect(result.output.liveCandidate.authenticated).toBe("unknown");
  expect(await readdir(join(installed, "skills/poteto-mode/scripts/node_modules"))).toEqual(["commander"]);
  expect(await Bun.file(join(installed, "integrations/archon/.archon/workflows/temari-pilot.yaml")).exists()).toBe(true);
  const live = spawnSync(process.execPath, [join(installed, "integrations/archon/live.ts"), "prepare", "--root", join(root, "installed-live-prepared")], { encoding: "utf8" });
  expect(live.status).toBe(0);
  expect(JSON.parse(live.stdout).taskSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(await Bun.file(join(installed, "integrations/archon/.archon/workflows/temari-live-pilot.yaml")).exists()).toBe(true);
  const record = await readFile(join(installed, recordName), "utf8");
  expect(record.includes(root)).toBe(false);
  expect(record.includes('"ready"')).toBe(false);
});

test("exact repeat probes again and preserves unrelated siblings", async () => {
  const sibling = join(root, "fresh", "keep.txt");
  await writeFile(sibling, "keep");
  const before = await readFile(join(installed, recordName), "utf8");
  const result = cli(source, ["install", "--dest", join(root, "fresh"), "--archon", runtime]);
  expect(result.status).toBe(0);
  expect(result.output.installation).toBe("unchanged");
  expect(await readFile(join(installed, recordName), "utf8")).toBe(before);
  expect(await readFile(sibling, "utf8")).toBe("keep");
  const wrong = await fake("wrong-repeat", "9.0.0");
  expect(cli(source, ["install", "--dest", join(root, "fresh"), "--archon", wrong]).status).toBe(1);
});

test("foreign destination, destination symlink, overlap and lock are refused", async () => {
  const parent = join(root, "foreign");
  const foreign = join(parent, "archon-foundation");
  await mkdir(foreign, { recursive: true });
  await writeFile(join(foreign, "keep.txt"), "foreign");
  expect(cli(source, ["install", "--dest", parent, "--archon", runtime]).output.error).toContain("unowned");
  expect(await readFile(join(foreign, "keep.txt"), "utf8")).toBe("foreign");
  const linked = join(root, "linked");
  await mkdir(linked);
  await symlink(installed, join(linked, "archon-foundation"));
  expect(cli(source, ["install", "--dest", linked, "--archon", runtime]).output.error).toContain("symlink");
  expect(cli(installed, ["install", "--dest", installed, "--archon", runtime]).output.error).toContain("overlap");
  const locked = join(root, "locked");
  await mkdir(join(locked, ".archon-foundation.install-lock"), { recursive: true });
  expect(cli(source, ["install", "--dest", locked, "--archon", runtime]).output.error).toContain("lock unavailable");
});

test("drift refuses repeat and does not import modified dependency code", async () => {
  const drift = await clone("drift");
  const marker = join(root, "must-not-execute");
  await writeFile(join(drift, "skills/poteto-mode/scripts/workflow/workflow.ts"), `await Bun.write(${JSON.stringify(marker)}, "executed");`);
  const result = cli(drift, ["check", "--archon", runtime]);
  expect(result.status).toBe(1);
  expect(result.output.checks.package.detail).toContain("content changed");
  expect(result.output.checks.dependencies.status).toBe("not-requested");
  expect(await Bun.file(marker).exists()).toBe(false);
  const parent = join(root, "drift-repeat");
  await mkdir(parent);
  await rename(drift, join(parent, "archon-foundation"));
  expect(cli(source, ["install", "--dest", parent, "--archon", runtime]).output.error).toContain("content changed");
});

test("missing managed payload and extra files fail integrity", async () => {
  const missing = await clone("missing-payload");
  await rm(join(missing, "integrations/archon/.archon/workflows/temari-pilot.yaml"));
  expect(cli(missing, ["check", "--archon", runtime]).output.checks.package.status).toBe("failed");
  const extra = await clone("extra-file");
  await writeFile(join(extra, "user-notes.txt"), "preserve");
  expect(cli(extra, ["check", "--archon", runtime]).output.checks.package.status).toBe("failed");
  expect(await readFile(join(extra, "user-notes.txt"), "utf8")).toBe("preserve");
});

test("moved installation checks itself from an unrelated directory and accepts explicit runtime symlink", async () => {
  const moving = await clone("before-move");
  const moved = join(root, "after-move");
  await rename(moving, moved);
  const link = join(root, "runtime-link");
  await symlink(runtime, link);
  const result = cli(moved, ["check", "--archon", link]);
  expect(result.status).toBe(0);
  expect(result.output.packageRoot).toBe(moved);
  const live = spawnSync(process.execPath, [join(moved, "integrations/archon/live.ts"), "prepare", "--root", join(root, "moved-live-prepared")], { encoding: "utf8" });
  expect(live.status).toBe(0);
  expect(JSON.parse(live.stdout).repositoryRoot).toBe(join(root, "moved-live-prepared/target"));
  expect(result.output.runtime.sha256).toMatch(/^[a-f0-9]{64}$/);
});

test("missing, wrong and failing runtime are fresh failures with diagnostics", async () => {
  const missing = cli(installed, ["check", "--archon", join(root, "absent")]);
  expect(missing.status).toBe(1);
  expect(missing.output.checks.runtime.status).toBe("failed");
  const wrong = await fake("wrong-version", "9.0.0");
  expect(cli(installed, ["check", "--archon", wrong]).output.checks.runtime.detail).toContain("incompatible");
  const invalid = await fake("invalid-workflow", "0.10.1", true);
  expect(cli(installed, ["check", "--archon", invalid]).output.checks.workflow.detail).toContain("fixture validation failed");
});

test("failed setup never publishes and leaves siblings intact", async () => {
  const standalone = await clone("source-without-dependencies");
  await rm(join(standalone, recordName));
  await rm(join(standalone, "skills/poteto-mode/scripts/node_modules"), { recursive: true });
  const checked = cli(standalone, ["check", "--archon", runtime]);
  expect(checked.output.checks.dependencies.status).toBe("failed");
  const local = cli(standalone, ["install", "--dest", join(root, "from-standalone"), "--archon", runtime]);
  expect(local.status).toBe(0);
  await writeFile(join(standalone, "skills/poteto-mode/scripts/bun.lock"), "invalid-lockfile");
  const parent = join(root, "dependency-failure");
  await mkdir(parent);
  await writeFile(join(parent, "keep.txt"), "keep");
  const result = cli(standalone, ["install", "--dest", parent, "--archon", runtime]);
  expect(result.status).toBe(1);
  expect(result.output.error).toContain("install failed");
  expect(await readdir(parent)).toEqual(["keep.txt"]);
  expect(await readFile(join(parent, "keep.txt"), "utf8")).toBe("keep");
  const absent = join(root, "missing-runtime-install");
  expect(cli(source, ["install", "--dest", absent, "--archon", join(root, "absent")]).status).toBe(1);
  expect(await readdir(absent)).toEqual([]);
}, 90_000);

test("source changes require a new destination rather than overwrite", async () => {
  const changed = await clone("changed-source");
  await rm(join(changed, recordName));
  await writeFile(join(changed, "integrations/archon/README.md"), "new release");
  const result = cli(changed, ["install", "--dest", join(root, "fresh"), "--archon", runtime]);
  expect(result.output.error).toContain("another destination");
});

test("verification rejects package-contained, symlink-contained and populated evidence before fixture writes", async () => {
  const alias = join(root, "package-alias");
  await symlink(installed, alias);
  for (const evidence of [join(installed, "evidence"), join(alias, "evidence")]) {
    const result = cli(installed, ["check", "--archon", runtime, "--verify", "--evidence", evidence]);
    expect(result.status).toBe(1);
    expect(result.output.checks.execution.detail).toContain("outside the package");
  }
  expect(await Bun.file(join(installed, "evidence/target/charge-cost.ts")).exists()).toBe(false);
  const occupied = join(root, "occupied-evidence");
  await mkdir(occupied);
  await writeFile(join(occupied, "keep.txt"), "keep");
  const result = cli(installed, ["check", "--archon", runtime, "--verify", "--evidence", occupied]);
  expect(result.status).toBe(1);
  expect(result.output.checks.execution.detail).toContain("empty");
  expect(await readdir(occupied)).toEqual(["keep.txt"]);
});

test("a drifted owned source cannot publish a newly trusted installation", async () => {
  const drifted = await clone("drifted-source");
  await writeFile(join(drifted, "integrations/archon/README.md"), "modified owned source");
  const destination = join(root, "from-drifted-source");
  const result = cli(drifted, ["install", "--dest", destination, "--archon", runtime]);
  expect(result.status).toBe(1);
  expect(result.output.error).toContain("content changed");
  expect(await Bun.file(join(destination, "archon-foundation", recordName)).exists()).toBe(false);
});

test("installed live workflow deadlines enclose the bridge and complete serial run", async () => {
  const workflow = Bun.YAML.parse(await readFile(join(installed, "integrations/archon/.archon/workflows/temari-live-pilot.yaml"), "utf8")) as { nodes: { id: string; timeout?: number; bash: string }[] };
  const { liveTimeouts } = await import(join(installed, "integrations/archon/live.ts"));
  const { taskBudget } = await import(join(installed, "integrations/archon/live-tasks.ts"));
  expect(workflow.nodes.map(node => node.id)).toEqual(["build", "shape-final", "verify", "review", "finalize"]);
  for (const node of workflow.nodes) {
    expect(Number.isSafeInteger(node.timeout)).toBe(true);
    if (node.id !== "finalize") for (const task of ["charge-cost", "temari-routing-doc"] as const) expect(node.timeout!).toBeGreaterThanOrEqual(taskBudget(task).minimumCaptureMs);
    else expect(node.timeout!).toBe(60_000);
  }
  expect(liveTimeouts.workflowWaitSeconds * 1000).toBeGreaterThanOrEqual(workflow.nodes.reduce((total, node) => total + node.timeout!, 0));
  expect(liveTimeouts.reportingGraceMs).toBeGreaterThanOrEqual(30_000);
});
