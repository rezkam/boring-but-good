---
name: tdd
description: Write the failing test first, prove it bites, then make it pass. Use for any change that adds or alters behavior, for every bug fix, whenever the user asks for tdd or invokes /tdd including for all implementations, and for each behavior-adding slice inside a coordinator campaign.
---

# TDD

A test that cannot fail is not a test. The loop is red, green, and then proof: proof that the
red came from the missing behavior and the green came from your code.

Everything below is a rule because it has already cost a real campaign.

## 1. One behavior at a time, vertically

Do not write all the tests and then all the code. Tests written in bulk describe imagined
behavior. They assert the shape of things (signatures, data structures) instead of what the
system does, so they pass while the feature is broken.

```
WRONG   RED: test1..test5      GREEN: impl1..impl5
RIGHT   test1 to impl1, then test2 to impl2, then ...
```

Each cycle is informed by the previous one. The first cycle is a tracer bullet: the smallest
test that proves the path exists end to end.

Test through the public interface. If renaming an internal function breaks a test, that test
was measuring implementation. See [tests.md](tests.md) and [mocking.md](mocking.md).

In an unfamiliar package, read the nearest existing test file before writing anything and mirror
its harness, its fixtures, and its naming. That file is a better reference than any description
of it, and it is the fastest way to match conventions you would otherwise have to guess.

## 2. A test counts only when it bites

If you wrote the test first and watched it fail with the assertion you intended, you already
have this proof. Otherwise, at green: break the behavior and watch the test go red, restore it
and watch it go green again. Either way, report the exact assertion that flipped.

"Tests pass" is not evidence. "Reverting the clamp in `foo.ts:112` flips
`bar.test.ts > keeps the total` from pass to fail with `expected 50 to be 1349`, restoring it
returns 24/24" is evidence.

**Never revert a bite with `git checkout -- <file>`, `git restore`, or `git stash`.** It
discards every other uncommitted change in that file. That has destroyed in-flight slice work
twice. Undo the bite with the same edit tool that made it, or commit the slice first and
bite-check against the commit. Full procedure and the exemptions: [bite-check.md](bite-check.md).

If the test still passes with the behavior removed, it is hollow. The catalogue of hollow tests
actually caught in this work, and what each one should have asserted, is in
[hollow-tests.md](hollow-tests.md).

## 3. Never move the test to meet the code

When a test fails, the working assumption is that the code is wrong. Agents reach for the
assertion instead, and it survives review more often than it should: see
[hollow-tests.md](hollow-tests.md).

Loosening a matcher, widening a tolerance, adding `.skip`, deleting a case, or changing an
expected value edits the specification. That is allowed only when the specification genuinely
changed, and then it is called out in the commit message and in the slice report.

## 4. Know the baseline before you write anything

Record what the suite does on a clean tree first: passed, failed, skipped, and the names of
the failing files. Every later run is read as baseline plus your new tests. A red you cannot
attribute is a stop condition, not a footnote.

Some red is environmental rather than yours, and it arrives in the hundreds when it arrives at
all. Classify before you attribute: [baseline.md](baseline.md).

## 5. Do not stall for approval

State the interface you are about to build and the behaviors you will cover, then start.
Ask first only when a wrong guess is expensive to reverse: a persisted schema, a public API
with other consumers, a data migration. Inside a coordinator campaign the plan is already
approved and there is nothing left to confirm.

You cannot test everything. Pick the critical paths and the logic that is genuinely hard, name
what you are leaving uncovered, and keep going.

## 6. Not every change needs a test

Declare the exemption out loud with its reason. Do not skip quietly.

Exempt: pure renames, moves, formatting, dependency bumps, deletion of dead code, doc-only
changes, and generated or data-only files. A guard test is also exempt when it cannot be
written without false positives, for example a doc-grep guard that would fire on the very
document describing the removal. Say `TEST-EXEMPT: <reason>` and move on.

Not exempt: anything a user or a caller can observe, every bug fix, and every change to an
error path or a fail-closed gate.

## 7. Green is not done

The slice is done when all of these hold, run by you:

- the new test bites, with the flipped assertion recorded
- typecheck is clean
- the suite equals baseline plus your new tests, with no collateral failures
- the behavior actually happens outside the test: run the CLI, open the UI, force the branch
  or cache path the change targets and confirm it executed. A green run whose target path
  never ran is a failed verification, not a caveat.

Then refactor, never while red. Extract the duplication the new code exposed, and re-run after
each step.

Finish through the `commit` skill. Standalone, continue into `pr-ready`. Inside a campaign, the
coordinator owns everything after the slice is proven.
