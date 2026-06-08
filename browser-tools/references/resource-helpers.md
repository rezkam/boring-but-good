# Generic Page Extraction Reference

Browser Tools includes only generic browser extraction helpers. Domain-specific workflows, such as finance data, should live in specialist skills and call Browser Tools for managed Chrome.

## Extraction helpers

| Script | Purpose | Example |
| --- | --- | --- |
| `scripts/scrape-page.mjs` | Extract visible links and timestamps from the current page | `scripts/scrape-page.mjs --port <reported port>` |
| `scripts/extract-article.mjs` | Extract article body text from the current page | `scripts/extract-article.mjs --chars 6000 --port <reported port>` |

Use these after Browser Control has navigated to the page.

## Cache behavior

When these environment variables are set, generic extraction helpers use reusable browser-query caching:

- `BROWSER_QUERY_CACHE_DIR`
- `BROWSER_QUERY_RUN_DIR`
- `BROWSER_QUERY_STEP_ID`
- `BROWSER_QUERY_STEP_LABEL`
- `BROWSER_QUERY_TTL_SECONDS`

`scripts/browser-query-cache.mjs` owns cache keys, cache entries, raw response files, and per-run invocation JSON files. `scripts/resource-helper.mjs` owns the common cache read/write flow for generic extractors.

## Adding a generic extractor

1. Put the executable script in `scripts/`.
2. Reuse `scripts/resource-helper.mjs` for browser connection, cache lookup and write, output sidecars, page cleanup, and disconnect behavior.
3. Keep Browser Control details behind `scripts/browser-control.mjs`. Do not import Puppeteer or connect to Chrome DevTools directly.
4. Open dedicated tabs with `browser.newPage({ background: true })` so helpers do not steal OS focus. Do not call `page.bringToFront()` unless the user explicitly asks to see or interact with the tab.
5. Use `runCachedBrowserResource` when the helper performs reusable queries. Use `runBrowserResource` for current-tab extractors that should not cache.
6. Keep stdout as the useful result. Send progress and diagnostics to stderr.
7. If the helper is domain-specific, create or update the specialist skill instead of adding it here.
