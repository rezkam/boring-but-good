# boring-but-good

Shell-script and workflow skills that give AI coding agents (Claude Code, etc.) the ability to interact with engineering systems. Each skill is a directory with a `SKILL.md`; workflow tools also include a `scripts/` folder.

## Skills

| Skill | External tool | Auth mechanism |
|---|---|---|
| `workflow-tools/jira/` | go-jira CLI (`jira`) | Keychain via `~/.jira.d/config.yml` |
| `to-tasks/` | jira skill or local files | Uses Jira configuration through `workflow-tools/jira/`, or writes local task files under `.agents/skills/to-tasks/` |
| `workflow-tools/jenkins/` | curl | `~/.boring/jenkins/{url,user,token}` |
| `workflow-tools/sonarqube/` | curl | `~/.boring/sonarqube/{url,token}` + optional `auth_method` |
| `workflow-tools/dependency-track/` | curl | `~/.boring/dependency-track/{url,apikey}` |
| `workflow-tools/argocd/` | curl | `~/.boring/argocd/{url,token}` |
| `skanetrafiken/` | curl | No auth needed |
| `browser-tools/` | Node.js + Chrome | Copied Chrome profile under `~/.cache/pi-browser-tools` |
| `finance/` | Node.js + Chrome via browser-tools | Browser-authenticated finance sessions from managed Chrome |
| `ai-chat/` | Node.js + Chrome via browser-tools | Browser-authenticated provider sessions from managed Chrome |

## Architecture

- **Config loaders** (`_config.sh`): Read credentials from `~/.boring/<skill>/` files. Environment variables take precedence over files (`if [ -z "$VAR" ] && [ -f file ]`).
- **API helpers** (`_api.sh`): Wrap curl with auth, retry logic (transient failures: codes 7/28/52/56), structured error messages, and HTTP status capture. Jenkins and SonarQube share this pattern. DTrack inlines it in `dtrack-api.sh`.
- **Jira is different**: Uses go-jira CLI instead of curl. Auth is via keychain, not token files. Scripts wrap `jira request -M METHOD ENDPOINT`.
- **to-tasks is workflow-only**: It has no scripts or credentials of its own. It tells agents to propose task changes, ask whether the destination is Jira or local, get explicit approval, then use the `jira` skill or write local task files.
- **`setup.sh`**: Interactive installer. Validates URLs, creates config dirs, symlinks SKILL.md files.

## CRITICAL: Tests must NEVER have side effects

**All tests against live servers must be strictly read-only.** No creating, updating, deleting, or modifying anything. This is non-negotiable.

The live test sections in `tests/test-*.sh` run only when the corresponding service is configured on the machine. Every API call in those sections must be a GET or equivalent read-only operation:

- Jenkins: `GET /api/json` (server info)
- SonarQube: `GET /api/system/status` (health check)
- Dependency-Track: `GET /v1/project` (list projects)
- Jira: `GET /rest/api/3/myself`, `GET .../project/...`, `GET .../priority`, `POST .../search/jql` (search is read-only), `GET .../issue/...`, `GET .../transitions`
- ArgoCD: `GET /api/v1/session/userinfo` (health check), `GET .../applications` (list apps), `GET .../projects` (list projects)
- The "invalid type detection" test calls `jira-create.sh` but it exits at type validation before any write API call

If you add a live test, verify the full call chain to confirm nothing writes to the server.

## Tests

Run: `bash tests/test-all.sh`

**Structure:**
- `tests/test-all.sh` — runner that invokes all suites and aggregates results
- `tests/test-{jira,jenkins,sonarqube,dependency-track}.sh` — per-skill suites

**Test categories:**
1. **Static checks** — SKILL.md structure, script syntax (bash + zsh), `set -e`/`set -eo pipefail`, no hardcoded paths, no company-specific data
2. **Argument validation** — scripts exit non-zero with missing/invalid args, error messages are actionable. Jira tests use a stub `jira` binary + mock `$HOME` so tests work without go-jira installed.
3. **Regression tests** — specific bugs that were found and fixed (grep for patterns in script source)
4. **Live integration tests** — skipped when service is not configured, read-only when it is
5. **Cross-skill checks** — no data leaks, setup.sh zsh-safety, SKILL.md consistency

**The Jira arg-validation mock:** go-jira may not be installed. The tests create a stub `jira` binary (just `exit 1`) and a mock `$HOME` with `~/.jira.d/config.yml` so `_config.sh` passes. This lets scripts reach their own argument validation code. The stub isn't testing go-jira — it's bypassing the "go-jira not installed" gate.

**`dtrack-metrics-refresh.sh`** is the only script with valid no-arg behavior (portfolio-wide refresh). It's tested separately from the arg-validation loop.

## Conventions

- All scripts use `set -eo pipefail`
- All scripts use `#!/bin/bash` shebangs but should pass `zsh -n` syntax check
- Config: `~/.boring/<skill>/` with separate files per value (not a single config file)
- Error messages follow: what failed → context → common causes → recovery commands
- curl-based tools have retry logic with exponential backoff for transport failures
- `_config.sh` files respect pre-set env vars (tests use this to inject fake URLs)
