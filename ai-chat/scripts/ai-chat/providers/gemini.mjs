import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readManagedStateForPort } from '../../../../browser-tools/scripts/browser-control.mjs';
import { urlHasAllowedHostname } from './shared.mjs';

import {
  GEMINI_MODELS,
  GOOGLE_ORIGINS,
  browserCookiesToGoogleCookieMap,
  classifyGeminiUiState,
  fetchGeminiAccountModels,
  getGoogleCookies,
  hasRequiredGoogleCookies,
  parseGeminiStreamResponse,
  queryGeminiWeb,
  resolveChromeProfileName,
  resolveGeminiModel,
} from './gemini-api.mjs';

const MODEL_CHECK_TOKEN = 'AI_CHAT_MODEL_CHECK';
const COOKIE_SOURCE_MANAGED_BROWSER = 'managed-browser';
const COOKIE_SOURCE_CHROME_PROFILE = 'chrome-profile';
const COOKIE_SOURCE_AUTO = 'auto';

const GEMINI_AUTH_CHECK_TIMEOUT_MS = 30000;
const GEMINI_APP_HOSTNAMES = ['gemini.google.com'];
const GEMINI_COOKIE_PAGE_HOSTNAMES = ['gemini.google.com', 'accounts.google.com', 'www.google.com', 'consent.google.com'];

function isGeminiAppUrl(url) {
  return urlHasAllowedHostname(url, GEMINI_APP_HOSTNAMES);
}

function isGeminiCookiePageUrl(url) {
  return urlHasAllowedHostname(url, GEMINI_COOKIE_PAGE_HOSTNAMES);
}

export function resolveGeminiConversationAttachment({ target }) {
  const value = String(target || '').trim();
  if (!value) throw new Error('[gemini] Conversation attachment is empty');
  if (/^https?:\/\//i.test(value)) {
    const parsed = new URL(value);
    const match = parsed.pathname.match(/^\/app\/([^/?#]+)/);
    const conversationId = match?.[1] || null;
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

function uniqueStrings(values) {
  return [...new Set(values.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))];
}

function withModelSelectionMetadata(model, cookieContext, source = model.source || 'known-webui-headers') {
  return {
    ...model,
    account_specific: !!model.account_specific,
    source,
    selected_by: uniqueStrings(['--model', model.id, model.name, model.model_id, ...(model.aliases || [])]),
    chrome_profile: cookieContext?.chromeProfile || null,
    cookie_source: cookieContext?.source || null,
    cookie_extraction: cookieContext?.extraction || null,
  };
}

function findModelByName(models, modelName) {
  const normalized = String(modelName || '').toLowerCase();
  if (!normalized || normalized === 'default') return resolveGeminiModel('default');
  const staticModel = resolveGeminiModel(normalized);
  if (staticModel) return staticModel;
  return models.find(model => {
    const candidates = [model.id, model.name, model.display_name, model.model_id, ...(model.aliases || [])];
    return candidates.some(candidate => String(candidate || '').toLowerCase() === normalized);
  }) || null;
}

async function discoverGeminiModels({ cookies, cookieContext, timeoutMs }) {
  const fallbackModels = GEMINI_MODELS.map(model => withModelSelectionMetadata(model, cookieContext));
  if (!cookies) {
    return {
      models: fallbackModels,
      discovery: {
        live: false,
        source: 'known-webui-headers',
        error: 'Google cookies were not readable from the selected Gemini cookie source',
      },
    };
  }

  try {
    const account = await fetchGeminiAccountModels(cookies, { timeoutMs });
    const accountModels = account.models.map(model => withModelSelectionMetadata(model, cookieContext, 'gemini-account-rpc'));
    if (!accountModels.length) throw new Error('Gemini account RPC returned no models');
    return {
      models: accountModels,
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
      models: fallbackModels.map(model => ({ ...model, discovery_error: error.message })),
      discovery: {
        live: false,
        source: 'known-webui-headers',
        error: error.message,
      },
    };
  }
}

async function getGoogleCookiesFromManagedBrowserRuntime(browser) {
  if (!browser) return null;
  const pages = await browser.pages();
  let page = pages.find(candidate => isGeminiCookiePageUrl(candidate.url()));
  if (!page) page = await browser.newPage({ background: true });

  let cookies = browserCookiesToGoogleCookieMap(await page.cookies(...GOOGLE_ORIGINS));
  if (hasRequiredGoogleCookies(cookies)) return cookies;

  try {
    if (!isGeminiAppUrl(page.url())) {
      await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded', timeout: 30000 });
    }
  } catch {}

  cookies = browserCookiesToGoogleCookieMap(await page.cookies(...GOOGLE_ORIGINS));
  return hasRequiredGoogleCookies(cookies) ? cookies : null;
}

async function getGoogleCookiesFromManagedProfileCopy(request = {}) {
  let state;
  try {
    state = readManagedStateForPort(request.port);
  } catch {
    state = null;
  }
  if (!state?.userDataDir) return null;
  const profileName = state.profileName || 'Default';
  const candidates = [
    join(state.userDataDir, profileName, 'Cookies'),
    join(state.userDataDir, profileName, 'Network', 'Cookies'),
  ];
  for (const cookiesPath of candidates) {
    if (!existsSync(cookiesPath)) continue;
    const cookies = await getGoogleCookies({ cookiesPath });
    if (cookies) return cookies;
  }
  return null;
}

async function getGoogleCookiesFromManagedBrowser(browser, request = {}) {
  const runtimeCookies = await getGoogleCookiesFromManagedBrowserRuntime(browser);
  if (runtimeCookies) return { cookies: runtimeCookies, extraction: 'browser-runtime-cookies' };
  const copiedProfileCookies = await getGoogleCookiesFromManagedProfileCopy(request);
  if (copiedProfileCookies) return { cookies: copiedProfileCookies, extraction: 'managed-profile-copy-db' };
  return null;
}

async function verifyGeminiUiLogin(browser, { timeoutMs = GEMINI_AUTH_CHECK_TIMEOUT_MS } = {}) {
  if (!browser) return { checked: false, ready: null, reason: 'browser_not_available' };

  let page = null;
  try {
    page = await browser.newPage({ background: true });
    await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await new Promise(resolve => setTimeout(resolve, 4000));
    const ui = await page.evaluate(() => {
      const text = document.body?.innerText || '';
      const promptInput = !!document.querySelector([
        'rich-textarea .ql-editor[contenteditable="true"]',
        'div[aria-label="Enter a prompt for Gemini"][contenteditable="true"]',
        'div[role="textbox"][contenteditable="true"]',
        'textarea[aria-label*="Gemini" i]',
      ].join(','));
      const accountButton = [...document.querySelectorAll('[aria-label], a, button')].some(node => {
        const label = node.getAttribute('aria-label') || '';
        return /Google Account/i.test(label);
      });
      return {
        url: location.href,
        title: document.title,
        text: text.slice(0, 5000),
        promptInput,
        accountButton,
      };
    });
    return { checked: true, ...classifyGeminiUiState(ui) };
  } catch (error) {
    return { checked: true, ready: false, reason: 'ui_check_failed', error: error.message };
  } finally {
    await page?.close().catch(() => {});
  }
}

async function verifyGeminiDirectSession({ cookies, cookieContext, timeoutMs = GEMINI_AUTH_CHECK_TIMEOUT_MS } = {}) {
  const requiredCookies = hasRequiredGoogleCookies(cookies);
  const direct = {
    checked: true,
    required_cookies: requiredCookies,
    cookie_source: cookieContext?.source || null,
    cookie_extraction: cookieContext?.extraction || null,
    account_rpc_live: false,
    model_count: 0,
    account_status_code: null,
    error: null,
  };

  if (!requiredCookies) {
    direct.error = 'required_google_cookies_missing';
    return direct;
  }

  try {
    const account = await fetchGeminiAccountModels(cookies, { timeoutMs });
    direct.account_rpc_live = true;
    direct.model_count = account.models.length;
    direct.account_status_code = account.account_status_code;
    direct.tier_flags = account.tier_flags;
    direct.capability_flags = account.capability_flags;
  } catch (error) {
    direct.error = error.message;
  }
  return direct;
}

async function verifyGeminiSession({ browser, cookies, cookieContext, request, timeoutMs = GEMINI_AUTH_CHECK_TIMEOUT_MS } = {}) {
  const direct = await verifyGeminiDirectSession({ cookies, cookieContext, timeoutMs });
  const shouldCheckUi = !!request?.providerOptions?.verifySession && cookieContext?.source === COOKIE_SOURCE_MANAGED_BROWSER && browser;
  const ui = shouldCheckUi
    ? await verifyGeminiUiLogin(browser, { timeoutMs })
    : { checked: false, ready: null, reason: 'ui_check_not_applicable' };
  const directReady = direct.required_cookies && direct.account_rpc_live && direct.model_count > 0;
  return {
    checked: true,
    direct_ready: directReady,
    ui_ready: ui.ready === true,
    fully_logged_in: directReady && (ui.checked ? ui.ready === true : true),
    direct,
    ui,
    requested: !!request?.providerOptions?.verifySession,
  };
}

function resolveCookieSource(request = {}) {
  const explicit = request.providerOptions?.cookieSource || null;
  if (explicit) return String(explicit).toLowerCase();
  if (request.providerOptions?.chromeProfile) return COOKIE_SOURCE_CHROME_PROFILE;
  return COOKIE_SOURCE_MANAGED_BROWSER;
}

async function getGeminiCookieContext({ browser, request }) {
  const source = resolveCookieSource(request);
  const chromeProfile = request?.providerOptions?.chromeProfile || null;

  if (source !== COOKIE_SOURCE_CHROME_PROFILE) {
    const managedCookieContext = await getGoogleCookiesFromManagedBrowser(browser, request);
    if (managedCookieContext?.cookies) {
      return { ...managedCookieContext, source: COOKIE_SOURCE_MANAGED_BROWSER, chromeProfile: null };
    }
    if (source === COOKIE_SOURCE_MANAGED_BROWSER) {
      throw new Error('[gemini] Could not read Google cookies from the Browser Tools managed browser. Start Browser Tools with the configured Gemini Chrome profile, for example browser-tools/scripts/start.mjs --task gemini --sync. If managed Chrome is already running from a stale copy, stop it with --clean, restart with --sync, and retry. You can also pass --cookie-source chrome-profile --chrome-profile <profile-folder> for the direct profile fallback.');
    }
  }

  if (source === COOKIE_SOURCE_CHROME_PROFILE || source === COOKIE_SOURCE_AUTO) {
    const cookies = await getGoogleCookies({ chromeProfile });
    if (cookies) {
      return { cookies, source: COOKIE_SOURCE_CHROME_PROFILE, extraction: 'chrome-profile-db', chromeProfile: resolveChromeProfileName({ chromeProfile }) };
    }
  }

  throw new Error('[gemini] Could not read Google cookies from the selected cookie source.');
}

async function verifyGeminiModels({ cookies, models, timeoutMs }) {
  const verifiedAt = new Date().toISOString();
  const result = [];
  for (const model of models) {
    try {
      const response = await queryGeminiWeb(`Reply exactly: ${MODEL_CHECK_TOKEN}`, cookies, {
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
        verification: {
          status: 'failed',
          error: error.message,
          error_code: error.errorCode || null,
        },
      });
    }
  }
  return result;
}

const GEMINI_NATIVE_CONTINUATION_ERROR_CODE = 1097;

function normalizedGeminiErrorCode(error) {
  const code = error?.errorCode ?? error?.error_code ?? null;
  if (typeof code === 'number' && Number.isInteger(code)) return code;
  if (typeof code === 'string' && /^\d+$/.test(code.trim())) return Number.parseInt(code, 10);
  const messageMatch = String(error?.message || '').match(/^Gemini Web returned error (\d+)$/);
  return messageMatch ? Number.parseInt(messageMatch[1], 10) : null;
}

export async function queryGeminiViaBrowserNetwork(browser, prompt, timeoutMs = 120000, options = {}) {
  const page = await browser.newPage({ background: true });
  const promptSelector = 'div[role="textbox"][aria-label="Enter a prompt for Gemini"]';
  const requestedMode = options.modelConfig?.ui_selected || (options.modelConfig?.thinking
    ? 'Thinking'
    : (options.modelConfig?.id?.includes('-pro') ? 'Pro' : 'Flash'));
  const requestedChoice = options.modelConfig?.ui_choice || requestedMode;
  try {
    await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector(promptSelector, { timeout: 30000 });
    await page.waitForSelector('button[aria-label^="Open mode picker"]', { timeout: 30000 });
    await page.waitForSelector('button[aria-label="Temporary chat"]', { timeout: 30000 });
    const configured = await page.evaluate(async ({ requestedMode, requestedChoice, temporary }) => {
      const modePicker = document.querySelector('button[aria-label^="Open mode picker"]');
      if (!modePicker) throw new Error('Gemini mode picker not found');
      const currentMode = `${modePicker.getAttribute('aria-label') || ''} ${modePicker.innerText || ''}`;
      if (!currentMode.includes(requestedMode)) {
        modePicker.click();
        await new Promise(resolve => setTimeout(resolve, 500));
        const choice = [...document.querySelectorAll('button, [role="menuitem"], [role="option"]')]
          .find(node => (node.innerText || '').trim().includes(requestedChoice));
        if (!choice) throw new Error(`Gemini model mode is unavailable in the UI: ${requestedChoice}`);
        choice.click();
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      const observedPicker = document.querySelector('button[aria-label^="Open mode picker"]');
      const observedMode = `${observedPicker?.getAttribute('aria-label') || ''} ${observedPicker?.innerText || ''}`;
      if (!observedMode.includes(requestedMode)) {
        throw new Error(`Gemini model mode did not activate: expected ${requestedMode}, observed ${observedMode.trim() || 'unknown'}`);
      }
      const temporaryButton = document.querySelector('button[aria-label="Temporary chat"]');
      if (!temporaryButton) throw new Error('Gemini temporary chat control not found');
      if (temporary) {
        temporaryButton.click();
        await new Promise(resolve => setTimeout(resolve, 750));
        if (!/Temporary chats/i.test(document.body?.innerText || '')) {
          throw new Error('Gemini temporary chat mode did not activate');
        }
      } else {
        temporaryButton.click();
        await new Promise(resolve => setTimeout(resolve, 750));
        if (!/Temporary chats/i.test(document.body?.innerText || '')) {
          throw new Error('Gemini temporary mode probe did not activate');
        }
        const activeTemporaryButton = document.querySelector('button[aria-label="Temporary chat"]');
        if (!activeTemporaryButton) throw new Error('Gemini temporary chat control disappeared during history verification');
        activeTemporaryButton.click();
        await new Promise(resolve => setTimeout(resolve, 750));
        if (/Temporary chats/i.test(document.body?.innerText || '')) {
          throw new Error('Gemini persistent chat mode did not activate');
        }
      }
      return { observedMode: requestedMode, temporaryActive: temporary, historyModeVerified: true };
    }, { requestedMode, requestedChoice, temporary: options.temporary !== false });
    if (!configured || configured.observedMode !== requestedMode) {
      throw new Error(`Gemini model mode verification failed: ${requestedMode}`);
    }
    if (options.temporary !== false && configured.temporaryActive !== true) {
      throw new Error('Gemini temporary chat verification failed');
    }
    if (configured.historyModeVerified !== true) {
      throw new Error('Gemini chat history mode verification failed');
    }
    await page.waitForSelector(promptSelector, { timeout: 30000 });
    await page.evaluate((selector, text) => {
      const editor = document.querySelector(selector);
      if (!editor) throw new Error('Gemini prompt input not found');
      editor.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }, promptSelector, prompt);
    await page.waitForSelector('button[aria-label="Send message"]:not([disabled])', { timeout: 10000 });

    const responsePromise = page.waitForResponse(
      response => response.request().method() === 'POST' && response.url().includes('/StreamGenerate'),
      { timeout: timeoutMs },
    );
    await page.evaluate(() => {
      const button = document.querySelector('button[aria-label="Send message"]');
      if (!button || button.disabled) throw new Error('Gemini send button is not actionable');
      button.click();
    });
    const response = await responsePromise;
    const rawText = await response.text();
    const result = parseGeminiStreamResponse(rawText);
    if (!result.text) throw new Error('Gemini browser network response contained no answer text');
    return {
      ...result,
      rawText,
      browserNetworkFallback: true,
      modelUsed: options.modelConfig?.id || null,
      temporaryVerified: configured.temporaryActive === true,
      historyModeVerified: configured.historyModeVerified === true,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

export function isGeminiNativeContinuationError(error) {
  return normalizedGeminiErrorCode(error) === GEMINI_NATIVE_CONTINUATION_ERROR_CODE;
}

export const geminiProvider = {
  name: 'gemini',
  url: 'https://gemini.google.com/app',
  trustedConversationHostnames: GEMINI_APP_HOSTNAMES,
  transport: 'webui-api',
  closeBrowserAfterRun: true,

  defaultModel: 'gemini-3.6-flash',
  taskModels: {
    default: 'gemini-3.6-flash',
    quick: 'gemini-3.6-flash',
    reasoning: 'gemini-3.6-flash-extended-thinking',
  },
  historyPolicy: {
    default: 'temporary',
    saveFlag: '--temporary false',
    compatibilitySaveFlag: '--save-to-library',
    transportField: 'innerReqList[45]',
  },
  resolveConversationAttachment: resolveGeminiConversationAttachment,

  runRequiresBrowser({ request } = {}) {
    return resolveCookieSource(request) !== COOKIE_SOURCE_CHROME_PROFILE;
  },

  listModelsRequiresBrowser({ request } = {}) {
    return resolveCookieSource(request) !== COOKIE_SOURCE_CHROME_PROFILE;
  },

  async listModels({ browser, request } = {}) {
    const cookieContext = await getGeminiCookieContext({ browser, request: request || { providerOptions: {} } });
    const inventory = await discoverGeminiModels({
      cookies: cookieContext.cookies,
      cookieContext,
      timeoutMs: (request?.verifyModelTimeoutSeconds || 90) * 1000,
    });
    const models = request?.verifyModels && cookieContext.cookies
      ? await verifyGeminiModels({ cookies: cookieContext.cookies, models: inventory.models, timeoutMs: (request.verifyModelTimeoutSeconds || 90) * 1000 })
      : inventory.models;
    const sessionVerification = await verifyGeminiSession({
      browser,
      cookies: cookieContext.cookies,
      cookieContext,
      request,
      timeoutMs: (request?.verifyModelTimeoutSeconds || 90) * 1000,
    });

    return {
      model_source: inventory.discovery.source,
      account_specific: inventory.discovery.live,
      cookie_source: cookieContext.source,
      chrome_profile: cookieContext.chromeProfile,
      cookie_extraction: cookieContext.extraction,
      discovery: inventory.discovery,
      verification: {
        enabled: !!request?.verifyModels,
        prompt: MODEL_CHECK_TOKEN,
        temporary: true,
      },
      session_verification: sessionVerification,
      models,
    };
  },

  async run({ browser, request, selectedModel, conversation }) {
    const cookieContext = await getGeminiCookieContext({ browser, request });
    const cookies = cookieContext.cookies;
    const sessionVerification = await verifyGeminiSession({ browser, cookies, cookieContext, request });
    if (sessionVerification.ui.checked && !sessionVerification.ui_ready) {
      console.error(`[gemini] UI login check is not ready: ${sessionVerification.ui.reason}. Direct WebUI auth ${sessionVerification.direct_ready ? 'passed' : 'failed'}.`);
    }
    const useBrowserNetwork = cookieContext.source === COOKIE_SOURCE_MANAGED_BROWSER && !!browser && request.browserHeadless;
    if (!sessionVerification.direct_ready && !useBrowserNetwork) {
      console.error(`[gemini] Direct session check is not ready: ${sessionVerification.direct.error || 'account RPC did not return models'}.`);
    }

    const requestedModel = selectedModel === 'default' ? request.modelName : selectedModel;
    let modelConfig = resolveGeminiModel(requestedModel);
    if (!modelConfig) {
      const inventory = await discoverGeminiModels({
        cookies,
        cookieContext,
        timeoutMs: 60000,
      });
      modelConfig = findModelByName(inventory.models, requestedModel);
    }
    if (!modelConfig) throw new Error(`[gemini] Unknown model: ${requestedModel}. Run --provider gemini --list-models --json to inspect selectable models.`);

    let result;
    const explicitTemporary = request.providerOptions?.temporary;
    const saveFlag = !!request.providerOptions?.saveToLibrary;
    if (explicitTemporary === true && saveFlag) {
      throw new Error('Gemini temporary mode conflicts with save-to-library');
    }
    const temporary = explicitTemporary ?? !saveFlag;
    const saveToLibrary = !temporary;
    if (!temporary && !useBrowserNetwork) {
      throw new Error('Gemini persistent history requires a headless managed-browser session so history mode can be verified');
    }
    const previousMessages = conversation?.record?.messages || [];
    const transcript = previousMessages
      .map(message => `${message.role === 'assistant' ? 'Assistant' : 'User'}: ${message.content}`)
      .join('\n\n');
    const replayPrompt = previousMessages.length
      ? `Continue this conversation. Use the prior messages as context, then answer the new user message.\n\n${transcript}\n\nUser: ${request.prompt}`
      : request.prompt;

    if (useBrowserNetwork) {
      result = await queryGeminiViaBrowserNetwork(browser, replayPrompt, request.timeoutSeconds * 1000, {
        modelConfig,
        temporary,
      });
      result.localTranscriptFallback = previousMessages.length > 0;
      sessionVerification.browser_network_ready = true;
      sessionVerification.fully_logged_in = true;
    } else {
      try {
        result = await queryGeminiWeb(request.prompt, cookies, {
          modelConfig,
          timeoutMs: request.timeoutSeconds * 1000,
          conversationState: conversation?.record?.provider_state?.conversation_state || null,
          temporary,
        });
      } catch (error) {
        if (!previousMessages.length || !isGeminiNativeContinuationError(error)) throw error;
        const nativeContinuationError = {
          message: error.message,
          error_code: normalizedGeminiErrorCode(error),
          model: error.model || modelConfig.id,
        };
        result = await queryGeminiWeb(replayPrompt, cookies, {
          modelConfig,
          timeoutMs: request.timeoutSeconds * 1000,
          temporary,
        });
        result.localTranscriptFallback = true;
        result.nativeContinuationError = nativeContinuationError;
      }
    }
    return {
      text: result.text,
      rawText: result.rawText,
      done: true,
      modelUsed: result.modelUsed,
      finalUrl: null,
      providerState: {
        transport: result.browserNetworkFallback ? 'browser-network' : 'webui-api',
        error_code: result.errorCode || null,
        conversation_state: result.conversationState || null,
        is_temporary: result.browserNetworkFallback ? result.temporaryVerified === true : temporary,
        temporary_verified: result.browserNetworkFallback ? result.temporaryVerified === true : null,
        history_mode_verified: result.browserNetworkFallback ? result.historyModeVerified === true : null,
        saved_to_library: saveToLibrary,
        cookie_source: cookieContext.source,
        chrome_profile: cookieContext.chromeProfile,
        cookie_extraction: cookieContext.extraction,
        session_verification: sessionVerification,
        model_fallback_from: result.modelFallbackFrom || null,
        model_fallback_reason: result.modelFallbackReason || null,
        native_continuation_error: result.nativeContinuationError || null,
        local_transcript_fallback: !!result.localTranscriptFallback,
      },
      searchResults: [],
    };
  },
};
