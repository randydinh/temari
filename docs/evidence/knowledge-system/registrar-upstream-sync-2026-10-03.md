# Private Registrar upstream sync, 2026-10-03

## Decision

**Hypothesis.** A pinned, byte-for-byte sync of the existing 33-file Registrar
payload from private upstream commit
`d73f626133b2543345c32805957e05b61e386bad` will preserve Temari's
installable Knowledge journey while bringing in the already reviewed schema-5
graph migration/retraction fixes, BM25 selected-snapshot manifest pin, and
opt-in PDF worker boundary repairs.

Two narrow choices were compared: sync the reviewed upstream payload before
the next Temari archive, or defer the sync until after an archive pin change.
The former keeps the installer's reviewed source tree, provenance manifest, and
launcher pins in one release candidate. Deferral would leave the bundled
Registrar on the older `7609269` source and require another successor release
for fixes already merged privately. This unit chose the direct pin update.

## Changed artifact and provenance

The existing bundle inventory remains 33 files. An exact comparison against
the merged upstream tree found 26 identical files and seven differing files:
`archive_cli.py`, `pdf_lima_worker.py`, `source_archive.py`,
`source_registry.py`, `test_audit_snapshots.py`, `test_pdf_lima_worker.py`, and
`test_source_archive.py`. Only those seven payload files were replaced with
their exact upstream bytes. A final comparison found **33/33 byte-identical**
payload files. `UPSTREAM.json` now pins the merged commit, file hashes, and
manifest SHA-256
`5ecf0874189fcfe6d0a0ad317ef78877a3cc390171c0240823598ac7de3d6e83`;
its downstream modification list is empty. The payload verifier and installed
launcher pin that same commit and manifest digest. The private Codex plugin
version moves from `0.1.0` to `0.1.1`; the upstream Python Registrar
distribution remains `0.1.0`.

The sync does not add a second hosted model or change the registered-source
and local-only policy. Direct TypeSafe Jev remains the sole hosted path. No
credential was read or used. The PDF lane remains opt-in and host dependent.

## Focused verification

| Check | Result |
| --- | --- |
| Exact comparison of each manifest file with `git show d73f626:<path>` | 33/33 bytes match; zero downstream modifications. |
| `node tools/registrar-payload.mjs` | Passed: 34 packaged files including the manifest. |
| `node --test tools/registrar-payload.test.mjs` | Passed 6/6, including changed-source, added-file, altered-manifest, and symlink refusals. |
| Bundled `uv run --frozen python -m unittest discover -s tests -p 'test_pdf_lima_worker.py'` with external venv/cache and bytecode disabled | Passed 13/13 synthetic worker tests. |
| Full standalone upstream `uv run --frozen python -m unittest discover -s tests` at a local commit with the same tree as merged `d73f626` | Passed 352/352 on macOS/Python 3.12.13. |
| `NX_DAEMON=false pnpm nx run workflow-runtime:knowledge-plugin-test` | Passed 2/2, including relocated install and local-only intake/BM25 search. |
| `NX_DAEMON=false pnpm nx run workflow-runtime:typecheck` | Passed with dependency typechecks. |
| `NX_DAEMON=false pnpm nx sync:check` | Workspace up to date. |

The full standalone suite ran from the private upstream clone because the
installer deliberately bundles a selected 33-file payload rather than the
whole Registrar repository. That suite exercised synthetic PDF timeout and
boundary tests. Its default macOS archive matrix reported
`pdf-memory-boundary-unavailable`; a real Lima guest PDF extraction was not
exercised here. Scanned-page text and visual meaning remain explicit gaps.

`NX_DAEMON=false pnpm nx run workflow-runtime:knowledge-release-test` was
attempted before committing this candidate. Its fixture setup refused the
dirty source with `Release requires a clean source commit`, causing 8/8
tests to abort. This is the intended archive trust guard, not evidence that
the successor archive passes. Rerun this target and the trusted prior-archive
successor check after a clean pinned commit.

## Keep or revert and finish predicate

**Keep for exact-head review.** Payload bytes, manifest, launcher pins, and
plugin version are internally consistent; the relocated install and actual
Registrar checks pass. Publication remains conditional on independent review,
a clean pinned Temari commit, the release suite, and a trusted prior-archive
successor check. This local verification does not establish public
distribution rights, a production lossless system, real PDF guest operation,
visual understanding, Windows operation, or human-validated answer quality.
