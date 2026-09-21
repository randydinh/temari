# Decision log

The decision log is the append-only TSV a long-running temari session keeps via `/show-me-your-work` and `skills/show-me-your-work/scripts/log.sh`.

## Sub-features

- `log-usage` prints `usage: log.sh <logfile> <phase> <decision> <why> <evidence> <result>` when argv is wrong.
- `log-create` writes the header `ts	phase	decision	why	evidence	result` on first use.
- `log-append` adds one ISO8601-stamped row without rewriting earlier rows.
- `log-sanitize` strips tabs/newlines inside cells and prefixes `=`, `+`, `-`, or `@` so a spreadsheet does not treat the cell as a formula.

## How to get to it (user POV)

- During an autonomous, overnight, or orchestrate run, follow `skills/show-me-your-work/SKILL.md` and keep one canonical log.
- Copy `skills/show-me-your-work/references/decision-log-template.tsv` or let `log.sh` create the header.
- Run `scripts/log.sh <logfile> <phase> <decision> <why> <evidence> <result>` after each decision or checkpoint.
- Default working path is `decisions.tsv` in the work dir, or `.audit/<task-slug>.tsv` when several efforts share a tree.

## Driving it with control-temari

Preconditions:

- A verification run is active so `$EVIDENCE` exists, or pass an explicit logfile under that evidence directory.
- Do not append to a user's committed `decisions.tsv`. Use `$EVIDENCE/decisions.tsv`.

- **Wrong argv.** Call the helper with no fields. Run `control-temari log` and expect a non-zero exit from `log.sh` plus the usage line on stderr. This is the documented six-argument contract.
- **Create and append.** Write the first real row. Run `control-temari log -- "$EVIDENCE/decisions.tsv" verify "used isolated orch store" "a shared coordinator store would mix proof with live work" "$EVIDENCE/02-orch-init.stdout.txt" "store initialized"`. Exit 0. The file begins with `ts	phase	decision	why	evidence	result` and has exactly one data row whose `phase` cell is `verify`.
- **Append stays append-only.** Write a second row. Run `control-temari log -- "$EVIDENCE/decisions.tsv" verify "captured unit add" "need action and stored row" "$EVIDENCE/03-unit-add.stdout.txt" "verify-u1 pending"`. The header is still the first line. There are two data rows. The first decision text is unchanged.
- **Sanitize formula cells.** Write a hostile evidence string. Run `control-temari log -- "$EVIDENCE/decisions.tsv" verify "sanitize" "spreadsheet safety" "=cmd|'/c calc'" "quoted"`. The evidence cell in the new row starts with a single quote before `=`.
- **Proof.** Copy the logfile. `cp` is unnecessary if the file already lives under `$EVIDENCE`. Re-read `decisions.tsv` after cleanup of the orch store; the TSV must still be in the evidence directory. Render with `column -s$'\t' -t "$EVIDENCE/decisions.tsv"` if `column` exists.

## Gotchas

- `log.sh` lives at `skills/show-me-your-work/scripts/log.sh`, not under poteto-mode scripts. `control-temari log` is the stable entry.
- A bare `printf` append also works, but then you own tab stripping and formula prefixing. Prefer `log.sh` so proof matches what the skill tells agents to run.
- Do not edit or delete earlier rows to fix a mistake. Append a superseding row.
- Cells that start with `-` are formula-shaped too. Phrases like `- skipped` become `'- skipped`. Assert the stored bytes, not the argv you passed.
