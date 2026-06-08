import test from 'node:test';
import assert from 'node:assert/strict';
import { formatTradingEconomicsMarket, parseMarketTablePayloads, parseSharesPayload } from '../scripts/tradingeconomics-markets.mjs';

const tablePayload = [
  {
    category: 'Major',
    headers: ['Major', 'Price', 'Day', '%', 'Weekly', 'Monthly', 'YTD', 'YoY', 'Date'],
    rows: [
      {
        cells: [
          { text: 'US500', url: 'https://tradingeconomics.com/united-states/stock-market' },
          { text: '7452.28' },
          { text: ' 51.57', direction: 'positive' },
          { text: '0.70%' },
          { text: '1.18%' },
          { text: '6.96%' },
          { text: '8.86%' },
          { text: '26.47%' },
          { text: 'May/13' },
        ],
      },
      {
        cells: [
          { text: 'ASX200', url: 'https://tradingeconomics.com/australia/stock-market' },
          { text: '8561' },
          { text: ' 110', direction: 'negative' },
          { text: '-1.26%' },
          { text: '-2.65%' },
          { text: '-4.57%' },
          { text: '-1.76%' },
          { text: '3.40%' },
          { text: 'May/13' },
        ],
      },
    ],
  },
];

test('parses generic Trading Economics market heatmap tables', () => {
  const result = parseMarketTablePayloads(tablePayload, 'stocks');

  assert.equal(result.categories.length, 1);
  assert.equal(result.rows.length, 2);
  assert.deepEqual(result.rows[0], {
    market: 'stocks',
    category: 'Major',
    name: 'US500',
    unit: '',
    values: {
      Price: '7452.28',
      Day: '+51.57',
      '%': '0.70%',
      Weekly: '1.18%',
      Monthly: '6.96%',
      YTD: '8.86%',
      YoY: '26.47%',
      Date: 'May/13',
    },
    url: 'https://tradingeconomics.com/united-states/stock-market',
  });
  assert.equal(result.rows[1].values.Day, '-110');
});

test('parses shares treemap source plus top mover tables', () => {
  const result = parseSharesPayload({
    tree: {
      name: '_root_',
      children: [
        {
          name: 'Information Technology',
          children: [
            {
              name: 'Semiconductors',
              children: [
                {
                  name: 'Nvidia',
                  value: 4779472000000,
                  change: 5.05,
                  p_change: 2.2873,
                  monthly: 14.9204,
                  weekly: 8.6609,
                  ytd: 21.0885,
                  yoy: 66.8612,
                  price: 225.83,
                  url: '/nvda:us',
                  ticker: 'NVDA',
                },
              ],
            },
          ],
        },
      ],
    },
    topTables: [
      {
        category: 'Top Gainers',
        headers: ['Top Gainers', 'Price', 'Chg', '%Chg', 'YoY'],
        rows: [
          {
            cells: [
              { text: 'Ford Motor' },
              { text: '13.57' },
              { text: '1.58', direction: 'positive' },
              { text: '13.18%' },
              { text: '27.42%' },
            ],
          },
        ],
      },
    ],
  });

  assert.equal(result.treemap_row_count, 1);
  assert.equal(result.rows.length, 2);
  assert.equal(result.categories[0].category, 'Information Technology');
  assert.equal(result.rows[0].values.Ticker, 'NVDA');
  assert.equal(result.rows[0].values['%Chg'], '2.29%');
  assert.equal(result.categories.at(-1).category, 'Top Gainers');
  assert.equal(result.rows.at(-1).values.Chg, '+1.58');
});

test('formats market data with dynamic section columns', () => {
  const parsed = parseMarketTablePayloads(tablePayload, 'stocks');
  const markdown = formatTradingEconomicsMarket({
    source: 'tradingeconomics-markets',
    market: 'stocks',
    title: 'Stock Market Indexes',
    url: 'https://tradingeconomics.com/stocks',
    captured_at: '2026-05-13T21:00:00.000Z',
    ...parsed,
  });

  assert.match(markdown, /Total rows: 2 across 1 sections/);
  assert.match(markdown, /### Major/);
  assert.match(markdown, /\| US500 \| 7452\.28 \| \+51\.57 \| 0\.70% \|/);
});
