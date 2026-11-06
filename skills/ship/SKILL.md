---
name: ship
description: Verify a change locally, then push it straight to the default branch and watch CI and deploy, for repositories that have pull requests disabled and ship continuously. Use when the user says ship it, push to main, or deploy, and in any repo whose instructions say pull requests are disabled. Do not use where a pull request review is required; use pr-ready there.
---

# Ship

For repositories that ship by pushing to `main`. Nothing is reviewed after the push, so the
evidence has to exist before it. End only with `SHIPPED` or one concrete blocker.

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
behavior in the running app, not only unit tests. Report in the `verify` shape.

A failing check that pre-dates the change is still a blocker for shipping. Say so; do not
skip it.

## 3. Correctness verification

Run the agent described in [`correctness-verification.md`](correctness-verification.md)
against the diff, with these limits:

- Scope it to the diff and the components it touches, not the whole repository.
- Derive the properties first. A one-line fix needs a failing test that bites; a change to
  state, concurrency, ordering, money, identity, or storage needs more.
- Use formal methods where they pay: TLA+ or a model checker for a state machine with
  interleavings or retries, property-based and stateful tests for invariants, deterministic
  simulation for timing and storage. Prefer what the repository already has. Skip a method
  that does not match a real risk, and say that it was skipped and why.
- Keep the artifacts that stay useful (tests, models, specs) in the change. Keep the report
  out of the repository unless the repository already keeps such reports.
- A counterexample or an unproven required property blocks the push. Fix the code or report
  the blocker; never weaken a property to get green.

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
fixable. A revert is a new commit, never a history rewrite. Do not rerun unchanged failed
runs hoping for green unless the log proves an infrastructure failure, and say so.

If the repository deploys on push, confirm the deployed version serves the new behavior with
a read-only check before calling it shipped.

## Final report

```
Pushed:        <sha> to main
Local gate:    <exact command and counts>
Correctness:   <properties checked, methods used, results, what was skipped and why>
Rollout:       <runs for this sha and their conclusions>
Not run:       <skipped checks and why>
Risk:          <what is still unverified>
VERDICT:       SHIPPED | BLOCKED <reason>
```

Report `SHIPPED` only when the runs for the pushed SHA are green. Never report a step that was
not run in this session.
