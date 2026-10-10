---
name: closeout
description: Persist and verify a current Temari run only through trusted invocation and independently selected candidate state.
---

# Closeout

The bundled [method library](../temari/references/method-library.md) supplies
engineering guidance. This public entry retains the canonical closeout contract;
the library's historical closeout and receipt tools do not replace it.

Verify a completed local run with the installed `bin/closeout.mjs` entry.
This operation reads the canonical receipt, stage evidence, workspace manifests,
and current product. It never grants merge, archive, deployment, independent QA,
or plugin replacement authority.

1. Select the current candidate identity from reviewed product bytes and file
   modes. Use the original admitted scope: `local-regular-files-v1` for regular-file
   runs, or `git-tracked-files-v1` for newly admitted Git-backed feature runs.
   Save `{ "scope": "ADMITTED_SCOPE", "sha256": "HEX" }` as a
   regular JSON file outside the run directory and candidate. Do not take the
   value from the receipt, checkpoint, or stage evidence being verified.
2. Supply the original admitted `temari` or `poteto-mode` request. Get the
   request, selected-identity file, and installed bundle manifest SHA-256 values
   from trusted inputs outside those files.
3. Run the command below with absolute paths. Exit 0 with
   `status: "candidate-verified"` establishes only the selected local
   candidate boundary. Any refusal exits nonzero and has no verified result.

```sh
node /isolated/bundle/bin/closeout.mjs verify \
  --request /isolated/request.json \
  --expected-request-sha256 REQUEST_SHA256 \
  --expected-manifest-sha256 BUNDLE_MANIFEST_SHA256 \
  --expected-current /isolated/selected-current.json \
  --expected-current-sha256 SELECTION_FILE_SHA256
```

The command requires the original six-stage PASS receipt, current product
identity, source requirement claims, stage evidence, and stage workspace
manifests. It derives the host-bound scope from the validated retained
invocation and opens existing stores without creating files. `policy` describes
the interface; `admit --run-directory` remains a blocked preflight because it
does not carry the trusted inputs.

Git feature selection uses the verified integration checkout, not the original
source. Observe its tracked regular-file bytes/modes and pinned dependency plan
through the packaged runtime's `observeCandidate` with
`observation: 'git-tracked-files-v1'`; do not hash Git administration or copy a
receipt digest. The Git scope excludes ignored/private payloads and refuses
nested dependencies. Closeout independently revalidates the original source,
exact integration commit, dependency tracked bytes, host proof and canonical
receipt. A changed child invalidates closeout even when parent status ignores
submodules. Old receipts keep their original observation semantics.
