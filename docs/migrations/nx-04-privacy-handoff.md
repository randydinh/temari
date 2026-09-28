# NX-04 privacy integration handoff

The integration branch is `codex/nx04-privacy-integration-20260928` in
`/private/tmp/temari-nx04-privacy-20260928`. The original transfer started at
`8cb14df8629b44fca3e12632c6a045adc4bff962` and was committed at
`93c3786f049731ddc5a55502cd6c3f03b60000be`. Independent reviews of
`c42956a1c521f05a75f3b3f60a6f6d5e752c6244` **failed** on a callback
argument swap and bracketed credential leaks. Linux CI run 36429003197 and
Windows run 36429723104 passed at that older head; neither establishes the
repair. The repair commit is `39971e5dbbcef074c315982770c86eaf92edef6b`.
After confirming remote `main` at
`7cf3221c0f8495b96adda4f9344b365262ca588c`, the branch integrated PR 57
with a normal merge commit `dd9d19710afbf20c772bd397ea0862d3863e9acc`.
After PR 59 merged, remote `main` was rechecked at
`c3e3d6b57d3dd085821c400d8c4ec69936ee70fe` and integrated with normal
merge commit `585ff24136f08420fd73b99736fd334d91779821`. The merge retained
both NX-02 installed closeout and NX-04 privacy changes. Only
`docs/migrations/continuation.md` and `migration-decisions.tsv` conflicted;
their resolution retained both histories. Linux CI run 36433849656 and
Windows run 36433840630 passed at pre-PR59 head
`79b88adc1e6497f038465427a0b20c8a6d4b060c`. Those runs do not establish
the final merged head.
Draft [PR #58](https://github.com/randydinh/temari/pull/58) remains open.
The owner authorized merge only after a new independent review; this repair
unit does not merge the PR.

The source checkout `/Users/randydinh/source/projects/temari-next` remained
read-only. Its baseline and the repair-time read-only check had 14 tracked
edits and 20 untracked files. Both its
`git diff --check` and the destination's staged `git diff --check` exited 0.
The destination code commit contains exactly the 34 source paths below.
Twenty-five transferred files match the source bytes. Nine paths differ for
the security repairs, generated copy, package reconciliation, CI preservation,
documentation, or provenance wording.

## Source and destination inventory

Tracked source edits carried into the destination:

```text
.github/workflows/ci.yml
libs/host-adapters/package.json
libs/host-adapters/src/index.ts
libs/host-adapters/tsconfig.lib.json
packages/workflow-runtime/assets/v4.1/integrations/archon/lifecycle.ts
packages/workflow-runtime/assets/v4.1/integrations/archon/live-codex.ts
packages/workflow-runtime/assets/v4.1/integrations/archon/live.test.ts
packages/workflow-runtime/assets/v4.1/integrations/archon/live.ts
packages/workflow-runtime/assets/v4.1/integrations/archon/runtime-files.txt
packages/workflow-runtime/import-paths.txt
packages/workflow-runtime/package.json
packages/workflow-runtime/provenance.json
pnpm-lock.yaml
tsconfig.json
```

Untracked source files carried into the destination:

```text
docs/privacy-model-transport.md
libs/host-adapters/src/lib/codex-model-driver.test.ts
libs/host-adapters/src/lib/codex-model-driver.ts
libs/host-adapters/src/lib/model-transport.test.ts
libs/host-adapters/src/lib/model-transport.ts
libs/privacy/README.md
libs/privacy/package.json
libs/privacy/src/index.ts
libs/privacy/src/lib/privacy.test.ts
libs/privacy/src/lib/privacy.ts
libs/privacy/tsconfig.json
libs/privacy/tsconfig.lib.json
packages/workflow-runtime/assets/v4.1/integrations/archon/codex-model-driver.ts
packages/workflow-runtime/assets/v4.1/integrations/archon/model-transport.ts
packages/workflow-runtime/assets/v4.1/integrations/archon/privacy.ts
tools/generate-privacy-runtime.mjs
tools/generate-privacy-runtime.test.mjs
tools/privacy-adapter.test.mjs
tools/privacy-preflight.mjs
tools/run-privacy-native-tests.mjs
```

The nine deliberate source-to-destination differences are
`.github/workflows/ci.yml`, `docs/privacy-model-transport.md`,
`libs/host-adapters/src/lib/model-transport.test.ts`,
`libs/host-adapters/src/lib/model-transport.ts`,
`packages/workflow-runtime/assets/v4.1/integrations/archon/model-transport.ts`,
`packages/workflow-runtime/package.json`,
`packages/workflow-runtime/provenance.json`,
`tools/generate-privacy-runtime.mjs`, and
`tools/generate-privacy-runtime.test.mjs`. The package target and CI invocation
for `public-entry-test` from the merged pilot remain present.

## Boundary decisions

The host transport maps protected JSON Schema property names back to the names
in the trusted schema only when it calls the local tool. Argument values remain
masked. The original implementation paired decoded `Object.entries` by position.
That premise failed because JavaScript enumerates integer-index keys before
other keys. The repair pairs key identities by the stable array indices in the
encoded schema, then rejects conflicting identities and unknown protected
callback keys. A global identity conflict is rejected rather than guessed.

| Case                         | Original schema property keys | Protected schema keys and model callback keys  | Trusted callback                                |
| ---------------------------- | ----------------------------- | ---------------------------------------------- | ----------------------------------------------- |
| Ordinary                     | `plain`, `Synthetic Key`      | `plain`, placeholder                           | `plain`, `Synthetic Key`; values stay masked    |
| Integer-index                | `3`, `12`                     | `12`, placeholder                              | `3`, `12`; values stay with their original keys |
| Nested                       | `group` → `3`, `12`           | `group` → `12`, placeholder                    | `group` → `3`, `12`                             |
| Duplicate/ambiguous callback | `3`, `12`                     | `12`, placeholder; callback also sends raw `3` | Rejected before tool execution                  |

The full callback-path tests enumerate these keys. The decoded-object position
approach swapped the integer-index values in the red test. An explicit identity
mapping preserves the valid cases; rejecting every changed key would break the
supported single-key callback without improving this boundary. Bracketed
unquoted credential values are masked as complete tokens. Values with an
unbalanced or truncated bracket span fail closed; a serialized empty `[]`
remains structural. Synthetic prompt, tool-description, and callback-result
tests cover source and relocated Archon packages.

The path read rejects symbolic links and
directories that another local UID can replace. A root-owned sticky directory
is accepted only for an entry owned by the process UID. The host must exclude
same-UID writers and ACL grants from its trusted file area. `O_NOFOLLOW` alone
protects only the final path component.

The generated Archon copies come from the three authoritative Nx sources.
`workflow-runtime:privacy-check` verifies their source and artifact hashes,
transformation notes, and exact 237-file package inventory. The public entry
and one-engine lifecycle retain their existing target and tests.

## Historical verification at the original code milestone

The commands below ran from the isolated worktree at
`93c3786f049731ddc5a55502cd6c3f03b60000be`. Each Nx command used the
prefix `PATH=/opt/homebrew/bin:$PATH NX_DAEMON=false`. The later handoff-only
documentation edits did not change the tested sources or artifact inventory.
The failed independent review supersedes any acceptance inference from these
older checks.

| Command after the prefix                                                                                                                                                                                                                                                    | Exit | Observed result                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---: | -------------------------------------------------------------------------------------------------------------------- |
| `pnpm exec nx run-many -t typecheck test --projects=privacy,host-adapters,workflow-runtime --parallel=1 --skipNxCache --skipSync --output-style=static`                                                                                                                     |    0 | Affected and dependent typechecks passed; privacy 31, host-adapters 69, workflow-runtime 34 tests passed.            |
| `pnpm exec nx affected -t typecheck --base=origin/main --parallel=1 --skipNxCache --skipSync --output-style=static`                                                                                                                                                         |    0 | All 11 affected project typechecks passed.                                                                           |
| `pnpm exec nx run workflow-runtime:privacy-check --skipNxCache --skipSync --output-style=static`                                                                                                                                                                            |    0 | The three generated Archon sources and provenance were current.                                                      |
| `pnpm exec nx run workflow-runtime:check --skipNxCache --skipSync --output-style=static`                                                                                                                                                                                    |    0 | The source payload matched all 237 inventory entries.                                                                |
| `pnpm exec nx run workflow-runtime:package --skipNxCache --skipSync --output-style=static`                                                                                                                                                                                  |    0 | The existing 213-file portable artifact matched its digest.                                                          |
| `pnpm exec nx run workflow-runtime:privacy-test --skipNxCache --skipSync --output-style=static`                                                                                                                                                                             |    0 | Generated copy check, 37 generator tests, and two relocated adapter journeys passed.                                 |
| `pnpm exec nx run workflow-runtime:privacy-native-test --skipNxCache --skipSync --output-style=static`                                                                                                                                                                      |    0 | The packaged Archon artifact passed 77 synthetic native and lifecycle tests. No live model turn ran.                 |
| `pnpm exec nx run workflow-runtime:package --args="--lane archon" --skipNxCache --skipSync --output-style=static`                                                                                                                                                           |    0 | Created the 237-file Archon artifact with digest `209c98c4e2a25d1429bf8169d5192b84010758b06bd4628109276530048ef5e9`. |
| `pnpm exec nx run workflow-runtime:check --args="--artifact /private/tmp/temari-nx04-privacy-20260928/packages/workflow-runtime/dist/archon-209c98c4e2a25d1429bf8169d5192b84010758b06bd4628109276530048ef5e9 --lane archon" --skipNxCache --skipSync --output-style=static` |    0 | The relocated artifact matched all 237 inventory entries.                                                            |
| `pnpm exec nx run workflow-runtime:public-entry-test --skipNxCache --skipSync --output-style=static`                                                                                                                                                                        |    0 | All 31 installed public-entry tests passed.                                                                          |
| `pnpm exec nx run workflow-runtime:privacy-preflight --args="/opt/homebrew/bin/codex" --skipNxCache --skipSync --output-style=static`                                                                                                                                       |    1 | Refused `runtime-version`; `credentialRequests` was 0. This is a release block.                                      |

`pnpm install --frozen-lockfile`, the scoped `nx format:check`, and
`git diff --check` exited 0 before the code commit. The privacy callback and
ancestor regressions first failed on the transferred source and then passed
after the fixes. These checks use synthetic fixtures. No credential, customer
record, or OpConnect source was added.

## Repair verification before the final handoff commit

The first full verification ran at merge head
`dd9d19710afbf20c772bd397ea0862d3863e9acc`, after PR 57 integration.
The workspace formatter then changed source layout and regenerated the Archon
copy. Focused source typecheck/test, privacy-test, package and artifact check
were repeated on the final working tree. Other results below are from the
merge head and are not claimed for the later formatting edit. Each Nx command
used `PATH=/opt/homebrew/bin:$PATH NX_DAEMON=false` and
`--skipNxCache --skipSync --output-style=static`. The new callback test was red
before the schema repair. The bracketed-value test was red before the grammar
repair.

| Nx command                                                                                                                                                                                                                                    | Exit | Observed result                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---: | -------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm exec nx run-many -t typecheck test --projects=privacy,host-adapters,workflow-runtime --parallel=1`                                                                                                                                      |    0 | Privacy 33, host-adapters 74, workflow-runtime 34 tests; dependent typechecks passed at merge head.                              |
| `pnpm exec nx run-many -t typecheck test --projects=privacy,host-adapters --parallel=1` after formatting                                                                                                                                      |    0 | Privacy 33 and host-adapters 74 tests; dependent typechecks passed.                                                              |
| `pnpm exec nx run workflow-runtime:privacy-test`                                                                                                                                                                                              |    0 | 37 generator and 4 relocated adapter tests, including packaged callback and three credential channels; rerun after formatting.   |
| `pnpm exec nx run workflow-runtime:privacy-native-test`                                                                                                                                                                                       |    0 | 77 synthetic installed Archon tests at merge head.                                                                               |
| `pnpm exec nx run workflow-runtime:public-entry-test`                                                                                                                                                                                         |    0 | 31 installed public-entry tests, including PR 57's Windows-compatible entry, at merge head.                                      |
| `pnpm exec nx run workflow-runtime:check`                                                                                                                                                                                                     |    0 | Source inventory: 237 files at merge head.                                                                                       |
| `pnpm exec nx run workflow-runtime:package --args='--lane archon'` after formatting                                                                                                                                                           |    0 | Archon artifact: 237 files; digest `e82ce8a7efd2a5657f64059eb2344ad85dfc0e867d3fa3ac701f6b5e1d7bcfe8`.                           |
| `pnpm exec nx run workflow-runtime:check --args='--artifact /private/tmp/temari-nx04-privacy-20260928/packages/workflow-runtime/dist/archon-e82ce8a7efd2a5657f64059eb2344ad85dfc0e867d3fa3ac701f6b5e1d7bcfe8 --lane archon'` after formatting |    0 | Relocated Archon artifact matched all 237 entries.                                                                               |
| `pnpm exec nx run workflow-runtime:package`                                                                                                                                                                                                   |    0 | Portable artifact: 213 files, unchanged digest `38ecaa0078d9f44efe4c1cced5193110348b3f3ea5d6176f426e3df5f92830bc` at merge head. |
| `pnpm exec nx run workflow-runtime:privacy-preflight --args='/opt/homebrew/bin/codex'`                                                                                                                                                        |    1 | Real installed `codex-cli 0.154.0` refused `runtime-version`; zero credential requests at merge head.                            |

The generated Archon sources and provenance were regenerated; the source and
relocated package checks confirm the resulting copies. New exact-head CI and
independent review are still required before merge. No current-head review
verdict is claimed here.

## Verification after the PR 59 merge

At merge commit `585ff24136f08420fd73b99736fd334d91779821`, the following
local commands used `PATH=/opt/homebrew/bin:$PATH NX_DAEMON=false` and
`--skipNxCache --skipSync --output-style=static`. They use synthetic fixtures;
they do not exercise a live private model request.

| Nx command                                                                                                                                                                                                                   | Exit | Observed result                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---: | ------------------------------------------------------------------------------------------------------------------ |
| `pnpm exec nx run-many -t typecheck test --projects=privacy,host-adapters,workflow-runtime,runtime,workflow-engine,temari-core,contracts --parallel=2`                                                                       |    0 | Seven project typecheck/test targets passed with dependencies.                                                     |
| `pnpm exec nx run-many -p workflow-runtime -t privacy-test public-entry-test host-session-test canonical-test --parallel=1`                                                                                                  |    0 | Relocated privacy, installed public closeout, host session, and canonical journeys passed.                         |
| `pnpm exec nx run workflow-runtime:public-entry-test`                                                                                                                                                                        |    0 | 35 tests, including packaged closeout plan-tamper refusal.                                                         |
| `pnpm exec nx run workflow-runtime:privacy-native-test`                                                                                                                                                                      |    0 | 77 synthetic installed Archon tests.                                                                               |
| `pnpm exec nx run workflow-runtime:check`                                                                                                                                                                                    |    0 | Source inventory matched 237 files.                                                                                |
| `pnpm exec nx run workflow-runtime:package --args='--lane archon'`                                                                                                                                                           |    0 | 237-file artifact unchanged at digest `e82ce8a7efd2a5657f64059eb2344ad85dfc0e867d3fa3ac701f6b5e1d7bcfe8`.          |
| `pnpm exec nx run workflow-runtime:check --args='--artifact /private/tmp/temari-nx04-privacy-20260928/packages/workflow-runtime/dist/archon-e82ce8a7efd2a5657f64059eb2344ad85dfc0e867d3fa3ac701f6b5e1d7bcfe8 --lane archon'` |    0 | Relocated Archon artifact matched 237 files.                                                                       |
| `pnpm exec nx run workflow-runtime:package`                                                                                                                                                                                  |    0 | 213-file portable artifact unchanged at digest `38ecaa0078d9f44efe4c1cced5193110348b3f3ea5d6176f426e3df5f92830bc`. |
| `pnpm exec nx run workflow-runtime:privacy-preflight --args='/opt/homebrew/bin/codex'`                                                                                                                                       |    1 | Installed `codex-cli 0.154.0` refused `runtime-version`, with zero credential requests.                            |

The Nx changed-file formatting check also exited 0. Final-head Linux and
Windows CI must be checked after the handoff documentation is committed and
pushed. A new independent review remains required. This record claims no
final-head CI or review result before those runs finish.

## Release gate

The Archon native pilot reports `explicit-request-only`. Its masking does not
isolate filesystem reads, environment variables, network access, or native
tools. No live private or customer data may enter either Codex path until a
compatible runtime passes the credential-free preflight and an independent
review proves native-tool restrictions and model egress. Synthetic tests and
package checks do not clear this gate. The current `/opt/homebrew/bin/codex`
reports `codex-cli 0.154.0`, and its preflight refused `runtime-version` with
exit 1 and zero credential requests. The earlier audit on
`0.155.0-alpha.16.4` refused `feature-state (unified_exec)` with exit 1 and
zero credential requests.

The owner authorized a merge after a new independent review, but this repair
unit stops with a draft PR. Final cutover and installed-plugin replacement
remain separate operator decisions. New reviewers must inspect the final PR
head and its Linux and Windows CI results. Private use remains blocked until
the separate runtime gate closes.
