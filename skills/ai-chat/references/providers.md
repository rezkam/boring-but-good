# Provider Routing

Use `scripts/ai-chat.mjs` for all browser-authenticated AI chat providers. AI Chat owns browser lifecycle, local conversation records, cache shape, output metadata, and evidence. Provider adapters own provider-specific auth, model resolution, request execution, stream parsing, and safe provider state.

## Provider table

| Provider | Transport | Model strategy | Continuation strategy | Main limitations |
| --- | --- | --- | --- | --- |
| `perplexity` | Headless-preferred same-origin browser fetch to `/rest/sse/perplexity_ask`, with captured schematized SSE block-patch parsing | Network-contract registry, direct tool aliases, task defaults, captured Thinking variants, and Max-tier filtering. `--verify-models` submits prompts only with explicit user authorization | Backend UUID plus private read-write token in local conversation record | Credentials stay inside managed Chrome. No UI or DOM fallback. Account tier decides accepted models. Responses usually have no final URL for screenshots |
| `chatgpt` | Visible UI opens `Advanced`, selects model and effort separately, and submits once; CDP observation plus authenticated same-origin reads provide progress, final state, and listing | Exactly `instant`, `medium`, `high`, `extra-high`, and `pro`; observed backend model and effort verify explicit selection | Provider conversation ID or trusted `/c/<id>` URL only, with zero local ChatGPT state | Continuation requires a baseline detail read and a changed current branch. Temporary chats reject detached read/continuation. Listing is read-only; automated writes are prohibited |
| `gemini` | WebUI API through managed-browser same-origin requests | Read-only account model discovery through Gemini `otAQ7b` RPC, fallback known headers, aliases, tiers, thinking flags, defaults, and task suggestions. `--verify-models` submits prompts only with explicit user authorization | Gemini metadata continuation first, explicit `1097` error reporting, then local transcript fallback | Model fallback on `1052` must be explicit. Deep research is not a stable AI Chat profile |
| `grok` | Browser UI with X/Grok composer auth preflight and partial network progress tracking | UI labels are account/UI dependent. `fast` is the reliable default in the current X/Grok app. Existing visible labels can be inspected read-only | Browser conversation URL | No backend model slug. Response text is DOM-derived with network completion heuristics. Provider writes require an explicit user invocation |

## Common commands

```bash
# Read-only model listings.
scripts/ai-chat.mjs --provider perplexity --list-models --json
scripts/ai-chat.mjs --provider gemini --list-models --json
scripts/ai-chat.mjs --provider chatgpt --list-models --json
scripts/ai-chat.mjs --provider grok --list-models --json

# Perplexity and Gemini --verify-models submit small provider prompts. Run only
# after explicit user authorization and never from automated tests or evals.

# Select models directly or through task defaults.
scripts/ai-chat.mjs --provider grok --model fast --prompt "..." --json
scripts/ai-chat.mjs --provider chatgpt --model extra-high --prompt-file ./question.md --json
scripts/ai-chat.mjs --provider gemini --task reasoning --prompt "..." --json
scripts/ai-chat.mjs --provider perplexity --task coding --prompt "..." --json

# Perplexity provider-specific features.
scripts/ai-chat.mjs --provider perplexity --task deep_research --prompt-file ./question.md --json
scripts/ai-chat.mjs --provider perplexity --prompt "Analyze this file" --file ./report.pdf --stream --json
scripts/ai-chat.mjs --provider perplexity --prompt-file ./question.md --source-focus all --time-range week --citation-mode markdown --json
```

## Conversation ids

Saved conversation ids are provider scoped:

- `perplexity:research-x` stores Perplexity backend UUID and private read-write token when available.
- `grok:research-x` stores a Grok conversation URL.
- ChatGPT accepts provider conversation IDs or trusted ChatGPT conversation URLs directly and never creates local conversation records.
- `gemini:research-x` stores Gemini provider metadata and a local transcript fallback.

Records live in private AI Chat conversation storage. Records can contain private provider continuation tokens. Normal JSON output redacts secrets and reports presence fields such as `has_read_write_token`.

Attach existing provider conversations without replaying transcript history:

```bash
scripts/ai-chat.mjs --provider chatgpt --conversation provider-id --prompt "Follow up" --json
scripts/ai-chat.mjs --provider grok --attach-conversation https://x.com/i/grok?conversation=example-id --save-conversation imported-grok --json
scripts/ai-chat.mjs --provider perplexity --attach-conversation 123e4567-e89b-12d3-a456-426614174000 --save-conversation imported-pplx --json
scripts/ai-chat.mjs --provider gemini --attach-conversation https://gemini.google.com/app/example-id --save-conversation imported-gemini --json
```

Continue a saved conversation by sending only the new user turn when the provider has backend state:

```bash
scripts/ai-chat.mjs --provider perplexity --conversation imported-pplx --prompt "Continue with only the recent policy changes" --save-conversation imported-pplx --json
```

Recheck a saved ChatGPT timeout without sending a new prompt:

```bash
scripts/ai-chat.mjs --provider chatgpt --conversation provider-id --final --json
```

## Provider-specific behavior

### Perplexity parity

Perplexity in AI Chat has one browser-authenticated network path:

- New Perplexity-owned sessions prefer a headless managed Chrome using the `ai-chat` task profile or fallback profile `Default`.
- Auth uses browser `fetch` with credentials inside managed Chrome. The adapter never reads the cookie and ignores `PERPLEXITY_SESSION_TOKEN` and `PPLX_SESSION_TOKEN`.
- Rendered HTML parsing, element interaction, and DOM fallback are not supported.
- Model ids, direct tool aliases, task defaults, captured Thinking variants, tiers, and provider families come from the network-contract registry. Max-tier models are filtered.
- `--verify-models` sends tiny Incognito WebUI API prompts and reports accepted and rejected model ids for the current account. It requires explicit user authorization and is never part of automated tests or evals.
- Normal asks persist to provider history by default. Explicit Incognito, deep research, source focus, search focus, recency, citation mode, language, timezone, file attachments, Spaces, streaming, save-to-library compatibility, and multi-turn continuation use one output contract and one network transport.
- The captured Incognito control maps to `params.is_incognito=true`; the terminal SSE reports `privacy_state`, expiry, reconnectability, thread access, and the backend UUID. AI Chat exposes the safe UUID plus canonical `/search/<uuid>` thread URL, while retaining any read-write token only in a saved local conversation. `--incognito` conflicts with `--save-to-library` and Spaces.
- Continuation secrets stay in the private local conversation record. Public output exposes redacted state only.

Known limits:

- Account acceptance can change by plan, region, or provider rollout. Do not claim a model works for all accounts from one live run.
- Deep research is slow and must stay behind explicit live gates.
- Perplexity WebUI API runs usually return `final_url: null`, so screenshot evidence may be skipped with `missing-final-url`. JSON, stderr, and saved output are the normal evidence.
- File uploads are limited to validated local files, at most 30 files, and 50 MB per file.

### ChatGPT long-running continuation

ChatGPT is optimized for long-running reasoning turns:

- The UI is used to create valid authenticated request context.
- The visible picker applies a selected profile and observed network metadata verifies model and effort.
- The adapter parses SSE, stream handoff events, WebSocket catchups, assistant text deltas, resolved model metadata, and completion state.
- Metadata distinguishes stream closure from assistant turn completion. A stream `[DONE]` is not treated as final if the turn handed off to another stream.
- Timeout, partial, empty response, handoff, resumed stream, and strict terminal quorum are visible in `provider_state.stream_state`.
- `--conversation <provider-id> --final --json` is a read-only current-turn retrieval. NDJSON watch/reattach includes the same safe full `turn`; `--out` mirrors NDJSON to an explicit private `0600` transcript with no sidecars.

Known limits:

- Provider writes occur only through the visible managed-browser composer and send control.
- `--verify-models` returns the static request profile list and does not perform a direct model acceptance prompt.
- Deep research is not exposed as a stable AI Chat request profile.

### Gemini

Gemini uses the WebUI API path and live account discovery where possible:

- Default auth source is the AI Chat owned Browser Tools browser. Every provider stops that owned browser with its matching owner token after completion or failure.
- Explicit fallback is `--cookie-source chrome-profile --chrome-profile <profile-folder>`.
- `--verify-session` reports direct API readiness and browser UI readiness separately.
- Exposed browser modes are `gemini-3.6-flash` and `gemini-3.6-flash-extended-thinking`.
- Default chats are temporary. In headless managed-browser mode, `--temporary false` requests provider history; `--save-to-library` remains a compatibility alias. Direct replay rejects persistence because it cannot verify history mode.
- Native continuation is attempted first. If backend ids fail, metadata reports `native_continuation_error` and `local_transcript_fallback`.

Known limits:

- The browser UI can require sign-in or consent even when direct cookies work.
- Gemini can reject a selected model with backend error `1052`; fallback must be visible through `model_fallback_from` and `model_fallback_reason`.
- Deep research is not exposed as a stable AI Chat profile.

### Grok

Grok remains a browser UI provider:

- The adapter preflights the X/Grok composer before prompt submission and reports login or stale-profile recovery guidance.
- Model selection is by visible UI label, not backend slug.
- `fast` is the reliable default for the current X/Grok app. `Auto` and `Expert` can be unavailable even on an authenticated session; inspect existing visible labels read-only, and obtain explicit user authorization before any provider write.
- Response extraction is DOM-derived with network progress heuristics and cleanup. If a future adapter adds structured stream parsing, DOM cleanup should become fallback only.

Known limits:

- Automated verification is deterministic or read-only. Provider writes require an explicit user invocation.
- Rate limits and quota banners are account-specific.
- Deep research is not exposed as a stable AI Chat profile.

## Verification standard

A provider feature is not considered working until these are true:

1. A deterministic unit test covers local parsing, routing, state redaction, and error handling for the changed behavior.
2. A gated live run returns non-empty structured output for the provider and feature.
3. Metadata includes `provider`, `requested_model`, `selected_model`, completion state, `captured_at`, and relevant `provider_state`.
4. Conversation features are verified with a second run by saved id, and with attach-by-link or attach-by-id where the provider supports it.
5. Model selection is verified or explicitly reported as unverified. Rejected requested models and fallback reasons must be visible.
6. UI providers capture screenshot evidence when they return a final URL. API transports without a final URL must record `evidence_skipped_reason` and keep JSON plus stderr evidence.
7. Browser lifecycle evidence shows AI Chat started or reused an owned Browser Tools browser and did not attach to unmanaged or foreign browsers.
8. If the verification started an AI Chat owned browser only for the test, cleanup uses Browser Tools stop with the matching owner token and does not stop other browsers.

Private evidence belongs under a user-supplied `<private-output-dir>/<provider>/<case>/` outside the repository.
