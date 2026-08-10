# Fakes and mocks

Mock at system boundaries only: external APIs, time, randomness, sometimes the filesystem.
Prefer a real test database over mocking one.

Do not mock your own modules. If a module is hard to use without mocking, that is a design
signal. Accept dependencies as parameters rather than constructing them inside the function,
and return results rather than mutating in place. Both are what make the fake style below
possible at all.

## A fake must mirror the real contract

The most expensive fake in this work returned two of the three fields the real host returned.
Under that fake a fail-closed path was unreachable, so a defect survived every test and only
appeared against the real host.

- return the full shape, including fields the test ignores
- when the real contract changes, the fake changes in the same commit
- name the real type in the fake, so a type error catches the drift

## A fake must discriminate

If the fake answers the same way for every input, the test cannot see the code under test. A
judge stub that contradicted everything made a contradiction detector untestable, and the test
passed regardless of what the detector did.

Flip the fake's answer. If the test outcome does not change, the test is hollow.

## One function per external operation

Prefer a small set of named operations over a single generic `fetch(endpoint, options)`. Each
one is then independently fakeable, with no conditional logic inside the fake and no guessing
which endpoint a test exercises.

## Live tests

Real-network tests are opt-in behind an environment flag and report as skipped when the flag is
absent. Track the skip count against the baseline so an accidental permanent skip stays visible.
An opt-in test does not replace a deterministic one; it is the extra proof that the
deterministic one is not lying.
