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

Automated browser checks use deterministic fixtures only. Authenticated checks, when explicitly run by a user, must be read-only.

## Provider model selection matrix

The automated matrix lives in `test/provider-model-selection-matrix.test.mjs`. It covers Perplexity, ChatGPT, Gemini, and Grok with the same contract for every provider.

| Provider | Automated coverage | Known limitations |
| --- | --- | --- |
| Perplexity | Deterministic aliases, payload, SSE, and browser-fetch fixtures | Account-specific availability is not automated |
| ChatGPT | Deterministic UI/network fixtures, strict quorum, and detached read safeguards | UI drift remains a provider risk |
| Gemini | Deterministic WebUI API fixtures and aliases | Account-specific availability is not automated |
| Grok | Deterministic UI label fixtures and aliases | UI labels can vary by account |

Run deterministic verification with:

```bash
cd ai-chat
node --test test/provider-model-selection-matrix.test.mjs
```

Automated verification never sends provider prompts, performs continuation, uploads files, or mutates provider history. Authenticated automated checks are read-only only.

## Evidence required before claiming a provider works

A claim like "Perplexity deep research works" or "ChatGPT extra-high continuation works" needs this evidence:

1. Unit test command and passing result for the changed parser, routing, metadata, and state behavior.
2. Read-only live command with exact flags, saved under `<private-output-dir>/ai-chat-verify/<provider>/<case>/`.
3. Non-empty response and `complete` state, or a clearly documented partial state when the feature is resumable.
4. Metadata showing `provider`, `requested_model`, `selected_model`, `model_task` when used, `captured_at`, completion fields, and relevant `provider_state`.
5. Proof that private tokens are redacted from public output. For Perplexity, public output may show `has_read_write_token: true` but not the token.
6. Conversation proof when the feature involves continuation: first run with `--save-conversation`, second run with `--conversation`, and attach by link or id when applicable.
7. Model proof when the feature involves model selection: read-only `--list-models` output or a documented provider limitation. Perplexity and Gemini `--verify-models` submit provider prompts, require explicit user authorization, and must never run in automated tests or evals.
8. Browser proof when the feature uses Browser Tools: owned startup or reuse, copied profile used instead of a fresh profile, no unmanaged or foreign attachment, and cleanup status if the test started a browser just for verification.
9. Screenshot evidence for UI providers when a final URL exists. For WebUI API providers without a final URL, record `evidence_skipped_reason` and keep JSON plus stderr evidence.
10. Remaining uncertainty, including account tier, quota, provider rollout, fallback use, DOM fallback, or native continuation errors.

## Per-provider live notes

### Perplexity

Use `references/perplexity.md` for the full normal research and deep research plan. Required evidence includes headless-preferred owned browser startup, same-origin network auth, persistent default mapping, explicit Incognito mapping when requested, captured request model identifier, selected model, Thinking state when used, schematized SSE completion, sources or search results, citation mode, saved conversation id, safe provider state, and redaction of read-write token. Normal-request evidence must show `is_incognito: false`, `saved_to_library: true`, `backend_uuid`, and matching canonical thread URLs. Incognito evidence must show `is_incognito: true`, `privacy_state: INCOGNITO`, expiry metadata, and no conflict with provider-history flags. Direct Perplexity thread URL continuation must send only the new turn plus the extracted backend UUID. Static tests must reject Perplexity UI lifecycle methods and DOM access patterns. For file or Space claims, include safe attachment metadata and Space selection metadata. Do not commit uploaded files or Space ids.

### ChatGPT

Use deterministic tests for all writes. A reviewer may gate read-only listing or `--final` on an existing provider ID. Evidence must show strict quorum, provider-ID equality, the safe current turn, and observed model/effort. Current provider UI drift is residual risk.

### Gemini

Show `session_verification.direct_ready`, `session_verification.ui_ready`, selected model, and temporary or saved-to-library behavior. For continuation, record whether native continuation succeeded or `native_continuation_error` plus `local_transcript_fallback` was used.

### Grok

Show read-only visible-label inspection for the requested label, a final conversation URL, and screenshot evidence when possible. In the current X/Grok session only `Fast` is visible; report `Auto` and `Expert` as unavailable unless an explicitly user-authorized provider operation verifies them. Document rate limits or quota fallback. Grok has no backend model slug.

## Skill evals

Prompt-level evals should cover:

- Perplexity model listing, direct tool aliases, research filters, file and Space option routing, streaming, and deep research routing
- saved conversation, follow-up continuation, and attach by link or backend id
- read-only account-specific model discovery with `--list-models --json`
- Grok model selection and reasoning or non-reasoning behavior
- ChatGPT request profiles, long-running handoff, strict quorum, provider-ID final retrieval, and safe turn visibility
- Gemini RPC model discovery, temporary/history behavior, session verification, and native continuation fallback
- browser lifecycle refusal and recovery messages
- fallback and failure reporting
