# Codex fast mode

Optionally requests `service_tier: "priority"` for models selected from Pi's
`openai-codex` provider using the `openai-codex-responses` API. Requires Pi 1.4.0
or newer. **Disabled by default.** Run `/codex-fast on` to enable it.

The footer shows **Codex fast: priority** while a Codex model is selected and clears
when switching providers. This indicates priority is requested, not that the server
guarantees it. Availability, billing, and usage limits depend on the model and
account. Fast mode does not change the model, reasoning effort, or output limits.

## Commands

- `/codex-fast off`: stop requesting priority and clear the footer indicator.
- `/codex-fast on`: opt in to priority requests for Codex models.
- `/codex-fast`: show whether fast mode is on or off.

Changes apply to subsequent requests, not a response already in progress. The
setting survives model switches but resets to off when Pi restarts or reloads
extensions. With fast mode off, the extension leaves the request unchanged,
including any service tier configured elsewhere.

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

## Request behavior

The parameter matches [OpenAI Codex's fast-tier mapping](https://github.com/openai/codex/blob/9cc14e79882ff8885cd5d33b4adadae014045aef/codex-rs/protocol/src/config_types.rs#L539-L543).
Pi 1.4.0 applies the payload hook before serializing either HTTP or WebSocket
requests.
