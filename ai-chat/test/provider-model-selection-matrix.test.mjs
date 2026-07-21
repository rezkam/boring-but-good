import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildAiChatRequest,
  buildMetadata,
  resolveInitialModel,
  runAiChat,
} from '../scripts/ai-chat/module.mjs';
import { chatgptProvider, resolveChatGptModel } from '../scripts/ai-chat/providers/chatgpt.mjs';
import { resolveGeminiModel } from '../scripts/ai-chat/providers/gemini-api.mjs';
import { geminiProvider } from '../scripts/ai-chat/providers/gemini.mjs';
import { grokProvider, resolveGrokModel } from '../scripts/ai-chat/providers/grok.mjs';
import { perplexityProvider, resolvePerplexityModel } from '../scripts/ai-chat/providers/perplexity.mjs';

const MODEL_CHECK_TOKEN = 'AI_CHAT_MODEL_MATRIX_OK';

function noCache() {
  return { read: () => null, write: () => null };
}

const MODEL_SELECTION_MATRIX = [
  {
    provider: perplexityProvider,
    defaultModel: 'perplexity/best',
    resolveId: model => resolvePerplexityModel(model)?.id || null,
    aliases: [
      ['pplx_best', 'perplexity/best'],
      ['reasoning', 'openai/gpt-5.6-terra-thinking'],
      ['pplx_gpt56_terra', 'openai/gpt-5.6-terra'],
      ['pplx_gpt56_terra_thinking', 'openai/gpt-5.6-terra-thinking'],
      ['pplx_deep_research', 'perplexity/deep-research'],
    ],
    taskDefaults: [
      ['deep_research', 'perplexity/deep-research'],
      ['coding', 'openai/gpt-5.6-terra'],
    ],
    unknownModel: 'definitely-not-a-perplexity-model',
    outputCase: {
      requestedModel: 'pplx_best',
      selectedModel: 'perplexity/best',
      fallbackTrail: ['perplexity/best'],
      providerState: {
        transport: 'browser-network-sse',
        network_only: true,
        dom_processing: false,
        backend_uuid: 'uuid-matrix',
        has_read_write_token: true,
        is_incognito: true,
        saved_to_library: false,
      },
    },
    liveCases: [
      { kind: 'fast', model: 'perplexity/best', timeoutSeconds: 120 },
      { kind: 'reasoning', model: 'openai/gpt-5.6-terra-thinking', timeoutSeconds: 180 },
      { kind: 'deep_research', model: 'perplexity/deep-research', timeoutSeconds: 3600 },
      { kind: 'provider_specific', model: 'perplexity/sonar-2', timeoutSeconds: 180 },
    ],
    limitations: [
      'Max tier models are intentionally filtered out of the bundled registry.',
      'Live acceptance depends on the current Perplexity account tier.',
      'Deep research is slow and should stay behind the live gate.',
    ],
  },
  {
    provider: chatgptProvider,
    defaultModel: 'extra-high',
    resolveId: model => resolveChatGptModel(model)?.id || null,
    aliases: [
      ['fast', 'instant'],
      ['reasoning', 'extra-high'],
      ['extra-high', 'extra-high'],
    ],
    taskDefaults: [
      ['quick', 'instant'],
      ['reasoning', 'extra-high'],
      ['pro', 'pro-extended'],
    ],
    unknownModel: 'definitely-not-a-chatgpt-profile',
    outputCase: {
      requestedModel: 'extra-high',
      selectedModel: 'gpt-5-5-thinking',
      fallbackTrail: ['extra-high'],
      providerState: {
        transport: 'network-stream',
        requested_model_profile: 'extra-high',
        requested_payload_model: 'gpt-5-5-thinking',
        model_slug: 'gpt-5-5-thinking',
        thinking_effort: 'max',
        stream_state: {
          status: 'completed',
          requested_model_profile: 'extra-high',
          model_slug: 'gpt-5-5-thinking',
          dom_fallback: false,
        },
      },
    },
    liveCases: [
      { kind: 'fast', model: 'instant', timeoutSeconds: 180 },
      { kind: 'reasoning', model: 'extra-high', timeoutSeconds: 300 },
      { kind: 'provider_specific', model: 'pro-extended', timeoutSeconds: 300 },
    ],
    limitations: [
      'Request profiles are applied by payload rewrite, not by a public model list API.',
      'Some profile ids are marked unverified until a live account run observes the selected slug.',
      'The old medium/high thinking_effort payloads are not exposed because the current ChatGPT backend rejects them with HTTP 422.',
      'Live prompt checks create normal ChatGPT conversations, so use a disposable profile if account history matters.',
      'Deep research is not exposed as a stable AI Chat model profile.',
    ],
  },
  {
    provider: geminiProvider,
    defaultModel: 'gemini-3-flash',
    resolveId: model => resolveGeminiModel(model)?.id || null,
    aliases: [
      ['flash', 'gemini-3-flash'],
      ['thinking', 'gemini-3-flash-thinking'],
      ['pro', 'gemini-3-pro'],
    ],
    taskDefaults: [
      ['quick', 'gemini-3-flash'],
      ['reasoning', 'gemini-3-flash-thinking'],
      ['pro', 'gemini-3-pro'],
    ],
    unknownModel: 'definitely-not-a-gemini-model',
    outputCase: {
      requestedModel: 'pro',
      selectedModel: 'gemini-3-pro',
      fallbackTrail: ['pro'],
      providerState: {
        transport: 'webui-api',
        cookie_source: 'managed-browser',
        model_fallback_from: null,
        model_fallback_reason: null,
        session_verification: {
          checked: true,
          direct_ready: true,
        },
      },
    },
    liveCases: [
      { kind: 'fast', model: 'gemini-3-flash', timeoutSeconds: 180 },
      { kind: 'reasoning', model: 'gemini-3-flash-thinking', timeoutSeconds: 300 },
      { kind: 'provider_specific', model: 'gemini-3-pro', timeoutSeconds: 300 },
    ],
    limitations: [
      'Live discovery requires Google cookies from the managed Browser Tools browser or an explicit Chrome profile fallback.',
      'Gemini can reject a model with backend error 1052 and then only fallback when the adapter marks that fallback.',
      'Deep research is not exposed as a stable AI Chat model profile.',
    ],
  },
  {
    provider: grokProvider,
    defaultModel: 'fast',
    resolveId: model => resolveGrokModel(model)?.id || null,
    aliases: [
      ['default', 'fast'],
      ['quick', 'fast'],
      ['think', 'expert'],
    ],
    taskDefaults: [
      ['quick', 'fast'],
      ['reasoning', 'expert'],
    ],
    unknownModel: 'definitely-not-a-grok-model',
    outputCase: {
      requestedModel: 'quick',
      selectedModel: 'fast',
      fallbackTrail: ['quick'],
      providerState: {
        transport: 'browser-ui',
        selected_model: 'fast',
        selected_model_label: 'Fast',
        conversation_url: 'https://x.com/i/grok?conversation=matrix',
      },
    },
    liveCases: [
      { kind: 'fast', model: 'fast', timeoutSeconds: 180 },
    ],
    limitations: [
      'Model selection is verified through visible UI labels.',
      'The provider can report Auto, Fast, or Expert, but not a backend model slug.',
      'Current X/Grok sessions can expose only Fast; Auto and Expert are account/UI availability dependent and must be checked with --list-models --verify-models before use.',
      'Live prompt checks create normal Grok conversations, so use a disposable profile if account history matters.',
      'Deep research is not exposed as a stable AI Chat model profile.',
    ],
  },
];

test('provider model selection matrix resolves known aliases', () => {
  for (const row of MODEL_SELECTION_MATRIX) {
    for (const [alias, expected] of row.aliases) {
      assert.equal(
        row.resolveId(alias),
        expected,
        `${row.provider.name} alias ${alias} should resolve to ${expected}`,
      );
    }
  }
});

test('provider model selection matrix resolves task defaults without overriding explicit models', () => {
  for (const row of MODEL_SELECTION_MATRIX) {
    const defaultRequest = buildAiChatRequest({ providerName: row.provider.name, prompt: 'matrix default' });
    assert.equal(
      resolveInitialModel(row.provider, defaultRequest),
      row.defaultModel,
      `${row.provider.name} default model should be stable`,
    );

    for (const [task, expected] of row.taskDefaults) {
      const taskRequest = buildAiChatRequest({ providerName: row.provider.name, prompt: 'matrix task', modelTask: task });
      assert.equal(
        resolveInitialModel(row.provider, taskRequest),
        expected,
        `${row.provider.name} task ${task} should resolve to ${expected}`,
      );

      const explicitModel = row.aliases.find(([alias]) => alias !== 'default')?.[0] || row.defaultModel;
      const explicitRequest = buildAiChatRequest({
        providerName: row.provider.name,
        prompt: 'matrix explicit',
        modelName: explicitModel,
        modelTask: task,
      });
      assert.equal(
        resolveInitialModel(row.provider, explicitRequest),
        explicitModel,
        `${row.provider.name} task ${task} must not override explicit --model ${explicitModel}`,
      );
    }
  }
});

test('provider model selection matrix rejects unknown model names before silent fallback', () => {
  for (const row of MODEL_SELECTION_MATRIX) {
    assert.equal(
      row.resolveId(row.unknownModel),
      null,
      `${row.provider.name} unknown model ${row.unknownModel} must not resolve to a fallback`,
    );
  }
});

test('provider model selection matrix documents provider limitations', () => {
  for (const row of MODEL_SELECTION_MATRIX) {
    assert.ok(row.limitations.length >= 2, `${row.provider.name} should document model selection limitations`);
    assert.ok(row.liveCases.length >= 1, `${row.provider.name} should define gated live model cases`);
  }
});

test('provider model selection matrix keeps output metadata shape stable', () => {
  const requiredKeys = [
    'provider',
    'model',
    'selected_model',
    'requested_model',
    'model_task',
    'fallback_from',
    'fallback_attempts',
    'complete',
    'rate_limited',
    'provider_state',
    'captured_at',
    'cache_hit',
  ];

  for (const row of MODEL_SELECTION_MATRIX) {
    const request = buildAiChatRequest({
      providerName: row.provider.name,
      modelName: row.outputCase.requestedModel,
      prompt: `matrix metadata ${row.provider.name}`,
      jsonOutput: true,
    });
    const metadata = buildMetadata({
      request,
      provider: row.provider,
      result: {
        text: 'matrix answer',
        rawText: 'matrix answer',
        done: true,
        rateLimited: false,
        modelUsed: row.outputCase.selectedModel,
        providerState: row.outputCase.providerState,
        searchResults: [],
      },
      fallbackFrom: row.outputCase.fallbackFrom || null,
      fallbackTrail: row.outputCase.fallbackTrail,
    });

    for (const key of requiredKeys) {
      assert.equal(Object.hasOwn(metadata, key), true, `${row.provider.name} metadata should include ${key}`);
    }
    assert.equal(metadata.provider, row.provider.name, `${row.provider.name} metadata provider mismatch`);
    assert.equal(metadata.requested_model, row.outputCase.requestedModel, `${row.provider.name} requested model mismatch`);
    assert.equal(metadata.selected_model, row.outputCase.selectedModel, `${row.provider.name} selected model mismatch`);
    assert.deepEqual(metadata.fallback_attempts, row.outputCase.fallbackTrail, `${row.provider.name} fallback trail mismatch`);
    assert.equal(metadata.complete, true, `${row.provider.name} completion flag mismatch`);
    assert.equal(metadata.rate_limited, false, `${row.provider.name} rate limit flag mismatch`);
    assert.equal(typeof metadata.provider_state, 'object', `${row.provider.name} provider_state should be an object`);
  }
});

test('model fallback metadata exposes rejected requested models', () => {
  const request = buildAiChatRequest({
    providerName: 'gemini',
    modelName: 'gemini-3-pro',
    prompt: 'matrix fallback',
    jsonOutput: true,
  });
  const metadata = buildMetadata({
    request,
    provider: geminiProvider,
    result: {
      text: 'fallback answer',
      rawText: 'fallback answer',
      done: true,
      rateLimited: false,
      modelUsed: 'gemini-3-flash',
      providerState: {
        transport: 'webui-api',
        model_fallback_from: 'gemini-3-pro',
        model_fallback_reason: 'error_1052',
      },
      searchResults: [],
    },
    fallbackFrom: null,
    fallbackTrail: ['gemini-3-pro'],
  });

  assert.equal(metadata.requested_model, 'gemini-3-pro');
  assert.equal(metadata.selected_model, 'gemini-3-flash');
  assert.equal(metadata.model_fallback_from, 'gemini-3-pro');
  assert.equal(metadata.model_fallback_reason, 'error_1052');
  assert.equal(metadata.provider_state.model_fallback_from, 'gemini-3-pro');
});

function enabledLiveProviders() {
  return new Set(String(process.env.AI_CHAT_LIVE_PROVIDERS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean));
}

function liveCaseSkipReason(providerName) {
  if (process.env.AI_CHAT_LIVE_MODEL_MATRIX !== '1') {
    return 'set AI_CHAT_LIVE_MODEL_MATRIX=1 to run browser-authenticated live model checks';
  }
  const providers = enabledLiveProviders();
  if (providers.size > 0 && !providers.has(providerName)) {
    return `AI_CHAT_LIVE_PROVIDERS does not include ${providerName}`;
  }
  return false;
}

function assertLiveProviderEvidence(providerName, emitted, { tokenRequired = true } = {}) {
  assert.equal(emitted.provider, providerName, `${providerName} provider mismatch`);
  assert.equal(emitted.complete, true, `${providerName} response should be complete`);
  assert.equal(emitted.rate_limited, false, `${providerName} should not be rate limited`);
  assert.equal(typeof emitted.selected_model, 'string', `${providerName} selected_model should be present`);
  assert.equal(typeof emitted.response_chars, 'number', `${providerName} response_chars should be numeric`);
  assert.ok(emitted.response_chars > 0, `${providerName} response should be non-empty`);
  if (tokenRequired) assert.match(emitted.response, /AI_CHAT_/, `${providerName} response should include the probe token`);

  const state = emitted.provider_state || {};
  if (providerName === 'chatgpt') {
    assert.ok(state.intercepted_requests > 0, 'chatgpt must prove a conversation request was intercepted');
    assert.ok(
      (state.response_statuses || []).some(item => /\/backend-api\/f\/conversation$/.test(item.url) && item.status === 200 && /event-stream/.test(item.mimeType || '')),
      'chatgpt must prove the conversation event stream returned HTTP 200',
    );
    assert.equal(state.stream_state?.status, 'completed');
    assert.equal(state.dom_fallback, false);
  } else if (providerName === 'perplexity') {
    assert.equal(typeof state.backend_uuid, 'string', 'perplexity must return a backend UUID');
    assert.equal(state.has_read_write_token, true, 'perplexity must report private continuation token presence safely');
    assert.equal(state.stream_state?.status, 'completed');
    assert.ok(state.stream_state?.progress_events > 0, 'perplexity must consume SSE progress events');
  } else if (providerName === 'gemini') {
    assert.equal(state.transport, 'webui-api');
    assert.equal(state.cookie_source, 'managed-browser');
    assert.equal(state.session_verification?.direct_ready, true, 'gemini must prove managed-browser cookies work');
    assert.equal(typeof state.conversation_state?.conversation_id, 'string', 'gemini must return conversation state');
  } else if (providerName === 'grok') {
    assert.equal(state.transport, 'browser-ui');
    assert.equal(state.selection_verification, 'visible-ui-label');
    assert.match(state.conversation_url || emitted.conversation_url || emitted.final_url || '', /x\.com\/i\/grok\?conversation=/);
  }
}

for (const row of MODEL_SELECTION_MATRIX) {
  for (const liveCase of row.liveCases) {
    test(`live model matrix ${row.provider.name} ${liveCase.kind} ${liveCase.model}`, {
      skip: liveCaseSkipReason(row.provider.name),
      timeout: (liveCase.timeoutSeconds + 60) * 1000,
    }, async () => {
      const stdout = [];
      const request = buildAiChatRequest({
        providerName: row.provider.name,
        modelName: liveCase.model,
        prompt: `Write one short sentence that contains the exact token ${MODEL_CHECK_TOKEN}.`,
        jsonOutput: true,
        timeoutSeconds: liveCase.timeoutSeconds,
        timeoutExplicit: true,
        providerOptions: liveCase.providerOptions || {},
      });

      await runAiChat(request, {
        cache: noCache(),
        io: {
          stdout: text => stdout.push(text),
          writeFile: () => assert.fail(`${row.provider.name} ${liveCase.kind} should not write private live output to a committed file`),
        },
      });

      const emitted = JSON.parse(stdout[0]);
      assertLiveProviderEvidence(row.provider.name, emitted);
      assert.equal(emitted.requested_model, liveCase.model, `${row.provider.name} ${liveCase.kind} requested model mismatch`);
    });
  }
}

const LIVE_CONVERSATION_CASES = [
  { providerName: 'perplexity', model: 'perplexity/best', timeoutSeconds: 120 },
  { providerName: 'chatgpt', model: 'instant', timeoutSeconds: 120 },
  { providerName: 'gemini', model: 'gemini-3-flash', timeoutSeconds: 120 },
  { providerName: 'grok', model: 'fast', timeoutSeconds: 180 },
];

function liveConversationSkipReason(providerName) {
  if (process.env.AI_CHAT_LIVE_CONVERSATION_MATRIX !== '1') {
    return 'set AI_CHAT_LIVE_CONVERSATION_MATRIX=1 to run browser-authenticated live conversation checks';
  }
  const providers = enabledLiveProviders();
  if (providers.size > 0 && !providers.has(providerName)) {
    return `AI_CHAT_LIVE_PROVIDERS does not include ${providerName}`;
  }
  return false;
}

for (const liveCase of LIVE_CONVERSATION_CASES) {
  test(`live conversation matrix ${liveCase.providerName} new and continuation`, {
    skip: liveConversationSkipReason(liveCase.providerName),
    timeout: (liveCase.timeoutSeconds * 2 + 120) * 1000,
  }, async () => {
    const dir = mkdtempSync(join(tmpdir(), `ai-chat-live-conversation-${liveCase.providerName}-`));
    const id = `live-${liveCase.providerName}-${Date.now()}`;
    try {
      const firstStdout = [];
      const firstToken = `AI_CHAT_${liveCase.providerName.toUpperCase()}_FIRST_${Date.now()}`;
      await runAiChat(buildAiChatRequest({
        providerName: liveCase.providerName,
        modelName: liveCase.model,
        prompt: `Write one short sentence that contains the exact token ${firstToken}.`,
        saveConversation: id,
        conversationStoreDir: dir,
        jsonOutput: true,
        timeoutSeconds: liveCase.timeoutSeconds,
        timeoutExplicit: true,
      }), {
        cache: noCache(),
        io: { stdout: text => firstStdout.push(text), writeFile: () => assert.fail(`${liveCase.providerName} should not write live output to a committed file`) },
      });
      const first = JSON.parse(firstStdout[0]);
      assertLiveProviderEvidence(liveCase.providerName, first);

      const secondStdout = [];
      await runAiChat(buildAiChatRequest({
        providerName: liveCase.providerName,
        conversationTarget: id,
        prompt: `In one sentence, say this is ${liveCase.providerName} turn two.`,
        saveConversation: id,
        conversationStoreDir: dir,
        jsonOutput: true,
        timeoutSeconds: liveCase.timeoutSeconds,
        timeoutExplicit: true,
      }), {
        cache: noCache(),
        io: { stdout: text => secondStdout.push(text), writeFile: () => assert.fail(`${liveCase.providerName} should not write live output to a committed file`) },
      });
      const second = JSON.parse(secondStdout[0]);
      assertLiveProviderEvidence(liveCase.providerName, second, { tokenRequired: false });
      assert.equal(second.conversation_id, id);
      assert.equal(second.selected_model, first.selected_model, `${liveCase.providerName} continuation should preserve the saved model when --model is omitted`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
