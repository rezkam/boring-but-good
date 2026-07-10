# Jira Skill

Give your AI agent full access to Jira — create issues, move them through workflows, search across projects, manage labels and assignments. Works with both Jira Cloud and Server/Data Center.

## Why

An agent that can read code but can't file a ticket is only half useful. This skill closes the loop: find a bug, create the issue, assign it, transition it through your workflow, all without leaving the terminal.

## What it can do

- **Create issues** with type validation, default labels, and sub-task support
- **View and search** issues with JQL, full-text search, or filtered listing
- **Update anything** — summary, description, priority, assignee, labels
- **Transition issues** through your workflow (In Progress → Review → Done)
- **Comment on issues** for audit trails and context
- **Fetch project metadata** — issue types, statuses, priorities, transitions (cached 24h)
- **Raw API access** for anything the wrappers don't cover

## Scripts

| Script | Purpose |
|--------|---------|
| `jira-create.sh` | Create an issue with validation and default labels |
| `jira-view.sh` | View issue details and comments |
| `jira-update.sh` | Update fields (summary, description, priority, assignee) |
| `jira-transition.sh` | Move an issue through workflow states |
| `jira-comment.sh` | Add a comment |
| `jira-labels.sh` | Set, add, or remove labels |
| `jira-assign.sh` | Assign, unassign, or take an issue |
| `jira-list.sh` | List issues with filters (status, type, assignee) |
| `jira-search.sh` | Full-text search across issues |
| `jira-meta.sh` | Fetch and cache project metadata |
| `jira-api.sh` | Raw REST API access via go-jira |
| `_config.sh` | Configuration loader |

## Installation

```bash
npx skills add rezkam/boring-but-good --skill jira
```

Or install manually — run `./setup.sh` from the repo root or see [SKILL.md](SKILL.md) for manual setup.

## Setup

Uses [go-jira](https://github.com/go-jira/jira) CLI with OS keychain for credentials.
