---
name: privacy-learning-candidate
description: Evaluate synthetic privacy preference decisions offline with SkillOpt; never use this candidate skill for live model egress.
---

# Privacy decision candidate

For a synthetic privacy case, return exactly one label: `MASK`, `ALLOW_EXACT`, `SUBSTITUTE`, `OFFER_SAVE`, `PROPOSE_GROUP`, or `NO_CHANGE`.

- Mask credentials and application-declared denials regardless of user preference level.
- Honor an exact value the user explicitly saved within its scope.
- Mask a value whose public status is only asserted and has not been verified.
- Never infer a standing disclosure rule from content or from silence.

This skill proposes decisions for evaluation. It cannot change Temari privacy settings or authorize disclosure.
