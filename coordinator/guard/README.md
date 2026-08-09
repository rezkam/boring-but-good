# Coordinator guard

The skill is prose, and prose decays. In a real 19 hour campaign the rules were quoted
correctly in hour one, then roughly seventy dispatches went out unpinned, twenty-three
reviewers ran during implementation, committing was delegated four times, and the status
block went silent for the two hours of heaviest fan-out. Nothing refused any of it.

This turns the mechanical half of the skill into refusals at the tool boundary.

- `policy.ts`: the rules, pure and harness-agnostic. No IO, no pi imports.
- `judge.ts`: the prompt, the verdict contract, and the strict parser for the model that
  reads dispatch prompts.
- `*.test.ts`: `node --test policy.test.ts judge.test.ts`. Node 24 runs the TypeScript directly.
- `pi-extension.ts`: the pi wiring. Blocks tool calls, calls the judge, restates the
  contract every turn, and keeps the session from going quiet while agents are in flight.
- `index.ts`: the entry point pi discovers.

## Two phases, and why

Enforcement splits by what kind of question is being asked.

**Structure** is a fact about the call: is a model pinned, does the declared class match the
tier table, is there a budget key, is the lane cap full, is the status block stale. These are
decided deterministically, before any model call, so a malformed dispatch costs nothing.

**Meaning** is what a prompt says: is this a review or an implementation, does it point at
the right worktree, does it tell the agent to rebase, is the class-3 reason a justification
or a label. A small model reads the prompt and answers those questions in a fixed JSON
shape; `policy.ts` then decides. The verdict is evidence, not a ruling.

That second half was regexes first, and it did not work. Six review rounds went into
patching them, and two rounds broke on this guard's own vocabulary: a slice named
`port-map` read as an instruction to port something, and the mandatory sentence "never push"
read as an instruction to push. Prose does not have a grammar you can match; a model reads
it, a regex counts words.

The judge sees only the dispatch prompt, delimited and labelled as data. It cannot allow
anything: it answers questions, and every decision stays in `policy.ts` where it can be
tested. Verdicts are cached per prompt, so a corrected retry costs one call, not two.

**The posture is fail closed.** A judge that cannot be resolved, errors, or answers with
something the parser cannot read whole refuses the dispatch (CG018), because an unread
prompt is an unchecked one. `/campaign judge off` turns it off; that is the user's decision,
not the agent's, and the structural rules keep running without it.

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
- `/campaign judge` shows the judge model; `/campaign judge <provider/model:effort>` changes
  it; `/campaign judge off` disables prompt rules entirely

Closing is the way out: a closed campaign is treated as no campaign, so ordinary dispatches
work again immediately.

## Campaign roles

`agents/` holds the only roles a campaign may dispatch: `campaign-worker`,
`campaign-reviewer`, and `campaign-scout`. The extension registers the directory with
pi-subagents at load through `PI_SUBAGENT_EXTRA_AGENT_DIRS`, so installing the extension
installs the roles. What a dispatched agent is told is part of what the guard
guarantees, and the builtins guarantee the opposite: pi's `reviewer` carries edit and
write tools and is told to apply fixes, `worker` forks the coordinator's conversation
into the child, and `delegate` appends the parent system prompt, campaign contract
included. `templates.test.ts` pins the role files to their boundaries.

Since pi-subagents 0.43.0 the only execution surface is `workflowScript`. A writer or
reviewer is dispatched as the only child of its own script; multi-child scripts are for
independent read-only investigations.

## Tiers and how to change them

Both axes are ordered lists of pins, defaulting to Claude first with a codex fallback.
Position one is what the injected contract tells the coordinator to reach for; the rest
are accepted, so one provider outage does not stall a campaign on refusals.

```
/campaign models                                    show both tables with measured tok/s
/campaign models gpt                                select every OpenAI default, including the judge
/campaign models claude                             select every Claude default, including the judge
/campaign models class <1|2|3> <pin>[, <pin>]       replace an implementation class
/campaign models review <1|2> <pin>[, <pin>]        replace a review class
/campaign models auto                               reorder each class fastest-measured first
/campaign models reset                              back to defaults
```

Throughput comes from pi's own session files, as output tokens over the gap to the
previous entry. That gap also holds tool and queue time, so it ranks rather than
benchmarks, and a model with fewer than five samples reports nothing rather than noise.
`auto` therefore leaves unmeasured entries where they are: no samples means unknown, not
slow. `gpt` and `claude` are the one-command provider choices. GPT selects Luna high,
Terra medium, Sol medium, Terra and Sol xhigh for review, and Luna low for the judge.
Claude selects Sonnet medium, Opus low, Opus medium, Opus high and xhigh for review, and
Sonnet low for the judge. They change dispatched agents and the judge, not the current
coordinator session; choose that session's model with pi's `/model` command.

Position one is enforced rather than suggested: a dispatch may take any entry in the list,
but reaching past the first one requires the routing reason to say why, the same sentence
class-3 escalation already costs (CG020). An outage stays survivable, and a silent
downgrade does not.

Overrides persist with the campaign and are printed whenever the guard arms, so the
enforced table is never something you have to remember.

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
| CG018 | A dispatch the judge could not read, including an unavailable judge model | An unread prompt is an unchecked one, so it fails rather than passing by default |
| CG023 | Marking the goal blocked or complete while the campaign still has work | A goal extension parked itself after a transport error, which stops the continuation an unattended campaign runs on |
| CG022 | A routing reason describing work broader than the class it declared | Sustained cross-component ownership was routed as class 1, whose meaning is a complete, mechanical slice; only escalation was ever graded |
| CG021 | A dispatch asking the harness for a managed worktree | Managed isolation branches from the session working directory rather than the campaign worktree, and puts the child under $TMPDIR at a path that does not exist when the prompt is written, so the named worktree and expected HEAD describe somewhere the child never goes |
| CG020 | A dispatch that reached past the preferred model for its class without a routing reason that explains why | Position one is the default, not a suggestion; a fallback stays available for outages, but silently ignorable preference is the shape of rule this guard replaces |
| CG019 | A dispatch through a role the campaign does not own, or through the wrong campaign role for the work | The role's prompt is part of what the guard guarantees: pi's builtin reviewer edits the tree it reviews, its worker forks the coordinator's conversation, its delegate inherits the campaign contract |
| CG017 | A launch that does not state `async` | Whether a run is foreground depends on configuration and per-agent defaults, so a guessed mode either closes a lane while its agent works or leaves it open forever |
| CG015 | `git reset --hard`, `git stash`, `git restore`, `git checkout -- <path>`, force push | A campaign created a backup branch, ran `git reset --hard`, and destroyed a pending dependency override |

Every refusal names the exact unblock action, so a blocked call is one corrected retry
away rather than a stall.

## What it cannot do

Judgment stays with the coordinator. The guard checks that a class was declared and that the
declared class matches the model at the effort it was pinned at; it cannot tell whether the
slice was really class 2 work. It enforces the shell, not the thinking.

The judge is a model, so it can be wrong. It is asked narrow, factual questions about one
delimited prompt, its answers are parsed strictly, and it can only ever supply evidence for
a rule that lives in `policy.ts`. A wrong verdict blocks a dispatch or lets a badly-shaped
one through; it cannot invent a new rule or lift an existing one.

Workflow scripts are read as text, not parsed as JavaScript. Children must therefore be
written as literal `agent`, `model`, and `task` fields; shorthand or variables are refused
rather than waved through, because a child whose model cannot be read is a child whose model
was never pinned.

No harness can force text out of a running agent. Status cadence is therefore enforced
three ways: launches fail while the block is stale, the contract is restated in the system
prompt every turn, and a turn that ends with lanes still open queues an automatic
continuation, rate limited to one per five minutes and paused after ten continuations with
no lane changing state.
