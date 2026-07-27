---
name: verify
description: Establish that a change actually works before reporting it done, and report what was run in a fixed shape. Use before any completion claim, when the user asks "did you run it" or "is it done", and after any fix that has not been executed.
---

# Verify

You are about to tell someone a change works. The only thing that makes that true is
having run it.

## Find the project's real command

Do not invent one. Read it from the repo, in this order:

1. `Makefile` targets
2. `package.json` scripts, `go.mod` with `go test ./...`, `pom.xml`, `pyproject.toml`
3. `.github/workflows/*.yml`, which is the authority on what must pass to merge
4. the repo's `CLAUDE.md`, `AGENTS.md`, or `CONTEXT-MAP.md`

If no command exists, say so and propose one. Reading the code is not a substitute for
running it.

## Run the whole thing, keep the output

Run the relevant suite, not only the test you touched, and paste real counts, failure
names, and exit status. Never paraphrase a result you did not see.

A suite that hangs is usually a missing service or a cancelled context, not a flake.
Investigate before retrying.

To decide whether a failure pre-dates your change, compare against the baseline you
recorded before starting, or re-run at the base commit in a separate worktree. Never
`git stash` or `git checkout` the working tree to find out: that discards uncommitted
work. See the `tdd` skill's `baseline.md`.

Green tests are not proof a feature exists. If the change is user-visible, drive it: the
`run` skill launches the app for exactly this.

## Report in this shape

```
Ran:        <exact command>
Passed:     <what passed, with counts>
Failed:     <what failed, and whether it pre-dates the change>
Not run:    <what was skipped, and why>
Risk:       <what is still unverified>
```

`Not run` and `Risk` are the two lines that make this worth reading. A report with both
empty is usually a report that did not look.

## Never

- claim green from a partial run, a type check alone, or a successful build
- say "should work" or "this fixes it" about something that was never executed
- report done while a suite is still running
- retry a red check hoping it flakes green without saying that is what you are doing
