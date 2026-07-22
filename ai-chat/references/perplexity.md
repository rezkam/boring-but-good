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

## Runtime contract

- endpoint: `POST https://www.perplexity.ai/rest/sse/perplexity_ask`
- requests use `use_schematized_api: true`; stream text uses block patches
- completion requires `status: "COMPLETED"` or `final_sse_message: true`; a `final: true` event while `status` is `PENDING` is not terminal
- GPT-5.6 Terra identifiers are `gpt56_terra` and `gpt56_terra_thinking`; Sonar 2 uses `experimental`
- explicit Incognito sends `is_incognito: true` with `query_source: "home"`; its final state can include `privacy_state`, expiry, reconnectability, and thread access

Do not commit private provider data, including HAR files, SSE streams, screenshots, account availability, cookies, owner tokens, conversation text, backend UUIDs, or read-write tokens.

## Supported capabilities

| Capability | Command or behavior |
| --- | --- |
| New prompt | `scripts/ai-chat.mjs --provider perplexity --prompt "..." --json` |
| Continue thread | Use the returned `conversation_url` directly with `--conversation`, or save with `--save-conversation` and use the local id |
| Attach thread | `--attach-conversation <backend-uuid-or-url> --save-conversation <local-id>` |
| Select model | `--model <id-or-alias>` |
| Select Thinking variant | `--model openai/gpt-5.6-terra --thinking`, or select `openai/gpt-5.6-terra-thinking` directly |
| List models | `scripts/ai-chat.mjs --provider perplexity --list-models --json` |
| Verify account acceptance | Requires explicit user authorization: `--verify-models --verify-model-timeout 180` submits provider prompts and is excluded from automated tests and evals |
| Deep research | `--model perplexity/deep-research` or `--task deep_research`; default timeout is 3600 seconds |
| Source focus | `--source-focus web|academic|social|finance|all`; repeat it or use commas |
| Search focus | `--search-focus web|writing` |
| Recency | `--time-range all|day|week|month|year` |
| Citations | `--citation-mode clean|markdown|default` |
| Files | Repeat `--file <path>`; paths and size limits are validated before network use |
| Spaces | `--space-uuid <uuid>` or `--space <uuid>` with a user-provided Space id |
| Streaming | `--stream` writes incremental answer deltas to stderr and still emits final structured output |
| Incognito | `--incognito`; explicit private session, not saved to provider history, with provider expiry metadata |
| Save to library | Normal requests persist to provider history. `--save-to-library` remains an explicit persistence flag and conflicts with `--incognito` |
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

# Continue the provider thread from the `conversation_url` in a prior JSON response.
scripts/ai-chat.mjs \
  --provider perplexity \
  --conversation https://www.perplexity.ai/search/123e4567-e89b-12d3-a456-426614174000 \
  --prompt "What changes your conclusion?" \
  --json

# Non-thinking model identifier.
scripts/ai-chat.mjs \
  --provider perplexity \
  --model openai/gpt-5.6-terra \
  --prompt "Give a concise current summary" \
  --json

# Same visible model with Thinking enabled.
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
  --prompt-file ./policy.md \
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
scripts/ai-chat.mjs --provider perplexity --task deep_research --prompt-file ./deep.md --json

# File, Space, streaming, and provider library history.
scripts/ai-chat.mjs \
  --provider perplexity \
  --prompt "Summarize this report and list open questions" \
  --file ./report.pdf \
  --space-uuid 123e4567-e89b-12d3-a456-426614174000 \
  --stream \
  --save-to-library \
  --json
```

## Model registry and Thinking

`--list-models --json` returns the network-contract model registry, default model, task suggestions, Thinking metadata, account tier requirements, history policy, and aliases.

The supported pair is:

| AI Chat model | Perplexity request identifier | Thinking |
| --- | --- | --- |
| `openai/gpt-5.6-terra` | `gpt56_terra` | disabled |
| `openai/gpt-5.6-terra-thinking` | `gpt56_terra_thinking` | enabled |

`--thinking` resolves the base GPT-5.6 Terra model to its Thinking variant. It fails before network use when a selected model has no supported Thinking variant. This avoids guessing an identifier.

Task defaults:

| Task | Model |
| --- | --- |
| `quick_web` | `perplexity/best` |
| `deep_research` | `perplexity/deep-research` |
| `sonar` | `perplexity/sonar-2` |
| `reasoning` | `openai/gpt-5.6-terra-thinking` |
| `coding` | `openai/gpt-5.6-terra` |

Account acceptance changes by plan, region, and rollout. `--list-models --json` is read-only. `--verify-models` performs private Incognito provider prompts for the current account only after explicit user authorization, and it is never part of automated tests or evals. A rejected requested model remains visible as an error. Do not silently replace it with another model.

## Request payload

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
    "is_incognito": false,
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

Recency, Space, file, and continuation fields are added only when needed. Each created thread maps its returned `backend_uuid` to the canonical URL `https://www.perplexity.ai/search/<backend_uuid>`, which AI Chat returns as both `final_url` and `conversation_url`. A direct `--conversation` URL extracts the UUID and sends only the new user turn plus `last_backend_uuid` and `query_source: "followup"`. A saved local conversation also retains the private `read_write_token` when supplied, which is the reliable continuation path across later agent turns. Spaces add `target_collection_uuid`, `target_thread_access_level`, and non-incognito history behavior.

AI Chat persists ordinary requests to provider history by default. `--incognito` records an explicit private request and bypasses the local AI Chat response cache. `--save-to-library` remains an explicit persistence flag for compatibility. Explicit output files or local conversation records are still written when the user asks for them. `--incognito` conflicts with `--save-to-library` and `--space-uuid`; both conflicts fail before network use instead of silently changing history behavior.

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
    "thread_url": "https://www.perplexity.ai/search/...",
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
  "final_url": "https://www.perplexity.ai/search/...",
  "conversation_url": "https://www.perplexity.ai/search/...",
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

User-invoked provider usage can create provider requests and consume quota. Before writing user-requested private output, set `umask 077` and use `<private-output-dir>/<case>/`. Automated tests remain deterministic and read-only.

For a user-invoked check, inspect normal and explicit Incognito privacy state, canonical `/search/<backend_uuid>` URLs, continuation with the private read-write token, Thinking selection, schematized stream completion, and redaction in public output. Do not claim an account model, Deep Research, file upload, or Space routing works without a user-requested check of that feature.
