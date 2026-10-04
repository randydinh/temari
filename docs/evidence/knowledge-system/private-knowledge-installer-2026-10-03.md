# Private Content Registrar Knowledge install helper

`tools/knowledge-private-install.mjs` is a bounded macOS CLI helper for a
caller-supplied, absolute private `0.1.2` release archive and an independently
provided SHA-256. It is not invoked by the Temari initializer yet, so it does
**not** make Content Registrar a default part of Temari installation.

Before any Codex command, the helper checks the archive digest and strict
current release provenance, then reads the archive again and checks its digest
before safe materialization under the caller's private state root. It uses
argument-array Codex CLI calls to inspect marketplace and plugin JSON state,
requires the exact `temari-knowledge` marketplace root, local plugin source,
`0.1.2` version and policy, then installs from that local root. It does not
download the archive, run Python setup, read a TypeSafe key, or invoke Jev.

The commands are `install`, `status`, and `reinstall`. A successful install
gets an atomic private receipt bound to the canonical Codex home. Repeating `install` verifies the exact state
and does nothing. If that exact plugin is later absent, `install` records
`user-removed` and leaves it absent; only explicit `reinstall` adds it again.
Unknown state, a second Codex home for the same state root, a foreign marketplace, changed cache bytes, and an interrupted
install refuse further mutations. An exclusive lockfile serializes calls to
the same state root. A crash can leave the lock or an `installing` receipt;
both require human inspection rather than automatic stale-lock takeover.

Focused fake-Codex tests passed **7/7** through Nx. They cover archive tamper
before zero Codex calls, cold and idempotent install, external removal and
explicit reinstall, failed plugin add and partial receipt, marketplace and
version collisions, stale lock, changed release-cache bytes, a second-home
refusal preserving the first receipt and plugin, and oversized receipt refusal. Nx
`sync:check` reported the workspace up to date.

An isolated real macOS Codex CLI run against release SHA-256
`709783cee705373df1ba1358e0fbba703d305ee13157976e37bbcf801399d583`
observed cold install, an unchanged rerun, explicit CLI removal followed by a
`user-removed` receipt, and successful explicit reinstall. The installed
plugin was sourced from the materialized local release. This test did not run
Python setup or a hosted model call.

The helper has no network fetch path for the release archive. The Codex CLI's
behavior for unrelated configured marketplaces was not instrumented. Native
Windows, desktop Plugins Directory behavior, power-loss durability, and an
initializer-triggered default install remain unverified.
