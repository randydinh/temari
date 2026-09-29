# Maintain and learn from the QA writer

The version-controlled source is `packages/workflow-runtime/public/skills/qa-review-verification`
in the Temari Nx monorepo. Edit that source and its callers, then rebuild the public
artifact. Installed bundles and the imported v4.1 snapshot are not editing targets.

For each behavior change:

1. Record the observed problem and the smallest proposed change. Use synthetic or
   sanitized examples; keep private tickets, paths, reviewer defaults, and customer
   data in the user's private overlay.
2. Run the same representative prompts against the baseline and proposed version.
   Keep the evidence fixed. Include a normal case, a missing-evidence case, and a
   nearby request that should retain its existing owner. Record model/host, skill
   version and Git revision, supplied evidence, outputs, assessment, and limitations.
3. Assess scope fidelity, candidate identity, attribution, missing-evidence handling,
   readability, and next actions. Record regressions and unresolved feedback as well
   as improvements. Do not claim independent evaluation for a self-review.
4. Update `metadata.version` and the [changelog](../CHANGELOG.md) for a behavior change. Keep trial
   prompts, outputs, and findings under `evaluations/qa-review-verification/` in the
   source repository. Those files are development evidence, not runtime resources.
5. Run the monorepo's `workflow-runtime:public-entry-test` target through the package
   manager and Nx. This checks packaging, links, integrity, and admission boundaries;
   it does not measure prose quality. Repeat the representative trials for behavior.
6. Commit source, caller, validation, and trial changes together. Retain the Git
   revision and public manifest digest with the installed artifact so a result can
   be traced to the exact version.

Rollback by reverting the relevant integration/change commit on a new branch and
rebuilding a fresh artifact through the normal delivery path. Preserve trial history;
do not overwrite prior outputs or relabel old execution evidence as a new run.
