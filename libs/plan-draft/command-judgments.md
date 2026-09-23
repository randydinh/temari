# Local command judgments

`createCommandJudgments(configuration)` supplies assessment, proposal, review,
and readiness callbacks for an authorized local conversation draft. It returns
`Omit<ConversationDraftDependencies, 'provider'>`. The application still owns
the provider, [intent and write authority](README.md#start-and-resume-a-conversation-draft).
Raw callbacks and `createLocalPlanDraft` composition remain available.

## Configuration and caller wiring

The deployment supplies canonical paths and approved SHA-256 values before this
example runs. `approvedArtifacts` includes the executable and every declared
behavior-affecting wrapper, configuration file, or other local asset. These pins
are deployment inputs, not hashes recomputed to accept whatever is installed at
resume time.

```ts
import {
  createCommandJudgments,
  createConversationPlanDraft,
  type CommandJudgmentConfiguration,
  type CommandJudgmentRole,
} from '@temari/plan-draft';

const command: CommandJudgmentRole = {
  executable: approvedExecutablePath,
  args: [approvedWrapperPath],
  cwd: approvedWorkingDirectory,
  environment: {},
  artifacts: approvedArtifacts,
  behaviorRevision: 'wrapper-v1',
  service: { id: 'approved-local-service', configurationRevision: 'config-v1' },
  timeoutMs: 30_000,
};
const configuration: CommandJudgmentConfiguration = {
  instance: 'local-plan-draft-service',
  roles: { assess: command, propose: command, review: command },
};
const dependencies = {
  provider: admittedProvider,
  ...createCommandJudgments(configuration),
};
const first = await createConversationPlanDraft(
  { kind: 'start', intent },
  dependencies,
);
const result = first.kind === 'draft' ? first.draft : first.result;
console.log(result.status, result.summary, result.evidencePaths);

const resumed = await createConversationPlanDraft(
  { kind: 'resume', task: intent.task, destination: intent.destination },
  {
    provider: admittedProvider,
    ...createCommandJudgments(configuration),
  },
);
```

The example uses one wrapper that implements all roles. Each role can instead
specify its own executable, arguments, artifacts, and service. A distinct role ID
or child process does not establish independent reasoning or separate model
sessions. There are no mandatory provider, model, or reasoning fields.

| Field              | Contract                                                                             |
| ------------------ | ------------------------------------------------------------------------------------ |
| `instance`         | Nonempty deployment identifier. It contributes to stable callback IDs and revisions. |
| `roles`            | Exactly `assess`, `propose`, and `review`.                                           |
| `executable`       | Canonical absolute executable file. It must appear in `artifacts`.                   |
| `args`             | Fixed literal strings. No shell or document substitution occurs.                     |
| `cwd`              | Explicit canonical existing directory at readiness or invocation.                    |
| `environment`      | Explicit nonsecret string values. `{}` supplies no application environment.          |
| `artifacts`        | Canonical absolute file paths mapped to lowercase SHA-256 values.                    |
| `behaviorRevision` | Nonempty revision for the deployment's behavioral contract.                          |
| `service`          | Nonempty opaque `id` and `configurationRevision` assertions.                         |
| `timeoutMs`        | Integer from 1 through 300000, for each command exchange.                            |

Construction validates and freezes a copy of the configuration without file
access or process launch. Callback revisions bind the role's entire command
configuration, service, policy, protocol, and fixed execution limits. Map key
ordering does not change identity. Changes require a new authorized operation;
they cannot resume an existing operation under another service.

`checkReady(roles)` checks only the requested roles. It checks POSIX support,
canonical directories and artifact paths, executable access, regular files, and
artifact hashes. It launches no judgment and performs no credential or
authentication probe. Each callback repeats those checks immediately before
launch. Readiness and artifact hashing are outside `timeoutMs`; this value is
not a deadline for the complete callback or conversation.

The bridge passes only the declared environment to `spawn`, with Node's automatic
`NODE_V8_COVERAGE` inheritance suppressed unless explicitly declared. It never
merges `process.env`, supplies a default `PATH`, or discovers credentials. The
child runtime or operating system can synthesize variables after launch. Tests
on macOS observed `__CF_USER_TEXT_ENCODING` and proved that it did not inherit a
parent sentinel value. This is not control over the executable's own environment
changes, permissions, filesystem, or network access.

## Wrapper protocol, version 1

One child receives one UTF-8 JSON object on stdin, followed by EOF. stdout contains
one UTF-8 JSON response, with optional surrounding JSON whitespace and no other
content. Logs belong on bounded stderr. The protocol is private to this bridge;
its frames are not public domain types or journal schemas.

The request has the following fields.

| Field             | Value                                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------- |
| `version`         | `1`                                                                                                         |
| `role`            | `assess`, `propose`, or `review`                                                                            |
| `bindingRevision` | Stable callback revision                                                                                    |
| `requestId`       | Fresh UUID for this invocation                                                                              |
| `requestDigest`   | SHA-256 described below                                                                                     |
| `service`         | Configured opaque service assertion                                                                         |
| `instructions`    | Fixed role policy text                                                                                      |
| `responseShape`   | Descriptive object and array shapes, with field types and enum choices expressed as strings                 |
| `trusted`         | Original brief and request; review also includes the admitted draft authority                               |
| `untrusted`       | The complete original callback input, preserved as data                                                     |
| `executionPolicy` | `{ attempts: 1, tools: false, context: 'fresh', responseRepair: false }`                                    |
| `limits`          | `inputBytes`, `stdoutBytes`, `stderrBytes`, `resultBytes`, `terminationGraceMs`, and configured `timeoutMs` |

`requestDigest` covers every request field except `requestId` and
`requestDigest`. This includes the opaque service, trusted and untrusted inputs,
instructions, response shape, execution policy, and limits. The bridge recursively
sorts object keys lexicographically, preserves array order, and uses compact
ordinary JSON scalar encoding before hashing the UTF-8 bytes. It does not
normalize strings or candidate Markdown. The wrapper returns this digest
unchanged. Correlation is not authentication.

For assessment, `trusted.brief` is `checkpoint.trustedBrief` and
`trusted.request` is `checkpoint.request`. The augmented `brief.context`, source
excerpts, prior judgments, and checkpoint paths stay within `untrusted`.
For proposal and review, trusted brief and request come from the original callback
fields. Source text cannot select commands or confer execution authority.

`responseShape` describes the role result. It is not vendor JSON Schema and does
not enforce structured output at a model service. The bridge parses the returned
JSON with explicit role parsers, rejects missing or extra fields and wrong types,
and constructs the existing domain result. There is no coercion, response repair,
default approval, or fallback. Ordinary `JSON.parse` behavior applies, including
its handling of repeated object keys. Multiple responses and trailing text fail.

The response has exactly these eight fields.

```js
const response = {
  version: request.version,
  role: request.role,
  bindingRevision: request.bindingRevision,
  service: deployedService,
  requestId: request.requestId,
  requestDigest: request.requestDigest,
  status: 'completed',
  result,
};
```

All correlation fields and the complete service object must match the request.
`deployedService` identifies the trusted wrapper's configured service. Its value
is a deployment assertion; echoing a request does not authenticate routing.
`completed` means one judgment finished. A complete review result can still
reject the candidate. An uncertain or partial status is not accepted.

The role results are `KnowledgeAssessment`, `Proposal`, and `DraftReview`.
The [private policy module](src/lib/judgment-policy.ts) contains the full shapes
and instructions. Existing knowledge citation and question validators and draft
citation, criterion, issue, and approval validators retain final admission.
Review receives the exact candidate bytes and hash, every acceptance criterion,
and every supplied issue. The bridge checks the candidate's UTF-8 SHA-256 before
launch and requires the same hash in the review result.

## Execution and recovery limits

| Value                           | Bound                  |
| ------------------------------- | ---------------------- |
| Serialized request              | 32 MiB                 |
| stdout                          | 1 MiB                  |
| stderr                          | 64 KiB                 |
| Canonically encoded role result | 256 KiB                |
| Command exchange                | Configured `timeoutMs` |
| Failure termination grace       | 100 ms                 |

The deadline starts immediately before spawn and includes writing stdin and
waiting for process and stream completion. The bridge accepts a result only
after stdin finishes and the child exits successfully with closed output streams.
Launch, stream, exit, size, and timeout failures reject the invocation. Failure
permanently invalidates subsequent output, including a response sent during
termination. There are no internal retries.

On failure, the bridge sends SIGTERM to the owned POSIX process group, then
SIGKILL after the grace interval. It destroys local pipes and settles without
waiting indefinitely for descendants to close them. Escaped processes and remote
work cannot be contained or proven cancelled. The executable is trusted code
with ordinary host access, not a sandboxed plugin.

The wrapper's deployment contract requires one judgment with fresh context,
no tools, and no internal retry or repair. The bridge cannot enforce those
promises inside arbitrary code. Artifact pins do not prove complete dependency
closure. Neither pins nor service IDs authorize uploads, authenticate a model
route, or attest to historical sessions. Authorization for the selected service
and input corpus must already exist.

Bridge errors contain fixed categories and an invocation UUID when available;
they omit command output and payloads. Existing caller blockers and recovery
rules apply. A failed or unsaved judgment cannot be repeated after its invocation
marker. A saved accepted preparation can recover with the same configuration
even when all command files are unavailable, because construction performs no I/O
and that recovery path does not require live readiness. Direct local composition
retains its existing weaker review-repetition guarantee.

Maintainers increment the role policy revision for parser or input-projection
changes and the bridge revision for execution changes. Instruction text and
response shapes already contribute directly to callback revisions.

## Verification evidence

`pnpm nx run plan-draft:test-command-judgments` exercises real child processes
with synthetic judgments, including exact output, environment isolation,
correlation refusals, stream bounds, inherited pipes, and fresh-process recovery.
`pnpm nx run plan-draft:test` also runs the existing admission and journal tests.
The [opt-in Registrar target](README.md#verification-targets) includes the actual
Registrar-to-conversation-to-child-process path and compares published bytes with
the recorded review candidate.

These checks establish transport and admission behavior for synthetic judgments.
They do not establish live model quality, reviewer independence, provider
authorization, human effort savings, or full FT/CP/CX completion. Live service use
remains a separate, explicitly authorized verification step.
