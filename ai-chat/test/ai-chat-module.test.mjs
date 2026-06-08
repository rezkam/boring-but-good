import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
} from '../scripts/ai-chat/module.mjs';

test('parseAiChatArgs supports provider options and conversation flags', () => {
  const request = buildAiChatRequest(parseAiChatArgs([
    '--provider', 'perplexity',
    '--prompt', 'hello',
    '--model', 'perplexity/deep-research',
    '--task', 'deep_research',
    '--conversation', 'thread-a',
    '--save-conversation', 'thread-a',
    '--source-focus', 'academic,web',
    '--search-focus', 'web',
    '--time-range', 'week',
    '--citation-mode', 'markdown',
    '--save-to-library',
    '--chrome-profile', 'Work Profile',
    '--cookie-source', 'chrome-profile',
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
  assert.equal(request.providerOptions.sourceFocus, 'academic,web');
  assert.equal(request.providerOptions.saveToLibrary, true);
  assert.equal(request.providerOptions.chromeProfile, 'Work Profile');
  assert.equal(request.providerOptions.cookieSource, 'chrome-profile');
  assert.equal(request.includeConversation, true);
  assert.equal(request.captureEvidence, true);
  assert.equal(request.evidencePath, '/tmp/ai-chat-evidence.png');
  assert.equal(request.evidenceFullPage, true);
  assert.equal(request.verifyModels, true);
  assert.equal(request.verifyModelTimeoutSeconds, 12);
  assert.equal(request.jsonOutput, true);
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
    continue_chat: false,
    conversation_target: 'thread-a',
    json_output: false,
    include_conversation: false,
    provider_options: { sourceFocus: 'academic' },
    prompt: 'question',
  });
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
