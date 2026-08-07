import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
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

function noCache() {
  return { read: () => null, write: () => null };
}

function makeGrokFallbackProvider({ rateLimitedModels = [], fallbackArgs = [], modelUsedBySelectedModel = {} } = {}) {
  const rateLimited = new Set(rateLimitedModels);
  const attempts = [];
  return {
    provider: {
      ...grokProvider,
      runRequiresBrowser: () => false,
      fallbackModels(args) {
        fallbackArgs.push(args);
        return grokProvider.fallbackModels(args);
      },
      async run({ selectedModel }) {
        attempts.push(selectedModel);
        const modelUsed = modelUsedBySelectedModel[selectedModel] || selectedModel;
        if (rateLimited.has(selectedModel) || rateLimited.has(modelUsed)) {
          return {
            text: `quota for ${selectedModel}`,
            rawText: `quota for ${selectedModel}`,
            done: true,
            rateLimited: true,
            modelUsed,
            providerState: { transport: 'browser-ui', selected_model: modelUsed },
          };
        }
        return {
          text: `answer from ${selectedModel}`,
          rawText: `answer from ${selectedModel}`,
          done: true,
          rateLimited: false,
          modelUsed,
          providerState: { transport: 'browser-ui', selected_model: modelUsed },
        };
      },
    },
    attempts,
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

test('Grok --task reasoning falls back from resolved expert model', async () => {
  const stdout = [];
  const fallbackArgs = [];
  const { provider, attempts } = makeGrokFallbackProvider({ rateLimitedModels: ['expert', 'auto'], fallbackArgs });
  const request = buildAiChatRequest({ providerName: 'grok', modelTask: 'reasoning', prompt: 'think hard', jsonOutput: true });

  const result = await runAiChat(request, {
    provider,
    connectBrowser: async () => assert.fail('connectBrowser should not be called'),
    cache: noCache(),
    io: { stdout: text => stdout.push(text), writeFile: () => assert.fail('no file expected') },
  });

  const emitted = JSON.parse(stdout[0]);
  assert.deepEqual(attempts, ['expert', 'fast']);
  assert.equal(fallbackArgs.length, 1);
  assert.equal(fallbackArgs[0].requestedModel, 'default');
  assert.equal(fallbackArgs[0].initialModel, 'expert');
  assert.equal(fallbackArgs[0].selectedModel, 'expert');
  assert.equal(fallbackArgs[0].rejectedModel, 'expert');
  assert.equal(fallbackArgs[0].rejectedModelUsed, 'expert');
  assert.equal(fallbackArgs[0].request.modelTask, 'reasoning');
  assert.equal(fallbackArgs[0].result.modelUsed, 'expert');
  assert.equal(result.metadata.fallback_from, 'expert');
  assert.equal(emitted.fallback_from, 'expert');
  assert.equal(emitted.model_fallback_from, 'expert');
  assert.equal(emitted.model_fallback_reason, 'rate_limited');
  assert.deepEqual(emitted.fallback_attempts, ['expert', 'fast']);
  assert.equal(emitted.requested_model, 'default');
  assert.equal(emitted.model_task, 'reasoning');
  assert.equal(emitted.selected_model, 'fast');
  assert.equal(emitted.response, 'answer from fast');
});

test('Grok explicit model fallback metadata reports the rejected explicit model', async () => {
  const stdout = [];
  const fallbackArgs = [];
  const { provider, attempts } = makeGrokFallbackProvider({
    rateLimitedModels: ['think'],
    fallbackArgs,
    modelUsedBySelectedModel: { think: 'expert' },
  });
  const request = buildAiChatRequest({
    providerName: 'grok',
    modelName: 'think',
    modelTask: 'quick',
    prompt: 'use expert even with a quick task',
    jsonOutput: true,
  });

  await runAiChat(request, {
    provider,
    connectBrowser: async () => assert.fail('connectBrowser should not be called'),
    cache: noCache(),
    io: { stdout: text => stdout.push(text), writeFile: () => assert.fail('no file expected') },
  });

  const emitted = JSON.parse(stdout[0]);
  assert.deepEqual(attempts, ['think', 'fast']);
  assert.equal(fallbackArgs.length, 1);
  assert.equal(fallbackArgs[0].rejectedModel, 'think');
  assert.equal(fallbackArgs[0].rejectedModelUsed, 'expert');
  assert.equal(emitted.requested_model, 'think');
  assert.equal(emitted.model_task, 'quick');
  assert.equal(emitted.fallback_from, 'think');
  assert.equal(emitted.model_fallback_from, 'think');
  assert.equal(emitted.model_fallback_reason, 'rate_limited');
  assert.deepEqual(emitted.fallback_attempts, ['think', 'fast']);
  assert.equal(emitted.selected_model, 'fast');
});

test('Grok default non-rate-limited metadata keeps fallback fields empty', async () => {
  const stdout = [];
  const { provider, attempts } = makeGrokFallbackProvider();
  const request = buildAiChatRequest({ providerName: 'grok', prompt: 'simple default', jsonOutput: true });

  await runAiChat(request, {
    provider: {
      ...provider,
      fallbackModels: () => assert.fail('fallbackModels should not be called without a rate limit'),
    },
    connectBrowser: async () => assert.fail('connectBrowser should not be called'),
    cache: noCache(),
    io: { stdout: text => stdout.push(text), writeFile: () => assert.fail('no file expected') },
  });

  const emitted = JSON.parse(stdout[0]);
  assert.deepEqual(attempts, ['fast']);
  assert.equal(emitted.requested_model, 'default');
  assert.equal(emitted.model_task, null);
  assert.equal(emitted.selected_model, 'fast');
  assert.equal(emitted.fallback_from, null);
  assert.deepEqual(emitted.fallback_attempts, ['fast']);
  assert.equal(emitted.model_fallback_from, null);
  assert.equal(emitted.model_fallback_reason, null);
  assert.equal(emitted.rate_limited, false);
  assert.equal(emitted.complete, true);
});

test('Grok evidence capture uses the final conversation tab instead of the active new tab', async () => {
  const stdout = [];
  const captured = [];
  const finalUrl = 'https://x.com/i/grok?conversation=abc123';
  const evidencePath = '/tmp/.ai-chat-evidence-test/grok-final-tab-evidence.png';
  const grokPage = {
    url: () => finalUrl,
    screenshot: async (options) => { captured.push({ page: 'grok', options }); writeFileSync(options.path, 'png'); },
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
