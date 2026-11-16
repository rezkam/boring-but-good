#!/bin/sh
# Make ~/.claude/skills mirror ~/.agents/skills with one relative symlink per skill.
#
# pi and Codex read ~/.agents/skills natively. Claude Code only reads ~/.claude/skills,
# and writes its own managed content there (the "synced" folder), so that directory
# stays a real directory and gets one link per shared skill.
#
# Only symlinks are created or removed. Real entries are never touched.
set -eu

src="$HOME/.agents/skills"
dst="$HOME/.claude/skills"

if [ ! -d "$src" ]; then
  echo "error: $src does not exist" >&2
  exit 1
fi
if [ -L "$dst" ] || [ ! -d "$dst" ]; then
  echo "error: $dst must be a real directory (not a symlink, not missing)" >&2
  exit 1
fi

# Add or refresh a link for every shared skill that has a SKILL.md.
for dir in "$src"/*/; do
  name=$(basename "$dir")
  [ -f "$dir/SKILL.md" ] || continue
  if [ -e "$dst/$name" ] && [ ! -L "$dst/$name" ]; then
    echo "skip $name: real entry in $dst" >&2
    continue
  fi
  ln -sfn "../../.agents/skills/$name" "$dst/$name"
done

# Remove links whose skill is gone from the shared directory.
for link in "$dst"/*; do
  [ -L "$link" ] || continue
  if [ ! -f "$link/SKILL.md" ]; then
    rm "$link"
    echo "removed stale link $(basename "$link")"
  fi
done
