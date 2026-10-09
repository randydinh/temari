# Credits and provenance

Temari is built by adapting proven ideas and source material while keeping the
origin and current owner of each layer visible. This page is the human-readable
map; the package inventory and source files remain the authoritative technical
record.

## P-stack — Lauren Tan

Thank you to **Lauren Tan** ([@poteto](https://x.com/poteto)) for creating
[P-stack](https://github.com/cursor/plugins/tree/main/pstack). Temari vendors
and adapts P-stack's conversational engineering workflows, including Poteto
and its playbooks. The imported baseline is the P-stack revision
[`c1c0a32802223f4be824112dd83d33ad29a8b26c`](https://github.com/cursor/plugins/tree/c1c0a32802223f4be824112dd83d33ad29a8b26c/pstack),
version 0.15.2, under the MIT license (Copyright 2026 Lauren Tan).

The shipped copy lives under
[`packages/workflow-runtime/assets/v4.1/`](../packages/workflow-runtime/assets/v4.1/).
Read its [upstream record](../packages/workflow-runtime/assets/v4.1/UPSTREAM.md)
and [license](../packages/workflow-runtime/assets/v4.1/LICENSE) when reusing or
redistributing it. Its `provenance.json` inventory records the selected files,
source and artifact hashes, and every intentional Temari transformation.

## Temari's Nx-native work

Temari owns the product-specific Nx platform around that imported workflow:

- typed plans, contracts, and the canonical workflow engine;
- durable runtime records, evidence binding, and closeout semantics;
- honest, replaceable host adapters and the initializer;
- package, migration, verification, and integration boundaries.

Those additions do not relabel P-stack as Temari. The ownership boundary is
described in the [P-stack capability index](pstack-audit/index.md) and the
[v4.1-to-Nx compatibility matrix](migrations/v4.1-to-nx-matrix.md).

## Other upstream components

- **Archon** is an optional, pinned execution-harness dependency from
  [coleam00/Archon](https://github.com/coleam00/Archon). Temari downloads a
  verified release asset; it does not present Archon as Temari code or as a
  P-stack fork. See the [harness decision](decisions/2026-09-22-archon-harness.md).
- **Content Registrar** is a versioned snapshot from
  [`randydinh/content-registrar`](https://github.com/randydinh/content-registrar),
  recorded with its commit and file hashes in
  [`packages/workflow-runtime/registrar/UPSTREAM.json`](../packages/workflow-runtime/registrar/UPSTREAM.json).
  It is a Temari-owned companion repository, not a third-party fork.

The current shipped-runtime records identify P-stack as the external forked
source. Research sources and optional integrations are not automatically
vendored or treated as installed capabilities; their boundaries remain in the
relevant source manifests and design documents.

## Preserved avatar

The [avatar created for Temari](assets/temari-avatar.png) is retained here from
the avatar chat. This preserves the design asset; wiring its display and
distribution across host adapters remains unfinished work.
