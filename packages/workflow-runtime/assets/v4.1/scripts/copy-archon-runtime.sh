#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 || "$1" != /* || "$2" != /* ]]; then
  echo "usage: copy-archon-runtime.sh <absolute-source-root> <absolute-destination>" >&2
  exit 2
fi

source_root="$1"
destination="$2"
manifest="$source_root/integrations/archon/runtime-files.txt"
[[ -f "$manifest" ]] || { echo "Archon unavailable in this distribution; select the optional archon lane" >&2; exit 2; }
[[ ! -e "$destination" && ! -L "$destination" ]] || { echo "Archon runtime destination already exists: $destination" >&2; exit 1; }

mkdir -p "$destination"
cp "$manifest" "$destination/runtime-files.txt"
while IFS= read -r relative || [[ -n "$relative" ]]; do
  [[ -n "$relative" ]] || { echo "Archon runtime manifest contains an empty path" >&2; exit 1; }
  case "$relative" in
    /*|..|../*|*/..|*/../*) echo "unsafe Archon runtime path: $relative" >&2; exit 1 ;;
  esac
  source="$source_root/integrations/archon/$relative"
  [[ -f "$source" ]] || { echo "missing Archon runtime file: $source" >&2; exit 1; }
  mkdir -p "$destination/$(dirname "$relative")"
  cp "$source" "$destination/$relative"
done < "$manifest"
