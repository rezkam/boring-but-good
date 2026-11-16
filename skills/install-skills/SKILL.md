---
name: install-skills
description: Install, update, list, or remove agent skills so Claude Code, pi, and Codex all see the same set. Use whenever the user wants to add a skill, install skills from boring-but-good or any other repository, link a skill, remove a skill, or fix a skill that one agent can see and another cannot.
---

# Install skills

One directory holds every skill: `~/.agents/skills`. Each skill is a directory with a
`SKILL.md`.

| Agent | How it sees `~/.agents/skills` |
|---|---|
| pi | Reads it natively. |
| Codex | Reads it natively. |
| Claude Code | Reads only `~/.claude/skills`, which is a real directory (Claude writes its own `synced` folder there) holding one symlink per shared skill. |

Never put a skill directly into `~/.claude/skills`, `~/.codex/skills`, or
`~/.pi/agent/skills`. Do not add `~/.claude/skills` to pi's `skills` setting: pi would load
Claude's `synced` folder too.

Two sources, two methods.

## Your own skills (boring-but-good and other local repos): symlink

The repository stays the single copy, so `git pull` updates the skill everywhere.

1. Use the main checkout, not a worktree. A worktree link dies when the worktree is removed.
2. Link it:

   ```sh
   <this-skill-dir>/scripts/link-own-skill.sh <checkout>/skills/<name>
   ```

   The script checks the target is a skill, its `name:` matches its directory, it is not in a
   worktree, and the shared name is not already a real directory. It creates a relative link in
   `~/.agents/skills/<name>` and refreshes the Claude links.
3. To link every skill in a checkout, run the script once per directory under `skills/`.

## Skills from anyone else (published repositories): npx skills

```sh
npx skills add <owner>/<repo> -g -a universal -s <skill> -y
```

- `-g` installs at user level. `-a universal` writes to `~/.agents/skills/<name>`, the shared
  directory. Do not pass other agent names, `-a '*'`, or `--all`: they write into each agent's
  own directory and recreate the duplication.
- `npx skills add <owner>/<repo> --list` shows what a repository offers before installing.
- This copies the files. It does not link them. Keep them current with
  `npx skills update -g`.
- The CLI records installs in `~/.agents/.skill-lock.json`.
- Afterwards refresh Claude: `<this-skill-dir>/scripts/link-claude-skills.sh`.

Installed skills run with the agent's full permissions. Read a third-party `SKILL.md` and its
scripts before installing.

Before running the CLI, confirm that `npx skills add --help` still lists `-g` and `-a` and that
`universal` still means `~/.agents/skills` (the CLI changes between versions). If it does not,
say so and stop.

## Remove a skill

- Linked skill: delete the symlink in `~/.agents/skills`. The repository is untouched.
- npx skill: `npx skills remove -g <name>`. This also drops its lock entry.
- Then run `scripts/link-claude-skills.sh`, which removes the stale Claude link.

Deleting anything needs the user's approval, naming the exact path.

## Verify

Show evidence that all three agents resolve the same set:

```sh
ls ~/.agents/skills
ls -l ~/.claude/skills
for d in ~/.agents/skills ~/.claude/skills; do
  for l in "$d"/*; do [ -L "$l" ] && [ ! -e "$l" ] && echo "dangling: $l"; done
done
```

Report any dangling link, any skill missing a `SKILL.md`, and any name present in one place but
not the other. A skill is not installed until a fresh agent session lists it. Say which agents you
did not start.

## Rules

- Write home paths as `~`. No personal or machine-specific names in anything committed.
- Do not edit `~/.claude/skills/synced`; Claude manages it.
- A name collision between a linked skill and an npx skill is the user's call. Report both
  sources and ask.
