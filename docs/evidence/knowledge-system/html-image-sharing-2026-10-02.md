# Archived HTML image inventory sharing admission

## Change and boundary

The archived standalone HTML image declaration adapter now admits a currently
enabled local Registrar source whose sharing is either `local-only` or
`registered-sources`. It records the admitted `sourceSharing` mode in each
metadata-only receipt and requires the same mode at the start and end of the
inventory. A change during the run refuses the receipt. The source
registration, complete archived generation, publication bytes, recovered HTML
original, and target original pins from the earlier inventory remain in force.

The mode describes current Registrar source sharing at inventory time. It is
not evidence of sharing at capture time, an authorization for a hosted call,
or an atomic snapshot of every intervening instant. This adapter parses the
explicitly recovered original locally; it makes no hosted call or key read.
Earlier schema-1 receipts lack `sourceSharing` and are historical local-only
receipts under their original
`local-only-simple-single-line-html-img-declarations-only` coverage literal.
New receipts use schema 2, retain that coverage literal for `local-only`, and
use a distinct
`registered-sources-simple-single-line-html-img-declarations-only` literal
for the newly admitted mode. The parser policy remains
`recovered-simple-html-img-v1`.
The receipt still says `currentOriginal: not-checked` and
`visualMeaning: not-evaluated`. Its coverage is the bounded simple single-line
`<img src="...">` declaration subset described in the earlier
[inventory evidence](html-image-inventory-2026-10-02.md), not rendered images
or visual meaning.

## Actual Registrar verification

The local-only fixture captures standalone HTML and PNG, deletes both live
files, recovers the exact HTML, and checks pinned target metadata and explicit
gaps. After changing that source to `registered-sources`, a new inventory
records the new mode in a distinct receipt; disabling the source still
refuses admission. A second fixture captures at Registrar's default
`registered-sources` mode, deletes the live HTML and PNG, recovers the exact
HTML, and verifies its source and target original hashes, code-point quote
hash, metadata-only receipt, and mode. It then changes sharing on the third
Registrar list call of another inventory, between the initial and final
admission checks. The adapter refuses the changed-mode run.

The test uses a fixed local Python wrapper executable to cause that controlled
mode change while all capture and read operations still go through the actual
Registrar CLI. The wrapper is included in the publication's transport
implementation pin; only test-owned registry state changes after capture.

Verification at the final code state passed: focused actual Registrar HTML cases
3/3; scoped Nx format check; uncached Knowledge typecheck; uncached Knowledge
unit tests 43/43; Nx sync check; and uncached full Knowledge integration
99/99. Final focused and Nx check logs are retained off-repository.

## Remaining gaps

This change does not establish hosted-source permission, browser rendering,
`picture`/`srcset` selection, CSS or script-generated images, OCR, visual
meaning, continuous freshness, or broader production losslessness. A source
mode may change and return to the same value between admission checks; this
adapter has no transactional sharing snapshot. The five broader Knowledge
finish predicates remain open.
