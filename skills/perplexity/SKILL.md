---
name: perplexity
description: Search, research, chat, and analyze files through Perplexity WebUI. Use when the user asks to use Perplexity, Perplexity WebUI, GPT thinking models through Perplexity, current-news research, cited web research, source-focused search, or file analysis.
compatibility: Requires uv, npm dependencies installed from package.json, internet access, a Perplexity Pro account, macOS Chrome, and a logged-in copied Chrome profile or explicit session token. Browser Tools is provided by @rezkam/browser-tools.
---

# Perplexity

Use the bundled scripts for all Perplexity work. Max-tier models are removed.

## Setup

Install the Browser Tools dependency declared in `package.json`:

```bash
npm ci
```

## Token safety

Never print or store the session token unless the user explicitly asks. Scripts read tokens from `--token`, `--token-file`, Browser Tools copied Chrome profile, `PERPLEXITY_SESSION_TOKEN`, or `PPLX_SESSION_TOKEN`. Browser Tools extraction starts a synced sandbox copy of the `Default` Chrome profile, navigates to Perplexity, and reads the session cookie through DevTools. Set `PPLX_BROWSER_TOOLS_PROFILE` or `CHROME_PROFILE` for another profile, or `PPLX_BROWSER_TOOLS_TASK` for a Browser Tools task profile. Commands retry transient WebUI 403 and query-processing failures according to `--auth-retries`. If an environment or token-file token is expired, commands retry once with Browser Tools when available. If token extraction fails but normal Chrome is logged in, verify the login is in the selected profile before trying another auth path.

## Quick research

Run from the Perplexity skill directory:

```bash
uv run scripts/pplx.py ask "latest verified news about Iran war" \
  --model openai/gpt-5.4-thinking \
  --time-range week \
  --source-focus all \
  --citation-mode markdown \
  --format markdown
```

## Direct model tools

Each direct tool is an executable script named for the tool. They all accept `query`, `--search-focus`, `--source-focus`, `--time-range`, `--language`, `--latitude`, `--longitude`, `--format`, and `--save`.

```bash
scripts/pplx_gpt54_thinking "research question" --source-focus all --time-range week
```

Available direct tools:

- `scripts/pplx_best`
- `scripts/pplx_deep_research`
- `scripts/pplx_sonar`
- `scripts/pplx_gpt54`
- `scripts/pplx_gpt54_thinking`
- `scripts/pplx_gemini31_pro_think_low`
- `scripts/pplx_gemini31_pro_think_high`
- `scripts/pplx_claude_s46`
- `scripts/pplx_claude_s46_think`
- `scripts/pplx_kimi_k26_instant`
- `scripts/pplx_kimi_k26_thinking`
- `scripts/pplx_nemotron3_super_think`

## General commands

```bash
uv run scripts/pplx.py models                         # list exposed model IDs and direct tools
uv run scripts/pplx.py token                          # check token availability without printing it
uv run scripts/pplx.py token --validate               # live read-only auth check without printing it
uv run scripts/pplx.py ask "question"                 # direct client, sources, files, streaming, Spaces, multi-turn
```

## When to use which path

- Use direct model tools when the user asks for a specific tool capability by name.
- Use `ask` for normal agent work, current-news research, citations, source lists, file uploads, streaming, Spaces, and multi-turn turns in one process.

More options and examples are in [REFERENCE.md](REFERENCE.md) and [EXAMPLES.md](EXAMPLES.md).
