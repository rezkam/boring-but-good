# Gemini WebUI API

Gemini uses a same-origin WebUI API path inside the Browser Tools managed page. This reference documents supported behavior and known failure modes.

## Current capability

- Always requires the Browser Tools managed browser; credentials and page tokens remain in page context.
- Validates managed-browser UI readiness with safe status and reason fields only.
- Fetches page data and sends account RPCs inside the `gemini.google.com` page.
- Sends prompts to `/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate`.
- Parses the chunked response stream for answer text.
- Discovers account-visible model choices through Gemini's `otAQ7b` user status RPC.
- Falls back to known model headers when live discovery fails:
  - `gemini-3-flash` alias `flash`
  - `gemini-3-flash-thinking` aliases `thinking`, `reasoning`
  - `gemini-3-pro` alias `pro`
  - `gemini-3-flash-plus`
  - `gemini-3-flash-thinking-plus`
  - `gemini-3-pro-plus` alias `plus-pro`
  - advanced variants when the account allows them
- Falls back from `pro` to `flash` on Gemini model unavailable error `1052`.
- Extracts Gemini conversation ids from stream responses.
- Defaults to temporary chats by setting `innerReqList[45]=1`.
- Uses `--save-to-library` to omit the temporary flag so the chat can appear in Gemini history.
- Attempts native Gemini metadata continuation first.
- Reports `native_continuation_error` when Gemini rejects the stored ids, commonly backend error `1097`.
- Saves a local conversation transcript and can continue by replaying prior messages as context when Gemini backend continuation rejects the stored ids.

`--list-models --json` is read-only and returns live account models from the managed browser when the RPC succeeds. `--verify-models` sends a tiny temporary prompt to each discovered model, so it requires explicit user authorization and must never run in automated tests or evals. Its output marks `available`, `verified_at`, and `verification.status`.

Task defaults:

| Task | Model |
| --- | --- |
| `quick` | `gemini-3-flash` |
| `reasoning` | `gemini-3-flash-thinking` |
| `pro` | `gemini-3-pro` |

## Important limitations

Gemini backend continuation can reject stale or mismatched state with error `1097`. Treat native continuation as best effort. Keep the fallback path visible in JSON with `native_continuation_error` and `local_transcript_fallback` so callers can tell whether Gemini accepted the stored backend ids. Direct Gemini URLs and provider IDs contain only a conversation ID, not the RPC metadata required for continuation, so they are rejected before browser submission. Continue only from a locally saved Gemini record with complete `provider_state.conversation_state.metadata`.

The managed page can be signed out, blocked by consent, or lack a visible prompt input. The helper reports only safe UI readiness status and reason fields; it never returns page text, credentials, tokens, or headers.

Use `--include-conversation` when the caller needs the full messages returned in the JSON output. The helper includes `conversation_messages` and `conversation_message_count`.

## Verification standard

Before claiming a Gemini behavior works:

1. Run `npm test`.
2. Ensure the managed Browser Tools session is signed in to Gemini. If auth is stale, cleanly restart the managed browser and sign in again.
3. Run the read-only `--list-models --json` command and save output under a user-supplied `<private-output-dir>/gemini/<case>/`. Do not add `--verify-models` unless the user explicitly authorizes the provider prompts.
4. Verify non-empty response text and useful `provider_state`.
5. For continuation, verify a second prompt using the same saved conversation id.
6. Record whether native continuation was accepted or whether the local transcript fallback was used.

Do not commit live response artifacts, cookies, account-visible model lists, profile labels, screenshots, or provider tokens.

## Next work

- Find a continuation payload shape that reduces backend `1097` across more accounts.
- Add file upload support from the source extension.
- Add YouTube URL support from the source extension.
