import { sleep, urlHasAllowedHostname } from './shared.mjs';

const CHATGPT_ORIGIN = 'https://chatgpt.com';
const CHATGPT_HOSTNAMES = ['chatgpt.com', 'www.chatgpt.com'];
const CHATGPT_CONVERSATION_ENDPOINT = '/backend-api/f/conversation';
const PRIVATE_KEYS = /(?:authorization|cookie|token|sentinel|conduit|turnstile|proof|resume|secret|credential|password|api[_-]?key)/i;
const UI_WAIT_TIMEOUT_MS = 5_000;

function isChatGptUrl(url) {
  return urlHasAllowedHostname(url, CHATGPT_HOSTNAMES);
}

function chatGptConversationUrl(id) {
  return id ? `${CHATGPT_ORIGIN}/c/${encodeURIComponent(id)}` : null;
}

function chatGptConversationIdFromUrl(url) {
  try {
    return new URL(url).pathname.match(/^\/c\/([^/?#]+)/)?.[1] || null;
  } catch {
    return null;
  }
}

function normalize(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
}

export const CHATGPT_MODEL_LEVELS = [
  { id: 'instant', name: 'Instant', uiLabel: 'Instant', model: 'gpt-5-5-instant', thinking_effort: null },
  { id: 'medium', name: 'Medium', uiLabel: 'Medium', model: 'gpt-5-6-thinking', thinking_effort: 'standard' },
  { id: 'high', name: 'High', uiLabel: 'High', model: 'gpt-5-6-thinking', thinking_effort: 'extended' },
  { id: 'extra-high', name: 'Extra High', uiLabel: 'Extra High', model: 'gpt-5-6-thinking', thinking_effort: 'max' },
  { id: 'pro', name: 'Pro', uiLabel: 'Pro', model: 'gpt-5-6-pro', thinking_effort: 'standard' },
];

export function resolveChatGptModel(modelName = 'default') {
  const value = normalize(modelName);
  if (value === 'default' || !value) return CHATGPT_MODEL_LEVELS.find(model => model.id === 'extra-high');
  return CHATGPT_MODEL_LEVELS.find(model => model.id === value) || null;
}

export function chatGptModelRecord(model) {
  return {
    id: model.id,
    name: model.name,
    model: model.model,
    thinking_effort: model.thinking_effort,
    account_specific: true,
    source: 'chatgpt-ui-picker',
    selected_by: [model.id],
    transport: 'ui-picker-then-network-verification',
    verification: { status: 'post-submit-network-verification' },
  };
}

export function verifyChatGptObservedModel(modelConfig, observedModel, observedThinkingEffort) {
  if (!observedModel) return { status: 'pending', verified: false };
  const expected = modelConfig?.id;
  const acceptedModel = expected === 'instant'
    ? ['gpt-5-5-instant', 'gpt-5-5'].includes(observedModel)
    : observedModel === modelConfig?.model;
  const acceptedEffort = expected === 'instant'
    ? true
    : observedThinkingEffort === modelConfig?.thinking_effort;
  return acceptedModel && acceptedEffort
    ? { status: 'verified', verified: true }
    : {
        status: 'mismatch',
        verified: false,
        expected_profile: expected || null,
        observed_model: observedModel || null,
        observed_thinking_effort: observedThinkingEffort || null,
      };
}

export function parseChatGptSseEvents(text) {
  const events = [];
  let event = 'message';
  let data = [];

  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line) {
      if (data.length) events.push({ event, data: data.join('\n') });
      event = 'message';
      data = [];
    } else if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      data.push(line.slice(5).trimStart());
    }
  }
  if (data.length) events.push({ event, data: data.join('\n') });
  return events;
}

export function createChatGptSseDecoder(state = {}) {
  const decoder = new TextDecoder();
  let pending = '';

  function splitCompleteFrames() {
    const events = [];
    while (true) {
      const match = /\r?\n\r?\n/.exec(pending);
      if (!match) return events;
      const end = match.index + match[0].length;
      events.push(...parseChatGptSseEvents(pending.slice(0, end)));
      pending = pending.slice(end);
    }
  }

  return {
    push(base64) {
      pending += decoder.decode(Buffer.from(base64 || '', 'base64'), { stream: true });
      return splitCompleteFrames();
    },
    flush() {
      pending += decoder.decode();
      const events = [...splitCompleteFrames(), ...parseChatGptSseEvents(pending)];
      pending = '';
      return events;
    },
    state,
  };
}

function applySseEvents(events, state = {}) {
  const next = {
    text: '', rawItems: [], searchResults: [], done: false,
    streamClosed: false, streamClosedCount: 0, assistantTurnComplete: false,
    awaitingResume: false, resumedStream: false, ...state,
  };
  let appendPath = next.lastTextAppendPath || null;

  for (const event of events) {
    if (event.data === '[DONE]') {
      next.streamClosed = true;
      next.streamClosedCount += 1;
      next.lastStreamCloseReason = 'sse_done';
      if (!next.handedOff && !next.awaitingResume) {
        next.done = true;
        next.doneReason ||= 'stream_closed_without_handoff';
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

    if (data.type === 'stream_handoff' || data.type === 'resume_conversation_token') {
      next.handedOff = true;
      next.awaitingResume = !next.assistantTurnComplete;
      next.streamHandoff ||= data.type === 'stream_handoff';
      const options = data.options || [];
      const websocket = options.find(option => option.type === 'subscribe_ws_topic');
      const sse = options.find(option => option.type === 'resume_sse_endpoint');
      next.topicId = websocket?.topic_id || sse?.topic_id || next.topicId;
      next.resumeTransport = websocket ? 'websocket' : (sse ? 'sse' : next.resumeTransport);
      continue;
    }

    if (data.type === 'message_stream_complete' || data.type === 'assistant_turn_complete') {
      next.messageStreamComplete ||= data.type === 'message_stream_complete';
      next.assistantTurnComplete = true;
      next.awaitingResume = false;
      next.done = true;
    }

    const message = data.v?.message;
    if (message?.metadata) {
      next.messageId = message.id || next.messageId;
      next.modelSlug = message.metadata.model_slug || message.metadata.default_model_slug || next.modelSlug;
      next.thinkingEffort = message.metadata.thinking_effort || next.thinkingEffort;
      next.requestId = message.metadata.request_id || next.requestId;
    }
    if (message?.author?.role === 'assistant' && message.channel === 'final') {
      next.finalMessageId = message.id || next.finalMessageId;
      const part = message.content?.parts?.[0];
      if (typeof part === 'string') next.text = !next.text || part.startsWith(next.text) ? part : next.text;
    }

    if (data.p === '/message/content/parts/0' && data.o === 'append' && typeof data.v === 'string') {
      next.text += data.v;
      appendPath = data.p;
    } else if (!data.p && !data.o && typeof data.v === 'string' && appendPath === '/message/content/parts/0') {
      next.text += data.v;
    }
    for (const patch of data.p === '' && data.o === 'patch' && Array.isArray(data.v) ? data.v : []) {
      if (patch.p === '/message/content/parts/0' && patch.o === 'append' && typeof patch.v === 'string') {
        next.text += patch.v;
        appendPath = patch.p;
      }
      if (patch.p === '/message/status' && patch.v === 'finished_successfully') next.finalStatus = patch.v;
      if (patch.p === '/message/end_turn' && patch.v === true) {
        next.endTurn = true;
        next.assistantTurnComplete = true;
        next.awaitingResume = false;
        next.done = true;
      }
    }
  }
  next.lastTextAppendPath = appendPath;
  return next;
}

export function extractChatGptStreamStateFromEncodedItem(text, state = {}) {
  return applySseEvents(parseChatGptSseEvents(text), state);
}

export function extractChatGptWebSocketPayload(payloadData, state = {}) {
  let frames;
  try {
    frames = JSON.parse(String(payloadData || ''));
  } catch {
    return state;
  }

  let next = state;
  for (const frame of Array.isArray(frames) ? frames : []) {
    for (const catchup of frame.reply?.catchups || []) {
      const item = catchup.payload?.payload?.encoded_item;
      if (item) {
        next = extractChatGptStreamStateFromEncodedItem(item, {
          ...next, resumedStream: true, resumeTransport: 'websocket', websocketCatchup: true, awaitingResume: false,
        });
      }
    }
    const item = frame.payload?.payload?.encoded_item;
    if (item) {
      next = extractChatGptStreamStateFromEncodedItem(item, {
        ...next, resumedStream: true, resumeTransport: 'websocket', websocketFrame: true, awaitingResume: false,
      });
    }
  }
  return next;
}

function initialState(model) {
  return {
    text: '', rawItems: [], searchResults: [], done: false, streamClosed: false,
    streamClosedCount: 0, assistantTurnComplete: false, handedOff: false,
    awaitingResume: false, resumedStream: false, responseStatuses: [],
    requestedModelProfile: model.id, modelVerification: { status: 'pending', verified: false },
    transport: 'network-incremental-sse',
  };
}

export async function createChatGptNetworkTracker({ page, selectedModel }) {
  const modelConfig = resolveChatGptModel(selectedModel) || resolveChatGptModel();
  const client = await page.target().createCDPSession();
  let state = initialState(modelConfig);
  let disposed = false;
  let finalRequestId = null;
  let decoder = null;
  const streamed = new Set();

  function recordObservedPayload(postData) {
    try {
      const payload = JSON.parse(postData || '{}');
      state.observedPayloadModel = payload.model || null;
      state.observedPayloadThinkingEffort = payload.thinking_effort || null;
      state.modelVerification = verifyChatGptObservedModel(modelConfig, state.observedPayloadModel, state.observedPayloadThinkingEffort);
    } catch {
      state.modelVerification = { status: 'unavailable', verified: false };
    }
  }

  function consume(base64) {
    if (!base64 || !decoder) return;
    state = applySseEvents(decoder.push(base64), state);
    state.incrementalBytes = (state.incrementalBytes || 0) + Buffer.from(base64, 'base64').length;
  }

  await client.send('Network.enable');
  const onRequest = event => {
    const request = event.request || {};
    if (request.method !== 'POST' || !isChatGptUrl(request.url)) return;
    if (new URL(request.url).pathname !== CHATGPT_CONVERSATION_ENDPOINT) return;
    finalRequestId = event.requestId;
    state.requestId = event.requestId;
    recordObservedPayload(request.postData);
  };
  const onResponse = async event => {
    if (disposed || event.requestId !== finalRequestId) return;
    const response = event.response || {};
    state.responseStatuses.push({ url: response.url || '', status: response.status, mimeType: response.mimeType || null });
    if (!(response.status >= 200 && response.status < 300 && /event-stream/i.test(response.mimeType || ''))) return;
    decoder = createChatGptSseDecoder();
    try {
      const result = await client.send('Network.streamResourceContent', { requestId: event.requestId });
      streamed.add(event.requestId);
      consume(result.bufferedData);
    } catch (error) {
      state.incrementalUnsupported = error.message;
    }
  };
  const onData = event => {
    if (event.requestId === finalRequestId && streamed.has(event.requestId)) consume(event.data);
  };
  const onFinished = async event => {
    if (event.requestId !== finalRequestId) return;
    if (decoder) state = applySseEvents(decoder.flush(), state);
    if (streamed.has(event.requestId) && state.incrementalBytes) return;
    try {
      const body = await client.send('Network.getResponseBody', { requestId: event.requestId });
      if (!body.body) state.networkResponseEmpty = true;
      else state = extractChatGptStreamStateFromEncodedItem(body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body, state);
    } catch (error) {
      state.responseBodyError = error.message;
    }
  };
  const onWebSocket = event => {
    state = extractChatGptWebSocketPayload(event.response?.payloadData || '', state);
  };

  client.on('Network.requestWillBeSent', onRequest);
  client.on('Network.responseReceived', onResponse);
  client.on('Network.dataReceived', onData);
  client.on('Network.loadingFinished', onFinished);
  client.on('Network.webSocketFrameReceived', onWebSocket);
  return {
    modelConfig,
    snapshot: () => ({ ...state }),
    reset() {
      state = initialState(modelConfig);
      finalRequestId = null;
      decoder = null;
      streamed.clear();
    },
    async dispose() {
      disposed = true;
      client.off('Network.requestWillBeSent', onRequest);
      client.off('Network.responseReceived', onResponse);
      client.off('Network.dataReceived', onData);
      client.off('Network.loadingFinished', onFinished);
      client.off('Network.webSocketFrameReceived', onWebSocket);
      await client.detach().catch(() => {});
    },
  };
}

export async function selectChatGptModelInUi(page, selectedModel) {
  const model = resolveChatGptModel(selectedModel);
  if (!model) throw new Error(`[chatgpt] Unknown model profile: ${selectedModel}`);
  const label = model.uiLabel;
  const labels = CHATGPT_MODEL_LEVELS.map(item => item.uiLabel);
  const opened = await page.evaluate(knownLabels => {
    const visible = element => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const firstLine = element => String(element.getAttribute('data-model-label') || element.getAttribute('aria-label') || element.textContent || '').split(/\r?\n/, 1)[0].trim();
    const controls = [...document.querySelectorAll('button,[role="button"]')].filter(visible);
    const opener = controls.find(element => /model/i.test(element.getAttribute('data-testid') || element.getAttribute('aria-label') || ''))
      || controls.find(element => knownLabels.some(candidate => firstLine(element) === candidate));
    if (!opener) return false;
    opener.click();
    return true;
  }, labels);
  if (!opened) throw new Error(`[chatgpt] Requested UI model ${label} is unavailable: model-picker-control-unavailable`);

  const versionSubmenuReady = await page.waitForFunction(expected => {
    const visible = element => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; };
    const firstLine = element => String(element.getAttribute('aria-label') || element.textContent || '').split(/\r?\n/, 1)[0].trim();
    return [...document.querySelectorAll('[role="menuitem"][data-has-submenu]')]
      .filter(visible)
      .some(element => firstLine(element) === expected);
  }, { timeout: UI_WAIT_TIMEOUT_MS }, 'GPT-5.6 Sol').then(() => true).catch(() => false);
  if (!versionSubmenuReady) throw new Error(`[chatgpt] Requested UI model ${label} is unavailable: model-version-submenu-unavailable`);

  const openedVersionSubmenu = await page.evaluate(expected => {
    const visible = element => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; };
    const firstLine = element => String(element.getAttribute('aria-label') || element.textContent || '').split(/\r?\n/, 1)[0].trim();
    const option = [...document.querySelectorAll('[role="menuitem"][data-has-submenu]')]
      .filter(visible)
      .find(element => firstLine(element) === expected);
    if (!option) return false;
    option.click();
    return true;
  }, 'GPT-5.6 Sol');
  if (!openedVersionSubmenu) throw new Error(`[chatgpt] Requested UI model ${label} is unavailable: model-version-submenu-disappeared`);

  const versionReady = await page.waitForFunction(expected => {
    const visible = element => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; };
    const firstLine = element => String(element.getAttribute('aria-label') || element.textContent || '').split(/\r?\n/, 1)[0].trim();
    return [...document.querySelectorAll('[role="menuitemradio"],[role="menuitem"]')]
      .filter(visible)
      .some(element => !element.hasAttribute('data-has-submenu') && firstLine(element) === expected);
  }, { timeout: UI_WAIT_TIMEOUT_MS }, 'GPT-5.6 Sol').then(() => true).catch(() => false);
  if (!versionReady) throw new Error(`[chatgpt] Requested UI model ${label} is unavailable: model-version-unavailable`);

  const clickedVersion = await page.evaluate(expected => {
    const visible = element => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; };
    const firstLine = element => String(element.getAttribute('aria-label') || element.textContent || '').split(/\r?\n/, 1)[0].trim();
    const option = [...document.querySelectorAll('[role="menuitemradio"],[role="menuitem"]')]
      .filter(visible)
      .find(element => !element.hasAttribute('data-has-submenu') && firstLine(element) === expected);
    if (!option) return false;
    option.click();
    return true;
  }, 'GPT-5.6 Sol');
  if (!clickedVersion) throw new Error(`[chatgpt] Requested UI model ${label} is unavailable: model-version-disappeared`);

  const reopened = await page.evaluate(knownLabels => {
    const visible = element => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; };
    const firstLine = element => String(element.getAttribute('data-model-label') || element.getAttribute('aria-label') || element.textContent || '').split(/\r?\n/, 1)[0].trim();
    const opener = [...document.querySelectorAll('button,[role="button"]')].filter(visible)
      .find(element => /model/i.test(element.getAttribute('data-testid') || element.getAttribute('aria-label') || ''))
      || [...document.querySelectorAll('button,[role="button"]')].filter(visible).find(element => knownLabels.some(candidate => firstLine(element) === candidate));
    if (!opener) return false;
    opener.click();
    return true;
  }, labels);
  if (!reopened) throw new Error(`[chatgpt] Requested UI model ${label} is unavailable: model-picker-control-unavailable-after-version`);

  const currentVersionConfirmed = await page.waitForFunction(expected => {
    const visible = element => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; };
    const firstLine = element => String(element.getAttribute('aria-label') || element.textContent || '').split(/\r?\n/, 1)[0].trim();
    return [...document.querySelectorAll('[role="menuitem"][data-has-submenu]')]
      .filter(visible)
      .some(element => firstLine(element) === expected);
  }, { timeout: UI_WAIT_TIMEOUT_MS }, 'GPT-5.6 Sol').then(() => true).catch(() => false);
  if (!currentVersionConfirmed) throw new Error(`[chatgpt] Requested UI model ${label} is unavailable: model-version-not-confirmed`);

  const optionReady = await page.waitForFunction(expected => {
    const visible = element => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; };
    const firstLine = element => String(element.getAttribute('data-model-label') || element.getAttribute('aria-label') || element.textContent || '').split(/\r?\n/, 1)[0].trim();
    return [...document.querySelectorAll('[role="menuitemradio"]')]
      .filter(visible)
      .some(element => firstLine(element) === expected);
  }, { timeout: UI_WAIT_TIMEOUT_MS }, label).then(() => true).catch(() => false);
  if (!optionReady) throw new Error(`[chatgpt] Requested UI model ${label} is unavailable: model-option-unavailable:${label}`);

  const clicked = await page.evaluate(expected => {
    const visible = element => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; };
    const firstLine = element => String(element.getAttribute('data-model-label') || element.getAttribute('aria-label') || element.textContent || '').split(/\r?\n/, 1)[0].trim();
    const option = [...document.querySelectorAll('[role="menuitemradio"]')]
      .filter(visible)
      .find(element => firstLine(element) === expected);
    if (!option) return false;
    option.click();
    return true;
  }, label);
  if (!clicked) throw new Error(`[chatgpt] Requested UI model ${label} is unavailable: model-option-disappeared:${label}`);

  const selected = await page.waitForFunction(expected => {
    const visible = element => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; };
    const firstLine = element => String(element.getAttribute('data-model-label') || element.getAttribute('aria-label') || element.textContent || '').split(/\r?\n/, 1)[0].trim();
    const opener = [...document.querySelectorAll('button,[role="button"]')].filter(visible)
      .find(element => ['Instant', 'Medium', 'High', 'Extra High', 'Pro'].includes(firstLine(element)));
    const checkedOption = [...document.querySelectorAll('[role="menuitemradio"]')]
      .some(element => firstLine(element) === expected && element.getAttribute('aria-checked') === 'true');
    return firstLine(opener) === expected || (checkedOption && (!opener || firstLine(opener) === expected));
  }, { timeout: UI_WAIT_TIMEOUT_MS }, label).then(() => true).catch(() => false);
  if (!selected) throw new Error(`[chatgpt] Requested UI model ${label} is unavailable: model-selection-not-visible`);
  return { ...model, verification: 'visible-ui-label' };
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !PRIVATE_KEYS.test(key))
    .map(([key, item]) => [key, redact(item)]));
}

export async function readChatGptConversation(page, conversationId) {
  if (!conversationId) return null;
  const detail = await page.evaluate(async id => {
    const sessionResponse = await fetch('/api/auth/session', { credentials: 'include' });
    const session = sessionResponse.ok ? await sessionResponse.json() : null;
    const accessToken = session?.accessToken;
    const accountId = session?.account?.id;
    if (typeof accessToken !== 'string' || !accessToken || typeof accountId !== 'string' || !accountId) return null;
    const headers = { Authorization: `Bearer ${accessToken}`, 'ChatGPT-Account-ID': accountId };
    const base = `/backend-api/conversation/${encodeURIComponent(id)}`;
    const read = url => fetch(url, { credentials: 'include', headers }).then(response => response.ok ? response.json() : null);
    const [conversation, streamStatus] = await Promise.all([read(base), read(`${base}/stream_status`)]);
    return { conversation, streamStatus };
  }, conversationId);
  return redact(detail);
}

function isPublicMessage(message) {
  const role = message?.author?.role;
  const contentType = message?.content?.content_type;
  return !!message
    && role !== 'system'
    && contentType !== 'model_editable_context'
    && contentType !== 'user_editable_context'
    && !message.is_visually_hidden_from_conversation
    && !message.metadata?.is_visually_hidden_from_conversation;
}

export function selectChatGptCurrentBranch(detail) {
  const conversation = detail?.conversation || detail || {};
  const mapping = conversation.mapping || {};
  let node = mapping[conversation.current_node];
  if (!node) return [];
  const reversed = [];
  while (node) {
    if (node.message) reversed.push(node.message);
    node = node.parent ? mapping[node.parent] : null;
  }
  const path = reversed.reverse();
  let latestUser = -1;
  for (let index = 0; index < path.length; index++) {
    if (path[index].author?.role === 'user' && path[index].content?.content_type !== 'user_editable_context') latestUser = index;
  }
  return latestUser < 0 ? [] : path.slice(latestUser).filter(isPublicMessage);
}

export function selectChatGptStructuredTurn(detail) {
  const messages = selectChatGptCurrentBranch(detail);
  const final = [...messages].reverse().find(message => message.author?.role === 'assistant'
    && message.channel === 'final'
    && message.status === 'finished_successfully'
    && message.end_turn === true);
  const text = final?.content?.parts?.filter(part => typeof part === 'string').join('\n') || '';
  const metadata = final?.metadata || {};
  return {
    messages: redact(messages),
    final: redact(final),
    text,
    modelSlug: metadata.model_slug || metadata.default_model_slug || null,
    thinkingEffort: metadata.thinking_effort || null,
    citations: redact(metadata.citations || final?.content?.citations || []),
    contentReferences: redact(metadata.content_references || final?.content?.content_references || []),
    searchResultGroups: redact(metadata.search_result_groups || final?.content?.search_result_groups || []),
  };
}

export function hasChatGptTerminalQuorum(detail) {
  const status = detail?.streamStatus?.status || detail?.stream_status?.status || detail?.conversation?.stream_status?.status;
  return status === 'COMPLETE' && !!selectChatGptStructuredTurn(detail).final;
}

function buildProviderState(snapshot, detail, extra = {}) {
  const structured = detail ? selectChatGptStructuredTurn(detail) : null;
  const quorum = detail ? hasChatGptTerminalQuorum(detail) : false;
  const timeout = !!extra.timeout;
  const hasText = !!(structured?.text || snapshot.text || '').trim();
  return redact({
    transport: snapshot.transport,
    requested_model_profile: snapshot.requestedModelProfile,
    observed_payload_model: snapshot.observedPayloadModel || null,
    observed_payload_thinking_effort: snapshot.observedPayloadThinkingEffort || null,
    model_verification: snapshot.modelVerification || { status: 'pending', verified: false },
    model_slug: structured?.modelSlug || snapshot.modelSlug || null,
    thinking_effort: structured?.thinkingEffort || snapshot.thinkingEffort || null,
    conversation_id: snapshot.conversationId || null,
    turn_exchange_id: snapshot.turnExchangeId || null,
    response_statuses: snapshot.responseStatuses || [],
    partial: !quorum && hasText,
    timeout,
    empty_response: !hasText,
    stream_state: {
      status: quorum ? 'completed' : (timeout ? (hasText ? 'timeout_partial' : 'timeout_empty') : (snapshot.handedOff ? 'stream_handoff' : 'pending')),
      stream_closed: !!snapshot.streamClosed,
      message_stream_complete: !!snapshot.messageStreamComplete,
      assistant_turn_complete: !!snapshot.assistantTurnComplete,
      end_turn: !!snapshot.endTurn,
      handed_off: !!snapshot.handedOff,
      resumed_stream: !!snapshot.resumedStream,
      persistent_complete: detail?.streamStatus?.status === 'COMPLETE',
      terminal_quorum: quorum,
    },
    structured_turn: structured ? {
      messages: structured.messages,
      citations: structured.citations,
      content_references: structured.contentReferences,
      search_result_groups: structured.searchResultGroups,
    } : null,
    ...extra,
  });
}

async function focusChatGptComposer(page) {
  return page.evaluate(() => {
    const selectors = '#prompt-textarea[contenteditable="true"],#prompt-textarea,[contenteditable="true"][role="textbox"],textarea[placeholder="Ask anything"],textarea';
    const element = [...document.querySelectorAll(selectors)].find(candidate => {
      const rect = candidate.getBoundingClientRect();
      return rect.width > 10 && rect.height > 10;
    });
    if (!element) return false;
    element.focus();
    return document.activeElement === element;
  }).catch(() => false);
}

async function chatGptComposerState(page) {
  return page.evaluate(() => {
    const selectors = '#prompt-textarea[contenteditable="true"],#prompt-textarea,[contenteditable="true"][role="textbox"],textarea[placeholder="Ask anything"],textarea';
    const element = [...document.querySelectorAll(selectors)].find(candidate => {
      const rect = candidate.getBoundingClientRect();
      return rect.width > 10 && rect.height > 10;
    });
    const text = (element?.value || element?.textContent || '').trim();
    const sendReady = [...document.querySelectorAll('button')].some(button => {
      const rect = button.getBoundingClientRect();
      const label = button.getAttribute('aria-label') || '';
      const testId = button.getAttribute('data-testid') || '';
      return rect.width > 0 && rect.height > 0 && !button.disabled
        && (/send prompt|send message/i.test(label) || /send-button/i.test(testId));
    });
    return { focused: document.activeElement === element, text, sendReady };
  }).catch(() => ({ focused: false, text: '', sendReady: false }));
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
  const details = { key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode, modifiers };
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', ...details });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...details });
}

export const chatgptProvider = {
  name: 'chatgpt',
  url: CHATGPT_ORIGIN,
  trustedConversationHostnames: CHATGPT_HOSTNAMES,
  transport: 'network-incremental-sse',
  defaultModel: 'extra-high',
  taskModels: { default: 'extra-high', quick: 'instant', reasoning: 'high', pro: 'pro' },
  historyPolicy: { default: 'provider-history', transportField: 'conversation_mode.kind' },
  async listModels({ request } = {}) {
    return { model_source: 'chatgpt-ui-picker-profiles', account_specific: true, verification: { enabled: !!request?.verifyModels, status: 'ui-selection-required' }, models: CHATGPT_MODEL_LEVELS.map(chatGptModelRecord) };
  },
  resolveConversationAttachment({ target }) {
    const value = String(target || '').trim();
    if (!value) throw new Error('[chatgpt] Conversation attachment is empty');
    const id = /^https?:\/\//i.test(value) ? chatGptConversationIdFromUrl(value) : value;
    return { type: /^https?:\/\//i.test(value) ? 'url' : 'provider_id', url: chatGptConversationUrl(id), providerId: id, providerState: { conversation_id: id } };
  },
  conversationUrlFromState({ conversation } = {}) {
    const state = conversation?.record?.provider_state || conversation?.providerState || {};
    return chatGptConversationUrl(state.conversation_id || conversation?.provider_id) || conversation?.url || null;
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
    if (!isChatGptUrl(page.url()) || (request?.conversationTarget && /^https?:/.test(request.conversationTarget))) {
      await page.goto(request?.conversationTarget || this.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }
    return page;
  },
  async createAttemptContext({ page, selectedModel }) {
    return { networkTracker: await createChatGptNetworkTracker({ page, selectedModel }) };
  },
  async disposeAttemptContext({ attemptContext }) {
    await attemptContext?.networkTracker?.dispose?.();
  },
  async recheckConversation({ browser, selectedModel, conversation }) {
    const url = this.conversationUrlFromState({ conversation });
    if (!url) throw new Error('[chatgpt] Cannot recheck without a ChatGPT conversation id.');
    const pages = await browser.pages();
    const page = pages.find(candidate => candidate.url() === url) || await browser.newPage({ background: true });
    if (page.url() !== url) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const id = chatGptConversationIdFromUrl(url);
    const detail = await readChatGptConversation(page, id);
    const snapshot = { ...initialState(resolveChatGptModel(selectedModel) || resolveChatGptModel()), conversationId: id };
    const turn = selectChatGptStructuredTurn(detail);
    return { text: turn.text.trim(), rawText: '', done: hasChatGptTerminalQuorum(detail), modelUsed: turn.modelSlug || resolveChatGptModel(selectedModel)?.model, finalUrl: url, providerState: buildProviderState(snapshot, detail, { recheck: true }), searchResults: turn.searchResultGroups };
  },
  async setModel({ page, model, selectedModel }) {
    return selectChatGptModelInUi(page, selectedModel || model);
  },
  async beforeSubmit() {},
  async clearInput({ page }) {
    if (!await focusChatGptComposer(page)) throw new Error('[chatgpt] Prompt input not found or could not be focused.');
    await withChatGptInputClient(page, async client => {
      await dispatchChatGptKey(client, { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4 });
      await dispatchChatGptKey(client, { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    });
    const state = await chatGptComposerState(page);
    if (!state.focused || state.text) throw new Error('[chatgpt] Failed to clear the prompt composer with browser-native input.');
  },
  async typePrompt({ page, prompt }) {
    if (!await focusChatGptComposer(page)) throw new Error('[chatgpt] Prompt input not found or could not be focused.');
    await withChatGptInputClient(page, async client => {
      await client.send('Input.insertText', { text: prompt });
    });
    const state = await chatGptComposerState(page);
    if (!state.focused || state.text !== String(prompt).trim() || !state.sendReady) {
      throw new Error('[chatgpt] Browser-native input did not populate the composer or enable Send.');
    }
  },
  async submit({ page }) {
    const submitted = await page.evaluate(() => {
      const button = [...document.querySelectorAll('button')].find(element => !element.disabled && (/send prompt|send message/i.test(element.getAttribute('aria-label') || '') || /send-button/i.test(element.getAttribute('data-testid') || '')));
      if (!button) return false;
      button.click();
      return true;
    });
    if (!submitted) throw new Error('[chatgpt] Send button is unavailable. The prompt was not submitted.');
  },
  async waitForResponse({ page, timeoutMs, networkTracker, selectedModel }) {
    const maxPolls = Math.ceil(timeoutMs / 1000);
    let last = networkTracker?.snapshot?.() || initialState(resolveChatGptModel(selectedModel) || resolveChatGptModel());
    for (let attempt = 0; attempt < maxPolls; attempt++) {
      last = networkTracker?.snapshot?.() || last;
      if (last.error) throw new Error(last.error);
      const detail = last.conversationId ? await readChatGptConversation(page, last.conversationId).catch(() => null) : null;
      if (detail && hasChatGptTerminalQuorum(detail)) {
        const turn = selectChatGptStructuredTurn(detail);
        return { text: turn.text.trim(), rawText: turn.text.trim(), done: true, modelUsed: turn.modelSlug || last.modelSlug || resolveChatGptModel(selectedModel)?.model, finalUrl: chatGptConversationUrl(last.conversationId) || page.url(), providerState: buildProviderState(last, detail), searchResults: turn.searchResultGroups };
      }
      await sleep(1000);
    }
    const detail = last.conversationId ? await readChatGptConversation(page, last.conversationId).catch(() => null) : null;
    const turn = detail ? selectChatGptStructuredTurn(detail) : null;
    const text = (turn?.text || last.text || '').trim();
    return { text, rawText: text, done: false, modelUsed: turn?.modelSlug || last.modelSlug || resolveChatGptModel(selectedModel)?.model, finalUrl: chatGptConversationUrl(last.conversationId) || page.url(), providerState: buildProviderState(last, detail, { timeout: true }), searchResults: turn?.searchResultGroups || [] };
  },
};
