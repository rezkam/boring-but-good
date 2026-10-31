---
name: code-review
description: "Review PRs, branches, local changes, snapshots, or codebases for concrete, material defects; report actionable findings without editing code."
---

# Code Review

## 1. Establish scope and instructions

Review the requested scope for concrete defects. Investigate broadly within that scope, then filter the final report to findings with material consequences.

Do not edit project files, commit, push, or post review comments. Read the applicable AGENTS.md and other repository instructions.

Honor the user's target, refs, paths, concerns, and exclusions. Infer routine details from context; ask only when ambiguity would materially change the review.

Resolve the comparison according to the requested review:
- PR or branch-change review: resolve the actual base and target and inspect `git diff <base>...<target>`, unless another comparison was requested.
- Explicit snapshot comparison: use `git diff <base> <target>`.
- Local changes: inspect the requested staged, unstaged, and untracked content. Preserve the distinction between the index and working tree.
- Codebase or directory audit: inspect the requested code as it exists. Existing defects are eligible; no PR or diff is required.

Preserve explicitly requested refs. Do not silently substitute an upstream or include unrelated working-tree edits in a committed review. Read supporting code from the revision or snapshot under review. Report unavailable targets rather than inventing a comparison.

Done when: the reviewed snapshot or local-change layers, comparison, boundaries, and applicable instructions are established, or the target is confirmed unavailable.

## 2. Investigate the complete scope

Cover the complete requested diff or audit scope, including relevant callers, contracts, configuration, and tests. Continue after finding the first issue. Read dependencies outside a path restriction when needed to assess in-scope behavior; keep findings within the requested scope.

For codebase audits, map the main subsystems and use available subagents to investigate distinct areas in parallel. Give them bounded assignments, the same review criteria, and a shared understanding of the reviewed snapshot. The lead reviewer checks interactions between areas, evaluates candidate findings against the code, and consolidates the report. If subagents are unavailable, proceed directly. For change reviews, delegate only substantial independent work.

Establish each candidate's trigger, failure path, and practical consequence. Check for existing safeguards or intentional requirements that invalidate it. Use targeted tests or reproductions when they resolve uncertainty; a clear code path can establish a defect without runtime reproduction. Keep any reproductions isolated from project files and avoid tests with destructive or external side effects.

Done when: the requested scope and relevant interactions have been inspected, each candidate has supporting evidence, and any coverage limits are recorded.

## 3. Select findings

Apply this filter after investigating, not as a reason to stop exploring.

Report a finding when it is discrete, actionable, supported by the code, and materially affects correctness, security, reliability, data integrity, performance, or compatibility. Explain the concrete consequence that makes it worth fixing.

For change reviews, establish that the reviewed change introduced or exposed the failure. Do not report unrelated pre-existing defects.

Exclude style nits, minor inconveniences, speculative concerns, and refactoring or maintainability preferences without a demonstrated material consequence. Missing tests alone are not a finding. An intended change is not itself a bug, but unintended breakage caused by it still qualifies.

Report all qualifying findings, with no quota. Merge duplicate reports of the same root cause. Omit low-impact findings rather than promoting their severity.

Assign priority from realistic impact, reachability, affected scope, and workarounds:
- P0: A demonstrably reachable critical defect, such as irreversible data loss, severe security compromise, or widespread outage. Block release.
- P1: A serious defect causing substantial harm or breaking important functionality. Fix before merge or deployment unless explicitly accepted.
- P2: A material defect with limited or recoverable impact that warrants a dedicated fix. Small improvements and low-impact issues do not qualify.

Rare failures can still be severe. Severity does not compensate for weak evidence.

Done when: every retained finding meets the evidence and materiality criteria, priorities reflect realistic consequences, and duplicate root causes are merged.

## 4. Report and verify

Present findings first, ordered by severity. Use one entry per root cause:

`[P1] Correct the concrete failure: path/to/file.ext:line`

Follow with one short paragraph stating the triggering conditions, incorrect behavior, and material consequence. Cite the smallest useful location; for a change review, anchor it in the reviewed diff and explain any downstream impact. For an audit, cite the responsible code.

If nothing qualifies, say `No findings.` If the target could not be inspected, say the review is blocked instead.

Finish with a brief scope and verification note, including material coverage limits or checks that could not run. Do not imply unperformed checks passed or that partial inspection established the whole codebase is safe.

Before delivering, verify each citation against the reviewed snapshot, confirm that each finding survives the selection filter, and distinguish performed checks from unperformed ones.

Done when: the report contains all qualifying findings or the required no-findings/blocked outcome, accurate citations, and an honest scope and verification note.
