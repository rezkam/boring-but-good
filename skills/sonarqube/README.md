# SonarQube Skill

Give your AI agent access to code quality data — issues, coverage, security hotspots, and quality gate status.

## Why

SonarQube knows what's wrong with your code. Your agent should too. Instead of opening the SonarQube dashboard to check if a PR passes quality gates or what the coverage looks like, the agent can pull that data directly and act on it — fix the issues, explain the findings, or just report the numbers.

## What it can do

- **Fetch issues** — bugs, vulnerabilities, code smells, filtered by project, severity, or PR
- **Check coverage** — line coverage, uncovered lines, new code metrics for PRs and branches
- **Quality gate status** — pass/fail with which conditions failed
- **Security hotspots** — review priority hotspots that need attention
- **Transition issues** — confirm, resolve, mark as false positive, reopen
- **Search projects** — find SonarQube projects by name
- **Raw API access** — for anything the wrappers don't cover

## Scripts

| Script | Purpose |
|--------|---------|
| `sonarqube-issues.sh` | Fetch issues by project, severity, type, or PR |
| `sonarqube-coverage.sh` | Coverage metrics for project, branch, or PR |
| `sonarqube-quality-gate.sh` | Quality gate pass/fail status |
| `sonarqube-hotspots.sh` | Security hotspots |
| `sonarqube-transition.sh` | Transition issue status (confirm, resolve, etc.) |
| `sonarqube-projects.sh` | Search for projects |
| `sonarqube-api.sh` | Raw API access |
| `_api.sh` | HTTP helper with bearer and token auth |
| `_config.sh` | Configuration loader |

## Installation

```bash
npx skills add rezkam/boring-but-good --skill sonarqube
```

Or install manually — run `./setup.sh` from the repo root or see [SKILL.md](SKILL.md) for manual setup.

## Setup

Needs a SonarQube user token. Supports both token-as-login (default) and bearer auth.
