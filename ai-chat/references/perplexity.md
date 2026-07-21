# Perplexity browser network transport

Perplexity has one supported AI Chat transport: authenticated HTTP and SSE inside the AI Chat owned Browser Tools browser.

The adapter:

1. Starts a new AI Chat browser headless when Perplexity is the provider that creates it. Browser Tools uses the configured `ai-chat` task profile, or Chrome profile `Default` as fallback.
2. Opens a dedicated background tab at `https://www.perplexity.ai/api/auth/session`. This JSON endpoint gives the request code a same-origin execution context without loading or parsing the Perplexity application UI.
3. Validates the logged-in account through the JSON response.
4. Sends uploads and `/rest/sse/perplexity_ask` requests with browser `fetch`, `credentials: "include"`, and the managed profile's browser credentials.
5. Parses the SSE protocol, including incremental `diff_block` patches and the final schematized response.
6. Waits for `status: "COMPLETED"` or `final_sse_message: true`. A preliminary `final: true` event with `status: "PENDING"` is not completion.

There is no Perplexity UI transport, rendered HTML parser, element selector, typing path, click path, or DOM response fallback. The provider object does not expose the old UI lifecycle methods. `provider_state` reports `transport: "browser-network-sse"`, `network_only: true`, and `dom_processing: false`.

AI Chat never reads or exports the Perplexity session cookie. It also ignores `PERPLEXITY_SESSION_TOKEN` and `PPLX_SESSION_TOKEN`. Browser credentials stay inside managed Chrome. Continuation read-write tokens still arrive through SSE and are stored only in private local conversation records.

If Chrome profile `Default` is logged in to Perplexity but the managed browser is logged out, stop the AI Chat owned browser with Browser Tools and `--clean`, then rerun so Browser Tools copies current profile state. If another Chrome profile has the login, configure the Browser Tools task profile `ai-chat`. Do not attach to main Chrome or another agent's browser.

## Network capture basis

The current request and stream contracts were derived with Browser Tools `record-har`, `extract-har`, `record-cdp`, GIF recording, screenshots, and a private same-origin replay. The capture verified:

- endpoint: `POST https://www.perplexity.ai/rest/sse/perplexity_ask`
- content type: `text/event-stream`
- schematized requests use `use_schematized_api: true`
- stream text is returned through block patches, so `send_back_text_in_streaming_api` is `false`
- `final: true` can arrive while status is still `PENDING`
- the terminal event has `status: "COMPLETED"` and `final_sse_message: true`
- GPT-5.6 Terra with Thinking disabled sends `model_preference: "gpt56_terra"`
- GPT-5.6 Terra with Thinking enabled sends `model_preference: "gpt56_terra_thinking"`
- Sonar 2 sends `model_preference: "experimental"`
- enabling the top-right Incognito control does not call a separate mode endpoint; the ask request carries `is_incognito: true` and keeps `query_source: "home"`
- the completed Incognito SSE event reports `privacy_state: "INCOGNITO"`, an `expiry_time`, `reconnectable: false`, and `thread_access: 1`

Private capture evidence belongs outside the repository. Do not commit HAR files, SSE streams, screenshots, GIFs, account model availability, cookies, owner tokens, conversation text, backend UUIDs, or read-write tokens.

## Supported capabilities

| Capability | Command or behavior |
| --- | --- |
| New prompt | `scripts/ai-chat.mjs --provider perplexity --prompt "..." --json` |
| Continue thread | Save with `--save-conversation`, then use `--conversation` |
| Attach thread | `--attach-conversation <backend-uuid-or-url> --save-conversation <local-id>` |
| Select model | `--model <id-or-alias>` |
| Select captured Thinking variant | `--model openai/gpt-5.6-terra --thinking`, or select `openai/gpt-5.6-terra-thinking` directly |
| List models | `scripts/ai-chat.mjs --provider perplexity --list-models --json` |
| Verify account acceptance | Add `--verify-models --verify-model-timeout 180` |
| Deep research | `--model perplexity/deep-research` or `--task deep_research`; default timeout is 3600 seconds |
| Source focus | `--source-focus web|academic|social|finance|all`; repeat it or use commas |
| Search focus | `--search-focus web|writing` |
| Recency | `--time-range all|day|week|month|year` |
| Citations | `--citation-mode clean|markdown|default` |
| Files | Repeat `--file <path>`; paths and size limits are validated before network use |
| Spaces | `--space-uuid <uuid>` or `--space <uuid>` with a user-provided Space id |
| Streaming | `--stream` writes incremental answer deltas to stderr and still emits final structured output |
| Incognito | `--incognito`; explicit private session, not saved to provider history, with provider expiry metadata |
| Save to library | `--save-to-library`; persistent provider history. It conflicts with `--incognito` |
| Language and timezone | `--language <tag>` and `--timezone <zone>` |
| Auth check | `--verify-session`; normal requests also validate auth before submission |

## Examples

```bash
# Explicit Incognito. The request is not saved to provider history.
scripts/ai-chat.mjs \
  --provider perplexity \
  --incognito \
  --prompt "Answer this private question" \
  --json

# Captured non-thinking model identifier.
scripts/ai-chat.mjs \
  --provider perplexity \
  --model openai/gpt-5.6-terra \
  --prompt "Give a concise current summary" \
  --json

# Same visible model with the captured Thinking toggle enabled.
scripts/ai-chat.mjs \
  --provider perplexity \
  --model openai/gpt-5.6-terra \
  --thinking \
  --prompt "Compare the evidence and explain uncertainty" \
  --stream \
  --json

# Research filters and private continuation state.
scripts/ai-chat.mjs \
  --provider perplexity \
  --task reasoning \
  --prompt-file "$HOME/.agents/questions/policy.md" \
  --source-focus all \
  --search-focus web \
  --time-range week \
  --citation-mode markdown \
  --language en-US \
  --timezone UTC \
  --save-conversation policy-research \
  --json

scripts/ai-chat.mjs \
  --provider perplexity \
  --conversation policy-research \
  --prompt "Now compare only the last 30 days" \
  --save-conversation policy-research \
  --json

# Deep research.
scripts/ai-chat.mjs --provider perplexity --task deep_research --prompt-file "$HOME/.agents/questions/deep.md" --json

# File, Space, streaming, and provider library history.
scripts/ai-chat.mjs \
  --provider perplexity \
  --prompt "Summarize this report and list open questions" \
  --file "$HOME/.agents/documents/report.pdf" \
  --space-uuid 123e4567-e89b-12d3-a456-426614174000 \
  --stream \
  --save-to-library \
  --json
```

## Model registry and Thinking

`--list-models --json` returns the network-contract model registry, default model, task suggestions, Thinking metadata, account tier requirements, history policy, and aliases.

The captured current pair is:

| AI Chat model | Perplexity request identifier | Thinking |
| --- | --- | --- |
| `openai/gpt-5.6-terra` | `gpt56_terra` | disabled |
| `openai/gpt-5.6-terra-thinking` | `gpt56_terra_thinking` | enabled |

`--thinking` resolves the base GPT-5.6 Terra model to its captured Thinking variant. It fails before network use when a selected model has no captured Thinking variant. This avoids guessing an identifier.

Task defaults:

| Task | Model |
| --- | --- |
| `quick_web` | `perplexity/best` |
| `deep_research` | `perplexity/deep-research` |
| `sonar` | `perplexity/sonar-2` |
| `reasoning` | `openai/gpt-5.6-terra-thinking` |
| `coding` | `openai/gpt-5.6-terra` |

Account acceptance changes by plan, region, and rollout. Add `--verify-models` to perform private incognito checks for the current account. A rejected requested model remains visible as an error. Do not silently replace it with another model.

## Captured request payload

A new request follows this shape. UUID values are generated for each request.

```json
{
  "params": {
    "attachments": [],
    "language": "en-US",
    "timezone": null,
    "search_focus": "internet",
    "sources": ["web"],
    "frontend_uuid": "<generated-uuid>",
    "mode": "copilot",
    "model_preference": "gpt56_terra_thinking",
    "is_related_query": false,
    "is_sponsored": false,
    "frontend_context_uuid": "<generated-uuid>",
    "prompt_source": "user",
    "query_source": "home",
    "is_incognito": true,
    "time_from_first_type": 0,
    "local_search_enabled": false,
    "use_schematized_api": true,
    "send_back_text_in_streaming_api": false,
    "supported_block_use_cases": ["answer_modes", "diff_blocks", "workflow_steps"],
    "client_coordinates": null,
    "mentions": [],
    "dsl_query": "question",
    "skip_search_enabled": true,
    "is_nav_suggestions_disabled": false,
    "source": "default",
    "always_search_override": false,
    "override_no_search": false,
    "should_ask_for_mcp_tool_confirmation": true,
    "supports_tool_approval_modal": true,
    "browser_agent_allow_once_from_toggle": false,
    "force_enable_browser_agent": false,
    "supported_features": ["browser_agent_permission_banner_v1.1"],
    "extended_context": false,
    "version": "2.18",
    "rum_session_id": "<generated-uuid>"
  },
  "query_str": "question"
}
```

Recency, Space, file, and continuation fields are added only when needed. Follow-ups send only the new user turn plus `last_backend_uuid`, private `read_write_token`, and `query_source: "followup"`. Spaces add `target_collection_uuid`, `target_thread_access_level`, and non-incognito history behavior.

AI Chat keeps its existing privacy-first default, so requests are Incognito unless `--save-to-library` or a Space requires persistence. `--incognito` records that the user explicitly requested the captured UI behavior and bypasses the local AI Chat response cache. Explicit output files or local conversation records are still written when the user asks for them. `--incognito` conflicts with `--save-to-library` and `--space-uuid`; both conflicts fail before network use instead of silently changing history behavior.

## Streaming parser

The current stream sends incremental answer text as JSON Patch operations under blocks such as:

```json
{
  "blocks": [
    {
      "intended_usage": "ask_text",
      "diff_block": {
        "field": "markdown_block",
        "patches": [
          {"op": "replace", "path": "", "value": {"progress": "IN_PROGRESS", "chunks": ["partial"]}},
          {"op": "add", "path": "/chunks/1", "value": " answer"}
        ]
      }
    }
  ],
  "status": "PENDING"
}
```

The adapter applies `add`, `replace`, and `remove` patches, emits answer deltas for `--stream`, then reconciles the final `FINAL` step and `markdown_block` when the completed event arrives. It retains backend UUID and read-write token in private state and maps top-level source objects into `search_results`.

## Output contract

Perplexity JSON output includes the common AI Chat metadata and safe provider state:

```json
{
  "provider": "perplexity",
  "model": "openai/gpt-5.6-terra-thinking",
  "selected_model": "openai/gpt-5.6-terra-thinking",
  "requested_model": "openai/gpt-5.6-terra",
  "complete": true,
  "provider_state": {
    "transport": "browser-network-sse",
    "network_only": true,
    "dom_processing": false,
    "requested_model_identifier": "gpt56_terra_thinking",
    "response_model_identifier": "gpt56_terra_thinking",
    "user_selected_model_identifier": "gpt56_terra_thinking",
    "model_selection_verified": true,
    "backend_uuid": "...",
    "has_read_write_token": true,
    "is_incognito": true,
    "incognito_explicit": true,
    "privacy_state": "INCOGNITO",
    "ephemeral": true,
    "expires_at": "...",
    "reconnectable": false,
    "thread_access": 1,
    "saved_to_library": false,
    "stream_state": {
      "enabled": true,
      "status": "completed",
      "partial": false,
      "timeout": false
    }
  },
  "sources": [],
  "search_results": [],
  "response": "..."
}
```

Session cookies never enter AI Chat process state. Continuation `read_write_token` values remain private. Public output may report `has_read_write_token: true`, but not the token itself.

## Verification

Run deterministic checks first:

```bash
cd ai-chat
node --test test/perplexity-provider.test.mjs
node --test test/ai-chat-module.test.mjs
node --test test/provider-model-selection-matrix.test.mjs
```

Live checks create provider requests and may consume quota. Keep evidence under a private durable directory such as `~/.agents/ai-chat/verify/perplexity/<case>/`. Verify at least:

1. Explicit `--incognito` request with `is_incognito: true`, `privacy_state: INCOGNITO`, expiry metadata, and no provider-history save.
2. New request with `openai/gpt-5.6-terra`.
3. The same base model with `--thinking`, with selected model reported as `openai/gpt-5.6-terra-thinking`.
4. `--stream` emits incremental block-patch text and ends only on the completed event.
5. First request saved with `--save-conversation`, followed by a second request using `--conversation`.
6. Auth failure points to profile resync and does not expose browser credentials.
7. Public JSON, sidecars, cache metadata, and stderr do not expose read-write tokens.
8. Files and Spaces are tested only with user-approved private inputs.

Do not claim Deep Research, file upload, Space routing, or an account model as live-working without a gated request for that exact feature.
