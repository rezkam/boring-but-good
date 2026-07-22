# Evaluation and Verification

Use deterministic Node tests for helper contracts and gated live tests for browser-authenticated provider behavior. Do not claim a provider feature works from documentation or code inspection alone.

## Required unit tests

Run the focused tests for the behavior you touched, then run the full AI Chat suite before a broad claim.

```bash
cd ai-chat

# Core CLI, browser lifecycle, cache, metadata, conversation records, redaction.
node --test test/ai-chat-module.test.mjs

# Provider parsers and provider-specific request contracts.
node --test test/perplexity-provider.test.mjs
node --test test/chatgpt-provider.test.mjs
node --test test/gemini-api.test.mjs
node --test test/grok-provider.test.mjs

# Cross-provider contracts.
node --test test/provider-model-selection-matrix.test.mjs
node --test test/browser-edge-cases.test.mjs
node --test test/provider-focus.test.mjs
node --test test/public-surface.test.mjs

# Everything.
npm test
```

Minimum unit coverage before claiming a changed provider behavior:

- argument parsing for any new flag
- model alias, task default, unknown model rejection, and selected model metadata
- provider request shape, including Perplexity `--incognito` and history conflicts, research options, file attachments, Spaces, or stream flags when relevant
- conversation save, provider-scoped lookup, attach by URL or id, continuation state round trip, and missing session errors
- secret redaction from stdout JSON, sidecars, cache metadata, stderr, and public provider state
- auth failure messages with practical Browser Tools profile-sync recovery
- fallback metadata that exposes rejected requested models or DOM fallback
- browser ownership safety when the behavior starts, reuses, refuses, or captures evidence through Browser Tools

## Browser lifecycle checks

The automated browser edge harness lives in `test/browser-edge-cases.test.mjs`. It covers:

- one AI Chat owned browser reused across provider switches
- default copied profile use and refusal of old fresh-profile AI Chat browsers
- missing owner token, wrong owner token, unmanaged Chrome, stale managed state, and unavailable debug port
- logged-out or sync-required profile diagnostics without unsafe browser attachment
- screenshot evidence captured only when a provider returns a final URL
- gated live Browser Tools start, reuse, private artifact paths, and cleanup only for the browser owned by the test

Run deterministic checks with:

```bash
cd ai-chat
node --test test/browser-edge-cases.test.mjs
```

Run the live browser harness only when local Browser Tools and Chrome are available and live browser side effects are allowed:

```bash
cd ai-chat
AI_CHAT_LIVE_BROWSER_EDGE_TESTS=1 node --test test/browser-edge-cases.test.mjs
```

The live harness writes only under private temp directories and uses Browser Tools stop with the matching owner token in cleanup. It also checks that a wrong owner token cannot stop the browser.

## Provider model selection matrix

The automated matrix lives in `test/provider-model-selection-matrix.test.mjs`. It covers Perplexity, ChatGPT, Gemini, and Grok with the same contract for every provider.

| Provider | Static assertions | Gated live cases | Actual selected model reporting | Known limitations |
| --- | --- | --- | --- | --- |
| Perplexity | Direct tool aliases, captured GPT-5.6 Terra Thinking toggle mapping, task defaults, unknown model rejection, no UI lifecycle methods, and no DOM source patterns | `perplexity/best`, `openai/gpt-5.6-terra`, `openai/gpt-5.6-terra-thinking`, `perplexity/deep-research`, `perplexity/sonar-2` | Canonical model id plus `provider_state.transport: browser-network-sse`, `network_only: true`, and `dom_processing: false` | Max-tier models are filtered. Account acceptance depends on the current account tier. Deep research is slow |
| ChatGPT | Five public UI profiles, provider-ID continuation, strict quorum, safe final turn, NDJSON, and bounded listing | Deterministic UI/network fixtures only | Observed backend model and effort verify explicit selection; omitted continuation model is reported as preserved/observed | UI drift remains a current-provider risk. Coordinator-only read gates may inspect listing or existing conversations; no automated live write is allowed |
| Gemini | WebUI model aliases like `flash`, `thinking`, `pro`, task defaults for quick, reasoning, and pro, unknown model rejection | `gemini-3-flash`, `gemini-3-flash-thinking`, `gemini-3-pro` | Gemini model id from the WebUI API result | Live checks require Google cookies. Backend error `1052` fallback must be explicit. Deep research is not a stable AI Chat profile |
| Grok | UI label aliases like `default`, `quick`, `think`, task defaults for quick and reasoning, unknown label rejection | `fast` for the current X/Grok session | Verified UI label id in `selected_model` and visible label details in `provider_state` | Grok exposes UI labels only. It does not report a backend model slug. Current X/Grok sessions can expose only `Fast`; run `--list-models --verify-models` before using `Auto` or `Expert`. Live checks create normal Grok conversations. Deep research is not a stable AI Chat profile |

Run the deterministic matrix with:

```bash
cd ai-chat
node --test test/provider-model-selection-matrix.test.mjs
```

Live model checks are skipped unless explicitly enabled. They keep provider responses in process memory and do not write private account output to committed files:

```bash
cd ai-chat
AI_CHAT_LIVE_MODEL_MATRIX=1 AI_CHAT_LIVE_PROVIDERS=perplexity,gemini node --test test/provider-model-selection-matrix.test.mjs
```

Use `AI_CHAT_LIVE_PROVIDERS=perplexity,chatgpt,gemini,grok` only when all accounts are logged in and live prompt side effects are allowed. Failure messages include provider, case kind, requested model, selected model, completion state, and fallback source.

## Gated live provider checks

Live checks must be opt-in because they can create provider conversations, consume quota, expose account-specific model lists, or upload user files.

Recommended environment gates:

| Gate | Purpose |
| --- | --- |
| `AI_CHAT_LIVE_MODEL_MATRIX=1` | Enables live model prompt cases in the matrix |
| `AI_CHAT_LIVE_PROVIDERS=<list>` | Limits live model checks to named providers |
| `AI_CHAT_LIVE_BROWSER_EDGE_TESTS=1` | Enables live Browser Tools lifecycle harness |
| `AI_CHAT_LIVE_PERPLEXITY_RESEARCH=1` | Enables manual Perplexity normal and deep research verification plan from `references/perplexity.md` |

For a provider feature, save commands, stdout JSON, stderr, notes, and screenshots when applicable under:

```text
.agents/artifacts/ai-chat-verify/<provider>/<case>/
```

Suggested files:

- `request.md` or `request.json`
- `response.json` or `response.md`
- `response.json.meta.json` when `--out` is used
- `response.json.raw.txt` when raw text is available
- `stderr.log`
- `screenshot.png` for UI providers with a final URL
- `notes.md` with account limits, selected model, fallback, and cleanup status

Private state and generated artifacts that must not be committed:

- `.agents/artifacts/ai-chat-verify/...`
- `~/.cache/pi-browser-tools/ai-chat-browser.json`
- `~/.cache/pi-browser-tools/ai-chat-conversations/...`
- Browser Tools cache and copied profiles under `~/.cache/pi-browser-tools`
- Query cache when `BROWSER_QUERY_CACHE_DIR` is set
- Provider screenshots, response text, model acceptance lists, account-visible metadata, uploaded files, owner tokens, cookies, and read-write tokens

## Evidence required before claiming a provider works

A claim like "Perplexity deep research works" or "ChatGPT extra-high continuation works" needs this evidence:

1. Unit test command and passing result for the changed parser, routing, metadata, and state behavior.
2. Coordinator-owned read-only live command with exact flags, saved under `.agents/artifacts/ai-chat-verify/<provider>/<case>/`.
3. Non-empty response and `complete` state, or a clearly documented partial state when the feature is resumable.
4. Metadata showing `provider`, `requested_model`, `selected_model`, `model_task` when used, `captured_at`, completion fields, and relevant `provider_state`.
5. Proof that private tokens are redacted from public output. For Perplexity, public output may show `has_read_write_token: true` but not the token.
6. Conversation proof when the feature involves continuation: first run with `--save-conversation`, second run with `--conversation`, and attach by link or id when applicable.
7. Model proof when the feature involves model selection: `--list-models` output, `--verify-models` where supported, or a documented provider limitation where verification is not available.
8. Browser proof when the feature uses Browser Tools: owned startup or reuse, copied profile used instead of a fresh profile, no unmanaged or foreign attachment, and cleanup status if the test started a browser just for verification.
9. Screenshot evidence for UI providers when a final URL exists. For WebUI API providers without a final URL, record `evidence_skipped_reason` and keep JSON plus stderr evidence.
10. Remaining uncertainty, including account tier, quota, provider rollout, fallback use, DOM fallback, or native continuation errors.

## Per-provider live notes

### Perplexity

Use `references/perplexity.md` for the full normal research and deep research plan. Required evidence includes headless-preferred owned browser startup, same-origin network auth, persistent default mapping, explicit Incognito mapping when requested, captured request model identifier, selected model, Thinking state when used, schematized SSE completion, sources or search results, citation mode, saved conversation id, safe provider state, and redaction of read-write token. Normal-request evidence must show `is_incognito: false`, `saved_to_library: true`, `backend_uuid`, and matching canonical thread URLs. Incognito evidence must show `is_incognito: true`, `privacy_state: INCOGNITO`, expiry metadata, and no conflict with provider-history flags. Direct Perplexity thread URL continuation must send only the new turn plus the extracted backend UUID. Static tests must reject Perplexity UI lifecycle methods and DOM access patterns. For file or Space claims, include safe attachment metadata and Space selection metadata. Do not commit uploaded files or Space ids.

### ChatGPT

Use deterministic tests for all writes. A coordinator may gate read-only listing or `--final` on an existing provider ID. Evidence must show strict quorum, provider-ID equality, the safe current turn, and observed model/effort. Current provider UI drift is residual risk.

### Gemini

Show `session_verification.direct_ready`, `session_verification.ui_ready`, selected model, and temporary or saved-to-library behavior. For continuation, record whether native continuation succeeded or `native_continuation_error` plus `local_transcript_fallback` was used.

### Grok

Show visible label verification for the requested label, a final conversation URL, and screenshot evidence when possible. In the current X/Grok session only `Fast` is visible; `Auto` and `Expert` must be reported as unavailable unless `--list-models --verify-models` shows them. Document rate limits or quota fallback. Grok has no backend model slug.

## Skill evals

Prompt-level evals should cover:

- Perplexity model listing, direct tool aliases, research filters, file and Space option routing, streaming, and deep research routing
- saved conversation, follow-up continuation, and attach by link or backend id
- account-specific model discovery with `--verify-models`
- Grok model selection and reasoning or non-reasoning behavior
- ChatGPT request profiles, long-running handoff, strict quorum, provider-ID final retrieval, and safe turn visibility
- Gemini RPC model discovery, temporary/history behavior, session verification, and native continuation fallback
- browser lifecycle refusal and recovery messages
- fallback and failure reporting
