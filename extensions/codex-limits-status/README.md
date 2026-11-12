# Codex Limits Status extension for Pi

Displays Codex account usage in Pi's status bar:

```text
Codex used 69% (resets in 2d3h10m)
```

Only models whose **provider starts with `openai-codex`** show this status.
Model IDs and API names do not enable it for other providers.

## Install

From this repository checkout:

```bash
mkdir -p ~/.pi/agent/extensions
ln -s "$PWD/extensions/codex-limits-status" ~/.pi/agent/extensions/codex-limits-status
```

If an older standalone `codex-limits-status.ts` is installed in that directory,
remove or move it before linking the directory so the extension is not loaded twice.
Run `/reload` in an existing Pi session.

For a one-session test without installing:

```bash
pi -e ./extensions/codex-limits-status/index.ts
```

## Behavior

- Reads the existing `openai-codex` access token and account ID from Pi's
  `auth.json` under `PI_CODING_AGENT_DIR`, or `~/.pi/agent` by default.
  Matching provider aliases use that same account's limits.
- Makes read-only requests to the Codex usage endpoint on session start,
  model selection, and agent end; also accepts provider response headers.
- Shows **percent used**, not remaining. Usage at 75% is warning-colored;
  usage at 90% is error-colored.
- Supports weekly-only accounts without a missing five-hour placeholder.
  When multiple windows exist, labels distinguish them, for example:
  `Codex used 5h 20% (resets in 1h0m) · 7d 69% (resets in 2d3h10m)`.
- Adds a reset countdown only when a reset time is available. It updates every
  minute without making extra network requests, rounds partial minutes up,
  and never becomes negative. After the deadline it shows `0m` until new usage
  data arrives; it does not assume the account has reset.
- Keeps the last successful status on transient network or authentication
  failures. No credentials are logged or written by the extension.

The reset countdown describes the allowance window, not authentication expiry.
At reset, the allowance becomes available again (usage returns to 0%).

## Development

```bash
npm --prefix extensions install
npm --prefix extensions run validate
```

Tests use fixture credentials, mocked usage responses, and a controlled clock;
no live account or network connection is required.
