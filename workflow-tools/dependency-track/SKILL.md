---
name: dependency-track
description: Query and audit Dependency-Track SCA findings. Use when working with software composition analysis, reviewing vulnerability findings, auditing CVEs, checking project dependency health, uploading SBOMs, or managing policy violations in Dependency-Track.
---

# Dependency-Track

Interact with the Dependency-Track SCA platform via its REST API.

## Configuration

Run `./setup.sh` from the repo root (recommended), or create config files manually:

```bash
mkdir -p ~/.boring/dependency-track
echo 'https://your-dtrack-server.example.com' > ~/.boring/dependency-track/url
echo 'your-api-key' > ~/.boring/dependency-track/apikey
chmod 600 ~/.boring/dependency-track/apikey
```

Obtain an API key: Administration → Access Management → Teams → Generate API key.
Required permissions: `VIEW_PORTFOLIO`, `VIEW_VULNERABILITY`, `VULNERABILITY_ANALYSIS`, `VIEW_POLICY_VIOLATION`.

## Scripts

### List / search projects

```bash
scripts/dtrack-projects.sh [name] [--inactive] [--tag TAG]
```

### Look up project by exact name

```bash
scripts/dtrack-project-lookup.sh <name> [version]
```

### Project status and metrics

```bash
scripts/dtrack-project-status.sh <project-uuid>
```

### List vulnerability findings

```bash
scripts/dtrack-findings.sh <project-uuid> [--suppressed] [--source NVD] [--cve CVE-ID] [--severity CRITICAL]
```

Each finding includes `component.uuid`, `vulnerability.uuid`, and `analysis.state` — needed for auditing.

### Vulnerability details

```bash
scripts/dtrack-vulnerability.sh <source> <vuln-id>
# Example: scripts/dtrack-vulnerability.sh NVD CVE-2024-12345
```

### Audit a finding

```bash
scripts/dtrack-audit.sh <project> <component> <vulnerability> \
    --state <STATE> [--justification JUST] [--response RESP] \
    [--comment "text"] [--details "text"] [--suppress|--unsuppress]
```

**States:** `FALSE_POSITIVE`, `NOT_AFFECTED`, `RESOLVED`, `IN_TRIAGE`, `EXPLOITABLE`, `NOT_SET`

**Justifications** (pair with `FALSE_POSITIVE` / `NOT_AFFECTED`):
`CODE_NOT_PRESENT`, `CODE_NOT_REACHABLE`, `REQUIRES_CONFIGURATION`, `REQUIRES_DEPENDENCY`, `REQUIRES_ENVIRONMENT`, `PROTECTED_BY_COMPILER`, `PROTECTED_AT_RUNTIME`, `PROTECTED_AT_PERIMETER`, `PROTECTED_BY_MITIGATING_CONTROL`

**Responses** (pair with `RESOLVED` / `EXPLOITABLE`):
`UPDATE`, `ROLLBACK`, `WORKAROUND_AVAILABLE`, `WILL_NOT_FIX`, `CAN_NOT_FIX`

### Retrieve existing analysis trail

```bash
scripts/dtrack-audit-get.sh <project> <component> <vulnerability>
```

### List components / services / violations

```bash
scripts/dtrack-components.sh <project-uuid> [page] [--search NAME]
scripts/dtrack-services.sh <project-uuid> [page]
scripts/dtrack-violations.sh <project-uuid> [--suppressed]
```

### Upload BOM (SBOM)

```bash
scripts/dtrack-bom-upload.sh <project-uuid> <bom-file> [--auto-create]
```

### Refresh metrics

```bash
scripts/dtrack-metrics-refresh.sh [project-uuid]
```

### Raw API

```bash
scripts/dtrack-api.sh GET "/v1/project"
scripts/dtrack-api.sh PUT "/v1/analysis" -d '{"project":"...","analysisState":"FALSE_POSITIVE"}'
```

## Typical workflow

```bash
S=scripts
$S/dtrack-projects.sh "my-service"
$S/dtrack-project-status.sh <uuid>
$S/dtrack-findings.sh <uuid>
$S/dtrack-vulnerability.sh NVD CVE-2024-XXXXX
$S/dtrack-audit-get.sh <project> <component> <vulnerability>
$S/dtrack-audit.sh <project> <component> <vulnerability> \
    --state FALSE_POSITIVE --justification CODE_NOT_REACHABLE \
    --comment "Vulnerable method is never invoked" --suppress
$S/dtrack-violations.sh <uuid>
```

## False positive patterns

Read [references/false-positive-patterns.md](references/false-positive-patterns.md) when investigating potential false positives from CPE namespace collisions or stale SBOM components.

## Links

```
<DTRACK_URL>/projects/<project-uuid>
<DTRACK_URL>/components/<component-uuid>
<DTRACK_URL>/vulnerabilities/<SOURCE>/<VULN-ID>
```
