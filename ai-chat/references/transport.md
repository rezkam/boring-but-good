# Transport Strategy

AI Chat should be network-first, UI-verified.

The Perplexity reference repo showed the right durable model: use the browser session for authentication, then send and read structured messages through provider endpoints or WebSocket/SSE streams. DOM scraping should be a fallback, not the main data path.

## Priority order

1. **Provider WebUI API or stream**: send prompts and parse structured responses from fetch, SSE, WebSocket, or GraphQL endpoints. This is preferred because it is less coupled to visual layout.
2. **Network-observed browser session**: use the UI only to trigger a request, then capture the request/response from CDP Network events. This is useful when direct endpoint replay is hard because tokens or request ids are generated in-page.
3. **UI control with network response parsing**: type and click through the UI, but read answer text and model state from network messages when possible.
4. **DOM extraction**: only for fields that are not available from structured messages, or as a recovery fallback.

## Provider status

| Provider | Current transport | Target transport |
| --- | --- | --- |
| Perplexity | WebUI API via session cookie and SSE parser | Keep and deepen |
| Grok | UI submit plus partial network tracking | Move to Network-observed or direct WebUI API |
| ChatGPT | UI submit and DOM extraction | Move to Network-observed stream parser if accessible |
| Gemini | WebUI API via Browser Tools managed Chrome cookies, account model RPC, and stream parser | Keep and deepen, solve native continuation `1097`, add uploads next |

## Adapter contract

A provider can implement `run({ browser, request, selectedModel, conversation })`. When present, the AI Chat Module calls it directly instead of the UI lifecycle methods.

`run` should return:

```json
{
  "text": "answer",
  "rawText": "raw answer or stream text",
  "done": true,
  "modelUsed": "provider/model-id",
  "finalUrl": null,
  "providerState": {},
  "searchResults": []
}
```

Provider state is where backend thread ids, read-write tokens, conversation ids, or stream ids live. Saved conversations should preserve this state so follow-up prompts can send only the new user message.

## Migration rules

- Do not remove UI screenshot verification. Network-first still needs browser evidence for account-specific state.
- Do not rely on static model lists for account-specific providers unless the provider exposes a stable model endpoint. Discover visible or accepted models per account.
- If endpoint replay fails, fall back to network-observed UI before DOM extraction.
- If DOM extraction is used, mark `transport: "dom-fallback"` or note this in metadata so failures are visible.
