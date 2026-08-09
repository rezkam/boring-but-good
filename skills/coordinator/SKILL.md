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

On a harness where [guard/README.md](guard/README.md) is installed, the mechanical half of
this skill is enforced at the tool boundary: an unpinned dispatch, a premature reviewer, a
delegated commit, or a launch behind a stale status block fails rather than proceeding.
Register the campaign before the first dispatch so those rules can apply. A refusal names
the fix; correct it and retry in the same turn.

The authoring hook under [hooks/README.md](hooks/README.md) keeps repository output rules with
the coordinator resources that apply them during file, git, and pull request work.

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

Every dispatch states a model and an effort. A call that cannot express both is a fact for
the dispatch table, never a detail to leave out.

**Claude Code.** The `Agent` tool has no `effort` parameter: `subagent_type`, `model`,
`isolation`, `run_in_background`, nothing else. Agents launched through it inherit the
session's reasoning effort whatever the plan said. Two ways to pin it:

1. **`Workflow`**, whose `agent(prompt, {model, effort})` accepts both. Default for any
   dispatch where effort matters. One `agent()` per slice also gives resume-from-cache if
   the run dies. Invoking this skill authorizes the `Workflow` call.
2. **A pre-defined agent type** with `model:` and `effort:` in its frontmatter under
   `~/.claude/agents/`, dispatched by name.

**pi.** `subagent` pins both inside one string: `model: "<provider>/<model>:<effort>"`, as
in `openai-codex/gpt-sol:high`. Since pi-subagents 0.43.0 every dispatch is a
`workflowScript`, and each `runs.run`/`runs.all` child carries its own literal `model`
and `agent`. A writer or reviewer is the only child of its script; only independent
read-only investigations share one. Leaving `model` off a child inherits silently, and
every builtin pi agent inherits the session model by default: a real campaign fanned out
three read-only investigations with no `model` key anywhere and two of them ran at
thinking `low`. The guard's injected contract carries the exact form; the campaign roles
are `campaign-worker`, `campaign-reviewer`, `campaign-scout`, never pi's builtins.

**Codex.** Pin what the local spawn mechanism supports, read it back off the launched
process rather than off the flag you passed, and never call an inherited effort pinned.

**A harness model recommender is input, not authority.** pi's
`subagent action:"watchdog.recommend-model"`, and anything like it, answers a different
question than the tier table in [dispatch.md](dispatch.md): it does not know the slice, the
budget, or the routing plan. Read it, then decide, then write the model you chose and why
into the table. Asking the harness what to run is not routing.

**Never give a dispatched agent a hard turn or tool-call budget.** Read-only agents
included. Turn count does not measure progress: one fan-out set `maxTurns: 4` and killed
two of its three investigations at turns 6 and 7, after both had already written their
findings, while the survivor was forced into an answer it labelled partial. Bound liveness
with elapsed time and a generous margin instead. Work that will not fit one context becomes
serial milestones, not a shorter leash.

**Routing is planned before and proved after.** Every dispatch opens with its own routing
row, so the table cannot drift from the calls:

```
ROUTE: <key> | class <1|2|3> | <provider/model:effort> | <why this class>
```

Review dispatches declare a review class instead, from their own table:

```
ROUTE: <key> | review <1|2> | <provider/model:effort> | <why this class>
```

The declared model must be the model the call carries, and the declared class must be the
class its own table gives that model: implementation classes for `campaign-worker` and
`campaign-scout`, review classes for `campaign-reviewer`.

Each class lists its models in order and the first is the default. Use `/campaign models gpt`
or `/campaign models claude` to set every dispatched-agent and review tier, plus the judge,
to that provider's calibrated default in one command. It does not change the continuing
coordinator session, which is pi's separate `/model` control. Taking a later one is allowed when the preferred model is
unavailable, and the row's reason is where you say so
("claude-bridge rate-limited at 14:02"). A reason that does not explain the choice is
refused, the same way a class 3 label is. Class 3 implementation carries a written reason for
what makes the slice cross-layer or long-horizon, not the word "hard". If you have not
written the row, you have not decided the routing and you are about to default into doing
everything yourself.

Integrating a writer lane records the slice in the same call: pass `slice: "done"` when it
finishes a slice, `"retry"` when it re-ran one already counted, `"partial"` when the slice
still needs work. There is no separate step to forget, because review opens on that count.

Then, once agents return, put the proof in the status block instead of the plan:

```bash
~/.agents/skills/coordinator/dispatch-audit.sh
```

It reads the harness's own records, so what you paste is what ran. Report its verdict as
written. `ROUTING_INDISTINGUISHABLE` means the pin equalled the session default and proved
nothing, and effort on Claude Code is always request-only. Neither is a pinned dispatch.

A campaign once printed `claude-fable` in its table while all eight agents ran
`claude-opus`, and nothing caught it, because nothing ever compared the two. Another pinned
correctly for three dispatches, then sent roughly seventy with no model key at all, each
inheriting the session's most expensive model at its highest effort, for work as mechanical
as a one-file repair. Pinning discipline decays with session length; assume yours has.

See [dispatch.md](dispatch.md) for tier selection and what every dispatch must carry.

## 3. Route by what dispatch buys, not by how mechanical the work is

Dispatch buys exactly two things: a separate context window, or real parallelism. A unit
that buys neither is cheaper done directly. Mechanical does not mean delegate. Mechanical
usually means do it now, in one tool call.

**Never dispatch. You own these, always:**

- committing (`commit` skill), pushing, opening or updating the PR, rebasing, resolving
  conflicts. The `pr-ready` skill covers that whole chain, and it runs once at the end,
  not per slice.
- running any gate whose result you will cite as evidence
- status reporting, reading state, adjudicating a deviation an agent reported
- any fix under roughly two files, and every review follow-up fix

Owning git means owning the risk in it. **Never run `git reset --hard`, `git checkout -- <path>`,
`git restore`, or `git stash` while the tree is dirty.** Each discards the user's
uncommitted work with no prompt, and a backup branch does not save it because a branch
only captures commits. A real campaign created a backup branch, ran `git reset --hard`,
then printed "working tree preserved?" and destroyed a pending dependency override. To
move a branch pointer use `git switch -C <branch> <sha>` or `git update-ref`, which refuse
rather than discard. If you truly need a clean tree, commit or export first and say so.

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

**At most three writer lanes are open at once, and a lane that returned is still open
until it is integrated.** Parallel lanes that never land are integration debt, not
progress: one campaign launched five writers in a single instant, then spent four hours
reviewing and repairing them while the PR received nothing and the plan stayed at seven of
twenty-nine slices. Integrate a lane, run its gates yourself, then start the next.

**Steering is not coordinating.** A run you have corrected twice is not converging: stop
it, split the remaining work into serial milestones, and re-dispatch. One campaign
chaperoned a single worker past sixty turns while its own status blocks reported the turn
count climbing.

## 4. Report status without being asked

After every slice, every dispatch return, and at least every five minutes of background
work, print this unprompted. This block is deliberately structured even on harnesses that
prefer minimal formatting, because it is scanned rather than read.

```
CAMPAIGN  <slug>          WORKTREE <path>
SLICES    <n> done / <n> total     NOW: <slice> (<state>, <elapsed>)
PR        #<n> pushed at <sha>, checks read at the end
AGENTS    <role> <model>@<effort> <alive|done|dead>
DIRECT    <slice> because <reason>, or none
PARKED    <gate waiting on an external dependency, or none>
NEEDS YOU <the one thing outside authorized scope, or nothing>
NEXT      <the one next action>
```

`DIRECT` is a field, not an optional remark, because a paragraph elsewhere in this skill
asking you to justify non-dispatch was silently skipped for two full slices in a real
campaign. Every slice you implemented yourself appears there with its reason, or the line
reads `none`.

Every task in the campaign gets a row in the routing table, including the ones you own.
The same campaign listed three coordinator-owned tasks and omitted the two real
implementation slices entirely, so nothing showed they had never been considered for
dispatch. A missing row is invisible; a row saying `DIRECT, single file` is a decision.

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
- Open the PR from the first slice, then leave its remote state alone until the end. Push
  as slices land and update the body if you want; do not read checks or mergeability
  again until the campaign is over.

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
- **the work is on the branch**: committed and pushed, with the local gates for the
  packages it touched green. That is the whole per-slice bar.

Do not run `pr-ready`, poll checks, or query mergeability per slice. Remote state is a
release-time fact, and the guard refuses check polling while slices remain. Making the PR
merge-ready, watching every check to a terminal state, and resolving conflicts happens
**once**, after the final review, when the campaign is over. One campaign spent hours
reporting `checks 0/14 (billing-blocked)` on a PR whose checks could not pass; none of it
changed a single slice. Update the PR body as work lands if you like, and keep going.

No code review per slice. Verify against the slice's acceptance criteria and move on.

Three failed fix rounds on one slice means it is not converging. Stop and report.

## Review, once, at the end

One review pass after all slices are done, not per slice. The user has asked for this
directly and repeatedly. The count of reviewer dispatches before that pass is zero, and it
is zero however the prompt is labelled: an "acceptance check" or a "verification" of a
returned lane is a review. One campaign ran twenty-three of them during implementation,
each rejection spawning a repair and each repair a re-review, and progress froze for five
hours while the PR received nothing. Slice acceptance is your own gate run against the
acceptance criteria.

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
  architectural fork with no conservative option, or a contradiction with a ratified ADR.
  A mid-campaign instruction from the user that changes the base, the dependencies, or the
  scope is an instance of this. Amend the plan with the new slice mapping, print the delta
  in the next status block, then work it. One campaign answered a one-line request to adopt
  a newer dependency version by inventing an eight-track parallel migration across fifteen
  worktrees that appeared in no plan, and the user had to ask twice why nothing was
  progressing
- the next step is destructive and outside the recorded authorization
- a rebase conflict whose correct resolution is genuinely ambiguous

A confirmed defect in code this campaign owns is none of these. Fix it, log it, continue.

Everything else: conservative option, log under Deviations, keep going.
