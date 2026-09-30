# Local intake-to-retrieval evaluation

This is an operator-run, two-responsibility flow over explicitly registered local
Registrar sources. Intake can capture and publish; search receives only an immutable
handoff and can discover, read and revalidate retained snapshots. Neither command
scans for new sources or executes instructions found in documents.

## Prepare admitted sources

Create a private, canonical task directory and a Registrar workspace outside this
repository. Register each selected source root with Registrar's `sources add` command.
Use curated copies when a repository or personal folder contains files outside the
evaluation grant. Keep the original path, revision and SHA-256 in a private source
manifest. Do not commit source copies, local reports or credentials.

Use the source IDs returned by registration in an intake plan:

```json
{
  "task": {
    "id": "local-eval",
    "directory": "/absolute/private-task",
    "authorityRef": "/absolute/private-source-manifest.json"
  },
  "intakes": [
    {
      "task": {
        "id": "local-eval",
        "directory": "/absolute/private-task",
        "authorityRef": "/absolute/private-source-manifest.json"
      },
      "source": {
        "provider": "local-eval",
        "id": "REGISTERED_SOURCE_ID",
        "locator": "file:///absolute/selected-root"
      },
      "readScope": "source-root",
      "transport": {
        "python": "/absolute/python",
        "registrarSource": "/absolute/content-registrar",
        "workspace": "/absolute/registrar-state"
      },
      "requestKey": "corpus-v1"
    }
  ]
}
```

From the Temari workspace root, with frozen dependencies installed:

```sh
pnpm nx run knowledge:demo -- journey-intake --input /absolute/intake-plan.json
```

Keep the returned `handoffPath`. A blocked capture produces no handoff. Intake
persists its attempts, publications and capability gaps in the task directory.

## Search and score

Write a separate search plan. Gold paths are explicit annotations, not text
extracted from the source. Each case narrows the handoff to listed source IDs.

```json
{
  "handoffPath": "/absolute/private-task/archive-handoff-HASH.json",
  "cases": [
    {
      "id": "known-answer-1",
      "query": "example search terms",
      "sourceIds": ["REGISTERED_SOURCE_ID"],
      "expected": [
        { "sourceId": "REGISTERED_SOURCE_ID", "path": "relative/document.md" }
      ],
      "topK": 4,
      "discoveryMode": "bm25",
      "hostedTextApproved": false
    }
  ]
}
```

```sh
pnpm nx run knowledge:demo -- journey-search --input /absolute/search-plan.json
```

`expectedRecallAtK` measures whether the annotated documents appear in the ranked
top K. `shortlistVerified` means each selected document yielded a first excerpt
whose archived SHA and read check were accepted. It does **not** mean full-document
coverage or a correct answer. The private shortlist checkpoint retains up to 1,000
codepoints per selected document with exact evidence IDs and checks; the report
contains no source excerpts. `sourceCapabilityGaps` and case `gaps` must be read
alongside scores. A first-page continuation leaves `discoveryExhausted: false`.
`timingMs` separates discovery, excerpt reads and Jev from total case time;
compare modes on the same pinned handoff and budgets.

Jev receives no text when `hostedTextApproved` is false. A true value authorizes
the case's verified excerpts for the server-side `TYPESAFE_API_KEY` call and still
produces shadow advice only. Do not set it for private corpora without an explicit
sharing decision. The first live check should use synthetic text. Missing key,
network or invalid response leaves judgments `unknown`.

For an optional graph ablation, set `graphId` on a search case to a published
Registrar graph ID covering the selected archive publications. The report keeps
`ranked` and `expectedRecallAtK` as the lexical baseline and adds `graph.ranked`,
`graph.expectedRecallAtK`, relationship provenance and explicit gaps. The trial
uses the first lexical hit as its seed and verifies at most `topK - 1` one-hop
related documents through the same archived provider. Its ordering is an
experimental policy, not a default ranker or evidence of semantic correctness.
No graph quotations or source excerpts enter the report; a private checkpoint
retains verified graph evidence. A missing/stale graph leaves lexical results
available and records a gap.

This loop measures local archive, exact/BM25 ranking and bounded evidence reads.
Native Graft structure, Graphify non-code extraction, image interpretation, a
scheduled pair of autonomous agents and semantic answer quality remain separate
capabilities to implement and evaluate. The archive preserves unsupported files
with gaps rather than claiming their contents were understood.
