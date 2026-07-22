import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  buildAiChatRequest,
  aiChatResultExitCode,
  buildCacheInput,
  buildOutput,
  buildMetadata,
  captureEvidenceScreenshot,
  createChatGptStreamEmitter,
  conversationRecordPath,
  defaultBrowserStateFs,
  defaultIo,
  parseAiChatArgs,
  resolveConversationReference,
  resolveInitialModel,
  runPromptAttempt,
  runAiChat,
  sanitizeChatGptStreamValue,
  sanitizeProviderStateForOutput,
  saveSidecarArtifacts,
  saveConversationReference,
  validateConversationUrlForProvider,
  writeAiChatBrowserState,
} from '../scripts/ai-chat/module.mjs';
import { chatgptProvider, createChatGptNetworkTracker } from '../scripts/ai-chat/providers/chatgpt.mjs';
import { geminiProvider } from '../scripts/ai-chat/providers/gemini.mjs';
import { grokProvider } from '../scripts/ai-chat/providers/grok.mjs';
import { buildPerplexityPayload, perplexityProvider, resolvePerplexityModel } from '../scripts/ai-chat/providers/perplexity.mjs';
import { getCacheConfig as getAiChatCacheConfig, readCachedResponse, recordInvocation, writeCachedResponse } from '../scripts/browser-query-cache.mjs';

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
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  chmodSync(path, 0o600);
}

function noCache() {
  return { read: () => null, write: () => null };
}

function fileMode(path) {
  return statSync(path).mode & 0o777;
}


test('private cache artifacts are secured before overwrite and before reads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-chat-cache-permissions-'));
  try {
    await withEnv({ BROWSER_QUERY_CACHE_DIR: dir, BROWSER_QUERY_RUN_DIR: join(dir, 'run'), BROWSER_QUERY_STEP_ID: 'step' }, () => {
      const input = { prompt: 'private prompt' };
      const first = writeCachedResponse('provider', input, { output: 'response', rawText: 'raw', metadata: {} });
      recordInvocation('provider', first.key, { input });
      const invocationDir = join(dir, 'run', 'browser-tool-calls', 'step');
      const invocation = join(invocationDir, readdirSync(invocationDir)[0]);
      for (const path of [dir, join(dir, 'entries'), join(dir, 'responses'), join(dir, 'responses', 'provider'), join(dir, 'raw'), join(dir, 'raw', 'provider'), join(dir, 'run'), join(dir, 'run', 'browser-tool-calls'), invocationDir]) assert.equal(fileMode(path), 0o700, path);
      for (const path of [first.responsePath, first.rawPath, first.entryPath, invocation]) assert.equal(fileMode(path), 0o600, path);
      const originalResponse = readFileSync(first.responsePath, 'utf-8');
      chmodSync(first.responsePath, 0o644);
      assert.throws(() => writeCachedResponse('provider', input, { output: 'response two', rawText: 'raw two', metadata: {} }), /Refusing unsafe private file/);
      assert.equal(fileMode(first.responsePath), 0o644);
      assert.equal(readFileSync(first.responsePath, 'utf-8'), originalResponse);
      assert.throws(() => readCachedResponse('provider', input), /Refusing unsafe private file/);
      chmodSync(first.responsePath, 0o600);
      const second = writeCachedResponse('provider', input, { output: 'response two', rawText: 'raw two', metadata: {} });
      recordInvocation('provider', second.key, { input: 'again' });
      const latestInvocation = join(invocationDir, readdirSync(invocationDir).sort().at(-1));
      for (const path of [second.responsePath, second.rawPath, second.entryPath, latestInvocation]) assert.equal(fileMode(path), 0o600, path);
      const target = join(dir, 'target.txt'); writeFileSync(target, 'unchanged');
      rmSync(second.rawPath); symlinkSync(target, second.rawPath);
      assert.throws(() => writeCachedResponse('provider', input, { output: 'nope', rawText: 'nope', metadata: {} }), /Refusing unsafe private file/);
      assert.equal(readFileSync(target, 'utf-8'), 'unchanged');
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('screenshot evidence presecures output and rejects a permissive requested parent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-chat-evidence-permissions-'));
  try {
    chmodSync(root, 0o700);
    const output = join(root, 'new', 'evidence.png');
    let writes = 0;
    const page = { url: () => 'https://provider.example/chat', screenshot: async ({ path }) => { writes += 1; assert.equal(fileMode(path), 0o600); writeFileSync(path, 'image'); } };
    await captureEvidenceScreenshot({ browser: { pages: async () => [page] }, provider: { name: 'provider' }, result: { finalUrl: page.url() }, request: { captureEvidence: true, evidencePath: output } });
    assert.equal(writes, 1); assert.equal(fileMode(dirname(output)), 0o700); assert.equal(fileMode(output), 0o600);
    chmodSync(output, 0o644);
    await captureEvidenceScreenshot({ browser: { pages: async () => [page] }, provider: { name: 'provider' }, result: { finalUrl: page.url() }, request: { captureEvidence: true, evidencePath: output } });
    assert.equal(fileMode(output), 0o600);
    const unsafe = join(root, 'unsafe'); mkdirSync(unsafe); chmodSync(unsafe, 0o755);
    let screenshotCalled = false;
    await assert.rejects(() => captureEvidenceScreenshot({ browser: { pages: async () => [{ url: () => 'https://provider.example/chat', screenshot: async () => { screenshotCalled = true; } }] }, provider: { name: 'provider' }, result: { finalUrl: 'https://provider.example/chat' }, request: { captureEvidence: true, evidencePath: join(unsafe, 'no.png') } }), /existing directory must be a real directory with mode 0700/);
    assert.equal(screenshotCalled, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

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
    '--file', '/tmp/report.pdf',
    '--file', '/tmp/chart.png',
    '--space-uuid', '123e4567-e89b-12d3-a456-426614174000',
    '--stream',
    '--include-conversation',
    '--evidence',
    '--evidence-path', '/tmp/ai-chat-evidence.png',
    '--evidence-full-page',
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
  assert.deepEqual(request.providerOptions.files, ['/tmp/report.pdf', '/tmp/chart.png']);
  assert.equal(request.providerOptions.spaceUuid, '123e4567-e89b-12d3-a456-426614174000');
  assert.equal(request.stream, true);
  assert.equal(request.includeConversation, true);
  assert.equal(request.captureEvidence, true);
  assert.equal(request.evidencePath, '/tmp/ai-chat-evidence.png');
  assert.equal(request.evidenceFullPage, true);
  assert.equal(request.verifyModels, true);
  assert.equal(request.verifyModelTimeoutSeconds, 12);
  assert.equal(request.jsonOutput, true);
});

test('parseAiChatArgs leaves history mode provider-specific and supports explicit incognito mode', () => {
  const defaults = parseAiChatArgs(['--provider', 'perplexity', '--prompt', 'hello']);
  const incognito = parseAiChatArgs(['--provider', 'perplexity', '--prompt', 'hello', '--incognito']);

  assert.equal(defaults.providerOptions.saveToLibrary, undefined);
  assert.equal(incognito.providerOptions.saveToLibrary, false);
  assert.throws(
    () => parseAiChatArgs(['--provider', 'perplexity', '--prompt', 'hello', '--save-to-library', '--incognito']),
    /Cannot combine --save-to-library with --incognito/,
  );
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

test('AI Chat browser state writes enforce private file permissions and fail closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-chat-browser-state-permissions-'));
  const stateFile = join(dir, 'browser.json');
  const ownerToken = 'owner-token-must-not-leak';

  try {
    writeFileSync(stateFile, '{}\n', { encoding: 'utf-8', mode: 0o600 });
    chmodSync(stateFile, 0o600);

    writeAiChatBrowserState({ version: 1, ownerToken, port: 62100 }, stateFile);

    assert.equal(fileMode(stateFile), 0o600);
    chmodSync(stateFile, 0o666);
    assert.throws(() => writeAiChatBrowserState({ version: 1, ownerToken, port: 62100 }, stateFile), /real file with mode 0600/);
    assert.equal(fileMode(stateFile), 0o666);
    assert.equal(JSON.parse(readFileSync(stateFile, 'utf-8')).ownerToken, ownerToken);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const writeCalls = [];
  const failingFs = {
    exists: path => path === '/tmp',
    mkdir: () => assert.fail('existing private parent must not be recreated'),
    stat: () => ({ mode: 0o700, isFile: () => true }),
    lstat: path => {
      if (path === '/tmp') return { mode: 0o700, isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false };
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    },
    writeFile: () => assert.fail('path-based private write must not be used'),
    writeFileNoFollow: (...args) => {
      writeCalls.push(args);
      throw new Error(`cannot securely write ${ownerToken}`);
    },
    chmod: () => assert.fail('path-based chmod must not be used'),
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

test('AI Chat browser state rejects permissive existing parents and creates new private parents', () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-chat-browser-state-parent-'));
  const permissiveParent = join(root, 'shared');
  const privateParent = join(root, 'private', 'nested');
  const ownerToken = 'owner-token-must-not-leak';

  try {
    mkdirSync(permissiveParent, { recursive: true, mode: 0o755 });
    chmodSync(permissiveParent, 0o755);
    const rejectedPath = join(permissiveParent, 'browser.json');
    assert.throws(
      () => writeAiChatBrowserState({ version: 1, ownerToken, port: 62100 }, rejectedPath),
      /existing directory must be a real directory with mode 0700/,
    );
    assert.equal(fileMode(permissiveParent), 0o755);
    assert.equal(existsSync(rejectedPath), false);

    const statePath = join(privateParent, 'browser.json');
    writeAiChatBrowserState({ version: 1, ownerToken, port: 62100 }, statePath);
    assert.equal(fileMode(privateParent), 0o700);
    assert.equal(fileMode(statePath), 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('private JSON writers reject dangling browser-state and conversation-record symlinks before writing targets', () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-chat-private-json-dangling-symlink-'));
  chmodSync(root, 0o700);

  try {
    const browserStatePath = join(root, 'browser-state.json');
    const browserStateTarget = join(root, 'missing-browser-state-target.json');
    symlinkSync(browserStateTarget, browserStatePath);
    assert.throws(
      () => writeAiChatBrowserState({ version: 1, ownerToken: 'private-owner-token', port: 62100 }, browserStatePath),
      /symlink/,
    );
    assert.equal(existsSync(browserStateTarget), false);
    assert.equal(lstatSync(browserStatePath).isSymbolicLink(), true);

    const racedStatePath = join(root, 'raced-browser-state.json');
    const racedStateTarget = join(root, 'missing-race-target.json');
    writeFileSync(racedStatePath, '{}\n', { encoding: 'utf-8', mode: 0o600 });
    chmodSync(racedStatePath, 0o600);
    const racingFs = {
      ...defaultBrowserStateFs,
      writeFileNoFollow(path, text, options) {
        rmSync(path);
        symlinkSync(racedStateTarget, path);
        return defaultBrowserStateFs.writeFileNoFollow(path, text, options);
      },
    };
    assert.throws(
      () => writeAiChatBrowserState({ version: 1, ownerToken: 'private-owner-token', port: 62100 }, racedStatePath, racingFs),
      /atomic no-follow write failed/,
    );
    assert.equal(existsSync(racedStateTarget), false);
    assert.equal(lstatSync(racedStatePath).isSymbolicLink(), true);

    const request = buildAiChatRequest({
      providerName: 'perplexity',
      modelName: 'perplexity/best',
      prompt: 'private prompt',
      saveConversation: 'research',
      conversationStoreDir: root,
    });
    const provider = { name: 'perplexity' };
    const result = { text: 'private answer', done: true, modelUsed: 'perplexity/best', providerState: { backend_uuid: 'thread' } };
    const metadata = buildMetadata({ request, provider, result, fallbackFrom: null, fallbackTrail: ['perplexity/best'] });
    const recordPath = conversationRecordPath({ providerName: provider.name, id: 'research', storeDir: root });
    const recordTarget = join(root, 'missing-conversation-target.json');
    mkdirSync(dirname(recordPath), { recursive: true, mode: 0o700 });
    chmodSync(dirname(recordPath), 0o700);
    symlinkSync(recordTarget, recordPath);

    assert.throws(() => saveConversationReference(request, provider, result, metadata), /symlink/);
    assert.equal(existsSync(recordTarget), false);
    assert.equal(lstatSync(recordPath).isSymbolicLink(), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

test('Perplexity rejects --incognito continuation and attachment before local writes or browser work', async () => {
  const request = buildAiChatRequest({ providerName: 'perplexity', prompt: 'follow up', conversationTarget: 'saved', providerOptions: { incognito: true } });
  await assert.rejects(() => runAiChat(request, { provider: perplexityProvider }), /--incognito cannot continue or attach an existing conversation/);
  const attach = buildAiChatRequest({ providerName: 'perplexity', attachConversation: '123e4567-e89b-12d3-a456-426614174000', saveConversation: 'saved', providerOptions: { incognito: true } });
  await assert.rejects(() => runAiChat(attach, { provider: perplexityProvider }), /--incognito cannot continue or attach an existing conversation/);
});

test('save-conversation bypasses public cache metadata and preserves private continuation state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-chat-cache-conversation-'));
  try {
    const recordPath = conversationRecordPath({ providerName: 'perplexity', id: 'research', storeDir: dir });
    mkdirSync(dirname(recordPath), { recursive: true, mode: 0o700 });
    writeFileSync(recordPath, JSON.stringify({
      version: 1, kind: 'ai-chat-conversation', id: 'research', provider: 'perplexity',
      provider_state: { backend_uuid: '123e4567-e89b-12d3-a456-426614174000', read_write_token: 'rw-private' }, messages: [],
    }), { mode: 0o600 });
    const request = buildAiChatRequest({ providerName: 'perplexity', prompt: 'hello', jsonOutput: true, conversationTarget: 'research', saveConversation: 'research', conversationStoreDir: dir });
    const stdout = [];
    let cacheReads = 0;
    const result = await runAiChat(request, {
      provider: {
        name: 'perplexity', runRequiresBrowser: false,
        run: ({ conversation }) => {
          assert.equal(conversation.record.provider_state.read_write_token, 'rw-private');
          return { text: 'live answer', rawText: 'live answer', done: true, modelUsed: 'perplexity/best', finalUrl: 'https://www.perplexity.ai/search/123e4567-e89b-12d3-a456-426614174000', providerState: { backend_uuid: '123e4567-e89b-12d3-a456-426614174000', has_read_write_token: true }, privateProviderState: { backend_uuid: '123e4567-e89b-12d3-a456-426614174000', read_write_token: 'rw-private' } };
        },
      },
      cache: { read: () => { cacheReads += 1; return assert.fail('save-conversation must not read cache'); }, write: () => assert.fail('save-conversation must not write cache') },
      io: { stdout: text => stdout.push(text), writeFile: () => assert.fail('no file expected') },
    });
    assert.equal(cacheReads, 0);
    const emitted = JSON.parse(stdout[0]);
    assert.equal(emitted.cache_hit, false);
    assert.equal(Object.hasOwn(emitted, 'conversation_record_path'), false);
    assert.equal(JSON.stringify(emitted).includes(recordPath), false);
    const record = JSON.parse(readFileSync(recordPath, 'utf-8'));
    assert.equal(record.provider_state.read_write_token, 'rw-private');
    assert.equal(result.source, 'live');
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

test('runAiChat starts an AI Chat owned Browser Tools browser when no usable state exists', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-chat-browser-start-'));
  try {
    const stateFile = join(dir, 'browser.json');
    const stdout = [];
    const connectCalls = [];
    let startArgs = null;
    let disconnects = 0;
    const browser = { disconnect: () => { disconnects += 1; } };
    const request = buildAiChatRequest({ providerName: 'browser-provider', modelName: 'default', prompt: 'hello', jsonOutput: true, browserStateFile: stateFile });

    await runAiChat(request, {
      provider: {
        name: 'browser-provider',
        runRequiresBrowser: () => true,
        async run({ browser: runBrowser, request: runRequest }) {
          assert.equal(runBrowser, browser);
          assert.equal(runRequest.port, 4555);
          return { text: 'owned answer', rawText: 'owned answer', done: true, modelUsed: 'default' };
        },
      },
      async startChrome(args) {
        startArgs = args;
        return { status: 'started', port: 4555, ownerToken: 'owned-token', profileName: 'Default', requestedProfileName: 'Default', headless: true };
      },
      async connectBrowser(port, options) {
        connectCalls.push({ port, options });
        return browser;
      },
      cache: noCache(),
      io: { stdout: text => stdout.push(text), writeFile: () => assert.fail('no file expected') },
    });

    assert.deepEqual(startArgs, { port: 9222, taskName: 'ai-chat', defaultProfileName: 'Default', ownerId: 'ai-chat', autoAllocatePort: true });
    assert.deepEqual(connectCalls, [{ port: 4555, options: { ownerToken: 'owned-token', protocolTimeout: 60000 } }]);
    const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
    assert.equal(state.ownerId, 'ai-chat');
    assert.equal(state.ownerToken, 'owned-token');
    assert.equal(state.port, 4555);
    assert.equal(state.profileName, 'Default');
    assert.equal(state.requestedProfileName, 'Default');
    assert.equal(state.headless, true);
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
        return { status: 'started', port: 4666, ownerToken: 'reuse-token', profileName: 'Default', requestedProfileName: 'Default', headless: true };
      },
      managedBrowserSafetyForPort(port) {
        assert.equal(port, 4666);
        return { ok: true };
      },
      readManagedStateForPort(port) {
        assert.equal(port, 4666);
        return { managedBy: 'browser-tools', ownerId: 'ai-chat', profileName: 'Default', headless: true };
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
      async startChrome(args) {
        startCount += 1;
        assert.equal(args.headless, undefined);
        return { status: 'started', port: 4888, ownerToken: 'new-token', headless: false };
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
      readManagedStateForPort: () => ({ managedBy: 'browser-tools', ownerId: 'ai-chat', profileName: 'Default', headless: true }),
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

test('runAiChat reuses a windowed AI Chat browser for UI providers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-chat-browser-windowed-'));
  try {
    const stateFile = join(dir, 'browser.json');
    writeJson(stateFile, { version: 1, ownerId: 'ai-chat', ownerToken: 'owned-token', port: 4995, profileName: 'Default', headless: false });
    const request = buildAiChatRequest({ providerName: 'browser-provider', prompt: 'hello', browserStateFile: stateFile });
    const browser = { disconnect() {} };

    const result = await runAiChat(request, {
      provider: { name: 'browser-provider', runRequiresBrowser: () => true, run: () => ({ text: 'answer', rawText: 'answer', done: true, modelUsed: 'default' }) },
      managedBrowserSafetyForPort: () => ({ ok: true }),
      readManagedStateForPort: () => ({ managedBy: 'browser-tools', ownerId: 'ai-chat', profileName: 'Default', headless: false }),
      managedBrowserOwnershipSafety: () => ({ ok: true, ownerId: 'ai-chat' }),
      browserWSEndpoint: async () => 'ws://localhost:4995',
      startChrome: () => assert.fail('windowed browser should be reused'),
      connectBrowser: async () => browser,
      cache: noCache(),
      io: { stdout: () => {}, writeFile: () => assert.fail('no file expected') },
    });
    assert.equal(result.result.text, 'answer');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runAiChat refuses old AI Chat browsers that were started with a fresh profile', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-chat-browser-profile-mismatch-'));
  try {
    const stateFile = join(dir, 'browser.json');
    writeJson(stateFile, { version: 1, ownerId: 'ai-chat', ownerToken: 'owned-token', port: 4996, profileName: null, headless: true });
    const request = buildAiChatRequest({ providerName: 'browser-provider', prompt: 'hello', browserStateFile: stateFile });

    await assert.rejects(() => runAiChat(request, {
      provider: { name: 'browser-provider', runRequiresBrowser: () => true, run: () => assert.fail('provider should not run') },
      managedBrowserSafetyForPort: () => ({ ok: true }),
      readManagedStateForPort: () => ({ managedBy: 'browser-tools', ownerId: 'ai-chat', profileName: null, headless: true }),
      managedBrowserOwnershipSafety: () => ({ ok: true, ownerId: 'ai-chat' }),
      browserWSEndpoint: async () => 'ws://localhost:4996',
      startChrome: () => assert.fail('fresh-profile browser should not be reused or replaced silently'),
      connectBrowser: () => assert.fail('fresh-profile browser should not connect'),
      cache: noCache(),
    }), /profile-mismatch expected configured-or-default-profile, got fresh-profile.*Recovery/s);
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

test('ai-chat query cache rejects invalid TTL values', async () => {
  await withEnv({
    BROWSER_QUERY_CACHE_DIR: '/tmp/ai-chat-cache-test',
    BROWSER_QUERY_TTL_SECONDS: 'not-a-number',
  }, () => {
    assert.throws(() => getAiChatCacheConfig(), /Invalid BROWSER_QUERY_TTL_SECONDS/);
  });
});

test('runAiChat keeps partial Perplexity SSE responses incomplete and uncached', async () => {
  const encoder = new TextEncoder();
  const partialEvent = `data: ${JSON.stringify({
    backend_uuid: 'uuid-partial',
    text: JSON.stringify({ answer: 'partial answer', chunks: ['partial answer'] }),
  })}\n`;
  let readCount = 0;
  const previousFetch = globalThis.fetch;
  const stdout = [];
  const cacheWrites = [];

  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes('/api/auth/session')) return { ok: true, json: async () => ({ user: { id: 'fixture-user' } }) };
    if (href.includes('/search/new')) return { ok: true, text: async () => '' };
    if (href.includes('/rest/sse/perplexity_ask')) {
      return {
        ok: true,
        body: {
          getReader: () => ({
            read: async () => {
              if (readCount > 0) return { done: true };
              readCount += 1;
              return { value: encoder.encode(partialEvent), done: false };
            },
          }),
        },
      };
    }
    throw new Error(`unexpected fetch URL: ${href}`);
  };

  try {
    const request = buildAiChatRequest({
      providerName: 'perplexity',
      modelName: 'perplexity/best',
      prompt: 'hello',
      jsonOutput: true,
    });
    const provider = {
      ...perplexityProvider,
      runRequiresBrowser: () => false,
      run: async () => ({
        text: 'partial answer',
        rawText: 'partial answer',
        done: false,
        modelUsed: 'perplexity/best',
        providerState: {
          transport: 'browser-network-sse',
          network_only: true,
          dom_processing: false,
          stream_state: { status: 'partial', partial: true, timeout: true },
        },
      }),
    };

    const result = await runAiChat(request, {
      provider,
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
  } finally {
    globalThis.fetch = previousFetch;
  }
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
    const publicTexts = [
      outputText,
      sidecarText,
      result.output,
      JSON.stringify(result.metadata),
      JSON.stringify(result.result),
    ];
    for (const text of publicTexts) assert.equal(text.includes(rawToken), false);
    assert.equal(cachedWrite, null, '--save-conversation must bypass public cache writes');

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
    assert.equal(Object.hasOwn(emitted, 'conversation_record_path'), false);
    assert.equal(Object.hasOwn(sidecar, 'conversation_record_path'), false);

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
    const recordPath = conversationRecordPath({ providerName: 'chatgpt', id: 'timed-out', storeDir: dir });
    writeJson(recordPath, {
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
    chmodSync(dirname(recordPath), 0o700);

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
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(path), 0o700);
    writeFileSync(path, '{}\n', { encoding: 'utf-8', mode: 0o600 });
    chmodSync(path, 0o600);

    const saved = saveConversationReference(request, provider, result, metadata);

    assert.equal(fileMode(dirname(saved.path)), 0o700);
    assert.equal(fileMode(saved.path), 0o600);
    chmodSync(path, 0o666);
    assert.throws(() => saveConversationReference(request, provider, result, metadata), /real file with mode 0600/);
    assert.equal(fileMode(path), 0o666);
    assert.equal(readFileSync(saved.path, 'utf-8').includes(rawToken), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const recordDir = dirname(conversationRecordPath({ providerName: provider.name, id: 'research', storeDir: dir }));
  const failingFs = {
    exists: path => path === recordDir,
    mkdir: () => assert.fail('existing private parent must not be recreated'),
    writeFile: () => {},
    chmod: () => {},
    stat: path => ({ mode: path === recordDir ? 0o700 : 0o644, isFile: () => path !== recordDir }),
    lstat: path => ({ mode: path === recordDir ? 0o700 : 0o644, isDirectory: () => path === recordDir, isFile: () => path !== recordDir, isSymbolicLink: () => false }),
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

test('submit-only and final flags validate the detached ChatGPT contract before browser startup', async () => {
  const base = { name: 'chatgpt', capabilities: { localConversationState: false, cachePolicy: 'none', supportsSubmitOnly: true, supportsFinal: true }, resolveConversationAttachment: chatgptProvider.resolveConversationAttachment };
  const submit = buildAiChatRequest(parseAiChatArgs(['--provider', 'chatgpt', '--prompt', 'x', '--submit-only']));
  assert.equal(submit.prompt, 'x'); assert.equal(submit.submitOnly, true);
  const finalWithoutPrompt = buildAiChatRequest(parseAiChatArgs(['--provider', 'chatgpt', '--conversation', 'provider_123', '--final']));
  assert.equal(finalWithoutPrompt.prompt, ''); assert.equal(finalWithoutPrompt.final, true);
  for (const [args, message] of [
    [['--provider', 'chatgpt', '--prompt', 'x', '--submit-only', '--stream'], /--submit-only conflicts with --final and --stream/],
    [['--provider', 'chatgpt', '--prompt', 'x', '--conversation', 'provider_123', '--final'], /--final cannot be used with --prompt/],
  ]) {
    const request = buildAiChatRequest(parseAiChatArgs(args));
    await assert.rejects(() => runAiChat(request, { provider: base, cache: noCache() }), message);
  }
  await assert.rejects(() => runAiChat(buildAiChatRequest({ providerName: 'chatgpt', submitOnly: true, prompt: '' }), { provider: base, cache: noCache() }), /--submit-only requires --prompt/);
  const request = buildAiChatRequest(parseAiChatArgs(['--provider', 'chatgpt', '--conversation', 'provider_123', '--final', '--json', '--timeout', '1']));
  let reads = 0;
  const result = await runAiChat(request, {
    provider: { ...base, async recheckConversation({ conversation }) { assert.equal(conversation.providerId, 'provider_123'); return { text: '', done: false, status: 'in_progress', providerConversationId: conversation.providerId, finalUrl: conversation.url, providerState: { conversation_id: conversation.providerId } }; } },
    fs: { exists: () => { reads += 1; throw new Error('local state read'); } },
    cache: { read: () => { reads += 1; }, write: () => { reads += 1; } },
    browser: {}, io: { stdout() {} },
  });
  assert.equal(reads, 0);
  assert.equal(result.metadata.status, 'in_progress');
  assert.equal(aiChatResultExitCode(request, result), 1);
  assert.equal(aiChatResultExitCode(buildAiChatRequest({ providerName: 'chatgpt', prompt: 'x', submitOnly: true }), { metadata: { complete: false } }), 0);
});

test('submit-only preserves every prompt source while final stays stdin-free', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-chat-submit-prompt-'));
  const promptFile = join(dir, 'prompt.txt'); const stdinFile = join(dir, 'stdin.txt');
  try {
    writeFileSync(promptFile, 'file prompt\n', { mode: 0o600 }); writeFileSync(stdinFile, 'stdin prompt\n', { mode: 0o600 });
    assert.equal(buildAiChatRequest(parseAiChatArgs(['--prompt', 'inline prompt', '--submit-only'])).prompt, 'inline prompt');
    assert.equal(buildAiChatRequest({ promptFile, submitOnly: true }).prompt, 'file prompt');
    assert.equal(buildAiChatRequest({ prompt: 'programmatic prompt', submitOnly: true }).prompt, 'programmatic prompt');
    assert.equal(buildAiChatRequest({ submitOnly: true, stdinPath: stdinFile }).prompt, 'stdin prompt');
    assert.equal(buildAiChatRequest({ final: true, conversationTarget: 'provider_123', stdinPath: join(dir, 'missing') }).prompt, '');
    assert.equal(buildAiChatRequest({ final: true, conversationTarget: 'provider_123', prompt: 'blocked' }).prompt, 'blocked');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('submit-only emits a provider id in plain and JSON output', () => {
  const metadata = { provider: 'chatgpt', provider_conversation_id: 'provider_123', status: 'submitted', complete: false, conversation_url: 'https://chatgpt.com/c/provider_123' };
  assert.equal(buildOutput({ request: buildAiChatRequest({ submitOnly: true, prompt: 'x' }), metadata, text: '' }).text, 'provider_123');
  const json = JSON.parse(buildOutput({ request: buildAiChatRequest({ submitOnly: true, prompt: 'x', jsonOutput: true }), metadata, text: '' }).text);
  assert.equal(json.provider_conversation_id, 'provider_123'); assert.equal(json.status, 'submitted'); assert.equal(json.complete, false); assert.equal(json.response, 'provider_123');
});

test('provider-only ChatGPT state and unsupported mode flags reject before browser, fs, or cache use', async () => {
  const forbidden = { get() { throw new Error('unexpected local or browser access'); } };
  const chatgpt = { name: 'chatgpt', capabilities: { localConversationState: false, cachePolicy: 'none', supportsSubmitOnly: true, supportsFinal: true }, resolveConversationAttachment: chatgptProvider.resolveConversationAttachment };
  for (const request of [
    buildAiChatRequest({ providerName: 'chatgpt', prompt: 'x', saveConversation: 'local' }),
    buildAiChatRequest({ providerName: 'chatgpt', prompt: 'x', attachConversation: 'provider_123' }),
  ]) await assert.rejects(() => runAiChat(request, { provider: chatgpt, fs: forbidden, cache: forbidden }), /--save-conversation and --attach-conversation are not supported; use the provider conversation id directly/);
  const unsupported = { name: 'other', capabilities: {} };
  await assert.rejects(() => runAiChat(buildAiChatRequest({ providerName: 'other', prompt: 'x', submitOnly: true }), { provider: unsupported, fs: forbidden, cache: forbidden }), /--submit-only is not supported/);
  await assert.rejects(() => runAiChat(buildAiChatRequest({ providerName: 'other', final: true, conversationTarget: 'id' }), { provider: unsupported, fs: forbidden, cache: forbidden }), /--final is not supported/);
});

test('ChatGPT capability modes never touch local cache or conversation storage', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-chat-chatgpt-stateless-'));
  const calls = { cache: 0, fs: 0, run: 0 };
  const provider = {
    name: 'chatgpt', capabilities: { localConversationState: false, cachePolicy: 'none', supportsSubmitOnly: true, supportsFinal: true },
    resolveConversationAttachment: chatgptProvider.resolveConversationAttachment,
    async run({ request }) { calls.run += 1; return { text: request.submitOnly ? '' : 'answer', done: !request.submitOnly, status: request.submitOnly ? 'submitted' : 'complete', providerConversationId: 'provider_123', finalUrl: 'https://chatgpt.com/c/provider_123', providerState: { conversation_id: 'provider_123' } }; },
    async recheckConversation({ conversation }) { return { text: '', done: false, status: 'in_progress', providerConversationId: conversation.providerId, finalUrl: conversation.url, providerState: { conversation_id: conversation.providerId } }; },
  };
  const fs = new Proxy({}, { get() { calls.fs += 1; throw new Error('local conversation fs accessed'); } });
  const cache = { read() { calls.cache += 1; }, write() { calls.cache += 1; } };
  try {
    const results = [];
    for (const request of [
      buildAiChatRequest({ providerName: 'chatgpt', prompt: 'sync', conversationStoreDir: dir }),
      buildAiChatRequest({ providerName: 'chatgpt', prompt: 'detach', submitOnly: true, conversationStoreDir: dir }),
      buildAiChatRequest({ providerName: 'chatgpt', final: true, conversationTarget: 'provider_123', conversationStoreDir: dir }),
    ]) results.push(await runAiChat(request, { provider, cache, fs, browser: {}, io: { stdout() {} } }));
    assert.equal(calls.cache, 0); assert.equal(calls.fs, 0); assert.equal(calls.run, 2); assert.deepEqual(readdirSync(dir), []);
    assert.deepEqual({ provider: results[1].metadata.provider, provider_conversation_id: results[1].metadata.provider_conversation_id, status: results[1].metadata.status, complete: results[1].metadata.complete, conversation_url: results[1].metadata.conversation_url }, { provider: 'chatgpt', provider_conversation_id: 'provider_123', status: 'submitted', complete: false, conversation_url: 'https://chatgpt.com/c/provider_123' });
    assert.equal(results[2].metadata.status, 'in_progress'); assert.equal(results[2].metadata.complete, false); assert.equal(aiChatResultExitCode(buildAiChatRequest({ providerName: 'chatgpt', final: true }), results[2]), 1);
    const completeFinal = await runAiChat(buildAiChatRequest({ providerName: 'chatgpt', final: true, conversationTarget: 'provider_123', conversationStoreDir: dir }), { provider: { ...provider, async recheckConversation({ conversation }) { return { text: 'answer', done: true, status: 'complete', providerConversationId: conversation.providerId, finalUrl: conversation.url, providerState: { conversation_id: conversation.providerId, structured_turn: { messages: [] } } }; } }, cache, fs, browser: {}, io: { stdout() {} } });
    assert.equal(completeFinal.metadata.provider_conversation_id, 'provider_123'); assert.equal(completeFinal.metadata.status, 'complete'); assert.equal(completeFinal.metadata.complete, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('submit-only disposes its attempt observer without closing the browser or page', async () => {
  let disposed = 0; let closed = 0;
  const page = { url: () => 'https://chatgpt.com/', evaluate: async () => 0, close: () => { closed += 1; } };
  const browser = { pages: async () => [], close: () => { closed += 1; } };
  const provider = {
    name: 'chatgpt', findPage: async () => page, createAttemptContext: async () => ({ networkTracker: {} }),
    clearInput: async () => {}, typePrompt: async () => {}, submit: async () => {},
    waitForResponse: async () => ({ text: '', done: false, status: 'submitted', providerConversationId: 'provider_123', finalUrl: 'https://chatgpt.com/c/provider_123', providerState: { conversation_id: 'provider_123' } }),
    disposeAttemptContext: async () => { disposed += 1; },
  };
  const result = await runPromptAttempt({ browser, provider, request: buildAiChatRequest({ providerName: 'chatgpt', prompt: 'detach', submitOnly: true }), selectedModel: 'default' });
  assert.equal(result.providerConversationId, 'provider_123'); assert.equal(disposed, 1); assert.equal(closed, 0);
});

test('ChatGPT stream owns stdout as NDJSON and emits one terminal complete event', async () => {
  const lines = [];
  const provider = {
    name: 'chatgpt', defaultModel: 'extra-high', transport: 'test',
    capabilities: { localConversationState: false, cachePolicy: 'none', streamFormat: 'ndjson' },
    runRequiresBrowser: () => false,
    async run({ onStreamEvent }) {
      onStreamEvent({ event: 'session', provider_conversation_id: 'provider_123', url: 'https://chatgpt.com/c/provider_123', source: 'live-cdp' });
      onStreamEvent({ event: 'delta', provider_conversation_id: 'provider_123', text: 'answer', source: 'live-cdp' });
      return { text: 'answer', rawText: 'answer', done: true, status: 'complete', modelUsed: 'gpt-test', providerConversationId: 'provider_123', finalUrl: 'https://chatgpt.com/c/provider_123', providerState: { conversation_id: 'provider_123', thinking_effort: 'max', structured_turn: { messages: [{ id: 'a', author: { role: 'assistant' }, content: { parts: ['answer'] } }] } } };
    },
  };
  const result = await runAiChat(buildAiChatRequest({ providerName: 'chatgpt', prompt: 'hello', stream: true }), {
    provider, cache: noCache(), io: { stdout: text => lines.push(text), writeFile: () => assert.fail('no file expected') },
  });
  const events = lines.map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => event.sequence), [1, 2, 3]);
  assert.deepEqual(events.map(event => event.event), ['session', 'delta', 'complete']);
  assert.equal(events.at(-1).complete, true);
  assert.equal(events.at(-1).source, 'live-cdp');
  assert.equal(events.at(-1).model, 'gpt-test'); assert.equal(events.at(-1).effort, 'max');
  assert.equal(events.at(-1).url, 'https://chatgpt.com/c/provider_123');
  assert.equal(events.at(-1).turn.messages[0].content.parts[0], 'answer');
  assert.equal(aiChatResultExitCode({ stream: true }, result), 0);
});

test('ChatGPT NDJSON timeout emits one live terminal without normal output and exits nonzero', async () => {
  const lines = [];
  const provider = { name: 'chatgpt', defaultModel: 'extra-high', capabilities: { localConversationState: false, cachePolicy: 'none', streamFormat: 'ndjson' }, runRequiresBrowser: () => false, async run({ onStreamEvent }) { onStreamEvent({ event: 'session', provider_conversation_id: 'provider_123', source: 'live-cdp' }); return { text: 'partial', done: false, status: 'in_progress', providerConversationId: 'provider_123', finalUrl: 'https://chatgpt.com/c/provider_123', providerState: { conversation_id: 'provider_123', partial: true, structured_turn: { messages: [{ id: 'a', metadata: { resume_token: 'TEST_TIMEOUT_SECRET' }, content: { parts: ['partial'] } }] } } }; } };
  const request = buildAiChatRequest({ providerName: 'chatgpt', prompt: 'hello', stream: true });
  const result = await runAiChat(request, { provider, cache: noCache(), io: { stdout: line => lines.push(line) } });
  const events = lines.map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => event.sequence), [1, 2]);
  assert.equal(events.at(-1).event, 'timeout'); assert.equal(events.at(-1).source, 'live-cdp');
  assert.equal(events.at(-1).response, 'partial'); assert.equal(JSON.stringify(events).includes('TEST_TIMEOUT_SECRET'), false);
  assert.equal(aiChatResultExitCode(request, result), 1);
});

test('provider-ID reattachment streams snapshot messages then one provider-snapshot terminal without local state', async () => {
  const lines = []; const calls = { cache: 0, fs: 0 };
  const provider = {
    name: 'chatgpt', defaultModel: 'extra-high', capabilities: { localConversationState: false, cachePolicy: 'none', streamFormat: 'ndjson' },
    resolveConversationAttachment: chatgptProvider.resolveConversationAttachment, runRequiresBrowser: () => false,
    async recheckConversation({ conversation, onStreamEvent }) { onStreamEvent({ event: 'session', provider_conversation_id: conversation.providerId, source: 'provider-snapshot' }); onStreamEvent({ event: 'message', provider_conversation_id: conversation.providerId, source: 'provider-snapshot', message: { id: 'a', content: { parts: ['answer'] } }, change: 'new' }); return { text: 'answer', done: true, status: 'complete', providerConversationId: conversation.providerId, finalUrl: conversation.url, modelUsed: 'gpt-test', providerState: { conversation_id: conversation.providerId, structured_turn: { messages: [{ id: 'a', content: { parts: ['answer'] } }] } } }; },
  };
  const request = buildAiChatRequest({ providerName: 'chatgpt', conversationTarget: 'provider_123', stream: true });
  const result = await runAiChat(request, { provider, cache: { read() { calls.cache += 1; }, write() { calls.cache += 1; } }, fs: new Proxy({}, { get() { calls.fs += 1; throw new Error('local state accessed'); } }), io: { stdout: line => lines.push(line) } });
  const events = lines.map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => event.event), ['session', 'message', 'complete']);
  assert.equal(events.every(event => event.provider_conversation_id === 'provider_123'), true);
  assert.equal(events.at(-1).source, 'provider-snapshot'); assert.equal(aiChatResultExitCode(request, result), 0);
  assert.deepEqual(calls, { cache: 0, fs: 0 });
});

test('ChatGPT public output redacts credential query families in state, responses, and NDJSON', () => {
  const queryFamilies = [
    'auth', 'authorization', 'session', 'session_id', 'cookie', 'AWSAccessKeyId', 'GoogleAccessId',
    'X-Goog-Credential', 'X-Goog-Signature',
  ];
  for (const parameter of queryFamilies) {
    const secret = `LEAK_${parameter}`;
    const url = `https://example.test/citation?${parameter}=${secret}&safe=ok#fragment`;
    const state = { structured_turn: { citations: [{ url }] } };
    const safeState = sanitizeProviderStateForOutput('chatgpt', state);
    assert.doesNotMatch(JSON.stringify(safeState), new RegExp(secret), `${parameter} provider state`);
    assert.match(JSON.stringify(safeState), /safe=ok#fragment/, `${parameter} provider state preserves safe URL content`);

    const normalJson = buildOutput({ request: { jsonOutput: true, submitOnly: false }, metadata: { provider: 'chatgpt', provider_state: state }, text: `answer ${url}` }).text;
    const normalPlain = buildOutput({ request: { jsonOutput: false, submitOnly: false }, metadata: { provider: 'chatgpt' }, text: `answer ${url}` }).text;
    assert.doesNotMatch(normalJson, new RegExp(secret), `${parameter} JSON response`);
    assert.doesNotMatch(normalPlain, new RegExp(secret), `${parameter} plain response`);
    assert.match(normalJson, /safe=ok#fragment/, `${parameter} JSON response preserves safe URL content`);
    assert.match(normalPlain, /safe=ok#fragment/, `${parameter} plain response preserves safe URL content`);

    const lines = [];
    const emitter = createChatGptStreamEmitter({ io: { stdout: line => lines.push(line) } });
    emitter.emit('message', { source: 'live-cdp', message: { content: { parts: [`source ${url}`] } } });
    assert.doesNotMatch(lines[0], new RegExp(secret), `${parameter} NDJSON`);
    assert.match(lines[0], /safe=ok#fragment/, `${parameter} NDJSON preserves safe URL content`);
  }
  assert.equal(sanitizeChatGptStreamValue('API key and passwordless tokenization are prose.'), 'API key and passwordless tokenization are prose.');
  assert.equal(sanitizeChatGptStreamValue('https://example.test/?key=harmless&safe=ok#fragment'), 'https://example.test/?key=harmless&safe=ok#fragment');
});

test('ChatGPT public surfaces redact structured and JSON-shaped signature credentials', () => {
  const markers = ['SIGNATURE_MARKER', 'SIG_MARKER', 'AWS_MARKER', 'GOOGLE_MARKER', 'AMZ_MARKER', 'GOOG_MARKER'];
  const secrets = { signature: markers[0], sig: markers[1], awsAccessKeyId: markers[2], googleAccessId: markers[3], xAmzCredential: markers[4], xGoogCredential: markers[5] };
  const prose = `signature verification matters; tokenization; key=music; ${JSON.stringify(secrets)}`;
  const state = { ...secrets, design: 'ordinary', nested: { note: prose } };
  const safeState = sanitizeProviderStateForOutput('chatgpt', state);
  const assertSafe = value => {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    for (const marker of markers) assert.equal(serialized.includes(marker), false, marker);
    assert.match(serialized, /signature verification matters; tokenization; key=music/);
  };
  assertSafe(safeState);
  assert.equal(safeState.design, 'ordinary');

  const metadata = { provider: 'chatgpt', provider_state: { structured_turn: { messages: [{ content: { parts: [prose] } }] }, ...state } };
  assertSafe(buildOutput({ request: { jsonOutput: true, submitOnly: false }, metadata, text: prose }).text);
  assertSafe(buildOutput({ request: { jsonOutput: false, submitOnly: false }, metadata, text: prose }).text);

  const lines = [];
  const emitter = createChatGptStreamEmitter({ io: { stdout: line => lines.push(line) } });
  emitter.emit('message', { source: 'live-cdp', message: { ...secrets, content: { parts: [prose] } } });
  emitter.emitTerminal('complete', { source: 'live-cdp', response: prose, turn: { ...secrets, messages: [{ content: { parts: [prose] } }] } });
  for (const line of lines) assertSafe(line);
});

test('ChatGPT stream emitter keeps its envelope core-owned and preserves prose while redacting credentials', () => {
  const lines = [];
  const emitter = createChatGptStreamEmitter({ io: { stdout: line => lines.push(line) }, now: () => '2026-07-22T00:00:00.000Z' });
  emitter.emit('delta', { event: 'error', provider: 'evil', sequence: 99, captured_at: 'evil-time', source: 'evil-source', provider_conversation_id: 'provider_123', text: 'Explain tokenization and secret management.', nested: { resume_token: 'TEST_SECRET', text: 'Bearer abc token=def' } });
  const event = JSON.parse(lines[0]);
  assert.deepEqual({ event: event.event, provider: event.provider, sequence: event.sequence, captured_at: event.captured_at, source: event.source }, { event: 'delta', provider: 'chatgpt', sequence: 1, captured_at: '2026-07-22T00:00:00.000Z', source: 'provider-snapshot' });
  assert.equal(event.text, 'Explain tokenization and secret management.');
  assert.equal(JSON.stringify(event).includes('TEST_SECRET'), false);
  assert.equal(JSON.stringify(event).includes('abc'), false);
  assert.equal(sanitizeChatGptStreamValue('API key and passwordless tokenization are prose.'), 'API key and passwordless tokenization are prose.');
});

test('ChatGPT NDJSON stream errors are terminal once and propagate only sanitized details', async () => {
  const lines = [];
  const secret = 'TEST_STREAM_SECRET';
  const provider = { name: 'chatgpt', capabilities: { localConversationState: false, cachePolicy: 'none', streamFormat: 'ndjson' }, runRequiresBrowser: () => false, async run() { const error = new Error(`Bearer raw-value token=${secret} ${secret}`); error.code = secret; throw error; } };
  const request = buildAiChatRequest({ providerName: 'chatgpt', prompt: 'hello', stream: true });
  await assert.rejects(() => runAiChat(request, { provider, cache: noCache(), io: { stdout: line => lines.push(line) } }), error => {
    assert.equal(error.message.includes(secret), false);
    assert.equal(error.message.includes('raw-value'), false);
    return true;
  });
  assert.equal(lines.length, 1);
  const event = JSON.parse(lines[0]);
  assert.equal(event.event, 'error'); assert.equal(event.complete, false);
  assert.equal(event.source, 'live-cdp'); assert.equal(event.code, 'chatgpt_stream_error');
  assert.equal(JSON.stringify(event).includes(secret), false);
  assert.equal(aiChatResultExitCode(request, { provider, metadata: { complete: false } }), 1);
});

test('provider terminal progress is rejected as one safe terminal error and cannot be followed by complete', async () => {
  const lines = []; const secret = 'PROGRESS_CODE_SECRET';
  const provider = { name: 'chatgpt', capabilities: { localConversationState: false, cachePolicy: 'none', streamFormat: 'ndjson' }, runRequiresBrowser: () => false, async run({ onStreamEvent }) { onStreamEvent({ event: 'complete', source: 'live-cdp', code: secret }); return { text: 'must not return', done: true, providerConversationId: 'provider_123' }; } };
  const request = buildAiChatRequest({ providerName: 'chatgpt', prompt: 'hello', stream: true });
  await assert.rejects(() => runAiChat(request, { provider, cache: noCache(), io: { stdout: line => lines.push(line) } }), /Invalid provider ChatGPT stream progress event/);
  const events = lines.map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => event.event), ['error']);
  assert.equal(events[0].source, 'live-cdp');
  assert.equal(JSON.stringify(events).includes(secret), false);
});

test('terminal reconciliation carries a provider id even without an earlier session event', async () => {
  const lines = [];
  const provider = { name: 'chatgpt', defaultModel: 'extra-high', capabilities: { localConversationState: false, cachePolicy: 'none', streamFormat: 'ndjson' }, runRequiresBrowser: () => false, async run() { return { text: 'answer', done: true, providerConversationId: 'provider_123', finalUrl: 'https://chatgpt.com/c/provider_123', providerState: { conversation_id: 'provider_123', structured_turn: { messages: [] } } }; } };
  await runAiChat(buildAiChatRequest({ providerName: 'chatgpt', prompt: 'hello', stream: true }), { provider, cache: noCache(), io: { stdout: line => lines.push(line) } });
  const terminal = JSON.parse(lines[0]);
  assert.equal(terminal.event, 'complete'); assert.equal(terminal.provider_conversation_id, 'provider_123');
});

test('ChatGPT stream tracker turns an asynchronous private transcript append failure into one error terminal', async () => {
  class FakeCdpSession extends EventEmitter {
    async send(method) {
      if (method === 'Network.streamResourceContent') return { bufferedData: Buffer.from('data: {"conversation_id":"provider_123"}\\n\\n').toString('base64') };
      return {};
    }
    async detach() {}
  }
  const lines = []; const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  const provider = {
    name: 'chatgpt', defaultModel: 'instant', capabilities: { localConversationState: false, cachePolicy: 'none', streamFormat: 'ndjson' }, runRequiresBrowser: () => false,
    async run({ onStreamEvent }) {
      const client = new FakeCdpSession();
      const tracker = await createChatGptNetworkTracker({ page: { target: () => ({ createCDPSession: async () => client }) }, selectedModel: 'instant', onStreamEvent });
      client.emit('Network.requestWillBeSent', { requestId: 'request', request: { method: 'POST', url: 'https://chatgpt.com/backend-api/f/conversation' } });
      client.emit('Network.responseReceived', { requestId: 'request', response: { status: 200, mimeType: 'text/event-stream' } });
      await new Promise(resolve => setImmediate(resolve));
      try {
        return await chatgptProvider.waitForResponse({ page: { url: () => 'https://chatgpt.com/' }, timeoutMs: 100, networkTracker: tracker, selectedModel: 'instant', request: {}, sleepFn: async () => {} });
      } finally {
        await tracker.dispose();
      }
    },
  };
  const request = buildAiChatRequest({ providerName: 'chatgpt', prompt: 'hello', stream: true, outFile: 'private.ndjson' });
  try {
    await assert.rejects(() => runAiChat(request, { provider, cache: noCache(), io: { initializePrivateStreamFile() {}, appendPrivateStreamFile() { throw new Error('disk failure'); }, stdout: line => lines.push(line) } }), /Failed to emit ChatGPT stream progress/);
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  const events = lines.map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => event.event), ['error']);
  assert.equal(events[0].code, 'stream_file_error'); assert.equal(events[0].complete, false);
  assert.equal(unhandled.length, 0);
});

test('ChatGPT stream transcript appends before stdout and turns an append failure into one error terminal', () => {
  const stdout = []; const file = [];
  const emitter = createChatGptStreamEmitter({ outFile: 'explicit.ndjson', io: { stdout: line => stdout.push(line), appendPrivateStreamFile: (_path, line) => file.push(line) }, now: () => 'now' });
  emitter.emitProgress('status', { source: 'live-cdp', status: 'submitted' });
  emitter.emitTerminal('complete', { source: 'live-cdp', complete: true });
  assert.deepEqual(stdout.map(line => `${line}\n`), file);
  const failed = []; let appendCount = 0;
  const failing = createChatGptStreamEmitter({ outFile: 'explicit.ndjson', io: { stdout: line => failed.push(line), appendPrivateStreamFile: () => { appendCount += 1; if (appendCount === 2) throw new Error('disk'); } }, now: () => 'now' });
  failing.emitProgress('status', { source: 'live-cdp', status: 'submitted' });
  assert.throws(() => failing.emitTerminal('complete', { source: 'live-cdp', complete: true }), /private NDJSON transcript/);
  failing.emitTerminal('error', { source: 'live-cdp', complete: false, code: 'stream_file_error', message: 'safe' });
  const failedEvents = failed.map(line => JSON.parse(line));
  assert.deepEqual(failedEvents.map(line => line.event), ['status', 'error']);
  assert.deepEqual(failedEvents.map(line => line.sequence), [1, 2]);
  assert.equal(failedEvents.filter(line => ['complete', 'timeout', 'error'].includes(line.event)).length, 1);
});

test('listing parses bounded flags and rejects invalid limits before browser use', async () => {
  const parsed = parseAiChatArgs(['--provider', 'chatgpt', '--list-conversations', '--conversation-limit', '20']);
  assert.equal(parsed.listConversations, true); assert.equal(parsed.conversationLimit, 20);
  for (const limit of ['0', '-1', '101', 'nope']) assert.throws(() => parseAiChatArgs(['--conversation-limit', limit]));
  const request = buildAiChatRequest({ providerName: 'grok', listConversations: true });
  await assert.rejects(() => runAiChat(request, { provider: { name: 'grok', capabilities: {} }, browserTools: { startChrome: async () => { throw new Error('browser started'); } } }), /not supported/);
});

test('ChatGPT stream validation emits one stdout terminal before browser work', async () => {
  const lines = []; const provider = { name: 'chatgpt', capabilities: { streamFormat: 'ndjson' } };
  await assert.rejects(() => runAiChat(buildAiChatRequest({ providerName: 'chatgpt', prompt: 'x', stream: true, submitOnly: true }), { provider, io: { stdout: line => lines.push(line) } }));
  assert.deepEqual(lines.map(line => JSON.parse(line).event), ['error']);
});
test('stream initialization failure uses prompted and reattach sources', async () => {
  for (const [request, source] of [[buildAiChatRequest({ providerName: 'chatgpt', prompt: 'x', stream: true, outFile: 'x' }), 'live-cdp'], [buildAiChatRequest({ providerName: 'chatgpt', conversationTarget: 'provider_1', stream: true, outFile: 'x' }), 'provider-snapshot']]) {
    const lines = []; const provider = { name: 'chatgpt', capabilities: { streamFormat: 'ndjson', localConversationState: false } };
    const result = await runAiChat(request, { provider, io: { stdout: line => lines.push(line), initializePrivateStreamFile: () => { throw new Error('no'); } } });
    assert.equal(JSON.parse(lines[0]).source, source); assert.equal(aiChatResultExitCode(request, result), 1);
  }
});
test('resolveInitialModel preserves ChatGPT continuation only when omitted', () => {
  const provider = { ...chatgptProvider }; assert.equal(resolveInitialModel(provider, { modelName: 'default' }, { providerId: 'p' }), 'default'); assert.equal(resolveInitialModel(provider, { modelName: 'high', modelExplicit: true }, { providerId: 'p' }), 'high'); assert.equal(resolveInitialModel(provider, { modelName: 'default' }), 'extra-high');
});
test('ChatGPT listing invokes only listing transport and prints one JSON object', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-chat-listing-'));
  try {
    const lines = []; let listed = 0; let started = 0; let connected = 0;
    const browser = { disconnect() {} };
    const provider = {
      name: 'chatgpt', capabilities: { supportsConversationListing: true },
      async listConversations({ request }) {
        listed += 1; assert.equal(request.conversationLimit, 7);
        return { provider: 'chatgpt', count: 1, conversations: [{ provider_conversation_id: 'provider_1' }] };
      },
    };
    const result = await runAiChat(buildAiChatRequest({ providerName: 'chatgpt', listConversations: true, conversationLimit: 7, browserStateFile: join(dir, 'browser.json') }), {
      provider,
      startChrome: async () => { started += 1; return { ownerToken: 'owner', port: 4771, profileName: 'Default' }; },
      connectBrowser: async () => { connected += 1; return browser; },
      cache: { read: () => assert.fail('listing must not read cache'), write: () => assert.fail('listing must not write cache') },
      fs: new Proxy({}, { get: () => () => assert.fail('listing must not use conversation storage') }),
      io: { stdout: line => lines.push(line), writeFile: () => assert.fail('no output file requested') },
    });
    assert.deepEqual({ listed, started, connected }, { listed: 1, started: 1, connected: 1 });
    assert.equal(result.source, 'provider-list');
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).conversations[0].provider_conversation_id, 'provider_1');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('ChatGPT structured JSON exposes full turn fields', () => {
  const output = JSON.parse(buildOutput({ request: { jsonOutput: true }, metadata: { provider: 'chatgpt', provider_state: { thinking_effort: 'high', structured_turn: { messages: [{ id: 'u' }], user_message_id: 'u', assistant_message_id: 'a', turn_exchange_id: 't', citations: [{ url: 'x' }], content_references: [], search_result_groups: [], story_events: [], started_at: 1, completed_at: 2 } }, response: 'x' }, text: 'x' }).text);
  assert.equal(output.turn.user_message_id, 'u'); assert.equal(output.thinking_effort, 'high');
  assert.deepEqual(Object.keys(output.turn).sort(), ['assistant_message_id', 'citations', 'completed_at', 'content_references', 'messages', 'search_result_groups', 'started_at', 'story_events', 'turn_exchange_id', 'user_message_id'].sort());
});

test('ChatGPT stream append failures produce one contiguous error terminal through runAiChat', async () => {
  for (const progressBeforeFailure of [false, true]) {
    const lines = []; let appends = 0;
    const provider = {
      name: 'chatgpt', defaultModel: 'extra-high', capabilities: { streamFormat: 'ndjson', localConversationState: false, cachePolicy: 'none' }, runRequiresBrowser: () => false,
      async run({ onStreamEvent }) {
        if (progressBeforeFailure) onStreamEvent({ event: 'status', status: 'submitted', source: 'live-cdp' });
        return { text: 'answer', done: true, providerConversationId: 'provider_1', providerState: { conversation_id: 'provider_1', structured_turn: { messages: [] } } };
      },
    };
    const failOn = progressBeforeFailure ? 2 : 1;
    await assert.rejects(() => runAiChat(buildAiChatRequest({ providerName: 'chatgpt', prompt: 'x', stream: true, outFile: 'explicit.ndjson' }), {
      provider, cache: noCache(), io: {
        stdout: line => lines.push(line), initializePrivateStreamFile: () => {},
        appendPrivateStreamFile: () => { appends += 1; if (appends === failOn) throw new Error('disk failure'); },
      },
    }), /private NDJSON transcript/);
    const events = lines.map(JSON.parse);
    assert.deepEqual(events.map(event => event.sequence), events.map((_, index) => index + 1));
    assert.equal(events.at(-1).event, 'error');
    assert.equal(events.filter(event => ['complete', 'timeout', 'error'].includes(event.event)).length, 1);
    assert.equal(events.some(event => event.event === 'complete'), false);
  }
});

test('default ChatGPT stream file IO creates private output without sidecars', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-chat-stream-file-'));
  try {
    const output = join(dir, 'private', 'events.ndjson');
    defaultIo.initializePrivateStreamFile(output);
    defaultIo.appendPrivateStreamFile(output, '{"event":"complete"}\n');
    assert.equal(statSync(dirname(output)).mode & 0o777, 0o700);
    assert.equal(statSync(output).mode & 0o777, 0o600);
    assert.equal(readFileSync(output, 'utf8'), '{"event":"complete"}\n');
    assert.equal(existsSync(`${output}.meta.json`), false);
    assert.equal(existsSync(`${output}.raw.txt`), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('private stream and generic output secure overwrite targets and reject shared parents', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-chat-output-permissions-'));
  try {
    chmodSync(dir, 0o700);
    const stream = join(dir, 'events.ndjson');
    writeFileSync(stream, 'old'); chmodSync(stream, 0o644);
    defaultIo.initializePrivateStreamFile(stream);
    assert.equal(fileMode(stream), 0o600);
    const generic = join(dir, 'answer.json');
    writeFileSync(generic, 'old'); chmodSync(generic, 0o644);
    defaultIo.writeFile(generic, 'new');
    assert.equal(fileMode(generic), 0o600);
    const shared = join(dir, 'shared'); mkdirSync(shared); chmodSync(shared, 0o755);
    assert.throws(() => defaultIo.writeFile(join(shared, 'answer.json'), 'private'), /existing directory must already have mode 0700/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('private output, sidecar, NDJSON, and evidence reject file and directory symlinks without touching targets', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-chat-output-symlink-'));
  try {
    chmodSync(root, 0o700);
    const target = join(root, 'target.txt'); writeFileSync(target, 'unchanged'); chmodSync(target, 0o644);
    const linkedOutput = join(root, 'answer.json'); symlinkSync(target, linkedOutput);
    assert.throws(() => defaultIo.writeFile(linkedOutput, 'private'), /symlink/);
    assert.equal(readFileSync(target, 'utf8'), 'unchanged'); assert.equal(fileMode(target), 0o644);

    const base = join(root, 'result');
    const sidecarTarget = join(root, 'sidecar-target.txt'); writeFileSync(sidecarTarget, 'unchanged'); chmodSync(sidecarTarget, 0o644);
    const rawSidecarTarget = join(root, 'raw-sidecar-target.txt'); writeFileSync(rawSidecarTarget, 'unchanged'); chmodSync(rawSidecarTarget, 0o644);
    symlinkSync(sidecarTarget, `${base}.meta.json`); symlinkSync(rawSidecarTarget, `${base}.raw.txt`);
    saveSidecarArtifacts(base, { private: 'metadata' }, 'private raw');
    assert.equal(readFileSync(sidecarTarget, 'utf8'), 'unchanged'); assert.equal(fileMode(sidecarTarget), 0o644);
    assert.equal(readFileSync(rawSidecarTarget, 'utf8'), 'unchanged'); assert.equal(fileMode(rawSidecarTarget), 0o644);

    const streamTarget = join(root, 'stream-target.txt'); writeFileSync(streamTarget, 'unchanged'); chmodSync(streamTarget, 0o644);
    const stream = join(root, 'events.ndjson'); symlinkSync(streamTarget, stream);
    assert.throws(() => defaultIo.initializePrivateStreamFile(stream), /symlink/);
    assert.equal(readFileSync(streamTarget, 'utf8'), 'unchanged'); assert.equal(fileMode(streamTarget), 0o644);

    const evidenceTarget = join(root, 'evidence-target.txt'); writeFileSync(evidenceTarget, 'unchanged'); chmodSync(evidenceTarget, 0o644);
    const evidence = join(root, 'evidence.png'); symlinkSync(evidenceTarget, evidence);
    await assert.rejects(() => captureEvidenceScreenshot({ browser: { pages: async () => [] }, provider: { name: 'provider' }, result: { finalUrl: 'https://provider.example/chat' }, request: { captureEvidence: true, evidencePath: evidence } }), /symlink/);
    assert.equal(readFileSync(evidenceTarget, 'utf8'), 'unchanged'); assert.equal(fileMode(evidenceTarget), 0o644);

    const realDir = join(root, 'real-dir'); mkdirSync(realDir); chmodSync(realDir, 0o700);
    const linkedDir = join(root, 'linked-dir'); symlinkSync(realDir, linkedDir);
    assert.throws(() => defaultIo.writeFile(join(linkedDir, 'answer.json'), 'private'), /real directory/);
    saveSidecarArtifacts(join(linkedDir, 'result'), { private: 'metadata' }, 'private raw');
    assert.throws(() => defaultIo.initializePrivateStreamFile(join(linkedDir, 'events.ndjson')), /real directory/);
    await assert.rejects(() => captureEvidenceScreenshot({ browser: { pages: async () => [] }, provider: { name: 'provider' }, result: { finalUrl: 'https://provider.example/chat' }, request: { captureEvidence: true, evidencePath: join(linkedDir, 'evidence.png') } }), /real directory/);
    assert.equal(readdirSync(realDir).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ChatGPT list-models conflicts reject before browser, cache, or conversation storage', async () => {
  const provider = { name: 'chatgpt', capabilities: { streamFormat: 'ndjson', localConversationState: false, supportsConversationListing: true }, listModels: () => assert.fail('list models must not run') };
  for (const conflict of [{ inlinePrompt: 'x' }, { conversationTarget: 'provider_1' }, { submitOnly: true }, { final: true }, { stream: true }, { listConversations: true }, { saveConversation: 'local' }, { attachConversation: 'provider_1' }]) {
    const lines = [];
    const request = buildAiChatRequest({ providerName: 'chatgpt', listModels: true, ...conflict });
    await assert.rejects(() => runAiChat(request, {
      provider, startChrome: () => assert.fail('browser must not start'), connectBrowser: () => assert.fail('browser must not connect'),
      cache: { read: () => assert.fail('cache read'), write: () => assert.fail('cache write') },
      fs: new Proxy({}, { get: () => () => assert.fail('conversation storage used') }), io: { stdout: line => lines.push(line) },
    }), conflict.listConversations ? /list-conversations conflicts/ : /list-models conflicts/);
    if (conflict.stream) assert.deepEqual(lines.map(line => JSON.parse(line).event), ['error']);
    else assert.deepEqual(lines, []);
  }
  const result = await runAiChat(buildAiChatRequest({ providerName: 'chatgpt', listModels: true, verifyModels: true, verifyModelTimeoutSeconds: 7, jsonOutput: true }), { provider: { ...provider, listModels: () => [] }, io: { stdout: () => {} } });
  assert.equal(result.source, 'models');
});

test('ChatGPT listing conflicts reject before browser, cache, or conversation storage', async () => {
  const provider = { name: 'chatgpt', capabilities: { supportsConversationListing: true, streamFormat: 'ndjson', localConversationState: false } };
  const conflicts = [
    { inlinePrompt: 'x' }, { conversationTarget: 'provider_1' }, { submitOnly: true }, { final: true },
    { stream: true }, { listModels: true }, { saveConversation: 'local' }, { attachConversation: 'provider_1' },
  ];
  for (const conflict of conflicts) {
    const lines = [];
    await assert.rejects(() => runAiChat(buildAiChatRequest({ providerName: 'chatgpt', listConversations: true, ...conflict }), {
      provider,
      startChrome: () => assert.fail('browser must not start'), connectBrowser: () => assert.fail('browser must not connect'),
      cache: { read: () => assert.fail('cache read'), write: () => assert.fail('cache write') },
      fs: new Proxy({}, { get: () => () => assert.fail('conversation storage used') }),
      io: { stdout: line => lines.push(line) },
    }), /list-conversations conflicts/);
    if (conflict.stream) assert.deepEqual(lines.map(line => JSON.parse(line).event), ['error']);
  }
});

test('runPromptAttempt passes minimal preflight context and skips ChatGPT pre-submit text reads', async () => {
  const order = []; const page = { url: () => 'https://chatgpt.com/c/provider_1', evaluate: () => assert.fail('body text must not be read') };
  const browser = { pages: async () => [page] };
  const provider = {
    name: 'chatgpt', capabilities: { requiresPreSubmitTextRead: false },
    findPage: async () => page,
    preflight: async () => { order.push('preflight'); return { expectedConversationId: 'provider_1', baselineCurrentNode: 'node_1' }; },
    createAttemptContext: async ({ preflightContext }) => { order.push('observer'); assert.deepEqual(preflightContext, { expectedConversationId: 'provider_1', baselineCurrentNode: 'node_1' }); return { marker: true }; },
    clearInput: async () => order.push('clear'), typePrompt: async () => order.push('type'), submit: async () => order.push('submit'),
    waitForResponse: async ({ attemptContext }) => { order.push('wait'); assert.equal(attemptContext.marker, true); return { text: 'answer', done: true, providerConversationId: 'provider_1' }; },
    disposeAttemptContext: async () => order.push('dispose'),
  };
  const result = await runPromptAttempt({ browser, provider, request: buildAiChatRequest({ providerName: 'chatgpt', prompt: 'follow-up' }), selectedModel: 'default', conversation: { providerId: 'provider_1' } });
  assert.equal(result.providerConversationId, 'provider_1');
  assert.deepEqual(order, ['preflight', 'observer', 'clear', 'type', 'submit', 'wait', 'dispose']);
});

test('parseAiChatArgs rejects retired Gemini credential-source options', () => {
  assert.throws(() => parseAiChatArgs(['--provider', 'gemini', '--cookie-source', 'chrome-profile']), /no longer supported/);
  assert.throws(() => parseAiChatArgs(['--provider', 'gemini', '--chrome-profile', 'Personal']), /no longer supported/);
});
