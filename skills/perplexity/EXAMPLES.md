# Perplexity Examples

## Current-news research with GPT thinking model

```bash
uv run scripts/pplx.py ask \
  "What are the latest important developments about the Iran war? Give confirmed facts, uncertainties, and sources." \
  --model openai/gpt-5.4-thinking \
  --time-range week \
  --source-focus all \
  --citation-mode markdown \
  --format markdown
```

## Direct model tool

```bash
scripts/pplx_gpt54_thinking \
  "Research the latest AI infrastructure capex news" \
  --source-focus all \
  --time-range week \
  --format json
```

## Save full structured result

```bash
uv run scripts/pplx.py ask \
  "Research the latest export controls affecting Nvidia chips" \
  --model openai/gpt-5.4-thinking \
  --time-range week \
  --source-focus all \
  --citation-mode markdown \
  --format json \
  --include-raw \
  --save /tmp/perplexity-export-controls.json
```

## Stream a response

```bash
uv run scripts/pplx.py ask "Explain this week's oil market moves" \
  --model perplexity/sonar-2 \
  --time-range week \
  --stream \
  --format answer
```

## Multi-turn conversation in one process

```bash
uv run scripts/pplx.py ask \
  --model openai/gpt-5.4-thinking \
  --citation-mode markdown \
  --turn "Find the latest news about Red Sea shipping risk." \
  --turn "Now focus only on insurance and freight-rate impact." \
  --format json
```

## Analyze attached files

```bash
uv run scripts/pplx.py ask "Summarize this PDF and list open questions" \
  --file ~/Downloads/report.pdf \
  --model perplexity/best \
  --format markdown
```
