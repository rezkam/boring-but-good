import { Buffer } from 'node:buffer';
import { sleep, urlHasAllowedHostname } from './shared.mjs';

const CHATGPT_ORIGIN = 'https://chatgpt.com';
const CHATGPT_HOSTNAMES = ['chatgpt.com', 'www.chatgpt.com'];
const CHATGPT_CONVERSATION_ENDPOINT_RE = /\/backend-api\/f\/conversation(?:$|[/?#])/;

function isChatGptUrl(url) {
  return urlHasAllowedHostname(url, CHATGPT_HOSTNAMES);
}

function isChatGptConversationUrl(url) {
  if (!isChatGptUrl(url)) return false;
  try {
    return new URL(url).pathname.startsWith('/c/');
  } catch {
    return false;
  }
}

function isChatGptConversationEndpointUrl(url) {
  if (!isChatGptUrl(url)) return false;
  try {
    const parsed = new URL(url);
    return CHATGPT_CONVERSATION_ENDPOINT_RE.test(`${parsed.pathname}${parsed.search}${parsed.hash}`);
  } catch {
    return false;
  }
}

function isChatGptConversationSubmitEndpointUrl(url) {
  if (!isChatGptUrl(url)) return false;
  try {
    const parsed = new URL(url);
    return parsed.pathname === '/backend-api/f/conversation';
  } catch {
    return false;
  }
}

function isChatGptConversationStreamEndpointUrl(url) {
  if (!isChatGptUrl(url)) return false;
  try {
    const parsed = new URL(url);
    return parsed.pathname === '/backend-api/f/conversation' || parsed.pathname === '/backend-api/f/conversation/resume';
  } catch {
    return false;
  }
}

function chatGptConversationUrl(conversationId) {
  const value = String(conversationId || '').trim();
  return value ? `${CHATGPT_ORIGIN}/c/${encodeURIComponent(value)}` : null;
}

function chatGptConversationIdFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/c\/([^/?#]+)/);
    return match?.[1] || null;
  } catch {
    return null;
  }
}

export function resolveChatGptConversationUrl(conversation = {}) {
  const record = conversation?.record || null;
  const providerState = record?.provider_state || conversation?.providerState || conversation?.provider_state || null;
  const providerConversationId = providerState?.conversation_id || providerState?.conversationId || record?.provider_id || conversation?.provider_id || null;
  const stateUrl = chatGptConversationUrl(providerConversationId);
  const directUrl = conversation?.url || record?.final_url || record?.conversation_url || null;
  const directConversationId = chatGptConversationIdFromUrl(directUrl);
  if (directConversationId) return directUrl;
  return stateUrl || directUrl || null;
}

export function resolveChatGptConversationAttachment({ target }) {
  const value = String(target || '').trim();
  if (!value) throw new Error('[chatgpt] Conversation attachment is empty');
  if (/^https?:\/\//i.test(value)) {
    const conversationId = chatGptConversationIdFromUrl(value);
    return {
      type: 'url',
      url: value,
      providerId: conversationId,
      providerState: conversationId ? { conversation_id: conversationId } : null,
    };
  }
  return {
    type: 'provider_id',
    url: chatGptConversationUrl(value),
    providerId: value,
    providerState: { conversation_id: value },
  };
}

export const CHATGPT_MODEL_LEVELS = [
  {
    id: 'instant',
    name: 'Instant',
    model: 'gpt-5-5',
    thinking_effort: null,
    aliases: ['fast', 'quick', 'low'],
    source: 'chatgpt-webui-request-profile',
  },
  {
    id: 'extra-high',
    name: 'Extra High',
    model: 'gpt-5-5-thinking',
    thinking_effort: 'max',
    aliases: ['default', 'thinking', 'think', 'reasoning', 'extra', 'max', 'best'],
    source: 'live-captured-chatgpt-webui-request',
  },
  {
    id: 'pro-extended',
    name: 'Pro Extended',
    model: 'gpt-5-5-thinking-pro',
    thinking_effort: 'max',
    aliases: ['pro', 'extended', 'research'],
    source: 'chatgpt-webui-request-profile-unverified',
  },
  {
    id: 'gpt-5.5',
    name: 'GPT-5.5',
    model: 'gpt-5-5-thinking',
    thinking_effort: 'max',
    aliases: ['gpt-5-5', 'gpt5.5', 'gpt55'],
    source: 'chatgpt-webui-request-profile-unverified',
  },
];

function normalizeModelName(value) {
  return String(value || 'default').trim().toLowerCase().replace(/[\s_]+/g, '-');
}

function uniqueStrings(values) {
  return [...new Set(values.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))];
}

export function resolveChatGptModel(modelName = 'default') {
  const normalized = normalizeModelName(modelName);
  if (!normalized || normalized === 'default') return CHATGPT_MODEL_LEVELS.find(model => model.id === 'extra-high');
  const direct = CHATGPT_MODEL_LEVELS.find(model => {
    const candidates = [model.id, model.name, model.model, ...(model.aliases || [])];
    return candidates.some(candidate => normalizeModelName(candidate) === normalized);
  });
  if (direct) return direct;

  if (/^gpt[-\w.]+$/i.test(String(modelName || ''))) {
    return {
      id: String(modelName),
      name: String(modelName),
      model: String(modelName),
      thinking_effort: null,
      aliases: [],
      source: 'explicit-chatgpt-model-id',
    };
  }

  return null;
}

export function chatGptModelRecord(model) {
  return {
    id: model.id,
    name: model.name,
    model: model.model,
    thinking_effort: model.thinking_effort,
    aliases: model.aliases || [],
    account_specific: true,
    source: model.source,
    selected_by: uniqueStrings(['--model', model.id, model.name, model.model, ...(model.aliases || [])]),
    transport: 'network-request-payload',
    verification: model.source?.includes('unverified')
      ? { status: 'needs-live-capture' }
      : { status: 'known-request-profile' },
  };
}

export function applyChatGptModelToPayload(payload, modelConfig) {
  if (!payload || typeof payload !== 'object') return { changed: false, payload };
  let changed = false;
  if (modelConfig?.model && payload.model !== modelConfig.model) {
    payload.model = modelConfig.model;
    changed = true;
  }
  if (modelConfig?.thinking_effort) {
    if (payload.thinking_effort !== modelConfig.thinking_effort) {
      payload.thinking_effort = modelConfig.thinking_effort;
      changed = true;
    }
  } else if (Object.prototype.hasOwnProperty.call(payload, 'thinking_effort')) {
    delete payload.thinking_effort;
    changed = true;
  }
  return { changed, payload };
}

export function parseChatGptSseEvents(text) {
  const events = [];
  let event = 'message';
  let data = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (line === '') {
      if (data.length) {
        events.push({ event, data: data.join('\n') });
        event = 'message';
        data = [];
      }
      continue;
    }
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (data.length) events.push({ event, data: data.join('\n') });
  return events;
}

export function extractChatGptStreamStateFromEncodedItem(encodedItem, state = {}) {
  const next = {
    text: '',
    rawItems: [],
    searchResults: [],
    done: false,
    streamClosed: false,
    streamClosedCount: 0,
    assistantTurnComplete: false,
    awaitingResume: false,
    resumedStream: false,
    ...state,
  };
  let lastTextAppendPath = next.lastTextAppendPath || null;
  for (const event of parseChatGptSseEvents(encodedItem)) {
    next.rawItems.push(event.data);
    if (event.data === '[DONE]') {
      // [DONE] closes the current HTTP/SSE stream. It is not the same as the
      // assistant turn finishing when a reasoning request has handed the turn to
      // a resumed stream.
      next.streamClosed = true;
      next.streamClosedCount = (next.streamClosedCount || 0) + 1;
      next.lastStreamCloseReason = 'sse_done';
      if (!next.handedOff && !next.awaitingResume) {
        next.assistantTurnComplete = true;
        next.done = true;
        next.doneReason = next.doneReason || 'stream_closed_without_handoff';
      } else {
        next.done = !!next.assistantTurnComplete;
      }
      continue;
    }

    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      continue;
    }

    if (data.conversation_id) next.conversationId = data.conversation_id;
    if (data.turn_exchange_id) next.turnExchangeId = data.turn_exchange_id;
    if (data.type === 'resume_conversation_token') {
      next.handedOff = true;
      next.awaitingResume = !next.assistantTurnComplete;
      next.resumeToken = data.token || next.resumeToken;
      next.conversationId = data.conversation_id || next.conversationId;
      if (!next.assistantTurnComplete) next.done = false;
    }
    if (data.type === 'stream_handoff') {
      next.handedOff = true;
      next.awaitingResume = !next.assistantTurnComplete;
      next.streamHandoff = true;
      next.conversationId = data.conversation_id || next.conversationId;
      next.turnExchangeId = data.turn_exchange_id || next.turnExchangeId;
      const wsOption = (data.options || []).find(option => option.type === 'subscribe_ws_topic');
      const sseOption = (data.options || []).find(option => option.type === 'resume_sse_endpoint');
      next.topicId = wsOption?.topic_id || sseOption?.topic_id || next.topicId;
      next.resumeTransport = wsOption ? 'websocket' : (sseOption ? 'sse' : next.resumeTransport);
      if (!next.assistantTurnComplete) next.done = false;
    }
    if (data.type === 'message_stream_complete') {
      next.messageStreamComplete = true;
      next.assistantTurnComplete = true;
      next.awaitingResume = false;
      next.done = true;
      next.doneReason = 'message_stream_complete';
    }
    if (data.type === 'server_ste_metadata') next.serverMetadata = data.metadata || null;
    if (data.type === 'conversation_detail_metadata') next.conversationDetailMetadata = data;

    const message = data.v?.message;
    if (message?.metadata) {
      next.messageId = message.id || next.messageId;
      next.modelSlug = message.metadata.model_slug || message.metadata.default_model_slug || message.metadata.resolved_model_slug || next.modelSlug;
      next.thinkingEffort = message.metadata.thinking_effort || next.thinkingEffort;
      next.requestId = message.metadata.request_id || next.requestId;
      next.turnExchangeId = message.metadata.turn_exchange_id || next.turnExchangeId;
    }
    if (message?.author?.role === 'assistant' && message.channel === 'final') {
      next.finalMessageId = message.id || next.finalMessageId;
      const part = message.content?.parts?.[0];
      if (typeof part === 'string' && part) {
        if (!next.text || part.startsWith(next.text)) next.text = part;
        else if (!next.text.endsWith(part)) next.text += part;
      }
    }

    if (data.p === '/message/content/parts/0' && data.o === 'append' && typeof data.v === 'string') {
      next.text += data.v;
      lastTextAppendPath = data.p;
    } else if (!data.p && !data.o && typeof data.v === 'string' && lastTextAppendPath === '/message/content/parts/0') {
      next.text += data.v;
    }
    if (data.p === '' && data.o === 'patch' && Array.isArray(data.v)) {
      for (const patch of data.v) {
        if (patch.p === '/message/content/parts/0' && patch.o === 'append' && typeof patch.v === 'string') {
          next.text += patch.v;
          lastTextAppendPath = patch.p;
        }
        if (patch.p === '/message/status' && patch.o === 'replace' && patch.v === 'finished_successfully') {
          next.finalStatus = patch.v;
        }
        if (patch.p === '/message/end_turn' && patch.o === 'replace' && patch.v === true) {
          next.endTurn = true;
          // end_turn=true is the authoritative end-of-assistant-turn signal and
          // survives the stream handoff, unlike the initial stream's [DONE].
          next.assistantTurnComplete = true;
          next.awaitingResume = false;
          next.done = true;
          next.doneReason = 'end_turn';
        }
      }
    }
  }
  next.lastTextAppendPath = lastTextAppendPath;
  return next;
}

export function extractChatGptWebSocketPayload(payloadData, state = {}) {
  let frames;
  try {
    frames = JSON.parse(String(payloadData || ''));
  } catch {
    return state;
  }
  if (!Array.isArray(frames)) return state;

  let next = state;
  for (const frame of frames) {
    const catchups = frame.reply?.catchups || [];
    for (const catchup of catchups) {
      const encodedItem = catchup.payload?.payload?.encoded_item;
      if (encodedItem) {
        next = extractChatGptStreamStateFromEncodedItem(encodedItem, {
          ...next,
          resumedStream: true,
          resumeTransport: 'websocket',
          websocketCatchup: true,
          awaitingResume: false,
        });
      }
    }

    const encodedItem = frame.payload?.payload?.encoded_item;
    if (encodedItem) {
      next = extractChatGptStreamStateFromEncodedItem(encodedItem, {
        ...next,
        resumedStream: true,
        resumeTransport: 'websocket',
        websocketFrame: true,
        awaitingResume: false,
      });
    }
    if (frame.payload?.payload?.type === 'done') {
      next = {
        ...next,
        websocketDone: true,
        streamClosed: true,
        done: next.assistantTurnComplete || (!next.handedOff && !next.awaitingResume),
      };
    }
  }
  return next;
}

function createInitialNetworkState(modelConfig) {
  return {
    text: '',
    rawItems: [],
    searchResults: [],
    done: false,
    streamClosed: false,
    streamClosedCount: 0,
    assistantTurnComplete: false,
    handedOff: false,
    awaitingResume: false,
    resumedStream: false,
    requestModified: false,
    interceptedRequests: 0,
    responseStatuses: [],
    emptyNetworkResponses: 0,
    modelSlug: modelConfig.model,
    thinkingEffort: modelConfig.thinking_effort || null,
    requestedModelProfile: modelConfig.id,
    transport: 'network-observed-request',
  };
}

export async function createChatGptNetworkTracker({ page, selectedModel }) {
  const modelConfig = resolveChatGptModel(selectedModel) || resolveChatGptModel('default');
  const client = await page.target().createCDPSession();
  const requestUrls = new Map();
  let state = createInitialNetworkState(modelConfig);
  let disposed = false;

  await client.send('Network.enable');
  await client.send('Fetch.enable', {
    patterns: [{ urlPattern: '*://chatgpt.com/backend-api/f/conversation*', requestStage: 'Request' }],
  });

  const onPaused = async (event) => {
    if (disposed) return;
    try {
      const url = event.request?.url || '';
      if (event.request?.method === 'POST' && isChatGptConversationSubmitEndpointUrl(url) && event.request?.postData) {
        const payload = JSON.parse(event.request.postData);
        const originalPayloadModel = payload.model || null;
        const originalPayloadThinkingEffort = payload.thinking_effort || null;
        const applied = applyChatGptModelToPayload(payload, modelConfig);
        state.originalPayloadModel = state.originalPayloadModel || originalPayloadModel;
        state.originalPayloadThinkingEffort = state.originalPayloadThinkingEffort || originalPayloadThinkingEffort;
        state.appliedPayloadModel = applied.payload.model || null;
        state.appliedPayloadThinkingEffort = applied.payload.thinking_effort || null;
        if (applied.changed) state.requestModified = true;
        state.interceptedRequests += 1;
        const postData = Buffer.from(JSON.stringify(applied.payload), 'utf-8').toString('base64');
        await client.send('Fetch.continueRequest', { requestId: event.requestId, postData });
        return;
      }
    } catch (error) {
      state.error = `[chatgpt] Failed to rewrite request payload: ${error.message}`;
      await client.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'Aborted' }).catch(() => {});
      return;
    }
    await client.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => {});
  };

  const onRequest = (event) => {
    const url = event.request?.url || '';
    if (!isChatGptConversationEndpointUrl(url)) return;
    requestUrls.set(event.requestId, url);
    if (event.request?.postData && isChatGptConversationSubmitEndpointUrl(url)) {
      try {
        const payload = JSON.parse(event.request.postData);
        state.requestedPayloadModel = payload.model || state.requestedPayloadModel;
        state.requestedPayloadThinkingEffort = payload.thinking_effort || null;
      } catch {}
    }
  };

  const onResponse = (event) => {
    const url = event.response?.url || '';
    if (!isChatGptConversationEndpointUrl(url)) return;
    state.responseStatuses.push({ url, status: event.response.status, mimeType: event.response.mimeType || null });
  };

  const onFinished = async (event) => {
    const url = requestUrls.get(event.requestId);
    if (!url) return;
    let body = null;
    try {
      const responseBody = await client.send('Network.getResponseBody', { requestId: event.requestId });
      body = responseBody.body || '';
    } catch (error) {
      state.responseBodyError = error.message;
      return;
    }
    if (!body) {
      state.networkResponseEmpty = true;
      state.emptyNetworkResponses = (state.emptyNetworkResponses || 0) + 1;
      return;
    }
    state.rawResponseBody = body;
    if (isChatGptConversationStreamEndpointUrl(url)) {
      state = extractChatGptStreamStateFromEncodedItem(body, state);
    }
  };

  const onWebSocketFrame = (event) => {
    state = extractChatGptWebSocketPayload(event.response?.payloadData || '', state);
  };

  client.on('Fetch.requestPaused', onPaused);
  client.on('Network.requestWillBeSent', onRequest);
  client.on('Network.responseReceived', onResponse);
  client.on('Network.loadingFinished', onFinished);
  client.on('Network.webSocketFrameReceived', onWebSocketFrame);

  return {
    modelConfig,
    snapshot() {
      return { ...state };
    },
    reset() {
      requestUrls.clear();
      state = createInitialNetworkState(modelConfig);
    },
    async dispose() {
      disposed = true;
      client.off('Fetch.requestPaused', onPaused);
      client.off('Network.requestWillBeSent', onRequest);
      client.off('Network.responseReceived', onResponse);
      client.off('Network.loadingFinished', onFinished);
      client.off('Network.webSocketFrameReceived', onWebSocketFrame);
      await client.send('Fetch.disable').catch(() => {});
      await client.detach().catch(() => {});
    },
  };
}

async function visibleInputPosition(page) {
  return page.evaluate(() => {
    const selectors = [
      '#prompt-textarea[contenteditable="true"]',
      '#prompt-textarea',
      '[contenteditable="true"][role="textbox"]',
      'textarea[placeholder="Ask anything"]',
      'textarea',
    ];
    const candidates = Array.from(document.querySelectorAll(selectors.join(','))).map(el => {
      const rect = el.getBoundingClientRect();
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        visible: rect.width > 10 && rect.height > 10 && rect.x >= 0 && rect.y >= 0,
      };
    });
    const target = candidates.find(candidate => candidate.visible);
    if (!target) return null;
    return { x: target.x + target.width / 2, y: target.y + Math.min(target.height / 2, 20) };
  });
}

async function chatGptComposerText(page) {
  return page.evaluate(() => {
    const selectors = '#prompt-textarea[contenteditable="true"], #prompt-textarea, [contenteditable="true"][role="textbox"], textarea[placeholder="Ask anything"], textarea';
    const candidates = Array.from(document.querySelectorAll(selectors));
    const el = candidates.find(candidate => {
      const rect = candidate.getBoundingClientRect();
      return rect.width > 10 && rect.height > 10;
    }) || candidates[0];
    if (!el) return '';
    return (el.innerText || el.value || el.textContent || '').trim();
  }).catch(() => '');
}

async function chatGptSendButtonReady(page) {
  return page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button')).map(el => {
      const rect = el.getBoundingClientRect();
      return {
        aria: el.getAttribute('aria-label') || '',
        testid: el.getAttribute('data-testid') || '',
        disabled: el.disabled || el.getAttribute('aria-disabled') === 'true',
        visible: rect.width > 0 && rect.height > 0,
      };
    });
    return buttons.some(button => /send prompt|send message|send/i.test(button.aria) && !/dictation|voice/i.test(button.aria) && !button.disabled && button.visible)
      || buttons.some(button => /send-button/i.test(button.testid) && !button.disabled && button.visible);
  }).catch(() => false);
}

async function focusChatGptComposer(page) {
  return page.evaluate(() => {
    const selectors = '#prompt-textarea[contenteditable="true"], #prompt-textarea, [contenteditable="true"][role="textbox"], textarea[placeholder="Ask anything"], textarea';
    const candidates = Array.from(document.querySelectorAll(selectors));
    const el = candidates.find(candidate => {
      const rect = candidate.getBoundingClientRect();
      return rect.width > 10 && rect.height > 10;
    }) || candidates[0];
    if (!el) return false;
    el.focus();
    const rect = el.getBoundingClientRect();
    return rect.width > 10 && rect.height > 10;
  }).catch(() => false);
}

async function withChatGptInputClient(page, callback) {
  const client = await page.target().createCDPSession();
  try {
    return await callback(client);
  } finally {
    await client.detach().catch(() => {});
  }
}

async function dispatchChatGptKey(client, { key, code, windowsVirtualKeyCode, modifiers = 0 }) {
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode, modifiers });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode, modifiers });
}

export async function clearChatGptPromptText(page) {
  if (!await focusChatGptComposer(page)) return false;
  await withChatGptInputClient(page, async (client) => {
    await dispatchChatGptKey(client, { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4 });
    await dispatchChatGptKey(client, { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  });
  await sleep(300);
  return !await chatGptSendButtonReady(page);
}

export async function insertChatGptPromptText(page, prompt) {
  if (!await focusChatGptComposer(page)) return false;
  await withChatGptInputClient(page, async (client) => {
    await client.send('Input.insertText', { text: prompt });
  });
  await sleep(500);
  return chatGptSendButtonReady(page);
}

function isUsableChatGptAssistantMessageCount(value) {
  return Number.isInteger(value) && value >= 0;
}

async function countChatGptAssistantMessages(page) {
  return page.evaluate(() => document.querySelectorAll('[data-message-author-role="assistant"]').length)
    .catch(() => null);
}

async function recoverChatGptDomResponse(page) {
  if (!page?.evaluate) return { text: '', done: false, assistantMessageCount: null };
  return page.evaluate(() => {
    const messages = document.querySelectorAll('[data-message-author-role="assistant"]');
    if (messages.length === 0) return { text: '', done: false, assistantMessageCount: 0 };
    let text = messages[messages.length - 1].innerText || '';
    text = text.replace(/^Thought for \d+[sm]?\s*\n?/i, '');
    text = text.replace(/^ChatGPT said\s*\n?/i, '');
    return { text: text.trim(), done: !!text.trim(), assistantMessageCount: messages.length };
  }).catch(() => ({ text: '', done: false, assistantMessageCount: null }));
}

async function recoverCurrentChatGptDomResult({ page, snapshot, selectedModel, attemptContext, preSubmitAssistantMessageCount, reason }) {
  const baselineAssistantMessageCount = isUsableChatGptAssistantMessageCount(preSubmitAssistantMessageCount)
    ? preSubmitAssistantMessageCount
    : attemptContext?.preSubmitAssistantMessageCount;
  const fallback = await recoverChatGptDomResponse(page);
  const fallbackIsCurrent = isUsableChatGptAssistantMessageCount(baselineAssistantMessageCount)
    && isUsableChatGptAssistantMessageCount(fallback.assistantMessageCount)
    && fallback.assistantMessageCount > baselineAssistantMessageCount;
  const fallbackText = String(fallback.text || '').trim();

  if (!fallbackIsCurrent || !fallbackText) return null;

  const fallbackSnapshot = {
    ...(snapshot || {}),
    text: fallbackText,
    done: fallback.done,
    assistantTurnComplete: fallback.done,
    transport: 'dom-fallback',
    requestedModelProfile: resolveChatGptModel(selectedModel)?.id || selectedModel,
  };
  return {
    text: fallbackText,
    rawText: fallbackText,
    done: fallback.done,
    modelUsed: snapshot?.modelSlug || resolveChatGptModel(selectedModel)?.model || selectedModel,
    finalUrl: page.url(),
    providerState: buildChatGptProviderState(fallbackSnapshot, { dom_fallback: true, reason }),
    searchResults: [],
  };
}

function buildChatGptStreamMetadata(snapshot, extra = {}) {
  const timeout = !!extra.timeout;
  const domFallback = !!extra.dom_fallback || snapshot.transport === 'dom-fallback';
  const hasText = !!String(snapshot.text || '').trim();
  const emptyResponse = !domFallback && (!!extra.empty_response || !!snapshot.networkResponseEmpty || (!hasText && (timeout || (snapshot.responseStatuses || []).length > 0)));
  const assistantTurnComplete = !!snapshot.assistantTurnComplete || (!!snapshot.done && !snapshot.awaitingResume);
  const partial = !emptyResponse && !assistantTurnComplete && (hasText || !!extra.partial);
  const handedOff = !!snapshot.handedOff;
  const awaitingResume = !!snapshot.awaitingResume || (handedOff && !snapshot.resumedStream && !assistantTurnComplete);
  const resumable = !!(snapshot.conversationId || snapshot.topicId || snapshot.turnExchangeId);

  let status = 'pending';
  if (domFallback) status = 'dom_fallback';
  else if (assistantTurnComplete) status = 'completed';
  else if (timeout && emptyResponse) status = 'timeout_empty';
  else if (timeout && partial) status = 'timeout_partial';
  else if (emptyResponse) status = 'empty';
  else if (snapshot.resumedStream) status = 'resumed_stream';
  else if (handedOff) status = 'stream_handoff';
  else if (snapshot.streamClosed) status = 'stream_closed';
  else if (partial) status = 'partial';

  return {
    status,
    partial,
    empty_response: emptyResponse,
    timeout,
    stream_closed: !!snapshot.streamClosed,
    stream_closed_count: snapshot.streamClosedCount || 0,
    assistant_turn_complete: assistantTurnComplete,
    done_reason: snapshot.doneReason || null,
    handed_off: handedOff,
    awaiting_resume: awaitingResume,
    resumed_stream: !!snapshot.resumedStream,
    resume_transport: snapshot.resumeTransport || null,
    websocket_catchup: !!snapshot.websocketCatchup,
    websocket_frame: !!snapshot.websocketFrame,
    websocket_done: !!snapshot.websocketDone,
    message_stream_complete: !!snapshot.messageStreamComplete,
    end_turn: !!snapshot.endTurn,
    has_resume_token: !!snapshot.resumeToken,
    resumable,
    dom_fallback: domFallback,
  };
}

function buildChatGptProviderState(snapshot, extra = {}) {
  const { partial, timeout, empty_response: emptyResponse, dom_fallback: domFallback, ...restExtra } = extra;
  const streamState = buildChatGptStreamMetadata(snapshot, {
    partial,
    timeout,
    empty_response: emptyResponse,
    dom_fallback: domFallback,
  });
  return {
    transport: snapshot.transport,
    requested_model_profile: snapshot.requestedModelProfile,
    requested_payload_model: Object.hasOwn(snapshot, 'appliedPayloadModel') ? snapshot.appliedPayloadModel : (snapshot.requestedPayloadModel || null),
    requested_payload_thinking_effort: Object.hasOwn(snapshot, 'appliedPayloadThinkingEffort') ? snapshot.appliedPayloadThinkingEffort : (snapshot.requestedPayloadThinkingEffort ?? null),
    original_payload_model: snapshot.originalPayloadModel || snapshot.requestedPayloadModel || null,
    original_payload_thinking_effort: snapshot.originalPayloadThinkingEffort ?? snapshot.requestedPayloadThinkingEffort ?? null,
    model_slug: snapshot.modelSlug || null,
    thinking_effort: snapshot.thinkingEffort || null,
    conversation_id: snapshot.conversationId || null,
    topic_id: snapshot.topicId || null,
    turn_exchange_id: snapshot.turnExchangeId || null,
    message_id: snapshot.finalMessageId || snapshot.messageId || null,
    request_id: snapshot.requestId || null,
    request_modified: !!snapshot.requestModified,
    intercepted_requests: snapshot.interceptedRequests || 0,
    response_statuses: snapshot.responseStatuses || [],
    empty_network_responses: snapshot.emptyNetworkResponses || 0,
    partial: streamState.partial,
    timeout: streamState.timeout,
    empty_response: streamState.empty_response,
    stream_closed: streamState.stream_closed,
    assistant_turn_complete: streamState.assistant_turn_complete,
    handed_off: streamState.handed_off,
    resumed_stream: streamState.resumed_stream,
    dom_fallback: streamState.dom_fallback,
    stream_state: streamState,
    ...restExtra,
  };
}

export const chatgptProvider = {
  name: 'chatgpt',
  url: CHATGPT_ORIGIN,
  trustedConversationHostnames: CHATGPT_HOSTNAMES,
  transport: 'network-observed-request',
  defaultModel: 'extra-high',
  taskModels: {
    default: 'extra-high',
    quick: 'instant',
    reasoning: 'extra-high',
    pro: 'pro-extended',
  },
  historyPolicy: {
    default: 'provider-history',
    transportField: 'conversation_mode.kind',
  },
  resolveConversationAttachment: resolveChatGptConversationAttachment,
  conversationUrlFromState({ conversation } = {}) {
    return resolveChatGptConversationUrl(conversation);
  },

  listModelsRequiresBrowser: false,

  async listModels({ request } = {}) {
    return {
      model_source: 'chatgpt-webui-request-profiles',
      account_specific: true,
      verification: {
        enabled: !!request?.verifyModels,
        status: request?.verifyModels ? 'not-implemented-for-chatgpt-direct-validation' : 'static-request-profile-list',
        note: 'Runtime uses request payload rewrite and network stream parsing, not the model picker UI.',
      },
      models: CHATGPT_MODEL_LEVELS.map(chatGptModelRecord),
    };
  },

  async findPage({ browser, continueChat, request }) {
    if (!continueChat && !request?.conversationTarget) {
      const page = await browser.newPage({ background: true });
      await page.goto(this.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(3000);
      return page;
    }

    const pages = await browser.pages();
    let page = pages.find(candidate => isChatGptUrl(candidate.url()));
    if (!page) page = await browser.newPage({ background: true });
    if (continueChat && isChatGptConversationUrl(page.url())) {
      await sleep(1000);
    } else if (!continueChat && !request?.conversationTarget && isChatGptConversationUrl(page.url())) {
      await page.goto(this.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(3000);
    } else if (!isChatGptUrl(page.url())) {
      await page.goto(this.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(3000);
    } else if (request?.conversationTarget && /^https?:\/\//i.test(request.conversationTarget)) {
      await page.goto(request.conversationTarget, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(2000);
    }
    return page;
  },

  async recheckConversation({ browser, request, selectedModel, conversation, networkTrackerFactory = createChatGptNetworkTracker }) {
    const url = resolveChatGptConversationUrl(conversation);
    if (!url || !chatGptConversationIdFromUrl(url)) {
      throw new Error('[chatgpt] Cannot recheck a saved request without a ChatGPT conversation URL or conversation_id. Use --conversation with a saved ChatGPT session that contains provider_state.conversation_id.');
    }

    const pages = await browser.pages();
    let page = pages.find(candidate => candidate.url() === url)
      || pages.find(candidate => isChatGptUrl(candidate.url()));
    if (!page) page = await browser.newPage({ background: true });

    const networkTracker = await networkTrackerFactory({ page, selectedModel });
    try {
      if (page.url() !== url) {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(2000);
      } else {
        await sleep(1000);
      }
      const result = await this.waitForResponse({
        page,
        timeoutMs: (request.timeoutSeconds || 60) * 1000,
        networkTracker,
        selectedModel,
      });
      return {
        ...result,
        finalUrl: result.finalUrl || url,
        providerState: {
          ...(result.providerState || {}),
          recheck: true,
          recheck_source: 'saved-conversation',
          stream_state: {
            ...(result.providerState?.stream_state || {}),
            recheck: true,
          },
        },
      };
    } finally {
      await networkTracker?.dispose?.();
    }
  },

  async createAttemptContext({ page, selectedModel }) {
    return {
      networkTracker: await createChatGptNetworkTracker({ page, selectedModel }),
      preSubmitAssistantMessageCount: await countChatGptAssistantMessages(page),
    };
  },

  async disposeAttemptContext({ attemptContext }) {
    await attemptContext?.networkTracker?.dispose?.();
  },

  async beforeSubmit({ page, attemptContext }) {
    if (!attemptContext) return;
    attemptContext.preSubmitAssistantMessageCount = await countChatGptAssistantMessages(page);
  },

  async setModel({ model, selectedModel }) {
    const modelConfig = resolveChatGptModel(selectedModel || model);
    if (!modelConfig) throw new Error(`[chatgpt] Unknown model request profile: ${selectedModel || model}`);
    console.error(`[chatgpt] Model request profile: ${modelConfig.id} -> ${modelConfig.model}${modelConfig.thinking_effort ? ` (${modelConfig.thinking_effort})` : ''}`);
  },

  async clearInput({ page }) {
    const inputPos = await visibleInputPosition(page);
    if (!inputPos) return;
    if (await clearChatGptPromptText(page)) return;
    await page.mouse.click(inputPos.x, inputPos.y);
    await sleep(200);
    await page.keyboard.down('Meta');
    await page.keyboard.press('a');
    await page.keyboard.up('Meta');
    await page.keyboard.press('Backspace');
    await sleep(200);
  },

  async typePrompt({ page, prompt }) {
    const inputPos = await visibleInputPosition(page);
    if (!inputPos) throw new Error('[chatgpt] Prompt input not found. Verify the Browser Tools profile is logged in to ChatGPT.');
    if (await insertChatGptPromptText(page, prompt)) {
      await sleep(800);
      return;
    }

    await page.mouse.click(inputPos.x, inputPos.y);
    await sleep(300);
    const lines = prompt.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].length > 0) await page.keyboard.type(lines[i], { delay: 0 });
      if (i < lines.length - 1) {
        await page.keyboard.down('Shift');
        await page.keyboard.press('Enter');
        await page.keyboard.up('Shift');
      }
    }
    await sleep(800);
    if (!await chatGptSendButtonReady(page)) {
      const typed = await chatGptComposerText(page);
      throw new Error(`[chatgpt] Failed to type prompt into the composer. The send button stayed unavailable after typing${typed ? ` (composer text: ${typed.slice(0, 80)})` : ''}.`);
    }
  },

  async submit({ page }) {
    const submitted = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button')).map(el => {
        const rect = el.getBoundingClientRect();
        return {
          el,
          aria: el.getAttribute('aria-label') || '',
          testid: el.getAttribute('data-testid') || '',
          disabled: el.disabled || el.getAttribute('aria-disabled') === 'true',
          visible: rect.width > 0 && rect.height > 0,
        };
      });
      const target = buttons.find(button => /send prompt|send message|send/i.test(button.aria) && !/dictation|voice/i.test(button.aria) && !button.disabled && button.visible)
        || buttons.find(button => /send-button/i.test(button.testid) && !button.disabled && button.visible);
      if (!target) return false;
      target.el.click();
      return true;
    });
    if (!submitted) throw new Error('[chatgpt] Send button is unavailable. The prompt was not submitted.');
    await sleep(1500);
  },

  async waitForResponse({ page, timeoutMs, networkTracker, selectedModel, attemptContext, preSubmitAssistantMessageCount = null, prompt = null, request = null }) {
    const pollMs = 1000;
    const maxPolls = Math.ceil(timeoutMs / pollMs);
    let lastTextLength = 0;
    let stablePolls = 0;
    let growthCount = 0;
    let retriedNoRequestSubmit = false;
    let retriedTerminalEmptyStream = false;

    for (let attempt = 0; attempt < maxPolls; attempt++) {
      const snapshot = networkTracker?.snapshot?.() || null;
      const text = snapshot?.text || '';
      if (snapshot?.error) throw new Error(snapshot.error);

      const responseStatuses = snapshot?.responseStatuses || [];
      const rejectedStatus = responseStatuses.find(item => item.status === 422 && /\/backend-api\/f\/conversation/.test(item.url || ''));
      const hasSuccessfulStream = responseStatuses.some(item => item.status === 200 && /event-stream/.test(item.mimeType || '') && /\/backend-api\/f\/conversation/.test(item.url || ''));
      if (rejectedStatus && !hasSuccessfulStream && !text.trim() && attempt >= 2) {
        throw new Error(`[chatgpt] ChatGPT rejected request profile ${snapshot.requestedModelProfile || selectedModel} with HTTP 422. The web backend did not accept the rewritten payload for ${snapshot.appliedPayloadModel || snapshot.requestedPayloadModel || selectedModel}${snapshot.appliedPayloadThinkingEffort ? ` (${snapshot.appliedPayloadThinkingEffort})` : ''}.`);
      }

      if (!retriedNoRequestSubmit
        && attempt >= 12
        && snapshot
        && (snapshot.interceptedRequests || 0) === 0
        && (snapshot.responseStatuses || []).length === 0
        && typeof prompt === 'string'
        && prompt.trim()) {
        retriedNoRequestSubmit = true;
        process.stderr.write('\n');
        console.error('[chatgpt] No conversation request observed after submit; retrying composer submission once...');
        if (!request?.conversationTarget && !request?.continueChat) {
          await page.goto(CHATGPT_ORIGIN, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await sleep(3000);
        }
        await chatgptProvider.clearInput({ page, request });
        await chatgptProvider.typePrompt({ page, prompt, request });
        await chatgptProvider.beforeSubmit?.({ page, attemptContext });
        await chatgptProvider.submit({ page, request, selectedModel });
        console.error('[chatgpt] Resubmitted. Waiting for response...');
        continue;
      }

      if (text.length > lastTextLength) growthCount += 1;
      if (text.length === lastTextLength && text.length > 0) stablePolls += 1;
      else stablePolls = 0;
      lastTextLength = text.length;

      if (snapshot?.done && text.trim()) {
        process.stderr.write('\n');
        return {
          text: text.trim(),
          rawText: (snapshot.rawItems || []).join('\n'),
          done: true,
          modelUsed: snapshot.modelSlug || resolveChatGptModel(selectedModel)?.model || selectedModel,
          finalUrl: chatGptConversationUrl(snapshot.conversationId) || page.url(),
          providerState: buildChatGptProviderState(snapshot),
          searchResults: snapshot.searchResults || [],
        };
      }

      if (snapshot?.done && !text.trim() && (snapshot.streamClosed || snapshot.assistantTurnComplete || snapshot.messageStreamComplete)) {
        process.stderr.write('\n');
        let recovered = null;
        const maxDomRecoveryAttempts = page?.evaluate ? 4 : 1;
        for (let recoveryAttempt = 0; recoveryAttempt < maxDomRecoveryAttempts && !recovered; recoveryAttempt++) {
          if (recoveryAttempt > 0) await sleep(1000);
          recovered = await recoverCurrentChatGptDomResult({
            page,
            snapshot,
            selectedModel,
            attemptContext,
            preSubmitAssistantMessageCount,
            reason: 'terminal-empty-stream-dom-recovery',
          });
        }
        if (recovered) return recovered;

        if (!retriedTerminalEmptyStream && typeof prompt === 'string' && prompt.trim()) {
          retriedTerminalEmptyStream = true;
          console.error('[chatgpt] Terminal stream was empty and no current DOM answer appeared; retrying prompt once...');
          networkTracker?.reset?.();
          lastTextLength = 0;
          stablePolls = 0;
          growthCount = 0;
          if (!request?.conversationTarget && !request?.continueChat) {
            await page.goto(CHATGPT_ORIGIN, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await sleep(3000);
          }
          await chatgptProvider.clearInput({ page, request });
          await chatgptProvider.typePrompt({ page, prompt, request });
          await chatgptProvider.beforeSubmit?.({ page, attemptContext });
          await chatgptProvider.submit({ page, request, selectedModel });
          console.error('[chatgpt] Resubmitted after empty stream. Waiting for response...');
          continue;
        }

        return {
          text: '',
          rawText: (snapshot.rawItems || []).join('\n'),
          done: false,
          modelUsed: snapshot.modelSlug || resolveChatGptModel(selectedModel)?.model || selectedModel,
          finalUrl: chatGptConversationUrl(snapshot.conversationId) || page.url(),
          providerState: buildChatGptProviderState(snapshot, { empty_response: true, reason: 'terminal-empty-stream' }),
          searchResults: snapshot.searchResults || [],
        };
      }

      // Stability fallback only fires once the answer stream has actually grown
      // past the initial preamble (growthCount >= 2). Reasoning models can sit on
      // the preamble for many seconds while thinking; the old 8s flat window
      // there returned the preamble as if it were the whole answer.
      if (text.trim() && growthCount >= 2 && stablePolls >= 12) {
        process.stderr.write('\n');
        return {
          text: text.trim(),
          rawText: (snapshot.rawItems || []).join('\n'),
          done: false,
          modelUsed: snapshot.modelSlug || resolveChatGptModel(selectedModel)?.model || selectedModel,
          finalUrl: chatGptConversationUrl(snapshot.conversationId) || page.url(),
          providerState: buildChatGptProviderState(snapshot, { partial: true }),
          searchResults: snapshot.searchResults || [],
        };
      }

      process.stderr.write(`  [chatgpt] network ${text.length} chars (poll ${attempt + 1}/${maxPolls})${snapshot?.done ? ' done' : ''}\r`);
      await sleep(pollMs);
    }

    const snapshot = networkTracker?.snapshot?.() || null;
    if (snapshot?.done && snapshot?.text?.trim()) {
      process.stderr.write('\n');
      return {
        text: snapshot.text.trim(),
        rawText: (snapshot.rawItems || []).join('\n'),
        done: true,
        modelUsed: snapshot.modelSlug || resolveChatGptModel(selectedModel)?.model || selectedModel,
        finalUrl: chatGptConversationUrl(snapshot.conversationId) || page.url(),
        providerState: buildChatGptProviderState(snapshot),
        searchResults: snapshot.searchResults || [],
      };
    }

    if (snapshot?.text?.trim()) {
      process.stderr.write('\n');
      return {
        text: snapshot.text.trim(),
        rawText: (snapshot.rawItems || []).join('\n'),
        done: false,
        modelUsed: snapshot.modelSlug || resolveChatGptModel(selectedModel)?.model || selectedModel,
        finalUrl: chatGptConversationUrl(snapshot.conversationId) || page.url(),
        providerState: buildChatGptProviderState(snapshot, { partial: true, timeout: true }),
        searchResults: snapshot.searchResults || [],
      };
    }

    if (snapshot?.conversationId || snapshot?.topicId || snapshot?.responseStatuses?.length) {
      process.stderr.write('\n');
      return {
        text: '',
        rawText: (snapshot.rawItems || []).join('\n'),
        done: false,
        modelUsed: snapshot.modelSlug || resolveChatGptModel(selectedModel)?.model || selectedModel,
        finalUrl: chatGptConversationUrl(snapshot.conversationId) || page.url(),
        providerState: buildChatGptProviderState(snapshot, { timeout: true, empty_response: true }),
        searchResults: snapshot.searchResults || [],
      };
    }

    const baselineAssistantMessageCount = isUsableChatGptAssistantMessageCount(preSubmitAssistantMessageCount)
      ? preSubmitAssistantMessageCount
      : attemptContext?.preSubmitAssistantMessageCount;
    const fallback = await recoverChatGptDomResponse(page);
    const fallbackIsCurrent = isUsableChatGptAssistantMessageCount(baselineAssistantMessageCount)
      && isUsableChatGptAssistantMessageCount(fallback.assistantMessageCount)
      && fallback.assistantMessageCount > baselineAssistantMessageCount;
    const fallbackText = String(fallback.text || '').trim();

    if (!fallbackIsCurrent || !fallbackText) {
      const emptySnapshot = {
        ...(snapshot || {}),
        text: '',
        done: false,
        assistantTurnComplete: false,
        transport: snapshot?.transport || 'network-observed-request',
        requestedModelProfile: snapshot?.requestedModelProfile || resolveChatGptModel(selectedModel)?.id || selectedModel,
      };
      return {
        text: '',
        rawText: '',
        done: false,
        modelUsed: emptySnapshot.modelSlug || resolveChatGptModel(selectedModel)?.model || selectedModel,
        finalUrl: chatGptConversationUrl(emptySnapshot.conversationId) || page.url(),
        providerState: buildChatGptProviderState(emptySnapshot, { timeout: true, empty_response: true, reason: 'dom-fallback-not-current' }),
        searchResults: emptySnapshot.searchResults || [],
      };
    }

    const fallbackSnapshot = {
      ...(snapshot || {}),
      text: fallbackText,
      done: fallback.done,
      assistantTurnComplete: fallback.done,
      transport: 'dom-fallback',
      requestedModelProfile: resolveChatGptModel(selectedModel)?.id || selectedModel,
    };
    return {
      text: fallbackText,
      rawText: fallbackText,
      done: fallback.done,
      modelUsed: resolveChatGptModel(selectedModel)?.model || selectedModel,
      finalUrl: page.url(),
      providerState: buildChatGptProviderState(fallbackSnapshot, { dom_fallback: true, reason: 'network-stream-empty' }),
      searchResults: [],
    };
  },
};
