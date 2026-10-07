# Temari initializer

The initializer is the cross-platform dependency entry point for Temari.
It supports macOS and Windows without depending on Bash, `ln`, `cp`, or
shell command strings.

```sh
pnpm temari:init
pnpm temari:doctor
```

`doctor` is read-only. It checks the required tools, platform support, and
lockfiles, plus the integrity and native version of managed Archon. Run it
after initialization on supported platforms. When Bun or Archon is missing,
doctor exits 1 and prints `pnpm temari:init`. It does not install either one.

`init` bootstraps pinned Bun 1.4.2 into the user-local Temari cache when that
managed executable is missing or older than the manifest major. A later
`pnpm temari:doctor` sees that binary with no Bun installer and no `PATH`
export. `init` then runs the locked installations declared in
[`dependency-manifest.json`](dependency-manifest.json):

1. `pnpm install --frozen-lockfile` at the Nx workspace root.
2. stages the packaged Poteto runtime into the user-local Temari cache and
   runs `bun install --frozen-lockfile --ignore-scripts` with the managed Bun.
3. downloads the pinned Archon v0.10.1 native executable for the current
   supported OS/architecture into the versioned Temari component cache and
   verifies its published byte count and SHA-256 before publication.

The source artifact is never mutated by initialization. This keeps packaging
deterministic and avoids copying platform-specific `node_modules` symlinks into
portable or Archon distributions.

The command invokes executables with argument arrays and resolves Windows
`.cmd`/`.bat` wrappers through `ComSpec`. It records a receipt at:

- macOS: `~/Library/Application Support/Temari/state/install-receipt.json`
- Windows: `%LOCALAPPDATA%\\Temari\\state\\install-receipt.json`
- Linux/other: `$XDG_DATA_HOME/Temari/state/install-receipt.json` or
  `~/.local/share/Temari/state/install-receipt.json`

Archon is not installed globally or added to `PATH`; callers receive its
verified absolute path through the initializer receipt. The runtime is a
managed default behind `ExecutionHarness`, so a host-provided or configured
alternative can replace it without changing the workflow engine. Unsupported
architectures remain available to host-provided or alternate harnesses. A
supported-platform download or digest failure makes initialization fail rather
than recording an unverified binary as ready.

After `init`, run an explicit live host probe from the selected host environment:

```sh
pnpm temari:doctor --live --host codex
# or: pnpm temari:doctor --live --host claude-code
# or: pnpm temari:doctor --live --host cursor
```

Live doctor creates a private synthetic `challenge.txt` under the user-local
Temari state directory. For Codex CLI and Claude Code it launches a bounded,
read-only child process and checks that the child returned the token it read
from that file. It retains process evidence and `doctor-report.json` in the
printed run directory. Cursor currently has no bounded noninteractive Nx probe,
so its live result is `BLOCKED`. A missing executable, failed response,
timeout, or wrong token is also `BLOCKED`. The ordinary `doctor` command never
launches a model or writes live proof.

An observed live result establishes only the local child-worker mechanism for
installation preflight. Forge, model diversity, isolation, durable delivery,
and parallelism remain unproven. Feature admission still requires fresh proof
bound to its own invocation and candidate; it never imports the doctor report
as authority. The live probe may make a model call and does not inspect a user
project.

Receipts contain tool versions, install commands, exit codes, hashes of
captured output, and Archon's pinned source/platform/runtime digest. They do
not store command output, credentials, or environment variables.
