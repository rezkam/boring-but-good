# Gemini WebUI API

Gemini uses a direct WebUI API path through Browser Tools managed Chrome cookies. This reference documents supported behavior and the known failure modes. Keep account-specific verification artifacts and local profile names outside the repo.

## Current capability

- Reads Google cookies from the AI Chat owned Browser Tools managed Chrome by default. AI Chat uses Chrome profile `Default` unless the Browser Tools task profile `ai-chat` is configured or `--browser-profile` selects a profile for a new owned browser. Use `--headless --include-google` for a background Gemini session that retains Google identity. Including Google identity reintroduces the source-session logout risk that Browser Tools normally avoids, so use it only for an intentional Google workflow. If auth looks stale, cleanly stop the AI Chat owned browser and rerun so Browser Tools resyncs the copied profile.
- Supports an explicit direct profile fallback with `--cookie-source chrome-profile --chrome-profile <profile-folder>`.
- Verifies Gemini session state on live runs and model listing. The result separates direct WebUI auth from browser UI readiness.
- Fetches Gemini page tokens from `https://gemini.google.com/app`.
- Sends prompts to `/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate`.
- In headless managed-browser mode, submits through the authenticated page and captures the complete `StreamGenerate` response through the browser network layer. Non-browser cookie sources continue to use direct WebUI replay.
- Parses the chunked response stream for answer text. It does not depend on rendered answer text.
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

`--list-models --json` returns live account models from the managed browser when the RPC succeeds. Add `--verify-models` to send a tiny temporary prompt to each discovered model and mark `available`, `verified_at`, and `verification.status`.

Task defaults:

| Task | Model |
| --- | --- |
| `quick` | `gemini-3-flash` |
| `reasoning` | `gemini-3-flash-thinking` |
| `pro` | `gemini-3-pro` |

## Important limitations

Gemini backend continuation can reject stale or mismatched state with error `1097`. Treat native continuation as best effort. Keep the fallback path visible in JSON with `native_continuation_error` and `local_transcript_fallback` so callers can tell whether Gemini accepted the stored backend ids.

A split auth state is possible: direct WebUI auth can pass through cookies and account RPC while the managed browser UI is not fully ready. The helper reports this through `session_verification.direct_ready`, `session_verification.ui_ready`, and `session_verification.ui.reason`.

The required-cookie gate requires `__Secure-1PSID`. `__Secure-1PSIDTS` is collected when present but is optional because Gemini can work without it for some accounts.

Use `--include-conversation` when the caller needs the full messages returned in the JSON output. The helper includes `conversation_messages` and `conversation_message_count`.

## Verification standard

Before claiming a Gemini behavior works:

1. Run `npm test`.
2. Ensure the Browser Tools task profile `ai-chat` points at a Gemini-capable Chrome profile. If current cookies matter and auth looks stale, cleanly stop the AI Chat owned browser and rerun so the profile copy is refreshed.
3. Run the command with `--json` and save output under `/tmp/ai-chat-verify/gemini/<case>/`.
4. Verify non-empty response text and useful `provider_state`.
5. For continuation, verify a second prompt using the same saved conversation id.
6. Record whether native continuation was accepted or whether the local transcript fallback was used.

Do not commit live response artifacts, cookies, account-visible model lists, profile labels, screenshots, or provider tokens.

## Next work

- Find a continuation payload shape that reduces backend `1097` across more accounts.
- Add file upload support from the source extension.
- Add YouTube URL support from the source extension.
