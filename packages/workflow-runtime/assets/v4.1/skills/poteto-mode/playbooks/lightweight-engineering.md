### Lightweight engineering

Use this route only when all of these statements are true:

- The requested result is clear, local, and reversible.
- The change does not alter a public interface, shared data shape, persistence, permissions, security, concurrency, deployment, dependency, or external side effect.
- The request is not a reported defect, unexplained symptom, performance claim, design choice, migration, or behavior whose affected callers are uncertain.
- One agent can complete it without crossing an architectural boundary.
- A direct focused check can prove the result.

If any statement is false or uncertain, reclassify the task into the matching full playbook. Preserve useful inspection already completed.

**You own the small change. Keep Poteto's lifecycle and compress its ceremony, not its proof.**

1. **Investigate.** Inspect the exact target, repository instructions, and nearby context needed to preserve existing behavior.
2. **Plan.** Name the smallest complete change and the direct check that will prove it. Reclassify if this exposes a design choice, uncertain caller, shared contract, or broader effect.
3. **Build.** Make that change serially. Do not spawn reviewers, architects, arenas, or swarms.
4. **Review.** Inspect the final diff or artifact for scope creep, accidental edits, and violations of the preserved behavior.
5. **Verify.** Run the narrowest direct check that proves the requested result. Reclassify instead of weakening proof when the check is unavailable or the change reveals broader effects.
6. **Deliver.** Report the changed result, the direct evidence, and any remaining gap.

Do not open a pull request, commit, or start a delivery workflow unless the user or repository requires it.

**Reply:** result, direct evidence, and any reclassification or remaining gap.
