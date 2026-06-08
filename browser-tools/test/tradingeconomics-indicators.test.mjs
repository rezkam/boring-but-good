import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatCountryList,
  formatIndicators,
  parseIndicatorTabsPayload,
  parseMatrixCountriesPayload,
} from '../scripts/tradingeconomics-indicators.mjs';

const indicatorsPayload = {
  tabs: [
    { id: 'overview', label: 'Overview' },
    { id: 'gdp', label: 'GDP' },
    { id: 'government', label: 'Government' },
  ],
  tabTables: [
    {
      id: 'overview',
      label: 'Overview',
      tables: [
        {
          tableIndex: 0,
          rows: [
            { cells: [{ text: '' }, { text: 'Last' }, { text: 'Previous' }, { text: 'Highest' }, { text: 'Lowest' }, { text: '' }, { text: '' }] },
            { cells: [{ text: 'Currency', url: 'https://tradingeconomics.com/euro-area/currency' }, { text: '1.17' }, { text: '1.17' }, { text: '1.87' }, { text: '0.64' }, { text: '' }, { text: 'May/26' }] },
          ],
        },
      ],
    },
    {
      id: 'gdp',
      label: 'GDP',
      tables: [
        {
          tableIndex: 0,
          rows: [
            { cells: [{ text: '' }, { text: 'Last' }, { text: 'Previous' }, { text: 'Highest' }, { text: 'Lowest' }, { text: '' }, { text: '' }] },
            { cells: [{ text: 'GDP Growth Rate', url: 'https://tradingeconomics.com/euro-area/gdp-growth' }, { text: '0.1' }, { text: '0.2' }, { text: '11.5' }, { text: '-11.1' }, { text: 'percent' }, { text: 'Mar/26' }] },
            { cells: [{ text: 'GDP', url: 'https://tradingeconomics.com/euro-area/gdp' }, { text: '16406' }, { text: '15787' }, { text: '16406' }, { text: '251' }, { text: 'USD Billion' }, { text: 'Dec/24' }] },
          ],
        },
      ],
    },
    {
      id: 'government',
      label: 'Government',
      tables: [
        {
          tableIndex: 0,
          rows: [
            { cells: [{ text: '' }, { text: 'Last' }, { text: 'Previous' }, { text: 'Highest' }, { text: 'Lowest' }, { text: '' }, { text: '' }] },
            { cells: [{ text: 'Government Debt to GDP' }, { text: '87.8' }, { text: '87' }, { text: '96.5' }, { text: '65.9' }, { text: 'percent of GDP' }, { text: 'Dec/25' }] },
          ],
        },
        {
          tableIndex: 1,
          rows: [
            { cells: [{ text: '' }, { text: 'Last' }, { text: 'Previous' }, { text: 'Highest' }, { text: 'Lowest' }, { text: '' }, { text: '' }] },
            { cells: [{ text: 'Corporate Tax Rate' }, { text: '22.2' }, { text: '22.1' }, { text: '36.8' }, { text: '22' }, { text: 'percent' }, { text: 'Dec/25' }] },
          ],
        },
      ],
    },
  ],
};

const matrixPayload = {
  headers: ['Country', 'GDP', 'GDP Growth', 'Interest Rate', 'Inflation Rate', 'Jobless Rate'],
  rows: [
    {
      cells: [
        { text: 'United States', url: 'https://tradingeconomics.com/united-states/indicators' },
        { text: '29185' },
        { text: '2.00' },
        { text: '3.75' },
        { text: '3.80' },
        { text: '4.30' },
      ],
    },
    {
      cells: [
        { text: 'Euro Area', url: 'https://tradingeconomics.com/euro-area/indicators' },
        { text: '16406' },
        { text: '0.10' },
        { text: '2.15' },
        { text: '3.00' },
        { text: '6.20' },
      ],
    },
  ],
};

test('parses all indicator tab tables and keeps multiple tables within one tab', () => {
  const result = parseIndicatorTabsPayload(indicatorsPayload);

  assert.equal(result.tabs.length, 3);
  assert.deepEqual(result.tabs.map(tab => [tab.id, tab.row_count]), [
    ['overview', 1],
    ['gdp', 2],
    ['government', 2],
  ]);
  assert.equal(result.rows.length, 5);
  assert.deepEqual(result.rows[1], {
    tab: 'GDP',
    tab_id: 'gdp',
    indicator: 'GDP Growth Rate',
    last: '0.1',
    previous: '0.2',
    highest: '11.5',
    lowest: '-11.1',
    unit: 'percent',
    date: 'Mar/26',
    url: 'https://tradingeconomics.com/euro-area/gdp-growth',
    table_index: 0,
  });
  assert.equal(result.rows.at(-1).indicator, 'Corporate Tax Rate');
  assert.equal(result.rows.at(-1).table_index, 1);
});

test('parses countries from the Trading Economics matrix table', () => {
  const result = parseMatrixCountriesPayload(matrixPayload);

  assert.equal(result.countries.length, 2);
  assert.equal(result.countries[0].slug, 'united-states');
  assert.equal(result.countries[1].values['GDP Growth'], '0.10');
  assert.deepEqual(result.columns, ['GDP', 'GDP Growth', 'Interest Rate', 'Inflation Rate', 'Jobless Rate']);
});

test('formats indicator tabs as grouped markdown', () => {
  const parsed = parseIndicatorTabsPayload(indicatorsPayload);
  const markdown = formatIndicators({
    source: 'tradingeconomics-indicators',
    type: 'country-indicators',
    country: { name: 'Euro Area', slug: 'euro-area', url: 'https://tradingeconomics.com/euro-area/indicators' },
    url: 'https://tradingeconomics.com/euro-area/indicators',
    captured_at: '2026-05-13T21:00:00.000Z',
    ...parsed,
  });

  assert.match(markdown, /Total indicators: 5 across 3 tabs/);
  assert.match(markdown, /### GDP/);
  assert.match(markdown, /\| GDP Growth Rate \| 0\.1 \| 0\.2 \| 11\.5 \| -11\.1 \| percent \| Mar\/26 \|/);
});

test('formats country list from matrix data', () => {
  const parsed = parseMatrixCountriesPayload(matrixPayload);
  const markdown = formatCountryList({
    source: 'tradingeconomics-indicators',
    type: 'country-list',
    url: 'https://tradingeconomics.com/matrix',
    captured_at: '2026-05-13T21:00:00.000Z',
    ...parsed,
  });

  assert.match(markdown, /Total countries: 2/);
  assert.match(markdown, /\| United States \| united-states \| https:\/\/tradingeconomics\.com\/united-states\/indicators \| 29185 \|/);
});
