---
name: verify
description: Establish that a code change actually works before reporting it done, and report what was run in a fixed shape. Also the release gate: implement and run correctness verification, including formal methods where they pay, before merging or deploying. Use whenever you are about to say a change works, is fixed, or is done, before committing, pushing, or opening a PR, even if the user did not ask; also when the user asks "did you run it" or "is it done", and after any fix that has not been executed.
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
work.

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

## Pre-release verification

Use this when the change will merge into the default branch or reach production, and
whenever the user or the repository asks for a release gate. The sections above are its
floor; this section adds executable verification of correctness properties. Establish whether
the candidate satisfies its intended requirements through executable evidence. Create and run
verification artifacts, not just a review or a proposed test plan.

### Scope and approach

Verify the candidate revision against the intended target branch, including affected existing
behavior. Identify release-critical properties and required checks. Derive them from
requirements, not merely the current implementation. Make inferred requirements and
assumptions explicit.

Prefer existing repository tooling. Select methods according to actual risk:

- Property-based and stateful testing for inputs, sequences, and invariants.
- Deterministic simulation testing for controlled scheduling and fault injection.
- TLA+/TLC for state-machine model checking; TLAPS or Lean 4 for appropriate
  machine-checked proofs.
- Docker Compose or Testcontainers for real-service integration and recovery.

Do not use every method by default. Say which were skipped and why.

### Implementation and execution

Create a repeatable workflow with a clear entry point, exact commands, and acceptance
criteria. Run existing relevant checks and add missing verification. Keep the artifacts that
stay useful (tests, models, specs, the entry-point command) in the change. Keep the report out
of the repository unless the repository already keeps such reports.

Use the candidate release artifact, pinned dependencies, and production-relevant
configuration. Exercise meaningful failure paths, not only successful requests. Include
compatibility, migrations, and rollback where relevant.

Seek and minimize counterexamples. Where practical, confirm that a controlled violation makes
the corresponding check fail. Never weaken requirements or assertions to obtain a passing
result.

Keep destructive tests inside disposable environments. Document production differences Docker
cannot reproduce. Modify verification artifacts as needed; change production code only when
authorized. Rerun affected checks after changes. Start any test database the repository
provides before the run and tear it down after, including after a failure.

### Readability

Write for engineers familiar with state machines but not necessarily formal languages. Clearly
identify state, transitions, properties, and assumptions. Explain important claims and
non-obvious notation in plain English. Show how models correspond to implementation behavior,
what they abstract away, and what remains unchecked. Use small examples or traces when useful.

### Evidence and release gate

Bind results to the exact revision and release artifact tested. Retain commands, observed
results, relevant logs, seeds, counterexamples, model bounds, and proof assumptions. Separate
expected outcomes from actual execution.

Distinguish empirical testing, model checking, and machine-checked proof. Formal proofs must be
complete with assumptions and axioms disclosed. Neither passing tests nor proving a model
establishes unrestricted implementation correctness.

Return:

- **PASS:** Release-critical properties have adequate evidence and all required checks passed
  for the candidate.
- **FAIL:** A required check failed or a correctness violation was demonstrated.
- **BLOCKED:** Required verification is incomplete, unavailable, or inconclusive.

Deliver the runnable artifacts, reproduction instructions, and remaining risks. Never mark
unexecuted checks as passed. The result is bound to one revision, so any later commit or
rebase needs the affected checks rerun. Verifying does not authorize merging, pushing, or
deploying.

## Never

- claim green from a partial run, a type check alone, or a successful build: those prove
  it compiles, not that it behaves
- say "should work" or "this fixes it" about something that was never executed: the
  reader will act on it as if it were checked
- report done while a suite is still running: the result you would report does not exist yet
- retry a red check hoping it flakes green without saying so: a silent retry hides a real
  failure
