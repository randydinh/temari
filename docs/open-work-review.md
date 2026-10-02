# Review captured open work

Use **Review open work** to see a saved inventory of chats and local worktrees in
one dashboard. This guide is for the operator who captures the inventory and
reviews what still needs attention. The page helps locate work; preservation,
merges and chat closure require further evidence and their owning workflow.

## Read the page

Open the dashboard and choose **Review open work**, or use
`http://127.0.0.1:3092/?view=open-work` at the configured port.

1. Read the capture time, freshness and **Coverage and gaps** first. A capture is
   stale after 15 minutes. A future timestamp needs a clock/evidence check. A
   fresh timestamp only describes capture age; it does not establish current
   writer activity or readiness to close work.
2. Search locally by title, host, branch or root. **Show** selects Codex chats,
   ChatGPT chats, worktrees or both. The chat-state filter distinguishes
   **Active at capture**, **Idle at capture** and **Writer state unknown**.
   Unloaded chats have unknown writer state. Idle does not mean done.
3. Open a Codex chat by its captured title. Titles are displayed verbatim as
   text. ChatGPT entries have no Codex link. **Show worktree** selects its
   captured worktree association; no association means the capture did not map
   that chat to a listed worktree.
4. Check conflicted paths, untracked paths and commits outside the main baseline.
   **Not observed** is distinct from zero. Missing worktrees retain unobserved
   counts. **Preservation: Unverified** means this inventory has not established
   that file contents or unique commits are durably saved. Even a clean worktree
   can contain commits outside the baseline.
5. Expand **Capture provenance** for the inventory identifier, exact manifest
   digest, capture/check times, main baseline and source-evidence digests. Source
   references identify evidence; the server does not open or independently
   verify those sources.

Both the top **Refresh** and page **Reload capture** reread the same pinned saved
file. They do not collect new chat or Git observations. Search and filters also
operate on that saved capture. Previous rows are cleared while rechecking, and
remain cleared if the file cannot be read or verified.

This first version always reports partial chat coverage, writer state not checked,
closure eligibility not assessed and preservation unverified. It has no merge,
archive, cancel or filesystem-discovery action.

## Publish a capture to the local dashboard

Keep the capture and its source evidence outside the source checkout. Use the
supported Node/pnpm environment from the [dashboard setup guide](task-dashboard.md).
The inventory must be an explicit host-produced capture; browser input never
selects a filesystem path.

1. Collect chats using the host's supported listing tools, and inspect the
   intended repository's registered worktrees. Record the capture time, pinned
   main revision, listing bounds, unavailable hosts/sources and omitted coverage.
   Record each chat/worktree association from the observed workspace. Leave
   ambiguous associations unmapped and explain them in coverage gaps. This local
   projection admits an association only when the chat's host is `local` and its
   captured workspace exactly matches the listed worktree root.
2. Retain the original host/Git observations independently. Build a manifest
   using the schema below, then compare its totals, associations and unresolved
   counts against those retained observations. Metadata collection does not
   back up file contents; record that limitation rather than implying preservation.
3. Save the approved manifest as a regular JSON file. Obtain the SHA-256 digest
   of its exact bytes using the host's hashing tool. Record the path and digest
   with the evidence; do not replace a capture in place to hide a discrepancy.
4. Start a read-only dashboard over an existing task store from the repository
   root, replacing all placeholders:

   ```sh
   pnpm exec nx run runtime:tasks -- serve --root /absolute/dashboard-state/tasks --open-work-manifest /absolute/dashboard-state/open-work.json --open-work-sha256 APPROVED_64_HEX_DIGEST --port 3092
   ```

   The two open-work flags must be supplied together and are supported only by
   `serve`. They require no Archon or control configuration. For an existing
   controlled dashboard, add the same pair to its established serve command;
   retain its task, preparation, configuration and Archon roots.
5. Open **Review open work**. Compare displayed chat/worktree totals, a known
   chat association, unresolved counts and coverage gaps with the independent
   capture evidence. Expand provenance and check the approved digest and baseline.
   A visible inventory establishes that the pinned projection loaded; it does
   not complete reconciliation.

To show newer observations, preserve the previous capture/evidence, collect and
review a new capture, then restart the server with the new path and approved
digest. Do not change a pin merely to bypass a reported mismatch.

## Capture manifest reference

The server admits an exact-field JSON schema, at most 1 MiB. Unknown fields,
duplicate identities/roots, unsafe identifiers, malformed digests, dangling
associations and invalid timestamps are rejected. The server rereads and hashes
the configured regular file on each API request; symlinks are rejected.

| Field | Required content |
| --- | --- |
| `schema`, `id`, `capturedAt`, `baseline` | `1`, a safe capture identifier, ISO UTC timestamp ending in `Z`, and a full 40-hex main revision. |
| `coverage` | `chatScope`, `chatLimit` (1–50), `allChats: false`, `worktreeScope`, and string arrays `unavailableHosts`, `unavailableSources`, `gaps`. |
| `chats` | At most 1,000 rows with `id`, `title`, `kind` (`codex` or `chatgpt`), nullable `hostId`/absolute `cwd`, `status` (`active`, `idle`, `notLoaded`, `unknown`), nullable Unix-seconds `updatedAt`, and nullable listed `worktreeId`. |
| `worktrees` | At most 200 rows with `id`, absolute `root`, boolean `exists`, nullable 40-hex `head`/`branch`/boolean `clean`, nullable nonnegative counts `unresolvedPathCount`, `untrackedPathCount`, `commitsNotInMain`, and `preservation: "unverified"`. Missing worktrees must have null observation counts. |
| `sourceRefs` | At most 32 `{kind, sha256}` rows identifying retained source evidence, with full 64-hex digests. No evidence paths or URLs. |

Safe identifiers contain letters, digits, `.`, `_` or `-`, begin with a letter or
digit, and are at most 128 characters. Titles are bounded to 512 characters,
absolute paths to 4,096 and scope/gap strings to 2,048. No chat summaries, raw Git
status, file contents or arbitrary URLs are included in this projection. The
strict implementation is in [the capture reader](../tools/dashboard-open-work.mts).

## When a capture needs attention

| Symptom | Next action |
| --- | --- |
| No saved capture configured | Supply both serve flags with an approved manifest and digest. |
| Saved capture unavailable / digest changed | Preserve the file and original pin. Compare exact bytes and retained evidence; review a replacement before updating the pin. Previous rows are not retained in the browser. |
| Invalid JSON, encoding or inventory fields | Check the exact-field schema, counts, identifiers and associations. Keep the rejected capture as discrepancy evidence. |
| Stale capture | Collect and review a newer host capture when newer observations are needed. Reload alone does not change capture time. |
| Future timestamp | Check the capture clock and its supporting evidence. Do not infer freshness from a future time. |
| A chat/worktree is missing or mapped incorrectly | Record the discrepancy and capture scope. Check host availability and the observed workspace; leave uncertain mappings unresolved. Never infer that missing work is complete. |
| Worktree counts are unobserved or preservation is unverified | Independently inspect the intended worktree and preserve unique work through its owning workflow before considering closure. |

Retain capture IDs/digests, baseline revisions, source observations, discrepancies,
verification results and workflow handoffs for the reconciliation retrospective.
Record parallel assignments/results separately from this inventory. This page
does not create stage receipts or a canonical completion receipt.
