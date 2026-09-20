#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUDIT="${WORKTREE_AUDIT_UNDER_TEST:-$SCRIPT_DIR/worktree-audit.sh}"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/temari-worktree-audit-test.XXXXXX")"
TMP="$(cd "$TMP" && pwd -P)"
trap 'rm -rf "$TMP"' EXIT

ORIGIN="$TMP/origin.git"
REPO="$TMP/repository"
BIN="$TMP/bin"
HOME_DIR="$TMP/home"
mkdir -p "$BIN" "$HOME_DIR"

git init --bare --initial-branch=main "$ORIGIN" >/dev/null
git init --initial-branch=main "$REPO" >/dev/null
git -C "$REPO" config user.name "Temari Test"
git -C "$REPO" config user.email "temari-test@example.invalid"
printf 'base\n' > "$REPO/tracked.txt"
git -C "$REPO" add tracked.txt
git -C "$REPO" commit -m base >/dev/null
git -C "$REPO" remote add origin "$ORIGIN"
git -C "$REPO" push -u origin main >/dev/null

MERGED="$TMP/merged path with spaces"
UNMERGED="$TMP/unmerged"
WIP="$TMP/tracked-wip"
SCRATCH="$TMP/untracked-scratch"
DETACHED="$TMP/detached"

git -C "$REPO" branch merged
git -C "$REPO" worktree add "$MERGED" merged >/dev/null
git -C "$REPO" worktree add -b unmerged "$UNMERGED" main >/dev/null
printf 'unmerged\n' > "$UNMERGED/unmerged.txt"
git -C "$UNMERGED" add unmerged.txt
git -C "$UNMERGED" commit -m unmerged >/dev/null
git -C "$REPO" worktree add -b tracked-wip "$WIP" main >/dev/null
printf 'changed\n' >> "$WIP/tracked.txt"
git -C "$REPO" worktree add -b untracked-scratch "$SCRATCH" main >/dev/null
printf 'scratch\n' > "$SCRATCH/scratch.txt"
git -C "$REPO" worktree add --detach "$DETACHED" main >/dev/null

printf '#!/usr/bin/env bash\nprintf '\''[{"number":7,"state":"CLOSED","headRefName":"unmerged"}]\\n'\''\n' > "$BIN/gh"
chmod +x "$BIN/gh"

before_worktrees="$(git -C "$REPO" worktree list --porcelain)"
before_wip="$(git -C "$WIP" status --porcelain=v1)"
before_scratch="$(git -C "$SCRATCH" status --porcelain=v1)"
OUTPUT="$TMP/output.tsv"
HOME="$HOME_DIR" PATH="$BIN:$PATH" "$AUDIT" "$REPO" > "$OUTPUT"

assert_field() {
  local path="$1"
  local field="$2"
  local expected="$3"
  local actual
  actual="$(awk -F '\t' -v path="$path" -v field="$field" '$9 == path { print $field }' "$OUTPUT")"
  if [[ "$actual" != "$expected" ]]; then
    echo "expected field $field for $path to be '$expected', got '$actual'" >&2
    sed -n '1,20p' "$OUTPUT" >&2
    exit 1
  fi
}

assert_field "$MERGED" 3 YES
assert_field "$MERGED" 8 safe
assert_field "$UNMERGED" 3 no
assert_field "$UNMERGED" 6 '#7/CLOSED'
assert_field "$UNMERGED" 8 review
assert_field "$WIP" 4 wip:1
assert_field "$WIP" 8 hold-wip
assert_field "$SCRATCH" 4 scratch:1
assert_field "$SCRATCH" 8 hold-scratch
assert_field "$DETACHED" 5 detached

[[ "$(git -C "$REPO" worktree list --porcelain)" == "$before_worktrees" ]]
[[ "$(git -C "$WIP" status --porcelain=v1)" == "$before_wip" ]]
[[ "$(git -C "$SCRATCH" status --porcelain=v1)" == "$before_scratch" ]]

echo "worktree audit behavior passed"
