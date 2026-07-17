# Self Review of Code Review Guidelines

## Scope

- Reviewed: `code-review/` guideline files
- Review mode: baseline
- Intent: improve the standalone review framework before reuse
- Instructions checked: repository session rules and `code-review/RUBRIC.md`

## Confirmed findings and fixes applied

### High: Guidelines assumed every review is diff-based

- Confidence: 92
- File: `code-review/RUBRIC.md`
- Scope relation: in-scope-existing
- Evidence: the original report threshold required every finding to be introduced by the reviewed change.
- Impact: reviewing named files, existing guidelines, directories, or documentation would incorrectly drop real in-scope issues because there is no diff.
- Confidence rationale: this defect appeared in the core report threshold and several prompts, so it would affect normal use outside PR review.
- Fix applied: added explicit diff and baseline review modes across the rubric, prompts, checklist, workflow, schema, and final report template.
- Validation: checked references with `rg` and verified schema JSON.

### Medium: Confidence scores lacked calibration examples

- Confidence: 88
- File: `code-review/RUBRIC.md`
- Scope relation: in-scope-existing
- Evidence: the rubric defined score bands but gave no concrete examples or requirement to explain a score.
- Impact: reviewers could assign 80 or higher by judgment alone without enough evidence, making the score look more objective than it is.
- Confidence rationale: the score is explicitly subjective, so missing calibration directly weakens consistency.
- Fix applied: added confidence rationale requirements and created `code-review/SCORECARD.md` with score anchors and examples.
- Validation: checked all final templates and schemas include confidence rationale.

### Medium: Linter-only filtering was too broad

- Confidence: 84
- File: `code-review/RUBRIC.md`
- Scope relation: in-scope-existing
- Evidence: the original false-positive filter said to drop issues standard lint or formatting checks catch.
- Impact: reviewers might drop type errors, compile failures, security scanner findings, or broken tests as linter-only, even though those are reportable defects.
- Confidence rationale: the wording was broad enough to conflict with the rubric's compile and typecheck severity guidance.
- Fix applied: narrowed this to style linters and formatters, and explicitly excluded type errors, compile errors, broken tests, and security findings from that filter.
- Validation: searched for remaining broad `standard linter` wording.

### Medium: Structured finding schema missed review-mode evidence

- Confidence: 86
- File: `code-review/schemas/finding.schema.json`
- Scope relation: in-scope-existing
- Evidence: the schema required `introduced_by_change` but did not support baseline review or require confidence rationale.
- Impact: structured outputs could not represent an in-scope existing issue, and confidence could not be audited.
- Confidence rationale: the schema is the machine-readable contract, so mismatch with the updated review policy would cause inconsistent outputs.
- Fix applied: replaced the diff-only field with `review_mode` and `scope_relation`, and added required `confidence_reason`.
- Validation: ran `python -m json.tool code-review/schemas/finding.schema.json`.

### Low: Root prompt files could drift from the canonical kit

- Confidence: 82
- File: `code-review-prompt.md`
- Scope relation: in-scope-existing
- Evidence: root-level prompt files existed outside the standalone `code-review/` directory.
- Impact: users could accidentally use outdated guidance instead of the canonical standalone kit.
- Confidence rationale: duplicate prompt entry points commonly drift unless one is made canonical.
- Fix applied: replaced the root prompt files with short pointers to the canonical files under `code-review/`.
- Validation: checked that the canonical files are now inside `code-review/` and root files only redirect.

## Tests and validation

- Ran: `python -m json.tool code-review/schemas/finding.schema.json`
- Result: pass
- Ran: em dash scan over `code-review/`
- Result: pass, no em dash characters found
- Ran: `rg` checks for stale diff-only and linter-only wording
- Result: remaining matches are intentional or now scoped

## Residual risk

- The framework is still prompt-based. Confidence is not deterministic.
- There is no executable test suite for prompt quality.
- Future improvement: add sample review fixtures with expected findings and dropped candidates.

## Verdict

Approve with comments. The main consistency gaps were fixed.
