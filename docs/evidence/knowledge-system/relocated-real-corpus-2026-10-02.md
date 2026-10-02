# Relocated Mac real-corpus execution, 2026-10-02

## Boundary and fixed input

This is a bounded local execution on an existing copied private corpus, not a
held-out answer-quality evaluation. A clean detached checkout at
`e18521a85c2f035eb39ad192ec88964e9c664470` built the public-entry package
through Nx; the source manifest reported `dirty:false`. Nx
`workflow-runtime:check` passed. The package was moved to a separate temporary
location and passed the public-entry artifact check both before and after the
run. Its stock-Node Knowledge exports loaded. No corpus file, question,
source path, raw report, or credential is in this repository.

Before any query, a deterministic private SHA-ranked selection fixed five
non-Nx files (two Python, two Markdown, one TOML), six mixed documents
(Markdown, HTML, DOCX, PNG and two PDFs), and five Nx files (two TypeScript,
two Markdown, one JSON). The private sample manifest SHA-256 is
`929194d61279bd622516fa9d111671e2ee907102dd82cf51660a0fdad571d891`.
The package manifest SHA-256 is
`afe8513cfcfb9f8d3e151fbde9980bdace8db91ec8cf4ab040fbb642f622d4af`.
The bundled Registrar payload identity checked by setup is
`066cab5179b726d94dfc8d3e8286033ff5e6c2650b0c66a7d4d7a34c414bda88`.

## Installed journey and verification

Cold setup installed the bundled Registrar into a fresh temporary home with
its registry and archives outside the package. Its installation receipt SHA-256
is `38cc5e9d4c2ecd35a630546e43e97e92a1553172e946c1d671e40e7329db39ce`.
The installed path registered all three selected roots as `local-only` and
published a three-source Knowledge intake handoff, SHA-256
`a771b93a9c1828b0f8f2a61bc6f3a2c25bb2505ecc4024aaf7d0a0ac35ca7be9`.
All three publications reported `complete-admitted`; Registrar inspect
matched the SHA-256 and byte count of all 16 selected originals. Their
publication SHA-256 values, in non-Nx, mixed, Nx order, are:

| Family | Publication SHA-256                                                | Originals |
| ------ | ------------------------------------------------------------------ | --------: |
| Non-Nx | `e66b5623ee8413e55fb2073a344d3a563549e33ec81de1987f027212f3de0c95` |         5 |
| Mixed  | `96e5a7d5a3d7c88b76030a88dd346c488f3de77db9c03a3f1f24290ba3816d1d` |         6 |
| Nx     | `9ce49708145b6e1f393ecdca3e2d341b5a5d5b1fc965b537fd25ec937353bce9` |         5 |

The private query plan was fixed before execution (SHA-256
`36e44c98807639e7d7e292af398dc418b68b84557c917ca12311c89cb3629191`).
One diagnostic BM25 query per family ran through the installed Knowledge entry
at top K 3. Each returned one result and one verified first excerpt. For all
three, a separate pinned Registrar read matched the returned citation's
source, generation, manifest, path, original and representation hashes,
code-point span and exact quote. The query report SHA-256 values, in the same
family order, are:

| Family | Ranked / citations verified | Report SHA-256                                                     |
| ------ | --------------------------: | ------------------------------------------------------------------ |
| Non-Nx |                       1 / 1 | `cff7b64c3832c3b6b0f08a4385cd1f448ccee0a04ab619460989d99bf02b4213` |
| Mixed  |                       1 / 1 | `024498d84dc18d11d025ccba3d27b36198e88eec8bc1cf5667e3a4104d303130` |
| Nx     |                       1 / 1 | `805d9dde48e3686f8a506fc9b1d326f02a679007bcd138879d858d277b0f6c78` |

A fourth, fixed nonce no-answer diagnostic across all three sources returned
zero ranked items and zero evidence. Its report SHA-256 is
`53c31d7464445342e8da74e2efb551e7ebb571e1bbf49c0385ae77e0166107d2`.
The exact archived PNG and one PDF recovered to the selected original byte
counts and SHA-256 values
`6034b07cbcd8075a4a7b3c3ecc67cd716b68810fcedb73ff22f989a026674a00`
and `e4d72356bde3a701c8d4669b90118f20352b7b7f61ce2269ae09690fe9b439ee`.

`TYPESAFE_API_KEY` was unset throughout execution. A private failing
`security` shim recorded zero calls; the reports marked the sources
`local-only` and recorded zero hosted requests. No TypeSafe Jev call or
Keychain read was made.

## Explicit gaps

All 16 originals were retained, but the six mixed documents did not all
yield text. Both PDFs reported `pdf-memory-boundary-unavailable` under this
default Mac capture, and the PNG reported `unsupported-format`; these three
had no text representation. The mixed documents also retained explicit
`visual-evidence-unavailable` gaps. Across the three publications, nine
capability gaps had kind `unsupported`. Byte recovery proves preservation of
the chosen PDF and PNG, not their text or visual meaning.

The four queries are agent-selected diagnostics on copied material. Their
one-result shortlists do not prove answerability, independent held-out
quality, no-answer correctness, ranker promotion, semantic graph quality,
continuous freshness, production losslessness, Windows behavior or end-user
plugin lifecycle. The broader Knowledge finish predicates remain open.
