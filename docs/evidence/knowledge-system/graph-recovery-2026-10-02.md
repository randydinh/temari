# Paired archive and root graph replay, 2026-10-02

## Result

An actual bundled-Registrar CLI fixture exercised separate archive and OKF
graph export/import for one synthetic `local-only` source. It captured two
text originals and published one parent-null graph with two anchored mention
nodes, one anchored relationship, and one exact RevisionSet. A fresh
destination workspace was pre-provisioned with the same source ID, root and
local-only access through a SQLite backup **before** the capture. The archive
package and graph OKF package stayed in the fixture's temporary directory,
outside Git. The OKF includes labels and quotes and must be treated as source
content, not a metadata-only receipt.
The fixture deletes its temporary workspace and both packages in a `finally`
block, including after an assertion failure.

Importing the graph before the archive refused and left zero archive,
RevisionSet and graph generations. Importing the archive first, then the OKF,
recovered the exact graph and RevisionSet IDs. The imported read returned the
same three records and anchors as the original graph. The imported derived
projection matched byte-for-byte as canonical JSON, and Registrar's
`graph-check` verified the projection on both workspaces; it did not produce
a native Graphify proof.

After one live original was edited and the other deleted, the destination
still returned the pinned archived text, original and representation hashes,
citations, graph records and projection. Registrar recovered both original
files to their exact captured bytes. Tampering with an archive blob refused
without publishing a generation. Tampering with an OKF file refused without
publishing a graph. A disabled destination registration refused graph import;
disabling the successfully restored source also refused graph read, projection
and OKF export. Import did not re-enable or change the pre-provisioned access
setting.

## Verification

The focused actual-Registrar integration test passed 1/1. The uncached
`knowledge:integration` run passed 100/100, `knowledge:test` passed 43/43,
`knowledge:typecheck` passed, and `pnpm nx sync:check` reported an up-to-date
workspace. A daemonless sync check initially found one missing generated
runtime project reference; Nx sync added only that reference, and the final
daemonless check passed. Scoped formatting passed. This recovery fixture used
only synthetic text, temporary packages and local CLI calls; it did not read
a TypeSafe key or invoke Jev. Independent read-only candidate review found no
remaining must-fix. Clean exact-head package verification and PR delivery
remain separate gates.

## Limits

This is a one-root, one-source recovery invariant, not a production backup
system. Archive and OKF exports are separate operations and are not an atomic
snapshot pair. The proof does not restore source policy, access grants, erasure
state, child graph history, retractions, arbitrary derived views, or external
Graphify data. It establishes no RPO/RTO, Windows behavior, semantic graph
correctness, or production losslessness. A caller must retain and protect both
packages and independently provision the destination registration.
