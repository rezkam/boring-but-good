---
name: pr-ready
description: Finish a branch or pull request and prove it is merge-ready. Use whenever the user asks to commit, push, open or update a PR, fix CI, check reviews, resolve conflicts, or make a PR ready. It follows the current PR head through replacement CI runs, diagnoses failures from logs, fixes valid review comments, and never merges.
---

# PR ready

End only with `READY_TO_MERGE` or one concrete blocker. Never merge.

## Source of truth

Use the snapshot command while doing the work:

```bash
~/.agents/skills/pr-ready/pr-state.sh [pr-number] [--exclude <foreign-path>]... [--probe-rebase]
```

Act on its last `VERDICT`. Run it again after every commit, push, rebase, check completion,
or review change. Never infer readiness from memory or from an earlier green run. A snapshot
that says `READY_TO_MERGE` is provisional because the base, reviews, or checks can change as soon
as the query finishes.

Before reporting completion, run the settling command from the same worktree:

```bash
~/.agents/skills/pr-ready/pr-final.sh [pr-number] [--exclude <foreign-path>]... [--probe-rebase]
```

It requires two `READY_TO_MERGE` snapshots with the same local, PR, and base heads, separated by
60 seconds. `PR_READY_STABILITY_SECONDS` may be shortened only in deterministic tests. Report
`READY_TO_MERGE` only when this settling command returns it. If state changes during the interval,
act on its final verdict and restart the state loop.

`READY_TO_MERGE` means all of these are true for the same current head SHA:

- the worktree is clean and local, upstream, and PR heads match
- the branch is current and mergeable against the PR base
- every check is present, terminal, and successful
- no review is requesting changes and no review thread is unresolved
- the PR is non-draft

If a repository truly has no CI, verify that first and pass `--allow-no-checks`. Without that
explicit exception, zero checks means the new pipeline may not have registered yet.

## State loop

An actionable non-ready verdict starts or resumes work. It is not a result to report. Perform
the matching repair, verify it, commit and push when needed, then take a fresh snapshot. Apply
the same rule when `pr-final.sh` returns a non-ready verdict: feed it back into this loop instead
of ending the run or waiting for the user to request the repair.

Stop only for a `BLOCKED_*` or `*_QUERY_FAILED` verdict after exhausting repairs available from the worktree.
Name the external dependency or authority required to continue. All other verdicts remain work
in progress until the settling command certifies `READY_TO_MERGE`.

| Verdict                                      | Action                                                                                                                |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `UNCOMMITTED_WORK`                           | Identify every path. Commit only this task's changes. Exclude proven foreign paths on every later run.                |
| `NO_PR`                                      | Push and create a non-draft PR with an explicit title and body.                                                       |
| `LOCAL_UNPUSHED` or `NO_UPSTREAM`            | Push and set tracking. Confirm the remote and PR head SHA afterward.                                                  |
| `UPSTREAM_AHEAD` or `PR_HEAD_MISMATCH`       | Fetch and reconcile before doing anything else. Do not overwrite unknown remote work.                                 |
| `IS_DRAFT`                                   | Mark the PR ready.                                                                                                    |
| `BEHIND_BASE` or `CONFLICTS_WITH_BASE`       | Rebase onto the freshly fetched base, test, then force-push with lease after required user approval.                  |
| `REBASE_UNPROVEN`                            | Re-run with `--probe-rebase`.                                                                                         |
| `CHECKS_STARTING` or `CHECKS_RUNNING`        | Keep polling. A push may briefly have no checks, and queued jobs are not failures.                                    |
| `CHECKS_FAILING`                             | Diagnose and fix using the failure loop below.                                                                        |
| `CHANGES_REQUESTED` or `OPEN_REVIEW_THREADS` | Read every comment. Fix valid findings, reply with evidence to invalid ones, push, and restart the check watch.       |
| `READY_EXCEPT_REBASE`                        | Report which merge methods are proven and which are not.                                                              |
| `BLOCKED_*` or `*_QUERY_FAILED`              | Stop only when the named dependency cannot be repaired from this worktree.                                            |
| `READY_TO_MERGE`                             | Treat it as provisional and run `pr-final.sh`; report readiness only if the settled verdict remains `READY_TO_MERGE`. |
| `STABILITY_CHANGED`                          | Fetch again, reconcile the changed PR or base state, then restart the state loop.                                     |

## Conflict handling

Base drift and conflicts come before pushing local commits. Fetch the exact PR base and remote
head, then probe the rebase in a disposable worktree before changing the PR branch.

For each conflict, inspect the base version, branch version, surrounding callers, and tests.
Preserve the branch's intent while adopting current base behavior. Never resolve the whole file
with an automatic ours or theirs choice. Drop a commit only when its exact change is already in
the base. Put any new integration repair in its own explained commit.

After the replay, compare `git range-diff` and the full old-head to new-head diff. Every changed
patch or tree difference must be intentional and explained. Run focused tests, the full project
gate, and required running-app checks before a lease-protected force-push.

## Pipeline watch and failure loop

After every push, record the PR head SHA and start a fresh watch. On every poll, verify the
head has not changed. If it changed, discard conclusions about the old run and restart from
the new head.

Do not stop at "checks pending". Poll until all jobs are terminal. Long-running and queued
jobs are normal. Keep the user updated during long waits.

When a job fails:

1. Open the exact failed run or job log with `gh run view <run-id> --log-failed`.
2. Identify the failing command, test, error, and whether the same failure is already fixed
   on the freshly fetched base.
3. Reproduce the narrow failure locally. For a code defect, add or confirm a test that fails
   for the defect before changing production code.
4. Fix the cause, then run the focused test and the repository's required full gate.
5. Commit and push once. Restart the watch for the new head SHA.

Do not rerun unchanged failed CI merely hoping for green. Retry unchanged code only when the
log proves an infrastructure failure or a known flaky test, and disclose that evidence.

## Safety

- Use an isolated worktree when new branch work is needed.
- Preserve foreign dirty files. Never clean them with reset, checkout, restore, or stash.
- Probe history rewrites first. Compare the old and rebased trees or inspect the full diff.
- Use `git push --force-with-lease`, never bare force.
- Disable editors for git continuation commands and prompts for PR creation.
- Respect repository instructions for tests, running-app verification, authorship, and PR text.

## Final report

Report the PR URL, exact head SHA, base SHA, non-draft state, mergeability, green check count and
names, review-thread result, tests actually run, and the settling command's final `VERDICT` verbatim.
If blocked, report the same facts plus the single blocker and what is needed. Never report a step
that was not verified in the current run.
