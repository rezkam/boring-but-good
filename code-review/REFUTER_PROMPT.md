# Refuter Prompt

Use this prompt to verify one candidate finding. The goal is to disprove weak findings before they reach the final review.

## Inputs

- Repository root: `<repo_root>`
- Change scope: `<branch_or_diff_or_files>`
- Review mode: `<diff | baseline>`
- Candidate finding: `<candidate_finding>`
- User goal or PR intent: `<goal>`
- Relevant instruction files: `<instruction_files>`

## Task

Try to refute this candidate finding. Default to `refuted: true` if uncertain.

You are not trying to make the review look impressive. You are trying to protect the final review from false positives.

## Steps

1. Read the cited code and nearby caller or callee context.
2. Check whether this candidate is introduced by the change, made worse by it, or in scope for baseline review.
3. Look for guards, invariants, schemas, type checks, tests, config, or runtime constraints that make the claim false.
4. Check whether the issue depends on impossible input, disabled config, or an unused path.
5. Check whether the relevant project instruction actually scopes to this file.
6. Decide whether a senior reviewer should block on it.
7. Assign final confidence using `RUBRIC.md`.
8. Return the structured verdict.

## Output format

```markdown
# Refutation Verdict

- Refuted: <true | false>
- Should report: <true | false>
- Final confidence: <0-100>
- Scope relation: <introduced-by-change | made-worse-by-change | in-scope-existing | out-of-scope | pre-existing-not-worse>
- Severity if real: <critical | high | medium | low>

## Reason
<short explanation>

## Confidence rationale
<why the score is justified>

## Evidence checked
- `<path>:<line>`: <what you checked>

## Missing evidence
<what would be needed if uncertain, or none>

## Suggested final-review wording
<only if should_report is true>
```

## Decision rule

Set `should_report: true` only when all are true:

- `refuted` is false.
- Final confidence is 80 or higher.
- In diff review, the finding is introduced by the reviewed change or made worse by it.
- In baseline review, the finding is inside the requested scope.
- The finding is actionable.
- Evidence is specific enough for another reviewer to verify.
