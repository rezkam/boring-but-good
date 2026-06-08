# AI Chat Resource Helper

Use `scripts/ai-chat.mjs` when the user wants an answer from a browser-authenticated AI provider.

The AI Chat Module is the single prompt lifecycle for all chat providers. It owns request parsing, conversation records, fallback, cache, metadata, output files, and sidecars. Provider Adapters under `scripts/ai-chat/providers/` only own browser-specific page behavior.

## Basic usage

```bash
scripts/ai-chat.mjs --provider grok --prompt "What is Brent crude today?"
scripts/ai-chat.mjs --provider chatgpt --model "thinking temporary" --prompt-file /tmp/q.txt --out /tmp/a.md
scripts/ai-chat.mjs --provider gemini --prompt-file /tmp/q.txt --json
scripts/ai-chat.mjs --provider perplexity --list-models --verify-models --json

# Save a browser conversation URL under a stable id, then continue it later.
scripts/ai-chat.mjs --provider grok --model fast --prompt "Start researching X" --save-conversation research-x --json
scripts/ai-chat.mjs --provider grok --conversation research-x --prompt "Now compare it with Y" --json
```

## Options

| Flag | Description |
| --- | --- |
| `--provider <name>` | `grok`, `gemini`, `chatgpt`, or `perplexity` |
| `--prompt <text>` | Inline prompt text |
| `--prompt-file <path>` | Read prompt from file |
| `--model <name>` | Provider-specific model id or alias |
| `--task <task>` | Provider task default, such as `reasoning`, `coding`, `deep_research`, or `quick` |
| `--thinking` | Enable thinking mode where supported |
| `--out <file>` | Save response to file |
| `--port <n>` | Chrome debug port, default `9222` |
| `--timeout <seconds>` | Max wait, default `300` |
| `--json` | Output JSON with metadata |
| `--list-models` | List provider models, defaults, task mappings, and history policy |
| `--verify-models` | With `--list-models`, run live account acceptance checks where supported |
| `--verify-model-timeout <seconds>` | Timeout per model verification, default `90` |
| `--save-to-library` | Save to provider history where supported. Default is incognito or temporary for Perplexity and Gemini |
| `--cookie-source <source>` | Gemini cookie source, `managed-browser` (default) or `chrome-profile` (explicit fallback) |
| `--chrome-profile <name>` | Gemini direct profile fallback, use with `--cookie-source chrome-profile`; prefer the configured Browser Tools `gemini` task profile for normal runs |
| `--continue` | Continue the active provider conversation tab when the current URL is already a conversation |
| `--conversation <id-or-url>` | Open a saved browser conversation id or direct conversation URL before sending the prompt |
| `--save-conversation <id>` | Save the final browser conversation URL under a provider-scoped id in `~/.cache/pi-browser-tools/ai-chat-conversations` |
| `--evidence` | Capture screenshot evidence for the final provider URL and include `evidence_path` in metadata |
| `--evidence-path <file>` | Write screenshot evidence to a specific file, also enables evidence capture |
| `--evidence-full-page` | Capture full-page screenshot evidence instead of the visible viewport |

## Conversation continuity

Use `--save-conversation <id>` when a task is expected to need follow-ups across multiple agent turns. The helper stores a small JSON record with the provider, model, provider state or final conversation URL, local messages, capture time, and response size. Use `--conversation <id>` later to continue that thread and send only the new user prompt when the provider supports native continuation.

This mirrors the useful part of thread UUID handling in API-style clients, but keeps the browser-authenticated implementation provider-neutral. The AI Chat Module owns the conversation record lifecycle. Provider Adapters only know how to open, type, submit, and read their own web UI.

Rules:

- Use stable ids such as `market-research`, `project-plan`, or a task id.
- Use provider-scoped ids. `grok:market-research` and `chatgpt:market-research` are separate records.
- Use a direct URL with `--conversation https://...` when the user gives a provider conversation link.
- Use `--continue` only for short same-tab flows. Prefer `--save-conversation` and `--conversation` for reliable multi-turn work.
- The final JSON metadata includes `conversation_id`, `conversation_url`, and `conversation_record_path` when applicable.

## Provider notes

### Grok

- URL: `x.com/i/grok`
- Models: `auto`, `fast`, `expert`
- `expert` can take several minutes.
- Grok uses the Browser Tools managed Chrome session. Start Browser Tools with the default or configured Chrome profile that is logged in to X/Grok, for example `../browser-tools/scripts/start.mjs --profile Default --sync`, when current login cookies matter. The adapter preflights the Grok composer before typing, so fresh, wrong, or logged-out profiles fail with an auth/session error before prompt submission.
- If quota is hit, the helper can fall back from `expert` to `auto` to `fast`, but it verifies the visible model label before submit.

### Gemini

- URL: `gemini.google.com`
- Prefer Browser Tools managed Chrome started with the Gemini-capable profile. The default Gemini cookie source is `managed-browser`.
- Use `--cookie-source chrome-profile --chrome-profile <profile-folder>` only as an explicit direct profile fallback.
- `--list-models` uses Gemini account RPC discovery when cookies work.
- Verified account models from the managed Gemini task profile browser: `gemini-3-flash`, `gemini-3-flash-thinking`, `gemini-3-pro`.
- Default chats are temporary. Use `--save-to-library` when the user wants Gemini history.
- Native Gemini continuation can return backend error `1097`; the helper reports `native_continuation_error` and uses local transcript fallback.

### Perplexity

- URL: `perplexity.ai`
- `--list-models` exposes the WebUI scraper registry with thinking levels, tiers, modes, and aliases.
- `--verify-models` checks current-account acceptance through incognito WebUI API prompts.
- Default chats are incognito. Use `--save-to-library` when the user wants Perplexity library history.

### ChatGPT

- URL: `chatgpt.com`
- Models: `instant`, `thinking`, `pro`, plus temporary chat variants such as `thinking temporary`.

## Module shape

| File | Role |
| --- | --- |
| `scripts/ai-chat.mjs` | Thin CLI entry point |
| `scripts/ai-chat/module.mjs` | Deep AI Chat Module: prompt lifecycle, conversation records, fallback, cache, metadata, output |
| `scripts/ai-chat/providers/` | Provider Adapter implementations for Grok, Gemini, and ChatGPT |

## Completion detection

The helper does not use only fixed sleeps. The AI Chat Module submits the prompt and delegates provider-specific page detection to the Provider Adapter. Adapters can poll response text, check generating indicators, watch network signals, and return stable response metadata.

## Output files

When `--out` is used, the helper writes:

- the requested output file
- `<out>.meta.json` with metadata
- `<out>.raw.txt` when raw visible text is available

Use `--json` when downstream code needs metadata and response in one JSON document. When `--evidence` or `--evidence-path` is used, metadata includes `evidence_path` and captures the final provider URL instead of the active browser tab.
