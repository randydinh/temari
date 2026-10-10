# Portable Temari install: evidence and remaining work

This assessment accompanies [PR #231](https://github.com/randydinh/temari/pull/231),
based on merged Temari 0.15.5. The unified package removes recipient Node,
Python, pip and uv installation from the setup journey. A portable engineering
agent also needs operating-system support, execution-host adapters, configuration
and published release artifacts. Those are separate from bundling runtimes.

## Platform evidence

The [native verification workflow](../../.github/workflows/unified-platforms.yml)
reproduces the independently pinned marketplace before running recipient checks.
Required jobs cover Linux x64/ARM64 and macOS ARM64; Intel macOS is a diagnostic
job while its dependency packaging is blocked. Windows checks native runtime
binaries and explicitly reports that installation remains unsupported.

| Platform | Executed evidence | Current limit |
| --- | --- | --- |
| macOS ARM64 | Local and native macOS 14 CI cold setup, retry/integrity, real MCP and cited Talk fixture passed. An earlier installed check also passed with a real local Ollama model. | Engineering execution still requires admitted host configuration. |
| Linux x64 | Native Ubuntu 24.04 CI passed build, cold setup, retry/integrity, real MCP and cited Talk fixture checks. | Wider Linux baselines and live engineering execution remain separate proofs. |
| Linux ARM64 | Native Ubuntu 24.04 CI passed build, cold setup, retry/integrity, real MCP and cited Talk fixture checks. | Wider Linux baselines and live engineering execution remain separate proofs. |
| macOS Intel | Native macOS 15 CI passed pinned Node, Python and Archon version checks; full package build failed on the locked Python dependencies. | `cryptography==50.0.1` has no Intel macOS binary wheel. An earlier Rosetta check also emitted Archon's AVX warning; the native version check does not establish compatibility with every older Intel CPU. |
| Windows x64 | Native Node 22.23.3, Python 3.12.15 and Archon 0.10.1 version checks passed; `fcntl` is absent as expected. | Installer refuses Windows; Registrar locking, bootstrap, venv and process control still need Windows support. |

Executed CI: [run 38063772324](https://github.com/randydinh/temari/actions/runs/38063772324),
PR head `8aaf245e`, clean synthetic merge revision
`584467c7520a6e92ddab284ba503b72eb9d8ff58`. The workflow succeeded because its
three supported-platform recipient jobs passed; the Intel diagnostic is
explicitly non-gating and failed. Per-platform manifests were:

| Native platform | Unified manifest SHA-256 |
| --- | --- |
| Linux x64 | `79e2e8019df9b3fd02b66eba0da528ec7fc40e63daae3bdcf8fe3096839bc1c6` |
| Linux ARM64 | `afda590bf30b570c97577935253261509bb953d02771592fa9ee25b31b435559` |
| macOS ARM64 | `c064d1a53684f69129c35057407f040e96290412e23adf644deed9c6d4eaf53e` |

The Intel wheel gap was verified against the upstream
[PyPI release metadata](https://pypi.org/pypi/cryptography/50.0.1/json).
The builder deliberately requires hash-locked wheels; installing a source build
on the recipient would reintroduce compiler/Rust prerequisites and defeat the
self-contained contract.

The first Linux archive attempt exposed an extractor bug: Python includes valid
case-distinct terminfo filenames. The collision guard previously folded every
path even on a case-sensitive filesystem. It now probes the actual destination
filesystem and rejects only names that alias there. Twelve focused archive
tests pass on macOS, and both native Linux jobs exercise the corresponding
case-sensitive extraction behavior. Linux archives remain correctly refused
when their case-distinct files cannot coexist on the selected filesystem.

The first CI run reproduced the exact public manifest and release inventory,
but its gzip archive digest differed from the original macOS build. CI now pins
the independently calculated original uncompressed canonical tar digest
(`8dedcec42ad3125f521b5132ce02748ce3ddd55f3e39be8ecd82d2d21ba97d9e`)
in addition to the public manifest; recipient packaging checks the original
release manifest digest. The published original archive digest remains
unchanged. A follow-up should establish compressor-independent payload
verification for archived releases and test original archives across build
hosts: the legacy archive verifier also recompresses bytes for canonicality.

Local evidence is retained under `.temari/platform-verification` and the CI jobs
upload `result.json`. A fixture response proves tool wiring, scoped registry
access and citation validation; it does not prove an arbitrary model or
provider. A binary version diagnostic does not prove an installed engineering
journey. WSL2, musl/Alpine, older OS versions and CPUs lacking the packaged
Archon binary's requirements have no recipient proof in this increment.

## What makes the engineering layer host agnostic

Keep the approved roles: Temari owns the main conversation, intent and semantic
acceptance; the workflow runtime orchestrates and retains worker progress;
Poteto supplies the engineering method; Archon executes admitted workflows as
a replaceable harness. The dashboard should expose these through Temari Talk
and the existing task/worker views, without requiring the user to manage another
coordinator chat.

Model transport already has Ollama, OpenAI Responses and Codex drivers. Execution
is less portable: the investigation and write routers select
`codex-exec-local` and `codex-exec-write-local`, and their worker implementation
requires the Codex CLI. Installing Node, Python and Archon does not provide a
different host with Codex authentication or verified worker/forge capabilities.
See [read workers](../../tools/run-codex-workers.mts),
[write workers](../../tools/run-codex-write-workers.mts),
[dashboard swarm](../../tools/dashboard-swarm.mts) and
[Codex worker adapter](../../libs/host-adapters/src/lib/codex-exec-worker.ts).

Extend the existing worker assignment/result and host-capability contracts with
a common execution adapter behind those boundaries:
capability discovery, assignment/typed write scope, pinned checkout identity,
model and tool permissions, budgets, start/observe/cancel/resume, and retained
worker evidence. Keep host-specific process and authentication behavior in
adapters, and keep this worker lifecycle distinct from Archon's run-level
`ExecutionHarness`. The runtime remains the orchestration owner. Make Codex the
first implementation of that contract, then add one
independent host and run the same admitted investigation/build/review/verify
journey through both. Preserve independent review, integration ownership and
canonical closeout; an adapter declaration is not proof of a capability.

Setup should discover installed adapters and offer a model, repository and
execution configuration journey. Today the default controller has no execution
recipes, so chat and knowledge can be ready while engineering still needs a
hand-authored `control` configuration. Provide validated starter recipes and a
doctor that reports exactly which admitted actions are usable. Credentials stay
in the user's environment or credential store.

## Changes still needed

| Area | Required change | Acceptance evidence |
| --- | --- | --- |
| Python packaging | Select a compatible locked dependency set for Intel macOS, or publish independently verified maintainer-built wheels. Preserve exact dependency hashes; do not fall back to recipient compilation. | Native Intel build, cold setup, registry/MCP and cited Talk check. |
| Windows | Add native PowerShell/command bootstrap and launcher, Windows venv paths, cross-platform Registrar locking, and safe owned-process termination. The current guardian signals POSIX process groups. | Windows install/retry, registry concurrent writes, dashboard restart, worker cancellation and child cleanup. |
| Other Linux/CPU baselines | Declare minimum libc, kernel, OS and CPU requirements; choose compatible Archon assets or document exclusions. Treat WSL2 and musl as separate validation environments. | Native recipient and actual admitted harness execution on each advertised baseline. |
| Execution hosts | Replace Codex-specific router selection with the shared adapter contract and configure supported host recipes. | One complete engineering task on Codex and another independent host, with equivalent progress/evidence and preserved admission. |
| Agent/client integration | Offer explicit per-client plugin/MCP registration adapters. The included marketplace is Codex-specific; generated stdio MCP configuration is portable only after a client connects it. | Fresh-client install and library retrieval, with capability diagnostics rather than inferred permissions. |
| Distribution | Publish per-platform archives with independently delivered digests/signatures, a small OS/CPU-selecting bootstrap, and tested download verification. Add upgrade/rollback and data export/migration. | Fresh-machine acquisition without a development checkout; failed/tampered download refusal; upgrade and rollback retain user state. |
| Installed-home relocation | Replace or deliberately migrate retained absolute paths; current installs require their original home location. Moving the extracted distribution before setup is supported. | Export/restore or home migration with retained tasks, registry and valid MCP configuration. |
| Library scope | Distinguish the working local exact-search/read/MCP baseline from optional semantic, graph, OCR and hosted-library services; add guided admitted corpus intake and optional remote-library authentication. | New source intake and cited retrieval with preserved source/privacy boundaries; each optional service has its own readiness proof. |

## Recommended next increment

First establish the Linux native recipient results and fix Intel wheel
compatibility. Then deliver the execution-adapter contract with Codex and one
independent host, plus configuration recipes, so the main Temari conversation
can start admitted engineering work on either host. Native Windows should be a
separate OS-support increment with process/locking tests. Publish a universal
bootstrap only for platforms whose complete recipient journey has passed.
