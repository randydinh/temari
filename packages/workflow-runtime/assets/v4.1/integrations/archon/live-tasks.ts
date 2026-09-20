const chargeTask = `# Charge cost pilot\n\nImplement chargeCostCents(wattHours: number, rateCentsPerKwh: number): number in charge-cost.ts. Reject either argument unless finite and non-negative. Convert Wh to kWh, multiply by the rate, and round the total to the nearest integer cent with Math.round. Zero energy or rate yields zero. Preserve the exported signature. Only charge-cost.ts may change. The controller owns tests, workflow, Git and evidence. Do not add dependencies or tests.\n`;
const chargeInitial = "export function chargeCostCents(wattHours: number, rateCentsPerKwh: number): number { return 0; }\n";
const chargeTests = `import { expect, test } from "bun:test";
import { chargeCostCents } from "./charge-cost.ts";
test("charges by kWh with total cent rounding", () => {
  expect(chargeCostCents(1500, 40)).toBe(60);
  expect(chargeCostCents(125, 15)).toBe(2);
  expect(chargeCostCents(250, 10)).toBe(3);
  expect(chargeCostCents(0, 40)).toBe(0);
  expect(chargeCostCents(1500, 0)).toBe(0);
});
test("rejects invalid energy and rates", () => {
  for (const value of [-1, NaN, Infinity, -Infinity]) {
    expect(() => chargeCostCents(value, 40)).toThrow();
    expect(() => chargeCostCents(1000, value)).toThrow();
  }
});
`;
const documentationTask = `# Temari role routing guide\n\nCreate docs/archon-role-routing.md for Temari maintainers using this implementation. Your scratch output is the existing empty archon-role-routing.md. Read the controller-provided README.md, live.ts, live-routing.ts and live-permissions.ts references. Write an accurate 800–18000 character guide with a Markdown title. Explain default Luna xhigh roles, complete per-role pairs, legacy-pair migration, capability preflight, requested versus observed routing, independent permissions and no automatic fallback or upgrade. Include two fenced shell examples invoking bun /absolute/installed/integrations/archon/live.ts run with absolute root/planning/archon/codex paths: one with default roles and one with explicit builder high / reviewer xhigh Luna pairs. Explain preparation with --task temari-routing-doc --repository against a clean matching Temari checkout, preserved original planning provenance, summary.json, native-run.json, ARCHON_HOME, stopped-run inspection and the canonical review receipt. Explain macOS and Codex 0.154.0 scope, no automatic repair, and that catalog inspection does not prove model completion. Only docs/archon-role-routing.md may change. Do not claim tests or live results not supplied, do not change source/tests/dependencies, and do not invoke Git.\n`;
const documentationTests = String.raw`import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseRoleSelection } from "./live-routing.ts";
const document = readFileSync("archon-role-routing.md", "utf8");
test("guide is a bounded titled document", () => {
  expect(document.length).toBeGreaterThanOrEqual(800);
  expect(document.length).toBeLessThanOrEqual(18000);
  expect(document).toMatch(/^#\s+\S/m);
});
test("default and per-role examples parse with the shipped routing rules", () => {
  const commands = [...document.matchAll(/\x60{3}(?:sh|bash|shell)\n([\s\S]*?)\x60{3}/g)].flatMap(match => match[1]!.replaceAll(String.fromCharCode(92, 10), " ").replaceAll(String.fromCharCode(92, 13, 10), " ").split("\n")).filter(line => /^bun\s+\/\S*live\.ts\s+run\s/.test(line.trim()));
  const routes = commands.map(command => {
    const tokens = command.trim().split(/\s+/).slice(3); const options: Record<string, string> = {};
    const allowed = ["--root", "--planning", "--archon", "--codex", "--builder-model", "--builder-reasoning", "--reviewer-model", "--reviewer-reasoning", "--model", "--reasoning"];
    for (let index = 0; index < tokens.length; index += 2) {
      const name = tokens[index]!; const value = tokens[index + 1];
      if (!allowed.includes(name) || name in options || !value || value.startsWith("--")) throw new Error("invalid documented run option");
      options[name] = value;
    }
    for (const name of ["--root", "--planning", "--archon", "--codex"]) if (!options[name]?.startsWith("/")) throw new Error("documented run paths must be absolute");
    return { options, roles: parseRoleSelection(options) };
  });
  expect(routes.length).toBeGreaterThanOrEqual(2);
  expect(routes.some(item => !Object.keys(item.options).some(key => /model|reasoning/.test(key)) && item.roles.build.model === "gpt-5.6-luna" && item.roles.build.reasoning === "xhigh" && item.roles.review.reasoning === "xhigh")).toBe(true);
  expect(routes.some(item => item.roles.build.model === "gpt-5.6-luna" && item.roles.review.model === "gpt-5.6-luna" && item.roles.build.reasoning === "high" && item.roles.review.reasoning === "xhigh")).toBe(true);
});
test("guide covers authority evidence and recovery checkpoints", () => {
  for (const term of ["permissions", "planning", "summary.json", "native-run.json", "ARCHON_HOME", "receipt", "macOS", "0.154.0"]) expect(document).toContain(term);
});
`;
export type TaskId = "charge-cost" | "temari-routing-doc";
const actorTimeouts = { "charge-cost": 180_000, "temari-routing-doc": 600_000 } as const satisfies Readonly<Record<TaskId, number>>;
export function taskBudget(task: TaskId): Readonly<{ actorMs: number; stageMs: number; minimumCaptureMs: number }> {
  if (!Object.hasOwn(actorTimeouts, task)) throw new Error("unsupported closed pilot task budget");
  const actorMs = actorTimeouts[task];
  return { actorMs, stageMs: actorMs + 60_000, minimumCaptureMs: actorMs + 120_000 };
}

export function taskRecipe(id: TaskId) {
  if (id === "charge-cost") return { id, repositoryPath: "charge-cost.ts", actorFilename: "charge-cost.ts", testFilename: "charge-cost.test.ts", initial: chargeInitial, task: chargeTask, tests: chargeTests, references: [] as string[], expectedTests: 2, expectedAssertions: 13, commitMessage: "Implement bounded charge cost calculation" };
  if (id === "temari-routing-doc") return { id, repositoryPath: "docs/archon-role-routing.md", actorFilename: "archon-role-routing.md", testFilename: "archon-role-routing.test.ts", initial: "", task: documentationTask, tests: documentationTests, references: ["README.md", "live.ts", "live-routing.ts", "live-permissions.ts"], expectedTests: 3, expectedAssertions: 14, commitMessage: "Document explicit Archon builder and reviewer routing" };
  throw new Error("unsupported closed pilot task");
}
