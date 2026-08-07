---
name: ai-chat
description: "Use browser-authenticated AI chat providers through reusable provider adapters and Browser Tools. Use this skill for ChatGPT provider-ID continuation, read-only reattach/watch, conversation listing, model profiles, and final or NDJSON output, as well as Grok, Gemini, and Perplexity browser-session work."
compatibility: "Requires the browser-tools skill as a sibling checkout, macOS Chrome, Node.js 20+, npm dependencies from package.json, and logged-in browser sessions for selected providers."
---

# AI Chat

AI Chat is the shared entry point for browser-authenticated AI providers. It depends on Browser Tools for managed Chrome, Profile Sync, safe DevTools connection, background tabs, screenshots, and stop safety.

Use this skill when the task is about using AI provider web sessions as tools. Do not use it for normal page browsing.

## Browser lifecycle contract

AI Chat owns its normal Browser Tools browser lifecycle.

- Startup: when a provider needs browser access and no healthy AI Chat owned browser exists, AI Chat starts Browser Tools with owner id `ai-chat`, task profile `ai-chat`, and fallback Chrome profile `Default` when no `ai-chat` task profile is configured. Perplexity prefers a headless launch because its only transport is same-origin HTTP and SSE. If the default port is busy and no explicit `--port` was passed, Browser Tools auto-allocates a free port.
- Reuse: later AI Chat commands read the private AI Chat browser state file, validate Browser Tools managed state, owner token, and copied profile presence, then reconnect to the same browser. Grok, ChatGPT, and Perplexity can leave the browser available for later reuse. Gemini can reuse a healthy owned browser at command start, but closes it when the Gemini command finishes.
- Refusal: AI Chat refuses unmanaged Chrome, missing owner tokens, wrong owner tokens, browsers owned by another agent, and live owned browsers with an unavailable debug port. Error messages include the reason and recovery path.
- Stale recovery: stale private state where the process is gone is discarded and a new owned browser is started. Unsafe live state is not killed or replaced.
- Cleanup: Gemini requests and model-listing commands disconnect from CDP and stop the owned browser with its matching owner token on both success and failure. Other providers disconnect from CDP but leave the owned browser open for reuse. Explicit cleanup for those providers must use Browser Tools stop with the matching owner token from the private AI Chat state. Use `--clean` when you need the next run to resync the copied profile.

By default, AI Chat copies and uses Chrome profile `Default`, so normal logged-in browser cookies are available without extra setup. Optional one-time setup when another Chrome profile is the logged-in provider profile: use the Browser Tools config helper to set task profile `ai-chat` to that Chrome profile alias or folder.

## Capability map

| Capability | Providers | Notes |
| --- | --- | --- |
| Ask a new question | Grok, ChatGPT, Gemini, Perplexity | Starts or reuses the AI Chat owned Browser Tools browser when needed |
| Save and continue a conversation | Grok, Gemini, Perplexity | Save with `--save-conversation`, continue with `--conversation` |
| ChatGPT continuation and reattach | ChatGPT | Use a `provider_conversation_id` or clean trusted `https://chatgpt.com/c/<id>` URL; no local alias, save, or attach |
| Select a model | Grok, ChatGPT, Gemini, Perplexity | Use `--model <id-or-alias>` or `--task <task>`. Perplexity also supports `--thinking` when a captured Thinking variant exists |
| List known or discovered models | ChatGPT, Gemini, Perplexity, Grok | `--list-models --json` is read-only. `--verify-models` submits small provider prompts and requires explicit user authorization |
| Deep research | Perplexity | Uses `perplexity/deep-research` and a 3600 second timeout unless `--timeout` is explicit |
| Research filters | Perplexity | `--source-focus`, `--search-focus`, `--time-range`, `--citation-mode`, `--language`, `--timezone` |
| Files, Spaces, streaming | Perplexity | `--file`, `--space-uuid` or `--space`, `--stream` |
| Incognito or provider history | All providers where supported | Normal AI Chat requests are non-Incognito and persist to provider history by default. Use `--incognito` only for a provider-supported private request. `--save-to-library` remains a compatibility flag and conflicts with `--incognito` |
| JSON output with metadata | All | Use `--json` |
| Evidence screenshots | Browser UI providers with a final URL | Perplexity and Gemini API transports usually provide JSON and stderr evidence, not screenshots |

## Examples

Run commands from `ai-chat/`.

```bash
# ChatGPT identities are provider IDs only. New writes use the visible UI; reads use authenticated same-origin network requests.
scripts/ai-chat.mjs --provider chatgpt --model instant --prompt "Give three launch risks" --json
scripts/ai-chat.mjs --provider chatgpt --model pro --prompt-file ./question.md --submit-only --json
scripts/ai-chat.mjs --provider chatgpt --conversation provider-id --prompt "Rank them by mitigation cost" --json
scripts/ai-chat.mjs --provider chatgpt --conversation provider-id --final --json
scripts/ai-chat.mjs --provider chatgpt --conversation provider-id --stream --out <private-output-dir>/chatgpt.ndjson
scripts/ai-chat.mjs --provider chatgpt --list-conversations --conversation-limit 20 --json

# Attach remains available for providers with local state.
scripts/ai-chat.mjs --provider perplexity --attach-conversation 123e4567-e89b-12d3-a456-426614174000 --save-conversation imported-pplx --json

# Continue a Perplexity thread URL returned in a previous response.
scripts/ai-chat.mjs --provider perplexity --conversation https://www.perplexity.ai/search/123e4567-e89b-12d3-a456-426614174000 --prompt "Follow up on the evidence" --json

# Model selection and model discovery.
scripts/ai-chat.mjs --provider chatgpt --list-models --json
scripts/ai-chat.mjs --provider chatgpt --model extra-high --prompt-file ./question.md --json
scripts/ai-chat.mjs --provider gemini --task reasoning --prompt "Explain this tradeoff" --verify-session --json
scripts/ai-chat.mjs --provider gemini --headless --include-google --browser-profile "Browser Profile" --prompt "Search the web for recent evidence" --json
scripts/ai-chat.mjs --provider gemini --headless --include-google --browser-profile "Browser Profile" --temporary false --prompt "Save this chat to provider history" --json
scripts/ai-chat.mjs --provider perplexity --list-models --verify-models --verify-model-timeout 180 --json
scripts/ai-chat.mjs --provider perplexity --model openai/gpt-5.6-terra --thinking --prompt "Find recent evidence" --json

# Perplexity research options with saved continuation state.
scripts/ai-chat.mjs \
  --provider perplexity \
  --prompt-file ./question.md \
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

# Perplexity deep research. Normal requests persist to provider history and use a long timeout by default.
scripts/ai-chat.mjs --provider perplexity --task deep_research --prompt-file ./question.md --json

# Perplexity files, Spaces, streaming progress, and provider library saving.
scripts/ai-chat.mjs \
  --provider perplexity \
  --prompt "Summarize this file for the project Space" \
  --file ./report.pdf \
  --space-uuid 123e4567-e89b-12d3-a456-426614174000 \
  --stream \
  --save-to-library \
  --json
```

## Provider notes

- Perplexity has one transport, `browser-network-sse`. It runs authenticated same-origin requests in a headless-preferred managed browser, parses captured schematized SSE block patches, supports model and Thinking variants, persistent-by-default history, explicit Incognito, research filters, deep research, files, Spaces, streaming, and backend UUID continuation. New responses expose the backend UUID and canonical `/search/<uuid>` thread URL. It never extracts browser cookies and has no rendered HTML, element, or DOM fallback path.
- ChatGPT uses visible UI only for model selection, composer input, and a single submission. Network observation and authenticated same-origin reads provide progress, listing, and final output. `--submit-only` returns a real provider ID and leaves the managed browser alive. `--stream` writes NDJSON to stdout and ends with exactly one `complete`, `timeout`, or `error` event. It has no local ChatGPT session state, DOM answer fallback, request rewrite, or automated live write verification.
- Gemini uses WebUI API cookies from the AI Chat owned browser by default. It can fall back to an explicit Chrome profile cookie source. For a fully headless Google-authenticated browser, use `--headless --include-google --browser-profile "<profile folder>"`. Including Google identity reintroduces the source-session logout risk that Browser Tools normally avoids, so use it only for an intentional Google workflow. Gemini chats are temporary by default. In a headless managed-browser session, use `--temporary false` to retain the chat in provider history; `--save-to-library` remains a compatibility alias. The exposed Gemini modes are `gemini-3.6-flash` and `gemini-3.6-flash-extended-thinking`. In headless managed-browser mode, Gemini submits through the authenticated page and parses the complete `StreamGenerate` network response instead of scraping rendered answer text. After the Gemini command completes or fails, AI Chat stops the owned browser with its matching owner token. Native continuation can fail with backend error `1097`; metadata must show that and the local transcript fallback.
- Grok uses browser UI labels and preflights the X/Grok composer before typing. It can verify visible labels, but not a backend model slug. In the current X/Grok app `Fast` is the reliable default; `Auto` or `Expert` require explicit user-authorized visible-label verification before selection.

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
- For ChatGPT, continue only with `provider_conversation_id` or trusted `https://chatgpt.com/c/<id>`. `--conversation <id>` without a prompt is read-only; temporary chats reject detached retrieval and continuation. Other providers retain local-state behavior where documented.
- For model selection, use `--list-models --json` for read-only discovery. Perplexity and Gemini `--verify-models` submit small provider prompts, so run them only after the user explicitly authorizes those writes. Never include them in automated tests or evals. Grok visible-label checks are read-only only when they inspect an existing UI state.
- Read-only live verification must use a user-supplied private output directory. Never commit provider responses, account metadata, credentials, or tokens.
- Final answers should include what was verified, what failed, evidence paths, and remaining uncertainty.
