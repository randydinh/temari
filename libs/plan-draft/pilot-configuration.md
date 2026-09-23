# Pilot configuration reference

The private `plan-draft:pilot` entry accepts one UTF-8 JSON file, at most 1 MiB.
The file must resolve to a regular file through an absolute path. Unknown or
missing fields and wrong structural types fail before dependency construction.
Ordinary `JSON.parse` semantics apply. The last repeated object member wins.

The envelope has exactly four fields.

| Field       | Shape                                                                                   |
| ----------- | --------------------------------------------------------------------------------------- |
| `schema`    | The number `1`.                                                                         |
| `registrar` | Serializable `LocalRegistrarOptions`, below.                                            |
| `judgments` | [`CommandJudgmentConfiguration`](command-judgments.md#configuration-and-caller-wiring). |
| `command`   | The existing start or resume command, below.                                            |

`registrar` requires string fields `python`, `registrarSource`, and `preparation`,
plus `readScope: "source-root"`. Optional `timeoutMs` and `maxStdoutBytes` are
numbers. `onCommand` is not accepted. The Registrar owns path, prepared-profile,
timeout, and size admission. Its construction can run a subprocess preflight.

The start form is `{ "kind": "start", "intent": ... }`.
`intent` contains exactly `task`, `brief`, `request`, `destination`, `title`, and
`authority`, with the [existing conversation intent fields](README.md#start-and-resume-a-conversation-draft).
No function fields or executable configuration modules are loaded.

The resume form contains no replacement intent. The following values are
placeholders for the original task and destination:

```json
{
  "kind": "resume",
  "task": {
    "id": "original-task-id",
    "directory": "/canonical/original/task",
    "authorityRef": "/canonical/original/task/authority.json"
  },
  "destination": "/canonical/original/output/draft.md"
}
```

The direct CLI accepts no arguments or `--help` for help. Execution accepts only
`--config /absolute/file.json` or `--config=/absolute/file.json`. One leading
`--` is accepted for Nx forwarding. Unknown or duplicate flags and mixed help and run
arguments fail. The target is explicit and uncached.

| Exit | Direct-entry result                                                             |
| ---- | ------------------------------------------------------------------------------- |
| `0`  | Help, or a full outcome with `kind: "draft"` and `draft.status: "PASS"`.        |
| `2`  | Any other returned conversation outcome, preserved in full on stdout.           |
| `1`  | Input, construction, or unexpected entry failure; a fixed diagnostic on stderr. |

The entry emits no fabricated outcome for setup failure. A `draft` outcome keeps
the investigation and draft results separate. Status and evidence-path guidance
go to stderr. Nx can add console framing around the direct-entry output.

The entry adds no public exports, journal, automatic source setup, authority
creation, service selection, credential discovery, or live-service authorization.
Command readiness remains selective inside the conversation caller. Existing
[recovery and evidence limits](README.md#conversation-journal-recovery) apply.
