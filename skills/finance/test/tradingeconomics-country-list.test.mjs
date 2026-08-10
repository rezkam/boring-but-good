import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCountryListComparison, parseCountryListTablePayload } from '../scripts/tradingeconomics-country-list.mjs';

const payload = {
  headers: ['Country', 'Last', 'Previous', 'Reference', 'Unit'],
  rows: [
    {
      cells: [
        { text: 'France', url: 'https://tradingeconomics.com/france/government-spending-to-gdp' },
        { text: '57.2' },
        { text: '57' },
        { text: 'Dec/25' },
        { text: '%' },
      ],
    },
    {
      cells: [
        { text: 'United States', url: 'https://tradingeconomics.com/united-states/government-spending-to-gdp' },
        { text: '33.8' },
        { text: '33.9' },
        { text: 'Dec/25' },
        { text: '%' },
      ],
    },
  ],
};

test('parses Trading Economics country-list comparison rows with optional filtering', () => {
  const result = parseCountryListTablePayload(payload, ['United States']);

  assert.equal(result.headers.length, 5);
  assert.deepEqual(result.rows, [
    {
      country: 'United States',
      url: 'https://tradingeconomics.com/united-states/government-spending-to-gdp',
      values: {
        Last: '33.8',
        Previous: '33.9',
        Reference: 'Dec/25',
        Unit: '%',
      },
    },
  ]);
});

test('formats country-list comparison data as grouped markdown', () => {
  const parsed = parseCountryListTablePayload(payload, []);
  const markdown = formatCountryListComparison({
    source: 'tradingeconomics-country-list',
    type: 'country-list-comparison',
    indicator: { name: 'Government Spending to GDP', slug: 'government-spending-to-gdp' },
    url: 'https://tradingeconomics.com/country-list/government-spending-to-gdp',
    captured_at: '2026-05-14T01:00:00.000Z',
    headers: parsed.headers,
    country_filter: [],
    total_rows_available: parsed.rows.length,
    rows: parsed.rows,
  });

  assert.match(markdown, /Rows: 2/);
  assert.match(markdown, /\| France \| 57\.2 \| 57 \| Dec\/25 \| % \|/);
});
