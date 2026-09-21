import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelCatalog, observeRoute, parseRoleSelection, routingDigest } from "./live-routing.ts";
import { inspectRolePlan } from "./live-codex.ts";
const roots: string[] = [];
afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });
const capability = (model = "gpt-5.6-luna", efforts = ["high", "xhigh"]) => ({ id: model, model, defaultReasoningEffort: efforts[0], supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort })) });
test("role selection defaults independently and migrates only complete legacy pairs", () => {
  const defaults = parseRoleSelection({});
  expect(defaults.build).toEqual({ model: "gpt-5.6-luna", reasoning: "xhigh" });
  expect(defaults.review).toEqual(defaults.build);
  expect(parseRoleSelection({ "--reviewer-model": "review", "--reviewer-reasoning": "high" })).toEqual({ ...defaults, review: { model: "review", reasoning: "high" } });
  expect(parseRoleSelection({ "--model": "legacy", "--reasoning": "low" })).toEqual({ build: { model: "legacy", reasoning: "low" }, review: { model: "legacy", reasoning: "low" } });
  for (const options of [{ "--model": "missing" }, { "--builder-reasoning": "high" }, { "--reviewer-model": "bad/slug", "--reviewer-reasoning": "high" }, { "--model": "legacy", "--reasoning": "high", "--builder-model": "mixed" }]) expect(() => parseRoleSelection(options)).toThrow();
});
test("catalog validates complete pagination and every selected role", () => {
  const catalog = new ModelCatalog();
  expect(catalog.accept({ data: [capability()], nextCursor: "second" })).toBe("second");
  expect(() => catalog.plan(parseRoleSelection({}))).toThrow();
  catalog.accept({ data: [capability("reviewer", ["medium"])], nextCursor: null });
  const plan = catalog.plan(parseRoleSelection({ "--reviewer-model": "reviewer", "--reviewer-reasoning": "medium" }));
  expect(plan.catalog.selected.map(item => item.model)).toEqual(["gpt-5.6-luna", "reviewer"]);
  expect(() => catalog.plan(parseRoleSelection({ "--reviewer-model": "reviewer", "--reviewer-reasoning": "xhigh" }))).toThrow("unsupported");
  expect(routingDigest({ ...plan, roles: { ...plan.roles, build: { ...plan.roles.build, reasoning: "high" } } })).not.toBe(routingDigest(plan));
});
test("malformed and ambiguous catalogs fail closed", () => {
  for (const data of [{ data: [capability()] }, { data: [capability(), capability()], nextCursor: null }, { data: [{ ...capability(), supportedReasoningEfforts: [] }], nextCursor: null }, { data: [{ ...capability(), defaultReasoningEffort: "unsupported" }], nextCursor: null }, { data: [], nextCursor: "nonterminal" }]) expect(() => new ModelCatalog().accept(data)).toThrow();
  const catalog = new ModelCatalog(); catalog.accept({ data: [capability()], nextCursor: "repeat" });
  expect(() => catalog.accept({ data: [capability("other")], nextCursor: "repeat" })).toThrow("pagination");
});
test("effective routing requires native model provider and effort", () => {
  const route = parseRoleSelection({}).build;
  const observed = { model: route.model, modelProvider: "openai", reasoningEffort: route.reasoning };
  expect(observeRoute(observed, route)).toEqual({ ...route, provider: "openai" });
  for (const mutation of [{ model: "fallback" }, { modelProvider: "other" }, { reasoningEffort: "high" }, { reasoningEffort: null }]) expect(() => observeRoute({ ...observed, ...mutation }, route)).toThrow("effective");
});
test("unsupported reviewer is refused by metadata discovery without starting any actor", async () => {
  const root = await mkdtemp(join(tmpdir(), "temari-routing-test-")); roots.push(root);
  const executable = join(root, "codex"); const log = join(root, "calls.jsonl");
  await writeFile(executable, `#!${process.execPath}\nimport {appendFileSync} from "node:fs";import {createInterface} from "node:readline";for await(const line of createInterface({input:process.stdin})){const m=JSON.parse(line);appendFileSync(${JSON.stringify(log)},m.method+"\\n");if(m.id)console.log(JSON.stringify({id:m.id,result:m.method==="model/list"?${JSON.stringify({ data: [capability()], nextCursor: null })}:{}}));}`, { mode: 0o755 });
  await expect(inspectRolePlan(executable, root, parseRoleSelection({ "--reviewer-model": "unavailable", "--reviewer-reasoning": "high" }))).rejects.toThrow("unsupported");
  expect((await readFile(log, "utf8")).trim().split("\n")).toEqual(["initialize", "initialized", "model/list"]);
});
