# temari verification map

This directory is the maintained source for verifying temari's user-facing behavior. Read this index before driving, then use the matching feature file as the recipe.

Temari's primary surface is a plugin package with host-specific discovery. The driveable harness in this checkout is `control-temari`, which wraps the package catalog and the bundled CLIs a user already runs from a terminal.

## Baseline preconditions

- Work from the repository root of this temari checkout.
- Bun is optional on your own `PATH`. `control-temari` resolves it, bootstrapping into `TEMARI_BUN_ROOT` (default `$TMPDIR/temari-bun`) when the host has none, and reports the resolved binary as `bun_bin=`. Run bun through `control-temari bun -- <args>` so a recipe never depends on `~/.bun/bin` existing.
- Run `verification/verify-temari/scripts/control-temari launch --run-id <run-id>`.
- Run `control-temari doctor` and require `healthy=yes`, `plugin_name=temari`, and `store_isolated=yes`.
- Set `TEMARI_MAINTENANCE_REPO` to the owning Git repository root, or pass `--repo <root>` to each maintenance command and guarded drive. Never use the installed package cache as another repository's state.
- Require a fresh maintenance receipt through `control-temari drive -- <command...>` before ordinary verification. When due, follow [daily maintenance](./verification-maintenance.md) through actual host execution and caller-attested recording.
- Point evidence at `verification/verify-temari/evidence/<run-id>/` (the helper does this).
- Never drive an orch store that was not created by this verification run.
- Never start unbounded `watch-pr` (must pass `--status-only` or `--timeout` greater than 0).

## Driving conventions

- Start every recipe from a fresh launch unless its preconditions say otherwise.
- Treat every command as literal. Keep quoted names and flags unchanged.
- Feature recipes name the underlying controls. For ordinary verification, insert `drive --` before the recipe's target command. For example, `control-temari orch -- init` becomes `control-temari drive -- orch -- init`, and `control-temari capture init -- orch -- init` becomes `control-temari capture init -- drive -- orch -- init`.
- Use raw controls during the maintenance skill's own live pass, diagnostics, or harness tests. Help, status, doctor, launch, and cleanup stay available when due. Doctor may bootstrap missing dependencies and never records maintenance.
- Run catalog actions through `control-temari plugin-catalog` and `control-temari playbooks`.
- Run orchestrate actions through `control-temari orch -- <command>`.
- Run watcher actions through `control-temari watch-pr -- <flags>`.
- Run decision-log actions through `control-temari log -- <args>`.
- Run named workflow state through `control-temari workflow-open`, `workflow-drive`, and `workflow-snapshot`.
- Keep live model journeys manual or release-gated with `control-temari journey-capture`.
- Replay sanitized journey manifests in CI with `control-temari journey-score`.
- Restore nothing in the user's home directory. Scratch lives under `/tmp/temari-verify/`.
- Do not remove proof artifacts during cleanup.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final stdout line.
- CLI proof includes the command, stdout, stderr, and exit code (`control-temari capture`).
- Mutation proof includes a read-only second view of the stored value (`unit get`, `snapshot`, or the TSV/Markdown files).
- Record the feature ID and entry point used with every artifact.
- Report an unreachable path with the attempted command and the unmet precondition (live `/poteto-mode` chat, GitHub auth, a real PR number).
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with control-temari` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map. Name only user paths, stable handles, required state, commands, and observable proof.

## Features

- [Plugin catalog](./plugin-catalog.md) covers the identity, skills, and agents in this checkout.
- [Orchestrate bookkeeping](./orch-bookkeeping.md) covers `orch` init, units, status, standing orders, ledger, inbox, and gates.
- [Watch PR](./watch-pr.md) covers the GitHub babysit watcher help, usage failures, and `--status-only` snapshots.
- [Decision log](./decision-log.md) covers `log.sh` header creation, append-only rows, and formula-safe cells.
- [Poteto-mode playbooks](./poteto-mode-playbooks.md) covers the playbook files `/poteto-mode` matches and their links from `skills/poteto-mode/SKILL.md`.
- [Seq log review](./seq-log-review.md) covers bounded read-only investigation of Seq logs and traces, evidence handling, and optional approved project overlays.
- [Integration discovery](./integration-discovery.md) covers the required provider census, lifecycle states, decision receipt, and checker before external-service integration work.
- [Archon installation](./archon-installation.md) covers local foundation installation, current checks, relocation and native deterministic verification. It requires the optional Archon distribution.
- [Bounded live pilot](./archon-live-pilot.md) covers caller-supplied planning, isolated Codex implementation, sandboxed target tests and fresh read-only review. It requires the optional Archon distribution and separate explicit live execution.
- [Routing chain](./routing-chain.md) covers the temari-to-poteto-mode delegation contract, the host adapter entries, and install drift.
- [Workflow conformance](./workflow-conformance.md) covers the workflow CLI, bounded journey capture, and sanitized journey replay.
- [Closeout](./closeout.md) covers the explicit durable task exit, public host stubs, and plugin-native Cursor path.
- [Credential profiles](./credential-profiles.md) covers Temari's credential-profile guidance and the Omega helper boundary.
- [Daily verification maintenance](./verification-maintenance.md) covers due/fresh decisions, caller-attested persistence, host continuation, and the guarded verification entry.
