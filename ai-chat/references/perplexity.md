# Perplexity WebUI API

This skill uses the same design ideas as `henrique-coder/perplexity-webui-scraper`:

- authenticate with the browser session token
- send prompts to `/rest/sse/perplexity_ask`
- parse Server-Sent Events instead of scraping rendered DOM
- keep backend conversation UUID and read-write token for follow-up turns
- expose model ids and Perplexity-specific options explicitly

Browser Tools uses a copied profile. If the live Chrome profile is logged in to Perplexity but the managed browser has no Perplexity session cookie, stop the managed browser with `--clean`, restart with the same profile and `--sync`, then retry before changing provider logic.

## Supported capabilities

| Capability | How |
| --- | --- |
| One-off prompt | `scripts/ai-chat.mjs --provider perplexity --prompt "..." --json` |
| Continue thread | save with `--save-conversation`, continue with `--conversation` |
| List models | `scripts/ai-chat.mjs --provider perplexity --list-models --json` |
| Verify account-accepted models | `scripts/ai-chat.mjs --provider perplexity --list-models --verify-models --verify-model-timeout 180 --json` |
| Deep research | `--model perplexity/deep-research --timeout 1800` |
| Source focus | provider option, one of `web`, `academic`, `social`, `finance`, `all` |
| Search focus | provider option, `web` or `writing` |
| Recency filter | provider option, `all`, `day`, `week`, `month`, `year` |
| Citation mode | provider option, `clean`, `markdown`, or `default` |
| Save to library | default is incognito, use `--save-to-library` to set `params.is_incognito=false` |
| Language and timezone | provider options passed into payload |

`--list-models --json` returns the default model, suggested task models, history policy, and the full bundled model registry from `henrique-coder/perplexity-webui-scraper`. Each model includes `id`, `name`, `identifier`, `tool_name`, `min_tier`, `mode`, `provider_family`, `thinking`, `thinking_level`, and `selected_by` aliases. Add `--verify-models` to send a tiny incognito prompt to every registry model and mark `available`, `verified_at`, and `verification.status` for the current account.

Task defaults:

| Task | Model |
| --- | --- |
| `quick_web` | `perplexity/best` |
| `deep_research` | `perplexity/deep-research` |
| `sonar` | `perplexity/sonar-2` |
| `reasoning` | `openai/gpt-5.4-thinking` |
| `coding` | `anthropic/claude-sonnet-4.6` |

## Known model ids

Use model ids, not display labels, when possible:

- `perplexity/best`
- `perplexity/deep-research`
- `perplexity/sonar-2`
- `openai/gpt-5.4`
- `openai/gpt-5.4-thinking`
- `openai/gpt-5.5-thinking`
- `google/gemini-3.1-pro-thinking-low`
- `google/gemini-3.1-pro-thinking-high`
- `anthropic/claude-sonnet-4.6`
- `anthropic/claude-sonnet-4.6-thinking`
- `anthropic/claude-opus-4.7`
- `anthropic/claude-opus-4.7-thinking`
- `moonshot/kimi-k2.6-instant`
- `moonshot/kimi-k2.6-thinking`
- `nvidia/nemotron-3-super-thinking`

Account tier matters. Pro and Max accounts expose different models. The bundled registry preserves `min_tier`; live `--verify-models` tells whether the current account accepts each model. If a model fails, report the error and retry with `perplexity/best` only when the user wants a fallback.

## Payload model

A Perplexity ask payload contains:

```json
{
  "params": {
    "attachments": [],
    "language": "en-US",
    "timezone": null,
    "client_coordinates": null,
    "sources": ["web"],
    "model_preference": "default",
    "mode": "search",
    "search_focus": "internet",
    "search_recency_filter": null,
    "is_incognito": true,
    "use_schematized_api": false,
    "local_search_enabled": false,
    "prompt_source": "user",
    "send_back_text_in_streaming_api": true,
    "version": "2.18"
  },
  "query_str": "question"
}
```

For follow-up turns, include:

```json
{
  "last_backend_uuid": "...",
  "read_write_token": "...",
  "query_source": "followup"
}
```

## Output contract

Perplexity JSON output should include:

```json
{
  "provider": "perplexity",
  "model": "perplexity/best",
  "requested_model": "perplexity/best",
  "conversation_id": "research-x",
  "conversation_url": null,
  "provider_state": {
    "backend_uuid": "...",
    "read_write_token": "...",
    "is_incognito": true,
    "saved_to_library": false
  },
  "search_results": [],
  "response": "..."
}
```

## Verification artifacts

Save live verification outputs under `/tmp/ai-chat-verify/perplexity/<case>/` or another private scratch directory. Do not commit model acceptance lists, provider state, conversation text, screenshots, or account-specific results.
