import test from 'node:test';
import assert from 'node:assert/strict';

import { chatgptProvider } from '../scripts/ai-chat/providers/chatgpt.mjs';
import { grokProvider } from '../scripts/ai-chat/providers/grok.mjs';
import { openPerplexityNetworkPage } from '../scripts/ai-chat/providers/perplexity.mjs';

async function withFastTimeouts(fn) {
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, _ms, ...args) => originalSetTimeout(callback, 0, ...args);
  try {
    return await fn();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
}

function makePage(initialUrl) {
  let currentUrl = initialUrl;
  const page = {
    navigations: [],
    evaluateCalls: 0,
    url: () => currentUrl,
    async goto(url) {
      page.navigations.push(url);
      currentUrl = url;
    },
    async evaluate() {
      page.evaluateCalls += 1;
    },
  };
  return page;
}

function makeBrowser({ pages, newPage }) {
  const newPageCalls = [];
  return {
    newPageCalls,
    async pages() {
      return pages;
    },
    async newPage(options) {
      newPageCalls.push(options);
      return newPage;
    },
  };
}

test('ChatGPT tab selection ignores provider domains outside the hostname and opens a background tab', async () => withFastTimeouts(async () => {
  const fakeQuery = makePage('https://evil.example/?q=chatgpt.com');
  const fakeFragment = makePage('https://evil.example/#chatgpt.com');
  const trustedNew = makePage('https://chatgpt.com/');
  const browser = makeBrowser({ pages: [fakeQuery, fakeFragment], newPage: trustedNew });

  const page = await chatgptProvider.findPage({ browser, continueChat: false, request: {} });

  assert.equal(page, trustedNew);
  assert.deepEqual(browser.newPageCalls, [{ background: true }]);
  assert.deepEqual(trustedNew.navigations, ['https://chatgpt.com']);
}));

test('ChatGPT reuses the managed browser startup tab for visible UI interaction', async () => withFastTimeouts(async () => {
  for (const startupUrl of ['about:blank', 'chrome://new-tab-page/']) {
    const startup = makePage(startupUrl);
    const browser = {
      pages: async () => [startup],
      newPage: async () => assert.fail('the visible startup tab should be reused'),
    };

    const page = await chatgptProvider.findPage({ browser, continueChat: false, request: {} });

    assert.equal(page, startup);
    assert.deepEqual(startup.navigations, ['https://chatgpt.com']);
  }
}));

test('ChatGPT tab selection reuses a real provider host', async () => withFastTimeouts(async () => {
  const real = makePage('https://chatgpt.com/c/abc123');
  const browser = {
    pages: async () => [real],
    newPage: async () => assert.fail('real ChatGPT tabs should be reused'),
  };

  const page = await chatgptProvider.findPage({ browser, continueChat: true, request: {} });

  assert.equal(page, real);
}));

test('Grok tab selection ignores provider domains outside the hostname and opens a background tab', async () => withFastTimeouts(async () => {
  const fakePath = makePage('https://evil.example/x.com/i/grok');
  const fakeFragment = makePage('https://evil.example/#x.com/i/grok');
  const trustedNew = makePage('about:blank');
  const browser = makeBrowser({ pages: [fakePath, fakeFragment], newPage: trustedNew });

  const page = await grokProvider.findPage({ browser, continueChat: false });

  assert.equal(page, trustedNew);
  assert.deepEqual(browser.newPageCalls, [{ background: true }]);
  assert.deepEqual(trustedNew.navigations, ['https://x.com/i/grok']);
}));

test('Grok tab selection reuses a real provider host', async () => withFastTimeouts(async () => {
  const real = makePage('https://x.com/home');
  const browser = {
    pages: async () => [real],
    newPage: async () => assert.fail('real X tabs should be reused'),
  };

  const page = await grokProvider.findPage({ browser, continueChat: false });

  assert.equal(page, real);
  assert.deepEqual(real.navigations, ['https://x.com/i/grok']);
}));

test('Perplexity opens only its dedicated background same-origin network page', async () => withFastTimeouts(async () => {
  const existingUiPage = makePage('https://www.perplexity.ai/search/uuid');
  const networkPage = makePage('about:blank');
  const browser = makeBrowser({ pages: [existingUiPage], newPage: networkPage });

  const page = await openPerplexityNetworkPage(browser);

  assert.equal(page, networkPage);
  assert.deepEqual(browser.newPageCalls, [{ background: true }]);
  assert.deepEqual(networkPage.navigations, ['https://www.perplexity.ai/api/auth/session']);
  assert.deepEqual(existingUiPage.navigations, []);
}));

test('Perplexity reuses only the dedicated same-origin network page', async () => withFastTimeouts(async () => {
  const networkPage = makePage('https://www.perplexity.ai/api/auth/session');
  const browser = {
    pages: async () => [networkPage],
    newPage: async () => assert.fail('dedicated Perplexity network page should be reused'),
  };

  const page = await openPerplexityNetworkPage(browser);

  assert.equal(page, networkPage);
  assert.deepEqual(networkPage.navigations, []);
}));
