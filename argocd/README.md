# ArgoCD Skill

Give your AI agent eyes on your GitOps deployments — check sync status, trigger syncs, read logs, and roll back when things go wrong.

## Why

Deployment stuck? Instead of clicking through the ArgoCD UI, the agent can check the sync status, inspect resource health, read pod logs, and tell you what went wrong. Or sync after a code change and watch it roll out.

## What it can do

- **Check app status** — sync state, health, conditions, last operation
- **List applications** — filter by project or repo
- **Trigger syncs** — with optional revision, prune, dry-run
- **Watch sync progress** — poll until synced and healthy
- **View deployment history** — with rollback capability
- **Inspect resources** — Kubernetes resource tree with health
- **Read pod logs** — filter by resource, container, tail lines
- **View manifests** — rendered Kubernetes manifests
- **Show diffs** — live vs desired state differences
- **Resource actions** — restart deployments, etc.
- **Browse projects, clusters, repos** — navigate the ArgoCD topology

## Scripts

| Script | Purpose |
|--------|---------|
| `argocd-app-list.sh` | List applications |
| `argocd-app-get.sh` | Application status and details |
| `argocd-app-sync.sh` | Trigger a sync |
| `argocd-app-wait.sh` | Wait for sync + healthy |
| `argocd-app-history.sh` | Deployment history |
| `argocd-app-resources.sh` | Resource tree |
| `argocd-app-logs.sh` | Pod logs |
| `argocd-app-manifests.sh` | Rendered manifests |
| `argocd-app-diff.sh` | Live vs desired diff |
| `argocd-app-rollback.sh` | Rollback to previous version |
| `argocd-app-actions.sh` | Resource actions (restart, etc.) |
| `argocd-app-delete.sh` | Delete an application |
| `argocd-project-list.sh` | List projects |
| `argocd-project-get.sh` | Project details |
| `argocd-cluster-list.sh` | List clusters |
| `argocd-repo-list.sh` | List repositories |
| `argocd-api.sh` | Raw API access |
| `_api.sh` | HTTP helper (all curl calls go through here) |
| `_config.sh` | Configuration loader |

## Installation

```bash
npx skills add rezkam/boring-but-good --skill argocd
```

Or install manually — run `./setup.sh` from the repo root or see [SKILL.md](SKILL.md) for manual setup.

## Setup

Needs an ArgoCD Bearer token (JWT). Generate one with `argocd account generate-token`.
