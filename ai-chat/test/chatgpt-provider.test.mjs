import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  CHATGPT_MODEL_LEVELS,
  CHATGPT_PROVIDER_ID_OBSERVATION_TIMEOUT_MS,
  chatgptProvider,
  chatGptConversationIdFromUrl,
  chatGptSubmissionObservationTimeoutMs,
  normalizeChatGptConversationId,
  resolveChatGptConversationTarget,
  createChatGptNetworkTracker,
  createChatGptSseDecoder,
  extractChatGptStreamStateFromEncodedItem,
  extractChatGptWebSocketPayload,
  hasChatGptTerminalQuorum,
  readChatGptConversation,
  resolveChatGptModel,
  selectChatGptCurrentBranch,
  selectChatGptModelInUi,
  selectChatGptStructuredTurn,
  verifyChatGptObservedModel,
} from '../scripts/ai-chat/providers/chatgpt.mjs';

class FakeCdpSession extends EventEmitter {
  constructor() { super(); this.calls = []; this.responses = new Map(); }
  async send(method, params = {}) { this.calls.push({ method, params }); return this.responses.get(method) || {}; }
  async detach() { this.calls.push({ method: 'detach', params: {} }); }
}
const pageFor = client => ({ target: () => ({ createCDPSession: async () => client }) });

test('ChatGPT provider conversation targets accept only opaque ids or trusted clean URLs', () => {
  assert.equal(normalizeChatGptConversationId('thread_123-abc'), 'thread_123-abc');
  assert.equal(resolveChatGptConversationTarget('https://chatgpt.com/c/thread_123').providerId, 'thread_123');
  for (const value of ['', '../thread', 'thread/next', 'thread?x=1', 'https://evil.example/c/thread', 'https://chatgpt.com/c/thread?x=1']) {
    assert.throws(() => /^https/.test(value) ? chatGptConversationIdFromUrl(value) : normalizeChatGptConversationId(value));
  }
});

test('submit-only provider id observation is capped at 30 seconds', async () => {
  assert.equal(CHATGPT_PROVIDER_ID_OBSERVATION_TIMEOUT_MS, 30_000);
  assert.equal(chatGptSubmissionObservationTimeoutMs(undefined), 30_000);
  assert.equal(chatGptSubmissionObservationTimeoutMs(300_000), 30_000);
  assert.equal(chatGptSubmissionObservationTimeoutMs(5_000), 5_000);
  let observed = null;
  await chatgptProvider.waitForResponse({ page: { url: () => 'https://chatgpt.com/' }, timeoutMs: 300_000, selectedModel: 'instant', request: { submitOnly: true }, networkTracker: { waitForSubmission: async timeout => { observed = timeout; return { conversationId: 'provider_123' }; } } });
  assert.equal(observed, 30_000);
  await chatgptProvider.waitForResponse({ page: { url: () => 'https://chatgpt.com/' }, timeoutMs: 4_000, selectedModel: 'instant', request: { submitOnly: true }, networkTracker: { waitForSubmission: async timeout => { observed = timeout; return { conversationId: 'provider_123' }; } } });
  assert.equal(observed, 4_000);
});

test('submit-only waits for accepted SSE plus a provider id without terminal completion', async () => {
  const client = new FakeCdpSession();
  client.responses.set('Network.streamResourceContent', { bufferedData: Buffer.from('data: {"conversation_id":"provider_123"}\n\n').toString('base64') });
  const tracker = await createChatGptNetworkTracker({ page: pageFor(client), selectedModel: 'instant' });
  try {
    client.emit('Network.requestWillBeSent', { requestId: 'request', request: { method: 'POST', url: 'https://chatgpt.com/backend-api/f/conversation' } });
    client.emit('Network.responseReceived', { requestId: 'request', response: { status: 200, mimeType: 'text/event-stream' } });
    await new Promise(resolve => setImmediate(resolve));
    const result = await chatgptProvider.waitForResponse({ page: { url: () => 'https://chatgpt.com/' }, timeoutMs: 100, networkTracker: tracker, selectedModel: 'instant', request: { submitOnly: true } });
    assert.equal(result.status, 'submitted'); assert.equal(result.done, false); assert.equal(result.providerConversationId, 'provider_123');
  } finally { await tracker.dispose(); }
});

test('submit-only reports accepted responses without ids and rejected final responses safely', async () => {
  for (const response of [
    { status: 200, mimeType: 'text/event-stream', expected: /Submission may have occurred, but no provider conversation id was observed before timeout/ },
    { status: 429, mimeType: 'application/json', expected: /Submission failed with HTTP 429/ },
  ]) {
    let clock = 0;
    const client = new FakeCdpSession();
    const tracker = await createChatGptNetworkTracker({ page: pageFor(client), selectedModel: 'instant', now: () => clock, sleepFn: async () => { clock += 100; } });
    try {
      client.emit('Network.requestWillBeSent', { requestId: 'request', request: { method: 'POST', url: 'https://chatgpt.com/backend-api/f/conversation' } });
      client.emit('Network.responseReceived', { requestId: 'request', response });
      await new Promise(resolve => setImmediate(resolve));
      await assert.rejects(() => tracker.waitForSubmission(100), response.expected);
      assert.equal(tracker.snapshot().conversationId, undefined);
    } finally { await tracker.dispose(); assert.equal(client.calls.filter(call => call.method === 'detach').length, 1); }
  }
});

class FakeInputSession {
  constructor() { this.calls = []; this.detached = false; }
  async send(method, params = {}) { this.calls.push({ method, params }); }
  async detach() { this.detached = true; }
}

function fakeComposerPage({ focus = true, states = [] } = {}) {
  const session = new FakeInputSession();
  let evaluateCount = 0;
  return {
    session,
    target: () => ({ createCDPSession: async () => session }),
    evaluate: async () => {
      const value = evaluateCount === 0 || (evaluateCount === 2 && states.length > 1) ? focus : states.shift();
      evaluateCount += 1;
      return value;
    },
  };
}

test('exposes exactly the five public ChatGPT profiles and rejects legacy or raw aliases', () => {
  assert.deepEqual(CHATGPT_MODEL_LEVELS.map(model => model.id), ['instant', 'medium', 'high', 'extra-high', 'pro']);
  for (const id of CHATGPT_MODEL_LEVELS.map(model => model.id)) assert.equal(resolveChatGptModel(id).id, id);
  for (const rejected of ['fast', 'thinking', 'research', 'pro-extended', 'gpt-5.5', 'gpt-5-5', 'gpt-5-6-thinking']) assert.equal(resolveChatGptModel(rejected), null, rejected);
});

class FakePickerPage {
  constructor({ profiles = CHATGPT_MODEL_LEVELS.map(model => model.uiLabel), hasSol = true, selected = 'Instant', leaveOptionVisible = false } = {}) {
    this.profiles = profiles;
    this.hasSol = hasSol;
    this.selected = selected;
    this.versionSelected = false;
    this.menuOpen = false;
    this.versionSubmenuOpen = false;
    this.leaveOptionVisible = leaveOptionVisible;
    this.phases = [];
    this.document = { querySelectorAll: selector => this.elementsFor(selector) };
  }

  element({ role = null, text, attrs = {}, click }) {
    return {
      textContent: text,
      getAttribute: name => attrs[name] ?? (name === 'role' ? role : null),
      hasAttribute: name => Object.hasOwn(attrs, name),
      getBoundingClientRect: () => ({ width: 100, height: 20 }),
      click,
    };
  }

  elementsFor(selector) {
    const opener = this.element({
      text: this.selected,
      click: () => {
        this.menuOpen = true;
        this.versionSubmenuOpen = false;
        this.phases.push(this.versionSelected ? 'reopen-intelligence' : 'open-intelligence');
      },
    });
    const submenu = this.element({
      role: 'menuitem', text: 'GPT-5.6 Sol', attrs: { 'data-has-submenu': '' },
      click: () => { this.versionSubmenuOpen = true; this.phases.push('enter-sol-submenu'); },
    });
    const solChoice = this.element({
      role: 'menuitemradio', text: 'GPT-5.6 Sol', attrs: { 'aria-checked': this.versionSelected ? 'true' : 'false' },
      click: () => { this.versionSelected = true; this.versionSubmenuOpen = false; this.menuOpen = false; this.phases.push('select-sol-and-close-menu'); },
    });
    const profiles = this.profiles.map(label => this.element({
      role: 'menuitemradio', text: label === 'Instant' ? 'Instant\n5.5' : label,
      attrs: { 'aria-checked': this.selected === label ? 'true' : 'false' },
      click: () => { this.selected = label; this.menuOpen = this.leaveOptionVisible; this.phases.push(`select-profile:${label}`); },
    }));
    if (selector.includes('button') || selector.includes('[role="button"]')) return [opener];
    if (selector.includes('[role="menuitem"][data-has-submenu]')) return this.menuOpen && !this.versionSubmenuOpen && this.hasSol ? [submenu] : [];
    if (selector.includes('[role="menuitemradio"],[role="menuitem"]')) return this.versionSubmenuOpen && this.hasSol ? [submenu, solChoice] : [];
    if (selector.includes('[role="menuitemradio"]')) {
      if (this.versionSubmenuOpen) return this.hasSol ? [solChoice] : [];
      return this.menuOpen || this.leaveOptionVisible ? profiles : [];
    }
    return [];
  }

  installDocument() {
    globalThis.document = this.document;
  }

  async evaluate(callback, arg) {
    this.installDocument();
    return callback(arg);
  }

  async waitForFunction(callback, _options, label) {
    this.installDocument();
    if (!callback(label)) throw new Error(`unavailable:${label}`);
  }
}

test('selects each profile through explicit picker phases with exact labels', async () => {
  for (const model of CHATGPT_MODEL_LEVELS) {
    const page = new FakePickerPage();
    const result = await selectChatGptModelInUi(page, model.id);
    assert.equal(result.id, model.id);
    assert.equal(result.verification, 'visible-ui-label');
    assert.deepEqual(page.phases, ['open-intelligence', 'enter-sol-submenu', 'select-sol-and-close-menu', 'reopen-intelligence', `select-profile:${model.uiLabel}`]);
  }
});

test('picker exact matching does not select Extra High for High', async () => {
  const page = new FakePickerPage({ profiles: ['Extra High'] });
  await assert.rejects(() => selectChatGptModelInUi(page, 'high'), /model-option-unavailable:High/);
  assert.deepEqual(page.phases, ['open-intelligence', 'enter-sol-submenu', 'select-sol-and-close-menu', 'reopen-intelligence']);
});

test('unselected visible profile option does not satisfy final picker verification', async () => {
  const page = new FakePickerPage({ leaveOptionVisible: true });
  const original = page.elementsFor.bind(page);
  page.elementsFor = selector => {
    const elements = original(selector);
    if (selector.includes('[role="menuitemradio"]') && page.versionSelected && page.menuOpen) {
      return elements.map(element => ({ ...element, click: () => page.phases.push('profile-click-without-state-change') }));
    }
    return elements;
  };
  await assert.rejects(() => selectChatGptModelInUi(page, 'high'), /model-selection-not-visible/);
  assert.equal(page.selected, 'Instant');
});

test('missing GPT-5.6 Sol fails before profile click or composer submission', async () => {
  const page = new FakePickerPage({ hasSol: false });
  await assert.rejects(() => selectChatGptModelInUi(page, 'pro'), /model-version-submenu-unavailable/);
  assert.deepEqual(page.phases, ['open-intelligence']);
});

test('Sol selection closes the submenu and is confirmed from the reopened main menu', async () => {
  const page = new FakePickerPage();
  await selectChatGptModelInUi(page, 'medium');
  assert.equal(page.menuOpen, false);
  assert.equal(page.versionSubmenuOpen, false);
  assert.deepEqual(page.phases.slice(0, 4), ['open-intelligence', 'enter-sol-submenu', 'select-sol-and-close-menu', 'reopen-intelligence']);
});

test('tracker uses Network only and correlates only final conversation POSTs', async () => {
  const client = new FakeCdpSession();
  const tracker = await createChatGptNetworkTracker({ page: pageFor(client), selectedModel: 'instant' });
  try {
    assert.deepEqual(client.calls.map(call => call.method), ['Network.enable']);
    client.emit('Network.requestWillBeSent', { requestId: 'prepare', request: { method: 'POST', url: 'https://chatgpt.com/backend-api/f/conversation/prepare', postData: '{}' } });
    client.emit('Network.requestWillBeSent', { requestId: 'other', request: { method: 'POST', url: 'https://chatgpt.com/backend-api/f/conversation', postData: '{"model":"gpt-5-5-instant"}' } });
    assert.equal(tracker.snapshot().requestId, 'other');
    assert.equal(tracker.snapshot().observedPayloadModel, 'gpt-5-5-instant');
    assert.equal(client.calls.some(call => /^Fetch\./.test(call.method)), false);
  } finally { await tracker.dispose(); }
});

test('incremental buffered and data chunks match a full SSE fixture across UTF-8 and frame boundaries', async () => {
  const fixture = 'data: {"p":"/message/content/parts/0","o":"append","v":"Hej 🌍"}\n\ndata: {"p":"","o":"patch","v":[{"p":"/message/end_turn","o":"replace","v":true}]}\n\n';
  const expected = extractChatGptStreamStateFromEncodedItem(fixture);
  const bytes = Buffer.from(fixture); const decoder = createChatGptSseDecoder(); let state = {};
  for (const chunk of [bytes.subarray(0, 29), bytes.subarray(29, 61), bytes.subarray(61)]) state = extractChatGptStreamStateFromEncodedItem(decoder.push(chunk.toString('base64')).map(event => `data: ${event.data}\n\n`).join(''), state);
  state = extractChatGptStreamStateFromEncodedItem(decoder.flush().map(event => `data: ${event.data}\n\n`).join(''), state);
  assert.equal(state.text, expected.text);
  assert.equal(state.endTurn, expected.endTurn);
});

test('SSE decoder returns every complete frame from one incremental chunk before flush', () => {
  const decoder = createChatGptSseDecoder();
  const events = decoder.push(Buffer.from('data: one\n\ndata: two\n\ndata: three\n\n').toString('base64'));
  assert.deepEqual(events.map(event => event.data), ['one', 'two', 'three']);
  assert.deepEqual(decoder.flush(), []);
});

test('does not duplicate incremental and fallback response bodies', async () => {
  const client = new FakeCdpSession();
  client.responses.set('Network.streamResourceContent', { bufferedData: Buffer.from('data: {"p":"/message/content/parts/0","o":"append","v":"one"}\n\n').toString('base64') });
  client.responses.set('Network.getResponseBody', { body: 'data: {"p":"/message/content/parts/0","o":"append","v":"one"}\n\n' });
  const tracker = await createChatGptNetworkTracker({ page: pageFor(client), selectedModel: 'instant' });
  try {
    client.emit('Network.requestWillBeSent', { requestId: 'request', request: { method: 'POST', url: 'https://chatgpt.com/backend-api/f/conversation' } });
    client.emit('Network.responseReceived', { requestId: 'request', response: { url: 'https://chatgpt.com/backend-api/f/conversation', status: 200, mimeType: 'text/event-stream' } });
    await new Promise(resolve => setImmediate(resolve));
    client.emit('Network.loadingFinished', { requestId: 'request' }); await new Promise(resolve => setImmediate(resolve));
    assert.equal(tracker.snapshot().text, 'one');
    assert.equal(client.calls.filter(call => call.method === 'Network.getResponseBody').length, 0);
  } finally { await tracker.dispose(); }
});

test('DONE after a handoff is not terminal, while a plain DONE closes its transport', () => {
  const handedOff = extractChatGptStreamStateFromEncodedItem('data: {"type":"stream_handoff","conversation_id":"c"}\n\ndata: [DONE]\n\n');
  assert.equal(handedOff.done, false);
  assert.equal(handedOff.streamClosed, true);
  const plain = extractChatGptStreamStateFromEncodedItem('data: [DONE]\n\n');
  assert.equal(plain.done, true);
});

test('assistant_turn_complete and WebSocket catchups remain terminal stream evidence', () => {
  const terminal = extractChatGptStreamStateFromEncodedItem('data: {"type":"assistant_turn_complete"}\n\n');
  assert.equal(terminal.assistantTurnComplete, true);
  assert.equal(terminal.done, true);
  const payload = JSON.stringify([{ reply: { catchups: [{ payload: { payload: { encoded_item: 'data: {"p":"/message/content/parts/0","o":"append","v":"catchup"}\n\n' } } }] } }]);
  const catchup = extractChatGptWebSocketPayload(payload);
  assert.equal(catchup.text, 'catchup');
  assert.equal(catchup.websocketCatchup, true);
});

test('SSE and WebSocket resume events retain no private event payloads', async () => {
  const secret = 'PRIVATE_RESUME_SENTINEL';
  const event = `data: {"type":"resume_conversation_token","conversation_id":"conv","token":"${secret}","proof":"${secret}"}\n\n`;
  const client = new FakeCdpSession();
  client.responses.set('Network.streamResourceContent', { bufferedData: Buffer.from(event).toString('base64') });
  const tracker = await createChatGptNetworkTracker({ page: pageFor(client), selectedModel: 'high' });
  try {
    client.emit('Network.requestWillBeSent', { requestId: 'request', request: { method: 'POST', url: 'https://chatgpt.com/backend-api/f/conversation' } });
    client.emit('Network.responseReceived', { requestId: 'request', response: { url: 'https://chatgpt.com/backend-api/f/conversation', status: 200, mimeType: 'text/event-stream' } });
    await new Promise(resolve => setImmediate(resolve));
    client.emit('Network.webSocketFrameReceived', { response: { payloadData: JSON.stringify([{ reply: { catchups: [{ payload: { payload: { encoded_item: event } } }] } }]) } });
    const trackerState = tracker.snapshot();
    const websocketState = extractChatGptWebSocketPayload(JSON.stringify([{ reply: { catchups: [{ payload: { payload: { encoded_item: event } } }] } }]));
    for (const state of [trackerState, websocketState]) {
      assert.equal(state.handedOff, true);
      assert.equal(state.conversationId, 'conv');
      assert.equal(JSON.stringify(state).includes(secret), false);
    }
    const result = await chatgptProvider.waitForResponse({
      page: { url: () => 'https://chatgpt.com/c/conv' }, timeoutMs: 0, selectedModel: 'high',
      networkTracker: { snapshot: () => tracker.snapshot() },
    });
    assert.equal(result.rawText.includes(secret), false);
    assert.equal(JSON.stringify(result.providerState).includes(secret), false);
    assert.equal(JSON.stringify(result).includes(secret), false);
  } finally {
    await tracker.dispose();
  }
});

test('composer clearing uses native CDP select-all and Backspace then detaches', async () => {
  const page = fakeComposerPage({ states: [{ focused: true, text: '', sendReady: false }] });
  await chatgptProvider.clearInput({ page });
  assert.deepEqual(page.session.calls.map(call => [call.method, call.params.type, call.params.key]), [
    ['Input.dispatchKeyEvent', 'keyDown', 'a'], ['Input.dispatchKeyEvent', 'keyUp', 'a'],
    ['Input.dispatchKeyEvent', 'keyDown', 'Backspace'], ['Input.dispatchKeyEvent', 'keyUp', 'Backspace'],
  ]);
  assert.equal(page.session.calls[0].params.modifiers, 4);
  assert.equal(page.session.detached, true);
});

test('composer prompt uses native Input.insertText and verifies send readiness', async () => {
  const page = fakeComposerPage({ states: [{ focused: true, text: 'Prompt exactly', sendReady: true }] });
  await chatgptProvider.typePrompt({ page, prompt: 'Prompt exactly' });
  assert.deepEqual(page.session.calls, [{ method: 'Input.insertText', params: { text: 'Prompt exactly' } }]);
  assert.equal(page.session.detached, true);
});

test('composer setup failure prevents submit', async () => {
  const page = fakeComposerPage({ focus: false });
  const originalSubmit = chatgptProvider.submit;
  let submitCalls = 0;
  chatgptProvider.submit = async () => { submitCalls += 1; };
  try {
    await assert.rejects(async () => {
      await chatgptProvider.typePrompt({ page, prompt: 'blocked' });
      await chatgptProvider.submit({ page });
    }, /could not be focused/);
    assert.equal(submitCalls, 0);
  } finally {
    chatgptProvider.submit = originalSubmit;
  }
});

function completeDetail({ status = 'COMPLETE', final = true } = {}) {
  return { streamStatus: { status }, conversation: { mapping: {
    user: { id: 'user', parent: null, message: { id: 'u', author: { role: 'user' }, create_time: 2, content: { parts: ['question'] } } },
    assistant: { id: 'assistant', parent: 'user', message: { id: 'a', author: { role: 'assistant' }, channel: 'final', status: final ? 'finished_successfully' : 'in_progress', end_turn: final, content: { parts: ['answer'], citations: [{ url: 'x' }] }, metadata: { model_slug: 'gpt-5-6-thinking', thinking_effort: 'max', resume_token: 'secret' } } },
    system: { id: 'system', parent: null, message: { author: { role: 'system' }, content: { parts: ['hidden'] } } },
  }, current_node: 'assistant' } };
}

test('final retrieval polls authenticated detail reads to strict quorum without composer actions', async () => {
  let clock = 0; let reads = 0; const actions = [];
  const page = { url: () => 'https://chatgpt.com/c/provider_123', goto: async () => actions.push('goto') };
  const result = await chatgptProvider.recheckConversation({
    browser: { pages: async () => [page], newPage: async () => page }, selectedModel: 'extra-high',
    conversation: { providerId: 'provider_123', url: page.url() }, request: { timeoutSeconds: 2 },
    now: () => clock, sleepFn: async () => { clock += 1000; },
    readConversation: async () => (++reads === 1 ? completeDetail({ final: false }) : completeDetail()),
  });
  assert.equal(result.done, true); assert.equal(result.status, 'complete'); assert.equal(result.providerConversationId, 'provider_123');
  assert.equal(result.text, 'answer'); assert.equal(result.providerState.structured_turn.messages.length, 2); assert.deepEqual(actions, []);
});

test('final retrieval timeout returns safe incomplete state without provider writes', async () => {
  let clock = 0; const page = { url: () => 'https://chatgpt.com/c/provider_123', goto: async () => { throw new Error('unexpected navigation'); } };
  const result = await chatgptProvider.recheckConversation({
    browser: { pages: async () => [page], newPage: async () => page }, selectedModel: 'extra-high',
    conversation: { providerId: 'provider_123', url: page.url() }, request: { timeoutSeconds: 1 }, now: () => clock,
    sleepFn: async () => { clock += 1000; }, readConversation: async () => completeDetail({ status: 'IN_PROGRESS', final: false }),
  });
  assert.equal(result.done, false); assert.equal(result.status, 'in_progress'); assert.equal(result.providerState.timeout, true);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('reattached streams emit one session, deduplicate snapshots, and report changed messages', async () => {
  let clock = 0;
  const events = [];
  const page = { url: () => 'https://chatgpt.com/c/provider_123', goto: async () => { throw new Error('unexpected navigation'); } };
  const first = completeDetail({ status: 'IN_PROGRESS', final: false });
  const second = structuredClone(first);
  second.conversation.mapping.assistant.message.content.parts = ['updated answer'];
  let reads = 0;
  await chatgptProvider.recheckConversation({
    browser: { pages: async () => [page], newPage: async () => page }, selectedModel: 'extra-high',
    conversation: { providerId: 'provider_123', url: page.url() }, request: { timeoutSeconds: 2 },
    onStreamEvent: event => events.push(event), now: () => clock, sleepFn: async () => { clock += 1000; },
    readConversation: async () => [first, first, second][Math.min(reads++, 2)],
  });
  assert.equal(events.filter(event => event.event === 'session').length, 1);
  assert.equal(events.filter(event => event.event === 'message').length, 3);
  assert.deepEqual(events.filter(event => event.event === 'message').map(event => event.change), ['new', 'new', 'changed']);
});

test('network tracker emits safe live session, delta, and handoff progress without raw payloads', async () => {
  const client = new FakeCdpSession(); const events = [];
  client.responses.set('Network.streamResourceContent', { bufferedData: Buffer.from('data: {"conversation_id":"provider_123"}\n\ndata: {"p":"/message/content/parts/0","o":"append","v":"hello"}\n\ndata: {"type":"stream_handoff","resume_token":"test-secret"}\n\ndata: [DONE]\n\n').toString('base64') });
  const tracker = await createChatGptNetworkTracker({ page: pageFor(client), selectedModel: 'instant', onStreamEvent: event => events.push(event) });
  try {
    client.emit('Network.requestWillBeSent', { requestId: 'request', request: { method: 'POST', url: 'https://chatgpt.com/backend-api/f/conversation' } });
    client.emit('Network.responseReceived', { requestId: 'request', response: { status: 200, mimeType: 'text/event-stream' } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(events.filter(event => event.event === 'session').length, 1);
    assert.deepEqual(events.filter(event => event.event === 'delta').map(event => event.text), ['hello']);
    assert.ok(events.some(event => event.event === 'status' && event.status === 'stream_handoff'));
    assert.equal(JSON.stringify(events).includes('test-secret'), false);
  } finally { await tracker.dispose(); }
});

test('strict terminal quorum requires both persistent completion and a finished final assistant', () => {
  assert.equal(hasChatGptTerminalQuorum(completeDetail({ status: 'COMPLETE', final: false })), false);
  assert.equal(hasChatGptTerminalQuorum(completeDetail({ status: 'IN_PROGRESS', final: true })), false);
  assert.equal(hasChatGptTerminalQuorum(completeDetail()), true);
});

test('structured turn contains only the current user branch and excludes token-like fields', () => {
  const detail = completeDetail();
  assert.deepEqual(selectChatGptCurrentBranch(detail).map(message => message.author.role), ['user', 'assistant']);
  const turn = selectChatGptStructuredTurn(detail);
  assert.equal(turn.text, 'answer');
  assert.equal(JSON.stringify(turn), JSON.stringify(turn).includes('secret') ? 'unexpected' : JSON.stringify(turn));
  assert.equal(JSON.stringify(turn).includes('hidden'), false);
});

test('structured turn removes editable contexts while retaining visible reasoning, tool, and assistant messages', () => {
  const message = (role, contentType, text, extra = {}) => ({ author: { role }, content: { content_type: contentType, parts: [text] }, ...extra });
  const detail = {
    conversation: {
      current_node: 'assistant',
      mapping: {
        user: { id: 'user', parent: null, message: message('user', 'text', 'question') },
        modelContext: { id: 'modelContext', parent: 'user', message: message('assistant', 'model_editable_context', 'model context') },
        userContext: { id: 'userContext', parent: 'modelContext', message: message('user', 'user_editable_context', 'user context') },
        reasoning: { id: 'reasoning', parent: 'userContext', message: message('assistant', 'reasoning_recap', 'reasoning') },
        tool: { id: 'tool', parent: 'reasoning', message: message('tool', 'tool_result', 'tool result') },
        assistant: { id: 'assistant', parent: 'tool', message: message('assistant', 'text', 'answer', { channel: 'final', status: 'finished_successfully', end_turn: true }) },
      },
    },
  };
  assert.deepEqual(selectChatGptCurrentBranch(detail).map(item => item.content.parts[0]), ['question', 'reasoning', 'tool result', 'answer']);
});

test('current_node branch excludes a finished stale sibling and keeps quorum incomplete', () => {
  const detail = {
    streamStatus: { status: 'COMPLETE' },
    conversation: {
      current_node: 'current',
      mapping: {
        user: { id: 'user', parent: null, message: { author: { role: 'user' }, content: { parts: ['question'] } } },
        stale: { id: 'stale', parent: 'user', message: { author: { role: 'assistant' }, channel: 'final', status: 'finished_successfully', end_turn: true, content: { parts: ['stale'] } } },
        current: { id: 'current', parent: 'user', message: { author: { role: 'assistant' }, channel: 'final', status: 'in_progress', end_turn: false, content: { parts: ['current'] } } },
      },
    },
  };
  assert.deepEqual(selectChatGptCurrentBranch(detail).map(message => message.content.parts[0]), ['question', 'current']);
  assert.equal(hasChatGptTerminalQuorum(detail), false);
});

test('terminal quorum rejects a finished assistant that is not on the final channel', () => {
  const detail = completeDetail();
  detail.conversation.mapping.assistant.message.channel = 'commentary';
  assert.equal(hasChatGptTerminalQuorum(detail), false);
});

test('authenticated conversation reads retain auth inside page context', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (url === '/api/auth/session') return { ok: true, json: async () => ({ accessToken: 'access-secret', account: { id: 'account-secret' } }) };
    return { ok: true, json: async () => ({ mapping: {}, current_node: null, token: 'provider-secret' }) };
  };
  try {
    const page = { evaluate: async (callback, arg) => callback(arg) };
    const result = await readChatGptConversation(page, 'conversation-id');
    assert.equal(requests.length, 3);
    for (const request of requests.slice(1)) {
      assert.equal(request.options.headers.Authorization, 'Bearer access-secret');
      assert.equal(request.options.headers['ChatGPT-Account-ID'], 'account-secret');
    }
    assert.equal(JSON.stringify(result).includes('secret'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('authenticated detail reads fail promptly with sanitized actionable errors', async () => {
  const originalFetch = globalThis.fetch;
  const page = { evaluate: async (callback, arg) => callback(arg) };
  const scenarios = [
    { fetch: async () => ({ ok: true, json: async () => ({}) }), expected: /Authentication is unavailable or expired/ },
    { fetch: async url => url.includes('/stream_status') ? { ok: true, json: async () => ({ status: 'IN_PROGRESS' }) } : (url.includes('/backend-api/') ? { ok: false, status: 404 } : { ok: true, json: async () => ({ accessToken: 'secret-token', account: { id: 'secret-account' } }) }), expected: /invalid or unavailable.*404/ },
    { fetch: async url => url.includes('/stream_status') ? { ok: false, status: 503 } : (url.includes('/backend-api/') ? { ok: true, json: async () => ({ mapping: {}, current_node: null }) } : { ok: true, json: async () => ({ accessToken: 'secret-token', account: { id: 'secret-account' } }) }), expected: /status read failed with HTTP 503/ },
  ];
  try {
    for (const scenario of scenarios) {
      globalThis.fetch = scenario.fetch;
      await assert.rejects(() => readChatGptConversation(page, 'provider_123'), error => {
        assert.match(error.message, scenario.expected); assert.equal(error.message.includes('secret'), false); return true;
      });
    }
    globalThis.fetch = async url => url === '/api/auth/session'
      ? { ok: true, json: async () => ({ accessToken: 'secret-token', account: { id: 'secret-account' } }) }
      : { ok: true, json: async () => ({ mapping: {}, current_node: null, token: 'secret-token', status: 'IN_PROGRESS' }) };
    const detail = await readChatGptConversation(page, 'provider_123');
    assert.equal(detail.streamStatus.status, 'IN_PROGRESS'); assert.equal(JSON.stringify(detail).includes('secret'), false);
  } finally { globalThis.fetch = originalFetch; }
});

test('post-submit model verification accepts observed mappings and exposes mismatches', () => {
  const accepted = [
    ['instant', 'gpt-5-5-instant', null], ['instant', 'gpt-5-5', 'ignored'],
    ['medium', 'gpt-5-6-thinking', 'standard'], ['high', 'gpt-5-6-thinking', 'extended'],
    ['extra-high', 'gpt-5-6-thinking', 'max'], ['pro', 'gpt-5-6-pro', 'standard'],
  ];
  for (const [profile, model, effort] of accepted) assert.equal(verifyChatGptObservedModel(resolveChatGptModel(profile), model, effort).status, 'verified', profile);
  assert.equal(verifyChatGptObservedModel(resolveChatGptModel('high'), 'gpt-5-6-thinking', 'max').status, 'mismatch');
  assert.equal(verifyChatGptObservedModel(resolveChatGptModel('pro'), 'gpt-5-6-thinking', 'standard').status, 'mismatch');
});

test('tracker records explicit post-submit model verification without changing the request', async () => {
  const client = new FakeCdpSession();
  const tracker = await createChatGptNetworkTracker({ page: pageFor(client), selectedModel: 'high' });
  try {
    client.emit('Network.requestWillBeSent', { requestId: 'request', request: { method: 'POST', url: 'https://chatgpt.com/backend-api/f/conversation', postData: '{"model":"gpt-5-6-thinking","thinking_effort":"max"}' } });
    assert.equal(tracker.snapshot().modelVerification.status, 'mismatch');
    assert.equal(client.calls.some(call => /^Fetch\./.test(call.method)), false);
  } finally {
    await tracker.dispose();
  }
});

test('persistent response completion waits for reconciliation instead of DOM or text stability', async () => {
  const result = await chatgptProvider.waitForResponse({
    page: { url: () => 'https://chatgpt.com/c/c', evaluate: async () => ({ detail: completeDetail() }) }, timeoutMs: 0, selectedModel: 'extra-high',
    networkTracker: { snapshot: () => ({ text: 'partial', rawItems: [], conversationId: 'c', requestedModelProfile: 'extra-high', transport: 'network-incremental-sse' }) },
  });
  assert.equal(result.done, false);
  assert.equal(result.providerState.timeout, true);
});

test('persistent response returns a complete structured turn only after both quorum conditions hold', async () => {
  const result = await chatgptProvider.waitForResponse({
    page: { url: () => 'https://chatgpt.com/c/c', evaluate: async () => ({ detail: completeDetail() }) }, timeoutMs: 1_000, selectedModel: 'extra-high',
    networkTracker: { snapshot: () => ({ text: 'stream text', rawItems: ['stream text'], conversationId: 'c', requestedModelProfile: 'extra-high', transport: 'network-incremental-sse' }) },
  });
  assert.equal(result.done, true);
  assert.equal(result.text, 'answer');
  assert.equal(result.providerState.stream_state.terminal_quorum, true);
  assert.equal(JSON.stringify(result.providerState).includes('secret'), false);
});

test('attached polling emits deduplicated structured message snapshots before strict completion', async () => {
  const events = []; let reads = 0;
  const first = completeDetail({ status: 'IN_PROGRESS', final: false });
  const changed = structuredClone(first);
  changed.conversation.mapping.assistant.message.content.parts = ['changed answer'];
  const complete = completeDetail();
  const result = await chatgptProvider.waitForResponse({
    page: { url: () => 'https://chatgpt.com/c/c' }, timeoutMs: 4_000, selectedModel: 'extra-high',
    networkTracker: { snapshot: () => ({ text: '', conversationId: 'c', requestedModelProfile: 'extra-high', transport: 'network-incremental-sse' }) },
    onStreamEvent: event => events.push(event),
    readConversation: async () => [first, first, changed, complete][Math.min(reads++, 3)],
    sleepFn: async () => {},
  });
  assert.equal(result.done, true);
  const messages = events.filter(event => event.event === 'message');
  assert.deepEqual(messages.map(event => event.change), ['new', 'new', 'changed', 'changed']);
  assert.equal(messages.filter(event => event.message.id === 'u').length, 1);
  assert.equal(messages.every(event => event.source === 'live-cdp'), true);
});
