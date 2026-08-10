# Jenkins Skill

Give your AI agent eyes on your CI pipeline — check what's building, why it failed, and kick off new builds.

## Why

Build broke? Instead of clicking through Jenkins UI, the agent can pull the status, grab the failing test names, read the console output, and tell you what went wrong. Or trigger a rebuild after pushing a fix and watch it complete.

## What it can do

- **Check build status** — result, duration, commit info for any build
- **Read test failures** — failed test names with optional full stack traces
- **View console output** — full log or grep for specific patterns
- **Trigger builds** — with or without parameters
- **Watch builds** — poll until complete, exit 0 on success / 1 on failure
- **Pipeline stages** — see which stage passed or failed
- **Build history** — recent builds with results
- **List jobs** — browse folder structures
- **Build queue** — what's waiting to run
- **Abort builds** — stop a running build

## Scripts

| Script | Purpose |
|--------|---------|
| `jenkins-build-status.sh` | Build result and metadata |
| `jenkins-test-failures.sh` | Failed tests with optional stack traces |
| `jenkins-console.sh` | Console output with optional grep |
| `jenkins-trigger.sh` | Trigger a build with URL-encoded parameters |
| `jenkins-watch.sh` | Poll until build finishes |
| `jenkins-stages.sh` | Pipeline stage status |
| `jenkins-build-history.sh` | Recent build history |
| `jenkins-list-jobs.sh` | List jobs in a folder |
| `jenkins-queue.sh` | Build queue |
| `jenkins-abort.sh` | Stop a running build |
| `jenkins-api.sh` | Raw API access |
| `_api.sh` | HTTP helper (all curl calls go through here) |
| `_config.sh` | Configuration loader |

## Installation

```bash
npx skills add rezkam/boring-but-good --skill jenkins
```

Or install manually — run `./setup.sh` from the repo root or see [SKILL.md](SKILL.md) for manual setup.

## Setup

Needs a Jenkins API token.
