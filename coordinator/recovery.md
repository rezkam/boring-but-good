# Recovery

What must be true before the coordinator acts on a broken agent or environment. The constant across every case: ground truth is the worktree, so the tree, the log, and the diff are read before anything is decided.

## Stalled agent

Whether the agent is stuck is established from evidence (transcript recency, tree movement), and whether the provider or the task is at fault is established before any redo: a trivial no-tools probe on the same model settles it. A downed provider means wait and resume; a wedged task means replace.

## Dead or orphaned agent

A missing completion record does not mean missing work; campaigns have "lost" agents whose slices were fully committed. The same holds for a report failure: an agent that exhausted its structured-output retries may have landed everything. Only what the tree proves absent gets redone.

## Informed retry after an agent death

Runtime retries are silent: a workflow journal with `started` entries lacking a matching `result` is the only visible trace, so the journal is read after every workflow completes. When a dead implementer needs redoing, the retry is coordinator-owned and INFORMED, never left to a runtime's blind re-run. The retry dispatch states, on top of the normal contract: that it IS a retry; that a prior attempt died mid-task and the worktree may hold its partial uncommitted work; the coordinator's distilled summary of what happened (where it died, its last actions, the files it touched per the pre-dispatch snapshot diff); and the dead agent's transcript path (`agent-<id>.jsonl` in the workflow transcript dir) as deep reference, read selectively (tail first: transcripts run to megabytes). Its job is to reconstruct what happened, CONTINUE the work rather than redo it blindly, and verify inherited changes as foreign code: partial state that still typechecks is not thereby correct.

## Replacing an agent mid-flight

The old agent is stopped first. The replacement judges the partial work from the tree before anything else, and either builds on it or redoes it coherently; its call, coherence over salvage.

## Concurrent mutation abort

When an agent reports `BLOCKED_CONCURRENT_MUTATION`, freeze new work in that worktree and compare the coordinator's pre-dispatch snapshot, the agent's last safe state, and the current tree. Identify which writer moved HEAD or files before deciding what survives. Do not tell the blocked agent to continue, and do not let another agent reconcile foreign changes speculatively.

If two planned writers shared one worktree, preserve their evidence and move retries into dedicated isolated worktrees with disjoint ownership. If the mutation came from an unplanned process or user edit, preserve it and report the collision; resume only from a stable baseline that does not overwrite that work.

## Shared launch or configuration failure

Treat identical zero-turn or zero-tool failures across parallel siblings as one shared launch or configuration failure, not several independent task failures. Inspect the runtime-resolved agent and child metadata before retrying.

Read child transcript stderr as well as the top-level error. A generated tool-availability message, including an injected `intercom` complaint, can be secondary and can mask an earlier model-selection or provider-authentication failure.

## Turn-budget classification failure

A mutation-capable child exceeding a turn budget is not evidence that implementation failed. The runtime may defer termination during active tool work and reject the next terminal response even when the child has completed edits, tests, and a final summary. Inspect the worktree, diff, transcript tail, commands and results, and final response before deciding what remains. Preserve completed work and redo only what evidence shows is missing or unsound; do not blindly relaunch the whole task.

If acceptance was skipped or the final response omitted its required report, evaluate delivery evidence separately from report compliance. Repair or re-request the handoff without treating a reporting failure as permission to overwrite a valid implementation.

## Resuming a killed Workflow run

`resumeFromRunId` replays finished slices from cache; only live work re-runs. The implementer contract's idempotent re-entry exists for exactly this, so even a cache miss on a finished slice costs a green-confirmation, not a re-implementation.

## A red gate that is not a code failure

The failure signature is read before code takes the blame: a sandbox restriction, a missing native binding, or an exhausted quota fails tests with no code being wrong. The gate is re-judged outside the restriction or after the environment is repaired; blaming code for an infra failure burns a fix round.

## Environment breakage mid-loop

Repairing a broken environment (a system update kills the toolchain, a dependency ABI shifts) is coordinator work, not implementation. The repair is done firsthand, recorded under Environment facts in the notes, and waiting agents are then woken; agents told to trust the environment facts will sit on a broken environment until the coordinator fixes it.
