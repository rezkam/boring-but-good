# Code Review Workflow

This workflow is standalone. Use it with `RUBRIC.md`, `CODE_REVIEW_PROMPT.md`, `ADVERSARIAL_CODE_REVIEW_PROMPT.md`, and `REFUTER_PROMPT.md`.

## Review mode selection

Choose the review mode before scoring findings.

- Diff review: use for PRs, branch diffs, git diffs, or recently changed code. Report only issues introduced by the change, made worse by it, or newly depended on by it.
- Baseline review: use for named files, directories, existing guidelines, or documentation. Report issues present inside the requested scope, even when there is no diff.

If unclear, default to diff review for PRs and git diffs, and baseline review for named files or directories.

## Standard review workflow

1. Preflight
   - Identify scope.
   - Select review mode: diff or baseline.
   - Confirm whether review is needed.
   - Gather scoped project instruction files.
   - Read PR title, PR body, issue text, or user goal.

2. Understand the change
   - List changed or selected files.
   - Identify public contracts touched.
   - Identify tests touched.
   - Identify runtime paths touched.

3. Find candidates
   - Review changed or selected code.
   - Read direct caller or callee context.
   - Build candidate findings.
   - Do not report anything yet.

4. Score candidates
   - Apply `RUBRIC.md` confidence scoring.
   - Drop speculative, style-only, style-linter-only, and out-of-scope candidates.
   - In diff review, drop pre-existing candidates unless the change makes them worse or depends on them.

5. Validate candidates
   - For each remaining candidate, check file, line, failure path, and applicable instruction scope.
   - Run or propose a targeted test or validation command.
   - Drop candidates below confidence 80 after validation.
   - Deduplicate by root cause.

6. Produce report
   - Use `templates/final-report.md`.
   - Include only confirmed findings.
   - Include validation status.
   - Include residual risk when something important was not checked.

## Adversarial review workflow

Use this for thorough reviews.

1. Preflight phase
   - Reviewer A checks skip conditions and relevant instruction files.
   - Reviewer B selects review mode and summarizes intent and changed files.

2. Finder phase
   - Run independent review passes by lens.
   - Minimum standard lenses:
     - instruction compliance
     - diff-only obvious bugs
     - contextual introduced-code bugs
     - tests and error handling
   - Thorough lenses:
     - type and invariant design
     - security and privacy
     - performance and concurrency
     - comments and documentation accuracy
     - simplification and maintainability

3. Deduplication phase
   - Merge candidates by file, line range, and root cause.
   - Keep the strongest evidence.
   - Keep preliminary confidence from the strongest candidate.

4. Refutation phase
   - Use `REFUTER_PROMPT.md` on each candidate with preliminary confidence 70 or higher.
   - For thorough review, use 3 to 5 refuters per serious candidate.
   - Each refuter must try to disprove the candidate.

5. Decision phase
   - Drop candidates refuted by the majority.
   - Drop candidates below final confidence 80.
   - Drop candidates without a realistic failure path.
   - Drop candidates outside the selected review mode.
   - Keep only unique, actionable findings.

6. Completeness check
   - Ask what changed area was not reviewed.
   - Ask what claim lacks evidence.
   - Ask what validation was skipped.
   - Add uncertainty to residual risk, not findings.

7. Final report
   - Use `templates/final-report.md`.
   - Include confirmed findings.
   - Include refuted or dropped candidates only if useful.
   - Include validation status and residual risk.

## Finder prompts by lens

### Instruction compliance finder

Check changed files against scoped project instruction files. Only report exact, scoped violations. Quote the rule and explain why it applies to the file.

### Diff-only bug finder

Review only the diff. Find issues that are obvious without broader context, such as syntax errors, missing imports, unresolved references, and logic that is definitely wrong.

### Contextual bug finder

Read the changed file plus direct callers or callees. Find contract mismatches, bad state assumptions, wrong schemas, and broken runtime paths introduced by the change.

### Test finder

Check whether changed behavior has meaningful tests. Focus on missing critical paths, false-positive tests, tests asserting old behavior, and brittle implementation tests.

### Error-handling finder

Look for silent failures, broad catches, swallowed errors, missing logs, unjustified fallbacks, and confusing user or operator feedback.

### Type design finder

Look for illegal states, weak invariants, mutable internals, missing boundary validation, and public types that allow invalid data.

### Security finder

Look for authorization gaps, unsafe input handling, secret leakage, unsafe file or network behavior, and privacy regressions.

### Performance finder

Look for unbounded work, resource leaks, N plus 1 operations, race conditions, and expensive work added to hot paths.

### Comment finder

Check that comments and docs match actual code behavior. Flag misleading comments and stale examples.

### Maintainability and simplification finder

Find simpler equivalent code that preserves behavior, but report only when complexity creates real maintenance risk.

## Validation priority

Prefer validation in this order:

1. Typecheck or compile command.
2. Targeted unit test for changed behavior.
3. Targeted integration test for runtime path.
4. Existing test suite subset.
5. Full suite, only when scope justifies it.
6. Manual reasoning, only when commands are unavailable.

Always report what was run and what was skipped.
