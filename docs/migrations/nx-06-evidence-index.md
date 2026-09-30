# NX-06 candidate evidence index

`tools/nx06-evidence-index.mjs` makes a pending WP4 evidence index from a
retained NX-06 `result.json`. It binds the index to independently selected
candidate and rehearsal digests, the two package manifests, and both artifact
tree digests. It lists all 13 V41 compatibility rows, ten WP4 live lanes, and
external decision gates. Every item starts `PENDING`; release starts `BLOCKED`.
The generator does not install anything or write an output file.
The Archon entry is conditional on claiming that optional lane; a reviewer
must record its applicability, and this index never marks it passed or waived.

First run the existing [NX-06 rehearsal and matrix audit](nx-06-cutover-readiness.md)
against fresh packaged artifacts. Retain the exact candidate SHA and the SHA-256
of `result.json` outside that writable report. Then produce the index in the
same retained evidence directory:

```sh
node tools/nx06-evidence-index.mjs \
  --rehearsal /absolute/evidence/result.json \
  --expected-rehearsal-sha256 EXTERNALLY_RETAINED_RESULT_SHA256 \
  --expected-candidate-sha INDEPENDENTLY_SELECTED_HEAD_SHA \
  > /absolute/evidence/wp4-evidence-index.json
```

The command refuses a changed report or a candidate mismatch. The index
transcribes the rehearsal identity; it does not independently verify the
artifacts or any claim in `result.json`. Keep the original report, package
manifests, raw command output, and any later lane evidence with the index.
The existing `nx06-matrix-drift.mjs --release` remains blocked even if someone
edits this index or the rehearsal to say PASS. Future row and lane dispositions
need separately selected, revision-bound proof and independent review. An
operator's cutover approval is a separate decision, and folder archival or
deletion requires its own authorization. Preserve the v4.1 installation and
retained records while those gates are open.
