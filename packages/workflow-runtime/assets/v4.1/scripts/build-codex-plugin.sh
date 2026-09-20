#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: ./scripts/build-codex-plugin.sh --output=/absolute/plugin-directory" >&2
}

OUTPUT=""
for arg in "$@"; do
  case "$arg" in
    --output=*) OUTPUT="${arg#*=}" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; usage; exit 2 ;;
  esac
done

if [[ -z "$OUTPUT" || "$OUTPUT" != /* || "$OUTPUT" == "/" ]]; then
  echo "--output must be an absolute, non-root path" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMARI_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT_PARENT="$(dirname "$OUTPUT")"
OUTPUT_NAME="$(basename "$OUTPUT")"
mkdir -p "$OUTPUT_PARENT"

STAGE="$(mktemp -d "$OUTPUT_PARENT/.${OUTPUT_NAME}.stage.XXXXXX")"
cleanup() {
  if [[ -d "$STAGE" ]]; then
    rm -rf "$STAGE"
  fi
}
trap cleanup EXIT

mkdir -p "$STAGE/.codex-plugin" "$STAGE/skills" "$STAGE/package/adapters/codex"
cp "$TEMARI_ROOT/adapters/codex/plugin.json" "$STAGE/.codex-plugin/plugin.json"
cp -R "$TEMARI_ROOT/adapters/codex/skills/temari" "$STAGE/skills/temari"
cp -R "$TEMARI_ROOT/adapters/codex/skills/poteto-mode" "$STAGE/skills/poteto-mode"
cp -R "$TEMARI_ROOT/adapters/codex/skills/closeout" "$STAGE/skills/closeout"
cp -R "$TEMARI_ROOT/skills" "$STAGE/package/skills"
cp -R "$TEMARI_ROOT/verification" "$STAGE/package/verification"
cp -R "$TEMARI_ROOT/agents" "$STAGE/package/agents"
if [[ -f "$TEMARI_ROOT/integrations/archon/runtime-files.txt" ]]; then
  mkdir -p "$STAGE/package/integrations"
  "$TEMARI_ROOT/scripts/copy-archon-runtime.sh" "$TEMARI_ROOT" "$STAGE/package/integrations/archon"
else
  echo "archon=unavailable (portable distribution)"
fi
cp -R "$TEMARI_ROOT/adapters/." "$STAGE/package/adapters/"
cp -R "$TEMARI_ROOT/docs" "$STAGE/package/docs"
cp -R "$TEMARI_ROOT/scripts" "$STAGE/package/scripts"
cp "$TEMARI_ROOT/LICENSE" "$TEMARI_ROOT/UPSTREAM.md" "$STAGE/package/"
cp "$TEMARI_ROOT/adapters/codex/HOST.md" "$STAGE/package/adapters/codex/HOST.md"
cp "$TEMARI_ROOT/adapters/codex/plugin.json" "$STAGE/package/adapters/codex/plugin.json"
cp "$TEMARI_ROOT/LICENSE" "$STAGE/LICENSE"
cp "$TEMARI_ROOT/UPSTREAM.md" "$STAGE/UPSTREAM.md"

if [[ -e "$OUTPUT" || -L "$OUTPUT" ]]; then
  BACKUP="$OUTPUT_PARENT/.${OUTPUT_NAME}.backup.$(date -u +%Y%m%dT%H%M%SZ).$$"
  mv "$OUTPUT" "$BACKUP"
  echo "backup: $BACKUP"
fi
mv "$STAGE" "$OUTPUT"
trap - EXIT
echo "built: $OUTPUT"
