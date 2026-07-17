# Code Review Checklist

Use this checklist during review.

## Preflight

- [ ] Scope is clear.
- [ ] Review mode is selected: diff or baseline.
- [ ] Changed or selected files are listed.
- [ ] User goal or PR intent is known.
- [ ] Relevant project instruction files are identified.
- [ ] Closed, draft, trivial, automated, or already-reviewed PR skip rules were considered when relevant.

## Scope control

- [ ] Review focuses on changed lines and direct context.
- [ ] Whole-codebase review is avoided unless explicitly requested.
- [ ] In diff review, pre-existing issues are not reported unless made worse by the change.
- [ ] In baseline review, findings are inside the requested scope.
- [ ] Instruction files are applied only where scoped.

## Finding quality

For every candidate finding:

- [ ] File path and line number are known.
- [ ] Evidence is observed directly in code.
- [ ] Scope relation is known: introduced-by-change, made-worse-by-change, or in-scope-existing.
- [ ] The failure path is realistic.
- [ ] The impact is concrete.
- [ ] A minimal fix is possible.
- [ ] A test or command could catch it.
- [ ] Confidence is scored with `RUBRIC.md`.
- [ ] Confidence rationale is written.
- [ ] Final confidence is 80 or higher.

## Refutation

For every candidate finding:

- [ ] An attempt was made to disprove the candidate before reporting.
- [ ] The refutation checklist from `RUBRIC.md` was applied.
- [ ] Refuted candidates were dropped.

## False-positive filters

Drop the candidate if any are true:

- [ ] It is pre-existing in diff review and not made worse by the change.
- [ ] It is outside the requested scope.
- [ ] It is style-only.
- [ ] It is speculative.
- [ ] It is a normal style linter or formatter issue.
- [ ] It depends on impossible input.
- [ ] It is already guarded by surrounding code.
- [ ] A type, schema, test, or invariant makes it safe.
- [ ] The instruction file does not scope to this file.
- [ ] The impact is too minor for a finding.

## Review dimensions

- [ ] Project instruction compliance.
- [ ] Correctness and edge cases.
- [ ] Data contracts and compatibility.
- [ ] Error handling and fallback behavior.
- [ ] Security and privacy.
- [ ] Performance and concurrency.
- [ ] Test quality and coverage.
- [ ] Type and invariant design.
- [ ] Comments and documentation accuracy.
- [ ] Maintainability and simplification.

## Validation

- [ ] Targeted validation command was run or recommended.
- [ ] Test result is recorded.
- [ ] Failures are reported honestly.
- [ ] Skipped validation is explained.

## Final report

- [ ] Findings are deduplicated by root cause.
- [ ] Findings are ordered by severity.
- [ ] Each finding includes confidence.
- [ ] Non-blocking notes are separate from findings.
- [ ] Verdict is clear.
