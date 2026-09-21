# Host adapters

Temari is built on a P-stack Cursor plugin, while its conversational entry is provider-neutral. A **host adapter** maps package operations onto another agent harness so Temari and the same engineering playbooks run without inventing Cursor APIs.

## Contract

Every adapter directory must provide:

| Artifact | Purpose |
| --- | --- |
| `HOST.md` | Mapping table: upstream operation → host execution. Explicit gaps for routes that need Cursor-only facilities (arena panels with model slugs, Graphite frontier, companion plugins). |
| Install notes | How skills land where the host discovers them (in `HOST.md` or a sibling README). |
| Thin entry skills | Discovery entries for `skills/temari`, `skills/poteto-mode`, and `skills/closeout`; all require `HOST.md` first. An optional `verify-temari` projection exposes the repository-owned verifier. |

Rules:

1. **Preserve upstream.** Adapters reference `skills/` by relative path. Do not fork playbook bodies into the adapter.
2. **Never fake Cursor APIs.** If Task subagents, AskQuestion, or companion plugins are missing, say so and degrade or stop.
3. **Inherit the host model by default.** Do not pass Cursor model slugs into other hosts or claim multi-model diversity the host cannot provide.
4. **Authorization is the host's.** A playbook is not permission to message, merge, deploy, or spend.
5. **Report missing deps** for arena, swarm, orchestration watchers, Benny, and shipping before those routes run.

## Shipped adapters

| Host | Path | Discovery |
| --- | --- | --- |
| Cursor (native) | [`cursor/`](./cursor/) | Add the Temari plugin — no remap |
| Codex | [`codex/`](./codex/) | Codex plugin skill root or `install-host.sh --host=codex` |
| Claude Code | [`claude-code/`](./claude-code/) | Project or user skills directory |
| Generic | [`generic/`](./generic/) | Plain skill root + `AGENTS.md` pointer |

Install helper: [`../scripts/install-host.sh`](../scripts/install-host.sh). It installs `temari`, `poteto-mode`, and `closeout`; pass `--include-verification` when the host should discover the repository-owned `verify-temari` projection. The package root is this repository root.

## Proof

Historical adapter evidence is not shipped in this runtime distribution. Run fresh isolated installation checks and keep their evidence outside the payload. File presence and install checks do not prove a live Feature journey on every host.
