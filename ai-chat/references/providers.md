# Provider Routing

Use `scripts/ai-chat.mjs` for all browser-authenticated AI chat providers.

## Provider table

| Provider | Mode | Model strategy | Continuation strategy |
| --- | --- | --- | --- |
| `perplexity` | WebUI API authenticated from browser cookie | Bundled `perplexity-webui-scraper` registry with ids, identifiers, tiers, modes, thinking variants, defaults, task suggestions, and optional live `--verify-models` acceptance checks | Backend UUID and read-write token |
| `grok` | Browser UI with X/Grok composer auth preflight from the Browser Tools managed profile | UI labels: `auto`, `fast`, `expert` | Browser conversation URL |
| `chatgpt` | Browser UI | UI labels vary by account, discover and verify visible choices where possible | Browser conversation URL |
| `gemini` | WebUI API with Browser Tools managed Chrome cookies by default | Live account model discovery through Gemini `otAQ7b` RPC, fallback known headers, aliases, tiers, thinking flags, defaults, task suggestions, and optional live `--verify-models` checks. Use Browser Tools started with the Gemini-capable profile | Gemini metadata continuation is attempted, with explicit `1097` error reporting and transcript fallback |

## Commands

```bash
scripts/ai-chat.mjs --provider perplexity --list-models --json
scripts/ai-chat.mjs --provider perplexity --list-models --verify-models --json
scripts/ai-chat.mjs --provider gemini --list-models --verify-models --json
scripts/ai-chat.mjs --provider grok --model fast --prompt "..." --json
scripts/ai-chat.mjs --provider chatgpt --model "thinking temporary" --prompt-file /tmp/q.md --json
scripts/ai-chat.mjs --provider gemini --task reasoning --prompt "..." --json
```

## Conversation ids

Saved conversation ids are provider scoped:

- `perplexity:research-x` stores Perplexity backend state.
- `grok:research-x` stores a Grok conversation URL.
- `chatgpt:research-x` stores a ChatGPT conversation URL.
- `gemini:research-x` stores Gemini provider metadata and a local transcript fallback.

Records live in `~/.cache/pi-browser-tools/ai-chat-conversations/<provider>/<id>.json`.

## Verification standard

A provider feature is not considered working until these are true:

1. A deterministic unit test covers the local parsing or routing logic.
2. A live run returns non-empty structured output.
3. The metadata includes provider, requested model, selected model, conversation id or URL when applicable, completion status, and capture time.
4. For UI providers, a screenshot confirms the visible model or conversation state when possible.
5. The managed browser is stopped if the task started it.

## Grok network migration plan

Status: Grok is still DOM-scraping. The provider already observes a real network signal but does not read the response body.

What we know today:

- The streaming endpoint is `https://grok.x.com/2/grok/add_response.json`.
- `scripts/ai-chat/providers/grok.mjs` has `createGrokNetworkTracker` that listens for `Network.requestWillBeSent`, `Network.dataReceived`, and `Network.loadingFinished` for that URL and exposes a `streamFinished` heuristic to the poller, but the answer text comes from `document.body.innerText` and a long DOM cleanup pipeline (`cleanRecoveredGrokText`, `endMarkers`, line-filter rules).
- A fresh prompt opens a new tab `x.com/i/grok?conversation=<id>`; the conversation id in the URL is the continuation handle.
- Submit uses the textarea `textarea[placeholder="Ask anything"]` and the send button by `aria-label` `Grok something|Submit|Send`.

Migration steps:

1. Replace the heuristic stream finished signal with a real body capture. Extend `createGrokNetworkTracker` to call `Network.getResponseBody` on `loadingFinished` for the matched `requestId` and store the full body.
2. Parse the body as NDJSON. Each Grok stream chunk is a JSON object; collect chunks of type `message` or `delta` (exact field shape to be confirmed during a live capture). Concatenate the text deltas to build the final answer.
3. Reuse `recoverGrokVisibleText` + `cleanRecoveredGrokText` only as a fallback when network capture is unavailable (no `requestId` matched, or `getResponseBody` failed).
4. Surface a structured `provider_state` like `{ conversation_url, conversation_id, response_id }` parsed from the stream when present, similar to Gemini metadata.
5. Add a parser unit test that feeds a recorded NDJSON sample (committed under `test/fixtures/grok-stream.ndjson`) and asserts the extracted text and provider state. The fixture should be captured once from a real session and committed verbatim, with auth tokens redacted.

Open questions to resolve from a live capture before changing code:

- Exact field name for the delta text inside each NDJSON line.
- Whether the conversation id is present in the body or only in the response URL.
- Whether Expert mode emits separate chain-of-thought records that we want to keep or discard.
- Whether rate limiting surfaces as an HTTP status (4xx) or a streamed error chunk.

ChatGPT migration follows the same pattern. ChatGPT streams over `https://chatgpt.com/backend-api/conversation` as SSE. The first network capture should be: open a tab in the managed Chrome, send a short prompt, and dump the raw stream to `/tmp/ai-chat-verify/<provider>/raw-stream.ndjson` for the fixture.
