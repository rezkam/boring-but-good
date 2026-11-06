---
name: pre-release-verification
description: Implement and execute correctness verification before merging into main or deploying to production.
---

# Pre-Release Verification

Establish whether the candidate change satisfies its intended requirements
through executable evidence. Create and run verification artifacts, not
just a review or a proposed test plan.

## Scope and approach

Verify the candidate revision against the intended target branch, including
affected existing behavior. Identify release-critical properties and required
checks. Derive them from requirements, not merely the current implementation.
Make inferred requirements and assumptions explicit.

Prefer existing repository tooling. Select methods according to actual risk:
- Property-based and stateful testing for inputs, sequences, and invariants.
- Deterministic simulation testing for controlled scheduling and fault injection.
- TLA+/TLC for state-machine model checking; TLAPS or Lean 4 for appropriate
  machine-checked proofs.
- Docker Compose or Testcontainers for real-service integration and recovery.

Do not use every method by default.

## Implementation and execution

Create a repeatable workflow with a clear entry point, exact commands, and
acceptance criteria. Run existing relevant checks and add missing verification.

Use the candidate release artifact, pinned dependencies, and production-relevant
configuration. Exercise meaningful failure paths, not only successful requests.
Include compatibility, migrations, and rollback where relevant.

Seek and minimize counterexamples. Where practical, confirm that a controlled
violation makes the corresponding check fail. Never weaken requirements or
assertions to obtain a passing result.

Keep destructive tests inside disposable environments. Document production
differences Docker cannot reproduce. Modify verification artifacts as needed;
change production code only when authorized. Rerun affected checks after changes.

## Readability

Write for engineers familiar with state machines but not necessarily formal
languages. Clearly identify state, transitions, properties, and assumptions.
Explain important claims and non-obvious notation in plain English.

Show how models correspond to implementation behavior, what they abstract
away, and what remains unchecked. Use small examples or traces when useful.

## Evidence and release gate

Bind results to the exact revision and release artifact tested. Retain commands,
observed results, relevant logs, seeds, counterexamples, model bounds, and proof
assumptions. Separate expected outcomes from actual execution.

Distinguish empirical testing, model checking, and machine-checked proof.
Formal proofs must be complete with assumptions and axioms disclosed.
Neither passing tests nor proving a model establishes unrestricted
implementation correctness.

Return:
- **PASS:** Release-critical properties have adequate evidence and all required
  checks passed for the candidate.
- **FAIL:** A required check failed or a correctness violation was demonstrated.
- **BLOCKED:** Required verification is incomplete, unavailable, or inconclusive.

Deliver the runnable artifacts, reproduction instructions, and remaining risks.
Never mark unexecuted checks as passed. Do not merge, push, or deploy unless
explicitly authorized.
