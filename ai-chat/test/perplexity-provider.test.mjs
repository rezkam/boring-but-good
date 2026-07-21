import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PERPLEXITY_NETWORK_BOOTSTRAP_URL,
  buildPerplexityPayload,
  buildPerplexityProviderStates,
  createPerplexityBrowserFetch,
  DEFAULT_PERPLEXITY_DEEP_RESEARCH_TIMEOUT_SECONDS,
  extractPerplexityState,
  formatCitations,
  normalizePerplexityFileAttachments,
  normalizePerplexitySpaceUuid,
  openPerplexityNetworkPage,
  parseSseLine,
  perplexityConversationUrl,
  perplexityAuthFailureMessage,
  perplexityProvider,
  resolvePerplexityConversationAttachment,
  resolvePerplexityModel,
  resolvePerplexityRequestModel,
  resolvePerplexityTimeoutSeconds,
  streamPerplexity,
  uploadPerplexityAttachments,
  validatePerplexitySession,
  verifyPerplexityModels,
} from '../scripts/ai-chat/providers/perplexity.mjs';

test('resolves Perplexity model ids, display names, and direct tool aliases', () => {
  assert.equal(resolvePerplexityModel('perplexity/deep-research').identifier, 'pplx_alpha');
  assert.equal(resolvePerplexityModel('GPT-5.6 Terra').identifier, 'gpt56_terra');
  assert.equal(resolvePerplexityModel('pplx_gpt56_terra_thinking').identifier, 'gpt56_terra_thinking');
  assert.equal(resolvePerplexityModel('pplx_nemotron3_ultra_thinking').identifier, 'nv_nemotron_3_ultra');
  assert.equal(resolvePerplexityModel('reasoning').id, 'openai/gpt-5.6-terra-thinking');

  const directTools = {
    pplx_best: 'perplexity/best',
    pplx_deep_research: 'perplexity/deep-research',
    pplx_sonar: 'perplexity/sonar-2',
    pplx_gpt56_terra: 'openai/gpt-5.6-terra',
    pplx_gpt56_terra_thinking: 'openai/gpt-5.6-terra-thinking',
    pplx_nemotron3_ultra_thinking: 'nvidia/nemotron-3-ultra-thinking',
  };

  for (const [alias, expectedId] of Object.entries(directTools)) {
    assert.equal(resolvePerplexityModel(alias).id, expectedId, alias);
  }
  assert.equal(resolvePerplexityModel('openai/gpt-5.4-thinking'), null);
});

test('Perplexity exposes canonical provider thread URLs from backend UUIDs', () => {
  const backendUuid = '1fcf54fa-dd85-4b77-a916-dc12f8a8efa5';
  const url = `https://www.perplexity.ai/search/${backendUuid}`;

  assert.equal(perplexityConversationUrl(backendUuid), url);
  assert.deepEqual(resolvePerplexityConversationAttachment({ target: backendUuid }), {
    type: 'provider_id',
    url,
    providerId: backendUuid,
    providerState: { backend_uuid: backendUuid },
  });
  assert.deepEqual(resolvePerplexityConversationAttachment({ target: url }), {
    type: 'url',
    url,
    providerId: backendUuid,
    providerState: { backend_uuid: backendUuid },
  });
});

test('lists Perplexity models with capability and account-tier metadata', async () => {
  const list = await perplexityProvider.listModels({ request: { verifyModels: false } });
  assert.equal(list.model_source, 'browser-tools-network-contract-registry');
  assert.equal(list.models.length, 6);
  assert.equal(list.models.some(model => model.min_tier === 'max'), false);
  assert.equal(list.models.some(model => model.id === 'openai/gpt-5.5-thinking'), false);
  const thinking = list.models.find(model => model.id === 'openai/gpt-5.6-terra-thinking');
  assert.equal(thinking.thinking, true);
  assert.equal(thinking.thinking_level, 'default');
  assert.equal(thinking.provider_family, 'openai');
  assert.equal(thinking.min_tier, 'pro');
  assert.equal(thinking.source, 'browser-tools-network-capture');
  assert.equal(thinking.account_specific, false);
  assert.deepEqual(thinking.account_tier, { required: 'pro', verified: null });
  assert.equal(perplexityProvider.historyPolicy.default, 'persistent');
  assert.equal(list.verification.enabled, false);
});

test('Perplexity validates auth through managed browser network requests without reading cookies or env tokens', async () => {
  const previousEnv = process.env.PERPLEXITY_SESSION_TOKEN;
  process.env.PERPLEXITY_SESSION_TOKEN = 'env-token-should-not-be-used';
  const calls = [];

  try {
    const session = await validatePerplexitySession({
      fetchImpl: async (url, options) => {
        calls.push({ url: String(url), options });
        return { ok: true, json: async () => ({ user: { id: 'account-present' } }) };
      },
    });
    assert.equal(session.authenticated, true);
    assert.equal(session.source, 'Browser Tools same-origin network session');
    assert.deepEqual(calls.map(call => call.url), [PERPLEXITY_NETWORK_BOOTSTRAP_URL]);
    assert.equal(JSON.stringify(calls).includes('Cookie'), false);
    assert.equal(JSON.stringify(session).includes('account-present'), false);
    assert.equal(JSON.stringify(session).includes('env-token-should-not-be-used'), false);
  } finally {
    if (previousEnv === undefined) delete process.env.PERPLEXITY_SESSION_TOKEN;
    else process.env.PERPLEXITY_SESSION_TOKEN = previousEnv;
  }
});

test('Perplexity opens a dedicated JSON network context without inspecting page content', async () => {
  const navigations = [];
  const page = {
    url: () => 'about:blank',
    goto: async (url, options) => navigations.push({ url, options }),
  };
  const browser = {
    pages: async () => [],
    newPage: async (options) => {
      assert.deepEqual(options, { background: true });
      return page;
    },
  };

  assert.equal(await openPerplexityNetworkPage(browser), page);
  assert.deepEqual(navigations, [{
    url: PERPLEXITY_NETWORK_BOOTSTRAP_URL,
    options: { waitUntil: 'domcontentloaded', timeout: 30000 },
  }]);
});

test('Perplexity returns the created provider thread URL from the backend UUID', async () => {
  const backendUuid = '1fcf54fa-dd85-4b77-a916-dc12f8a8efa5';
  const callbacks = {};
  const page = {
    url: () => PERPLEXITY_NETWORK_BOOTSTRAP_URL,
    exposeFunction: async (name, callback) => { callbacks[name] = callback; },
    evaluate: async (_fn, args) => {
      if (typeof args === 'string') return;
      const callback = callbacks[args.callbackName];
      await callback({ type: 'response', status: 200, headers: [['content-type', 'application/json']] });
      if (args.url === PERPLEXITY_NETWORK_BOOTSTRAP_URL) {
        await callback({ type: 'chunk', chunk: JSON.stringify({ user: { id: 'account-present' } }) });
      } else {
        await callback({
          type: 'chunk',
          chunk: `data: ${JSON.stringify({
            status: 'COMPLETED',
            final_sse_message: true,
            backend_uuid: backendUuid,
            text: JSON.stringify({ answer: 'thread answer', chunks: ['thread answer'] }),
          })}\n`,
        });
      }
      await callback({ type: 'done' });
    },
  };
  const result = await perplexityProvider.run({
    browser: { pages: async () => [page] },
    request: { prompt: 'start a thread', modelName: 'perplexity/best', timeoutSeconds: 1, providerOptions: {} },
    selectedModel: 'perplexity/best',
    conversation: null,
  });

  assert.equal(result.done, true);
  assert.equal(result.providerState.backend_uuid, backendUuid);
  assert.equal(result.providerState.thread_url, `https://www.perplexity.ai/search/${backendUuid}`);
  assert.equal(result.finalUrl, `https://www.perplexity.ai/search/${backendUuid}`);
});

test('Perplexity exposes only the browser network transport and no UI lifecycle fallback', () => {
  const source = readFileSync(new URL('../scripts/ai-chat/providers/perplexity.mjs', import.meta.url), 'utf-8');
  for (const pattern of [
    /document\./,
    /querySelector/,
    /innerText/,
    /textContent/,
    /\.click\(/,
    /\.type\(/,
    /\.cookies\(/,
    /page\.content/,
  ]) {
    assert.doesNotMatch(source, pattern);
  }
  for (const method of ['findPage', 'createAttemptContext', 'clearInput', 'typePrompt', 'submit', 'waitForResponse']) {
    assert.equal(Object.prototype.hasOwnProperty.call(perplexityProvider, method), false, method);
  }
  assert.equal(perplexityProvider.transport, 'browser-network-sse');
  assert.equal(perplexityProvider.preferredBrowserHeadless, true);
});

test('Perplexity browser fetch uses page credentials and strips unsafe cookie headers', async () => {
  const calls = {};
  let evaluated = null;
  const page = {
    exposeFunction: async (name, fn) => {
      calls[name] = fn;
    },
    evaluate: async (fn, args) => {
      evaluated = args;
      await calls[args.callbackName]({
        type: 'response',
        status: 200,
        statusText: 'OK',
        headers: [['content-type', 'text/event-stream']],
      });
      await calls[args.callbackName]({ type: 'chunk', chunk: 'data: {"answer":"ok"}\n\n' });
      await calls[args.callbackName]({ type: 'done' });
    },
  };

  const fetchImpl = createPerplexityBrowserFetch(page, async () => assert.fail('same-origin Perplexity fetch should use browser context'));
  const response = await fetchImpl('https://www.perplexity.ai/rest/sse/perplexity_ask', {
    method: 'POST',
    headers: {
      Cookie: '__Secure-next-auth.session-token=secret',
      Origin: 'https://www.perplexity.ai',
      Referer: 'https://www.perplexity.ai/',
      'Content-Type': 'application/json',
    },
    body: '{"query":"hello"}',
  });

  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'data: {"answer":"ok"}\n\n');
  assert.equal(evaluated.options.headers.Cookie, undefined);
  assert.equal(evaluated.options.headers.Origin, undefined);
  assert.equal(evaluated.options.headers.Referer, undefined);
  assert.equal(evaluated.options.headers['Content-Type'], 'application/json');
  assert.equal(evaluated.options.body, '{"query":"hello"}');
});

test('Perplexity same-origin requests fail closed instead of falling back to Node fetch', async () => {
  let fallbackCalls = 0;
  const fetchImpl = createPerplexityBrowserFetch(null, async () => {
    fallbackCalls += 1;
    return { ok: true };
  });

  await assert.rejects(
    () => fetchImpl('https://www.perplexity.ai/rest/sse/perplexity_ask'),
    /managed Browser Tools page context.*fallbacks are disabled/i,
  );
  assert.equal(fallbackCalls, 0);
  assert.equal((await fetchImpl('https://uploads.example.test/file')).ok, true);
  assert.equal(fallbackCalls, 1);
});

test('Perplexity stream timeout aborts the in-browser fetch', async () => {
  const exposed = {};
  let browserAbortCalls = 0;
  const page = {
    async exposeFunction(name, callback) { exposed[name] = callback; },
    async evaluate(_fn, args) {
      if (typeof args === 'string') {
        browserAbortCalls += 1;
        return;
      }
      await exposed[args.callbackName]({ type: 'response', status: 200, headers: [['content-type', 'text/event-stream']] });
      return new Promise(() => {});
    },
  };
  const fetchImpl = createPerplexityBrowserFetch(page);

  await assert.rejects(
    () => streamPerplexity({
      payload: buildPerplexityPayload({ query: 'hello', model: resolvePerplexityModel('perplexity/best') }),
      timeoutMs: 5,
      citationMode: 'clean',
      fetchImpl,
    }),
    (error) => error.name === 'AbortError' && /Browser fetch aborted/.test(error.message),
  );
  assert.equal(browserAbortCalls, 1);
});

test('Perplexity auth failures include recovery guidance without token values', async () => {
  await assert.rejects(
    () => validatePerplexitySession({
      fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'not authenticated' }),
    }),
    /Perplexity authentication failed.*Log in to perplexity\.ai.*--sync/s,
  );

  const message = perplexityAuthFailureMessage({ source: 'Browser Tools same-origin network session', chromeError: 'session missing' });
  assert.match(message, /Perplexity authentication failed for Browser Tools same-origin network session/i);
  assert.match(message, /Log in to perplexity\.ai in the selected Chrome profile/i);
  assert.match(message, /stop it with --clean, restart with --sync/i);
  assert.match(message, /never extracts Perplexity cookies or reads PERPLEXITY_SESSION_TOKEN or PPLX_SESSION_TOKEN/i);

  const payload = buildPerplexityPayload({
    query: 'hello',
    model: resolvePerplexityModel('perplexity/best'),
  });
  const fetchCalls = [];
  const fetchImpl = async (url) => {
    fetchCalls.push(String(url));
    return {
      ok: false,
      status: 403,
      text: async () => '{"read_write_token":"rw-secret"}',
    };
  };

  await assert.rejects(
    () => streamPerplexity({ payload, timeoutMs: 1000, citationMode: 'clean', fetchImpl }),
    (error) => {
      assert.match(error.message, /Perplexity authentication failed/);
      assert.equal(error.message.includes('rw-secret'), false);
      return true;
    },
  );
  assert.deepEqual(fetchCalls, ['https://www.perplexity.ai/rest/sse/perplexity_ask']);

  await assert.rejects(
    () => streamPerplexity({ payload, timeoutMs: 1000, citationMode: 'clean', fetchImpl, authPrevalidated: true }),
    (error) => {
      assert.match(error.message, /model rejected or unavailable/i);
      assert.equal(error.message.includes('rw-secret'), false);
      return true;
    },
  );
});

test('Perplexity live model verification uses private requests and reports accepted and rejected shape safely', async () => {
  const models = [resolvePerplexityModel('perplexity/best'), resolvePerplexityModel('openai/gpt-5.6-terra')];
  const payloads = [];
  const result = await verifyPerplexityModels({
    models,
    timeoutMs: 1000,
    streamFn: async ({ model, payload }) => {
      payloads.push(payload);
      if (model.id === 'perplexity/best') {
        return { answer: 'AI_CHAT_MODEL_CHECK', chunks: [], backendUuid: 'uuid-accepted' };
      }
      throw new Error('Perplexity HTTP 403: {"read_write_token":"rw-verification-secret"}');
    },
  });

  assert.equal(result.verification.accepted_count, 1);
  assert.equal(result.verification.rejected_count, 1);
  assert.deepEqual(result.verification.accepted_model_ids, ['perplexity/best']);
  assert.deepEqual(result.verification.rejected_model_ids, ['openai/gpt-5.6-terra']);
  assert.equal(result.models[0].verification.status, 'accepted');
  assert.equal(result.models[0].verification.accepted, true);
  assert.equal(result.models[1].verification.status, 'rejected');
  assert.equal(result.models[1].verification.accepted, false);
  assert.equal(JSON.stringify(result).includes('rw-verification-secret'), false);
  assert.equal(payloads.every(payload => payload.params.is_incognito === true), true);
});

test('Perplexity provider rejects unknown explicit model requests', async () => {
  const request = { prompt: 'hello', modelName: 'definitely-not-real', timeoutSeconds: 1, providerOptions: {} };
  await assert.rejects(
    () => perplexityProvider.run({ browser: {}, request, selectedModel: 'definitely-not-real' }),
    /\[perplexity\] Unknown model: definitely-not-real.*--list-models/s,
  );
});

test('Perplexity provider resolves defaults, task aliases, and captured Thinking variants', () => {
  const defaultModel = resolvePerplexityRequestModel({ request: { modelName: 'default' }, selectedModel: 'default' });
  const reasoningModel = resolvePerplexityRequestModel({ request: { modelName: 'default' }, selectedModel: 'reasoning' });
  const taskModel = resolvePerplexityRequestModel({ request: { modelName: 'default', modelTask: 'coding' }, selectedModel: perplexityProvider.taskModels.coding });
  const thinkingModel = resolvePerplexityRequestModel({ request: { thinking: true }, selectedModel: 'openai/gpt-5.6-terra' });

  assert.equal(defaultModel.id, 'perplexity/best');
  assert.equal(reasoningModel.id, 'openai/gpt-5.6-terra-thinking');
  assert.equal(taskModel.id, 'openai/gpt-5.6-terra');
  assert.equal(thinkingModel.id, 'openai/gpt-5.6-terra-thinking');
  assert.equal(thinkingModel.identifier, 'gpt56_terra_thinking');
  assert.throws(
    () => resolvePerplexityRequestModel({ request: { thinking: true }, selectedModel: 'perplexity/sonar-2' }),
    /has no captured Thinking variant/,
  );
});

test('builds Perplexity payload with continuation and research options', () => {
  const payload = buildPerplexityPayload({
    query: 'follow up',
    model: resolvePerplexityModel('perplexity/deep-research'),
    options: {
      sourceFocus: ['academic,web', 'finance'],
      searchFocus: 'writing',
      timeRange: 'week',
      language: 'sv-SE',
      timezone: 'Europe/Stockholm',
    },
    conversation: { record: { provider_state: { backend_uuid: 'uuid-1', read_write_token: 'rw-1' } } },
  });

  assert.equal(payload.params.model_preference, 'pplx_alpha');
  assert.equal(payload.params.mode, 'research');
  assert.deepEqual(payload.params.sources, ['scholar', 'web', 'edgar']);
  assert.equal(payload.params.search_focus, 'writing');
  assert.equal(payload.params.search_recency_filter, 'WEEK');
  assert.equal(payload.params.language, 'sv-SE');
  assert.equal(payload.params.timezone, 'Europe/Stockholm');
  assert.equal(payload.params.is_incognito, false);
  assert.equal(payload.params.use_schematized_api, true);
  assert.equal(payload.params.send_back_text_in_streaming_api, false);
  assert.equal(payload.params.dsl_query, 'follow up');
  assert.equal(payload.params.skip_search_enabled, true);
  assert.equal(payload.params.always_search_override, false);
  assert.equal(payload.params.override_no_search, false);
  assert.match(payload.params.frontend_uuid, /^[0-9a-f-]{36}$/i);
  assert.match(payload.params.frontend_context_uuid, /^[0-9a-f-]{36}$/i);
  assert.match(payload.params.rum_session_id, /^[0-9a-f-]{36}$/i);
  assert.equal(payload.params.supported_block_use_cases.includes('diff_blocks'), true);
  assert.equal(payload.params.supported_block_use_cases.includes('workflow_steps'), true);
  assert.equal(payload.params.last_backend_uuid, 'uuid-1');
  assert.equal(payload.params.read_write_token, 'rw-1');
  assert.equal(payload.params.query_source, 'followup');
});

test('builds explicit Incognito payloads and defaults ordinary requests to persistent history', () => {
  const model = resolvePerplexityModel('perplexity/sonar-2');
  const explicit = buildPerplexityPayload({
    query: 'private question',
    model,
    options: { incognito: true },
  });
  const defaultPersistent = buildPerplexityPayload({ query: 'ordinary question', model });

  assert.equal(explicit.params.is_incognito, true);
  assert.equal(explicit.params.query_source, 'home');
  assert.equal(explicit.requestMetadata.incognito_explicit, true);
  assert.equal(defaultPersistent.params.is_incognito, false);
  assert.equal(defaultPersistent.requestMetadata.incognito_explicit, false);
  assert.throws(
    () => buildPerplexityPayload({ query: 'conflict', model, options: { incognito: true, saveToLibrary: true } }),
    /either --incognito or --save-to-library/,
  );
  assert.throws(
    () => buildPerplexityPayload({
      query: 'space conflict',
      model,
      options: { incognito: true, spaceUuid: '123e4567-e89b-12d3-a456-426614174000' },
    }),
    /--incognito cannot be combined with --space-uuid/,
  );
});

test('Perplexity rejects Incognito conflicts before opening a browser network context', async () => {
  let browserCalls = 0;
  const browser = {
    async pages() {
      browserCalls += 1;
      return [];
    },
  };

  await assert.rejects(
    () => perplexityProvider.run({
      browser,
      request: {
        prompt: 'private question',
        modelName: 'perplexity/best',
        providerOptions: { incognito: true, saveToLibrary: true },
      },
      selectedModel: 'perplexity/best',
      conversation: null,
    }),
    /either --incognito or --save-to-library/,
  );
  assert.equal(browserCalls, 0);
});

test('builds Perplexity payload with uploaded attachments, Space selection, and new-turn continuation only', () => {
  const spaceUuid = '123e4567-e89b-12d3-a456-426614174000';
  const payload = buildPerplexityPayload({
    query: 'new user turn only',
    model: resolvePerplexityModel('perplexity/best'),
    options: {
      spaceUuid,
      uploadedAttachments: [{
        url: 'https://uploads.example.test/report.pdf',
        filename: 'report.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1234,
        isImage: false,
      }],
    },
    conversation: {
      record: {
        provider_state: { backend_uuid: 'uuid-previous', read_write_token: 'rw-previous' },
        messages: [{ role: 'user', content: 'old turn must not be replayed' }],
      },
    },
  });

  assert.deepEqual(payload.params.attachments, ['https://uploads.example.test/report.pdf']);
  assert.equal(payload.params.target_collection_uuid, spaceUuid);
  assert.equal(payload.params.target_thread_access_level, 1);
  assert.equal(payload.params.is_incognito, false);
  assert.equal(payload.params.last_backend_uuid, 'uuid-previous');
  assert.equal(payload.params.read_write_token, 'rw-previous');
  assert.equal(payload.params.query_source, 'followup');
  assert.equal(Object.prototype.hasOwnProperty.call(payload.params, 'search_recency_filter'), false);
  assert.equal(payload.query_str, 'new user turn only');
  assert.equal(JSON.stringify(payload).includes('old turn must not be replayed'), false);
  assert.deepEqual(payload.requestMetadata.attachments, [{
    filename: 'report.pdf',
    mime_type: 'application/pdf',
    size_bytes: 1234,
    is_image: false,
    source: 'local-file',
    status: 'uploaded',
    url_present: true,
  }]);
  assert.equal(payload.requestMetadata.space_uuid, spaceUuid);
});

test('validates Perplexity file attachments before network use', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pplx-attachments-'));
  try {
    const valid = join(dir, 'report.md');
    const empty = join(dir, 'empty.md');
    const nestedDir = join(dir, 'nested');
    writeFileSync(valid, '# report\n', 'utf-8');
    writeFileSync(empty, '', 'utf-8');
    mkdirSync(nestedDir);

    const attachments = normalizePerplexityFileAttachments([valid, valid]);
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0].filename, 'report.md');
    assert.equal(attachments[0].mimeType, 'text/markdown');
    assert.equal(attachments[0].sizeBytes, 9);
    assert.equal(JSON.stringify(attachments).includes('# report'), false);

    assert.throws(() => normalizePerplexityFileAttachments([join(dir, 'missing.txt')]), /File not found/);
    assert.throws(() => normalizePerplexityFileAttachments([empty]), /File is empty/);
    assert.throws(() => normalizePerplexityFileAttachments([nestedDir]), /Path is not a file/);
    assert.throws(() => normalizePerplexityFileAttachments(new Array(31).fill(valid)), /Too many files/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('uploads Perplexity file attachments with safe metadata', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pplx-upload-'));
  const calls = [];
  try {
    const file = join(dir, 'report.txt');
    writeFileSync(file, 'hello file', 'utf-8');
    const fetchImpl = async (url, options = {}) => {
      calls.push({ url: String(url), options });
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.signal.aborted, false);
      if (String(url).includes('/rest/uploads/batch_create_upload_urls')) {
        const body = JSON.parse(options.body);
        const fileUuid = Object.keys(body.files)[0];
        assert.equal(body.files[fileUuid].filename, 'report.txt');
        assert.equal(body.files[fileUuid].content_type, 'text/plain');
        assert.equal(body.files[fileUuid].file_size, 10);
        assert.equal(body.files[fileUuid].force_image, false);
        return {
          ok: true,
          json: async () => ({
            results: {
              [fileUuid]: {
                s3_bucket_url: 'https://s3.example.test/upload',
                s3_object_url: 'https://uploads.example.test/report.txt',
                fields: { key: 'report.txt', policy: 'policy' },
              },
            },
          }),
        };
      }
      assert.equal(String(url), 'https://s3.example.test/upload');
      assert.equal(options.method, 'POST');
      assert.equal(options.headers, undefined);
      return { ok: true, status: 204, text: async () => '' };
    };

    const uploaded = await uploadPerplexityAttachments({ files: [file], fetchImpl });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.signal, calls[1].options.signal);
    assert.equal(uploaded[0].url, 'https://uploads.example.test/report.txt');
    assert.deepEqual(uploaded[0].metadata, {
      filename: 'report.txt',
      mime_type: 'text/plain',
      size_bytes: 10,
      is_image: false,
      source: 'local-file',
      status: 'uploaded',
      url_present: true,
    });
    assert.equal(JSON.stringify(uploaded[0].metadata).includes(file), false);
    assert.equal(JSON.stringify(uploaded[0].metadata).includes('hello file'), false);
    assert.equal(JSON.stringify(calls[0]).includes('Cookie'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Perplexity file upload timeout aborts stalled initialization and S3 requests', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pplx-upload-timeout-'));
  try {
    const file = join(dir, 'report.txt');
    writeFileSync(file, 'hello file', 'utf-8');

    let initSignal;
    const initFetch = async (url, options = {}) => {
      assert.ok(String(url).includes('/rest/uploads/batch_create_upload_urls'));
      initSignal = options.signal;
      if (!initSignal) throw new Error('missing upload initialization signal');
      return new Promise((resolve, reject) => {
        const guard = setTimeout(() => reject(new Error('test timed out waiting for upload initialization abort')), 100);
        initSignal.addEventListener('abort', () => {
          clearTimeout(guard);
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    };

    await assert.rejects(
      () => uploadPerplexityAttachments({ files: [file], fetchImpl: initFetch, timeoutMs: 5 }),
      (error) => {
        assert.match(error.message, /File upload timed out for report\.txt during upload initialization after 5ms/);
        return true;
      },
    );
    assert.equal(initSignal.aborted, true);

    let s3Signal;
    const s3Fetch = async (url, options = {}) => {
      assert.ok(options.signal instanceof AbortSignal);
      if (String(url).includes('/rest/uploads/batch_create_upload_urls')) {
        const fileUuid = Object.keys(JSON.parse(options.body).files)[0];
        return {
          ok: true,
          json: async () => ({
            results: {
              [fileUuid]: {
                s3_bucket_url: 'https://s3.example.test/upload',
                s3_object_url: 'https://uploads.example.test/report.txt',
                fields: { key: 'report.txt', policy: 'policy' },
              },
            },
          }),
        };
      }
      assert.equal(String(url), 'https://s3.example.test/upload');
      s3Signal = options.signal;
      return new Promise((resolve, reject) => {
        const guard = setTimeout(() => reject(new Error('test timed out waiting for S3 upload abort')), 100);
        s3Signal.addEventListener('abort', () => {
          clearTimeout(guard);
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    };

    await assert.rejects(
      () => uploadPerplexityAttachments({ files: [file], fetchImpl: s3Fetch, timeoutMs: 5 }),
      (error) => {
        assert.match(error.message, /File upload timed out for report\.txt during S3 upload after 5ms/);
        return true;
      },
    );
    assert.equal(s3Signal.aborted, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validates Perplexity Space identifiers before network use', () => {
  assert.equal(normalizePerplexitySpaceUuid('123e4567-e89b-12d3-a456-426614174000'), '123e4567-e89b-12d3-a456-426614174000');
  assert.equal(normalizePerplexitySpaceUuid(null), null);
  assert.throws(() => normalizePerplexitySpaceUuid('not-a-space'), /Invalid --space-uuid/);
});

test('Perplexity research options reject unsupported values before network use', () => {
  const model = resolvePerplexityModel('perplexity/best');
  assert.throws(
    () => buildPerplexityPayload({ query: 'hello', model, options: { sourceFocus: 'video' } }),
    /Invalid --source-focus.*web, academic, social, finance, all/,
  );
  assert.throws(
    () => buildPerplexityPayload({ query: 'hello', model, options: { searchFocus: 'images' } }),
    /Invalid --search-focus.*web, writing/,
  );
  assert.throws(
    () => buildPerplexityPayload({ query: 'hello', model, options: { timeRange: 'hour' } }),
    /Invalid --time-range.*all, day, week, month, year/,
  );
  assert.throws(
    () => formatCitations('hello [1]', 'html', []),
    /Invalid --citation-mode.*clean, markdown, default/,
  );
});

test('formats Perplexity citations deterministically', () => {
  const sources = [
    { title: 'One', url: 'https://one.example' },
    { title: 'Two', url: 'https://two.example' },
  ];
  const text = 'Alpha [1] cites [2]. Missing [3] is removed in clean mode.';

  assert.equal(
    formatCitations(text, 'clean', sources),
    'Alpha cites. Missing is removed in clean mode.',
  );
  assert.equal(
    formatCitations(text, 'markdown', sources),
    'Alpha [1](https://one.example) cites [2](https://two.example). Missing [3] is removed in clean mode.',
  );
  assert.equal(formatCitations(text, 'default', sources), text);
});

test('Perplexity deep research uses the long timeout profile unless timeout is explicit', () => {
  const model = resolvePerplexityModel('perplexity/deep-research');
  assert.equal(
    resolvePerplexityTimeoutSeconds({ model, request: { timeoutSeconds: 300, timeoutExplicit: false } }),
    DEFAULT_PERPLEXITY_DEEP_RESEARCH_TIMEOUT_SECONDS,
  );
  assert.equal(
    resolvePerplexityTimeoutSeconds({ model, request: { timeoutSeconds: 120, timeoutExplicit: true } }),
    120,
  );
  assert.equal(
    resolvePerplexityTimeoutSeconds({ model: resolvePerplexityModel('perplexity/best'), request: { timeoutSeconds: 300, timeoutExplicit: false } }),
    300,
  );
});

test('parses Perplexity SSE data and extracts answer, citations, and thread state', () => {
  const state = extractPerplexityState(parseSseLine(`data: ${JSON.stringify({
    backend_uuid: 'uuid-2',
    read_write_token: 'rw-2',
    final: true,
    final_sse_message: true,
    status: 'COMPLETED',
    text: JSON.stringify({
      answer: 'Answer [1]',
      chunks: ['Answer [1]'],
      web_results: [{ name: 'Source', url: 'https://example.com', snippet: 'Snippet' }],
    }),
  })}`), undefined, 'markdown');

  assert.equal(state.backendUuid, 'uuid-2');
  assert.equal(state.readWriteToken, 'rw-2');
  assert.equal(state.answer, 'Answer [1](https://example.com)');
  assert.equal(state.searchResults[0].title, 'Source');
  assert.equal(state.done, true);
});

test('Perplexity streaming reports incremental progress and still returns final state', async () => {
  const encoder = new TextEncoder();
  const lines = [
    `data: ${JSON.stringify({ text: JSON.stringify({ answer: 'Hello', chunks: ['Hello'] }) })}\n`,
    `data: ${JSON.stringify({ final: true, final_sse_message: true, status: 'COMPLETED', backend_uuid: 'uuid-stream', text: JSON.stringify({ answer: 'Hello world', chunks: ['Hello world'] }) })}\n`,
  ];
  let readIndex = 0;
  const progress = [];
  const fetchImpl = async (url) => {
    if (String(url).includes('/search/new')) return { ok: true, text: async () => '' };
    return {
      ok: true,
      body: {
        getReader: () => ({
          read: async () => {
            if (readIndex >= lines.length) return { done: true };
            return { value: encoder.encode(lines[readIndex++]), done: false };
          },
        }),
      },
    };
  };

  const state = await streamPerplexity({
    payload: buildPerplexityPayload({ query: 'hello', model: resolvePerplexityModel('perplexity/best') }),
    timeoutMs: 1000,
    citationMode: 'clean',
    fetchImpl,
    onProgress: event => progress.push(event),
  });

  assert.equal(state.answer, 'Hello world');
  assert.equal(state.backendUuid, 'uuid-stream');
  assert.deepEqual(progress.map(event => event.delta), ['Hello', ' world']);
  assert.equal(progress.at(-1).done, true);
  assert.equal(state.streamProgress.events, 2);
  assert.equal(state.streamProgress.streamed_chars, 11);
});

test('Perplexity streaming applies captured block diffs and waits for the completed SSE event', async () => {
  const encoder = new TextEncoder();
  const lines = [
    `data: ${JSON.stringify({
      status: 'PENDING',
      text_completed: true,
      blocks: [{
        intended_usage: 'ask_text',
        diff_block: {
          field: 'markdown_block',
          patches: [{ op: 'replace', path: '', value: { progress: 'IN_PROGRESS', chunks: ['Hello'] } }],
        },
      }],
    })}\n`,
    `data: ${JSON.stringify({
      status: 'PENDING',
      final: true,
      text_completed: true,
      blocks: [{
        intended_usage: 'ask_text',
        diff_block: {
          field: 'markdown_block',
          patches: [{ op: 'add', path: '/chunks/1', value: ' world' }],
        },
      }],
    })}\n`,
    `data: ${JSON.stringify({
      status: 'COMPLETED',
      final: true,
      final_sse_message: true,
      backend_uuid: 'uuid-captured-schema',
      read_write_token: 'rw-private',
      display_model: 'gpt56_terra_thinking',
      user_selected_model: 'gpt56_terra_thinking',
      privacy_state: 'INCOGNITO',
      expiry_time: '2026-07-22T00:00:00.000Z',
      reconnectable: false,
      thread_access: 1,
      text: JSON.stringify([
        { step_type: 'INITIAL_QUERY', content: { query: 'hello' } },
        { step_type: 'FINAL', content: { answer: 'Hello world' } },
      ]),
      blocks: [{
        intended_usage: 'ask_text',
        markdown_block: { progress: 'DONE', chunks: ['Hello', ' world'], answer: 'Hello world' },
      }],
    })}\n`,
  ];
  let readIndex = 0;
  const progress = [];
  const state = await streamPerplexity({
    payload: buildPerplexityPayload({ query: 'hello', model: resolvePerplexityModel('openai/gpt-5.6-terra-thinking') }),
    timeoutMs: 1000,
    citationMode: 'clean',
    fetchImpl: async (url) => {
      assert.equal(String(url), 'https://www.perplexity.ai/rest/sse/perplexity_ask');
      return {
        ok: true,
        body: {
          getReader: () => ({
            read: async () => readIndex < lines.length
              ? { value: encoder.encode(lines[readIndex++]), done: false }
              : { done: true },
          }),
        },
      };
    },
    onProgress: event => progress.push(event),
  });

  assert.equal(readIndex, 3, 'the pending final event must not end the stream');
  assert.equal(state.answer, 'Hello world');
  assert.equal(state.done, true);
  assert.equal(state.backendUuid, 'uuid-captured-schema');
  assert.equal(state.readWriteToken, 'rw-private');
  assert.equal(state.displayModel, 'gpt56_terra_thinking');
  assert.equal(state.privacyState, 'INCOGNITO');
  assert.equal(state.expiresAt, '2026-07-22T00:00:00.000Z');
  assert.equal(state.reconnectable, false);
  assert.equal(state.threadAccess, 1);
  assert.deepEqual(progress.map(event => event.delta), ['Hello', ' world', '']);
  assert.equal(progress.at(-1).done, true);
});

test('Perplexity streaming does not replay an answer when final citation links are resolved', async () => {
  const encoder = new TextEncoder();
  const lines = [
    `data: ${JSON.stringify({
      status: 'PENDING',
      blocks: [{
        intended_usage: 'ask_text',
        markdown_block: { progress: 'IN_PROGRESS', answer: 'Hello [1]' },
      }],
    })}\n`,
    `data: ${JSON.stringify({
      status: 'COMPLETED',
      final_sse_message: true,
      web_results: [{ name: 'Source', url: 'https://example.test/source' }],
      blocks: [{
        intended_usage: 'ask_text',
        markdown_block: { progress: 'DONE', answer: 'Hello [1]' },
      }],
    })}\n`,
  ];
  let readIndex = 0;
  const progress = [];

  const state = await streamPerplexity({
    payload: buildPerplexityPayload({ query: 'hello', model: resolvePerplexityModel('perplexity/best') }),
    timeoutMs: 1000,
    citationMode: 'markdown',
    fetchImpl: async () => ({
      ok: true,
      body: {
        getReader: () => ({
          read: async () => readIndex < lines.length
            ? { value: encoder.encode(lines[readIndex++]), done: false }
            : { done: true },
        }),
      },
    }),
    onProgress: event => progress.push(event),
  });

  assert.equal(state.answer, 'Hello [1](https://example.test/source)');
  assert.deepEqual(progress.map(event => event.delta), ['Hello [1]', '']);
  assert.equal(progress.at(-1).done, true);
});

test('Perplexity streaming consumes final SSE data without trailing newline', async () => {
  const encoder = new TextEncoder();
  const lines = [
    `data: ${JSON.stringify({ text: JSON.stringify({ answer: 'Hello', chunks: ['Hello'] }) })}\n`,
    `data: ${JSON.stringify({ final: true, final_sse_message: true, status: 'COMPLETED', backend_uuid: 'uuid-no-newline', text: JSON.stringify({ answer: 'Hello world', chunks: ['Hello world'] }) })}`,
  ];
  let readIndex = 0;
  const progress = [];
  const fetchImpl = async (url) => {
    if (String(url).includes('/search/new')) return { ok: true, text: async () => '' };
    return {
      ok: true,
      body: {
        getReader: () => ({
          read: async () => {
            if (readIndex >= lines.length) return { done: true };
            return { value: encoder.encode(lines[readIndex++]), done: false };
          },
        }),
      },
    };
  };

  const state = await streamPerplexity({
    payload: buildPerplexityPayload({ query: 'hello', model: resolvePerplexityModel('perplexity/best') }),
    timeoutMs: 1000,
    citationMode: 'clean',
    fetchImpl,
    onProgress: event => progress.push(event),
  });

  assert.equal(state.answer, 'Hello world');
  assert.equal(state.backendUuid, 'uuid-no-newline');
  assert.equal(state.done, true);
  assert.deepEqual(progress.map(event => event.delta), ['Hello', ' world']);
  assert.equal(progress.at(-1).done, true);
});

test('builds safe and private Perplexity provider state without leaking continuation token', () => {
  const rawToken = 'rw-private-token';
  const spaceUuid = '123e4567-e89b-12d3-a456-426614174000';
  const states = buildPerplexityProviderStates({
    backendUuid: 'uuid-2',
    readWriteToken: rawToken,
    requestedModelIdentifier: 'gpt56_terra_thinking',
    responseModelIdentifier: 'gpt56_terra_thinking',
    userSelectedModelIdentifier: 'gpt56_terra_thinking',
    isIncognito: true,
    incognitoExplicit: true,
    privacyState: 'INCOGNITO',
    expiresAt: '2026-07-22T00:00:00.000Z',
    reconnectable: false,
    threadAccess: 1,
    attachments: [{
      url: 'https://uploads.example.test/report.txt',
      metadata: {
        filename: 'report.txt',
        mime_type: 'text/plain',
        size_bytes: 10,
        is_image: false,
        source: 'local-file',
        status: 'uploaded',
        url_present: true,
      },
    }],
    spaceUuid,
    streamState: { enabled: true, status: 'completed', progress_events: 2, streamed_chars: 11 },
  });

  assert.deepEqual(states.providerState, {
    transport: 'browser-network-sse',
    network_only: true,
    dom_processing: false,
    requested_model_identifier: 'gpt56_terra_thinking',
    response_model_identifier: 'gpt56_terra_thinking',
    user_selected_model_identifier: 'gpt56_terra_thinking',
    model_selection_verified: true,
    backend_uuid: 'uuid-2',
    thread_url: 'https://www.perplexity.ai/search/uuid-2',
    has_read_write_token: true,
    is_incognito: true,
    incognito_explicit: true,
    privacy_state: 'INCOGNITO',
    ephemeral: true,
    expires_at: '2026-07-22T00:00:00.000Z',
    reconnectable: false,
    thread_access: 1,
    saved_to_library: false,
    attachment_count: 1,
    attachments: [{
      filename: 'report.txt',
      mime_type: 'text/plain',
      size_bytes: 10,
      is_image: false,
      source: 'local-file',
      status: 'uploaded',
      url_present: true,
    }],
    space_uuid: spaceUuid,
    space_selected: true,
    stream_state: { enabled: true, status: 'completed', progress_events: 2, streamed_chars: 11 },
  });
  assert.equal(states.providerState.read_write_token, undefined);
  assert.equal(JSON.stringify(states.providerState).includes(rawToken), false);
  assert.equal(JSON.stringify(states.providerState).includes('https://uploads.example.test'), false);
  assert.deepEqual(states.privateProviderState, {
    transport: 'browser-network-sse',
    network_only: true,
    dom_processing: false,
    requested_model_identifier: 'gpt56_terra_thinking',
    response_model_identifier: 'gpt56_terra_thinking',
    user_selected_model_identifier: 'gpt56_terra_thinking',
    model_selection_verified: true,
    backend_uuid: 'uuid-2',
    thread_url: 'https://www.perplexity.ai/search/uuid-2',
    read_write_token: rawToken,
    is_incognito: true,
    incognito_explicit: true,
    privacy_state: 'INCOGNITO',
    ephemeral: true,
    expires_at: '2026-07-22T00:00:00.000Z',
    reconnectable: false,
    thread_access: 1,
    saved_to_library: false,
    attachment_count: 1,
    attachments: states.providerState.attachments,
    space_uuid: spaceUuid,
    space_selected: true,
    stream_state: { enabled: true, status: 'completed', progress_events: 2, streamed_chars: 11 },
  });
});

test('defaults Perplexity provider state to persistent history', () => {
  const states = buildPerplexityProviderStates();

  assert.equal(states.providerState.is_incognito, false);
  assert.equal(states.providerState.incognito_explicit, false);
  assert.equal(states.providerState.privacy_state, 'PERSISTENT');
  assert.equal(states.providerState.ephemeral, false);
  assert.equal(states.providerState.saved_to_library, true);
});

test('preserves previous Perplexity continuation state when a follow-up response omits rotated state', () => {
  const rawToken = 'rw-previous-token';
  const states = buildPerplexityProviderStates({
    backendUuid: 'uuid-new',
    readWriteToken: null,
    previousBackendUuid: 'uuid-previous',
    previousReadWriteToken: rawToken,
    isIncognito: true,
  });

  assert.equal(states.providerState.backend_uuid, 'uuid-new');
  assert.equal(states.providerState.has_read_write_token, true);
  assert.equal(states.providerState.read_write_token, undefined);
  assert.equal(JSON.stringify(states.providerState).includes(rawToken), false);
  assert.equal(states.privateProviderState.backend_uuid, 'uuid-new');
  assert.equal(states.privateProviderState.read_write_token, rawToken);

  const fallbackStates = buildPerplexityProviderStates({
    backendUuid: null,
    readWriteToken: null,
    previousBackendUuid: 'uuid-previous',
    previousReadWriteToken: rawToken,
    isIncognito: true,
  });
  assert.equal(fallbackStates.providerState.backend_uuid, 'uuid-previous');
  assert.equal(fallbackStates.privateProviderState.read_write_token, rawToken);
});
