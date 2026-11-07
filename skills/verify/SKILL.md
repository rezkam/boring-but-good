---
name: verify
description: Establish that a change, or the whole codebase when there is no change, actually works, by formal proof where the properties allow and by reproducible executable verification otherwise. It is the release gate before merging or deploying. Use whenever you are about to say something works, is fixed, or is done, before committing, pushing, or opening a PR, even if the user did not ask; also when the user asks to verify the repository, "did you run it" or "is it done", and after any fix that has not been verified.
---

# Verify

You are about to tell someone that something works. Establish that it does by formally proving
it where the properties allow, and by verification that anyone can rerun and get the same
result. A claim without a proof or a reproducible run is not verified.

## Scope: the change, or the whole codebase

With a change (uncommitted work, a branch, a diff, a revision), verify that change and the
existing behavior it can affect. With no change, or when asked to verify the repository, verify
the whole codebase at its current revision: every required check, every component, and the
release-critical properties of the system as a whole. Do not shrink a whole-codebase request to
the last commit or to the tests that are easiest to run. State the scope and the revision at the
top of the result.

## Pre-release verification

Use this when a change will merge into the default branch or reach production, when a
revision or the whole codebase is about to be released, and whenever the user or the repository
asks for a release gate. Establish whether
the candidate satisfies its intended requirements through executable evidence. Create and run
verification artifacts, not just a review or a proposed test plan.

### Scope and approach

Verify the candidate revision against the intended target branch, including affected existing
behavior. With no change to verify, the candidate is the whole codebase at the current
revision, and the properties cover every component and the system's end-to-end behavior. Identify release-critical properties and required checks. Derive them from
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

Make the verification reproducible. Create a repeatable workflow with a clear entry point, exact
commands, pinned versions, recorded seeds, and acceptance criteria, so a fresh checkout reruns it
and reaches the same result. Run existing relevant checks and add missing verification. Keep the artifacts that
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
