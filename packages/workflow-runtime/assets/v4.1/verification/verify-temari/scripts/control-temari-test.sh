#!/usr/bin/env bash
# Smoke-test control-temari launch, doctor, help, and cleanup.
# Does not replace a mapped feature proof.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONTROL="$SCRIPT_DIR/control-temari"
export TEMARI_VERIFY_ROOT="${TEMARI_VERIFY_ROOT:-/tmp/temari-verify-selftest}"
export TEMARI_BUN_ROOT="${TEMARI_BUN_ROOT:-${TMPDIR:-/tmp}/temari-bun-selftest}"
export TEMARI_VERIFY_EVIDENCE="${TEMARI_VERIFY_EVIDENCE:-$TEMARI_VERIFY_ROOT/evidence}"
RUN_ID="selftest-$$"

cleanup() {
  TEMARI_VERIFY_RUN_ID="$RUN_ID" "$CONTROL" cleanup >/dev/null 2>&1 || true
  rm -rf "$TEMARI_VERIFY_ROOT"
}
trap cleanup EXIT

"$CONTROL" launch --run-id "$RUN_ID" | grep -q "ready: run control-temari doctor next"
TEMARI_VERIFY_RUN_ID="$RUN_ID" "$CONTROL" doctor | grep -q "healthy=yes"
TEMARI_VERIFY_RUN_ID="$RUN_ID" "$CONTROL" orch -- --help | grep -q "Plain-file orchestrate bookkeeping"
"$CONTROL" workflow -- --help | grep -q "Record and verify a Temari playbook run"
TEMARI_VERIFY_RUN_ID="$RUN_ID" "$CONTROL" workflow-open smoke-route lightweight-engineering "$SCRIPT_DIR/../../.." coordinator | grep -q "started smoke-route"
if TEMARI_VERIFY_RUN_ID="$RUN_ID" "$CONTROL" workflow-drive smoke-route coordinator -- check --boundary final >/dev/null 2>&1; then
  echo "workflow-drive unexpectedly accepted an incomplete run" >&2
  exit 1
fi
TEMARI_VERIFY_RUN_ID="$RUN_ID" "$CONTROL" workflow-snapshot smoke-route before-evidence | grep -q "workflow_snapshot="
TEMARI_VERIFY_RUN_ID="$RUN_ID" "$CONTROL" journey-capture bounded-smoke 5 "$SCRIPT_DIR" -- sh -c 'printf journey-ok' | grep -q "timed_out=no"
if "$CONTROL" journey-score /tmp --candidate-root /tmp >/dev/null 2>&1; then
  echo "journey-score unexpectedly accepted a candidate-root override" >&2
  exit 1
fi
"$CONTROL" watch-pr -- --help | grep -q "Watch one pull request"
"$CONTROL" plugin-catalog | grep -q "name=temari"
"$CONTROL" playbooks | grep -q "coverage=exact"
TEMARI_VERIFY_RUN_ID="$RUN_ID" "$CONTROL" cleanup | grep -q "evidence_kept="
echo "control-temari-test: pass"
