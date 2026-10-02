# Simple Markdown raw-HTML image inventory experiment

## Scope

An operator-run Knowledge receipt inventories a narrow subset of single-line
`<img ... src="relative-image-path" ...>` declarations in selected archived
`.md` or `.markdown` files. It reads a complete, admitted Registrar generation
and pins a resolved target to retained original SHA-256 and byte length when
the target exists. It is a syntax inventory, not evidence that a Markdown or
browser renderer displays the image.

The parser accepts a double-quoted `src`, recognizes case-insensitive attribute
names and a quoted `>` within another attribute, and refuses duplicate `src`
attributes. Missing or unterminated tags are malformed gaps. External URLs,
outside-source paths, missing assets, and unsupported forms (including
`srcset`, encoded or modified paths, and unsupported extensions) remain
distinct gaps. The visibility pass excludes frontmatter, fenced and indented
code, inline code, comments, escaped starts, and raw HTML blocks recognized by
the shared Markdown mask. It also suppresses candidates inside bounded CDATA,
DOCTYPE, and processing-instruction forms. HTML-block children can be omitted; full HTML
and Markdown dialect parsing is outside this receipt.

## Pinning, privacy, and limits

For each candidate, the receipt stores its source path, original and text
representation hashes, exact Unicode code-point span, quote SHA-256, and
either a canonical source-relative target path plus retained original hash and
bytes or a categorized gap. It stores no raw `src`, alt text, external URL,
markup body, image bytes, or recovered file path. The normalized target path
can equal a simple raw relative destination. `currentOriginal: not-checked`
and `visualMeaning: not-evaluated` state the limits of the claim.

The adapter requires an unchanged current source registration, revalidates the
selected archived text, and rechecks registration and publication bytes before
writing the metadata-only receipt. It bounds selected files to 1–64, text to
65,536 code points per file, tags to 1,024 code points each and 256 total,
and the pinned manifest scan to 1,000 rows across at most 50 pages of 20.
It refuses over-limit or ambiguous input instead of publishing a partial
success.

## Actual Registrar verification

The focused `local-only` fixture captures Markdown and a PNG through the
actual Registrar, deletes the live originals, reads a pinned archive, proves
that the asset appears on a later manifest page, and recovers the exact PNG
bytes separately. It checks emoji-offset code-point spans and quote hashes,
quoted `>` handling, nested tag text within an attribute, escaped starts,
frontmatter/code/comment/HTML-block exclusions, and missing, outside,
external, unsupported, and malformed gaps. Separate cases refuse duplicate
`src`, 257 tags, and an overlong tag. Publication tampering and disabled
registration refuse an inventory. This local-only path makes no hosted Jev
call and does not read a TypeSafe key.

After the fixture explicitly set `local-only` sharing, the focused
actual-Registrar rerun passed 2/2 and the final full
`pnpm nx run knowledge:integration` passed 94/94, including both new cases.
`pnpm nx run knowledge:test --skipNxCache` passed 43/43, uncached
`knowledge:typecheck` passed, and `pnpm nx sync:check` reported an up-to-date
workspace. An independent read-only review found no must-fix issue in this
scoped candidate.

## Open boundaries

This does not establish rendered Markdown or browser behavior, standalone
HTML coverage, `picture`/`srcset` selection, CSS images, PDF assets, OCR,
visual meaning, continuous freshness, Windows behavior, or production
losslessness. The broader Knowledge finish predicates remain open.
