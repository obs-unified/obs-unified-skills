#!/usr/bin/env bash
# Validate a skill: confirms SKILL.md exists, has the required frontmatter
# fields (name, description), and that the name matches the directory.
#
# Usage: scripts/validate.sh <skill-dir-name>

set -euo pipefail

SKILL="${1:?usage: $0 <skill-dir-name>}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO_ROOT/$SKILL/SKILL.md"

if [ ! -f "$SRC" ]; then
  echo "FAIL ($SKILL): missing SKILL.md" >&2
  exit 1
fi

# Extract frontmatter (between the first two --- lines)
FRONTMATTER=$(awk '/^---$/{c++; next} c==1' "$SRC")

if ! echo "$FRONTMATTER" | grep -q '^name:'; then
  echo "FAIL ($SKILL): frontmatter missing 'name' field" >&2
  exit 1
fi

if ! echo "$FRONTMATTER" | grep -q '^description:'; then
  echo "FAIL ($SKILL): frontmatter missing 'description' field" >&2
  exit 1
fi

NAME=$(echo "$FRONTMATTER" | grep '^name:' | head -1 | sed 's/^name:[[:space:]]*//' | tr -d ' ')
if [ "$NAME" != "$SKILL" ]; then
  echo "FAIL ($SKILL): frontmatter name '$NAME' does not match directory '$SKILL'" >&2
  exit 1
fi

echo "ok ($SKILL)"
