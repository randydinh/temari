import { execFileSync } from "node:child_process";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BridgeRequest, PilotSpec } from "../bridge.ts";

export const implementation = `export function chargeCostCents(wattHours: number, rateCentsPerKwh: number): number {
  if (![wattHours, rateCentsPerKwh].every(value => Number.isFinite(value) && value >= 0)) {
    throw new Error("energy and rate must be finite and non-negative");
  }
  return Math.round(wattHours * rateCentsPerKwh / 1000);
}
`;

export async function createPilot(root: string, options: { failOnce?: boolean; brokenBuild?: boolean } = {}): Promise<BridgeRequest> {
  const repositoryRoot = join(root, "target");
  const control = join(root, "control");
  await mkdir(repositoryRoot, { recursive: true });
  await mkdir(control, { recursive: true });
  await mkdir(join(repositoryRoot, ".archon", "workflows"), { recursive: true });
  await copyFile(fileURLToPath(new URL("../.archon/workflows/temari-pilot.yaml", import.meta.url)), join(repositoryRoot, ".archon", "workflows", "temari-pilot.yaml"));
  await writeFile(join(repositoryRoot, "charge-cost.ts"), "export function chargeCostCents(wattHours: number, rateCentsPerKwh: number): number { return 0; }\n");
  await writeFile(join(repositoryRoot, "charge-cost.test.ts"), `import { expect, test } from "bun:test";
import { chargeCostCents } from "./charge-cost.ts";
test("charges by kWh with cent rounding", () => {
  expect(chargeCostCents(1500, 40)).toBe(60);
  expect(chargeCostCents(125, 15)).toBe(2);
  expect(chargeCostCents(0, 40)).toBe(0);
});
test("rejects invalid readings and rates", () => {
  for (const value of [-1, NaN, Infinity]) {
    expect(() => chargeCostCents(value, 40)).toThrow();
    expect(() => chargeCostCents(1000, value)).toThrow();
  }
});
`);
  await writeFile(join(control, "initial-design.md"), "# Deterministic contract fixture\n\nThis historical fixture plan is not AI architecture work. Implement chargeCostCents with finite non-negative arguments and integer cent rounding. The builder owns the target edit; coordinator verifies actual Bun tests; a distinct scripted reviewer checks the diff. Only the builder may edit the target.\n");
  const git = (...args: string[]) => execFileSync("git", ["-C", repositoryRoot, ...args], { stdio: "pipe" });
  git("init", "-b", "main");
  git("add", ".");
  git("-c", "user.name=Temari fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Add deterministic harness fixture");
  const actor = fileURLToPath(new URL("./stage.ts", import.meta.url));
  const command = (id: string) => ({ executable: process.execPath, args: [actor, id, control, ...(id === "verify" && options.failOnce ? ["--fail-once"] : []), ...(id === "build" && options.brokenBuild ? ["--broken-build"] : [])], timeoutMs: 30_000 });
  const spec: PilotSpec = {
    version: 1,
    profilePath: fileURLToPath(new URL("../../../skills/poteto-mode/playbook-contracts/v1/feature.json", import.meta.url)),
    coordinator: "fixture-coordinator",
    assignments: { shape: "fixture-coordinator", build: "fixture-builder", verify: "fixture-coordinator", review: "fixture-reviewer", delivery: "fixture-coordinator" },
    stages: {
      build: { actor: "fixture-builder", command: command("build"), evidence: [{ requirementId: "feature.build.delegated-implementation", kind: "diff", artifact: "build.md" }] },
      "shape-final": { actor: "fixture-coordinator", command: command("shape-final"), evidence: [
        { requirementId: "feature.shape.how", kind: "document", artifact: "shape-final.md" },
        { requirementId: "feature.shape.parallel-design", kind: "document", artifact: "shape-final.md" },
        { requirementId: "feature.shape.throughput-checkpoint", kind: "document", artifact: "shape-final.md" },
      ] },
      verify: { actor: "fixture-coordinator", command: command("verify"), evidence: [{ requirementId: "feature.verify.matching-surface", kind: "command", artifact: "verification.md" }] },
      review: { actor: "fixture-reviewer", command: command("review"), evidence: [{ requirementId: "feature.review.ordered-commits", kind: "review", artifact: "review.md" }] },
    },
  };
  const specPath = join(root, "pilot-spec.json");
  await writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`);
  return { repositoryRoot, artifactsDirectory: join(root, "artifacts"), specPath, archonRunId: "fixture-run" };
}

if (import.meta.main) {
  if (!process.argv[2]) throw new Error("usage: bun fixtures/pilot.ts /absolute/empty-directory [--fail-once]");
  process.stdout.write(`${JSON.stringify(await createPilot(resolve(process.argv[2]), { failOnce: process.argv.includes("--fail-once") }), null, 2)}\n`);
}
