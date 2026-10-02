# Archived standalone HTML image declaration inventory

## Scope

This operator-run Knowledge adapter inventories simple single-line `<img>`
declarations in one explicitly recovered `.html` or `.htm` original from a
complete, admitted Registrar generation. Registrar's HTML text representation
strips markup, so the adapter verifies the recovered original's SHA-256 and
byte count against the pinned manifest before parsing it. The fixture uses a
current `local-only` source and makes no hosted Jev call or key lookup.
The receipt deliberately requires current `local-only` sharing and refuses
`registered-sources` even though parsing runs locally; it does not cover every
registered source.

The scanner recognizes only a double-quoted `src` with a simple relative
image path. It handles quoted `>` and case-insensitive attribute names. It
skips HTML comments and `script`, `style`, `template`, `textarea`, and `title`
regions, and refuses nested templates or multiline tags. Duplicate `src`
refuses the run. Missing `src` is a malformed gap; `srcset`, modified or
encoded paths, unsupported extensions, external URLs, missing archive assets,
and outside-source paths receive distinct gaps. This is a declaration
inventory, not an HTML rendering result.

Target paths use the selected file's source-relative location. A document
containing `<base>` refuses rather than pin an asset whose browser URL could
resolve elsewhere.
Other raw-text or context-dependent containers (`xmp`, `iframe`, `noembed`,
`noframes`, `plaintext`, and `noscript`) refuse the document rather than expose
their interior as candidate image tags.

## Pinning and limits

The receipt records the source path and pinned original SHA-256/bytes, each
declaration's exact Unicode code-point span and quote hash, a canonical
source-relative target path when supported, retained target original
SHA-256/bytes when present, and explicit gaps. It stores no raw `src`, alt
text, external URL, HTML body, image bytes, or recovered file path. A simple
relative `src` may equal its canonical target path. The receipt marks
`currentOriginal: not-checked` and `visualMeaning: not-evaluated`.

Input is bounded to a regular recovered original of at most 64 KiB, decoded
as strict UTF-8 without a byte-order mark or NUL. The scanner admits at most
256 image declarations of at most 1,024 Unicode code points each. The
complete archived manifest is read in at most 50 pages of 20 rows, with a
1,000-row cap. Current registration and `local-only` sharing, pinned
publication bytes, archive identity, and recovered bytes are rechecked before
metadata-only receipt publication. Over-limit or ambiguous input refuses.

## Actual Registrar verification

The focused fixture captures standalone HTML and PNG through the actual
Registrar under explicit `local-only` sharing, deletes the live originals,
recovers exact HTML bytes, and inventories the retained generation. It proves
the PNG is on a later manifest page, validates an emoji-offset span and every
quote hash, and exercises comments, inert blocks, missing/external/outside/
unsupported/malformed gaps, receipt privacy, changed recovered bytes,
publication tampering, sharing change, and source disablement. A separate
fixture refuses duplicate `src`, 257 images, an overlong tag, invalid UTF-8,
an over-64-KiB original, nested template, and LF or CR-only multiline image
syntax, an `xmp` raw-text container, and a `<base>` element. The fixture also
excludes candidate text inside `textarea` and `title`.

The final focused actual-Registrar cases passed 2/2. Uncached Knowledge
typecheck and unit tests passed (43/43); Nx sync reported an up-to-date
workspace. Final actual-Registrar `pnpm nx run knowledge:integration` passed
98/98 at the corrected source. Scoped Nx format checking passed for the new
adapter and test. An independent read-only review found no remaining code
must-fix. Workspace-wide format checking still lists pre-existing differences;
only the new adapter and test were formatted.

## Open boundaries

The receipt does not establish browser rendering, `picture`/`srcset`
selection, CSS images, JavaScript-generated images, OCR, visual meaning,
continuous freshness, Windows behavior, graph/derived-view recovery, answer
quality, or production losslessness. The broader five Knowledge finish
predicates remain open.
