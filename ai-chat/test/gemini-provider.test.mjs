import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAiChatRequest, runAiChat } from '../scripts/ai-chat/module.mjs';
import { geminiProvider, isGeminiNativeContinuationError } from '../scripts/ai-chat/providers/gemini.mjs';

function noCache() {
  return { read: () => null, write: () => null };
}

function fakeGeminiBrowser() {
  const page = {
    url: () => 'https://gemini.google.com/app',
    cookies: async () => [{ name: '__Secure-1PSID', value: 'psid' }],
  };
  return { pages: async () => [page] };
}

function geminiAppHtml() {
  return '<html><script>{"SNlM0e":"token","cfb2h":"bl","FdrFJe":"sid"}</script></html>';
}

function accountModelsRaw() {
  const body = [];
  body[14] = 1;
  body[15] = [['fbb127bbb056c959', 'Gemini 3 Flash', 'Fast model']];
  body[16] = [];
  body[17] = [115];
  return `)]}'\n${JSON.stringify([['wrb.fr', 'otAQ7b', JSON.stringify(body)]])}\n`;
}

function streamAnswerRaw(text) {
  const inner = JSON.stringify([null, ['conv-new', 'resp-new'], null, null, [['choice-new', [text]]]]);
  return `)]}'\n${JSON.stringify([[null, null, inner]])}\n`;
}

function streamErrorRaw(code) {
  return `)]}'\n${JSON.stringify([[null, null, null, null, null, [null, null, [[null, [code]]]]]])}\n`;
}

function installGeminiFetch(streamResponses) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    const method = options.method || 'GET';
    calls.push({ href, method, body: options.body?.toString?.() || options.body || '' });

    if (method === 'GET' && href === 'https://gemini.google.com/app') {
      return new Response(geminiAppHtml());
    }
    if (method === 'POST' && href.includes('/_/BardChatUi/data/batchexecute')) {
      return new Response(accountModelsRaw());
    }
    if (method === 'POST' && href.includes('/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate')) {
      const raw = streamResponses.shift();
      assert.ok(raw, 'unexpected Gemini stream request');
      return new Response(raw);
    }

    throw new Error(`Unexpected Gemini fetch: ${method} ${href}`);
  };
  return calls;
}

function savedGeminiConversation() {
  return {
    id: null,
    url: null,
    record: {
      provider_state: {
        conversation_state: {
          conversation_id: 'conv-old',
          response_id: 'resp-old',
          choice_id: 'choice-old',
          metadata: ['conv-old', 'resp-old', 'choice-old', null, null, null, null, null, null, ''],
        },
      },
      messages: [
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'first answer' },
      ],
    },
  };
}

function streamCalls(calls) {
  return calls.filter(call => call.href.includes('/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate'));
}

function promptFromStreamCall(call) {
  const body = new URLSearchParams(call.body);
  const outer = JSON.parse(body.get('f.req'));
  const innerReqList = JSON.parse(outer[1]);
  return innerReqList[0][0];
}

test('Gemini continuation error classifier is explicit to 1097', () => {
  const coded = new Error('backend rejected continuation');
  coded.errorCode = 1097;
  assert.equal(isGeminiNativeContinuationError(coded), true);
  assert.equal(isGeminiNativeContinuationError(new Error('Gemini Web returned error 1097')), true);

  const modelUnavailable = new Error('Gemini Web returned error 1052');
  modelUnavailable.errorCode = 1052;
  assert.equal(isGeminiNativeContinuationError(modelUnavailable), false);
  assert.equal(isGeminiNativeContinuationError(new Error('Unable to authenticate with Gemini')), false);
  assert.equal(isGeminiNativeContinuationError(new Error('Gemini Web returned empty response')), false);
});

test('Gemini native continuation error 1097 uses local transcript fallback and reports metadata', async () => {
  const previousFetch = globalThis.fetch;
  const calls = installGeminiFetch([streamErrorRaw(1097), streamAnswerRaw('fallback answer')]);
  const stdout = [];

  try {
    const request = buildAiChatRequest({
      providerName: 'gemini',
      modelName: 'gemini-3-flash',
      prompt: 'follow up',
      jsonOutput: true,
      timeoutSeconds: 1,
    });
    const result = await runAiChat(request, {
      provider: geminiProvider,
      browser: fakeGeminiBrowser(),
      conversation: savedGeminiConversation(),
      cache: noCache(),
      io: { stdout: text => stdout.push(text), writeFile: () => assert.fail('no file expected') },
    });

    const emitted = JSON.parse(stdout[0]);
    assert.equal(emitted.response, 'fallback answer');
    assert.equal(result.metadata.provider_state.local_transcript_fallback, true);
    assert.equal(emitted.provider_state.local_transcript_fallback, true);
    assert.deepEqual(emitted.provider_state.native_continuation_error, {
      message: 'Gemini Web returned error 1097',
      error_code: 1097,
      model: 'gemini-3-flash',
    });

    const prompts = streamCalls(calls).map(promptFromStreamCall);
    assert.deepEqual(prompts, [
      'follow up',
      'Continue this conversation. Use the prior messages as context, then answer the new user message.\n\nUser: first question\n\nAssistant: first answer\n\nUser: follow up',
    ]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Gemini rethrows non-continuation query errors even when prior messages exist', async () => {
  const previousFetch = globalThis.fetch;
  const calls = installGeminiFetch([streamErrorRaw(1052), streamAnswerRaw('should not be used')]);
  const stdout = [];

  try {
    const request = buildAiChatRequest({
      providerName: 'gemini',
      modelName: 'gemini-3-flash',
      prompt: 'follow up',
      jsonOutput: true,
      timeoutSeconds: 1,
    });

    await assert.rejects(
      () => runAiChat(request, {
        provider: geminiProvider,
        browser: fakeGeminiBrowser(),
        conversation: savedGeminiConversation(),
        cache: noCache(),
        io: { stdout: text => stdout.push(text), writeFile: () => assert.fail('no file expected') },
      }),
      (error) => {
        assert.equal(error.message, 'Gemini Web returned error 1052');
        assert.equal(error.errorCode, 1052);
        return true;
      },
    );

    assert.equal(streamCalls(calls).length, 1);
    assert.deepEqual(stdout, []);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
