# Overlays: what stays out of this repository

Temari is shared with coworkers as a portable platform. Personal and
OpConnect material must be installable **without** living in git here.

## In this repository

- Workflow contracts and the one engine
- Host adapter _interfaces_ and honest capability reports
- Playbook templates (not Cursor-only API calls)
- Verifier, routing evals, packaging
- Decision ledger for product behavior

## Overlay (user or host profile, not this repo)

| Kind                      | Examples                                              | Where it belongs                                         |
| ------------------------- | ----------------------------------------------------- | -------------------------------------------------------- |
| Personal skills and modes | `automate-me`, sports-analyst, product-foundry        | `~/.temari/` or host skill root                          |
| Employer product          | `source/opconnect/*`, Core, SupportBot, QA_Automation | OpConnect workspaces, `randydinh-opconnect`              |
| Secrets                   | tokens, `.env`, vault items                           | Host credential store; workers get profile _references_  |
| Optional research tools   | Graphify, Archon live transcripts                     | Optional package or local tool, stripped of private runs |
| Grok Bot team templates   | dr-eggbot account bindings                            | Personal agent config                                    |

## Rule

If a coworker at another company cannot use the file, it is an overlay.
If swapping Cursor for Claude would require rewriting the file, it belongs
in a host adapter, not in core.
