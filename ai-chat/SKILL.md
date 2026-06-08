---
name: ai-chat
description: "Use browser-authenticated AI chat providers through reusable provider adapters and Browser Tools. Use this skill whenever the user asks to query Grok, ChatGPT, Gemini, or Perplexity through their logged-in browser session, select or discover available models, run deep research, continue an existing browser chat, save chat history, compare provider outputs, or build a multi-turn research workflow."
compatibility: "Requires the browser-tools skill as a sibling checkout, macOS Chrome, Node.js 20+, npm dependencies from package.json, and logged-in browser sessions for selected providers."
---

# AI Chat

AI Chat is a separate skill for browser-authenticated model providers. It depends on Browser Tools for managed Chrome, Profile Sync, safe DevTools connection, background tabs, screenshots, and cleanup.

Use this skill when the task is about using AI provider web sessions as tools, not when the task is normal page browsing.

## Capability map

| Capability | Providers | Notes |
| --- | --- | --- |
| Ask a one-off question | Grok, ChatGPT, Gemini, Perplexity | Uses the logged-in browser session or session cookies from it |
| Continue a conversation | Grok, ChatGPT, Gemini, Perplexity | Save with `--save-conversation`, continue with `--conversation` |
| Select a model | Grok, ChatGPT, Gemini, Perplexity | Use `--model <id-or-alias>` for exact selection or `--task <task>` for task defaults |
| List known or discovered models | Gemini, Perplexity, provider adapters over time | Use `--list-models --json`; add `--verify-models` for live account acceptance checks |
| Deep research | Perplexity | Uses Perplexity `perplexity/deep-research` model and long timeout |
| Save to provider history | Gemini, Perplexity, provider-dependent others | Perplexity defaults to incognito. Gemini defaults to temporary. Use `--save-to-library` to write provider history where supported |
| JSON output with metadata | All | Use `--json` |
| Evidence screenshots | Browser UI providers, Perplexity Finance page if relevant | Capture screenshots after live verification |

## Basic workflow

```bash
# Start managed Chrome through Browser Tools first.
# For Grok, use the default or configured Chrome profile that is logged in to X/Grok.
# For Gemini, start Browser Tools with the configured Gemini task profile.
# Use --sync when current login cookies matter or when the managed browser looked logged out.
# Example: run Browser Tools start with --profile <profile-or-alias> --sync
# Example: run Browser Tools start with --task gemini --sync

# One-off prompt.
scripts/ai-chat.mjs --provider grok --model fast --prompt "Give me three scenarios" --json --evidence

# Save and continue a thread.
scripts/ai-chat.mjs --provider grok --model fast --prompt "Start researching X" --save-conversation research-x --json
scripts/ai-chat.mjs --provider grok --conversation research-x --prompt "Now compare it with Y" --json

# Perplexity deep research.
scripts/ai-chat.mjs --provider perplexity --model perplexity/deep-research --prompt-file /tmp/question.md --timeout 1800 --json

# Model discovery and history control.
scripts/ai-chat.mjs --provider perplexity --list-models --json
scripts/ai-chat.mjs --provider perplexity --list-models --verify-models --verify-model-timeout 180 --json
scripts/ai-chat.mjs --provider gemini --list-models --verify-models --json
scripts/ai-chat.mjs --provider gemini --model flash --prompt "..." --verify-session --json
scripts/ai-chat.mjs --provider gemini --task reasoning --prompt "..." --json
scripts/ai-chat.mjs --provider perplexity --task reasoning --prompt "..." --json
scripts/ai-chat.mjs --provider perplexity --model openai/gpt-5.4-thinking --prompt "..." --save-to-library --json
```

Stop Chrome with the Browser Tools stop command when you started it for the task.

## References

- Read [references/transport.md](references/transport.md) before changing or debugging provider interaction. The architectural rule is network-first, UI-verified.
- Read [references/providers.md](references/providers.md) before choosing a provider or model.
- Read [references/perplexity.md](references/perplexity.md) for Perplexity WebUI API features, model ids, thread continuation, deep research, source filters, and save-to-library behavior.
- Read [references/gemini.md](references/gemini.md) for Gemini WebUI API transport, model headers, current limitations, and verification rules.
- Read [references/evaluation.md](references/evaluation.md) before claiming a provider feature works.

## Operating rules

- Use Browser Tools managed Chrome only. Do not connect to main Chrome or unmanaged DevTools sessions.
- Browser Tools uses a copied profile. If a provider is logged in in normal Chrome but logged out in managed Chrome, stop the managed browser with `--clean`, restart it with the same profile or task plus `--sync`, and verify the provider session before blaming the adapter.
- Grok preflights the X/Grok composer before typing. Fresh, wrong, or logged-out profiles fail with an auth/session error instead of waiting at prompt submission.
- Open any browser tabs in the background with `browser.newPage({ background: true })`.
- Prefer provider APIs and network streams whenever possible. Use browser UI automation to authenticate, trigger, and verify. Read DOM text only as a fallback when structured messages are unavailable.
- For multi-turn work, save a conversation id on the first turn and continue by id. Do not replay the whole chat history unless the provider lacks thread continuation.
- For model selection, prefer a provider adapter that can list or verify available models. If the account gates models, report which models were visible or accepted.
- For live verification, save JSON output and screenshot evidence under `/tmp/...`.
- Final answers should include what was verified, what failed, evidence paths, and remaining uncertainty.
