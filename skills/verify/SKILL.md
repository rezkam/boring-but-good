---
name: verify
description: Establish that a change, or the whole codebase when nothing has changed, actually works, by formal proof where the properties allow and by reproducible executable verification otherwise. This is the release gate before merging or deploying. Use it whenever you are about to say something works, is fixed, is done, or is ready, before committing, pushing, merging or deploying, whenever the user asks to verify, prove, check or test a change or the repository, or asks "did you run it" or "is it done", and after any fix that has not been verified, even if the user did not ask.
---

# Verify

Saying that something works is a claim other people will act on, so it needs evidence they can
check. Establish that it works by formally proving it where the properties allow, and by
verification that anyone can rerun with the same result. A claim without a proof or a
reproducible run is not verified.

The aim is executable evidence. Create and run verification artifacts; a review or a proposed
test plan does not count.

## Scope: the change, or the whole codebase

With a change (uncommitted work, a branch, a diff, a revision), verify that change against the
intended target branch, including the existing behavior it can affect. With no change, or when
asked to verify the repository, the candidate is the whole codebase at its current revision:
every component and the system's end-to-end behavior. Do not shrink a whole-codebase request to
the last commit or to the checks that are easiest to run. State the scope and the revision at
the top of the result.

## Choose the properties and methods

Identify the release-critical properties and the required checks. Derive them from the
requirements, not from what the current implementation happens to do, and write down every
inferred requirement and assumption so a reader can disagree with it.

Prefer the repository's own tooling, then select methods by actual risk:

- Property-based and stateful testing for inputs, sequences, and invariants.
- Deterministic simulation testing for controlled scheduling and fault injection.
- TLA+/TLC for state-machine model checking; TLAPS or Lean 4 for machine-checked proofs where
  a proof is appropriate.
- Docker Compose or Testcontainers for real-service integration and recovery.

Using every method by default adds cost without evidence. Pick the ones that match a real risk
and say which were skipped and why.

## Build and run it

Make the verification reproducible: a clear entry point, exact commands, pinned versions,
recorded seeds, and acceptance criteria, so a fresh checkout reruns it and reaches the same
result. Run the existing relevant checks and add what is missing. Keep the artifacts that stay
useful (tests, models, specs, the entry-point command) in the change, and keep the report out of
the repository unless it already keeps such reports. Start any test database the repository
provides before the run and tear it down after, including after a failure.

Test what will actually ship: the candidate release artifact, pinned dependencies, and
production-relevant configuration. Exercise failure paths, not only successful requests, and
include compatibility, migrations, and rollback where they apply.

Look for counterexamples and minimize the ones you find. Where practical, introduce a controlled
violation and confirm that the matching check fails, because a check that cannot fail proves
nothing. Never weaken a requirement or an assertion to get a passing result.

Keep destructive tests in disposable environments, and document the production differences
Docker cannot reproduce. Change verification artifacts as needed; change production code only
when authorized. Rerun the affected checks after every change.

## Make it readable

Write for engineers who know state machines but not necessarily formal languages. Identify the
state, the transitions, the properties, and the assumptions. Explain each important claim and any
non-obvious notation in plain English, and use a small example or trace where it helps. Show how
each model corresponds to the implementation, what it abstracts away, and what remains
unchecked.

## Evidence and verdict

Bind every result to the exact revision and release artifact tested, so it cannot be mistaken for
evidence about something else. Keep the commands, observed results, relevant logs, seeds,
counterexamples, model bounds, and proof assumptions, and keep expected outcomes separate from
what actually ran.

Say which kind of evidence each result is: empirical testing, model checking, or machine-checked
proof. A formal proof must be complete, with its assumptions and axioms disclosed. Passing tests
do not establish unrestricted correctness, and a proved model is not a proved implementation.

Return one verdict:

- **PASS:** the release-critical properties have adequate evidence and every required check
  passed for the candidate.
- **FAIL:** a required check failed or a correctness violation was demonstrated.
- **BLOCKED:** required verification is incomplete, unavailable, or inconclusive.

Deliver the runnable artifacts, the reproduction instructions, and the remaining risks. Never
mark an unexecuted check as passed, report a result while a suite is still running, or retry a
red check without saying so, since each of those hides a real failure. The verdict covers one
revision, so any later commit or rebase needs the affected checks rerun. Verifying does not
authorize merging, pushing, or deploying.
