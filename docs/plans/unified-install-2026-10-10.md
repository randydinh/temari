# Unified Temari installation

User-authorized increment, based on merged PR #230 at `afa479979dac0e4d8a8bddd4277d803c881e8d17`.

## Outcome and ownership

Install Temari without recipient Node or Python setup. One setup journey provisions pinned runtimes, the existing 0.15.5 plugin, Archon, local knowledge, and the installed dashboard. Temari is the main conversation; the runtime coordinates work behind the scenes and the dashboard shows retained task and worker progress. Archon remains the replaceable native execution harness. Model and repository authentication remain explicit external configuration.

## Reuse and scope

Reuse the existing public artifact and marketplace verification, knowledge launcher, source registry, dashboard lifecycle, Talk transport, task controller and Archon adapter. Package these behind one release contract rather than replace their stores or widen execution admission. Keep immutable artifacts separate from user data. Setup must be repeatable and refuse changed or conflicting owned installations.

Provide platform-specific verified runtime assets under one product contract. The first actual clean recipient journey runs on this macOS host. Other supported platform claims require their own execution evidence. No model credentials, private corpus or host configuration enter the release.

## Acceptance

- A recipient launcher can start setup without system Node or Python.
- Managed runtime payloads are version-pinned, verified and isolated from global executables.
- Setup joins installation, knowledge readiness and dashboard configuration; retry preserves existing data and checks retained identity.
- Local knowledge can discover and read included public Temari documentation with source citations.
- Installed dashboard Talk uses the configured model transport, shares durable task state with the existing controller and exposes worker progress.
- Archon remains pinned and visible in readiness; host/provider capabilities are not inferred from installation.
- Relocated distribution checks, negative integrity/retry cases and a real knowledge/dashboard recipient journey establish the delivered scope.

## Verification and delivery

Use focused runtime/setup tests, existing public release and dashboard regression targets, typechecks and a real relocated recipient journey. Independent architecture and final review are required by the selected Temari feature method. Record fixture results separately from real host evidence. Preserve a structured task handoff and exact candidate/release references. Publication and merging require their own authorization.

## Delivered candidate

Task selected: `temari-unified-install-20261010`. Implementation branch: `codex/unified-install-20261010`, based on merged `afa479979dac0e4d8a8bddd4277d803c881e8d17`. Changes remain available for source review; no canonical feature acceptance or publication is inferred.

The additive unified distribution is version 0.1.0 and preserves the original verified 0.15.5 marketplace unchanged. Recipient setup supplies Node 22.23.3, Python 3.12.15 and Archon 0.10.1; installs hash-locked binary dependencies and verified Registrar source; seeds a scoped public library; verifies a real read-only MCP connection; and configures Talk and the existing task controller. The installed launcher provides start/stop/status/doctor without global PATH changes.

The first live model check exposed interference between Ollama tool calling and a final-answer grammar. The driver now completes a bounded retrieval phase, disables tools, and renders the final packet using the native schema. Protected tool access, cancellation, budgets and final Talk packet validation remain in place.

## Executed evidence

The final macOS arm64 candidate (`rc4`) has manifest SHA-256 `a7778801137c509fcdc1b0076d46b4971b3bf0a1d815919232a37236d93296fe`. Its archive SHA-256 is `7fad278b4537ad3f3fed1c3c9f3feddeb89589fd7df03e659bf9df857ce73f6d`. Local artifacts and logs are under `.temari/releases` and `.temari/unified-install` and are excluded from source delivery.

- Actual cold recipient setup with PATH limited to `/usr/bin:/bin`, verified discovery/read citations and read-only MCP handshake: PASS.
- Retry retains user data and one source registration, repairs a missing dependency, and refuses changed manifest/profile/venv configuration and injected startup code before execution: PASS.
- Archive extraction to a fresh location and exact full inventory verification: PASS.
- Installed Talk using the actual local `qwen3-coder:30b` model retrieves an unpredictable value from a newly registered document and returns the exact path and SHA-256: PASS.
- Installed model fixture performs search, pinned read and cited final rendering, excludes a denied source, and retains the response after restart without replay: PASS.
- Focused checks: 11 asset tests, 6 distribution/dependency tests, 9 knowledge tests and 5 Ollama tests passed; runtime/task and dashboard lifecycle typechecks passed.
- Existing Talk regression: 74 tests passed. Host adapter regression: 269 tests passed before the final rendering refinement; the final refinement has the focused Ollama and installed knowledge fixture checks above. Dashboard smoke, release smoke and installed Talk smoke passed.
- Independent architecture and source reviews identified retry startup injection, unpinned build backend, archive-link/collision/truncation/Windows-path cases and a broken packaged configuration link. Each reported issue was addressed and exercised by focused regression or recipient checks. The final two-phase Ollama change passed independent review. Native homogeneous read-only review receipts remain in the local evidence directory; they do not prove host feature admission or canonical completion.

## Remaining scope

macOS arm64 is the only platform with executed recipient evidence. Other native platforms require verification; native Windows knowledge remains unsupported. The starter library is a curated subset rather than a complete offline documentation mirror. Host MCP/plugin registration is explicit per client. Engineering workers, execution recipes, repository authentication and forge capabilities continue to require the existing admission/configuration; this increment does not silently enable them. In-place upgrade/migration and distribution publication are separate follow-up work.
