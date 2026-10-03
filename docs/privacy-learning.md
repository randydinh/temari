# Privacy preference learning experiment

## Current boundary

Temari's privacy library stores scoped exact-value decisions and remembers repeated one-submission approvals locally. A host still needs to show the save choice and apply preferences at every model egress point. The library remains the enforcement boundary: credentials, application-declared denials, and previously removed values stay protected regardless of a learned suggestion.

The next question is whether a separate learner can reduce repeated prompts and improve answer usefulness without broadening disclosure against the user's intent. The SkillOpt experiment uses only synthetic cases. It does not read submissions, Codex transcripts, saved privacy files, or images.

## Proposed shape

1. `recordPrivacyLearningDecision` records an explicit user choice locally with scope, category, action, and a keyed value fingerprint. The local preferences file retains no raw value for this observation. Do not infer consent from the submitted text, silence, or a model's guess that data is public.
2. `suggestPrivacyGroupDefaults` proposes a narrow grouping only after three distinct decisions in the same workspace, source, and category agree. A conflicting decision blocks that grouping. Sensitive account, card, SSN, and private-category allows never produce a group proposal. `suppressPrivacyGroupProposal` persists a “never suggest” choice. The proposal contains counts and scope, without raw values or fingerprints.
3. Keep the proposal separate from the active policy. One user decision can save the grouping; the host must allow review and removal. The deterministic policy engine applies only the saved result. Broader grouping needs a typed runtime rule and tests before it can be activated.
4. Evaluate candidate skill edits on held-out cases for disclosure mistakes, answer usefulness, prompt frequency, scope errors, and reversals. Any credential leak or override of an application denial is a hard failure, even if an aggregate score improves.

This design uses SkillOpt for bounded skill edits and held-out evaluation, while Temari retains typed policy enforcement. SkillOpt-Sleep's real backends can send task or transcript excerpts to a provider. Its `mock` backend makes no provider calls, but it only tests the pipeline with a deterministic mock agent; it does not prove privacy-decision quality. See the [SkillOpt-Sleep data boundary](https://github.com/microsoft/SkillOpt/blob/main/docs/sleep/README.md) and [task-file contract](https://github.com/microsoft/SkillOpt/blob/main/skillopt_sleep/tasks_file.py).

The local learning record holds at most 256 decisions and 64 suppressed proposals. At capacity it refuses new learning input rather than forgetting an earlier conflict or a “never suggest” choice. This does not change the active masking policy.

The HMAC key lives in the same owner-only local settings file as its fingerprints. This avoids recording raw one-time values, but it is not protection against an attacker who obtains that file and guesses likely values. Do not export the learning record or send it to SkillOpt or a model provider as if it were anonymized data.

## Synthetic fixture

[`tasks.json`](experiments/privacy-learning/tasks.json) is a reviewed, synthetic SkillOpt-Sleep task file with six training, three validation, and three test cases. Its candidate [`SKILL.md`](experiments/privacy-learning/SKILL.md) is an offline seed; it is outside `.agents/skills` and cannot control live submissions. Cases cover saved exact overrides, repeated approvals, local substitutes, group conflicts, cross-workspace scope, unverified public claims, a visible face, and credentials.

The fixture was checked against SkillOpt source commit `f02c6fce16e958c185b57ebb66e241a8ab2a7b76`. Every task has an explicit six-label output contract, including the held-out tasks. A reproducible no-provider smoke run uses a disposable copy of the fixture so SkillOpt's local state also stays outside the repository:

```sh
git clone https://github.com/microsoft/SkillOpt.git /tmp/skillopt-privacy-eval
git -C /tmp/skillopt-privacy-eval checkout f02c6fce16e958c185b57ebb66e241a8ab2a7b76
mkdir -p /tmp/temari-privacy-skillopt/docs/experiments
cp -R docs/experiments/privacy-learning /tmp/temari-privacy-skillopt/docs/experiments/
PYTHONPATH=/tmp/skillopt-privacy-eval python3 -m skillopt_sleep dry-run \
  --project /tmp/temari-privacy-skillopt \
  --tasks-file /tmp/temari-privacy-skillopt/docs/experiments/privacy-learning/tasks.json \
  --target-skill-path /tmp/temari-privacy-skillopt/docs/experiments/privacy-learning/SKILL.md \
  --claude-home /tmp/temari-privacy-skillopt/.claude \
  --backend mock --json
```

The smoke run loaded all 12 tasks and all three splits, then rejected an unchanged candidate at `0.0 → 0.0`. That score is expected from SkillOpt's generic mock backend and says nothing about privacy decision quality. Before a real backend experiment, enable `gate_no_regression`, add more held-out leakage and utility cases, and inspect every task sent to the provider.

An isolated user-level install of the pinned source and its Codex skill wrapper was tested separately. SkillOpt's built-in deterministic researcher experiment improved its held-out score from `0.3333` to `1.0` and rejected a harmful edit. A four-case synthetic privacy dry run through the Codex backend returned actual model answers but made no edit: its two training cases passed, while the image validation case failed. A second run with a deliberately weak temporary skill proposed the invalid label `GENERALIZE`; the held-out gate rejected it. This demonstrates why the output contract and gate matter, but the tiny sample is not evidence that the privacy guidance is ready to deploy. Both Codex runs used disposable files and no real submissions or transcripts.

## Host decision flow

`createPrivacyDecisionHost` in `@temari/host-adapters` connects an existing host-owned preferences store to explicit user actions. The host supplies `load` and `save`, using `loadPrivacyPreferences` and `savePrivacyPreferences` for the local Unix store or its own approved store on another platform. Use one coordinator per settings file so concurrent actions are serialized.

- `allowOnce` accepts a user-authorized, one-submission exact rule with a source scope and a unique event ID. It saves the repeated-approval count and the keyed learning event together. A retry with the same event ID does not count as another approval.
- `maskOnce` records an explicit mask choice. Either action returns only a newly reached group proposal; a settings view can call `pendingGroupProposals` with its workspace and source to list existing ones. This avoids prompting on every later request.
- `resolveExactOffer` applies the user's `save`, `not-now`, or `never-suggest` response for an exact value. The one-time allow has already persisted the next-offer delay; saving adds an exact rule, and `never-suggest` persists suppression. `neverSuggestGroup` persists a group's dismissal. The host UI must present these choices locally.

The host API does not send data to a model, activate group defaults, inspect media, or modify `createProtectedModelTransport`. The next increment is a typed group rule that can be applied at the final egress boundary only after user approval. Connecting SkillOpt to real user decisions or transcripts requires a separate data-source decision and provider review.
