import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTradingEconomicsMetadata,
  cleanText,
  dismissTradingEconomicsOverlays,
  escapeMarkdown,
  extractTradingEconomicsCountryTablePayload,
  extractTradingEconomicsForecastTablesPayload,
  extractTradingEconomicsMatrixPayload,
  extractTradingEconomicsTables,
  formatNumber,
  formatPercentNumber,
  markdownTable,
  normalizeCountryName,
  pageTextPreview,
  prepareTradingEconomicsPage,
  slugFromTradingEconomicsUrl,
  slugify,
  splitNameUnit,
  titleCase,
  withDirection,
} from '../scripts/tradingeconomics-common.mjs';

test('normalizes text, markdown, numeric direction, slugs, and names consistently', () => {
  assert.equal(cleanText('  A\u00a0 B  '), 'A  B');
  assert.equal(cleanText('  A\u00a0 \n B  ', { collapseWhitespace: true }), 'A B');
  assert.equal(escapeMarkdown('A | B'), 'A \\| B');
  assert.equal(withDirection(' 1.20 ', 'negative'), '-1.20');
  assert.equal(withDirection('0.00', 'positive'), '0.00');
  assert.equal(withDirection('-1.20', 'positive'), '-1.20');
  assert.equal(formatNumber(12.30), '12.3');
  assert.equal(formatNumber('N/A'), 'N/A');
  assert.equal(formatPercentNumber(2.345), '2.35%');
  assert.deepEqual(splitNameUnit('Stock Market (points)'), { indicator: 'Stock Market', unit: 'points' });
  assert.deepEqual(splitNameUnit('Currency'), { indicator: 'Currency', unit: '' });
  assert.equal(slugify('Government Spending & GDP'), 'government-spending-and-gdp');
  assert.equal(titleCase('euro-area'), 'Euro Area');
  assert.equal(normalizeCountryName('Bosnia & Herzegovina'), 'bosnia and herzegovina');
  assert.equal(slugFromTradingEconomicsUrl('https://tradingeconomics.com/sweden/forecast', 'forecast'), 'sweden');
});

test('builds markdown tables and common metadata in one reusable place', () => {
  assert.equal(
    markdownTable(['Name', 'Value'], [['A | B', 10]]),
    '| Name | Value |\n| --- | --- |\n| A \\| B | 10 |\n',
  );

  const result = {
    source: 'tradingeconomics-example',
    url: 'https://tradingeconomics.com/example',
    captured_at: '2026-05-13T00:00:00.000Z',
    rows: [1, 2],
  };
  assert.deepEqual(buildTradingEconomicsMetadata(result, { row_count: 2 }), {
    source: 'tradingeconomics-example',
    url: 'https://tradingeconomics.com/example',
    captured_at: '2026-05-13T00:00:00.000Z',
    json: result,
    cache_hit: false,
    row_count: 2,
  });
});

test('page helpers centralize Trading Economics page evaluate contracts', async () => {
  const calls = [];
  const page = {
    evaluate: async (fn, arg) => {
      calls.push({ fn: String(fn), arg });
      if (arg === 120) return 'preview';
      return [];
    },
    waitForSelector: async (selector, options) => calls.push({ waitForSelector: selector, options }),
  };

  assert.equal(await pageTextPreview(page, 120), 'preview');
  await dismissTradingEconomicsOverlays(page, { includeSubscribe: true });
  await extractTradingEconomicsTables(page, 'table.table-hover', { cleanWhitespace: true });
  await prepareTradingEconomicsPage(page, 'table.table-hover', { includeSubscribe: true, settleMs: 0 });

  assert.equal(calls[1].arg.includeSubscribe, true);
  assert.match(calls[1].fn, /subscribe-prompt/);
  assert.equal(calls[2].arg.selector, 'table.table-hover');
  assert.equal(calls[2].arg.cleanWhitespace, true);
  assert.match(calls[2].fn, /market-negative-image/);
  assert.deepEqual(calls[4], { waitForSelector: 'table.table-hover', options: { timeout: 15000 } });
});

test('table extraction adapters share the generic table extractor', async () => {
  const calls = [];
  const page = {
    evaluate: async (_fn, arg) => {
      calls.push(arg);
      if (arg.selector === 'table') return [
        { headers: ['Name'], rows: [] },
        { headers: ['Country', 'Last', 'Unit'], rows: [{ cells: [{ text: 'Sweden' }] }] },
      ];
      if (arg.selector === 'table.table-hover') return [{ headers: ['GDP', 'Actual'], rows: [] }];
      if (arg.selector === 'table#matrix') return [{ headers: ['Country', 'GDP'], rows: [] }];
      return [];
    },
  };

  assert.deepEqual(await extractTradingEconomicsCountryTablePayload(page), {
    headers: ['Country', 'Last', 'Unit'],
    rows: [{ cells: [{ text: 'Sweden' }] }],
  });
  assert.deepEqual(await extractTradingEconomicsForecastTablesPayload(page), {
    tables: [{ headers: ['GDP', 'Actual'], rows: [] }],
  });
  assert.deepEqual(await extractTradingEconomicsMatrixPayload(page), { headers: ['Country', 'GDP'], rows: [] });
  assert.deepEqual(calls.map(call => call.selector), ['table', 'table.table-hover', 'table#matrix']);
});
