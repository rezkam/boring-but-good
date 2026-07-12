# Perplexity Reference

Run commands from the Perplexity skill directory:

```bash
uv run scripts/pplx.py <command> [options]
```

## Token sources

Token lookup order:

1. `--token TOKEN`
2. `--token-file PATH`
3. Browser Tools copied Chrome profile from `Default`, unless `--no-chrome` is set
4. `PERPLEXITY_SESSION_TOKEN`
5. `PPLX_SESSION_TOKEN`

Use `uv run scripts/pplx.py token` to check availability without printing the token. Use `uv run scripts/pplx.py token --validate` for a live read-only auth check. Browser Tools is the default automatic token path: it starts a synced sandbox copy of the selected Chrome profile, navigates to Perplexity, reads the session cookie through DevTools, then stops the managed browser. `ask` and direct tools retry transient WebUI 403 and query-processing failures according to `--auth-retries`. If an environment or token-file token is expired, `ask`, direct tools, and `token --validate` retry once with Browser Tools when available. Set `PPLX_BROWSER_TOOLS_PROFILE` or `CHROME_PROFILE` for a non-default Chrome profile. Set `PPLX_BROWSER_TOOLS_TASK` to use a Browser Tools task profile. Set `PPLX_BROWSER_TOOLS_SYNC=0` only when you intentionally want a cached profile copy. If token lookup fails while normal Chrome is logged in, first verify that Perplexity is logged in in the selected profile.

## Direct model tools

Direct tools are executable scripts in `scripts/`. They use one fixed Pro-tier model and return `answer`, `search_results`, and `conversation_uuid` by default.

| Tool script | Model ID | Purpose |
|---|---|---|
| `scripts/pplx_best` | `perplexity/best` | Auto-selects Perplexity model |
| `scripts/pplx_deep_research` | `perplexity/deep-research` | Deeper research |
| `scripts/pplx_sonar` | `perplexity/sonar-2` | Perplexity Sonar search |
| `scripts/pplx_gpt54` | `openai/gpt-5.4` | GPT 5.4 through Perplexity |
| `scripts/pplx_gpt54_thinking` | `openai/gpt-5.4-thinking` | GPT 5.4 thinking through Perplexity |
| `scripts/pplx_gemini31_pro_think_low` | `google/gemini-3.1-pro-thinking-low` | Gemini thinking, low effort |
| `scripts/pplx_gemini31_pro_think_high` | `google/gemini-3.1-pro-thinking-high` | Gemini thinking, high effort |
| `scripts/pplx_claude_s46` | `anthropic/claude-sonnet-4.6` | Sonnet 4.6 through Perplexity |
| `scripts/pplx_claude_s46_think` | `anthropic/claude-sonnet-4.6-thinking` | Sonnet 4.6 thinking through Perplexity |
| `scripts/pplx_kimi_k26_instant` | `moonshot/kimi-k2.6-instant` | Fast Kimi model |
| `scripts/pplx_kimi_k26_thinking` | `moonshot/kimi-k2.6-thinking` | Kimi thinking model |
| `scripts/pplx_nemotron3_super_think` | `nvidia/nemotron-3-super-thinking` | Nemotron thinking model |

Example:

```bash
scripts/pplx_gpt54_thinking "latest AI infrastructure capex news" \
  --source-focus all \
  --time-range week \
  --format json
```

Direct tool options:

- `query`, required positional text. Use `-` to read stdin.
- `--search-focus web|writing`, default `web`.
- `--source-focus web|academic|social|finance|all`, default `web`.
- `--time-range all|day|week|month|year`, default `all`.
- `--language TAG`, default `en-US`.
- `--latitude FLOAT --longitude FLOAT`, optional and must be passed together.
- `--format json|markdown|answer`, default `json`.
- `--save PATH`, save output to file.
- Shared token and client options: `--token`, `--token-file`, `--no-chrome`, `--timeout`, `--max-retries`, `--auth-retries`, `--requests-per-second`, `--logging-level`, `--log-file`. `--auth-retries` covers transient WebUI 403 and query-processing failures from authenticated requests.

## `models`

Lists exposed Pro-tier models.

```bash
uv run scripts/pplx.py models
uv run scripts/pplx.py models --format json
```

Options:

- `--format table|json`

## `token`

Checks or generates a session token.

```bash
uv run scripts/pplx.py token
uv run scripts/pplx.py token --validate
uv run scripts/pplx.py token --wizard
```

Options:

- `--show`, print token. Only use when explicitly requested.
- `--validate`, make a live read-only auth check without printing the token.
- `--wizard`, run the interactive token wizard.
- `--email EMAIL`, pass email to the wizard.
- Shared token options.

## `ask`

Direct package client. Best default for research because it supports citations, source objects, file uploads, streaming, Spaces, and multi-turn turns in one process.

```bash
uv run scripts/pplx.py ask "question" [options]
```

Options:

- `--model MODEL_ID`, default `perplexity/best`.
- `--system TEXT`, prepended instruction.
- `--file PATH`, repeatable local attachments.
- `--stream`, stream response deltas.
- `--citation-mode clean|markdown|default`.
- `--search-focus web|writing`.
- `--source-focus web|academic|social|finance|all`, repeatable.
- `--time-range all|day|week|month|year`.
- `--language TAG`, default `en-US`.
- `--timezone ZONE`, for example `America/New_York`.
- `--latitude FLOAT --longitude FLOAT`.
- `--space-uuid UUID`.
- `--save-to-library`.
- `--turn TEXT`, repeatable multi-turn prompt.
- `--format answer|markdown|json`, default `markdown`.
- `--include-raw`, include parser raw data in JSON.
- `--save PATH`.
- Shared token and client options.

Models that require Max tier are not exposed by this skill.
