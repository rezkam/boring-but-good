---
name: ship
description: Verify a change with executable evidence, push it straight to the default branch, and watch CI and deploy, for repositories that have pull requests disabled and ship continuously. Use when the user says ship it, push to main, or deploy, and in any repo whose instructions say pull requests are disabled. Do not use where a pull request review is required; use pr-ready there.
---

# Ship

For repositories that ship by pushing to `main`. Nothing is reviewed after the push, so the
evidence has to exist before it. End with `SHIPPED` or one concrete blocker. Invoking this
skill authorizes the push in step 4 and nothing else.

## 1. Scope

`git status --porcelain` and `git diff --stat`. Identify the files this task changed; leave
everything else alone and never stage with `-A`, `.`, or `-u`. Follow the `commit` skill for
staging and the message. Work in an isolated worktree when other sessions may be active.

Fetch and rebase onto the current `origin/main` before verifying, so the evidence is about
what will actually land. Never force-push.

## 2. Local gate

Run the repository's own full gate, found as the `verify` skill describes: its `AGENTS.md`,
Makefile, package scripts, and CI workflow. Start any test database the repository provides
before the run and tear it down after, including after a failure. Exercise user-visible
behavior in the running app, not only unit tests. A failing check that pre-dates the change
still blocks the push; say so and do not skip it.

## 3. Pre-release verification

Establish whether the candidate change satisfies its intended requirements through executable
evidence. Create and run verification artifacts, not just a review or a proposed test plan.

### Scope and approach

Verify the candidate revision against `main`, including affected existing behavior. Identify
release-critical properties and required checks. Derive them from requirements, not merely the
current implementation. Make inferred requirements and assumptions explicit.

Prefer existing repository tooling. Select methods according to actual risk:

- Property-based and stateful testing for inputs, sequences, and invariants.
- Deterministic simulation testing for controlled scheduling and fault injection.
- TLA+/TLC for state-machine model checking; TLAPS or Lean 4 for appropriate
  machine-checked proofs.
- Docker Compose or Testcontainers for real-service integration and recovery.

Do not use every method by default. Say which were skipped and why.

### Implementation and execution

Create a repeatable workflow with a clear entry point, exact commands, and acceptance
criteria. Run existing relevant checks and add missing verification. Keep the artifacts that
stay useful (tests, models, specs, the entry-point command) in the change. Keep the report out
of the repository unless the repository already keeps such reports.

Use the candidate release artifact, pinned dependencies, and production-relevant
configuration. Exercise meaningful failure paths, not only successful requests. Include
compatibility, migrations, and rollback where relevant.

Seek and minimize counterexamples. Where practical, confirm that a controlled violation makes
the corresponding check fail. Never weaken requirements or assertions to obtain a passing
result.

Keep destructive tests inside disposable environments. Document production differences Docker
cannot reproduce. Modify verification artifacts as needed; change production code only when
authorized. Rerun affected checks after changes.

### Readability

Write for engineers familiar with state machines but not necessarily formal languages. Clearly
identify state, transitions, properties, and assumptions. Explain important claims and
non-obvious notation in plain English. Show how models correspond to implementation behavior,
what they abstract away, and what remains unchecked. Use small examples or traces when useful.

### Evidence and release gate

Bind results to the exact revision and release artifact tested. Retain commands, observed
results, relevant logs, seeds, counterexamples, model bounds, and proof assumptions. Separate
expected outcomes from actual execution.

Distinguish empirical testing, model checking, and machine-checked proof. Formal proofs must be
complete with assumptions and axioms disclosed. Neither passing tests nor proving a model
establishes unrestricted implementation correctness.

Return:

- **PASS:** Release-critical properties have adequate evidence and all required checks passed
  for the candidate.
- **FAIL:** A required check failed or a correctness violation was demonstrated.
- **BLOCKED:** Required verification is incomplete, unavailable, or inconclusive.

Never mark unexecuted checks as passed. Push only on `PASS`. The result is bound to one
revision, so any later commit or rebase needs the affected checks rerun.

## 4. Push

The staged diff holds only this task's files, with no secrets and no machine or account data.
Re-fetch; if `origin/main` moved, rebase and repeat steps 2 and 3 for what changed. Then:

```bash
git push origin HEAD:main
```

If the push is rejected, fetch and reconcile. Do not overwrite remote work.

## 5. Watch the rollout

After the push, record the pushed SHA and watch the runs for that SHA, CI and any deploy
workflow, until each is terminal:

```bash
gh run list --commit <sha> --json databaseId,name,status,conclusion
gh run watch <run-id> --exit-status
```

When a run fails, open `gh run view <run-id> --log-failed`, find the cause, and fix forward
with a new verified commit, or revert it when the failure is in production and not quickly
fixable. A revert is a new commit, never a history rewrite. Do not rerun unchanged failed runs
hoping for green unless the log proves an infrastructure failure, and say so.

If the repository deploys on push, confirm the deployed version serves the new behavior with a
read-only check before calling it shipped.

## Final report

```
Pushed:        <sha> to main
Local gate:    <exact command and counts>
Verification:  <PASS | FAIL | BLOCKED, properties, methods, seeds and bounds, what was skipped and why>
Rollout:       <runs for this sha and their conclusions>
Not run:       <skipped checks and why>
Risk:          <what is still unverified>
VERDICT:       SHIPPED | BLOCKED <reason>
```

Report `SHIPPED` only when the runs for the pushed SHA are green. Never report a step that was
not run in this session.
