# Bounded evidence intake

Use this decision when a request needs source-backed evidence. It is local
context for continuity and review, not authenticated execution proof, a runtime
admission input, or a completion receipt. Loading instructions or announcing a
lookup does not establish that a provider, worker or evaluator ran.

## Decide and gather

Select and retain one private-data area, `work` or `personal`, before source
lookup. Shared tooling does not make private sources shared. Scope provider,
workspace, task history, output and graph selection to that area. Ask if the
area cannot be inferred; use both only when the user explicitly requests the
additional sources. Missing results never authorize cross-area fallback.

Choose one evidence need with a reason:

- `required`: material dependencies remain on documents, current external facts,
  product requirements, code behavior, source comparisons or factual verification.
- `supplied`: relevant supplied or reusable evidence covers those dependencies;
  record its identity, applicability and currentness without a redundant lookup.
- `not-needed`: the outcome is self-contained, such as a rewrite or arithmetic
  using supplied premises that do not themselves need verification.

For `required`, select a bounded question, source IDs or paths/domains, read or
result budget, and freshness requirement before lookup. Use relevant registered
sources where available, read the necessary passages, and check current
authoritative sources when currency matters. Inspect current candidate code for
application-behavior claims. Search hits, summaries, navigation notes and graph
edges guide selection; they do not establish the underlying behavior.

Honor source access, disabled provider selection and source-sharing policy.
Do not enable a provider, broaden a corpus, send local-only material to a hosted
service or substitute a model merely to fulfill this decision. If retrieval is
unavailable, retain the gap and use an allowed scoped fallback. Missing evidence
limits dependent work and claims; independent work can continue. Source intake
or refresh is conditional on capture, version retention or durable handoff needs.

## Retain a small decision

Attach the record to the actual request. Use existing task artifacts with a
`contextRefs` link when tracking is present; otherwise retain explicit
per-request local context outside the immutable plugin. Use the current host's
existing context mechanism, not a new canonical task database. Keep source
content out of the record; retain bounded references and conclusions.
Use the host-supplied request or task identity when available. Otherwise retain
the exact user request with the record so its scope can be checked; do not invent
a conversation identifier.

| Field | Retained context |
| --- | --- |
| Request | Outcome and task/request reference; work owner and method when applicable |
| Need | `required`, `supplied` or `not-needed`, with the dependency or skip reason |
| Scope | Work/personal area, question, selected sources/domains, budgets and currentness requirement |
| Observations | Actual operation names and references to retained tool/worker results; an empty list means no observed calls |
| Evidence | Citations and source revisions, hashes or snapshots where available; applicability to supported claims |
| Result | `pending`, `retrieved`, `partial`, `blocked` or `not-needed`; material gaps and unresolved decisions |

For each observation, retain the operation name and a concrete result reference,
such as a saved result path or a host tool-event ID. An operation summary alone
is not a result reference. If the host exposes no retainable result reference,
record `resultRef: null` and that limitation; do not invent one or imply that the
decision independently proves execution. Source citations still identify what
was read.

Start unresolved retrieval at `pending`. Use `retrieved` only when observed
operations support the scoped question, or when identified supplied/reusable
evidence satisfies it; the need and observations show which occurred. Use
`partial` for useful but incomplete evidence, `blocked` when the dependency
cannot be resolved within allowed capabilities, and `not-needed` for a
self-contained outcome. Update the decision when scope or dependencies change.

Retain extraction, pagination, inventory, freshness and capability gaps when
material. No useful hits establishes only the result of that bounded search,
not absence across unsearched files or the internet. A provider call alone does
not establish evidence sufficiency. Knowledge results support the answer or
owning workflow; they do not accept engineering stages or produce a QA pass.
