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

## Check an external overlay before installation

The operator owns this check. Keep the overlay outside the Temari
repository and obtain the public bundle and overlay manifest SHA-256 digests
from a trusted source before running it. A digest calculated from an untrusted
copy at check time does not establish that the copy was approved.

The overlay root contains `temari-overlay.json` and exactly the assets named
in it. The version 1 manifest has these fields:

```json
{
  "schemaVersion": 1,
  "overlayId": "team-reference",
  "compatiblePublicManifestSha256": "<approved public-entry-manifest.json SHA-256>",
  "assets": [
    {
      "path": "knowledge/guide.md",
      "kind": "knowledge",
      "sha256": "<approved guide.md SHA-256>",
      "bytes": 123
    }
  ],
  "credentialRefs": [
    {
      "id": "model",
      "provider": "openai",
      "handle": "credential-ref:team-model"
    }
  ]
}
```

`kind` is `skill`, `knowledge`, or `provider-profile`. Credential handles are
opaque names; the manifest cannot contain a credential value. It has no stage,
capability-grant, or workflow-authority fields. A host must resolve a handle
separately and prove any required capability itself.

For an overlay, run the installed checker with the independently pinned
digests:

```sh
node /absolute/public-bundle/bin/overlay-check.mjs \
  --expected-manifest-sha256 APPROVED_PUBLIC_SHA256 \
  --overlay-root /absolute/external-overlay \
  --expected-overlay-sha256 APPROVED_OVERLAY_MANIFEST_SHA256
```

The checker verifies the entire public bundle, then the overlay manifest,
exact file inventory, sizes, and bytes. Success prints `"status":"compatible"`
with the overlay ID and counts; failure exits 1. It does not print asset
contents or credential handles. To check a host with no overlay, omit the two
overlay flags; success prints the same status with `"overlayId":null`.

This is an install-time compatibility and integrity check. It does not load
the overlay into a workflow, resolve a credential, prove a host capability, or
approve private use. Keep the previously approved overlay and bundle available
if a new pair fails this check.
