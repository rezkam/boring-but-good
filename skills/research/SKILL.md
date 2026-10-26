---
name: research
description: Investigate a question against high-trust primary sources and capture the findings as a Markdown file in the repo. Use when the user wants a topic researched, docs or API facts gathered, or reading legwork delegated to a background agent, including asks like "look up how X works", "what does the spec say", or "check the docs for".
---

# Research

Spin up a background agent to do the research, so you keep working while it reads. Use the
harness's own way to run a separate agent; if there is none, do the research inline and say so.

Investigate the question against primary sources (official docs, source code, specs, first-party
APIs), not a secondary write-up of them. Follow every claim back to the source that owns it.

Write the findings to a single Markdown file, citing each claim's source with its version,
commit, or date, because docs and APIs change. List anything you could not trace to a primary
source as Unknown, not as a finding.

Save it where the repo already keeps such notes and match the existing convention. If there is
none, prefer `.agents/research/`. On a worktree other than the main checkout, save to
`~/.agents/research/` instead. Name it `<yyyy-mm-dd>-<topic-slug>.md`, and say where the file
landed.
