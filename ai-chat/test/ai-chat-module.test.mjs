import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  buildAiChatRequest,
  buildCacheInput,
  buildMetadata,
  conversationRecordPath,
  parseAiChatArgs,
  resolveConversationReference,
  resolveInitialModel,
  runAiChat,
  saveConversationReference,
  validateConversationUrlForProvider,
  writeAiChatBrowserState,
} from '../scripts/ai-chat/module.mjs';
import { chatgptProvider } from '../scripts/ai-chat/providers/chatgpt.mjs';
import { geminiProvider } from '../scripts/ai-chat/providers/gemini.mjs';
import { grokProvider } from '../scripts/ai-chat/providers/grok.mjs';
import { buildPerplexityPayload, perplexityProvider, resolvePerplexityModel } from '../scripts/ai-chat/providers/perplexity.mjs';
import { getCacheConfig as getAiChatCacheConfig } from '../scripts/browser-query-cache.mjs';

function withEnv(env, fn) {
  const previous = {};
  for (const key of Object.keys(env)) {
    previous[key] = process.env[key];
    if (env[key] === null) delete process.env[key];
    else process.env[key] = env[key];
  }

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function noCache() {
  return { read: () => null, write: () => null };
}

function fileMode(path) {
  return statSync(path).mode & 0o777;
}

test('parseAiChatArgs supports provider options and conversation flags', () => {
  const request = buildAiChatRequest(parseAiChatArgs([
    '--provider', 'perplexity',
    '--prompt', 'hello',
    '--model', 'perplexity/deep-research',
    '--task', 'deep_research',
    '--conversation', 'thread-a',
    '--save-conversation', 'thread-a',
    '--attach-conversation', 'https://provider.test/thread-a',
    '--source-focus', 'academic,web',
    '--search-focus', 'web',
    '--time-range', 'week',
    '--citation-mode', 'markdown',
    '--language', 'sv-SE',
    '--timezone', 'Europe/Stockholm',
    '--save-to-library',
    '--chrome-profile', 'Work Profile',
    '--browser-profile', 'Browser Profile',
    '--cookie-source', 'chrome-profile',
    '--file', '/tmp/report.pdf',
    '--file', '/tmp/chart.png',
    '--space-uuid', '123e4567-e89b-12d3-a456-426614174000',
    '--stream',
    '--include-conversation',
    '--evidence',
    '--evidence-path', '/tmp/ai-chat-evidence.png',
    '--evidence-full-page',
    '--headless',
    '--include-google',
    '--verify-models',
    '--verify-model-timeout', '12',
    '--json',
  ]));

  assert.equal(request.providerName, 'perplexity');
  assert.equal(request.modelName, 'perplexity/deep-research');
  assert.equal(request.modelTask, 'deep_research');
  assert.equal(request.conversationTarget, 'thread-a');
  assert.equal(request.saveConversation, 'thread-a');
  assert.equal(request.attachConversation, 'https://provider.test/thread-a');
  assert.equal(request.providerOptions.sourceFocus, 'academic,web');
  assert.equal(request.providerOptions.searchFocus, 'web');
  assert.equal(request.providerOptions.timeRange, 'week');
  assert.equal(request.providerOptions.citationMode, 'markdown');
  assert.equal(request.providerOptions.language, 'sv-SE');
  assert.equal(request.providerOptions.timezone, 'Europe/Stockholm');
  assert.equal(request.providerOptions.saveToLibrary, true);
  assert.equal(request.providerOptions.chromeProfile, 'Work Profile');
  assert.equal(request.browserProfileName, 'Browser Profile');
  assert.equal(request.providerOptions.cookieSource, 'chrome-profile');
  assert.deepEqual(request.providerOptions.files, ['/tmp/report.pdf', '/tmp/chart.png']);
  assert.equal(request.providerOptions.spaceUuid, '123e4567-e89b-12d3-a456-426614174000');
  assert.equal(request.stream, true);
  assert.equal(request.includeConversation, true);
  assert.equal(request.captureEvidence, true);
  assert.equal(request.evidencePath, '/tmp/ai-chat-evidence.png');
  assert.equal(request.evidenceFullPage, true);
  assert.equal(request.browserHeadless, true);
  assert.equal(request.includeGoogle, true);
  assert.equal(request.verifyModels, true);
  assert.equal(request.verifyModelTimeoutSeconds, 12);
  assert.equal(request.jsonOutput, true);
});

test('parseAiChatArgs rejects missing values for value options without breaking boolean flags', () => {
  assert.throws(() => parseAiChatArgs(['--provider', '--prompt', 'hello']), /Missing value after --provider/);
  assert.throws(() => parseAiChatArgs(['--prompt-file', '--json']), /Missing value after --prompt-file/);
  assert.throws(() => parseAiChatArgs(['--evidence-path']), /Missing value after --evidence-path/);
  assert.throws(() => parseAiChatArgs(['--attach-conversation']), /Missing value after --attach-conversation/);
  assert.equal(parseAiChatArgs(['--evidence', '--prompt', 'hello']).captureEvidence, true);
});

test('parseAiChatArgs strictly validates timeout flags', () => {
  const invalidValues = ['1m', '10s', '1.5', '0', '-1', '', 'abc'];
  for (const flag of ['--timeout', '--verify-model-timeout']) {
    for (const value of invalidValues) {
      assert.throws(
        () => parseAiChatArgs([flag, value]),
        (error) => {
          assert.ok(error instanceof Error);
          assert.ok(error.message.includes(`Invalid ${flag} value`), error.message);
          assert.ok(error.message.includes(`"${value}"`), error.message);
          return true;
        },
      );
    }
  }

  const parsed = parseAiChatArgs(['--timeout', '42', '--verify-model-timeout', '12']);
  assert.equal(parsed.timeoutSeconds, 42);
  assert.equal(parsed.verifyModelTimeoutSeconds, 12);
});

test('parseAiChatArgs keeps repeated Perplexity source focus values in order', () => {
  const request = buildAiChatRequest(parseAiChatArgs([
    '--provider', 'perplexity',
    '--prompt', 'hello',
    '--source-focus', 'academic',
    '--source-focus', 'finance',
  ]));

  assert.deepEqual(request.providerOptions.sourceFocus, ['academic', 'finance']);
});

test('parseAiChatArgs exposes explicit Perplexity incognito mode', () => {
  const request = buildAiChatRequest(parseAiChatArgs([
    '--provider', 'perplexity',
    '--prompt', 'private question',
    '--incognito',
  ]));

  assert.equal(request.providerOptions.incognito, true);
  assert.equal(request.providerOptions.saveToLibrary, false);
});

test('AI Chat browser state writes enforce private file permissions and fail closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-chat-browser-state-permissions-'));
  const stateFile = join(dir, 'browser.json');
  const ownerToken = 'owner-token-must-not-leak';

  try {
    writeFileSync(stateFile, '{}\n', 'utf-8');
    chmodSync(stateFile, 0o666);

    writeAiChatBrowserState({ version: 1, ownerToken, port: 62100 }, stateFile);

    assert.equal(fileMode(stateFile), 0o600);
    assert.equal(JSON.parse(readFileSync(stateFile, 'utf-8')).ownerToken, ownerToken);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const writeCalls = [];
  const failingFs = {
    mkdir: () => {},
    writeFile: (...args) => writeCalls.push(args),
    chmod: () => { throw new Error(`cannot chmod ${ownerToken}`); },
  };

  assert.throws(
    () => writeAiChatBrowserState({ version: 1, ownerToken, port: 62100 }, '/tmp/ai-chat-browser.json', failingFs),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Failed to enforce private permissions/);
      assert.match(error.message, /AI Chat browser state/);
      assert.equal(error.message.includes(ownerToken), false);
      return true;
    },
  );
  assert.equal(writeCalls.length, 1);
});

test('buildCacheInput includes provider options and conversation target', () => {
  const request = buildAiChatRequest({
    providerName: 'perplexity',
    modelName: 'perplexity/best',
    prompt: 'question',
    conversationTarget: 'thread-a',
    includeConversation: false,
    providerOptions: { sourceFocus: 'academic' },
  });

  assert.deepEqual(buildCacheInput(request), {
    provider: 'perplexity',
    requested_model: 'perplexity/best',
    model_task: null,
    thinking: false,
    stream: false,
    continue_chat: false,
    conversation_target: 'thread-a',
    save_conversation: null,
    attach_conversation: null,
    json_output: false,
    include_conversation: false,
    provider_options: { sourceFocus: 'academic' },
    prompt: 'question',
  });
});

test('direct provider conversation URLs allow only trusted selected provider hosts', () => {
  const cases = [
    { provider: chatgptProvider, url: 'https://chatgpt.com/c/chatgpt-thread' },
    { provider: grokProvider, url: 'https://x.com/i/grok?conversation=grok-thread' },
    { provider: geminiProvider, url: 'https://gemini.google.com/app/gemini-thread' },
    { provider: perplexityProvider, url: 'https://www.perplexity.ai/search/perplexity-thread' },
  ];

  for (const { provider, url } of cases) {
    assert.equal(validateConversationUrlForProvider(provider, url, { optionName: '--conversation' }), url);
  }
});

test('direct Perplexity thread URLs retain backend state for a follow-up request', () => {
  const backendUuid = '1fcf54fa-dd85-4b77-a916-dc12f8a8efa5';
  const url = `https://www.perplexity.ai/search/${backendUuid}`;
  const conversation = resolveConversationReference(buildAiChatRequest({
    providerName: 'perplexity',
    prompt: 'continue this thread',
    conversationTarget: url,
  }), undefined, perplexityProvider);
  const payload = buildPerplexityPayload({
    query: 'continue this thread',
    model: resolvePerplexityModel('perplexity/best'),
    conversation,
  });

  assert.equal(conversation.url, url);
  assert.deepEqual(conversation.providerState, { backend_uuid: backendUuid });
  assert.equal(payload.params.last_backend_uuid, backendUuid);
  assert.equal(payload.params.query_source, 'followup');
});

test('runAiChat rejects untrusted ChatGPT conversation URLs before browser navigation', async () => {
  const request = buildAiChatRequest({
    providerName: 'chatgpt',
    prompt: 'hello',
    conversationTarget: 'https://attacker.example/?next=https://chatgpt.com',
  });
  let startedBrowser = false;

  await assert.rejects(
    () => runAiChat(request, {
      provider: chatgptProvider,
      cache: noCache(),
      startChrome: () => {
        startedBrowser = true;
        throw new Error('browser should not start for an untrusted conversation URL');
      },
    }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /\[chatgpt\]/);
      assert.match(error.message, /selected provider/);
      assert.match(error.message, /attacker\.example/);
      assert.match(error.message, /chatgpt\.com/);
      return true;
    },
  );
  assert.equal(startedBrowser, false);
});

test('runAiChat rejects untrusted ChatGPT attached conversation URLs before saving', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-chat-attach-url-validation-'));
  try {
    const request = buildAiChatRequest({
      providerName: 'chatgpt',
      attachConversation: 'https://evil.example/c/abc',
      saveConversation: 'local-session',
      conversationStoreDir: dir,
      jsonOutput: true,
    });

    const stdout = [];

    await assert.rejects(
      () => runAiChat(request, {
        provider: chatgptProvider,
        cache: noCache(),
        startChrome: () => assert.fail('browser should not start for an untrusted attached conversation URL'),
        io: { stdout: text => stdout.push(text), writeFile: () => assert.fail('no file expected') },
      }),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /\[chatgpt\]/);
        assert.match(error.message, /--attach-conversation/);
        assert.match(error.message, /evil\.example/);
        assert.match(error.message, /chatgpt\.com/);
        return true;
      },
    );

    assert.deepEqual(stdout, []);
    const recordPath = conversationRecordPath({ providerName: 'chatgpt', id: 'local-session', storeDir: dir });
    assert.equal(existsSync(recordPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildMetadata includes safe attachment metadata', () => {
  const attachment = {
    filename: 'report.txt',
    mime_type: 'text/plain',
    size_bytes: 10,
    is_image: false,
    source: 'local-file',
    status: 'uploaded',
    url_present: true,
  };
  const metadata = buildMetadata({
    request: buildAiChatRequest({ providerName: 'perplexity', prompt: 'analyze', jsonOutput: true }),
    provider: { name: 'perplexity' },
    result: {
      text: 'answer',
      rawText: 'answer',
      done: true,
      modelUsed: 'perplexity/best',
      providerState: { attachments: [attachment] },
      attachments: [attachment],
      searchResults: [],
    },
    fallbackFrom: null,
    fallbackTrail: ['perplexity/best'],
  });

  assert.deepEqual(metadata.attachments, [attachment]);
  assert.deepEqual(metadata.provider_state.attachments, [attachment]);
  assert.equal(JSON.stringify(metadata).includes('/tmp/'), false);
  assert.equal(JSON.stringify(metadata).includes('https://uploads.example.test'), false);
});

test('runAiChat cache hits update JSON cache metadata and save conversation references', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-chat-cache-conversation-'));
  try {
    const request = buildAiChatRequest({
      providerName: 'direct',
      modelName: 'api-model',
      prompt: 'hello',
      jsonOutput: true,
      saveConversation: 'research',
      conversationStoreDir: dir,
    });
    const cachedMetadata = {
      provider: 'direct',
      model: 'api-model',
      requested_model: 'api-model',
      model_task: null,
      fallback_from: null,
      fallback_attempts: ['api-model'],
      prompt_chars: 5,
      response_chars: 13,
      complete: true,
      rate_limited: false,
      final_url: 'https://example.test/thread',
      conversation_id: null,
      conversation_url: 'https://example.test/thread',
      provider_state: { thread: 't1' },
      search_results: [],
      captured_at: '2026-01-01T00:00:00.000Z',
      continue_chat: false,
      prompt: 'hello',
      cache_hit: false,
    };
    const stdout = [];
    let cacheInput = null;

    const result = await runAiChat(request, {
      provider: { name: 'direct', run: () => assert.fail('cached response should not call provider') },
      cache: {
        read(tool, input) {
          assert.equal(tool, 'ai-chat');
          cacheInput = input;
          return {
            key: 'cache-key',
            entry: {
              created_at: '2026-01-01T00:00:01.000Z',
              metadata: cachedMetadata,
            },
            output: JSON.stringify({ ...cachedMetadata, response: 'cached answer' }, null, 2),
            rawText: 'cached answer',
          };
        },
        write: () => assert.fail('cache hits should not write a new cache entry'),
      },
      io: { stdout: text => stdout.push(text), writeFile: () => assert.fail('no file expected') },
    });

    assert.equal(cacheInput.save_conversation, 'research');
    const emitted = JSON.parse(stdout[0]);
    assert.equal(emitted.cache_hit, true);
    assert.equal(emitted.cache_key, 'cache-key');
    assert.equal(emitted.response, 'cached answer');
    assert.equal(emitted.conversation_id, 'research');
    assert.match(emitted.conversation_record_path, /research\.json$/);

    const recordPath = conversationRecordPath({ providerName: 'direct', id: 'research', storeDir: dir });
    assert.equal(existsSync(recordPath), true);
    const record = JSON.parse(readFileSync(recordPath, 'utf-8'));
    assert.equal(record.provider_state.thread, 't1');
    assert.deepEqual(record.messages.map(message => message.content), ['hello', 'cached answer']);
    assert.equal(result.source, 'cache');
    assert.equal(result.metadata.cache_hit, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveInitialModel uses provider task defaults', () => {
  assert.equal(resolveInitialModel({ defaultModel: 'best' }, buildAiChatRequest({ prompt: 'x' })), 'best');
  assert.equal(resolveInitialModel({ taskModels: { reasoning: 'think' }, defaultModel: 'best' }, buildAiChatRequest({ prompt: 'x', modelTask: 'reasoning' })), 'think');
  assert.equal(resolveInitialModel({ taskModels: { reasoning: 'think' }, defaultModel: 'best' }, buildAiChatRequest({ prompt: 'x', modelName: 'manual', modelTask: 'reasoning' })), 'manual');
});

test('runAiChat uses provider direct transport when available', async () => {
  const request = buildAiChatRequest({ providerName: 'direct', modelName: 'api-model', prompt: 'hello', jsonOutput: true });
  const stdout = [];
  const result = await runAiChat(request, {
    browser: { marker: 'browser' },
    provider: {
      name: 'direct',
      transport: 'webui-api',
      async run({ browser, request: runRequest, selectedModel }) {
        assert.equal(browser.marker, 'browser');
        assert.equal(runRequest.prompt, 'hello');
        assert.equal(selectedModel, 'api-model');
        return {
          text: 'api answer',
          rawText: 'api answer',
          done: true,
          modelUsed: 'api-model',
          providerState: { thread: 't1' },
        };
      },
    },
    cache: { read: () => null, write: () => null },
    io: { stdout: text => stdout.push(text), writeFile: () => assert.fail('no file expected') },
  });

  assert.equal(result.result.text, 'api answer');
  assert.equal(JSON.parse(stdout[0]).provider_state.thread, 't1');
});

test('runAiChat starts a headless Google-enabled browser from the explicitly selected profile', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-chat-browser-start-'));
  try {
    const stateFile = join(dir, 'browser.json');
    const stdout = [];
    const connectCalls = [];
    let startArgs = null;
    let disconnects = 0;
    const browser = { disconnect: () => { disconnects += 1; } };
    const request = buildAiChatRequest({
      providerName: 'browser-provider',
      modelName: 'default',
      prompt: 'hello',
      jsonOutput: true,
      browserStateFile: stateFile,
      browserProfileName: 'Browser Profile',
      browserHeadless: true,
      includeGoogle: true,
    });

    await runAiChat(request, {
      provider: {
        name: 'browser-provider',
        preferredBrowserHeadless: true,
        runRequiresBrowser: () => true,
        async run({ browser: runBrowser, request: runRequest }) {
          assert.equal(runBrowser, browser);
          assert.equal(runRequest.port, 4555);
          return { text: 'owned answer', rawText: 'owned answer', done: true, modelUsed: 'default' };
        },
      },
      async startChrome(args) {
        startArgs = args;
        return { status: 'started', port: 4555, ownerToken: 'owned-token', profileName: 'Browser Profile', requestedProfileName: 'Browser Profile', headless: true, includeGoogle: true };
      },
      async connectBrowser(port, options) {
        connectCalls.push({ port, options });
        return browser;
      },
      cache: noCache(),
      io: { stdout: text => stdout.push(text), writeFile: () => assert.fail('no file expected') },
    });

    assert.deepEqual(startArgs, { port: 9222, taskName: 'ai-chat', profileName: 'Browser Profile', ownerId: 'ai-chat', autoAllocatePort: true, headless: true, includeGoogle: true });
    assert.deepEqual(connectCalls, [{ port: 4555, options: { ownerToken: 'owned-token', protocolTimeout: 330000 } }]);
    const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
    assert.equal(state.ownerId, 'ai-chat');
    assert.equal(state.ownerToken, 'owned-token');
    assert.equal(state.port, 4555);
    assert.equal(state.profileName, 'Browser Profile');
    assert.equal(state.requestedProfileName, 'Browser Profile');
    assert.equal(state.headless, true);
    assert.equal(state.includeGoogle, true);
    assert.equal(statSync(stateFile).mode & 0o777, 0o600);
    assert.equal(disconnects, 1);
    assert.equal(JSON.parse(stdout[0]).response, 'owned answer');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runAiChat reuses the AI Chat owned browser across providers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-chat-browser-reuse-'));
  try {
    const stateFile = join(dir, 'browser.json');
    const connectCalls = [];
    const runCalls = [];
    let startCount = 0;
    const browser = { disconnect() {} };
    const commonDeps = {
      async startChrome() {
        startCount += 1;
        return { status: 'started', port: 4666, ownerToken: 'reuse-token', profileName: 'Default', requestedProfileName: 'Default' };
      },
      managedBrowserSafetyForPort(port) {
        assert.equal(port, 4666);
        return { ok: true };
      },
      readManagedStateForPort(port) {
        assert.equal(port, 4666);
        return { managedBy: 'browser-tools', ownerId: 'ai-chat', profileName: 'Default' };
      },
      managedBrowserOwnershipSafety({ ownerToken }) {
        assert.equal(ownerToken, 'reuse-token');
        return { ok: true, ownerId: 'ai-chat' };
      },
      browserWSEndpoint: async port => `ws://localhost:${port}`,
      async connectBrowser(port, options) {
        connectCalls.push({ port, ownerToken: options.ownerToken });
        return browser;
      },
      cache: noCache(),
      io: { stdout: () => {}, writeFile: () => assert.fail('no file expected') },
    };

    for (const providerName of ['grok', 'gemini']) {
      const request = buildAiChatRequest({ providerName, prompt: `hello ${providerName}`, jsonOutput: true, browserStateFile: stateFile });
      await runAiChat(request, {
        ...commonDeps,
        provider: {
          name: providerName,
          runRequiresBrowser: () => true,
          async run({ request: runRequest }) {
            runCalls.push({ providerName, port: runRequest.port });
            return { text: `${providerName} answer`, rawText: `${providerName} answer`, done: true, modelUsed: 'default' };
          },
        },
      });
    }

    assert.equal(startCount, 1);
    assert.deepEqual(connectCalls, [
      { port: 4666, ownerToken: 'reuse-token' },
      { port: 4666, ownerToken: 'reuse-token' },
    ]);
    assert.deepEqual(runCalls, [
      { providerName: 'grok', port: 4666 },
      { providerName: 'gemini', port: 4666 },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runAiChat discards stale private browser state and starts a new owned browser', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-chat-browser-stale-'));
  try {
    const stateFile = join(dir, 'browser.json');
    writeJson(stateFile, { version: 1, ownerId: 'ai-chat', ownerToken: 'stale-token', port: 4777 });
    let startCount = 0;
    const browser = { disconnect() {} };
    const request = buildAiChatRequest({ providerName: 'browser-provider', prompt: 'hello', jsonOutput: true, browserStateFile: stateFile });

    await runAiChat(request, {
      provider: {
        name: 'browser-provider',
        runRequiresBrowser: () => true,
        async run({ request: runRequest }) {
          assert.equal(runRequest.port, 4888);
          return { text: 'new answer', rawText: 'new answer', done: true, modelUsed: 'default' };
        },
      },
      managedBrowserSafetyForPort: port => ({ ok: false, reason: port === 4777 ? 'process-not-found' : 'unexpected-port' }),
      browserWSEndpoint: async () => null,
      async startChrome() {
        startCount += 1;
        return { status: 'started', port: 4888, ownerToken: 'new-token' };
      },
      connectBrowser: async () => browser,
      cache: noCache(),
      io: { stdout: () => {}, writeFile: () => assert.fail('no file expected') },
    });

    const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
    assert.equal(startCount, 1);
    assert.equal(state.ownerToken, 'new-token');
    assert.equal(state.port, 4888);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runAiChat refuses saved browser state with a missing owner token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-chat-browser-missing-token-'));
  try {
    const stateFile = join(dir, 'browser.json');
    writeJson(stateFile, { version: 1, ownerId: 'ai-chat', port: 4991 });
    const request = buildAiChatRequest({ providerName: 'browser-provider', prompt: 'hello', browserStateFile: stateFile });

    await assert.rejects(() => runAiChat(request, {
      provider: { name: 'browser-provider', runRequiresBrowser: () => true, run: () => assert.fail('provider should not run') },
      startChrome: () => assert.fail('missing owner token should not start a new browser'),
      connectBrowser: () => assert.fail('missing owner token should not connect'),
      cache: noCache(),
    }), /missing-owner-token.*Recovery/s);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runAiChat refuses saved browser state when the owner token belongs to another agent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-chat-browser-wrong-token-'));
  try {
    const stateFile = join(dir, 'browser.json');
    writeJson(stateFile, { version: 1, ownerId: 'ai-chat', ownerToken: 'wrong-token', port: 4992 });
    const request = buildAiChatRequest({ providerName: 'browser-provider', prompt: 'hello', browserStateFile: stateFile });

    await assert.rejects(() => runAiChat(request, {
      provider: { name: 'browser-provider', runRequiresBrowser: () => true, run: () => assert.fail('provider should not run') },
      managedBrowserSafetyForPort: () => ({ ok: true }),
      readManagedStateForPort: () => ({ managedBy: 'browser-tools', ownerId: 'other-agent' }),
      managedBrowserOwnershipSafety: () => ({ ok: false, reason: 'owner-token-mismatch', ownerId: 'other-agent' }),
      startChrome: () => assert.fail('wrong owner token should not start a new browser'),
      connectBrowser: () => assert.fail('wrong owner token should not connect'),
      cache: noCache(),
    }), /owner-token-mismatch.*Recovery.*other-agent/s);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runAiChat refuses to attach to unmanaged Chrome on a saved debug port', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-chat-browser-unmanaged-'));
  try {
    const stateFile = join(dir, 'browser.json');
    writeJson(stateFile, { version: 1, ownerId: 'ai-chat', ownerToken: 'owned-token', port: 4993 });
    const request = buildAiChatRequest({ providerName: 'browser-provider', prompt: 'hello', browserStateFile: stateFile });

    await assert.rejects(() => runAiChat(request, {
      provider: { name: 'browser-provider', runRequiresBrowser: () => true, run: () => assert.fail('provider should not run') },
      managedBrowserSafetyForPort: () => ({ ok: false, reason: 'missing-managed-state' }),
      browserWSEndpoint: async () => 'ws://localhost:4993',
      startChrome: () => assert.fail('unmanaged Chrome should not be replaced silently'),
      connectBrowser: () => assert.fail('unmanaged Chrome should not connect'),
      cache: noCache(),
    }), /missing-managed-state.*choose a different --port/s);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runAiChat refuses saved owned state when the debug port is unavailable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-chat-browser-debug-port-'));
  try {
    const stateFile = join(dir, 'browser.json');
    writeJson(stateFile, { version: 1, ownerId: 'ai-chat', ownerToken: 'owned-token', port: 4994 });
    const request = buildAiChatRequest({ providerName: 'browser-provider', prompt: 'hello', browserStateFile: stateFile });

    await assert.rejects(() => runAiChat(request, {
      provider: { name: 'browser-provider', runRequiresBrowser: () => true, run: () => assert.fail('provider should not run') },
      managedBrowserSafetyForPort: () => ({ ok: true }),
      readManagedStateForPort: () => ({ managedBy: 'browser-tools', ownerId: 'ai-chat', profileName: 'Default' }),
      managedBrowserOwnershipSafety: () => ({ ok: true, ownerId: 'ai-chat' }),
      browserWSEndpoint: async () => null,
      startChrome: () => assert.fail('unavailable debug port should not start over a live owned process'),
      connectBrowser: () => assert.fail('unavailable debug port should not connect'),
      cache: noCache(),
    }), /debug-port-unavailable.*Recovery/s);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runAiChat refuses old AI Chat browsers that were started with a fresh profile', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-chat-browser-profile-mismatch-'));
  try {
    const stateFile = join(dir, 'browser.json');
    writeJson(stateFile, { version: 1, ownerId: 'ai-chat', ownerToken: 'owned-token', port: 4995, profileName: null });
    const request = buildAiChatRequest({ providerName: 'browser-provider', prompt: 'hello', browserStateFile: stateFile });

    await assert.rejects(() => runAiChat(request, {
      provider: { name: 'browser-provider', runRequiresBrowser: () => true, run: () => assert.fail('provider should not run') },
      managedBrowserSafetyForPort: () => ({ ok: true }),
      readManagedStateForPort: () => ({ managedBy: 'browser-tools', ownerId: 'ai-chat', profileName: null }),
      managedBrowserOwnershipSafety: () => ({ ok: true, ownerId: 'ai-chat' }),
      browserWSEndpoint: async () => 'ws://localhost:4995',
      startChrome: () => assert.fail('fresh-profile browser should not be reused or replaced silently'),
      connectBrowser: () => assert.fail('fresh-profile browser should not connect'),
      cache: noCache(),
    }), /profile-mismatch expected configured-or-default-profile, got fresh-profile.*Recovery/s);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runAiChat refuses a visible saved browser when headless execution is requested', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-chat-browser-headless-mismatch-'));
  try {
    const stateFile = join(dir, 'browser.json');
    writeJson(stateFile, { version: 1, ownerId: 'ai-chat', ownerToken: 'owned-token', port: 4996, profileName: 'Browser Profile' });
    const request = buildAiChatRequest({
      providerName: 'browser-provider',
      prompt: 'hello',
      browserStateFile: stateFile,
      browserProfileName: 'Browser Profile',
      browserHeadless: true,
    });

    await assert.rejects(() => runAiChat(request, {
      provider: { name: 'browser-provider', runRequiresBrowser: () => true, run: () => assert.fail('provider should not run') },
      managedBrowserSafetyForPort: () => ({ ok: true }),
      readManagedStateForPort: () => ({ managedBy: 'browser-tools', ownerId: 'ai-chat', profileName: 'Browser Profile', headless: false }),
      managedBrowserOwnershipSafety: () => ({ ok: true, ownerId: 'ai-chat' }),
      browserWSEndpoint: async () => 'ws://localhost:4996',
      startChrome: () => assert.fail('visible browser should not be replaced silently'),
      connectBrowser: () => assert.fail('visible browser should not connect'),
      cache: noCache(),
    }), /headless-mismatch expected headless browser.*Recovery/s);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runAiChat emits direct provider output with evidence warning when screenshot cannot be captured', async () => {
  const request = buildAiChatRequest({ providerName: 'direct', modelName: 'api-model', prompt: 'hello', jsonOutput: true, captureEvidence: true });
  const stdout = [];
  const result = await runAiChat(request, {
    provider: {
      name: 'direct',
      transport: 'webui-api',
      runRequiresBrowser: () => false,
      async run({ browser }) {
        assert.equal(browser, null);
        return { text: 'answer', rawText: 'answer', done: true, modelUsed: 'api-model', finalUrl: null };
      },
    },
    connectBrowser: async () => assert.fail('connectBrowser should not be called'),
    cache: { read: () => assert.fail('evidence requests should not use cache'), write: () => assert.fail('evidence requests should not write cache') },
    io: { stdout: text => stdout.push(text), writeFile: () => assert.fail('no file expected') },
  });

  const emitted = JSON.parse(stdout[0]);
  assert.equal(emitted.response, 'answer');
  assert.equal(emitted.evidence_path, null);
  assert.equal(emitted.evidence_skipped_reason, 'browser-unavailable');
  assert.match(emitted.evidence_warning, /Skipped screenshot evidence/);
  assert.equal(result.metadata.evidence_skipped_reason, 'browser-unavailable');
});

test('runAiChat can skip Browser Tools connection for direct providers', async () => {
  const request = buildAiChatRequest({ providerName: 'direct', modelName: 'api-model', prompt: 'hello', jsonOutput: true });
  const stdout = [];
  const result = await runAiChat(request, {
    provider: {
      name: 'direct',
      transport: 'webui-api',
      runRequiresBrowser: () => false,
      async run({ browser }) {
        assert.equal(browser, null);
        return { text: 'no browser answer', rawText: 'no browser answer', done: true, modelUsed: 'api-model' };
      },
    },
    connectBrowser: async () => assert.fail('connectBrowser should not be called'),
    cache: { read: () => null, write: () => null },
    io: { stdout: text => stdout.push(text), writeFile: () => assert.fail('no file expected') },
  });

  assert.equal(result.result.text, 'no browser answer');
  assert.equal(JSON.parse(stdout[0]).response, 'no browser answer');
});

test('explicit Incognito requests bypass the local AI Chat response cache', async () => {
  const stdout = [];
  const request = buildAiChatRequest({
    providerName: 'perplexity',
    modelName: 'perplexity/best',
    prompt: 'private question',
    jsonOutput: true,
    providerOptions: { incognito: true },
  });

  const result = await runAiChat(request, {
    provider: {
      name: 'perplexity',
      runRequiresBrowser: () => false,
      async run() {
        return {
          text: 'private answer',
          rawText: 'private answer',
          done: true,
          modelUsed: 'perplexity/best',
          providerState: { is_incognito: true, incognito_explicit: true },
        };
      },
    },
    cache: {
      read: () => assert.fail('explicit Incognito must not read the response cache'),
      write: () => assert.fail('explicit Incognito must not write the response cache'),
    },
    io: { stdout: text => stdout.push(text), writeFile: () => assert.fail('no file expected') },
  });

  assert.equal(result.source, 'live');
  assert.equal(result.metadata.cache_hit, false);
  assert.equal(JSON.parse(stdout[0]).provider_state.incognito_explicit, true);
});

test('ai-chat query cache rejects invalid TTL values', async () => {
  await withEnv({
    BROWSER_QUERY_CACHE_DIR: '/tmp/ai-chat-cache-test',
    BROWSER_QUERY_TTL_SECONDS: 'not-a-number',
  }, () => {
    assert.throws(() => getAiChatCacheConfig(), /Invalid BROWSER_QUERY_TTL_SECONDS/);
  });
});

test('runAiChat keeps partial Perplexity SSE responses incomplete and uncached', async () => {
  const partialEvent = `data: ${JSON.stringify({
    backend_uuid: 'uuid-partial',
    text: JSON.stringify({ answer: 'partial answer', chunks: ['partial answer'] }),
  })}\n`;
  const stdout = [];
  const cacheWrites = [];
  const exposed = {};
  const page = {
    url: () => 'https://www.perplexity.ai/api/auth/session',
    async exposeFunction(name, callback) { exposed[name] = callback; },
    async removeExposedFunction(name) { delete exposed[name]; },
    async evaluate(_fn, args) {
      const callback = exposed[args.callbackName];
      if (args.url.endsWith('/api/auth/session')) {
        await callback({ type: 'response', status: 200, headers: [['content-type', 'application/json']] });
        await callback({ type: 'chunk', chunk: '{"user":{"id":"present"}}' });
        await callback({ type: 'done' });
        return;
      }
      assert.equal(args.url, 'https://www.perplexity.ai/rest/sse/perplexity_ask');
      await callback({ type: 'response', status: 200, headers: [['content-type', 'text/event-stream']] });
      await callback({ type: 'chunk', chunk: partialEvent });
      await callback({ type: 'done' });
    },
  };
  const request = buildAiChatRequest({
    providerName: 'perplexity',
    modelName: 'perplexity/best',
    prompt: 'hello',
    jsonOutput: true,
  });

  const result = await runAiChat(request, {
    browser: { pages: async () => [page] },
    provider: perplexityProvider,
    cache: {
      read: () => null,
      write(...args) {
        cacheWrites.push(args);
        return { key: 'cache-key' };
      },
    },
    io: { stdout: text => stdout.push(text), writeFile: () => assert.fail('no file expected') },
  });

  const emitted = JSON.parse(stdout[0]);
  assert.equal(emitted.response, 'partial answer');
  assert.equal(emitted.complete, false);
  assert.equal(result.metadata.complete, false);
  assert.equal(result.result.done, false);
  assert.equal(emitted.provider_state.stream_state.status, 'partial');
  assert.equal(emitted.provider_state.stream_state.partial, true);
  assert.equal(emitted.provider_state.stream_state.timeout, true);
  assert.equal(cacheWrites.length, 0);
});

test('runAiChat redacts Perplexity continuation tokens from public artifacts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-chat-perplexity-token-'));
  const rawToken = 'rw-private-token';
  const outFile = join(dir, 'answer.json');
  let cachedWrite = null;

  try {
    const request = buildAiChatRequest({
      providerName: 'perplexity',
      modelName: 'perplexity/best',
      prompt: 'hello',
      jsonOutput: true,
      outFile,
      saveConversation: 'research',
      conversationStoreDir: dir,
    });

    const result = await runAiChat(request, {
      provider: {
        name: 'perplexity',
        transport: 'webui-api',
        runRequiresBrowser: () => false,
        async run() {
          return {
            text: 'answer',
            rawText: 'answer raw',
            done: true,
            modelUsed: 'perplexity/best',
            finalUrl: null,
            providerState: {
              backend_uuid: 'uuid-secret',
              read_write_token: rawToken,
              is_incognito: true,
              saved_to_library: false,
            },
            searchResults: [{ title: 'Source', url: 'https://example.test/source', snippet: 'Snippet' }],
          };
        },
      },
      connectBrowser: async () => assert.fail('connectBrowser should not be called'),
      cache: {
        read: () => null,
        write(tool, input, payload) {
          cachedWrite = {
            tool,
            input,
            output: payload.output,
            metadata: JSON.parse(JSON.stringify(payload.metadata)),
          };
          return { key: 'cache-key' };
        },
      },
    });

    const outputText = readFileSync(outFile, 'utf-8');
    const sidecarText = readFileSync(`${outFile}.meta.json`, 'utf-8');
    assert.equal(fileMode(outFile), 0o600);
    assert.equal(fileMode(`${outFile}.meta.json`), 0o600);
    assert.equal(fileMode(`${outFile}.raw.txt`), 0o600);
    const publicTexts = [
      outputText,
      sidecarText,
      cachedWrite.output,
      result.output,
      JSON.stringify(cachedWrite.metadata),
      JSON.stringify(result.metadata),
      JSON.stringify(result.result),
    ];
    for (const text of publicTexts) assert.equal(text.includes(rawToken), false);

    const emitted = JSON.parse(outputText);
    const sidecar = JSON.parse(sidecarText);
    assert.equal(emitted.provider, 'perplexity');
    assert.equal(emitted.requested_model, 'perplexity/best');
    assert.equal(emitted.model, 'perplexity/best');
    assert.equal(emitted.selected_model, 'perplexity/best');
    assert.equal(emitted.complete, true);
    assert.equal(emitted.conversation_id, 'research');
    assert.match(emitted.captured_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(emitted.provider_state.has_read_write_token, true);
    assert.equal(emitted.provider_state.read_write_token, undefined);
    assert.deepEqual(emitted.sources, [{ title: 'Source', url: 'https://example.test/source', snippet: 'Snippet' }]);
    assert.deepEqual(emitted.search_results, emitted.sources);
    assert.deepEqual(sidecar.provider_state, emitted.provider_state);
    assert.deepEqual(cachedWrite.metadata.provider_state, emitted.provider_state);
    assert.equal(cachedWrite.metadata.provider_state.read_write_token, undefined);

    const recordPath = conversationRecordPath({ providerName: 'perplexity', id: 'research', storeDir: dir });
    assert.equal(fileMode(recordPath), 0o600);
    const recordText = readFileSync(recordPath, 'utf-8');
    assert.equal(recordText.includes(rawToken), true);
    const record = JSON.parse(recordText);
    assert.equal(record.provider_state.read_write_token, rawToken);

    const conversation = resolveConversationReference(buildAiChatRequest({
      providerName: 'perplexity',
      prompt: 'follow-up',
      conversationTarget: 'research',
      conversationStoreDir: dir,
    }));
    const payload = buildPerplexityPayload({
      query: 'follow-up',
      model: resolvePerplexityModel('perplexity/best'),
      conversation,
    });
    assert.equal(payload.params.last_backend_uuid, 'uuid-secret');
    assert.equal(payload.params.read_write_token, rawToken);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('saved conversations are provider scoped and missing local sessions are actionable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-chat-provider-scope-'));
  try {
    const sharedId = 'shared-research';
    const alphaPath = conversationRecordPath({ providerName: 'alpha', id: sharedId, storeDir: dir });
    const betaPath = conversationRecordPath({ providerName: 'beta', id: sharedId, storeDir: dir });
    writeJson(alphaPath, { id: sharedId, provider: 'alpha', provider_state: { thread: 'alpha-thread' } });
    writeJson(betaPath, { id: sharedId, provider: 'beta', provider_state: { thread: 'beta-thread' } });

    const alpha = resolveConversationReference(buildAiChatRequest({
      providerName: 'alpha',
      prompt: 'follow-up',
      conversationTarget: sharedId,
      conversationStoreDir: dir,
    }));
    const beta = resolveConversationReference(buildAiChatRequest({
      providerName: 'beta',
      prompt: 'follow-up',
      conversationTarget: sharedId,
      conversationStoreDir: dir,
    }));

    assert.equal(alpha.record.provider_state.thread, 'alpha-thread');
    assert.equal(beta.record.provider_state.thread, 'beta-thread');
    assert.throws(() => resolveConversationReference(buildAiChatRequest({
      providerName: 'gamma',
      prompt: 'follow-up',
      conversationTarget: sharedId,
      conversationStoreDir: dir,
    })), /Conversation not found: shared-research/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runAiChat saves and continues a provider session with backend state only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-chat-session-roundtrip-'));
  const stdout = [];
  const calls = [];

  try {
    const provider = {
      name: 'direct-session',
      transport: 'direct',
      runRequiresBrowser: () => false,
      async run({ request: runRequest, conversation }) {
        calls.push({ prompt: runRequest.prompt, conversationState: conversation?.record?.provider_state || null });
        if (!conversation) {
          return { text: 'first answer', rawText: 'first answer', done: true, modelUsed: 'default', providerState: { thread: 'thread-1' } };
        }
        assert.equal(runRequest.prompt, 'follow-up only');
        assert.equal(runRequest.prompt.includes('first answer'), false);
        assert.deepEqual(conversation.record.provider_state, { thread: 'thread-1' });
        return { text: 'second answer', rawText: 'second answer', done: true, modelUsed: 'default', providerState: { thread: 'thread-2' } };
      },
    };

    await runAiChat(buildAiChatRequest({
      providerName: 'direct-session',
      prompt: 'start',
      saveConversation: 'research',
      conversationStoreDir: dir,
      jsonOutput: true,
    }), {
      provider,
      cache: noCache(),
      io: { stdout: text => stdout.push(text), writeFile: () => assert.fail('no file expected') },
    });

    await runAiChat(buildAiChatRequest({
      providerName: 'direct-session',
      prompt: 'follow-up only',
      conversationTarget: 'research',
      saveConversation: 'research',
      conversationStoreDir: dir,
      jsonOutput: true,
    }), {
      provider,
      cache: noCache(),
      io: { stdout: text => stdout.push(text), writeFile: () => assert.fail('no file expected') },
    });

    assert.deepEqual(calls, [
      { prompt: 'start', conversationState: null },
      { prompt: 'follow-up only', conversationState: { thread: 'thread-1' } },
    ]);
    const record = JSON.parse(readFileSync(conversationRecordPath({ providerName: 'direct-session', id: 'research', storeDir: dir }), 'utf-8'));
    assert.deepEqual(record.provider_state, { thread: 'thread-2' });
    assert.deepEqual(record.messages.map(message => message.content), ['start', 'first answer', 'follow-up only', 'second answer']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runAiChat preserves the saved conversation model when follow-up omits --model', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-chat-session-model-roundtrip-'));
  const selectedModels = [];

  try {
    const provider = {
      name: 'model-session',
      defaultModel: 'auto',
      transport: 'direct',
      runRequiresBrowser: () => false,
      async run({ selectedModel, conversation }) {
        selectedModels.push(selectedModel);
        return {
          text: conversation ? 'second answer' : 'first answer',
          rawText: conversation ? 'second answer' : 'first answer',
          done: true,
          modelUsed: selectedModel,
          providerState: { selected_model: selectedModel, thread: 'thread-1' },
        };
      },
    };

    await runAiChat(buildAiChatRequest({
      providerName: 'model-session',
      modelName: 'fast',
      prompt: 'start',
      saveConversation: 'research',
      conversationStoreDir: dir,
      jsonOutput: true,
    }), {
      provider,
      cache: noCache(),
      io: { stdout: () => {}, writeFile: () => assert.fail('no file expected') },
    });

    await runAiChat(buildAiChatRequest({
      providerName: 'model-session',
      prompt: 'follow-up only',
      conversationTarget: 'research',
      saveConversation: 'research',
      conversationStoreDir: dir,
      jsonOutput: true,
    }), {
      provider,
      cache: noCache(),
      io: { stdout: () => {}, writeFile: () => assert.fail('no file expected') },
    });

    assert.deepEqual(selectedModels, ['fast', 'fast']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runAiChat attaches a provider URL to a local session and continues from it safely', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-chat-url-attach-'));
  const secretToken = 'private-url-token';
  const providerUrl = `https://provider.example.test/thread/abc123?read_write_token=${secretToken}&view=1`;
  const stdout = [];
  let runCount = 0;

  try {
    const provider = {
      name: 'attachable',
      trustedConversationHostnames: ['provider.example.test'],
      transport: 'direct',
      runRequiresBrowser: () => false,
      resolveConversationAttachment({ target }) {
        return {
          url: target,
          providerId: 'abc123',
          providerState: { backend_uuid: 'abc123', read_write_token: secretToken },
        };
      },
      async run({ conversation }) {
        runCount += 1;
        assert.equal(conversation.url, providerUrl);
        assert.deepEqual(conversation.record.provider_state, { backend_uuid: 'abc123', read_write_token: secretToken });
        return {
          text: 'continued answer',
          rawText: 'continued answer',
          done: true,
          modelUsed: 'default',
          finalUrl: providerUrl,
          providerState: { backend_uuid: 'abc124', read_write_token: secretToken },
        };
      },
    };

    const attached = await runAiChat(buildAiChatRequest({
      providerName: 'attachable',
      attachConversation: providerUrl,
      saveConversation: 'local-session',
      conversationStoreDir: dir,
      jsonOutput: true,
    }), {
      provider,
      cache: noCache(),
      io: { stdout: text => stdout.push(text), writeFile: () => assert.fail('no file expected') },
    });

    assert.equal(attached.source, 'conversation-attachment');
    assert.equal(runCount, 0);
    assert.equal(stdout[0].includes(secretToken), false);
    const attachOutput = JSON.parse(stdout[0]);
    assert.equal(attachOutput.conversation_id, 'local-session');
    assert.equal(attachOutput.provider_state.has_read_write_token, true);
    assert.equal(attachOutput.provider_state.read_write_token, undefined);

    const attachedRecordPath = conversationRecordPath({ providerName: 'attachable', id: 'local-session', storeDir: dir });
    const attachedRecordText = readFileSync(attachedRecordPath, 'utf-8');
    assert.equal(attachedRecordText.includes(secretToken), true);

    await runAiChat(buildAiChatRequest({
      providerName: 'attachable',
      prompt: 'continue attached',
      conversationTarget: 'local-session',
      saveConversation: 'local-session',
      conversationStoreDir: dir,
      jsonOutput: true,
    }), {
      provider,
      cache: noCache(),
      io: { stdout: text => stdout.push(text), writeFile: () => assert.fail('no file expected') },
    });

    assert.equal(runCount, 1);
    assert.equal(stdout[1].includes(secretToken), false);
    const record = JSON.parse(readFileSync(attachedRecordPath, 'utf-8'));
    assert.deepEqual(record.provider_state, { backend_uuid: 'abc124', read_write_token: secretToken });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runAiChat rechecks a saved provider request without a new prompt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-chat-recheck-conversation-'));
  const stdout = [];

  try {
    writeJson(conversationRecordPath({ providerName: 'chatgpt', id: 'timed-out', storeDir: dir }), {
      version: 1,
      kind: 'ai-chat-conversation',
      id: 'timed-out',
      provider: 'chatgpt',
      provider_state: {
        conversation_id: 'conv-timeout',
        partial: true,
        timeout: true,
        stream_state: { status: 'timeout_partial', resumable: true },
      },
      messages: [],
    });

    const request = buildAiChatRequest({
      providerName: 'chatgpt',
      conversationTarget: 'timed-out',
      saveConversation: 'timed-out',
      conversationStoreDir: dir,
      jsonOutput: true,
    });
    assert.equal(request.prompt, '');

    const result = await runAiChat(request, {
      provider: {
        name: 'chatgpt',
        defaultModel: 'extra-high',
        runRequiresBrowser: () => false,
        async recheckConversation({ browser, conversation }) {
          assert.equal(browser, null);
          assert.equal(conversation.record.provider_state.conversation_id, 'conv-timeout');
          return {
            text: 'completed after recheck',
            rawText: 'completed after recheck',
            done: true,
            modelUsed: 'extra-high',
            finalUrl: 'https://chatgpt.com/c/conv-timeout',
            providerState: {
              conversation_id: 'conv-timeout',
              recheck: true,
              stream_state: { status: 'completed', recheck: true },
            },
          };
        },
      },
      cache: noCache(),
      io: { stdout: text => stdout.push(text), writeFile: () => assert.fail('no file expected') },
    });

    const emitted = JSON.parse(stdout[0]);
    assert.equal(result.source, 'recheck');
    assert.equal(emitted.recheck, true);
    assert.equal(emitted.response, 'completed after recheck');
    assert.equal(emitted.provider_state.stream_state.status, 'completed');

    const record = JSON.parse(readFileSync(conversationRecordPath({ providerName: 'chatgpt', id: 'timed-out', storeDir: dir }), 'utf-8'));
    assert.deepEqual(record.messages.map(message => message.role), ['assistant']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('conversation record writes enforce private file permissions and fail closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-chat-conversation-permissions-'));
  const provider = { name: 'perplexity' };
  const rawToken = 'provider-token-must-not-leak';
  const request = buildAiChatRequest({
    providerName: 'perplexity',
    modelName: 'perplexity/best',
    prompt: 'hello',
    saveConversation: 'research',
    conversationStoreDir: dir,
  });
  const result = {
    text: 'answer',
    rawText: 'answer',
    done: true,
    modelUsed: 'perplexity/best',
    providerState: { backend_uuid: 'uuid', read_write_token: rawToken },
  };
  const metadata = buildMetadata({
    request,
    provider,
    result,
    fallbackFrom: null,
    fallbackTrail: ['perplexity/best'],
  });

  try {
    const path = conversationRecordPath({ providerName: provider.name, id: 'research', storeDir: dir });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{}\n', 'utf-8');
    chmodSync(path, 0o666);

    const saved = saveConversationReference(request, provider, result, metadata);

    assert.equal(fileMode(saved.path), 0o600);
    assert.equal(readFileSync(saved.path, 'utf-8').includes(rawToken), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const failingFs = {
    mkdir: () => {},
    writeFile: () => {},
    chmod: () => {},
    stat: () => ({ mode: 0o644 }),
  };

  assert.throws(
    () => saveConversationReference(request, provider, result, metadata, failingFs),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Failed to verify private permissions/);
      assert.match(error.message, /AI Chat conversation record/);
      assert.equal(error.message.includes(rawToken), false);
      return true;
    },
  );
});

test('conversation references preserve provider state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-chat-skill-conversation-'));
  try {
    const request = buildAiChatRequest({
      providerName: 'perplexity',
      modelName: 'perplexity/best',
      prompt: 'hello',
      saveConversation: 'research',
      conversationStoreDir: dir,
    });
    const result = {
      modelUsed: 'perplexity/best',
      finalUrl: null,
      providerState: { backend_uuid: 'uuid', read_write_token: 'rw' },
    };
    const metadata = buildMetadata({
      request,
      provider: { name: 'perplexity' },
      result: { ...result, text: 'answer', done: true, rateLimited: false },
      fallbackFrom: null,
      fallbackTrail: ['perplexity/best'],
    });

    const saved = saveConversationReference(request, { name: 'perplexity' }, result, metadata);
    const record = JSON.parse(readFileSync(saved.path, 'utf-8'));
    assert.deepEqual(record.provider_state, { backend_uuid: 'uuid', read_write_token: 'rw' });
    assert.deepEqual(record.messages.map(message => message.role), ['user', 'assistant']);
    assert.equal(saved.path, conversationRecordPath({ providerName: 'perplexity', id: 'research', storeDir: dir }));

    const resolved = resolveConversationReference(buildAiChatRequest({
      providerName: 'perplexity',
      prompt: 'follow-up',
      conversationTarget: 'research',
      conversationStoreDir: dir,
    }));
    assert.equal(resolved.record.provider_state.backend_uuid, 'uuid');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
