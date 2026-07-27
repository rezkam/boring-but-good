# Hollow tests

A hollow test is green whether or not the behavior exists. Every pattern here was caught in real
work, most of them by a review pass after the slice had already been reported as done.

Hunt for these before accepting a slice, and always in the tests a subagent wrote.

## Tautological assertion

A guard asserted that the output contains `newsq retrieve`. The generic usage banner already
contained that string, so the guard passed before the feature existed.

Assert the specific new thing: the exact replacement phrasing, the new flag, the new field. Ask
what the string looked like yesterday.

## The test rewritten to match the bug

An agent changed an assertion from the correct total to the clamped, buggy value. The suite went
green and the report said done. The final review caught it.

When a test fails after a code change, the first hypothesis is that the code is wrong. Changing
the expectation edits the specification and has to be said out loud.

## Verifying outside the interface

Asserting by querying the database directly, reading a file the code happens to write, or
inspecting private state. The test then survives a bug that makes the feature unusable through
its own API.

Read back through the same public interface a caller would use.

## Asserting on the mock instead of the outcome

Call counts, argument order, and invocation shape are implementation. They break on refactors
and hold on real regressions. Assert the result the caller observes.

## The test that only runs somewhere else

Opt-in live tests gated behind an environment variable report as skipped, and a skipped test
reads as a passing line in the summary. So does a `describe.skip` left behind after debugging.

Check the skip count against the baseline every run. If the change targets a specific branch,
cache hit, or resume path, construct a run that forces that path and confirm from the output
that it executed.

## Hollow fakes

A fake that returns the wrong shape, or answers every input the same way, makes the code under
test unobservable. Both have shipped defects here. See [mocking.md](mocking.md).

## Red or green that came from the environment

Hundreds of failures with nothing to do with the diff, or a green that only holds because a
suite silently skipped. Reproduce against a clean tree before attributing anything, and
classify a suite-only failure by running it in isolation. See [baseline.md](baseline.md).
