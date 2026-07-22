import { sleep, urlHasAllowedHostname } from './shared.mjs';

const CHATGPT_ORIGIN = 'https://chatgpt.com';
const CHATGPT_HOSTNAMES = ['chatgpt.com', 'www.chatgpt.com'];
const CHATGPT_CONVERSATION_ENDPOINT = '/backend-api/f/conversation';
const PRIVATE_KEYS = /(?:authorization|cookie|token|sentinel|conduit|turnstile|proof|resume|secret|credential|password|api[_-]?key|signature|(?:^|[_-])sig(?:$|[_-])|(?:aws|google)[_-]?access[_-]?(?:key[_-]?)?id|x[-_]?(?:amz|goog)[-_]?(?:credential|security[-_]?token|signature))/i;
const SENSITIVE_STRING_KEY = '(?:[a-z0-9_-]*(?:auth(?:orization)?|session|cookie|token|secret|credential|password|signature)[a-z0-9_-]*|(?:[a-z0-9_-]*(?:api|access)[_-]?key[a-z0-9_-]*)|sig|(?:aws|google)[_-]?access[_-]?(?:key[_-]?)?id|x[-_]?(?:amz|goog)[-_]?(?:credential|security[-_]?token|signature))';
const UI_WAIT_TIMEOUT_MS = 5_000;
export const CHATGPT_PROVIDER_ID_OBSERVATION_TIMEOUT_MS = 30_000;

export function chatGptSubmissionObservationTimeoutMs(timeoutMs) {
  const requested = Number(timeoutMs);
  return Math.max(1, Math.min(Number.isFinite(requested) && requested > 0 ? requested : CHATGPT_PROVIDER_ID_OBSERVATION_TIMEOUT_MS, CHATGPT_PROVIDER_ID_OBSERVATION_TIMEOUT_MS));
}

function isChatGptUrl(url) {
  return urlHasAllowedHostname(url, CHATGPT_HOSTNAMES);
}

export function normalizeChatGptConversationId(value) {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(id)) throw new Error('[chatgpt] Invalid provider conversation id.');
  return id;
}

export function chatGptConversationUrl(id) {
  if (id === null || id === undefined || String(id).trim() === '') return null;
  return `${CHATGPT_ORIGIN}/c/${encodeURIComponent(normalizeChatGptConversationId(id))}`;
}

export function chatGptConversationIdFromUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('[chatgpt] Invalid conversation URL.'); }
  if (parsed.protocol !== 'https:' || !CHATGPT_HOSTNAMES.includes(parsed.hostname.toLowerCase()) || parsed.search || parsed.hash) {
    throw new Error('[chatgpt] Conversation URL must be a trusted chatgpt.com /c/<id> URL.');
  }
  const encoded = parsed.pathname.match(/^\/c\/([^/]+)$/)?.[1];
  if (!encoded) throw new Error('[chatgpt] Conversation URL must use /c/<id>.');
  try { return normalizeChatGptConversationId(decodeURIComponent(encoded)); } catch { throw new Error('[chatgpt] Invalid provider conversation id.'); }
}

export function resolveChatGptConversationTarget(target) {
  const value = String(target || '').trim();
  const id = /^https?:\/\//i.test(value) ? chatGptConversationIdFromUrl(value) : normalizeChatGptConversationId(value);
  return { providerId: id, url: chatGptConversationUrl(id) };
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

function initialState(model, preserveSelection = false) {
  return {
    text: '', rawItems: [], searchResults: [], done: false, streamClosed: false,
    streamClosedCount: 0, assistantTurnComplete: false, handedOff: false,
    awaitingResume: false, resumedStream: false, responseStatuses: [],
    requestedModelProfile: preserveSelection ? null : model.id,
    modelVerification: preserveSelection ? { status: 'observed', verified: false, preserved_selection: true } : { status: 'pending', verified: false },
    transport: 'network-incremental-sse',
  };
}

export async function createChatGptNetworkTracker({ page, selectedModel, expectedConversationId = null, preserveSelection = false, sleepFn = sleep, now = Date.now, onStreamEvent = null }) {
  const modelConfig = resolveChatGptModel(selectedModel) || resolveChatGptModel();
  const client = await page.target().createCDPSession();
  let state = initialState(modelConfig, preserveSelection);
  let disposed = false;
  let finalRequestId = null;
  let decoder = null;
  let streamSetup = null;
  let fatalProgressError = null;
  const streamed = new Set();
  const emitted = { session: false, statuses: new Set(), deltas: new Set() };

  function recordFatalProgressError(error) {
    if (fatalProgressError) return;
    fatalProgressError = new Error('Failed to emit ChatGPT stream progress.');
    fatalProgressError.code = error?.code === 'stream_file_error' ? 'stream_file_error' : 'chatgpt_stream_progress_error';
  }

  function throwIfFatalProgressError() {
    if (fatalProgressError) throw fatalProgressError;
  }

  function update(next) {
    if (fatalProgressError) return;
    const previous = state;
    if (expectedConversationId && next.requestConversationId && next.requestConversationId !== expectedConversationId) next.error = '[chatgpt] Submission request conversation id did not match the requested provider conversation id.';
    if (expectedConversationId && next.conversationId && next.conversationId !== expectedConversationId) next.error = '[chatgpt] Submission stream conversation id did not match the requested provider conversation id.';
    state = next;
    if (state.error) return;
    try {
      emitTrackerChanges(previous, state, onStreamEvent, emitted);
    } catch (error) {
      recordFatalProgressError(error);
    }
  }

  function recordObservedPayload(postData) {
    try {
      const payload = JSON.parse(postData || '{}');
      state.requestConversationId = payload.conversation_id || null;
      if (expectedConversationId && state.requestConversationId && state.requestConversationId !== expectedConversationId) state.error = '[chatgpt] Submission request conversation id did not match the requested provider conversation id.';
      state.observedPayloadModel = payload.model || null;
      state.observedPayloadThinkingEffort = payload.thinking_effort || null;
      state.modelVerification = preserveSelection
        ? { status: 'observed', verified: false, preserved_selection: true, observed_model: state.observedPayloadModel || null, observed_thinking_effort: state.observedPayloadThinkingEffort || null }
        : verifyChatGptObservedModel(modelConfig, state.observedPayloadModel, state.observedPayloadThinkingEffort);
    } catch {
      state.modelVerification = { status: 'unavailable', verified: false };
    }
  }

  function consume(base64) {
    if (!base64 || !decoder) return;
    update(applySseEvents(decoder.push(base64), state));
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
    if (state.error) return;
    const response = event.response || {};
    let responsePath = '';
    try { responsePath = new URL(response.url || CHATGPT_ORIGIN).pathname; } catch {}
    state.responseStatuses.push({ url: responsePath, status: response.status, mimeType: response.mimeType || null });
    state.acceptedResponse = response.status >= 200 && response.status < 300 && /event-stream/i.test(response.mimeType || '');
    try {
      emitTrackerChanges({ ...state, acceptedResponse: false }, state, onStreamEvent, emitted);
    } catch (error) {
      recordFatalProgressError(error);
      return;
    }
    if (!state.acceptedResponse) return;
    decoder = createChatGptSseDecoder();
    streamSetup = (async () => {
      try {
        const result = await client.send('Network.streamResourceContent', { requestId: event.requestId });
        streamed.add(event.requestId);
        consume(result.bufferedData);
      } catch (error) {
        state.incrementalUnsupported = error.message;
      }
    })();
    await streamSetup;
  };
  const onData = event => {
    if (event.requestId === finalRequestId && streamed.has(event.requestId)) consume(event.data);
  };
  const onFinished = async event => {
    if (event.requestId !== finalRequestId) return;
    // Loading can finish before CDP finishes enabling incremental content.
    // Wait for setup before deciding whether the full-body fallback is needed.
    if (streamSetup) await streamSetup;
    if (decoder) update(applySseEvents(decoder.flush(), state));
    if (streamed.has(event.requestId) && state.incrementalBytes) return;
    try {
      const body = await client.send('Network.getResponseBody', { requestId: event.requestId });
      if (!body.body) state.networkResponseEmpty = true;
      else update(extractChatGptStreamStateFromEncodedItem(body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body, state));
    } catch (error) {
      state.responseBodyError = error.message;
    }
  };
  const onWebSocket = event => {
    update(extractChatGptWebSocketPayload(event.response?.payloadData || '', state));
  };

  client.on('Network.requestWillBeSent', onRequest);
  client.on('Network.responseReceived', onResponse);
  client.on('Network.dataReceived', onData);
  client.on('Network.loadingFinished', onFinished);
  client.on('Network.webSocketFrameReceived', onWebSocket);
  return {
    modelConfig,
    snapshot: () => ({ ...state }),
    throwIfFatalProgressError,
    async waitForSubmission(timeoutMs) {
      const deadline = now() + timeoutMs;
      while (now() <= deadline) {
        throwIfFatalProgressError();
        const snapshot = { ...state };
        const rejected = snapshot.responseStatuses.find(item => item.status >= 400);
        if (rejected) throw new Error(`[chatgpt] Submission failed with HTTP ${rejected.status}.`);
        if (expectedConversationId && snapshot.requestConversationId && snapshot.requestConversationId !== expectedConversationId) {
          throw new Error('[chatgpt] Submission request conversation id did not match the requested provider conversation id.');
        }
        if (expectedConversationId && snapshot.conversationId && snapshot.conversationId !== expectedConversationId) {
          throw new Error('[chatgpt] Submission stream conversation id did not match the requested provider conversation id.');
        }
        if (snapshot.acceptedResponse && snapshot.conversationId) return snapshot;
        await sleepFn(100);
      }
      throwIfFatalProgressError();
      const rejected = state.responseStatuses.find(item => item.status >= 400);
      if (rejected) throw new Error(`[chatgpt] Submission failed with HTTP ${rejected.status}.`);
      if (state.acceptedResponse) throw new Error('[chatgpt] Submission may have occurred, but no provider conversation id was observed before timeout.');
      throw new Error('[chatgpt] Submission was not accepted before timeout.');
    },
    reset() {
      state = initialState(modelConfig, preserveSelection);
      finalRequestId = null;
      decoder = null;
      streamSetup = null;
      fatalProgressError = null;
      streamed.clear();
      emitted.session = false;
      emitted.statuses.clear();
      emitted.deltas.clear();
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

function redactString(value) {
  const sensitiveKey = new RegExp(`((?:["']${SENSITIVE_STRING_KEY}["'])\\s*:\\s*["'])([^"']*)(["'])`, 'gi');
  const assignment = new RegExp(`((?:${SENSITIVE_STRING_KEY})\\s*[=:]\\s*)([^\\s,;?&#}\\]]+)`, 'gi');
  const query = new RegExp(`([?&]${SENSITIVE_STRING_KEY}=)[^&#\\s"']+`, 'gi');
  return String(value)
    .replace(/(Bearer\s+)[^\s,;]+/gi, '$1[redacted]')
    .replace(sensitiveKey, '$1[redacted]$3')
    .replace(assignment, '$1[redacted]')
    .replace(query, '$1[redacted]');
}

function redact(value, key = '') {
  if (PRIVATE_KEYS.test(key)) return '[redacted]';
  if (Array.isArray(value)) return value.map(item => redact(item));
  if (!value || typeof value !== 'object') return typeof value === 'string' ? redactString(value) : value;
  return Object.fromEntries(Object.entries(value).map(([itemKey, item]) => [itemKey, redact(item, itemKey)]));
}

function safeStreamEvent(onStreamEvent, event, payload = {}) {
  if (typeof onStreamEvent !== 'function') return;
  onStreamEvent({ event, provider_conversation_id: payload.provider_conversation_id || null, source: payload.source || 'live-cdp', ...redact(payload) });
}

function emitTrackerChanges(previous, next, onStreamEvent, emitted) {
  const id = next.conversationId || null;
  if (id && !emitted.session) {
    emitted.session = true;
    safeStreamEvent(onStreamEvent, 'session', { provider_conversation_id: id, url: chatGptConversationUrl(id), source: 'live-cdp' });
  }
  const statuses = [];
  if (next.acceptedResponse && !previous.acceptedResponse) statuses.push('submitted');
  if (next.handedOff && !previous.handedOff) statuses.push('stream_handoff');
  if (next.resumedStream && !previous.resumedStream) statuses.push('resumed');
  if (next.messageStreamComplete && !previous.messageStreamComplete) statuses.push('message_stream_complete');
  if (next.assistantTurnComplete && !previous.assistantTurnComplete) statuses.push('assistant_turn_complete');
  if (next.endTurn && !previous.endTurn) statuses.push('end_turn');
  for (const status of statuses) {
    if (emitted.statuses.has(status)) continue;
    emitted.statuses.add(status);
    safeStreamEvent(onStreamEvent, 'status', { provider_conversation_id: id, status, source: 'live-cdp' });
  }
  const before = previous.text || '';
  const after = next.text || '';
  if (after.length > before.length && after.startsWith(before)) {
    const delta = after.slice(before.length);
    if (delta && !emitted.deltas.has(`${after.length}:${delta}`)) {
      emitted.deltas.add(`${after.length}:${delta}`);
      safeStreamEvent(onStreamEvent, 'delta', { provider_conversation_id: id, text: delta, source: 'live-cdp' });
    }
  }
}

function emitSnapshotMessages(onStreamEvent, id, detail, fingerprints, source) {
  for (const message of selectChatGptCurrentBranch(detail).map(item => redact(item))) {
    const messageId = message?.id || JSON.stringify(message);
    const fingerprint = JSON.stringify(message);
    const previous = fingerprints.get(messageId);
    if (previous === fingerprint) continue;
    fingerprints.set(messageId, fingerprint);
    safeStreamEvent(onStreamEvent, 'message', {
      provider_conversation_id: id,
      message,
      change: previous === undefined ? 'new' : 'changed',
      source,
    });
  }
}

export async function readChatGptConversation(page, conversationId) {
  if (!conversationId) return null;
  const outcome = await page.evaluate(async id => {
    const sessionResponse = await fetch('/api/auth/session', { credentials: 'include' });
    if (!sessionResponse.ok) return { error: { kind: 'auth', status: sessionResponse.status || 0 } };
    const session = await sessionResponse.json();
    const accessToken = session?.accessToken;
    const accountId = session?.account?.id;
    if (typeof accessToken !== 'string' || !accessToken || typeof accountId !== 'string' || !accountId) return { error: { kind: 'auth', status: 0 } };
    const headers = { Authorization: `Bearer ${accessToken}`, 'ChatGPT-Account-ID': accountId };
    const base = `/backend-api/conversation/${encodeURIComponent(id)}`;
    const read = async (url, kind) => {
      const response = await fetch(url, { credentials: 'include', headers });
      if (!response.ok) return { error: { kind, status: response.status || 0 } };
      return { value: await response.json() };
    };
    const [conversation, streamStatus] = await Promise.all([read(base, 'detail'), read(`${base}/stream_status`, 'status')]);
    return { error: conversation.error || streamStatus.error || null, detail: conversation.error || streamStatus.error ? null : { conversation: conversation.value, streamStatus: streamStatus.value } };
  }, conversationId);
  if (outcome?.error?.kind === 'auth') {
    throw new Error('[chatgpt] Authentication is unavailable or expired. Recovery: sign in to ChatGPT in the configured Chrome profile, then resync the AI Chat Browser Tools profile and retry.');
  }
  if (outcome?.error?.kind === 'detail' && outcome.error.status === 404) {
    throw new Error('[chatgpt] Provider conversation id is invalid or unavailable (detail HTTP 404).');
  }
  if (outcome?.error) throw new Error(`[chatgpt] Conversation ${outcome.error.kind} read failed with HTTP ${outcome.error.status || 'unknown'}.`);
  return redact(outcome?.detail || null);
}

export async function listChatGptConversations({ browser, limit = 20, now = () => new Date().toISOString() } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('[chatgpt] conversation limit must be between 1 and 100.');
  const pages = await browser.pages();
  const page = pages.find(candidate => isChatGptUrl(candidate.url())) || await browser.newPage({ background: true });
  if (!isChatGptUrl(page.url())) await page.goto(CHATGPT_ORIGIN, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const result = await page.evaluate(async requestedLimit => {
    const sensitiveKey = '(?:[a-z0-9_-]*(?:auth(?:orization)?|session|cookie|token|secret|credential|password|signature)[a-z0-9_-]*|(?:[a-z0-9_-]*(?:api|access)[_-]?key[a-z0-9_-]*)|sig|(?:aws|google)[_-]?access[_-]?(?:key[_-]?)?id|x[-_]?(?:amz|goog)[-_]?(?:credential|security[-_]?token|signature))';
    const clean = value => String(value ?? '')
      .replace(/(Bearer\s+)[^\s,;]+/gi, '$1[redacted]')
      .replace(new RegExp(`((?:["']${sensitiveKey}["'])\\s*:\\s*["'])([^"']*)(["'])`, 'gi'), '$1[redacted]$3')
      .replace(new RegExp(`((?:${sensitiveKey})\\s*[=:]\\s*)([^\\s,;?&#}\\]]+)`, 'gi'), '$1[redacted]');
    const allowedStatusValues = new Set([
      'not_started', 'pending', 'queued', 'running', 'in_progress', 'complete', 'completed',
      'finished', 'failed', 'error', 'cancelled', 'canceled', 'stopped', 'expired',
    ]);
    const statusToken = value => {
      if (typeof value !== 'string') return null;
      const token = clean(value);
      const normalized = token.trim().toLowerCase().replace(/[\s-]+/g, '_');
      return allowedStatusValues.has(normalized) ? token : null;
    };
    const safeStatus = value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const status = {};
      const state = statusToken(value.state);
      const statusValue = statusToken(value.status);
      if (state) status.state = state;
      if (statusValue) status.status = statusValue;
      if (typeof value.progress === 'number' && Number.isFinite(value.progress)) status.progress = value.progress;
      if (typeof value.done === 'boolean') status.done = value.done;
      return Object.keys(status).length > 0 ? status : null;
    };
    const sessionResponse = await fetch('/api/auth/session', { credentials: 'include' });
    if (!sessionResponse.ok) return { error: { kind: 'auth', status: sessionResponse.status || 0 } };
    const session = await sessionResponse.json();
    const token = session?.accessToken;
    const accountId = session?.account?.id;
    if (!token || !accountId) return { error: { kind: 'auth', status: 0 } };
    const response = await fetch(`/backend-api/conversations?offset=0&limit=${requestedLimit}&order=updated`, { method: 'GET', credentials: 'include', headers: { Authorization: `Bearer ${token}`, 'ChatGPT-Account-ID': accountId } });
    if (!response.ok) return { error: { kind: 'list', status: response.status || 0 } };
    const body = await response.json();
    const items = Array.isArray(body?.items) ? body.items : [];
    return { total: Number(body?.total) || items.length, items: items.map(item => ({
      provider_conversation_id: typeof item?.id === 'string' ? item.id : null,
      title: clean(item?.title || ''),
      created_at: item?.create_time ?? null,
      updated_at: item?.update_time ?? null,
      current_node: item?.current_node ?? null,
      async_status: safeStatus(item?.async_status),
      is_temporary: !!item?.is_temporary_chat,
      is_archived: !!item?.is_archived,
      is_starred: !!item?.is_starred,
    })).filter(item => item.provider_conversation_id), };
  }, limit);
  if (result?.error?.kind === 'auth') throw new Error('[chatgpt] Authentication is unavailable or expired. Recovery: sign in to ChatGPT in the configured Chrome profile, then retry.');
  if (result?.error) throw new Error(`[chatgpt] Conversation listing read failed with HTTP ${result.error.status || 'unknown'}.`);
  const conversations = result.items.flatMap(item => {
      try { return [{ ...item, provider_conversation_id: normalizeChatGptConversationId(item.provider_conversation_id), conversation_url: chatGptConversationUrl(item.provider_conversation_id) }]; } catch { return []; }
    });
  return { provider: 'chatgpt', count: conversations.length, total: result.total, limit, offset: 0, captured_at: now(), conversations };
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
  const text = redactString(final?.content?.parts?.filter(part => typeof part === 'string').join('\n') || '');
  const metadata = final?.metadata || {};
  const user = messages.find(message => message.author?.role === 'user') || null;
  const startedAt = user?.create_time ?? final?.create_time ?? null;
  const completedAt = final?.update_time ?? final?.create_time ?? null;
  return {
    messages: redact(messages),
    final: redact(final),
    text,
    modelSlug: metadata.model_slug || metadata.default_model_slug || null,
    thinkingEffort: metadata.thinking_effort || null,
    citations: redact(metadata.citations || final?.content?.citations || []),
    contentReferences: redact(metadata.content_references || final?.content?.content_references || []),
    searchResultGroups: redact(metadata.search_result_groups || final?.content?.search_result_groups || []),
    storyEvents: redact(metadata.story_events || final?.metadata?.story_events || []),
    userMessageId: user?.id || null,
    assistantMessageId: final?.id || null,
    turnExchangeId: metadata.turn_exchange_id || final?.turn_exchange_id || null,
    startedAt,
    completedAt,
  };
}

export function isChatGptTemporaryConversation(detailOrListing) {
  // Detail responses use is_temporary_chat. Listings are intentionally accepted too,
  // so callers cannot mistake a provider-supplied temporary record for persistence.
  const detail = detailOrListing?.conversation || detailOrListing || {};
  return detail?.is_temporary_chat === true || detail?.is_temporary === true;
}

function rejectChatGptTemporaryConversation(detailOrListing) {
  if (isChatGptTemporaryConversation(detailOrListing)) {
    throw new Error('[chatgpt] Temporary conversations cannot be continued, reattached, or read as detached output. Start a persistent conversation instead.');
  }
}

export function hasChatGptTerminalQuorum(detail) {
  const status = detail?.streamStatus?.status || detail?.stream_status?.status || detail?.conversation?.stream_status?.status;
  return status === 'COMPLETE' && !!selectChatGptStructuredTurn(detail).final;
}

function isTransientChatGptDetailError(error) {
  return /\[chatgpt\] Conversation (?:detail|status) read failed with HTTP (?:408|429|5\d\d)\./.test(String(error?.message || ''));
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
    model_slug: structured?.modelSlug || snapshot.modelSlug || snapshot.observedPayloadModel || null,
    thinking_effort: structured?.thinkingEffort || snapshot.thinkingEffort || snapshot.observedPayloadThinkingEffort || null,
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
      user_message_id: structured.userMessageId,
      assistant_message_id: structured.assistantMessageId,
      turn_exchange_id: structured.turnExchangeId || snapshot.turnExchangeId || null,
      citations: structured.citations,
      content_references: structured.contentReferences,
      search_result_groups: structured.searchResultGroups,
      story_events: structured.storyEvents,
      started_at: structured.startedAt,
      completed_at: structured.completedAt,
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
  capabilities: { localConversationState: false, cachePolicy: 'none', supportsSubmitOnly: true, supportsFinal: true, supportsConversationListing: true, streamFormat: 'ndjson', requiresPreSubmitTextRead: false },
  async listModels({ request } = {}) {
    return { model_source: 'chatgpt-ui-picker-profiles', account_specific: true, verification: { enabled: !!request?.verifyModels, status: 'ui-selection-required' }, models: CHATGPT_MODEL_LEVELS.map(chatGptModelRecord) };
  },
  async listConversations({ browser, request }) {
    return listChatGptConversations({ browser, limit: request?.conversationLimit || 20 });
  },
  resolveConversationAttachment({ target }) {
    const value = String(target || '').trim();
    if (!value) throw new Error('[chatgpt] Conversation attachment is empty');
    const { providerId: id, url } = resolveChatGptConversationTarget(value);
    return { type: /^https?:\/\//i.test(value) ? 'url' : 'provider_id', url, providerId: id, providerState: { conversation_id: id } };
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
    const target = request?.conversationTarget ? resolveChatGptConversationTarget(request.conversationTarget) : null;
    const pages = await browser.pages();
    let page = target ? pages.find(candidate => candidate.url() === target.url) : pages.find(candidate => isChatGptUrl(candidate.url()));
    if (!page) page = await browser.newPage({ background: true });
    if (!isChatGptUrl(page.url()) || target) {
      await page.goto(target?.url || this.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }
    if (target && (() => { try { return chatGptConversationIdFromUrl(page.url()) !== target.providerId; } catch { return true; } })()) throw new Error('[chatgpt] Loaded page identity does not match the requested provider conversation id.');
    return page;
  },
  async preflight({ page, request, conversation, readConversation = readChatGptConversation }) {
    const expected = conversation?.providerId || (request?.conversationTarget ? resolveChatGptConversationTarget(request.conversationTarget).providerId : null);
    if (!expected) return;
    let loaded;
    try { loaded = chatGptConversationIdFromUrl(page.url()); } catch { throw new Error('[chatgpt] Loaded page is not the requested trusted provider conversation URL.'); }
    if (loaded !== expected) throw new Error('[chatgpt] Loaded page identity does not match the requested provider conversation id.');
    const baseline = await readConversation(page, expected);
    rejectChatGptTemporaryConversation(baseline);
    const baselineNode = baseline?.conversation?.current_node || null;
    if (!baselineNode) throw new Error('[chatgpt] Conversation detail or baseline current node is unavailable; refusing continuation before submission.');
    return { expectedConversationId: expected, baselineCurrentNode: baselineNode };
  },
  async createAttemptContext({ page, selectedModel, onStreamEvent, request, conversation, preflightContext }) {
    const expectedConversationId = preflightContext?.expectedConversationId || conversation?.providerId || null;
    const preserveSelection = !!(expectedConversationId && !request?.modelExplicit && !request?.modelTask);
    return { expectedConversationId, baselineCurrentNode: preflightContext?.baselineCurrentNode || null, preserveSelection, networkTracker: await createChatGptNetworkTracker({ page, selectedModel, expectedConversationId, preserveSelection, onStreamEvent }) };
  },
  async disposeAttemptContext({ attemptContext }) {
    await attemptContext?.networkTracker?.dispose?.();
  },
  async recheckConversation({ browser, selectedModel, conversation, request, onStreamEvent = null, readConversation = readChatGptConversation, sleepFn = sleep, now = Date.now }) {
    const url = this.conversationUrlFromState({ conversation });
    if (!url) throw new Error('[chatgpt] Cannot recheck without a ChatGPT conversation id.');
    const pages = await browser.pages();
    const page = pages.find(candidate => candidate.url() === url) || await browser.newPage({ background: true });
    if (page.url() !== url) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const id = conversation?.providerId || chatGptConversationIdFromUrl(url);
    const deadline = now() + ((request?.timeoutSeconds || 300) * 1000);
    let detail = null;
    let lastStatus = null;
    const fingerprints = new Map();
    do {
      detail = await readConversation(page, id);
      // This first authenticated detail read is the trust boundary. Do not emit a
      // session or snapshot before rejecting a provider-marked temporary chat.
      rejectChatGptTemporaryConversation(detail);
      if (!lastStatus) safeStreamEvent(onStreamEvent, 'session', { provider_conversation_id: id, url, source: 'provider-snapshot' });
      const status = detail?.streamStatus?.status || detail?.stream_status?.status || detail?.conversation?.stream_status?.status || 'UNKNOWN';
      if (status !== lastStatus) {
        lastStatus = status;
        safeStreamEvent(onStreamEvent, 'status', { provider_conversation_id: id, status: status === 'COMPLETE' ? 'completion_evidence' : 'in_progress', source: 'provider-snapshot' });
      }
      emitSnapshotMessages(onStreamEvent, id, detail, fingerprints, 'provider-snapshot');
      if (hasChatGptTerminalQuorum(detail)) break;
      if (now() >= deadline) break;
      await sleepFn(1000);
    } while (true);
    const snapshot = { ...initialState(resolveChatGptModel(selectedModel) || resolveChatGptModel()), conversationId: id };
    const turn = selectChatGptStructuredTurn(detail);
    const done = hasChatGptTerminalQuorum(detail);
    return { text: turn.text.trim(), rawText: '', done, status: done ? 'complete' : 'in_progress', providerConversationId: id, modelUsed: turn.modelSlug || resolveChatGptModel(selectedModel)?.model, finalUrl: url, providerState: buildProviderState(snapshot, detail, { recheck: true, timeout: !done }), searchResults: turn.searchResultGroups };
  },
  async setModel({ page, model, selectedModel }) {
    return selectChatGptModelInUi(page, selectedModel || model);
  },
  shouldSetModel({ request, conversation }) {
    return !(conversation?.providerId && !request?.modelExplicit && !request?.modelTask);
  },
  preserveContinuationModel({ request, conversation }) {
    return !!(conversation?.providerId && !request?.modelExplicit && !request?.modelTask);
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
  async waitForResponse({ page, timeoutMs, networkTracker, selectedModel, request, attemptContext = null, onStreamEvent = null, readConversation = readChatGptConversation, sleepFn = sleep }) {
    networkTracker?.throwIfFatalProgressError?.();
    if (request?.submitOnly) {
      const snapshot = await networkTracker.waitForSubmission(chatGptSubmissionObservationTimeoutMs(timeoutMs));
      networkTracker?.throwIfFatalProgressError?.();
      const id = normalizeChatGptConversationId(snapshot.conversationId);
      return { text: '', rawText: '', done: false, status: 'submitted', providerConversationId: id, modelUsed: snapshot.modelSlug || snapshot.observedPayloadModel || (selectedModel === 'default' ? null : resolveChatGptModel(selectedModel)?.model), finalUrl: chatGptConversationUrl(id), providerState: buildProviderState(snapshot, null, { submitted: true }) };
    }
    const maxPolls = Math.ceil(timeoutMs / 1000);
    const expectedConversationId = attemptContext?.expectedConversationId || null;
    const baselineCurrentNode = attemptContext?.baselineCurrentNode || null;
    if (expectedConversationId && !baselineCurrentNode) throw new Error('[chatgpt] Continuation baseline current node is unavailable; refusing response reconciliation.');
    let last = networkTracker?.snapshot?.() || initialState(resolveChatGptModel(selectedModel) || resolveChatGptModel());
    let lastDetailError = null;
    const fingerprints = new Map();
    for (let attempt = 0; attempt < maxPolls; attempt++) {
      networkTracker?.throwIfFatalProgressError?.();
      last = networkTracker?.snapshot?.() || last;
      if (last.error) throw new Error(last.error);
      if (expectedConversationId && last.requestConversationId && last.requestConversationId !== expectedConversationId) throw new Error('[chatgpt] Submission request conversation id did not match the requested provider conversation id.');
      if (expectedConversationId && last.conversationId && last.conversationId !== expectedConversationId) throw new Error('[chatgpt] Submission stream conversation id did not match the requested provider conversation id.');
      const detailId = last.conversationId || expectedConversationId || null;
      let detail = null;
      if (detailId) {
        try {
          detail = await readConversation(page, detailId);
          networkTracker?.throwIfFatalProgressError?.();
        } catch (error) {
          networkTracker?.throwIfFatalProgressError?.();
          if (!isTransientChatGptDetailError(error)) throw error;
          lastDetailError = error;
        }
      }
      if (detail) emitSnapshotMessages(onStreamEvent, detailId, detail, fingerprints, 'live-cdp');
      networkTracker?.throwIfFatalProgressError?.();
      const changedBranch = !baselineCurrentNode || detail?.conversation?.current_node !== baselineCurrentNode;
      if (detail && changedBranch && hasChatGptTerminalQuorum(detail)) {
        const turn = selectChatGptStructuredTurn(detail);
        networkTracker?.throwIfFatalProgressError?.();
        return { text: turn.text.trim(), rawText: turn.text.trim(), done: true, providerConversationId: expectedConversationId || last.conversationId, modelUsed: turn.modelSlug || last.modelSlug || last.observedPayloadModel || (expectedConversationId && selectedModel === 'default' ? null : resolveChatGptModel(selectedModel)?.model), finalUrl: chatGptConversationUrl(expectedConversationId || last.conversationId) || page.url(), providerState: buildProviderState(last, detail), searchResults: turn.searchResultGroups };
      }
      await sleepFn(1000);
    }
    networkTracker?.throwIfFatalProgressError?.();
    const detailId = last.conversationId || expectedConversationId || null;
    let detail = null;
    if (detailId) {
      try {
        detail = await readConversation(page, detailId);
        networkTracker?.throwIfFatalProgressError?.();
      } catch (error) {
        networkTracker?.throwIfFatalProgressError?.();
        if (!isTransientChatGptDetailError(error)) throw error;
        lastDetailError = error;
      }
    }
    networkTracker?.throwIfFatalProgressError?.();
    if (lastDetailError && !detail) throw lastDetailError;
    if (detail) emitSnapshotMessages(onStreamEvent, detailId, detail, fingerprints, 'live-cdp');
    networkTracker?.throwIfFatalProgressError?.();
    const turn = detail ? selectChatGptStructuredTurn(detail) : null;
    // CDP/SSE text is progress evidence only. A timeout may expose text only from
    // the authenticated current-branch structured turn.
    const text = (turn?.text || '').trim();
    networkTracker?.throwIfFatalProgressError?.();
    return { text, rawText: text, done: false, providerConversationId: expectedConversationId || last.conversationId || null, modelUsed: turn?.modelSlug || last.modelSlug || last.observedPayloadModel || (expectedConversationId && selectedModel === 'default' ? null : resolveChatGptModel(selectedModel)?.model), finalUrl: chatGptConversationUrl(expectedConversationId || last.conversationId) || page.url(), providerState: buildProviderState(last, detail, { timeout: true }), searchResults: turn?.searchResultGroups || [] };
  },
};
