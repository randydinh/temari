import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { actorPermissionArguments, actorConfiguration, configurationFacts, assertDisabledMcpInventory, type AuthorizedLaunch } from "./live-permissions.ts";

import { taskBudget, type TaskId } from "./live-tasks.ts";
import { ModelCatalog, observeRoute, type RoleSelection, type RolePlan, type ObservedRoute } from "./live-routing.ts";

export type CodexResult = { threadId: string; turnId: string; observed: ObservedRoute; final: unknown; finalText: string };
type Request = { launch: AuthorizedLaunch; executable: string; cwd: string; model: string; reasoning: string; role: "build" | "review"; prompt: string; schema: string; lastMessage: string };
const outputLimits = { stdout: 8 * 1024 * 1024, stderr: 1024 * 1024, event: 512 * 1024, final: 64 * 1024 };

export function codexLimits(task: TaskId) { return { ...outputLimits, timeoutMs: taskBudget(task).actorMs }; }

export function codexArguments(request: Request): string[] {
  if (request.role !== request.launch.role || request.executable !== request.launch.executable || request.cwd !== request.launch.cwd) throw new Error("Codex request does not match authorized execution");
  return ["app-server", "--strict-config", ...actorPermissionArguments(request.launch)];
}

export async function executeCodex(request: Request, testLimits?: Partial<ReturnType<typeof codexLimits>>): Promise<CodexResult> {
  const limits = codexLimits(request.launch.task);
  const bound = { ...limits, ...testLimits, timeoutMs: Math.min(limits.timeoutMs, testLimits?.timeoutMs ?? limits.timeoutMs) };
  const args = codexArguments(request);
  const sessionConfiguration = actorConfiguration(request.launch);
  const outputSchema = JSON.parse(await readFile(request.schema, "utf8"));
  const profile = request.launch.profileArguments[1]!;
  process.stderr.write(`${JSON.stringify({ kind: "codex-invocation", executable: request.executable, args, role: request.role, task: request.launch.task, timeoutMs: bound.timeoutMs, permissions: profile })}\n`);
  const result = await new Promise<CodexResult>((resolve, reject) => {
    const child = spawn(request.executable, args, { cwd: request.cwd, stdio: ["pipe", "pipe", "pipe"], detached: false, env: process.env });
    let finished = false; let buffer = ""; let stdoutBytes = 0; let stderrBytes = 0;
    const catalog = new ModelCatalog(); let observed: ObservedRoute;
    let threadId = ""; let turnId = ""; let started = false; let completed = false;
    const pendingItems = new Set<string>();
    let configuration: unknown; let configuredMcpServers: string[] = []; let finalText = ""; let finalResult: CodexResult | undefined;
    let pending = 1; let sequence: Promise<void> = Promise.resolve();
    const decoder = new StringDecoder("utf8");
    const finish = (error?: Error) => {
      if (finished) return; finished = true; clearTimeout(timer);
      process.off("SIGTERM", interrupted); process.off("SIGINT", interrupted);
      child.kill("SIGKILL"); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      if (error || !finalResult) reject(error ?? new Error("Codex ended without a terminal result")); else resolve(finalResult);
    };
    const send = (id: number, method: string, params: unknown) => { pending = id; child.stdin.write(`${JSON.stringify({ id, method, params })}\n`); };
    const interrupted = () => finish(new Error("Codex invocation interrupted"));
    process.on("SIGTERM", interrupted); process.on("SIGINT", interrupted);
    const timer = setTimeout(() => finish(new Error("Codex invocation timed out")), bound.timeoutMs);
    const handle = async (message: any) => {
      if (finished) return;
      if (message.id !== undefined) {
        if (message.method || message.id !== pending || message.error || !Object.hasOwn(message, "result")) throw new Error("Codex returned an unexpected request or failed RPC");
        const response = message.result;
        if (message.id === 1) { child.stdin.write('{"method":"initialized"}\n'); send(2, "config/read", { cwd: request.cwd, includeLayers: true }); }
        else if (message.id === 2 || message.id === 7) { configuration = response; send(message.id === 2 ? 3 : 8, "configRequirements/read", {}); }
        else if (message.id === 3 || message.id === 8) {
          const facts = configurationFacts(configuration, response, sessionConfiguration);
          if (facts.sha256 !== request.launch.observation.configurationSha256) throw new Error("Codex configuration changed in actor process");
          if (message.id === 8) { finish(); return; }
          configuredMcpServers = facts.mcpServerNames;
          send(9, "model/list", { limit: 100, includeHidden: true });
        } else if (message.id === 9) {
          const cursor = catalog.accept(response);
          if (cursor !== null) { send(9, "model/list", { limit: 100, includeHidden: true, cursor }); return; }
          catalog.assert(request);
          const mcp_servers = Object.fromEntries(configuredMcpServers.map(name => [name, { enabled: false }]));
          send(4, "thread/start", { cwd: request.cwd, model: request.model, modelProvider: "openai", ephemeral: true, approvalPolicy: "never", permissions: profile, runtimeWorkspaceRoots: [request.cwd], dynamicTools: [], config: { mcp_servers, model_reasoning_effort: request.reasoning } });
        } else if (message.id === 4) {
          if (response.activePermissionProfile?.id !== profile || response.activePermissionProfile?.extends !== null || response.approvalPolicy !== "never" || response.cwd !== request.cwd || response.model !== request.model || response.modelProvider !== "openai" || typeof response.thread?.id !== "string" || !/^[a-zA-Z0-9-]{1,128}$/.test(response.thread.id)) throw new Error("Codex did not activate the exact actor profile/model");
          observed = observeRoute(response, request);
          threadId = response.thread.id;
          process.stdout.write(`${JSON.stringify({ kind: "actor-started", threadId, observed, permissions: response.activePermissionProfile, instructionSources: response.instructionSources ?? [] })}\n`);
          send(5, "mcpServerStatus/list", { threadId, detail: "full", limit: 100 });
        } else if (message.id === 5) {
          assertDisabledMcpInventory(response, configuredMcpServers);
          send(6, "turn/start", { threadId, model: request.model, effort: request.reasoning, permissions: profile, approvalPolicy: "never", input: [{ type: "text", text: request.prompt }], outputSchema });
        } else if (message.id === 6) {
          if (!response.turn || typeof response.turn.id !== "string" || (turnId && turnId !== response.turn.id)) throw new Error("Codex returned an invalid turn identity");
          turnId = response.turn.id;
        } else throw new Error("unknown Codex response");
        return;
      }
      if (typeof message.method !== "string" || !message.params || typeof message.params !== "object") throw new Error("invalid Codex notification");
      const params = message.params;
      if (message.method === "model/rerouted") throw new Error("Codex model reroute is forbidden");
      if (message.method === "thread/settings/updated") {
        if (!threadId || params.threadId !== threadId) throw new Error("Codex routing settings belong to another thread");
        observeRoute(params.threadSettings, request, "effort");
      }
      if (message.method === "error") throw new Error("Codex reported failure");
      if (["item/commandExecution/outputDelta", "item/fileChange/outputDelta"].includes(message.method)) {
        if (!started || completed || params.threadId !== threadId || params.turnId !== turnId) throw new Error("Codex output belongs to another actor turn");
        process.stdout.write(`${JSON.stringify(message)}\n`);
      }
      if (["turn/started", "turn/completed", "item/started", "item/completed"].includes(message.method)) {
        if (params.threadId !== threadId || (params.turnId && turnId && params.turnId !== turnId)) throw new Error("Codex event belongs to another actor turn");
        if (completed) throw new Error("Codex event after completed turn");
        process.stdout.write(`${JSON.stringify(message)}\n`);
      }
      if (message.method === "item/started") {
        if (!started || typeof params.item?.id !== "string" || pendingItems.has(params.item.id)) throw new Error("Codex returned an invalid or duplicate pending item");
        pendingItems.add(params.item.id);
      }
      if (message.method === "turn/started") {
        if (started || typeof params.turn?.id !== "string" || (turnId && turnId !== params.turn.id)) throw new Error("invalid or duplicate Codex turn");
        turnId = params.turn.id; started = true;
      } else if (message.method === "item/completed") {
        if (typeof params.item?.id === "string") pendingItems.delete(params.item.id);
        if (!started || (params.item?.status === "failed" && params.item?.type !== "commandExecution") || params.item?.type === "error") throw new Error("Codex item failed or preceded its turn");
        if (params.item?.type === "agentMessage") {
          if (typeof params.item.text !== "string") throw new Error("invalid Codex reply");
          finalText = params.item.text;
        }
      } else if (message.method === "turn/completed") {
        if (!started || pendingItems.size || params.turn?.id !== turnId || params.turn.status !== "completed" || params.turn.error || !Array.isArray(params.turn.items)) throw new Error("Codex turn did not complete successfully");
        const terminal = params.turn.items.at(-1);
        if (terminal?.type !== "agentMessage" || typeof terminal.text !== "string" || !terminal.text.trim() || (finalText && terminal.text !== finalText) || Buffer.byteLength(terminal.text) > bound.final) throw new Error("Codex completed without its terminal structured reply");
        completed = true; finalText = terminal.text;
        finalResult = { threadId, turnId, observed, finalText, final: JSON.parse(finalText) };
        send(7, "config/read", { cwd: request.cwd, includeLayers: true });
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length; buffer += decoder.write(chunk);
      if (stdoutBytes > bound.stdout) return finish(new Error("Codex stdout overflow"));
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n"); const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        if (Buffer.byteLength(line) > bound.event) return finish(new Error("Codex event overflow"));
        sequence = sequence.then(async () => {
          if (finished) return;
          let message: unknown;
          try { message = JSON.parse(line); } catch { throw new Error("invalid Codex protocol JSON"); }
          await handle(message);
        }).catch(error => finish(error instanceof Error ? error : new Error("invalid Codex protocol")));
      }
      if (Buffer.byteLength(buffer) > bound.event) finish(new Error("Codex event overflow"));
    });
    child.stderr.on("data", (chunk: Buffer) => { process.stderr.write(chunk.subarray(0, Math.max(0, bound.stderr - stderrBytes))); stderrBytes += chunk.length; if (stderrBytes > bound.stderr) finish(new Error("Codex stderr overflow")); });
    child.on("error", error => finish(error));
    child.on("exit", (code, signal) => { if (!finished) finish(new Error(`Codex exited ${code}, signal ${signal} before terminal confirmation`)); });
    child.stdin.on("error", () => finish(new Error("Codex request pipe failed")));
    send(1, "initialize", { clientInfo: { name: "temari_actor", version: "1" }, capabilities: { experimentalApi: true } });
  });
  await writeFile(request.lastMessage, result.finalText, { flag: "wx" });
  process.stderr.write(`${JSON.stringify({ kind: "codex-last-message", text: result.finalText })}\n`);
  return result;
}

export async function inspectRolePlan(executable: string, cwd: string, selection: RoleSelection): Promise<RolePlan> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["app-server"], { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    const catalog = new ModelCatalog(); const decoder = new StringDecoder("utf8");
    let buffer = ""; let size = 0; let diagnostics = 0; let pending = 1; let finished = false;
    const finish = (error?: Error, plan?: RolePlan) => {
      if (finished) return; finished = true; clearTimeout(timer);
      child.kill("SIGKILL"); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      if (error) reject(error); else resolve(plan!);
    };
    const send = (id: number, method: string, params: unknown) => { pending = id; child.stdin.write(`${JSON.stringify({ id, method, params })}\n`); };
    const timer = setTimeout(() => finish(new Error("Codex model discovery timed out")), 20_000);
    child.on("error", error => finish(error));
    child.on("exit", () => { if (!finished) finish(new Error("Codex model discovery exited early")); });
    child.stdin.on("error", () => finish(new Error("Codex model discovery pipe failed")));
    child.stderr.on("data", (chunk: Buffer) => { diagnostics += chunk.length; if (diagnostics > 1024 * 1024) finish(new Error("Codex model discovery diagnostics exceeded limit")); });
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length; buffer += decoder.write(chunk);
      if (size > 4 * 1024 * 1024) return finish(new Error("Codex model discovery exceeded limit"));
      while (buffer.includes("\n") && !finished) {
        const index = buffer.indexOf("\n"); const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        try {
          if (Buffer.byteLength(line) > 512 * 1024) throw new Error("Codex model catalog event exceeded limit");
          const message = JSON.parse(line);
          if (message.id === undefined && typeof message.method === "string" && message.method !== "error") continue;
          if (message.method || message.id !== pending || message.error || !Object.hasOwn(message, "result")) throw new Error("unexpected Codex model discovery response");
          if (pending === 1) { child.stdin.write('{"method":"initialized"}\n'); send(2, "model/list", { limit: 100, includeHidden: true }); }
          else { const cursor = catalog.accept(message.result); if (cursor === null) finish(undefined, catalog.plan(selection)); else send(++pending, "model/list", { limit: 100, includeHidden: true, cursor }); }
        } catch (error) { finish(error instanceof Error ? error : new Error("invalid Codex model discovery")); }
      }
      if (Buffer.byteLength(buffer) > 512 * 1024) finish(new Error("Codex model catalog event exceeded limit"));
    });
    send(1, "initialize", { clientInfo: { name: "temari_routing", version: "1" }, capabilities: { experimentalApi: true } });
  });
}
