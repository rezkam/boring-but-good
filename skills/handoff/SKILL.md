---
name: handoff
description: Compact the current conversation into a handoff document for another agent to pick up.
argument-hint: What will the next session be used for?
disable-model-invocation: true
---

# Handoff

Write a handoff document summarising the current conversation so a fresh agent can continue the
work.

Save it to the repo's `.agents/handoff/` directory. If you are on a worktree other than the main
checkout, save it to `~/.agents/handoff/` instead (or `$TMPDIR` if that is not writable), not into
the worktree. Name it `<yyyy-mm-dd>-<topic-slug>.md`, and say where the file landed.

Include a "Suggested skills" section naming which skills the next agent should load.

If a worktree is in use, include its full path and branch so the next agent can work in it.

Separate what was verified from what was not run or is waiting on the user. End with the first
concrete step for the next session.

Do not duplicate content already captured in other artifacts (specs, plans, issues,
commits, diffs). Reference them by full path or URL instead. Write home paths with `~` and leave
out personal or machine-specific data, since the file may be committed.

If the user passed arguments, treat them as a description of what the next session will focus
on and tailor the document accordingly.
