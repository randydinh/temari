import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { taskRecipe, type TaskId } from "./live-tasks.ts";
import type { Candidate } from "./bridge.ts";

export type PilotRole = "build" | "verify" | "review";
type FileIdentity = Readonly<{ path: string; sha256: string; size: number; mode: number }>;
export type ExecutionContract = Readonly<{
  version: 2; kind: "temari-fixed-pilot-execution"; task: TaskId; policy: typeof executionPolicy;
  root: string; baseline: Candidate; taskSha256: string;
  runtime: Readonly<{ codex: FileIdentity; bun: FileIdentity }>;
  inputs: readonly FileIdentity[]; configurationSha256: string;
  environment: Readonly<Record<string, string>>;
}>;
export type ExecutionObservation = Readonly<{
  role: PilotRole; contractSha256: string; identity: unknown; inputs: readonly FileIdentity[];
  configurationSha256: string; environmentSha256: string; profileSha256: string;
  toolPolicy: "local-task-tools-only";
}>;
export type AuthorizedLaunch = Readonly<{
  role: PilotRole; task: TaskId; executable: string; bun: string; cwd: string; context: string;
  profileArguments: readonly string[]; environment: Readonly<Record<string, string>>;
  observation: ExecutionObservation;
}>;
type Request = { role: "build"; identity: Candidate } | {
  role: "verify" | "review";
  identity: { candidate: Candidate; baselineHead: string; sourceSha256: string; testsSha256: string; planningSha256: string; diffSha256: string; executionSha256: string };
  source: Buffer; tests: Buffer; diff?: string; verification?: string;
};
const baseNames = ["task.md", "planning/manifest.json", "planning/how.md", "planning/design-a.md", "planning/design-b.md", "planning/selection.md", "planning/checkpoint.md", "feature.md"];
const commonNames = (task: TaskId) => [...baseNames, ...taskRecipe(task).references];
const disabled = ["js_repl", "apps", "hooks", "multi_agent", "multi_agent_v2", "plugins", "remote_plugin", "browser_use", "browser_use_external", "browser_use_full_cdp_access", "computer_use", "image_generation", "view_image", "memories", "skill_search", "skill_mcp_dependency_install", "shell_snapshot", "shell_snapshot_v2", "tool_suggest", "recommended_plugins", "workspace_dependencies", "code_mode", "goals", "artifact", "network_proxy", "request_permissions_tool", "shell_zsh_fork"];
const executionPolicy = {
  name: "task-scoped-native-v1", localProjectTrust: "trusted",
  // Codex 0.154.0 needs both glob forms to override minimal temp grants for listings and contents.
  filesystem: { ":root": "deny", ":minimal": "read", ":slash_tmp": "deny", ":tmpdir": "deny", "/tm[p]": "deny", "/private/tm[p]": "deny", "/var/tm[p]": "deny", "/private/var/tm[p]": "deny", "/tmp/**": "deny", "/private/tmp/**": "deny", "/var/tmp/**": "deny", "/private/var/tmp/**": "deny" }, networkEnabled: false,
  roles: { build: { context: "read", cwd: "write" }, verify: { context: "read", cwd: "read" }, review: { context: "read", cwd: "read" } },
  runtimeReads: ["codex", "bun"], verifierEnvironmentCommand: ["/usr/bin/env", "-i"], verifierCommand: ["test"],
  actorSettings: { approval_policy: "never", allow_login_shell: false, web_search: "disabled", project_doc_max_bytes: 0, agents: { max_depth: 0 }, suppress_unstable_features_warning: true, notify: [], features: { ...Object.fromEntries(disabled.map(name => [name, false])), code_mode_host: true, shell_tool: true, unified_exec: true, skip_host_skill_discovery: true } },

} as const;
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const same = isDeepStrictEqual;
export const executionDigest = (contract: ExecutionContract): string => hash(JSON.stringify(contract));
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
const empty = (value: unknown) => !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;
function fields(value: unknown, keys: string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== keys.sort().join()) throw new Error(`${label} has unsupported fields`);
}
async function fileIdentity(path: string, runtime = false): Promise<FileIdentity> {
  const info = await lstat(path);
  if (!info.isFile() || info.nlink !== 1 || (!runtime && info.size > 1024 * 1024) || await realpath(path) !== path) throw new Error("execution input must be a bounded regular single-link canonical file");
  return { path, sha256: hash(await readFile(path)), size: info.size, mode: info.mode & 0o777 };
}
async function assertFile(identity: FileIdentity, runtime = false) {
  if (!same(await fileIdentity(identity.path, runtime), identity)) throw new Error("execution input or runtime changed");
}
function validateContract(value: unknown): asserts value is ExecutionContract {
  fields(value, ["version", "kind", "task", "policy", "root", "baseline", "taskSha256", "runtime", "inputs", "configurationSha256", "environment"], "execution contract");
  if (value.version !== 2 || value.kind !== "temari-fixed-pilot-execution" || !same(value.policy, executionPolicy) || typeof value.root !== "string" || !isAbsolute(value.root)) throw new Error("invalid execution contract");
  const names = commonNames(value.task as TaskId);
  fields(value.baseline, ["head", "fingerprint"], "execution baseline");
  if (typeof value.baseline.head !== "string" || !/^[a-f0-9]{40,64}$/.test(value.baseline.head) || typeof value.baseline.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.baseline.fingerprint)) throw new Error("invalid execution baseline");
  for (const key of ["taskSha256", "configurationSha256"]) if (typeof value[key] !== "string" || !/^[a-f0-9]{64}$/.test(value[key])) throw new Error("invalid execution digest");
  fields(value.runtime, ["codex", "bun"], "execution runtime");
  if (!Array.isArray(value.inputs) || value.inputs.length !== names.length) throw new Error("invalid execution context");
  for (const item of [...Object.values(value.runtime), ...value.inputs]) {
    fields(item, ["path", "sha256", "size", "mode"], "execution file");
    if (typeof item.path !== "string" || !isAbsolute(item.path) || typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.size) || Number(item.size) < 0 || !Number.isInteger(item.mode) || Number(item.mode) < 0 || Number(item.mode) > 0o777) throw new Error("invalid execution file");
  }
  if (!same(value.inputs.map(item => item.path), names.map(name => join(value.root as string, "execution/common", name)))) throw new Error("execution context paths changed");
  if (!same(value.environment, environment(value.root))) throw new Error("execution environment changed");
  for (const item of Object.values(value.runtime) as FileIdentity[]) if (item.path === value.root || item.path.startsWith(`${value.root}${sep}`)) throw new Error("runtime overlaps task output");
}
function assertNativeLocations(root: string, runtimes: readonly string[]): void {
  if (process.platform !== "darwin") throw new Error("task-scoped-native-v1 requires verified macOS execution; other platforms are unsupported");
  for (const path of [root, ...runtimes]) if (["/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp"].some(base => path === base || path.startsWith(`${base}/`))) throw new Error("pilot root and runtime executables must be outside shared temporary directories; use the macOS per-user temporary directory or an owned normal directory");
}
function environment(root: string): Record<string, string> {
  return { BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: join(root, "execution/home"), TMPDIR: join(root, "execution/home"), LANG: "C.UTF-8", LC_ALL: "C.UTF-8", USER: "temari", LOGNAME: "temari", SHELL: "/bin/sh" };
}

export function configurationFacts(config: unknown, requirements: unknown, expectedSession?: Record<string, unknown>): { sha256: string; mcpServerNames: string[] } {
  if (!config || typeof config !== "object" || !Array.isArray((config as { layers?: unknown }).layers)) throw new Error("Codex configuration inspection did not return layers");
  fields(requirements, ["requirements"], "Codex requirements response");
  if (requirements.requirements !== null) throw new Error("managed Codex requirements need a separately verified compatible execution contract");
  const accepted: unknown[] = []; const mcpServerNames = new Set<string>(); let sessionSeen = false;
  const userKeys = ["model", "model_provider", "model_reasoning_effort", "service_tier", "notify", "sandbox_mode", "plugins", "projects", "marketplaces", "desktop", "features", "mcp_servers", "apps", "shell_environment_policy", "sandbox_workspace_write"];
  for (const layer of (config as { layers: any[] }).layers) {
    if (!layer || typeof layer !== "object" || !layer.name || typeof layer.name.type !== "string" || typeof layer.version !== "string") throw new Error("unsupported Codex configuration layer");
    if (layer.name.type === "sessionFlags") {
      if (!expectedSession || sessionSeen || !same(layer.config, expectedSession)) throw new Error("unexpected Codex session configuration");
      sessionSeen = true; continue;
    }
    if (layer.name.type === "user") {
      if (!layer.config || typeof layer.config !== "object" || Array.isArray(layer.config) || Object.keys(layer.config).some(key => !userKeys.includes(key))) throw new Error("unsupported Codex user configuration keys");
      if (layer.config.model_provider && layer.config.model_provider !== "openai") throw new Error("custom model provider requires a separately verified contract");
      if (Object.keys(layer.config.features ?? {}).some(key => ![...disabled, "code_mode_host", "shell_tool", "unified_exec", "skip_host_skill_discovery"].includes(key))) throw new Error("unsupported Codex user feature configuration");
      if (Object.keys(layer.config.shell_environment_policy ?? {}).some(key => key !== "set")) throw new Error("unsupported Codex user environment filters");
      for (const name of Object.keys(layer.config.mcp_servers ?? {})) {
        if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(name)) throw new Error("unsupported Codex MCP server name");
        mcpServerNames.add(name);
      }
    } else if (layer.name.type !== "system" || !empty(layer.config) || layer.disabledReason) throw new Error(`unsupported non-user Codex configuration layer: ${layer.name.type}`);
    accepted.push({ name: layer.name, version: layer.version, config: layer.config });
  }
  if (expectedSession && !sessionSeen) throw new Error("Codex did not report the required session configuration");
  return { sha256: hash(JSON.stringify(canonical({ layers: accepted, requirements: null }))), mcpServerNames: [...mcpServerNames].sort() };
}
export const configurationIdentity = (config: unknown, requirements: unknown): string => configurationFacts(config, requirements).sha256;
export function assertDisabledMcpInventory(value: unknown, configuredNames: readonly string[]): void {
  if (!value || typeof value !== "object" || !Array.isArray((value as any).data) || (value as any).nextCursor !== null) throw new Error("Codex actor MCP inventory is incomplete");
  const names = new Set<string>();
  for (const server of (value as any).data) {
    if (!server || !configuredNames.includes(server.name) || names.has(server.name) || server.runtimeStatus !== "disabled" || !empty(server.tools) || server.serverInfo !== null || server.toolsError !== null || !Array.isArray(server.resources) || server.resources.length || !Array.isArray(server.resourceTemplates) || server.resourceTemplates.length) throw new Error("Codex actor has unexpected or active MCP capabilities");
    names.add(server.name);
  }
}
export async function inspectPilotConfiguration(executable: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["app-server"], { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    let buffer = ""; let size = 0; let stderrSize = 0; let config: unknown; let finished = false;
    const finish = (error?: Error, digest?: string) => {
      if (finished) return;
      finished = true; clearTimeout(timer); child.kill("SIGKILL"); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      if (error) reject(error); else resolve(digest!);
    };
    const send = (id: number, method: string, params: unknown) => child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    const timer = setTimeout(() => finish(new Error("Codex configuration inspection timed out")), 15_000);
    child.on("error", () => finish(new Error("Codex configuration inspection could not start")));
    child.on("exit", () => { if (!finished) finish(new Error("Codex configuration inspection exited early")); });
    child.stdin.on("error", () => finish(new Error("Codex configuration inspection pipe failed")));
    child.stderr.on("data", (chunk: Buffer) => { stderrSize += chunk.length; if (stderrSize > 1024 * 1024) finish(new Error("Codex configuration diagnostics exceeded limit")); });
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length; buffer += chunk.toString("utf8");
      if (size > 4 * 1024 * 1024) return finish(new Error("Codex configuration inspection exceeded limit"));
      while (buffer.includes("\n") && !finished) {
        const index = buffer.indexOf("\n"); const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        try {
          const message = JSON.parse(line);
          if (message.error) throw new Error("Codex rejected configuration inspection");
          if (message.id === 1) { child.stdin.write('{"method":"initialized"}\n'); send(2, "config/read", { cwd, includeLayers: true }); }
          else if (message.id === 2) { config = message.result; send(3, "configRequirements/read", {}); }
          else if (message.id === 3) finish(undefined, configurationIdentity(config, message.result));
          else if (message.id !== undefined) throw new Error("unexpected Codex inspection response");
        } catch { finish(new Error("Codex configuration inspection refused unsupported or incompatible configuration")); }
      }
    });
    send(1, "initialize", { clientInfo: { name: "temari_execution", version: "1" }, capabilities: { experimentalApi: true } });
  });
}

export async function freezePilotExecution(input: { root: string; task?: TaskId; baseline: Candidate; taskSha256: string; codex: string; bun: string; playbook: string }): Promise<ExecutionContract> {
  if (await realpath(input.root) !== input.root) throw new Error("execution root must be canonical");
  const codex = await realpath(input.codex); const bun = await realpath(input.bun);
  assertNativeLocations(input.root, [codex, bun]);
  const directory = join(input.root, "execution"); await mkdir(directory); await mkdir(join(directory, "home")); await mkdir(join(directory, "common")); await mkdir(join(directory, "common/planning"));
  const task = input.task ?? "charge-cost";
  const inputs: FileIdentity[] = [];
  for (const name of commonNames(task)) {
    const source = name === "feature.md" ? input.playbook : name === "task.md" ? join(input.root, name) : taskRecipe(task).references.includes(name) ? join(input.root, "control/task", name) : join(input.root, "control", name);
    await fileIdentity(source);
    const destination = join(directory, "common", name);
    await writeFile(destination, await readFile(source), { flag: "wx", mode: 0o444 }); inputs.push(await fileIdentity(destination));
  }
  const contract: ExecutionContract = { version: 2, kind: "temari-fixed-pilot-execution", task, policy: structuredClone(executionPolicy), root: input.root, baseline: input.baseline, taskSha256: input.taskSha256, runtime: { codex: await fileIdentity(codex, true), bun: await fileIdentity(bun, true) }, inputs, configurationSha256: await inspectPilotConfiguration(input.codex, input.root), environment: environment(input.root) };
  validateContract(contract);
  if (contract.inputs[0]!.sha256 !== input.taskSha256) throw new Error("execution task identity mismatch");
  return contract;
}
async function directoryFiles(root: string, prefix = ""): Promise<string[]> {
  if (!(await lstat(join(root, prefix))).isDirectory() || await realpath(join(root, prefix)) !== join(root, prefix)) throw new Error("execution directory changed");
  const names: string[] = [];
  for (const name of (await readdir(join(root, prefix))).sort()) {
    const relative = prefix ? `${prefix}/${name}` : name;
    if ((await lstat(join(root, relative))).isDirectory()) names.push(...await directoryFiles(root, relative));
    else { await fileIdentity(join(root, relative)); names.push(relative); }
  }
  return names;
}
async function checkContract(contract: ExecutionContract) {
  validateContract(contract);
  assertNativeLocations(contract.root, Object.values(contract.runtime).map(file => file.path));
  if (await realpath(contract.root) !== contract.root || !same(await directoryFiles(join(contract.root, "execution/common")), commonNames(contract.task).sort())) throw new Error("execution context inventory changed");
  if ((await directoryFiles(join(contract.root, "execution/home"))).length) throw new Error("execution home inventory changed");
  for (const input of contract.inputs) await assertFile(input);
  for (const runtime of Object.values(contract.runtime)) await assertFile(runtime, true);
}
export async function authorizePilotExecution(contract: ExecutionContract, request: Request): Promise<AuthorizedLaunch> {
  await checkContract(contract);
  const recipe = taskRecipe(contract.task);
  const context = join(contract.root, "execution", `${request.role}-inputs`);
  const cwd = request.role === "build" ? join(contract.root, "builder-workspace") : context;
  const files: Record<string, Buffer> = {};
  if (request.role === "build") {
    if (!same(request.identity, contract.baseline)) throw new Error("builder execution baseline mismatch");
    if (!(await lstat(cwd)).isDirectory() || await realpath(cwd) !== cwd || !same(await directoryFiles(cwd), [recipe.actorFilename])) throw new Error("invalid builder execution workspace");
  } else {
    if (request.identity.executionSha256 !== executionDigest(contract) || request.identity.baselineHead !== contract.baseline.head || hash(request.source) !== request.identity.sourceSha256 || hash(request.tests) !== request.identity.testsSha256) throw new Error("execution candidate input identity mismatch");
    files[recipe.actorFilename] = request.source; files[recipe.testFilename] = request.tests;
    if (request.role === "review") {
      if (typeof request.diff !== "string" || hash(request.diff) !== request.identity.diffSha256 || typeof request.verification !== "string") throw new Error("review execution context mismatch");
      const verification = JSON.parse(request.verification);
      if (!same(verification.identity, request.identity) || verification.exitCode !== 0 || verification.execution?.contractSha256 !== executionDigest(contract)) throw new Error("review requires bound verification observation");
      files["commit-diff.txt"] = Buffer.from(request.diff); files["verification.json"] = Buffer.from(request.verification);
    }
  }
  for (const [index, name] of commonNames(contract.task).entries()) if (request.role !== "verify" || recipe.references.includes(name)) files[name] = await readFile(contract.inputs[index]!.path);
  try {
    await mkdir(context); if (request.role !== "verify") await mkdir(join(context, "planning"));
    for (const [name, bytes] of Object.entries(files)) await writeFile(join(context, name), bytes, { flag: "wx", mode: 0o444 });
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  if (!same(await directoryFiles(context), Object.keys(files).sort())) throw new Error("execution role context inventory changed");
  const inputs: FileIdentity[] = [];
  for (const [name, bytes] of Object.entries(files)) {
    const input = await fileIdentity(join(context, name));
    if (input.sha256 !== hash(bytes) || input.mode !== 0o444) throw new Error("execution role context changed");
    inputs.push(input);
  }
  const configurationSha256 = await inspectPilotConfiguration(contract.runtime.codex.path, cwd);
  if (configurationSha256 !== contract.configurationSha256) throw new Error("Codex configuration changed before execution");
  const profile = `temari_${request.role}`;
  const permissions: Record<string, string> = { ...contract.policy.filesystem, [context]: contract.policy.roles[request.role].context, [join(contract.root, "execution/home")]: "read", [cwd]: contract.policy.roles[request.role].cwd };
  for (const name of contract.policy.runtimeReads) permissions[contract.runtime[name].path] = "read";
  const filesystem = Object.entries(permissions).map(([path, access]) => `${JSON.stringify(path)}=${JSON.stringify(access)}`).join(",");
  const profileArguments = ["--permission-profile", profile, "-c", `permissions.${profile}.filesystem={${filesystem}}`, "-c", `permissions.${profile}.network.enabled=${contract.policy.networkEnabled}`];
  const observation: ExecutionObservation = { role: request.role, contractSha256: executionDigest(contract), identity: request.identity, inputs, configurationSha256, environmentSha256: hash(JSON.stringify(contract.environment)), profileSha256: hash(JSON.stringify(profileArguments)), toolPolicy: "local-task-tools-only" };
  return { role: request.role, task: contract.task, executable: contract.runtime.codex.path, bun: contract.runtime.bun.path, cwd, context, profileArguments, environment: contract.environment, observation };
}
export async function assertPilotExecution(contract: ExecutionContract, launch: AuthorizedLaunch): Promise<void> {
  await checkContract(contract);
  if (launch.task !== contract.task || launch.observation.contractSha256 !== executionDigest(contract) || !same(launch.environment, contract.environment) || hash(JSON.stringify(launch.profileArguments)) !== launch.observation.profileSha256) throw new Error("execution policy changed");
  if (!same(await directoryFiles(launch.context), launch.observation.inputs.map(input => input.path.slice(launch.context.length + 1)).sort())) throw new Error("execution role context inventory changed");
  for (const input of launch.observation.inputs) await assertFile(input);
  if (await inspectPilotConfiguration(contract.runtime.codex.path, launch.cwd) !== contract.configurationSha256) throw new Error("Codex configuration changed during execution");
}
export function actorConfiguration(launch: AuthorizedLaunch): Record<string, unknown> {
  if (launch.role === "verify") throw new Error("verifier cannot launch a model");
  const filesystem: Record<string, string> = { ...executionPolicy.filesystem, [launch.context]: "read", [launch.environment.HOME!]: "read", [launch.bun]: "read", [launch.executable]: "read", [launch.cwd]: executionPolicy.roles[launch.role].cwd };
  return { ...structuredClone(executionPolicy.actorSettings), projects: { [launch.cwd]: { trust_level: executionPolicy.localProjectTrust } }, shell_environment_policy: { inherit: "none", include_only: Object.keys(launch.environment), exclude: [], set: launch.environment }, permissions: { [launch.profileArguments[1]!]: { filesystem, network: { enabled: false } } } };
}
function toml(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(toml).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}=${toml(item)}`).join(",")}}`;
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  throw new Error("unsupported native configuration value");
}
export function actorPermissionArguments(launch: AuthorizedLaunch): string[] {
  return Object.entries(actorConfiguration(launch)).flatMap(([key, value]) => ["-c", `${key}=${toml(value)}`]);
}
export function verifierArguments(launch: AuthorizedLaunch): string[] {
  if (launch.role !== "verify") throw new Error("only verifier can launch protected tests");
  return ["sandbox", "--include-managed-config", ...launch.profileArguments, "--cd", launch.cwd, "--", ...executionPolicy.verifierEnvironmentCommand, ...Object.entries(launch.environment).map(([key, value]) => `${key}=${value}`), launch.bun, ...executionPolicy.verifierCommand, taskRecipe(launch.task).testFilename];
}
