const TRADING_ECONOMICS_BASE_URL = 'https://tradingeconomics.com';

export { TRADING_ECONOMICS_BASE_URL };

export function cleanText(value, { collapseWhitespace = false } = {}) {
  let text = String(value ?? '').replace(/\u00a0/g, ' ');
  if (collapseWhitespace) text = text.replace(/\s+/g, ' ');
  return text.trim();
}

export function escapeMarkdown(value) {
  return cleanText(value).replace(/\|/g, '\\|');
}

export function markdownTable(headers, rows) {
  const escapedHeaders = headers.map(escapeMarkdown);
  let output = `| ${escapedHeaders.join(' | ')} |\n`;
  output += `| ${headers.map(() => '---').join(' | ')} |\n`;
  for (const row of rows) {
    output += `| ${row.map(escapeMarkdown).join(' | ')} |\n`;
  }
  return output;
}

export function isZero(value) {
  return /^[+-]?0+(?:\.0+)?$/.test(cleanText(value).replace(/,/g, ''));
}

export function withDirection(value, direction) {
  const cleaned = cleanText(value);
  if (!cleaned || isZero(cleaned) || cleaned.startsWith('-') || cleaned.startsWith('+')) return cleaned;
  if (direction === 'negative') return `-${cleaned}`;
  if (direction === 'positive') return `+${cleaned}`;
  return cleaned;
}

export function formatNumber(value) {
  if (value === null || value === undefined || value === '') return '';
  return Number.isFinite(Number(value)) ? String(Number(value)) : cleanText(value);
}

export function formatPercentNumber(value) {
  if (value === null || value === undefined || value === '') return '';
  return Number.isFinite(Number(value)) ? `${Number(value).toFixed(2)}%` : cleanText(value);
}

export function splitNameUnit(text) {
  const value = cleanText(text).replace(/\s+/g, ' ');
  const match = value.match(/^(.*?)\s*\(([^()]*)\)$/);
  if (!match) return { indicator: value, unit: '' };
  return { indicator: cleanText(match[1]), unit: cleanText(match[2]) };
}

export function slugify(value) {
  return cleanText(value).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function titleCase(value) {
  return cleanText(value).split(/[-\s]+/).filter(Boolean).map(part => part[0]?.toUpperCase() + part.slice(1)).join(' ');
}

export function normalizeCountryName(value) {
  return cleanText(value).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();
}

export function slugFromTradingEconomicsUrl(url, marker) {
  try {
    const parsed = new URL(url, TRADING_ECONOMICS_BASE_URL);
    const parts = parsed.pathname.split('/').filter(Boolean);
    const markerIndex = parts.indexOf(marker);
    if (markerIndex > 0) return parts[markerIndex - 1];
    return parts[0] || '';
  } catch {
    return '';
  }
}

export function buildTradingEconomicsMetadata(result, extra = {}) {
  return {
    source: result.source,
    url: result.url,
    captured_at: result.captured_at,
    json: result,
    cache_hit: false,
    ...extra,
  };
}

export async function dismissTradingEconomicsOverlays(page, { includeSubscribe = false } = {}) {
  await page.evaluate((options) => {
    const consentButton = Array.from(document.querySelectorAll('button, [role="button"]'))
      .find((candidate) => /^(Consent|Accept all|Accept|I agree|Agree)$/i.test((candidate.innerText || '').trim()));
    if (consentButton) consentButton.click();

    const removableText = options.includeSubscribe
      ? /(subscribe to unlock access|consent|cookies|personal data|legitimate interest|manage options)/i
      : /(consent|cookies|personal data|legitimate interest|manage options)/i;

    for (const element of Array.from(document.querySelectorAll('body *'))) {
      const style = window.getComputedStyle(element);
      const zIndex = Number.parseInt(style.zIndex, 10);
      const isSubscribePrompt = options.includeSubscribe && element.id === 'subscribe-prompt';
      if (!isSubscribePrompt && style.position !== 'fixed' && style.position !== 'sticky') continue;
      if (!isSubscribePrompt && (!Number.isFinite(zIndex) || zIndex < 1000)) continue;
      const text = element.innerText || '';
      if (isSubscribePrompt || removableText.test(text)) element.remove();
    }

    document.documentElement.style.overflow = 'auto';
    document.body.style.overflow = 'auto';
  }, { includeSubscribe }).catch(() => {});
}

export async function prepareTradingEconomicsPage(
  page,
  selector,
  { timeout = 15000, settleMs = 1000, includeSubscribe = false } = {},
) {
  await dismissTradingEconomicsOverlays(page, { includeSubscribe });
  await page.waitForSelector(selector, { timeout });
  await new Promise(resolve => setTimeout(resolve, settleMs));
  await dismissTradingEconomicsOverlays(page, { includeSubscribe });
}

export async function pageTextPreview(page, chars = 2500) {
  return page.evaluate((limit) => document.body.innerText.substring(0, limit), chars);
}

export async function extractTradingEconomicsTables(page, selector, {
  includeHeaders = true,
  skipHeader = true,
  cleanWhitespace = false,
  includeDirection = true,
} = {}) {
  return page.evaluate((options) => {
    const clean = (value) => {
      let text = String(value ?? '').replace(/\u00a0/g, ' ');
      if (options.cleanWhitespace) text = text.replace(/\s+/g, ' ');
      return text.trim();
    };
    const cellPayload = (cell) => {
      const payload = {
        text: clean(cell.innerText || cell.textContent || ''),
        url: cell.querySelector('a')?.href || '',
      };
      if (options.includeDirection) {
        payload.direction = cell.querySelector('.market-negative-image') ? 'negative'
          : cell.querySelector('.market-positive-image') ? 'positive'
            : '';
      }
      return payload;
    };

    return Array.from(document.querySelectorAll(options.selector)).map((table, tableIndex) => {
      const headerCells = Array.from(table.rows[0]?.cells || []);
      const headers = headerCells.map(cell => clean(cell.innerText || cell.textContent || ''));
      return {
        tableIndex,
        category: headers[0] || '',
        ...(options.includeHeaders ? { headers } : {}),
        rows: Array.from(table.rows).slice(options.skipHeader ? 1 : 0).map(row => ({
          cells: Array.from(row.cells).map(cellPayload),
        })),
      };
    });
  }, { selector, includeHeaders, skipHeader, cleanWhitespace, includeDirection });
}

export async function extractTradingEconomicsCountryTablePayload(page) {
  const tables = await extractTradingEconomicsTables(page, 'table', { cleanWhitespace: true });
  return tables.find((table) => table.headers?.includes('Country') && table.headers.length >= 3) ||
    tables[0] ||
    { headers: [], rows: [] };
}

export async function extractTradingEconomicsForecastTablesPayload(page) {
  return {
    tables: await extractTradingEconomicsTables(page, 'table.table-hover', { cleanWhitespace: true }),
  };
}

export async function extractTradingEconomicsMatrixPayload(page) {
  const tables = await extractTradingEconomicsTables(page, 'table#matrix');
  return tables[0] || { headers: [], rows: [] };
}

export async function extractTradingEconomicsIndicatorTabsPayload(page) {
  return page.evaluate(() => {
    const cellPayload = (cell) => ({
      text: cell.innerText || cell.textContent || '',
      url: cell.querySelector('a')?.href || '',
    });
    const tabs = Array.from(document.querySelectorAll('a[role="tab"][href*="#"]'))
      .map((anchor) => ({
        id: new URL(anchor.href).hash.replace('#', ''),
        label: anchor.innerText.trim(),
      }))
      .filter(tab => tab.id && tab.label);

    const tabTables = tabs.map((tab) => {
      const pane = document.getElementById(tab.id);
      return {
        id: tab.id,
        label: tab.label,
        tables: Array.from(pane?.querySelectorAll('table.table-hover') || []).map((table, tableIndex) => ({
          tableIndex,
          rows: Array.from(table.rows).map(row => ({
            cells: Array.from(row.cells).map(cellPayload),
          })),
        })),
      };
    });

    return { tabs, tabTables };
  });
}

export async function extractTradingEconomicsSharesPayload(page, selector) {
  const [tree, topTables] = await Promise.all([
    page.evaluate(() => {
      const script = Array.from(document.scripts)
        .find(candidate => candidate.textContent.includes('const data = {"name":"_root_"'));
      if (!script) return null;
      const marker = 'const data = ';
      const text = script.textContent;
      const markerIndex = text.indexOf(marker);
      if (markerIndex === -1) return null;
      const start = markerIndex + marker.length;
      let depth = 0;
      let inString = false;
      let escaping = false;
      let end = start;

      for (; end < text.length; end += 1) {
        const char = text[end];
        if (inString) {
          if (escaping) escaping = false;
          else if (char === '\\') escaping = true;
          else if (char === '"') inString = false;
        } else if (char === '"') inString = true;
        else if (char === '{') depth += 1;
        else if (char === '}') {
          depth -= 1;
          if (depth === 0) {
            end += 1;
            break;
          }
        }
      }

      return JSON.parse(text.slice(start, end));
    }),
    extractTradingEconomicsTables(page, selector),
  ]);

  return { tree, topTables };
}
