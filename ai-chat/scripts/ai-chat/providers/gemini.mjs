import { urlHasAllowedHostname } from './shared.mjs';
import {
  GEMINI_MODELS,
  checkGeminiUiReady,
  fetchGeminiAccountModels,
  queryGeminiWeb,
  resolveGeminiModel,
} from './gemini-api.mjs';

const MODEL_CHECK_TOKEN = 'AI_CHAT_MODEL_CHECK';
const GEMINI_NATIVE_CONTINUATION_ERROR_CODE = 1097;
const GEMINI_APP_HOSTNAMES = ['gemini.google.com'];
const AUTH_SOURCE = 'managed-browser-same-origin';

function isGeminiAppUrl(url) {
  return urlHasAllowedHostname(url, GEMINI_APP_HOSTNAMES);
}

function uniqueStrings(values) {
  return [...new Set(values.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))];
}

export function resolveGeminiConversationAttachment({ target }) {
  const value = String(target || '').trim();
  if (!value) throw new Error('[gemini] Conversation attachment is empty');
  if (/^https?:\/\//i.test(value)) {
    const parsed = new URL(value);
    const conversationId = parsed.pathname.match(/^\/app\/([^/?#]+)/)?.[1] || null;
    return {
      type: 'url',
      url: value,
      providerId: conversationId,
      providerState: conversationId ? { conversation_state: { conversation_id: conversationId } } : null,
    };
  }
  return {
    type: 'provider_id',
    url: null,
    providerId: value,
    providerState: { conversation_state: { conversation_id: value } },
  };
}

function hasCompleteGeminiConversationState(state) {
  return !!state && typeof state === 'object' && typeof state.conversation_id === 'string' && state.conversation_id.trim() && Array.isArray(state.metadata) && state.metadata.length > 0;
}

function geminiConversationState(conversation) {
  const state = conversation?.record?.provider_state?.conversation_state || conversation?.providerState?.conversation_state || conversation?.provider_state?.conversation_state || null;
  if (!conversation) return null;
  if (!hasCompleteGeminiConversationState(state)) {
    throw new Error('[gemini] Direct conversation URLs and provider IDs cannot continue Gemini conversations because they do not include required continuation metadata. Use a locally saved Gemini conversation record with complete provider_state.conversation_state.metadata.');
  }
  return state;
}

function modelMetadata(model, source = model.source || 'known-webui-headers') {
  return {
    ...model,
    account_specific: !!model.account_specific,
    source,
    selected_by: uniqueStrings(['--model', model.id, model.name, model.model_id, ...(model.aliases || [])]),
  };
}

function findModel(models, value) {
  const normalized = String(value || '').toLowerCase();
  return resolveGeminiModel(normalized) || models.find(model => (
    [model.id, model.name, model.display_name, model.model_id, ...(model.aliases || [])]
      .some(candidate => String(candidate || '').toLowerCase() === normalized)
  )) || null;
}

async function geminiPage(browser) {
  if (!browser) throw new Error('[gemini] Managed browser is required. Start Browser Tools with its standard task profile and sign in at gemini.google.com.');
  const pages = await browser.pages();
  let page = pages.find(candidate => isGeminiAppUrl(candidate.url()));
  if (!page) page = await browser.newPage({ background: true });
  if (!isGeminiAppUrl(page.url())) await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded', timeout: 30000 });
  return page;
}

async function discoverGeminiModels(page, timeoutMs) {
  const fallback = GEMINI_MODELS.map(model => modelMetadata(model));
  try {
    const account = await fetchGeminiAccountModels(page, { timeoutMs });
    if (!account.models.length) throw new Error('account model registry returned no models');
    return {
      models: account.models.map(model => modelMetadata(model, 'gemini-account-rpc')),
      discovery: {
        live: true,
        source: 'gemini-account-rpc',
        account_status_code: account.account_status_code,
        tier_flags: account.tier_flags,
        capability_flags: account.capability_flags,
      },
    };
  } catch (error) {
    return {
      models: fallback.map(model => ({ ...model, discovery_error: error.message })),
      discovery: { live: false, source: 'known-webui-headers', error: error.message },
    };
  }
}

async function verifyModels(page, models, timeoutMs) {
  const verifiedAt = new Date().toISOString();
  const result = [];
  for (const model of models) {
    try {
      const response = await queryGeminiWeb(page, `Reply exactly: ${MODEL_CHECK_TOKEN}`, {
        modelConfig: model,
        timeoutMs,
        temporary: true,
        allowModelFallback: false,
      });
      result.push({
        ...model,
        available: true,
        verified_at: verifiedAt,
        verification: {
          status: response.text.includes(MODEL_CHECK_TOKEN) ? 'ok' : 'accepted_response_mismatch',
          response_chars: response.text.length,
          model_used: response.modelUsed,
        },
      });
    } catch (error) {
      result.push({
        ...model,
        available: false,
        verified_at: verifiedAt,
        verification: { status: 'failed', error: error.message, error_code: error.errorCode || null },
      });
    }
  }
  return result;
}

function errorCode(error) {
  const value = error?.errorCode ?? error?.error_code;
  if (typeof value === 'number') return value;
  const match = String(error?.message || '').match(/^Gemini Web returned error (\d+)$/);
  return match ? Number(match[1]) : null;
}

export function isGeminiNativeContinuationError(error) {
  return errorCode(error) === GEMINI_NATIVE_CONTINUATION_ERROR_CODE;
}

export const geminiProvider = {
  name: 'gemini',
  url: 'https://gemini.google.com/app',
  trustedConversationHostnames: GEMINI_APP_HOSTNAMES,
  transport: 'managed-browser-same-origin',
  defaultModel: 'gemini-3-flash',
  taskModels: {
    default: 'gemini-3-flash',
    quick: 'gemini-3-flash',
    reasoning: 'gemini-3-flash-thinking',
    pro: 'gemini-3-pro',
  },
  historyPolicy: { default: 'provider-history', incognitoFlag: '--incognito', saveFlag: '--save-to-library', transportField: 'innerReqList[45]' },
  resolveConversationAttachment: resolveGeminiConversationAttachment,

  runRequiresBrowser() {
    return true;
  },

  listModelsRequiresBrowser() {
    return true;
  },

  async listModels({ browser, request } = {}) {
    const page = await geminiPage(browser);
    const timeoutMs = (request?.verifyModelTimeoutSeconds || 90) * 1000;
    const inventory = await discoverGeminiModels(page, timeoutMs);
    const models = request?.verifyModels
      ? await verifyModels(page, inventory.models, timeoutMs)
      : inventory.models;
    const ui = request?.providerOptions?.verifySession
      ? await checkGeminiUiReady(page, timeoutMs)
      : { checked: false, ready: null, reason: 'ui_check_not_requested' };

    return {
      model_source: inventory.discovery.source,
      account_specific: inventory.discovery.live,
      auth_source: AUTH_SOURCE,
      discovery: inventory.discovery,
      verification: { enabled: !!request?.verifyModels, prompt: MODEL_CHECK_TOKEN, temporary: true },
      session_verification: {
        checked: true,
        ui_ready: ui.ready === true,
        fully_logged_in: inventory.discovery.live && (ui.checked === false || ui.ready === true),
        ui,
      },
      models,
    };
  },

  async run({ browser, request, selectedModel, conversation }) {
    const page = await geminiPage(browser);
    const requestedModel = selectedModel === 'default' ? request.modelName : selectedModel;
    let modelConfig = resolveGeminiModel(requestedModel);
    if (!modelConfig) modelConfig = findModel((await discoverGeminiModels(page, 60000)).models, requestedModel);
    if (!modelConfig) throw new Error(`[gemini] Unknown model: ${requestedModel}. Run --provider gemini --list-models --json to inspect selectable models.`);

    const temporary = request.providerOptions?.incognito === true;
    let result;
    try {
      result = await queryGeminiWeb(page, request.prompt, {
        modelConfig,
        timeoutMs: request.timeoutSeconds * 1000,
        conversationState: geminiConversationState(conversation),
        temporary,
      });
    } catch (error) {
      const previous = conversation?.record?.messages || [];
      if (!previous.length || !isGeminiNativeContinuationError(error)) throw error;
      const transcript = previous
        .map(message => `${message.role === 'assistant' ? 'Assistant' : 'User'}: ${message.content}`)
        .join('\n\n');
      result = await queryGeminiWeb(page, `Continue this conversation. Use the prior messages as context, then answer the new user message.\n\n${transcript}\n\nUser: ${request.prompt}`, {
        modelConfig,
        timeoutMs: request.timeoutSeconds * 1000,
        temporary,
      });
      result.localTranscriptFallback = true;
      result.nativeContinuationError = {
        message: error.message,
        error_code: errorCode(error),
        model: error.model || modelConfig.id,
      };
    }

    return {
      text: result.text,
      rawText: result.rawText,
      done: true,
      modelUsed: result.modelUsed,
      finalUrl: null,
      providerState: {
        transport: 'managed-browser-same-origin',
        auth_source: AUTH_SOURCE,
        error_code: result.errorCode || null,
        conversation_state: result.conversationState || null,
        is_temporary: temporary,
        saved_to_library: !temporary,
        model_fallback_from: result.modelFallbackFrom || null,
        model_fallback_reason: result.modelFallbackReason || null,
        native_continuation_error: result.nativeContinuationError || null,
        local_transcript_fallback: !!result.localTranscriptFallback,
      },
      searchResults: [],
    };
  },
};
