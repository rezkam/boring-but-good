---
name: sonarqube
description: Fetch and fix SonarQube code quality issues, coverage metrics, security hotspots, and quality gate status. Use when reviewing SonarQube findings for a project or pull request, checking code coverage, investigating security hotspots, verifying quality gate pass/fail, or searching for SonarQube projects.
---

# SonarQube

Interact with SonarQube to fetch code quality issues, coverage, and quality gate status.

## Configuration

Run `./setup.sh` from the repo root (recommended), or create config files manually:

```bash
mkdir -p ~/.boring/sonarqube
echo 'https://your-sonarqube.example.com' > ~/.boring/sonarqube/url
echo 'your-token' > ~/.boring/sonarqube/token
chmod 600 ~/.boring/sonarqube/token
```

For bearer auth (instead of default token-as-login), also create:
```bash
echo 'bearer' > ~/.boring/sonarqube/auth_method
```

Generate token: User → My Account → Security → Generate Tokens.

## Scripts

### Fetch issues

```bash
scripts/sonarqube-issues.sh <project-key> [pr-number] \
    [--status OPEN,CONFIRMED] [--severity CRITICAL,BLOCKER] \
    [--type BUG] [--branch main] [--limit 100]
```

### Coverage metrics

```bash
scripts/sonarqube-coverage.sh <project-key> [pr-number] [--branch main]
```

For PRs, returns new code coverage. For branches/projects, returns overall coverage.

### Security hotspots

```bash
scripts/sonarqube-hotspots.sh <project-key> [--pr N] [--branch main] [--status TO_REVIEW]
```

### Quality gate status

```bash
scripts/sonarqube-quality-gate.sh <project-key> [--pr N] [--branch main]
```

Exits 0 if gate passes, 1 if it fails.

### List/search projects

```bash
scripts/sonarqube-projects.sh [search-query] [--limit 50]
```

### Transition an issue

```bash
scripts/sonarqube-transition.sh <issue-key> <transition> [--comment "text"]
```

**Transitions:** `confirm`, `unconfirm`, `reopen`, `resolve`, `falsepositive`, `wontfix`, `accept`

Mark issues as false positive, resolved, or won't fix. Optionally attach a comment explaining why.

### Raw API

```bash
scripts/sonarqube-api.sh <endpoint> [curl-options...]
```

## Workflow for fixing issues

```bash
S=scripts

# 1. Fetch issues for a PR
$S/sonarqube-issues.sh my-service 327

# 2. Check quality gate
$S/sonarqube-quality-gate.sh my-service --pr 327

# 3. Check coverage
$S/sonarqube-coverage.sh my-service 327

# 4. Check security hotspots
$S/sonarqube-hotspots.sh my-service --pr 327

# 5. Fix issues, verify compilation, commit
```

## Common Java rules and fixes

Read [references/common-rules.md](references/common-rules.md) for fix patterns for frequently triggered rules (S3457 logging concatenation, S2629 conditional invocation, S1128 unused imports, S5786 JUnit modifiers, etc.).

## API reference

**Issue search:** `GET /api/issues/search?componentKeys=KEY&pullRequest=N&issueStatuses=OPEN&severities=CRITICAL&types=BUG&ps=100`

**Measures:** `GET /api/measures/component?component=KEY&pullRequest=N&metricKeys=new_coverage,new_line_coverage`

**Quality gate:** `GET /api/qualitygates/project_status?projectKey=KEY&pullRequest=N`

**Hotspots:** `GET /api/hotspots/search?projectKey=KEY&status=TO_REVIEW`

**Dashboard URL:** `<SONARQUBE_URL>/dashboard?id=PROJECT_KEY&pullRequest=PR_NUMBER`
