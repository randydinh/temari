# Poteto-mode playbooks

Poteto-mode playbooks are the markdown recipes `/poteto-mode` matches and copies into the todo list. Users reach them by typing `/poteto-mode` plus a goal; the catalog this harness can prove is the playbook directory plus the index in `skills/poteto-mode/SKILL.md`.

## Sub-features

- `playbook-files` lists every `skills/poteto-mode/playbooks/*.md` file.
- `playbook-index` lists every `playbooks/<slug>.md` link in `skills/poteto-mode/SKILL.md`.
- `playbook-coverage` requires those two sets to match (`coverage=exact`).
- `playbook-core` requires Lightweight engineering, Investigation, Bug fix, Feature, Refactoring, Babysit, Shipping, Orchestrate, and Opening a PR to be present.

## How to get to it (user POV)

- In a supported host, invoke `/poteto-mode` with a goal. The skill matches one of the playbooks listed under **Playbooks** in `skills/poteto-mode/SKILL.md`.
- Open a playbook file directly, for example `skills/poteto-mode/playbooks/feature.md` or `playbooks/babysit.md`.
- From the guide, read `docs/guide/02-poteto-mode.md` and follow a linked playbook.

## Driving it with control-temari

Preconditions:

- The checkout includes `skills/poteto-mode/SKILL.md` and `skills/poteto-mode/playbooks/`.
- `control-temari doctor` reports `healthy=yes`. Catalog inspection does not need an orch store, but launch is still the supported way to bind evidence to a run-id.

- **List files and links.** Ask the catalog for coverage. Run `control-temari capture 01-playbooks -- playbooks`. Exit 0. Stdout contains `coverage=exact`, `playbook_files:`, and `linked_from_poteto_mode:`.
- **Core slugs.** From that stdout, require these file slugs: `lightweight-engineering`, `investigation`, `bug-fix`, `feature`, `refactoring`, `babysit`, `shipping`, `orchestrate`, `opening-a-pr`, `eval`, `authoring-a-skill`. The live tree this map was written against also includes `autonomous-run`, `autopilot-full`, `autopilot-stack`, `hillclimb`, `multi-phase-plan`, `pause-safely`, `perf-issue`, `prototype`, `runtime-forensics`, `session-pickup`, `trace-forensics`, `visual-parity`, and `worktree-cleanup` (24 files).
- **Open one playbook.** Read `skills/poteto-mode/playbooks/orchestrate.md` the way a coordinator would. Confirm it tells the user to run `bun scripts/orch/orch.ts` / `orch` and names `units.tsv` and `status.md`. This is the user-facing contract the orch feature then drives.
- **Proof.** Keep `01-playbooks.stdout.txt`. Re-run `control-temari playbooks` and require `coverage=exact` still. A missing file or a SKILL.md link to a deleted slug is drift, not a pass.

## Gotchas

- Live `/poteto-mode` matching happens inside a host chat. This harness cannot type the slash command. Report that entry point as `verified-unreachable` unless the current host actually ran `/poteto-mode`. Do not claim routing was proven because the markdown files exist.
- `docs/guide/02-poteto-mode.md` does not hard-code a playbook count; it points at the playbook directory for the full set. Assert the directory and SKILL.md (`coverage=exact`), not a remembered count.
- Opening a PR is invoked at the end of other playbooks. Finding `opening-a-pr.md` does not prove a PR was opened.
- Do not skip `playbooks` because `plugin-catalog` already printed a playbook list. Catalog count and SKILL.md link coverage are different checks.
