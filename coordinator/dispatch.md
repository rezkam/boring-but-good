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

Implementation defaults form three capability classes. The listed GPT and Claude models
are alternatives, not a requirement to have both providers. Use an available model from the
selected class, at its listed effort. Record the chosen model and the reason in the routing
table.

| Implementation class | Equivalent models | Use for |
| --- | --- | --- |
| 1 | `gpt-luna` at `high`, or `claude-sonnet` at `medium` | Complete, mechanical slices |
| 2 | `gpt-terra` at `medium`, or `claude-opus` at `low` | Prose-led implementation and integration work |
| 3 | `gpt-sol` at `medium`, or `claude-opus` at `medium` | Complex cross-layer or long-horizon work |

Choose the fastest available model in the selected class. Prefer observed throughput from
this campaign, measured as returned tokens divided by elapsed seconds. A larger model may
be the faster choice, so do not choose by model size or provider alone. When there is no
campaign measurement, use the quickest successfully completed comparable dispatch, then
record the assumption and revisit it after the first result.

Escalate exactly one class only when the task is complex or the selected class cannot make
progress. Do not skip a class simply because a stronger model is available. Class 3 has no
higher implementation class.

Review has its own two classes, checked against their own table. Review runs once, at the
end, so the class is chosen by the risk of the whole branch rather than by stage:

| Review class | Equivalent models | Use for |
| --- | --- | --- |
| 1 | `claude-opus-5` at `high`, or `gpt-5.6-terra` at `xhigh` | Narrow or mechanical branch, low blast radius |
| 2 | `claude-opus-5` at `xhigh`, or `gpt-5.6-sol` at `xhigh` | Subtle, risky, broad, or cross-layer branch |

A review dispatch declares `review 1` or `review 2` in its routing row, never an
implementation class, and the review always names its model explicitly, even when that
model equals the session default. The same model at a different effort is a different
class: `claude-opus-5` is review 1 at `high` and review 2 at `xhigh`.

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

- its own routing row as the first line, which is what makes the table match the calls:
  `ROUTE: <key> | class <1|2|3> | <provider/model:effort> | <why this class>`

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

At most three writer lanes are open at once, and a lane counts as open until you have
integrated it and run its gates yourself. A campaign that launches faster than it
integrates is accumulating integration debt: five writers went out in a single instant of
one campaign, and four hours later the branch had received none of them.

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
