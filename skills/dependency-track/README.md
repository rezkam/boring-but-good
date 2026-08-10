# Dependency-Track Skill

Give your AI agent access to your software composition analysis — know what vulnerabilities are in your dependencies and audit them.

## Why

Dependency-Track tells you which of your 500 dependencies have known CVEs. This skill lets your agent query that data, filter by severity, audit findings as false positives or not affected, and check if a project's dependency health is getting better or worse. Useful during PR reviews, security audits, or when someone asks "are we affected by CVE-2024-XXXX?"

## What it can do

- **List projects** — with pagination, search, tag filtering, and inactive project support
- **Look up projects** — by exact name and version
- **View project status** — vulnerability counts, risk scores, component totals
- **List findings** — vulnerabilities with severity, CVSS, CWE, and audit state
- **Audit findings** — mark as NOT_AFFECTED, FALSE_POSITIVE, EXPLOITABLE, etc.
- **Get audit history** — see who audited what and when
- **List components** — project dependencies with license and version info
- **Check policy violations** — license or security policy failures
- **View services** — external service dependencies
- **Raw API access** — for anything the wrappers don't cover

## Scripts

| Script | Purpose |
|--------|---------|
| `dtrack-projects.sh` | List/search projects with pagination |
| `dtrack-project-lookup.sh` | Look up project by name and version |
| `dtrack-project-status.sh` | Vulnerability summary for a project |
| `dtrack-findings.sh` | List vulnerability findings |
| `dtrack-audit.sh` | Set audit status on a finding |
| `dtrack-audit-get.sh` | Get audit trail for a finding |
| `dtrack-components.sh` | List project dependencies |
| `dtrack-violations.sh` | Policy violations |
| `dtrack-services.sh` | External service dependencies |
| `dtrack-api.sh` | HTTP helper and raw API access |
| `_config.sh` | Configuration loader |

## Installation

```bash
npx skills add rezkam/boring-but-good --skill dependency-track
```

Or install manually — run `./setup.sh` from the repo root or see [SKILL.md](SKILL.md) for manual setup.

## Setup

Needs a Dependency-Track API key with `VIEW_PORTFOLIO`, `VIEW_VULNERABILITY`, `VULNERABILITY_ANALYSIS`, and `VIEW_POLICY_VIOLATION` permissions.
