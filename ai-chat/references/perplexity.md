# Perplexity WebUI API

AI Chat uses the same durable path as `perplexity-webui-scraper` for Perplexity:

- authenticate with the Browser Tools managed browser session cookie
- send prompts to `/rest/sse/perplexity_ask`
- parse Server-Sent Events instead of scraping rendered DOM
- keep backend conversation UUID and private read-write token for follow-up turns
- expose model ids, direct tool aliases, research options, files, Spaces, streaming, and deep research through the AI Chat command shape

Browser Tools uses a copied profile. AI Chat reads the Perplexity session cookie from the AI Chat owned managed browser only, first from `https://www.perplexity.ai`, then from `https://perplexity.ai`. It does not read `PERPLEXITY_SESSION_TOKEN` or `PPLX_SESSION_TOKEN`, and it keeps the cookie value out of JSON output, sidecars, cache metadata, and logs.

If normal Chrome profile `Default` is logged in to Perplexity but the AI Chat managed browser is logged out, stop the AI Chat owned browser with Browser Tools and `--clean`, then rerun AI Chat so Browser Tools creates a fresh copy. If another profile has the login, configure the Browser Tools task profile `ai-chat`. Do not attach to main Chrome or another agent's browser.

## Supported capabilities

| Capability | How |
| --- | --- |
| New prompt | `scripts/ai-chat.mjs --provider perplexity --prompt "..." --json` |
| Continue thread | Save with `--save-conversation`, continue with `--conversation` |
| Attach thread | `--attach-conversation <backend-uuid-or-url> --save-conversation <local-id>` |
| List models | `scripts/ai-chat.mjs --provider perplexity --list-models --json` |
| Verify account-accepted models | `scripts/ai-chat.mjs --provider perplexity --list-models --verify-models --verify-model-timeout 180 --json` |
| Deep research | `--model perplexity/deep-research` or `--task deep_research`; uses a 3600 second timeout unless `--timeout` is explicit |
| Source focus | `--source-focus web|academic|social|finance|all`; repeat it or pass comma-separated values |
| Search focus | `--search-focus web|writing` |
| Recency filter | `--time-range all|day|week|month|year` |
| Citation mode | `--citation-mode clean|markdown|default` |
| File attachments | Repeat `--file <path>` for local files. Files are validated before network use |
| Spaces | `--space-uuid <uuid>` or `--space <uuid>` with a user-provided Perplexity Space id |
| Streaming | `--stream` writes progress deltas to stderr and still emits final JSON or markdown output |
| Save to library | Default is incognito. Use `--save-to-library` to set `params.is_incognito=false` |
| Language and timezone | `--language <tag>` and `--timezone <zone>` are passed into the WebUI API payload |
| Auth check | `--verify-session` validates the Perplexity auth session without printing the cookie |

## Examples

```bash
# Current research with deterministic citation links and saved continuation state.
scripts/ai-chat.mjs \
  --provider perplexity \
  --model openai/gpt-5.4-thinking \
  --prompt-file /tmp/question.md \
  --source-focus all \
  --search-focus web \
  --time-range week \
  --citation-mode markdown \
  --language en-US \
  --timezone UTC \
  --save-conversation policy-research \
  --json

# Follow up using backend UUID plus private read-write token when available.
scripts/ai-chat.mjs \
  --provider perplexity \
  --conversation policy-research \
  --prompt "Now compare only the last 30 days" \
  --save-conversation policy-research \
  --json

# Attach a known backend UUID to a reusable local session.
scripts/ai-chat.mjs \
  --provider perplexity \
  --attach-conversation 123e4567-e89b-12d3-a456-426614174000 \
  --save-conversation attached-policy-research \
  --json

# Deep research.
scripts/ai-chat.mjs --provider perplexity --task deep_research --prompt-file /tmp/question.md --json

# File analysis in a Space with streaming progress and provider history.
scripts/ai-chat.mjs \
  --provider perplexity \
  --prompt "Summarize this report and list open questions" \
  --file /tmp/report.pdf \
  --space-uuid 123e4567-e89b-12d3-a456-426614174000 \
  --stream \
  --save-to-library \
  --json
```

## Model registry

`--list-models --json` returns the default model, suggested task models, history policy, and the exposed Pro-tier bundled model registry from `perplexity-webui-scraper`. Max-tier models are filtered out to match the standalone Perplexity skill.

Each model includes `id`, `name`, `identifier`, `tool_name`, `min_tier`, `mode`, `provider_family`, `thinking`, `thinking_level`, `account_tier`, and `selected_by` aliases, including direct tool aliases like `pplx_gpt54_thinking`.

Add `--verify-models` to send a tiny incognito prompt to every exposed model and mark `available`, `verified_at`, `verification.status`, `verification.accepted`, and `verification.rejected` for the current account. The top-level `verification` object includes accepted and rejected counts and model ids for that live run.

Task defaults:

| Task | Model |
| --- | --- |
| `quick_web` | `perplexity/best` |
| `deep_research` | `perplexity/deep-research` |
| `sonar` | `perplexity/sonar-2` |
| `reasoning` | `openai/gpt-5.4-thinking` |
| `coding` | `anthropic/claude-sonnet-4.6` |

Known model ids:

- `perplexity/best`
- `perplexity/deep-research`
- `perplexity/sonar-2`
- `openai/gpt-5.4`
- `openai/gpt-5.4-thinking`
- `google/gemini-3.1-pro-thinking-low`
- `google/gemini-3.1-pro-thinking-high`
- `anthropic/claude-sonnet-4.6`
- `anthropic/claude-sonnet-4.6-thinking`
- `moonshot/kimi-k2.6-instant`
- `moonshot/kimi-k2.6-thinking`
- `nvidia/nemotron-3-super-thinking`

Account tier matters. AI Chat exposes the same Pro-tier model set as the standalone Perplexity skill and preserves each model's `min_tier` in `account_tier.required`. Live `--verify-models` tells whether the current account accepts each exposed model and sets `account_tier.verified` to `accepted` or `rejected`. If a model fails, report the error and retry with `perplexity/best` only when the user wants a fallback.

## Request payload model

A normal Perplexity ask payload contains:

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

For follow-up turns, include only the new user prompt plus backend continuation state:

```json
{
  "params": {
    "last_backend_uuid": "...",
    "read_write_token": "...",
    "query_source": "followup"
  },
  "query_str": "new user question"
}
```

For Spaces, the payload includes `target_collection_uuid`, `target_thread_access_level`, `query_source: "collection"`, and non-incognito history behavior. For files, `params.attachments` contains uploaded object URLs. Public metadata stores only safe attachment fields: filename, MIME type, size, image flag, source, status, and URL presence.

## Output contract

Perplexity JSON output should include:

```json
{
  "provider": "perplexity",
  "model": "perplexity/best",
  "selected_model": "perplexity/best",
  "requested_model": "perplexity/best",
  "complete": true,
  "conversation_id": "research-x",
  "conversation_url": null,
  "provider_state": {
    "backend_uuid": "...",
    "has_read_write_token": true,
    "is_incognito": true,
    "saved_to_library": false,
    "attachment_count": 1,
    "attachments": [
      {
        "filename": "report.pdf",
        "mime_type": "application/pdf",
        "size_bytes": 12345,
        "is_image": false,
        "source": "local-file",
        "status": "uploaded",
        "url_present": true
      }
    ],
    "space_uuid": "123e4567-e89b-12d3-a456-426614174000",
    "space_selected": true,
    "stream_state": {
      "enabled": true,
      "status": "completed",
      "partial": false,
      "timeout": false
    }
  },
  "sources": [],
  "search_results": [],
  "captured_at": "2026-06-23T00:00:00.000Z",
  "response": "..."
}
```

Continuation `read_write_token` values and session cookie values are secrets. Keep them only in private local conversation records or in memory during the request, not stdout JSON, metadata sidecars, query cache metadata, stderr, or logs.

## Known limitations

- Perplexity account acceptance is live-account specific. Do not commit accepted or rejected model lists.
- Max-tier-only models are intentionally filtered out.
- WebUI API requests usually do not return a final provider URL, so screenshot evidence can be skipped. Use saved JSON output, sidecar metadata, stderr, and notes as evidence.
- Deep research is long-running. Keep live checks gated and use a long timeout.
- File uploads are limited to validated local files, at most 30 files, and 50 MB per file.
- Spaces require an explicit user-provided UUID. AI Chat does not discover private Space ids.

## Verification artifacts

Save live verification outputs under `/tmp/ai-chat-verify/perplexity/<case>/` or another private scratch directory outside the repo. Do not commit model acceptance lists, provider state, conversation text, screenshots, files, account-specific results, browser state, or local conversation records.

Gated live research plan:

```bash
# Run only when the user allows live Perplexity calls.
if [ "${AI_CHAT_LIVE_PERPLEXITY_RESEARCH:-0}" = "1" ]; then
  base="/tmp/ai-chat-verify/perplexity/research-options-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$base/normal" "$base/deep" "$base/file-space"

  scripts/ai-chat.mjs \
    --provider perplexity \
    --prompt "Give a cited summary of one current battery recycling policy development." \
    --source-focus all \
    --search-focus web \
    --time-range month \
    --citation-mode markdown \
    --language en-US \
    --timezone UTC \
    --save-conversation pplx-normal-live-check \
    --json \
    --out "$base/normal/response.json" \
    2>"$base/normal/stderr.log"

  scripts/ai-chat.mjs \
    --provider perplexity \
    --conversation pplx-normal-live-check \
    --prompt "Now list only unresolved questions." \
    --save-conversation pplx-normal-live-check \
    --json \
    --out "$base/normal/followup.json" \
    2>"$base/normal/followup.stderr.log"

  scripts/ai-chat.mjs \
    --provider perplexity \
    --task deep_research \
    --prompt "Deeply research one current battery recycling policy development and list key uncertainties." \
    --source-focus all \
    --time-range month \
    --citation-mode markdown \
    --language en-US \
    --timezone UTC \
    --save-conversation pplx-deep-live-check \
    --json \
    --out "$base/deep/response.json" \
    2>"$base/deep/stderr.log"

  printf 'Private live evidence: %s\n' "$base" > "$base/notes.md"
fi
```

The normal case verifies research options, citation formatting, saved conversation metadata, continuation, and provider state redaction. The deep case verifies `perplexity/deep-research`, the long timeout profile, non-DOM SSE completion, sources, and completion state. If file or Space verification is needed, add a private file path and a user-approved Space UUID under the same `$base` tree and record the limits in `notes.md`.
