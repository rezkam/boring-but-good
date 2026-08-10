import test from 'node:test';
import assert from 'node:assert/strict';
import { formatForecasts, parseForecastTablesPayload } from '../scripts/tradingeconomics-forecasts.mjs';

const payload = {
  tables: [
    {
      tableIndex: 0,
      headers: ['Markets', 'Actual', 'Q2/26', 'Q3/26', 'Q4/26', 'Q1/27'],
      rows: [
        {
          cells: [
            { text: 'Currency', url: 'https://tradingeconomics.com/united-states/currency' },
            { text: '98.46' },
            { text: '97.61' },
            { text: '96.9' },
            { text: '96.41' },
            { text: '95.92' },
          ],
        },
        {
          cells: [
            { text: 'Stock Market (points)', url: 'https://tradingeconomics.com/united-states/stock-market' },
            { text: '7454.52' },
            { text: '7310' },
            { text: '7096' },
            { text: '6949' },
            { text: '6805' },
          ],
        },
      ],
    },
    {
      tableIndex: 1,
      headers: ['GDP', 'Actual', 'Q2/26', 'Q3/26', 'Q4/26', 'Q1/27'],
      rows: [
        {
          cells: [
            { text: 'GDP Growth Rate (%)', url: 'https://tradingeconomics.com/united-states/gdp-growth' },
            { text: '2.00' },
            { text: '1.1' },
            { text: '0.9' },
            { text: '2' },
            { text: '2.2' },
          ],
        },
      ],
    },
  ],
};

test('parses country forecast tables into section rows', () => {
  const result = parseForecastTablesPayload(payload);

  assert.equal(result.sections.length, 2);
  assert.equal(result.rows.length, 3);
  assert.deepEqual(result.rows[1], {
    section: 'Markets',
    indicator: 'Stock Market',
    unit: 'points',
    values: {
      Actual: '7454.52',
      'Q2/26': '7310',
      'Q3/26': '7096',
      'Q4/26': '6949',
      'Q1/27': '6805',
    },
    url: 'https://tradingeconomics.com/united-states/stock-market',
  });
});

test('formats country forecasts as grouped markdown', () => {
  const parsed = parseForecastTablesPayload(payload);
  const markdown = formatForecasts({
    source: 'tradingeconomics-forecasts',
    type: 'country-forecasts',
    country: { name: 'United States', slug: 'united-states', url: 'https://tradingeconomics.com/united-states/forecast' },
    url: 'https://tradingeconomics.com/united-states/forecast',
    captured_at: '2026-05-13T21:00:00.000Z',
    section_count: parsed.sections.length,
    total_rows: parsed.rows.length,
    ...parsed,
  });

  assert.match(markdown, /Total rows: 3 across 2 sections/);
  assert.match(markdown, /### Markets/);
  assert.match(markdown, /\| Stock Market \| points \| 7454\.52 \| 7310 \| 7096 \| 6949 \| 6805 \|/);
});
