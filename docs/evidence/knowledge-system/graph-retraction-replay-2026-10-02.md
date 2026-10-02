# Ordered root and retracted-child graph replay, 2026-10-02

## Scope and result

An actual bundled-Registrar CLI fixture extends the paired archive/root graph
recovery proof to one child generation. One synthetic `local-only` source has
two retained text originals. The root graph contains two anchored mention
nodes and one anchored relationship. Registrar's `graph-retract` creates a child
that keeps the same RevisionSet, nodes, anchors, and assertion identity while
marking the relationship `retracted` and pinning the root as its parent.

The fixture exports the archive, root OKF, and child OKF as **three separate**
packages. A fresh destination workspace is pre-provisioned with the same source
registration and local-only setting before the source capture. Archive, root,
then child import reconstructs exact graph IDs, RevisionSet ID, child parent,
record identities, and the durable retraction row. Source and destination graph
ledger IDs and stored-byte hashes match. Both derived projections match their
source counterparts, and `graph-check` verifies each projection. After one live
original changes and the other is deleted, historical graph reads, archive
reads, and byte-exact recovery still work.

Importing the child before its root refuses without graph, record-identity or
retraction rows. Reimporting the exact root after the child leaves the
retraction intact. A distinct new child that tries to reuse the retired
assertion ID as active refuses without publishing state. Tampering with the
child OKF refuses before graph publication. A disabled destination source
refuses child import; disabled source access also refuses graph reads and
exports. The packages contain labels and anchor quotes, so they remain in the
fixture's private temporary directory and are removed in `finally`, including
on assertion failure.

## Verification

The new actual-Registrar case passed within the final uncached Nx Knowledge
integration run (100/100, zero failures). `knowledge:test` passed 43/43;
`knowledge:typecheck`, daemonless `pnpm nx sync:check`, scoped Prettier check,
and `git diff --check` passed. The fixture uses synthetic text, the local
Registrar CLI, and no hosted Jev call or TypeSafe key read. Independent review,
clean exact-head package verification, and PR delivery remain separate gates.

## Limits

This proves one ordered, one-source, root-plus-child lineage replay. The three
exports are not an atomic backup. It does not restore source registration,
access grants, erasure state, arbitrary graph history, external Graphify state,
or other derived views. It establishes no production RPO/RTO, Windows behavior,
semantic graph correctness, or lossless knowledge-system claim. A caller must
protect all packages, pre-provision the destination source, and import in
dependency order.
