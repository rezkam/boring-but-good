import { writeFileSync } from 'node:fs';
import { DEFAULT_PORT, connectBrowser } from './browser-control.mjs';
import { readCachedResponse, writeCachedResponse } from './browser-query-cache.mjs';

export function writeResourceOutput({ output, outFile = null, metadata = null }) {
  if (outFile) {
    writeFileSync(outFile, output, 'utf-8');
    if (metadata) writeFileSync(`${outFile}.meta.json`, JSON.stringify(metadata, null, 2), 'utf-8');
    console.log(`Saved to ${outFile}`);
    return;
  }

  console.log(output);
}

export function readCachedResourceOutput({ tool, cacheInput, outFile = null, readCache = readCachedResponse } = {}) {
  const cached = readCache(tool, cacheInput);
  if (!cached) return null;

  const metadata = {
    ...(cached.entry?.metadata || {}),
    cache_hit: true,
    cache_key: cached.key,
  };
  writeResourceOutput({ output: cached.output, outFile, metadata });
  return { status: 'cached', key: cached.key, output: cached.output, metadata };
}

export function writeResourceCache({
  tool,
  cacheInput,
  output,
  rawText = output,
  pageUrl = null,
  metadata = {},
  extension = 'txt',
  writeCache = writeCachedResponse,
} = {}) {
  const cacheWrite = writeCache(tool, cacheInput, {
    output,
    rawText,
    pageUrl,
    metadata,
    extension,
  });
  if (cacheWrite) metadata.cache_key = cacheWrite.key;
  return cacheWrite;
}

export async function newBackgroundPage(browser) {
  return browser.newPage({ background: true });
}

export async function closeResourcePage(page) {
  if (!page) return;
  const isClosed = typeof page.isClosed === 'function' ? page.isClosed() : false;
  if (!isClosed && typeof page.close === 'function') await page.close().catch(() => {});
}

function connectOptionsForOwner(ownerToken) {
  return ownerToken === undefined ? {} : { ownerToken };
}

function normalizePageResult(pageResult, closePage) {
  if (pageResult && typeof pageResult === 'object' && Object.hasOwn(pageResult, 'page')) {
    return {
      page: pageResult.page,
      closePage: Object.hasOwn(pageResult, 'closePage') ? Boolean(pageResult.closePage) : closePage,
    };
  }
  return { page: pageResult, closePage };
}

export async function runBrowserResource({
  port = DEFAULT_PORT,
  ownerToken = undefined,
  connect = connectBrowser,
  getPage = null,
  closePage = false,
  run,
} = {}) {
  if (typeof run !== 'function') throw new Error('Missing Resource Helper run function');

  const browser = await connect(port, connectOptionsForOwner(ownerToken));
  let page = null;
  let shouldClosePage = closePage;

  try {
    const normalized = normalizePageResult(getPage ? await getPage(browser) : null, closePage);
    page = normalized.page;
    shouldClosePage = normalized.closePage;
    return await run({ browser, page });
  } finally {
    if (shouldClosePage) await closeResourcePage(page);
    if (browser && typeof browser.disconnect === 'function') browser.disconnect();
  }
}

export async function runCachedBrowserResource({
  tool,
  cacheInput,
  outFile = null,
  port = DEFAULT_PORT,
  ownerToken = undefined,
  connect = connectBrowser,
  getPage = newBackgroundPage,
  closePage = true,
  run,
  readCache = readCachedResponse,
  writeCache = writeCachedResponse,
} = {}) {
  const cached = readCachedResourceOutput({ tool, cacheInput, outFile, readCache });
  if (cached) return cached;
  if (typeof run !== 'function') throw new Error('Missing Resource Helper run function');

  return runBrowserResource({
    port,
    ownerToken,
    connect,
    getPage,
    closePage,
    run: async ({ browser, page }) => {
      const result = await run({ browser, page });
      if (!result || !Object.hasOwn(result, 'output')) throw new Error('Resource Helper run function must return output');
      const output = result.output;
      const metadata = result.metadata || {};
      const extension = result.extension || 'txt';
      const pageUrl = result.pageUrl ?? (page && typeof page.url === 'function' ? page.url() : null);
      writeResourceCache({
        tool,
        cacheInput,
        output,
        rawText: result.rawText ?? output,
        pageUrl,
        metadata,
        extension,
        writeCache,
      });
      writeResourceOutput({ output, outFile, metadata });
      return { status: 'fresh', output, metadata };
    },
  });
}
