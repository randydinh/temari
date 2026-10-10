# Intel compatibility and shared worker execution

Authorized on 2026-10-10, on branch `codex/portable-execution-adapters-20261010`
from `3b8ab4a7`. PR #231 remains open; this increment is stacked on its reviewed
unified-install work. Task `temari-unified-install-20261010` retains the actual
chat and previous evidence. The local code graph is unavailable; the P-stack
capability index and bounded current-source inspection supply navigation.

## Product boundary

Temari remains the main chat and owns intent and semantic acceptance. The
workflow runtime is the Orchestrator behind the scenes, retaining worker
progress for the dashboard. Archon remains the run-level execution harness.
A worker adapter does not create a scheduler, task store, new completion owner,
or an inferred host capability.

## Implementation

Keep the verified 0.15.5 marketplace unchanged. Add a versioned outer dependency
compatibility profile only for Intel macOS, preserving the original direct
Registrar requirements and all other locked package versions. Record original
and selected project/lock hashes and the profile identity in `UNIFIED.json`.
Use binary wheels exclusively; recipients need no compilers or Rust.

Add a worker execution port using the existing assignment/result and process
evidence contracts. Legacy requests default to Codex. A strict provider union
selects pinned Codex or Claude Code executables and their own policies. Keep
Codex catalog/config admission distinct. Thread provider/tool-server selections
through existing worker routers, dashboard preparation manifests, reload and
controller configuration. Preserve clone preparation, ownership checks,
integration, independent review, trusted verification commands and Archon.

Claude Code uses a pinned current native executable with bare mode, no native
tools, strict explicit MCP configuration, and only admitted filesystem tools.
A scoped stdio tool server bounds reads/searches and enforces typed write
ownership independently of model instructions. It denies external paths,
symlinks and Git metadata; atomic replacement protects hardlinked external
sentinels. It exposes no shell, network, arbitrary process or agent-launch tool.
Pin the server/interpreter/configuration and retain tool and process evidence.
Timeout/cancellation must clean up the worker and its MCP child without replay.

The installed dashboard bundles the tool server; unified setup supplies its
pin for an explicitly selected Claude profile. Model/provider authentication
remains user configuration. The local native Claude experiment can use Ollama's
Anthropic-compatible loopback API; that proves the Claude host with that local
model, without claiming Anthropic cloud access.

## Verification and delivery

- Full Intel package/cold setup, real knowledge MCP, retry and cited Talk fixture;
  first Rosetta locally, then native Intel CI. Existing ARM/Linux journeys pass.
- Same bounded investigation and scoped edit through Codex and Claude, retaining
  validated results, raw logs, native identities and tool evidence.
- Unknown provider, changed executable/policy/server, wrong access, malformed
  or error final envelopes, out-of-scope writes, Git metadata, symlinks,
  hardlinks and inherited tools/configurations fail closed.
- Integrated changes receive independent review and controller-run checks;
  dashboard progress/recovery retains provider identity and does not replay
  uncertain effects. Cancellation proves MCP child cleanup.
- Focused adapter/router/controller tests and typechecks, installed dashboard
  smoke, native platform CI and an independent final review establish scope.
  Fixture and native-model evidence remain distinct.
- Commit and open a stacked PR at the verified candidate. Merge/publication,
  native Windows support and universal acquisition/upgrade remain separate.

Claude isolation flags and local-provider support are based on the current
[Claude headless documentation](https://code.claude.com/docs/en/headless) and
[Ollama integration documentation](https://docs.ollama.com/integrations/claude-code).
Installed Claude 1.0.35 lacks the necessary flags; the native test selects
2.1.296 explicitly rather than modifying the user's global installation.


## Executed local evidence

The Intel outer profile selects cryptography 48.0.1 and preserves all 37 other
package records. Full Rosetta x64 setup, managed Node/Python/Archon versions,
actual MCP discovery/read/citations, repair/retry/injection refusals and cited
Talk fixture passed. A managed x64 Python Ed25519/PyJWT encode/decode roundtrip
also passed. Native ARM full recipient regression passed. Native Intel and Linux
results for this candidate belong to the PR workflow rather than the earlier
0.15.5 baseline assessment.

Local live tests used Codex CLI 0.154.0 with gpt-5.6-sol/high and native Claude Code
2.1.296 with Ollama qwen3-coder:30b. Each host passed two isolated implementers,
patch integration, exact combined verification and an independent read-only
review batch through the shared router. The configured gpt-6.1-sol name was
rejected by this CLI account; its retained run remains BLOCKED, and the successful
proof selected a model from the account's cached catalog without changing global
configuration. Requested model selection is retained separately from observed
native session identity; these tests do not establish arbitrary account access.

Unified setup also supplied installed server and managed Node pins to a real
Claude dashboard implementation. Both durable workers, integration and the
separate reviewer completed successfully; the dashboard snapshot retained their
progress. A live native Claude read-only test ignored poisoned project hooks and
an inherited MCP configuration, read an admitted file, and refused external and
Git-metadata reads. The audit records those actual successful/refused calls. Native cancellation
returned BLOCKED with cancelled=true and left neither the observed worker nor
its MCP child process alive. An initial sandboxed process-list check was
unavailable; the successful check enumerated only this worker's descendant PIDs.

Focused checks: 16 adapter/MCP tests; 68 dashboard tests; 64 implementation/write
regressions; 123 process/Codex/router diagnostics tests; adapter and runtime task
typechecks; dashboard build; 9 unified compatibility/integrity tests. Independent
source review found and corrected final-publication false PASS, FIFO read
blocking and requested-model attribution defects. A local review exposed file-scoped
search being refused despite readable files; search now accepts admitted files
and directories, preserving link/metadata/byte limits and MCP line evidence.

Temporary evidence is under `/private/tmp/temari-live-shared-hosts`,
`/private/tmp/temari-native-boundary`, `/private/tmp/temari-intel-compat-journey-20261010`
and `/private/tmp/temari-portable-final-arm-20261010`; command logs are ignored
under `.temari/portable-execution`. None is a canonical Temari feature receipt.
CLI credentials, private transcripts and generated distributions are not shipped.

## Remaining portability work

Native Windows setup and safe process termination remain unsupported. Broader
OS/libc/CPU baselines, per-client plugin registration, published acquisition and
upgrade/rollback, data-home relocation, guided execution/profile admission and
remote library authentication remain separate increments. Claude is admitted as
a scoped filesystem MCP worker; its shell tools and Anthropic cloud backend have
not been enabled or verified. Provider CLI acquisition/authentication remains
explicit, while Node, Python, Archon and knowledge dependencies are managed.


The first complete native verification for this increment is
[run 38068483999](https://github.com/randydinh/temari/actions/runs/38068483999)
at head `47e6df06`: macOS ARM/Intel, Linux x64/ARM recipient journeys and shared
execution checks all passed. Windows passed runtime diagnostics only. The final
file-search correction follows that proof and is checked in the subsequent PR
workflow. The final focused local review used a clean frozen checkout at
`78cc47ca`, passed both groups through the required router, and was reviewed by
the coordinator. Earlier broad local review timed out; file-scoped search
refusals were reproduced and fixed before this successful review. Native review
text is advisory; its line-number claims do not substitute for current source.
