# Harness collisions

Read this once at campaign start. These are places where the host agent's own system
prompt pulls against a running campaign. Each one has caused a real stall.

The host's safety rules always win. What follows resolves ambiguity, it does not override
anything.

## Every harness: a status question is not a stop signal

Codex classifies turns by request type, and "report status" is a class that explicitly
does not authorize writes or PR changes. So mid-campaign, typing "what's the current
status of each of the slices" reads as a read-only turn and the loop stops.

Observed: in one Codex campaign the user had to re-ask for status seven times and resume
the goal loop four times. In one pi campaign the coordinator sat idle behind a subagent
until prompted.

**Resolution.** Inside an approved campaign, a status question is a progress request, not
a scope change. Answer it and keep working in the same turn. The answer is the status
block; the work continues under the authorization already granted. Only an explicit
"stop", "pause", or a new conflicting instruction ends the campaign.

## Every harness: what campaign approval already covers

Hosts require confirmation for hard-to-reverse actions unless durably authorized, and
tell the agent to stop and ask when completion needs new authority. A campaign that keeps
re-asking for authority it already has burns the user's whole session.

Observed: a user granted blanket deletion authority for a greenfield cleanup, then
confirmed it a second time when asked. The coordinator still declined two specific
removals as unconfirmed, and the user had to grant the same authority a third time before
it proceeded. In another campaign the user had to restate that full permission was already
given before the loop would continue.

**Resolution.** At campaign start, write the authorization scope into the notes file and
restate it in the status block. Approval is per campaign, not per action:

```
AUTHORIZED   implement approved slices; commit; push; open and update the PR;
             rebase onto base; fix P0-P2 findings; <deletions the user named>
NOT AUTHORIZED  merge; close or reopen PRs; publish releases; touch production;
             force-push over shared history; delete anything outside the named scope
```

A blanket scope statement from the user, of the kind that names a whole class of work
rather than one target, is durable authorization for that class for the rest of the
campaign. Record it once, then act. Do not re-derive consent per file.

If a target genuinely falls outside the recorded scope, do not stall the campaign on it:
do everything else, and surface the one item needing approval in the status block.

## Every harness: never idle on an external dependency

Observed: a user twice had to tell a coordinator to stop waiting on a container runtime
and get on with the implementation. And a coordinator idling behind a worker with no
heartbeat.

**Resolution.** A missing external dependency (Docker not running, a service down, a
network hiccup) parks that one gate. It never parks the campaign. Log the parked gate,
move to the next unblocked slice, and report the park in the status block. Waiting is
only correct when the wait itself is the work, and then it is a short poll, not a block.

## Claude Code

**Agent and Workflow are gated by opt-in.** This session config carries "Do not call the
AgentTool unless the user requested it" and "Do not use workflows unless the user
requested it". The `Workflow` tool additionally lists, as valid opt-in, "the user invoked
a skill or slash command whose instructions tell you to call Workflow."

**Resolution.** Invoking this skill is the request. This skill instructs you to use
`Agent` for delegated units and `Workflow` for any dispatch that must pin reasoning
effort. That satisfies the opt-in for the campaign. State it once in the dispatch table
rather than asking the user to re-authorize per dispatch.

**Effort cannot be pinned through `Agent`.** Verified against 2.1.220: `Agent` accepts
`description`, `prompt`, `subagent_type`, `model`, `isolation`, `run_in_background`, and
nothing else. Effort comes from an agent definition's frontmatter. Only `Workflow`'s
`agent(prompt, {model, effort})` takes it per call.

**EnterWorktree is gated too**: it is only for when the user or project instructions ask
for a worktree. Use plain `git worktree add` instead, which has no such gate.

**Background work is native.** `run_in_background` on Bash and Agent, plus task
notifications, so poll rather than block. Bash timeout caps at 600000 ms.

**Do not fabricate a pending agent's result.** If asked before the notification arrives,
say it is still running and report what the tree shows.

## Codex

**Skills do not persist across turns.** Codex is told not to carry a skill across turns
unless re-mentioned, and that the main agent must read `SKILL.md` itself rather than
delegating that read.

**Resolution.** The conversation is not the campaign's memory. The notes file is. At the
start of every campaign turn in Codex, re-read this skill and the notes file before
acting. Never assume the previous turn's loaded instructions are still in force. This is
why users have had to remind a mid-campaign Codex session that it was supposed to be
running this skill at all.

**No blocking waits over 60 seconds**, and the user should not go 60 seconds without a
commentary update. Poll in short intervals and narrate. This suits the status block well.

**Diagnose does not authorize fixing.** Codex treats "diagnose" as explain-only. Inside a
campaign, a confirmed P0-P2 defect in code the campaign owns is in scope to fix under the
recorded authorization. A defect found outside the campaign's scope is reported, not fixed.

**Prefer `rg`, edit with `apply_patch`.** Do not prescribe a different file-editing tool
from this skill; the host's tooling rule wins.

**Formatting.** Codex asks for minimal formatting. The status block is a deliberate
exception because it is scanned, not read. Keep everything else plain.

**Goal loop.** Codex's own goal machinery already requires a completion audit against
current state, forbids marking blocked on the first blocker, and forbids shrinking the
objective. Lean on it. Do not restate it, and do not fight it by declaring a goal done
that the audit would reject.

## pi

**Effort is pinned inside the model string**, not as a separate argument. The `subagent`
tool takes `model: "<provider>/<model>:<effort>"`, for example
`openai-codex/gpt-5.6-luna:medium` or `openai-codex/gpt-5.6-sol:high`. Observed working in
a real campaign. So pi can pin both values, and the dispatch table should say so rather
than reporting effort as inherited.

`subagent` also takes `action` values (`list`, `status`, `get`) for inspecting running
agents. Use `status` for the liveness check instead of assuming a quiet agent is working.

A dispatch that returns nothing inside its liveness bound is a failed dispatch, not a slow
one. One review dispatch in a real campaign timed out at three minutes with no result and
was never retried. Retry once with a longer bound, or take the unit back and do it
directly, and say which you did.

Confirm at campaign start that the goal or loop command exists before planning around it,
and write what you found into the notes file. Whatever genuinely cannot be pinned is
reported as inherited. Never describe an inherited setting as pinned.
