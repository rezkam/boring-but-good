#!/usr/bin/env node
/**
 * tradingeconomics-markets.mjs - Extract market indicator tables from Trading Economics.
 *
 * Usage:
 *   scripts/tradingeconomics-markets.mjs --market stocks [--json] [--out <file>] [port] [--owner-token token]
 *   scripts/tradingeconomics-markets.mjs stocks [--json]
 *
 * Supported markets: commodities, stocks, shares, currencies, bonds.
 */

import { pathToFileURL } from 'url';
import { loadBrowserToolsRuntime, optionValue, parseBrowserSessionArgs } from './browser-tools-runtime.mjs';
import {
  TRADING_ECONOMICS_BASE_URL,
  buildTradingEconomicsMetadata,
  cleanText,
  extractTradingEconomicsSharesPayload,
  extractTradingEconomicsTables,
  formatNumber,
  formatPercentNumber,
  markdownTable,
  pageTextPreview,
  prepareTradingEconomicsPage,
  withDirection,
} from './tradingeconomics-common.mjs';

const MARKET_CONFIGS = {
  commodities: {
    path: '/commodities',
    title: 'Commodity Prices',
    selector: 'table.table-heatmap',
  },
  stocks: {
    path: '/stocks',
    title: 'Stock Market Indexes',
    selector: 'table.table-heatmap',
    aliases: ['indexes', 'indices'],
  },
  shares: {
    path: '/shares',
    title: 'Share Prices',
    selector: 'table.table-condensed',
  },
  currencies: {
    path: '/currencies',
    title: 'Currency Exchange Rates',
    selector: 'table.table-heatmap',
  },
  bonds: {
    path: '/bonds',
    title: 'Government Bond Yields',
    selector: 'table.table-heatmap',
  },
};

export function parseMarketTablePayloads(tablePayloads, marketName = '') {
  const categories = [];
  const rows = [];

  for (const table of tablePayloads || []) {
    const normalized = normalizeTableShape(table);
    const headers = normalized.headers;
    if (headers.length < 2) continue;

    const category = cleanText(table.category || headers[0]);
    const columns = headers.slice(1).filter(Boolean);
    const categoryRows = [];

    for (const rawRow of normalized.rows || []) {
      if (!rawRow.cells || rawRow.cells.length < 2) continue;
      const firstCell = rawRow.cells[0];
      const labelLines = cleanText(firstCell.text).split('\n').map(cleanText).filter(Boolean);
      if (labelLines.length === 0) continue;

      const values = {};
      for (let index = 1; index < rawRow.cells.length && index < headers.length; index += 1) {
        const header = headers[index];
        if (!header) continue;
        values[header] = withDirection(rawRow.cells[index].text, rawRow.cells[index].direction);
      }

      const row = {
        market: marketName,
        category,
        name: labelLines[0],
        unit: labelLines.slice(1).join(' '),
        values,
        url: firstCell.url || '',
      };
      categoryRows.push(row);
      rows.push(row);
    }

    if (category && categoryRows.length > 0) categories.push({ category, columns, rows: categoryRows });
  }

  return { categories, rows };
}

export function parseSharesPayload(payload) {
  const categories = [];
  const rows = [];
  const sectorGroups = new Map();
  const treeRows = flattenSharesTree(payload?.tree);
  const treeColumns = ['Ticker', 'Price', 'Chg', '%Chg', 'Weekly', 'Monthly', 'YTD', 'YoY', 'Market Cap', 'Path'];

  for (const leaf of treeRows) {
    const category = leaf.path[0] || 'Shares';
    const row = {
      market: 'shares',
      category,
      name: leaf.name,
      unit: '',
      values: {
        Ticker: leaf.ticker || '',
        Price: formatNumber(leaf.price),
        Chg: formatNumber(leaf.change),
        '%Chg': formatPercentNumber(leaf.p_change),
        Weekly: formatPercentNumber(leaf.weekly),
        Monthly: formatPercentNumber(leaf.monthly),
        YTD: formatPercentNumber(leaf.ytd),
        YoY: formatPercentNumber(leaf.yoy),
        'Market Cap': formatNumber(leaf.value),
        Path: leaf.path.join(' / '),
      },
      url: leaf.url ? new URL(leaf.url, TRADING_ECONOMICS_BASE_URL).href : '',
    };

    if (!sectorGroups.has(category)) sectorGroups.set(category, []);
    sectorGroups.get(category).push(row);
    rows.push(row);
  }

  for (const [category, categoryRows] of sectorGroups) {
    categories.push({ category, columns: treeColumns, rows: categoryRows });
  }

  const topTables = parseMarketTablePayloads(payload?.topTables || [], 'shares');
  categories.push(...topTables.categories);
  rows.push(...topTables.rows);

  return { categories, rows, treemap_row_count: treeRows.length };
}

export function formatTradingEconomicsMarket(data) {
  let output = `## Trading Economics - ${data.title}\n\n`;
  output += `Source: ${data.url}\n`;
  output += `Captured: ${data.captured_at}\n`;
  output += `Total rows: ${data.rows.length} across ${data.categories.length} sections`;
  if (typeof data.treemap_row_count === 'number') output += `, including ${data.treemap_row_count} treemap companies`;
  output += '\n\n';

  for (const category of data.categories) {
    output += `### ${category.category}\n\n`;
    const hasUnit = category.rows.some(row => row.unit);
    const headers = ['Name', ...(hasUnit ? ['Unit'] : []), ...category.columns];
    output += markdownTable(
      headers,
      category.rows.map(row => [row.name, ...(hasUnit ? [row.unit] : []), ...category.columns.map(column => row.values[column] || '')]),
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
  const market = parseMarket(args, outFile);
  const config = MARKET_CONFIGS[market];
  const cacheInput = { source: 'markets-page', market, schema: 1, json: isJson };

  await browserTools.runCachedBrowserResource({
    tool: 'tradingeconomics-markets',
    cacheInput,
    outFile,
    port,
    ownerToken,
    run: async ({ page }) => {
      await page.goto(`${TRADING_ECONOMICS_BASE_URL}${config.path}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await prepareTradingEconomicsPage(page, config.selector, { settleMs: 1500 });

      const extracted = market === 'shares'
        ? parseSharesPayload(await extractTradingEconomicsSharesPayload(page, config.selector))
        : parseMarketTablePayloads(await extractTradingEconomicsTables(page, config.selector), market);

      if (extracted.rows.length === 0) {
        const rawText = await pageTextPreview(page);
        throw new Error(`Could not parse ${market} data from ${page.url()}. Raw extract: ${rawText}`);
      }

      const data = {
        source: 'tradingeconomics-markets',
        market,
        title: config.title,
        url: page.url(),
        page_title: await page.title(),
        captured_at: new Date().toISOString(),
        ...extracted,
      };

      const output = isJson ? JSON.stringify(data, null, 2) : formatTradingEconomicsMarket(data);
      const metadata = buildTradingEconomicsMetadata(data, {
        market,
        row_count: data.rows.length,
        treemap_row_count: data.treemap_row_count,
        categories: data.categories.map(category => ({
          name: category.category,
          row_count: category.rows.length,
        })),
      });
      return {
        output,
        rawText: output,
        pageUrl: data.url,
        metadata,
        extension: isJson ? 'json' : 'md',
      };
    },
  });
}

function normalizeTableShape(table) {
  let headers = (table.headers || []).map(cleanText);
  let rows = table.rows || [];

  if (!headers[0] && headers[1]) {
    headers = headers.slice(1);
    rows = rows.map(row => ({ ...row, cells: (row.cells || []).slice(1) }));
  }

  while (headers.length > 0 && !headers[headers.length - 1]) {
    headers = headers.slice(0, -1);
    rows = rows.map(row => ({ ...row, cells: (row.cells || []).slice(0, headers.length) }));
  }

  return { headers, rows };
}

function parseMarket(rawArgs, outFile = null) {
  const marketIdx = rawArgs.indexOf('--market');
  const raw = marketIdx !== -1 ? rawArgs[marketIdx + 1]
    : rawArgs.find(arg => !arg.startsWith('--') && !/^\d{4,5}$/.test(arg) && arg !== outFile);
  const normalized = cleanText(raw || 'commodities').toLowerCase();

  for (const [name, cfg] of Object.entries(MARKET_CONFIGS)) {
    if (normalized === name || (cfg.aliases || []).includes(normalized)) return name;
  }

  throw new Error(`Unsupported market "${raw}". Supported markets: ${Object.keys(MARKET_CONFIGS).join(', ')}`);
}

function flattenSharesTree(root) {
  const leaves = [];
  const walk = (node, path = []) => {
    if (!node) return;
    const nextPath = node.name === '_root_' ? path : [...path, node.name];
    if (Array.isArray(node.children) && node.children.length > 0) {
      for (const child of node.children) walk(child, nextPath);
      return;
    }
    if (node.name && node.name !== '_root_') leaves.push({ ...node, path: nextPath });
  };
  walk(root);
  return leaves;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error('Error:', e.message); process.exit(1); });
}
