import { createHash } from "node:crypto";

export type ModelRole = "build" | "review";
export type RoleRoute = Readonly<{ model: string; reasoning: string }>;
export type RoleSelection = Readonly<Record<ModelRole, RoleRoute>>;
type Capability = Readonly<{ model: string; efforts: readonly string[] }>;
export type RolePlan = Readonly<{ version: 1; provider: "openai"; roles: RoleSelection; catalog: Readonly<{ observedAt: string; selected: readonly Capability[] }>; fallback: "none" }>;
export type ObservedRoute = Readonly<{ model: string; reasoning: string; provider: "openai" }>;
const identifier = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value);
export const routingDigest = (plan: RolePlan): string => createHash("sha256").update(JSON.stringify(plan)).digest("hex");
export function validateRoleSelection(value: RoleSelection): RoleSelection {
  if (!value || Object.keys(value).sort().join() !== "build,review") throw new Error("routing requires exactly build and review roles");
  for (const route of Object.values(value)) if (!route || Object.keys(route).sort().join() !== "model,reasoning" || !identifier(route.model) || !identifier(route.reasoning)) throw new Error("invalid explicit model/reasoning pair");
  return Object.freeze({ build: Object.freeze({ ...value.build }), review: Object.freeze({ ...value.review }) });
}
export function parseRoleSelection(options: Readonly<Record<string, unknown>>): RoleSelection {
  const legacy = options["--model"] !== undefined || options["--reasoning"] !== undefined;
  if (legacy && ["builder", "reviewer"].some(role => options[`--${role}-model`] !== undefined || options[`--${role}-reasoning`] !== undefined)) throw new Error("legacy and per-role model options cannot be mixed");
  const pair = (prefix: string): RoleRoute => {
    const model = options[`${prefix}model`]; const reasoning = options[`${prefix}reasoning`];
    if (model === undefined && reasoning === undefined) return { model: "gpt-5.6-luna", reasoning: "xhigh" };
    if (!identifier(model) || !identifier(reasoning)) throw new Error("each selected model requires its explicit reasoning pair");
    return { model, reasoning };
  };
  return validateRoleSelection(legacy ? { build: pair("--"), review: pair("--") } : { build: pair("--builder-"), review: pair("--reviewer-") });
}
export class ModelCatalog {
  private readonly capabilities = new Map<string, Capability>();
  private readonly cursors = new Set<string>();
  private readonly ids = new Set<string>();
  private pages = 0;
  private complete = false;
  accept(value: any): string | null {
    if (this.complete || ++this.pages > 16 || !value || !Array.isArray(value.data) || value.data.length > 100 || !(value.nextCursor === null || (typeof value.nextCursor === "string" && value.nextCursor.length > 0 && value.nextCursor.length <= 2048))) throw new Error("invalid or incomplete model catalog page");
    for (const item of value.data) {
      if (!item || !identifier(item.id) || !identifier(item.model) || this.ids.has(item.id) || this.capabilities.has(item.model) || !Array.isArray(item.supportedReasoningEfforts) || !item.supportedReasoningEfforts.length || item.supportedReasoningEfforts.length > 32) throw new Error("invalid or ambiguous model catalog identity");
      const efforts = item.supportedReasoningEfforts.map((entry: any) => entry?.reasoningEffort);
      if (efforts.some((effort: unknown) => !identifier(effort)) || new Set(efforts).size !== efforts.length || !efforts.includes(item.defaultReasoningEffort)) throw new Error("invalid model catalog reasoning capabilities");
      this.ids.add(item.id); this.capabilities.set(item.model, { model: item.model, efforts: [...efforts].sort() });
    }
    if (value.nextCursor !== null) {
      if (!value.data.length || this.cursors.has(value.nextCursor) || this.pages === 16) throw new Error("model catalog pagination did not complete");
      this.cursors.add(value.nextCursor);
    } else this.complete = true;
    return value.nextCursor;
  }
  assert(route: RoleRoute): Capability {
    const capability = this.capabilities.get(route.model);
    if (!this.complete || !capability || !capability.efforts.includes(route.reasoning)) throw new Error(`unsupported model/reasoning selection: ${route.model}/${route.reasoning}`);
    return capability;
  }
  plan(selection: RoleSelection): RolePlan {
    const roles = validateRoleSelection(selection);
    const selected = [...new Map(Object.values(roles).map(route => { const capability = this.assert(route); return [capability.model, capability] as const; })).values()].sort((a, b) => a.model.localeCompare(b.model));
    return { version: 1, provider: "openai", roles, catalog: { observedAt: new Date().toISOString(), selected }, fallback: "none" };
  }
}
export function observeRoute(value: any, route: RoleRoute, effortField: "reasoningEffort" | "effort" = "reasoningEffort"): ObservedRoute {
  if (value?.model !== route.model || value?.modelProvider !== "openai" || value?.[effortField] !== route.reasoning) throw new Error("Codex effective model/provider/reasoning differs from the frozen role route");
  return { model: value.model, provider: value.modelProvider, reasoning: value[effortField] };
}
