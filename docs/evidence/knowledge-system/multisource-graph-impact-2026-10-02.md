# Bounded multi-source graph impact, 2026-10-02

## Question and chosen scope

An exact graph may cite several registered sources. The existing single-source
impact plan refuses that graph after one source is recaptured. A separate
read-only planner now accepts two to eight complete, uniquely identified old
publications, one changed source's complete new publication, and the old graph
ID. The alternative considered in the run plan was persistent BM25 caching;
that would change Registrar storage and protocol and needs measured latency
evidence. This increment stays within Knowledge's retained graph read and
generation-diff contracts.

## Observed actual Registrar fixture

The fixture registers and captures A and B in one local workspace with
`local-only` source admission, publishes an exact two-source graph, and
retracts one cross-source assertion. It changes a file in A, removes another,
adds a third, then captures A v2. The planner uses the pinned A v1/v2 diff and the entire
old two-source RevisionSet. A cross-source relationship supported only by
unchanged B evidence enters `needsReview` because its A endpoint changed. A
relationship supported by changed A evidence also enters review. A removed
anchor and a relation with that endpoint enter review. Unchanged A
and B records enter `needRepin` as **candidates only**. The retraction remains
`historicalOnly`; A's added and changed paths enter `needDiscovery`.

The historical graph remains readable under A v1+B v1 and refuses under A
v2+B v1. The test also refuses a one-source input, nine source slots, duplicate or absent changed
source, a graph from the wrong RevisionSet, substituted B v2, tampered B v1
publication, and disabled B registration. The saved receipt omits source
text. It pins publication hashes, graph ID and RevisionSet ID, diff receipt
hash, record IDs, changed path names and counts; its explicit status is
`plan-only`, `currentOriginal: not-checked`, and `graphMutation: none`.

## Verification and limits

The focused actual Registrar test passed 1/1 with the workspace's pinned
Registrar source and local Python. `pnpm nx run knowledge:typecheck
--skipNxCache` passed. Knowledge unit tests passed 43/43, Nx sync and diff
checks passed. An independent read-only router review found no must-fix issue
in the initial candidate; the reviewer suggested the removed-anchor and
nine-source refusal cases now present in the final fixture. The final uncached
Nx integration rerun passed 95/95, including the strengthened actual Registrar
case. No hosted TypeSafe Jev call was made. This
receipt does not repin or publish a graph, validate semantic
relationships, infer transitive dependencies, prove current source bytes,
establish rendering or visual meaning, or change the existing single-source
impact and repin contracts. The broader production and PDF visual-coverage
gates stay open.
