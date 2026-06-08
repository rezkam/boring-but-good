# Trading Economics Helpers

Trading Economics is a source for market snapshots and macroeconomic datasets. Use these helpers whenever the user asks for Trading Economics market data, commodity prices, stock indexes, currency or bond tables, share treemaps, country indicators, forecasts, matrix countries, or country comparisons.

Prefer the helper scripts over ad hoc browser evaluation because they already handle background tabs, overlay removal, parsing, metadata, and browser-query caching. Shared Trading Economics page behavior lives in `scripts/tradingeconomics-common.mjs` so page changes are fixed in one place.

## Capability map

These are the question types this skill can answer from Trading Economics:

| Question type | Examples | Coverage |
| --- | --- | --- |
| Latest commodity prices | "What is WTI now?", "Give me all energy and metals prices" | Full `/commodities` page, grouped by Energy, Metals, Agricultural, Industrial, Livestock, Index, Electricity |
| Broad market pages | "Get currencies", "Get bond yields", "Scan stock indexes" | `/stocks`, `/shares`, `/currencies`, `/bonds`, `/commodities` |
| Share treemap and movers | "What are the US share movers?", "Extract the shares page" | Inline page treemap JSON plus top gainers and top losers |
| Country indicator dashboards | "Get Sweden indicators", "Extract all tabs for Euro Area" | All indicator tabs present in the DOM, including optional Energy and Health tabs when present |
| Country forecast dashboards | "Get United States forecast", "Extract all forecast sections" | Markets, Overview, GDP, Labour, Prices, Money, Trade, Business, Consumer, Housing, Energy, Government, when present |
| Matrix countries | "Which countries are available?", "Is Euro Area available?" | `/matrix` country table with indicator links and core macro columns |
| Country-list comparisons | "Compare government spending to GDP across these countries" | Any `/country-list/<indicator>` table, optionally filtered by country names |

If the user asks a Trading Economics question that fits one of these types, use the matching helper and return JSON.

## Operating rules

1. Start a managed browser with `scripts/start.mjs` if one is not already running. Keep the reported port and owner token for the helper commands.
2. Use helper commands with `--json` for Trading Economics tasks. The final answer to the user should be a JSON object.
3. Open any new tab in the background. Helper scripts use `browser.newPage({ background: true })` and must not call `page.bringToFront()` unless the user explicitly asks to interact with the tab.
4. Remove cookie or subscription overlays only when they block extraction. The helpers remove consent and `subscribe-prompt` style overlays before parsing.
5. Prefer structured page data where available. Currently `shares` uses inline treemap JSON. Other Trading Economics pages are parsed from DOM tables because no stable public JSON table endpoint was observed. Reuse `scripts/tradingeconomics-common.mjs` for table payload extraction, overlay removal, text cleanup, markdown tables, slug helpers, and common metadata.
6. Stop the managed browser with `scripts/stop.mjs --clean --port <reported port> --owner-token <token>` after the work if you started it for the task.
7. Include `source`, `captured_at`, row counts, and missing country or filter information in the final JSON.

Helper examples below assume `BROWSER_TOOLS_OWNER_TOKEN` is set in the current agent session. Add `--port <reported port>` when the browser is not using the default port.

## Helper selection

All Trading Economics specific routing lives here. The main `SKILL.md` should only point to this reference and describe the high-level capability.

| User asks for | Helper | Example |
| --- | --- | --- |
| Commodity prices, including WTI, Brent, metals, agriculture, industrials, livestock, indexes, electricity | `scripts/tradingeconomics-markets.mjs` | `scripts/tradingeconomics-markets.mjs --market commodities --json` |
| Stock indexes by region | `scripts/tradingeconomics-markets.mjs` | `scripts/tradingeconomics-markets.mjs --market stocks --json` |
| US share treemap, top gainers, top losers | `scripts/tradingeconomics-markets.mjs` | `scripts/tradingeconomics-markets.mjs --market shares --json` |
| Currencies by region | `scripts/tradingeconomics-markets.mjs` | `scripts/tradingeconomics-markets.mjs --market currencies --json` |
| Government bond yields by region | `scripts/tradingeconomics-markets.mjs` | `scripts/tradingeconomics-markets.mjs --market bonds --json` |
| Country indicators tabs | `scripts/tradingeconomics-indicators.mjs` | `scripts/tradingeconomics-indicators.mjs --country sweden --json` |
| Available indicator countries from matrix | `scripts/tradingeconomics-indicators.mjs` | `scripts/tradingeconomics-indicators.mjs --list-countries --json` |
| Country forecast page | `scripts/tradingeconomics-forecasts.mjs` | `scripts/tradingeconomics-forecasts.mjs --country united-states --json` |
| Country-list comparison page | `scripts/tradingeconomics-country-list.mjs` | `scripts/tradingeconomics-country-list.mjs --indicator government-spending-to-gdp --countries "United States,Sweden,Germany" --json` |

## Input rules

- If the user gives a direct Trading Economics URL, choose the helper by URL shape:
  - `/commodities`, `/stocks`, `/shares`, `/currencies`, `/bonds` use `tradingeconomics-markets.mjs`.
  - `/<country>/indicators` uses `tradingeconomics-indicators.mjs`.
  - `/<country>/forecast` uses `tradingeconomics-forecasts.mjs`.
  - `/country-list/<indicator>` uses `tradingeconomics-country-list.mjs`.
  - `/matrix` uses `tradingeconomics-indicators.mjs --list-countries`.
- Country inputs can be slugs (`united-states`, `euro-area`), human names (`United States`), or full URLs for indicator and forecast helpers.
- Market input must be one of: `commodities`, `stocks`, `shares`, `currencies`, `bonds`. `stocks` also accepts `indexes` and `indices`.
- Country-list input can be a slug after `--indicator`, a human-ish indicator name that slugifies cleanly, or a full `https://tradingeconomics.com/country-list/...` URL.
- Country filters use exact display names separated by commas. Report any `missing_countries` from the helper output.

## Output contracts

### Market pages

`tradingeconomics-markets.mjs --json` returns:

```json
{
  "source": "tradingeconomics-markets",
  "market": "commodities",
  "url": "https://tradingeconomics.com/commodities",
  "captured_at": "...",
  "categories": [
    {
      "category": "Energy",
      "columns": ["Price", "Day", "%", "Weekly", "Monthly", "YTD", "YoY", "Date"],
      "rows": [
        {
          "name": "Crude Oil",
          "unit": "USD/Bbl",
          "values": {"Price": "101.163", "%": "-1.00%"},
          "url": "https://tradingeconomics.com/commodity/crude-oil"
        }
      ]
    }
  ],
  "rows": []
}
```

### Country indicators

`tradingeconomics-indicators.mjs --json` returns:

```json
{
  "source": "tradingeconomics-indicators",
  "type": "country-indicators",
  "country": {"name": "Sweden", "slug": "sweden", "url": "..."},
  "tabs": [
    {
      "id": "overview",
      "label": "Overview",
      "row_count": 20,
      "rows": [
        {"indicator": "Inflation Rate", "last": "-0.1", "previous": "0.5", "unit": "percent", "date": "Apr/26"}
      ]
    }
  ],
  "rows": []
}
```

### Country forecasts

`tradingeconomics-forecasts.mjs --json` returns sections with periods such as `Actual`, `Q2/26`, `Q3/26`, `Q4/26`, `Q1/27`:

```json
{
  "source": "tradingeconomics-forecasts",
  "type": "country-forecasts",
  "country": {"name": "United States", "slug": "united-states", "url": "..."},
  "section_count": 12,
  "total_rows": 155,
  "sections": [
    {
      "section": "GDP",
      "periods": ["Actual", "Q2/26", "Q3/26", "Q4/26", "Q1/27"],
      "rows": [
        {"indicator": "GDP Growth Rate", "unit": "%", "values": {"Actual": "2.00", "Q2/26": "1.1"}}
      ]
    }
  ]
}
```

### Country-list comparisons

`tradingeconomics-country-list.mjs --json` returns:

```json
{
  "source": "tradingeconomics-country-list",
  "type": "country-list-comparison",
  "indicator": {"name": "Government Spending to GDP", "slug": "government-spending-to-gdp"},
  "country_filter": ["United States", "Sweden"],
  "missing_countries": [],
  "rows": [
    {"country": "Sweden", "values": {"Last": "49.9", "Previous": "50.5", "Reference": "Dec/25", "Unit": "%"}}
  ]
}
```

## Final answer pattern

Return a JSON object. Keep it small enough for the user to read, but do not hide important coverage metadata.

```json
{
  "source": "...",
  "captured_at": "...",
  "browser_closed": true,
  "query": {"...": "..."},
  "coverage": {"sections": 12, "rows": 155},
  "data": [],
  "observations": []
}
```

If the full helper output is too large, save it to `/tmp/...json` and include `full_json_path` plus a summarized `data` array in the final JSON.
