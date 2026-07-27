---
name: commit
description: Stage and commit work without pulling in unrelated changes. Use whenever committing, staging, amending, or moving changed files into a worktree, and when the user says "commit only what you changed".
---

# Commit

The working tree usually contains work that is not yours. Staging is an explicit act.

## Stage only your own edits

1. `git status --porcelain` and `git diff --stat` first. Read the whole list.
2. Identify the files *you* edited this session. If unsure which those are, say so and
   ask rather than guessing.
3. Stage them by explicit path: `git add path/a path/b`.
4. Never `git add -A`, `git add .`, `git add -u`, or `git commit -a`.
5. `git diff --cached` before committing. If anything in it is not yours, unstage it.

Untracked files are not automatically yours and are not automatically disposable.

The same rule applies when moving work into a worktree: carry over the files you
changed, not everything the tree shows as dirty.

Never stage `implementation-notes-*.md`. It is a local record, not part of the change.

## Write the message

Conventional Commits: `type(scope): intent`. Types: feat, fix, refactor, test, docs,
build, ci, chore, perf, revert.

- Three sentences maximum, total.
- Say why the change exists and what outcome it achieves.
- No file-by-file summary, no filenames, no implementation narration.
- No separate "Why" section.
- No em dashes.
- No AI, agent, model, or provider attribution. No `Co-Authored-By`, no session
  trailers, no session links. If a tool adds one, remove it before committing.
- No employer name, personal name, or email.

## Before the commit lands

- The relevant tests were run and passed. Not "should pass".
- The staged diff contains only intended changes.
- No secrets, keys, tokens, or customer data in the diff.
- Generated files in the diff are there on purpose.

## Never without being asked

Amend, squash, rebase, `reset --hard`, force-push, or rewrite history. Each needs
explicit approval naming what will be rewritten.
