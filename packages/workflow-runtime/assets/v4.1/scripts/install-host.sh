#!/usr/bin/env bash
# Install Temari host entry skills into a skill discovery root.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: ./scripts/install-host.sh --host=<codex|claude-code|generic> --dest=<absolute-skill-root> [--mode=symlink|copy] [--include-verification]

  --host    Target harness adapter
  --dest    Absolute directory where the host discovers skills (created if missing)
  --mode    symlink (default) or copy
  --include-verification  Install the repository-owned verify-temari projection too

Cursor needs no install via this script: add the Temari plugin.
USAGE
}

HOST=""
DEST=""
MODE="symlink"
INCLUDE_VERIFICATION="no"

for arg in "$@"; do
  case "$arg" in
    --host=*) HOST="${arg#*=}" ;;
    --dest=*) DEST="${arg#*=}" ;;
    --mode=*) MODE="${arg#*=}" ;;
    --include-verification) INCLUDE_VERIFICATION="yes" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; usage; exit 2 ;;
  esac
done

if [[ -z "$HOST" || -z "$DEST" ]]; then
  usage
  exit 2
fi

case "$HOST" in
  codex|claude-code|generic) ;;
  cursor)
    echo "cursor is native — add the Temari plugin" >&2
    exit 2
    ;;
  *)
    echo "unsupported host: $HOST" >&2
    exit 2
    ;;
esac

if [[ "$DEST" != /* ]]; then
  echo "--dest must be an absolute path" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PSTACK_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ADAPTER="$PSTACK_ROOT/adapters/$HOST"
ENTRY_SKILLS=(temari poteto-mode closeout)

if [[ ! -f "$ADAPTER/HOST.md" ]]; then
  echo "missing adapter: $ADAPTER/HOST.md" >&2
  exit 1
fi
for skill in "${ENTRY_SKILLS[@]}"; do
  if [[ ! -f "$ADAPTER/skills/$skill/SKILL.md" ]]; then
    echo "missing entry skill: $ADAPTER/skills/$skill/SKILL.md" >&2
    exit 1
  fi
done

mkdir -p "$DEST"

case "$MODE" in
  symlink|copy) ;;
  *) echo "unsupported mode: $MODE" >&2; exit 2 ;;
esac

BACKUP="$DEST/.temari-backups/$(date -u +%Y%m%dT%H%M%SZ).$$"
backup_target() {
  local target="$1"
  if [[ -e "$target" || -L "$target" ]]; then
    mkdir -p "$BACKUP"
    mv "$target" "$BACKUP/$(basename "$target")"
  fi
}

BACKUP_TARGETS=(temari poteto-mode closeout pstack-root pstack-HOST.md .temari-package)
if [[ "$INCLUDE_VERIFICATION" == yes ]]; then
  BACKUP_TARGETS+=(verify-temari)
fi
for target in "${BACKUP_TARGETS[@]}"; do
  backup_target "$DEST/$target"
done

if [[ "$MODE" == "copy" ]]; then
  BUNDLE="$DEST/.temari-package"
  mkdir -p "$BUNDLE/adapters/$HOST" "$BUNDLE/adapters/codex"
  cp -R "$PSTACK_ROOT/skills" "$BUNDLE/skills"
  cp -R "$PSTACK_ROOT/verification" "$BUNDLE/verification"
  cp -R "$PSTACK_ROOT/agents" "$BUNDLE/agents"
  if [[ -f "$PSTACK_ROOT/integrations/archon/runtime-files.txt" ]]; then
    mkdir -p "$BUNDLE/integrations"
    "$PSTACK_ROOT/scripts/copy-archon-runtime.sh" "$PSTACK_ROOT" "$BUNDLE/integrations/archon"
  else
    echo "archon=unavailable (portable distribution)"
  fi
  cp -R "$PSTACK_ROOT/docs" "$BUNDLE/docs"
  cp -R "$PSTACK_ROOT/scripts" "$BUNDLE/scripts"
  cp "$PSTACK_ROOT/LICENSE" "$PSTACK_ROOT/UPSTREAM.md" "$BUNDLE/"
  cp -R "$PSTACK_ROOT/adapters/." "$BUNDLE/adapters/"
  # The canonical verifier uses this portable metadata fallback when the
  # copied bundle is no longer inside the source checkout.
  cp "$PSTACK_ROOT/adapters/codex/plugin.json" "$BUNDLE/adapters/codex/plugin.json"
  for skill in "${ENTRY_SKILLS[@]}"; do
    cp -R "$ADAPTER/skills/$skill" "$DEST/$skill"
  done
  cp "$ADAPTER/HOST.md" "$DEST/pstack-HOST.md"
  if [[ "$INCLUDE_VERIFICATION" == yes ]]; then
    cp -R "$ADAPTER/skills/verify-temari" "$DEST/verify-temari"
  fi
  printf '%s\n' '.temari-package' > "$DEST/pstack-root"
else
  for skill in "${ENTRY_SKILLS[@]}"; do
    ln -s "$ADAPTER/skills/$skill" "$DEST/$skill"
  done
  if [[ "$INCLUDE_VERIFICATION" == yes ]]; then
    ln -s "$ADAPTER/skills/verify-temari" "$DEST/verify-temari"
  fi
  printf '%s\n' "$PSTACK_ROOT" > "$DEST/pstack-root"
  ln -s "$ADAPTER/HOST.md" "$DEST/pstack-HOST.md"
fi

echo "installed host=$HOST mode=$MODE"
for skill in "${ENTRY_SKILLS[@]}"; do
  echo "  entry:  $DEST/$skill"
done
if [[ "$INCLUDE_VERIFICATION" == yes ]]; then
  echo "  entry:  $DEST/verify-temari"
fi
echo "  root:   $DEST/pstack-root -> $(cat "$DEST/pstack-root")"
echo "  host:   $DEST/pstack-HOST.md"
if [[ -d "$BACKUP" ]]; then
  echo "  backup: $BACKUP"
fi
echo "read $DEST/pstack-HOST.md, then start with Temari, invoke poteto-mode directly, or use closeout for a durable task exit."
