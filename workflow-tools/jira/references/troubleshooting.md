# Jira Troubleshooting

## Table of Contents
- Authentication errors (401/403)
- Rate limiting (429)
- Description format (ADF vs plain text)
- Transition not found
- Assignee field format (Cloud vs Server)

## Authentication Errors (401/403)

- **Cloud**: Use Basic auth with `email:api-token`. PAT is not supported.
- **Server/DC**: Use Basic auth with `username:password` or Bearer (PAT).
- Verify token hasn't expired.
- Check project-level permissions.

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
