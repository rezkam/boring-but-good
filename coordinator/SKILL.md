---
name: coordinator
description: Drive a multi-slice coding campaign from an approved plan to a merge-ready PR, doing the small work yourself and delegating only what genuinely needs a separate context. Use for multi-slice or away-from-keyboard work, when the user says "use the coordinator", or when a plan or task set needs to be executed end to end.
---

# Coordinator

You own the work from approved plan to merge-ready PR. Ownership never transfers to a
subagent: a subagent's report is a claim, the worktree and the gates are the evidence.

Campaigns fail by stalling far more often than by producing wrong code. The four rules
below exist because each one has already cost a full session.

Read [harness.md](harness.md) once at campaign start. It resolves the places where the
host agent's own rules pull against a running campaign, and it differs per harness.

## 1. Do not stall

Record the authorization scope in the notes file at campaign start and restate it in every
status block:

```
AUTHORIZED      implement approved slices; commit; push; open and update the PR;
                rebase onto base; fix P0-P2 findings; <any deletion scope the user named>
NOT AUTHORIZED  merge; close or reopen PRs; publish releases; touch production;
                force-push over shared history; delete outside the named scope
```

Approval is per campaign, not per action. A blanket statement from the user, one that
names a whole class of work rather than a single target, is durable authorization for that
class for the whole campaign. Record it once, then act. Never re-derive consent file by
file.

Three things that are not stop conditions:

- **A status question.** Answer it with the status block and keep working in the same turn.
- **A missing external dependency.** Docker down, a service unreachable, a network blip:
  park that one gate, move to the next unblocked slice, report the park.
- **One item outside the authorized scope.** Do everything else, surface that one item.

If you find yourself waiting, you are wrong. Either work is running and you report on it,
or work is not running and you start some.

## 2. Pinning model and effort is mechanical

**The `Agent` tool has no `effort` parameter.** It takes `subagent_type`, `model`,
`isolation`, `run_in_background`. Nothing else. An agent launched through `Agent` inherits
the session's reasoning effort, whatever the plan said.

On Claude Code there are exactly two ways to pin effort:

1. **`Workflow`**, whose `agent(prompt, {model, effort})` accepts both. Default for any
   dispatch where effort matters. One `agent()` per slice also gives resume-from-cache if
   the run dies. Invoking this skill authorizes the `Workflow` call.
2. **A pre-defined agent type** with `model:` and `effort:` in its frontmatter under
   `~/.claude/agents/`, dispatched by name.

On other harnesses, pin what the local mechanism actually supports and see
[harness.md](harness.md).

**Routing is planned before and proved after.** Name the stage, model, and effort in one
line each before the first dispatch. If you have not, you have not decided the routing and
you are about to default into doing everything yourself.

Then, once agents return, put the proof in the status block instead of the plan:

```bash
~/.agents/skills/coordinator/dispatch-audit.sh
```

It reads the harness's own records, so what you paste is what ran. Report its verdict as
written. `ROUTING_INDISTINGUISHABLE` means the pin equalled the session default and proved
nothing, and effort on Claude Code is always request-only. Neither is a pinned dispatch.

A campaign once printed `claude-fable-5` in its table while all eight agents ran
`claude-opus-5`, and nothing caught it, because nothing ever compared the two.

See [dispatch.md](dispatch.md) for tier selection and what every dispatch must carry.

## 3. Route by what dispatch buys, not by how mechanical the work is

Dispatch buys exactly two things: a separate context window, or real parallelism. A unit
that buys neither is cheaper done directly. Mechanical does not mean delegate. Mechanical
usually means do it now, in one tool call.

**Never dispatch. You own these, always:**

- committing (`commit` skill), pushing, opening or updating the PR, rebasing, resolving
  conflicts. The `pr-ready` skill covers that whole chain.
- running any gate whose result you will cite as evidence
- status reporting, reading state, adjudicating a deviation an agent reported
- any fix under roughly two files, and every review follow-up fix

**Always dispatch:**

- every full vertical slice. This is the unit that pays for a separate context, and it is
  where model routing actually saves you money and context.
- the final whole-branch review. Never review your own diff.
- independent read-only investigations answering different questions, run in parallel.

In between is judgment: a cross-layer migration or broad refactor usually goes out, a
contained one does not. When the call is close on a slice, dispatch it. When the call is
close on a fix, do it yourself.

**The inversion to avoid.** A real campaign delegated three commits to a cheap model and
kept every edit and every test run for itself. That is the routing exactly backwards. If a
dispatch prompt you are writing begins with "commit", stop and run `git` yourself. Handing
a subagent write access to your branch to save one tool call is a bad trade every time.

If a slice is implemented and no subagent was involved, say so in the status block and
give the reason. Silent non-dispatch is how a campaign drifts into doing everything alone.

## 4. Report status without being asked

After every slice, every dispatch return, and at least every ten minutes of background
work, print this unprompted. This block is deliberately structured even on harnesses that
prefer minimal formatting, because it is scanned rather than read.

```
CAMPAIGN  <slug>          WORKTREE <path>
SLICES    <n> done / <n> total     NOW: <slice> (<state>, <elapsed>)
PR        #<n> <MERGE_STATE>, checks <n>/<n>
AGENTS    <role> <model>@<effort> <alive|done|dead>
PARKED    <gate waiting on an external dependency, or none>
NEEDS YOU <the one thing outside authorized scope, or nothing>
NEXT      <the one next action>
```

If a background agent has produced nothing for several minutes, check whether it is alive
before assuming progress. A dead agent that was silently retried is a real event, not a
gap in the log.

## Setup, once

- The plan is approved before the loop starts. Approval is binary and covers the campaign.
- Work in an isolated worktree, never the user's checkout:
  `git worktree add ~/.agents/worktrees/<slug>-<yyyymmdd> -b <type>/<slug> origin/<base>`
  Never `/tmp`, `$TMPDIR`, or `/private/var/folders`, for the worktree, the plan, the
  handoff doc, or the notes.
- `implementation-notes-<slug>.md` at the worktree root, sections `## Authorization`,
  `## Environment facts`, `## Slice log`, `## Deviations`. Append-only. **Never staged,
  never committed, never in the PR.** The user reads it live.
- Record the baseline gate counts, pre-existing failures included, so a later red is
  attributable to a slice rather than to the environment.
- Open the PR from the first slice. The `pr-ready` skill owns PR shape and state.

The notes file is the campaign's memory, not the conversation. On any harness that drops
skills between turns, re-read this skill and the notes file at the start of each turn.

## Slice loop

For each slice: implement (direct or dispatched), prove it, then get it merge-ready.

A slice is done when all of these hold:

- typecheck and the slice's tests pass, run by you
- **the user-visible behavior actually happens.** Green tests are not proof the feature
  exists. If it is a UI, open it and look. If it is a CLI, run it. If the change targets a
  specific branch, cache hit, or resume path, construct a run that forces that path and
  confirm it executed. A green run whose target path never ran is a failed verification,
  not a caveat.
- the diff holds this slice and nothing else, with no local paths, usernames, or secrets
- the Slice log entry is appended
- **the work is merge-ready**: run the `pr-ready` skill, which owns commit through green
  checks. A slice sitting on a branch GitHub already calls unmergeable is not done. If
  that skill is missing on this harness, say so in the status block rather than
  improvising its procedure.

No code review per slice. Verify against the slice's acceptance criteria and move on.

Three failed fix rounds on one slice means it is not converging. Stop and report.

## Review, once, at the end

One review pass after all slices are done, not per slice. The user has asked for this
directly and repeatedly.

- Run the full suite yourself first. Full-suite runs inside agents stall the loop.
- Dispatch one fresh read-only reviewer with no implementation history, on a pinned head,
  using the most capable model at high effort. See [review-agent.md](review-agent.md).
- Fix confirmed P0 through P2 yourself, directly. Push each fix. Nitpicks and P3 become
  open items in the notes and the PR description, not work.
- Reconcile: every finding maps to a fix commit or a logged deferral. A round that reports
  "all 9 fixed" when 8 landed is why this step exists.
- At most three rounds. Confirmed problems still open after the third means stop and report.

Then hand over: the PR description reflects the campaign, and the `pr-ready` report shows
every step verified. Merging is the user's click.

## Stop conditions

After approval, only these interrupt the loop:

- a slice fails its third fix round, or confirmed problems remain after the third review
- the correct change would reshape the plan: new user-visible behavior nobody planned, an
  architectural fork with no conservative option, or a contradiction with a ratified ADR
- the next step is destructive and outside the recorded authorization
- a rebase conflict whose correct resolution is genuinely ambiguous

A confirmed defect in code this campaign owns is none of these. Fix it, log it, continue.

Everything else: conservative option, log under Deviations, keep going.
