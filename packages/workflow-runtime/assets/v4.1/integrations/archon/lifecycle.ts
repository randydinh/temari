#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const recordName = ".temari-archon-install.json";
const compatibility = { version: "0.10.1", commit: "9820785c" };
export const payload = [
  "integrations/archon/lifecycle.ts", "integrations/archon/README.md", "integrations/archon/bridge.ts", "integrations/archon/canonical-bridge.ts", "integrations/archon/smoke.ts",
  "integrations/archon/live.ts", "integrations/archon/live-codex.ts", "integrations/archon/live-routing.ts", "integrations/archon/live-tasks.ts", "integrations/archon/live-permissions.ts", "integrations/archon/.archon/workflows/temari-live-pilot.yaml",
  "integrations/archon/worker-efficiency.ts", "integrations/archon/privacy.ts", "integrations/archon/model-transport.ts", "integrations/archon/codex-model-driver.ts", "integrations/archon/openai-responses-driver.ts",
  "integrations/archon/fixtures/pilot.ts", "integrations/archon/fixtures/stage.ts", "integrations/archon/.archon/workflows/temari-pilot.yaml", "integrations/archon/.archon/workflows/temari-nx-canonical.yaml",
  "skills/poteto-mode/scripts/package.json", "skills/poteto-mode/scripts/bun.lock",
  ...["profiles", "receipt", "store", "types", "workflow"].map(name => `skills/poteto-mode/scripts/workflow/${name}.ts`),
  "skills/poteto-mode/playbook-contracts/v1/feature.json", "skills/poteto-mode/playbooks/feature.md",
].sort();

type Manifest = Record<string, string>;
type InstallRecord = { owner: "temari.archon-foundation"; schema: 1; compatibility: typeof compatibility; files: Manifest };
type Check = { status: "passed" | "failed" | "not-requested"; detail: string };
type Result = {
  observedAt: string; packageRoot: string; packageDigest: string | null; liveAI: "bounded-pilot-available";
  liveCandidate: { name: "archon-bounded-codex-pilot"; scope: string; configured: "unknown"; exposed: "present" | "absent"; authenticated: "unknown"; verified: "unknown" };
  checks: { package: Check; dependencies: Check; runtime: Check; workflow: Check; execution: Check };
  runtime: { executable: string; sha256: string | null; version: string | null };
  evidenceDirectory?: string; installation?: "created" | "unchanged"; failures: string[];
  candidate: { name: string; kind: "cli"; source: string; suitability: "suitable"; suitability_evidence: string; configured: "present"; exposed: "present" | "absent"; authenticated: "unknown"; verified: "present" | "unknown" };
};

const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const exists = async (path: string) => { try { return await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; } };
const within = (parent: string, child: string) => child === parent || child.startsWith(`${parent}${sep}`);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

async function canonicalTarget(path: string): Promise<string> {
  let ancestor = path;
  while (!await exists(ancestor)) ancestor = dirname(ancestor);
  return resolve(await realpath(ancestor), relative(ancestor, path));
}

async function files(root: string, prefix = ""): Promise<Manifest> {
  const manifest: Manifest = {};
  for (const item of (await readdir(join(root, prefix))).sort()) {
    const path = prefix ? `${prefix}/${item}` : item;
    if (path === recordName) continue;
    const info = await lstat(join(root, path));
    if (info.isDirectory()) Object.assign(manifest, await files(root, path));
    else if (info.isFile()) manifest[path] = hash(await readFile(join(root, path)));
    else throw new Error(`unsupported link or special file: ${path}`);
  }
  return manifest;
}

async function payloadFiles(root: string): Promise<Manifest> {
  const manifest: Manifest = {};
  for (const path of payload) {
    if (!(await lstat(join(root, path))).isFile()) throw new Error(`required payload is not a regular file: ${path}`);
    manifest[path] = hash(await readFile(join(root, path)));
  }
  return manifest;
}

async function installedRecord(root: string): Promise<InstallRecord> {
  if (!(await lstat(join(root, recordName))).isFile()) throw new Error("installation record must be a regular file");
  const value: unknown = JSON.parse(await readFile(join(root, recordName), "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid installation record");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).sort().join() !== "compatibility,files,owner,schema" || raw.owner !== "temari.archon-foundation" || raw.schema !== 1 || JSON.stringify(raw.compatibility) !== JSON.stringify(compatibility)) throw new Error("unrecognized installation owner, schema or compatibility");
  if (!raw.files || typeof raw.files !== "object" || Array.isArray(raw.files)) throw new Error("invalid installation manifest");
  const manifest = raw.files as Record<string, unknown>;
  for (const [path, digest] of Object.entries(manifest)) {
    if (isAbsolute(path) || path.split("/").some(part => !part || part === "." || part === "..") || path === recordName || typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) throw new Error(`invalid manifest entry: ${path}`);
  }
  if (payload.some(path => !(path in manifest))) throw new Error("installation manifest omits required payload");
  return raw as InstallRecord;
}

async function integrity(root: string): Promise<string> {
  const required = await payloadFiles(root);
  if (await exists(join(root, recordName))) {
    const record = await installedRecord(root);
    const current = await files(root);
    if (Object.keys(current).length !== Object.keys(record.files).length || Object.entries(record.files).some(([path, digest]) => current[path] !== digest)) throw new Error("installed content changed or contains extra files; preserve it and install in another destination");
    return hash(JSON.stringify(record.files));
  }
  return hash(JSON.stringify(required));
}

function environment(home: string): NodeJS.ProcessEnv {
  return { ...process.env, ARCHON_HOME: home, LOG_LEVEL: "error", DO_NOT_TRACK: "1", CLAUDE_BIN_PATH: "/usr/bin/false", PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` };
}

function run(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeout = 15_000): string {
  const result = spawnSync(executable, args, { cwd, env, encoding: "utf8", timeout, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${executable} ${args[0]} failed: ${result.error?.message ?? `exit ${result.status}; ${result.stderr.trim()} ${result.stdout.trim()}`}`);
  return result.stdout;
}

async function inspect(root: string, executable: string, verify: boolean, evidence?: string): Promise<Result> {
  const pending = (): Check => ({ status: "not-requested", detail: "not requested" });
  const result: Result = {
    observedAt: new Date().toISOString(), packageRoot: root, packageDigest: null, liveAI: "bounded-pilot-available",
    liveCandidate: { name: "archon-bounded-codex-pilot", scope: "Two closed tasks: charge-cost fixture or new Temari role-routing guide; separate explicit live.ts run required", configured: "unknown", exposed: "absent", authenticated: "unknown", verified: "unknown" },
    checks: { package: pending(), dependencies: pending(), runtime: pending(), workflow: pending(), execution: pending() },
    runtime: { executable, sha256: null, version: null }, failures: [],
    candidate: { name: "archon-deterministic-foundation", kind: "cli", source: join(root, "integrations/archon"), suitability: "suitable", suitability_evidence: "Supports the deterministic Temari failure/resume foundation only; the bounded live pilot requires separate explicit execution.", configured: "present", exposed: "absent", authenticated: "unknown", verified: "unknown" },
  };
  const probeRoot = await mkdtemp(join(tmpdir(), "temari-archon-check-"));
  const env = environment(join(probeRoot, "archon-home"));
  async function check(key: keyof Result["checks"], operation: () => Promise<string>) {
    try { result.checks[key] = { status: "passed", detail: await operation() }; }
    catch (error) { const detail = `${message(error)}${key === "execution" && result.evidenceDirectory ? `; evidence: ${result.evidenceDirectory}` : ""}`; result.checks[key] = { status: "failed", detail }; result.failures.push(`${key}: ${detail}`); }
  }
  try {
    await check("package", async () => { result.packageDigest = await integrity(root); return await exists(join(root, recordName)) ? "owned installation matches its manifest" : "source payload is complete; no installation manifest"; });
    if (result.checks.package.status === "passed") await check("dependencies", async () => {
      const scripts = join(root, "skills/poteto-mode/scripts");
      const dependency = JSON.parse(await readFile(join(scripts, "node_modules/commander/package.json"), "utf8"));
      const declared = JSON.parse(await readFile(join(scripts, "package.json"), "utf8"));
      if (dependency.version !== declared.dependencies.commander) throw new Error("local commander version does not match the locked package");
      const code = `await import(${JSON.stringify(pathToFileURL(join(scripts, "workflow/workflow.ts")).href)}); const {loadProfile} = await import(${JSON.stringify(pathToFileURL(join(scripts, "workflow/profiles.ts")).href)}); await loadProfile(${JSON.stringify(join(root, "skills/poteto-mode/playbook-contracts/v1/feature.json"))});`;
      run(process.execPath, ["-e", code], probeRoot, env);
      run("git", ["--version"], probeRoot, env);
      return `Bun ${Bun.version}, local commander ${dependency.version}, canonical Feature profile and Git are available`;
    });
    await check("runtime", async () => {
      const selected = await realpath(executable);
      if (!(await lstat(selected)).isFile()) throw new Error("--archon must select a regular executable file");
      result.runtime.executable = selected;
      result.runtime.sha256 = hash(await readFile(selected));
      const version = run(executable, ["version"], probeRoot, env);
      result.runtime.version = version.trim();
      if (!/^Archon CLI v0\.10\.1$/m.test(version) || !/^  Git commit: 9820785c$/m.test(version)) throw new Error("incompatible runtime; require Archon v0.10.1 at 9820785c");
      return "Archon v0.10.1 at 9820785c";
    });
    if (result.checks.package.status === "passed" && result.checks.runtime.status === "passed") {
      await check("workflow", async () => {
        await mkdir(join(probeRoot, ".archon/workflows"), { recursive: true });
        run("git", ["init", "-b", "main", probeRoot], probeRoot, env);
        for (const name of ["temari-pilot", "temari-live-pilot", "temari-nx-canonical"]) {
          await copyFile(join(root, `integrations/archon/.archon/workflows/${name}.yaml`), join(probeRoot, `.archon/workflows/${name}.yaml`));
          const validation: unknown = JSON.parse(run(executable, ["validate", "workflows", name, "--cwd", probeRoot, "--json"], probeRoot, env));
          if (!validation || typeof validation !== "object" || !("summary" in validation)) throw new Error("workflow validation returned no summary");
          const summary = validation.summary as Record<string, unknown>;
          if (summary.total !== 1 || summary.valid !== 1 || summary.errors !== 0) throw new Error("native workflow validation did not accept exactly one workflow");
        }
        return "installed deterministic and bounded live workflows pass native validation; no model was called";
      });
    }
    if (result.failures.length === 0) {
      result.candidate.exposed = "present";
      result.liveCandidate.exposed = "present";
      if (verify) {
        await check("execution", async () => {
          const requested = evidence ?? await mkdtemp(join(tmpdir(), "temari-archon-verification-"));
          const evidenceRoot = await canonicalTarget(requested);
          if (within(await realpath(root), evidenceRoot)) throw new Error("verification evidence must be outside the package");
          result.evidenceDirectory = evidenceRoot;
          const { verifyFoundation } = await import(pathToFileURL(join(root, "integrations/archon/smoke.ts")).href);
          const summary = await verifyFoundation(executable, requested);
          return `run ${summary.archonRunId}: failed, resumed, builder ran once, canonical review passed`;
        });
        if (result.checks.execution.status === "passed") result.candidate.verified = "present";
      }
    } else if (verify) result.checks.execution.detail = "not run because a prerequisite failed";
    return result;
  } finally { await rm(probeRoot, { recursive: true, force: true }); }
}

async function install(parent: string, executable: string): Promise<Result> {
  const source = await realpath(packageRoot);
  await integrity(source);
  await mkdir(parent, { recursive: true });
  const canonicalParent = await realpath(parent);
  const destination = join(canonicalParent, "archon-foundation");
  if (within(source, destination) || within(destination, source)) throw new Error("source and installation destination must not overlap");
  const lock = join(canonicalParent, ".archon-foundation.install-lock");
  try { await mkdir(lock); } catch (error) { throw new Error(`installation lock unavailable at ${lock}; inspect any interrupted installer before removing it: ${message(error)}`); }
  let stage: string | undefined;
  try {
    const present = await exists(destination);
    if (present) {
      if (!present.isDirectory() || present.isSymbolicLink()) throw new Error(`refusing non-directory or symlink destination: ${destination}`);
      if (!await exists(join(destination, recordName))) throw new Error(`refusing unowned destination: ${destination}`);
      await integrity(destination);
      const sourceFiles = await payloadFiles(source);
      const record = await installedRecord(destination);
      if (Object.entries(sourceFiles).some(([path, digest]) => record.files[path] !== digest)) throw new Error("a different package is installed; choose another destination for an upgrade");
      const result = await inspect(destination, executable, false);
      result.installation = "unchanged";
      return result;
    }
    stage = await mkdtemp(join(canonicalParent, ".archon-foundation.stage-"));
    for (const path of payload) {
      await mkdir(dirname(join(stage, path)), { recursive: true });
      await copyFile(join(source, path), join(stage, path));
    }
    run(process.execPath, ["install", "--cwd", join(stage, "skills/poteto-mode/scripts"), "--frozen-lockfile", "--production", "--ignore-scripts"], stage, process.env, 60_000);
    const record: InstallRecord = { owner: "temari.archon-foundation", schema: 1, compatibility, files: await files(stage) };
    await writeFile(join(stage, recordName), `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
    const result = await inspect(stage, executable, false);
    if (result.failures.length) throw new Error(`installation checks failed: ${result.failures.join("; ")}`);
    if (await exists(destination)) throw new Error(`destination appeared during installation; preserving it: ${destination}`);
    await rename(stage, destination);
    stage = undefined;
    result.packageRoot = destination;
    result.candidate.source = join(destination, "integrations/archon");
    result.installation = "created";
    return result;
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true });
    await rm(lock, { recursive: true });
  }
}

function parse(args: string[]) {
  const [command, ...rest] = args;
  if (command !== "install" && command !== "check") throw new Error("use install or check; add --help for usage");
  const options: Record<string, string | boolean> = {};
  for (let index = 0; index < rest.length; index++) {
    const name = rest[index];
    if (name in options) throw new Error(`duplicate option: ${name}`);
    if (name === "--json" || (command === "check" && name === "--verify")) options[name] = true;
    else if (["--archon", ...(command === "install" ? ["--dest"] : ["--evidence"])].includes(name)) {
      const value = rest[++index];
      if (!value || !isAbsolute(value)) throw new Error(`${name} needs an absolute path`);
      options[name] = resolve(value);
    } else throw new Error(`unknown option: ${name}`);
  }
  if (typeof options["--archon"] !== "string") throw new Error("--archon /absolute/path/to/archon is required");
  if (command === "install" && typeof options["--dest"] !== "string") throw new Error("install requires --dest /absolute/parent");
  if (options["--evidence"] && !options["--verify"]) throw new Error("--evidence requires --verify");
  return { command, executable: options["--archon"], destination: options["--dest"] as string, verify: options["--verify"] === true, evidence: options["--evidence"] as string | undefined, json: options["--json"] === true };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("Usage: bun lifecycle.ts install --dest /absolute/parent --archon /absolute/executable [--json]\n       bun lifecycle.ts check --archon /absolute/executable [--verify [--evidence /absolute/empty-directory]] [--json]\n\nInstalls into <parent>/archon-foundation. Uses existing Bun, Git and pinned Archon.\nCheck is read-only for the package. Verification exercises deterministic failure/resume; the bounded live pilot requires separate explicit execution.");
  } else {
    try {
      const request = parse(args);
      const result = request.command === "install" ? await install(request.destination, request.executable) : await inspect(packageRoot, request.executable, request.verify, request.evidence);
      if (request.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`Archon foundation${result.installation ? ` ${result.installation}` : ""}: ${result.failures.length ? "checks failed" : "checks passed"}\nPackage: ${result.packageRoot}`);
        for (const [name, check] of Object.entries(result.checks)) console.log(`${name}: ${check.status} — ${check.detail}`);
        console.log("Live AI: bounded pilot available; provider configuration, authentication and execution are unverified by this check.");
        if (result.evidenceDirectory) console.log(`Evidence: ${result.evidenceDirectory}`);
        if (!result.failures.length && result.checks.execution.status === "not-requested") console.log("To verify execution, run the installed check command again with --verify.");
      }
      if (result.failures.length) process.exitCode = 1;
    } catch (error) {
      if (args.includes("--json")) console.log(JSON.stringify({ error: message(error), liveAI: "unknown" }));
      else console.error(message(error));
      process.exitCode = 1;
    }
  }
}
