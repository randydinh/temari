import { afterAll, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { preparePilot, inventory, admitSource } from "./live.ts";
import { taskRecipe, taskBudget } from "./live-tasks.ts";
import { codexLimits } from "./live-codex.ts";
import { payload } from "./lifecycle.ts";
const roots: string[] = [];
const integration = import.meta.dir;
afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });
async function temporary() { const root = await realpath(await mkdtemp(join(tmpdir(), "temari-doc-task-"))); roots.push(root); return root; }
function git(root: string, ...args: string[]) { return execFileSync("git", ["-C", root, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-c", "user.name=Synthetic task", "-c", "user.email=synthetic@example.invalid", ...args], { encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }).trim(); }
async function source(root: string) {
  const repository = join(root, "source"); await mkdir(repository);
  for (const path of payload) { await mkdir(dirname(join(repository, path)), { recursive: true }); await copyFile(resolve(integration, "../..", path), join(repository, path)); }
  git(repository, "init", "-b", "main"); git(repository, "add", "."); git(repository, "commit", "-m", "Synthetic matching Temari payload");
  git(repository, "update-index", "--add", "--cacheinfo", `160000,${git(repository, "rev-parse", "HEAD")},external/content-registrar`); git(repository, "commit", "-m", "Synthetic uninitialized known gitlink");
  await mkdir(join(repository, "external/content-registrar"), { recursive: true });
  return repository;
}
const syntheticDocument = `# Synthetic guide fixture\n\nThis text verifies the data contract only; no model authored this fixture. ${"Synthetic explanatory text. ".repeat(32)}\n\npermissions planning summary.json native-run.json ARCHON_HOME receipt macOS 0.154.0\n\n\x60\x60\x60sh\nbun /absolute/installed/integrations/archon/live.ts run --root /owned/pilot --planning /owned/manifest.json --archon /absolute/archon --codex /absolute/codex\n\x60\x60\x60\n\n\x60\x60\x60sh\nbun /absolute/installed/integrations/archon/live.ts run \\\n  --root /owned/pilot --planning /owned/manifest.json --archon /absolute/archon --codex /absolute/codex \\\n  --builder-model gpt-5.6-luna --builder-reasoning high --reviewer-model gpt-5.6-luna --reviewer-reasoning xhigh\n\x60\x60\x60\n`;
test("documentation preparation preserves source HEAD, uninitialized gitlink and absent output", async () => {
  const root = await temporary(); const repository = await source(root); const before = await inventory(repository);
  const prepared = await preparePilot({ root: join(root, "pilot"), task: "temari-routing-doc", repository });
  expect(prepared.baseline.head).toBe(git(repository, "rev-parse", "HEAD"));
  expect(await inventory(repository)).toEqual(before);
  expect(git(prepared.repositoryRoot, "status", "--porcelain", "--untracked-files=all")).toBe("");
  expect(git(prepared.repositoryRoot, "ls-tree", "HEAD", "external/content-registrar")).toContain("160000 commit");
  expect(await Bun.file(join(prepared.repositoryRoot, "docs/archon-role-routing.md")).exists()).toBe(false);
  expect(await readFile(join(prepared.root, "control/task/archon-role-routing.test.ts"), "utf8")).toBe(taskRecipe("temari-routing-doc").tests);
  expect(git(prepared.repositoryRoot, "remote")).toBe("");
});
test("documentation preparation rejects dirty, divergent and preexisting output sources", async () => {
  const root = await temporary(); const repository = await source(root);
  await writeFile(join(repository, "untracked"), "dirty");
  await expect(preparePilot({ root: join(root, "dirty"), task: "temari-routing-doc", repository })).rejects.toThrow("clean separate");
  await rm(join(repository, "untracked"));
  await writeFile(join(repository, "integrations/archon/live-routing.ts"), "different implementation"); git(repository, "add", "."); git(repository, "commit", "-m", "Divergent synthetic package");
  await expect(preparePilot({ root: join(root, "different"), task: "temari-routing-doc", repository })).rejects.toThrow("package differ");
  git(repository, "reset", "--hard", "HEAD~1");
  await mkdir(join(repository, "docs")); await writeFile(join(repository, "docs/archon-role-routing.md"), "existing"); git(repository, "add", "."); git(repository, "commit", "-m", "Existing synthetic document");
  await expect(preparePilot({ root: join(root, "exists"), task: "temari-routing-doc", repository })).rejects.toThrow("already exists");
});
test("fixed documentation verifier parses real routing options and treats Markdown as data", async () => {
  const root = await temporary(); const recipe = taskRecipe("temari-routing-doc");
  await writeFile(join(root, recipe.testFilename), recipe.tests); await copyFile(join(integration, "live-routing.ts"), join(root, "live-routing.ts"));
  await writeFile(join(root, recipe.actorFilename), syntheticDocument);
  const passed = spawnSync(process.execPath, ["test", recipe.testFilename], { cwd: root, encoding: "utf8" });
  expect(passed.status).toBe(0); expect(passed.stderr).toContain("14 expect() calls"); expect(passed.stderr).toContain("3 pass");
  await writeFile(join(root, recipe.actorFilename), syntheticDocument.replace("--builder-reasoning high", "--unknown-control high"));
  expect(spawnSync(process.execPath, ["test", recipe.testFilename], { cwd: root }).status).not.toBe(0);
});
test("documentation admission retains one bounded output and inventory includes opaque Git data", async () => {
  const root = await temporary(); const scratch = join(root, "scratch"); await mkdir(scratch);
  await writeFile(join(scratch, "archon-role-routing.md"), syntheticDocument, { mode: 0o644 });
  expect((await admitSource(scratch, { sha256: "empty", size: 0, mode: 0o644 }, "temari-routing-doc")).toString()).toBe(syntheticDocument);
  await writeFile(join(scratch, "extra"), "no"); await expect(admitSource(scratch, { sha256: "empty", size: 0, mode: 0o644 }, "temari-routing-doc")).rejects.toThrow("only");
  const canonical = join(root, "canonical"); await mkdir(join(canonical, ".git/objects"), { recursive: true });
  await writeFile(join(canonical, ".git/objects/large"), Buffer.alloc(5 * 1024 * 1024));
  const files = await inventory(canonical); expect(files[".git/objects/large"]!.size).toBe(5 * 1024 * 1024);
  await symlink("large", join(canonical, ".git/objects/link")); await expect(inventory(canonical)).rejects.toThrow("unsupported");
});

test("closed task budgets preserve the fixture limit and bound the larger documentation context", () => {
  expect(taskBudget("charge-cost")).toEqual({ actorMs: 180_000, stageMs: 240_000, minimumCaptureMs: 300_000 });
  expect(taskBudget("temari-routing-doc")).toEqual({ actorMs: 600_000, stageMs: 660_000, minimumCaptureMs: 720_000 });
  for (const task of ["charge-cost", "temari-routing-doc"] as const) {
    expect(codexLimits(task).timeoutMs).toBe(taskBudget(task).actorMs);
    expect(taskBudget(task).stageMs - codexLimits(task).timeoutMs).toBe(60_000);
    expect(taskBudget(task).minimumCaptureMs - taskBudget(task).stageMs).toBe(60_000);
  }
  expect(() => taskBudget("arbitrary" as never)).toThrow("unsupported");
});
