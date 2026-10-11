# Guided host authentication and client registration

This increment follows merged PRs [231](https://github.com/randydinh/temari/pull/231) and [232](https://github.com/randydinh/temari/pull/232). It extends the outer unified installer; the verified 0.15.5 marketplace stays immutable.

## Delivered journey

`./setup guide --expected-manifest-sha256 HEX` collects project, chat and worker choices, discovers compatible executables and models, runs native Codex login when needed, generates the profile, installs managed components, registers selected clients and starts the dashboard. Temari remains the main conversation, the runtime coordinates work and records progress, and Archon remains the execution harness.

Chat and engineering authentication are separate selections. Ollama is discovered through its loopback API; OpenAI Responses uses an API credential. Codex worker model discovery uses a fresh CLI-version-matching account catalog or native app-server `model/list`, with no prompt or project source. Claude bare workers use an explicit Anthropic API key or the local Ollama endpoint, independently of client OAuth. Saved selections clear competing Anthropic authentication and endpoint variables.

Credentials are stored only in a protected owner-only installation file, resolved by the launcher on each start. Profiles, guided receipts and process arguments contain no credential values. The launcher checks the release manifest and managed Node/dashboard hashes before spawning. Native Codex authentication stays with its host.

The guide journals exact generated profile bytes once setup owns the home. Interrupted installation and partial client registration can replay the same choices. Changed release, profiles, models, authentication backends or executable pins require a separate installation. Client registration uses official CLI commands, preserves unrelated configuration, refuses conflicts, and verifies the named result. An existing identical Codex marketplace at another path can be retained after independent release verification. Claude workspace-disabled or shadowed knowledge entries remain blocked.

For a Git project with a commit, the generated controller includes the existing clean-checkout verification recipe. Selecting a worker enables read-only investigations and visible worker progress. Coding ownership, project-specific checks and forge access remain explicit engineering admission requirements; authentication does not create those permissions.

## Verification scope

- Focused unit fixtures cover login/cancellation, CLI model discovery, credential permissions/redaction/restart, generated profiles, mixed chat/worker backends, partial recovery, registration collisions, disabled servers, marketplace reuse and binary drift.
- A cold-PATH packaged journey generates its profile, retries, starts through the managed launcher, executes actual knowledge search/read with returned citations, and restarts. Its model is an explicit loopback fixture.
- Native local trials use existing Codex login/model discovery and local Ollama with current Claude Code. Codex and Claude client configuration roots are isolated; global client settings and credentials are unchanged. Fresh browser login and cloud API billing are tested with fixtures, not claimed as live account evidence.
- The native matrix runs the guided cold journey on macOS Intel/ARM and Linux x64/ARM. Windows remains a runtime diagnostic with native knowledge setup explicitly refused.

Independent source review found inherited Claude authentication routing, disabled-client readiness and mixed-backend model-selection issues; each received a focused regression. Frozen local review and final CI are recorded in the PR and task handoff. Test and host receipts are context evidence, not canonical Temari feature completion receipts.

## Remaining portability work

Provider CLI acquisition, Ollama installation/model acquisition, arbitrary project coding-plan admission, native Windows knowledge locking/launch conventions, other libc/OS baselines, and in-place upgrades remain separate increments. Claude knowledge registration does not imply a Claude edition of the Codex-only public plugin.

See the [installation guide](../migrations/unified-install.md) for the supported recipient flow. Authentication follows the official [Codex login contract](https://learn.chatgpt.com/docs/developer-commands#codex-login) and [Claude CLI contract](https://code.claude.com/docs/en/cli-reference); local version-specific help governs emitted commands.
