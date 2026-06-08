import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAiChatRequest, runAiChat } from '../scripts/ai-chat/module.mjs';
import { classifyGrokPageState, grokProvider, isGrokPlaceholderResponse } from '../scripts/ai-chat/providers/grok.mjs';

const INCIDENT_PLACEHOLDER = 'Thinking about your request\n7 more\n7 more';

function makeGrokDirectProvider(responseText) {
  return {
    ...grokProvider,
    runRequiresBrowser: () => false,
    async run() {
      return {
        text: responseText,
        rawText: responseText,
        done: true,
        rateLimited: false,
        modelUsed: 'fast',
      };
    },
  };
}

test('Grok placeholder detector rejects the incident UI text', () => {
  assert.equal(isGrokPlaceholderResponse({ text: INCIDENT_PLACEHOLDER }), true);
});

test('Grok placeholder detector allows a real short answer', () => {
  assert.equal(isGrokPlaceholderResponse({ text: 'Yes.' }), false);
});

test('Grok page state classifier accepts a usable composer', () => {
  const state = classifyGrokPageState({
    url: 'https://x.com/i/grok',
    bodyText: 'Grok\nAsk anything',
    title: 'Grok / X',
    hasComposer: true,
    composerDisabled: false,
    loginTextVisible: false,
  });

  assert.equal(state.usable, true);
  assert.equal(state.status, 'ready');
});

test('Grok page state classifier reports an unauthenticated X session', () => {
  const state = classifyGrokPageState({
    url: 'https://x.com/i/flow/login?redirect_after_login=%2Fi%2Fgrok',
    bodyText: 'Log in to X\nSign in\nCreate account',
    title: 'Log in to X',
    hasComposer: false,
    composerDisabled: false,
    loginTextVisible: true,
  });

  assert.equal(state.usable, false);
  assert.equal(state.status, 'auth_required');
  assert.match(state.reason, /not authenticated/i);
});

test('Grok auth preflight fails before prompt submission on an unusable page', async () => {
  const calls = [];
  const fakePage = {
    url: () => 'https://x.com/i/flow/login?redirect_after_login=%2Fi%2Fgrok',
    evaluate: async () => ({
      url: 'https://x.com/i/flow/login?redirect_after_login=%2Fi%2Fgrok',
      bodyText: 'Log in to X\nSign in\nCreate account',
      title: 'Log in to X',
      hasComposer: false,
      composerDisabled: false,
      loginTextVisible: true,
    }),
  };
  const request = buildAiChatRequest({ providerName: 'grok', modelName: 'fast', prompt: 'hello', jsonOutput: true });
  const provider = {
    ...grokProvider,
    async findPage() { return fakePage; },
    async setModel() { calls.push('setModel'); },
    async clearInput() { calls.push('clearInput'); },
    async typePrompt() { calls.push('typePrompt'); },
    async submit() { calls.push('submit'); },
  };

  await assert.rejects(
    () => runAiChat(request, {
      provider,
      browser: { pages: async () => [fakePage] },
      cache: { read: () => null, write: () => assert.fail('cache write should not be called') },
      io: { stdout: () => assert.fail('stdout should not be called'), writeFile: () => assert.fail('no file expected') },
    }),
    (error) => {
      assert.match(error.message, /Browser session is not authenticated for X\/Grok/i);
      assert.match(error.message, /default or configured Chrome profile/i);
      assert.match(error.message, /--sync/);
      assert.match(error.message, /Current page: https:\/\/x\.com\/i\/flow\/login/);
      return true;
    },
  );
  assert.deepEqual(calls, []);
});

test('Grok placeholder-only output is not reported complete and is not cached', async () => {
  const stdout = [];
  const cacheWrites = [];
  const request = buildAiChatRequest({ providerName: 'grok', modelName: 'fast', prompt: 'hello', jsonOutput: true });

  const result = await runAiChat(request, {
    provider: makeGrokDirectProvider(INCIDENT_PLACEHOLDER),
    connectBrowser: async () => assert.fail('connectBrowser should not be called'),
    cache: {
      read: () => null,
      write: (...args) => {
        cacheWrites.push(args);
        return { key: 'cache-key' };
      },
    },
    io: { stdout: text => stdout.push(text), writeFile: () => assert.fail('no file expected') },
  });

  const emitted = JSON.parse(stdout[0]);
  assert.equal(result.metadata.complete, false);
  assert.equal(emitted.complete, false);
  assert.equal(emitted.rate_limited, false);
  assert.equal(cacheWrites.length, 0);
});

test('Grok real short answer can still complete and be cached', async () => {
  const stdout = [];
  const cacheWrites = [];
  const request = buildAiChatRequest({ providerName: 'grok', modelName: 'fast', prompt: 'answer yes or no', jsonOutput: true });

  const result = await runAiChat(request, {
    provider: makeGrokDirectProvider('Yes.'),
    connectBrowser: async () => assert.fail('connectBrowser should not be called'),
    cache: {
      read: () => null,
      write: (...args) => {
        cacheWrites.push(args);
        return { key: 'cache-key' };
      },
    },
    io: { stdout: text => stdout.push(text), writeFile: () => assert.fail('no file expected') },
  });

  const emitted = JSON.parse(stdout[0]);
  assert.equal(result.metadata.complete, true);
  assert.equal(emitted.complete, true);
  assert.equal(emitted.response, 'Yes.');
  assert.equal(cacheWrites.length, 1);
});

test('Grok evidence capture uses the final conversation tab instead of the active new tab', async () => {
  const stdout = [];
  const captured = [];
  const finalUrl = 'https://x.com/i/grok?conversation=abc123';
  const evidencePath = '/tmp/grok-final-tab-evidence.png';
  const grokPage = {
    url: () => finalUrl,
    screenshot: async (options) => captured.push({ page: 'grok', options }),
  };
  const activeNewTab = {
    url: () => 'chrome://new-tab-page/',
    screenshot: async () => assert.fail('active new tab should not be captured'),
  };
  const request = {
    ...buildAiChatRequest({ providerName: 'grok', modelName: 'fast', prompt: 'hello', jsonOutput: true }),
    captureEvidence: true,
    evidencePath,
  };

  const result = await runAiChat(request, {
    browser: { pages: async () => [grokPage, activeNewTab] },
    provider: {
      ...makeGrokDirectProvider('final answer'),
      runRequiresBrowser: () => true,
      async run() {
        return {
          text: 'final answer',
          rawText: 'final answer',
          done: true,
          rateLimited: false,
          modelUsed: 'fast',
          finalUrl,
        };
      },
    },
    cache: {
      read: () => assert.fail('evidence requests should not use cached output'),
      write: () => assert.fail('evidence requests should not cache per-run artifacts'),
    },
    io: { stdout: text => stdout.push(text), writeFile: () => assert.fail('no file expected') },
  });

  const emitted = JSON.parse(stdout[0]);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].page, 'grok');
  assert.equal(captured[0].options.path, evidencePath);
  assert.equal(result.metadata.evidence_path, evidencePath);
  assert.equal(result.metadata.evidence_url, finalUrl);
  assert.equal(emitted.evidence_path, evidencePath);
  assert.equal(emitted.evidence_url, finalUrl);
});
