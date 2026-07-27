---
name: pr-ready
description: Take the work in this session all the way to a merge-ready PR and prove it. Commits, pushes, opens a non-draft PR, keeps the branch mergeable against main, proves the merge strategy the user actually uses, watches every GitHub check to a terminal state, triages review comments, and reports each step verified. Use for "commit and push", "push to the pr", "create a PR", "is it ready", "check the review comments", "fix the conflicts", or any request to finish the current change. Never merges.
---

# pr-ready

One invocation. It ends in exactly one of two states: **READY_TO_MERGE**, with every step
shown as verified, or **BLOCKED**, naming the one thing that stopped it. Never ask the
user "should I continue" between steps. Never report a step you did not run.

Merging is the user's click. This skill never merges.

## The state command

`pr-state.sh` in this skill directory is the single source of truth. Never infer readiness
from memory, from a push succeeding, or from a check that was green ten minutes ago.

```bash
~/.agents/skills/pr-ready/pr-state.sh [pr-number] [--exclude <path>]... [--probe-rebase] [--preserve-merges]
```

It prints the dirty paths by name, then `BRANCH BASE UNCOMMITTED UNPUSHED UPSTREAM_AHEAD
BEHIND_BASE AHEAD_BASE PR DRAFT MERGEABLE MERGE_STATE MERGE_METHODS REBASE_MERGE CHECKS
OPEN_THREADS COMMENTS REVIEW`, and one `VERDICT`. Act on the VERDICT.

**The final report's VERDICT line is the script's last VERDICT, verbatim.** If you decide
something the script cannot know, that changes the inputs you give the script, never the
verdict you print. Printing READY_TO_MERGE over a script that said UNCOMMITTED_WORK, with
the disagreement explained underneath, has already happened once and it made a blocked PR
look finished.

## Optional first step: isolate

If the user asked for an isolated worktree, or the change is substantial and the current
checkout is the user's main working tree, create it before touching anything:

```bash
git worktree add ~/.agents/worktrees/<slug>-<yyyymmdd> -b <type>/<slug> origin/<base>
```

Never `/tmp`, never `$TMPDIR`, never `/private/var/folders`. Move only the files you
changed into the worktree, not everything the tree shows as dirty.

## The loop

Run `pr-state.sh`, act on the VERDICT, run it again. Repeat until READY_TO_MERGE or
BLOCKED. Each verdict has exactly one correct response:

| VERDICT | Do this |
| --- | --- |
| `UNCOMMITTED_WORK` | Adjudicate each named path, then commit yours. See below. |
| `NO_PR` | Push, then `gh pr create` (never `--draft`). |
| `IS_DRAFT` | `gh pr ready <n>`. The user has said: never draft. |
| `BEHIND_BASE` | Rebase onto the base, then force-push with lease. See below. |
| `CONFLICTS_WITH_BASE` | Same rebase. Resolve keeping this branch's intent. |
| `REBASE_UNPROVEN` | Re-run with `--probe-rebase`. Do not report ready until it resolves. |
| `READY_EXCEPT_REBASE` | Merge-commit and squash work, rebase-merge does not. Report all three buttons. |
| `CHECKS_RUNNING` | Wait and re-poll. Do not declare anything. |
| `CHECKS_FAILING` | Open the failing run's log, fix the cause, push, re-poll. |
| `OPEN_REVIEW_THREADS` | Triage each one. Valid gets fixed and pushed, invalid gets a reply saying why. |
| `BLOCKED_NEEDS_APPROVAL` | Terminal. Report it: this needs the user's review click. |
| `READY_TO_MERGE` | Terminal. Print the verified report. |

### Uncommitted work you did not create

The script names every dirty path because a count cannot be adjudicated. Each path gets
one of three outcomes, and the loop cannot advance until all of them do:

- **Yours**: commit it.
- **Not yours**: pass `--exclude <path>` on every subsequent run. It then prints as
  FOREIGN, stays visible in the report, and stops deadlocking the verdict. Say in the
  report why each one was excluded, with the evidence: an archived patch it matches, a
  build directory, a prior session's artifact.
- **Unclear**: ask. The `commit` skill's rule governs: untracked files are not
  automatically yours and are not automatically disposable.

Never let an excluded path silently disappear from the report. Exclusion is a claim you
are making, so it is stated where the user can contradict it.

### Rebasing, and the tree-identity grip

Any operation that rewrites history is proven before it touches the real branch.

**Before anything**: if the working tree is dirty, snapshot it. `git diff > ~/.agents/pr-ready-dirty-<date>.patch`
and list the untracked paths. Do this even for files you have adjudicated as foreign,
especially those, because they are the user's and not yours to lose.

**Never `git reset --hard`, `git checkout -- <path>`, `git restore`, or `git stash` to
move or clean a branch with uncommitted changes present.** Each of them discards the
user's work with no prompt. This has already destroyed a user's pending dependency
override mid-run. To move a branch pointer safely use `git switch -C <branch> <sha>` or
`git update-ref`, both of which refuse rather than discard when the tree conflicts. If
you genuinely need a clean tree, commit or export the changes first, and say so.

**The grip**: a rebase that preserves behavior produces the same tree. Capture it before
and compare after.

```bash
before=$(git rev-parse 'HEAD^{tree}')
# ... rebase ...
[ "$(git rev-parse 'HEAD^{tree}')" = "$before" ] || echo "TREE DIVERGED, a resolution was wrong"
```

An identical tree hash means every conflict resolution reproduced the original content
exactly. A different one means at least one was wrong, and `git diff <old-head> HEAD`
shows precisely where. Run the probe first so this is proven with the real branch
untouched:

```bash
pr-state.sh <n> --probe-rebase                     # linearize; drops merge commits
pr-state.sh <n> --probe-rebase --preserve-merges   # keep all commits including merges
```

The probe runs in a detached worktree under `~/.agents/pr-ready-probe/`, removes itself,
and keeps a log only when it fails. It never touches your branch, the PR, or the remote.

Then the real one:

1. `git fetch origin <base>`
2. `git rebase origin/<base>`, adding `--rebase-merges` when the user wants every commit
   kept. Linearizing a branch that contains merge commits discards their resolutions and
   is why replays conflict against a base that already has the same changes.
3. On conflict: keep this branch's intent, do not resurrect the base's version of code
   this branch deliberately restructured. If the correct resolution is genuinely
   ambiguous, that is a BLOCKED, not a guess.
4. Check the tree hash against `before`. A divergence is a stop, not a note.
5. Re-run the test suite. An identical tree makes this cheap to reason about but does not
   replace it when the tree did change on purpose.
6. `git push --force-with-lease`. Never bare `--force`.

Force-pushing over a branch someone may have pulled, or over a PR with filed reviews,
needs the user's explicit go-ahead first.

### MERGE_STATE is not the whole answer

`mergeStateStatus: CLEAN` means a **merge commit** would apply. It says nothing about
whether **rebase-merge** can replay the branch commit by commit. A PR can be CLEAN in the
API and still show "This branch cannot be rebased due to conflicts" in the UI. That
contradiction has already been reported as a false ready.

There is no API field for rebase-mergeability. In particular:

| Field | What it actually means |
| --- | --- |
| `mergeable` | Merge-commit conflict state, nothing more |
| `mergeStateStatus` | Merge-commit readiness including checks and protection |
| `viewerCanUpdateBranch` | Whether the "Update branch" button is available |
| `rebaseMergeAllowed` | Whether the repo enables the button, not whether it would work |

Never alias a field to a name that asserts something it does not measure. Reporting
`viewerCanUpdateBranch` as `canBeRebased` produced a confident, wrong conclusion. The only
evidence for rebase-mergeability is a replay, which is what `--probe-rebase` runs.

### Watching checks

Poll until every check reaches a terminal state. `gh pr checks <n> --watch` blocks, or
re-run `pr-state.sh` on an interval. Long CI is normal, so do not give up and report
"pushed, checks pending" as if that were done. That is the whole point of this skill.

For a failure, read the actual log before changing anything:
```bash
gh run view <run-id> --log-failed
```
Fix the cause. Never retry a red check hoping it flakes green without saying so.

### Review comments

Poll them: bot reviews and human reviews both land after the push, not during it.

Each comment gets one of two outcomes, and both are visible:
- **Valid**: fix it, push, and say which commit addressed it.
- **Invalid**: reply on the thread explaining why, so the thread is not silently ignored.

Never resolve a thread by deleting the comment or by silence.

## PR content

Problem or goal, why, approach, tradeoffs, validation run, remaining risk.

Link issues with `Closes #N` so GitHub closes them on merge. Do not close issues by hand
while opening the PR. Never `--draft`. No AI attribution. No em dashes.

## The final report

Always end with this, filled in from real command output, never from memory:

```
PR-READY: #<n> <url>
  Committed      <n> file(s), <sha> "<subject>"
  Foreign        <path> excluded because <evidence>   (omit when none)
  Pushed         <sha> -> origin/<branch>, remote head confirmed
  PR             #<n>, non-draft, Closes #<issues>
  Base           rebased onto origin/<base> at <sha>  (or: already current)
  Mergeable      MERGE_STATE=CLEAN
  Buttons        merge:<yes|no>  squash:<yes|no>  rebase:<yes|no, with the proof>
  Checks         <n>/<n> green: <names>
  Review         <n> threads, <n> fixed, <n> answered, 0 unresolved
  Tests          <command> -> <result>
  VERDICT        <the script's VERDICT, verbatim>
```

The Buttons line is not optional. "Ready to merge" without naming which button works is
the failure this skill exists to prevent.

If blocked, the same block with the failing line marked and one sentence on what is
needed. Never print a line you did not verify this run.
