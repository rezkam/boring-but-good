# AI Chat Resource Helper

Use `scripts/ai-chat.mjs` when the user wants an answer from a browser-authenticated AI provider.

The AI Chat Module is the single prompt lifecycle for Grok, ChatGPT, Gemini, and Perplexity. It owns CLI parsing, browser startup and reuse, local conversation records, fallback policy, cache keys, metadata, output files, sidecars, evidence capture, and final JSON shape. Provider adapters own provider-specific auth checks, model resolution, request payloads, streams, UI actions, and safe provider state.

## Browser lifecycle

Normal AI Chat commands do not require a manual Browser Tools start.

1. If a provider needs browser access, AI Chat reads `~/.cache/pi-browser-tools/ai-chat-browser.json` or `AI_CHAT_BROWSER_STATE_FILE` when set.
2. If the saved browser is healthy, Browser Tools managed, and owned by `ai-chat`, AI Chat reconnects with the saved owner token.
3. If no usable owned browser exists, AI Chat starts Browser Tools with owner id `ai-chat`, task profile `ai-chat`, fallback Chrome profile `Default` when no task profile is configured, and auto port allocation unless `--port` is explicit.
4. After a successful request, AI Chat disconnects from CDP but leaves Chrome running for reuse.
5. Explicit cleanup must use Browser Tools stop with the matching owner token. Use `--clean` to remove the copied profile when auth state is stale and a fresh sync is needed.

AI Chat refuses to attach to unmanaged Chrome, another owner, missing owner token, wrong owner token, and a live owned browser whose debug port cannot be reached. Stale private state where the process is gone is removed and replaced by a new owned browser.

AI Chat uses Chrome profile `Default` by default. Configure the Browser Tools task profile once only when another Chrome profile has the provider logins:

```bash
../browser-tools/scripts/config.mjs task-profile set ai-chat --profile "<profile-alias-or-folder>"
```

## Basic usage

```bash
# New chat.
scripts/ai-chat.mjs --provider grok --model fast --prompt "What is Brent crude today?" --json

# Save a browser conversation under a stable id, then continue it later.
scripts/ai-chat.mjs --provider chatgpt --model instant --prompt "Start researching X" --save-conversation research-x --json
scripts/ai-chat.mjs --provider chatgpt --conversation research-x --prompt "Now compare it with Y" --save-conversation research-x --json

# Attach an existing provider link or backend id to a local AI Chat session.
scripts/ai-chat.mjs --provider chatgpt --attach-conversation https://chatgpt.com/c/example-id --save-conversation imported-chatgpt --json
scripts/ai-chat.mjs --provider perplexity --attach-conversation 123e4567-e89b-12d3-a456-426614174000 --save-conversation imported-pplx --json

# Recheck a saved ChatGPT request after a timeout without sending a new prompt.
scripts/ai-chat.mjs --provider chatgpt --conversation research-x --save-conversation research-x --json

# Model discovery and selection.
scripts/ai-chat.mjs --provider chatgpt --list-models --json
scripts/ai-chat.mjs --provider gemini --list-models --verify-models --json
scripts/ai-chat.mjs --provider perplexity --list-models --verify-models --verify-model-timeout 180 --json
scripts/ai-chat.mjs --provider perplexity --model openai/gpt-5.6-terra --thinking --prompt-file "$HOME/.agents/questions/q.txt" --json
scripts/ai-chat.mjs --provider gemini --task reasoning --prompt "Explain this" --verify-session --json

# Perplexity research and deep research.
scripts/ai-chat.mjs --provider perplexity --prompt-file /tmp/q.txt --source-focus all --time-range week --citation-mode markdown --language en-US --timezone UTC --json
scripts/ai-chat.mjs --provider perplexity --task deep_research --prompt-file /tmp/q.txt --json

# Perplexity files, Spaces, and streaming.
scripts/ai-chat.mjs --provider perplexity --prompt "Analyze this file" --file /tmp/report.pdf --space-uuid 123e4567-e89b-12d3-a456-426614174000 --stream --json
```

## Options

| Flag | Description |
| --- | --- |
| `--provider <name>` | `grok`, `gemini`, `chatgpt`, or `perplexity` |
| `--prompt <text>` | Inline prompt text |
| `--prompt-file <path>` | Read prompt from file |
| `--model <name>` | Provider-specific model id, request profile, UI label, or alias |
| `--task <task>` | Provider task default, such as `quick`, `reasoning`, `coding`, `deep_research`, or `pro` |
| `--thinking` | Enable thinking mode where supported by a UI adapter |
| `--out <file>` | Save response to file. Sidecars are written as `<out>.meta.json` and `<out>.raw.txt` when available |
| `--port <n>` | Preferred Chrome debug port, default `9222`. Without an explicit port, Browser Tools may auto-allocate another port |
| `--timeout <seconds>` | Max wait, default `300`. Perplexity deep research uses at least `3600` unless this flag is explicit |
| `--json` | Output JSON with metadata and `response` |
| `--stream` | Enable provider streaming progress where supported. Perplexity writes deltas to stderr and still emits final structured output |
| `--list-models` | List provider models, defaults, task mappings, and history policy |
| `--verify-models` | With `--list-models`, run live account acceptance checks where supported |
| `--verify-model-timeout <seconds>` | Timeout per model verification, default `90` |
| `--verify-session` or `--auth-check` | Ask supporting providers to validate the current browser-authenticated session |
| `--source-focus <value>` | Perplexity source focus, `web`, `academic`, `social`, `finance`, or `all`; repeat it or use commas |
| `--search-focus <value>` | Perplexity search focus, `web` or `writing` |
| `--time-range <value>` | Perplexity recency, `all`, `day`, `week`, `month`, or `year` |
| `--citation-mode <value>` | Perplexity citations, `clean`, `markdown`, or `default` |
| `--language <tag>` | Perplexity response language tag, default `en-US` |
| `--timezone <zone>` | Perplexity timezone passed to the WebUI API |
| `--file <path>` | Perplexity local attachment. Repeatable. Metadata is safe, file contents are not echoed into metadata |
| `--space-uuid <uuid>` or `--space <uuid>` | Perplexity Space identifier supplied by the user |
| `--save-to-library` | Save to provider history where supported. Default is incognito or temporary for Perplexity and Gemini |
| `--cookie-source <source>` | Gemini cookie source, `managed-browser` by default or `chrome-profile` for the direct fallback |
| `--chrome-profile <name>` | Gemini direct profile fallback. Prefer Chrome profile `Default` or Browser Tools task profile `ai-chat` for normal AI Chat runs |
| `--continue` | Continue the active provider conversation tab when the current URL is already a conversation |
| `--conversation <id-or-url>` | Open a saved browser conversation id or direct conversation URL before sending the prompt. With ChatGPT, omit the prompt to recheck a saved timed-out turn |
| `--save-conversation <id>` | Save the final provider continuation state under a provider-scoped id in `~/.cache/pi-browser-tools/ai-chat-conversations` |
| `--attach-conversation <provider-id-or-url>` | Attach an existing provider conversation id or link to `--save-conversation <id>` without replaying transcript history |
| `--include-conversation` | Include `conversation_messages` in JSON output. Use only when downstream code needs full local transcript context |
| `--evidence` or `--capture-evidence` | Capture screenshot evidence for the final provider URL and include `evidence_path` in metadata |
| `--evidence-path <file>` | Write screenshot evidence to a specific file, also enables evidence capture |
| `--evidence-full-page` | Capture full-page screenshot evidence instead of the visible viewport |

## Conversation continuity

Use `--save-conversation <id>` when a task is expected to need follow-ups across agent turns. The helper stores a JSON record with the provider, requested model, final URL or backend provider state, local messages, capture time, and response size. Use `--conversation <id>` later to continue that thread and send only the new user prompt when the provider supports backend continuation.

Records live in `~/.cache/pi-browser-tools/ai-chat-conversations/<provider>/<id>.json` with local-user permissions. Provider-scoped ids are separate, so `grok:research` and `chatgpt:research` are different records.

Rules:

- Use stable ids such as `market-research`, `project-plan`, or a task id.
- Use a direct URL with `--conversation https://...` when the user gives a provider conversation link for one run.
- Use `--attach-conversation <provider-id-or-url> --save-conversation <id>` when the link or backend id should become a reusable local AI Chat session.
- Use `--continue` only for short same-tab flows. Prefer saved conversation ids for reliable multi-turn work.
- For ChatGPT long-running turns that time out, rerun `--conversation <id> --save-conversation <id>` without `--prompt` to recheck the same provider conversation and update the saved record.
- Perplexity stores backend UUID and a private read-write token in the local record when available. Normal output only reports redacted presence, for example `has_read_write_token: true`.
- Gemini attempts native continuation first. If Gemini rejects stored ids, metadata shows `native_continuation_error` and `local_transcript_fallback`.
- The final JSON metadata includes `conversation_id`, `conversation_url`, and `conversation_record_path` when applicable.

## Provider notes

### Grok

- URL: `x.com/i/grok`.
- Models are UI labels. `fast` is the reliable default for the current X/Grok app. `auto` and `expert` stay account/UI dependent and must be checked with `--list-models --verify-models` before use.
- Grok uses the AI Chat owned Browser Tools browser and preflights the Grok composer before typing. Fresh, wrong, or logged-out profiles fail with an auth/session error before prompt submission.
- Model selection is verified through visible UI labels. Grok does not expose a backend model slug.
- If quota or account gating is hit, fallback attempts are reported in metadata and must not hide the rejected requested model.

### Gemini

- URL: `gemini.google.com`.
- Default cookie source is the Browser Tools managed browser that AI Chat owns.
- Use `--cookie-source chrome-profile --chrome-profile <profile-folder>` only as an explicit direct profile fallback.
- `--list-models` uses Gemini account RPC discovery when cookies work.
- Verified account models from the managed Gemini-capable browser include `gemini-3-flash`, `gemini-3-flash-thinking`, and `gemini-3-pro`.
- Default chats are temporary. Use `--save-to-library` when the user wants Gemini history.
- Native Gemini continuation can return backend error `1097`; the helper reports `native_continuation_error` and uses local transcript fallback.
- Model unavailable error `1052` can fall back only when the adapter reports that fallback in metadata.

### Perplexity

- URL: `perplexity.ai`.
- Uses a headless-preferred managed browser and same-origin `fetch` with browser credentials. The adapter never reads the cookie, and environment token variables are ignored.
- Perplexity has no rendered HTML parser, element interaction, UI transport, or DOM fallback.
- `--list-models` exposes the network-contract registry with Thinking levels, tiers, modes, aliases, and direct tool aliases. Max-tier models are filtered.
- `--verify-models` checks current-account acceptance through incognito WebUI API prompts.
- Default chats are incognito. Use `--save-to-library` when the user wants Perplexity library history or when a Space requires non-incognito behavior.
- Research options are available with `--source-focus`, `--search-focus`, `--time-range`, `--citation-mode`, `--language`, and `--timezone`.
- File analysis uses repeatable `--file` and uploads validated local files through the WebUI upload flow. Metadata includes filename, MIME type, size, image flag, status, and URL presence, not file contents.
- Spaces use `--space-uuid` or `--space` with a user-provided UUID and make the request non-incognito.
- `--stream` applies captured schematized SSE block patches, emits incremental answer deltas to stderr, and waits for the completed stream event before returning final JSON.
- Deep research uses `perplexity/deep-research` through the WebUI API and gets a 3600 second timeout unless `--timeout` is explicit.
- JSON output includes `requested_model`, `selected_model`, `complete`, `provider_state`, `sources`, `search_results`, `captured_at`, and `conversation_id` when applicable.

### ChatGPT

- URL: `chatgpt.com`.
- Models: `instant`, `extra-high`, `pro-extended`, and aliases such as `thinking` and `reasoning` for `extra-high`.
- Long-running requests use network SSE and WebSocket state first. Provider metadata reports `stream_state.status`, `partial`, `timeout`, `empty_response`, `handed_off`, `resumed_stream`, `assistant_turn_complete`, and `dom_fallback`.
- DOM text is only a fallback when network state is unavailable, and the fallback is marked with `provider_state.dom_fallback=true`.
- Request profiles are applied by authenticated backend payload rewrite and verified through observed stream metadata where available. There is no public ChatGPT model list API in this adapter.
- The old `medium` and `high` `thinking_effort` payloads are not exposed because the current ChatGPT web backend rejects them with HTTP 422.

## Module shape

| File | Role |
| --- | --- |
| `scripts/ai-chat.mjs` | Thin CLI entry point |
| `scripts/ai-chat/module.mjs` | Prompt lifecycle, browser lifecycle, conversation records, fallback, cache, metadata, output, evidence |
| `scripts/ai-chat/providers/` | Provider adapters for Grok, ChatGPT, Gemini, and Perplexity |
| `test/provider-model-selection-matrix.test.mjs` | Cross-provider model selection contract |
| `test/browser-edge-cases.test.mjs` | Browser lifecycle, ownership, profile auth diagnostics, and evidence harness |

## Completion detection

The helper does not use only fixed sleeps. The AI Chat Module submits the prompt and delegates provider-specific completion to the adapter. Adapters can parse WebUI APIs, SSE, WebSocket messages, network CDP events, visible UI labels, and provider-specific DOM fallback. Perplexity is the strict exception: it completes only from SSE network state and has no DOM path. When another provider uses DOM fallback, provider metadata must make that visible.

## Output files and private state

When `--out` is used, the helper writes:

- the requested output file
- `<out>.meta.json` with metadata
- `<out>.raw.txt` when raw visible text or raw stream text is available

AI Chat writes `--out` files and their metadata and raw-text sidecars with owner-only mode `0600`, including overwrites. Use `--json` when downstream code needs metadata and response in one JSON document. When `--evidence` or `--evidence-path` is used, metadata includes `evidence_path` and `evidence_url` when a screenshot can be captured. If the provider transport has no final browser URL, metadata includes `evidence_skipped_reason`.

Private local state:

- AI Chat browser state: `~/.cache/pi-browser-tools/ai-chat-browser.json`. Contains the Browser Tools owner token and must not be committed or printed.
- Conversation records: `~/.cache/pi-browser-tools/ai-chat-conversations/<provider>/<id>.json`. May contain private provider continuation tokens.
- Query cache: only used when `BROWSER_QUERY_CACHE_DIR` is set. Keep it outside the repo because it can contain prompts, responses, and metadata.
