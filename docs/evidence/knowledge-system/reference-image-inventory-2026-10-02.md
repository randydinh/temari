# Simple Markdown reference-image inventory experiment

## Hypothesis and scope

A separate operator-run Knowledge receipt can identify simple reference-style
Markdown image uses from a retained, fully admitted Registrar generation, and
pin their relative image targets to captured original hashes without changing
the existing inline-image receipt. This is a conservative syntax inventory.

The adapter accepts adjacent full `![alt][id]` and collapsed `![alt][]` uses,
including definitions that appear later in the same selected Markdown file.
Definitions are limited to one line, zero to three leading spaces, a simple
bracketed label, a colon, and one whitespace-free destination. Labels are
trimmed, whitespace runs collapse to one space, and JavaScript Unicode
lowercase is applied. This is not full Unicode case folding or a complete
CommonMark parser. Duplicate normalized definitions refuse the entire run
instead of applying CommonMark's first-definition rule. Escaped syntax,
frontmatter, code, HTML comments, and HTML blocks handled by the shared
visibility mask do not contribute uses. Other Markdown dialect features can
be omitted or conservatively classified as gaps.

## Pinning and limits

The receipt includes selected source paths, source and representation hashes,
each use's code-point span and quote hash, resolved target path, retained
original SHA-256 and byte length when present, and categorized gaps. It does
not store a separate raw destination field; a simple raw relative path can
equal the normalized `targetPath`. It omits alt text, external URLs, Markdown
body, image bytes, and recovered local path. `currentOriginal: not-checked`
means a live file is not part of the
claim. `visualMeaning: not-evaluated` is explicit.

The run requires a complete-admitted publication and unchanged current source
registration. It reads only pinned archive Markdown and manifest metadata,
revalidates the selected evidence, then rechecks registration and publication
bytes before writing the receipt. Limits: 1–64 selected files, 65,536 code
points per file, 256 uses total, 256 definitions per file, 1,000 manifest rows
over at most 50 pages of 20, and the Registrar transport response cap.
Ambiguous duplicate labels and exceeded budgets refuse. Missing definitions,
missing retained targets, outside-source paths, external URLs, and unsupported
targets remain distinct gaps.

## Focused verification

An actual local-only Registrar integration fixture captures Markdown and PNG,
deletes the live originals, verifies a later manifest page and exact Unicode
code-point spans, explicitly recovers a pinned PNG, and exercises forward,
collapsed, normalized, missing, external, outside, and unsupported cases.
Additional fixtures refuse duplicate normalized definitions, 257 uses, 257
definitions, publication tamper, disabled source, a single backslash and NUL
in a selected path. `pnpm nx run knowledge:integration` passed 92/92 against
the actual local-only Registrar; `pnpm nx run knowledge:test` passed 43/43;
uncached `knowledge:typecheck` and `pnpm nx sync:check` passed. An independent
read-only reviewer found no remaining must-fix in this scoped adapter.

## Open finish predicate

The receipt establishes declared simple syntax and retained original metadata.
It does not establish Markdown renderer behavior, visual meaning or OCR,
complete container/PDF image coverage, ongoing freshness, answer quality,
Windows behavior, or production losslessness. Those remain separate gates.
