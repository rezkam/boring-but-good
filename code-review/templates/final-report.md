# Code Review

## Scope

- Reviewed: `<diff, branch, PR, or files>`
- Review mode: `<diff or baseline>`
- Intent: `<short intent summary>`
- Review depth: `<quick, standard, or thorough>`
- Instructions checked: `<instruction files or none found>`

## Findings

### `<severity>`: `<title>`

- Confidence: `<80-100>`
- File: `<path>:<line>`
- Scope relation: `<introduced-by-change | made-worse-by-change | in-scope-existing | out-of-scope | pre-existing-not-worse>`
- Lens: `<instructions | correctness | data-contract | errors | security | performance | tests | types | comments | maintainability>`
- Evidence: `<what the code does>`
- Failure path: `<step-by-step path to the bug or invariant violation>`
- Impact: `<why it matters>`
- Confidence rationale: `<why the score is justified>`
- Refutation result: `<why the finding survived skeptical review>`
- Suggested fix: `<minimal fix direction>`
- Validation: `<test or command that would catch it>`

## Refuted or dropped candidates

- `<candidate title>`: dropped because `<reason>`

## Tests and validation

- Ran: `<command>` or `not run`
- Result: `<pass, fail, skipped, or unavailable>`
- Notes: `<important output or reason>`

## Non-blocking notes

- `<optional minor notes, not findings>`

## Residual risk

- `<uncertainty, unreviewed area, or validation gap>`

## Verdict

`<Approve, approve with comments, or request changes>`
