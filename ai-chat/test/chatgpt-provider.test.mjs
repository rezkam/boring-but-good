import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  CHATGPT_MODEL_LEVELS,
  applyChatGptModelToPayload,
  chatgptProvider,
  createChatGptNetworkTracker,
  extractChatGptStreamStateFromEncodedItem,
  extractChatGptWebSocketPayload,
  parseChatGptSseEvents,
  resolveChatGptModel,
} from '../scripts/ai-chat/providers/chatgpt.mjs';

class FakeCdpSession extends EventEmitter {
  constructor() {
    super();
    this.calls = [];
  }

  async send(method, params = {}) {
    this.calls.push({ method, params });
    return {};
  }

  async emitPaused(event) {
    await Promise.all(this.listeners('Fetch.requestPaused').map(listener => listener(event)));
  }

  async detach() {
    this.calls.push({ method: 'detach', params: {} });
  }
}

function fakePageForCdp(client) {
  return {
    target: () => ({
      createCDPSession: async () => client,
    }),
  };
}

test('resolves ChatGPT request profiles and aliases', () => {
  assert.equal(resolveChatGptModel('default').id, 'extra-high');
  assert.equal(resolveChatGptModel('thinking').id, 'extra-high');
  assert.equal(resolveChatGptModel('reasoning').id, 'extra-high');
  assert.equal(resolveChatGptModel('Extra High').thinking_effort, 'max');
  assert.equal(resolveChatGptModel('max').id, 'extra-high');
  assert.equal(resolveChatGptModel('gpt-5-5').model, 'gpt-5-5');
  assert.equal(resolveChatGptModel('unknown-model'), null);
});

test('lists ChatGPT models without requiring the model picker UI', async () => {
  const listed = await chatgptProvider.listModels({ request: {} });
  assert.equal(listed.model_source, 'chatgpt-webui-request-profiles');
  assert.equal(listed.models.some(model => model.id === 'extra-high' && model.thinking_effort === 'max'), true);
  assert.equal(listed.models.every(model => model.transport === 'network-request-payload'), true);
});

test('ChatGPT new requests use a fresh tab instead of reusing stale conversation SPA state', async () => {
  const gotos = [];
  const existingPage = {
    url: () => 'https://chatgpt.com/c/existing-thread',
    goto: async (url) => gotos.push(['existing', url]),
  };
  const newPage = {
    url: () => gotos.at(-1)?.[1] || 'about:blank',
    goto: async (url) => gotos.push(['new', url]),
  };
  const browser = { pages: async () => [existingPage], newPage: async () => newPage };

  const selected = await chatgptProvider.findPage({ browser, continueChat: false, request: {} });

  assert.equal(selected, newPage);
  assert.deepEqual(gotos, [['new', 'https://chatgpt.com']]);
});

test('rewrites ChatGPT conversation payload model and thinking effort', () => {
  const payload = { model: 'gpt-5-5-thinking', thinking_effort: 'standard', action: 'next' };
  const { changed } = applyChatGptModelToPayload(payload, resolveChatGptModel('extra-high'));
  assert.equal(changed, true);
  assert.equal(payload.model, 'gpt-5-5-thinking');
  assert.equal(payload.thinking_effort, 'max');

  const instantPayload = { model: 'gpt-5-5-thinking', thinking_effort: 'medium' };
  applyChatGptModelToPayload(instantPayload, resolveChatGptModel('instant'));
  assert.deepEqual(instantPayload, { model: 'gpt-5-5' });
});

test('every ChatGPT request profile can be applied to a backend payload', () => {
  for (const model of CHATGPT_MODEL_LEVELS) {
    const payload = { model: 'placeholder', thinking_effort: 'standard' };
    applyChatGptModelToPayload(payload, model);
    assert.equal(payload.model, model.model, model.id);
    if (model.thinking_effort) assert.equal(payload.thinking_effort, model.thinking_effort, model.id);
    else assert.equal(Object.hasOwn(payload, 'thinking_effort'), false, model.id);
  }
});

test('fails paused ChatGPT requests when postData is malformed', async () => {
  const client = new FakeCdpSession();
  const tracker = await createChatGptNetworkTracker({ page: fakePageForCdp(client), selectedModel: 'extra-high' });
  try {
    await client.emitPaused({
      requestId: 'request-malformed',
      request: {
        method: 'POST',
        url: 'https://chatgpt.com/backend-api/f/conversation',
        postData: '{"model":',
      },
    });

    assert.match(tracker.snapshot().error, /^\[chatgpt\] Failed to rewrite request payload:/);
    assert.deepEqual(
      client.calls.filter(call => call.method === 'Fetch.failRequest'),
      [{ method: 'Fetch.failRequest', params: { requestId: 'request-malformed', errorReason: 'Aborted' } }],
    );
    assert.equal(client.calls.some(call => call.method === 'Fetch.continueRequest'), false);
  } finally {
    await tracker.dispose();
  }
});

test('does not rewrite ChatGPT prepare requests', async () => {
  const client = new FakeCdpSession();
  const tracker = await createChatGptNetworkTracker({ page: fakePageForCdp(client), selectedModel: 'instant' });
  try {
    await client.emitPaused({
      requestId: 'request-prepare',
      request: {
        method: 'POST',
        url: 'https://chatgpt.com/backend-api/f/conversation/prepare',
        postData: JSON.stringify({ model: 'gpt-5-5-thinking', thinking_effort: 'max' }),
      },
    });

    assert.equal(tracker.snapshot().interceptedRequests, 0);
    assert.deepEqual(
      client.calls.filter(call => call.method === 'Fetch.continueRequest'),
      [{ method: 'Fetch.continueRequest', params: { requestId: 'request-prepare' } }],
    );
  } finally {
    await tracker.dispose();
  }
});

test('fails paused ChatGPT requests when payload cannot be rewritten', async () => {
  const client = new FakeCdpSession();
  const tracker = await createChatGptNetworkTracker({ page: fakePageForCdp(client), selectedModel: 'extra-high' });
  try {
    await client.emitPaused({
      requestId: 'request-rewrite-failure',
      request: {
        method: 'POST',
        url: 'https://chatgpt.com/backend-api/f/conversation',
        postData: 'null',
      },
    });

    assert.match(tracker.snapshot().error, /^\[chatgpt\] Failed to rewrite request payload:/);
    assert.deepEqual(
      client.calls.filter(call => call.method === 'Fetch.failRequest'),
      [{ method: 'Fetch.failRequest', params: { requestId: 'request-rewrite-failure', errorReason: 'Aborted' } }],
    );
    assert.equal(client.calls.some(call => call.method === 'Fetch.continueRequest'), false);
  } finally {
    await tracker.dispose();
  }
});

test('parses ChatGPT SSE events and stream handoff metadata', () => {
  const encoded = [
    'event: message',
    'data: {"type":"stream_handoff","conversation_id":"conv-1","turn_exchange_id":"turn-1","options":[{"type":"subscribe_ws_topic","topic_id":"topic-1"}]}',
    '',
    'data: {"type":"resume_conversation_token","conversation_id":"conv-1","token":"resume-1"}',
    '',
  ].join('\n');

  assert.deepEqual(parseChatGptSseEvents(encoded).map(event => event.event), ['message', 'message']);
  const state = extractChatGptStreamStateFromEncodedItem(encoded);
  assert.equal(state.conversationId, 'conv-1');
  assert.equal(state.turnExchangeId, 'turn-1');
  assert.equal(state.topicId, 'topic-1');
  assert.equal(state.resumeToken, 'resume-1');
  assert.equal(state.handedOff, true);
  assert.equal(state.awaitingResume, true);
});

test('does not mark the turn done on [DONE] after a stream handoff', () => {
  // Regression: reasoning models stream a short preamble in the final channel,
  // then hand the turn off to a resumed stream that ends with [DONE]. Treating
  // that [DONE] as turn-completion returned only the preamble and dropped the
  // real answer. After a handoff, [DONE] must NOT complete the turn.
  const initialStream = [
    'data: {"v":{"message":{"id":"msg-1","author":{"role":"assistant"},"channel":"final","content":{"parts":["I will answer this."]},"metadata":{"model_slug":"gpt-5-5-thinking"}}}}',
    '',
    'data: {"type":"stream_handoff","conversation_id":"conv-1","options":[{"type":"subscribe_ws_topic","topic_id":"topic-1"}]}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');

  const afterPreamble = extractChatGptStreamStateFromEncodedItem(initialStream);
  assert.equal(afterPreamble.text, 'I will answer this.');
  assert.equal(afterPreamble.handedOff, true);
  assert.equal(afterPreamble.streamClosed, true);
  assert.equal(afterPreamble.assistantTurnComplete, false);
  assert.equal(afterPreamble.done, false, '[DONE] after a handoff must not complete the turn');

  // The real answer arrives on the resumed stream and ends with end_turn=true.
  const resumed = [
    'data: {"p":"/message/content/parts/0","o":"append","v":" Here is the full answer."}',
    '',
    'data: {"p":"","o":"patch","v":[{"p":"/message/end_turn","o":"replace","v":true}]}',
    '',
  ].join('\n');
  const finalState = extractChatGptStreamStateFromEncodedItem(resumed, afterPreamble);
  assert.equal(finalState.text, 'I will answer this. Here is the full answer.');
  assert.equal(finalState.assistantTurnComplete, true);
  assert.equal(finalState.done, true, 'end_turn=true must complete the turn');
});

test('marks the turn done on [DONE] when no handoff occurred', () => {
  const stream = [
    'data: {"p":"/message/content/parts/0","o":"append","v":"Short answer."}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');
  const state = extractChatGptStreamStateFromEncodedItem(stream);
  assert.equal(state.text, 'Short answer.');
  assert.equal(state.done, true);
});

test('extracts assistant text from ChatGPT WebSocket catchups', () => {
  const encodedItem = [
    'data: {"p":"/message/content/parts/0","o":"append","v":"CHATGPT_"}',
    '',
    'data: {"p":"/message/content/parts/0","o":"append","v":"OK"}',
    '',
    'data: {"type":"message_stream_complete"}',
    '',
  ].join('\n');
  const payload = JSON.stringify([
    {
      reply: {
        catchups: [
          { payload: { payload: { encoded_item: encodedItem } } },
        ],
      },
    },
  ]);

  const state = extractChatGptWebSocketPayload(payload);
  assert.equal(state.text, 'CHATGPT_OK');
  assert.equal(state.done, true);
  assert.equal(state.resumedStream, true);
  assert.equal(state.resumeTransport, 'websocket');
  assert.equal(state.websocketCatchup, true);
});

test('does not duplicate full assistant final messages after streamed deltas', () => {
  const encodedItem = [
    'data: {"p":"/message/content/parts/0","o":"append","v":"Hello"}',
    '',
    'data: {"v":{"message":{"id":"msg-1","author":{"role":"assistant"},"channel":"final","content":{"parts":["Hello world"]},"metadata":{"model_slug":"gpt-5-5-thinking","thinking_effort":"max","request_id":"req-1"}}}}',
    '',
  ].join('\n');

  const state = extractChatGptStreamStateFromEncodedItem(encodedItem);
  assert.equal(state.text, 'Hello world');
  assert.equal(state.messageId, 'msg-1');
  assert.equal(state.modelSlug, 'gpt-5-5-thinking');
  assert.equal(state.thinkingEffort, 'max');
});

test('parses compact ChatGPT continuation deltas after an append path', () => {
  const encodedItem = [
    'data: {"p":"/message/content/parts/0","o":"append","v":"AI"}',
    '',
    'data: {"v":"_CHAT"}',
    '',
    'data: {"v":"_TOKEN"}',
    '',
    'data: {"p":"","o":"patch","v":[{"p":"/message/status","o":"replace","v":"finished_successfully"},{"p":"/message/end_turn","o":"replace","v":true}]}',
    '',
  ].join('\n');

  const state = extractChatGptStreamStateFromEncodedItem(encodedItem);
  assert.equal(state.text, 'AI_CHAT_TOKEN');
  assert.equal(state.done, true);
  assert.equal(state.assistantTurnComplete, true);
});

test('returns empty network timeout metadata without using DOM fallback', async () => {
  let domRead = false;
  const result = await chatgptProvider.waitForResponse({
    page: {
      url: () => 'https://chatgpt.com/',
      evaluate: async () => {
        domRead = true;
        return { text: 'dom text', done: true };
      },
    },
    timeoutMs: 0,
    selectedModel: 'extra-high',
    networkTracker: {
      snapshot: () => ({
        text: '',
        rawItems: [],
        done: false,
        transport: 'network-observed-request',
        requestedModelProfile: 'extra-high',
        responseStatuses: [{ url: 'https://chatgpt.com/backend-api/f/conversation', status: 200, mimeType: 'text/event-stream' }],
        networkResponseEmpty: true,
      }),
    },
  });

  assert.equal(domRead, false);
  assert.equal(result.text, '');
  assert.equal(result.done, false);
  assert.equal(result.providerState.empty_response, true);
  assert.equal(result.providerState.timeout, true);
  assert.equal(result.providerState.stream_state.status, 'timeout_empty');
  assert.equal(result.providerState.stream_state.dom_fallback, false);
});

test('returns terminal empty ChatGPT streams without waiting for full timeout', async () => {
  const started = Date.now();
  const result = await chatgptProvider.waitForResponse({
    page: { url: () => 'https://chatgpt.com/c/empty-terminal' },
    timeoutMs: 60_000,
    selectedModel: 'instant',
    networkTracker: {
      snapshot: () => ({
        text: '',
        rawItems: ['[DONE]'],
        done: true,
        streamClosed: true,
        messageStreamComplete: true,
        conversationId: 'empty-terminal',
        responseStatuses: [{ url: 'https://chatgpt.com/backend-api/f/conversation', status: 200, mimeType: 'text/event-stream' }],
      }),
    },
  });

  assert.ok(Date.now() - started < 2000);
  assert.equal(result.done, false);
  assert.equal(result.text, '');
  assert.equal(result.providerState.empty_response, true);
  assert.equal(result.providerState.reason, 'terminal-empty-stream');
});

test('recovers current ChatGPT DOM answer when terminal stream is empty', async () => {
  const result = await chatgptProvider.waitForResponse({
    page: {
      url: () => 'https://chatgpt.com/c/dom-terminal-empty',
      evaluate: async () => ({ text: 'AI_CHAT_DOM_RECOVERY_OK', done: true, assistantMessageCount: 1 }),
    },
    timeoutMs: 60_000,
    selectedModel: 'instant',
    attemptContext: { preSubmitAssistantMessageCount: 0 },
    networkTracker: {
      snapshot: () => ({
        text: '',
        rawItems: ['[DONE]'],
        done: true,
        streamClosed: true,
        messageStreamComplete: true,
        conversationId: 'dom-terminal-empty',
        responseStatuses: [{ url: 'https://chatgpt.com/backend-api/f/conversation', status: 200, mimeType: 'text/event-stream' }],
      }),
    },
  });

  assert.equal(result.done, true);
  assert.equal(result.text, 'AI_CHAT_DOM_RECOVERY_OK');
  assert.equal(result.providerState.dom_fallback, true);
  assert.equal(result.providerState.reason, 'terminal-empty-stream-dom-recovery');
});

test('retries ChatGPT once when terminal stream and DOM are both empty', async () => {
  const original = {
    clearInput: chatgptProvider.clearInput,
    typePrompt: chatgptProvider.typePrompt,
    beforeSubmit: chatgptProvider.beforeSubmit,
    submit: chatgptProvider.submit,
  };
  const calls = [];
  let reset = false;
  chatgptProvider.clearInput = async () => calls.push('clear');
  chatgptProvider.typePrompt = async () => calls.push('type');
  chatgptProvider.beforeSubmit = async () => calls.push('before');
  chatgptProvider.submit = async () => calls.push('submit');
  try {
    const result = await chatgptProvider.waitForResponse({
      page: {
        url: () => reset ? 'https://chatgpt.com/c/retried' : 'https://chatgpt.com/c/empty',
        goto: async (url) => calls.push(`goto:${url}`),
      },
      timeoutMs: 10_000,
      selectedModel: 'instant',
      prompt: 'Reply exactly AI_CHAT_RETRY_OK.',
      request: {},
      networkTracker: {
        reset: () => { reset = true; calls.push('reset'); },
        snapshot: () => reset
          ? {
              text: 'AI_CHAT_RETRY_OK',
              rawItems: ['AI_CHAT_RETRY_OK'],
              done: true,
              streamClosed: true,
              assistantTurnComplete: true,
              conversationId: 'retried',
              responseStatuses: [{ url: 'https://chatgpt.com/backend-api/f/conversation', status: 200, mimeType: 'text/event-stream' }],
            }
          : {
              text: '',
              rawItems: ['[DONE]'],
              done: true,
              streamClosed: true,
              messageStreamComplete: true,
              conversationId: 'empty',
              responseStatuses: [{ url: 'https://chatgpt.com/backend-api/f/conversation', status: 200, mimeType: 'text/event-stream' }],
            },
      },
    });

    assert.equal(result.done, true);
    assert.equal(result.text, 'AI_CHAT_RETRY_OK');
    assert.deepEqual(calls, ['reset', 'goto:https://chatgpt.com', 'clear', 'type', 'before', 'submit']);
  } finally {
    Object.assign(chatgptProvider, original);
  }
});

test('returns timeout metadata for a resumable ChatGPT partial state', async () => {
  const result = await chatgptProvider.waitForResponse({
    page: { url: () => 'https://chatgpt.com/' },
    timeoutMs: 0,
    selectedModel: 'extra-high',
    networkTracker: {
      snapshot: () => ({
        text: 'I will answer this.',
        rawItems: ['preamble'],
        done: false,
        handedOff: true,
        awaitingResume: true,
        streamClosed: true,
        transport: 'network-observed-request',
        requestedModelProfile: 'extra-high',
        modelSlug: 'gpt-5-5-thinking',
        conversationId: 'conv-timeout',
        topicId: 'topic-timeout',
        responseStatuses: [{ url: 'https://chatgpt.com/backend-api/f/conversation', status: 200, mimeType: 'text/event-stream' }],
      }),
    },
  });

  assert.equal(result.text, 'I will answer this.');
  assert.equal(result.done, false);
  assert.equal(result.finalUrl, 'https://chatgpt.com/c/conv-timeout');
  assert.equal(result.providerState.partial, true);
  assert.equal(result.providerState.timeout, true);
  assert.equal(result.providerState.stream_state.status, 'timeout_partial');
  assert.equal(result.providerState.stream_state.handed_off, true);
  assert.equal(result.providerState.stream_state.awaiting_resume, true);
  assert.equal(result.providerState.stream_state.resumable, true);
});

test('does not use stale ChatGPT DOM fallback when assistant count did not advance', async () => {
  const result = await chatgptProvider.waitForResponse({
    page: {
      url: () => 'https://chatgpt.com/c/conv-dom',
      evaluate: async () => ({ text: 'old answer from dom', done: true, assistantMessageCount: 1 }),
    },
    timeoutMs: 0,
    selectedModel: 'extra-high',
    attemptContext: { preSubmitAssistantMessageCount: 1 },
    networkTracker: {
      snapshot: () => ({
        text: '',
        rawItems: [],
        done: false,
        transport: 'network-observed-request',
        requestedModelProfile: 'extra-high',
        responseStatuses: [],
      }),
    },
  });

  assert.equal(result.text, '');
  assert.equal(result.done, false);
  assert.equal(result.providerState.transport, 'network-observed-request');
  assert.equal(result.providerState.dom_fallback, false);
  assert.equal(result.providerState.empty_response, true);
  assert.equal(result.providerState.timeout, true);
  assert.equal(result.providerState.stream_state.status, 'timeout_empty');
});

test('marks current ChatGPT DOM fallback when assistant count advances', async () => {
  const result = await chatgptProvider.waitForResponse({
    page: {
      url: () => 'https://chatgpt.com/c/conv-dom',
      evaluate: async () => ({ text: 'answer from dom', done: true, assistantMessageCount: 2 }),
    },
    timeoutMs: 0,
    selectedModel: 'extra-high',
    attemptContext: { preSubmitAssistantMessageCount: 1 },
    networkTracker: {
      snapshot: () => ({
        text: '',
        rawItems: [],
        done: false,
        transport: 'network-observed-request',
        requestedModelProfile: 'extra-high',
        responseStatuses: [],
      }),
    },
  });

  assert.equal(result.text, 'answer from dom');
  assert.equal(result.providerState.transport, 'dom-fallback');
  assert.equal(result.providerState.dom_fallback, true);
  assert.equal(result.providerState.stream_state.status, 'dom_fallback');
});

test('rechecks a saved ChatGPT timeout by reopening the same conversation', async () => {
  const navigations = [];
  const page = {
    _url: 'about:blank',
    url() { return this._url; },
    async goto(url) {
      navigations.push(url);
      this._url = url;
    },
  };
  let disposed = false;

  const result = await chatgptProvider.recheckConversation({
    browser: {
      pages: async () => [page],
      newPage: async () => page,
    },
    request: { timeoutSeconds: 0 },
    selectedModel: 'extra-high',
    conversation: {
      id: 'local-chatgpt-timeout',
      url: null,
      record: {
        provider_state: {
          conversation_id: 'conv-timeout',
          partial: true,
          timeout: true,
        },
      },
    },
    networkTrackerFactory: async () => ({
      snapshot: () => ({
        text: 'completed after resume',
        rawItems: ['completed after resume'],
        done: true,
        assistantTurnComplete: true,
        resumedStream: true,
        resumeTransport: 'websocket',
        transport: 'network-observed-request',
        requestedModelProfile: 'extra-high',
        modelSlug: 'gpt-5-5-thinking',
        conversationId: 'conv-timeout',
        responseStatuses: [{ url: 'https://chatgpt.com/backend-api/f/conversation', status: 200, mimeType: 'text/event-stream' }],
      }),
      dispose: async () => { disposed = true; },
    }),
  });

  assert.deepEqual(navigations, ['https://chatgpt.com/c/conv-timeout']);
  assert.equal(result.text, 'completed after resume');
  assert.equal(result.done, true);
  assert.equal(result.providerState.recheck, true);
  assert.equal(result.providerState.stream_state.status, 'completed');
  assert.equal(result.providerState.stream_state.resumed_stream, true);
  assert.equal(disposed, true);
});
