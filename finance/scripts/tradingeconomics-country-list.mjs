#!/usr/bin/env node
/**
 * tradingeconomics-country-list.mjs - Extract Trading Economics country-list comparison pages.
 *
 * Usage:
 *   scripts/tradingeconomics-country-list.mjs --indicator government-spending-to-gdp --countries "United States,Sweden,Germany" --json
 *   scripts/tradingeconomics-country-list.mjs https://tradingeconomics.com/country-list/inflation-rate --json [--owner-token token]
 */

import { pathToFileURL } from 'url';
import { loadBrowserToolsRuntime, optionValue, parseBrowserSessionArgs } from './browser-tools-runtime.mjs';
import {
  TRADING_ECONOMICS_BASE_URL as BASE_URL,
  buildTradingEconomicsMetadata,
  cleanText,
  extractTradingEconomicsCountryTablePayload,
  markdownTable,
  normalizeCountryName,
  pageTextPreview,
  prepareTradingEconomicsPage,
  slugify,
  titleCase,
} from './tradingeconomics-common.mjs';

export function parseCountryListTablePayload(payload, countryFilter = []) {
  const headers = (payload.headers || []).map(cleanText);
  const wanted = new Set(countryFilter.map(normalizeCountryName));
  const rows = [];

  for (const rawRow of payload.rows || []) {
    const cells = rawRow.cells || [];
    if (cells.length === 0) continue;
    const row = {
      country: cleanText(cells[0]?.text),
      url: cells[0]?.url || '',
      values: {},
    };
    if (!row.country) continue;
    if (wanted.size > 0 && !wanted.has(normalizeCountryName(row.country))) continue;

    for (let index = 1; index < cells.length && index < headers.length; index += 1) {
      const header = headers[index];
      if (header) row.values[header] = cleanText(cells[index]?.text);
    }
    rows.push(row);
  }

  return { headers, rows };
}

export function formatCountryListComparison(data) {
  let output = `## Trading Economics - ${data.indicator.name}\n\n`;
  output += `Source: ${data.url}\n`;
  output += `Captured: ${data.captured_at}\n`;
  output += `Rows: ${data.rows.length}`;
  if (data.country_filter.length > 0) output += `, filtered from ${data.total_rows_available} available countries`;
  output += '\n\n';

  const columns = ['Country', ...data.headers.slice(1)];
  output += markdownTable(
    columns,
    data.rows.map(row => [row.country, ...data.headers.slice(1).map(header => row.values[header] || '')]),
  );
  return output;
}

async function main() {
  const browserTools = await loadBrowserToolsRuntime();
  const rawArgs = process.argv.slice(2);
  const { ownerToken, port, args } = parseBrowserSessionArgs(rawArgs, browserTools);
  const isJson = args.includes('--json');
  const outFile = optionValue(args, '--out');
  const indicatorInput = parseIndicatorInput(args, outFile);
  const countries = parseCountries(args);
  const cacheInput = { source: 'country-list', indicator: indicatorInput.slug, countries, schema: 1, json: isJson };

  await browserTools.runCachedBrowserResource({
    tool: 'tradingeconomics-country-list',
    cacheInput,
    outFile,
    port,
    ownerToken,
    run: async ({ page }) => {
      const result = await extractCountryList(page, indicatorInput, countries);
      const output = isJson ? JSON.stringify(result, null, 2) : formatCountryListComparison(result);
      const metadata = buildTradingEconomicsMetadata(result, {
        indicator: result.indicator,
        row_count: result.rows.length,
        country_filter: result.country_filter,
        total_rows_available: result.total_rows_available,
      });
      return {
        output,
        rawText: output,
        pageUrl: result.url,
        metadata,
        extension: isJson ? 'json' : 'md',
      };
    },
  });
}

async function extractCountryList(page, indicator, countryFilter) {
  await page.goto(indicator.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await prepareTradingEconomicsPage(page, 'table', { includeSubscribe: true });

  const payload = await extractTradingEconomicsCountryTablePayload(page);

  const allRows = parseCountryListTablePayload(payload, []);
  const filtered = parseCountryListTablePayload(payload, countryFilter);
  const missing = countryFilter.filter(country => !filtered.rows.some(row => normalizeCountryName(row.country) === normalizeCountryName(country)));

  if (filtered.rows.length === 0) {
    const rawText = await pageTextPreview(page);
    throw new Error(`Could not parse country list from ${page.url()}. Raw extract: ${rawText}`);
  }

  return {
    source: 'tradingeconomics-country-list',
    type: 'country-list-comparison',
    indicator: {
      name: pageTitleToIndicator(await page.title(), indicator.slug),
      slug: indicator.slug,
    },
    url: page.url(),
    page_title: await page.title(),
    captured_at: new Date().toISOString(),
    headers: filtered.headers,
    country_filter: countryFilter,
    missing_countries: missing,
    row_count: filtered.rows.length,
    total_rows_available: allRows.rows.length,
    rows: filtered.rows,
  };
}

function parseIndicatorInput(rawArgs, outFile = null) {
  const indicatorIdx = rawArgs.indexOf('--indicator');
  const raw = indicatorIdx !== -1 ? rawArgs[indicatorIdx + 1]
    : rawArgs.find(arg => !arg.startsWith('--') && !/^\d{4,5}$/.test(arg) && arg !== outFile);
  const value = cleanText(raw || 'government-spending-to-gdp');
  if (/^https?:\/\//i.test(value)) {
    const parsed = new URL(value);
    const slug = parsed.pathname.split('/').filter(Boolean).at(-1) || '';
    return { slug, url: parsed.href };
  }
  const slug = slugify(value);
  return { slug, url: `${BASE_URL}/country-list/${slug}` };
}

function parseCountries(rawArgs) {
  const countriesIdx = rawArgs.indexOf('--countries');
  if (countriesIdx === -1) return [];
  return cleanText(rawArgs[countriesIdx + 1]).split(',').map(cleanText).filter(Boolean);
}

function pageTitleToIndicator(title, slug) {
  return cleanText(title).replace(/\s+by Country\s*$/i, '') || titleCase(slug);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error('Error:', e.message); process.exit(1); });
}
