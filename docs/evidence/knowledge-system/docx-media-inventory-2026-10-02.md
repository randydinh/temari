# Recovered DOCX package-media inventory

This increment inventories media members inside **one explicitly recovered archived DOCX original**. It does not fetch the recovered file itself. The operator supplies the publication path, a canonical source-relative `.docx` path, and the recovered-original file path. The operation requires a complete-admitted publication, the same currently enabled source registration, a verified pinned Registrar manifest entry, and recovered bytes matching the retained original SHA-256 and byte count. It rechecks the file, registration, and publication before publishing a receipt.

The parser runs a fixed Python standard-library `zipfile` script with `-I -S`, a 30-second deadline and 1 MiB output bound. It accepts at most 8 MiB of compressed original, 1,000 ZIP members, 32 MiB of actual expanded data, and 256 media members. It streams every member, checks central-directory sizes and CRCs, rejects duplicate or unsafe names, and requires minimal DOCX markers (`[Content_Types].xml` and `word/document.xml`). The receipt records the worker script hash and the Knowledge adapter module hash (TypeScript in a source run or compiled JavaScript in a package run), rechecked before receipt publication.

The receipt contains only the source/publication pins, original SHA-256 and byte count, sorted `word/media/*` member names with SHA-256 and byte counts, total expanded bytes, and coverage labels. It does not retain the recovered path, source text, or image bytes. `coverage: package-media-only` means these members exist in the ZIP; it does **not** establish that document XML displays them. `visualMeaning: not-evaluated` and `currentOriginal: not-checked` remain explicit.

## Focused evidence

The actual local-only Registrar fixture captures a synthetic DOCX, deletes its live original, recovers the pinned original, and inventories two media members. It checks exact member metadata and receipt redaction, replay idempotence, refusal of tampered recovered bytes and disabled registration, and low-level parser refusal of duplicate names, excessive expansion, non-DOCX ZIP, unsafe member names, malformed ZIP, and a CRC-corrupted member. The source-relative path rejects backslash and NUL inputs.

Verification results and commit/PR identity are recorded in the overnight decision log. This is a narrow package inventory, not OCR, displayed-image detection, PDF embedded-asset coverage, Windows support, or production losslessness.
