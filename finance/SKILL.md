---
name: finance
description: "Fetch market and macroeconomic data through browser-authenticated finance sources using Browser Tools managed Chrome. Use this skill whenever the user asks for prices, tickers, commodities, stock indexes, currencies, bonds, market snapshots, Yahoo Finance quotes, Perplexity Finance, Trading Economics, country indicators, forecasts, country-list comparisons, GDP, inflation, unemployment, debt, government spending, or other finance or macro data. Prefer this over generic browser scraping for finance questions."
compatibility: "Requires the browser-tools skill as a sibling checkout, Node.js 20+, Browser Tools npm dependencies, and network access. Some providers need a logged-in Chrome profile copied by Browser Tools."
---

# Finance

Finance is the specialist skill for market and macroeconomic data. It depends on Browser Tools for managed Chrome, owner-token safety, copied profile sync, background tabs, cache flow, and cleanup. Keep Browser Tools generic. Do not add finance-specific helpers back to Browser Tools.

## Source choice

| User asks for | Prefer | Why |
| --- | --- | --- |
| Ticker quote snapshots for equities, futures, indexes, FX, crypto | `scripts/yahoo-finance.mjs` | Fast quote API through the browser session |
| Perplexity finance quote snapshots or market overview | `scripts/perplexity-finance.mjs` | Uses Perplexity Finance authenticated browser API |
| Commodities, stock indexes, share treemap, currencies, bonds | `scripts/tradingeconomics-markets.mjs` | Broad Trading Economics market pages |
| Country indicator dashboards or available countries | `scripts/tradingeconomics-indicators.mjs` | Country tabs and `/matrix` country table |
| Country forecast pages | `scripts/tradingeconomics-forecasts.mjs` | Full Trading Economics forecast sections |
| Cross-country macro comparison | `scripts/tradingeconomics-country-list.mjs` | Trading Economics `/country-list/<indicator>` tables |

Read [references/tradingeconomics.md](references/tradingeconomics.md) for Trading Economics routing, input rules, and JSON contracts.

## Browser Tools dependency

Start a Browser Tools managed browser first when a helper needs live browser access. Use the sibling Browser Tools `start.mjs` command with `--task finance --sync`, then export the owner token it prints.

Use `--sync` when current cookies matter or a provider looks logged out. Use the reported `--port` when Browser Tools did not use the default port.

Finance helpers import Browser Tools at runtime from the sibling `browser-tools` skill. They do not own Chrome lifecycle, profile discovery, cache directories, or DevTools safety.

## Commands

```bash
# Yahoo quote snapshot
scripts/yahoo-finance.mjs --tickers "AMZN,BZ=F,^GSPC" --json --port <reported port>

# Perplexity Finance
scripts/perplexity-finance.mjs --tickers "AMZN,META,GC=F" --json --port <reported port>
scripts/perplexity-finance.mjs --market --json --port <reported port>

# Trading Economics markets
scripts/tradingeconomics-markets.mjs --market commodities --json --port <reported port>
scripts/tradingeconomics-markets.mjs --market currencies --json --port <reported port>

# Trading Economics country and comparison data
scripts/tradingeconomics-indicators.mjs --country sweden --json --port <reported port>
scripts/tradingeconomics-indicators.mjs --list-countries --json --port <reported port>
scripts/tradingeconomics-forecasts.mjs --country united-states --json --port <reported port>
scripts/tradingeconomics-country-list.mjs --indicator government-spending-to-gdp --countries "United States,Sweden,Germany" --json --port <reported port>
```

## Operating rules

- Use Browser Tools managed Chrome only. Never connect to main Chrome or unmanaged DevTools sessions.
- Pass the owner token through `--owner-token <token>` or `BROWSER_TOOLS_OWNER_TOKEN`.
- Prefer helper scripts over manual page scraping because they already handle background tabs, output sidecars, cache, and source-specific extraction.
- Use `--json` for Trading Economics tasks and return a JSON object to the user.
- Include `source`, `captured_at`, source URL, row counts or coverage, missing country information, and any provider errors in the final answer.
- If the full output is too large, save it to `/tmp/...json` and return `full_json_path` plus a compact summary.
- Stop Browser Tools with its sibling `stop.mjs` command and `--clean --port <reported port> --owner-token <token>` if you started it for the task.

## Local config and cache

Browser Tools owns local directories and profile discovery. Defaults work out of the box:

- Config: `~/.agents/browser-tools/config.json`
- Browser cache and copied profiles: `~/.cache/pi-browser-tools`
- Artifacts: `/tmp` unless `directories.artifactDir` is configured

Users can change directories, Chrome binary, source Chrome profile location, aliases, and task profiles in the Browser Tools config. Finance should not store profile mappings in this repo.
