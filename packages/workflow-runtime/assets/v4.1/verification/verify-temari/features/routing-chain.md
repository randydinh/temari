# Routing chain

Temari is the conversational entry point, and the skill text it loads sends every software engineering request to poteto-mode for route classification. This feature covers that contract text and the host skill root a user installed into. Adapter layout and `install-host.sh` modes belong to `scripts/check-host-adapters.sh`; the routing cases themselves belong to `scripts/check-routing-evals.py`.

## Sub-features

- `routing-delegation` requires package `skills/temari/SKILL.md` to hand every software engineering request to poteto-mode.
- `routing-classification` requires `skills/poteto-mode/SKILL.md` to open on route classification and `playbooks/lightweight-engineering.md` to exist as the route it classifies against.
- `routing-install` resolves a host skill root's `pstack-root` pointer to a package and reports `install_mode`, plus drift when that package is a copy rather than the checkout.

## How to get to it (user POV)

- Invoke `temari` (or `/temari`) in the host and watch it read `HOST.md`, then the package Temari skill, then poteto-mode for an engineering request.
- Run `scripts/install-host.sh --host=<host> --dest=<skill-root>` and then open `<skill-root>/pstack-root` to see which package the host entries resolve to.

## Driving it with control-temari

Preconditions:

- The git checkout is the revision under test. No orch store or run-id is required; this check is read-only.
- For the install half, name a real host skill root (for Claude Code, `~/.claude/skills`), or export `TEMARI_HOST_SKILL_ROOT`.

- **Check the contract.** Ask the harness whether the delegation text is intact. Run `control-temari routing`. Exit 0. Stdout contains `package_root=`, `temari_delegates=yes`, `poteto_classifies=yes`, `lightweight_playbook=yes`, `install_root=(not checked)`, and `routing_ok=yes`. Rewording either sentence flips its line to `no` and exits 1.
- **Check an install.** Run `control-temari routing --dest <skill-root>` from a separate trusted reference distribution. `install_mode=symlink` means the pointer is absolute; `install_mode=copy` means it is relative. A separate copied package reports `install_comparison=independent-reference` and `install_drift=none` only when the compared files match. Running the installed controller against its own tree reports `install_comparison=not-performed (same tree; no independent reference)` and `install_drift=unknown`. Routing health may still be `routing_ok=yes`; that is not an independent integrity verdict.
- **Detect drift.** Against a disposable copied bundle, remove its bundled host mapping, alter its installation script, or alter a public entry. The public `pstack-HOST.md` must match exactly one supported host mapping in the independent reference; all public Temari, Poteto, Closeout, and present optional verification projections must match that same host’s bundled templates. From the independent reference, the same command must report `install_drift=<n> files`, `routing_ok=no`, and exit 1. Restore the bytes and require `install_drift=none` again. Do not run destructive negative checks against an active installation.
- **Proof.** Run `control-temari capture 01-routing -- routing` and, when an install root exists, `control-temari capture 02-routing-install -- routing --dest <skill-root>`. Keep both transcripts with their exit codes. Re-read `01-routing.stdout.txt` and confirm `routing_ok=yes` survives.

## Gotchas

- This check proves the text a host loads, not that a session obeyed it. Live routing behavior is proven elsewhere: `scripts/check-routing-evals.py` validates the `evals/engineering-routing` cases, and the organic journey evidence under `evidence/routing-organic-*` records real runs.
- `routing` greps the contract sentences. Rewording `every software engineering request` in `skills/temari/SKILL.md`, or `route classification` in `skills/poteto-mode/SKILL.md`, fails the check even though the intent survived. Fix the grep with the rewrite; do not delete the check.
- A symlink install pins the host to whatever path it was made from. Installing from a Git worktree makes the host's skills vanish when that worktree is removed, so install from the long-lived checkout.
- A symlink into a different checkout reports `install_tracks`, `install_comparison=not-performed (live symlink; no copy comparison)`, and `install_drift=unknown`. It serves its current target; no equality with the invoking distribution was established.
- Copy drift covers `skills/`, `verification/` excluding retained evidence, `adapters/`, `agents/`, `scripts/`, `docs/`, `LICENSE`, `UPSTREAM.md`, and the optional Archon runtime allowlist. Public projection directories are also compared, including extra files; a missing or altered `pstack-HOST.md`, mixed-host projection, or missing required projection fails the comparison. `verification/` retains the inherited `diff -x evidence` exclusion. Skill dependencies are not excluded: compare equivalent copies before runtime dependency provisioning. The optional Archon lane retains its explicit runtime allowlist rather than including installed dependencies. The count is a mismatch signal, not a file-by-file report.
