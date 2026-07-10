---
name: jenkins
description: Interact with Jenkins CI via REST API. Use when checking build status, viewing test failures, reading console output, triggering builds, watching build progress, viewing pipeline stages, listing jobs, or managing the build queue on a Jenkins server.
---

# Jenkins CI

Interact with a Jenkins CI server via its REST API.

## Configuration

Run `./setup.sh` from the repo root (recommended), or create config files manually:

```bash
mkdir -p ~/.boring/jenkins
echo 'https://your-jenkins.example.com' > ~/.boring/jenkins/url
echo 'your-username' > ~/.boring/jenkins/user
echo 'your-api-token' > ~/.boring/jenkins/token
chmod 600 ~/.boring/jenkins/token
```

Obtain an API token: Log in → Your Username → Configure → API Token → Add new Token → Generate.

## Job path format

Paths use `/` to separate folders:
- `MyOrg/my-service/main` — main branch
- `MyOrg/my-service/PR-42` — pull request
- `MyOrg/my-service/feature%2Fmy-branch` — URL-encode slashes in branch names

## Scripts

### Build status

```bash
scripts/jenkins-build-status.sh <job-path> [build-number]
```

### Test failures

```bash
scripts/jenkins-test-failures.sh <job-path> [build-number] [--full]
```

`--full` includes complete stack traces.

### Console output

```bash
scripts/jenkins-console.sh <job-path> [build-number] [grep-pattern]
```

### Trigger a build

```bash
scripts/jenkins-trigger.sh <job-path> [--param KEY=VALUE]...
```

### Watch build progress

```bash
scripts/jenkins-watch.sh <job-path> [build-number]
```

Polls until the build finishes and exits 0 on success, 1 on failure.

### Build history

```bash
scripts/jenkins-build-history.sh <job-path> [count]
```

### Pipeline stages

```bash
scripts/jenkins-stages.sh <job-path> [build-number]
```

Shows stage names with pass/fail status (requires Pipeline plugin).

### List jobs

```bash
scripts/jenkins-list-jobs.sh [folder-path] [--depth N]
```

### Build queue

```bash
scripts/jenkins-queue.sh
```

### Abort a build

```bash
scripts/jenkins-abort.sh <job-path> [build-number]
```

### Raw API

```bash
scripts/jenkins-api.sh <endpoint> [curl-options...]
```

## Typical workflow

```bash
S=scripts
$S/jenkins-build-status.sh "MyOrg/my-service/PR-42"
$S/jenkins-test-failures.sh "MyOrg/my-service/PR-42"
$S/jenkins-console.sh "MyOrg/my-service/PR-42" lastBuild "ERROR"
$S/jenkins-stages.sh "MyOrg/my-service/PR-42"
$S/jenkins-trigger.sh "MyOrg/my-service/PR-42"
$S/jenkins-watch.sh "MyOrg/my-service/PR-42"
```

## API endpoints reference

Append to job URL:
- `/api/json` — metadata
- `/lastBuild/api/json` — last build
- `/lastBuild/consoleText` — console
- `/lastBuild/testReport/api/json` — test results
- `/build` — trigger (POST)
- `/buildWithParameters?KEY=VALUE` — parameterized trigger (POST)
- `/lastBuild/wfapi/describe` — pipeline stages
- `/stop` — abort (POST)

Query params: `tree=field[sub]`, `depth=N`
