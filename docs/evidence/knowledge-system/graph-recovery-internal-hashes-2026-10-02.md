# Bounded recovery package internal hashes, 2026-10-02

## Hypothesis and choice

The read-only archive/graph dependency plan in PR #184 checks package bytes and declared package relationships, but it can still report a plan for a package whose embedded archive blob or OKF file body disagrees with its own hash declaration. An operator might import earlier packages before Registrar rejects the corrupt later package. Verify those internal byte declarations before publishing the plan.

The alternative was a PDF embedded-image declaration inventory. That requires extending the hard-bounded Lima parser and its result contract. A raw-token scan could miss compressed object streams and falsely report an image absent. The recovery preflight is a smaller check against a reproduced failure in the actual Registrar replay fixture.

## Intended boundary

Keep the existing one archive at most 8 MiB and up to four OKF files at most 1 MiB each. Decode each archive blob using a strict canonical base64 form and compare its bytes to the declared digest; require every represented original/derived descriptor to point to a blob of matching digest and byte length, with no unattached blob. For each OKF package, require the file and `file_sha256` keysets to agree and check the UTF-8 bytes of each declared file. The receipt must distinguish this limited internal-hash preflight from the older declared-dependency-only plan.

This does not validate the complete Registrar archive or OKF profile, current source admission, access, origin or erasure policy. It neither imports nor makes packages atomic, and a later import must recheck the same file bytes because paths can change after planning. Registrar remains the authority for package admission. No hosted model or key is involved.

## Verification

The same synthetic `local-only` actual Registrar archive/root/retracted-child fixture first exposed the declared-only gap. The schema 2 candidate plans the original shuffled packages in archive/root/child order and actual imports still preserve graph lineage and retraction. It now refuses a changed archive blob, non-base64 blob, missing or unreferenced blob, wrong descriptor size, changed OKF body or hash, and missing or extra OKF file hash before the destination has any archive or graph rows. A changed OKF body with a correspondingly updated internal file hash passes this limited planner, then Registrar rejects the invalid exact OKF profile. That is the boundary of the new claim.

Focused actual Registrar test passed 1/1. The uncached Nx Knowledge integration suite passed 100/100 with the bundled Registrar source and explicit isolated Python; unit tests passed 43/43, daemonless typecheck and `nx sync:check` passed. The first full integration attempt omitted the required explicit Registrar environment and refused, then the environment-corrected run passed; it did not indicate a product failure. Scoped code/document formatting and `git diff --check` passed. Independent read-only candidate review found no must-fix after checking the Registrar export/import data shapes and test refusal behavior. Clean exact-head public-entry package/check reported `c539bdf300aa7cc7f6bc8796e0cb7cde81d24453` with `dirty:false`; relocated stock Node Knowledge CLI help and packaged planner export loaded. Independent exact-head review found no must-fix. [PR #186](https://github.com/randydinh/temari/pull/186) merged at `738dc07229366ffeb2870e31b941682b27e19b63` with the reviewed tree. No hosted Jev call or key read occurred. The five broader production finish predicates in the [Knowledge handoff](knowledge-handoff-2026-10-02.md) remain open.
