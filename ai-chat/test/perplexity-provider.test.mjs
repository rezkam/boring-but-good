import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PERPLEXITY_SESSION_LOOKUP_ORDER,
  buildPerplexityPayload,
  buildPerplexityProviderStates,
  createPerplexityBrowserFetch,
  DEFAULT_PERPLEXITY_DEEP_RESEARCH_TIMEOUT_SECONDS,
  extractPerplexityState,
  formatCitations,
  normalizePerplexityFileAttachments,
  normalizePerplexitySpaceUuid,
  parseSseLine,
  perplexityAuthFailureMessage,
  perplexityProvider,
  readPerplexitySession,
  resolvePerplexityModel,
  resolvePerplexityTimeoutSeconds,
  streamPerplexity,
  uploadPerplexityAttachments,
  verifyPerplexityModels,
} from '../scripts/ai-chat/providers/perplexity.mjs';

test('resolves Perplexity model ids, display names, and direct tool aliases', () => {
  assert.equal(resolvePerplexityModel('perplexity/deep-research').identifier, 'pplx_alpha');
  assert.equal(resolvePerplexityModel('GPT-5.4 Thinking').id, 'openai/gpt-5.4-thinking');
  assert.equal(resolvePerplexityModel('claude46sonnetthinking').id, 'anthropic/claude-sonnet-4.6-thinking');
  assert.equal(resolvePerplexityModel('reasoning').id, 'openai/gpt-5.4-thinking');

  const directTools = {
    pplx_best: 'perplexity/best',
    pplx_deep_research: 'perplexity/deep-research',
    pplx_sonar: 'perplexity/sonar-2',
    pplx_gpt54: 'openai/gpt-5.4',
    pplx_gpt54_thinking: 'openai/gpt-5.4-thinking',
    pplx_gemini31_pro_think_low: 'google/gemini-3.1-pro-thinking-low',
    pplx_gemini31_pro_think_high: 'google/gemini-3.1-pro-thinking-high',
    pplx_claude_s46: 'anthropic/claude-sonnet-4.6',
    pplx_claude_s46_think: 'anthropic/claude-sonnet-4.6-thinking',
    pplx_kimi_k26_instant: 'moonshot/kimi-k2.6-instant',
    pplx_kimi_k26_thinking: 'moonshot/kimi-k2.6-thinking',
    pplx_nemotron3_super_think: 'nvidia/nemotron-3-super-thinking',
  };

  for (const [alias, expectedId] of Object.entries(directTools)) {
    assert.equal(resolvePerplexityModel(alias).id, expectedId, alias);
  }
  assert.equal(resolvePerplexityModel('openai/gpt-5.5-thinking'), null);
});

test('lists Perplexity models with capability and account-tier metadata', async () => {
  const list = await perplexityProvider.listModels({ request: { verifyModels: false } });
  assert.equal(list.models.length >= 10, true);
  assert.equal(list.models.some(model => model.min_tier === 'max'), false);
  assert.equal(list.models.some(model => model.id === 'openai/gpt-5.5-thinking'), false);
  const thinking = list.models.find(model => model.id === 'google/gemini-3.1-pro-thinking-high');
  assert.equal(thinking.thinking, true);
  assert.equal(thinking.thinking_level, 'high');
  assert.equal(thinking.provider_family, 'google');
  assert.equal(thinking.min_tier, 'pro');
  assert.equal(thinking.account_specific, false);
  assert.deepEqual(thinking.account_tier, { required: 'pro', verified: null });
  assert.equal(list.verification.enabled, false);
});

test('Perplexity session lookup uses managed browser cookies and ignores env tokens', async () => {
  const previousEnv = process.env.PERPLEXITY_SESSION_TOKEN;
  process.env.PERPLEXITY_SESSION_TOKEN = 'env-token-should-not-be-used';
  const cookieCalls = [];
  const page = {
    cookies: async (url) => {
      cookieCalls.push(url);
      if (url === 'https://perplexity.ai') {
        return [{ name: '__Secure-next-auth.session-token', value: 'browser-session-token' }];
      }
      return [];
    },
  };

  try {
    const session = await readPerplexitySession(page);
    assert.equal(session.token, 'browser-session-token');
    assert.equal(session.source, 'Browser Tools Chrome profile');
    assert.deepEqual(cookieCalls, PERPLEXITY_SESSION_LOOKUP_ORDER.map(item => item.url));
    assert.equal(JSON.stringify(session).includes('browser-session-token'), false);
    assert.equal(JSON.stringify(session).includes('env-token-should-not-be-used'), false);
  } finally {
    if (previousEnv === undefined) delete process.env.PERPLEXITY_SESSION_TOKEN;
    else process.env.PERPLEXITY_SESSION_TOKEN = previousEnv;
  }
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

test('Perplexity auth failures include recovery guidance without token values', async () => {
  await assert.rejects(
    () => readPerplexitySession({ cookies: async () => [] }),
    /Perplexity authentication failed.*Log in to perplexity\.ai.*--sync.*session cookie not found/s,
  );

  const message = perplexityAuthFailureMessage({ source: 'Browser Tools Chrome profile', chromeError: 'cookie missing' });
  assert.match(message, /Perplexity authentication failed for Browser Tools Chrome profile/i);
  assert.match(message, /Log in to perplexity\.ai in the selected Chrome profile/i);
  assert.match(message, /PPLX_BROWSER_TOOLS_SYNC=1/);
  assert.match(message, /stop it with --clean, restart with --sync/i);
  assert.match(message, /does not read PERPLEXITY_SESSION_TOKEN or PPLX_SESSION_TOKEN/i);

  const token = 'secret-session-token';
  const payload = buildPerplexityPayload({
    query: 'hello',
    model: resolvePerplexityModel('perplexity/best'),
  });
  const fetchCalls = [];
  const fetchImpl = async (url) => {
    fetchCalls.push(String(url));
    if (String(url).includes('/search/new')) return { ok: true, text: async () => '' };
    return {
      ok: false,
      status: 403,
      text: async () => `expired ${token} {"read_write_token":"rw-secret"}`,
    };
  };

  await assert.rejects(
    () => streamPerplexity({ token, payload, timeoutMs: 1000, citationMode: 'clean', fetchImpl }),
    (error) => {
      assert.match(error.message, /Perplexity authentication failed/);
      assert.equal(error.message.includes(token), false);
      assert.equal(error.message.includes('rw-secret'), false);
      return true;
    },
  );
  assert.equal(fetchCalls.length, 2);

  await assert.rejects(
    () => streamPerplexity({ token, payload, timeoutMs: 1000, citationMode: 'clean', fetchImpl, authPrevalidated: true }),
    (error) => {
      assert.match(error.message, /model rejected or unavailable/i);
      assert.equal(error.message.includes(token), false);
      assert.equal(error.message.includes('rw-secret'), false);
      return true;
    },
  );
});

test('Perplexity live model verification reports accepted and rejected shape safely', async () => {
  const models = [resolvePerplexityModel('perplexity/best'), resolvePerplexityModel('openai/gpt-5.4')];
  const token = 'verification-session-token';
  const result = await verifyPerplexityModels({
    token,
    models,
    timeoutMs: 1000,
    streamFn: async ({ model }) => {
      if (model.id === 'perplexity/best') {
        return { answer: 'AI_CHAT_MODEL_CHECK', chunks: [], backendUuid: 'uuid-accepted' };
      }
      throw new Error(`Perplexity HTTP 403: rejected ${token}`);
    },
  });

  assert.equal(result.verification.accepted_count, 1);
  assert.equal(result.verification.rejected_count, 1);
  assert.deepEqual(result.verification.accepted_model_ids, ['perplexity/best']);
  assert.deepEqual(result.verification.rejected_model_ids, ['openai/gpt-5.4']);
  assert.equal(result.models[0].verification.status, 'accepted');
  assert.equal(result.models[0].verification.accepted, true);
  assert.equal(result.models[1].verification.status, 'rejected');
  assert.equal(result.models[1].verification.accepted, false);
  assert.equal(JSON.stringify(result).includes(token), false);
});

function fakePerplexitySessionPage() {
  return {
    cookies: async () => [{ name: '__Secure-next-auth.session-token', value: 'session-token' }],
  };
}

test('Perplexity provider rejects unknown explicit model requests', async () => {
  const page = fakePerplexitySessionPage();
  const provider = { ...perplexityProvider, findPage: async () => page };
  const request = { prompt: 'hello', modelName: 'definitely-not-real', timeoutSeconds: 1, providerOptions: {} };
  const previousFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return {
      ok: true,
      text: async () => '',
      body: {
        getReader: () => ({ read: async () => ({ done: true }) }),
      },
    };
  };

  try {
    await assert.rejects(
      () => provider.run({ browser: {}, request, selectedModel: 'definitely-not-real' }),
      /\[perplexity\] Unknown model: definitely-not-real.*--list-models/s,
    );
    await assert.rejects(
      () => perplexityProvider.createAttemptContext({ page, request, selectedModel: 'definitely-not-real' }),
      /\[perplexity\] Unknown model: definitely-not-real.*--list-models/s,
    );
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Perplexity provider resolves valid default, alias, and task model requests', async () => {
  const page = fakePerplexitySessionPage();
  const defaultContext = await perplexityProvider.createAttemptContext({
    page,
    request: { modelName: 'default' },
    selectedModel: 'default',
  });
  const aliasContext = await perplexityProvider.createAttemptContext({
    page,
    request: { modelName: 'default' },
    selectedModel: 'reasoning',
  });
  const taskContext = await perplexityProvider.createAttemptContext({
    page,
    request: { modelName: 'default', modelTask: 'coding' },
    selectedModel: perplexityProvider.taskModels.coding,
  });

  assert.equal(defaultContext.model.id, 'perplexity/best');
  assert.equal(aliasContext.model.id, 'openai/gpt-5.4-thinking');
  assert.equal(taskContext.model.id, 'anthropic/claude-sonnet-4.6');
  assert.equal(defaultContext.token, 'session-token');
  assert.equal(JSON.stringify(defaultContext).includes('session-token'), false);
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
      saveToLibrary: true,
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
  assert.equal(payload.params.last_backend_uuid, 'uuid-1');
  assert.equal(payload.params.read_write_token, 'rw-1');
  assert.equal(payload.params.query_source, 'followup');
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
  const token = 'session-token';
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

    const uploaded = await uploadPerplexityAttachments({ token, files: [file], fetchImpl });
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
    assert.equal(JSON.stringify(calls[0]).includes(token), true);
    assert.equal(JSON.stringify(uploaded[0].metadata).includes(token), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Perplexity file upload timeout aborts stalled initialization and S3 requests', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pplx-upload-timeout-'));
  const token = 'session-token';
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
      () => uploadPerplexityAttachments({ token, files: [file], fetchImpl: initFetch, timeoutMs: 5 }),
      (error) => {
        assert.match(error.message, /File upload timed out for report\.txt during upload initialization after 5ms/);
        assert.equal(error.message.includes(token), false);
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
      () => uploadPerplexityAttachments({ token, files: [file], fetchImpl: s3Fetch, timeoutMs: 5 }),
      (error) => {
        assert.match(error.message, /File upload timed out for report\.txt during S3 upload after 5ms/);
        assert.equal(error.message.includes(token), false);
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
    `data: ${JSON.stringify({ final: true, backend_uuid: 'uuid-stream', text: JSON.stringify({ answer: 'Hello world', chunks: ['Hello world'] }) })}\n`,
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
    token: 'session-token',
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

test('Perplexity streaming consumes final SSE data without trailing newline', async () => {
  const encoder = new TextEncoder();
  const lines = [
    `data: ${JSON.stringify({ text: JSON.stringify({ answer: 'Hello', chunks: ['Hello'] }) })}\n`,
    `data: ${JSON.stringify({ final: true, backend_uuid: 'uuid-no-newline', text: JSON.stringify({ answer: 'Hello world', chunks: ['Hello world'] }) })}`,
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
    token: 'session-token',
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
    isIncognito: true,
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
    backend_uuid: 'uuid-2',
    has_read_write_token: true,
    is_incognito: true,
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
    backend_uuid: 'uuid-2',
    read_write_token: rawToken,
    is_incognito: true,
    saved_to_library: false,
    attachment_count: 1,
    attachments: states.providerState.attachments,
    space_uuid: spaceUuid,
    space_selected: true,
    stream_state: { enabled: true, status: 'completed', progress_events: 2, streamed_chars: 11 },
  });
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
