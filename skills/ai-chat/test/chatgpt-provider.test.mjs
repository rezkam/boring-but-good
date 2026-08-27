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
  listChatGptConversations,
  resolveChatGptModel,
  selectChatGptCurrentBranch,
  selectChatGptModelInUi,
  selectChatGptStructuredTurn,
  verifyChatGptObservedModel,
} from '../scripts/ai-chat/providers/chatgpt.mjs';

test('listing keeps auth in page, uses one bounded GET, and exposes only safe fields', async () => {
  const calls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === '/api/auth/session') return { ok: true, json: async () => ({ accessToken: 'secret-token', account: { id: 'account-1' } }) };
    return { ok: true, json: async () => ({ total: 2, items: [
      { id: 'good_1', title: 'token=abc normal prose', create_time: 1, update_time: 2, current_node: 'node', async_status: { state: 'running', status: 'IN_PROGRESS', progress: 0.5, done: false, account: { label: 'private-account-label' }, profile_name: 'private-profile', nested: { token: 'secret' } }, is_temporary_chat: true, is_archived: true, is_starred: true, mapping: { hidden: true }, snippet: 'hidden' },
      { id: '../bad', title: 'bad' },
    ] }) };
  };
  try {
    const page = { url: () => 'https://chatgpt.com/', evaluate: async (fn, arg) => fn(arg) };
    const result = await listChatGptConversations({ browser: { pages: async () => [page] }, limit: 20, now: () => 'now' });
    assert.equal(calls.length, 2); assert.equal(calls[1].options.method, 'GET'); assert.match(calls[1].url, /offset=0&limit=20&order=updated/);
    assert.equal(result.count, 1); assert.equal(result.conversations[0].is_temporary, true);
    assert.deepEqual(result.conversations[0].async_status, { state: 'running', status: 'IN_PROGRESS', progress: 0.5, done: false });
    assert.equal('mapping' in result.conversations[0], false); assert.equal('snippet' in result.conversations[0], false); assert.doesNotMatch(JSON.stringify(result), /secret-token|account-1|private-account-label|private-profile/);
  } finally { globalThis.fetch = previousFetch; }
});

test('preflight returns minimal provider baseline without mutating request', async () => {
  const request = { conversationTarget: 'provider_1' }; const page = { url: () => 'https://chatgpt.com/c/provider_1' };
  const context = await chatgptProvider.preflight({ page, request, readConversation: async () => ({ conversation: { current_node: 'node_1', mapping: { secret: true } } }) });
  assert.deepEqual(context, { expectedConversationId: 'provider_1', baselineCurrentNode: 'node_1' }); assert.equal('chatgptContinuationBaseline' in request, false);
});
test('preflight rejects wrong ChatGPT continuation URL', async () => {
  await assert.rejects(() => chatgptProvider.preflight({ page: { url: () => 'https://chatgpt.com/' }, request: { conversationTarget: 'provider_1' }, readConversation: async () => null }), /not the requested/);
});
test('preflight rejects missing detail and baseline node', async () => {
  const page = { url: () => 'https://chatgpt.com/c/provider_1' };
  await assert.rejects(() => chatgptProvider.preflight({ page, request: { conversationTarget: 'provider_1' }, readConversation: async () => null }), /baseline/);
  await assert.rejects(() => chatgptProvider.preflight({ page, request: { conversationTarget: 'provider_1' }, readConversation: async () => ({ conversation: {} }) }), /baseline/);
});
test('preserve continuation model uses default sentinel while explicit model remains explicit', () => {
  assert.equal(chatgptProvider.preserveContinuationModel({ request: {}, conversation: { providerId: 'provider_1' } }), true);
  assert.equal(chatgptProvider.preserveContinuationModel({ request: { modelExplicit: true }, conversation: { providerId: 'provider_1' } }), false);
});
test('preserve submit-only uses observed model rather than Extra High', async () => {
  const result = await chatgptProvider.waitForResponse({ page: { url: () => 'https://chatgpt.com/' }, timeoutMs: 10, selectedModel: 'default', request: { submitOnly: true }, networkTracker: { waitForSubmission: async () => ({ conversationId: 'provider_1', observedPayloadModel: 'observed-model', observedPayloadThinkingEffort: 'extended' }) } });
  assert.equal(result.modelUsed, 'observed-model'); assert.equal(result.providerState.model_slug, 'observed-model');
});
test('preserve response rejects missing continuation baseline', async () => {
  await assert.rejects(() => chatgptProvider.waitForResponse({ page: { url: () => '' }, timeoutMs: 1, selectedModel: 'default', request: {}, attemptContext: { expectedConversationId: 'provider_1' }, networkTracker: { snapshot: () => ({}) } }), /baseline/);
});
test('listing errors are sanitized and actionable', async () => {
  const previous = globalThis.fetch; globalThis.fetch = async () => ({ ok: false, status: 401 });
  try { await assert.rejects(() => listChatGptConversations({ browser: { pages: async () => [{ url: () => 'https://chatgpt.com/', evaluate: async (fn, arg) => fn(arg) }] } }), /Authentication/); } finally { globalThis.fetch = previous; }
});
test('listing status omits arbitrary nested provider fields', async () => {
  const previous = globalThis.fetch; globalThis.fetch = async url => url === '/api/auth/session' ? ({ ok: true, json: async () => ({ accessToken: 'AUTH_SECRET', account: { id: 'ACCOUNT_SECRET' } }) }) : ({ ok: true, json: async () => ({ items: [{ id: 'provider_1', async_status: { state: 'AUTH_SECRET', status: 'x-amz-signature', nested: { token: 'SENTINEL', list: ['Bearer SENTINEL'] }, account: { name: 'PRIVATE_ACCOUNT' } } }] }) });
  try {
    const value = await listChatGptConversations({ browser: { pages: async () => [{ url: () => 'https://chatgpt.com/', evaluate: async (fn, arg) => fn(arg) }] } });
    assert.equal(value.conversations[0].async_status, null);
    assert.doesNotMatch(JSON.stringify(value), /SENTINEL|PRIVATE_ACCOUNT|AUTH_SECRET|ACCOUNT_SECRET/);
  } finally { globalThis.fetch = previous; }
});

test('listing status drops camel-case credential families outside the status allowlist', async () => {
  const markers = ['SESSION_TOKEN_MARKER', 'AUTH_TOKEN_MARKER', 'REFRESH_TOKEN_MARKER', 'READ_WRITE_TOKEN_MARKER', 'RESUME_TOKEN_MARKER'];
  const previous = globalThis.fetch;
  globalThis.fetch = async url => url === '/api/auth/session'
    ? { ok: true, json: async () => ({ accessToken: 'AUTH_SECRET', account: { id: 'ACCOUNT_SECRET' } }) }
    : { ok: true, json: async () => ({ items: [{ id: 'provider_1', async_status: {
      sessionToken: markers[0], nested: { authToken: markers[1], values: [{ refreshToken: markers[2] }, { readWriteToken: markers[3], resumeToken: markers[4] }] },
    } }] }) };
  try {
    const value = await listChatGptConversations({ browser: { pages: async () => [{ url: () => 'https://chatgpt.com/', evaluate: async (fn, arg) => fn(arg) }] } });
    assert.equal(value.conversations[0].async_status, null);
    const serialized = JSON.stringify(value);
    for (const marker of [...markers, 'AUTH_SECRET', 'ACCOUNT_SECRET']) assert.equal(serialized.includes(marker), false, marker);
  } finally { globalThis.fetch = previous; }
});

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

class FakeAdvancedPickerPage {
  constructor({
    selectedModel = 'GPT-5.6 Sol',
    selectedEffort = 'Extra High',
    models = ['GPT-5.6 Sol', 'GPT-5.5'],
    efforts = CHATGPT_MODEL_LEVELS.map(model => model.uiLabel),
    applyEffortSelection = true,
    pointerSubmenusClose = false,
    keepModelMenuOpen = false,
    keepEffortMenuOpen = false,
  } = {}) {
    this.selectedModel = selectedModel;
    this.selectedEffort = selectedEffort;
    this.models = models;
    this.efforts = efforts;
    this.applyEffortSelection = applyEffortSelection;
    this.pointerSubmenusClose = pointerSubmenusClose;
    this.keepModelMenuOpen = keepModelMenuOpen;
    this.keepEffortMenuOpen = keepEffortMenuOpen;
    this.menuOpen = false;
    this.advanced = false;
    this.submenu = null;
    this.phases = [];
    this.pendingClick = null;
    this.mouse = {
      click: async () => {
        if (!this.pendingClick) throw new Error('no picker target was located');
        const click = this.pendingClick;
        this.pendingClick = null;
        click();
      },
    };
    this.document = { querySelectorAll: selector => this.elementsFor(selector) };
  }

  element({ role = null, text, attrs = {}, click, pointerClick = click }) {
    const element = {
      textContent: text,
      innerText: text,
      disabled: false,
      getAttribute: name => attrs[name] ?? (name === 'role' ? role : null),
      hasAttribute: name => Object.hasOwn(attrs, name),
      getBoundingClientRect: () => {
        this.pendingClick = pointerClick;
        return { x: 10, y: 10, width: 100, height: 20 };
      },
      click,
    };
    return element;
  }

  elementsFor(selector) {
    const opener = this.element({
      text: this.selectedEffort,
      attrs: { 'aria-haspopup': 'menu', 'aria-expanded': this.menuOpen ? 'true' : 'false' },
      click: () => {
        if (this.menuOpen) {
          this.menuOpen = false;
          this.submenu = null;
          this.phases.push('close-picker');
          return;
        }
        this.menuOpen = true;
        this.submenu = null;
        this.phases.push('open-picker');
      },
    });
    const advanced = this.element({
      role: 'menuitem', text: 'Advanced', attrs: { 'aria-label': 'Show advanced options' },
      click: () => { this.advanced = true; this.phases.push('show-advanced'); },
    });
    const modelMenu = this.element({
      role: 'menuitem', text: `Model\n${this.selectedModel}`, attrs: { 'data-has-submenu': '', 'aria-haspopup': 'menu' },
      click: () => { this.submenu = 'model'; this.phases.push('open-model'); },
      pointerClick: this.pointerSubmenusClose
        ? () => { this.menuOpen = false; this.submenu = null; this.phases.push('pointer-model-closed'); }
        : () => { this.submenu = 'model'; this.phases.push('open-model'); },
    });
    const effortMenu = this.element({
      role: 'menuitem', text: `Effort\n${this.selectedEffort}`, attrs: { 'data-has-submenu': '', 'aria-haspopup': 'menu' },
      click: () => { this.submenu = 'effort'; this.phases.push('open-effort'); },
      pointerClick: this.pointerSubmenusClose
        ? () => { this.menuOpen = false; this.submenu = null; this.phases.push('pointer-effort-closed'); }
        : () => { this.submenu = 'effort'; this.phases.push('open-effort'); },
    });
    const modelOptions = this.models.map(label => this.element({
      role: 'menuitemradio', text: label, attrs: { 'aria-checked': this.selectedModel === label ? 'true' : 'false' },
      click: () => {
        this.selectedModel = label;
        this.menuOpen = this.keepModelMenuOpen;
        this.submenu = this.keepModelMenuOpen ? 'model' : null;
        this.phases.push(`select-model:${label}`);
      },
    }));
    const effortOptions = this.efforts.map(label => this.element({
      role: 'menuitemradio', text: label, attrs: { 'aria-checked': this.selectedEffort === label ? 'true' : 'false' },
      click: () => {
        if (this.applyEffortSelection) this.selectedEffort = label;
        this.menuOpen = this.keepEffortMenuOpen;
        this.submenu = this.keepEffortMenuOpen ? 'effort' : null;
        this.phases.push(`select-effort:${label}`);
      },
    }));
    if (selector.includes('button') || selector.includes('[role="button"]')) return [opener];
    if (selector.includes('[role="menuitem"][data-has-submenu]')) return this.menuOpen && this.advanced ? [modelMenu, effortMenu] : [];
    if (selector.includes('[role="menuitemradio"],[role="menuitem"]')) {
      if (this.submenu === 'model') return [modelMenu, ...modelOptions];
      if (this.submenu === 'effort') return [effortMenu, ...effortOptions];
      return this.menuOpen ? [advanced, ...(this.advanced ? [modelMenu, effortMenu] : [])] : [];
    }
    if (selector.includes('[role="menuitemradio"]')) {
      if (this.submenu === 'model') return modelOptions;
      if (this.submenu === 'effort') return effortOptions;
      return [];
    }
    if (selector.includes('[role="menuitem"]')) return this.menuOpen ? [advanced, ...(this.advanced ? [modelMenu, effortMenu] : [])] : [];
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
    const value = callback(label);
    if (!value) throw new Error(`unavailable:${JSON.stringify(label)}`);
    return { jsonValue: async () => value };
  }
}

test('selects every model and effort profile through the current advanced picker', async () => {
  for (const model of CHATGPT_MODEL_LEVELS) {
    const page = new FakeAdvancedPickerPage();
    const result = await selectChatGptModelInUi(page, model.id);
    assert.equal(result.id, model.id);
    assert.equal(result.verification, 'visible-ui-model-and-effort');
    assert.equal(page.selectedModel, model.uiModelLabel);
    assert.equal(page.selectedEffort, model.uiLabel);
    assert.deepEqual(page.phases, [
      'open-picker',
      'show-advanced',
      'open-model',
      `select-model:${model.uiModelLabel}`,
      'open-picker',
      'open-effort',
      `select-effort:${model.uiLabel}`,
    ]);
  }
});

test('submenu activation does not let pointer toggling close the picker', async () => {
  const page = new FakeAdvancedPickerPage({ pointerSubmenusClose: true });
  const result = await selectChatGptModelInUi(page, 'high');
  assert.equal(result.id, 'high');
  assert.equal(page.selectedEffort, 'High');
  assert.equal(page.phases.includes('pointer-model-closed'), false);
  assert.equal(page.phases.includes('pointer-effort-closed'), false);
});

test('continues from a model submenu that remains open after selection', async () => {
  const page = new FakeAdvancedPickerPage({ keepModelMenuOpen: true });
  const result = await selectChatGptModelInUi(page, 'high');
  assert.equal(result.id, 'high');
  assert.equal(page.selectedModel, 'GPT-5.6 Sol');
  assert.equal(page.selectedEffort, 'High');
  assert.deepEqual(page.phases, [
    'open-picker',
    'show-advanced',
    'open-model',
    'select-model:GPT-5.6 Sol',
    'open-effort',
    'select-effort:High',
  ]);
});

test('verifies an effort that remains open and closes the picker explicitly', async () => {
  const page = new FakeAdvancedPickerPage({ keepModelMenuOpen: true, keepEffortMenuOpen: true });
  const result = await selectChatGptModelInUi(page, 'high');
  assert.equal(result.id, 'high');
  assert.equal(page.selectedEffort, 'High');
  assert.equal(page.menuOpen, false);
  assert.deepEqual(page.phases.slice(-2), ['select-effort:High', 'close-picker']);
});

test('effort picker exact matching does not select Extra High for High', async () => {
  const page = new FakeAdvancedPickerPage({ efforts: ['Extra High'] });
  await assert.rejects(() => selectChatGptModelInUi(page, 'high'), /effort-option-unavailable:High/);
  assert.equal(page.selectedEffort, 'Extra High');
});

test('an effort click without a state change fails final picker verification', async () => {
  const page = new FakeAdvancedPickerPage({ applyEffortSelection: false });
  await assert.rejects(() => selectChatGptModelInUi(page, 'high'), /effort-selection-not-visible/);
  assert.equal(page.selectedEffort, 'Extra High');
});

test('missing requested base model fails before effort selection or composer submission', async () => {
  const page = new FakeAdvancedPickerPage({ models: ['GPT-5.5'] });
  await assert.rejects(() => selectChatGptModelInUi(page, 'pro'), /model-option-unavailable:GPT-5\.6 Sol/);
  assert.equal(page.phases.includes('open-effort'), false);
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

test('loadingFinished waits for delayed stream setup before falling back to the full body', async () => {
  const client = new FakeCdpSession();
  let releaseStream;
  let streamStarted;
  const streamStartedPromise = new Promise(resolve => { streamStarted = resolve; });
  const streamReady = new Promise(resolve => { releaseStream = resolve; });
  const originalSend = client.send.bind(client);
  client.send = async (method, params) => {
    if (method === 'Network.streamResourceContent') {
      client.calls.push({ method, params });
      streamStarted();
      await streamReady;
      return { bufferedData: Buffer.from('data: {"p":"/message/content/parts/0","o":"append","v":"one"}\n\n').toString('base64') };
    }
    return originalSend(method, params);
  };
  client.responses.set('Network.getResponseBody', { body: 'data: {"p":"/message/content/parts/0","o":"append","v":"one"}\n\n' });
  const tracker = await createChatGptNetworkTracker({ page: pageFor(client), selectedModel: 'instant' });
  try {
    client.emit('Network.requestWillBeSent', { requestId: 'request', request: { method: 'POST', url: 'https://chatgpt.com/backend-api/f/conversation' } });
    client.emit('Network.responseReceived', { requestId: 'request', response: { url: 'https://chatgpt.com/backend-api/f/conversation', status: 200, mimeType: 'text/event-stream' } });
    await streamStartedPromise;
    client.emit('Network.loadingFinished', { requestId: 'request' });
    releaseStream();
    await new Promise(resolve => setTimeout(resolve, 0));
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
      readConversation: async () => null,
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
    assistant: { id: 'assistant', parent: 'user', message: { id: 'a', author: { role: 'assistant' }, create_time: 3, update_time: 4, channel: 'final', status: final ? 'finished_successfully' : 'in_progress', end_turn: final, content: { parts: ['answer'], citations: [{ url: 'content-citation' }] }, metadata: { model_slug: 'gpt-5-6-thinking', thinking_effort: 'max', turn_exchange_id: 'turn-1', citations: [{ url: 'citation' }], content_references: [{ type: 'webpage' }], search_result_groups: [{ type: 'search' }], story_events: [{ type: 'tool' }], resume_token: 'secret' } } },
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

test('network tracker redacts credential-bearing query values in raw delta callbacks', async () => {
  const client = new FakeCdpSession(); const events = [];
  const secrets = ['AUTH_SECRET', 'SESSION_SECRET', 'AWS_SECRET', 'GOOGLE_SECRET', 'X_GOOG_SECRET'];
  const delta = 'ordinary prose survives https://storage.example/path?auth=AUTH_SECRET&session=SESSION_SECRET&AWSAccessKeyId=AWS_SECRET&GoogleAccessId=GOOGLE_SECRET&X-Goog-Credential=X_GOOG_SECRET&safe=preserved#fragment';
  const frame = `data: ${JSON.stringify({ p: '/message/content/parts/0', o: 'append', v: delta })}\n\n`;
  client.responses.set('Network.streamResourceContent', { bufferedData: Buffer.from(frame).toString('base64') });
  const tracker = await createChatGptNetworkTracker({ page: pageFor(client), selectedModel: 'instant', onStreamEvent: event => events.push(event) });
  try {
    client.emit('Network.requestWillBeSent', { requestId: 'request', request: { method: 'POST', url: 'https://chatgpt.com/backend-api/f/conversation' } });
    client.emit('Network.responseReceived', { requestId: 'request', response: { status: 200, mimeType: 'text/event-stream' } });
    await new Promise(resolve => setImmediate(resolve));
    const payload = events.find(event => event.event === 'delta');
    assert.ok(payload);
    const captured = JSON.stringify(payload);
    for (const secret of secrets) assert.equal(captured.includes(secret), false);
    assert.match(payload.text, /ordinary prose survives/);
    assert.match(payload.text, /\?auth=\[redacted\]&session=\[redacted\]&AWSAccessKeyId=\[redacted\]&GoogleAccessId=\[redacted\]&X-Goog-Credential=\[redacted\]&safe=preserved#fragment/);
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

test('structured turn and live deltas redact signature and cloud credential fields without altering prose', async () => {
  const markers = ['SIGNATURE_MARKER', 'SIG_MARKER', 'AWS_MARKER', 'GOOGLE_MARKER', 'AMZ_MARKER', 'GOOG_MARKER'];
  const secretJson = JSON.stringify({ signature: markers[0], sig: markers[1], awsAccessKeyId: markers[2], googleAccessId: markers[3], xAmzCredential: markers[4], xGoogCredential: markers[5] });
  const detail = completeDetail();
  detail.conversation.mapping.assistant.message.content.parts = [`signature verification matters; tokenization; key=music; ${secretJson}`];
  detail.conversation.mapping.assistant.message.metadata = { ...detail.conversation.mapping.assistant.message.metadata, signature: markers[0], sig: markers[1], awsAccessKeyId: markers[2], googleAccessId: markers[3], xAmzCredential: markers[4], xGoogCredential: markers[5], design: 'ordinary' };
  const turn = selectChatGptStructuredTurn(detail);
  const structured = JSON.stringify(turn);
  for (const marker of markers) assert.equal(structured.includes(marker), false, marker);
  assert.match(turn.text, /signature verification matters; tokenization; key=music/);
  assert.equal(turn.final.metadata.design, 'ordinary');

  const client = new FakeCdpSession(); const events = [];
  const frame = `data: ${JSON.stringify({ p: '/message/content/parts/0', o: 'append', v: `signature verification matters; tokenization; key=music; ${secretJson}` })}\n\n`;
  client.responses.set('Network.streamResourceContent', { bufferedData: Buffer.from(frame).toString('base64') });
  const tracker = await createChatGptNetworkTracker({ page: pageFor(client), selectedModel: 'instant', onStreamEvent: event => events.push(event) });
  try {
    client.emit('Network.requestWillBeSent', { requestId: 'request', request: { method: 'POST', url: 'https://chatgpt.com/backend-api/f/conversation' } });
    client.emit('Network.responseReceived', { requestId: 'request', response: { status: 200, mimeType: 'text/event-stream' } });
    await new Promise(resolve => setImmediate(resolve));
    const eventText = JSON.stringify(events);
    for (const marker of markers) assert.equal(eventText.includes(marker), false, marker);
    assert.match(events.find(event => event.event === 'delta').text, /signature verification matters; tokenization; key=music/);
  } finally { await tracker.dispose(); }
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

test('waitForResponse rejects a fatal tracker progress failure raised during a deferred detail read', async () => {
  const client = new FakeCdpSession();
  const initial = `data: ${JSON.stringify({ conversation_id: 'provider_1' })}\n\n`;
  client.responses.set('Network.streamResourceContent', { bufferedData: Buffer.from(initial).toString('base64') });
  let throwOnProgress = false;
  const tracker = await createChatGptNetworkTracker({ page: pageFor(client), selectedModel: 'instant', onStreamEvent: () => { if (throwOnProgress) throw new Error('transcript append failed'); } });
  let releaseDetail;
  const detailPending = new Promise(resolve => { releaseDetail = resolve; });
  try {
    client.emit('Network.requestWillBeSent', { requestId: 'request', request: { method: 'POST', url: 'https://chatgpt.com/backend-api/f/conversation' } });
    client.emit('Network.responseReceived', { requestId: 'request', response: { status: 200, mimeType: 'text/event-stream' } });
    await new Promise(resolve => setImmediate(resolve));
    const response = chatgptProvider.waitForResponse({ page: { url: () => 'https://chatgpt.com/c/provider_1' }, timeoutMs: 1_000, selectedModel: 'instant', request: {}, networkTracker: tracker, readConversation: async () => detailPending, sleepFn: async () => {} });
    await new Promise(resolve => setImmediate(resolve));
    throwOnProgress = true;
    const delta = `data: ${JSON.stringify({ p: '/message/content/parts/0', o: 'append', v: 'delta' })}\n\n`;
    client.emit('Network.dataReceived', { requestId: 'request', data: Buffer.from(delta).toString('base64') });
    releaseDetail(completeDetail());
    await assert.rejects(() => response, /Failed to emit ChatGPT stream progress/);
  } finally { await tracker.dispose(); }
});

test('continuation ignores the old complete node and completes only after the branch changes', async () => {
  const oldDetail = completeDetail();
  const continued = structuredClone(oldDetail);
  continued.conversation.mapping.user2 = { id: 'user2', parent: 'assistant', message: { id: 'u2', author: { role: 'user' }, create_time: 5, content: { parts: ['follow-up'] } } };
  continued.conversation.mapping.assistant2 = { id: 'assistant2', parent: 'user2', message: { ...structuredClone(oldDetail.conversation.mapping.assistant.message), id: 'a2', create_time: 6, update_time: 7, content: { parts: ['follow-up answer'] }, metadata: { ...oldDetail.conversation.mapping.assistant.message.metadata, turn_exchange_id: 'turn-2' } } };
  continued.conversation.current_node = 'assistant2';
  let reads = 0;
  const result = await chatgptProvider.waitForResponse({
    page: { url: () => 'https://chatgpt.com/c/provider_1' }, timeoutMs: 2_000, selectedModel: 'default', request: {},
    attemptContext: { expectedConversationId: 'provider_1', baselineCurrentNode: 'assistant' },
    networkTracker: { snapshot: () => ({ conversationId: 'provider_1', observedPayloadModel: 'gpt-observed', observedPayloadThinkingEffort: 'extended', transport: 'network-incremental-sse' }) },
    readConversation: async () => reads++ === 0 ? oldDetail : continued,
    sleepFn: async () => {},
  });
  assert.equal(result.done, true);
  assert.equal(result.providerConversationId, 'provider_1');
  assert.equal(result.modelUsed, 'gpt-5-6-thinking');
  assert.deepEqual(result.providerState.structured_turn.messages.map(message => message.id), ['u2', 'a2']);
  assert.deepEqual({
    user: result.providerState.structured_turn.user_message_id,
    assistant: result.providerState.structured_turn.assistant_message_id,
    exchange: result.providerState.structured_turn.turn_exchange_id,
    started: result.providerState.structured_turn.started_at,
    completed: result.providerState.structured_turn.completed_at,
  }, { user: 'u2', assistant: 'a2', exchange: 'turn-2', started: 5, completed: 7 });
  assert.equal(result.providerState.structured_turn.citations[0].url, 'citation');
  assert.equal(result.providerState.structured_turn.content_references[0].type, 'webpage');
  assert.equal(result.providerState.structured_turn.search_result_groups[0].type, 'search');
  assert.equal(result.providerState.structured_turn.story_events[0].type, 'tool');
  assert.doesNotMatch(JSON.stringify(result), /secret|hidden/);
});

test('continuation polls its preflighted provider id when the stream omits it', async () => {
  const updated = completeDetail();
  updated.conversation.mapping['new-assistant'] = structuredClone(updated.conversation.mapping.assistant);
  updated.conversation.mapping['new-assistant'].parent = updated.conversation.mapping.assistant.parent;
  updated.conversation.current_node = 'new-assistant';
  const result = await chatgptProvider.waitForResponse({
    page: { url: () => 'https://chatgpt.com/c/provider_1' }, timeoutMs: 1_000, selectedModel: 'default', request: {},
    attemptContext: { expectedConversationId: 'provider_1', baselineCurrentNode: 'assistant' },
    networkTracker: { snapshot: () => ({ requestConversationId: 'provider_1', observedPayloadModel: 'gpt-observed', transport: 'network-incremental-sse' }) },
    readConversation: async (_page, id) => { assert.equal(id, 'provider_1'); return updated; }, sleepFn: async () => {},
  });
  assert.equal(result.done, true);
  assert.equal(result.providerConversationId, 'provider_1');
});

test('continuation propagates authentication errors and exhausted transient detail errors', async () => {
  const common = { page: { url: () => 'https://chatgpt.com/c/provider_1' }, timeoutMs: 1_000, selectedModel: 'default', request: {}, attemptContext: { expectedConversationId: 'provider_1', baselineCurrentNode: 'assistant' }, networkTracker: { snapshot: () => ({ requestConversationId: 'provider_1', transport: 'network-incremental-sse' }) }, sleepFn: async () => {} };
  await assert.rejects(() => chatgptProvider.waitForResponse({ ...common, readConversation: async () => { throw new Error('[chatgpt] Authentication is unavailable or expired.'); } }), /Authentication is unavailable/);
  await assert.rejects(() => chatgptProvider.waitForResponse({ ...common, readConversation: async () => { throw new Error('[chatgpt] Conversation status read failed with HTTP 503.'); } }), /status read failed with HTTP 503/);
});

test('continuation timeout does not return or stream the unchanged prior turn', async () => {
  const events = [];
  const result = await chatgptProvider.waitForResponse({
    page: { url: () => 'https://chatgpt.com/c/provider_1' }, timeoutMs: 1_000, selectedModel: 'default', request: {},
    attemptContext: { expectedConversationId: 'provider_1', baselineCurrentNode: 'assistant' },
    networkTracker: { snapshot: () => ({ conversationId: 'provider_1', observedPayloadModel: 'gpt-observed', text: 'untrusted stream progress', transport: 'network-incremental-sse' }) },
    onStreamEvent: event => events.push(event),
    readConversation: async () => completeDetail(), sleepFn: async () => {},
  });
  assert.equal(result.done, false);
  assert.equal(result.providerConversationId, 'provider_1');
  assert.equal(result.modelUsed, 'gpt-observed');
  assert.equal(result.text, '');
  assert.equal(result.rawText, '');
  assert.equal(result.searchResults.length, 0);
  assert.equal(result.providerState.structured_turn, null);
  assert.equal(result.providerState.partial, false);
  assert.equal(result.providerState.empty_response, true);
  assert.doesNotMatch(JSON.stringify(result), /answer|untrusted stream progress/);
  assert.equal(events.some(event => event.event === 'message'), false);
});

test('normal ChatGPT submissions fail promptly on rejected responses but not after acceptance', async () => {
  for (const status of [422, 429, 500]) {
    await assert.rejects(
      () => chatgptProvider.waitForResponse({
        page: { url: () => 'https://chatgpt.com/' }, timeoutMs: 1_000, selectedModel: 'instant', request: {},
        networkTracker: { snapshot: () => ({ responseStatuses: [{ status }], acceptedResponse: false, transport: 'network-incremental-sse' }) },
        sleepFn: async () => assert.fail('rejected submission must not wait for timeout'),
      }),
      new RegExp(`Submission failed with HTTP ${status}`),
    );
  }

  const accepted = await chatgptProvider.waitForResponse({
    page: { url: () => 'https://chatgpt.com/c/provider_1' }, timeoutMs: 1_000, selectedModel: 'instant', request: {},
    networkTracker: { snapshot: () => ({ conversationId: 'provider_1', responseStatuses: [{ status: 429 }], acceptedResponse: true, transport: 'network-incremental-sse' }) },
    readConversation: async () => completeDetail(), sleepFn: async () => {},
  });
  assert.equal(accepted.done, true);
  assert.equal(accepted.text, 'answer');
});

test('continuation request identity mismatch emits no accepted progress', async () => {
  let clock = 0; const events = []; const client = new FakeCdpSession();
  const tracker = await createChatGptNetworkTracker({ page: pageFor(client), selectedModel: 'default', expectedConversationId: 'provider_1', preserveSelection: true, onStreamEvent: event => events.push(event), now: () => clock, sleepFn: async () => { clock += 100; } });
  try {
    client.emit('Network.requestWillBeSent', { requestId: 'request', request: { method: 'POST', url: 'https://chatgpt.com/backend-api/f/conversation', postData: '{"conversation_id":"provider_2"}' } });
    client.emit('Network.responseReceived', { requestId: 'request', response: { status: 200, mimeType: 'text/event-stream' } });
    await assert.rejects(() => tracker.waitForSubmission(100), /request conversation id did not match/);
    assert.deepEqual(events, []);
  } finally { await tracker.dispose(); }
});

test('continuation stream identity mismatch emits no session', async () => {
  const events = []; const client = new FakeCdpSession();
  client.responses.set('Network.streamResourceContent', { bufferedData: Buffer.from('data: {"conversation_id":"provider_2"}\n\n').toString('base64') });
  const tracker = await createChatGptNetworkTracker({ page: pageFor(client), selectedModel: 'default', expectedConversationId: 'provider_1', preserveSelection: true, onStreamEvent: event => events.push(event) });
  try {
    client.emit('Network.requestWillBeSent', { requestId: 'request', request: { method: 'POST', url: 'https://chatgpt.com/backend-api/f/conversation', postData: '{"conversation_id":"provider_1"}' } });
    client.emit('Network.responseReceived', { requestId: 'request', response: { status: 200, mimeType: 'text/event-stream' } });
    await new Promise(resolve => setImmediate(resolve));
    assert.match(tracker.snapshot().error, /stream conversation id did not match/);
    assert.equal(events.some(event => event.event === 'session'), false);
  } finally { await tracker.dispose(); }
});

test('provider-marked temporary ChatGPT conversations cannot be continued or detached-read', async () => {
  const temporaryDetail = { conversation: { is_temporary_chat: true, current_node: 'node' }, streamStatus: { status: 'COMPLETE' } };
  const page = { url: () => 'https://chatgpt.com/c/temp_123' };
  await assert.rejects(
    () => chatgptProvider.preflight({ page, request: { conversationTarget: 'temp_123' }, conversation: { providerId: 'temp_123' }, readConversation: async () => temporaryDetail }),
    /Temporary conversations cannot be continued/,
  );
  let emitted = false;
  const browser = { pages: async () => [], newPage: async () => ({ url: () => 'https://chatgpt.com/c/temp_123', goto: async () => {} }) };
  await assert.rejects(
    () => chatgptProvider.recheckConversation({ browser, conversation: { providerId: 'temp_123', url: 'https://chatgpt.com/c/temp_123' }, readConversation: async () => temporaryDetail, onStreamEvent: () => { emitted = true; } }),
    /Temporary conversations cannot be continued/,
  );
  assert.equal(emitted, false);
  const persistent = { conversation: { is_temporary_chat: false, current_node: 'node' }, streamStatus: { status: 'COMPLETE' } };
  const context = await chatgptProvider.preflight({ page, request: { conversationTarget: 'temp_123' }, conversation: { providerId: 'temp_123' }, readConversation: async () => persistent });
  assert.equal(context.baselineCurrentNode, 'node');
});

test('ChatGPT timeout does not return raw SSE progress without a structured turn', async () => {
  const tracker = { throwIfFatalProgressError() {}, snapshot: () => ({ text: 'unsafe SSE progress', conversationId: 'safe_123' }) };
  const result = await chatgptProvider.waitForResponse({ page: { url: () => 'https://chatgpt.com/c/safe_123' }, timeoutMs: 0, networkTracker: tracker, selectedModel: 'extra-high', readConversation: async () => null });
  assert.equal(result.text, '');
  assert.equal(result.rawText, '');
});
