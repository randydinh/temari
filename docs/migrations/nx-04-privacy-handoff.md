# NX-04 privacy integration handoff

The integration branch is `codex/nx04-privacy-integration-20260928` in
`/private/tmp/temari-nx04-privacy-20260928`. It started from merged `main`
`8cb14df8629b44fca3e12632c6a045adc4bff962`. The code milestone is
`93c3786f049731ddc5a55502cd6c3f03b60000be`. Remote `main` still pointed
to the same merge when the code milestone was pushed. Draft
[PR #58](https://github.com/randydinh/temari/pull/58) awaits independent review.

The source checkout `/Users/randydinh/source/projects/temari-next` remained
read-only. Its baseline had 14 tracked edits and 20 untracked files. Both its
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
masked. The full callback regression uses a synthetic credential-class key and
checks the actual callback argument. The path read rejects symbolic links and
directories that another local UID can replace. A root-owned sticky directory
is accepted only for an entry owned by the process UID. The host must exclude
same-UID writers and ACL grants from its trusted file area. `O_NOFOLLOW` alone
protects only the final path component.

The generated Archon copies come from the three authoritative Nx sources.
`workflow-runtime:privacy-check` verifies their source and artifact hashes,
transformation notes, and exact 237-file package inventory. The public entry
and one-engine lifecycle retain their existing target and tests.

## Verification at the code milestone

The commands below ran from the isolated worktree at
`93c3786f049731ddc5a55502cd6c3f03b60000be`. Each Nx command used the
prefix `PATH=/opt/homebrew/bin:$PATH NX_DAEMON=false`. The later handoff-only
documentation edits do not change the tested sources or artifact inventory.

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

Independent code review, current-head CI, and final cutover approval remain
outside NX-04. Do not merge this branch or replace an installed plugin on this
handoff. The next engineer should review the draft PR, reproduce the privacy
and installed-artifact checks at its final SHA, and keep private use blocked
until the separate runtime gate closes.
