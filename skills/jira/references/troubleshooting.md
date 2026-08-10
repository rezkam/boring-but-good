# Jira Troubleshooting

## Table of Contents
- Authentication errors (401/403)
- macOS SSH / `ERROR EOF`
- Rate limiting (429)
- Description format (ADF vs plain text)
- Transition not found
- Assignee field format (Cloud vs Server)

## Authentication Errors (401/403)

- **Cloud**: Use Basic auth with `email:api-token`. PAT is not supported.
- **Server/DC**: Use Basic auth with `username:password` or Bearer (PAT).
- Verify token hasn't expired.
- Check project-level permissions.

## macOS SSH / `ERROR EOF`

Older go-jira releases invoke `security find-generic-password` without naming a keychain. In SSH or other non-GUI sessions, macOS may search only `System.keychain` even though the token is present in `~/Library/Keychains/login.keychain-db`. The Jira skill scripts detect this and query the login keychain explicitly.

If the item exists but cannot be read, unlock the keychain interactively and retry the same skill command:

```bash
security unlock-keychain "$HOME/Library/Keychains/login.keychain-db"
```

To use another keychain:

```bash
export JIRA_KEYCHAIN_PATH=/path/to/custom.keychain-db
```

The scripts recognize the canonical go-jira item (`service=go-jira`, `account=api-token:<email>`) and the common endpoint-style item (`service=<Jira URL>`, `account=<email>`). They do not scan arbitrary files or print token values.

## Rate Limiting (429)

Add delays between bulk operations. Jira Cloud rate limits vary by plan.

## Description Format

Jira Cloud API v3 uses Atlassian Document Format (ADF). The scripts handle this automatically.

For manual API calls:
```bash
# v2 — plain text
jira-api.sh PUT "/rest/api/2/issue/KEY" '{"fields":{"description":"plain text"}}'

# v3 — ADF (default)
jira-api.sh PUT "/rest/api/3/issue/KEY" '{"fields":{"description":{"type":"doc","version":1,"content":[{"type":"paragraph","content":[{"type":"text","text":"rich text"}]}]}}}'
```

## Transition Not Found

List available transitions first:
```bash
jira-transition.sh KEY --list
```
Transition names are workflow-specific and differ between projects.

## Assignee Field Format

- **Cloud**: Uses `accountId` — find yours with: `jira-api.sh GET "/rest/api/3/myself" | jq '.accountId'`
- **Server/DC**: Uses `name` (username)
