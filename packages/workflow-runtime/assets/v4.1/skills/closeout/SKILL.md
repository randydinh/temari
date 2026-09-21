---
name: closeout
description: Close an agent task only after its task-owned work, verification, decisions, and approved preferences have durable homes. Use for /closeout or an explicit request to persist the task and archive it.
disable-model-invocation: true
---

# Closeout

Close one task through a guarded sequence. Do not archive first and reconstruct later.

The user's explicit `/closeout` request covers normal commits of task-owned changes, a normal push of the current task branch, and archiving the current task when the host supports it. Host policy and repository rules still apply. The request does not cover a force-push, merge, deploy, deletion, shared-branch write, new PR, or changes outside the task's scope.

## 1. Establish the boundary

Read the host adapter before acting. Confirm that the requested task is complete. If work is intentionally stopping before completion, use the poteto-mode `pause-safely` playbook instead and do not archive. Once rerouted, the closeout push and archive authorization ends. Follow `pause-safely`, including its no-new-push and no-new-PR rule, and report `paused` instead of `closeout-blocked`.

Reconcile every delegated agent. Each must be complete, explicitly abandoned, or have its remaining scope absorbed. Finish or stop active commands at a safe boundary.

Inventory every repository and worktree touched by the task. Record the branch, upstream, working-tree state, and commits ahead of the upstream. Separate task-owned changes from pre-existing or unrelated user work. Ambiguous ownership blocks closeout.

## 2. Persist the knowledge

Review the thread for material choices and classify each one before archiving.

| Kind | Durable home |
| --- | --- |
| Behavior already expressed by code and tests | The verified commit. Add prose only when the reason is not recoverable from the implementation. |
| Future-facing architecture, invariant, boundary, or operational rule | The repository's existing ADR, architecture document, runbook, or durable navigation notes. Do not invent a second source of truth. |
| Long-running task decision or abandoned path that affects review | The `show-me-your-work` decision trail. Commit it when the reviewer needs the trail to trust the result. |
| Incomplete work or a non-obvious resume point | The `pause-safely` resume note. This changes the outcome from closeout to pause. |
| Task-local user preference | The closeout report only. Do not promote it into permanent policy. |
| Repeated or explicitly permanent user working preference | A candidate for `reflect` or `automate-me` and the user's approval before changing a personal mode skill. |
| Orchestrated program standing order | The orchestration store's `preferences.md`. It is program-local, not a global user preference. |

Do not silently turn one conversation into permanent user policy. If a material design choice or preference has no approved durable home, present the candidate and stop before archiving. Resume closeout after the user approves a destination or explicitly declines persistence.

Calling a preference permanent authorizes presenting it as a candidate. Changing a personal mode skill still requires approval of the exact destination and proposed wording unless the user already requested that specific edit.

Materialize approved knowledge changes before verification. They are part of the task diff and must pass the same review, checks, commit, and remote-persistence gates as code.

## 3. Prove the result

Check the task's completion claim against the real artifact. Run the smallest verification that covers the final diff and any required broader regression gate. Keep claims proportional to the executed evidence.

If verification fails, fix it within the original task scope or stop closeout with the exact blocker. Never archive a known-broken result.

## 4. Persist the work

For each repository with committed or uncommitted task-owned changes:

1. Review only the task-owned final diff. Apply the packaged `deslop` skill only to task-owned changes before a new commit. Never edit, discard, stage, or reformat unrelated user work.
2. Commit only task-owned changes with a clear non-WIP message. Preserve unrelated edits without staging them.
3. If the repository has a remote and the current branch is a task branch, push it normally and verify that the remote contains the local head. Never push directly to a protected or shared branch and never force-push.
4. If a PR already belongs to the task, verify that its head matches the pushed commit. Create a PR only when the original task or repository rules already required one.

A repository without a remote may close with a local commit. Label that result `local-only` in the report. Uncommitted task-owned changes, an unpushed task branch when a remote exists, or a stale PR head block archiving.

## 5. Archive last

Assemble the final report before invoking the host archive operation. The report names:

- each repository, branch, commit, and remote persistence state;
- the verification that passed;
- each material decision or preference and its durable home;
- any preserved pre-existing or unrelated user work, including its repository and paths;
- any intentionally local-only artifact;
- the archive result.

Archive only when all delegated work is reconciled, the working tree contains no uncommitted task-owned changes, required verification passes, remote persistence is current where available, and every material knowledge item is persisted or explicitly declined.

Use the host adapter's archive operation when available. Otherwise report `ready-to-archive` and leave the task open for the user. If any gate fails, do not archive. Report `closeout-blocked`, the exact failed gate, and the first recovery action.
