# Codex fast mode

Automatically requests `service_tier: "priority"` for models selected from Pi's
`openai-codex` provider using the `openai-codex-responses` API. Requires Pi 1.4.0
or newer. Enabled by default.

The footer shows **Codex fast: priority** while a Codex model is selected and clears
when switching providers. This indicates priority is requested, not that the server
guarantees it. Availability and usage limits depend on the model and account.

## Commands

- `/codex-fast off`: stop requesting priority and clear the footer indicator.
- `/codex-fast on`: request priority again for Codex models.
- `/codex-fast`: show whether fast mode is on or off.

Changes apply to subsequent requests, not a response already in progress. The
setting survives model switches but resets to on when Pi restarts or reloads
extensions. With fast mode off, requests use Pi's normal service tier.

## Install

```bash
mkdir -p ~/.pi/agent/extensions
ln -s /absolute/path/to/boring-but-good/extensions/codex-fast-mode/index.ts ~/.pi/agent/extensions/codex-fast-mode.ts
```

Run `/reload` in Pi. Load only one fast-mode extension at a time.

## Tests

```bash
npm --prefix extensions run validate
```
