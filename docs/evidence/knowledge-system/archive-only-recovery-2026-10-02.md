# Archive-only recovery proof, 2026-10-02

An actual Registrar CLI fixture copied a pre-capture SQLite registry into
fresh workspaces. The registered source ID, original root and `local-only`
sharing setting were already present in each destination. The source workspace
then captured and exported one generation. A destination imported that bundle,
verified the exact generation and manifest pin, and returned the same archived
representation and citation as the source workspace. After one live original
was changed and another deleted, `recover` returned both retained originals
with exact SHA-256 and bytes. No hosted model call was made.

A changed blob refused import without publishing a generation. A registration
with the same source ID but a different root refused the origin binding. In a
separate destination, import into an already disabled source succeeded, but
archived `read`, `recover` and `export` all refused because the source was
disabled. Import preserved the pre-provisioned `local-only` setting; it did not
create or restore source policy.

This is **archive-only, same-origin recovery** evidence. It does not restore
graph relationships, derived views, authorization or erasure ledgers, or
establish backup scheduling, RPO, RTO or production recovery. A fresh machine
would need the same approved source identity and root registration before
import. The fixture is synthetic and runs on this macOS host; it says nothing
about Windows support.

Focused verification selected the recovery case and passed 1/1 with the actual
bundled Registrar. The full `pnpm nx run knowledge:integration` suite passed
78/78. `pnpm nx run knowledge:test` passed 43/43. `pnpm nx sync:check` and `pnpm nx run knowledge:typecheck` passed on the
same worktree without a sync override. An initial focused run used `--skipSync`
after a transient generated-reference warning; final checks did not need it.
