import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { implementation } from "./pilot.ts";

const [stage, control] = process.argv.slice(2);
const output = process.env.TEMARI_OUTPUT_DIR;
if (!control || !output || stage !== process.env.TEMARI_STAGE) throw new Error("fixture requires a bridge stage environment");
const report = (name: string, contents: string) => writeFile(join(output, name), `Deterministic contract fixture; no AI agents or independent AI judgment.\nActor: ${process.env.TEMARI_ACTOR}\n\n${contents}\n`);
const diff = () => execFileSync("git", ["diff", "--", "charge-cost.ts"], { encoding: "utf8" });
if (stage === "build") {
  const countPath = join(control, "build-count");
  const count = Number(await readFile(countPath, "utf8").catch(() => "0")) + 1;
  await writeFile(countPath, String(count));
  if (!process.argv.includes("--broken-build")) await writeFile("charge-cost.ts", implementation);
  await report("build.md", `Bounded delegated implementation. Builder invocation ${count}.\n\n${diff()}`);
} else if (stage === "shape-final") {
  const history = await readFile(join(control, "initial-design.md"), "utf8");
  const source = await readFile("charge-cost.ts");
  await report("shape-final.md", `Explicit final-candidate reconciliation by the fixture coordinator.\nHistorical planning remains below, labeled as fixture data. No historical report has been re-stamped.\nCurrent source SHA-256: ${createHash("sha256").update(source).digest("hex")}\nThe cost function and its tests are the affected subsystem. The selected implementation follows the stated units and rounding. Blocking work: build then tests. Independent work: later review. Shared state: exclusive target checkout. Smallest unit: one cost function.\n\n${history}`);
} else if (stage === "verify") {
  const result = spawnSync(process.execPath, ["test", "charge-cost.test.ts"], { encoding: "utf8" });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.status !== 0) process.exit(result.status ?? 1);
  if (process.argv.includes("--fail-once")) {
    const flag = join(control, "verification-failed-once");
    try { await writeFile(flag, "Controlled transient verification checkpoint failed.\n", { flag: "wx" }); process.stderr.write("fixture transient verification checkpoint: fail once\n"); process.exit(23); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  await report("verification.md", `Actual target test command: bun test charge-cost.test.ts\nExit: ${result.status}\n${result.stdout}\n${result.stderr}`);
} else if (stage === "review") {
  const source = await readFile("charge-cost.ts", "utf8");
  if (source !== implementation) throw new Error("fixture reviewer rejected unexpected implementation");
  await report("review.md", `Scripted reviewer inspected the exact expected change. One bounded commit can contain the cost function. Input validation, unit conversion and cent rounding match the fixture plan. This is a fixture assertion, not a real independent code review.\n\n${diff()}`);
} else throw new Error(`unknown fixture stage ${stage}`);
process.stdout.write(`fixture ${stage} completed\n`);
