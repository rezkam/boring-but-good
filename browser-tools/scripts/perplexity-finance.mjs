#!/usr/bin/env node
/**
 * perplexity-finance.mjs - Fetch price data from Perplexity Finance REST API.
 *
 * Usage:
 *   node perplexity-finance.mjs <ticker> [port] [--owner-token token]
 *   node perplexity-finance.mjs --tickers "CL=F,BZ=F,^GSPC,^VIX,GC=F,BTC-USD,EURUSD=X,LMT" [port]
 *   node perplexity-finance.mjs --market [port]   # Main page market summary + top assets
 *   node perplexity-finance.mjs --bundle <ticker> [port]  # ALL shapes in one go (ADR-0012)
 *
 * Flags:
 *   --json         Output raw JSON instead of markdown
 *   --out <file>   Save output to file
 *   --bundle T     Fetch quote + financials + analyst consensus + holders +
 *                  earnings + narratives + key issues + developments +
 *                  research reports for ticker T in one round-trip. Used
 *                  by financial-pipeline's MarketDataService.fetchBundle.
 *                  Endpoints that 4xx are recorded as `null` in the output;
 *                  the caller persists what is present, never fabricates.
 *
 * How it works:
 *   Uses the browser's authenticated session to call Perplexity's internal REST APIs:
 *   - /rest/finance/quote/<ticker>                 - price, change, stats
 *   - /rest/tasks/finance/tickers/<symbol>         - summary, news, predictions
 *   - /rest/finance/financials/<ticker>            - quarterly financials (probed)
 *   - /rest/finance/analyst-consensus/<ticker>     - consensus + targets (probed)
 *   - /rest/finance/holders/<ticker>               - institutional holders (probed)
 *   - /rest/finance/earnings/<ticker>              - earnings history (probed)
 *   - /rest/finance/historical-data/<ticker>       - OHLCV history (probed)
 *   - /rest/finance/news/<ticker>                  - developments newsfeed (probed)
 *
 * Endpoints marked "probed" are best-effort: bundle mode tries each in
 * parallel. Missing endpoints surface as `null` sections - the TypeScript
 * MarketDataService treats those as `unsupported` per the dispatcher's
 * anti-fabrication contract.
 *
 * The price text on the page is SVG-rendered (not DOM text), so we MUST use the API.
 */

import { parseOwnerToken, parsePort, stripBrowserSessionArgs } from './browser-control.mjs';
import { runCachedBrowserResource } from './resource-helper.mjs';

const rawArgs = process.argv.slice(2);
const ownerToken = parseOwnerToken(rawArgs);
const port = parsePort(rawArgs, rawArgs.find(a => /^\d{4,5}$/.test(a)) || '9222');
const args = stripBrowserSessionArgs(rawArgs, { stripPositionalPort: true });
const isJson = args.includes('--json');
const isMarket = args.includes('--market');
const outIdx = args.indexOf('--out');
const outFile = outIdx !== -1 ? args[outIdx + 1] : null;
const tickersIdx = args.indexOf('--tickers');
const tickers = tickersIdx !== -1 ? args[tickersIdx + 1].split(',').map(t => t.trim()) : null;
const singleTicker = !isMarket && !tickers ? args.find(a => !a.startsWith('--') && !/^\d{4,5}$/.test(a)) : null;
const cacheInput = { market: isMarket, tickers: isMarket ? ['--market'] : (tickers || [singleTicker]), json: isJson };

async function main() {
  await runCachedBrowserResource({
    tool: 'perplexity-finance',
    cacheInput,
    outFile,
    port,
    ownerToken,
    closePage: false,
    getPage: async (browser) => {
      const pages = await browser.pages();
      // Use a dedicated Perplexity tab. Reusing an active research thread can destroy the execution context.
      let page = pages.find(p => p.url().includes('perplexity.ai/finance'));
      if (!page) {
        page = await browser.newPage({ background: true });
        await page.goto('https://www.perplexity.ai/finance', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await sleep(2000);
      }
      return page;
    },
    run: async ({ page }) => {
      let results;

      if (isMarket) {
        results = await fetchMarketSummary(page);
      } else if (tickers) {
        results = [];
        for (const t of tickers) {
          const data = await fetchQuote(page, t);
          results.push(data);
        }
      } else if (singleTicker) {
        results = await fetchQuote(page, singleTicker);
      } else {
        throw new Error('Usage: node perplexity-finance.mjs <ticker> | --tickers "A,B" | --market');
      }

      const output = isJson ? JSON.stringify(results, null, 2) : formatMarkdown(results);
      const metadata = {
        source: 'perplexity-finance',
        url: page.url(),
        captured_at: new Date().toISOString(),
        tickers: isMarket ? ['--market'] : (tickers || [singleTicker]),
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

async function fetchQuote(page, ticker) {
  const encoded = encodeURIComponent(ticker);
  const data = await page.evaluate(async (enc) => {
    try {
      const resp = await fetch(`/rest/finance/quote/${enc}?version=2.18&source=default`);
      if (!resp.ok) return { error: `HTTP ${resp.status}`, ticker: enc };
      return resp.json();
    } catch (e) {
      return { error: e.message, ticker: enc };
    }
  }, encoded);

  if (data.error) return { ...data, ticker };

  return {
    ticker: data.symbol || ticker,
    name: data.name || '',
    exchange: data.exchange || '',
    currency: data.currency || 'USD',
    price: data.price,
    change: data.change,
    changePercent: data.changesPercentage,
    prevClose: data.previousClose,
    open: data.open,
    dayLow: data.dayLow,
    dayHigh: data.dayHigh,
    yearHigh: data.yearHigh,
    yearLow: data.yearLow,
    volume: data.volume,
    avgVolume: data.avgVolume,
    marketCap: data.marketCap,
    pe: data.pe,
    eps: data.eps,
    dividendYield: data.dividendYieldTTM,
    priceAvg50: data.priceAvg50,
    priceAvg200: data.priceAvg200,
    afterHoursPrice: data.afterHoursPrice,
    afterHoursChange: data.afterHoursChange,
    timestamp: data.timestamp ? new Date(data.timestamp * 1000).toISOString() : null,
    isCrypto: data.isCrypto,
    isEtf: data.isEtf,
  };
}

async function fetchMarketSummary(page) {
  // Navigate to finance page and scrape the top assets from the API
  await page.goto('https://www.perplexity.ai/finance', { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
  await sleep(2000);

  // Get market summary text from the page
  const summary = await page.evaluate(() => {
    const body = document.body.innerText;
    const headlines = [];
    const lines = body.split('\n');
    let inSummary = false;
    for (const line of lines) {
      if (line.includes('Market Summary')) { inSummary = true; continue; }
      if (inSummary && line.trim().length > 20 && line.trim().length < 200 && !line.includes('Updated') && !line.includes('sources') && !line.includes('Ask anything')) {
        headlines.push(line.trim());
        if (headlines.length >= 10) break;
      }
    }
    const sentMatch = body.match(/(Uncertain|Bullish|Bearish|Neutral) Sentiment/);
    return { sentiment: sentMatch?.[1] || 'unknown', headlines };
  });

  // Fetch key market tickers via API
  const marketTickers = ['ES=F', 'NQ=F', 'YM=F', '^VIX', 'CL=F', 'BZ=F', 'GC=F', 'BTC-USD', 'EURUSD=X', '^TNX'];
  const quotes = [];
  for (const t of marketTickers) {
    const q = await fetchQuote(page, t);
    quotes.push(q);
  }

  return { ...summary, quotes };
}

function formatMarkdown(data) {
  if (Array.isArray(data)) {
    let md = '## Perplexity Finance - Multi-Ticker Snapshot\n\n';
    md += '| Ticker | Name | Price | Change | % | Day Range | Year High |\n';
    md += '|--------|------|-------|--------|---|-----------|----------|\n';
    for (const d of data) {
      if (d.error) { md += `| ${d.ticker} | ERROR | ${d.error} | | | | |\n`; continue; }
      const sign = d.change >= 0 ? '+' : '';
      md += `| ${d.ticker} | ${d.name} | $${d.price?.toFixed(2)} | ${sign}$${d.change?.toFixed(2)} | ${sign}${d.changePercent?.toFixed(2)}% | $${d.dayLow?.toFixed(2)}–$${d.dayHigh?.toFixed(2)} | $${d.yearHigh?.toFixed(2)} |\n`;
    }
    return md;
  }

  if (data.quotes) return formatMarketSummary(data);
  return formatSingleTicker(data);
}

function formatSingleTicker(d) {
  if (d.error) return `**${d.ticker}**: Error - ${d.error}`;
  const sign = d.change >= 0 ? '+' : '';
  let md = `## ${d.name} (${d.ticker})\n\n`;
  md += `**Price**: $${d.price?.toFixed(2)}  |  **Change**: ${sign}$${d.change?.toFixed(2)} (${sign}${d.changePercent?.toFixed(2)}%)\n`;
  if (d.timestamp) md += `*${d.timestamp}*\n`;
  md += '\n';

  md += '| Stat | Value |\n|------|-------|\n';
  md += `| Prev Close | $${d.prevClose?.toFixed(2)} |\n`;
  md += `| Open | $${d.open?.toFixed(2)} |\n`;
  md += `| Day Range | $${d.dayLow?.toFixed(2)} – $${d.dayHigh?.toFixed(2)} |\n`;
  md += `| Year High | $${d.yearHigh?.toFixed(2)} |\n`;
  md += `| Year Low | $${d.yearLow?.toFixed(2)} |\n`;
  if (d.volume) md += `| Volume | ${fmtNum(d.volume)} |\n`;
  if (d.avgVolume) md += `| Avg Volume | ${fmtNum(d.avgVolume)} |\n`;
  if (d.marketCap) md += `| Market Cap | ${fmtNum(d.marketCap)} |\n`;
  if (d.pe) md += `| P/E Ratio | ${d.pe.toFixed(2)} |\n`;
  if (d.eps) md += `| EPS | $${d.eps.toFixed(2)} |\n`;
  if (d.dividendYield) md += `| Div Yield | ${d.dividendYield.toFixed(2)}% |\n`;
  md += `| 50D Avg | $${d.priceAvg50?.toFixed(2)} |\n`;
  md += `| 200D Avg | $${d.priceAvg200?.toFixed(2)} |\n`;
  return md;
}

function formatMarketSummary(data) {
  let md = `## Perplexity Finance - Market Overview\n\n`;
  md += `**Sentiment**: ${data.sentiment}\n\n`;

  if (data.quotes.length > 0) {
    md += '### Key Market Prices\n\n';
    md += '| Ticker | Name | Price | Change | % |\n';
    md += '|--------|------|-------|--------|---|\n';
    for (const d of data.quotes) {
      if (d.error) { md += `| ${d.ticker} | - | ERROR | | |\n`; continue; }
      const sign = d.change >= 0 ? '+' : '';
      md += `| ${d.ticker} | ${d.name} | $${d.price?.toFixed(2)} | ${sign}$${d.change?.toFixed(2)} | ${sign}${d.changePercent?.toFixed(2)}% |\n`;
    }
    md += '\n';
  }

  if (data.headlines.length > 0) {
    md += '### Market Summary Headlines\n\n';
    for (const h of data.headlines) md += `- ${h}\n`;
  }
  return md;
}

function fmtNum(n) {
  if (!n) return '-';
  if (n >= 1e12) return `$${(n/1e12).toFixed(2)}T`;
  if (n >= 1e9) return `$${(n/1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n/1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n/1e3).toFixed(1)}K`;
  return n.toString();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
