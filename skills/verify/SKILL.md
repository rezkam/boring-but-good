---
name: verify
description: Establish that a code change actually works before reporting it done, and report what was run in a fixed shape. Use whenever you are about to say a change works, is fixed, or is done, before committing or opening a PR, even if the user did not ask; also when the user asks "did you run it" or "is it done", and after any fix that has not been executed.
---

# Verify

You are about to tell someone a change works. The only thing that makes that true is
having run it.

## Find the project's real command

Do not invent one. Read it from the repo, in this order:

1. `Makefile` targets
2. the project's build or task files: `package.json` scripts, `go.mod` with `go test ./...`,
   `pom.xml`, `build.gradle`, `Cargo.toml`, `pyproject.toml`, `justfile`, `Taskfile.yml`
3. `.github/workflows/*.yml`, which is the authority on what must pass to merge
4. the repo's `CLAUDE.md` or `AGENTS.md`

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

Green tests are not proof a feature exists. If the change is user-visible, drive it: use
the `run` skill where the harness has one, otherwise launch the app or CLI yourself.

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

Example:

```
Ran:        make test; npm --prefix web run test
Passed:     go: 412 tests, exit 0; web: 88 tests, exit 0
Failed:     none
Not run:    make e2e, needs a local Postgres that is not running here
Risk:       the migration path is covered only by e2e, so it is unverified
```

## Never

- claim green from a partial run, a type check alone, or a successful build: those prove
  it compiles, not that it behaves
- say "should work" or "this fixes it" about something that was never executed: the
  reader will act on it as if it were checked
- report done while a suite is still running: the result you would report does not exist yet
- retry a red check hoping it flakes green without saying so: a silent retry hides a real
  failure
