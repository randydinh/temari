# Temari dashboard local release

This guide is for the person running Temari against a local product repository.
It installs one built dashboard directory, keeps its state outside the product,
and applies only the candidate retained by that task's reviewed completion.

The first release supports macOS, Node.js 22, Git repositories, and a local
loopback dashboard. It does not publish branches or pull requests. The Talk
adapter remains deferred.

## Build the installable directory

From the Temari Nx workspace, run:

```sh
pnpm exec nx run dashboard:build
```

Install the complete `apps/dashboard/dist` directory. `main.mjs` is the
executable entry point. The directory also contains the browser assets, owned
process helpers, the bundled managed workflow bridge and operation, and the
native workflow YAML. The managed workflow does not load TypeScript or other
files from the Temari source checkout.

Set a short shell variable for the examples:

```sh
TEMARI_DASHBOARD=/absolute/path/to/installed-dashboard/main.mjs
```

## Create a project profile

A profile is the reusable, versioned configuration for one product. It replaces
the separate control JSON previously supplied to the source dashboard. Use
absolute, canonical paths.

```json
{
  "schema": 1,
  "id": "my-product",
  "archonHome": "/absolute/path/to/archon-state",
  "port": 3095,
  "control": {
    "schema": 1,
    "workspaceRoot": "/absolute/path/to/my-product",
    "preparationRoot": "/absolute/path/to/temari-preparation",
    "recipes": []
  }
}
```

`control` uses the existing dashboard configuration contract. A managed local
candidate profile still pins the task store, evidence root, Codex executable,
provider and model selection, workers, checks, and protected inputs. Set its
bridge selection to `"bridge": "packaged"` and omit `bridgePath` and
`bridgeSha256`. `configure` resolves the installed bridge, hashes it, adds it to
the protected inputs, validates the resulting control configuration, and writes
the materialized configuration under the dashboard home.

The managed candidate and planning policy fields are documented in
[Reviewed local candidate source operation](reviewed-local-candidate.md#dashboard-source-launcher).

## Configure and run

The default dashboard home is
`~/Library/Application Support/Temari/dashboard`. Supply the same `--home`
argument to every command when using another location.

```sh
node "$TEMARI_DASHBOARD" configure --profile /absolute/path/to/my-product.json
node "$TEMARI_DASHBOARD" doctor
node "$TEMARI_DASHBOARD" start
node "$TEMARI_DASHBOARD" status
```

`configure` creates the task store, cache, and log directories. `doctor` must
return `"status": "PASS"`. `start` returns the loopback URL and reuses an
already healthy process. The PID, selected profile digest, logs, task ledger,
application receipts, and closeout receipts persist under the dashboard home.

Open the URL returned by `start`. A later stop and start uses the same task
ledger:

```sh
node "$TEMARI_DASHBOARD" stop
node "$TEMARI_DASHBOARD" start
```

If startup fails, inspect `logs/dashboard.log` under the dashboard home and run
`doctor`. A dead process with a retained runtime record appears as `stale`; a
new `start` removes that record and starts a new process.

## Apply and close out a reviewed candidate

When the dashboard reports a reviewed local candidate, stop the coordinator
before changing the product checkout:

```sh
node "$TEMARI_DASHBOARD" stop
node "$TEMARI_DASHBOARD" apply --task TASK_ID
node "$TEMARI_DASHBOARD" closeout --task TASK_ID
```

`apply` selects the single `reviewed-local-candidate-completion` reference from
the task's durable handoff. It verifies the retained digest, PASS profile and
binding, exact clean base checkout, exact clean candidate commit, and ancestor
relationship. It then fetches locally and performs a fast-forward-only merge.
The immutable receipt is stored by task and candidate commit. Repeating the same
command reopens and verifies that receipt.

`closeout` reopens the task-selected completion and application receipt, checks
that the product is still clean at the applied commit, and stores an immutable
closeout receipt. Publication remains denied. A dirty checkout, changed task
handoff, moved candidate, changed digest, wrong base, non-fast-forward history,
or running dashboard refuses the operation.

## Release verification

Run the focused release journey from the Nx workspace:

```sh
pnpm exec nx run dashboard:release-smoke --skip-nx-cache
```

The journey copies the built directory to a disposable installation, imports
the packaged managed bridge there, configures a disposable Git product, runs
`doctor`, and executes the real native managed workflow through a deterministic
Codex transport. It stops and restarts the dashboard while that run is active,
recovers the reviewed completion, proves that a dirty product is refused,
applies the exact candidate, retries idempotently, and closes out twice. It
deletes the disposable environment after the proof.
