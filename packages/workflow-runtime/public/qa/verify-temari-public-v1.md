# Verify Temari public CLI v1

Target: a candidate checkout whose `package.json` names `@temari/workspace`. This is a project verifier handoff, not proof of execution.

For an installed Temari public entry, pin the artifact manifest digest and request digest outside the request. Run the relocated `bin/temari.mjs policy`, then the selected `qa` request against an existing canonical evidence root. Check the process exit, retained `config/qa-result.json`, evaluator input/output identity, scenario observations, QA disposition, and denied external writes. A CLI policy response or successful package check proves only that layer.

Use the project's actual verifier or control adapter for product behavior beyond the public CLI. This handoff supplies no browser, API, or station control for another application. Record `NotRun` or `BlockedOrIncomplete` when that surface is unavailable.
