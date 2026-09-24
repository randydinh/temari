# Show the facilities uptime walkthrough

Use this walkthrough to explain Temari to a site operations leader. The
scenario is synthetic. It demonstrates how Temari turns an uptime incident
into a bounded plan, evidence trail, and handoff.

## Run the walkthrough

From the workspace root, run:

```sh
pnpm nx run workflow-engine:demo
```

The command prints one incident and the six workflow stages:

`investigate → plan → build → review → verify → deliver`

The command also writes synthetic stage evidence to a temporary directory and
prints that directory. Use `--json` when you want the full plan and receipt.

## Use these talking points

The incident concerns an air-handler fault affecting an operating suite. The
important question is not whether Temari knows HVAC engineering. The question
is whether it can keep the response explicit, bounded, reviewable, and easy to
resume.

Point out the following parts of the output:

- The plan names the work type, evidence policy, delivery policy, and host mode.
- Each stage has a result and a retained evidence path.
- The serial host is reported honestly. The demo does not claim delegated workers.
- The closeout keeps ownership, guardrails, and open unknowns visible.

## State the boundary clearly

This walkthrough does not connect to a building-management system, dispatch a
vendor, change a control setpoint, or make a clinical decision. A real site
operations adapter would need approved integrations, identity and permission
rules, durable notifications, and domain-specific verification.

The next useful feedback is whether this incident shape matches the work a site
operations manager actually needs to coordinate. If it does, the next increment
should replace the synthetic evidence with one approved read-only source and
keep the same workflow receipt boundary.
