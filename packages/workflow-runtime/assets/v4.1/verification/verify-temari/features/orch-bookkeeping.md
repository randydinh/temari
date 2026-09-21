# Orchestrate bookkeeping

Orchestrate bookkeeping is the `orch` CLI a coordinator uses to init a plain-file store, track units, render status, record verification, and park gates. One command in, one line out.

## Sub-features

- `orch-help` prints usage, global flags, and the command list.
- `orch-init` creates `units.tsv`, `ledger.tsv`, `inbox/`, `gates.md`, `preferences.md`, and `frontier.json`.
- `orch-unit` adds, gets, lists, and counts units without rewriting TSV by hand.
- `orch-status` writes `status.md` and prints `counts:`, `changed:`, `gates open:`.
- `orch-standing` appends numbered standing orders to `preferences.md`.
- `orch-ledger` records and checks verdicts `live-ui-verified`, `unit-test-verified`, `type-check-only`, `verifier-blocked`, `verifier-failed`.
- `orch-inbox` pushes a pointer and drains it.
- `orch-gate` parks, lists, and resolves a decision gate.

## How to get to it (user POV)

- In an Orchestrate run, follow `skills/poteto-mode/playbooks/orchestrate.md` and run `bun scripts/orch/orch.ts` (from `skills/poteto-mode/scripts`) with `--store` pointing at `orchestrate/<project-slug>/`.
- Run `orch init` before any other store command.
- Run `orch unit add`, `orch status`, `orch standing add`, `orch ledger record`, `orch inbox push`, and `orch gate park` as the playbook's drain points require.
- Pass `--json` when a complete row is needed instead of the compact four-line view.

## Driving it with control-temari

Preconditions:

- `control-temari launch --run-id <run-id>` has created an isolated store under `/tmp/temari-verify/<run-id>/store`.
- `control-temari doctor` reports `healthy=yes` and `store_isolated=yes`.
- The store is not yet initialized (`units_header=(not initialized)`).
- Evidence goes to `verification/verify-temari/evidence/<run-id>/`.

- **Show help.** Ask orch what it does. Run `control-temari orch -- --help`. Exit 0. Stdout contains `Plain-file orchestrate bookkeeping`, `init`, `unit`, `ledger`, `inbox`, `gate`, `frontier`, `status`, and `standing`.
- **Init store.** Initialize. Run `control-temari capture 02-orch-init -- orch -- init`. Exit 0. Stdout is `initialized <store-path>` and that path matches `STORE` from `control-temari current`.
- **Add unit.** Create work item `verify-u1` on track `verify`. Run `control-temari capture 03-unit-add -- orch -- unit add verify-u1 --track verify`. Exit 0. Compact stdout starts with `verify-u1	verify	pending`.
- **Read unit back.** Fetch the same id. Run `control-temari orch -- unit get verify-u1`. The row still shows `verify-u1	verify	pending`. Run `control-temari orch -- --json unit get verify-u1` and require `"id": "verify-u1"`, `"track": "verify"`, `"state": "pending"`.
- **Render status.** Ask for the drain summary. Run `control-temari capture 04-status -- orch -- status`. Stdout includes `counts: units=1; states=pending=1; ledger=none`, `changed: first render`, and `gates open: 0`.
- **Confirm files.** Snapshot the store. Run `control-temari snapshot 05-store`. `05-store/units.tsv` has header `id	track	state	branch	pr	sha	brief` and a `verify-u1` row. `05-store/status.md` starts with `# Orchestrate status` and a table row for `verify-u1`.
- **Standing order.** Add a constraint. Run `control-temari orch -- standing add "verify isolation with --store"`. Stdout is `1. verify isolation with --store`. `control-temari orch -- standing show` prints the same line. `preferences.md` contains that sentence.
- **Ledger.** Record a verification row. Run `control-temari orch -- ledger record 1 abcdef1 unit-test-verified --evidence $EVIDENCE/04-status.stdout.txt --verifier control-temari`. Stdout is `1	abcdef1	unit-test-verified`. `control-temari orch -- ledger check 1 abcdef1` prints `unit-test-verified`.
- **Inbox and gate.** Push `control-temari orch -- inbox push agent-1 verify-u1 done` (stdout contains `verify-u1	done	`). Drain with `inbox drain`. Park `control-temari orch -- gate park g1 --question "land now?" --options "yes,no" --default no`, then `gate resolve g1 --answer no` yielding `g1	resolved	no`.
- **Proof.** Re-read status after mutations. Run `control-temari orch -- status` and `control-temari snapshot 06-final`. `counts:` includes `units=1` and a ledger verdict. Evidence transcripts and store snapshots both name `verify-u1`.

## Gotchas

- `orch` without a subcommand exits 1 with `error: a valid command is required` and reprints help. That is usage, not a hung store.
- Compact `unit list` and `gate list` hide rows after 4 with `... N more; use --json`. `inbox drain` prints every pointer. Assert with `--json` or by reading the TSV when `unit list` / `gate list` has more than four rows.
- `ledger check` on a missing key exits 2. With `--json` stdout is `{"pr":"...","sha":"...","verdict":"NOT-VERIFIED"}` and stderr is empty. Do not treat exit 2 as a crash.
- `frontier set` needs `--repo` or `ORCH_REPO` and a real git/Graphite stack. Skip it unless that precondition exists; missing repo exits 1 with `set --repo <dir> or ORCH_REPO`.
- Do not init twice as the interesting proof. `writeIfMissing` leaves existing files alone. Drive add/get/status on a store this run initialized.
- Never point `--store` at a live Orchestrate program directory. Isolation is the whole point of launch.
