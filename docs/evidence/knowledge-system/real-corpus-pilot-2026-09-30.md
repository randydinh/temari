# Knowledge journey: bounded real-corpus pilot

Date: 2026-09-30. Candidate: Temari `3845553a125bfd0511ef69060db64fe3a1a85bc7`; Registrar `26d15e137a80f769ccf462a85f6439150dc6fac4`.

This was a local, revision-pinned evaluation. The corpus and receipts remain in a private temporary workspace. No source text, local path, credential, or private repository identity is included here. The three source snapshots were a Temari Nx checkout (672 tracked files), a small Python repository without Nx (88 tracked files), and six selected Markdown, HTML, DOCX, PDF, and PNG documents. The latter includes two PDFs and one image. Each source was explicitly registered and captured. The original bytes were retained; `complete-admitted` means all admitted originals were preserved, not that every format was searchable.

## Observed journey

| Stage | Result |
| --- | --- |
| Registration and capture | 309 Temari files, 64 Python-repository files, and five of six document files received text indexes. All three sources published immutable archive handoffs. The PNG retained its original but had no text representation. |
| Exact and BM25 discovery | At top 3 on nine fixed target-file questions, exact found 3 targets and BM25 found 4. The evaluation questions are a diagnostic sample, not a held-out task-quality benchmark. All returned shortlist excerpts passed archive revalidation. |
| Jev | Three registered-source BM25 cases sent six bounded, verified excerpts to TypeSafe using the Keychain key. All six returned typed `jev-1.13.0` judgments. Jev remained a shadow signal and did not invent or replace evidence. |
| Nx structure | The real Nx project graph published 18 archived, source-anchored dependency relationships; four candidate edges lacked sufficient anchors. A one-hop query recovered a target at top 3 that lexical ranking missed (recall 0 to 1). |
| Graft structure | Graft 0.20.0 parsed all 43 Python files into 348 nodes and 952 candidate edges. The adapter published 205 verified relationships, with 210 unresolved-node and 537 unverified-relation skips. These skips include unsupported Python call/import relations; they are not accepted as graph facts. |

The pilot exposed two implementation defects, reproduced before repair: Nx project IDs need not equal scoped package names, and a graph trial that uses only lexical rank 1 can miss an anchored seed lower in the shortlist. The candidate now checks Nx's declared package name against the retained package manifest and chooses the first connected, archived lexical seed without changing the lexical order. The Graft importer now reuses each verified archived file read within a publication. On this corpus, the 200-edge publication fell from roughly 74 seconds before that change to 10 seconds after it. The importer also reports any edges left unexamined by its explicit edge budget. A 400-edge budget covered the entire candidate graph without truncation and published 205 verified relationships in roughly nine seconds. These are local observations, not general performance guarantees.

## Open capability gaps

- Both PDFs retained original bytes but had no archive text representation because this macOS host could not establish the worker's hard PDF memory boundary. The PNG also retained original bytes but was explicitly unsupported for OCR and visual search. Image-bearing DOCX text was indexed, while embedded visual meaning remains unverified.
- BM25 at top 3 missed several target code files, including the fixed Temari and Python code cases. Jev cannot recover a file absent from the shortlist. Larger, held-out questions and candidate-generation improvements are required before assigning a retrieval default.
- The Graft adapter validates file containment and narrowly supported calls; Python cross-file calls/imports still need a conservative, source-anchored verifier. Native Graphify semantic extraction was not run because the available path uses Gemini or the host model for non-code content, while this system is limited to Jev for hosted model work.
- Intake and search have a durable handoff, but automatic agent scheduling, reviewed relationship correction, query feedback, and default plugin install/disconnect/uninstall/reinstall are not implemented yet.

## Optional PNG OCR follow-up

Registrar PR #4 added explicit on-device macOS Vision OCR for bounded PNG captures. On the same selected document copies, it retained the image original, stored a 751-character OCR representation, and BM25 found the PNG at rank 1 for a term present in the diagram. Temari intake published the OCR-mode handoff; the selected excerpt passed archive revalidation and received one live `jev-1.13.0` shadow judgment. The receipt still marked visual meaning unavailable and the transcription unreviewed. The initial pilot numbers above describe the ordinary capture mode and remain unchanged. The on-device Vision run needed macOS permissions outside this agent's filesystem sandbox; the behavior is not yet proven on other hosts.

## Verification

The candidate passed `pnpm nx run knowledge:typecheck`, `knowledge:test` (36), `knowledge:integration` (29), and the direct four-test archive graph integration file. The real-corpus capture, exact/BM25 evaluation, TypeSafe responses, Nx graph import, and Graft import were executed separately against the pinned snapshots. Only the candidate-bound results above are claimed.
The OCR follow-up passed the updated `knowledge:typecheck`, `knowledge:test` (36), and `knowledge:integration` (30) targets. Registrar's full suite passed 321 tests at that increment and 322 after the graph-review increment.

## Retrieval and graph review follow-up

An offline candidate combined whole-document BM25 with 1,600-character passage BM25 by reciprocal rank fusion. It found six of nine fixed expected files at top three, versus four for the current BM25 route. On a separate 11-question code set created after the first comparison, both routes found six expected files at top three. The fixed sample includes a PDF without extractable archive text on this macOS host and a PNG captured before the optional OCR mode. This is insufficient evidence to replace the current ranker, so no default changed.

Registrar PR #5 added explicit assertion retraction against a pinned parent and source scope. A Temari integration test now exercises a reviewed retraction through the actual Registrar CLI, confirms the parent remains active and the child is retired, and verifies the child still reads after the original source directory is removed. This is a manual correction path; automatic graph feedback and a blind review loop remain future work.

## Merged-code end-to-end rerun

After Registrar PRs #4–5 and Temari PRs #109, #111–112 merged, a fresh task captured all three selected source families under the current implementation identity: the pinned Temari Nx snapshot, the pinned non-Nx Python snapshot, and the selected document copies. The intake published three archive receipts and one Nx structure graph. A separate current-implementation Graft publication accepted 205 archived, source-anchored relationships, with 210 unresolved nodes and 537 unverified relationships omitted.

All 18 fixed search cases completed with verified shortlists. At top three, exact found four of nine expected files and BM25 found five of nine; the additional hit in each route came from the explicitly enabled on-device PNG OCR representation. Four cases also produced graph trial results. A fresh three-case live TypeSafe run produced six typed `jev-1.13.0` judgments from verified excerpts, all in `judged` state. The key came from macOS Keychain service `temari-typesafe-jev` and was supplied only to the child process; no Vercel credential or other hosted model was used. The selected corpus and detailed receipts stayed in a private temporary workspace, outside version control.

This establishes a working local end-to-end pilot, not full document coverage or production readiness. The two selected PDFs still retained originals but had no searchable archive text on this macOS host because the worker could not establish its hard memory boundary. PNG OCR transcribes text without proving visual meaning. Graphify's available non-code semantic route requires a different hosted/host model and was not run under the Jev-only rule. Agent job ownership, durable scheduling, feedback-driven corrections, and plugin lifecycle are still absent.

## Next build order

1. Add a bounded PDF text path that works on macOS without dropping the hard worker boundary; test searchable, scanned and image-only PDFs, and keep unsupported pages explicit. Broaden image/Office asset accounting after that.
2. Create a sealed, source-scoped question set across code and documents. Compare exact, whole-document BM25, passage challengers, graph expansion and conditional Jev at equal candidate and byte budgets; promote only measured gains without regression on a second cohort.
3. Add conservative Python Graft call/import verification. For non-code, derive source-anchored candidates locally and use Jev only for bounded choice judgments; retain Graphify's useful projection/query role without invoking another hosted model.
4. Route intake and search as separate runtime-owned jobs with leases, retries, immutable handoffs and revision-bound feedback. Feed missed evidence and reviewed relationship corrections into repeatable regression cases; keep model judgments separate from publication authority.
5. Add operations for source refresh, archive retention/export, capability health and Keychain-backed TypeSafe configuration. Exercise source disable/local-only, recovery, and implementation upgrade paths on each supported host.
6. After those journeys and regression gates pass, package Temari Knowledge as a default-installed optional plugin. Provide disconnect, uninstall and reinstall with preserved archives/audit history by default, explicit purge separately, upgrade-stable preferences, and no silent model substitution.
