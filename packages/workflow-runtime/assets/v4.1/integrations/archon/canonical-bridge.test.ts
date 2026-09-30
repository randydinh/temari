import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CANONICAL_STAGES, captureCanonicalStage, verifyCanonicalCaptures } from "./canonical-bridge.ts";

const roots: string[] = [];
afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "temari-canonical-bridge-"));
  roots.push(root);
  const repositoryRoot = join(root, "repo");
  const artifactsDirectory = join(root, "artifacts");
  await mkdir(repositoryRoot);
  await writeFile(join(repositoryRoot, "tracked.txt"), "stable\n");
  execFileSync("git", ["-C", repositoryRoot, "init", "-q"]);
  execFileSync("git", ["-C", repositoryRoot, "add", "tracked.txt"]);
  execFileSync("git", ["-C", repositoryRoot, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "initial"]);
  const plan = { version: 1, workType: "feature", stages: CANONICAL_STAGES, delegation: "none", review: "self", evidence: "minimal", delivery: "local", requiredCapabilities: [] };
  const specPath = join(root, "spec.json");
  const spec = {
    schema: 1, runId: "temari-run-1", revision: "revision-1", repositoryRoot, plan,
    stages: Object.fromEntries(CANONICAL_STAGES.map((stage) => [stage, {
      executable: process.execPath,
      args: ["-e", "process.stdout.write(process.env.TEMARI_STAGE + '\\n')"],
      timeoutMs: 3000,
      summary: `${stage} complete`,
    }])),
  };
  await writeFile(specPath, JSON.stringify(spec));
  return { root, repositoryRoot, artifactsDirectory, specPath, spec,
    request: { specPath, artifactsDirectory, nativeRunId: "native-run-1" } };
}

test("seals six ordered captures and reuses an unchanged stage", async () => {
  const f = await fixture();
  await expect(captureCanonicalStage(f.request, "plan")).rejects.toThrow("investigate has no completed capture");
  const first = await captureCanonicalStage(f.request, "investigate");
  expect(await captureCanonicalStage(f.request, "investigate")).toEqual(first);
  for (const stage of CANONICAL_STAGES.slice(1)) await captureCanonicalStage(f.request, stage);
  const verified = await verifyCanonicalCaptures(f.request);
  expect(verified.binding.nativeRunId).toBe("native-run-1");
  expect(verified.stages.map((stage) => stage.stage)).toEqual(CANONICAL_STAGES);
  expect(Buffer.from(verified.stages[2]!.stdoutBase64, "base64").toString()).toBe("build\n");
});

test("changed spec, sealed bytes, and checkout fail closed", async () => {
  const f = await fixture();
  for (const stage of CANONICAL_STAGES) await captureCanonicalStage(f.request, stage);
  await writeFile(f.specPath, `${await readFile(f.specPath, "utf8")}\n`);
  await expect(verifyCanonicalCaptures(f.request)).rejects.toThrow("binding or checkout changed");
  await writeFile(f.specPath, JSON.stringify(f.spec));
  const pointer = JSON.parse(await readFile(join(f.artifactsDirectory, "temari-nx-canonical", "stages", "build.json"), "utf8"));
  await writeFile(join(f.artifactsDirectory, "temari-nx-canonical", "attempts", pointer.attempt, "stdout.bin"), "changed");
  await expect(verifyCanonicalCaptures(f.request)).rejects.toThrow("sealed build output changed");
  await writeFile(join(f.repositoryRoot, "tracked.txt"), "changed\n");
  await expect(verifyCanonicalCaptures(f.request)).rejects.toThrow("binding or checkout changed");
});
