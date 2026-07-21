---
name: ai-chat
description: "Use browser-authenticated AI chat providers through reusable provider adapters and Browser Tools. Use this skill whenever the user asks to query Grok, ChatGPT, Gemini, or Perplexity through their logged-in browser session, select or discover available models, run deep research, continue an existing browser chat, save chat history, compare provider outputs, or build a multi-turn research workflow."
compatibility: "Requires the browser-tools skill as a sibling checkout, macOS Chrome, Node.js 20+, npm dependencies from package.json, and logged-in browser sessions for selected providers."
---

# AI Chat

AI Chat is the shared entry point for browser-authenticated AI providers. It depends on Browser Tools for managed Chrome, Profile Sync, safe DevTools connection, background tabs, screenshots, and stop safety.

Use this skill when the task is about using AI provider web sessions as tools. Do not use it for normal page browsing.

## Browser lifecycle contract

AI Chat owns its normal Browser Tools browser lifecycle.

- Startup: when a provider needs browser access and no healthy AI Chat owned browser exists, AI Chat starts Browser Tools with owner id `ai-chat`, task profile `ai-chat`, and fallback Chrome profile `Default` when no `ai-chat` task profile is configured. Perplexity prefers a headless launch because its only transport is same-origin HTTP and SSE. If the default port is busy and no explicit `--port` was passed, Browser Tools auto-allocates a free port.
- Reuse: later AI Chat commands read the private state file `~/.cache/pi-browser-tools/ai-chat-browser.json`, validate Browser Tools managed state, owner token, and copied profile presence, then reconnect to the same browser. The same browser can be reused across Grok, ChatGPT, Gemini, and Perplexity.
- Refusal: AI Chat refuses unmanaged Chrome, missing owner tokens, wrong owner tokens, browsers owned by another agent, and live owned browsers with an unavailable debug port. Error messages include the reason and recovery path.
- Stale recovery: stale private state where the process is gone is discarded and a new owned browser is started. Unsafe live state is not killed or replaced.
- Cleanup: successful requests disconnect from CDP but leave the owned browser open for reuse. Cleanup is explicit and must use Browser Tools stop with the matching owner token from the private AI Chat state. Use `--clean` when you need the next run to resync the copied profile.

By default, AI Chat copies and uses Chrome profile `Default`, so normal logged-in browser cookies are available without extra setup. Optional one-time setup when another Chrome profile is the logged-in provider profile: use the Browser Tools config helper to set task profile `ai-chat` to that Chrome profile alias or folder.

## Capability map

| Capability | Providers | Notes |
| --- | --- | --- |
| Ask a new question | Grok, ChatGPT, Gemini, Perplexity | Starts or reuses the AI Chat owned Browser Tools browser when needed |
| Save and continue a conversation | Grok, ChatGPT, Gemini, Perplexity | Save with `--save-conversation`, continue with `--conversation` |
| Attach an existing provider chat | Grok, ChatGPT, Gemini, Perplexity | Use `--attach-conversation <provider-id-or-url> --save-conversation <local-id>` |
| Select a model | Grok, ChatGPT, Gemini, Perplexity | Use `--model <id-or-alias>` or `--task <task>`. Perplexity also supports `--thinking` when a captured Thinking variant exists |
| List known or discovered models | ChatGPT, Gemini, Perplexity, Grok | Use `--list-models --json`; add `--verify-models` where supported |
| Deep research | Perplexity | Uses `perplexity/deep-research` and a 3600 second timeout unless `--timeout` is explicit |
| Research filters | Perplexity | `--source-focus`, `--search-focus`, `--time-range`, `--citation-mode`, `--language`, `--timezone` |
| Files, Spaces, streaming | Perplexity | `--file`, `--space-uuid` or `--space`, `--stream` |
| Incognito or provider history | Perplexity, Gemini where applicable | Perplexity defaults to incognito and also accepts explicit `--incognito`; use `--save-to-library` for persistent history. The two flags conflict |
| JSON output with metadata | All | Use `--json` |
| Evidence screenshots | Browser UI providers with a final URL | Perplexity and Gemini API transports usually provide JSON and stderr evidence, not screenshots |

## Examples

Run commands from `ai-chat/`.

```bash
# New chat. AI Chat starts or reuses its owned Browser Tools browser.
scripts/ai-chat.mjs --provider chatgpt --model instant --prompt "Give three launch risks" --json --save-conversation launch-risks

# Continue a saved chat by provider-scoped local id.
scripts/ai-chat.mjs --provider chatgpt --conversation launch-risks --prompt "Rank them by mitigation cost" --json --save-conversation launch-risks

# Recheck a saved ChatGPT request that timed out, without sending a new prompt.
scripts/ai-chat.mjs --provider chatgpt --conversation launch-risks --save-conversation launch-risks --json

# Attach an existing provider link or backend id to a reusable local session.
scripts/ai-chat.mjs --provider chatgpt --attach-conversation https://chatgpt.com/c/example-id --save-conversation imported-chatgpt --json
scripts/ai-chat.mjs --provider perplexity --attach-conversation 123e4567-e89b-12d3-a456-426614174000 --save-conversation imported-pplx --json

# Model selection and model discovery.
scripts/ai-chat.mjs --provider chatgpt --list-models --json
scripts/ai-chat.mjs --provider chatgpt --model extra-high --prompt-file /tmp/question.md --json
scripts/ai-chat.mjs --provider gemini --task reasoning --prompt "Explain this tradeoff" --verify-session --json
scripts/ai-chat.mjs --provider perplexity --list-models --verify-models --verify-model-timeout 180 --json
scripts/ai-chat.mjs --provider perplexity --model openai/gpt-5.6-terra --thinking --prompt "Find recent evidence" --json

# Perplexity research options with saved continuation state.
scripts/ai-chat.mjs \
  --provider perplexity \
  --prompt-file /tmp/question.md \
  --source-focus all \
  --search-focus web \
  --time-range week \
  --citation-mode markdown \
  --language en-US \
  --timezone UTC \
  --save-conversation policy-research \
  --json

# Explicit Perplexity Incognito session. The request is not saved to history and expires after 24 hours.
scripts/ai-chat.mjs --provider perplexity --incognito --prompt "Answer this privately" --json

# Perplexity deep research. Uses a long timeout by default.
scripts/ai-chat.mjs --provider perplexity --task deep_research --prompt-file /tmp/question.md --json

# Perplexity files, Spaces, streaming progress, and provider library saving.
scripts/ai-chat.mjs \
  --provider perplexity \
  --prompt "Summarize this file for the project Space" \
  --file /tmp/report.pdf \
  --space-uuid 123e4567-e89b-12d3-a456-426614174000 \
  --stream \
  --save-to-library \
  --json
```

## Provider notes

- Perplexity has one transport, `browser-network-sse`. It runs authenticated same-origin requests in a headless-preferred managed browser, parses captured schematized SSE block patches, supports model and Thinking variants, explicit Incognito, research filters, deep research, files, Spaces, streaming, and backend UUID continuation. It never extracts browser cookies and has no rendered HTML, element, or DOM fallback path.
- ChatGPT long-running requests use network SSE and WebSocket state first. Metadata reports stream handoff, timeout, partial or empty response, resumed stream, assistant turn completion, and DOM fallback when fallback is used.
- Gemini uses WebUI API cookies from the AI Chat owned browser by default. It can fall back to an explicit Chrome profile cookie source. Native continuation can fail with backend error `1097`; metadata must show that and the local transcript fallback.
- Grok uses browser UI labels and preflights the X/Grok composer before typing. It can verify visible labels, but not a backend model slug. In the current X/Grok app `Fast` is the reliable default; check `--list-models --verify-models` before selecting `Auto` or `Expert`.

## References

- Read [references/orchestration.md](references/orchestration.md) for the provider boundary, owned browser lifecycle, private state contract, and Perplexity parity scope.
- Read [references/transport.md](references/transport.md) before changing or debugging provider interaction. The rule is network-first, UI-verified.
- Read [references/providers.md](references/providers.md) before choosing a provider or model.
- Read [references/perplexity.md](references/perplexity.md) for Perplexity WebUI API features, model ids, thread continuation, files, Spaces, streaming, deep research, source filters, and save-to-library behavior.
- Read [references/gemini.md](references/gemini.md) for Gemini WebUI API transport, model headers, current limitations, and verification rules.
- Read [references/evaluation.md](references/evaluation.md) before claiming a provider feature works.

## Operating rules

- Use Browser Tools managed Chrome only. Do not connect to main Chrome or unmanaged DevTools sessions.
- AI Chat starts and reuses its own Browser Tools browser. Do not manually attach it to another agent browser. Do not stop a browser unless Browser Tools owner-token checks prove it is the AI Chat owned browser.
- Browser Tools uses a copied profile. AI Chat defaults to copied Chrome profile `Default`, or the configured `ai-chat` task profile when set. If a provider is logged in in normal Chrome but logged out in managed Chrome, cleanly stop the AI Chat owned browser, then rerun so Browser Tools resyncs the copied profile.
- Perplexity auth stays inside managed Chrome through browser `fetch` with credentials. AI Chat never reads the Perplexity cookie, ignores `PERPLEXITY_SESSION_TOKEN` and `PPLX_SESSION_TOKEN`, and reports missing or expired auth with login and profile-sync recovery guidance.
- Grok preflights the X/Grok composer before typing. Fresh, wrong, or logged-out profiles fail with an auth/session error before prompt submission.
- Open any browser tabs in the background with `browser.newPage({ background: true })`.
- Prefer provider APIs and network streams whenever possible. Perplexity is strictly network-only and must not add UI automation or DOM parsing. Other UI providers can use browser interaction to authenticate, trigger, and verify; any DOM fallback must be explicit in metadata.
- For multi-turn work, save a conversation id on the first turn and continue by id. Attach existing provider links or backend ids with `--attach-conversation` and `--save-conversation`. For ChatGPT timeouts, run `--conversation <id> --save-conversation <id>` without a prompt to recheck the same saved turn. Do not replay the whole chat history unless the provider lacks backend continuation.
- For model selection, prefer a provider adapter that can list or verify available models. If the account gates models, report which models were visible or accepted. Fallbacks must be explicit in metadata and must not hide a rejected requested model.
- For live verification, save JSON output, stderr, notes, and screenshots when applicable under `/tmp/ai-chat-verify/...`. Never commit provider responses, model acceptance lists, screenshots, account-visible metadata, conversation records, owner tokens, or read-write tokens.
- Final answers should include what was verified, what failed, evidence paths, and remaining uncertainty.
