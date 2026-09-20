#!/usr/bin/env bash
# Every path a skill tells an agent to read must resolve in this worktree.
# A reference that only exists on another branch reads as authoritative and is not there.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PSTACK_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

usage() {
  echo "usage: check-skill-references.sh [--root=PATH]" >&2
  echo "Resolves every relative markdown link and referenced script in the skill package." >&2
  exit 2
}

ROOT="$PSTACK_ROOT"
for arg in "$@"; do
  case "$arg" in
    --root=*) ROOT="${arg#*=}" ;;
    *) usage ;;
  esac
done

docs=()
while IFS= read -r doc; do
  docs+=("$doc")
done < <(find "$ROOT/skills" "$ROOT/adapters" "$ROOT/verification" "$ROOT/docs" \
  \( -name node_modules -o -name .git \) -prune -o \
  -name '*.md' -type f -print 2>/dev/null | sort)
[[ ${#docs[@]} -gt 0 ]] || { echo "no skill documents found under $ROOT" >&2; exit 2; }

fail=0
checked=0

# Skills write references relative to their own directory, not to the citing file.
skill_root() {
  local d="$1"
  while [[ "$d" != "$ROOT" && "$d" != "/" ]]; do
    [[ -f "$d/SKILL.md" ]] && { echo "$d"; return; }
    d=$(dirname "$d")
  done
}

for doc in "${docs[@]}"; do
  dir=$(dirname "$doc")
  base=$(skill_root "$dir")
  # Markdown link targets, plus backticked paths. poteto-mode cites its whole
  # playbook catalog in backticks, so links alone check almost nothing.
  while IFS= read -r target; do
    [[ -n "$target" ]] || continue
    target="${target%%#*}"
    case "$target" in
      ''|http*|mailto:*) continue ;;
      *'<'*|*'>'*|*'{'*|*'*'*) continue ;;   # placeholder, not a path
      *.*) ;;                                 # needs an extension to be a file
      *) continue ;;
    esac
    checked=$((checked + 1))
    # A backticked path may be written relative to the doc or to the package root.
    for candidate in "$dir/$target" "${base:+$base/$target}" "$ROOT/$target"; do
      [[ -n "$candidate" ]] || continue
      [[ -e "$candidate" ]] && continue 2
    done
    printf 'MISSING %s\n        referenced by %s\n' "$target" "${doc#"$ROOT"/}"
    fail=1
  done < <(
    grep -oE '\]\([^)]*\)' "$doc" 2>/dev/null | sed -E 's/^\]\(//; s/\)$//'
    # Must contain a slash. A bare `HOST.md` is a generic mention, not a path.
    grep -oE '`[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)+\.(md|py|sh|ts|json|mjs)`' "$doc" 2>/dev/null | tr -d '`'
  )
done

printf 'checked=%s references across %s documents\n' "$checked" "${#docs[@]}"

if [[ "$fail" -ne 0 ]]; then
  echo "FAILED — a skill references a path that is not in this worktree" >&2
  exit 1
fi
echo "PASSED — every skill reference resolves"
