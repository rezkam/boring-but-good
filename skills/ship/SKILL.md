---
name: ship
description: Verify a change, then deliver it by opening a pull request and watching its CI pass, or by pushing straight to main when the repository says so. Use when the user says ship it, open a PR, push to main, or deploy.
---

# Ship

Deliver verified work. The delivery mode is a pull request unless the repository's
instructions say to push straight to `main`; look for that in `AGENTS.md`, the README, and
whether pull requests are enabled on the remote. If the instructions are silent, use a pull
request. End with `SHIPPED` or one concrete blocker. Invoking this skill authorizes the
delivery below and nothing else. It never merges a pull request.

## 1. Scope

`git status --porcelain` and `git diff --stat`. Identify the files this task changed; leave
everything else alone and never stage with `-A`, `.`, or `-u`. Follow the `commit` skill for
staging and the message. Work in an isolated worktree when other sessions may be active.

Fetch and rebase onto the current base (`origin/main`) so the evidence is about what will
land. Never force-push without explicit approval.

## 2. Verify

Run the `verify` skill, including its pre-release verification section, on the candidate
revision. Deliver only on `PASS`. `FAIL` and `BLOCKED` both stop here: fix the cause or report
the blocker, never weaken a check to get `PASS`. Any later commit or rebase needs the
affected checks rerun.

## 3. Deliver

The staged diff holds only this task's files, with no secrets and no machine or account data.
Re-fetch; if the base moved, rebase and rerun step 2 for what changed.

### Pull request mode (default)

Push the branch with upstream tracking and open a non-draft pull request with an explicit
title and body: why the change exists, the verification result and how to reproduce it, and
remaining risks. Then watch the checks for the head SHA until each is terminal:

```bash
gh pr checks <number> --watch
```

On every poll confirm the head SHA has not changed. Address review comments that are valid
and reply with evidence to those that are not. Stop at a green, mergeable pull request and
report it; the merge is the user's.

### Direct mode (repository ships to `main`)

```bash
git push origin HEAD:main
```

If the push is rejected, fetch and reconcile. Do not overwrite remote work. Then watch the CI
and deploy runs for the pushed SHA until each is terminal:

```bash
gh run list --commit <sha> --json databaseId,name,status,conclusion
gh run watch <run-id> --exit-status
```

If the repository deploys on push, confirm the deployed version serves the new behavior with a
read-only check before calling it shipped.

## 4. When a check fails

Open `gh run view <run-id> --log-failed`, find the failing command and cause, and whether the
base already fixes it. Reproduce narrowly, fix, verify again, and push once. In direct mode a
failure in production that is not quickly fixable is reverted with a new commit, never a
history rewrite. Do not rerun unchanged failed runs hoping for green unless the log proves an
infrastructure failure, and say so.

## Final report

```
Mode:          pull request | direct to main
Delivered:     <PR URL or pushed sha>
Verification:  <PASS | FAIL | BLOCKED, with the verify report>
Checks:        <runs for this head and their conclusions>
Not run:       <skipped checks and why>
Risk:          <what is still unverified>
VERDICT:       SHIPPED | BLOCKED <reason>
```

Report `SHIPPED` only when the checks for the delivered head are green. Never report a step
that was not run in this session.
