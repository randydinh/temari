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
after initialization on supported platforms. `init` runs the locked installations declared in
[`dependency-manifest.json`](dependency-manifest.json):

1. `pnpm install --frozen-lockfile` at the Nx workspace root.
2. stages the packaged Poteto runtime into the user-local Temari cache and
   runs `bun install --frozen-lockfile --ignore-scripts` there.
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

Receipts contain tool versions, install commands, exit codes, hashes of
captured output, and Archon's pinned source/platform/runtime digest. They do
not store command output, credentials, or environment variables.
