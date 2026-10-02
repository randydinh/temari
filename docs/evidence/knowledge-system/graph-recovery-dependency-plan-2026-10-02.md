# Read-only recovery dependency plan, 2026-10-02

## Hypothesis

The existing actual Registrar replay imports an archive bundle, a root OKF
graph package and a retracted child OKF package in a known working order. An
operator choosing packages has no separate pre-import view of which archived
generation each graph declares or whether the supplied parent chain is
complete. A bounded, read-only dependency plan can expose that missing-package
or ordering problem before a destination is changed.

The alternative considered was a PDF embedded-image declaration inventory.
The current hard-bounded PDF parser runs in a pinned Linux guest on this Mac;
a reliable page-resource inventory requires a bounded parser result contract.
Scanning raw PDF bytes would miss compressed object streams and could falsely
report that no image was declared. That work remains open.

## Contract

The plan accepts one Registrar archive-only JSON bundle at most 8 MiB and one
to four archived-graph OKF JSON packages at most 1 MiB each. It reads a regular
file through one descriptor with a byte cap and final-component symlink refusal.
Ancestor-directory symlinks are outside this boundary. It reports only hashes,
byte counts and declared source/generation,
manifest, graph, RevisionSet and parent identities. Every graph selector must
match an archive envelope, and the graph packages must form one complete,
acyclic, root-first parent set. No package path, source text, graph label, quote or
original bytes enter the receipt.

This is **declared dependency closure only**. The plan does not import, mutate
or validate all archive blobs, OKF profile content, source registration,
access grants, origin binding or erasure policy. Registrar's actual import
remains the authority for those checks. The packages are separate files, so
the plan also does not make a backup atomic or establish recovery time or
data-loss objectives. The receipt does not bind a later import to the same
path bytes; an operator must recheck each package hash immediately before
import. These deliberately small caps also exclude otherwise valid larger
Registrar exports: Registrar's archive bundle limit is 192 MiB and its OKF
export limit is 32 MiB.

## Verification

The existing synthetic `local-only` actual Registrar fixture exported one
archive bundle, one root OKF and one child OKF with a retracted assertion.
Given child before root, the planner returned archive, root, child package
hashes in dependency order. The fixture then imported those exact selected
packages into a fresh pre-provisioned Registrar workspace and retained its
previous exact graph IDs, parent, records, projection and retraction checks.
The planner performed no import; the destination remained empty during all
planning and refusal cases.

Focused actual Registrar integration passed 1/1. Negative cases refused a
missing archive, graph selector outside the bundle, a missing second selector
after a valid first one, orphan/duplicate/cyclic graph declarations, oversized
archive and OKF packages, and a final-component symlink. A modified OKF file
body passed declared dependency planning but was refused by Registrar's
actual import, demonstrating the `payloadIntegrity: not-validated` limit.
Uncached Nx Knowledge integration passed 100/100, unit tests 43/43,
daemonless typecheck and sync passed, scoped formatting and diff checks
passed. Independent candidate review found no must-fix after the second
selector and boundary corrections. Clean exact-head package/check and PR
remain pending. No hosted Jev call or key read occurred. The five broader
production finish predicates in the
[Knowledge handoff](knowledge-handoff-2026-10-02.md) remain open.
