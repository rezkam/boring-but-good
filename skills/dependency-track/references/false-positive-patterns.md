# Common False Positive Patterns

## Table of Contents
- CPE Namespace Collision
- Stale SBOM Components
- Audit Workflow Checklist

## CPE Namespace Collision

Dependency-Track uses CPE (Common Platform Enumeration) matching to correlate components with known vulnerabilities. This frequently produces false positives when an artifact name collides with an unrelated product name in the CPE dictionary.

**Pattern:** A single CVE flagged against multiple unrelated components that share a generic artifact name (e.g. "core", "common", "utils").

**How to verify:**
1. Check the CVE details (NVD/NIST, MITRE, OSV) — identify the actual affected vendor, product, and technology
2. Compare against the flagged component's group/vendor, technology stack, and actual usage
3. Search the codebase for any reference to the actual vulnerable product
4. If the component is a transitive dependency, trace its usage (e.g. `rg "import.*zxing"`)
5. Check if the component is even still present (stale SBOM entries for removed dependencies)

**How to resolve:**
- State: `FALSE_POSITIVE`
- Justification: `CODE_NOT_PRESENT` (the actual vulnerable product was never there)
- Comment: Explain the CPE collision — name the actual product, the flagged component, and why they're unrelated
- Details: Note verification steps taken (codebase search results, technology mismatch, vendor mismatch)
- Suppress: `--suppress`

**Important:** A single CVE can generate multiple findings if several components share the colliding name. Always filter findings by `vulnId`:
```bash
dtrack-findings.sh <project-uuid> --cve CVE-XXXX-XXXXX
```

## Stale SBOM Components

Components that were part of a previous SBOM upload but have since been removed from the project. They show up in findings but are not in the current dependency files or lock files.

**How to verify:** Search for the component in the project's dependency files and build artifacts.

**How to resolve:** `FALSE_POSITIVE` with `CODE_NOT_PRESENT`, note that the component is no longer in the project.

## Audit Workflow Checklist

When auditing vulnerability findings:

1. **Identify all findings for the CVE** — one CVE can flag multiple components
2. **Research the CVE** — check NVD, MITRE, OSV for the actual affected product, vendor, and technology
3. **Verify each component in the codebase:**
   - Is the component a direct or transitive dependency? Check dependency files
   - Is the component still present? Check lock files and build artifacts
   - Does the codebase actually use the vulnerable feature? Search for imports/references
4. **Record the decision** with `dtrack-audit.sh` — include specific evidence in `--comment` and `--details`
5. **Verify** — re-run `dtrack-findings.sh` to confirm findings are suppressed from active list
