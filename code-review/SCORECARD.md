# Confidence Scorecard

Use this file when assigning confidence scores. The score is a judgment, not a formula. The score must be backed by evidence and a short rationale.

## Required anchors for reportable findings

A finding with confidence 80 or higher must have all of these:

1. Exact file and line.
2. Direct observed evidence.
3. Correct review mode relation:
   - `introduced-by-change` or `made-worse-by-change` for diff review.
   - `in-scope-existing` for baseline review.
4. Realistic failure path or violated invariant.
5. Concrete impact.
6. Minimal fix direction.
7. Test, command, or reproducible check.

## Score examples

| Score | Example | Why |
|---:|---|---|
| 0 | Candidate is outside the requested files in baseline review | Out of scope |
| 10 | Candidate is refuted by an existing guard in the caller | False positive |
| 25 | Candidate is pre-existing in a PR and not made worse | Not introduced by change |
| 40 | Code style concern not covered by project instructions | Preference, not a defect |
| 50 | Real issue, but only affects an unrealistic input path | Weak impact path |
| 65 | Real maintainability issue, but no clear bug or contract risk | Valid but not review-blocking |
| 75 | Likely real issue, but missing one key proof point | Important but below threshold |
| 80 | Changed code breaks a realistic edge case and the path is cited | Reportable |
| 85 | Changed code violates a scoped project instruction with exact quote | Reportable |
| 90 | Changed code creates a compile, parse, or type error | Strong direct proof |
| 95 | Changed code corrupts persisted data on a normal path | Critical and directly evidenced |
| 100 | Deterministic failure is reproduced by command or test | Fully confirmed |

## Score adjustment guide

Raise the score when:

- The issue is directly visible in changed code.
- The issue survives refutation.
- A failing test or command proves it.
- A schema, type, or contract clearly proves it.
- The impact is normal-path and not edge-only.
- The fix is small and obvious.

Lower the score when:

- The failure path needs assumptions not present in code.
- The issue is only a possible future problem.
- The issue is a style concern.
- Existing tests or types may already protect it.
- The change scope is unclear.
- The impact is weak or rare.

## Examples by category

### Compile and type errors

- Missing import used by changed code: 90 to 100.
- Type mismatch on a changed public API: 85 to 95.
- Formatter-only issue: 0 to 30 unless it blocks build.

### Correctness

- Changed conditional reverses intended behavior on normal input: 85 to 95.
- Edge case with realistic input and no guard: 80 to 90.
- Hypothetical edge case with no known caller path: 40 to 70.

### Project instructions

- Exact scoped instruction violation with quote: 85 to 95.
- Possible convention mismatch without explicit rule: 30 to 60.
- Instruction file does not scope to changed file: 0 to 25.

### Tests

- Missing test for new critical behavior with no existing coverage: 80 to 90.
- Missing test for trivial wrapper: 0 to 40.
- Test asserts old behavior after intentional change: 80 to 95.

### Error handling

- Error swallowed on normal path with no log or user signal: 85 to 95.
- Fallback is explicit and documented: 0 to 40.
- Broad catch could hide unrelated errors, but path is unclear: 50 to 75.

### Baseline guideline review

- Guideline contradicts itself and would make reviewers drop valid findings: 85 to 95.
- Guideline is vague but still usable: 50 to 70.
- Guideline repeats content in another file without conflict: 20 to 50.

## Final check before reporting

If you cannot write a clear confidence rationale in one or two sentences, lower the score below 80 or drop the finding.
