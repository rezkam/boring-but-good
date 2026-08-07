# Coordinator guard

The skill is prose, and prose decays. In a real 19 hour campaign the rules were quoted
correctly in hour one, then roughly seventy dispatches went out unpinned, twenty-three
reviewers ran during implementation, committing was delegated four times, and the status
block went silent for the two hours of heaviest fan-out. Nothing refused any of it.

This turns the mechanical half of the skill into refusals at the tool boundary.

- `policy.ts`: the rules, pure and harness-agnostic. No IO, no pi imports.
- `policy.test.ts`: `node --test policy.test.ts`. Node 24 runs the TypeScript directly.
- `pi-extension.ts`: the pi wiring. Blocks tool calls, restates the contract every turn,
  and keeps the session from going quiet while agents are in flight.
- `index.ts`: the entry point pi discovers.

## Install on pi

Symlink this directory into pi's extension directory, so the installed copy is this
repository rather than a duplicate that drifts:

```bash
ln -sfn "$PWD/coordinator/guard" ~/.pi/agent/extensions/coordinator-guard
```

Link the directory, not `pi-extension.ts`. pi's loader resolves relative imports against
the symlink path rather than the real path, so a single-file link fails with
`Cannot find module './policy.ts'`, and a broken extension path is a hard pi startup
error for every session. For the same reason, never point the link at a git worktree that
may be removed.

## Enabling: three states, not a global switch

The guard is loaded in every session and enforces nothing until a coordinator campaign is
actually running. Ordinary sessions are unaffected.

| State | What is enforced | How you get there |
| --- | --- | --- |
| inert | nothing | the default in every session |
| armed | dispatches fail until a campaign is registered (CG001), and the destructive-git and bypass rules apply | the agent reads `SKILL.md`, `dispatch.md`, or `harness.md`; the user types `/skill:coordinator` or "use the coordinator"; or `/campaign arm` |
| campaign | every rule | `coordinator_campaign` action `start` |

Arming is automatic, so nothing needs to be remembered at campaign start. The footer shows
the live state (`Guard armed, no campaign`, or `Campaign <slug> 2/7, 1 open`).

Commands:

- `/campaign` shows the current contract and state
- `/campaign arm` and `/campaign disarm` force it on or off
- `/campaign close` ends the campaign and disarms, returning to inert
- `/campaign resume` re-activates a paused or closed campaign

Closing is the way out: a closed campaign is treated as no campaign, so ordinary dispatches
work again immediately.

## What fails, and why

| Code | Refuses | The incident behind it |
| --- | --- | --- |
| CG001 | Any dispatch while armed with no campaign registered | Nothing could be enforced because nothing knew a campaign was running |
| CG002 | A launch whose model is missing or lacks a `:effort` suffix, including per-agent models inside a workflow script | Roughly 70 launches inherited the session model at `xhigh`; five more carried a bare id that silently resolved to the role default |
| CG003 | A launch with no `ROUTE:` header | Routing was never written down, so plan and practice were never compared |
| CG004 | A header naming a different model than the launch, or a class that disagrees with the tier table | A campaign printed one model in its table while every agent ran another |
| CG005 | `turnBudget`, `toolBudget`, `maxTurns`, in arguments or inside a workflow script | 40+ dispatches carried hard leashes; one fan-out killed two investigations after they had already written their findings |
| CG006 | A reviewer before the review phase is open, or a second concurrent reviewer. Applies to review-shaped prompts whatever agent name they use | 23 reviewers ran during implementation, each rejection spawning a repair and a re-review, while the PR received nothing |
| CG007 | Dispatching commit, stage, rebase, push, or PR work | Committing was delegated four times to a subagent given write access to the branch |
| CG008 | A launch while the last status block is older than five minutes | Zero status blocks during the two hours of heaviest fan-out |
| CG009 | Unrendered placeholders, or a prompt missing the worktree path, the HEAD sha, or the never-push boundary | One unset interpolation shipped `cd undefined/<pkg>` to every agent in a fanout |
| CG010 | A fourth open writer lane, counting returned-but-unintegrated ones, or reusing a route key whose lane is still open | Five writers launched in one instant, nothing integrated for hours |
| CG011 | A third steer of the same run | One worker was chaperoned past 64 turns instead of being stopped and split |
| CG012 | Class 3 implementation with a label instead of a justification | Class 3 became the default for mechanical repairs |
| CG013 | An ephemeral `/tmp` or `$TMPDIR` worktree path | |
| CG014 | Spawning an agent through bash (`codex exec`, `claude -p`, `pi -p`) | Otherwise the guard only guards the polite path |
| CG016 | An action the guard cannot classify, and work deferred to a scheduler | A read-only action belongs in the guard's management list, named there rather than assumed; a scheduled run starts with no tool call, so no rule can see it |
| CG017 | A launch that does not state `async` | Whether a run is foreground depends on configuration and per-agent defaults, so a guessed mode either closes a lane while its agent works or leaves it open forever |
| CG015 | `git reset --hard`, `git stash`, `git restore`, `git checkout -- <path>`, force push | A campaign created a backup branch, ran `git reset --hard`, and destroyed a pending dependency override |

Every refusal names the exact unblock action, so a blocked call is one corrected retry
away rather than a stall.

## What it cannot do

Judgment stays with the coordinator. The guard checks that a class was declared and that
the declared class matches the model at the effort it was pinned at; it cannot tell whether
the slice was really class 2 work. It enforces the shell, not the thinking.

Workflow scripts are read as text, not parsed as JavaScript. Children must therefore be
written as literal `agent`, `model`, and `task` fields; shorthand or variables are refused
rather than waved through, because a child whose model cannot be read is a child whose
model was never pinned.

No harness can force text out of a running agent. Status cadence is therefore enforced
three ways: launches fail while the block is stale, the contract is restated in the system
prompt every turn, and a turn that ends with lanes still open queues an automatic
continuation, rate limited to one per five minutes and paused after ten continuations with
no lane changing state.
