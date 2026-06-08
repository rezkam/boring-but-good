#!/usr/bin/env node
/**
 * tradingeconomics-indicators.mjs - Extract country indicator pages from Trading Economics.
 *
 * Usage:
 *   scripts/tradingeconomics-indicators.mjs --country sweden [--json] [--out <file>] [port] [--owner-token token]
 *   scripts/tradingeconomics-indicators.mjs https://tradingeconomics.com/euro-area/indicators --json
 *   scripts/tradingeconomics-indicators.mjs --list-countries --json
 */

import { pathToFileURL } from 'url';
import { parseOwnerToken, parsePort, stripBrowserSessionArgs } from './browser-control.mjs';
import { runCachedBrowserResource } from './resource-helper.mjs';
import {
  TRADING_ECONOMICS_BASE_URL as BASE_URL,
  buildTradingEconomicsMetadata,
  cleanText,
  extractTradingEconomicsIndicatorTabsPayload,
  extractTradingEconomicsMatrixPayload,
  markdownTable,
  pageTextPreview,
  prepareTradingEconomicsPage,
  slugFromTradingEconomicsUrl,
  slugify,
  titleCase,
} from './tradingeconomics-common.mjs';

const MATRIX_URL = `${BASE_URL}/matrix`;
const rawArgs = process.argv.slice(2);
const ownerToken = parseOwnerToken(rawArgs);
const port = parsePort(rawArgs, rawArgs.find(a => /^\d{4,5}$/.test(a)) || '9222');
const args = stripBrowserSessionArgs(rawArgs, { stripPositionalPort: true });
const outIdx = args.indexOf('--out');
const outFile = outIdx !== -1 ? args[outIdx + 1] : null;
const isJson = args.includes('--json');
const listCountries = args.includes('--list-countries');
const countryInput = parseCountryInput(args);
const cacheInput = listCountries
  ? { source: 'matrix-countries', schema: 1, json: isJson }
  : { source: 'country-indicators', country: countryInput.slug, schema: 1, json: isJson };

export function parseIndicatorTabsPayload(payload) {
  const tabLabels = new Map((payload.tabs || []).map(tab => [tab.id, tab.label]));
  const tabs = [];
  const rows = [];

  for (const tabPayload of payload.tabTables || []) {
    const id = cleanText(tabPayload.id);
    const label = cleanText(tabLabels.get(id) || tabPayload.label || titleCase(id));
    const tabRows = [];

    for (const table of tabPayload.tables || []) {
      const parsedRows = parseIndicatorTableRows(table.rows || [], table.tableIndex || 0);
      tabRows.push(...parsedRows);
    }

    const tab = { id, label, row_count: tabRows.length, rows: tabRows };
    tabs.push(tab);
    for (const row of tabRows) rows.push({ tab: label, tab_id: id, ...row });
  }

  return { tabs, rows };
}

export function parseMatrixCountriesPayload(payload) {
  const headers = (payload.headers || []).map(cleanText);
  const valueHeaders = headers.slice(1);
  const countries = [];

  for (const rawRow of payload.rows || []) {
    const cells = rawRow.cells || [];
    if (cells.length < 2) continue;
    const name = cleanText(cells[0].text);
    const url = cells[0].url || '';
    if (!name || !url.includes('/indicators')) continue;

    const values = {};
    for (let index = 1; index < cells.length && index < headers.length; index += 1) {
      values[headers[index]] = cleanText(cells[index].text);
    }

    countries.push({
      name,
      slug: slugFromTradingEconomicsUrl(url, 'indicators'),
      url,
      values,
      columns: valueHeaders,
    });
  }

  return { countries, columns: valueHeaders };
}

export function formatIndicators(data) {
  let output = `## Trading Economics - ${data.country.name} Indicators\n\n`;
  output += `Source: ${data.url}\n`;
  output += `Captured: ${data.captured_at}\n`;
  output += `Total indicators: ${data.rows.length} across ${data.tabs.length} tabs\n\n`;

  for (const tab of data.tabs) {
    output += `### ${tab.label}\n\n`;
    output += markdownTable(
      ['Indicator', 'Last', 'Previous', 'Highest', 'Lowest', 'Unit', 'Date'],
      tab.rows.map(row => [row.indicator, row.last, row.previous, row.highest, row.lowest, row.unit, row.date]),
    );
    output += '\n';
  }

  return output.trimEnd();
}

export function formatCountryList(data) {
  let output = '## Trading Economics - Indicator Countries\n\n';
  output += `Source: ${data.url}\n`;
  output += `Captured: ${data.captured_at}\n`;
  output += `Total countries: ${data.countries.length}\n\n`;
  output += markdownTable(
    ['Country', 'Slug', 'Indicators URL', 'GDP', 'GDP Growth', 'Interest Rate', 'Inflation Rate', 'Jobless Rate'],
    data.countries.map(country => [
      country.name,
      country.slug,
      country.url,
      country.values.GDP,
      country.values['GDP Growth'],
      country.values['Interest Rate'],
      country.values['Inflation Rate'],
      country.values['Jobless Rate'],
    ]),
  );
  return output;
}

async function main() {
  await runCachedBrowserResource({
    tool: 'tradingeconomics-indicators',
    cacheInput,
    outFile,
    port,
    ownerToken,
    run: async ({ page }) => {
      const result = listCountries ? await extractCountryList(page) : await extractCountryIndicators(page, countryInput);
      const output = isJson ? JSON.stringify(result, null, 2)
        : listCountries ? formatCountryList(result) : formatIndicators(result);
      const metadata = buildMetadata(result, listCountries);
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

async function extractCountryIndicators(page, country) {
  const url = country.url || `${BASE_URL}/${country.slug}/indicators`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await prepareTradingEconomicsPage(page, '.tab-pane table.table-hover, table.table-hover');

  const payload = await extractTradingEconomicsIndicatorTabsPayload(page);

  const parsed = parseIndicatorTabsPayload(payload);
  if (parsed.rows.length === 0) {
    const rawText = await pageTextPreview(page);
    throw new Error(`Could not parse indicators from ${page.url()}. Raw extract: ${rawText}`);
  }

  const pageTitle = await page.title();
  const countryName = pageTitle.replace(/\s+Indicators\s*$/i, '').trim() || titleCase(country.slug);

  return {
    source: 'tradingeconomics-indicators',
    type: 'country-indicators',
    country: {
      name: countryName,
      slug: slugFromTradingEconomicsUrl(page.url(), 'indicators') || country.slug,
      url: page.url(),
    },
    url: page.url(),
    page_title: pageTitle,
    captured_at: new Date().toISOString(),
    ...parsed,
  };
}

async function extractCountryList(page) {
  await page.goto(MATRIX_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await prepareTradingEconomicsPage(page, 'table#matrix');

  const payload = await extractTradingEconomicsMatrixPayload(page);

  const parsed = parseMatrixCountriesPayload(payload);
  if (parsed.countries.length === 0) throw new Error(`Could not parse country list from ${page.url()}`);

  return {
    source: 'tradingeconomics-indicators',
    type: 'country-list',
    url: page.url(),
    page_title: await page.title(),
    captured_at: new Date().toISOString(),
    ...parsed,
  };
}

function parseIndicatorTableRows(rawRows, tableIndex) {
  const rows = [];
  for (const rawRow of rawRows.slice(1)) {
    const cells = rawRow.cells || [];
    if (cells.length < 2) continue;
    const indicator = cleanText(cells[0].text);
    if (!indicator) continue;
    rows.push({
      indicator,
      last: cleanText(cells[1]?.text),
      previous: cleanText(cells[2]?.text),
      highest: cleanText(cells[3]?.text),
      lowest: cleanText(cells[4]?.text),
      unit: cleanText(cells[5]?.text),
      date: cleanText(cells[6]?.text),
      url: cells[0]?.url || '',
      table_index: tableIndex,
    });
  }
  return rows;
}

function parseCountryInput(rawArgs) {
  const countryIdx = rawArgs.indexOf('--country');
  const raw = countryIdx !== -1 ? rawArgs[countryIdx + 1]
    : rawArgs.find(arg => !arg.startsWith('--') && !/^\d{4,5}$/.test(arg) && arg !== outFile);
  const value = cleanText(raw || 'united-states');
  if (/^https?:\/\//i.test(value)) {
    const parsed = new URL(value);
    const slug = slugFromTradingEconomicsUrl(parsed.href, 'indicators') || parsed.pathname.split('/').filter(Boolean)[0];
    return { slug, url: parsed.href };
  }
  return { slug: slugify(value), url: '' };
}

function buildMetadata(result, isCountryList) {
  if (isCountryList) {
    return buildTradingEconomicsMetadata(result, {
      type: 'country-list',
      country_count: result.countries.length,
    });
  }

  return buildTradingEconomicsMetadata(result, {
    type: 'country-indicators',
    country: result.country,
    row_count: result.rows.length,
    tabs: result.tabs.map(tab => ({ id: tab.id, label: tab.label, row_count: tab.row_count })),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error('Error:', e.message); process.exit(1); });
}
