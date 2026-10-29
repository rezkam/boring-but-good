# Codex fast-mode review

Reviewed on 2026-10-29 against Pi 1.4.0 and OpenAI Codex commit
`9cc14e79882ff8885cd5d33b4adadae014045aef`.

## Findings

- The request parameter is correct: OpenAI Codex maps its `Fast` tier to the
  wire value `priority`, not `fast`.
  [Source: OpenAI Codex `ServiceTier::request_value`](https://github.com/openai/codex/blob/9cc14e79882ff8885cd5d33b4adadae014045aef/codex-rs/protocol/src/config_types.rs#L539-L543).
- Pi connects `before_provider_request` to its provider's `onPayload` callback.
  Handlers may return a replacement payload; returning `undefined` leaves it
  unchanged.
  [Sources: Pi 1.4.0 SDK](https://unpkg.com/@earendil-works/pi-coding-agent@1.4.0/dist/core/sdk.js)
  and [extension runner](https://unpkg.com/@earendil-works/pi-coding-agent@1.4.0/dist/core/extensions/runner.js).
- Pi's Codex provider applies `onPayload` before serializing either transport.
  HTTP serializes the transformed body before optional zstd compression;
  WebSocket sends it in a `response.create` frame. Cached WebSocket requests
  preserve non-input fields, including `service_tier`.
  [Source: Pi AI 1.4.0 Codex provider](https://unpkg.com/@earendil-works/pi-ai@1.4.0/dist/api/openai-codex-responses.js).
- The extension previously enabled priority immediately on load. It now starts
  disabled and requires `/codex-fast on`. Restarting or reloading resets it to
  disabled. `/codex-fast off` leaves all request fields untouched, including
  tiers supplied by other configuration.
  [Source: extension implementation](../../extensions/codex-fast-mode/index.ts).

## Limits and unknowns

The footer reports a request for priority, not server confirmation. This review
establishes the request wiring, not account eligibility, the server's selected
tier, billing, or a latency improvement. Reasoning effort, model selection, and
output limits are not changed by the extension.

No additional test cases are retained, as requested. Existing cases were adjusted
only to opt in before asserting enabled behavior.
