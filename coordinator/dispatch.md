# Dispatch

Read this only when a unit cleared the DIRECT/DISPATCH gate in SKILL.md and is going out.

## Mechanism

SKILL.md section 2 carries the per-harness pinning contract, including which call shape
accepts a model at all. Establish which harness you are in before planning dispatches, and
never assume a tool exists because another harness has it.

What that section does not cover: verify what actually resolved. A same-name user or
project agent definition can shadow a builtin, and a builtin's model summary may describe
the hidden builtin rather than the definition you selected. Confirm the source path,
model, effort, and tools before the first dispatch of a campaign and again after any
worktree or dependency change.

If neither model nor effort can be pinned for a stage, say so in the table and let the
user decide, rather than launching and reporting as though the plan was honored.

## Tier selection

This applies only to work that already cleared the dispatch gate in SKILL.md. It is not a
reason to dispatch something. A cheap tier existing does not make trivial work worth
delegating: if the unit is on the never-dispatch list, no row here applies to it.

Use the least capable model that finishes the role correctly in few turns. Turn count
costs more than token price: a cheap model that needs three times the turns is not cheap.

| Role | Claude | GPT |
| --- | --- | --- |
| A slice whose spec is complete and mechanical | `claude-sonnet-5` | `gpt-5.6-luna` |
| Implementation from prose, integration work | `claude-sonnet-5` | `gpt-5.6-terra` |
| Design judgment, long-horizon work | `claude-opus-5` | `gpt-5.6-sol` |
| Final whole-branch review | `claude-fable-5` at high | `gpt-5.6-sol` at high |

Implementers and fixers default to `medium` effort. Reviewer effort scales with risk;
the final review is always high and always names its model explicitly, even when that
model equals the session default.

This table is policy, not proof of availability. Resolve the model before launch and
report an unavailable tier rather than silently substituting one. Write the ID in the form
the local dispatch mechanism requires: bare on Claude Code, provider-prefixed with the
effort suffix on pi. Never carry a prefixed alias into a commit, a doc, or the PR.

When a standing project rule routes implementation elsewhere ("codex does all impl"),
the dispatch becomes a driver for that worker: same contract, same report. A worker that
cannot commit reports its diff and you commit it after verifying. When the worker fails,
the driver reports the failure instead of quietly implementing it itself.

## What every implementation dispatch carries

Give the agent a complete world. A dispatch missing any of these produces a report you
cannot trust:

- the full resolved worktree path, stated verbatim, and the branch name
- the exact expected `HEAD` sha, with an instruction to STOP and report if it differs
- the one slice, its acceptance criteria, and how it will be verified
- the boundaries: what it may not touch, and that `implementation-notes-*.md` is never
  staged
- that the global instruction file's hard rules apply to it exactly as they apply to you,
  and that its commit follows the `commit` skill. Name both rather than restating their
  contents. If the harness cannot load skills inside a subagent, say so in the dispatch
  table and paste the `commit` skill body into the prompt instead of paraphrasing it.
- that it commits locally on its branch and **never pushes, never runs `gh`, never opens
  a PR**. Pushing and PR state belong to the coordinator alone.
- what to do on conflict: stop and report, do not improvise

Lint the rendered prompt before sending it. Reject `undefined`, `null`, `NaN`, and empty
interpolations. One unset variable once shipped `cd undefined/<pkg>` to every agent in a
fanout, under a header telling them the path was verified.

## Parallel writers

Only in separate worktrees with disjoint file ownership, integrated one lane at a time in
the approved order, with the touched gates re-run after each integration. Read-only
agents may share a frozen revision. Two writers never share a worktree.

Every dispatched agent stops immediately and reports `BLOCKED_CONCURRENT_MUTATION` if
`HEAD`, `git status`, or file contents change in a way it cannot attribute to itself.

## Reading a returned report

The report is a claim. The tree is the evidence. Judge by the diff and your own gate runs.

- A schema-valid but information-free report ("test", empty strings) is a failed dispatch.
- After a `Workflow` returns, read its journal: a `started` with no matching `result`
  means an agent died and may have been silently retried. Attribute the tree state by
  diffing against your pre-dispatch snapshot before trusting anything. See
  [recovery.md](recovery.md).
- Every deviation the agent reports is adjudicated before the slice closes: ratified and
  logged with why, or reverted and fixed. A filed but unjudged deviation is an open scope
  decision hiding as a note.
