#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPilot } from "./fixtures/pilot.ts";
import { finalize } from "./bridge.ts";
import { workflowCheck } from "../../skills/poteto-mode/scripts/workflow/workflow.ts";

export async function verifyFoundation(executable: string, evidenceDirectory?: string) {
  const selected = evidenceDirectory ?? await mkdtemp(join(tmpdir(), "temari-archon-smoke-"));
  await mkdir(selected, { recursive: true });
  if ((await lstat(selected)).isSymbolicLink() || (await readdir(selected)).length) throw new Error(`evidence directory must be empty and not a symlink: ${selected}`);
  const root = await realpath(selected);
  const integration = dirname(fileURLToPath(import.meta.url));
  const request = await createPilot(root, { failOnce: true });
  const env = { ...process.env, ARCHON_HOME: join(root, "archon-home"), LOG_LEVEL: "error", DO_NOT_TRACK: "1", CLAUDE_BIN_PATH: "/usr/bin/false", PATH: `${dirname(process.execPath)}:${process.env.PATH}` };
  const require = (condition: unknown, message: string): void => { if (!condition) throw new Error(`${message}; evidence retained at ${root}`); };
  async function archon(label: string, args: string[], allowFailure = false) {
    const result = spawnSync(executable, args, { cwd: request.repositoryRoot, env, encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024 });
    await writeFile(join(root, `${label}.stdout.log`), result.stdout ?? "");
    await writeFile(join(root, `${label}.stderr.log`), result.stderr ?? "");
    if (!allowFailure) require(result.status === 0, `${label} failed: ${result.error ?? result.stderr ?? result.stdout}`);
    return result;
  }
  const version = await archon("version", ["version"]);
  require(/^Archon CLI v0\.10\.1$/m.test(version.stdout) && /^  Git commit: 9820785c$/m.test(version.stdout), "pilot compatibility is pinned to Archon v0.10.1 at 9820785c");
  await archon("validate", ["validate", "workflows", "temari-pilot", "--cwd", request.repositoryRoot]);
  const launch = await archon("launch", ["workflow", "run", "temari-pilot", "--cwd", request.repositoryRoot, "--workflow-source", integration, "--no-worktree", "--input", `bridge=${join(integration, "bridge.ts")}`, "--input", `spec=${request.specPath}`, "--detach", "--json"]);
  const runId = JSON.parse(launch.stdout).runId;
  require(typeof runId === "string", "detached launch did not return an exact run ID");
  await archon("wait-failed", ["workflow", "wait", runId, "--timeout", "40", "--json"], true);
  const failed = JSON.parse((await archon("failed", ["workflow", "get", runId, "--json"])).stdout);
  require(failed.id === runId && failed.status === "failed", "first run must fail at the controlled verification checkpoint");
  const artifactsDirectory = join(failed.output_root, "artifacts", "runs", runId);
  require(!await Bun.file(join(artifactsDirectory, "evidence.json")).exists(), "failed run published a completion marker");
  const before = await readFile(join(artifactsDirectory, "temari-bridge", "stages", "build.json"), "utf8");
  const resumed = await archon("resume", ["workflow", "resume", runId, "--cwd", request.repositoryRoot]);
  require(resumed.stderr.includes("[build] Skipped (prior_success)"), "Archon did not report reuse of the successful builder");
  const completed = JSON.parse((await archon("completed", ["workflow", "get", runId, "--json"])).stdout);
  require(completed.id === runId && completed.status === "completed", "exact resumed run did not complete");
  require(await readFile(join(root, "control", "build-count"), "utf8") === "1", "builder side effect ran more than once");
  require(await readFile(join(artifactsDirectory, "temari-bridge", "stages", "build.json"), "utf8") === before, "builder capture changed during resume");
  const marker = await finalize({ ...request, archonRunId: runId, artifactsDirectory });
  require((await workflowCheck(marker.binding.temariRunDirectory, "review")).passed, "canonical review check failed");
  const verificationPointer = JSON.parse(await readFile(join(artifactsDirectory, "temari-bridge", "stages", "verify.json"), "utf8"));
  const verification = await readFile(join(artifactsDirectory, "temari-bridge", "attempts", verificationPointer.attempt, "sealed", "evidence-0"), "utf8");
  require(verification.includes("2 pass") && verification.includes("0 fail"), "successful capture lacks actual target test output");
  const summary = { fixtureOnly: true, archonVersion: version.stdout.trim(), archonRunId: runId as string, firstStatus: failed.status as string, finalStatus: completed.status as string, builderInvocations: 1, reviewPassed: true, artifactsDirectory, receiptPath: resolve(artifactsDirectory, marker.receipt.path), hardKillRecoveryExercised: false };
  await writeFile(join(root, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

if (import.meta.main) {
  const executable = process.env.ARCHON_BIN;
  if (!executable) throw new Error("set ARCHON_BIN to a verified Archon v0.10.1 executable");
  const summary = await verifyFoundation(executable);
  console.log(`PASS: ${summary.archonRunId} failed, resumed, skipped the builder, passed 2 actual tests and produced a canonical review receipt.\nReceipt: ${summary.receiptPath}`);
}
