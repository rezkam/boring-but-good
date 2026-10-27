---
name: tdd
description: Fix a bug or add behavior by first capturing it in a test that fails, then making it pass. Use for bug fixes and behavior changes that have a cheap local test target, and whenever the user asks for TDD, a failing test, or a regression test.
---

# TDD

Goal: the change lands with a test that failed before it and passes after it. Seeing the test
fail for the reason you expect is what shows it checks the behavior; a test written after the
code often passes either way.

Constraints:

- The test states the required behavior. If code and test disagree, change the code. If the
  test itself looks wrong, say so instead of editing it to pass. Special-casing inputs,
  weakening assertions, or copying the current output into the expected value all hide the bug
  the test was meant to catch.
- Keep tests to what the task needs: roughly one focused test per behavior, shaped like the
  neighboring tests. Scratch checks do not have to become permanent tests.
- When a failing test would be slow, flaky, or would mostly exercise mocks, skip it and use the
  closest real check instead. No test is better than a misleading one.

Done when the new test failed for the expected reason, now passes, and the rest of the suite is
no worse than before you started. Report those runs, or say why there is no failing-before run
and what you checked instead.
