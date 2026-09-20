# Closeout

Closeout is the explicit durable task exit. A user invokes `/closeout` or asks to persist and archive the current task. Temari then runs a guarded sequence: establish the boundary, persist knowledge, prove the result, persist the work, and archive last.

## Sub-features

- `closeout-catalog` lists `closeout` among the `skills/*/SKILL.md` names `plugin-catalog` would load.
- `closeout-package` requires package-root `skills/closeout/SKILL.md` (the provider-neutral sequence; `disable-model-invocation` is true).
- `closeout-public-entries` requires the three public host stubs `adapters/codex/skills/closeout/SKILL.md`, `adapters/claude-code/skills/closeout/SKILL.md`, and `adapters/generic/skills/closeout/SKILL.md`.
- `closeout-install` is one of `scripts/install-host.sh` `ENTRY_SKILLS` (`temari`, `poteto-mode`, `closeout`).
- `closeout-cursor` is plugin-native: Cursor has no `adapters/cursor/skills/closeout/` stub; `adapters/cursor/HOST.md` maps `/closeout` to the packaged skill.
- `closeout-pause` reroutes incomplete work to `playbooks/pause-safely.md` instead of archiving.

## How to get to it (user POV)

- Type `/closeout`, or ask to persist the current task and archive it.
- On Claude Code, Codex, or a generic host, invoke the installed `closeout` entry after `scripts/install-host.sh`.
- From poteto-mode, an explicit `/closeout` is classified to the packaged closeout skill. A pause or incomplete handoff still routes to `playbooks/pause-safely.md`.

## Driving it with control-temari

Preconditions:

- The git checkout is the revision under test.
- `control-temari doctor` reports `healthy=yes`.
- Catalog inspection is read-only. No orch store mutation is required.
- Do not archive, push, or commit as proof of this feature.

- **Catalog identity.** Ask the package whether closeout is loadable. Run `control-temari plugin-catalog`. `skills=` includes `closeout`.
- **Package skill.** Read `skills/closeout/SKILL.md`. It names the five steps (boundary, persist knowledge, prove, persist work, archive last) and refuses force-push, merge, deploy, deletion, shared-branch write, or a new PR that the original task did not already require.
- **Public host stubs.** Confirm `test -f adapters/codex/skills/closeout/SKILL.md`, `test -f adapters/claude-code/skills/closeout/SKILL.md`, and `test -f adapters/generic/skills/closeout/SKILL.md`. Each stub tells the host to read that host's `HOST.md`, then the package closeout skill. Cursor has no adapter stub; that absence is expected.
- **Install entries.** `scripts/check-host-adapters.sh` (outside the repo evidence dir) requires those stubs and `skills/closeout/SKILL.md`. Exit 0 is packaging proof, not proof that a host archived a task.
- **Host `/closeout`.** The host-native path is unreachable through `control-temari`. Attempt the user action `/closeout` in a fresh host task. The unmet precondition is a host that can archive the current task. Record `verified-unreachable` rather than treating catalog presence as a completed closeout.

## Gotchas

- Cursor loads closeout from the plugin `./skills/` pointer. Do not fail the map because `adapters/cursor/skills/closeout/` is missing.
- `disable-model-invocation: true` means a host must not auto-trigger closeout. Invoking it is an explicit user request.
- Incomplete work is a pause, not a closeout. Finding `pause-safely.md` does not prove a task was archived.
- The request never authorizes a force-push. Do not drive closeout by mutating this verification checkout.
