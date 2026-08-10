---
name: argocd
description: Interact with ArgoCD GitOps deployments via REST API. Use when checking application sync status, health, triggering syncs, viewing deployment history, inspecting Kubernetes resources, reading pod logs, rolling back deployments, listing projects/clusters/repos, or managing ArgoCD applications.
---

# ArgoCD

Interact with an ArgoCD server via its REST API.

## Configuration

Run `./setup.sh` from the repo root (recommended), or create config files manually:

```bash
mkdir -p ~/.boring/argocd
echo 'https://argocd.example.com' > ~/.boring/argocd/url
echo 'your-bearer-token' > ~/.boring/argocd/token
chmod 600 ~/.boring/argocd/token
```

Generate a token:
- **API token**: `argocd account generate-token --account <account-name>`
- **Session token**: `curl -s $ARGOCD_URL/api/v1/session -d '{"username":"admin","password":"PASSWORD"}'`

## Scripts

### List applications

```bash
scripts/argocd-app-list.sh [--project PROJECT] [--repo REPO]
```

### Application details

```bash
scripts/argocd-app-get.sh <app-name> [--project PROJECT]
```

Shows sync status, health, repo, target revision, conditions, last operation.

### Sync an application

```bash
scripts/argocd-app-sync.sh <app-name> [--revision REV] [--prune] [--dry-run] [--project PROJECT]
```

### Wait for sync and health

```bash
scripts/argocd-app-wait.sh <app-name> [--timeout SECONDS] [--project PROJECT]
```

Polls until the app is Synced + Healthy (or timeout). Default timeout: 300s.

### Sync history

```bash
scripts/argocd-app-history.sh <app-name> [--project PROJECT]
```

### Resource tree

```bash
scripts/argocd-app-resources.sh <app-name> [--project PROJECT]
```

Shows all Kubernetes resources managed by the app with their health and status.

### Pod logs

```bash
scripts/argocd-app-logs.sh <app-name> [--resource NAME] [--container NAME] [--tail LINES] [--project PROJECT]
```

### Rendered manifests

```bash
scripts/argocd-app-manifests.sh <app-name> [--project PROJECT]
```

### Live vs desired diff

```bash
scripts/argocd-app-diff.sh <app-name> [--project PROJECT]
```

Shows resources that differ between the live cluster state and the desired state in Git.

### Rollback

```bash
scripts/argocd-app-rollback.sh <app-name> <history-id> [--project PROJECT]
```

Use `argocd-app-history.sh` to find the history ID.

### Resource actions

```bash
scripts/argocd-app-actions.sh <app-name> --kind KIND --name RESOURCE_NAME [--run ACTION] [--namespace NS] [--group GROUP] [--project PROJECT]
```

List available actions (omit `--run`) or execute one (e.g. restart a Deployment).

### Delete application

```bash
scripts/argocd-app-delete.sh <app-name> [--cascade|--no-cascade] [--project PROJECT]
```

`--cascade` (default) also deletes Kubernetes resources. `--no-cascade` removes from ArgoCD only.

### List projects

```bash
scripts/argocd-project-list.sh
```

### Project details

```bash
scripts/argocd-project-get.sh <project-name>
```

### List clusters

```bash
scripts/argocd-cluster-list.sh
```

### List repositories

```bash
scripts/argocd-repo-list.sh
```

### Raw API

```bash
scripts/argocd-api.sh <endpoint> [curl-options...]
```

## Typical workflow

```bash
S=scripts
# Check what's deployed
$S/argocd-app-list.sh
$S/argocd-app-get.sh my-service
$S/argocd-app-resources.sh my-service

# After pushing code changes, sync
$S/argocd-app-sync.sh my-service
$S/argocd-app-wait.sh my-service --timeout 600

# Debug if unhealthy
$S/argocd-app-logs.sh my-service --resource my-service-pod --tail 200
$S/argocd-app-diff.sh my-service

# Rollback if needed
$S/argocd-app-history.sh my-service
$S/argocd-app-rollback.sh my-service 5
$S/argocd-app-wait.sh my-service
```

## API endpoints reference

All endpoints are under the ArgoCD server URL:
- `/api/v1/applications` — list/create applications
- `/api/v1/applications/{name}` — get/update/delete app
- `/api/v1/applications/{name}/sync` — trigger sync (POST)
- `/api/v1/applications/{name}/rollback` — rollback (POST)
- `/api/v1/applications/{name}/resource-tree` — resource tree
- `/api/v1/applications/{name}/managed-resources` — managed resources with diffs
- `/api/v1/applications/{name}/manifests` — rendered manifests
- `/api/v1/applications/{name}/logs` — pod logs
- `/api/v1/applications/{name}/resource/actions` — resource actions
- `/api/v1/projects` — list/create projects
- `/api/v1/projects/{name}` — get/update project
- `/api/v1/clusters` — list clusters
- `/api/v1/repositories` — list repositories
- `/api/v1/session/userinfo` — current user info

Auth: `Authorization: Bearer <token>`. All endpoints accept optional `project` query param.
