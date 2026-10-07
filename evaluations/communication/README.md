# Communication comprehension corpus

This is a small fictional development corpus, not a runtime resource or proof of generated response quality. The response examples are authored. No customer, ticket, account identifier or credential is used.

The fixed contexts in [fixtures.json](fixtures.json) freeze the original goal, current phase, evidence facts and limits, authorized actions and feasible choices. [responses.json](responses.json) uses neutral response IDs and mixed ordering. Cases cover phase completion with an unfinished goal, authentication recovery, partial evidence, consequential ambiguity, ongoing authorized work needing no user action, a fully finished title edit, and delivery choices. Available choices number zero, one, two and four; no display-option cap is imposed.

The assessor-only [rubric.json](rubric.json) evaluates meaning and novice comprehension. [expectations.json](expectations.json) is also assessor-only and withheld until the independent classifications have been sealed. Neither is a response-generation input. Adequate/inadequate classifications concern these authored examples only.

## Independent procedure

Following the fixed-input editorial and retained-binding pattern in the [paired QA comparison](../qa-review-verification/2026-10-02-paired-model-comparison/README.md):

1. Supply an independent reader only fixtures, responses and rubric. Withhold expectations and synthetic unit-test assessments. Record reader identity and method; independence is declared and must be verified by the coordinator, not inferred from a JSON field.
2. For every response, ask the reader what happened, what that means, what remains, who acts, the next action (including no action), and a grounded recommendation (including no recommendation). Judge each rubric criterion semantically, with a reason and one or more exact quoted response spans. Missing information may be evidenced by a relevant surrounding span and explained as an omission; do not fabricate absent text.
3. Retain the assessment with raw SHA256 bindings of all three input files. Seal the independent assessment before revealing expectations. Never replace disagreements with expected answers.
4. Run the review validator and examine every disagreement. Retain corrections as a new version and rebind/review changed responses. Passing integrity does not establish correctness of judgment or general model quality. Independently judged authored examples calibrate guidance; quality improvement requires actual fixed-input baseline/proposed output captures and a separate assessment.

Review JSON schema (UTF-16 start inclusive/end exclusive offsets within response.text):

    {
      "schemaVersion": 1,
      "reviewer": {"id": "distinct-reader", "independent": true, "method": "description"},
      "bindings": {"fixturesSha256": "...", "rubricSha256": "...", "responsesSha256": "..."},
      "assessments": [{
        "responseId": "r-1",
        "classification": "adequate",
        "readerAnswers": {
          "happened": "...", "means": "...", "remaining": "...",
          "actor": "...", "nextAction": "...", "recommendation": "..."
        },
        "criteria": [{
          "id": "outcome", "score": 2, "reason": "...",
          "evidence": [{"start": 0, "end": 4, "quote": "exact response slice"}]
        }]
      }]
    }

All six criteria are required for every one of the fourteen responses. Scores are integers 0–2. The checker validates raw input binding, complete coverage, independent-actor declaration, score bounds and exact span bytes. It cannot detect a dishonest declared identity or decide whether a reason is semantically convincing. It performs no keyword grading, natural-language matching, golden-prose snapshot test or live model call.

## Local checks

From the workspace root with existing dependencies:

    pnpm exec nx run workflow-runtime:communication-fixtures-test

This runs corpus integrity and dependency-free validator tests. It reports semantic quality as not assessed; synthetic test assessments are not saved as independent review evidence.

After retaining an actual independent assessment:

    pnpm exec nx run workflow-runtime:communication-fixtures-review

A missing review fails. A stale binding, fabricated quote, partial case/criterion coverage or classification disagreement exits unsuccessfully. A passing review reports only that independent judgments were retained and bound; humans still inspect semantic reasons. No scripts from archived artifacts, network services, model CLIs or credentials are involved.

## Retained review

[review.json](review.json) retains a separate blind assessment of all fourteen examples. Its classifications agree with the author expectations. The reviewer gave the adequate authentication-recovery example partial evidence credit because signed-out status and unchanged files exceed the frozen facts. This qualification remains visible; an adequate classification does not mean every claim is supported. These are authored calibration examples, not a live model comparison.

The focused packaging regression check is `pnpm exec nx run workflow-runtime:communication-bundle-test`. It checks the relocated bundle inventory and that both engineering skills reach the exact packaged conversation reference.
