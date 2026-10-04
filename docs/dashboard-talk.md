# Talk to Temari

Use **Talk** as the conversational front door of the local dashboard. Keep a
topic for each area of work, with one composer and its linked tasks beside it.
Switching topics keeps their messages separate and preserves unfinished drafts
while the page remains open. Updates from other topics appear in the attention
inbox instead of entering the conversation you are reading.

## User flow

1. Create or select a topic in the left column. When the host has selected
   multiple workspaces, choose one when creating the topic. Its workspace stays
   fixed and is shown beside the topic.
2. Ask Temari a question or work through a goal in the center conversation.
3. Link an existing task from that topic's workspace to include its current
   runtime status. Other workspaces have their own topics in the same surface.
4. When Temari offers a task, review its title and goal and choose **Accept**.
   This creates one durable, open task and links it to the topic.
5. Open a linked task to use the existing planning, investigation, implementation
   or verification controls. Return to Talk to continue the discussion.

Accepting a proposal saves a goal. The existing task workflow supplies the plan
and execution controls. A conversational answer never accepts a run, marks work
done, merges a change or closes a chat. Temari owns intent and routing, Poteto
owns engineering method, and the runtime owns durable execution. Archon remains
the replaceable native harness.

The right column shows linked task observations and attention. Acknowledge an
update after reviewing it; acknowledgement does not change the task's status or
accept its evidence. Counts and omission notes identify bounded history and
attention. Older conversation pages remain available through the paging controls.

## Configure the local service

Run from the source checkout with its dependencies installed. Keep conversation
and task data outside that checkout. The identifiers below are stable host
bindings; they are not filesystem paths, credentials or permission grants.

Create `/absolute/dashboard-state/talk.json`:

```json
{
  "schema": 1,
  "root": "/absolute/dashboard-state/conversations",
  "workspaceRoot": "/absolute/path/to/temari-next",
  "hostId": "local-desktop",
  "workspaceId": "temari-next",
  "taskStoreId": "main-tasks"
}
```

Start the service:

```sh
pnpm exec nx run runtime:tasks -- serve --root /absolute/dashboard-state/tasks --talk-config /absolute/dashboard-state/talk.json --port 3092
```

Without a transport, Talk supports topic organization, task links and attention;
the composer explains that a model must be configured. This mode does not
initialize Archon or read model credentials. Add `--control-config` and the
native options from [the dashboard guide](task-dashboard.md) to enable the
existing execution controls in the same service.

### Several workspaces in one surface

Use a schema2 registry in a **new external directory**. Each selected workspace
keeps its own conversation store and immutable scope. The dashboard combines
topic lists and attention; conversation context contains only the selected
topic and its explicitly linked tasks. For example:

```json
{
  "schema": 2,
  "root": "/absolute/dashboard-state/talk-registry",
  "registryId": "temari-workspaces",
  "hostId": "local-desktop",
  "taskStoreId": "main-tasks",
  "workspaces": [
    {
      "key": "engineering",
      "workspaceId": "engineering-workspace",
      "label": "Engineering",
      "workspaceRoot": "/absolute/engineering-checkout"
    },
    {
      "key": "research",
      "workspaceId": "research-workspace",
      "label": "Research",
      "workspaceRoot": "/absolute/research-checkout"
    }
  ]
}
```

Use the same `--talk-config` launch flag and actual task store. Workspace keys
are host-selected identifiers, not paths or execution permissions. A topic
cannot be moved to another workspace. Foreign-workspace links are refused;
opening a task still uses the existing execution controller's admission.

Keep a registry's roster, source roots and actual task-store selection fixed.
Changing them requires a separately reviewed new registry root; existing
conversations are neither adopted nor migrated automatically. Schema1 stores
and their bindings remain supported. Aggregated status is observed across
stores in sequence, with a reported time window; it is not an atomic snapshot.

The registry admits at most eight workspaces and 128 topics in total. Its
attention list shows the latest 50 items and reports the retained total and
omissions. If a selected source directory disappears or is replaced while the
service is running, its retained topic history remains readable and mutations
for that workspace stop. Restart requires every original selected directory
and storage binding to be available; it refuses an incomplete or changed roster.

A host can add one of these `transport` objects to `talk.json`:

```json
{"kind":"ollama","model":"YOUR_INSTALLED_MODEL","baseUrl":"http://127.0.0.1:11434"}
```

```json
{"kind":"openai-responses","model":"YOUR_SELECTED_MODEL","credentialEnv":"OPENAI_API_KEY"}
```

```json
{"kind":"codex","model":"YOUR_SELECTED_MODEL","reasoning":"medium","executable":"/absolute/path/to/codex","credentialEnv":"OPENAI_API_KEY","timeoutMs":120000}
```

Select the model and credential environment variable on the host. Never place a
credential value in this file or submit it through the browser. Model messages
include the selected topic's bounded history, the new message and explicitly
linked task observations. They do not automatically read repository files,
dereference context links or include other topics. Each adapter retains its
existing admission and privacy checks; a configured transport is not proof of
successful live execution. In particular, the protected Codex adapter requires
its supported executable and isolation admission.

## Recovery and limits

- Topic history, task links, attention and proposal state persist in the selected
  conversation store. Reuse the same roots and host bindings after restart. The
  service also retains the canonical workspace and task-store roots; reusing a
  conversation store with a different selection is refused. Keep the original
  selection when recovering existing conversations.
- Drafts remain in page memory. Refreshing or closing the page discards unsent
  drafts; they are not silently placed in browser storage.
- A lost response keeps the original request identity. Refresh to inspect the
  retained turn before choosing an identical-request retry. A retry does not
  automatically launch another model effect.
- Restart marks interrupted turns or task intake as uncertain. It does not
  replay model calls or create tasks automatically. An explicit proposal retry
  retains the original task identity and checks the actual task store.
- The store bounds topics, history, attention and ledger size. Model context
  retains the newest complete turns within its byte budget and reports omitted
  history. Reaching a storage bound refuses further mutations; it does not erase
  older work.
- Missing or corrupt retained files and a held store lock refuse access. Startup
  does not replace the ledger, adopt different roots or take over the lock.
- Each conversation store binds one host, workspace and task store. A schema2
  registry combines those fixed workspace scopes on one host. Cross-host delegation,
  automatic engineering dispatch and general standing-program execution remain
  separate capabilities.

For source onboarding, read the [roles matrix](system-roles-and-responsibilities.md),
[task continuity guide](task-continuity.md) and
[open-work review guide](open-work-review.md). Conversation persistence preserves
context; task evidence and explicit acceptance remain the completion authority.

See the [executed verification and limits](evidence/2026-10-03-dashboard-talk-verification.md)
for this increment's source, HTTP, fixture and browser coverage.
