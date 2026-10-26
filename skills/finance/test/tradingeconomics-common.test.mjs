import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTradingEconomicsMetadata,
  cleanText,
  escapeMarkdown,
  extractTradingEconomicsCountryTablePayload,
  extractTradingEconomicsForecastTablesPayload,
  extractTradingEconomicsMatrixPayload,
  formatNumber,
  formatPercentNumber,
  markdownTable,
  normalizeCountryName,
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
