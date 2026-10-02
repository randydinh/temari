# Visible Markdown image inventory, 2026-10-02

## Result

A read-only Temari adapter inventories simple visible inline Markdown image
references from one pinned, completely admitted Registrar generation. The
operator selects 1–64 source-relative Markdown files. The adapter validates
the selected publication and current source registration before and after the
read, checks complete retained UTF-8 text and its archive evidence, and records
the exact code-point span and SHA-256 of each image token. Its content-addressed
receipt contains metadata only: source and target paths, hashes, byte counts,
and explicit gaps. It contains no alt text, quote, raw URL, or image bytes.

For a relative supported image path, the adapter pages the pinned generation's
Registrar manifest to find captured original SHA-256 and byte count. An
in-root path absent from that manifest is `missing`. External or modified
destinations and unsupported extensions on detected tokens are `unsupported`;
an absolute or root-escaping path is `outside`. The adapter never routes image
bytes through the text provider. Archived image bytes remain recoverable with
Registrar's explicit `recover` command.

The refusal bounds are 65,536 code points per selected Markdown file, 256
detected references total, and 1,000 archived manifest documents in at most
50 `inspect` pages of 20. If the manifest has another page after that bound,
inventory refuses instead of incorrectly reporting an uninspected target as
missing. Each page uses an explicit response budget no larger than the pinned
transport's maximum (at most 1 MiB); an oversized page refuses rather than
silently dropping records. The current original is not inspected; the receipt says
`currentOriginal: not-checked`.

## Verification

An actual bundled-Registrar CLI fixture captured Markdown and a PNG, then
deleted both live files. Twenty-two filler documents placed the captured PNG
on the second `inspect` page; the fixture checked that the first page lacked
it and the second contained it. The adapter pinned the PNG's original hash
and byte count, distinguished a missing in-root image, an external URL, and a
path outside the source root, and ignored code, comments, and a singly escaped
image. It counted an image preceded by two backslashes as visible.
The fixture checked every reported code-point span and token hash against the
retained Markdown, recovered the PNG through the Registrar CLI and compared
its exact bytes, rejected a tampered publication pin, and rejected a disabled
source. The focused integration test passed 1/1 and the full actual-Registrar
`knowledge:integration` suite passed 79/79. The existing Markdown-link cases
passed, as did `knowledge:test` (43/43). An initial focused Nx run needed
`--skipSync` after a transient project-reference warning; final
`pnpm nx sync:check` and `pnpm nx run knowledge:typecheck` passed without it.

## Limits

This inventory records a reference and captured byte identity, not what an
image depicts. It performs no visual interpretation, OCR, image embedding,
relationship inference, or hosted-model call. The parser covers simple inline
`![alt](relative-path.ext)` tokens in retained Markdown. It does not establish
coverage for reference-style images, complex Markdown destination/title
syntax, HTML images, PDF or DOCX embedded images, or every Markdown dialect.
It is a bounded archive visibility proof, not a production claim of lossless
visual knowledge.
