#!/usr/bin/env node
/**
 * tradingeconomics-forecasts.mjs - Extract country forecast pages from Trading Economics.
 *
 * Usage:
 *   scripts/tradingeconomics-forecasts.mjs --country united-states --json [--out <file>] [port] [--owner-token token]
 *   scripts/tradingeconomics-forecasts.mjs https://tradingeconomics.com/sweden/forecast --json
 */

import { pathToFileURL } from 'url';
import { loadBrowserToolsRuntime, optionValue, parseBrowserSessionArgs } from './browser-tools-runtime.mjs';
import {
  TRADING_ECONOMICS_BASE_URL as BASE_URL,
  buildTradingEconomicsMetadata,
  cleanText,
  extractTradingEconomicsForecastTablesPayload,
  markdownTable,
  pageTextPreview,
  prepareTradingEconomicsPage,
  slugFromTradingEconomicsUrl,
  slugify,
  splitNameUnit,
  titleCase,
} from './tradingeconomics-common.mjs';

export function parseForecastTablesPayload(payload) {
  const sections = [];
  const rows = [];

  for (const table of payload.tables || []) {
    const headers = (table.headers || []).map(cleanText).filter((_, index) => index < (table.headers || []).length);
    if (headers.length < 2) continue;
    const section = cleanText(headers[0]);
    const periods = headers.slice(1);
    const sectionRows = [];

    for (const rawRow of table.rows || []) {
      const cells = rawRow.cells || [];
      if (cells.length < 2) continue;
      const firstCell = cells[0];
      const parsed = splitNameUnit(firstCell.text);
      if (!parsed.indicator) continue;

      const values = {};
      for (let index = 0; index < periods.length; index += 1) {
        values[periods[index]] = cleanText(cells[index + 1]?.text);
      }

      const row = {
        section,
        indicator: parsed.indicator,
        unit: parsed.unit,
        values,
        url: firstCell.url || '',
      };
      sectionRows.push(row);
      rows.push(row);
    }

    if (section && sectionRows.length > 0) {
      sections.push({ section, table_index: table.tableIndex, periods, row_count: sectionRows.length, rows: sectionRows });
    }
  }

  return { sections, rows };
}

export function formatForecasts(data) {
  let output = `## Trading Economics - ${data.country.name} Forecast\n\n`;
  output += `Source: ${data.url}\n`;
  output += `Captured: ${data.captured_at}\n`;
  output += `Total rows: ${data.total_rows} across ${data.section_count} sections\n\n`;

  for (const section of data.sections) {
    const headers = ['Indicator', 'Unit', ...section.periods];
    output += `### ${section.section}\n\n`;
    output += markdownTable(
      headers,
      section.rows.map(row => [row.indicator, row.unit, ...section.periods.map(period => row.values[period] || '')]),
    );
    output += '\n';
  }

  return output.trimEnd();
}

async function main() {
  const browserTools = await loadBrowserToolsRuntime();
  const rawArgs = process.argv.slice(2);
  const { ownerToken, port, args } = parseBrowserSessionArgs(rawArgs, browserTools);
  const outFile = optionValue(args, '--out');
  const isJson = args.includes('--json');
  const countryInput = parseCountryInput(args, outFile);
  const cacheInput = { source: 'country-forecasts', country: countryInput.slug, schema: 1, json: isJson };

  await browserTools.runCachedBrowserResource({
    tool: 'tradingeconomics-forecasts',
    cacheInput,
    outFile,
    port,
    ownerToken,
    run: async ({ page }) => {
      const result = await extractCountryForecasts(page, countryInput);
      const output = isJson ? JSON.stringify(result, null, 2) : formatForecasts(result);
      const metadata = buildTradingEconomicsMetadata(result, {
        type: 'country-forecasts',
        country: result.country,
        row_count: result.total_rows,
        sections: result.sections.map(section => ({ section: section.section, row_count: section.row_count })),
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

async function extractCountryForecasts(page, country) {
  const url = country.url || `${BASE_URL}/${country.slug}/forecast`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await prepareTradingEconomicsPage(page, 'table.table-hover', { includeSubscribe: true });

  const payload = await extractTradingEconomicsForecastTablesPayload(page);

  const parsed = parseForecastTablesPayload(payload);
  if (parsed.rows.length === 0) {
    const rawText = await pageTextPreview(page);
    throw new Error(`Could not parse forecasts from ${page.url()}. Raw extract: ${rawText}`);
  }

  const pageTitle = await page.title();
  return {
    source: 'tradingeconomics-forecasts',
    type: 'country-forecasts',
    country: {
      name: pageTitle.replace(/\s+Forecast\s*$/i, '').trim() || titleCase(country.slug),
      slug: slugFromTradingEconomicsUrl(page.url(), 'forecast') || country.slug,
      url: page.url(),
    },
    url: page.url(),
    page_title: pageTitle,
    captured_at: new Date().toISOString(),
    section_count: parsed.sections.length,
    total_rows: parsed.rows.length,
    ...parsed,
  };
}

function parseCountryInput(rawArgs, outFile = null) {
  const countryIdx = rawArgs.indexOf('--country');
  const raw = countryIdx !== -1 ? rawArgs[countryIdx + 1]
    : rawArgs.find(arg => !arg.startsWith('--') && !/^\d{4,5}$/.test(arg) && arg !== outFile);
  const value = cleanText(raw || 'united-states');
  if (/^https?:\/\//i.test(value)) {
    const parsed = new URL(value);
    const slug = slugFromTradingEconomicsUrl(parsed.href, 'forecast') || parsed.pathname.split('/').filter(Boolean)[0];
    return { slug, url: parsed.href };
  }
  return { slug: slugify(value), url: '' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error('Error:', e.message); process.exit(1); });
}
