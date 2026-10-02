# Negative shortlist feedback, 2026-10-02

An operator can record either `shortlist-excerpts-unanswered` for every ranked,
verified first excerpt in an operational query, or `empty-shortlist-observed`
when that query returned no ranked documents. The new content-addressed local
receipt pins the query report, intake handoff, discovery checkpoint, selected
source publications and, for a nonempty shortlist, the shortlist checkpoint.
It derives all ranked document pins from the report and rereads and revalidates
each one against the retained archive. There is no reviewer-selected subset.

The observation covers at most the **first 1,000 code points of each ranked
document**, under the recorded top-K and source scope. `fullDocumentRead` and
`corpusAbsenceClaim` are both false. An empty returned page is an observed
query-page miss, not proof that the archive or outside sources lack an answer.
No graph assertion, ranker default, Jev judgment or hosted model call is made
by the feedback recorder. The existing positive feedback input and receipt
remain unchanged.

Focused actual-Registrar integration exercised a two-document BM25 shortlist,
an empty exact shortlist, a current sharing change to local-only, positive
receipt compatibility, mismatch and tamper refusals, and current source
revocation. The four focused cases passed with the actual bundled Registrar.
The full `pnpm nx run knowledge:integration` suite then passed 77/77 using the
actual Registrar; `knowledge:test` passed 43/43. `pnpm nx sync:check` and
`knowledge:typecheck` passed on the
same worktree. An initial focused run used `--skipSync` after a transient
workspace sync warning; the final checks did not require that flag.
Synthetic reviewer labels do not establish answerability quality or an
authenticated human review. A real held-out no-answer evaluation remains open.
