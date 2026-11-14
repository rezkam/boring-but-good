#!/bin/sh
# Install one of your own skills by symlinking its directory into ~/.agents/skills.
#
# Usage: link-own-skill.sh <path-to-skill-directory>
#
# Refuses a target that is not a skill, a git worktree (it disappears when the worktree
# is removed), or a name that already holds a real directory. Afterwards it refreshes the
# Claude Code links so all three agents see the same skills.
set -eu

die() { echo "error: $*" >&2; exit 1; }

[ $# -eq 1 ] || die "usage: link-own-skill.sh <path-to-skill-directory>"
[ -d "$1" ] || die "$1 is not a directory"

target=$(cd "$1" && pwd -P)
name=$(basename "$target")
[ -f "$target/SKILL.md" ] || die "$target has no SKILL.md"

declared=$(sed -n 's/^name:[[:space:]]*//p' "$target/SKILL.md" | head -n 1)
[ "$declared" = "$name" ] || die "frontmatter name '$declared' does not match directory '$name'"

if git -C "$target" rev-parse --git-dir >/dev/null 2>&1; then
  gitdir=$(git -C "$target" rev-parse --absolute-git-dir)
  common=$(git -C "$target" rev-parse --path-format=absolute --git-common-dir)
  [ "$gitdir" = "$common" ] || die "$target is inside a git worktree; link the main checkout instead"
  branch=$(git -C "$target" branch --show-current)
  case "$branch" in
    main|master) ;;
    *) echo "warning: $target is on branch '$branch', not main" >&2 ;;
  esac
else
  echo "warning: $target is not in a git repository, nothing versions it" >&2
fi

shared="$HOME/.agents/skills"
mkdir -p "$shared"
dest="$shared/$name"

if [ -e "$dest" ] && [ ! -L "$dest" ]; then
  die "$dest is a real directory; move it away first"
fi

rel=$(python3 -c 'import os,sys; print(os.path.relpath(sys.argv[1], sys.argv[2]))' "$target" "$shared")
ln -sfn "$rel" "$dest"
echo "linked $name -> $rel"

if [ -d "$HOME/.claude/skills" ] && [ ! -L "$HOME/.claude/skills" ]; then
  "$(dirname "$0")/link-claude-skills.sh"
fi
