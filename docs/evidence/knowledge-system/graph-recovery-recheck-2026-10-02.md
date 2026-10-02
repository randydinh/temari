# Bounded recovery package identity recheck, 2026-10-02

## Hypothesis and choice

The schema 2 read-only dependency planner computes hashes and dependency order for a selected archive bundle and root/child OKF packages. A caller can change a selected file after planning; Registrar's later import commands reopen paths by name. A read-only recheck against a trusted saved plan can identify accidental package drift just before import.

The alternative was a full exact OKF profile preflight. That would require a new Registrar validation API and bundled payload pins, or a second implementation of Python's profile rendering in TypeScript. A PDF embedded-image inventory likewise needs a wider hard-bounded Linux parser contract. The recheck is a narrow addition to the existing verified package-size and internal-hash boundary.

## Intended boundary

Re-run the bounded planner for one archive at most 8 MiB and one to four OKFs at most 1 MiB each, then compare the complete deterministic schema 2 receipt with a caller-trusted earlier receipt. The receipt contains hashes and metadata, never package paths or source content. Reordering the same OKF input paths is equivalent because the planner reports root-first dependencies. A replaced, missing, oversized or symlinked package should refuse before a destination is touched.

This observes bytes **at recheck time only**. It does not lock the files, bind Registrar's later path opens, remove the interval between recheck and import, or provide atomic recovery. The caller must trust the expected receipt and recheck immediately before each import; Registrar still validates package profile, source admission, origin and policy.

## Verification

The same synthetic `local-only` actual Registrar archive/root/retracted-child fixture first plans valid packages. Recheck passes both the original and a shuffled OKF path list and returns the normalized import order and the prior plan hash. It rejects a same-path archive repack, same-path child OKF repack, a changed OKF body with a matching new internal file hash, a missing package, a final-component symlink, and malformed expected receipt before the destination has any archive or graph rows. The fixture then imports the original packages and preserves exact graph lineage and retraction. These are local pre-import observations, not a promise that Registrar imports the checked descriptors.

Focused actual Registrar fixture passed 1/1. Uncached Nx Knowledge integration passed 100/100 with the bundled Registrar source and explicit isolated Python; unit tests passed 43/43, daemonless typecheck and `nx sync:check` passed. Scoped Prettier and `git diff --check` passed. Independent read-only candidate review found no must-fix after checking strict expected-receipt shape, complete deterministic comparison, normalized order and zero destination state at refusal. Exact-head package/check and PR remain pending. No hosted Jev call or key read occurred. The five broader production finish predicates in the [Knowledge handoff](knowledge-handoff-2026-10-02.md) remain open.
