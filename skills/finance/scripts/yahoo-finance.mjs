#!/usr/bin/env node
/**
 * yahoo-finance.mjs - Fetch quote data from Yahoo Finance v7 API via browser session.
 *
 * Uses the browser's Yahoo cookie + crumb for auth.
 * Returns settlement/closing prices (regularMarketPreviousClose for 24h instruments).
 *
 * Usage:
 *   node yahoo-finance.mjs --tickers "CL=F,BZ=F,^GSPC" [port] [--json] [--owner-token token]
 */

import { loadBrowserToolsRuntime, optionValue, parseBrowserSessionArgs } from './browser-tools-runtime.mjs';

async function main() {
  const browserTools = await loadBrowserToolsRuntime();
  const rawArgs = process.argv.slice(2);
  const { ownerToken, port, args } = parseBrowserSessionArgs(rawArgs, browserTools);
  const isJson = args.includes('--json');
  const outFile = optionValue(args, '--out');
  const tickersValue = optionValue(args, '--tickers');
  const tickers = tickersValue ? tickersValue.split(',').map(t => t.trim()).filter(Boolean) : null;

  if (!tickers || tickers.length === 0) {
    console.error('Usage: node yahoo-finance.mjs --tickers "CL=F,BZ=F,^GSPC" [port] [--json] [--owner-token token]');
    process.exit(1);
  }

  const cacheInput = { tickers, json: isJson };

  await browserTools.runCachedBrowserResource({
    tool: 'yahoo-finance',
    cacheInput,
    outFile,
    port,
    ownerToken,
    closePage: false,
    getPage: async (browser) => {
      const pages = await browser.pages();
      let page = pages.find(p => p.url().includes('yahoo.com'));
      if (!page) {
        page = await browser.newPage({ background: true });
        await page.goto('https://finance.yahoo.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 2000));
      }
      return page;
    },
    run: async ({ page }) => {
      const data = await page.evaluate(async (syms) => {
        try {
          // Get crumb
          const crumbResp = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', { credentials: 'include' });
          const crumb = await crumbResp.text();

          const fields = [
            'regularMarketPrice', 'regularMarketPreviousClose',
            'regularMarketChange', 'regularMarketChangePercent',
            'regularMarketOpen', 'regularMarketDayHigh', 'regularMarketDayLow',
            'regularMarketVolume', 'regularMarketTime',
            'shortName', 'quoteType', 'market', 'exchange',
            'fiftyTwoWeekHigh', 'fiftyTwoWeekLow',
            'fiftyDayAverage', 'twoHundredDayAverage',
            'marketCap', 'trailingPE', 'epsTrailingTwelveMonths',
          ].join(',');

          const url = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(syms)}&fields=${fields}&crumb=${encodeURIComponent(crumb)}`;
          const resp = await fetch(url, { credentials: 'include' });
          const json = await resp.json();
          return json?.quoteResponse?.result || [];
        } catch (e) {
          return [{ error: e.message }];
        }
      }, tickers.join(','));

      const results = data.map(q => {
        if (q.error) return { error: q.error };
        return {
          symbol: q.symbol,
          name: q.shortName || '',
          quoteType: q.quoteType,      // FUTURE, EQUITY, INDEX, CURRENCY, CRYPTOCURRENCY
          exchange: q.exchange,
          price: q.regularMarketPrice,
          previousClose: q.regularMarketPreviousClose,
          change: q.regularMarketChange,
          changePercent: q.regularMarketChangePercent,
          open: q.regularMarketOpen,
          dayHigh: q.regularMarketDayHigh,
          dayLow: q.regularMarketDayLow,
          volume: q.regularMarketVolume,
          yearHigh: q.fiftyTwoWeekHigh,
          yearLow: q.fiftyTwoWeekLow,
          avg50: q.fiftyDayAverage,
          avg200: q.twoHundredDayAverage,
          marketCap: q.marketCap,
          pe: q.trailingPE,
          eps: q.epsTrailingTwelveMonths,
          timestamp: q.regularMarketTime,
        };
      });

      const output = isJson ? JSON.stringify(results, null, 2) : formatTable(results);
      const metadata = {
        source: 'yahoo-finance',
        url: page.url(),
        captured_at: new Date().toISOString(),
        tickers,
        json: results,
        cache_hit: false,
      };
      return {
        output,
        rawText: output,
        pageUrl: page.url(),
        metadata,
        extension: isJson ? 'json' : 'md',
      };
    },
  });
}

function formatTable(data) {
  let md = '| Symbol | Name | Price | Prev Close | Change | % | Day Range | Year High |\n';
  md += '|--------|------|-------|------------|--------|---|-----------|----------|\n';
  for (const d of data) {
    if (d.error) { md += `| ERROR | ${d.error} | | | | | | |\n`; continue; }
    const sign = (d.change || 0) >= 0 ? '+' : '';
    md += `| ${d.symbol} | ${d.name} | $${d.price?.toFixed(2)} | $${d.previousClose?.toFixed(2)} | ${sign}${d.change?.toFixed(2)} | ${sign}${d.changePercent?.toFixed(2)}% | $${d.dayLow?.toFixed(2)}–$${d.dayHigh?.toFixed(2)} | $${d.yearHigh?.toFixed(2)} |\n`;
  }
  return md;
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
