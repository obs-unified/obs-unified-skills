#!/usr/bin/env bash
# Package a skill directory into a .skill file (a zip archive).
# Excludes evals/, node_modules, __pycache__, .DS_Store.
#
# Usage: scripts/package.sh <skill-dir-name>
# Example: scripts/package.sh instrument-obs-unified

set -euo pipefail

SKILL="${1:?usage: $0 <skill-dir-name>}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO_ROOT/$SKILL"
OUT="$REPO_ROOT/dist/$SKILL.skill"

if [ ! -d "$SRC" ]; then
  echo "skill dir not found: $SRC" >&2
  exit 1
fi

if [ ! -f "$SRC/SKILL.md" ]; then
  echo "missing SKILL.md in $SRC" >&2
  exit 1
fi

mkdir -p "$REPO_ROOT/dist"
rm -f "$OUT"

cd "$REPO_ROOT"
# zip the skill directory; -x patterns excludes evals/, __pycache__, etc.
zip -r "$OUT" "$SKILL" \
  -x "$SKILL/evals/*" \
  -x "*__pycache__*" \
  -x "*.pyc" \
  -x "*.DS_Store" \
  -x "*node_modules*" \
  >/dev/null

echo "built: $OUT ($(du -h "$OUT" | cut -f1))"
