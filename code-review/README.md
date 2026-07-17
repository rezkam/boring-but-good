# Standalone Code Review Kit

This directory contains a self-contained code review system. It does not depend on any external prompt file.

Use it for local diffs, branch diffs, pull requests, or named files.

## Files

- `RUBRIC.md`: scoring rules, severity rules, false-positive filters, and confidence guidance.
- `SCORECARD.md`: examples for assigning confidence scores consistently.
- `CODE_REVIEW_PROMPT.md`: standard high-signal code review prompt.
- `ADVERSARIAL_CODE_REVIEW_PROMPT.md`: stronger review prompt with finder and refuter phases.
- `REFUTER_PROMPT.md`: standalone prompt for verifying or disproving one candidate finding.
- `WORKFLOW.md`: step-by-step review workflow, including optional multi-agent orchestration.
- `CHECKLIST.md`: manual checklist for reviewers.
- `SELF_REVIEW.md`: review notes from applying this framework to itself.
- `schemas/finding.schema.json`: structured candidate finding schema.
- `templates/final-report.md`: final report template.

## Recommended usage

1. Read `RUBRIC.md` first.
2. Select review mode:
   - Diff review for PRs, branch diffs, git diffs, or recently changed code.
   - Baseline review for named files, existing guidelines, directories, or documentation.
3. Read `SCORECARD.md` for score examples if confidence is unclear.
4. Pick one prompt:
   - Use `CODE_REVIEW_PROMPT.md` for normal review.
   - Use `ADVERSARIAL_CODE_REVIEW_PROMPT.md` for thorough review.
5. Apply `CHECKLIST.md` during review.
6. Use `REFUTER_PROMPT.md` on each candidate finding before reporting it.
7. Format the final answer with `templates/final-report.md`.

## Core policy

Only report issues that are real, actionable, relevant to the selected review mode, and confidence 80 or higher.

Do not report style preferences, speculative bugs, style-linter-only issues, or pre-existing defects in diff review unless the reviewed change makes them worse.

## Minimal review command pattern

```text
Review <scope> using code-review/CODE_REVIEW_PROMPT.md and code-review/RUBRIC.md. Report only findings with confidence 80 or higher. Do not post comments externally.
```

## Thorough review command pattern

```text
Review <scope> using code-review/ADVERSARIAL_CODE_REVIEW_PROMPT.md and code-review/RUBRIC.md. Generate candidate findings by lens, refute each candidate, drop anything below confidence 80, then produce the final report.
```
