# boring-but-good

Shell-script and workflow skills that give AI coding agents (Claude Code, etc.) the ability to
interact with engineering systems. Each skill is a directory with a `SKILL.md`. Some keep their
executables in a `scripts/` folder (the `workflow-tools/` skills, `browser-tools`, `ai-chat`,
`codex`, `skanetrafiken`), others at the skill root
(`coordinator/dispatch-audit.sh`, `pr-ready/pr-state.sh`), and several are prose only.

This file deliberately does not inventory the skills or the test suites. Run `ls` and read
`tests/test-all.sh` for the current list: every previous attempt to keep an inventory here went
stale and misled the next reader. Not everything at the top level is a skill: `code-review/` is
a prompt and rubric set, `hooks/` ships a PreToolUse guard, and `tests/` is the suite runner.

## Architecture

- **Config loaders** (`_config.sh`): Read credentials from `~/.boring/<skill>/` files. Environment variables take precedence over files (`if [ -z "$VAR" ] && [ -f file ]`).
- **API helpers** (`_api.sh`): Wrap curl with auth, retry logic (transient failures: codes 7/28/52/56), structured error messages, and HTTP status capture. Jenkins, SonarQube, and ArgoCD share this pattern. Dependency-Track inlines it in `dtrack-api.sh`.
- **Jira is different**: Uses go-jira CLI instead of curl. Auth is via keychain, not token files. Scripts wrap `jira request -M METHOD ENDPOINT`; `_config.sh` explicitly resolves the macOS login keychain when go-jira's legacy implicit lookup cannot see it in SSH/non-GUI sessions. There is no `_api.sh` for it.
- **to-tasks is workflow-only**: It has no scripts or credentials of its own. It tells agents to propose task changes, ask whether the destination is Jira or local, get explicit approval, then use the `jira` skill or write local task files.

## CRITICAL: Tests must NEVER have side effects

**All tests against live servers must be strictly read-only.** No creating, updating, deleting, or modifying anything. This is non-negotiable.

The live test sections in `tests/test-*.sh` run only when the corresponding service is configured on the machine. Every API call in those sections must be a GET or equivalent read-only operation:

- Jenkins: `GET /api/json` (server info)
- SonarQube: `GET /api/system/status` (health check)
- Dependency-Track: `GET /v1/project` (list projects)
- Jira: `GET /rest/api/3/myself`, `GET .../project/...`, `GET .../priority`, `POST .../search/jql` (search is read-only), `GET .../issue/...`, `GET .../transitions`
- ArgoCD: `GET /api/v1/session/userinfo` (health check), `GET .../applications` (list apps), `GET .../projects` (list projects)
- The "invalid type detection" test calls `jira-create.sh` but it exits at type validation before any write API call

The setup, codex, and coordinator suites reach no server at all. Keep them offline; do not add
a live section to them without re-auditing this rule.

If you add a live test, verify the full call chain to confirm nothing writes to the server.

## Tests

Run: `bash tests/test-all.sh`. It invokes every suite in `tests/` and aggregates the results.

**Not in the runner:** `hooks/test-guard-output.sh` covers the PreToolUse guard and
`tests/test-all.sh` does not call it. Run it by hand after touching `hooks/guard-output.sh`.

**The Jira arg-validation mock:** go-jira may not be installed. The tests create a stub `jira` binary (just `exit 1`) and a mock `$HOME` with `~/.jira.d/config.yml` so `_config.sh` passes. This lets scripts reach their own argument validation code. The stub isn't testing go-jira, it's bypassing the "go-jira not installed" gate.

**`dtrack-metrics-refresh.sh`** is the only script with valid no-arg behavior (portfolio-wide refresh). It's tested separately from the arg-validation loop.

## Conventions

- **`set -e` is per skill, not universal.** The curl-based action scripts (jenkins, sonarqube,
  dependency-track, argocd) use `set -eo pipefail`, and those four suites assert it with
  `grep -q 'set -e'`. Their `_config.sh` files use plain `set -e`. The jira scripts and
  `setup.sh` use neither, and no suite requires it there. One exception is asserted in reverse:
  `jenkins-test-failures.sh` must **not** have `set -e` (it handles 404s with `|| true`), and
  `tests/test-jenkins.sh` fails if it gains one. Check the skill's own suite before adding or
  removing the line.
- **Shebangs are mixed.** Both `#!/bin/bash` and `#!/usr/bin/env bash` are in use; `codex/`,
  `hooks/`, `setup.sh`, `pr-ready/pr-state.sh`, and `coordinator/dispatch-audit.sh` take the
  `env` form. Match the directory you are editing. Scripts should also pass `zsh -n`, which the
  jira, argocd, and coordinator suites check.
- Config: `~/.boring/<skill>/` with separate files per value (not a single config file)
- Error messages follow: what failed, then context, then common causes, then recovery commands
- curl-based tools have retry logic with exponential backoff for transport failures
- `_config.sh` files respect pre-set env vars (tests use this to inject fake URLs)
