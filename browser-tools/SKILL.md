---
name: browser-tools
description: "Control a sandboxed Chrome browser with a copied profile, including launch, stop, navigation, page evaluation, screenshots, DOM picking, local profile configuration, and supported market data helpers. Use this skill whenever the user asks to open or inspect a website, scrape a page, use logged-in browser sessions, or fetch supported market data through Yahoo Finance, Trading Economics, or Perplexity Finance."
compatibility: "Requires macOS Chrome, Node.js 20+, npm dependencies from package.json, and network access for browser automation."
---

# Browser Tools

Browser Tools has two layers:

1. **Browser Control**: the core capability for controlling the sandboxed Chrome browser.
2. **Resource Helpers**: task-specific scripts that use Browser Control for known workflows such as market data and article extraction.

Use Browser Control first when the task is general browser work. Use Resource Helpers when the user asks for a supported resource workflow.

## Quick start

```bash
scripts/start.mjs
export BROWSER_TOOLS_OWNER_TOKEN="<owner token from start output>"
scripts/nav.mjs https://example.com --port <reported port>
scripts/eval.mjs 'document.title' --port <reported port>
scripts/screenshot.mjs --full --port <reported port>
scripts/stop.mjs --port <reported port>
```

All executable scripts live under `scripts/`. There are no root-level compatibility wrappers.

## Trading Economics data

Trading Economics is the default source in this skill for broad market pages and macroeconomic country data. Use it when the user asks about commodity prices, stock indexes, share treemaps, currencies, bonds, country indicators, country forecasts, available countries, or country-to-country comparisons such as inflation, government spending, debt, GDP, or unemployment.

For Trading Economics tasks, read [tradingeconomics.md](references/tradingeconomics.md) before choosing a helper. That reference owns the detailed capability map, accepted inputs, helper commands, overlay handling, and JSON output contracts. The final answer for these tasks should be a JSON object.

## Browser Control

Use Browser Control for launch, stop, navigation, page JavaScript, screenshots, and DOM picking.

| Task | Script |
| --- | --- |
| Configure private Browser Tools config | `scripts/config.mjs profiles`, `scripts/config.mjs active-profiles`, `scripts/config.mjs task-profile set tradingeconomics --profile "<alias>"` |
| Start Chrome | `scripts/start.mjs`, `scripts/start.mjs --profile "<Chrome profile folder or local alias>"`, or `scripts/start.mjs --task tradingeconomics` |
| Stop Chrome | `scripts/stop.mjs --clean --owner-token "<token>"` |
| Navigate | `scripts/nav.mjs https://example.com` |
| Evaluate JavaScript | `scripts/eval.mjs 'document.title'` |
| Screenshot | `scripts/screenshot.mjs --full` |
| Pick DOM element | `scripts/pick.mjs "Click the price"` |

Read [browser-control.md](references/browser-control.md) when you need profile names, private config behavior, port behavior, DOM picking controls, or implementation details.

## Resource Helpers

Resource Helpers are not the base skill. They are optional capabilities for specific resources and workflows.

| Workflow | Script |
| --- | --- |
| Market data from Yahoo Finance | `scripts/yahoo-finance.mjs` |
| Trading Economics data suite, see [tradingeconomics.md](references/tradingeconomics.md) | `scripts/tradingeconomics-markets.mjs`, `scripts/tradingeconomics-indicators.mjs`, `scripts/tradingeconomics-forecasts.mjs`, `scripts/tradingeconomics-country-list.mjs` |
| Market overview from Perplexity Finance | `scripts/perplexity-finance.mjs` |
| Article link extraction | `scripts/scrape-page.mjs` |
| Article body extraction | `scripts/extract-article.mjs` |

Read [resource-helpers.md](references/resource-helpers.md) when choosing a Resource Helper or adding a new one. Read [tradingeconomics.md](references/tradingeconomics.md) for Trading Economics input rules, helper selection, overlay handling, and JSON output contracts.

## Defaults

- Start with `scripts/start.mjs` for a fresh browser. Add `--profile "<Chrome profile folder or local alias>"` only when logged-in browser access is needed. Use `--task <task>` to start with the configured profile for a non-primary helper task. For workflows that depend on current cookies or login state, start with `--sync` or restart with `--sync` after any login mismatch.
- If the default port is busy, `scripts/start.mjs` auto-allocates another port and creates a separate per-port sandbox profile copy. Use the reported port for follow-up commands.
- Each start owns the browser with an owner token. Use the printed token through `--owner-token <token>` or `BROWSER_TOOLS_OWNER_TOKEN` for all follow-up commands. Scripts refuse to connect to or stop a browser when the owner token is missing or wrong.
- Use `--port` consistently after start when more than one browser instance is running.
- Prefer Browser Control for unknown sites and Resource Helpers for known workflows.
- For Trading Economics tasks, use the documented helper with `--json` and return a JSON object to the user. Save very large full outputs to `/tmp/...json` and include that path in the JSON answer.
- Open new browser tabs in the background with `browser.newPage({ background: true })` so automation does not steal OS focus from the user. Do not call `page.bringToFront()` unless the user explicitly asks to see or interact with that tab.
- Send useful result data to stdout. Treat stderr as progress and diagnostics.

## Gotchas

- Private profile labels, account names, active-profile cache, aliases, and task profile preferences belong in `~/.agents/browser-tools/config.json`, never in this repo. `scripts/config.mjs profiles` creates or refreshes the profiles section from Chrome `Local State`. `scripts/config.mjs active-profiles` shows Chrome's last-active profiles. `scripts/config.mjs task-profile set <task> --profile "<alias>"` remembers which profile to use for a non-primary helper task.
- The sandboxed Chrome profile is a per-port copy in `~/.cache/pi-browser-tools`, not the live Chrome profile.
- A copied profile can be stale. If a site where the live Chrome profile is logged in opens as logged out, the fix is usually: stop the managed browser with the owner token and `--clean`, then start again with the same profile plus `--sync`. Do this before trusting scraped account data, empty inboxes, follower counts, or provider auth errors.
- Managed Chrome keeps copied profile extensions, extension payloads, and extension state so the sandbox resembles the original profile. Chrome sync stays disabled so the sandbox does not sync mutations back through the browser account.
- `scripts/stop.mjs` only stops a managed Chrome process launched by `scripts/start.mjs` when the owner token matches. It refuses to kill the main Chrome, another agent's browser, or any reused/manual browser process. Use `scripts/stop.mjs --dry-run --owner-token <token>` before stop operations when safety matters.
- `scripts/pick.mjs` is Browser Control because it is general DOM selection, not a resource workflow.
- Resource Helpers should reuse `scripts/resource-helper.mjs` instead of reimplementing cache lookup, browser connection, output sidecars, page cleanup, or disconnect behavior. That module uses `scripts/browser-control.mjs` for Browser Control safety. Trading Economics Resource Helpers should reuse `scripts/tradingeconomics-common.mjs` for overlay removal, table extraction, text cleanup, markdown tables, slug helpers, and metadata.
- Some Resource Helpers need an already started Browser Tools managed browser. If connection fails, start Chrome first with `scripts/start.mjs`, then pass the reported port and owner token. Resource Helpers must not connect to another agent's browser, a manual browser, or the main Chrome DevTools session.
