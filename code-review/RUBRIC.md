# Code Review Rubric

This rubric defines how to decide what to report.

## Review goal

Report only high-signal issues. A finding must be real, actionable, relevant to the selected review mode, and important enough for a reviewer to fix before merge.

## Review modes

This kit supports two review modes.

### Diff review

Use for git diffs, branch diffs, PR diffs, or recently changed code.

Report only issues introduced by the reviewed change, or pre-existing issues that the change makes worse or now depends on.

### Baseline review

Use for named files, existing guidelines, directories, or documentation where there may be no diff.

Report issues that are present inside the requested scope, even if they are not newly introduced. The finding still must be actionable and important. Mark the scope relation as `in-scope-existing`.

If the input is a PR or git diff, default to diff review. If the input is named files or a directory, default to baseline review.

## Confidence score

Confidence is a reviewer judgment guided by this rubric. It is not a deterministic formula.

Use a score from 0 to 100.

| Score | Meaning | Report? |
|---:|---|---|
| 0 to 25 | Likely false positive, pre-existing, contradicted by code, or not enough evidence | No |
| 26 to 50 | Possible issue, but speculative, style-only, or minor | No |
| 51 to 75 | Valid issue, but low impact, uncommon, or weakly evidenced | No |
| 76 to 79 | Important-looking issue, but still below report threshold | No |
| 80 to 89 | Important issue with strong evidence and correct scope relation | Yes |
| 90 to 100 | Confirmed critical issue or explicit scoped rule violation | Yes |

Only report issues with final confidence 80 or higher. Every reported score must include a short confidence rationale.

## How to assign confidence

Start at 50 for a plausible candidate. Adjust based on evidence.

Score 80 or higher requires direct cited evidence and a realistic impact path. Score 90 or higher requires direct proof, for example a compile failure, a contract violation, a deterministic wrong result, or an explicit scoped instruction violation.

Raise confidence when:

- The code will fail to compile, parse, or typecheck.
- A referenced symbol, import, field, or file is missing.
- The failure happens on a normal runtime path.
- The issue is directly introduced by the diff, or clearly in scope for baseline review.
- A scoped project instruction is clearly violated and can be quoted.
- A test, type, schema, or contract proves the issue.
- The failure path can be explained step by step.
- A small reproduction or targeted test would catch it.

Lower confidence when:

- The issue depends on rare or unclear input.
- Surrounding code might guard against it.
- The candidate is a style preference.
- A style linter or formatter would catch it.
- The issue is pre-existing in diff review and not made worse by the change.
- The applicable instruction file might not scope to this file.
- The finding needs broad speculation about future changes.
- The impact is unclear.

Set confidence to 0 to 25 when:

- The finding is refuted by code, tests, types, schemas, or caller contracts.
- The finding is outside the reviewed change in diff review, or outside the requested scope in baseline review.
- The finding repeats an already known or pre-existing issue.
- The reviewer cannot identify a realistic failure path.

## Severity

Severity and confidence are different.

- Confidence: how sure the reviewer is that the issue is real.
- Severity: how bad the issue is if real.

Use these severities:

### Critical

Use for:

- Data loss.
- Security exposure.
- Broken deploy or compile failure.
- Corrupt persisted output.
- Core workflow always fails in normal use.

Usually confidence 90 to 100.

### High

Use for:

- User-visible bug.
- Broken important workflow.
- Invalid data contract.
- Major backward compatibility break.
- Missing required authorization or validation.

Usually confidence 80 to 95.

### Medium

Use for:

- Edge-case bug with realistic impact.
- Degraded reliability.
- Hidden incompatibility.
- Important missing test for changed behavior.
- Error handling that hides actionable failures.

Usually confidence 80 to 90 if reported.

### Low

Use for:

- Local maintainability issue with clear future cost.
- Minor inconsistency that can cause confusion.

Usually do not report as a finding unless confidence is high and impact is concrete. Put it in notes instead.

### Severity anchor for contract and runtime-integrity defects

Defects in public interfaces or CLI/tool contracts, runtime error paths, and silent data loss or truncation are High minimum, never Medium or Low, regardless of how narrow the trigger seems. Recurring under-graded shapes from real campaigns: a client forwarding two flags the target rejects together, an error masked by IO in a finally block, truncation splitting a surrogate pair, a filtered probability distribution left un-renormalized.

## Verdicts

When a review must return a single verdict, its meaning is fixed by this rubric, not redefined per review:

- CLEAN / SHIP: zero reportable findings of severity Medium or higher remain.
- SHIP WITH FIXES: reportable Medium findings remain, each with a concrete fix attached; nothing High or Critical.
- NEEDS-FIX / BLOCK: at least one reportable High or Critical finding remains, with file, line, and evidence.

## False-positive filters

Do not report:

- Pre-existing issues not introduced by the change.
- Issues outside the requested scope.
- Pure style preferences.
- Subjective suggestions.
- General code quality concerns without concrete impact.
- Issues standard style lint or formatting checks will catch. Do not use this filter for type errors, compile errors, security scanner findings, or broken tests.
- Missing tests for trivial logic.
- Missing tests when existing integration tests already cover the behavior.
- Issues that depend on impossible input or disabled paths.
- Project instruction violations where the instruction file is not scoped to the changed file.
- A suspicious pattern that is explicitly allowed by a local comment or project rule.

## Evidence requirements

Every reported finding must include:

1. File path and line number.
2. Observed code evidence.
3. Why the issue is introduced by this change, or why it is in scope for baseline review.
4. Failure path or violated invariant.
5. Realistic impact.
6. Suggested minimal fix.
7. Validation command or test idea.
8. Final confidence score.
9. Confidence rationale.

## Refutation requirement

Before reporting a candidate, try to disprove it.

Ask:

1. Is the issue introduced by this change, or in scope for baseline review?
2. Does surrounding code prevent it?
3. Is there a type, schema, guard, config, or invariant that makes it safe?
4. Is the relevant project instruction actually scoped here?
5. Is the path reachable in normal use?
6. Would a senior reviewer block on this?
7. Is there a test or command that would catch it?

If the candidate cannot survive these questions, drop it.

## Report threshold

A finding is reportable only when all are true:

- Confidence is 80 or higher.
- Severity is Medium or higher, or Low with unusually clear impact.
- In diff review, the issue is introduced by the reviewed change or made worse by it.
- In baseline review, the issue is inside the requested scope.
- The issue is actionable.
- The evidence is specific enough that another reviewer can verify it.
