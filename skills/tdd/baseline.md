# Attributable baselines

The point of a baseline is that every later red is attributable. Without one, an unrelated
pre-existing failure reads as your regression and a real regression hides inside the noise.

## Take it before the first test

On a clean tree, at the base commit, run the same command you will run later:

- passed, failed, skipped counts
- the file names of every failure
- typecheck exit code, separately, for each package involved

Write it into the notes file, not just the conversation. A worked example from a real campaign:

```
BASELINE  pipeline: 8 failed | 1446 passed | 4 skipped
          all 8 in test/session-auth-rotation.test.ts + test/preflight-rotation.test.ts
          (OAuth rotation against a read-only auth store, environmental)
          typecheck: pipeline 0, shared 0
```

Every later run is then read as arithmetic: baseline passed plus the tests you added, the same
failures, the same skip count. `8 failed | 1549 passed | 4 skipped` after adding 13 tests to a
1536 baseline is clean. Anything else needs a name before the slice closes.

## Classify a failure before attributing it

In order, cheapest first:

1. Is it in the baseline list? Then it is not yours.
2. Does it reproduce on a clean checkout of the base commit? Then it is not yours.
3. Does it pass in isolation and fail under the full suite? Shared state or parallelism, not
   your logic. Note it, do not chase it inside the slice.
4. Does it fail in isolation too? Real regression. Fix it under the slice.

## Environmental red is not code red

Seen in this work:

- a native module built for one Node ABI running under another, producing hundreds of failures
  with nothing to do with the diff. Fixed by rebuilding it in the worktree, not by editing code.
- auth-dependent suites failing against a read-only credential store
- sandboxed runs turning socket binds into `EPERM`
- a missing fixture file making a test throw before any assertion

Each of these belongs in the baseline as a named, environmental failure. Record the cause next
to the count so the next session does not rediscover it.

## When the baseline itself is red

A red baseline is workable as long as it is attributable and stable. Record the exact set,
state that additive slices are expected to hold it constant, and confirm the set is unchanged
at every slice boundary.

A baseline that is red for unknown reasons is not a baseline. Find out why before starting, or
say plainly that the suite's signal is untrusted for this campaign.

## Per-package scoping

In a monorepo, run and record the gates that apply to the part of the tree you touched, plus
the full suite once before review. Full-suite runs are slow and, inside a subagent, they stall
the loop; the coordinator runs them.
