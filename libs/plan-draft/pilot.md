# Run one configured local pilot

Use this guide to start or resume one authorized local Markdown draft. It assumes
you maintain the deployment and already have approved inputs. The entry does not
select a model service, prepare sources, or create write authority.

## Prepare the inputs

1. Use Node 24.18.0 and pnpm 9.15.9 on a local POSIX host for the verified command
   paths below. Run them from the workspace root after installing its dependencies.
2. Supply an existing isolated Registrar preparation and explicit Python and
   Registrar source paths. Admit the whole copied source root, not just selected
   documents. See the [Registrar preparation contract](../knowledge/README.md).
3. Supply the approved [command configuration](command-judgments.md#configuration-and-caller-wiring)
   and a wrapper that implements its protocol. Keep the original artifact hashes.
   Do not recompute them to approve changed files during recovery.
4. Obtain authorization for the task and exact output path. Supply the existing
   [authority record and its byte hash](README.md#input-and-authority). Source
   documents and review approval do not grant write permission.
5. Write a schema-1 JSON file using the [configuration reference](pilot-configuration.md).
   Use an absolute path outside tracked product source. Keep credentials out of
   this file. For live judgment, authorize both the service and the input corpus
   before you run the entry.

## Start the pilot

Check the entry's help without constructing its dependencies:

```sh
pnpm nx run plan-draft:pilot -- --help
```

Replace the path below with your prepared configuration file. The target is
uncached. Execution constructs the Registrar, which runs a configuration and list
preflight and can maintain extraction caches. This is not a dry run.

```sh
pnpm nx run plan-draft:pilot -- --config=/absolute/path/to/pilot.json
```

For a machine-readable outcome without Nx console framing, invoke the entry
directly from the workspace root:

```sh
node --import @swc-node/register/esm-register \
  libs/plan-draft/src/pilot.ts --config /absolute/path/to/pilot.json
```

Inspect the complete JSON outcome on stdout and the status and evidence paths on
stderr. For a successful run, require `kind: "draft"` and `draft.status: "PASS"`.
Read the actual output file and the saved review candidate. Compare their exact
UTF-8 bytes and SHA-256. Check the original investigation separately. It can be
`BLOCKED` while a draft passes under the existing discovery-gap rules.

## Resume the same operation

Keep the original Registrar and judgment configuration. Replace only `command`
with the resume form in the configuration reference, using the original task and
destination. Run the same entry command against that file. Do not supply a new
intent, change service identity, repair records, or create another authority hash
to make a blocked operation pass.

If accepted draft preparation exists, recovery does not require judgment commands
to remain available. Registrar construction and source revalidation still apply.
An earlier saved boundary can invoke downstream roles that have not yet started.
If a judgment may have run without a saved result, the caller blocks repetition.
Preserve those artifacts for a decision about a new authorized operation.

## Inspect failures before another attempt

- For exit 1, inspect the fixed setup-error category on stderr. No conversation
  outcome is available. Check the explicit file, schema, judgment configuration,
  or Registrar configuration named by that category.
- For exit 2, inspect the full returned outcome and surviving evidence paths.
  A blocked result can retain a previously published draft. Do not infer that no
  file exists, delete records, or retry a judgment manually.
- If a completed output is missing or has changed, preserve the remaining
  evidence. Resume does not recreate or overwrite that output.
- If required source evidence or identity has changed, inspect the difference.
  Do not refresh sources or approve new artifact hashes within the old operation.

For review, retain the configuration securely, repository revision, command and
exit code, full outcome, and existing draft and evidence files. Do not include
credentials. Existing records retain admitted results, not every raw exchange or
failed launch. Do not repeat uncertain work to obtain a better transcript.

The synthetic integration tests prove composition and recovery mechanics. They
do not prove useful live model judgment, independent reasoning, or reduced human
review. Those require a separately authorized live pilot.
