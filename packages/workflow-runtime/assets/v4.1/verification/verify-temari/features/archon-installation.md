# Archon installation

A packaged Temari installation can prepare a local Archon execution foundation, check its current files and selected runtime, and optionally verify deterministic failure/resume without model credentials.

## Sub-features

- `archon-install` creates the owned `archon-foundation` child with locked production dependencies.
- `archon-check` reports current package, dependency, runtime and workflow facts separately from execution verification.
- `archon-preservation` refuses foreign or changed destinations and preserves siblings on setup failure.
- `archon-portability` keeps hidden workflow files and relative dependencies usable after moving packages.
- `archon-native-verification` resumes the exact deliberately failed native run and obtains a canonical review receipt.

## How to get to it (user POV)

- Ask Temari to discover or install the Archon deterministic foundation.
- Run the packaged `integrations/archon/lifecycle.ts install` or `check` command.
- Add `--verify` to check deterministic execution with the selected native runtime.

## Driving it with control-temari

Preconditions:

- Select the optional Archon distribution, Bun, Git and a verified Archon v0.10.1 executable at commit `9820785c`. Archon commands are unavailable in the portable distribution.
- Use an operator-owned destination and fresh evidence outside the package. No model credentials are required.

- **Local behavior.** Run `control-temari bun -- test integrations/archon/lifecycle.test.ts` from the repository root. Require fresh/repeat, missing/incompatible runtime, drift, ownership, dependency failure and relocation tests to pass. These tests use an explicit fake CLI; they do not prove native execution.
- **Packaging.** Create a fresh copy install with `scripts/install-host.sh` and a fresh plugin with `scripts/build-codex-plugin.sh`. Require relocated copies to preserve the hidden workflow, run controller help from an unrelated directory and reject integration drift with `control-temari routing --dest <skill-root>`.
- **Install from a package.** From an unrelated directory, run `bun <package>/integrations/archon/lifecycle.ts install --dest <absolute-parent> --archon <absolute-native-executable> --json`. Require `installation: created`, four passed prerequisite checks, `execution.status: not-requested`, and `liveAI: bounded-pilot-available` with `liveCandidate.configured`, `authenticated` and `verified` all `unknown`.
- **Move and verify.** Move the whole `<parent>/archon-foundation` directory, then run `bun <moved>/integrations/archon/lifecycle.ts check --archon <absolute-native-executable> --verify --evidence <absolute-empty-evidence> --json`. Require passed execution, a retained exact native run ID, `summary.json` showing failed then completed, builder count one and a valid canonical review receipt.
- **Fresh recheck.** Run the moved controller's plain `check` again. Require execution to return to `not-requested`; a past success cannot substitute for current verification.

## Gotchas

- The foundation's candidate facts are scoped to deterministic failure/resume. The separate live candidate advertises only the bounded pilot and retains unknown configuration, authentication and actual verification. See [Bounded live pilot](./archon-live-pilot.md).
- Plain checks do not install or repair dependencies. Changed owned content requires a different destination.
- Moving a package does not migrate active runs or rewrite their absolute path bindings.
- A successful deterministic run does not prove live AI work, automatic repair, hard-crash recovery or unexercised operating systems.
