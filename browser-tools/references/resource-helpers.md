# Resource Helpers Reference

Resource Helpers are task-specific scripts. Use them when the user asks for a known workflow that would otherwise require many Browser Control steps.

A Resource Helper can navigate, fetch, extract, format, and cache data for one workflow. It should not own browser lifecycle, Profile Sync behavior, ownership behavior, direct Chrome DevTools connection behavior, cache plumbing, output sidecars, or page cleanup. Browser lifecycle and DevTools safety belong to Browser Control. Shared Resource Helper lifecycle belongs to `scripts/resource-helper.mjs`. Resource Helpers must connect through that module so they refuse another agent's browser, manual sessions, or main Chrome sessions and clean up consistently.

## Task profile preferences

Non-primary helpers can have preferred profiles in the private Browser Tools config. Use these commands to manage them:

```bash
scripts/config.mjs task-profile set tradingeconomics --profile "<Chrome profile folder or local alias>"
scripts/config.mjs task-profile set yahoo-finance --profile "<Chrome profile folder or local alias>"
scripts/config.mjs task-profile list
scripts/start.mjs --task tradingeconomics
export BROWSER_TOOLS_OWNER_TOKEN="<owner token from start output>"
```

The config is stored outside the repo at `~/.agents/browser-tools/config.json` by default. If a helper needs logged-in access and no managed browser is running, start Browser Tools with the matching task name before running the helper. Add `--sync` when current cookies matter or when a previous managed browser looked logged out. Then pass the reported port and owner token, or set `BROWSER_TOOLS_OWNER_TOKEN` in the current agent session.

## Market data helpers

| Script | Purpose | Example |
| --- | --- | --- |
| `scripts/tradingeconomics-markets.mjs` | Trading Economics market pages for commodities, stocks, shares, currencies, and bonds | `scripts/tradingeconomics-markets.mjs --market currencies --out /tmp/currencies.md` |
| `scripts/tradingeconomics-indicators.mjs` | Trading Economics country indicator tabs and matrix country list | `scripts/tradingeconomics-indicators.mjs --country sweden --out /tmp/sweden-indicators.md` |
| `scripts/tradingeconomics-forecasts.mjs` | Trading Economics country forecast pages | `scripts/tradingeconomics-forecasts.mjs --country united-states --json --out /tmp/us-forecast.json` |
| `scripts/tradingeconomics-country-list.mjs` | Trading Economics country-list comparison pages | `scripts/tradingeconomics-country-list.mjs --indicator government-spending-to-gdp --countries "United States,Sweden,Germany" --json` |
| `scripts/yahoo-finance.mjs` | Yahoo quote snapshots | `scripts/yahoo-finance.mjs --tickers "AMZN,BZ=F,^GSPC" --out /tmp/yahoo.md` |
| `scripts/perplexity-finance.mjs` | Perplexity quote snapshots and market overview | `scripts/perplexity-finance.mjs --tickers "AMZN,META,GC=F" --out /tmp/prices.md` |

Default source choice:

- Use Trading Economics for commodity, stock-index, share-treemap, currency, bond, country-indicator, country-forecast, and country-list comparison pages.
- Use `references/tradingeconomics.md` for helper selection and JSON output contracts. Trading Economics helpers share `scripts/tradingeconomics-common.mjs` for overlay removal, table extraction, text cleanup, markdown tables, URL helpers, and metadata.
- Use `scripts/tradingeconomics-indicators.mjs --list-countries` when resolving available indicator countries from the matrix page.
- Use Yahoo Finance for individual equity, index, currency, crypto, and futures quote snapshots when a ticker quote is requested.
- Use Perplexity Finance only for quote snapshots and market overview data.

## Extraction helpers

| Script | Purpose | Example |
| --- | --- | --- |
| `scripts/scrape-page.mjs` | Extract visible article links and timestamps | `scripts/scrape-page.mjs` |
| `scripts/extract-article.mjs` | Extract article body text from current tab | `scripts/extract-article.mjs --chars 6000` |

Use these after Browser Control has navigated to the page.

## Cache behavior

When these environment variables are set, helper scripts use reusable browser-query caching:

- `BROWSER_QUERY_CACHE_DIR`
- `BROWSER_QUERY_RUN_DIR`
- `BROWSER_QUERY_STEP_ID`
- `BROWSER_QUERY_STEP_LABEL`
- `BROWSER_QUERY_TTL_SECONDS`

`scripts/browser-query-cache.mjs` owns cache keys, cache entries, raw response files, and per-run invocation JSON files. `scripts/resource-helper.mjs` owns the common cache read/write flow for Resource Helpers.

## Adding a new Resource Helper

1. Put the executable script in `scripts/`.
2. Reuse `scripts/resource-helper.mjs` for browser connection, cache lookup and write, output sidecars, page cleanup, and disconnect behavior.
3. Keep Browser Control details behind `scripts/browser-control.mjs`. Do not import Puppeteer or connect to Chrome DevTools directly.
4. For Trading Economics helpers, reuse `scripts/tradingeconomics-common.mjs` instead of copying page overlay, table extraction, text cleanup, markdown, slug, or metadata logic.
5. Open dedicated tabs with `browser.newPage({ background: true })` so helpers do not steal OS focus. Do not call `page.bringToFront()` unless the user explicitly asks to see or interact with the tab.
6. Use `runCachedBrowserResource` when the helper performs reusable queries. Use `runBrowserResource` for current-tab extractors that should not cache.
7. Keep stdout as the useful result. Send progress and diagnostics to stderr.
8. Document the helper in this file and add only a short pointer in `SKILL.md`.
