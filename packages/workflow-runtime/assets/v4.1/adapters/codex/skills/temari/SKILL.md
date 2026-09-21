---
name: temari
description: Use Temari as the conversational engineering entry point on Codex. Applies the Codex host mapping, then the provider-neutral Temari skill.
---

# Temari on Codex

1. Resolve the package root from the first valid location: `../../package` in the Codex plugin bundle; three levels above `adapters/codex/skills/temari` in a source checkout; or the `pstack-root` file next to the installed skill directories. Resolve a relative pointer from the directory containing `pstack-root`.
2. Read `adapters/codex/HOST.md` from that package root and apply it to every package skill and delegated worker.
3. Read `skills/temari/SKILL.md` from that package root.
4. When Temari routes engineering work to poteto-mode, keep applying the same host mapping to the selected playbook and leaf skills.
5. When poteto-mode selects `lightweight-engineering` or `feature`, use the matching profile under `skills/poteto-mode/playbook-contracts/v1/`. Before editing, start the run with `skills/poteto-mode/scripts/workflow/workflow.ts` below the repository's `.temari/runs/` directory. A lightweight run records every requirement against the final repository state, checks the `final` boundary, and writes that receipt. A Feature run assigns implementation and review to distinct delegated workers, records every requirement through `feature.review.ordered-commits` against the final repository state, checks the `review` boundary, and writes that receipt. A final response is blocked while the route-specific check fails or `receipt.json` is absent.
6. Keep workflow evidence outside the product tree before ingestion. The workflow tool copies it into the ignored run directory and binds it to the current Git revision and worktree fingerprint. Keep the separate product check in the final response. Do not claim that the procedural receipt proves the product result.
7. Keep missing Cursor-only facilities explicit and claims proportional to executed evidence.

The package skills do not override the user, host policies, or repository instructions.
