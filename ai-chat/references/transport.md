# Transport Strategy

AI Chat should be network-first and UI-verified.

The durable provider model is: use the browser session for authentication, then send and read structured messages through provider endpoints, SSE, WebSocket, GraphQL, or network-observed browser requests. DOM extraction is a fallback, not the preferred data path.

## Priority order

1. **Provider WebUI API or stream**: send prompts and parse structured responses from fetch, SSE, WebSocket, or GraphQL endpoints. This is preferred because it is less coupled to visual layout.
2. **Network-observed browser session**: use the UI to create valid authenticated request context, then capture or rewrite request and response data from CDP Network and Fetch events.
3. **UI control with network response parsing**: type and click through the UI, but read answer text and model state from network messages when possible.
4. **DOM extraction**: use only for fields that are not available from structured messages, or as a recovery fallback. Metadata must mark DOM fallback.

## Provider status

| Provider | Current transport | Notes and next direction |
| --- | --- | --- |
| Perplexity | WebUI API via managed-browser session cookie, uploads API for files, SSE parser for ask and deep research | Keep. Auth is browser-cookie only inside AI Chat. Deepen live verification for files and Spaces as needed |
| ChatGPT | Network-observed authenticated request. The UI creates valid context, the adapter rewrites backend payloads, then parses SSE and WebSocket catchups | Keep stream parsing first. DOM text remains fallback only and must be marked in metadata |
| Gemini | WebUI API via Browser Tools managed Chrome cookies by default, account model RPC, and stream parser. Direct Chrome profile cookie fallback is explicit | Keep. Native continuation error `1097` remains a known provider limitation with transcript fallback |
| Grok | Browser UI submit, visible model labels, auth preflight, partial network progress tracking, DOM-derived response cleanup | Move toward structured network body parsing when a stable Grok stream body contract is captured. Until then, make DOM fallback and limitations visible |

## Adapter contract

A provider can implement `run({ browser, request, selectedModel, conversation })`. When present, the AI Chat Module calls it directly instead of the older UI lifecycle methods.

`run` should return:

```json
{
  "text": "answer",
  "rawText": "raw answer or stream text",
  "done": true,
  "modelUsed": "provider/model-id",
  "finalUrl": null,
  "providerState": {},
  "searchResults": [],
  "attachments": []
}
```

Provider state is where safe backend thread ids, redacted continuation markers, stream state, model selection details, file metadata, Space selection, or fallback details live. Secret tokens must be omitted or represented as presence fields in public output. If the provider needs private continuation state, return it as private provider state so the AI Chat module can write it only to the local conversation record.

Saved conversations should preserve provider state so follow-up prompts can send only the new user message when the provider supports backend continuation.

## Browser rules for transports

- Use only the AI Chat owned Browser Tools managed browser for browser-authenticated transports.
- Open provider tabs in the background with `browser.newPage({ background: true })`.
- Do not bring pages to front unless a task explicitly needs user-visible interaction.
- Do not connect to unmanaged Chrome or another agent's Browser Tools browser.
- Do not print or cache Browser Tools owner tokens, cookies, Perplexity read-write tokens, or provider session tokens.
- Successful AI Chat runs disconnect from CDP but leave the owned browser open for reuse.

## Migration rules

- Do not remove UI screenshot verification for browser UI providers. Network-first still needs browser evidence for account-specific state when a final URL exists.
- Do not require screenshots from WebUI API transports that return no final URL. Record `evidence_skipped_reason` and keep JSON, stderr, and notes instead.
- Do not rely on static model lists for account-specific providers unless the provider has no live model endpoint. Discover visible or accepted models per account when possible.
- If endpoint replay fails, prefer network-observed UI before DOM extraction.
- If DOM extraction is used, mark it with `provider_state.dom_fallback=true`, `transport: "dom-fallback"`, or another explicit metadata field.
- Fallbacks must be visible. Do not silently replace a rejected requested model, an expired auth session, or a failed native continuation.

## Evidence implications

Structured transports produce stronger evidence through JSON metadata and raw stream text. UI transports need screenshot evidence when a final URL is available. For every transport, live evidence should include:

- command and prompt or prompt file path
- stdout JSON or output file
- stderr log with provider progress and browser lifecycle messages
- metadata sidecar when `--out` is used
- screenshot when final URL exists and the provider uses browser UI
- notes with selected model, continuation result, fallback, and cleanup status
