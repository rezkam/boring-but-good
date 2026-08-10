import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  buildAiChatRequest,
  buildMetadata,
  resolveInitialModel,
} from '../scripts/ai-chat/module.mjs';
import { chatgptProvider, resolveChatGptModel } from '../scripts/ai-chat/providers/chatgpt.mjs';
import { resolveGeminiModel } from '../scripts/ai-chat/providers/gemini-api.mjs';
import { geminiProvider } from '../scripts/ai-chat/providers/gemini.mjs';
import { grokProvider, resolveGrokModel } from '../scripts/ai-chat/providers/grok.mjs';
import { perplexityProvider, resolvePerplexityModel } from '../scripts/ai-chat/providers/perplexity.mjs';

const MODEL_SELECTION_MATRIX = [
  {
    provider: perplexityProvider,
    defaultModel: 'perplexity/best',
    resolveId: model => resolvePerplexityModel(model)?.id || null,
    aliases: [
      ['pplx_best', 'perplexity/best'],
      ['pplx_gpt56_terra_thinking', 'openai/gpt-5.6-terra-thinking'],
      ['reasoning', 'openai/gpt-5.6-terra-thinking'],
      ['pplx_deep_research', 'perplexity/deep-research'],
    ],
    taskDefaults: [
      ['quick_web', 'perplexity/best'],
      ['deep_research', 'perplexity/deep-research'],
      ['reasoning', 'openai/gpt-5.6-terra-thinking'],
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
        is_incognito: false,
        incognito_explicit: false,
        privacy_state: 'PERSISTENT',
        saved_to_library: true,
      },
    },
    limitations: [
      'Max tier models are intentionally filtered out of the bundled registry.',
      'Live acceptance depends on the current Perplexity account tier.',
      'Deep research has a longer provider timeout.'
    ],
  },
  {
    provider: chatgptProvider,
    defaultModel: 'extra-high',
    resolveId: model => resolveChatGptModel(model)?.id || null,
    aliases: [
      ['instant', 'instant'],
      ['medium', 'medium'],
      ['high', 'high'],
      ['extra-high', 'extra-high'],
      ['pro', 'pro'],
    ],
    taskDefaults: [
      ['quick', 'instant'],
      ['reasoning', 'high'],
      ['pro', 'pro'],
    ],
    unknownModel: 'definitely-not-a-chatgpt-profile',
    outputCase: {
      requestedModel: 'extra-high',
      selectedModel: 'gpt-5-6-thinking',
      fallbackTrail: ['extra-high'],
      providerState: {
        transport: 'network-incremental-sse',
        requested_model_profile: 'extra-high',
        observed_payload_model: 'gpt-5-6-thinking',
        model_slug: 'gpt-5-6-thinking',
        thinking_effort: 'max',
        stream_state: {
          status: 'completed',
          requested_model_profile: 'extra-high',
          model_slug: 'gpt-5-6-thinking',
          terminal_quorum: true,
        },
      },
    },
    limitations: [
      'Model selection is performed through the ChatGPT UI before prompt submission.',
      'Network-observed model and effort fields verify the UI-selected profile after submission.',
      'Only instant, medium, high, extra-high, and pro are public profile ids.',
      'Automated verification is deterministic or read-only; provider writes require an explicit user invocation.',
      'Deep research is not exposed as a stable AI Chat model profile.',
    ],
  },
  {
    provider: geminiProvider,
    defaultModel: 'gemini-3.6-flash',
    resolveId: model => resolveGeminiModel(model)?.id || null,
    aliases: [
      ['flash', 'gemini-3.6-flash'],
      ['thinking', 'gemini-3.6-flash-extended-thinking'],
      ['extended-thinking', 'gemini-3.6-flash-extended-thinking'],
    ],
    taskDefaults: [
      ['quick', 'gemini-3.6-flash'],
      ['reasoning', 'gemini-3.6-flash-extended-thinking'],
    ],
    unknownModel: 'definitely-not-a-gemini-model',
    outputCase: {
      requestedModel: 'thinking',
      selectedModel: 'gemini-3.6-flash-extended-thinking',
      fallbackTrail: ['thinking'],
      providerState: {
        transport: 'managed-browser-same-origin',
        auth_source: 'managed-browser-same-origin',
        model_fallback_from: null,
        model_fallback_reason: null,
        session_verification: {
          checked: true,
          fully_logged_in: true,
        },
      },
    },
    limitations: [
      'Live discovery requires Google cookies from the managed Browser Tools browser or an explicit Chrome profile fallback.',
      'The exposed modes are Gemini 3.6 Flash and Gemini 3.6 Flash Extended Thinking.',
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
    limitations: [
      'Model selection is verified through visible UI labels.',
      'The provider can report Auto, Fast, or Expert, but not a backend model slug.',
      'Current X/Grok sessions can expose only Fast; Auto and Expert are account/UI availability dependent and require explicit user-authorized visible-label verification before use.',
      'Automated verification is deterministic or read-only; provider writes require an explicit user invocation.',
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
    modelName: 'gemini-3.6-flash-extended-thinking',
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
      modelUsed: 'gemini-3.6-flash',
      providerState: {
        transport: 'webui-api',
        model_fallback_from: 'gemini-3.6-flash-extended-thinking',
        model_fallback_reason: 'error_1052',
      },
      searchResults: [],
    },
    fallbackFrom: null,
    fallbackTrail: ['gemini-3.6-flash-extended-thinking'],
  });

  assert.equal(metadata.requested_model, 'gemini-3.6-flash-extended-thinking');
  assert.equal(metadata.selected_model, 'gemini-3.6-flash');
  assert.equal(metadata.model_fallback_from, 'gemini-3.6-flash-extended-thinking');
  assert.equal(metadata.model_fallback_reason, 'error_1052');
  assert.equal(metadata.provider_state.model_fallback_from, 'gemini-3.6-flash-extended-thinking');
});

test('model matrix and eval fixtures contain no automated live-write flags or retired Gemini credential fields', () => {
  const matrix = readFileSync(new URL(import.meta.url), 'utf8');
  const evals = readFileSync(new URL('../evals/evals.json', import.meta.url), 'utf8');
  const liveGate = new RegExp(['AI_CHAT_LIVE_', '(?:MODEL|CONVERSATION)_MATRIX'].join(''));
  const liveWriteFlag = new RegExp(['--verify', '-models'].join(''));
  const retiredGeminiFields = new RegExp(['cookie', '_source|chrome', '_profile|cookie', '_extraction'].join(''));
  for (const source of [matrix, evals]) {
    assert.doesNotMatch(source.replace(/\['--verify', '-models'\]/, ''), liveWriteFlag);
    assert.doesNotMatch(source.replace(/\['cookie', '_source\|chrome', '_profile\|cookie', '_extraction'\]/, ''), retiredGeminiFields);
    assert.doesNotMatch(source.replace(/\['AI_CHAT_LIVE_', '\(\?:MODEL\|CONVERSATION\)_MATRIX'\]/, ''), liveGate);
  }
  assert.match(matrix, /auth_source: 'managed-browser-same-origin'/);
});
