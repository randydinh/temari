# Pinned Python Graft call-name pilot, 2026-10-01

## Result

The current adapter was rerun against the prior 43-file non-Nx Python archive
and its pinned Graft artifact. It published 286 relationships: 205 existing
containment edges and 81 newly verified `call-name-candidate` edges. Each new
edge has two archive anchors, including the exact AST call-name token. It
means a caller contains a spelling that matches a visible, module-level
declaration in the same file; it does not prove runtime dispatch or resolved
callee identity.

The receipt explicitly omitted 180 import edges whose module-name targets
have no Graft node ID, 30 other unresolved edges, and 456 relations that did
not meet verification rules. The private source paths, artifact, graph draft
and receipt remain outside Git. No hosted model was called.

## Limits

Temari knowledge typecheck and all 38 Registrar-backed integration tests
passed on the final candidate. The focused Python fixture includes positive
same-file calls and negative strings, comments, nested scopes, pattern
captures, inaccessible targets, module rebinding and cross-file name matches.

The Python AST helper parses bounded, retained, hash-matched source in an
isolated subprocess. The adapter skips cross-file name matches, nested and
inaccessible target declarations, shadowed/rebound names, attribute calls,
multiple matching call tokens and parse failures. Python import-to-file
relationships still need explicit module roots, unique admitted target mapping
and an AST-confirmed import statement before they can be published as
candidates. The graph retrieval diagnostic gate remains opt-in and does not
make these relationships a default ranking signal.
