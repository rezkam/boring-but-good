# Codex fast mode

Automatically requests `service_tier: "priority"` for models selected from Pi's
`openai-codex` provider using the `openai-codex-responses` API. Requires Pi 1.4.0
or newer. No commands or configuration.

The footer shows **Codex fast: priority** while a Codex model is selected and clears
when switching providers. This indicates priority is requested, not that the server
guarantees it. Availability and usage limits depend on the model and account.

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
