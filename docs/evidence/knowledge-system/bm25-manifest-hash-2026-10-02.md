# Per-discovery manifest hash reuse, 2026-10-02

## Hypothesis and scope

Actual Registrar archive discovery hashed the full selected manifest for the
continuation binding, then serialized and hashed that same manifest again for
each represented document. Reusing the binding hash within the same call should
remove repeated work while leaving archived source validation, response
recheck, manifest pins and retrieval order intact. This is a local calculation
change, not a persistent cache or a change to BM25 ranking.

The alternative considered was a paired archive/graph backup preflight. That
needs a separate consistency, policy and erasure contract, so it was deferred.

## Actual Registrar observation

The opt-in fixed-source diagnostic from [the preceding baseline](bm25-cost-2026-10-02.md)
was rerun on the same macOS arm64 host with Python 3.12.13 and SQLite 3.53.1.
Both runs used one synthetic `local-only` source, three pinned generations
containing 100, 500 and 1,000 small documents, the same query, one warmup and
seven measured samples per size. The fixture helper digest, capture limits,
selected text-and-path byte totals, query term count, result limit and
response budget matched across reports. Each run independently verified 48 pinned
top citations against the retained archive and checked that its BM25 index
digest stayed stable across routes and samples. The raw reports stayed outside
the repository; their SHA-256 digests are
`936ea3e1f28c3f45a1672e9582064d727528577b75b1ff0378df130809d8c18c`
(before) and
`560707e54d78e19d13adb89c7c00b6aa594f5688db9422ecf2aac2421ef47e81`
(after). The index digest values differ **between** runs because each creates
fresh source and generation identities; their within-run stability and pinned
citations are the relevant checks.

| Documents | In-process discovery median before → after | Wrapped BM25 helper median before → after | Fresh CLI median before → after |
| --------: | -----------------------------------------: | ----------------------------------------: | ------------------------------: |
|       100 |                          41.401 → 7.007 ms |                          0.656 → 0.602 ms |            127.202 → 111.475 ms |
|       500 |                        846.399 → 30.857 ms |                          1.915 → 1.854 ms |            912.024 → 133.942 ms |
|     1,000 |                       3276.202 → 59.601 ms |                          3.421 → 3.380 ms |           3355.173 → 163.838 ms |

The changed path plausibly explains much of the in-process reduction, but
these are sequential observations on one host with newly generated archive
identities and ordinary runtime variation. The fresh CLI route includes process
startup. The difference between total discovery and wrapped rank-helper time
still contains mixed archive, response and Python work; it is not a pure
validation cost. These measurements set no SLO and do not choose a cache,
default ranker or hosted model.

## Verification and limits

The expanded two-source actual Registrar fixture exercises exact and BM25
pagination, manifest pins, exact and ranked ordering, stable within-run BM25
index digest, cross-mode continuation refusal, disabled source refusal and
tampered-manifest refusal. `_selection` and `_load` validation and the final
`_recheck` remain in place. No TypeSafe key was read and no Jev call occurred.

The installer package initially refused the source change because its pinned
Registrar payload inventory still held the previous file hash. The reviewed
candidate updates that file's inventory digest and both existing pins for the
resulting manifest digest; the payload verifier's focused tests pass. This
maintains the bundle's integrity check and does not alter upstream attribution.

The actual Registrar and Nx checks are recorded in the overnight decision
log. Exact-head package/check and review are pending. This does not establish
answer quality, continuous graph correction, visual meaning, production
recovery, Windows operation or a production lossless system.
