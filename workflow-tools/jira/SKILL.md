---
name: jira
description: Manage Jira issues — create, view, update, transition, comment, label, assign, list, search, and raw API access. Works with Jira Cloud and Server/Data Center via go-jira CLI.
---

# Jira

Manage Jira issues using wrapper scripts around the `go-jira` CLI.
Credentials are handled by go-jira (`~/.jira.d/config.yml` + OS keychain). Scripts never touch secrets directly.
The ADF conversion helpers use the dependencies declared in `scripts/package.json`. Run `npm ci --prefix scripts` after a manual install. `node_modules/` is local-only and is never committed.

## Configuration

Configured automatically by the setup script. Manual setup:

```bash
# 1. Install go-jira
brew install go-jira

# 2. Create config
mkdir -p ~/.jira.d
cat > ~/.jira.d/config.yml << 'EOF'
endpoint: https://your-org.atlassian.net
user: you@example.com
password-source: keyring
EOF
chmod 600 ~/.jira.d/config.yml

# 3. Store token in keychain
security add-generic-password -a "api-token:you@example.com" -s "go-jira" -w "YOUR_TOKEN"

# 4. Optional: set defaults
cat > ~/.boring/jira/defaults << 'EOF'
JIRA_PROJECT=PROJ
JIRA_ASSIGNEE=your-username
EOF

# 5. Optional: default labels (applied to every new ticket)
echo "label1 label2 label3" > ~/.boring/jira/default-labels
```

**Cloud tokens:** https://id.atlassian.com/manage-profile/security/api-tokens
**Server/DC PAT:** Profile → Personal Access Tokens

## Scripts

All scripts are in the `scripts/` directory relative to this skill.

### Project metadata (ALWAYS check first)

Before creating issues or transitioning, fetch the available types and transitions:

```bash
scripts/jira-meta.sh types                        # issue types for default project
scripts/jira-meta.sh types --project KEY           # issue types for specific project
scripts/jira-meta.sh transitions PROJ-123          # available transitions for an issue
scripts/jira-meta.sh statuses                      # all statuses in the project
scripts/jira-meta.sh priorities                    # available priorities
scripts/jira-meta.sh fields                        # all fields
scripts/jira-meta.sh refresh                       # force refresh cached data
```

Results are cached for 24h in `~/.boring/jira/cache/`. The create script validates issue types against this cache and shows valid options on mismatch.

### Create issue

```bash
scripts/jira-create.sh --type Bug --summary "[Service] Title" \
    [--description "text"] [--project KEY] [--assignee id] \
    [--priority High] [--labels "l1 l2"] [--parent KEY]
```

Applies default labels from `~/.boring/jira/default-labels` automatically. Returns the issue key.

#### Writing issue descriptions

**Always write descriptions in standard Markdown.** The scripts convert Markdown to Atlassian Document Format (ADF) automatically before posting. Never use Jira wiki markup (`h2.`, `{{code}}`, `*bold*`) — it will be stored as literal text and render broken in the Jira UI.

Supported Markdown:
- Headings: `##`, `###` (not `h2.`)
- Inline code: `` `code` `` (not `{{code}}`)
- Bold: `**text**` (not `*text*`)
- Bullets: `- item`
- Numbered lists: `1. item`
- Links: `[text](url)`
- Fenced code blocks: ` ```lang `

**Issues describe problems, not solutions.** Do not include fix details, code changes, or implementation plans. The fix is unknown at the time of filing — that comes later during investigation.

A good issue description contains:

1. **What is broken** — the observable symptom (error message, wrong output, crash, empty response)
2. **Why it happens** — the root cause or chain of events leading to the failure
3. **Impact** — who or what is affected, how severely, under what conditions
4. **How to reproduce** — exact steps, commands, or inputs that trigger the issue
5. **Expected vs actual behavior** — what should happen vs what does happen

**Do not include:**
- Fix proposals, code patches, or implementation suggestions
- "The fix is to change X to Y" — that belongs in a PR, not a ticket
- Workarounds (unless explicitly asked to document them)

**Example — BAD (Jira wiki markup — never do this):**
```
h2. What is broken
{{FileReaderLoop}} jams on {{exported/}} keys. Fix: add delimiter to ListObjectsV2.
```

**Example — GOOD (Markdown):**
```
## What is broken
`FileReaderLoop` jams when sub-folder keys appear in the listing result.
The loop fetches with `limit=1` and `exported/` sorts before all flat keys,
so the same unreachable key is returned on every iteration.
```

### View issue

```bash
scripts/jira-view.sh PROJ-123
scripts/jira-view.sh PROJ-123 --comments
```

### Transition issue

```bash
scripts/jira-transition.sh PROJ-123 --list               # list available transitions
scripts/jira-transition.sh PROJ-123 "In Progress"         # transition by name
scripts/jira-transition.sh PROJ-123 "Review"
scripts/jira-transition.sh PROJ-123 "Mark as in production"
```

### Add comment

```bash
scripts/jira-comment.sh PROJ-123 "Comment text"
```

### Update fields

```bash
scripts/jira-update.sh PROJ-123 --summary "[Svc] New title"
scripts/jira-update.sh PROJ-123 --description "Updated" --priority High
scripts/jira-update.sh PROJ-123 --assignee username
```

### Manage labels

```bash
scripts/jira-labels.sh PROJ-123 set label1 label2
scripts/jira-labels.sh PROJ-123 add new-label
scripts/jira-labels.sh PROJ-123 remove old-label
```

### Assign issue

```bash
scripts/jira-assign.sh PROJ-123                    # assign to default from config
scripts/jira-assign.sh PROJ-123 --me               # assign to self
scripts/jira-assign.sh PROJ-123 john.doe            # assign to specific user
scripts/jira-assign.sh PROJ-123 --unassign          # remove assignment
```

### List issues (JQL)

```bash
scripts/jira-list.sh --assignee me --status "In Progress"
scripts/jira-list.sh --status "In Progress,In code review" --type Bug
scripts/jira-list.sh --project PROJ --limit 20
scripts/jira-list.sh --jql "project = PROJ AND created >= -7d ORDER BY priority DESC"
```

### Search issues

```bash
scripts/jira-search.sh "memory leak" --project PROJ
scripts/jira-search.sh "NPE" --limit 10
```

### Raw API access

```bash
scripts/jira-api.sh GET "/rest/api/3/myself"
scripts/jira-api.sh GET "/rest/api/3/issue/PROJ-123"
scripts/jira-api.sh POST "/rest/api/3/issue" '{"fields":{...}}'
scripts/jira-api.sh PUT "/rest/api/3/issue/PROJ-123" '{"fields":{"summary":"New"}}'
```

## Workflow example

```bash
S=scripts

# Create and start working
ISSUE=$($S/jira-create.sh --type Bug --summary "[Service] NPE in processor" --description "Stack trace...")
$S/jira-transition.sh $ISSUE "Start progress"

# ... fix and push PR ...
$S/jira-transition.sh $ISSUE "Review"

# ... after merge & deploy ...
$S/jira-transition.sh $ISSUE "Mark as in production"
$S/jira-comment.sh $ISSUE "Deployed to production"
```
